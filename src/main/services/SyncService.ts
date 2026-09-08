import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  clamp,
  detectPipelineError,
  formatFriendlyError,
  joinObjectKey,
  joinPublicUrl,
} from '../lib/helpers';
import type { AppSettings, LogLevel, StoredVideoSource } from '../../shared/types';
import type { StorageKeyPlan } from '../../shared/storageLayout';
import type { PackagedVideoResult } from './TranscodeService';

interface SyncLogger {
  (level: LogLevel, message: string, jobId?: string): void;
}

interface SyncTask {
  jobId: string;
  sourcePath: string;
  sourceName: string;
  outputDirectory: string;
  keyPlan: StorageKeyPlan;
  artifact: PackagedVideoResult;
  settings: AppSettings;
  onProgress: (progress: number) => void;
  onStageChange?: (
    stage: 'uploading-archive' | 'uploading-distribution' | 'verifying',
    message: string,
  ) => void;
  onLog: (message: string) => void;
}

interface OffloadUploadTask {
  jobId: string;
  localDirectory: string;
  destinationObjectKey: string;
  settings: AppSettings;
  onProgress: (progress: number) => void;
  onLog: (message: string) => void;
  onSpawn?: (child: ChildProcessWithoutNullStreams | null) => void;
}

interface R2FileUploadTask {
  jobId: string;
  localFilePath: string;
  destinationObjectKey: string;
  settings: AppSettings;
  onLog: (message: string) => void;
}

interface B2FileDownloadTask {
  jobId: string;
  sourceObjectKey: string;
  localFilePath: string;
  settings: AppSettings;
  onProgress: (progress: number) => void;
  onLog: (message: string) => void;
}

interface RcloneExecutionOptions {
  onSpawn?: (child: ChildProcessWithoutNullStreams | null) => void;
}

interface RemoteListTask {
  jobId: string;
  storage: 'b2' | 'r2';
  bucket: string;
  remotePrefix: string;
  recursive?: boolean;
  settings: AppSettings;
  onLog: (message: string) => void;
}

interface RemoteDeleteTask {
  jobId: string;
  storage: 'b2' | 'r2';
  bucket: string;
  objectKey: string;
  settings: AppSettings;
  onLog: (message: string) => void;
}

interface RemoteCopyTask {
  jobId: string;
  storage: 'b2' | 'r2';
  bucket: string;
  sourceObjectKey: string;
  destinationObjectKey: string;
  settings: AppSettings;
  onLog: (message: string) => void;
}

interface RemotePurgeTask {
  jobId: string;
  storage: 'b2' | 'r2';
  bucket: string;
  remotePrefix: string;
  settings: AppSettings;
  onLog: (message: string) => void;
}

interface RcloneLsJsonEntry {
  Name?: string;
  Path?: string;
  Size?: number;
}

export interface SyncTargets {
  archiveObjectKey: string;
  distributionObjectKey: string;
  /** Where the poster is published, when it lives outside the distribution prefix. */
  posterObjectKey: string | null;
  playbackUrl: string;
  manifestUrl: string | null;
  posterUrl: string | null;
  sources: StoredVideoSource[];
}

export type SyncResult = SyncTargets;

export interface RemoteObjectSnapshot {
  objectKey: string;
  relativePath: string;
  sizeBytes: number;
}

function parsePercent(line: string) {
  const match = line.match(/(\d{1,3})%/);
  if (!match) {
    return null;
  }

  return clamp(Number(match[1]));
}

function buildSourceTarget(
  settings: AppSettings,
  distributionObjectKey: string,
  source: PackagedVideoResult['sources'][number],
): StoredVideoSource {
  const objectKey = joinObjectKey(distributionObjectKey, source.relativePath);
  return {
    codec: source.codec,
    mimeType: source.mimeType,
    objectKey,
    url: joinPublicUrl(settings.r2.publicBaseUrl, objectKey),
  };
}

/**
 * Resolves every URL and object key for one ingest from its key plan.
 *
 * The poster is the only asset whose location depends on the layout: under the
 * canonical contract it lives in its own persistent `posters/` prefix and needs
 * a dedicated transfer, while legacy ingests ship it inside the distribution
 * package upload.
 */
export function buildSyncTargets(
  settings: AppSettings,
  keyPlan: StorageKeyPlan,
  artifact: PackagedVideoResult,
): SyncTargets {
  const { archiveObjectKey, distributionObjectKey } = keyPlan;
  const playbackObjectKey = joinObjectKey(
    distributionObjectKey,
    artifact.playbackRelativePath,
  );
  const manifestObjectKey = artifact.manifestRelativePath
    ? joinObjectKey(distributionObjectKey, artifact.manifestRelativePath)
    : null;
  const posterObjectKey = artifact.posterPath
    ? keyPlan.posterObjectKey ??
      joinObjectKey(distributionObjectKey, path.basename(artifact.posterPath))
    : null;

  return {
    archiveObjectKey,
    distributionObjectKey,
    posterObjectKey,
    playbackUrl: joinPublicUrl(settings.r2.publicBaseUrl, playbackObjectKey),
    manifestUrl: manifestObjectKey
      ? joinPublicUrl(settings.r2.publicBaseUrl, manifestObjectKey)
      : null,
    posterUrl: posterObjectKey
      ? joinPublicUrl(settings.r2.publicBaseUrl, posterObjectKey)
      : null,
    sources: artifact.sources.map((source) =>
      buildSourceTarget(settings, distributionObjectKey, source),
    ),
  };
}

export class SyncService {
  constructor(private readonly log: SyncLogger) {}

  async sync(task: SyncTask): Promise<SyncResult> {
    const targets = buildSyncTargets(task.settings, task.keyPlan, task.artifact);
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'csn-media-bridge-rclone-'));
    const configPath = path.join(configDirectory, 'rclone.conf');

    await writeFile(configPath, this.buildConfig(task.settings), 'utf8');

    const transferArgs = [
      '--config',
      configPath,
      '--stats',
      '1s',
      '--stats-one-line',
      '--retries',
      '3',
      '--low-level-retries',
      '10',
      '--retries-sleep',
      '2s',
      '--contimeout',
      '15s',
      '--timeout',
      '30s',
      '--progress',
      '--transfers',
      String(task.settings.uploadConcurrency),
      '--checkers',
      String(Math.max(4, task.settings.uploadConcurrency * 2)),
    ];

    try {
      task.onStageChange?.('uploading-archive', 'Uploading source archive.');
      await this.runRclone(
        [
          'copyto',
          task.sourcePath,
          `csnb2:${task.settings.b2.bucket}/${targets.archiveObjectKey}`,
          ...transferArgs,
        ],
        task.jobId,
        task.onLog,
        (percent) => task.onProgress(clamp(percent * 0.35)),
      );

      if (task.settings.verifyUploads) {
        task.onStageChange?.('verifying', 'Verifying archive upload integrity.');
        task.onLog('Verifying archive upload integrity...');
        await this.verifyUpload(
          task.sourcePath,
          `csnb2:${task.settings.b2.bucket}/${targets.archiveObjectKey}`,
          configPath,
          task.jobId,
          task.onLog,
        );
      }

      task.onProgress(35);

      task.onStageChange?.(
        'uploading-distribution',
        task.artifact.deliveryType === 'hls'
          ? 'Uploading HLS ladder.'
          : 'Uploading progressive playback renditions.',
      );
      await this.runRclone(
        [
          'copy',
          task.outputDirectory,
          `csnr2:${task.settings.r2.bucket}/${targets.distributionObjectKey}`,
          ...transferArgs,
        ],
        task.jobId,
        task.onLog,
        (percent) => task.onProgress(clamp(35 + percent * 0.65)),
      );

      if (task.settings.verifyUploads) {
        task.onStageChange?.('verifying', 'Verifying distribution upload integrity.');
        task.onLog('Verifying distribution upload integrity...');
        await this.verifyUpload(
          task.outputDirectory,
          `csnr2:${task.settings.r2.bucket}/${targets.distributionObjectKey}`,
          configPath,
          task.jobId,
          task.onLog,
        );
      }

      // Under the canonical layout the poster is published to its own
      // persistent `posters/` prefix so article cards and social previews keep
      // a stable URL that is independent of the playback package. The copy that
      // rode along inside the package upload is left in place — it costs a few
      // KB and keeps the package self-contained for anyone reading the bucket.
      if (targets.posterObjectKey && task.artifact.posterPath) {
        task.onStageChange?.('uploading-distribution', 'Publishing poster image.');
        await this.runRcloneCommand(
          [
            'copyto',
            task.artifact.posterPath,
            `csnr2:${task.settings.r2.bucket}/${targets.posterObjectKey}`,
            ...transferArgs,
          ],
          task.jobId,
          task.onLog,
        );
      }

      task.onProgress(100);
      return targets;
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  }

  /**
   * Server-side copy of one object within a provider, used by storage tasks to
   * promote a staged social render into the protected `scheduled/social/`
   * prefix before the staging lifecycle rule can expire it.
   */
  async copyRemoteObject(task: RemoteCopyTask) {
    if (!task.sourceObjectKey.trim() || !task.destinationObjectKey.trim()) {
      throw new Error('A source and destination object key are required to copy a remote object.');
    }

    const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'csn-media-bridge-rclone-'));
    const configPath = path.join(configDirectory, 'rclone.conf');

    await writeFile(configPath, this.buildConfig(task.settings), 'utf8');

    try {
      await this.runRcloneCommand(
        [
          '--config',
          configPath,
          'copyto',
          this.buildRemoteTarget(task.storage, task.bucket, task.sourceObjectKey),
          this.buildRemoteTarget(task.storage, task.bucket, task.destinationObjectKey),
          '--retries',
          '3',
          '--low-level-retries',
          '10',
          '--contimeout',
          '15s',
          '--timeout',
          '60s',
        ],
        task.jobId,
        task.onLog,
      );

      task.onLog(
        `Copied ${task.storage.toUpperCase()} object ${task.sourceObjectKey} to ${task.destinationObjectKey}.`,
      );
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  }

  async uploadDirectoryToB2(task: OffloadUploadTask): Promise<string> {
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'csn-media-bridge-rclone-'));
    const configPath = path.join(configDirectory, 'rclone.conf');

    await writeFile(configPath, this.buildConfig(task.settings), 'utf8');

    const transferArgs = [
      '--config',
      configPath,
      '--stats',
      '1s',
      '--stats-one-line',
      '--retries',
      '3',
      '--low-level-retries',
      '10',
      '--retries-sleep',
      '2s',
      '--contimeout',
      '15s',
      '--timeout',
      '30s',
      '--progress',
      '--checksum',
      '--transfers',
      String(task.settings.uploadConcurrency),
      '--checkers',
      String(Math.max(4, task.settings.uploadConcurrency * 2)),
    ];

    try {
      await this.runRclone(
        [
          'copy',
          task.localDirectory,
          `csnb2:${task.settings.b2.bucket}/${task.destinationObjectKey}`,
          ...transferArgs,
        ],
        task.jobId,
        task.onLog,
        task.onProgress,
        {
          onSpawn: task.onSpawn,
        },
      );

      if (task.settings.verifyUploads) {
        task.onLog('Verifying Backblaze offload upload integrity...');
        await this.verifyUpload(
          task.localDirectory,
          `csnb2:${task.settings.b2.bucket}/${task.destinationObjectKey}`,
          configPath,
          task.jobId,
          task.onLog,
        );
      }

      return task.destinationObjectKey;
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  }

  async uploadFileToR2(task: R2FileUploadTask): Promise<string> {
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'csn-media-bridge-rclone-'));
    const configPath = path.join(configDirectory, 'rclone.conf');

    await writeFile(configPath, this.buildConfig(task.settings), 'utf8');

    const transferArgs = [
      '--config',
      configPath,
      '--stats',
      '1s',
      '--stats-one-line',
      '--retries',
      '3',
      '--low-level-retries',
      '10',
      '--retries-sleep',
      '2s',
      '--contimeout',
      '15s',
      '--timeout',
      '30s',
      '--progress',
      '--checksum',
    ];

    try {
      await this.runRclone(
        [
          'copyto',
          task.localFilePath,
          `csnr2:${task.settings.r2.bucket}/${task.destinationObjectKey}`,
          ...transferArgs,
        ],
        task.jobId,
        task.onLog,
        () => undefined,
      );

      if (task.settings.verifyUploads) {
        task.onLog('Verifying uploaded poster image integrity...');
        await this.verifyUpload(
          task.localFilePath,
          `csnr2:${task.settings.r2.bucket}/${task.destinationObjectKey}`,
          configPath,
          task.jobId,
          task.onLog,
        );
      }

      return task.destinationObjectKey;
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  }

  async downloadFileFromB2(task: B2FileDownloadTask): Promise<string> {
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'csn-media-bridge-rclone-'));
    const configPath = path.join(configDirectory, 'rclone.conf');

    await writeFile(configPath, this.buildConfig(task.settings), 'utf8');
    await mkdir(path.dirname(task.localFilePath), { recursive: true });

    const transferArgs = [
      '--config',
      configPath,
      '--stats',
      '1s',
      '--stats-one-line',
      '--retries',
      '3',
      '--low-level-retries',
      '10',
      '--retries-sleep',
      '2s',
      '--contimeout',
      '15s',
      '--timeout',
      '30s',
      '--progress',
    ];

    try {
      await this.runRclone(
        [
          'copyto',
          `csnb2:${task.settings.b2.bucket}/${task.sourceObjectKey}`,
          task.localFilePath,
          ...transferArgs,
        ],
        task.jobId,
        task.onLog,
        task.onProgress,
      );

      return task.localFilePath;
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  }

  async listRemoteObjects(task: RemoteListTask): Promise<RemoteObjectSnapshot[]> {
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'csn-media-bridge-rclone-'));
    const configPath = path.join(configDirectory, 'rclone.conf');
    const normalizedPrefix = task.remotePrefix.replace(/^\/+|\/+$/g, '');

    await writeFile(configPath, this.buildConfig(task.settings), 'utf8');

    try {
      const remoteTarget = this.buildRemoteTarget(task.storage, task.bucket, normalizedPrefix);
      const output = await this.runRcloneJsonCommand(
        [
          'lsjson',
          remoteTarget,
          '--config',
          configPath,
          '--files-only',
          ...(task.recursive ? ['--recursive'] : []),
        ],
        task.jobId,
        task.onLog,
        true,
      );

      const parsed = JSON.parse(output) as RcloneLsJsonEntry[];
      return parsed.map((entry) => {
        const relativePath = entry.Path ?? entry.Name ?? '';
        return {
          objectKey: joinObjectKey(normalizedPrefix, relativePath),
          relativePath,
          sizeBytes: entry.Size ?? 0,
        };
      });
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  }

  async deleteRemoteFile(task: RemoteDeleteTask) {
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'csn-media-bridge-rclone-'));
    const configPath = path.join(configDirectory, 'rclone.conf');
    const normalizedObjectKey = task.objectKey.replace(/^\/+|\/+$/g, '');

    await writeFile(configPath, this.buildConfig(task.settings), 'utf8');

    try {
      await this.runRcloneCommand(
        [
          'deletefile',
          this.buildRemoteTarget(task.storage, task.bucket, normalizedObjectKey),
          '--config',
          configPath,
        ],
        task.jobId,
        task.onLog,
      );
    } catch (error) {
      if (!this.isMissingRemoteError(error)) {
        throw error;
      }
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  }

  async purgeRemotePrefix(task: RemotePurgeTask) {
    const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'csn-media-bridge-rclone-'));
    const configPath = path.join(configDirectory, 'rclone.conf');
    const normalizedPrefix = task.remotePrefix.replace(/^\/+|\/+$/g, '');

    if (!normalizedPrefix) {
      throw new Error('Remote prefix is required before purging cloud objects.');
    }

    await writeFile(configPath, this.buildConfig(task.settings), 'utf8');

    try {
      await this.runRcloneCommand(
        [
          'purge',
          this.buildRemoteTarget(task.storage, task.bucket, normalizedPrefix),
          '--config',
          configPath,
        ],
        task.jobId,
        task.onLog,
      );
    } catch (error) {
      if (!this.isMissingRemoteError(error)) {
        throw error;
      }
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  }

  private buildConfig(settings: AppSettings) {
    return [
      '[csnb2]',
      'type = b2',
      `account = ${settings.b2.keyId}`,
      `key = ${settings.b2.applicationKey}`,
      '',
      '[csnr2]',
      'type = s3',
      'provider = Cloudflare',
      `access_key_id = ${settings.r2.accessKeyId}`,
      `secret_access_key = ${settings.r2.secretAccessKey}`,
      `endpoint = https://${settings.r2.accountId}.r2.cloudflarestorage.com`,
      'acl = private',
      '',
    ].join('\n');
  }

  private buildRemoteTarget(storage: 'b2' | 'r2', bucket: string, objectKey: string) {
    const remoteName = storage === 'b2' ? 'csnb2' : 'csnr2';
    return objectKey ? `${remoteName}:${bucket}/${objectKey}` : `${remoteName}:${bucket}`;
  }

  private isMissingRemoteError(error: unknown) {
    const message = formatFriendlyError(error).toLowerCase();
    return (
      message.includes('directory not found') ||
      message.includes('object not found') ||
      message.includes('not found') ||
      message.includes('did not find section in config file')
    );
  }

  private async verifyUpload(
    sourcePath: string,
    destinationPath: string,
    configPath: string,
    jobId: string,
    onLog: (message: string) => void,
  ) {
    const verificationArgs = await this.buildVerificationArgs(
      sourcePath,
      destinationPath,
      configPath,
    );

    try {
      await this.runRcloneCommand(
        [
          ...verificationArgs,
          '--checksum',
        ],
        jobId,
        onLog,
      );
      this.log('info', 'Checksum verification completed successfully.', jobId);
    } catch (error) {
      onLog(
        `Checksum verification could not complete cleanly (${formatFriendlyError(error)}). Falling back to byte-level verification.`,
      );
      await this.runRcloneCommand(
        [
          ...verificationArgs,
          '--download',
        ],
        jobId,
        onLog,
      );
      this.log('info', 'Byte-level verification completed successfully.', jobId);
    }
  }

  private async buildVerificationArgs(
    sourcePath: string,
    destinationPath: string,
    configPath: string,
  ) {
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isFile()) {
      return [
        'check',
        sourcePath,
        destinationPath,
        '--config',
        configPath,
        '--one-way',
      ];
    }

    const fileListPath = path.join(path.dirname(configPath), 'verify-files.txt');
    await writeFile(fileListPath, `${path.basename(sourcePath)}\n`, 'utf8');

    return [
      'check',
      path.dirname(sourcePath),
      path.posix.dirname(destinationPath),
      '--config',
      configPath,
      '--one-way',
      '--files-from-raw',
      fileListPath,
    ];
  }

  private runRclone(
    args: string[],
    jobId: string,
    onLog: (message: string) => void,
    onProgress: (percent: number) => void,
    options?: RcloneExecutionOptions,
  ) {
    return this.runRcloneCommand(args, jobId, onLog, onProgress, options);
  }

  private runRcloneCommand(
    args: string[],
    jobId: string,
    onLog: (message: string) => void,
    onProgress?: (percent: number) => void,
    options?: RcloneExecutionOptions,
  ) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn('rclone', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      options?.onSpawn?.(child);
      let stdout = '';
      let stderr = '';

      const consumeStream = (stream: NodeJS.ReadableStream | null) => {
        if (!stream) {
          return;
        }

        const reader = readline.createInterface({ input: stream });
        reader.on('line', (line) => {
          onLog(line);
          if (!onProgress) {
            return;
          }

          const percent = parsePercent(line);
          if (percent !== null) {
            onProgress(percent);
          }
        });
      };

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      consumeStream(child.stdout);
      consumeStream(child.stderr);

      child.on('error', (error) => {
        options?.onSpawn?.(null);
        reject(new Error(detectPipelineError(error.message)));
      });

      child.on('close', (code) => {
        options?.onSpawn?.(null);
        if (code === 0) {
          this.log('info', 'Rclone command completed successfully.', jobId);
          resolve();
          return;
        }

        const output = `${stdout}\n${stderr}`.trim();
        reject(
          new Error(
            detectPipelineError(output || `rclone exited with code ${code ?? 'unknown'}.`),
          ),
        );
      });
    });
  }

  private runRcloneJsonCommand(
    args: string[],
    jobId: string,
    onLog: (message: string) => void,
    allowMissingRemote = false,
  ) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn('rclone', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        const line = chunk.toString();
        stderr += line;
        const trimmed = line.trim();
        if (trimmed) {
          onLog(trimmed);
        }
      });

      child.on('error', (error) => {
        reject(new Error(detectPipelineError(error.message)));
      });

      child.on('close', (code) => {
        if (code === 0) {
          this.log('info', 'Rclone inspection command completed successfully.', jobId);
          resolve(stdout);
          return;
        }

        const output = `${stdout}\n${stderr}`.trim();
        if (allowMissingRemote && this.isMissingRemoteError(output)) {
          resolve('[]');
          return;
        }

        reject(new Error(detectPipelineError(output || `rclone exited with code ${code ?? 'unknown'}.`)));
      });
    });
  }
}

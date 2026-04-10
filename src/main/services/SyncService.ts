import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import {
  clamp,
  detectPipelineError,
  formatFriendlyError,
  joinObjectKey,
  joinPublicUrl,
} from '../lib/helpers';
import type { AppSettings, LogLevel, StoredVideoSource } from '../../shared/types';
import type { PackagedVideoResult } from './TranscodeService';

interface SyncLogger {
  (level: LogLevel, message: string, jobId?: string): void;
}

interface SyncTask {
  jobId: string;
  sourcePath: string;
  sourceName: string;
  outputDirectory: string;
  jobFolderName: string;
  artifact: PackagedVideoResult;
  settings: AppSettings;
  onProgress: (progress: number) => void;
  onStageChange?: (
    stage: 'uploading-archive' | 'uploading-distribution' | 'verifying',
    message: string,
  ) => void;
  onLog: (message: string) => void;
}

export interface SyncTargets {
  archiveObjectKey: string;
  distributionObjectKey: string;
  playbackUrl: string;
  manifestUrl: string | null;
  posterUrl: string | null;
  sources: StoredVideoSource[];
}

export type SyncResult = SyncTargets;

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

export function buildSyncTargets(
  settings: AppSettings,
  jobFolderName: string,
  sourceName: string,
  artifact: PackagedVideoResult,
): SyncTargets {
  const archiveObjectKey = joinObjectKey(
    settings.b2.pathPrefix,
    jobFolderName,
    sourceName,
  );
  const distributionObjectKey = joinObjectKey(settings.r2.pathPrefix, jobFolderName);
  const playbackObjectKey = joinObjectKey(
    distributionObjectKey,
    artifact.playbackRelativePath,
  );
  const manifestObjectKey = artifact.manifestRelativePath
    ? joinObjectKey(distributionObjectKey, artifact.manifestRelativePath)
    : null;
  const posterObjectKey = artifact.posterPath
    ? joinObjectKey(distributionObjectKey, path.basename(artifact.posterPath))
    : null;

  return {
    archiveObjectKey,
    distributionObjectKey,
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
    const targets = buildSyncTargets(
      task.settings,
      task.jobFolderName,
      task.sourceName,
      task.artifact,
    );
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

      task.onProgress(100);
      return targets;
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
  ) {
    return this.runRcloneCommand(args, jobId, onLog, onProgress);
  }

  private runRcloneCommand(
    args: string[],
    jobId: string,
    onLog: (message: string) => void,
    onProgress?: (percent: number) => void,
  ) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn('rclone', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

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

      consumeStream(child.stdout);
      consumeStream(child.stderr);

      child.on('error', (error) => {
        reject(new Error(detectPipelineError(error.message)));
      });

      child.on('close', (code) => {
        if (code === 0) {
          this.log('info', 'Rclone command completed successfully.', jobId);
          resolve();
          return;
        }

        reject(new Error(detectPipelineError(`rclone exited with code ${code ?? 'unknown'}.`)));
      });
    });
  }
}

import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants, createReadStream, type Dirent } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import {
  clamp,
  createId,
  formatFriendlyError,
  joinObjectKey,
  nowIso,
  slugify,
} from '../lib/helpers';
import type {
  AppSettings,
  OffloadLocalCopyMode,
  OffloadSourceKind,
  OffloadSourceSnapshot,
  OffloadTaskSnapshot,
  OffloadTaskStatus,
  RunOffloadTaskRequest,
} from '../../shared/types';
import { SyncService } from './SyncService';

interface OffloadFileEntry {
  absolutePath: string;
  relativePath: string;
  size: number;
  kind: OffloadSourceKind;
  mtimeMs: number;
}

interface RunOffloadTaskOptions {
  request: RunOffloadTaskRequest;
  settings: AppSettings;
  onSnapshot: (snapshot: OffloadTaskSnapshot) => void;
  onLog: (message: string) => void;
}

interface StageWeights {
  copy: number;
  convert: number;
  upload: number;
}

interface OffloadUploadAsset {
  sourcePath: string;
  relativePath: string;
}

interface OffloadManifestEntry {
  relativePath: string;
  kind: OffloadSourceKind;
  size: number;
  mtimeMs: number;
  sourceChecksum: string | null;
  localStatus: 'pending' | 'verified';
  localVerificationMode: 'checksum' | 'metadata' | null;
  localChecksum: string | null;
  localCopiedAt: string | null;
  webpRelativePath: string | null;
  webpStatus: 'not_requested' | 'pending' | 'verified';
  webpChecksum: string | null;
  webpSize: number | null;
  webpCreatedAt: string | null;
}

interface OffloadManifest {
  version: number;
  taskId: string;
  sourcePath: string;
  sourceName: string;
  jobName: string;
  folderName: string;
  localDestinationPath: string;
  originalsPath: string;
  webReadyPath: string | null;
  manifestPath: string;
  logPath: string;
  cloudObjectKey: string | null;
  convertImagesToWebp: boolean;
  uploadToB2: boolean;
  status: OffloadTaskStatus;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  copyProgress: number;
  conversionProgress: number;
  uploadProgress: number;
  overallProgress: number;
  skippedFiles: number;
  entries: OffloadManifestEntry[];
}

interface ResolvedPackagePaths {
  folderName: string;
  localDestinationPath: string;
  originalsPath: string;
  webReadyPath: string;
  manifestPath: string;
  logPath: string;
  cloudObjectKey: string;
  existingManifest: OffloadManifest | null;
}

interface OffloadManifestSummary {
  copiedFiles: number;
  copiedBytes: number;
  convertedImageCount: number;
}

interface OffloadExecution {
  pauseRequested: boolean;
  cancelRequested: boolean;
  currentUploadChild: ChildProcessWithoutNullStreams | null;
  snapshot: OffloadTaskSnapshot;
  emitSnapshot: (patch: Partial<OffloadTaskSnapshot>) => Promise<void>;
  appendLog: (message: string) => Promise<void>;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.webm']);
const VOLUME_METADATA_DIRECTORY_NAMES = new Set([
  '.Spotlight-V100',
  '.Trashes',
  '.fseventsd',
  '.TemporaryItems',
  '.DocumentRevisions-V100',
  '$RECYCLE.BIN',
  'System Volume Information',
]);
const WEBP_QUALITY = 82;
const OFFLOAD_MANIFEST_VERSION = 3;
const OFFLOAD_MANIFEST_FILENAME = 'offload-manifest.json';
const OFFLOAD_LOG_FILENAME = 'offload.log';
const LOCAL_COPY_MTIME_TOLERANCE_MS = 2000;

class OffloadPausedError extends Error {
  constructor(message = 'Offload paused. Resume later to continue from the same package.') {
    super(message);
    this.name = 'OffloadPausedError';
  }
}

class OffloadCanceledError extends Error {
  constructor(message = 'Offload canceled. You can resume later from the same package if needed.') {
    super(message);
    this.name = 'OffloadCanceledError';
  }
}

function isPermissionError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = 'code' in error ? error.code : null;
  return code === 'EPERM' || code === 'EACCES';
}

function shouldSkipDirectory(entryName: string) {
  return VOLUME_METADATA_DIRECTORY_NAMES.has(entryName);
}

function classifyFile(filePath: string): OffloadSourceKind {
  const extension = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }

  if (VIDEO_EXTENSIONS.has(extension)) {
    return 'video';
  }

  return 'other';
}

function buildStageWeights(convertImagesToWebp: boolean, uploadToB2: boolean): StageWeights {
  if (convertImagesToWebp && uploadToB2) {
    return { copy: 60, convert: 20, upload: 20 };
  }

  if (convertImagesToWebp) {
    return { copy: 75, convert: 25, upload: 0 };
  }

  if (uploadToB2) {
    return { copy: 75, convert: 0, upload: 25 };
  }

  return { copy: 100, convert: 0, upload: 0 };
}

function calculateOverallProgress(
  weights: StageWeights,
  copyProgress: number,
  conversionProgress: number,
  uploadProgress: number,
) {
  return clamp(
    (copyProgress * weights.copy) / 100 +
      (conversionProgress * weights.convert) / 100 +
      (uploadProgress * weights.upload) / 100,
  );
}

function buildOffloadFolderName(jobName: string) {
  const normalizedName = slugify(jobName) || 'offload';
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  return `${timestamp}-${normalizedName}-${createId().slice(0, 6)}`;
}

async function collectFiles(
  rootPath: string,
  currentPath = rootPath,
): Promise<OffloadFileEntry[]> {
  let directoryEntries: Dirent[];
  try {
    directoryEntries = await readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    if (isPermissionError(error)) {
      return [];
    }

    throw error;
  }

  directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

  const files: OffloadFileEntry[] = [];

  for (const entry of directoryEntries) {
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) {
        continue;
      }

      files.push(...(await collectFiles(rootPath, absolutePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    let fileStats;
    try {
      fileStats = await stat(absolutePath);
    } catch (error) {
      if (isPermissionError(error)) {
        continue;
      }

      throw error;
    }

    files.push({
      absolutePath,
      relativePath: path.relative(rootPath, absolutePath),
      size: fileStats.size,
      kind: classifyFile(absolutePath),
      mtimeMs: fileStats.mtimeMs,
    });
  }

  return files;
}

function buildSourceSnapshot(sourcePath: string, files: OffloadFileEntry[]): OffloadSourceSnapshot {
  const imageCount = files.filter((file) => file.kind === 'image').length;
  const videoCount = files.filter((file) => file.kind === 'video').length;

  return {
    sourcePath,
    sourceName: path.basename(sourcePath),
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    imageCount,
    videoCount,
    otherCount: files.length - imageCount - videoCount,
  };
}

function toWebpRelativePath(relativePath: string) {
  return relativePath.replace(/\.(png|jpe?g)$/i, '.webp');
}

async function computeFileChecksum(filePath: string) {
  return await new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);

    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

function timestampsMatch(actualMs: number, expectedMs: number) {
  return Math.abs(actualMs - expectedMs) <= LOCAL_COPY_MTIME_TOLERANCE_MS;
}

async function readManifest(manifestPath: string) {
  try {
    const manifestContent = await readFile(manifestPath, 'utf8');
    return JSON.parse(manifestContent) as OffloadManifest;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return null;
    }

    throw error;
  }
}

async function writeManifest(manifest: OffloadManifest) {
  await writeFile(manifest.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function findExistingManifest(destinationRoot: string, sourcePath: string, jobName: string) {
  let directoryEntries: Dirent[];
  try {
    directoryEntries = await readdir(destinationRoot, { withFileTypes: true });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }

    throw error;
  }

  let latestManifest: OffloadManifest | null = null;

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = path.join(destinationRoot, entry.name, OFFLOAD_MANIFEST_FILENAME);
    const manifest = await readManifest(manifestPath);
    if (!manifest) {
      continue;
    }

    if (manifest.sourcePath !== sourcePath || manifest.jobName !== jobName) {
      continue;
    }

    if (!latestManifest || manifest.updatedAt > latestManifest.updatedAt) {
      latestManifest = manifest;
    }
  }

  return latestManifest;
}

function getManifestEntry(manifest: OffloadManifest, relativePath: string) {
  return manifest.entries.find((entry) => entry.relativePath === relativePath) ?? null;
}

function summarizeManifest(manifest: OffloadManifest, files: OffloadFileEntry[]): OffloadManifestSummary {
  let copiedFiles = 0;
  let copiedBytes = 0;
  let convertedImageCount = 0;

  for (const file of files) {
    const entry = getManifestEntry(manifest, file.relativePath);
    if (!entry) {
      continue;
    }

    if (entry.localStatus === 'verified') {
      copiedFiles += 1;
      copiedBytes += file.size;
    }

    if (file.kind === 'image' && entry.webpStatus === 'verified') {
      convertedImageCount += 1;
    }
  }

  return {
    copiedFiles,
    copiedBytes,
    convertedImageCount,
  };
}

function buildTaskSnapshot(
  manifest: OffloadManifest,
  source: OffloadSourceSnapshot,
  summary: OffloadManifestSummary,
): OffloadTaskSnapshot {
  return {
    id: manifest.taskId,
    status: manifest.status,
    message: manifest.message,
    sourcePath: manifest.sourcePath,
    sourceName: manifest.sourceName,
    jobName: manifest.jobName,
    localDestinationPath: manifest.localDestinationPath,
    webReadyPath: manifest.webReadyPath,
    cloudObjectKey: manifest.cloudObjectKey,
    manifestPath: manifest.manifestPath,
    logPath: manifest.logPath,
    copyProgress: manifest.copyProgress,
    conversionProgress: manifest.conversionProgress,
    uploadProgress: manifest.uploadProgress,
    overallProgress: manifest.overallProgress,
    totalFiles: source.fileCount,
    imageCount: source.imageCount,
    copiedFiles: summary.copiedFiles,
    totalBytes: source.totalBytes,
    copiedBytes: summary.copiedBytes,
    convertedImageCount: summary.convertedImageCount,
    skippedFiles: manifest.skippedFiles,
    uploadEnabled: manifest.uploadToB2,
    startedAt: manifest.startedAt,
    completedAt: manifest.completedAt,
    errorMessage: manifest.errorMessage,
  };
}

function createManifest(
  source: OffloadSourceSnapshot,
  request: RunOffloadTaskRequest,
  paths: ResolvedPackagePaths,
): OffloadManifest {
  const createdAt = nowIso();

  return {
    version: OFFLOAD_MANIFEST_VERSION,
    taskId: createId(),
    sourcePath: source.sourcePath,
    sourceName: source.sourceName,
    jobName: request.jobName.trim() || source.sourceName,
    folderName: paths.folderName,
    localDestinationPath: paths.localDestinationPath,
    originalsPath: paths.originalsPath,
    webReadyPath: request.convertImagesToWebp ? paths.webReadyPath : null,
    manifestPath: paths.manifestPath,
    logPath: paths.logPath,
    cloudObjectKey: request.uploadToB2 ? paths.cloudObjectKey : null,
    convertImagesToWebp: request.convertImagesToWebp,
    uploadToB2: request.uploadToB2,
    status: 'preparing',
    message: 'Preparing the offload package.',
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: null,
    errorMessage: null,
    copyProgress: 0,
    conversionProgress: 0,
    uploadProgress: 0,
    overallProgress: 0,
    skippedFiles: 0,
    entries: [],
  };
}

export class OffloadService {
  private activeExecution: OffloadExecution | null = null;

  constructor(private readonly syncService: SyncService) {}

  async inspectSourceFolder(sourcePath: string): Promise<OffloadSourceSnapshot> {
    const resolvedSourcePath = path.resolve(sourcePath);
    const sourceStats = await stat(resolvedSourcePath);
    if (!sourceStats.isDirectory()) {
      throw new Error('Choose a folder to offload, not a single file.');
    }

    const files = await collectFiles(resolvedSourcePath);
    if (files.length === 0) {
      throw new Error('The selected folder is empty.');
    }

    return buildSourceSnapshot(resolvedSourcePath, files);
  }

  getLatestActiveSnapshot() {
    return this.activeExecution?.snapshot ?? null;
  }

  requestPause() {
    const execution = this.activeExecution;
    if (!execution) {
      return null;
    }

    execution.pauseRequested = true;
    if (execution.currentUploadChild) {
      execution.currentUploadChild.kill();
    }

    void execution.appendLog('Pause requested. The offload will stop at the next safe checkpoint.');
    void execution.emitSnapshot({
      message: execution.currentUploadChild
        ? 'Pause requested. Stopping the image upload at the next transfer checkpoint.'
        : 'Pause requested. Stopping after the current file finishes.',
    });

    return execution.snapshot;
  }

  requestCancel() {
    const execution = this.activeExecution;
    if (!execution) {
      return null;
    }

    execution.cancelRequested = true;
    if (execution.currentUploadChild) {
      execution.currentUploadChild.kill();
    }

    void execution.appendLog('Cancel requested. The offload will stop at the next safe checkpoint.');
    void execution.emitSnapshot({
      message: execution.currentUploadChild
        ? 'Cancel requested. Stopping the image upload now.'
        : 'Cancel requested. Stopping after the current file finishes.',
    });

    return execution.snapshot;
  }

  async runTask({
    request,
    settings,
    onSnapshot,
    onLog,
  }: RunOffloadTaskOptions): Promise<OffloadTaskSnapshot> {
    if (!settings.offload.localFolder) {
      throw new Error('Set an offload destination folder in Settings before starting an offload.');
    }

    if (request.uploadToB2) {
      if (!settings.b2.bucket) {
        throw new Error('Backblaze B2 bucket is required for cloud offloads.');
      }

      if (!settings.b2.keyId || !settings.b2.applicationKey) {
        throw new Error('Backblaze B2 credentials are required for cloud offloads.');
      }
    }

    const resolvedSourcePath = path.resolve(request.sourcePath);
    const files = await collectFiles(resolvedSourcePath);
    if (files.length === 0) {
      throw new Error('The selected folder is empty.');
    }

    const source = buildSourceSnapshot(resolvedSourcePath, files);
    const resolvedJobName = request.jobName.trim() || source.sourceName;
    const paths = await this.resolvePackagePaths(settings, source, resolvedJobName);
    const relativeDestination = path.relative(resolvedSourcePath, paths.localDestinationPath);
    if (
      relativeDestination === '' ||
      (!relativeDestination.startsWith('..') && !path.isAbsolute(relativeDestination))
    ) {
      throw new Error('Offload destination cannot be inside the selected source folder.');
    }

    const manifest =
      paths.existingManifest ?? createManifest(source, { ...request, jobName: resolvedJobName }, paths);

    this.prepareManifestForRun(manifest, source, files, {
      ...request,
      jobName: resolvedJobName,
    }, paths);

    const stageWeights = buildStageWeights(request.convertImagesToWebp, request.uploadToB2);
    const initialSummary = summarizeManifest(manifest, files);
    let snapshot = buildTaskSnapshot(manifest, source, initialSummary);

    const persistManifestFromSnapshot = async () => {
      manifest.status = snapshot.status;
      manifest.message = snapshot.message;
      manifest.updatedAt = nowIso();
      manifest.completedAt = snapshot.completedAt;
      manifest.errorMessage = snapshot.errorMessage;
      manifest.copyProgress = snapshot.copyProgress;
      manifest.conversionProgress = snapshot.conversionProgress;
      manifest.uploadProgress = snapshot.uploadProgress;
      manifest.overallProgress = snapshot.overallProgress;
      manifest.skippedFiles = snapshot.skippedFiles;
      await writeManifest(manifest);
    };

    const appendTaskLog = async (message: string) => {
      const timestampedMessage = `[${new Date().toLocaleString()}] ${message}`;
      onLog(message);
      await appendFile(manifest.logPath, `${timestampedMessage}\n`, 'utf8');
    };

    const emitSnapshot = async (patch: Partial<OffloadTaskSnapshot>) => {
      snapshot = {
        ...snapshot,
        ...patch,
      };

      const recalculatedOverallProgress = calculateOverallProgress(
        stageWeights,
        snapshot.copyProgress,
        snapshot.conversionProgress,
        snapshot.uploadProgress,
      );

      snapshot.overallProgress =
        snapshot.status === 'complete'
          ? 100
          : patch.overallProgress ?? recalculatedOverallProgress;

      this.activeExecution = {
        ...this.activeExecution,
        pauseRequested: this.activeExecution?.pauseRequested ?? false,
        cancelRequested: this.activeExecution?.cancelRequested ?? false,
        currentUploadChild: this.activeExecution?.currentUploadChild ?? null,
        snapshot,
        emitSnapshot,
        appendLog: appendTaskLog,
      };
      onSnapshot(snapshot);
      await persistManifestFromSnapshot();
    };

    this.activeExecution = {
      pauseRequested: false,
      cancelRequested: false,
      currentUploadChild: null,
      snapshot,
      emitSnapshot,
      appendLog: appendTaskLog,
    };

    await mkdir(paths.localDestinationPath, { recursive: true });
    await writeManifest(manifest);
    onSnapshot(snapshot);

    try {
      await appendTaskLog(
        paths.existingManifest
          ? `Resuming offload for ${source.sourceName} at ${paths.localDestinationPath}.`
          : `Starting offload for ${source.sourceName} at ${paths.localDestinationPath}.`,
      );

      await mkdir(paths.originalsPath, { recursive: true });
      if (request.convertImagesToWebp) {
        await mkdir(paths.webReadyPath, { recursive: true });
      }

      const imageFiles = files.filter((file) => file.kind === 'image');
      let skippedFiles = 0;

      await emitSnapshot({
        status: 'copying',
        message:
          settings.offload.localCopyMode === 'fast'
            ? 'Copying source files into the local offload package with fast metadata checks.'
            : 'Verifying and copying source files into the local offload package with checksums.',
        skippedFiles,
        completedAt: null,
        errorMessage: null,
        uploadEnabled: request.uploadToB2,
      });

      for (const file of files) {
        await this.throwIfInterrupted();

        const entry = this.ensureManifestEntry(manifest, file, request.convertImagesToWebp);
        const copyOutcome = await this.ensureLocalOriginal(
          file,
          entry,
          paths.originalsPath,
          settings.offload.localCopyMode,
        );
        if (copyOutcome === 'skipped') {
          skippedFiles += 1;
          await appendTaskLog(`Reused verified local copy for ${file.relativePath}.`);
        } else {
          await appendTaskLog(
            settings.offload.localCopyMode === 'fast'
              ? `Copied ${file.relativePath} with fast local verification.`
              : `Copied and checksum-verified ${file.relativePath}.`,
          );
        }

        const summary = summarizeManifest(manifest, files);
        await emitSnapshot({
          copiedFiles: summary.copiedFiles,
          copiedBytes: summary.copiedBytes,
          skippedFiles,
          copyProgress:
            source.totalBytes > 0
              ? clamp((summary.copiedBytes / source.totalBytes) * 100)
              : clamp((summary.copiedFiles / source.fileCount) * 100),
          message:
            copyOutcome === 'skipped'
              ? `Verified ${file.relativePath}; existing local copy reused.`
              : settings.offload.localCopyMode === 'fast'
                ? `Copied ${file.relativePath} with fast local verification.`
                : `Copied and checksum-verified ${file.relativePath}.`,
        });
      }

      if (request.convertImagesToWebp) {
        await emitSnapshot({
          status: 'converting',
          message:
            imageFiles.length > 0
              ? 'Generating checksum-tracked webp copies for image assets.'
              : 'No PNG or JPEG files found to convert.',
          conversionProgress: imageFiles.length === 0 ? 100 : snapshot.conversionProgress,
          skippedFiles,
        });

        for (const imageFile of imageFiles) {
          await this.throwIfInterrupted();

          const entry = this.ensureManifestEntry(manifest, imageFile, true);
          const convertOutcome = await this.ensureWebReadyImage(imageFile, entry, paths.webReadyPath);
          if (convertOutcome === 'skipped') {
            skippedFiles += 1;
            await appendTaskLog(`Reused verified webp image for ${imageFile.relativePath}.`);
          } else {
            await appendTaskLog(`Generated and checksum-verified webp image for ${imageFile.relativePath}.`);
          }

          const summary = summarizeManifest(manifest, files);
          await emitSnapshot({
            convertedImageCount: summary.convertedImageCount,
            skippedFiles,
            conversionProgress:
              imageFiles.length > 0
                ? clamp((summary.convertedImageCount / imageFiles.length) * 100)
                : 100,
            message:
              convertOutcome === 'skipped'
                ? `Verified existing webp output for ${imageFile.relativePath}.`
                : `Converted ${imageFile.relativePath} to webp.`,
          });
        }
      }

      if (request.uploadToB2 && manifest.cloudObjectKey) {
        await this.throwIfInterrupted();

        const uploadAssets = this.buildUploadAssets({
          imageFiles,
          originalsPath: paths.originalsPath,
          webReadyPath: request.convertImagesToWebp ? paths.webReadyPath : null,
          includeWebReady: request.convertImagesToWebp,
        });

        if (uploadAssets.length === 0) {
          await appendTaskLog('No picture files were found for cloud upload. Video files remain local only.');
          await emitSnapshot({
            status: 'uploading',
            uploadProgress: 100,
            skippedFiles,
            message: 'No picture files found for Backblaze upload. Video files stay local only.',
          });
        } else {
          await appendTaskLog(
            `Uploading ${uploadAssets.length} image assets to Backblaze B2 at ${manifest.cloudObjectKey}.`,
          );
          await emitSnapshot({
            status: 'uploading',
            skippedFiles,
            message: 'Uploading image assets to Backblaze B2 with resumable checksum comparison.',
          });

          const uploadDirectory = await this.stageUploadDirectory(uploadAssets);
          try {
            await this.syncService.uploadDirectoryToB2({
              jobId: snapshot.id,
              localDirectory: uploadDirectory,
              destinationObjectKey: manifest.cloudObjectKey,
              settings,
              onProgress: async (uploadProgress) => {
                await emitSnapshot({
                  uploadProgress,
                  skippedFiles,
                  message: `Uploading image assets to Backblaze B2 (${Math.round(uploadProgress)}%).`,
                });
              },
              onLog: (message) => {
                void appendTaskLog(message);
              },
              onSpawn: (child) => {
                if (this.activeExecution) {
                  this.activeExecution.currentUploadChild = child;
                }
              },
            });
          } catch (error) {
            if (this.activeExecution?.cancelRequested) {
              throw new OffloadCanceledError();
            }

            if (this.activeExecution?.pauseRequested) {
              throw new OffloadPausedError();
            }

            throw error;
          } finally {
            if (this.activeExecution) {
              this.activeExecution.currentUploadChild = null;
            }
            await rm(uploadDirectory, { recursive: true, force: true });
          }

          await appendTaskLog('Backblaze image upload completed successfully.');
          await emitSnapshot({
            uploadProgress: 100,
            skippedFiles,
            message: 'Image upload completed. Remote resume data is preserved by reusing the same cloud prefix.',
          });
        }
      }

      await appendTaskLog(`Offload completed successfully for ${source.sourceName}.`);
      await emitSnapshot({
        status: 'complete',
        message:
          !request.uploadToB2
            ? 'Offload finished locally with manifest and checksum tracking.'
            : 'Offload finished. Video files remain local, picture files were uploaded, and the package can be resumed later if needed.',
        copyProgress: 100,
        conversionProgress:
          request.convertImagesToWebp
            ? 100
            : snapshot.conversionProgress,
        uploadProgress:
          request.uploadToB2
            ? 100
            : snapshot.uploadProgress,
        skippedFiles,
        completedAt: nowIso(),
        errorMessage: null,
      });

      return snapshot;
    } catch (error) {
      if (error instanceof OffloadPausedError) {
        await appendTaskLog(error.message);
        await emitSnapshot({
          status: 'paused',
          message: error.message,
          errorMessage: null,
        });
        return snapshot;
      }

      if (error instanceof OffloadCanceledError) {
        await appendTaskLog(error.message);
        await emitSnapshot({
          status: 'canceled',
          message: error.message,
          completedAt: nowIso(),
          errorMessage: null,
        });
        return snapshot;
      }

      const errorMessage = formatFriendlyError(error);
      await appendTaskLog(`Offload failed: ${errorMessage}`);
      await emitSnapshot({
        status: 'error',
        message: errorMessage,
        completedAt: nowIso(),
        errorMessage,
      });
      throw error;
    } finally {
      this.activeExecution = null;
    }
  }

  private async resolvePackagePaths(
    settings: AppSettings,
    source: OffloadSourceSnapshot,
    jobName: string,
  ): Promise<ResolvedPackagePaths> {
    const destinationRoot = path.resolve(settings.offload.localFolder);
    await mkdir(destinationRoot, { recursive: true });

    const existingManifest = await findExistingManifest(destinationRoot, source.sourcePath, jobName);
    const folderName = existingManifest?.folderName ?? buildOffloadFolderName(jobName);
    const localDestinationPath = existingManifest?.localDestinationPath ?? path.join(destinationRoot, folderName);
    const originalsPath = existingManifest?.originalsPath ?? localDestinationPath;
    const webReadyPath = existingManifest?.webReadyPath ?? path.join(localDestinationPath, 'web-ready');
    const manifestPath = existingManifest?.manifestPath ?? path.join(localDestinationPath, OFFLOAD_MANIFEST_FILENAME);
    const logPath = existingManifest?.logPath ?? path.join(localDestinationPath, OFFLOAD_LOG_FILENAME);

    return {
      folderName,
      localDestinationPath,
      originalsPath,
      webReadyPath,
      manifestPath,
      logPath,
      cloudObjectKey: joinObjectKey(settings.offload.b2PathPrefix, folderName),
      existingManifest,
    };
  }

  private prepareManifestForRun(
    manifest: OffloadManifest,
    source: OffloadSourceSnapshot,
    files: OffloadFileEntry[],
    request: RunOffloadTaskRequest,
    paths: ResolvedPackagePaths,
  ) {
    manifest.sourcePath = source.sourcePath;
    manifest.sourceName = source.sourceName;
    manifest.jobName = request.jobName;
    manifest.folderName = paths.folderName;
    manifest.localDestinationPath = paths.localDestinationPath;
    manifest.originalsPath = paths.originalsPath;
    manifest.webReadyPath = request.convertImagesToWebp
      ? paths.webReadyPath
      : manifest.webReadyPath;
    manifest.manifestPath = paths.manifestPath;
    manifest.logPath = paths.logPath;
    manifest.cloudObjectKey = request.uploadToB2 ? paths.cloudObjectKey : manifest.cloudObjectKey;
    manifest.convertImagesToWebp = request.convertImagesToWebp;
    manifest.uploadToB2 = request.uploadToB2;
    manifest.version = OFFLOAD_MANIFEST_VERSION;
    manifest.status = 'preparing';
    manifest.message = 'Preparing the offload package.';
    manifest.completedAt = null;
    manifest.errorMessage = null;
    manifest.skippedFiles = 0;
    manifest.copyProgress = 0;
    manifest.uploadProgress = 0;
    manifest.overallProgress = 0;
    manifest.conversionProgress =
      request.convertImagesToWebp && source.imageCount === 0
        ? 100
        : 0;

    for (const file of files) {
      const entry = this.ensureManifestEntry(manifest, file, request.convertImagesToWebp);
      const metadataChanged =
        entry.kind !== file.kind ||
        entry.size !== file.size ||
        entry.mtimeMs !== file.mtimeMs;

      entry.kind = file.kind;
      entry.size = file.size;
      entry.mtimeMs = file.mtimeMs;

      if (metadataChanged) {
        entry.sourceChecksum = null;
        entry.localStatus = 'pending';
        entry.localVerificationMode = null;
        entry.localChecksum = null;
        entry.localCopiedAt = null;
        entry.webpChecksum = null;
        entry.webpSize = null;
        entry.webpCreatedAt = null;
        entry.webpStatus = file.kind === 'image' ? 'pending' : 'not_requested';
      }

      if (file.kind === 'image') {
        entry.webpRelativePath = toWebpRelativePath(file.relativePath);
        if (request.convertImagesToWebp && entry.webpStatus === 'not_requested') {
          entry.webpStatus = 'pending';
        }
      } else {
        entry.webpRelativePath = null;
        entry.webpStatus = 'not_requested';
        entry.webpChecksum = null;
        entry.webpSize = null;
        entry.webpCreatedAt = null;
      }
    }

    manifest.entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  private ensureManifestEntry(
    manifest: OffloadManifest,
    file: OffloadFileEntry,
    convertImagesToWebp: boolean,
  ) {
    let entry = getManifestEntry(manifest, file.relativePath);
    if (entry) {
      entry.localVerificationMode ??= entry.localChecksum ? 'checksum' : null;
      return entry;
    }

    entry = {
      relativePath: file.relativePath,
      kind: file.kind,
      size: file.size,
      mtimeMs: file.mtimeMs,
      sourceChecksum: null,
      localStatus: 'pending',
      localVerificationMode: null,
      localChecksum: null,
      localCopiedAt: null,
      webpRelativePath: file.kind === 'image' ? toWebpRelativePath(file.relativePath) : null,
      webpStatus:
        file.kind === 'image' && convertImagesToWebp
          ? 'pending'
          : 'not_requested',
      webpChecksum: null,
      webpSize: null,
      webpCreatedAt: null,
    };
    manifest.entries.push(entry);
    return entry;
  }

  private async ensureLocalOriginal(
    file: OffloadFileEntry,
    entry: OffloadManifestEntry,
    originalsPath: string,
    localCopyMode: OffloadLocalCopyMode,
  ): Promise<'copied' | 'skipped'> {
    const destinationPath = path.join(originalsPath, file.relativePath);

    if (localCopyMode === 'fast') {
      if (await this.fileMatchesMetadata(destinationPath, file.size, file.mtimeMs)) {
        entry.localStatus = 'verified';
        entry.localVerificationMode = 'metadata';
        entry.localChecksum = null;
        entry.localCopiedAt = entry.localCopiedAt ?? nowIso();
        return 'skipped';
      }

      await mkdir(path.dirname(destinationPath), { recursive: true });
      await this.copyFileFastPreservingMtime(file.absolutePath, destinationPath, file.mtimeMs);

      if (!(await this.fileMatchesMetadata(destinationPath, file.size, file.mtimeMs))) {
        throw new Error(`Metadata mismatch after copying ${file.relativePath}.`);
      }

      entry.localStatus = 'verified';
      entry.localVerificationMode = 'metadata';
      entry.localChecksum = null;
      entry.localCopiedAt = nowIso();
      return 'copied';
    }

    const sourceChecksum = await this.ensureSourceChecksum(file, entry);
    if (await this.fileMatchesChecksum(destinationPath, sourceChecksum, file.size)) {
      entry.localStatus = 'verified';
      entry.localVerificationMode = 'checksum';
      entry.localChecksum = sourceChecksum;
      entry.localCopiedAt = entry.localCopiedAt ?? nowIso();
      return 'skipped';
    }

    await mkdir(path.dirname(destinationPath), { recursive: true });
    await this.copyFileFastPreservingMtime(file.absolutePath, destinationPath, file.mtimeMs);

    const destinationChecksum = await computeFileChecksum(destinationPath);
    if (destinationChecksum !== sourceChecksum) {
      throw new Error(`Checksum mismatch after copying ${file.relativePath}.`);
    }

    entry.localStatus = 'verified';
    entry.localVerificationMode = 'checksum';
    entry.localChecksum = destinationChecksum;
    entry.localCopiedAt = nowIso();
    return 'copied';
  }

  private async ensureWebReadyImage(
    file: OffloadFileEntry,
    entry: OffloadManifestEntry,
    webReadyPath: string,
  ): Promise<'converted' | 'skipped'> {
    const relativeOutputPath = entry.webpRelativePath ?? toWebpRelativePath(file.relativePath);
    const outputPath = path.join(webReadyPath, relativeOutputPath);

    if (
      entry.webpChecksum &&
      await this.fileMatchesChecksum(outputPath, entry.webpChecksum, entry.webpSize ?? undefined)
    ) {
      entry.webpStatus = 'verified';
      return 'skipped';
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    await this.convertImageToWebp(file.absolutePath, outputPath);

    const outputStats = await stat(outputPath);
    const outputChecksum = await computeFileChecksum(outputPath);

    entry.webpRelativePath = relativeOutputPath;
    entry.webpStatus = 'verified';
    entry.webpChecksum = outputChecksum;
    entry.webpSize = outputStats.size;
    entry.webpCreatedAt = nowIso();
    return 'converted';
  }

  private async ensureSourceChecksum(file: OffloadFileEntry, entry: OffloadManifestEntry) {
    if (!entry.sourceChecksum) {
      entry.sourceChecksum = await computeFileChecksum(file.absolutePath);
    }

    return entry.sourceChecksum;
  }

  private async fileMatchesMetadata(
    filePath: string,
    expectedSize: number,
    expectedMtimeMs: number,
  ) {
    try {
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) {
        return false;
      }

      return fileStats.size === expectedSize && timestampsMatch(fileStats.mtimeMs, expectedMtimeMs);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return false;
      }

      throw error;
    }
  }

  private async fileMatchesChecksum(
    filePath: string,
    expectedChecksum: string,
    expectedSize?: number,
  ) {
    try {
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) {
        return false;
      }

      if (typeof expectedSize === 'number' && fileStats.size !== expectedSize) {
        return false;
      }
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return false;
      }

      throw error;
    }

    const actualChecksum = await computeFileChecksum(filePath);
    return actualChecksum === expectedChecksum;
  }

  private async copyFileFastPreservingMtime(sourcePath: string, destinationPath: string, mtimeMs: number) {
    await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_FICLONE);
    await utimes(destinationPath, new Date(), new Date(mtimeMs));
  }

  private async throwIfInterrupted() {
    if (this.activeExecution?.cancelRequested) {
      throw new OffloadCanceledError();
    }

    if (this.activeExecution?.pauseRequested) {
      throw new OffloadPausedError();
    }
  }

  private buildUploadAssets({
    imageFiles,
    originalsPath,
    webReadyPath,
    includeWebReady,
  }: {
    imageFiles: OffloadFileEntry[];
    originalsPath: string;
    webReadyPath: string | null;
    includeWebReady: boolean;
  }) {
    const assets: OffloadUploadAsset[] = imageFiles.map((file) => ({
      sourcePath: path.join(originalsPath, file.relativePath),
      relativePath: file.relativePath,
    }));

    if (includeWebReady && webReadyPath) {
      for (const file of imageFiles) {
        const relativePath = toWebpRelativePath(file.relativePath);
        assets.push({
          sourcePath: path.join(webReadyPath, relativePath),
          relativePath: path.join('web-ready', relativePath),
        });
      }
    }

    return assets;
  }

  private async stageUploadDirectory(assets: OffloadUploadAsset[]) {
    const uploadDirectory = await mkdtemp(path.join(os.tmpdir(), 'csn-media-bridge-offload-images-'));

    for (const asset of assets) {
      const destinationPath = path.join(uploadDirectory, asset.relativePath);
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(asset.sourcePath, destinationPath);
    }

    return uploadDirectory;
  }

  private async convertImageToWebp(sourcePath: string, outputPath: string) {
    await unlink(outputPath).catch(() => undefined);

    await new Promise<void>((resolve, reject) => {
      const command = ffmpeg(sourcePath)
        .output(outputPath)
        .outputOptions(
          '-c:v',
          'libwebp',
          '-quality',
          String(WEBP_QUALITY),
          '-compression_level',
          '6',
          '-preset',
          'picture',
          '-pix_fmt',
          'yuva420p',
        );

      command.on('error', (error: Error, stdout: string, stderr: string) => {
        const failureDetails = [error.message, stdout, stderr].filter(Boolean).join('\n');
        reject(new Error(failureDetails));
      });

      command.on('end', () => {
        resolve();
      });

      command.run();
    });
  }
}

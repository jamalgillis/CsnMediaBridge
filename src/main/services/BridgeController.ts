import { access, mkdir, mkdtemp, readdir, rm, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve4 } from 'node:dns/promises';
import { BrowserWindow, Notification, dialog } from 'electron';
import packageJson from '../../../package.json';
import { MAX_JOB_HISTORY, MAX_LOG_ENTRIES, initialBridgeState } from '../../shared/defaults';
import {
  inferStoredContentType,
  inferStoredDeliveryType,
  resolveDeliveryType as resolveAutoDeliveryType,
} from '../../shared/media';
import type {
  ApplyStoredVideoPosterRequest,
  ArchivePreviewRequest,
  ArchivePreviewResult,
  RetrieveArchivedMasterRequest,
  RetrieveArchivedMasterResult,
  AppSettings,
  BridgeStateSnapshot,
  ContentType,
  DeleteStoredVideoRequest,
  DeleteStoredVideoResult,
  DesktopNodeCapability,
  DesktopNodeHeartbeat,
  DeliveryType,
  DirectoryBrowseResult,
  GenerateStoredVideoPosterCandidatesRequest,
  IngestUploadAuditSnapshot,
  IngestJobSnapshot,
  LocalTrimSourceSnapshot,
  LogEntry,
  LogLevel,
  LogSource,
  ManualIntakeRequest,
  ManualIntakeSourceSnapshot,
  ManualPipelineRoute,
  OffloadSourceSnapshot,
  OffloadTaskSnapshot,
  RenderJobSnapshot,
  StorageTaskSnapshot,
  RequestedDeliveryType,
  ReviewStatus,
  StoredVideoMetadataUpdateRequest,
  StoredVideoPosterCandidate,
  StoredVideoSnapshot,
  StoredVideoStatus,
  SocialDeploymentStatus,
  TrimClipRequest,
  TrimClipResult,
  RunOffloadTaskRequest,
  SaveSettingsResult,
  StorageUsageSnapshot,
  UploadAuditObjectSnapshot,
  UploadAuditSectionSnapshot,
} from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/ipc';
import {
  buildJobFolderName,
  createId,
  formatFriendlyError,
  joinObjectKey,
  joinPublicUrl,
  nowIso,
} from '../lib/helpers';
import {
  assetKeyFromStreamingPrefix,
  buildStagingSocialKey,
  buildScheduledSocialKey,
  buildStorageKeyPlan,
  buildStreamingPrefix,
  resolvePosterObjectKey,
  type StorageKeyPlan,
} from '../../shared/storageLayout';
import { resolveEncoderRuntime } from '../lib/encoder';
import { computeSourceFingerprint } from '../lib/sourceFingerprint';
import { loadSourceMetadata, SUPPORTED_INGEST_EXTENSIONS, type SourceMetadata } from '../lib/sourceMetadata';
import { StoreService } from './StoreService';
import { WatcherService } from './WatcherService';
import {
  TranscodeService,
  type PackagedVideoResult,
  type SourceProbe,
  type StoredVideoPosterCandidateResult,
} from './TranscodeService';
import { SyncService, buildSyncTargets, type RemoteObjectSnapshot } from './SyncService';
import { ConvexService, type ExistingVideoRecord } from './ConvexService';
import { ArchiveService } from './ArchiveService';
import { MediaProxyService } from './MediaProxyService';
import { AppUpdateService } from './AppUpdateService';
import { OffloadService } from './OffloadService';

interface CommandCheckResult {
  available: boolean;
  message: string;
}

interface ManualPipelinePreset {
  requestedDelivery: RequestedDeliveryType;
  contentType: ContentType;
  reviewStatus: ReviewStatus;
  socialStatus: SocialDeploymentStatus;
  finalStatus: StoredVideoStatus;
}

const MANUAL_PIPELINE_ROUTES: ManualPipelineRoute[] = [
  'web_streaming',
  'clip_progressive',
  'review_draft',
];

export class BridgeController {
  private readonly windows = new Set<BrowserWindow>();
  private readonly store = new StoreService();
  private readonly desktopNodeKey = this.store.getDesktopNodeKey();
  private settings = this.store.loadSettings();
  private state: BridgeStateSnapshot = {
    ...initialBridgeState,
    system: { ...initialBridgeState.system },
    appUpdate: { ...initialBridgeState.appUpdate },
  };
  private readonly jobs = new Map<string, IngestJobSnapshot>();
  private readonly logs: LogEntry[] = [];
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private renderJobPollTimer: NodeJS.Timeout | null = null;
  private activeRenderJobId: string | null = null;
  private storageTaskPollTimer: NodeJS.Timeout | null = null;
  private activeStorageTaskId: string | null = null;
  private lastDesktopNodeHeartbeatErrorMessage: string | null = null;
  private readonly watcher = new WatcherService({
    onFileReady: async (filePath) => {
      await this.enqueueSourceFile(filePath);
    },
    log: (level, message) => this.pushLog(level, 'watcher', message),
  });
  private readonly transcodeService = new TranscodeService(
    (level, message, jobId) => this.pushLog(level, 'transcode', message, jobId),
    (queueDepth, activeEncodingJobId) => {
      this.state = {
        ...this.state,
        queueDepth,
        activeEncodingJobId,
      };
      this.broadcastState();
    },
  );
  private readonly syncService = new SyncService((level, message, jobId) =>
    this.pushLog(level, 'sync', message, jobId),
  );
  private readonly convexService = new ConvexService((level, message, jobId) =>
    this.pushLog(level, 'convex', message, jobId),
  );
  private readonly mediaProxy = new MediaProxyService();
  private readonly archiveService = new ArchiveService((level, message, jobId) =>
    this.pushLog(level, 'sync', message, jobId),
  );
  private readonly offloadService = new OffloadService(this.syncService);
  private readonly appUpdateService = new AppUpdateService({
    log: (level, message) => this.pushLog(level, 'system', message),
    onStateChange: (snapshot) => {
      this.state = {
        ...this.state,
        appUpdate: snapshot,
      };
      this.broadcastState();
    },
    notify: (title, body) => this.showNotification(title, body),
  });
  private latestOffloadTask: OffloadTaskSnapshot | null = null;
  private activeOffloadTaskId: string | null = null;

  async initialize() {
    await this.refreshSystem();
    await this.appUpdateService.initialize(this.settings);
    this.startHeartbeatMonitor();
    this.startRenderJobWorker();
    this.startStorageTaskWorker();

    if (this.settings.autoWatch && this.settings.watchFolder) {
      try {
        await this.startWatching();
      } catch (error) {
        this.pushLog('warn', 'system', formatFriendlyError(error));
      }
    } else {
      this.broadcastState();
    }
  }

  registerWindow(window: BrowserWindow) {
    this.windows.add(window);
    window.on('closed', () => {
      this.windows.delete(window);
    });
    window.webContents.once('did-finish-load', () => {
      window.webContents.send(IPC_CHANNELS.stateUpdated, this.getState());
      if (this.latestOffloadTask) {
        window.webContents.send(IPC_CHANNELS.offloadUpdated, this.latestOffloadTask);
      }
    });
  }

  getState() {
    return {
      ...this.state,
      isWatching: this.watcher.isWatching,
      queueDepth: this.transcodeService.getQueueDepth(),
      activeEncodingJobId: this.transcodeService.getActiveJobId(),
      jobs: this.getSortedJobs(),
      logs: [...this.logs],
    };
  }

  loadSettings() {
    this.settings = this.store.loadSettings();
    return this.settings;
  }

  async checkForAppUpdates() {
    await this.appUpdateService.checkForUpdates(true);
    return this.getState();
  }

  async installAppUpdate() {
    this.appUpdateService.installUpdate();
  }

  async listStoredVideos() {
    const videos = await this.convexService.listVideos(this.settings);

    return await Promise.all(
      videos.map(async (video) => ({
        ...video,
        masterPlaylistUrl:
          (await this.mediaProxy.getProxyUrl(video.masterPlaylistUrl)) ?? video.masterPlaylistUrl,
        manifestUrl:
          (await this.mediaProxy.getProxyUrl(video.manifestUrl)) ?? video.manifestUrl,
        playbackUrl: (await this.mediaProxy.getProxyUrl(video.playbackUrl)) ?? video.playbackUrl,
        posterUrl: this.addCacheBust(
          (await this.mediaProxy.getProxyUrl(video.posterUrl)) ?? video.posterUrl,
          video.updatedAt,
        ),
        sources: await Promise.all(
          (video.sources ?? []).map(async (source) => ({
            ...source,
            url: (await this.mediaProxy.getProxyUrl(source.url)) ?? source.url,
          })),
        ),
      })),
    );
  }

  async repairStoredVideoUrls() {
    const result = await this.convexService.repairStoredVideoUrls(this.settings);
    this.pushLog(
      'info',
      'convex',
      `Stored playback URL repair finished. Updated ${result.updated} of ${result.inspected} videos.`,
    );
    return result;
  }

  async updateStoredVideoMetadata(request: StoredVideoMetadataUpdateRequest) {
    await this.convexService.updateVideoMetadata(this.settings, request);
    this.pushLog('info', 'convex', `Updated stored video metadata for ${request.videoId}.`);
  }

  async deleteStoredVideo(request: DeleteStoredVideoRequest): Promise<DeleteStoredVideoResult> {
    this.assertStoredVideoDeletionReady(request);

    const jobId = `delete:${request.videoId}`;
    let deletedArchive = false;
    let deletedDistribution = false;

    if (request.archiveObjectKey?.trim()) {
      await this.syncService.deleteRemoteFile({
        jobId,
        storage: 'b2',
        bucket: this.settings.b2.bucket,
        objectKey: request.archiveObjectKey,
        settings: this.settings,
        onLog: (message) => this.pushLog('info', 'sync', message, jobId),
      });
      deletedArchive = true;
    }

    if (request.distributionObjectKey?.trim()) {
      await this.syncService.purgeRemotePrefix({
        jobId,
        storage: 'r2',
        bucket: this.settings.r2.bucket,
        remotePrefix: request.distributionObjectKey,
        settings: this.settings,
        onLog: (message) => this.pushLog('info', 'sync', message, jobId),
      });
      deletedDistribution = true;
    }

    await this.convexService.deleteVideo(this.settings, request);
    this.pushLog(
      'info',
      'convex',
      `Deleted stored video ${request.sourceFileName} and removed its library record.`,
      jobId,
    );

    return {
      videoId: request.videoId,
      title: request.title,
      deletedRecord: true,
      deletedArchive,
      deletedDistribution,
    };
  }

  async generateStoredVideoPosterCandidates(
    request: GenerateStoredVideoPosterCandidatesRequest,
  ): Promise<StoredVideoPosterCandidate[]> {
    if (!request.sourceUrl.trim()) {
      throw new Error('A playable source is required before poster candidates can be generated.');
    }

    const outputDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'csn-media-bridge-poster-candidates-'),
    );
    const candidates = await this.transcodeService.generatePosterCandidates({
      sourcePath: request.sourceUrl,
      outputDirectory,
      durationSeconds: request.durationSeconds,
      onLog: (message) => this.pushLog('info', 'transcode', message),
    });

    return await Promise.all(
      candidates.map(async (candidate: StoredVideoPosterCandidateResult) => ({
        ...candidate,
        imageUrl: await this.mediaProxy.getLocalFileUrl(candidate.localPath),
      })),
    );
  }

  async applyStoredVideoPoster(request: ApplyStoredVideoPosterRequest) {
    if (!this.settings.r2.bucket || !this.settings.r2.accountId) {
      throw new Error('Cloudflare R2 bucket and account settings are required before posters can be saved.');
    }

    if (!this.settings.r2.accessKeyId || !this.settings.r2.secretAccessKey) {
      throw new Error('Cloudflare R2 credentials are required before posters can be saved.');
    }

    if (!this.settings.r2.publicBaseUrl.trim()) {
      throw new Error('R2 Public Base URL is required before posters can be saved.');
    }

    await stat(request.candidatePath);

    const posterObjectKey = resolvePosterObjectKey(request.distributionObjectKey);
    await this.syncService.uploadFileToR2({
      jobId: `poster:${request.videoId}`,
      localFilePath: request.candidatePath,
      destinationObjectKey: posterObjectKey,
      settings: this.settings,
      onLog: (message) => this.pushLog('info', 'sync', message, request.videoId),
    });

    const posterUrl = joinPublicUrl(this.settings.r2.publicBaseUrl, posterObjectKey);
    await this.convexService.updateVideoMetadata(this.settings, {
      videoId: request.videoId,
      posterUrl,
    });

    this.pushLog('info', 'convex', `Stored poster updated for ${request.videoId}.`);
    return posterUrl;
  }

  /**
   * A short-lived playback URL for an archived master.
   *
   * Returns the reason rather than throwing when archive access is not
   * configured, so the library can explain which setting is missing instead of
   * showing a dead button.
   */
  async getArchivePreviewUrl(request: ArchivePreviewRequest): Promise<ArchivePreviewResult> {
    const expiresInSeconds = 60 * 60;
    const unavailableReason = this.archiveService.getUnavailableReason(this.settings);

    if (unavailableReason) {
      return { url: null, expiresInSeconds, unavailableReason };
    }

    if (!request.archiveObjectKey?.trim()) {
      return {
        url: null,
        expiresInSeconds,
        unavailableReason: 'This asset has no archived master in Backblaze B2.',
      };
    }

    const url = await this.archiveService.getPresignedObjectUrl(
      this.settings,
      request.archiveObjectKey,
      expiresInSeconds,
    );

    return { url, expiresInSeconds, unavailableReason: null };
  }

  /**
   * Pulls an archived master back to local disk so it can be re-cut.
   *
   * Retrieved masters are kept under the temp output folder keyed by video id.
   * An existing local copy of the right size is reused rather than downloaded
   * again — these are multi-gigabyte camera files, and re-fetching one because
   * an operator clicked twice is an expensive mistake.
   */
  async retrieveArchivedMaster(
    request: RetrieveArchivedMasterRequest,
  ): Promise<RetrieveArchivedMasterResult> {
    if (!this.settings.tempOutputPath) {
      throw new Error('Set a temp output folder in Settings before retrieving archived masters.');
    }
    if (!this.settings.b2.bucket || !this.settings.b2.keyId || !this.settings.b2.applicationKey) {
      throw new Error('Backblaze B2 credentials are required before retrieving archived masters.');
    }
    if (!request.archiveObjectKey?.trim()) {
      throw new Error('This asset has no archived master in Backblaze B2.');
    }

    const jobId = `retrieve:${request.videoId}`;
    const targetDirectory = path.join(this.settings.tempOutputPath, 'retrieved', request.videoId);
    const fileName = path.basename(request.archiveObjectKey) || request.sourceFileName || 'master';
    const localFilePath = path.join(targetDirectory, fileName);

    const existing = await stat(localFilePath).catch(() => null);
    if (existing?.isFile() && existing.size > 0) {
      this.pushLog(
        'info',
        'sync',
        `Reusing the local copy of ${request.title} already in the working folder.`,
        jobId,
      );
    } else {
      await mkdir(targetDirectory, { recursive: true });
      this.pushLog('info', 'sync', `Retrieving ${request.title} from the B2 archive.`, jobId);

      await this.syncService.downloadFileFromB2({
        jobId,
        sourceObjectKey: request.archiveObjectKey,
        localFilePath,
        settings: this.settings,
        onProgress: (progress) => {
          this.pushLog('debug', 'sync', `Archive retrieval ${Math.round(progress)}%.`, jobId);
        },
        onLog: (message) => this.pushLog('info', 'sync', message, jobId),
      });
    }

    const sourceStats = await stat(localFilePath);
    const sourceUrl = await this.mediaProxy.getLocalFileUrl(localFilePath);

    this.pushLog('info', 'sync', `${request.title} is ready for processing.`, jobId);
    this.showNotification('Archive retrieved', `${request.title} is ready to trim.`);

    return {
      canceled: false,
      source: {
        sourcePath: localFilePath,
        sourceFileName: path.basename(localFilePath),
        sourceUrl,
        fileSizeBytes: sourceStats.size,
        modifiedAt: new Date(sourceStats.mtimeMs).toISOString(),
      },
    };
  }

  async chooseTrimSource(): Promise<LocalTrimSourceSnapshot | null> {
    const result = await dialog.showOpenDialog(this.getDialogWindow(), {
      title: 'Choose Video Clip',
      properties: ['openFile'],
      filters: [
        {
          name: 'Video Files',
          extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv'],
        },
      ],
    });

    if (result.canceled) {
      return null;
    }

    const sourcePath = result.filePaths[0];
    if (!sourcePath) {
      return null;
    }

    const sourceStats = await stat(sourcePath);
    const sourceUrl = await this.mediaProxy.getLocalFileUrl(sourcePath);

    return {
      sourcePath,
      sourceFileName: path.basename(sourcePath),
      sourceUrl,
      fileSizeBytes: sourceStats.size,
      modifiedAt: new Date(sourceStats.mtimeMs).toISOString(),
    };
  }

  async chooseOffloadSource(): Promise<OffloadSourceSnapshot | null> {
    const result = await dialog.showOpenDialog(this.getDialogWindow(), {
      title: 'Choose Shoot Folder',
      properties: ['openDirectory'],
    });

    if (result.canceled) {
      return null;
    }

    const sourcePath = result.filePaths[0];
    if (!sourcePath) {
      return null;
    }

    return await this.offloadService.inspectSourceFolder(sourcePath);
  }

  getOffloadTask(): OffloadTaskSnapshot | null {
    return this.latestOffloadTask;
  }

  async trimClip(request: TrimClipRequest): Promise<TrimClipResult> {
    const normalizedInPoint = Math.max(0, Number(request.inPointSeconds));
    const normalizedOutPoint = Math.max(normalizedInPoint, Number(request.outPointSeconds));
    const clipDurationSeconds = Number((normalizedOutPoint - normalizedInPoint).toFixed(3));

    if (!Number.isFinite(normalizedInPoint) || !Number.isFinite(normalizedOutPoint)) {
      throw new Error('Trim points must be valid numbers.');
    }

    if (clipDurationSeconds < 0.1) {
      throw new Error('Trim selections must span at least 0.1 seconds.');
    }

    const sourcePath = path.resolve(request.sourcePath);
    await access(sourcePath, fsConstants.R_OK);

    const sourceBaseName = path.parse(sourcePath).name;
    const saveResult = await dialog.showSaveDialog(this.getDialogWindow(), {
      title: 'Export Trimmed Clip',
      defaultPath: path.join(path.dirname(sourcePath), `${sourceBaseName}-trimmed.mp4`),
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      properties: ['showOverwriteConfirmation'],
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return {
        canceled: true,
        outputPath: null,
        durationSeconds: null,
        effectiveEncoder: null,
      };
    }

    const outputPath = saveResult.filePath;
    if (path.resolve(outputPath) === sourcePath) {
      throw new Error('Choose a new file name for the trimmed export so the source clip is not overwritten.');
    }

    this.pushLog(
      'info',
      'transcode',
      `Trim export started for ${path.basename(sourcePath)} (${normalizedInPoint.toFixed(2)}s - ${normalizedOutPoint.toFixed(2)}s).`,
    );

    const result = await this.transcodeService.trimClip({
      sourcePath,
      outputPath,
      inPointSeconds: normalizedInPoint,
      outPointSeconds: normalizedOutPoint,
      settings: this.settings,
      onLog: (message) => this.pushLog('info', 'transcode', message),
    });

    this.pushLog(
      'info',
      'transcode',
      `Trim export finished: ${path.basename(outputPath)} (${result.effectiveEncoder}).`,
    );

    return {
      canceled: false,
      outputPath,
      durationSeconds: result.durationSeconds,
      effectiveEncoder: result.effectiveEncoder,
    };
  }

  async listClipsForVideo(sourceVideoId: string): Promise<StoredVideoSnapshot[]> {
    return await this.convexService.listClipsForVideo(this.settings, sourceVideoId);
  }

  private async findStoredVideoById(videoId: string): Promise<StoredVideoSnapshot | null> {
    if (!this.settings.convex.deploymentUrl || !this.settings.convex.mutationPath) {
      return null;
    }

    const videos = await this.convexService.listVideos(this.settings);
    return videos.find((video) => video._id === videoId) ?? null;
  }

  async runOffloadTask(request: RunOffloadTaskRequest): Promise<OffloadTaskSnapshot> {
    if (this.activeOffloadTaskId) {
      throw new Error('An offload task is already running. Let it finish before starting another one.');
    }

    this.activeOffloadTaskId = createId();

    try {
      const result = await this.offloadService.runTask({
        request,
        settings: this.settings,
        onSnapshot: (snapshot) => {
          this.latestOffloadTask = snapshot;
          this.broadcastOffloadTask(snapshot);
        },
        onLog: (message) => this.pushLog('info', 'offload', message),
      });

      this.latestOffloadTask = result;
      this.broadcastOffloadTask(result);
      return result;
    } finally {
      this.activeOffloadTaskId = null;
    }
  }

  pauseOffloadTask(): OffloadTaskSnapshot | null {
    const snapshot = this.offloadService.requestPause();
    if (snapshot) {
      this.latestOffloadTask = snapshot;
      this.broadcastOffloadTask(snapshot);
    }

    return snapshot;
  }

  cancelOffloadTask(): OffloadTaskSnapshot | null {
    const snapshot = this.offloadService.requestCancel();
    if (snapshot) {
      this.latestOffloadTask = snapshot;
      this.broadcastOffloadTask(snapshot);
    }

    return snapshot;
  }

  /**
   * Disk usage for the volume the operator actually works on. Prefers the
   * offload drive — that is the one that fills up — and falls back to the temp
   * output folder, then the watch folder. Returns null when none is configured
   * or the platform does not report volume statistics.
   */
  async getStorageUsage(): Promise<StorageUsageSnapshot | null> {
    const candidates: Array<{ label: string; path: string }> = [
      { label: 'Offload drive', path: this.settings.offload.localFolder },
      { label: 'Working disk', path: this.settings.tempOutputPath },
      { label: 'Watch disk', path: this.settings.watchFolder },
    ];

    for (const candidate of candidates) {
      if (!candidate.path) {
        continue;
      }

      try {
        const stats = await statfs(candidate.path);
        const totalBytes = stats.blocks * stats.bsize;
        const freeBytes = stats.bavail * stats.bsize;

        if (totalBytes > 0) {
          return {
            label: candidate.label,
            path: candidate.path,
            usedBytes: Math.max(0, totalBytes - freeBytes),
            totalBytes,
          };
        }
      } catch {
        // Path missing or volume not reportable — try the next candidate.
      }
    }

    return null;
  }

  async saveSettings(settings: AppSettings): Promise<SaveSettingsResult> {
    this.settings = this.store.saveSettings(settings);
    this.appUpdateService.applySettings(this.settings);
    this.pushLog('info', 'system', 'Settings saved.');

    if (this.watcher.isWatching) {
      await this.startWatching();
    } else if (this.settings.autoWatch && this.settings.watchFolder) {
      await this.startWatching();
    } else {
      this.broadcastState();
    }

    return {
      settings: this.settings,
      state: this.getState(),
    };
  }

  async browseDirectory(): Promise<DirectoryBrowseResult> {
    const result = await dialog.showOpenDialog({
      title: 'Select Folder',
      properties: ['openDirectory', 'createDirectory'],
    });

    if (result.canceled) {
      return { canceled: true, path: null };
    }

    return {
      canceled: false,
      path: result.filePaths[0] ?? null,
    };
  }

  async chooseManualIntakeSource(): Promise<ManualIntakeSourceSnapshot | null> {
    const result = await dialog.showOpenDialog(this.getDialogWindow(), {
      title: 'Choose Content',
      properties: ['openFile'],
      filters: [
        {
          name: 'Video Files',
          extensions: SUPPORTED_INGEST_EXTENSIONS.map((extension) => extension.slice(1)),
        },
      ],
    });

    if (result.canceled) {
      return null;
    }

    const sourcePath = result.filePaths[0];
    if (!sourcePath) {
      return null;
    }

    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isFile()) {
      throw new Error('Choose a video file for manual intake.');
    }

    return {
      sourcePath,
      sourceFileName: path.basename(sourcePath),
      fileSizeBytes: sourceStats.size,
      modifiedAt: new Date(sourceStats.mtimeMs).toISOString(),
    };
  }

  async enqueueManualIntake(request: ManualIntakeRequest) {
    const manualIntake = this.normalizeManualIntakeRequest(request);
    const extension = path.extname(manualIntake.sourcePath).toLowerCase();
    if (!SUPPORTED_INGEST_EXTENSIONS.includes(extension as (typeof SUPPORTED_INGEST_EXTENSIONS)[number])) {
      throw new Error(`Manual intake supports ${SUPPORTED_INGEST_EXTENSIONS.join(', ')} files.`);
    }

    await access(manualIntake.sourcePath, fsConstants.R_OK);
    await this.enqueueSourceFile(manualIntake.sourcePath, { manualIntake });
    return this.getState();
  }

  async startWatching() {
    await this.ensureFolderExists(this.settings.watchFolder, 'Ingest folder');
    if (!this.settings.tempOutputPath) {
      throw new Error('Temp output folder is not configured.');
    }
    await mkdir(this.settings.tempOutputPath, { recursive: true });
    await this.watcher.start(this.settings);
    await this.refreshSystem();
    this.state = {
      ...this.getState(),
      isWatching: true,
    };
    this.broadcastState();
    return this.getState();
  }

  async stopWatching() {
    await this.watcher.stop();
    await this.refreshSystem();
    this.state = {
      ...this.getState(),
      isWatching: false,
    };
    this.broadcastState();
    return this.getState();
  }

  async retryJob(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return this.getState();
    }

    await this.enqueueSourceFile(job.sourcePath, {
      isRetry: true,
      manualIntake: this.buildManualIntakeRequestFromJob(job),
    });
    return this.getState();
  }

  async auditJobUploads(jobId: string): Promise<IngestUploadAuditSnapshot> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error('Job not found.');
    }

    if (!job.archiveObjectKey && !job.distributionObjectKey) {
      throw new Error('This job has not reached the cloud upload stage yet.');
    }

    const archiveExpectedObjects = await this.collectArchiveExpectedObjects(job);
    const distributionExpectedObjects = await this.collectDistributionExpectedObjects(job);
    const archiveParentPrefix = job.archiveObjectKey ? path.posix.dirname(job.archiveObjectKey) : null;
    const archiveBaseName = job.archiveObjectKey ? path.posix.basename(job.archiveObjectKey) : null;

    const [archiveRemoteObjects, distributionRemoteObjects, sourceExists] = await Promise.all([
      archiveParentPrefix
        ? this.syncService.listRemoteObjects({
            jobId,
            storage: 'b2',
            bucket: this.settings.b2.bucket,
            remotePrefix: archiveParentPrefix,
            settings: this.settings,
            onLog: (message) => this.pushLog('info', 'sync', message, jobId),
          })
        : Promise.resolve([] as RemoteObjectSnapshot[]),
      job.distributionObjectKey
        ? this.syncService.listRemoteObjects({
            jobId,
            storage: 'r2',
            bucket: this.settings.r2.bucket,
            remotePrefix: job.distributionObjectKey,
            recursive: true,
            settings: this.settings,
            onLog: (message) => this.pushLog('info', 'sync', message, jobId),
          })
        : Promise.resolve([] as RemoteObjectSnapshot[]),
      this.pathExists(job.sourcePath),
    ]);

    const filteredArchiveRemoteObjects = archiveBaseName
      ? archiveRemoteObjects.filter((entry) => path.posix.basename(entry.objectKey) === archiveBaseName)
      : [];

    const archiveSection = job.archiveObjectKey
      ? this.buildUploadAuditSection({
          label: 'Archive Upload',
          storage: 'b2',
          bucket: this.settings.b2.bucket,
          remotePrefix: job.archiveObjectKey,
          localPath: job.sourcePath,
          localExists: sourceExists,
          expectedObjects: archiveExpectedObjects,
          remoteObjects: filteredArchiveRemoteObjects,
        })
      : null;

    const distributionLocalExists = job.outputDirectory
      ? await this.pathExists(job.outputDirectory)
      : false;
    const distributionSection = job.distributionObjectKey
      ? this.buildUploadAuditSection({
          label: 'Distribution Upload',
          storage: 'r2',
          bucket: this.settings.r2.bucket,
          remotePrefix: job.distributionObjectKey,
          localPath: job.outputDirectory,
          localExists: distributionLocalExists,
          expectedObjects: distributionExpectedObjects,
          remoteObjects: distributionRemoteObjects,
        })
      : null;

    const summary = this.summarizeUploadAudit(job, archiveSection, distributionSection);
    return {
      jobId: job.id,
      sourceName: job.sourceName,
      status: summary.status,
      message: summary.message,
      auditedAt: nowIso(),
      canResumeSamePrefix: Boolean(sourceExists && this.getJobFolderNameFromJob(job)),
      canCleanupRemote: [archiveSection, distributionSection].some(
        (section) => (section?.remoteObjects.length ?? 0) > 0,
      ),
      archive: archiveSection,
      distribution: distributionSection,
    };
  }

  async resumeJobUploads(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error('Job not found.');
    }

    const reuseJobFolderName = this.getJobFolderNameFromJob(job);
    if (!reuseJobFolderName) {
      throw new Error('This job does not have a reusable cloud prefix yet.');
    }

    await this.enqueueSourceFile(job.sourcePath, {
      isRetry: true,
      reuseJobFolderName,
      manualIntake: this.buildManualIntakeRequestFromJob(job),
    });
    this.pushLog(
      'info',
      'sync',
      `Queued same-prefix upload resume for ${job.sourceName}.`,
      job.id,
    );
    return this.getState();
  }

  async cleanupJobUploads(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error('Job not found.');
    }

    if (job.archiveObjectKey) {
      await this.syncService.deleteRemoteFile({
        jobId,
        storage: 'b2',
        bucket: this.settings.b2.bucket,
        objectKey: job.archiveObjectKey,
        settings: this.settings,
        onLog: (message) => this.pushLog('info', 'sync', message, jobId),
      });
    }

    if (job.distributionObjectKey) {
      await this.syncService.purgeRemotePrefix({
        jobId,
        storage: 'r2',
        bucket: this.settings.r2.bucket,
        remotePrefix: job.distributionObjectKey,
        settings: this.settings,
        onLog: (message) => this.pushLog('info', 'sync', message, jobId),
      });
    }

    this.updateJob(jobId, {
      updatedAt: nowIso(),
      message: 'Remote cloud objects were cleaned up for this failed upload.',
    });
    this.pushLog('info', 'sync', `Cleaned remote upload targets for ${job.sourceName}.`, jobId);
    return await this.auditJobUploads(jobId);
  }

  private async pathExists(targetPath: string | null | undefined) {
    if (!targetPath?.trim()) {
      return false;
    }

    try {
      await stat(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private assertStoredVideoDeletionReady(request: DeleteStoredVideoRequest) {
    if (!this.settings.convex.deploymentUrl || !this.settings.convex.mutationPath) {
      throw new Error('Convex settings are incomplete. Add the deployment URL and mutation path before deleting library items.');
    }

    if (request.archiveObjectKey?.trim()) {
      if (!this.settings.b2.bucket.trim()) {
        throw new Error('Backblaze B2 bucket is required before archive assets can be deleted.');
      }

      if (!this.settings.b2.keyId.trim() || !this.settings.b2.applicationKey.trim()) {
        throw new Error('Backblaze B2 credentials are required before archive assets can be deleted.');
      }
    }

    if (request.distributionObjectKey?.trim()) {
      if (!this.settings.r2.bucket.trim() || !this.settings.r2.accountId.trim()) {
        throw new Error('Cloudflare R2 bucket and account settings are required before playback assets can be deleted.');
      }

      if (!this.settings.r2.accessKeyId.trim() || !this.settings.r2.secretAccessKey.trim()) {
        throw new Error('Cloudflare R2 credentials are required before playback assets can be deleted.');
      }
    }
  }

  private async collectArchiveExpectedObjects(job: IngestJobSnapshot): Promise<UploadAuditObjectSnapshot[]> {
    if (!job.archiveObjectKey) {
      return [];
    }

    try {
      const sourceStats = await stat(job.sourcePath);
      if (!sourceStats.isFile()) {
        return [];
      }

      return [
        {
          objectKey: job.archiveObjectKey,
          relativePath: path.posix.basename(job.archiveObjectKey),
          sizeBytes: sourceStats.size,
        },
      ];
    } catch {
      return [];
    }
  }

  private async collectDistributionExpectedObjects(
    job: IngestJobSnapshot,
  ): Promise<UploadAuditObjectSnapshot[]> {
    if (!job.distributionObjectKey || !job.outputDirectory) {
      return [];
    }

    return await this.collectLocalDirectoryObjects(job.outputDirectory, job.distributionObjectKey);
  }

  private async collectLocalDirectoryObjects(
    rootPath: string,
    objectKeyPrefix: string,
  ): Promise<UploadAuditObjectSnapshot[]> {
    const objects: UploadAuditObjectSnapshot[] = [];

    const walk = async (currentPath: string) => {
      const entries = await readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const entryStats = await stat(entryPath);
        const relativePath = path.relative(rootPath, entryPath).split(path.sep).join('/');
        objects.push({
          objectKey: joinObjectKey(objectKeyPrefix, relativePath),
          relativePath,
          sizeBytes: entryStats.size,
        });
      }
    };

    try {
      await walk(rootPath);
    } catch {
      return [];
    }

    return objects.sort((left, right) => left.objectKey.localeCompare(right.objectKey));
  }

  private buildUploadAuditSection(params: {
    label: string;
    storage: 'b2' | 'r2';
    bucket: string;
    remotePrefix: string;
    localPath: string | null;
    localExists: boolean;
    expectedObjects: UploadAuditObjectSnapshot[];
    remoteObjects: RemoteObjectSnapshot[];
  }): UploadAuditSectionSnapshot {
    const expectedByKey = new Map(
      params.expectedObjects.map((object) => [object.objectKey, object]),
    );
    const remoteByKey = new Map(
      params.remoteObjects.map((object) => [object.objectKey, object]),
    );

    const missingObjectKeys = params.expectedObjects
      .filter((object) => !remoteByKey.has(object.objectKey))
      .map((object) => object.objectKey);
    const unexpectedObjectKeys = params.remoteObjects
      .filter((object) => !expectedByKey.has(object.objectKey))
      .map((object) => object.objectKey);
    const sizeMismatchObjectKeys = params.expectedObjects
      .filter((object) => {
        const remoteObject = remoteByKey.get(object.objectKey);
        return (
          object.sizeBytes !== null &&
          remoteObject &&
          remoteObject.sizeBytes !== object.sizeBytes
        );
      })
      .map((object) => object.objectKey);

    return {
      label: params.label,
      storage: params.storage,
      bucket: params.bucket,
      remotePrefix: params.remotePrefix,
      localPath: params.localPath,
      localExists: params.localExists,
      expectedObjects: params.expectedObjects,
      remoteObjects: params.remoteObjects
        .map((object) => ({
          objectKey: object.objectKey,
          relativePath: object.relativePath,
          sizeBytes: object.sizeBytes,
        }))
        .sort((left, right) => left.objectKey.localeCompare(right.objectKey)),
      missingObjectKeys,
      unexpectedObjectKeys,
      sizeMismatchObjectKeys,
    };
  }

  private summarizeUploadAudit(
    job: IngestJobSnapshot,
    archive: UploadAuditSectionSnapshot | null,
    distribution: UploadAuditSectionSnapshot | null,
  ) {
    const sections = [archive, distribution].filter(
      (section): section is UploadAuditSectionSnapshot => Boolean(section),
    );

    const issueCount = sections.reduce(
      (total, section) =>
        total +
        section.missingObjectKeys.length +
        section.unexpectedObjectKeys.length +
        section.sizeMismatchObjectKeys.length,
      0,
    );

    const hasNoRemoteObjects = sections.every((section) => section.remoteObjects.length === 0);
    const hasExpectedObjects = sections.some((section) => section.expectedObjects.length > 0);
    const localComparisonUnavailable = sections.some(
      (section) => !section.localExists || section.expectedObjects.length === 0,
    );

    if (issueCount === 0 && hasExpectedObjects && !localComparisonUnavailable) {
      return {
        status: 'healthy' as const,
        message: `Archive and distribution uploads for ${job.sourceName} match the local ingest outputs.`,
      };
    }

    if (hasNoRemoteObjects && hasExpectedObjects) {
      return {
        status: 'missing' as const,
        message: `No remote upload objects were found for ${job.sourceName}.`,
      };
    }

    if (issueCount > 0) {
      return {
        status: 'partial' as const,
        message: `Found ${issueCount} upload audit issue${issueCount === 1 ? '' : 's'} for ${job.sourceName}.`,
      };
    }

    return {
      status: 'unknown' as const,
      message: `Upload audit for ${job.sourceName} needs local outputs to compare the remote prefix cleanly.`,
    };
  }

  private getJobFolderNameFromJob(job: IngestJobSnapshot) {
    const distributionPrefix = job.distributionObjectKey
      ? this.getJobFolderNameFromObjectKey(job.distributionObjectKey, this.settings.r2.pathPrefix)
      : null;
    if (distributionPrefix) {
      return distributionPrefix;
    }

    return job.archiveObjectKey
      ? this.getJobFolderNameFromObjectKey(job.archiveObjectKey, this.settings.b2.pathPrefix)
      : null;
  }

  /**
   * Resolves the B2 and R2 keys for one ingest according to the configured
   * layout. Canonical keys are content-addressed by source fingerprint, so a
   * retried or resumed ingest of the same file always writes back to the same
   * place instead of orphaning a half-finished folder under a fresh id.
   */
  private buildStorageKeyPlan(params: {
    jobFolderName: string;
    sourceName: string;
    sourceFingerprint: string | null;
    projectName: string | null;
    recordedAt: string | null;
  }): StorageKeyPlan {
    return buildStorageKeyPlan({
      layout: this.settings.storage.layout,
      sourceFingerprint: params.sourceFingerprint,
      jobFolderName: params.jobFolderName,
      sourceName: params.sourceName,
      projectName: params.projectName,
      recordedAt: params.recordedAt,
      legacyArchivePrefix: this.settings.b2.pathPrefix,
      legacyDistributionPrefix: this.settings.r2.pathPrefix,
    });
  }

  /**
   * Where a completed render is published.
   *
   * The key prefix is what R2 lifecycle rules act on, so it must agree with the
   * job's declared `storageClass` — a staged render written outside
   * `staging/social/` would never expire, and a scheduled one written inside it
   * would vanish on a 72-hour fuse.
   */
  private buildRenderOutputObjectKey(
    renderJob: RenderJobSnapshot,
    sourceVideo: StoredVideoSnapshot,
  ) {
    if (renderJob.storageClass === 'scheduled_social') {
      return buildScheduledSocialKey(renderJob.socialPostId ?? renderJob._id, renderJob._id);
    }

    if (renderJob.storageClass === 'streaming') {
      // A persistent render belongs with the asset it was cut from, under the
      // never-expiring streaming prefix.
      const assetKey =
        assetKeyFromStreamingPrefix(sourceVideo.distributionObjectKey) ?? renderJob._id;
      return joinObjectKey(buildStreamingPrefix(assetKey), `social-${renderJob._id}.mp4`);
    }

    return buildStagingSocialKey(renderJob._id);
  }

  private getJobFolderNameFromObjectKey(objectKey: string, configuredPrefix: string) {
    // Canonical keys carry the asset key rather than a job folder, so recover
    // that instead of splitting on a legacy prefix that is not there.
    const canonicalAssetKey = assetKeyFromStreamingPrefix(objectKey);
    if (canonicalAssetKey) {
      return canonicalAssetKey;
    }

    const normalizedObjectKey = objectKey.replace(/^\/+|\/+$/g, '');
    const normalizedPrefix = configuredPrefix.replace(/^\/+|\/+$/g, '');
    const remainder =
      normalizedPrefix && normalizedObjectKey.startsWith(`${normalizedPrefix}/`)
        ? normalizedObjectKey.slice(normalizedPrefix.length + 1)
        : normalizedObjectKey;

    const [jobFolderName] = remainder.split('/');
    return jobFolderName?.trim() ? jobFolderName : null;
  }

  async refreshSystem() {
    const [ffmpeg, ffprobe, rclone, internetReachable, watchFolderAccessible] = await Promise.all([
      this.checkCommand('ffmpeg', ['-version']),
      this.checkCommand('ffprobe', ['-version']),
      this.checkCommand('rclone', ['version']),
      this.checkInternetConnectivity(),
      this.checkWatchFolderAccessible(),
    ]);

    const watcherHealthy = this.watcher.isWatching
      ? watchFolderAccessible &&
        internetReachable &&
        ffmpeg.available &&
        ffprobe.available &&
        rclone.available
      : false;

    const notes = [
      ffmpeg,
      ffprobe,
      rclone,
    ]
      .filter((result) => !result.available)
      .map((result) => result.message);

    if (!internetReachable) {
      notes.push('Internet heartbeat failed. Cloud upload or Convex sync may be unavailable.');
    }

    if (this.watcher.isWatching && !watchFolderAccessible) {
      notes.push('Watcher is running but the ingest folder is no longer readable.');
    }

    this.state = {
      ...this.state,
      system: {
        ffmpegAvailable: ffmpeg.available,
        ffprobeAvailable: ffprobe.available,
        rcloneAvailable: rclone.available,
        internetReachable,
        watcherHealthy,
        lastCheckedAt: nowIso(),
        lastHeartbeatAt: nowIso(),
        notes,
      },
    };

    this.broadcastState();
    void this.reportDesktopNodeHeartbeat();
    return this.getState();
  }

  private buildDesktopNodeHeartbeat(): DesktopNodeHeartbeat {
    const system = this.state.system;
    const notes = [...system.notes];
    const hasMissingDependency =
      system.ffmpegAvailable === false ||
      system.ffprobeAvailable === false ||
      system.rcloneAvailable === false ||
      system.internetReachable === false;
    const capabilities: DesktopNodeCapability[] = [
      'watchfolder_ingest',
      'local_offload',
    ];

    if (system.ffmpegAvailable) {
      capabilities.push('native_ffmpeg', 'poster_generation');
      if (this.settings.hardwareEncoderOverride !== 'software') {
        capabilities.push('gpu_transcode');
      }
    }

    if (system.rcloneAvailable && system.internetReachable) {
      capabilities.push('cloud_sync');
    }

    return {
      nodeKey: this.desktopNodeKey,
      displayName: `${os.hostname() || 'Desktop'} Media Bridge`,
      appVersion: packageJson.version,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      status: hasMissingDependency ? 'degraded' : 'online',
      capabilities,
      watchFolder: this.settings.watchFolder || undefined,
      tempOutputPath: this.settings.tempOutputPath || undefined,
      queueDepth: this.transcodeService.getQueueDepth(),
      activeEncodingJobId: this.transcodeService.getActiveJobId() ?? undefined,
      activeRenderJobId: this.activeRenderJobId ?? undefined,
      ffmpegAvailable: system.ffmpegAvailable ?? undefined,
      ffprobeAvailable: system.ffprobeAvailable ?? undefined,
      rcloneAvailable: system.rcloneAvailable ?? undefined,
      internetReachable: system.internetReachable ?? undefined,
      watcherHealthy: system.watcherHealthy ?? undefined,
      notes,
    };
  }

  private async reportDesktopNodeHeartbeat() {
    if (!this.settings.convex.deploymentUrl) {
      return;
    }

    try {
      await this.convexService.upsertDesktopNodeHeartbeat(
        this.settings,
        this.buildDesktopNodeHeartbeat(),
      );
      if (this.lastDesktopNodeHeartbeatErrorMessage) {
        this.pushLog('info', 'convex', 'Desktop node heartbeat recovered.');
        this.lastDesktopNodeHeartbeatErrorMessage = null;
      }
    } catch (error) {
      const message = formatFriendlyError(error);
      if (message !== this.lastDesktopNodeHeartbeatErrorMessage) {
        this.pushLog('warn', 'convex', `Desktop node heartbeat failed: ${message}`);
        this.lastDesktopNodeHeartbeatErrorMessage = message;
      }
    }
  }

  /**
   * Executes the object-storage copies and deletes Convex has queued.
   *
   * The desktop node runs these because it already holds B2 and R2 credentials
   * and the transfer tooling — a browser can request a promotion or a cleanup
   * without ever receiving a key. See `docs/STORAGE_LAYOUT.md` section 6.
   */
  private startStorageTaskWorker() {
    if (this.storageTaskPollTimer) {
      clearInterval(this.storageTaskPollTimer);
    }

    this.storageTaskPollTimer = setInterval(() => {
      void this.pollStorageTasks();
    }, 10_000);

    void this.pollStorageTasks();
  }

  private canRunStorageTaskWorker() {
    return Boolean(
      this.settings.convex.deploymentUrl &&
        this.settings.r2.bucket &&
        this.settings.r2.accountId &&
        this.settings.r2.accessKeyId &&
        this.settings.r2.secretAccessKey &&
        this.state.system.rcloneAvailable,
    );
  }

  private async pollStorageTasks() {
    if (this.activeStorageTaskId || !this.canRunStorageTaskWorker()) {
      return;
    }

    try {
      const task = await this.convexService.claimNextStorageTask(
        this.settings,
        this.desktopNodeKey,
      );
      if (!task) {
        return;
      }

      await this.processStorageTask(task);
    } catch (error) {
      this.pushLog('warn', 'convex', `Storage task polling failed: ${formatFriendlyError(error)}`);
    }
  }

  private async processStorageTask(task: StorageTaskSnapshot) {
    this.activeStorageTaskId = task._id;
    const jobId = `storage:${task._id}`;
    const bucket = task.provider === 'b2' ? this.settings.b2.bucket : this.settings.r2.bucket;

    const leaseRenewalTimer = setInterval(() => {
      void this.convexService
        .renewStorageTaskLease(this.settings, task._id, this.desktopNodeKey)
        .catch((error) => {
          this.pushLog(
            'warn',
            'convex',
            `Storage task lease renewal failed: ${formatFriendlyError(error)}`,
            jobId,
          );
        });
    }, 45_000);

    try {
      if (!bucket) {
        throw new Error(`No ${task.provider.toUpperCase()} bucket is configured on this node.`);
      }

      if (task.operation === 'copy') {
        if (!task.sourceObjectKey || !task.destinationObjectKey) {
          throw new Error('Copy task is missing a source or destination object key.');
        }

        if (task.destinationProvider && task.destinationProvider !== task.provider) {
          // Cross-provider moves would need a download/upload round trip rather
          // than a server-side copy; nothing queues one today.
          throw new Error('Cross-provider storage copies are not supported by this worker.');
        }

        await this.syncService.copyRemoteObject({
          jobId,
          storage: task.provider,
          bucket,
          sourceObjectKey: task.sourceObjectKey,
          destinationObjectKey: task.destinationObjectKey,
          settings: this.settings,
          onLog: (message) => this.pushLog('info', 'sync', message, jobId),
        });
      } else {
        if (!task.sourceObjectKey) {
          throw new Error('Delete task is missing an object key.');
        }

        await this.syncService.deleteRemoteFile({
          jobId,
          storage: task.provider,
          bucket,
          objectKey: task.sourceObjectKey,
          settings: this.settings,
          onLog: (message) => this.pushLog('info', 'sync', message, jobId),
        });
      }

      // Completing is what patches the linked Convex record onto the new key,
      // so it only runs once the object is confirmed in place.
      await this.convexService.completeStorageTask(this.settings, task._id, this.desktopNodeKey);
      this.pushLog(
        'info',
        'sync',
        `Completed ${task.operation} storage task for ${task.reason.replace(/_/g, ' ')}.`,
        jobId,
      );
    } catch (error) {
      const message = formatFriendlyError(error);
      this.pushLog('error', 'sync', `Storage task ${task._id} failed: ${message}`, jobId);
      try {
        await this.convexService.markStorageTaskFailed(
          this.settings,
          task._id,
          this.desktopNodeKey,
          message,
        );
      } catch (markFailedError) {
        this.pushLog(
          'warn',
          'convex',
          `Could not mark storage task ${task._id} failed: ${formatFriendlyError(markFailedError)}`,
          jobId,
        );
      }
    } finally {
      clearInterval(leaseRenewalTimer);
      this.activeStorageTaskId = null;
    }
  }

  private startRenderJobWorker() {
    if (this.renderJobPollTimer) {
      clearInterval(this.renderJobPollTimer);
    }

    this.renderJobPollTimer = setInterval(() => {
      void this.pollRenderJobs();
    }, 5_000);

    void this.pollRenderJobs();
  }

  private canRunRenderWorker() {
    return Boolean(
      this.settings.convex.deploymentUrl &&
        this.settings.tempOutputPath &&
        this.settings.b2.bucket &&
        this.settings.b2.keyId &&
        this.settings.b2.applicationKey &&
        this.settings.r2.bucket &&
        this.settings.r2.accountId &&
        this.settings.r2.accessKeyId &&
        this.settings.r2.secretAccessKey &&
        this.settings.r2.publicBaseUrl &&
        this.state.system.ffmpegAvailable &&
        this.state.system.rcloneAvailable,
    );
  }

  private async pollRenderJobs() {
    if (this.activeRenderJobId || !this.canRunRenderWorker()) {
      return;
    }

    try {
      const renderJob = await this.convexService.claimNextRenderJob(
        this.settings,
        this.desktopNodeKey,
      );
      if (!renderJob) {
        return;
      }

      void this.processRenderJob(renderJob);
    } catch (error) {
      this.pushLog('warn', 'convex', `Render job polling failed: ${formatFriendlyError(error)}`);
    }
  }

  private async processRenderJob(renderJob: RenderJobSnapshot) {
    this.activeRenderJobId = renderJob._id;
    await this.reportDesktopNodeHeartbeat();

    const jobId = `render:${renderJob._id}`;
    const workingDirectory = path.join(this.settings.tempOutputPath, 'render-jobs', renderJob._id);
    const sourceDirectory = path.join(workingDirectory, 'source');
    const outputDirectory = path.join(workingDirectory, 'output');
    const leaseRenewalTimer = setInterval(() => {
      void this.convexService.renewRenderJobLease(
        this.settings,
        renderJob._id,
        this.desktopNodeKey,
      ).catch((error) => {
        this.pushLog(
          'warn',
          'convex',
          `Render job lease renewal failed: ${formatFriendlyError(error)}`,
          jobId,
        );
      });
    }, 30_000);

    try {
      const sourceVideo = await this.findStoredVideoById(renderJob.sourceVideoId);
      if (!sourceVideo) {
        throw new Error(`Source video ${renderJob.sourceVideoId} was not found.`);
      }

      const sourceObjectKey = renderJob.sourceObjectKey ?? sourceVideo.archiveObjectKey;
      if (!sourceObjectKey) {
        throw new Error(`Source video ${sourceVideo.title} does not have a B2 archive object key.`);
      }

      const sourcePath = path.join(sourceDirectory, sourceVideo.sourceFileName || `${renderJob._id}.mp4`);
      await this.convexService.markRenderJobProgress(this.settings, {
        renderJobId: renderJob._id,
        nodeKey: this.desktopNodeKey,
        status: 'claimed',
        progress: 5,
        stage: 'downloading-source',
        message: 'Downloading archived master from Backblaze B2.',
      });

      await this.syncService.downloadFileFromB2({
        jobId,
        sourceObjectKey,
        localFilePath: sourcePath,
        settings: this.settings,
        onProgress: (progress) => {
          this.pushLog('debug', 'sync', `Archived master download ${Math.round(progress)}%.`, jobId);
        },
        onLog: (message) => this.pushLog('info', 'sync', message, jobId),
      });

      await this.convexService.markRenderJobProgress(this.settings, {
        renderJobId: renderJob._id,
        nodeKey: this.desktopNodeKey,
        status: 'claimed',
        progress: 25,
        stage: 'downloaded-source',
        message: 'Archived master downloaded.',
      });

      const inPointSeconds = Math.max(0, renderJob.inPointSeconds ?? 0);
      const outPointSeconds = Math.max(
        inPointSeconds + 0.5,
        renderJob.outPointSeconds ?? sourceVideo.durationSeconds,
      );

      await this.convexService.markRenderJobProgress(this.settings, {
        renderJobId: renderJob._id,
        nodeKey: this.desktopNodeKey,
        status: 'rendering',
        progress: 30,
        stage: 'rendering',
        message: `Rendering ${renderJob.aspectRatio} social asset with FFmpeg.`,
      });

      const artifact = await this.transcodeService.reframeClip({
        sourcePath,
        outputDirectory,
        inPointSeconds,
        outPointSeconds,
        aspectRatio: renderJob.aspectRatio,
        settings: this.settings,
        onLog: (message) => this.pushLog('info', 'transcode', message, jobId),
      });

      const clipOutputPath = path.join(outputDirectory, artifact.playbackRelativePath);
      const outputObjectKey = this.buildRenderOutputObjectKey(renderJob, sourceVideo);

      await this.convexService.markRenderJobProgress(this.settings, {
        renderJobId: renderJob._id,
        nodeKey: this.desktopNodeKey,
        status: 'uploading',
        progress: 82,
        stage: 'uploading-render',
        message: 'Uploading social render to Cloudflare R2.',
      });

      await this.syncService.uploadFileToR2({
        jobId,
        localFilePath: clipOutputPath,
        destinationObjectKey: outputObjectKey,
        settings: this.settings,
        onLog: (message) => this.pushLog('info', 'sync', message, jobId),
      });

      await this.convexService.completeRenderJob(this.settings, {
        renderJobId: renderJob._id,
        nodeKey: this.desktopNodeKey,
        objectKey: outputObjectKey,
        url: joinPublicUrl(this.settings.r2.publicBaseUrl, outputObjectKey),
        mimeType: 'video/mp4',
        durationSeconds: artifact.durationSeconds,
      });

      this.pushLog('info', 'convex', `Completed Spool render job ${renderJob._id}.`, jobId);
    } catch (error) {
      const message = formatFriendlyError(error);
      this.pushLog('error', 'system', `Spool render job ${renderJob._id} failed: ${message}`, jobId);
      try {
        await this.convexService.markRenderJobFailed(
          this.settings,
          renderJob._id,
          this.desktopNodeKey,
          message,
        );
      } catch (markFailedError) {
        this.pushLog(
          'warn',
          'convex',
          `Could not mark render job ${renderJob._id} failed: ${formatFriendlyError(markFailedError)}`,
          jobId,
        );
      }
    } finally {
      clearInterval(leaseRenewalTimer);
      if (this.settings.autoCleanupTempFiles) {
        await rm(workingDirectory, { recursive: true, force: true });
      }
      this.activeRenderJobId = null;
      await this.reportDesktopNodeHeartbeat();
    }
  }

  private async enqueueSourceFile(
    sourcePath: string,
    options?: {
      isRetry?: boolean;
      reuseJobFolderName?: string | null;
      manualIntake?: ManualIntakeRequest | null;
    },
  ) {
    const isRetry = options?.isRetry ?? false;
    const reuseJobFolderName = options?.reuseJobFolderName ?? null;
    const manualIntake = options?.manualIntake ?? null;
    const pipelineRoute = manualIntake?.route ?? null;
    const routePreset = pipelineRoute ? this.getManualPipelinePreset(pipelineRoute) : null;
    const sourceStats = await stat(sourcePath);
    const existingActiveJob = Array.from(this.jobs.values()).find(
      (job) =>
        job.sourcePath === sourcePath &&
        !['complete', 'error'].includes(job.status),
    );

    if (existingActiveJob) {
      this.pushLog(
        'warn',
        'system',
        `Skipped ${path.basename(sourcePath)} because it is already in flight.`,
        existingActiveJob.id,
      );
      return existingActiveJob.id;
    }

    const jobId = createId();
    const createdAt = nowIso();
    const job: IngestJobSnapshot = {
      id: jobId,
      intakeMode: manualIntake ? 'manual' : 'watch',
      pipelineRoute,
      title: manualIntake?.title ?? null,
      sourcePath,
      sourceName: path.basename(sourcePath),
      sourceSizeBytes: sourceStats.size,
      sourceFrameRate: null,
      sourceWidth: null,
      sourceHeight: null,
      sourceVideoCodec: null,
      sourceAudioCodec: null,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
      status: isRetry ? 'queued' : 'checking',
      stage: isRetry ? 'waiting' : 'file-ready',
      message: isRetry
        ? reuseJobFolderName
          ? 'Same-prefix retry queued.'
          : 'Retry queued.'
        : manualIntake
          ? 'Manual intake is ready for ingest.'
          : 'Source file is ready for ingest.',
      encodingProgress: 0,
      uploadProgress: 0,
      encoder: null,
      requestedDelivery: routePreset?.requestedDelivery ?? null,
      deliveryType: null,
      contentType: routePreset?.contentType ?? null,
      outputDirectory: null,
      masterPlaylistPath: null,
      manifestUrl: null,
      posterPath: null,
      posterUrl: null,
      publicUrl: null,
      sources: [],
      archiveObjectKey: null,
      distributionObjectKey: null,
      sourceFingerprint: null,
      durationSeconds: null,
      tags: manualIntake?.tags ?? [],
      playlistTitles: manualIntake?.playlistTitles ?? [],
      description: manualIntake?.description ?? null,
      series: manualIntake?.series ?? null,
      recordedAt: manualIntake?.recordedAt ?? null,
      projectName: manualIntake?.projectName ?? null,
      eventName: manualIntake?.eventName ?? null,
      cameraId: manualIntake?.cameraId ?? null,
      sourceNode: manualIntake?.sourceNode ?? null,
      reviewStatus: routePreset?.reviewStatus ?? null,
      socialStatus: routePreset?.socialStatus ?? null,
      scheduledPublishAt: null,
      sidecarPath: null,
      errorMessage: null,
    };

    this.jobs.set(jobId, job);
    this.trimJobHistory();
    this.broadcastState();

    void this.processJob(jobId, { reuseJobFolderName });
    return jobId;
  }

  private getDialogWindow() {
    return BrowserWindow.getFocusedWindow() ?? Array.from(this.windows)[0];
  }

  private addCacheBust(url: string | null | undefined, updatedAt: string) {
    if (!url) {
      return url ?? undefined;
    }

    try {
      const nextUrl = new URL(url);
      nextUrl.searchParams.set('v', updatedAt);
      return nextUrl.toString();
    } catch {
      return url;
    }
  }

  private broadcastOffloadTask(task: OffloadTaskSnapshot) {
    for (const window of this.windows) {
      if (window.isDestroyed()) {
        continue;
      }

      window.webContents.send(IPC_CHANNELS.offloadUpdated, task);
    }
  }

  private async processJob(jobId: string, options?: { reuseJobFolderName?: string | null }) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    try {
      await this.validatePipelineConfiguration();

      const sidecarMetadata = await loadSourceMetadata(job.sourcePath);
      const routePreset = job.pipelineRoute ? this.getManualPipelinePreset(job.pipelineRoute) : null;
      const sourceMetadata = this.resolveEffectiveSourceMetadata(
        sidecarMetadata,
        job,
        routePreset,
      );
      const finalStoredStatus = routePreset?.finalStatus ?? 'ready';
      const probe = await this.transcodeService.inspectSource(job.sourcePath);
      const requestedDelivery = this.resolveRequestedDelivery(sourceMetadata.requestedDelivery);
      const deliveryType = this.resolveDeliveryType(requestedDelivery, probe);
      const contentType = this.resolveContentType(sourceMetadata.contentType, deliveryType);
      const preferredEncoder = resolveEncoderRuntime(this.settings).effectiveEncoder;

      this.updateJob(jobId, {
        startedAt: nowIso(),
        updatedAt: nowIso(),
        status: 'checking',
        stage: 'fingerprinting',
        title: sourceMetadata.title ?? path.parse(job.sourceName).name,
        message: 'Calculating source fingerprint for duplicate detection.',
        encoder: preferredEncoder,
        requestedDelivery,
        deliveryType,
        contentType,
        durationSeconds: probe.durationSeconds,
        sourceFrameRate: probe.frameRate || null,
        sourceWidth: probe.width,
        sourceHeight: probe.height,
        sourceVideoCodec: probe.videoCodec,
        sourceAudioCodec: probe.audioCodec,
        tags: sourceMetadata.tags,
        playlistTitles: sourceMetadata.playlistTitles,
        description: sourceMetadata.description ?? null,
        series: sourceMetadata.series ?? null,
        recordedAt: sourceMetadata.recordedAt ?? null,
        projectName: sourceMetadata.projectName ?? null,
        eventName: sourceMetadata.eventName ?? null,
        cameraId: sourceMetadata.cameraId ?? null,
        sourceNode: sourceMetadata.sourceNode ?? null,
        reviewStatus: sourceMetadata.reviewStatus ?? null,
        socialStatus: sourceMetadata.socialStatus ?? null,
        scheduledPublishAt: sourceMetadata.scheduledPublishAt ?? null,
        sidecarPath: sourceMetadata.sidecarPath,
      });

      const sourceFingerprint = await computeSourceFingerprint(job.sourcePath);

      this.updateJob(jobId, {
        updatedAt: nowIso(),
        status: 'checking',
        stage: 'checking-duplicate',
        sourceFingerprint,
        message: 'Checking Convex for an existing uploaded copy of this source.',
      });

      const reusableVideo = await this.findReusableDuplicate(jobId, sourceFingerprint, deliveryType);
      if (reusableVideo) {
        await this.completeDuplicateJob(jobId, reusableVideo, sourceMetadata, finalStoredStatus);
        return;
      }

      const jobFolderName = options?.reuseJobFolderName?.trim() || buildJobFolderName(job.sourcePath, job.id);
      const outputDirectory = path.join(this.settings.tempOutputPath, jobFolderName);
      // Resolved once, before any bytes move, so the optimistic pre-upload UI
      // and the real upload cannot disagree about where this asset lives.
      const keyPlan = this.buildStorageKeyPlan({
        jobFolderName,
        sourceName: job.sourceName,
        sourceFingerprint,
        projectName: sourceMetadata.projectName ?? null,
        recordedAt: sourceMetadata.recordedAt ?? null,
      });
      const expectedSyncTargets = buildSyncTargets(
        this.settings,
        keyPlan,
        this.buildExpectedArtifact(deliveryType),
      );

      this.updateJob(jobId, {
        updatedAt: nowIso(),
        status: 'queued',
        stage: 'waiting',
        message: 'Waiting for the transcode queue.',
        outputDirectory,
        masterPlaylistPath: deliveryType === 'hls' ? path.join(outputDirectory, 'master.m3u8') : null,
        archiveObjectKey: expectedSyncTargets.archiveObjectKey,
        distributionObjectKey: expectedSyncTargets.distributionObjectKey,
        manifestUrl: expectedSyncTargets.manifestUrl,
        publicUrl: expectedSyncTargets.playbackUrl,
        sources: expectedSyncTargets.sources,
      });

      this.showNotification('Ingest started', `${job.sourceName} entered the ingest queue.`);
      await this.syncConvexStatus(jobId, 'processing');

      const transcodeResult = await this.transcodeService.enqueue({
        jobId,
        sourcePath: job.sourcePath,
        outputDirectory,
        deliveryType,
        settings: this.settings,
        probe,
        onProgress: (encodingProgress) => {
          this.updateJob(jobId, {
            status: 'encoding',
            stage: 'encoding',
            message:
              deliveryType === 'hls'
                ? `Encoding HLS ladder at ${encodingProgress.toFixed(0)}%.`
                : `Encoding progressive renditions at ${encodingProgress.toFixed(0)}%.`,
            encodingProgress,
            updatedAt: nowIso(),
          });
        },
        onLog: (message) => this.pushLog('info', 'transcode', message, jobId),
      });

      const syncTargets = buildSyncTargets(this.settings, keyPlan, transcodeResult);

      this.updateJob(jobId, {
        status: 'uploading',
        stage: 'uploading-archive',
        message: 'Archive and distribution sync started.',
        encodingProgress: 100,
        encoder: transcodeResult.effectiveEncoder,
        durationSeconds: transcodeResult.durationSeconds,
        sourceFrameRate: transcodeResult.frameRate || null,
        sourceWidth: transcodeResult.width,
        sourceHeight: transcodeResult.height,
        sourceVideoCodec: transcodeResult.videoCodec,
        sourceAudioCodec: transcodeResult.audioCodec,
        posterPath: transcodeResult.posterPath,
        posterUrl: transcodeResult.posterPath ? syncTargets.posterUrl : null,
        masterPlaylistPath: transcodeResult.masterPlaylistPath,
        manifestUrl: syncTargets.manifestUrl,
        publicUrl: syncTargets.playbackUrl,
        sources: syncTargets.sources,
        updatedAt: nowIso(),
      });

      await this.syncConvexStatus(jobId, 'uploading');

      const syncResult = await this.syncService.sync({
        jobId,
        sourcePath: job.sourcePath,
        sourceName: job.sourceName,
        outputDirectory,
        keyPlan,
        artifact: transcodeResult,
        settings: this.settings,
        onProgress: (uploadProgress) => {
          this.updateJob(jobId, {
            status: 'uploading',
            stage: uploadProgress < 35 ? 'uploading-archive' : 'uploading-distribution',
            message:
              uploadProgress < 35
                ? `Uploading source archive ${uploadProgress.toFixed(0)}%.`
                : deliveryType === 'hls'
                  ? `Uploading HLS ladder ${uploadProgress.toFixed(0)}%.`
                  : `Uploading progressive renditions ${uploadProgress.toFixed(0)}%.`,
            uploadProgress,
            updatedAt: nowIso(),
          });
        },
        onStageChange: (stage, message) => {
          this.updateJob(jobId, {
            status: 'uploading',
            stage,
            message,
            updatedAt: nowIso(),
          });
        },
        onLog: (message) => this.pushLog('info', 'sync', message, jobId),
      });

      this.updateJob(jobId, {
        status: 'registering',
        stage: 'registering',
        message:
          contentType === 'clip'
            ? 'Registering clip entry with Convex.'
            : 'Registering VOD entry with Convex.',
        uploadProgress: 100,
        archiveObjectKey: syncResult.archiveObjectKey,
        distributionObjectKey: syncResult.distributionObjectKey,
        manifestUrl: syncResult.manifestUrl,
        publicUrl: syncResult.playbackUrl,
        posterUrl: this.jobs.get(jobId)?.posterPath ? syncResult.posterUrl : null,
        sources: syncResult.sources,
        updatedAt: nowIso(),
      });

      const readyPayload = this.buildConvexPayload(jobId, finalStoredStatus);
      if (!readyPayload) {
        throw new Error('Unable to build Convex payload for the completed ingest job.');
      }

      await this.convexService.createVodEntry(this.settings, readyPayload, jobId);

      if (this.settings.autoCleanupTempFiles) {
        this.updateJob(jobId, {
          stage: 'cleaning',
          message: 'Cleaning local temp files.',
          updatedAt: nowIso(),
        });

        await rm(outputDirectory, { recursive: true, force: true });
      }

      this.updateJob(jobId, {
        status: 'complete',
        stage: 'complete',
        message: this.getCompletedJobMessage(contentType, finalStoredStatus),
        completedAt: nowIso(),
        updatedAt: nowIso(),
        posterPath: this.settings.autoCleanupTempFiles ? null : this.jobs.get(jobId)?.posterPath ?? null,
      });
      this.showNotification('Ingest complete', `${job.sourceName} is ready to watch.`);
    } catch (error) {
      const message = formatFriendlyError(error);
      this.pushLog('error', 'system', message, jobId);
      this.updateJob(jobId, {
        status: 'error',
        stage: 'error',
        message,
        errorMessage: message,
        updatedAt: nowIso(),
        completedAt: nowIso(),
      });
      await this.syncConvexStatus(jobId, 'error');
      this.showNotification('Ingest failed', `${job.sourceName} needs attention.`);
    }
  }

  private updateJob(jobId: string, patch: Partial<IngestJobSnapshot>) {
    const current = this.jobs.get(jobId);
    if (!current) {
      return;
    }

    this.jobs.set(jobId, {
      ...current,
      ...patch,
    });

    this.broadcastState();
  }

  private getSortedJobs() {
    return Array.from(this.jobs.values()).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  private trimJobHistory() {
    const jobs = this.getSortedJobs();
    if (jobs.length <= MAX_JOB_HISTORY) {
      return;
    }

    for (const job of jobs.slice(MAX_JOB_HISTORY)) {
      if (job.status === 'complete' || job.status === 'error') {
        this.jobs.delete(job.id);
      }
    }
  }

  private pushLog(level: LogLevel, source: LogSource, message: string, jobId?: string) {
    this.logs.unshift({
      id: createId(),
      timestamp: nowIso(),
      level,
      source,
      message,
      jobId,
    });

    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs.length = MAX_LOG_ENTRIES;
    }

    this.broadcastState();
  }

  private broadcastState() {
    const snapshot = this.getState();
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.stateUpdated, snapshot);
      }
    }
  }

  private async validatePipelineConfiguration() {
    await this.ensureFolderExists(this.settings.watchFolder, 'Ingest folder');
    if (!this.settings.tempOutputPath) {
      throw new Error('Temporary output folder is not configured.');
    }
    await mkdir(this.settings.tempOutputPath, { recursive: true });

    const missingFields = [
      !this.settings.tempOutputPath && 'Temporary output folder',
      !this.settings.b2.bucket && 'Backblaze B2 bucket',
      !this.settings.b2.keyId && 'Backblaze B2 key ID',
      !this.settings.b2.applicationKey && 'Backblaze B2 application key',
      !this.settings.r2.accountId && 'Cloudflare R2 account ID',
      !this.settings.r2.bucket && 'Cloudflare R2 bucket',
      !this.settings.r2.accessKeyId && 'Cloudflare R2 access key',
      !this.settings.r2.secretAccessKey && 'Cloudflare R2 secret key',
      !this.settings.r2.publicBaseUrl && 'Cloudflare R2 public base URL',
      !this.settings.convex.deploymentUrl && 'Convex deployment URL',
      !this.settings.convex.mutationPath && 'Convex mutation path',
    ].filter(Boolean);

    if (missingFields.length > 0) {
      throw new Error(`Complete the following settings before ingesting: ${missingFields.join(', ')}.`);
    }
  }

  private async ensureFolderExists(folderPath: string, label: string) {
    if (!folderPath) {
      throw new Error(`${label} is not configured.`);
    }

    await access(folderPath, fsConstants.R_OK);
  }

  private checkCommand(command: string, args: string[]) {
    return new Promise<CommandCheckResult>((resolve) => {
      const child = spawn(command, args, {
        stdio: 'ignore',
      });

      child.on('error', (error) => {
        resolve({
          available: false,
          message: `${command} is unavailable: ${error.message}`,
        });
      });

      child.on('close', (code) => {
        resolve({
          available: code === 0,
          message:
            code === 0 ? `${command} detected on PATH.` : `${command} returned code ${code ?? 'unknown'}.`,
        });
      });
    });
  }

  private async checkInternetConnectivity() {
    try {
      const addresses = await resolve4('cloudflare.com');
      return addresses.length > 0;
    } catch {
      return false;
    }
  }

  private async checkWatchFolderAccessible() {
    if (!this.settings.watchFolder) {
      return false;
    }

    try {
      await access(this.settings.watchFolder, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  private startHeartbeatMonitor() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      void this.refreshSystem();
    }, 30_000);
  }

  private showNotification(title: string, body: string) {
    if (!this.settings.enableNotifications || !Notification.isSupported()) {
      return;
    }

    new Notification({
      title,
      body,
      silent: false,
    }).show();
  }

  private mergeUniqueStrings(...groups: Array<string[] | null | undefined>) {
    return Array.from(
      new Set(
        groups
          .flatMap((group) => group ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );
  }

  private normalizeOptionalString(value: string | null | undefined) {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private normalizeStringList(values: string[] | null | undefined) {
    return Array.from(
      new Set(
        (values ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );
  }

  private normalizeManualIntakeRequest(request: ManualIntakeRequest): ManualIntakeRequest {
    if (!MANUAL_PIPELINE_ROUTES.includes(request.route)) {
      throw new Error('Choose a valid manual intake pipeline.');
    }

    return {
      sourcePath: path.resolve(request.sourcePath),
      route: request.route,
      title: this.normalizeOptionalString(request.title),
      description: this.normalizeOptionalString(request.description),
      series: this.normalizeOptionalString(request.series),
      recordedAt: this.normalizeOptionalString(request.recordedAt),
      projectName: this.normalizeOptionalString(request.projectName),
      eventName: this.normalizeOptionalString(request.eventName),
      cameraId: this.normalizeOptionalString(request.cameraId),
      sourceNode: this.normalizeOptionalString(request.sourceNode),
      tags: this.normalizeStringList(request.tags),
      playlistTitles: this.normalizeStringList(request.playlistTitles),
    };
  }

  private buildManualIntakeRequestFromJob(job: IngestJobSnapshot): ManualIntakeRequest | null {
    if (!job.pipelineRoute) {
      return null;
    }

    return this.normalizeManualIntakeRequest({
      sourcePath: job.sourcePath,
      route: job.pipelineRoute,
      title: job.title ?? undefined,
      description: job.description ?? undefined,
      series: job.series ?? undefined,
      recordedAt: job.recordedAt ?? undefined,
      projectName: job.projectName ?? undefined,
      eventName: job.eventName ?? undefined,
      cameraId: job.cameraId ?? undefined,
      sourceNode: job.sourceNode ?? undefined,
      tags: job.tags,
      playlistTitles: job.playlistTitles,
    });
  }

  private getManualPipelinePreset(route: ManualPipelineRoute): ManualPipelinePreset {
    if (route === 'clip_progressive') {
      return {
        requestedDelivery: 'progressive',
        contentType: 'clip',
        reviewStatus: 'approved',
        socialStatus: 'none',
        finalStatus: 'ready',
      };
    }

    if (route === 'review_draft') {
      return {
        requestedDelivery: 'auto',
        contentType: 'vod',
        reviewStatus: 'needs_review',
        socialStatus: 'none',
        finalStatus: 'draft',
      };
    }

    return {
      requestedDelivery: 'auto',
      contentType: 'vod',
      reviewStatus: 'approved',
      socialStatus: 'none',
      finalStatus: 'ready',
    };
  }

  private resolveEffectiveSourceMetadata(
    sidecarMetadata: SourceMetadata,
    job: IngestJobSnapshot,
    routePreset: ManualPipelinePreset | null,
  ): SourceMetadata {
    if (job.intakeMode !== 'manual') {
      return sidecarMetadata;
    }

    return {
      title: job.title ?? sidecarMetadata.title,
      description: job.description ?? sidecarMetadata.description,
      series: job.series ?? sidecarMetadata.series,
      recordedAt: job.recordedAt ?? sidecarMetadata.recordedAt,
      projectName: job.projectName ?? sidecarMetadata.projectName,
      eventName: job.eventName ?? sidecarMetadata.eventName,
      cameraId: job.cameraId ?? sidecarMetadata.cameraId,
      sourceNode: job.sourceNode ?? sidecarMetadata.sourceNode,
      reviewStatus: job.reviewStatus ?? routePreset?.reviewStatus ?? sidecarMetadata.reviewStatus,
      socialStatus: job.socialStatus ?? routePreset?.socialStatus ?? sidecarMetadata.socialStatus,
      scheduledPublishAt: job.scheduledPublishAt ?? sidecarMetadata.scheduledPublishAt,
      requestedDelivery:
        routePreset?.requestedDelivery ?? job.requestedDelivery ?? sidecarMetadata.requestedDelivery,
      contentType: routePreset?.contentType ?? job.contentType ?? sidecarMetadata.contentType,
      tags: this.mergeUniqueStrings(sidecarMetadata.tags, job.tags),
      playlistTitles: this.mergeUniqueStrings(sidecarMetadata.playlistTitles, job.playlistTitles),
      sidecarPath: sidecarMetadata.sidecarPath,
    };
  }

  private getCompletedJobMessage(contentType: ContentType, finalStatus: StoredVideoStatus) {
    if (finalStatus === 'draft') {
      return this.settings.autoCleanupTempFiles
        ? 'Review draft complete. Cloud sync, Convex draft registration, and temp cleanup finished.'
        : 'Review draft complete. Archive, distribution, and Convex draft registration finished.';
    }

    return this.settings.autoCleanupTempFiles
      ? `${contentType === 'clip' ? 'Clip' : 'Ingest'} complete. Cloud sync, Convex registration, and temp cleanup finished.`
      : `${contentType === 'clip' ? 'Clip' : 'Ingest'} complete. Archive, distribution, and Convex registration finished.`;
  }

  private resolveRequestedDelivery(requestedDelivery: RequestedDeliveryType | undefined) {
    return (requestedDelivery ?? 'auto') as RequestedDeliveryType;
  }

  private resolveDeliveryType(
    requestedDelivery: RequestedDeliveryType,
    probe: SourceProbe,
  ): DeliveryType {
    return resolveAutoDeliveryType({
      requestedDelivery,
      durationSeconds: probe.durationSeconds,
      autoProgressiveMaxDurationSeconds: this.settings.autoProgressiveMaxDurationSeconds,
    });
  }

  private resolveContentType(
    requestedContentType: ContentType | undefined,
    deliveryType: DeliveryType,
  ): ContentType {
    return requestedContentType ?? (deliveryType === 'progressive' ? 'clip' : 'vod');
  }

  private buildExpectedArtifact(deliveryType: DeliveryType): PackagedVideoResult {
    return {
      deliveryType,
      durationSeconds: 0,
      frameRate: 0,
      width: null,
      height: null,
      videoCodec: null,
      audioCodec: null,
      posterPath: this.settings.extractPosterFrame ? 'poster.jpg' : null,
      masterPlaylistPath: deliveryType === 'hls' ? 'master.m3u8' : null,
      manifestRelativePath: deliveryType === 'hls' ? 'master.m3u8' : null,
      playbackRelativePath: deliveryType === 'hls' ? 'master.m3u8' : 'playback-h264.mp4',
      sources:
        deliveryType === 'progressive'
          ? [{ codec: 'h264', mimeType: 'video/mp4', relativePath: 'playback-h264.mp4' }]
          : [],
      effectiveEncoder: resolveEncoderRuntime(this.settings).effectiveEncoder,
    };
  }

  private async findReusableDuplicate(
    jobId: string,
    sourceFingerprint: string,
    deliveryType: DeliveryType,
  ) {
    try {
      const matches = await this.convexService.findVideosBySourceFingerprint(
        this.settings,
        sourceFingerprint,
        jobId,
      );
      const readyMatch = matches.find((match) => {
        const matchDeliveryType = inferStoredDeliveryType(match);
        return (
          match.status === 'ready' &&
          Boolean(match.playbackUrl) &&
          matchDeliveryType === deliveryType
        );
      });

      if (readyMatch) {
        this.pushLog(
          'info',
          'system',
          `Duplicate source detected. Reusing existing uploaded asset from Convex record ${readyMatch._id}.`,
          jobId,
        );
      }

      return readyMatch ?? null;
    } catch (error) {
      this.pushLog(
        'warn',
        'convex',
        `Duplicate check skipped: ${formatFriendlyError(error)}`,
        jobId,
      );
      return null;
    }
  }

  private async completeDuplicateJob(
    jobId: string,
    existingVideo: ExistingVideoRecord,
    sourceMetadata: SourceMetadata,
    finalStatus: StoredVideoStatus,
  ) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    const title = sourceMetadata.title ?? existingVideo.title;
    const tags = this.mergeUniqueStrings(existingVideo.tags, sourceMetadata.tags);
    const description = sourceMetadata.description ?? existingVideo.description ?? null;
    const series = sourceMetadata.series ?? existingVideo.series ?? null;
    const recordedAt = sourceMetadata.recordedAt ?? existingVideo.recordedAt ?? null;
    const projectName = sourceMetadata.projectName ?? existingVideo.projectName ?? null;
    const eventName = sourceMetadata.eventName ?? existingVideo.eventName ?? null;
    const cameraId = sourceMetadata.cameraId ?? existingVideo.cameraId ?? null;
    const sourceNode = sourceMetadata.sourceNode ?? existingVideo.sourceNode ?? null;
    const reviewStatus = sourceMetadata.reviewStatus ?? existingVideo.reviewStatus ?? null;
    const socialStatus = sourceMetadata.socialStatus ?? existingVideo.socialStatus ?? null;
    const scheduledPublishAt = sourceMetadata.scheduledPublishAt ?? existingVideo.scheduledPublishAt ?? null;
    const deliveryType = inferStoredDeliveryType(existingVideo);
    const contentType = inferStoredContentType(existingVideo);

    try {
      await this.convexService.createVodEntry(
        this.settings,
        {
          title,
          sourceName: existingVideo.sourceFileName,
          sourceFingerprint: job.sourceFingerprint,
          requestedDelivery: sourceMetadata.requestedDelivery ?? existingVideo.requestedDelivery ?? 'auto',
          deliveryType,
          contentType,
          archiveObjectKey: existingVideo.archiveObjectKey,
          distributionObjectKey: existingVideo.distributionObjectKey,
          playbackUrl: existingVideo.playbackUrl,
          manifestUrl: existingVideo.manifestUrl ?? existingVideo.masterPlaylistUrl ?? null,
          posterUrl: existingVideo.posterUrl ?? null,
          sources: existingVideo.sources ?? [],
          encoder: existingVideo.encoder,
          durationSeconds: existingVideo.durationSeconds,
          sourceFileSizeBytes: existingVideo.sourceFileSizeBytes ?? job.sourceSizeBytes,
          sourceFrameRate: existingVideo.sourceFrameRate ?? null,
          sourceWidth: existingVideo.sourceWidth ?? null,
          sourceHeight: existingVideo.sourceHeight ?? null,
          sourceVideoCodec: existingVideo.sourceVideoCodec ?? null,
          sourceAudioCodec: existingVideo.sourceAudioCodec ?? null,
          tags,
          playlistTitles: sourceMetadata.playlistTitles,
          description,
          series,
          recordedAt,
          projectName,
          eventName,
          cameraId,
          sourceNode,
          reviewStatus,
          socialStatus,
          scheduledPublishAt,
          status: finalStatus,
        },
        jobId,
      );
    } catch (error) {
      this.pushLog(
        'warn',
        'convex',
        `Duplicate metadata refresh failed: ${formatFriendlyError(error)}`,
        jobId,
      );
    }

    this.updateJob(jobId, {
      title,
      status: 'complete',
      stage: 'complete',
      message:
        finalStatus === 'draft'
          ? 'Duplicate detected. Existing uploaded asset reused and marked as a review draft.'
          : 'Duplicate detected. Existing uploaded asset reused; no transcode or upload was required.',
      completedAt: nowIso(),
      updatedAt: nowIso(),
      encoder: existingVideo.encoder,
      requestedDelivery: sourceMetadata.requestedDelivery ?? existingVideo.requestedDelivery ?? 'auto',
      deliveryType,
      contentType,
      durationSeconds: existingVideo.durationSeconds,
      sourceFrameRate: existingVideo.sourceFrameRate ?? null,
      sourceWidth: existingVideo.sourceWidth ?? null,
      sourceHeight: existingVideo.sourceHeight ?? null,
      sourceVideoCodec: existingVideo.sourceVideoCodec ?? null,
      sourceAudioCodec: existingVideo.sourceAudioCodec ?? null,
      archiveObjectKey: existingVideo.archiveObjectKey,
      distributionObjectKey: existingVideo.distributionObjectKey,
      manifestUrl: existingVideo.manifestUrl ?? existingVideo.masterPlaylistUrl ?? null,
      publicUrl: existingVideo.playbackUrl,
      posterUrl: existingVideo.posterUrl ?? null,
      sources: existingVideo.sources ?? [],
      tags,
      playlistTitles: sourceMetadata.playlistTitles,
      description,
      series,
      recordedAt,
      projectName,
      eventName,
      cameraId,
      sourceNode,
      reviewStatus,
      socialStatus,
      scheduledPublishAt,
      errorMessage: null,
    });

    this.showNotification(
      'Duplicate skipped',
      `${job.sourceName} already exists in the library. Existing upload reused.`,
    );
  }

  private buildConvexPayload(
    jobId: string,
    status: StoredVideoStatus,
  ) {
    const job = this.jobs.get(jobId);
    if (
      !job ||
      !job.archiveObjectKey ||
      !job.distributionObjectKey ||
      !job.publicUrl
    ) {
      return null;
    }

    return {
      title: job.title ?? undefined,
      sourceName: job.sourceName,
      sourceFingerprint: job.sourceFingerprint,
      requestedDelivery: job.requestedDelivery,
      deliveryType: job.deliveryType,
      contentType: job.contentType,
      archiveObjectKey: job.archiveObjectKey,
      distributionObjectKey: job.distributionObjectKey,
      playbackUrl: job.publicUrl,
      manifestUrl: job.manifestUrl,
      posterUrl: job.posterUrl,
      sources: job.sources,
      encoder:
        job.encoder ?? resolveEncoderRuntime(this.settings).effectiveEncoder,
      durationSeconds: job.durationSeconds ?? 0,
      sourceFileSizeBytes: job.sourceSizeBytes,
      sourceFrameRate: job.sourceFrameRate,
      sourceWidth: job.sourceWidth,
      sourceHeight: job.sourceHeight,
      sourceVideoCodec: job.sourceVideoCodec,
      sourceAudioCodec: job.sourceAudioCodec,
      tags: job.tags,
      playlistTitles: job.playlistTitles,
      description: job.description,
      series: job.series,
      recordedAt: job.recordedAt,
      projectName: job.projectName,
      eventName: job.eventName,
      cameraId: job.cameraId,
      sourceNode: job.sourceNode,
      reviewStatus: job.reviewStatus,
      socialStatus: job.socialStatus,
      scheduledPublishAt: job.scheduledPublishAt,
      errorMessage: status === 'error' ? job.errorMessage : null,
      status,
    };
  }

  private async syncConvexStatus(
    jobId: string,
    status: 'processing' | 'uploading' | 'error',
  ) {
    const payload = this.buildConvexPayload(jobId, status);
    if (!payload) {
      return;
    }

    try {
      await this.convexService.createVodEntry(this.settings, payload, jobId);
    } catch (error) {
      this.pushLog(
        'warn',
        'convex',
        `Non-blocking Convex status update failed: ${formatFriendlyError(error)}`,
        jobId,
      );
    }
  }
}

import { access, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve4 } from 'node:dns/promises';
import { BrowserWindow, Notification, dialog } from 'electron';
import { MAX_JOB_HISTORY, MAX_LOG_ENTRIES, initialBridgeState } from '../../shared/defaults';
import {
  inferStoredContentType,
  inferStoredDeliveryType,
  resolveDeliveryType as resolveAutoDeliveryType,
} from '../../shared/media';
import type {
  AppSettings,
  BridgeStateSnapshot,
  ContentType,
  DeliveryType,
  DirectoryBrowseResult,
  IngestJobSnapshot,
  LocalTrimSourceSnapshot,
  LogEntry,
  LogLevel,
  LogSource,
  RequestedDeliveryType,
  TrimClipRequest,
  TrimClipResult,
  SaveSettingsResult,
} from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/ipc';
import {
  buildJobFolderName,
  createId,
  formatFriendlyError,
  nowIso,
} from '../lib/helpers';
import { resolveEncoderRuntime } from '../lib/encoder';
import { computeSourceFingerprint } from '../lib/sourceFingerprint';
import { loadSourceMetadata } from '../lib/sourceMetadata';
import { StoreService } from './StoreService';
import { WatcherService } from './WatcherService';
import {
  TranscodeService,
  type PackagedVideoResult,
  type SourceProbe,
} from './TranscodeService';
import { SyncService, buildSyncTargets } from './SyncService';
import { ConvexService, type ExistingVideoRecord } from './ConvexService';
import { MediaProxyService } from './MediaProxyService';
import { AppUpdateService } from './AppUpdateService';

interface CommandCheckResult {
  available: boolean;
  message: string;
}

export class BridgeController {
  private readonly windows = new Set<BrowserWindow>();
  private readonly store = new StoreService();
  private settings = this.store.loadSettings();
  private state: BridgeStateSnapshot = {
    ...initialBridgeState,
    system: { ...initialBridgeState.system },
    appUpdate: { ...initialBridgeState.appUpdate },
  };
  private readonly jobs = new Map<string, IngestJobSnapshot>();
  private readonly logs: LogEntry[] = [];
  private heartbeatTimer: NodeJS.Timeout | null = null;
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

  async initialize() {
    await this.refreshSystem();
    await this.appUpdateService.initialize(this.settings);
    this.startHeartbeatMonitor();

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
        posterUrl: (await this.mediaProxy.getProxyUrl(video.posterUrl)) ?? video.posterUrl,
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

    await this.enqueueSourceFile(job.sourcePath, true);
    return this.getState();
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
    return this.getState();
  }

  private async enqueueSourceFile(sourcePath: string, isRetry = false) {
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
      title: null,
      sourcePath,
      sourceName: path.basename(sourcePath),
      sourceSizeBytes: sourceStats.size,
      sourceFrameRate: null,
      sourceWidth: null,
      sourceHeight: null,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
      status: isRetry ? 'queued' : 'checking',
      stage: isRetry ? 'waiting' : 'file-ready',
      message: isRetry ? 'Retry queued.' : 'Source file is ready for ingest.',
      encodingProgress: 0,
      uploadProgress: 0,
      encoder: null,
      requestedDelivery: null,
      deliveryType: null,
      contentType: null,
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
      tags: [],
      playlistTitles: [],
      description: null,
      series: null,
      recordedAt: null,
      sidecarPath: null,
      errorMessage: null,
    };

    this.jobs.set(jobId, job);
    this.trimJobHistory();
    this.broadcastState();

    void this.processJob(jobId);
    return jobId;
  }

  private getDialogWindow() {
    return BrowserWindow.getFocusedWindow() ?? Array.from(this.windows)[0];
  }

  private async processJob(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    try {
      await this.validatePipelineConfiguration();

      const sourceMetadata = await loadSourceMetadata(job.sourcePath);
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
        tags: sourceMetadata.tags,
        playlistTitles: sourceMetadata.playlistTitles,
        description: sourceMetadata.description ?? null,
        series: sourceMetadata.series ?? null,
        recordedAt: sourceMetadata.recordedAt ?? null,
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
        await this.completeDuplicateJob(jobId, reusableVideo, sourceMetadata);
        return;
      }

      const jobFolderName = buildJobFolderName(job.sourcePath, job.id);
      const outputDirectory = path.join(this.settings.tempOutputPath, jobFolderName);
      const expectedSyncTargets = buildSyncTargets(
        this.settings,
        jobFolderName,
        job.sourceName,
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

      const syncTargets = buildSyncTargets(
        this.settings,
        jobFolderName,
        job.sourceName,
        transcodeResult,
      );

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
        jobFolderName,
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

      const readyPayload = this.buildConvexPayload(jobId, 'ready');
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
        message: this.settings.autoCleanupTempFiles
          ? `${contentType === 'clip' ? 'Clip' : 'Ingest'} complete. Cloud sync, Convex registration, and temp cleanup finished.`
          : `${contentType === 'clip' ? 'Clip' : 'Ingest'} complete. Archive, distribution, and Convex registration finished.`,
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
    sourceMetadata: Awaited<ReturnType<typeof loadSourceMetadata>>,
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
          tags,
          playlistTitles: sourceMetadata.playlistTitles,
          description,
          series,
          recordedAt,
          status: 'ready',
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
      message: 'Duplicate detected. Existing uploaded asset reused; no transcode or upload was required.',
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
      errorMessage: null,
    });

    this.showNotification(
      'Duplicate skipped',
      `${job.sourceName} already exists in the library. Existing upload reused.`,
    );
  }

  private buildConvexPayload(
    jobId: string,
    status: 'processing' | 'uploading' | 'ready' | 'error',
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
      tags: job.tags,
      playlistTitles: job.playlistTitles,
      description: job.description,
      series: job.series,
      recordedAt: job.recordedAt,
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

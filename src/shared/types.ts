export type HardwareEncoderOverride = 'auto' | 'nvenc' | 'videotoolbox' | 'software';

export type EffectiveHardwareEncoder = 'nvenc' | 'videotoolbox' | 'software';

export type RequestedDeliveryType = 'auto' | 'progressive' | 'hls';

export type DeliveryType = 'progressive' | 'hls';

export type ContentType = 'clip' | 'vod';

export type VideoSourceCodec = 'av1' | 'h264' | 'hevc';

export type ReviewStatus = 'needs_review' | 'approved' | 'archived';

export type SocialDeploymentStatus = 'none' | 'staged' | 'scheduled' | 'published' | 'failed';

export type ClipAspectRatio = '9:16' | '1:1' | '4:5' | '16:9';

export type SocialPlatform = 'TikTok' | 'Reels' | 'Shorts' | 'IGFeed' | 'Facebook' | 'YouTube';

export type SocialPostFormat = 'vertical' | 'feed' | 'video';

export type SocialPostMediaType = 'video' | 'image';

export type SocialPostStatus = 'draft' | 'scheduled' | 'posted';

export type YoutubeVisibility = 'public' | 'unlisted';

export type DesktopNodeStatus = 'online' | 'degraded' | 'offline';

export type DesktopNodeCapability =
  | 'watchfolder_ingest'
  | 'native_ffmpeg'
  | 'gpu_transcode'
  | 'cloud_sync'
  | 'local_offload'
  | 'poster_generation';

export type RenderExecutorType = 'desktop' | 'browser';

export type RenderJobStatus =
  | 'queued'
  | 'claimed'
  | 'rendering'
  | 'uploading'
  | 'ready'
  | 'failed'
  | 'canceled';

export type RenderStorageClass = 'streaming' | 'staging_social' | 'scheduled_social';

/** `canonical` writes the lifecycle-aware layout; `legacy` keeps pre-contract flat prefixes. */
export type StorageLayoutMode = 'canonical' | 'legacy';

export type SocialRenderStatus =
  | 'ready'
  | 'scheduled'
  | 'published'
  | 'expired'
  | 'deleted'
  | 'failed';

export type StorageProvider = 'b2' | 'r2';

export type StorageTaskOperation = 'copy' | 'delete';

export type StorageTaskStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'complete'
  | 'failed'
  | 'canceled';

export type StorageTaskReason =
  | 'promote_to_scheduled'
  | 'cleanup_after_publish'
  | 'cleanup_expired_staging'
  | 'delete_asset'
  | 'manual';

export type LiveStreamProvider = 'cloudflare_stream';

export type LiveStreamHandoffJobStatus =
  | 'pending'
  | 'claimed'
  | 'downloading'
  | 'processing'
  | 'uploading'
  | 'registering'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface LiveStreamHandoffJobSnapshot {
  _id: string;
  provider: LiveStreamProvider;
  providerVideoId: string;
  providerLiveInputId?: string;
  sourceDownloadUrl?: string;
  sourceObjectKey?: string;
  status: LiveStreamHandoffJobStatus;
  claimedByNodeKey?: string;
  leaseExpiresAt?: string;
  attempts: number;
  maxAttempts: number;
  projectName?: string;
  eventName?: string;
  recordedAt?: string;
  requestedDelivery?: Extract<RequestedDeliveryType, 'auto' | 'hls'>;
  archiveObjectKey?: string;
  distributionObjectKey?: string;
  playbackUrl?: string;
  manifestUrl?: string;
  dashManifestUrl?: string;
  posterUrl?: string;
  errorMessage?: string;
  progress?: number;
  stage?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface LiveStreamHandoffWorkerWakeResult {
  woke: boolean;
  claimedJobId: string | null;
  message?: string;
}

export interface StorageTaskSnapshot {
  _id: string;
  operation: StorageTaskOperation;
  reason: StorageTaskReason;
  provider: StorageProvider;
  sourceObjectKey?: string;
  destinationObjectKey?: string;
  destinationProvider?: StorageProvider;
  deleteSourceAfterCopy: boolean;
  socialRenderId?: string;
  renderJobId?: string;
  socialPostId?: string;
  videoId?: string;
  status: StorageTaskStatus;
  attempts: number;
  maxAttempts: number;
  claimedByNodeKey?: string;
  leaseExpiresAt?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export type ManualPipelineRoute = 'web_streaming' | 'clip_progressive' | 'review_draft';

export type StoredVideoStatus =
  | 'processing'
  | 'uploading'
  | 'draft'
  | 'ready'
  | 'error'
  | 'archived';

export type JobStatus =
  | 'queued'
  | 'checking'
  | 'encoding'
  | 'uploading'
  | 'registering'
  | 'complete'
  | 'error';

export type JobStage =
  | 'waiting'
  | 'file-ready'
  | 'fingerprinting'
  | 'checking-duplicate'
  | 'encoding'
  | 'uploading-archive'
  | 'uploading-distribution'
  | 'verifying'
  | 'cleaning'
  | 'registering'
  | 'complete'
  | 'error';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export type LogSource = 'system' | 'watcher' | 'transcode' | 'sync' | 'convex' | 'offload';

export type AppUpdateStatus =
  | 'unsupported'
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error';

export interface BackblazeB2Settings {
  bucket: string;
  pathPrefix: string;
  keyId: string;
  applicationKey: string;
  /**
   * B2's S3-compatible endpoint, e.g. `https://s3.us-west-004.backblazeb2.com`.
   * Needed only for presigned archive playback; rclone transfers use the
   * native B2 backend and ignore it. The region is derived from the hostname.
   */
  s3Endpoint: string;
}

export interface CloudflareR2Settings {
  accountId: string;
  bucket: string;
  pathPrefix: string;
  publicBaseUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ConvexSettings {
  deploymentUrl: string;
  mutationPath: string;
  /**
   * Provisioned credential identifying this workstation to the shared Convex
   * deployment. The ingest worker runs unattended, so it authenticates as a
   * machine rather than borrowing an operator's session — see
   * `convex/media/auth.ts` in the sports app.
   */
  nodeToken: string;
}

export type OffloadLocalCopyMode = 'fast' | 'safe';

export interface OffloadSettings {
  localFolder: string;
  b2PathPrefix: string;
  localCopyMode: OffloadLocalCopyMode;
}

export interface AppUpdateSettings {
  enabled: boolean;
  baseUrl: string;
  checkIntervalMinutes: number;
}

export interface BackendConnectionProfile {
  profileVersion: 1;
  profileName: string;
  storage?: Partial<StorageSettings>;
  b2?: Partial<Pick<BackblazeB2Settings, 'bucket' | 'pathPrefix' | 's3Endpoint'>>;
  r2?: Partial<Pick<CloudflareR2Settings, 'accountId' | 'bucket' | 'pathPrefix' | 'publicBaseUrl'>>;
  convex?: Partial<Pick<ConvexSettings, 'deploymentUrl' | 'mutationPath'>>;
  offload?: Partial<Pick<OffloadSettings, 'b2PathPrefix'>>;
  appUpdates?: Partial<AppUpdateSettings>;
  exportedAt?: string;
  notes?: string;
}

export interface ConnectionProfileImportResult extends SaveSettingsResult {
  canceled: boolean;
  profileName: string | null;
  path: string | null;
}

export interface ConnectionProfileExportResult {
  canceled: boolean;
  profileName: string | null;
  path: string | null;
}

export interface StoredVideoSource {
  codec: VideoSourceCodec;
  mimeType: string;
  url: string;
  objectKey: string;
}

export interface AppSettings {
  watchFolder: string;
  tempOutputPath: string;
  hardwareEncoderOverride: HardwareEncoderOverride;
  autoWatch: boolean;
  autoCleanupTempFiles: boolean;
  autoFallbackToSoftware: boolean;
  extractPosterFrame: boolean;
  verifyUploads: boolean;
  enableNotifications: boolean;
  uploadConcurrency: number;
  autoProgressiveMaxDurationSeconds: number;
  readyCheckIntervalMs: number;
  readyCheckStablePasses: number;
  storage: StorageSettings;
  b2: BackblazeB2Settings;
  r2: CloudflareR2Settings;
  convex: ConvexSettings;
  offload: OffloadSettings;
  appUpdates: AppUpdateSettings;
}

export interface StorageSettings {
  /**
   * Which key layout new ingests write. `canonical` follows the lifecycle-aware
   * contract in `docs/STORAGE_LAYOUT.md`; `legacy` keeps the flat
   * `{pathPrefix}/{jobFolderName}` scheme used before that contract existed.
   * Existing objects are never moved by this setting.
   */
  layout: StorageLayoutMode;
}

export interface DependencyStatus {
  ffmpegAvailable: boolean | null;
  ffprobeAvailable: boolean | null;
  rcloneAvailable: boolean | null;
  internetReachable: boolean | null;
  watcherHealthy: boolean | null;
  lastCheckedAt: string | null;
  lastHeartbeatAt: string | null;
  notes: string[];
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  jobId?: string;
}

export interface IngestJobSnapshot {
  id: string;
  intakeMode: 'watch' | 'manual';
  pipelineRoute: ManualPipelineRoute | null;
  title: string | null;
  sourcePath: string;
  sourceName: string;
  sourceSizeBytes: number | null;
  sourceFrameRate: number | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  sourceVideoCodec: string | null;
  sourceAudioCodec: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  status: JobStatus;
  stage: JobStage;
  message: string;
  encodingProgress: number;
  uploadProgress: number;
  encoder: EffectiveHardwareEncoder | null;
  requestedDelivery: RequestedDeliveryType | null;
  deliveryType: DeliveryType | null;
  contentType: ContentType | null;
  outputDirectory: string | null;
  masterPlaylistPath: string | null;
  manifestUrl: string | null;
  dashManifestUrl: string | null;
  posterPath: string | null;
  posterUrl: string | null;
  publicUrl: string | null;
  sources: StoredVideoSource[];
  archiveObjectKey: string | null;
  distributionObjectKey: string | null;
  sourceFingerprint: string | null;
  durationSeconds: number | null;
  tags: string[];
  playlistTitles: string[];
  description: string | null;
  series: string | null;
  recordedAt: string | null;
  projectName: string | null;
  eventName: string | null;
  cameraId: string | null;
  sourceNode: string | null;
  reviewStatus: ReviewStatus | null;
  socialStatus: SocialDeploymentStatus | null;
  scheduledPublishAt: string | null;
  sidecarPath: string | null;
  errorMessage: string | null;
}

export interface StoredVideoSnapshot {
  _id: string;
  title: string;
  sourceFileName: string;
  sourceFingerprint?: string;
  requestedDelivery?: RequestedDeliveryType;
  deliveryType?: DeliveryType;
  contentType?: ContentType;
  archiveObjectKey: string;
  distributionObjectKey: string;
  masterPlaylistUrl?: string;
  manifestUrl?: string;
  dashManifestUrl?: string;
  playbackUrl: string;
  posterUrl?: string;
  sources?: StoredVideoSource[];
  encoder: EffectiveHardwareEncoder;
  durationSeconds: number;
  sourceFileSizeBytes?: number;
  sourceFrameRate?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceVideoCodec?: string;
  sourceAudioCodec?: string;
  createdAt: string;
  updatedAt: string;
  status: StoredVideoStatus;
  tags: string[];
  playlistTitles?: string[];
  description?: string;
  series?: string;
  recordedAt?: string;
  projectName?: string;
  eventName?: string;
  cameraId?: string;
  sourceNode?: string;
  reviewStatus?: ReviewStatus;
  socialStatus?: SocialDeploymentStatus;
  scheduledPublishAt?: string;
  errorMessage?: string;
  sourceVideoId?: string;
  clipAspectRatio?: ClipAspectRatio;
  clipInSeconds?: number;
  clipOutSeconds?: number;
}

export interface ManualIntakeSourceSnapshot {
  sourcePath: string;
  sourceFileName: string;
  fileSizeBytes: number;
  modifiedAt: string;
}

export interface ManualIntakeRequest {
  sourcePath: string;
  route: ManualPipelineRoute;
  title?: string;
  description?: string;
  series?: string;
  recordedAt?: string;
  projectName?: string;
  eventName?: string;
  cameraId?: string;
  sourceNode?: string;
  tags?: string[];
  playlistTitles?: string[];
}

export interface BridgeStateSnapshot {
  isWatching: boolean;
  queueDepth: number;
  activeEncodingJobId: string | null;
  jobs: IngestJobSnapshot[];
  logs: LogEntry[];
  system: DependencyStatus;
  appUpdate: AppUpdateSnapshot;
}

export interface AppUpdateSnapshot {
  status: AppUpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  feedUrl: string | null;
  downloadUrl: string | null;
  lastCheckedAt: string | null;
  downloadedAt: string | null;
  message: string;
}

export interface DirectoryBrowseResult {
  canceled: boolean;
  path: string | null;
}

export interface LocalTrimSourceSnapshot {
  sourcePath: string;
  sourceFileName: string;
  sourceUrl: string;
  fileSizeBytes: number;
  modifiedAt: string;
}

export interface SaveSettingsResult {
  settings: AppSettings;
  state: BridgeStateSnapshot;
}

export interface RepairStoredVideoUrlsResult {
  inspected: number;
  updated: number;
  skipped: number;
}

export interface UploadAuditObjectSnapshot {
  objectKey: string;
  relativePath: string;
  sizeBytes: number | null;
}

export interface UploadAuditSectionSnapshot {
  label: string;
  storage: 'b2' | 'r2';
  bucket: string;
  remotePrefix: string;
  localPath: string | null;
  localExists: boolean;
  expectedObjects: UploadAuditObjectSnapshot[];
  remoteObjects: UploadAuditObjectSnapshot[];
  missingObjectKeys: string[];
  unexpectedObjectKeys: string[];
  sizeMismatchObjectKeys: string[];
}

export interface IngestUploadAuditSnapshot {
  jobId: string;
  sourceName: string;
  status: 'healthy' | 'partial' | 'missing' | 'unknown';
  message: string;
  auditedAt: string;
  canResumeSamePrefix: boolean;
  canCleanupRemote: boolean;
  archive: UploadAuditSectionSnapshot | null;
  distribution: UploadAuditSectionSnapshot | null;
}

export interface StoredVideoMetadataUpdateRequest {
  videoId: string;
  title?: string | null;
  status?: StoredVideoStatus;
  tags?: string[] | null;
  playlistTitles?: string[] | null;
  description?: string | null;
  series?: string | null;
  recordedAt?: string | null;
  projectName?: string | null;
  eventName?: string | null;
  cameraId?: string | null;
  sourceNode?: string | null;
  reviewStatus?: ReviewStatus | null;
  socialStatus?: SocialDeploymentStatus | null;
  scheduledPublishAt?: string | null;
  posterUrl?: string | null;
}

export interface DeleteStoredVideoRequest {
  videoId: string;
  title: string;
  sourceFileName: string;
  archiveObjectKey?: string | null;
  distributionObjectKey?: string | null;
}

export interface DeleteStoredVideoResult {
  videoId: string;
  title: string;
  deletedRecord: boolean;
  deletedArchive: boolean;
  deletedDistribution: boolean;
}

export interface GenerateStoredVideoPosterCandidatesRequest {
  sourceUrl: string;
  durationSeconds: number;
  sourceName: string;
}

export interface StoredVideoPosterCandidate {
  id: string;
  label: string;
  imageUrl: string;
  localPath: string;
  timestampSeconds: number;
}

export interface ApplyStoredVideoPosterRequest {
  videoId: string;
  distributionObjectKey: string;
  candidatePath: string;
}

export interface ArchivePreviewRequest {
  videoId: string;
  archiveObjectKey: string;
}

export interface ArchivePreviewResult {
  /** Time-limited, single-object URL. Null when archive access is unconfigured. */
  url: string | null;
  expiresInSeconds: number;
  unavailableReason: string | null;
}

export interface RetrieveArchivedMasterRequest {
  videoId: string;
  title: string;
  archiveObjectKey: string;
  sourceFileName: string;
}

export interface RetrieveArchivedMasterResult {
  canceled: boolean;
  /** Local path of the retrieved master, ready to open in the trimmer. */
  source: LocalTrimSourceSnapshot | null;
}

export interface TrimClipRequest {
  sourcePath: string;
  inPointSeconds: number;
  outPointSeconds: number;
}

export interface TrimClipResult {
  canceled: boolean;
  outputPath: string | null;
  durationSeconds: number | null;
  effectiveEncoder: EffectiveHardwareEncoder | null;
}

export interface SocialPostSnapshot {
  _id: string;
  videoId: string;
  platforms: SocialPlatform[];
  format: SocialPostFormat;
  mediaType?: SocialPostMediaType;
  scheduledDate: string;
  scheduledTime: string;
  status: SocialPostStatus;
  caption?: string;
  ytVisibility?: YoutubeVisibility;
  ytTitle?: string;
  ytDesc?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertSocialPostRequest {
  postId?: string;
  videoId: string;
  platforms: SocialPlatform[];
  format: SocialPostFormat;
  mediaType?: SocialPostMediaType;
  scheduledDate: string;
  scheduledTime: string;
  status: SocialPostStatus;
  caption?: string;
  ytVisibility?: YoutubeVisibility;
  ytTitle?: string;
  ytDesc?: string;
}

export interface MarkSocialPostStatusRequest {
  postId: string;
  status: SocialPostStatus;
}

export interface DesktopNodeHeartbeat {
  nodeKey: string;
  displayName: string;
  appVersion?: string;
  platform: string;
  arch: string;
  hostname?: string;
  status: DesktopNodeStatus;
  capabilities: DesktopNodeCapability[];
  watchFolder?: string;
  tempOutputPath?: string;
  queueDepth: number;
  activeEncodingJobId?: string;
  activeRenderJobId?: string;
  ffmpegAvailable?: boolean;
  ffprobeAvailable?: boolean;
  rcloneAvailable?: boolean;
  internetReachable?: boolean;
  watcherHealthy?: boolean;
  notes: string[];
}

export interface DesktopNodeSnapshot extends DesktopNodeHeartbeat {
  _id: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueRenderJobRequest {
  sourceVideoId: string;
  socialPostId?: string;
  requestedBy?: string;
  executorType?: RenderExecutorType;
  targetPlatforms: SocialPlatform[];
  aspectRatio: ClipAspectRatio;
  inPointSeconds?: number;
  outPointSeconds?: number;
  title?: string;
  caption?: string;
  priority?: number;
  storageClass?: RenderStorageClass;
  scheduledFor?: string;
  sourceObjectKey?: string;
  maxAttempts?: number;
}

export interface RenderJobSnapshot {
  _id: string;
  sourceVideoId: string;
  socialPostId?: string;
  requestedBy?: string;
  executorType: RenderExecutorType;
  targetPlatforms: SocialPlatform[];
  aspectRatio: ClipAspectRatio;
  inPointSeconds?: number;
  outPointSeconds?: number;
  title?: string;
  caption?: string;
  status: RenderJobStatus;
  priority: number;
  storageClass: RenderStorageClass;
  scheduledFor?: string;
  claimedByNodeKey?: string;
  leaseExpiresAt?: string;
  attempts: number;
  maxAttempts: number;
  progress: number;
  stage?: string;
  sourceObjectKey?: string;
  outputObjectKey?: string;
  outputUrl?: string;
  socialRenderId?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SocialRenderSnapshot {
  _id: string;
  sourceVideoId: string;
  renderJobId?: string;
  socialPostId?: string;
  targetPlatforms: SocialPlatform[];
  aspectRatio: ClipAspectRatio;
  durationSeconds?: number;
  storageClass: RenderStorageClass;
  objectKey: string;
  url: string;
  mimeType: string;
  status: SocialRenderStatus;
  createdByNodeKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopJobEventSnapshot {
  _id: string;
  nodeKey: string;
  renderJobId?: string;
  ingestJobId?: string;
  level: LogLevel;
  eventType: string;
  message: string;
  progress?: number;
  stage?: string;
  createdAt: string;
}

export type OffloadSourceKind = 'image' | 'video' | 'other';

export type OffloadTaskStatus =
  | 'preparing'
  | 'copying'
  | 'converting'
  | 'uploading'
  | 'paused'
  | 'canceled'
  | 'complete'
  | 'error';

export interface OffloadSourceSnapshot {
  sourcePath: string;
  sourceName: string;
  fileCount: number;
  totalBytes: number;
  imageCount: number;
  videoCount: number;
  otherCount: number;
}

export interface RunOffloadTaskRequest {
  sourcePath: string;
  jobName: string;
  convertImagesToWebp: boolean;
  uploadToB2: boolean;
}

export interface OffloadTaskSnapshot {
  id: string;
  status: OffloadTaskStatus;
  message: string;
  sourcePath: string;
  sourceName: string;
  jobName: string;
  localDestinationPath: string | null;
  webReadyPath: string | null;
  cloudObjectKey: string | null;
  manifestPath: string | null;
  logPath: string | null;
  copyProgress: number;
  conversionProgress: number;
  uploadProgress: number;
  overallProgress: number;
  totalFiles: number;
  imageCount: number;
  copiedFiles: number;
  totalBytes: number;
  copiedBytes: number;
  convertedImageCount: number;
  skippedFiles: number;
  uploadEnabled: boolean;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

/**
 * Free/total bytes for the volume holding the operator's working folder, plus
 * the label shown beside the figure in the sidebar footer.
 */
export interface StorageUsageSnapshot {
  label: string;
  path: string;
  usedBytes: number;
  totalBytes: number;
}

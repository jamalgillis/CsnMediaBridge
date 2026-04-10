export type HardwareEncoderOverride = 'auto' | 'nvenc' | 'videotoolbox' | 'software';

export type EffectiveHardwareEncoder = 'nvenc' | 'videotoolbox' | 'software';

export type RequestedDeliveryType = 'auto' | 'progressive' | 'hls';

export type DeliveryType = 'progressive' | 'hls';

export type ContentType = 'clip' | 'vod';

export type VideoSourceCodec = 'av1' | 'h264' | 'hevc';

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

export type LogSource = 'system' | 'watcher' | 'transcode' | 'sync' | 'convex';

export type AppUpdateStatus =
  | 'unsupported'
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error';

export interface BackblazeB2Settings {
  bucket: string;
  pathPrefix: string;
  keyId: string;
  applicationKey: string;
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
}

export interface AppUpdateSettings {
  enabled: boolean;
  baseUrl: string;
  checkIntervalMinutes: number;
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
  b2: BackblazeB2Settings;
  r2: CloudflareR2Settings;
  convex: ConvexSettings;
  appUpdates: AppUpdateSettings;
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
  title: string | null;
  sourcePath: string;
  sourceName: string;
  sourceSizeBytes: number | null;
  sourceFrameRate: number | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
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
  playbackUrl: string;
  posterUrl?: string;
  sources?: StoredVideoSource[];
  encoder: EffectiveHardwareEncoder;
  durationSeconds: number;
  sourceFileSizeBytes?: number;
  sourceFrameRate?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  createdAt: string;
  updatedAt: string;
  status: StoredVideoStatus;
  tags: string[];
  description?: string;
  series?: string;
  recordedAt?: string;
  errorMessage?: string;
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

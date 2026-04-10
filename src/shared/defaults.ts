import type { AppSettings, BridgeStateSnapshot } from './types';
import { AUTO_PROGRESSIVE_MAX_DURATION_SECONDS } from './media';

export const MAX_LOG_ENTRIES = 500;
export const MAX_JOB_HISTORY = 75;
const DEFAULT_APP_UPDATE_BASE_URL =
  typeof __APP_UPDATE_BASE_URL__ === 'string' ? __APP_UPDATE_BASE_URL__ : '';

export const defaultSettings: AppSettings = {
  watchFolder: '',
  tempOutputPath: '',
  hardwareEncoderOverride: 'auto',
  autoWatch: true,
  autoCleanupTempFiles: true,
  autoFallbackToSoftware: true,
  extractPosterFrame: true,
  verifyUploads: true,
  enableNotifications: true,
  uploadConcurrency: 10,
  autoProgressiveMaxDurationSeconds: AUTO_PROGRESSIVE_MAX_DURATION_SECONDS,
  readyCheckIntervalMs: 2000,
  readyCheckStablePasses: 3,
  b2: {
    bucket: '',
    pathPrefix: 'vod/archive',
    keyId: '',
    applicationKey: '',
  },
  r2: {
    accountId: '',
    bucket: '',
    pathPrefix: 'vod/hls',
    publicBaseUrl: '',
    accessKeyId: '',
    secretAccessKey: '',
  },
  convex: {
    deploymentUrl: '',
    mutationPath: 'videos:createVodEntry',
  },
  appUpdates: {
    enabled: Boolean(DEFAULT_APP_UPDATE_BASE_URL),
    baseUrl: DEFAULT_APP_UPDATE_BASE_URL,
    checkIntervalMinutes: 60,
  },
};

export const initialBridgeState: BridgeStateSnapshot = {
  isWatching: false,
  queueDepth: 0,
  activeEncodingJobId: null,
  jobs: [],
  logs: [],
  system: {
    ffmpegAvailable: null,
    ffprobeAvailable: null,
    rcloneAvailable: null,
    internetReachable: null,
    watcherHealthy: null,
    lastCheckedAt: null,
    lastHeartbeatAt: null,
    notes: [],
  },
  appUpdate: {
    status: 'idle',
    currentVersion: '0.0.0',
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    feedUrl: null,
    lastCheckedAt: null,
    downloadedAt: null,
    message: 'App update status is loading.',
  },
};

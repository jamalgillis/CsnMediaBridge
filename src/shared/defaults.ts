import type { AppSettings, BridgeStateSnapshot } from './types';
import { AUTO_PROGRESSIVE_MAX_DURATION_SECONDS } from './media';

export const MAX_LOG_ENTRIES = 500;
export const MAX_JOB_HISTORY = 75;
const DEFAULT_APP_UPDATE_BASE_URL =
  typeof __APP_UPDATE_BASE_URL__ === 'string' ? __APP_UPDATE_BASE_URL__ : '';
const DEFAULT_B2_BUCKET = typeof __CSN_B2_BUCKET__ === 'string' ? __CSN_B2_BUCKET__ : '';
const DEFAULT_B2_PATH_PREFIX =
  typeof __CSN_B2_PATH_PREFIX__ === 'string' ? __CSN_B2_PATH_PREFIX__ : 'vod/archive';
const DEFAULT_B2_S3_ENDPOINT =
  typeof __CSN_B2_S3_ENDPOINT__ === 'string' ? __CSN_B2_S3_ENDPOINT__ : '';
const DEFAULT_R2_ACCOUNT_ID =
  typeof __CSN_R2_ACCOUNT_ID__ === 'string' ? __CSN_R2_ACCOUNT_ID__ : '';
const DEFAULT_R2_BUCKET = typeof __CSN_R2_BUCKET__ === 'string' ? __CSN_R2_BUCKET__ : '';
const DEFAULT_R2_PATH_PREFIX =
  typeof __CSN_R2_PATH_PREFIX__ === 'string' ? __CSN_R2_PATH_PREFIX__ : 'vod/hls';
const DEFAULT_R2_PUBLIC_BASE_URL =
  typeof __CSN_R2_PUBLIC_BASE_URL__ === 'string' ? __CSN_R2_PUBLIC_BASE_URL__ : '';
const DEFAULT_CONVEX_DEPLOYMENT_URL =
  typeof __CSN_CONVEX_DEPLOYMENT_URL__ === 'string' ? __CSN_CONVEX_DEPLOYMENT_URL__ : '';
const DEFAULT_CONVEX_MUTATION_PATH =
  typeof __CSN_CONVEX_MUTATION_PATH__ === 'string'
    ? __CSN_CONVEX_MUTATION_PATH__
    : 'media/videos:createVodEntry';
const DEFAULT_OFFLOAD_B2_PATH_PREFIX =
  typeof __CSN_OFFLOAD_B2_PATH_PREFIX__ === 'string'
    ? __CSN_OFFLOAD_B2_PATH_PREFIX__
    : 'offloads';

const DEFAULT_AUTH_ISSUER =
  typeof __CLERK_OAUTH_ISSUER__ === 'string' ? __CLERK_OAUTH_ISSUER__ : '';
const DEFAULT_AUTH_CLIENT_ID =
  typeof __CLERK_OAUTH_CLIENT_ID__ === 'string' ? __CLERK_OAUTH_CLIENT_ID__ : '';

const DEFAULT_BROKER_URL =
  typeof __CSN_BROKER_URL__ === 'string' ? __CSN_BROKER_URL__ : '';

export const defaultSettings: AppSettings = {
  liveRecordings: {
    autoConvert: false,
  },
  watchFolder: '',
  tempOutputPath: '',
  hardwareEncoderOverride: 'auto',
  autoWatch: true,
  autoCleanupTempFiles: true,
  autoFallbackToSoftware: true,
  extractPosterFrame: true,
  generateScrubThumbnails: true,
  verifyUploads: true,
  enableNotifications: true,
  uploadConcurrency: 10,
  autoProgressiveMaxDurationSeconds: AUTO_PROGRESSIVE_MAX_DURATION_SECONDS,
  readyCheckIntervalMs: 2000,
  readyCheckStablePasses: 3,
  storage: {
    layout: 'canonical',
  },
  b2: {
    bucket: DEFAULT_B2_BUCKET,
    pathPrefix: DEFAULT_B2_PATH_PREFIX,
    keyId: '',
    applicationKey: '',
    s3Endpoint: DEFAULT_B2_S3_ENDPOINT,
  },
  r2: {
    accountId: DEFAULT_R2_ACCOUNT_ID,
    bucket: DEFAULT_R2_BUCKET,
    pathPrefix: DEFAULT_R2_PATH_PREFIX,
    publicBaseUrl: DEFAULT_R2_PUBLIC_BASE_URL,
    accessKeyId: '',
    secretAccessKey: '',
  },
  convex: {
    deploymentUrl: DEFAULT_CONVEX_DEPLOYMENT_URL,
    mutationPath: DEFAULT_CONVEX_MUTATION_PATH,
    nodeToken: '',
  },
  offload: {
    localFolder: '',
    b2PathPrefix: DEFAULT_OFFLOAD_B2_PATH_PREFIX,
    localCopyMode: 'fast',
    convertImagesToWebp: true,
    uploadImagesToCloud: false,
  },
  auth: {
    issuer: DEFAULT_AUTH_ISSUER,
    clientId: DEFAULT_AUTH_CLIENT_ID,
  },
  broker: {
    url: DEFAULT_BROKER_URL,
    token: '',
    streamMedia: false,
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
    downloadUrl: null,
    lastCheckedAt: null,
    downloadedAt: null,
    message: 'App update status is loading.',
  },
};

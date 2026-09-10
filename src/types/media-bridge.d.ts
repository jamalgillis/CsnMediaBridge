import type {
  ApplyStoredVideoPosterRequest,
  ArchivePreviewRequest,
  ArchivePreviewResult,
  RetrieveArchivedMasterRequest,
  RetrieveArchivedMasterResult,
  AppSettings,
  BridgeStateSnapshot,
  ConnectionProfileExportResult,
  ConnectionProfileImportResult,
  DeleteStoredVideoRequest,
  DeleteStoredVideoResult,
  DirectoryBrowseResult,
  GenerateStoredVideoPosterCandidatesRequest,
  IngestUploadAuditSnapshot,
  LocalTrimSourceSnapshot,
  LiveStreamHandoffJobSnapshot,
  LiveStreamHandoffWorkerWakeResult,
  ManualIntakeRequest,
  ManualIntakeSourceSnapshot,
  OffloadSourceSnapshot,
  OffloadTaskSnapshot,
  RepairStoredVideoUrlsResult,
  RunOffloadTaskRequest,
  SaveSettingsResult,
  StorageUsageSnapshot,
  StoredVideoMetadataUpdateRequest,
  StoredVideoPosterCandidate,
  StoredVideoSnapshot,
  TrimClipRequest,
  TrimClipResult,
} from '../shared/types';

export interface MediaBridgeApi {
  getState: () => Promise<BridgeStateSnapshot>;
  loadSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<SaveSettingsResult>;
  importConnectionProfile: () => Promise<ConnectionProfileImportResult>;
  exportConnectionProfile: (profileName?: string) => Promise<ConnectionProfileExportResult>;
  checkForAppUpdates: () => Promise<BridgeStateSnapshot>;
  installAppUpdate: () => Promise<void>;
  startWatching: () => Promise<BridgeStateSnapshot>;
  stopWatching: () => Promise<BridgeStateSnapshot>;
  browseDirectory: () => Promise<DirectoryBrowseResult>;
  chooseManualIntakeSource: () => Promise<ManualIntakeSourceSnapshot | null>;
  enqueueManualIntake: (request: ManualIntakeRequest) => Promise<BridgeStateSnapshot>;
  retryJob: (jobId: string) => Promise<BridgeStateSnapshot>;
  auditJobUploads: (jobId: string) => Promise<IngestUploadAuditSnapshot>;
  resumeJobUploads: (jobId: string) => Promise<BridgeStateSnapshot>;
  cleanupJobUploads: (jobId: string) => Promise<IngestUploadAuditSnapshot>;
  refreshSystem: () => Promise<BridgeStateSnapshot>;
  listStoredVideos: () => Promise<StoredVideoSnapshot[]>;
  updateStoredVideoMetadata: (request: StoredVideoMetadataUpdateRequest) => Promise<void>;
  deleteStoredVideo: (request: DeleteStoredVideoRequest) => Promise<DeleteStoredVideoResult>;
  repairStoredVideoUrls: () => Promise<RepairStoredVideoUrlsResult>;
  generateStoredVideoPosterCandidates: (
    request: GenerateStoredVideoPosterCandidatesRequest,
  ) => Promise<StoredVideoPosterCandidate[]>;
  applyStoredVideoPoster: (request: ApplyStoredVideoPosterRequest) => Promise<string>;
  chooseTrimSource: () => Promise<LocalTrimSourceSnapshot | null>;
  getArchivePreviewUrl: (request: ArchivePreviewRequest) => Promise<ArchivePreviewResult>;
  retrieveArchivedMaster: (
    request: RetrieveArchivedMasterRequest,
  ) => Promise<RetrieveArchivedMasterResult>;
  trimClip: (request: TrimClipRequest) => Promise<TrimClipResult>;
  listClipsForVideo: (sourceVideoId: string) => Promise<StoredVideoSnapshot[]>;
  chooseOffloadSource: () => Promise<OffloadSourceSnapshot | null>;
  getOffloadTask: () => Promise<OffloadTaskSnapshot | null>;
  runOffloadTask: (request: RunOffloadTaskRequest) => Promise<OffloadTaskSnapshot>;
  pauseOffloadTask: () => Promise<OffloadTaskSnapshot | null>;
  cancelOffloadTask: () => Promise<OffloadTaskSnapshot | null>;
  getStorageUsage: () => Promise<StorageUsageSnapshot | null>;
  listLiveStreamHandoffJobs: () => Promise<LiveStreamHandoffJobSnapshot[]>;
  wakeLiveStreamHandoffWorker: () => Promise<LiveStreamHandoffWorkerWakeResult>;
  onStateUpdate: (listener: (state: BridgeStateSnapshot) => void) => () => void;
  onOffloadUpdate: (listener: (task: OffloadTaskSnapshot) => void) => () => void;
  onLiveStreamHandoffUpdate: (
    listener: (jobs: LiveStreamHandoffJobSnapshot[]) => void,
  ) => () => void;
}

declare global {
  interface Window {
    mediaBridge: MediaBridgeApi;
  }
}

export {};

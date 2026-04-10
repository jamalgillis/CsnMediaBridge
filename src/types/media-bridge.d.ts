import type {
  AppSettings,
  BridgeStateSnapshot,
  DirectoryBrowseResult,
  LocalTrimSourceSnapshot,
  RepairStoredVideoUrlsResult,
  SaveSettingsResult,
  StoredVideoSnapshot,
  TrimClipRequest,
  TrimClipResult,
} from '../shared/types';

export interface MediaBridgeApi {
  getState: () => Promise<BridgeStateSnapshot>;
  loadSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<SaveSettingsResult>;
  checkForAppUpdates: () => Promise<BridgeStateSnapshot>;
  installAppUpdate: () => Promise<void>;
  startWatching: () => Promise<BridgeStateSnapshot>;
  stopWatching: () => Promise<BridgeStateSnapshot>;
  browseDirectory: () => Promise<DirectoryBrowseResult>;
  retryJob: (jobId: string) => Promise<BridgeStateSnapshot>;
  refreshSystem: () => Promise<BridgeStateSnapshot>;
  listStoredVideos: () => Promise<StoredVideoSnapshot[]>;
  repairStoredVideoUrls: () => Promise<RepairStoredVideoUrlsResult>;
  chooseTrimSource: () => Promise<LocalTrimSourceSnapshot | null>;
  trimClip: (request: TrimClipRequest) => Promise<TrimClipResult>;
  onStateUpdate: (listener: (state: BridgeStateSnapshot) => void) => () => void;
}

declare global {
  interface Window {
    mediaBridge: MediaBridgeApi;
  }
}

export {};

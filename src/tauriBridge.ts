import type { MediaBridgeApi } from './types/media-bridge';
import { IPC_CHANNELS } from './shared/ipc';

type TauriUnlisten = () => void;

interface TauriEvent<T> {
  payload: T;
}

interface TauriGlobalApi {
  core?: {
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  };
  event?: {
    listen: <T>(
      eventName: string,
      listener: (event: TauriEvent<T>) => void,
    ) => Promise<TauriUnlisten>;
  };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobalApi;
  }
}

function getTauriInvoke() {
  return window.__TAURI__?.core?.invoke;
}

function invoke<T>(command: string, args?: Record<string, unknown>) {
  const tauriInvoke = getTauriInvoke();

  if (!tauriInvoke) {
    return Promise.reject(new Error('Tauri runtime is not available.'));
  }

  return tauriInvoke<T>(command, args);
}

function listen<T>(eventName: string, listener: (payload: T) => void): () => void {
  const tauriListen = window.__TAURI__?.event?.listen;
  let unlisten: TauriUnlisten | null = null;
  let disposed = false;

  if (!tauriListen) {
    return function unsubscribeUnavailableListener(): void {
      void eventName;
    };
  }

  void tauriListen<T>(eventName, (event) => {
    listener(event.payload);
  }).then((nextUnlisten) => {
    if (disposed) {
      nextUnlisten();
      return;
    }

    unlisten = nextUnlisten;
  });

  return () => {
    disposed = true;
    unlisten?.();
  };
}

function installTauriMediaBridge() {
  if (window.mediaBridge || !getTauriInvoke()) {
    return;
  }

  const mediaBridgeApi: MediaBridgeApi = {
    getState: () => invoke('get_state'),
    loadSettings: () => invoke('load_settings'),
    saveSettings: (settings) => invoke('save_settings', { settings }),
    importConnectionProfile: () => invoke('import_connection_profile'),
    exportConnectionProfile: (profileName) =>
      invoke('export_connection_profile', { profileName }),
    checkForAppUpdates: () => invoke('check_for_app_updates'),
    installAppUpdate: () => invoke('install_app_update'),
    startWatching: () => invoke('start_watching'),
    stopWatching: () => invoke('stop_watching'),
    browseDirectory: () => invoke('browse_directory'),
    chooseManualIntakeSource: () => invoke('choose_manual_intake_source'),
    enqueueManualIntake: (request) => invoke('enqueue_manual_intake', { request }),
    retryJob: (jobId) => invoke('retry_job', { jobId }),
    auditJobUploads: (jobId) => invoke('audit_job_uploads', { jobId }),
    resumeJobUploads: (jobId) => invoke('resume_job_uploads', { jobId }),
    cleanupJobUploads: (jobId) => invoke('cleanup_job_uploads', { jobId }),
    refreshSystem: () => invoke('refresh_system'),
    listStoredVideos: () => invoke('list_stored_videos'),
    updateStoredVideoMetadata: (request) =>
      invoke('update_stored_video_metadata', { request }),
    deleteStoredVideo: (request) => invoke('delete_stored_video', { request }),
    repairStoredVideoUrls: () => invoke('repair_stored_video_urls'),
    generateStoredVideoPosterCandidates: (request) =>
      invoke('generate_stored_video_poster_candidates', { request }),
    applyStoredVideoPoster: (request) => invoke('apply_stored_video_poster', { request }),
    getArchivePreviewUrl: (request) => invoke('get_archive_preview_url', { request }),
    retrieveArchivedMaster: (request) => invoke('retrieve_archived_master', { request }),
    chooseTrimSource: () => invoke('choose_trim_source'),
    trimClip: (request) => invoke('trim_clip', { request }),
    listClipsForVideo: (sourceVideoId) =>
      invoke('list_clips_for_video', { sourceVideoId }),
    chooseOffloadSource: () => invoke('choose_offload_source'),
    getOffloadTask: () => invoke('get_offload_task'),
    runOffloadTask: (request) => invoke('run_offload_task', { request }),
    pauseOffloadTask: () => invoke('pause_offload_task'),
    cancelOffloadTask: () => invoke('cancel_offload_task'),
    getStorageUsage: () => invoke('get_storage_usage'),
    listLiveStreamHandoffJobs: () => invoke('list_live_stream_handoff_jobs'),
    wakeLiveStreamHandoffWorker: () => invoke('wake_live_stream_handoff_worker'),
    onStateUpdate: (listener) => listen(IPC_CHANNELS.stateUpdated, listener),
    onOffloadUpdate: (listener) => listen(IPC_CHANNELS.offloadUpdated, listener),
    onLiveStreamHandoffUpdate: (listener) =>
      listen(IPC_CHANNELS.liveStreamHandoffUpdated, listener),
  };

  window.mediaBridge = mediaBridgeApi;
}

installTauriMediaBridge();

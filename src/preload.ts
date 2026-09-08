import { contextBridge, ipcRenderer } from 'electron';
import type { MediaBridgeApi } from './types/media-bridge';
import { IPC_CHANNELS } from './shared/ipc';

const mediaBridgeApi: MediaBridgeApi = {
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.getState),
  loadSettings: () => ipcRenderer.invoke(IPC_CHANNELS.loadSettings),
  saveSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.saveSettings, settings),
  checkForAppUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.checkForAppUpdates),
  installAppUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.installAppUpdate),
  startWatching: () => ipcRenderer.invoke(IPC_CHANNELS.startWatching),
  stopWatching: () => ipcRenderer.invoke(IPC_CHANNELS.stopWatching),
  browseDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.browseDirectory),
  chooseManualIntakeSource: () => ipcRenderer.invoke(IPC_CHANNELS.chooseManualIntakeSource),
  enqueueManualIntake: (request) => ipcRenderer.invoke(IPC_CHANNELS.enqueueManualIntake, request),
  retryJob: (jobId) => ipcRenderer.invoke(IPC_CHANNELS.retryJob, jobId),
  auditJobUploads: (jobId) => ipcRenderer.invoke(IPC_CHANNELS.auditJobUploads, jobId),
  resumeJobUploads: (jobId) => ipcRenderer.invoke(IPC_CHANNELS.resumeJobUploads, jobId),
  cleanupJobUploads: (jobId) => ipcRenderer.invoke(IPC_CHANNELS.cleanupJobUploads, jobId),
  refreshSystem: () => ipcRenderer.invoke(IPC_CHANNELS.refreshSystem),
  listStoredVideos: () => ipcRenderer.invoke(IPC_CHANNELS.listStoredVideos),
  updateStoredVideoMetadata: (request) => ipcRenderer.invoke(IPC_CHANNELS.updateStoredVideoMetadata, request),
  deleteStoredVideo: (request) => ipcRenderer.invoke(IPC_CHANNELS.deleteStoredVideo, request),
  repairStoredVideoUrls: () => ipcRenderer.invoke(IPC_CHANNELS.repairStoredVideoUrls),
  generateStoredVideoPosterCandidates: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.generateStoredVideoPosterCandidates, request),
  applyStoredVideoPoster: (request) => ipcRenderer.invoke(IPC_CHANNELS.applyStoredVideoPoster, request),
  getArchivePreviewUrl: (request) => ipcRenderer.invoke(IPC_CHANNELS.getArchivePreviewUrl, request),
  retrieveArchivedMaster: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.retrieveArchivedMaster, request),
  chooseTrimSource: () => ipcRenderer.invoke(IPC_CHANNELS.chooseTrimSource),
  trimClip: (request) => ipcRenderer.invoke(IPC_CHANNELS.trimClip, request),
  listClipsForVideo: (sourceVideoId) => ipcRenderer.invoke(IPC_CHANNELS.listClipsForVideo, sourceVideoId),
  chooseOffloadSource: () => ipcRenderer.invoke(IPC_CHANNELS.chooseOffloadSource),
  getOffloadTask: () => ipcRenderer.invoke(IPC_CHANNELS.getOffloadTask),
  runOffloadTask: (request) => ipcRenderer.invoke(IPC_CHANNELS.runOffloadTask, request),
  pauseOffloadTask: () => ipcRenderer.invoke(IPC_CHANNELS.pauseOffloadTask),
  cancelOffloadTask: () => ipcRenderer.invoke(IPC_CHANNELS.cancelOffloadTask),
  getStorageUsage: () => ipcRenderer.invoke(IPC_CHANNELS.getStorageUsage),
  onStateUpdate: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: Awaited<ReturnType<MediaBridgeApi['getState']>>) => {
      listener(state);
    };

    ipcRenderer.on(IPC_CHANNELS.stateUpdated, wrappedListener);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.stateUpdated, wrappedListener);
    };
  },
  onOffloadUpdate: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      task: Awaited<ReturnType<MediaBridgeApi['runOffloadTask']>>,
    ) => {
      listener(task);
    };

    ipcRenderer.on(IPC_CHANNELS.offloadUpdated, wrappedListener);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.offloadUpdated, wrappedListener);
    };
  },
};

contextBridge.exposeInMainWorld('mediaBridge', mediaBridgeApi);

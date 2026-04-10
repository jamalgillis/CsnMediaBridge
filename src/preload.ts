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
  retryJob: (jobId) => ipcRenderer.invoke(IPC_CHANNELS.retryJob, jobId),
  refreshSystem: () => ipcRenderer.invoke(IPC_CHANNELS.refreshSystem),
  listStoredVideos: () => ipcRenderer.invoke(IPC_CHANNELS.listStoredVideos),
  repairStoredVideoUrls: () => ipcRenderer.invoke(IPC_CHANNELS.repairStoredVideoUrls),
  chooseTrimSource: () => ipcRenderer.invoke(IPC_CHANNELS.chooseTrimSource),
  trimClip: (request) => ipcRenderer.invoke(IPC_CHANNELS.trimClip, request),
  onStateUpdate: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: Awaited<ReturnType<MediaBridgeApi['getState']>>) => {
      listener(state);
    };

    ipcRenderer.on(IPC_CHANNELS.stateUpdated, wrappedListener);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.stateUpdated, wrappedListener);
    };
  },
};

contextBridge.exposeInMainWorld('mediaBridge', mediaBridgeApi);

import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { BridgeController } from './main/services/BridgeController';
import { IPC_CHANNELS } from './shared/ipc';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let bridgeController: BridgeController | null = null;

if (process.platform === 'win32') {
  app.setAppUserModelId('com.squirrel.csnmediabridge.CSNMediaBridge');
}

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#09111d',
    title: 'CSN Media Bridge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  bridgeController?.registerWindow(mainWindow);
};

function registerIpcHandlers(controller: BridgeController) {
  ipcMain.handle(IPC_CHANNELS.getState, async () => controller.getState());
  ipcMain.handle(IPC_CHANNELS.loadSettings, async () => controller.loadSettings());
  ipcMain.handle(IPC_CHANNELS.saveSettings, async (_event, settings) => controller.saveSettings(settings));
  ipcMain.handle(IPC_CHANNELS.checkForAppUpdates, async () => controller.checkForAppUpdates());
  ipcMain.handle(IPC_CHANNELS.installAppUpdate, async () => controller.installAppUpdate());
  ipcMain.handle(IPC_CHANNELS.startWatching, async () => controller.startWatching());
  ipcMain.handle(IPC_CHANNELS.stopWatching, async () => controller.stopWatching());
  ipcMain.handle(IPC_CHANNELS.browseDirectory, async () => controller.browseDirectory());
  ipcMain.handle(IPC_CHANNELS.retryJob, async (_event, jobId: string) => controller.retryJob(jobId));
  ipcMain.handle(IPC_CHANNELS.refreshSystem, async () => controller.refreshSystem());
  ipcMain.handle(IPC_CHANNELS.listStoredVideos, async () => controller.listStoredVideos());
  ipcMain.handle(IPC_CHANNELS.repairStoredVideoUrls, async () => controller.repairStoredVideoUrls());
  ipcMain.handle(IPC_CHANNELS.chooseTrimSource, async () => controller.chooseTrimSource());
  ipcMain.handle(IPC_CHANNELS.trimClip, async (_event, request) => controller.trimClip(request));
}

app.on('ready', async () => {
  nativeTheme.themeSource = 'dark';
  bridgeController = new BridgeController();
  registerIpcHandlers(bridgeController);
  await bridgeController.initialize();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

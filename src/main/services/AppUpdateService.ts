import { app, autoUpdater } from 'electron';
import type { AppSettings, AppUpdateSnapshot, LogLevel } from '../../shared/types';
import { nowIso } from '../lib/helpers';

interface AppUpdateServiceOptions {
  log: (level: LogLevel, message: string) => void;
  onStateChange: (snapshot: AppUpdateSnapshot) => void;
  notify: (title: string, body: string) => void;
}

const MIN_CHECK_INTERVAL_MINUTES = 15;

function trimTrailingSlash(value: string) {
  return value.trim().replace(/\/+$/g, '');
}

export class AppUpdateService {
  private readonly log;
  private readonly onStateChange;
  private readonly notify;
  private snapshot: AppUpdateSnapshot = {
    status: 'idle',
    currentVersion: app.getVersion(),
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    feedUrl: null,
    lastCheckedAt: null,
    downloadedAt: null,
    message: 'App update status is loading.',
  };
  private initialCheckTimer: NodeJS.Timeout | null = null;
  private recurringCheckTimer: NodeJS.Timeout | null = null;
  private listenersAttached = false;
  private settings: AppSettings['appUpdates'] | null = null;

  constructor({ log, onStateChange, notify }: AppUpdateServiceOptions) {
    this.log = log;
    this.onStateChange = onStateChange;
    this.notify = notify;
  }

  async initialize(settings: AppSettings) {
    this.attachListeners();
    this.applySettings(settings);
  }

  getState() {
    return this.snapshot;
  }

  applySettings(settings: AppSettings) {
    this.settings = settings.appUpdates;
    this.clearTimers();

    if (!app.isPackaged) {
      return this.setSnapshot({
        status: 'unsupported',
        currentVersion: app.getVersion(),
        availableVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseDate: null,
        feedUrl: null,
        downloadedAt: null,
        message: 'App updates are available only in packaged builds.',
      });
    }

    if (!['darwin', 'win32'].includes(process.platform)) {
      return this.setSnapshot({
        status: 'unsupported',
        currentVersion: app.getVersion(),
        availableVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseDate: null,
        feedUrl: null,
        downloadedAt: null,
        message: 'Auto-updates are supported only on macOS and Windows.',
      });
    }

    if (!settings.appUpdates.enabled || !settings.appUpdates.baseUrl.trim()) {
      return this.setSnapshot({
        status: 'disabled',
        currentVersion: app.getVersion(),
        availableVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseDate: null,
        feedUrl: null,
        downloadedAt: null,
        message: 'App updates are disabled until an update feed URL is configured.',
      });
    }

    const feedUrl = this.configureFeed();

    this.setSnapshot({
      status: 'idle',
      currentVersion: app.getVersion(),
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseDate: null,
      feedUrl,
      downloadedAt: null,
      message: 'App updates are ready to check.',
    });

    this.scheduleChecks();
    return this.snapshot;
  }

  async checkForUpdates(manual = false) {
    if (this.snapshot.status === 'unsupported' || this.snapshot.status === 'disabled') {
      return this.snapshot;
    }

    if (this.snapshot.status === 'checking' || this.snapshot.status === 'downloading') {
      return this.snapshot;
    }

    if (this.snapshot.status === 'downloaded') {
      return this.snapshot;
    }

    try {
      const feedUrl = this.configureFeed();
      this.setSnapshot({
        status: 'checking',
        feedUrl,
        lastCheckedAt: nowIso(),
        message: manual ? 'Checking for app updates now.' : 'Checking for app updates.',
      });
      autoUpdater.checkForUpdates();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log('error', `App update check failed: ${message}`);
      this.setSnapshot({
        status: 'error',
        lastCheckedAt: nowIso(),
        message: `App update check failed: ${message}`,
      });
    }

    return this.snapshot;
  }

  installUpdate() {
    if (this.snapshot.status !== 'downloaded') {
      throw new Error('No downloaded app update is ready to install yet.');
    }

    this.log('info', 'Installing downloaded app update.');
    autoUpdater.quitAndInstall();
  }

  private attachListeners() {
    if (this.listenersAttached) {
      return;
    }

    autoUpdater.on('checking-for-update', () => {
      this.setSnapshot({
        status: 'checking',
        lastCheckedAt: nowIso(),
        message: 'Checking for app updates.',
      });
    });

    autoUpdater.on('update-available', () => {
      this.log('info', 'App update found. Downloading in the background.');
      this.setSnapshot({
        status: 'downloading',
        message: 'A new app update is available and is downloading now.',
      });
      this.notify('App update found', 'Downloading the latest CSN Media Bridge release now.');
    });

    autoUpdater.on('update-not-available', () => {
      this.setSnapshot({
        status: 'up-to-date',
        availableVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseDate: null,
        downloadedAt: null,
        message: 'This app is already on the latest available version.',
      });
    });

    autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName, releaseDate, updateURL) => {
      const releaseVersion = releaseName?.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? null;
      this.log('info', `App update downloaded${releaseName ? `: ${releaseName}` : '.'}`);
      this.setSnapshot({
        status: 'downloaded',
        availableVersion: releaseVersion,
        releaseName: releaseName || null,
        releaseNotes: releaseNotes || null,
        releaseDate: releaseDate ? new Date(releaseDate).toISOString() : null,
        downloadedAt: nowIso(),
        feedUrl: updateURL || this.snapshot.feedUrl,
        message: 'A new app update has been downloaded and is ready to install.',
      });
      this.notify('Update ready', 'A new CSN Media Bridge build is ready. Install it from the app.');
    });

    autoUpdater.on('error', (error) => {
      const message = error.message.trim();
      this.log('error', `App updater error: ${message}`);
      this.setSnapshot({
        status: 'error',
        lastCheckedAt: nowIso(),
        message: `App updater error: ${message}`,
      });
    });

    this.listenersAttached = true;
  }

  private configureFeed() {
    const baseUrl = trimTrailingSlash(this.settings?.baseUrl ?? '');

    if (!baseUrl) {
      throw new Error('App update feed URL is not configured.');
    }

    const platformBaseUrl = `${baseUrl}/${process.platform}/${process.arch}`;
    if (process.platform === 'darwin') {
      const feedUrl = `${platformBaseUrl}/RELEASES.json`;
      autoUpdater.setFeedURL({ url: feedUrl, serverType: 'json' });
      return feedUrl;
    }

    autoUpdater.setFeedURL({ url: platformBaseUrl });
    return platformBaseUrl;
  }

  private scheduleChecks() {
    if (!this.settings?.enabled || !this.settings.baseUrl.trim()) {
      return;
    }

    const intervalMinutes = Math.max(
      MIN_CHECK_INTERVAL_MINUTES,
      this.settings.checkIntervalMinutes || MIN_CHECK_INTERVAL_MINUTES,
    );
    const initialDelayMs =
      process.platform === 'win32' && process.argv.includes('--squirrel-firstrun')
        ? 10_000
        : 5_000;

    this.initialCheckTimer = setTimeout(() => {
      void this.checkForUpdates();
    }, initialDelayMs);

    this.recurringCheckTimer = setInterval(() => {
      void this.checkForUpdates();
    }, intervalMinutes * 60_000);
  }

  private clearTimers() {
    if (this.initialCheckTimer) {
      clearTimeout(this.initialCheckTimer);
      this.initialCheckTimer = null;
    }

    if (this.recurringCheckTimer) {
      clearInterval(this.recurringCheckTimer);
      this.recurringCheckTimer = null;
    }
  }

  private setSnapshot(patch: Partial<AppUpdateSnapshot>) {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      currentVersion: app.getVersion(),
    };
    this.onStateChange(this.snapshot);
    return this.snapshot;
  }
}

import { app, autoUpdater, shell } from 'electron';
import type { AppSettings, AppUpdateSnapshot, LogLevel } from '../../shared/types';
import { nowIso } from '../lib/helpers';

interface AppUpdateServiceOptions {
  log: (level: LogLevel, message: string) => void;
  onStateChange: (snapshot: AppUpdateSnapshot) => void;
  notify: (title: string, body: string) => void;
}

interface MacReleaseManifest {
  currentRelease?: string;
  releases?: Array<{
    version?: string;
    updateTo?: {
      name?: string;
      version?: string;
      pub_date?: string;
      url?: string;
      notes?: string;
    };
  }>;
}

const MIN_CHECK_INTERVAL_MINUTES = 15;

function trimTrailingSlash(value: string) {
  return value.trim().replace(/\/+$/g, '');
}

function normalizeVersion(value: string) {
  return value.trim().replace(/^v/i, '');
}

function compareVersions(left: string, right: string) {
  const leftParts = normalizeVersion(left).split(/[.-]/g);
  const rightParts = normalizeVersion(right).split(/[.-]/g);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? '0';
    const rightPart = rightParts[index] ?? '0';
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    const bothNumeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);

    if (bothNumeric) {
      if (leftNumber > rightNumber) {
        return 1;
      }
      if (leftNumber < rightNumber) {
        return -1;
      }
      continue;
    }

    const comparison = leftPart.localeCompare(rightPart, undefined, { numeric: true });
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

function isNativeUpdatePlatform() {
  return process.platform === 'win32';
}

function isManualDownloadPlatform() {
  return process.platform === 'darwin';
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
    downloadUrl: null,
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
        availableVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseDate: null,
        feedUrl: null,
        downloadUrl: null,
        downloadedAt: null,
        message: 'App updates are available only in packaged builds.',
      });
    }

    if (!isNativeUpdatePlatform() && !isManualDownloadPlatform()) {
      return this.setSnapshot({
        status: 'unsupported',
        availableVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseDate: null,
        feedUrl: null,
        downloadUrl: null,
        downloadedAt: null,
        message: 'App updates are currently supported only on Windows and macOS.',
      });
    }

    if (!settings.appUpdates.enabled || !settings.appUpdates.baseUrl.trim()) {
      return this.setSnapshot({
        status: 'disabled',
        availableVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseDate: null,
        feedUrl: null,
        downloadUrl: null,
        downloadedAt: null,
        message: 'App updates are disabled until an update feed URL is configured.',
      });
    }

    const feedUrl = this.getFeedUrl();
    this.setSnapshot({
      status: 'idle',
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseDate: null,
      feedUrl,
      downloadUrl: null,
      downloadedAt: null,
      message: isNativeUpdatePlatform()
        ? 'App updates are ready to check.'
        : 'App updates are ready to check. On macOS, updates open as a manual download and may require an Open Anyway approval after install.',
    });

    if (isNativeUpdatePlatform()) {
      this.configureNativeFeed(feedUrl);
    }

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

    if (this.snapshot.status === 'downloaded' || this.snapshot.status === 'available') {
      return this.snapshot;
    }

    try {
      const feedUrl = this.getFeedUrl();
      this.setSnapshot({
        status: 'checking',
        feedUrl,
        lastCheckedAt: nowIso(),
        message: manual ? 'Checking for app updates now.' : 'Checking for app updates.',
      });

      if (isNativeUpdatePlatform()) {
        this.configureNativeFeed(feedUrl);
        autoUpdater.checkForUpdates();
      } else {
        await this.checkForManualMacUpdate(feedUrl);
      }
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

  async installUpdate() {
    if (this.snapshot.status === 'downloaded') {
      this.log('info', 'Installing downloaded Windows app update.');
      autoUpdater.quitAndInstall();
      return;
    }

    if (this.snapshot.status === 'available' && this.snapshot.downloadUrl) {
      await shell.openExternal(this.snapshot.downloadUrl);
      this.setSnapshot({
        message: 'Opened the latest macOS build in your browser. After replacing the app, macOS may ask you to allow it in Privacy & Security.',
      });
      return;
    }

    throw new Error('No app update action is available right now.');
  }

  private attachListeners() {
    if (this.listenersAttached || !isNativeUpdatePlatform()) {
      this.listenersAttached = true;
      return;
    }

    autoUpdater.on('checking-for-update', () => {
      this.setSnapshot({
        status: 'checking',
        lastCheckedAt: nowIso(),
        message: 'Checking for Windows app updates.',
      });
    });

    autoUpdater.on('update-available', () => {
      this.log('info', 'Windows app update found. Downloading in the background.');
      this.setSnapshot({
        status: 'downloading',
        message: 'A new Windows app update is available and is downloading now.',
      });
      this.notify('App update found', 'Downloading the latest Windows release now.');
    });

    autoUpdater.on('update-not-available', () => {
      this.setSnapshot({
        status: 'up-to-date',
        availableVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseDate: null,
        downloadUrl: null,
        downloadedAt: null,
        message: 'This app is already on the latest available version.',
      });
    });

    autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName, releaseDate, updateURL) => {
      const releaseVersion = releaseName?.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? null;
      this.log('info', `Windows app update downloaded${releaseName ? `: ${releaseName}` : '.'}`);
      this.setSnapshot({
        status: 'downloaded',
        availableVersion: releaseVersion,
        releaseName: releaseName || null,
        releaseNotes: releaseNotes || null,
        releaseDate: releaseDate ? new Date(releaseDate).toISOString() : null,
        downloadUrl: updateURL || null,
        downloadedAt: nowIso(),
        message: 'A new Windows app update has been downloaded and is ready to install.',
      });
      this.notify('Update ready', 'A new Windows build is ready. Install it from the app.');
    });

    autoUpdater.on('error', (error) => {
      const message = error.message.trim();
      this.log('error', `Windows app updater error: ${message}`);
      this.setSnapshot({
        status: 'error',
        lastCheckedAt: nowIso(),
        message: `Windows app updater error: ${message}`,
      });
    });

    this.listenersAttached = true;
  }

  private getFeedUrl() {
    const baseUrl = trimTrailingSlash(this.settings?.baseUrl ?? '');

    if (!baseUrl) {
      throw new Error('App update feed URL is not configured.');
    }

    const platformBaseUrl = `${baseUrl}/${process.platform}/${process.arch}`;
    return isManualDownloadPlatform()
      ? `${platformBaseUrl}/RELEASES.json`
      : platformBaseUrl;
  }

  private configureNativeFeed(feedUrl: string) {
    autoUpdater.setFeedURL({ url: feedUrl });
  }

  private async checkForManualMacUpdate(feedUrl: string) {
    const response = await fetch(feedUrl, {
      cache: 'no-store',
      headers: {
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Update manifest request failed with status ${response.status}.`);
    }

    const manifest = (await response.json()) as MacReleaseManifest;
    const currentVersion = normalizeVersion(app.getVersion());
    const releases = manifest.releases ?? [];
    const selectedRelease =
      releases.find((release) => normalizeVersion(release.version ?? '') === normalizeVersion(manifest.currentRelease ?? '')) ??
      releases
        .filter((release) => release.updateTo?.version && release.updateTo.url)
        .sort((left, right) =>
          compareVersions(right.updateTo?.version ?? '0.0.0', left.updateTo?.version ?? '0.0.0'),
        )[0];

    const nextVersion = selectedRelease?.updateTo?.version ?? selectedRelease?.version ?? null;
    const downloadUrl = selectedRelease?.updateTo?.url ?? null;

    if (!nextVersion || !downloadUrl) {
      this.setSnapshot({
        status: 'up-to-date',
        availableVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseDate: null,
        downloadUrl: null,
        message: 'No newer macOS build is currently published.',
      });
      return;
    }

    if (compareVersions(nextVersion, currentVersion) <= 0) {
      this.setSnapshot({
        status: 'up-to-date',
        availableVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseDate: null,
        downloadUrl: null,
        message: 'This app is already on the latest available version.',
      });
      return;
    }

    const releaseName = selectedRelease?.updateTo?.name ?? `CSN Media Bridge v${nextVersion}`;
    this.log('info', `New macOS app build available: ${releaseName}`);
    this.setSnapshot({
      status: 'available',
      availableVersion: nextVersion,
      releaseName,
      releaseNotes: selectedRelease?.updateTo?.notes ?? null,
      releaseDate: selectedRelease?.updateTo?.pub_date
        ? new Date(selectedRelease.updateTo.pub_date).toISOString()
        : null,
      downloadUrl,
      downloadedAt: null,
      message: 'A new macOS build is available to download. After installing it, macOS may ask you to allow it in Privacy & Security.',
    });
    this.notify('Update available', 'A newer macOS build is available to download.');
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
      isNativeUpdatePlatform() && process.argv.includes('--squirrel-firstrun')
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

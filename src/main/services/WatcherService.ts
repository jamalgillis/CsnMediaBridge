import { watch, type FSWatcher } from 'chokidar';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppSettings, LogLevel } from '../../shared/types';
import { SUPPORTED_INGEST_EXTENSIONS } from '../lib/sourceMetadata';

interface WatcherLogger {
  (level: LogLevel, message: string): void;
}

interface WatcherServiceOptions {
  onFileReady: (filePath: string) => Promise<void> | void;
  log: WatcherLogger;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WatcherService {
  private watcher: FSWatcher | null = null;
  private readonly pendingFiles = new Set<string>();
  private currentWatchFolder = '';

  constructor(private readonly options: WatcherServiceOptions) {}

  get isWatching() {
    return Boolean(this.watcher);
  }

  get watchFolder() {
    return this.currentWatchFolder;
  }

  async start(settings: AppSettings) {
    await this.stop();

    if (!settings.watchFolder) {
      throw new Error('Choose an ingest folder before starting the watcher.');
    }

    this.currentWatchFolder = settings.watchFolder;
    this.watcher = watch(settings.watchFolder, {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: false,
    });

    this.watcher.on('add', (filePath) => {
      void this.handleFileCandidate(filePath, settings);
    });

    this.watcher.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log('error', `Watcher error: ${message}`);
    });

    this.options.log(
      'info',
      `Watching ${settings.watchFolder} for new ${SUPPORTED_INGEST_EXTENSIONS.join(', ')} files.`,
    );
  }

  async stop() {
    if (!this.watcher) {
      return;
    }

    await this.watcher.close();
    this.pendingFiles.clear();
    this.currentWatchFolder = '';
    this.watcher = null;
    this.options.log('info', 'Folder watcher stopped.');
  }

  private async handleFileCandidate(filePath: string, settings: AppSettings) {
    const extension = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_INGEST_EXTENSIONS.includes(extension as (typeof SUPPORTED_INGEST_EXTENSIONS)[number])) {
      this.options.log(
        'debug',
        `Skipping ${path.basename(filePath)} because it is not a supported ingest file.`,
      );
      return;
    }

    if (this.pendingFiles.has(filePath)) {
      return;
    }

    this.pendingFiles.add(filePath);
    this.options.log('info', `Detected ${path.basename(filePath)}. Running file-ready checks...`);

    try {
      const ready = await this.waitForFileReady(filePath, settings);
      if (!ready || !this.watcher) {
        return;
      }

      this.options.log('info', `${path.basename(filePath)} is stable. Sending to the ingest queue.`);
      await this.options.onFileReady(filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log('error', `File-ready check failed for ${path.basename(filePath)}: ${message}`);
    } finally {
      this.pendingFiles.delete(filePath);
    }
  }

  private async waitForFileReady(filePath: string, settings: AppSettings) {
    const stablePassesNeeded = settings.readyCheckStablePasses;
    const intervalMs = settings.readyCheckIntervalMs;
    let stablePasses = 0;
    let previousSignature = '';

    for (let attempt = 0; attempt < 180; attempt += 1) {
      if (!this.watcher) {
        return false;
      }

      try {
        const fileStats = await stat(filePath);
        const signature = `${fileStats.size}:${fileStats.mtimeMs}`;

        if (
          signature === previousSignature &&
          fileStats.size > 0 &&
          (await this.isFileUnlocked(filePath))
        ) {
          stablePasses += 1;
        } else {
          stablePasses = 0;
          previousSignature = signature;
        }

        if (stablePasses >= stablePassesNeeded) {
          return true;
        }
      } catch (error) {
        if (attempt > 3) {
          throw error;
        }
      }

      await sleep(intervalMs);
    }

    throw new Error('Timed out while waiting for the source file to stop changing.');
  }

  private async isFileUnlocked(filePath: string) {
    try {
      const handle = await open(filePath, 'r');
      await handle.close();
      return true;
    } catch {
      return false;
    }
  }
}

import Store from 'electron-store';
import { safeStorage } from 'electron';
import { defaultSettings } from '../../shared/defaults';
import type { AppSettings } from '../../shared/types';

type ProtectedValue = string;

interface PersistedSettings {
  watchFolder: string;
  tempOutputPath: string;
  hardwareEncoderOverride: AppSettings['hardwareEncoderOverride'];
  autoWatch: boolean;
  autoCleanupTempFiles: boolean;
  autoFallbackToSoftware: boolean;
  extractPosterFrame: boolean;
  verifyUploads: boolean;
  enableNotifications: boolean;
  uploadConcurrency: number;
  autoProgressiveMaxDurationSeconds: number;
  readyCheckIntervalMs: number;
  readyCheckStablePasses: number;
  b2: {
    bucket: string;
    pathPrefix: string;
    keyId: ProtectedValue;
    applicationKey: ProtectedValue;
  };
  r2: {
    accountId: string;
    bucket: string;
    pathPrefix: string;
    publicBaseUrl: string;
    accessKeyId: ProtectedValue;
    secretAccessKey: ProtectedValue;
  };
  convex: {
    deploymentUrl: string;
    mutationPath: string;
  };
  appUpdates: {
    enabled: boolean;
    baseUrl: string;
    checkIntervalMinutes: number;
  };
}

interface StoreShape {
  settings: PersistedSettings;
}

function encryptSecret(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return '';
  }

  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(normalized).toString('base64')}`;
  }

  return `plain:${normalized}`;
}

function decryptSecret(value: string) {
  if (!value) {
    return '';
  }

  if (value.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    } catch {
      return '';
    }
  }

  if (value.startsWith('plain:')) {
    return value.slice(6);
  }

  return value;
}

function normalizeSettings(settings: AppSettings): AppSettings {
  return {
    watchFolder: settings.watchFolder.trim(),
    tempOutputPath: settings.tempOutputPath.trim(),
    hardwareEncoderOverride: settings.hardwareEncoderOverride,
    autoWatch: settings.autoWatch,
    autoCleanupTempFiles: settings.autoCleanupTempFiles,
    autoFallbackToSoftware: settings.autoFallbackToSoftware,
    extractPosterFrame: settings.extractPosterFrame,
    verifyUploads: settings.verifyUploads,
    enableNotifications: settings.enableNotifications,
    uploadConcurrency: Math.max(1, settings.uploadConcurrency || defaultSettings.uploadConcurrency),
    autoProgressiveMaxDurationSeconds: Math.max(
      5,
      settings.autoProgressiveMaxDurationSeconds || defaultSettings.autoProgressiveMaxDurationSeconds,
    ),
    readyCheckIntervalMs: Math.max(1000, settings.readyCheckIntervalMs || defaultSettings.readyCheckIntervalMs),
    readyCheckStablePasses: Math.max(
      2,
      settings.readyCheckStablePasses || defaultSettings.readyCheckStablePasses,
    ),
    b2: {
      bucket: settings.b2.bucket.trim(),
      pathPrefix: settings.b2.pathPrefix.trim(),
      keyId: settings.b2.keyId.trim(),
      applicationKey: settings.b2.applicationKey.trim(),
    },
    r2: {
      accountId: settings.r2.accountId.trim(),
      bucket: settings.r2.bucket.trim(),
      pathPrefix: settings.r2.pathPrefix.trim(),
      publicBaseUrl: settings.r2.publicBaseUrl.trim(),
      accessKeyId: settings.r2.accessKeyId.trim(),
      secretAccessKey: settings.r2.secretAccessKey.trim(),
    },
    convex: {
      deploymentUrl: settings.convex.deploymentUrl.trim(),
      mutationPath: settings.convex.mutationPath.trim(),
    },
    appUpdates: {
      enabled: settings.appUpdates.enabled,
      baseUrl: settings.appUpdates.baseUrl.trim(),
      checkIntervalMinutes: Math.max(
        15,
        settings.appUpdates.checkIntervalMinutes || defaultSettings.appUpdates.checkIntervalMinutes,
      ),
    },
  };
}

export class StoreService {
  private readonly store = new Store<StoreShape>({
    name: 'csn-media-bridge',
    defaults: {
      settings: {
        watchFolder: defaultSettings.watchFolder,
        tempOutputPath: defaultSettings.tempOutputPath,
        hardwareEncoderOverride: defaultSettings.hardwareEncoderOverride,
        autoWatch: defaultSettings.autoWatch,
        autoCleanupTempFiles: defaultSettings.autoCleanupTempFiles,
        autoFallbackToSoftware: defaultSettings.autoFallbackToSoftware,
        extractPosterFrame: defaultSettings.extractPosterFrame,
        verifyUploads: defaultSettings.verifyUploads,
        enableNotifications: defaultSettings.enableNotifications,
        uploadConcurrency: defaultSettings.uploadConcurrency,
        autoProgressiveMaxDurationSeconds: defaultSettings.autoProgressiveMaxDurationSeconds,
        readyCheckIntervalMs: defaultSettings.readyCheckIntervalMs,
        readyCheckStablePasses: defaultSettings.readyCheckStablePasses,
        b2: {
          bucket: defaultSettings.b2.bucket,
          pathPrefix: defaultSettings.b2.pathPrefix,
          keyId: '',
          applicationKey: '',
        },
        r2: {
          accountId: defaultSettings.r2.accountId,
          bucket: defaultSettings.r2.bucket,
          pathPrefix: defaultSettings.r2.pathPrefix,
          publicBaseUrl: defaultSettings.r2.publicBaseUrl,
          accessKeyId: '',
          secretAccessKey: '',
        },
        convex: {
          deploymentUrl: defaultSettings.convex.deploymentUrl,
          mutationPath: defaultSettings.convex.mutationPath,
        },
        appUpdates: {
          enabled: defaultSettings.appUpdates.enabled,
          baseUrl: defaultSettings.appUpdates.baseUrl,
          checkIntervalMinutes: defaultSettings.appUpdates.checkIntervalMinutes,
        },
      },
    },
  }) as unknown as { store: StoreShape };

  loadSettings(): AppSettings {
    const { settings } = this.store.store;
    const persistedAppUpdates = settings.appUpdates ?? defaultSettings.appUpdates;

    return normalizeSettings({
      watchFolder: settings.watchFolder,
      tempOutputPath: settings.tempOutputPath,
      hardwareEncoderOverride: settings.hardwareEncoderOverride,
      autoWatch: settings.autoWatch,
      autoCleanupTempFiles: settings.autoCleanupTempFiles,
      autoFallbackToSoftware: settings.autoFallbackToSoftware,
      extractPosterFrame: settings.extractPosterFrame,
      verifyUploads: settings.verifyUploads,
      enableNotifications: settings.enableNotifications,
      uploadConcurrency: settings.uploadConcurrency,
      autoProgressiveMaxDurationSeconds: settings.autoProgressiveMaxDurationSeconds,
      readyCheckIntervalMs: settings.readyCheckIntervalMs,
      readyCheckStablePasses: settings.readyCheckStablePasses,
      b2: {
        bucket: settings.b2.bucket,
        pathPrefix: settings.b2.pathPrefix,
        keyId: decryptSecret(settings.b2.keyId),
        applicationKey: decryptSecret(settings.b2.applicationKey),
      },
      r2: {
        accountId: settings.r2.accountId,
        bucket: settings.r2.bucket,
        pathPrefix: settings.r2.pathPrefix,
        publicBaseUrl: settings.r2.publicBaseUrl,
        accessKeyId: decryptSecret(settings.r2.accessKeyId),
        secretAccessKey: decryptSecret(settings.r2.secretAccessKey),
      },
      convex: {
        deploymentUrl: settings.convex.deploymentUrl,
        mutationPath: settings.convex.mutationPath,
      },
      appUpdates: {
        enabled: persistedAppUpdates.enabled ?? defaultSettings.appUpdates.enabled,
        baseUrl: persistedAppUpdates.baseUrl ?? defaultSettings.appUpdates.baseUrl,
        checkIntervalMinutes:
          persistedAppUpdates.checkIntervalMinutes ?? defaultSettings.appUpdates.checkIntervalMinutes,
      },
    });
  }

  saveSettings(settings: AppSettings) {
    const normalized = normalizeSettings(settings);

    this.store.store = {
      ...this.store.store,
      settings: {
        watchFolder: normalized.watchFolder,
        tempOutputPath: normalized.tempOutputPath,
        hardwareEncoderOverride: normalized.hardwareEncoderOverride,
        autoWatch: normalized.autoWatch,
        autoCleanupTempFiles: normalized.autoCleanupTempFiles,
        autoFallbackToSoftware: normalized.autoFallbackToSoftware,
        extractPosterFrame: normalized.extractPosterFrame,
        verifyUploads: normalized.verifyUploads,
        enableNotifications: normalized.enableNotifications,
        uploadConcurrency: normalized.uploadConcurrency,
        autoProgressiveMaxDurationSeconds: normalized.autoProgressiveMaxDurationSeconds,
        readyCheckIntervalMs: normalized.readyCheckIntervalMs,
        readyCheckStablePasses: normalized.readyCheckStablePasses,
        b2: {
          bucket: normalized.b2.bucket,
          pathPrefix: normalized.b2.pathPrefix,
          keyId: encryptSecret(normalized.b2.keyId),
          applicationKey: encryptSecret(normalized.b2.applicationKey),
        },
        r2: {
          accountId: normalized.r2.accountId,
          bucket: normalized.r2.bucket,
          pathPrefix: normalized.r2.pathPrefix,
          publicBaseUrl: normalized.r2.publicBaseUrl,
          accessKeyId: encryptSecret(normalized.r2.accessKeyId),
          secretAccessKey: encryptSecret(normalized.r2.secretAccessKey),
        },
        convex: {
          deploymentUrl: normalized.convex.deploymentUrl,
          mutationPath: normalized.convex.mutationPath,
        },
        appUpdates: {
          enabled: normalized.appUpdates.enabled,
          baseUrl: normalized.appUpdates.baseUrl,
          checkIntervalMinutes: normalized.appUpdates.checkIntervalMinutes,
        },
      },
    };

    return normalized;
  }
}

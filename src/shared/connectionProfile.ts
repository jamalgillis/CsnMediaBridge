import type { AppSettings, BackendConnectionProfile, StorageLayoutMode } from './types';

export const CONNECTION_PROFILE_VERSION = 1;

const PROFILE_FIELDS = [
  'storage',
  'b2',
  'r2',
  'convex',
  'offload',
  'appUpdates',
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown) {
  return typeof value === 'boolean' ? value : undefined;
}

function storageLayout(value: unknown): StorageLayoutMode | undefined {
  return value === 'canonical' || value === 'legacy' ? value : undefined;
}

export function normalizeConnectionProfile(rawProfile: unknown): BackendConnectionProfile {
  const raw = asRecord(rawProfile);
  const profileName = stringValue(raw.profileName) ?? stringValue(raw.name) ?? 'Imported Profile';
  const storage = asRecord(raw.storage);
  const b2 = asRecord(raw.b2);
  const r2 = asRecord(raw.r2);
  const convex = asRecord(raw.convex);
  const offload = asRecord(raw.offload);
  const appUpdates = asRecord(raw.appUpdates);

  const profile: BackendConnectionProfile = {
    profileVersion: CONNECTION_PROFILE_VERSION,
    profileName,
  };

  if (storageLayout(storage.layout)) {
    profile.storage = { layout: storageLayout(storage.layout) };
  }

  profile.b2 = {
    bucket: stringValue(b2.bucket),
    pathPrefix: stringValue(b2.pathPrefix),
    s3Endpoint: stringValue(b2.s3Endpoint),
  };
  profile.r2 = {
    accountId: stringValue(r2.accountId),
    bucket: stringValue(r2.bucket),
    pathPrefix: stringValue(r2.pathPrefix),
    publicBaseUrl: stringValue(r2.publicBaseUrl),
  };
  profile.convex = {
    deploymentUrl: stringValue(convex.deploymentUrl),
    mutationPath: stringValue(convex.mutationPath),
  };
  profile.offload = {
    b2PathPrefix: stringValue(offload.b2PathPrefix),
  };
  profile.appUpdates = {
    enabled: booleanValue(appUpdates.enabled),
    baseUrl: stringValue(appUpdates.baseUrl),
    checkIntervalMinutes: numberValue(appUpdates.checkIntervalMinutes),
  };

  for (const field of PROFILE_FIELDS) {
    const section = profile[field];
    if (
      section &&
      Object.values(section).every((value) => value === undefined || value === '')
    ) {
      delete profile[field];
    }
  }

  const notes = stringValue(raw.notes);
  if (notes) {
    profile.notes = notes;
  }

  return profile;
}

function definedEntries<T extends object>(patch: Partial<T>): Partial<T> {
  const next: Partial<T> = {};

  for (const [key, value] of Object.entries(patch) as [keyof T, unknown][]) {
    if (value !== undefined && value !== '') {
      next[key] = value as T[keyof T];
    }
  }

  return next;
}

export function applyConnectionProfile(
  settings: AppSettings,
  rawProfile: unknown,
): AppSettings {
  const profile = normalizeConnectionProfile(rawProfile);

  return {
    ...settings,
    storage: profile.storage
      ? { ...settings.storage, ...definedEntries(profile.storage) }
      : settings.storage,
    b2: profile.b2 ? { ...settings.b2, ...definedEntries(profile.b2) } : settings.b2,
    r2: profile.r2 ? { ...settings.r2, ...definedEntries(profile.r2) } : settings.r2,
    convex: profile.convex
      ? { ...settings.convex, ...definedEntries(profile.convex) }
      : settings.convex,
    offload: profile.offload
      ? { ...settings.offload, ...definedEntries(profile.offload) }
      : settings.offload,
    appUpdates: profile.appUpdates
      ? { ...settings.appUpdates, ...definedEntries(profile.appUpdates) }
      : settings.appUpdates,
  };
}

export function buildConnectionProfile(
  settings: AppSettings,
  profileName = 'Media Bridge Connection Profile',
): BackendConnectionProfile {
  return {
    profileVersion: CONNECTION_PROFILE_VERSION,
    profileName,
    storage: {
      layout: settings.storage.layout,
    },
    b2: {
      bucket: settings.b2.bucket,
      pathPrefix: settings.b2.pathPrefix,
      s3Endpoint: settings.b2.s3Endpoint,
    },
    r2: {
      accountId: settings.r2.accountId,
      bucket: settings.r2.bucket,
      pathPrefix: settings.r2.pathPrefix,
      publicBaseUrl: settings.r2.publicBaseUrl,
    },
    convex: {
      deploymentUrl: settings.convex.deploymentUrl,
      mutationPath: settings.convex.mutationPath,
    },
    offload: {
      b2PathPrefix: settings.offload.b2PathPrefix,
    },
    appUpdates: {
      enabled: settings.appUpdates.enabled,
      baseUrl: settings.appUpdates.baseUrl,
      checkIntervalMinutes: settings.appUpdates.checkIntervalMinutes,
    },
    exportedAt: new Date().toISOString(),
    notes:
      'This profile intentionally excludes storage access keys and the media library node token.',
  };
}

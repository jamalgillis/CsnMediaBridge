/**
 * The storage key contract for Backblaze B2 and Cloudflare R2.
 *
 * Lifecycle rules in R2 act on key *prefixes*, so a key written to the wrong
 * place is either billed forever or deleted out from under a scheduled post.
 * Every key the app writes to either provider comes from this module.
 *
 * See `docs/STORAGE_LAYOUT.md` for the contract this implements, and
 * `convex/storageKeys.ts` for the backend mirror that validates it on write.
 */

import type { RenderStorageClass, StorageLayoutMode } from './types';

export type { StorageLayoutMode };

/**
 * Hex characters of the source SHA-256 kept as the asset key. 16 hex chars is
 * 64 bits of collision resistance — far past what a media library needs, while
 * staying short enough to read in a bucket listing.
 */
export const ASSET_KEY_LENGTH = 16;

export const MASTERS_PREFIX = 'masters';
export const OFFLOADS_PREFIX = 'offloads';
export const STILLS_PREFIX = 'stills';
export const STREAMING_PREFIX = 'videos';
const LEGACY_STREAMING_PREFIX = 'streaming/vod';
export const POSTERS_PREFIX = 'posters';
export const STAGING_SOCIAL_PREFIX = 'staging/social';
export const SCHEDULED_SOCIAL_PREFIX = 'scheduled/social';

export const UNASSIGNED_PROJECT_SEGMENT = 'unassigned';
export const DEFAULT_POSTER_FILE_NAME = 'default.jpg';

/** The prefix each render storage class must live under. */
export const STORAGE_CLASS_PREFIXES: Record<RenderStorageClass, string> = {
  streaming: STREAMING_PREFIX,
  staging_social: STAGING_SOCIAL_PREFIX,
  scheduled_social: SCHEDULED_SOCIAL_PREFIX,
};

function joinKey(...parts: Array<string | null | undefined>) {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

/**
 * Lowercase, hyphen-separated, safe as a single object-key segment. Kept local
 * rather than imported from the main process so this module stays usable from
 * the renderer and from any future shared package.
 */
export function slugifySegment(value: string | null | undefined, fallback: string) {
  const slug = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  return slug || fallback;
}

/**
 * The stable per-asset identifier every derivative shares.
 *
 * Takes the `sha256:<hex>` fingerprint the ingest pipeline already computes for
 * duplicate detection. Falls back to a slug of the supplied seed when a
 * fingerprint is unavailable, so a key can always be built — a fallback key is
 * still deterministic for that seed, just not content-addressed.
 */
export function deriveAssetKey(
  sourceFingerprint: string | null | undefined,
  fallbackSeed: string,
) {
  const hex = (sourceFingerprint ?? '').replace(/^sha256:/i, '').trim().toLowerCase();
  if (/^[0-9a-f]{16,}$/.test(hex)) {
    return hex.slice(0, ASSET_KEY_LENGTH);
  }

  return slugifySegment(fallbackSeed, 'asset');
}

/** `YYYY-MM-DD` from an ISO timestamp, falling back to today. */
export function toDateSegment(isoTimestamp: string | null | undefined, now = new Date()) {
  const parsed = isoTimestamp ? new Date(isoTimestamp) : null;
  const date = parsed && !Number.isNaN(parsed.getTime()) ? parsed : now;
  return date.toISOString().slice(0, 10);
}

/** Strips path separators so a source filename can never escape its asset folder. */
export function sanitizeFileName(fileName: string | null | undefined, fallback: string) {
  const base = (fileName ?? '').split(/[\\/]/).pop()?.trim() ?? '';
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return safe || fallback;
}

export interface MasterKeyParams {
  assetKey: string;
  originalFileName: string;
  projectName?: string | null;
  recordedAt?: string | null;
}

/** `masters/{projectSlug}/{recordedDate}/{assetKey}/{originalFileName}` */
export function buildMasterObjectKey(params: MasterKeyParams) {
  return joinKey(
    MASTERS_PREFIX,
    slugifySegment(params.projectName, UNASSIGNED_PROJECT_SEGMENT),
    toDateSegment(params.recordedAt),
    params.assetKey,
    sanitizeFileName(params.originalFileName, `${params.assetKey}.bin`),
  );
}

/** The sidecar metadata backup that sits beside a master. */
export function buildMasterSidecarKey(params: Omit<MasterKeyParams, 'originalFileName'>) {
  return joinKey(
    MASTERS_PREFIX,
    slugifySegment(params.projectName, UNASSIGNED_PROJECT_SEGMENT),
    toDateSegment(params.recordedAt),
    params.assetKey,
    'sidecar.bridge.json',
  );
}

/** `videos/{assetKey}` — the directory the playback package uploads into. */
export function buildStreamingPrefix(assetKey: string) {
  return joinKey(STREAMING_PREFIX, assetKey);
}

/** `posters/{assetKey}/default.jpg` */
export function buildPosterObjectKey(assetKey: string, fileName = DEFAULT_POSTER_FILE_NAME) {
  return joinKey(POSTERS_PREFIX, assetKey, sanitizeFileName(fileName, DEFAULT_POSTER_FILE_NAME));
}

/** `staging/social/{renderJobId}/render.mp4` */
export function buildStagingSocialKey(renderJobId: string, fileName = 'render.mp4') {
  return joinKey(STAGING_SOCIAL_PREFIX, renderJobId, sanitizeFileName(fileName, 'render.mp4'));
}

/**
 * `scheduled/social/{socialPostId}/{renderJobId}.mp4`
 *
 * Keyed by post because that is the unit the publish scheduler and post-publish
 * cleanup act on; the render job id stays in the filename so a post carrying
 * several platform variants does not collide with itself.
 */
export function buildScheduledSocialKey(socialPostId: string, renderJobId: string) {
  return joinKey(SCHEDULED_SOCIAL_PREFIX, socialPostId, `${renderJobId}.mp4`);
}

/** `offloads/{date}/{cardPackageName}` */
export function buildOffloadPrefix(cardPackageName: string, offloadedAt?: string | null) {
  return joinKey(
    OFFLOADS_PREFIX,
    toDateSegment(offloadedAt),
    slugifySegment(cardPackageName, 'card'),
  );
}

/** `stills/{projectSlug}/{date}/{fileName}` */
export function buildStillObjectKey(params: {
  fileName: string;
  projectName?: string | null;
  capturedAt?: string | null;
}) {
  return joinKey(
    STILLS_PREFIX,
    slugifySegment(params.projectName, UNASSIGNED_PROJECT_SEGMENT),
    toDateSegment(params.capturedAt),
    sanitizeFileName(params.fileName, 'still.webp'),
  );
}

/**
 * The storage class an existing key belongs to, or `null` when the key predates
 * the contract. Used to validate that a record's declared `storageClass` agrees
 * with where its bytes actually live.
 */
export function storageClassForKey(objectKey: string | null | undefined): RenderStorageClass | null {
  const normalized = (objectKey ?? '').replace(/^\/+/, '');
  if (!normalized) {
    return null;
  }

  // Checked longest-first so `staging/social/` wins over a bare `staging/`.
  const entries = Object.entries(STORAGE_CLASS_PREFIXES) as Array<[RenderStorageClass, string]>;
  const match = entries
    .sort(([, left], [, right]) => right.length - left.length)
    .find(([, prefix]) => normalized === prefix || normalized.startsWith(`${prefix}/`));

  return match ? match[0] : null;
}

/** True when the key is written under one of the contract's known prefixes. */
export function isCanonicalKey(objectKey: string | null | undefined) {
  const normalized = (objectKey ?? '').replace(/^\/+/, '');
  return [
    MASTERS_PREFIX,
    OFFLOADS_PREFIX,
    STILLS_PREFIX,
    STREAMING_PREFIX,
    POSTERS_PREFIX,
    STAGING_SOCIAL_PREFIX,
    SCHEDULED_SOCIAL_PREFIX,
  ].some((prefix) => normalized.startsWith(`${prefix}/`));
}

/**
 * Recovers the asset key from the canonical persistent video prefix.
 * Returns `null` for legacy keys, whose layout carries no asset key.
 */
export function assetKeyFromStreamingPrefix(distributionObjectKey: string | null | undefined) {
  const normalized = (distributionObjectKey ?? '').replace(/^\/+|\/+$/g, '');

  for (const prefix of [STREAMING_PREFIX, LEGACY_STREAMING_PREFIX]) {
    if (normalized.startsWith(`${prefix}/`)) {
      const [assetKey] = normalized.slice(prefix.length + 1).split('/');
      return assetKey?.trim() ? assetKey : null;
    }
  }

  return null;
}

/**
 * Where a replacement poster for an existing asset should be written.
 *
 * Canonical assets get `posters/{assetKey}/default.jpg`; legacy assets keep
 * `{distributionObjectKey}/poster.jpg` so an in-place poster swap continues to
 * land beside the playback files it was published with.
 */
export function resolvePosterObjectKey(distributionObjectKey: string) {
  const assetKey = assetKeyFromStreamingPrefix(distributionObjectKey);
  return assetKey ? buildPosterObjectKey(assetKey) : joinKey(distributionObjectKey, 'poster.jpg');
}

export interface StorageKeyPlanParams {
  layout: StorageLayoutMode;
  /** Source SHA-256 (`sha256:<hex>`), when duplicate detection has computed it. */
  sourceFingerprint?: string | null;
  /** Per-job folder name, used as the legacy path segment and as the fallback seed. */
  jobFolderName: string;
  /** Original source filename, preserved inside the master folder. */
  sourceName: string;
  projectName?: string | null;
  recordedAt?: string | null;
  /** Legacy-only: the configured B2 path prefix. */
  legacyArchivePrefix?: string | null;
  /** Legacy-only: the configured R2 path prefix. */
  legacyDistributionPrefix?: string | null;
}

export interface StorageKeyPlan {
  layout: StorageLayoutMode;
  assetKey: string;
  /** Full B2 key for the raw master. */
  archiveObjectKey: string;
  /** R2 prefix the playback package uploads into. */
  distributionObjectKey: string;
  /**
   * R2 key for the poster, when it lives outside the distribution prefix.
   * `null` in legacy mode, where the poster ships inside the package upload and
   * needs no separate transfer.
   */
  posterObjectKey: string | null;
}

/**
 * Resolves every key a single ingest will write, in one place, before the first
 * byte moves. Both the pre-upload optimistic UI and the post-transcode upload
 * call this with the same inputs and get the same answer.
 */
export function buildStorageKeyPlan(params: StorageKeyPlanParams): StorageKeyPlan {
  const assetKey = deriveAssetKey(params.sourceFingerprint, params.jobFolderName);

  if (params.layout === 'legacy') {
    return {
      layout: 'legacy',
      assetKey,
      archiveObjectKey: joinKey(
        params.legacyArchivePrefix,
        params.jobFolderName,
        params.sourceName,
      ),
      distributionObjectKey: joinKey(params.legacyDistributionPrefix, params.jobFolderName),
      posterObjectKey: null,
    };
  }

  return {
    layout: 'canonical',
    assetKey,
    archiveObjectKey: buildMasterObjectKey({
      assetKey,
      originalFileName: params.sourceName,
      projectName: params.projectName,
      recordedAt: params.recordedAt,
    }),
    distributionObjectKey: buildStreamingPrefix(assetKey),
    posterObjectKey: buildPosterObjectKey(assetKey),
  };
}

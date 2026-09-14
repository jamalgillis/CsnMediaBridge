/**
 * Where you stopped watching.
 *
 * An operator reviewing a two-hour game should not be sent back to 0:00 every
 * time they leave the screen. Positions live in this window's local storage
 * rather than in the library: where one person got to on one station is not a
 * fact about the asset, and writing it to Convex would make every scrub a
 * network call.
 *
 * The rules exist so resuming never feels wrong. A few seconds in is not worth
 * restoring, and neither is a position so close to the end that resuming would
 * drop you on the credits — both start over instead.
 */

const STORAGE_KEY = 'csn-media-bridge:resume';

/** Below this, the viewer had barely started and resuming is noise. */
const MINIMUM_RESUME_SECONDS = 15;
/** Within this of the end, treat it as watched and start over. */
const END_TOLERANCE_SECONDS = 20;
/** Positions older than this are stale enough to be misleading. */
const MAX_AGE_DAYS = 60;
/** Keeps the store from growing without bound on a long-lived station. */
const MAX_ENTRIES = 300;

interface ResumeEntry {
  positionSeconds: number;
  durationSeconds: number;
  updatedAt: number;
}

type ResumeStore = Record<string, ResumeEntry>;

/**
 * Local storage can be unavailable or full, and a failure to remember a
 * playback position must never stop a video playing.
 */
function readStore(): ResumeStore {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as ResumeStore) : {};
  } catch {
    return {};
  }
}

function writeStore(store: ResumeStore): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Full or blocked: the position is simply not remembered.
  }
}

/** Drops entries that are stale, then the oldest, so the store stays bounded. */
function prune(store: ResumeStore, now: number): ResumeStore {
  const cutoff = now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const fresh = Object.entries(store).filter(([, entry]) => entry.updatedAt >= cutoff);

  if (fresh.length <= MAX_ENTRIES) {
    return Object.fromEntries(fresh);
  }

  return Object.fromEntries(
    fresh.sort(([, left], [, right]) => right.updatedAt - left.updatedAt).slice(0, MAX_ENTRIES),
  );
}

/**
 * Whether a position is worth writing down. A video watched to the end is
 * cleared rather than stored, so the next play starts cleanly.
 */
export function isWorthRemembering(positionSeconds: number, durationSeconds: number): boolean {
  if (!Number.isFinite(positionSeconds) || !Number.isFinite(durationSeconds)) {
    return false;
  }
  if (positionSeconds < MINIMUM_RESUME_SECONDS) {
    return false;
  }
  if (durationSeconds <= 0) {
    return false;
  }

  return positionSeconds < durationSeconds - END_TOLERANCE_SECONDS;
}

export function rememberPosition(
  videoId: string,
  positionSeconds: number,
  durationSeconds: number,
  now = Date.now(),
): void {
  if (!videoId) {
    return;
  }

  const store = readStore();

  if (!isWorthRemembering(positionSeconds, durationSeconds)) {
    // Finishing a video forgets it, so it does not resume near the end forever.
    delete store[videoId];
    writeStore(store);
    return;
  }

  store[videoId] = {
    positionSeconds,
    durationSeconds,
    updatedAt: now,
  };

  writeStore(prune(store, now));
}

/** The position to start at, or null to start from the beginning. */
export function resumePosition(
  videoId: string,
  durationSeconds?: number,
  now = Date.now(),
): number | null {
  if (!videoId) {
    return null;
  }

  const entry = readStore()[videoId];
  if (!entry) {
    return null;
  }

  if (entry.updatedAt < now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000) {
    return null;
  }

  // A re-encode can change the length; a position past the new end is not
  // meaningful, so it is discarded rather than clamped to somewhere arbitrary.
  const duration = durationSeconds ?? entry.durationSeconds;
  if (!isWorthRemembering(entry.positionSeconds, duration)) {
    return null;
  }

  return entry.positionSeconds;
}

export function forgetPosition(videoId: string): void {
  const store = readStore();
  if (videoId in store) {
    delete store[videoId];
    writeStore(store);
  }
}

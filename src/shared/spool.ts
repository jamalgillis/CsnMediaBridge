/**
 * Spool visual helpers shared by the renderer.
 *
 * Thumbnails in the Spool design are CSS gradients keyed to a per-asset hue —
 * there are no external images. We derive a stable hue from the asset id so a
 * given asset always renders the same color.
 */

/** The prototype's thumbnail gradient, verbatim. */
export function hueGradient(hue: number) {
  return `radial-gradient(128% 112% at 28% 16%, hsl(${hue} 60% 33%), hsl(${(hue + 34) % 360} 54% 13%) 72%)`;
}

/**
 * Stable 0–359 hue from any identifier. Uses FNV-1a then spreads the result
 * across the wheel by the golden angle, so ids that differ by one character
 * still land far apart instead of clustering in the same corner of the wheel.
 */
export function hueFor(seed: string | undefined | null) {
  const value = seed ?? '';
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return Math.round(((hash % 1000) / 1000) * 137.508 * 8) % 360;
}

export function thumbGradientFor(seed: string | undefined | null) {
  return hueGradient(hueFor(seed));
}

/** Duration in seconds → `m:ss` or `h:mm:ss`, matching the prototype's mono timecodes. */
export function formatTimecode(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '0:00';
  }

  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const paddedSeconds = String(seconds).padStart(2, '0');

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`
    : `${minutes}:${paddedSeconds}`;
}

/**
 * CSN v2 visual helpers shared by the renderer.
 *
 * The site draws artwork it does not have as a `MediaSlot`: the `tile` surface
 * under a faint diagonal hatch, with an uppercase caption in `ghost`. We use the
 * same treatment for assets without a poster, so a bare thumbnail here reads the
 * same as a bare thumbnail on csnsports.tv.
 */

/** The site's MediaSlot hatch (components/site/media-slot.tsx), verbatim. */
export const MEDIA_HATCH =
  'repeating-linear-gradient(135deg, rgba(255,255,255,.022) 0 12px, transparent 12px 24px)';

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

/**
 * Collection swatch. The palette is monochrome plus red, so these stay low
 * chroma — enough to tell two collections apart in the rail, not enough to read
 * as a second brand color.
 */
export function swatchFor(seed: string | undefined | null) {
  return `hsl(${hueFor(seed)} 22% 46%)`;
}

/** Duration in seconds → `m:ss` or `h:mm:ss`. Set in tabular figures. */
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

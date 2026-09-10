import type { ReactNode } from 'react';
import { MEDIA_HATCH } from '../../shared/csn';
import { PlayGlyph } from './icons';

interface ThumbProps {
  /** Any stable identifier — kept for callers; the placeholder is neutral. */
  seed: string | undefined | null;
  /** Poster image, when the asset has one. Falls back to the hatch. */
  posterUrl?: string | null;
  className?: string;
  /** Overlays: badges, pills, checkboxes. Positioned absolutely by the caller. */
  children?: ReactNode;
  showPlay?: boolean;
  duration?: string | null;
  /** List rows use a tighter timecode than grid cards. */
  compact?: boolean;
}

/**
 * The CSN thumbnail: the `tile` surface, a bottom-up scrim so overlaid type
 * stays readable, and the site's diagonal hatch standing in for missing
 * artwork. A real poster replaces the hatch but keeps the overlays, so cards
 * stay visually consistent either way.
 */
export default function Thumb({
  posterUrl,
  className = '',
  children,
  showPlay = false,
  duration,
  compact = false,
}: ThumbProps) {
  return (
    <div className={`relative overflow-hidden bg-ink-tile ${className}`}>
      {posterUrl ? (
        <img src={posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0" style={{ backgroundImage: MEDIA_HATCH }} />
      )}
      <div className="csn-scrim" />

      {showPlay ? (
        <div className="csn-play">
          <PlayGlyph />
        </div>
      ) : null}

      {duration ? (
        compact ? (
          <div className="absolute bottom-[5px] right-[5px] rounded-[2px] bg-ink/80 px-1.5 py-px text-[10px] font-bold tabular-nums text-paper">
            {duration}
          </div>
        ) : (
          <div className="csn-timecode">{duration}</div>
        )
      ) : null}

      {children}
    </div>
  );
}

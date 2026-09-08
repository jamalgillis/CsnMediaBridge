import type { ReactNode } from 'react';
import { thumbGradientFor } from '../../shared/spool';
import { PlayGlyph } from './icons';

interface ThumbProps {
  /** Any stable identifier — the gradient hue is derived from it. */
  seed: string | undefined | null;
  /** Poster image, when the asset has one. Falls back to the gradient. */
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
 * The Spool thumbnail: a per-asset gradient under a scanline + vignette pair.
 * A real poster image, when present, replaces the gradient but keeps the
 * overlays so cards stay visually consistent either way.
 */
export default function Thumb({
  seed,
  posterUrl,
  className = '',
  children,
  showPlay = false,
  duration,
  compact = false,
}: ThumbProps) {
  return (
    <div className={`relative overflow-hidden bg-surface-scrim ${className}`}>
      {posterUrl ? (
        <img src={posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0" style={{ background: thumbGradientFor(seed) }} />
      )}
      <div className="spool-scanline" />
      <div className="spool-vignette" />

      {showPlay ? (
        <div className="spool-play">
          <PlayGlyph />
        </div>
      ) : null}

      {duration ? (
        compact ? (
          <div className="absolute bottom-[5px] right-[5px] rounded-[4px] bg-[rgba(8,9,12,.78)] px-[5px] py-px font-mono text-micro text-ink">
            {duration}
          </div>
        ) : (
          <div className="spool-timecode">{duration}</div>
        )
      ) : null}

      {children}
    </div>
  );
}

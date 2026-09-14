import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { StoredVideoStatus } from '../../shared/types';
import { LiveDot } from './ui';

/**
 * The Bridge half of the CSN v2 system.
 *
 * `ui.tsx` holds the primitives the sports site and this app share verbatim.
 * The pieces here exist only in the desktop node, because only the desktop node
 * has to explain a pipeline to someone who is not a pipeline engineer: the four
 * named steps every file walks, the plain-language status chip, the disclosure
 * that keeps `sha256` and rclone errors present but never first. See design.md
 * §4 for the three principles these encode.
 */

/* ------------------------------------------------------------------ heading */

/**
 * The one plain answer a screen leads with. Bridge titles state the situation
 * — "1 thing needs you", "Working on 2 videos" — rather than dumping the
 * subsystem behind it.
 */
export function PageHeading({
  title,
  subhead,
  live = false,
  size = 'page',
  action,
}: {
  title: string;
  subhead?: ReactNode;
  live?: boolean;
  size?: 'page' | 'detail';
  action?: ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-[11px]">
        {live ? <LiveDot /> : null}
        <h1
          className={`m-0 font-display font-normal uppercase tracking-[.01em] text-paper ${
            size === 'page' ? 'text-[38px] leading-none' : 'text-[28px] leading-[1.02]'
          }`}
        >
          {title}
        </h1>
        {action ? (
          <>
            <span className="flex-1" />
            {action}
          </>
        ) : null}
      </div>
      {subhead ? <div className="mt-2.5 text-[15px] text-pretty text-body">{subhead}</div> : null}
    </div>
  );
}

/** The 30px/38px content gutter every Bridge screen shares. */
export function Screen({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div data-screen-label={label} className="pb-11">
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------- status */

/**
 * Status in the operator's words, not the pipeline's. CSN has no green and no
 * amber: inert states sit on the tile surface in the neutral ladder, and only
 * the two states that are live or want attention take the accent ring.
 */
const STATUS_COPY: Record<StoredVideoStatus, string> = {
  ready: 'Ready',
  draft: 'Draft',
  processing: 'Converting',
  uploading: 'Uploading',
  error: 'Needs attention',
  archived: 'Archived',
};

const STATUS_CLASS: Record<StoredVideoStatus, string> = {
  ready: 'csn-status-ready',
  draft: 'csn-status-draft',
  processing: 'csn-status-processing',
  uploading: 'csn-status-published',
  error: 'csn-status-failed',
  archived: 'csn-status-draft',
};

export function statusLabel(status: StoredVideoStatus) {
  return STATUS_COPY[status] ?? status;
}

export function StatusChip({ status, label }: { status: StoredVideoStatus; label?: string }) {
  return <span className={STATUS_CLASS[status] ?? 'csn-status-draft'}>{label ?? statusLabel(status)}</span>;
}

/** Same chip shape for anything that isn't a stored video (live jobs, tasks). */
export type ChipTone = 'neutral' | 'quiet' | 'bright' | 'waiting' | 'live';

const TONE_CLASS: Record<ChipTone, string> = {
  neutral: 'csn-status-ready',
  quiet: 'csn-status-draft',
  bright: 'csn-status-published',
  waiting: 'csn-status-waiting',
  live: 'csn-status-processing',
};

export function ToneChip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return <span className={TONE_CLASS[tone]}>{children}</span>;
}

/* -------------------------------------------------------------------- steps */

/**
 * The four named steps every file walks. Done steps are the neutral "good",
 * the current step is accent, future steps are a hairline — so the row reads
 * as a position, not a percentage.
 */
export const PIPELINE_STEPS = ['Check', 'Convert', 'Upload', 'Publish'] as const;

export function StepBar({ active }: { active: number }) {
  return (
    <div className="flex gap-2">
      {PIPELINE_STEPS.map((label, index) => {
        const done = index < active;
        const now = index === active;
        return (
          <div key={label} className="min-w-0 flex-1">
            <div
              className={`h-1 rounded-chip ${
                done ? 'bg-soft' : now ? 'bg-accent' : 'bg-[var(--rule)]'
              }`}
            />
            <div
              className={`mt-[7px] font-condensed text-[11px] font-bold uppercase tracking-[.08em] ${
                now ? 'text-paper' : done ? 'text-quiet' : 'text-muted'
              }`}
            >
              {label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 4–5px track on a hairline ground; accent only when the bar is live work. */
export function ProgressTrack({
  value,
  live = false,
  thick = false,
}: {
  value: number;
  live?: boolean;
  thick?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className={`overflow-hidden rounded-chip bg-[var(--rule)] ${thick ? 'h-[5px]' : 'h-1'}`}
    >
      <div
        className={`h-full rounded-chip ${live ? 'bg-accent' : 'bg-soft'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* --------------------------------------------------------------- disclosure */

/**
 * "Show technical details". Machine vocabulary lives behind this everywhere in
 * Bridge — present, never first.
 */
export function Disclosure({
  open,
  onToggle,
  showLabel = 'Show technical details',
  hideLabel = 'Hide technical details',
  small = false,
}: {
  open: boolean;
  onToggle: () => void;
  showLabel?: string;
  hideLabel?: string;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`csn-disclosure ${small ? 'text-[12.5px]' : ''}`}
    >
      {open ? hideLabel : showLabel}
    </button>
  );
}

/** The raw string a disclosure reveals: condensed, tabular, breakable. */
export function TechNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-chip border border-rule bg-ink-panel px-[13px] py-[11px] machine text-[12px] text-pretty break-all text-quiet">
      {children}
    </div>
  );
}

/** An error that needs you, stated plainly, inside the accent ring. */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-chip bg-ink px-[13px] py-3 text-[13px] text-pretty text-accent shadow-live">
      {children}
    </div>
  );
}

/** A neutral aside — a skipped phase, a safety note. */
export function QuietNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-chip bg-ink-chip px-[13px] py-[11px] text-[12.5px] text-pretty text-body">
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------- toggle */

/** 38×22, squared to 2px, paper track with an inverted ink knob when on. */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`csn-toggle ${checked ? 'bg-paper' : 'bg-[#2a2f39]'}`}
    >
      <span
        className={`csn-toggle-knob ${checked ? 'left-[18px] bg-ink' : 'left-[2px] bg-paper'}`}
      />
    </button>
  );
}

/* --------------------------------------------------------------- fact lists */

/** One label/value row inside a hairline list. */
export function Fact({
  label,
  value,
  machine = false,
  wide = false,
}: {
  label: string;
  value: ReactNode;
  /** Machine-produced values take the condensed tabular voice. */
  machine?: boolean;
  wide?: boolean;
}) {
  return (
    <div className="csn-hair-row flex items-baseline gap-[14px] px-[14px] py-[11px]">
      <span className={`flex-none text-[12.5px] text-quiet ${wide ? 'w-[124px]' : 'w-[100px]'}`}>
        {label}
      </span>
      <span
        className={`min-w-0 flex-1 break-words ${
          machine
            ? 'machine text-[13.5px] font-bold tracking-[.02em] text-paper'
            : 'text-[13.5px] text-paper'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

/** A group of facts under an eyebrow. */
export function FactList({ children, sunk = false }: { children: ReactNode; sunk?: boolean }) {
  return <div className={`csn-hair ${sunk ? 'csn-hair-sunk' : ''}`}>{children}</div>;
}

/* -------------------------------------------------------------------- tiles */

/** One number from the machine, shown only once "technical details" is open. */
export function Vital({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="csn-card px-[14px] py-3">
      <div className="truncate text-[11.5px] text-quiet">{label}</div>
      <div
        className={`mt-[3px] machine text-[18px] font-bold ${alert ? 'text-accent' : 'text-paper'}`}
      >
        {value}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- platform */

/**
 * One treatment for every publish destination: brand ink on the page ground
 * inside a 1px inset brand ring. No saturated fills behind text — nothing
 * clears 4.5:1 on `#FE2C55` or `#E1458F`. A destination that isn't live drops
 * to the dim step rather than reducing opacity, since alpha-muted text fails
 * contrast too.
 */
export const PLATFORM_META: Record<string, { name: string; glyph: string; color: string }> = {
  Website: { name: 'csn.com', glyph: 'WEB', color: '#fbfef9' },
  YouTube: { name: 'YouTube', glyph: 'YT', color: '#ff3b30' },
  TikTok: { name: 'TikTok', glyph: 'TT', color: '#fe2c55' },
  Reels: { name: 'Instagram Reels', glyph: 'IG', color: '#e1458f' },
  Shorts: { name: 'YouTube Shorts', glyph: 'YT', color: '#ff5c52' },
  IGFeed: { name: 'Instagram Feed', glyph: 'IG', color: '#b14fe0' },
  Facebook: { name: 'Facebook', glyph: 'FB', color: '#2d7ff9' },
};

export function PlatformGlyph({
  platform,
  live = true,
  size = 30,
}: {
  platform: string;
  live?: boolean;
  size?: number;
}) {
  const meta = PLATFORM_META[platform];
  const color = live && meta ? meta.color : '#8c8c8c';
  const glyph = meta?.glyph ?? platform.slice(0, 2).toUpperCase();
  return (
    <span
      className="flex flex-none items-center justify-center rounded-chip bg-ink machine font-bold"
      style={{
        width: size,
        height: size,
        fontSize: size <= 20 ? 10 : 10,
        color,
        boxShadow: `inset 0 0 0 1px ${color}`,
      }}
    >
      {glyph}
    </span>
  );
}

/** The compact form that rides on a gallery card or list row. */
export function PlatformTag({ platform, live = true }: { platform: string; live?: boolean }) {
  const meta = PLATFORM_META[platform];
  const color = live && meta ? meta.color : '#8c8c8c';
  return (
    <span
      className="rounded-chip bg-ink px-[5px] py-[2px] machine text-[10px] font-bold tracking-[.06em]"
      style={{ color, boxShadow: `inset 0 0 0 1px ${color}` }}
    >
      {meta?.glyph ?? platform.slice(0, 2).toUpperCase()}
    </span>
  );
}

/* -------------------------------------------------------------------- toast */

/** Every create / destroy / queue action emits one, bottom-centre, ~2.6s. */
export function Toast({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }

  return (
    <div className="fixed bottom-[26px] left-1/2 z-50 -translate-x-1/2 rounded-card border border-rule-strong bg-ink-chip px-[18px] py-[11px] text-[13px] text-paper shadow-toast">
      {message}
    </div>
  );
}

export function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const flash = useCallback((next: string) => {
    clearTimeout(timer.current);
    setMessage(next);
    timer.current = setTimeout(() => setMessage(null), 2600);
  }, []);

  return { toast: message, flash };
}

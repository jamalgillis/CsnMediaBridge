import type { ReactNode } from 'react';

/**
 * The CSN v2 shared primitives, ported from the site's `components/site/ui.tsx`
 * (`Websites/csn`). Same names, same markup, same classes — only the `next/link`
 * dependency is dropped, since this app routes with react-router. Keep the two
 * in step: if a primitive changes on the site, change it here.
 */

/** Pulsing square/dot that marks anything currently on air. */
export function LiveDot({ square = false, dim = false }: { square?: boolean; dim?: boolean }) {
  return (
    <span
      className={`block h-[7px] w-[7px] flex-none ${square ? 'rounded-[2px]' : 'rounded-full'} ${
        dim ? 'bg-faint' : 'animate-csnpulse bg-accent'
      }`}
    />
  );
}

/** Small uppercase kicker above a title. */
export function Eyebrow({
  children,
  accent = false,
  className = '',
}: {
  children: ReactNode;
  accent?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`label text-[13px] tracking-[0.16em] ${accent ? 'text-accent' : 'text-muted'} ${className}`}
    >
      {children}
    </div>
  );
}

/** Section rule: Anton title, a note, and an optional action on the right. */
export function SectionHead({
  title,
  note,
  action,
  className = '',
  size = 'md',
}: {
  title: string;
  note?: string;
  action?: ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizes = { sm: 'text-[20px]', md: 'text-[24px]', lg: 'text-[26px]' };
  return (
    <div className={`flex flex-wrap items-baseline gap-x-3.5 gap-y-1 ${className}`}>
      <span className={`font-display tracking-[0.01em] ${sizes[size]}`}>{title}</span>
      {note ? <span className="text-xs text-muted">{note}</span> : null}
      {action ? (
        <>
          <div className="flex-1" />
          {action}
        </>
      ) : null}
    </div>
  );
}

/** Outlined capsule action ("Open folder", "Clear filters"). */
export function GhostButton({
  children,
  onClick,
  disabled,
  title,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className="csn-btn-capsule">
      {children}
    </button>
  );
}

/** Round-bordered filter chip with an optional count. */
export function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-[7px] ${active ? 'csn-chip-on' : 'csn-chip-off'}`}
    >
      <span>{label}</span>
      {count !== undefined ? (
        <span className={`tnum text-[11px] ${active ? 'text-accent' : 'text-ghost'}`}>{count}</span>
      ) : null}
    </button>
  );
}

/** Inverted segmented control. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-full border border-white/[0.08] bg-ink-tile p-[3px]">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChange(option.key)}
          aria-pressed={value === option.key}
          className={`cursor-pointer rounded-full px-4 py-2 text-xs font-bold uppercase tracking-[0.06em] transition-colors ${
            value === option.key ? 'bg-paper text-ink' : 'text-muted hover:text-paper'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Underlined tab row. */
export function UnderlineTabs<T extends string>({
  tabs,
  value,
  onChange,
  className = '',
}: {
  tabs: readonly { key: T; label: string; count?: string }[];
  value: T;
  onChange: (key: T) => void;
  className?: string;
}) {
  return (
    <div className={`flex gap-[22px] ${className}`}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={value === tab.key}
          onClick={() => onChange(tab.key)}
          className={value === tab.key ? 'csn-tab-on' : 'csn-tab'}
        >
          <span>{tab.label}</span>
          {tab.count ? <span className="tnum font-sans text-[11px] text-dim">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-rule px-7 py-14 text-center">
      <div className="mb-2 font-display text-[26px]">{title}</div>
      <div className="mx-auto mb-5 max-w-[52ch] text-sm text-muted">{body}</div>
      {action}
    </div>
  );
}

/** Stat block: an Anton value over a condensed uppercase key. */
export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="font-display text-[26px] tabular-nums">{value}</div>
      <div className="text-[11px] tracking-[0.12em] text-muted uppercase">{label}</div>
    </div>
  );
}

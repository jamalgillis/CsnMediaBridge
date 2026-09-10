interface StatusBadgeProps {
  tone: 'good' | 'active' | 'warning' | 'danger' | 'neutral';
  children: string;
}

/**
 * The CSN micro badge — 10px, bold, wide-tracked, squared to 3px, as the site
 * sets "REPLAY" or "CSN STAFF". Color carries meaning: red is the brand's live
 * state and so marks work in flight, green is done, amber needs a look, and the
 * danger red is failure.
 */
const toneClasses: Record<StatusBadgeProps['tone'], string> = {
  good: 'border-state-ok/30 bg-state-ok/[.13] text-state-ok',
  active: 'border-transparent bg-accent text-paper',
  warning: 'border-state-warn/30 bg-state-warn/[.12] text-state-warn',
  danger: 'border-state-danger/30 bg-state-danger/[.13] text-state-danger',
  neutral: 'border-white/20 bg-transparent text-mid',
};

export default function StatusBadge({ tone, children }: StatusBadgeProps) {
  return <span className={`csn-pill ${toneClasses[tone]}`}>{children}</span>;
}

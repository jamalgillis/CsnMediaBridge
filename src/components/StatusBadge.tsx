interface StatusBadgeProps {
  tone: 'good' | 'active' | 'warning' | 'danger' | 'neutral';
  children: string;
}

/**
 * Spool's status pill. Color carries meaning here: green is posted/done, amber
 * is processing, teal is queued/active, red is failure.
 */
const toneClasses: Record<StatusBadgeProps['tone'], string> = {
  good: 'border-state-posted/30 bg-state-posted/[.13] text-state-posted',
  active: 'border-primary-500/40 bg-primary-500/[.16] text-primary-200',
  warning: 'border-state-processing/30 bg-state-processing/[.12] text-state-processing',
  danger: 'border-state-danger/30 bg-state-danger/[.13] text-state-danger',
  neutral: 'border-surface-hairline-strong bg-white/[.05] text-ink-muted',
};

export default function StatusBadge({ tone, children }: StatusBadgeProps) {
  return <span className={`spool-pill ${toneClasses[tone]}`}>{children}</span>;
}

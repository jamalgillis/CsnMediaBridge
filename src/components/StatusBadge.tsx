interface StatusBadgeProps {
  tone: 'good' | 'active' | 'warning' | 'danger' | 'neutral';
  children: string;
}

const toneClasses: Record<StatusBadgeProps['tone'], string> = {
  good: 'border-secondary-400/20 bg-secondary-400/10 text-secondary-700 dark:text-secondary-300',
  active: 'border-primary-400/20 bg-primary-400/10 text-primary-700 dark:text-primary-300',
  warning: 'border-amber-400/20 bg-amber-400/10 text-amber-700 dark:text-amber-300',
  danger: 'border-red-400/20 bg-red-400/10 text-red-700 dark:text-red-300',
  neutral:
    'border-surface-light-border bg-surface-light-elevated text-slate-500 dark:border-surface-border dark:bg-surface-elevated dark:text-slate-400',
};

export default function StatusBadge({ tone, children }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-widest ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}

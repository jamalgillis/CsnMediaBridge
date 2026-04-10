interface ProgressBarProps {
  label: string;
  value: number;
  variant: 'primary' | 'secondary';
}

export default function ProgressBar({ label, value, variant }: ProgressBarProps) {
  const barColor =
    variant === 'primary'
      ? 'bg-primary-400'
      : 'bg-secondary-400';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium uppercase tracking-widest text-slate-400 dark:text-slate-500">
          {label}
        </span>
        <span className="font-semibold text-slate-700 dark:text-slate-100">
          {Math.round(value)}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-surface-elevated">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

interface ProgressBarProps {
  label: string;
  value: number;
  variant: 'primary' | 'secondary';
}

export default function ProgressBar({ label, value, variant }: ProgressBarProps) {
  const barColor = variant === 'primary' ? 'bg-accent' : 'bg-state-ok';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-condensed text-overline uppercase text-dim">{label}</span>
        <span className="font-mono text-count font-semibold text-body">
          {Math.round(value)}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-[4px] bg-white/[.08]">
        <div
          className={`h-full rounded-[4px] transition-all duration-500 ${barColor}`}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

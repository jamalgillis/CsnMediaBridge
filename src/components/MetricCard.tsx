import type { ReactNode } from 'react';
import GlassCard from './GlassCard';

interface MetricCardProps {
  label: string;
  value: string;
  detail: string;
  accent: ReactNode;
}

export default function MetricCard({ label, value, detail, accent }: MetricCardProps) {
  return (
    <GlassCard className="overflow-hidden">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-slate-400 dark:text-slate-500">
            {label}
          </p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 dark:text-white">
            {value}
          </p>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{detail}</p>
        </div>
        <div className="rounded-widget border border-surface-light-border bg-primary-400/10 p-3 text-primary-500 dark:border-surface-border dark:text-primary-400">
          {accent}
        </div>
      </div>
    </GlassCard>
  );
}

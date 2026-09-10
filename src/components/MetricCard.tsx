import type { ReactNode } from 'react';

interface MetricCardProps {
  label: string;
  value: string;
  detail: string;
  accent: ReactNode;
}

/**
 * The site's stat block, boxed: an Anton value over a condensed uppercase key.
 * Numerals are tabular so a row of these does not jitter as counts tick.
 */
export default function MetricCard({ label, value, detail, accent }: MetricCardProps) {
  return (
    <div className="csn-card overflow-hidden p-[18px]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-condensed text-overline uppercase text-muted">{label}</p>
          <p className="mt-1.5 truncate font-display text-[30px] leading-none tabular-nums text-paper">
            {value}
          </p>
          <p className="mt-2.5 text-caption leading-relaxed text-muted">{detail}</p>
        </div>
        <div className="flex-none rounded-[4px] bg-accent/[.14] p-2.5 text-accent-hi">{accent}</div>
      </div>
    </div>
  );
}

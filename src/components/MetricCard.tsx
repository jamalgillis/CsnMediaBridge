import type { ReactNode } from 'react';

interface MetricCardProps {
  label: string;
  value: string;
  detail: string;
  accent: ReactNode;
}

export default function MetricCard({ label, value, detail, accent }: MetricCardProps) {
  // Spool runs every count, size and timecode in mono; words stay in the UI face.
  const isNumeric = /^[\d.,:%\s/]+$/.test(value);

  return (
    <div className="spool-card overflow-hidden p-[18px]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-overline uppercase text-ink-dim">{label}</p>
          {/* Metric values read as machine output, so they run in mono. */}
          <p
            className={`mt-2.5 truncate text-[26px] font-semibold tracking-[-.02em] text-ink ${
              isNumeric ? 'font-mono' : ''
            }`}
          >
            {value}
          </p>
          <p className="mt-2 text-caption leading-relaxed text-ink-muted">{detail}</p>
        </div>
        <div className="flex-none rounded-control bg-primary-500/[.13] p-2.5 text-primary-200">
          {accent}
        </div>
      </div>
    </div>
  );
}

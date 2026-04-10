interface DonutSegment {
  label: string;
  value: number;
  colorClass: string;
  strokeColor: string;
}

interface DonutChartProps {
  segments: DonutSegment[];
  centerLabel: string;
  centerValue: string;
  size?: number;
}

const RADIUS = 40;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function DonutChart({
  segments,
  centerLabel,
  centerValue,
  size = 160,
}: DonutChartProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  let cumulativeOffset = 0;

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          viewBox="0 0 100 100"
          className="h-full w-full -rotate-90"
        >
          {/* Background ring */}
          <circle
            cx="50"
            cy="50"
            r={RADIUS}
            fill="none"
            strokeWidth="8"
            className="stroke-slate-200 dark:stroke-surface-elevated"
          />
          {/* Segments */}
          {segments.map((segment) => {
            const pct = total > 0 ? segment.value / total : 0;
            const dashLength = pct * CIRCUMFERENCE;
            const dashOffset = cumulativeOffset * CIRCUMFERENCE;
            cumulativeOffset += pct;

            return (
              <circle
                key={segment.label}
                cx="50"
                cy="50"
                r={RADIUS}
                fill="none"
                strokeWidth="8"
                strokeLinecap="round"
                stroke={segment.strokeColor}
                strokeDasharray={`${dashLength} ${CIRCUMFERENCE - dashLength}`}
                strokeDashoffset={-dashOffset}
                className="transition-all duration-700"
              />
            );
          })}
        </svg>
        {/* Center text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-slate-900 dark:text-white">{centerValue}</span>
          <span className="text-xs font-medium text-slate-400 dark:text-slate-500">{centerLabel}</span>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
        {segments.map((segment) => {
          const pct = total > 0 ? Math.round((segment.value / total) * 100) : 0;
          return (
            <div key={segment.label} className="flex items-center gap-1.5 text-xs">
              <span className={`inline-block h-2 w-2 rounded-full ${segment.colorClass}`} />
              <span className="text-slate-500 dark:text-slate-400">
                {pct}% {segment.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

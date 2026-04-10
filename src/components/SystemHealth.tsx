import GlassCard from './GlassCard';
import StatusBadge from './StatusBadge';
import DonutChart from './DonutChart';
import { useBridge } from '../context/BridgeContext';

const resourceSegments = [
  { label: 'Encode', value: 55, colorClass: 'bg-primary-400', strokeColor: '#22d3ee' },
  { label: 'Upload', value: 35, colorClass: 'bg-secondary-400', strokeColor: '#34d399' },
  { label: 'Idle', value: 10, colorClass: 'bg-slate-400', strokeColor: '#94a3b8' },
];

export default function SystemHealth() {
  const { state, settings, refreshSystem } = useBridge();

  const configChecks = [
    {
      label: 'Folders',
      ready: Boolean(settings.watchFolder && settings.tempOutputPath),
      detail: settings.watchFolder || 'Watch folder missing',
    },
    {
      label: 'Backblaze B2',
      ready: Boolean(settings.b2.bucket && settings.b2.keyId && settings.b2.applicationKey),
      detail: settings.b2.bucket || 'Archive bucket missing',
    },
    {
      label: 'Cloudflare R2',
      ready: Boolean(
        settings.r2.accountId &&
          settings.r2.bucket &&
          settings.r2.accessKeyId &&
          settings.r2.secretAccessKey &&
          settings.r2.publicBaseUrl,
      ),
      detail: settings.r2.bucket || 'Distribution bucket missing',
    },
    {
      label: 'Convex',
      ready: Boolean(settings.convex.deploymentUrl && settings.convex.mutationPath),
      detail: settings.convex.mutationPath || 'Mutation path missing',
    },
  ];

  const binaryChecks = [
    {
      label: 'FFmpeg',
      ready: state.system.ffmpegAvailable,
      detail: state.system.ffmpegAvailable ? 'Detected on PATH' : 'Not detected',
    },
    {
      label: 'FFprobe',
      ready: state.system.ffprobeAvailable,
      detail: state.system.ffprobeAvailable ? 'Detected on PATH' : 'Not detected',
    },
    {
      label: 'Rclone',
      ready: state.system.rcloneAvailable,
      detail: state.system.rcloneAvailable ? 'Detected on PATH' : 'Not detected',
    },
  ];

  const serviceChecks = [
    {
      label: 'Internet',
      ready: state.system.internetReachable,
      detail:
        state.system.internetReachable === null
          ? 'Heartbeat pending'
          : state.system.internetReachable
            ? 'Cloud path reachable'
            : 'Offline or DNS unavailable',
    },
    {
      label: 'Watcher Heartbeat',
      ready: state.system.watcherHealthy,
      detail: state.isWatching
        ? state.system.watcherHealthy
          ? 'Watcher active and healthy'
          : 'Watcher needs attention'
        : 'Watcher is currently stopped',
    },
  ];

  return (
    <GlassCard className="col-span-full xl:col-span-4">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">System Health</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Resource allocation and pipeline readiness.
          </p>
        </div>
        <button
          onClick={() => void refreshSystem()}
          className="rounded-widget border border-surface-light-border bg-surface-light-elevated
            px-3 py-2 text-xs font-semibold uppercase tracking-widest text-slate-600
            transition hover:bg-slate-200
            dark:border-surface-border dark:bg-surface-elevated dark:text-slate-200
            dark:hover:bg-surface-card"
        >
          Refresh
        </button>
      </div>

      {/* Donut chart */}
      <div className="mb-6">
        <DonutChart
          segments={resourceSegments}
          centerLabel="Allocation"
          centerValue="100%"
          size={160}
        />
      </div>

      <div className="space-y-5">
        {/* Runtime checks */}
        <div>
          <p className="mb-3 text-xs font-medium uppercase tracking-widest text-slate-400 dark:text-slate-500">
            Runtime
          </p>
          <div className="space-y-3">
            {binaryChecks.map((item) => (
              <div
                key={item.label}
                className="rounded-widget border border-surface-light-border bg-surface-light-elevated p-4
                  dark:border-surface-border dark:bg-surface-deep"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-800 dark:text-white">{item.label}</p>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{item.detail}</p>
                  </div>
                  <StatusBadge tone={item.ready ? 'good' : 'danger'}>
                    {item.ready ? 'Ready' : 'Missing'}
                  </StatusBadge>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Config checks */}
        <div>
          <p className="mb-3 text-xs font-medium uppercase tracking-widest text-slate-400 dark:text-slate-500">
            Configuration
          </p>
          <div className="space-y-3">
            {configChecks.map((item) => (
              <div
                key={item.label}
                className="rounded-widget border border-surface-light-border bg-surface-light-elevated p-4
                  dark:border-surface-border dark:bg-surface-deep"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-800 dark:text-white">{item.label}</p>
                    <p className="mt-1 truncate text-sm text-slate-500 dark:text-slate-400">
                      {item.detail}
                    </p>
                  </div>
                  <StatusBadge tone={item.ready ? 'good' : 'warning'}>
                    {item.ready ? 'Configured' : 'Needs Input'}
                  </StatusBadge>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-3 text-xs font-medium uppercase tracking-widest text-slate-400 dark:text-slate-500">
            Service Status
          </p>
          <div className="space-y-3">
            {serviceChecks.map((item) => (
              <div
                key={item.label}
                className="rounded-widget border border-surface-light-border bg-surface-light-elevated p-4
                  dark:border-surface-border dark:bg-surface-deep"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-800 dark:text-white">{item.label}</p>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{item.detail}</p>
                  </div>
                  <StatusBadge
                    tone={
                      item.ready === null ? 'warning' : item.ready ? 'good' : 'danger'
                    }
                  >
                    {item.ready === null ? 'Pending' : item.ready ? 'Healthy' : 'Issue'}
                  </StatusBadge>
                </div>
              </div>
            ))}
          </div>
        </div>

        {state.system.notes.length > 0 && (
          <div className="rounded-widget border border-amber-400/20 bg-amber-400/10 p-4 text-sm text-amber-700 dark:text-amber-200">
            {state.system.notes.join(' ')}
          </div>
        )}
      </div>
    </GlassCard>
  );
}

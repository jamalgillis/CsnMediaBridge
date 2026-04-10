import GlassCard from './GlassCard';
import JobCard from './JobCard';
import StatusBadge from './StatusBadge';
import { useBridge } from '../context/BridgeContext';

export default function JobMonitor() {
  const { state, retryJob } = useBridge();
  const activeJobs = state.jobs.filter((job) => !['complete', 'error'].includes(job.status));
  const completedCount = state.jobs.filter((job) => job.status === 'complete').length;

  return (
    <GlassCard className="col-span-full xl:col-span-8">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">Universal VOD Queue</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {activeJobs.length} active jobs, {completedCount} completed this session, queue depth{' '}
            {state.queueDepth}.
          </p>
        </div>
        {state.activeEncodingJobId ? (
          <StatusBadge tone="active">Encoder Busy</StatusBadge>
        ) : (
          <StatusBadge tone="good">Encoder Idle</StatusBadge>
        )}
      </div>

      <div className="space-y-3">
        {state.jobs.length === 0 ? (
          <div
            className="rounded-widget border border-dashed border-surface-light-border bg-surface-light-elevated
              p-10 text-center text-sm text-slate-400
              dark:border-surface-border dark:bg-surface-deep dark:text-slate-500"
          >
            New MP4, MOV, and MKV files dropped into the ingest folder will appear here once the
            watcher is running.
          </div>
        ) : (
          state.jobs.map((job) => <JobCard key={job.id} job={job} onRetry={retryJob} />)
        )}
      </div>
    </GlassCard>
  );
}

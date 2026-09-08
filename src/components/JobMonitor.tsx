import GlassCard from './GlassCard';
import JobCard from './JobCard';
import StatusBadge from './StatusBadge';
import { useBridge } from '../context/BridgeContext';

export default function JobMonitor() {
  const { state } = useBridge();
  const activeJobs = state.jobs.filter((job) => !['complete', 'error'].includes(job.status));
  const completedCount = state.jobs.filter((job) => job.status === 'complete').length;

  return (
    <GlassCard className="col-span-full xl:col-span-8">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-section text-ink">Universal VOD Queue</h2>
          <p className="mt-1 text-sm text-ink-muted">
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
            className="rounded-control border p-10 text-center text-sm border-surface-hairline bg-surface-canvas text-ink-dim"
          >
            Manual intake and watched-folder jobs will appear here once they enter the queue.
          </div>
        ) : (
          state.jobs.map((job) => <JobCard key={job.id} job={job} />)
        )}
      </div>
    </GlassCard>
  );
}

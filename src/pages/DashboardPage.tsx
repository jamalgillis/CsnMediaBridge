import JobMonitor from '../components/JobMonitor';
import SystemHealth from '../components/SystemHealth';
import LogConsole from '../components/LogConsole';
import MetricCard from '../components/MetricCard';
import GlassCard from '../components/GlassCard';
import ManualIntakePanel from '../components/ManualIntakePanel';
import LiveStreamHandoffPanel from '../components/LiveStreamHandoffPanel';
import { useBridge } from '../context/BridgeContext';

export default function DashboardPage() {
  const { state, actionError, clearActionError } = useBridge();
  const completedJobs = state.jobs.filter((job) => job.status === 'complete').length;
  const failedJobs = state.jobs.filter((job) => job.status === 'error').length;
  const latestJob = state.jobs[0];

  return (
    <div className="px-6 pb-11 pt-[22px]">
      <div className="mb-5">
        <h1 className="font-display text-page text-paper">Operations</h1>
        <p className="mt-1 text-control text-muted">
          Watcher, ingest queue, and system health for this workstation.
        </p>
      </div>

      <div className="space-y-5">
      {actionError && (
        <GlassCard className="border-state-danger/30 bg-state-danger/[.12]">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="font-condensed text-overline uppercase text-state-danger">Attention</p>
              <p className="mt-2 text-copy text-state-danger">{actionError}</p>
            </div>
            <button
              onClick={clearActionError}
              className="csn-btn-danger h-9"
            >
              Dismiss
            </button>
          </div>
        </GlassCard>
      )}

      {/* Metric cards - 4-column grid */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Watcher"
          value={state.isWatching ? 'Live' : 'Paused'}
          detail={
            state.isWatching
              ? 'Monitoring the ingest folder for new MP4, MOV, or MKV files.'
              : 'Start the watcher to resume automatic ingest.'
          }
          accent={
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 17l6-6 4 4 8-8" />
            </svg>
          }
        />
        <MetricCard
          label="Queue Depth"
          value={String(state.queueDepth)}
          detail={
            state.activeEncodingJobId
              ? 'FFmpeg is actively encoding a job.'
              : 'No active encode at the moment.'
          }
          accent={
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12m-12 5.25h12m-12 5.25h12M3.75 6.75h.008v.008H3.75V6.75zm0 5.25h.008v.008H3.75V12zm0 5.25h.008v.008H3.75v-.008z" />
            </svg>
          }
        />
        <MetricCard
          label="Completed"
          value={String(completedJobs)}
          detail="Successful archive, distribution, and Convex registrations in this session."
          accent={
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          }
        />
        <MetricCard
          label="Last Intake"
          value={latestJob ? latestJob.sourceName.slice(0, 14) : 'None'}
          detail={
            failedJobs > 0
              ? `${failedJobs} failed jobs need review.`
              : 'No failed jobs recorded in this session.'
          }
          accent={
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2.25M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
      </div>

      {/* Main content - 12-col grid */}
      <div className="grid gap-5 xl:grid-cols-12">
        <ManualIntakePanel />
        <JobMonitor />
        <LiveStreamHandoffPanel />
        <SystemHealth />
      </div>

      {/* Log Console */}
      <LogConsole />
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import GlassCard from './GlassCard';
import StatusBadge from './StatusBadge';
import type { LiveStreamHandoffJobSnapshot } from '../shared/types';

function getStatusTone(status: LiveStreamHandoffJobSnapshot['status']) {
  if (status === 'completed') return 'good';
  if (status === 'failed' || status === 'canceled') return 'danger';
  if (status === 'pending') return 'warning';
  return 'active';
}

function formatJobTitle(job: LiveStreamHandoffJobSnapshot) {
  return job.eventName || job.projectName || job.providerVideoId;
}

function formatTime(value: string | undefined) {
  if (!value) {
    return 'Not recorded';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

export default function LiveStreamHandoffPanel() {
  const [jobs, setJobs] = useState<LiveStreamHandoffJobSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isWaking, setIsWaking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshJobs() {
    const nextJobs = await window.mediaBridge.listLiveStreamHandoffJobs();
    setJobs(nextJobs);
  }

  useEffect(() => {
    let isMounted = true;

    void refreshJobs()
      .catch((loadError) => {
        if (!isMounted) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    const unsubscribe = window.mediaBridge.onLiveStreamHandoffUpdate((nextJobs) => {
      setJobs(nextJobs);
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  async function handleWakeWorker() {
    setIsWaking(true);
    setError(null);
    setMessage(null);

    try {
      const result = await window.mediaBridge.wakeLiveStreamHandoffWorker();
      setMessage(result.message ?? (result.claimedJobId ? `Claimed ${result.claimedJobId}.` : 'Worker checked the queue.'));
      await refreshJobs();
    } catch (wakeError) {
      setError(wakeError instanceof Error ? wakeError.message : String(wakeError));
    } finally {
      setIsWaking(false);
    }
  }

  const activeJobs = jobs.filter((job) => !['completed', 'failed', 'canceled'].includes(job.status));

  return (
    <GlassCard className="col-span-full xl:col-span-8">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="font-display text-section text-paper">Live Handoff</h2>
          <p className="mt-1 text-sm text-muted">
            {activeJobs.length} active stream recordings, {jobs.length} recent jobs.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleWakeWorker()}
          disabled={isWaking}
          className="rounded-control border px-4 py-2 font-condensed text-overline uppercase transition disabled:cursor-not-allowed disabled:opacity-60 border-rule bg-ink-chip text-body hover:bg-ink-panel"
        >
          {isWaking ? 'Checking' : 'Wake Worker'}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-control border p-4 text-sm border-state-danger/30 bg-state-danger/[.12] text-state-danger">
          {error}
        </div>
      )}

      {message && (
        <div className="mb-4 rounded-control border p-4 text-sm border-rule bg-ink text-muted">
          {message}
        </div>
      )}

      {isLoading ? (
        <div className="rounded-control border p-8 text-center text-sm border-rule bg-ink text-dim">
          Loading live handoff queue.
        </div>
      ) : jobs.length === 0 ? (
        <div className="rounded-control border p-8 text-center text-sm border-rule bg-ink text-dim">
          Cloudflare Stream handoff jobs will appear here after the Convex queue is connected.
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <div
              key={job._id}
              className="rounded-control border p-4 border-rule bg-ink"
            >
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <p className="truncate font-medium text-paper">{formatJobTitle(job)}</p>
                  <p className="mt-1 text-sm text-muted">
                    {job.providerVideoId} / {formatTime(job.recordedAt ?? job.createdAt)}
                  </p>
                  {job.message && (
                    <p className="mt-2 text-sm text-muted">{job.message}</p>
                  )}
                </div>
                <StatusBadge tone={getStatusTone(job.status)}>
                  {job.status}
                </StatusBadge>
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-ink-panel">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${Math.max(0, Math.min(100, job.progress ?? 0))}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </GlassCard>
  );
}

import { useEffect, useState } from 'react';
import type { LiveStreamHandoffJobSnapshot } from '../shared/types';

/**
 * The live-stream handoff queue, kept in step with the main process.
 *
 * Both the rail (which shows an attention dot when a handoff has failed) and
 * the Live streams screen read the same list, so the subscription lives here
 * rather than in either of them.
 */
export function useLiveStreamJobs() {
  const [jobs, setJobs] = useState<LiveStreamHandoffJobSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    void window.mediaBridge
      .listLiveStreamHandoffJobs()
      .then((next) => {
        if (isMounted) {
          setJobs(next);
        }
      })
      .catch((loadError: unknown) => {
        if (isMounted) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    const unsubscribe = window.mediaBridge.onLiveStreamHandoffUpdate((next) => setJobs(next));

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  return { jobs, isLoading, error };
}

/**
 * What on this screen needs a person: a conversion that stopped short, or a
 * recording nobody can convert until it is assigned to a client.
 */
export function hasLiveStreamAttention(jobs: LiveStreamHandoffJobSnapshot[]) {
  return jobs.some((job) => job.status === 'failed' || job.status === 'needs_client');
}

/** Whether Convert can be offered: waiting, or stopped with attempts left. */
export function canConvert(job: LiveStreamHandoffJobSnapshot) {
  return job.status === 'pending' || (job.status === 'failed' && job.attempts < job.maxAttempts);
}

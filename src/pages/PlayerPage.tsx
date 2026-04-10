import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import GlassCard from '../components/GlassCard';
import StatusBadge from '../components/StatusBadge';
import StoredVideoPlayer from '../components/StoredVideoPlayer';
import { useBridge } from '../context/BridgeContext';
import {
  getManifestUrl,
  getPrimaryPlaybackUrl,
  inferStoredContentType,
  inferStoredDeliveryType,
} from '../shared/media';
import type { StoredVideoSnapshot } from '../shared/types';

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function formatDuration(durationSeconds: number) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 'Duration pending';
  }

  const totalSeconds = Math.round(durationSeconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDate(value: string | undefined) {
  if (!value) {
    return 'Unknown date';
  }

  return new Date(value).toLocaleString();
}

function formatResolution(video: StoredVideoSnapshot) {
  if (!video.sourceWidth || !video.sourceHeight) {
    return 'Resolution pending';
  }

  return `${video.sourceWidth}x${video.sourceHeight}`;
}

function isPlayableVideo(video: StoredVideoSnapshot) {
  return (
    video.status === 'ready' &&
    Boolean(getManifestUrl(video) || getPrimaryPlaybackUrl(video))
  );
}

export default function PlayerPage() {
  const { settings, state } = useBridge();
  const [videos, setVideos] = useState<StoredVideoSnapshot[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRepairingUrls, setIsRepairingUrls] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const hasConvexConfig = Boolean(settings.convex.deploymentUrl && settings.convex.mutationPath);

  useEffect(() => {
    let isMounted = true;

    if (!hasConvexConfig) {
      setVideos([]);
      setSelectedVideoId(null);
      setLoadError(null);
      return () => {
        isMounted = false;
      };
    }

    setIsLoading(true);
    setLoadError(null);

    void window.mediaBridge
      .listStoredVideos()
      .then((storedVideos) => {
        if (!isMounted) {
          return;
        }

        const playableVideos = storedVideos.filter(isPlayableVideo);
        setVideos(playableVideos);
        setSelectedVideoId((currentVideoId) =>
          playableVideos.some((video) => video._id === currentVideoId)
            ? currentVideoId
            : (playableVideos[0]?._id ?? null),
        );
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }

        setVideos([]);
        setSelectedVideoId(null);
        setLoadError(getErrorMessage(error));
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [hasConvexConfig, refreshKey]);

  const selectedVideo = videos.find((video) => video._id === selectedVideoId) ?? videos[0] ?? null;
  const completedJobs = state.jobs.filter((job) => job.status === 'complete').length;

  async function handleRepairStoredUrls() {
    setIsRepairingUrls(true);
    setLoadError(null);
    setLibraryNotice(null);

    try {
      const result = await window.mediaBridge.repairStoredVideoUrls();
      setLibraryNotice(
        result.updated > 0
          ? `Repaired ${result.updated} stored video URL${result.updated === 1 ? '' : 's'} and refreshed the library.`
          : `No stored URLs needed repair. Checked ${result.inspected} video${result.inspected === 1 ? '' : 's'}.`,
      );
      setRefreshKey((current) => current + 1);
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setIsRepairingUrls(false);
    }
  }

  return (
    <div className="space-y-6">
      <GlassCard className="overflow-hidden bg-gradient-to-br from-primary-400/12 via-white to-secondary-400/10 dark:from-primary-400/10 dark:via-surface-card dark:to-secondary-400/10">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-primary-500 dark:text-primary-300">
              Stored Library
            </p>
            <h1 className="mt-3 text-3xl font-bold text-slate-900 dark:text-white">
              Preview ready HLS uploads without leaving the bridge.
            </h1>
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
              This view pulls your latest ready videos from Convex and plays the stored master
              playlist or progressive clip directly from storage. It is ideal for spot-checking
              poster frames, playback behavior, and metadata after ingest completes.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge tone="good">{`${videos.length} Ready`}</StatusBadge>
            <StatusBadge tone="active">{`${completedJobs} Session Complete`}</StatusBadge>
            <button
              onClick={() => setRefreshKey((current) => current + 1)}
              className="rounded-widget border border-primary-400/20 bg-primary-400/10 px-4 py-2
                text-xs font-semibold uppercase tracking-widest text-primary-700
                transition hover:bg-primary-400/15
                dark:text-primary-300"
              type="button"
            >
              Refresh Library
            </button>
            <button
              onClick={() => void handleRepairStoredUrls()}
              className="rounded-widget border border-secondary-400/20 bg-secondary-400/10 px-4 py-2
                text-xs font-semibold uppercase tracking-widest text-secondary-700
                transition hover:bg-secondary-400/15
                disabled:cursor-not-allowed disabled:opacity-60
                dark:text-secondary-300"
              disabled={!hasConvexConfig || isRepairingUrls}
              type="button"
            >
              {isRepairingUrls ? 'Repairing URLs...' : 'Repair Stored URLs'}
            </button>
          </div>
        </div>
        {(libraryNotice || loadError) && (
          <div className="mt-4 space-y-2">
            {libraryNotice && (
              <p className="text-sm text-secondary-700 dark:text-secondary-300">{libraryNotice}</p>
            )}
            {loadError && (
              <p className="text-sm text-red-600 dark:text-red-300">{loadError}</p>
            )}
          </div>
        )}
      </GlassCard>

      <div className="grid gap-6 xl:grid-cols-12">
        <GlassCard className="xl:col-span-8" padded={false}>
          {selectedVideo ? (
            <>
              <StoredVideoPlayer video={selectedVideo} />
              <div className="space-y-4 p-6">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500">
                      Now Previewing
                    </p>
                    <h2 className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">
                      {selectedVideo.title}
                    </h2>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Source file: {selectedVideo.sourceFileName}
                    </p>
                  </div>
                  <StatusBadge tone="good">Ready</StatusBadge>
                </div>

                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full bg-surface-light-elevated px-3 py-1 text-xs font-semibold uppercase tracking-widest text-slate-500 dark:bg-surface-elevated dark:text-slate-400">
                    {formatDuration(selectedVideo.durationSeconds)}
                  </span>
                  <span className="rounded-full bg-surface-light-elevated px-3 py-1 text-xs font-semibold uppercase tracking-widest text-slate-500 dark:bg-surface-elevated dark:text-slate-400">
                    {formatResolution(selectedVideo)}
                  </span>
                  <span className="rounded-full bg-surface-light-elevated px-3 py-1 text-xs font-semibold uppercase tracking-widest text-slate-500 dark:bg-surface-elevated dark:text-slate-400">
                    {selectedVideo.encoder}
                  </span>
                  <span className="rounded-full bg-surface-light-elevated px-3 py-1 text-xs font-semibold uppercase tracking-widest text-slate-500 dark:bg-surface-elevated dark:text-slate-400">
                    {inferStoredDeliveryType(selectedVideo)}
                  </span>
                  <span className="rounded-full bg-surface-light-elevated px-3 py-1 text-xs font-semibold uppercase tracking-widest text-slate-500 dark:bg-surface-elevated dark:text-slate-400">
                    {inferStoredContentType(selectedVideo)}
                  </span>
                  <span className="rounded-full bg-surface-light-elevated px-3 py-1 text-xs font-semibold uppercase tracking-widest text-slate-500 dark:bg-surface-elevated dark:text-slate-400">
                    Added {formatDate(selectedVideo.createdAt)}
                  </span>
                </div>

                {(selectedVideo.description || selectedVideo.series || selectedVideo.tags.length > 0) && (
                  <div className="space-y-3 border-t border-surface-light-border pt-4 dark:border-surface-border">
                    {selectedVideo.description && (
                      <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">
                        {selectedVideo.description}
                      </p>
                    )}

                    <div className="flex flex-wrap gap-2 text-xs uppercase tracking-widest text-slate-400 dark:text-slate-500">
                      {selectedVideo.series && (
                        <span className="rounded-full border border-surface-light-border px-3 py-1 dark:border-surface-border">
                          Series: {selectedVideo.series}
                        </span>
                      )}
                      {selectedVideo.recordedAt && (
                        <span className="rounded-full border border-surface-light-border px-3 py-1 dark:border-surface-border">
                          Recorded: {formatDate(selectedVideo.recordedAt)}
                        </span>
                      )}
                      {selectedVideo.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full border border-surface-light-border px-3 py-1 dark:border-surface-border"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div
              className="flex min-h-[32rem] flex-col items-center justify-center gap-4 p-10 text-center"
            >
              <div className="max-w-md">
                <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
                  {hasConvexConfig ? 'No ready stored videos yet' : 'Convex connection needed'}
                </h2>
                <p className="mt-3 text-sm leading-6 text-slate-500 dark:text-slate-400">
                  {hasConvexConfig
                    ? 'Once a video reaches ready status in Convex, it will show up here for playback preview.'
                    : 'Add your Convex deployment URL and mutation path in Settings so the player can load stored content.'}
                </p>
              </div>
              {!hasConvexConfig && (
                <Link
                  to="/settings"
                  className="rounded-widget bg-primary-400 px-4 py-2 text-sm font-semibold text-primary-950 transition hover:bg-primary-300"
                >
                  Open Settings
                </Link>
              )}
            </div>
          )}
        </GlassCard>

        <GlassCard className="xl:col-span-4" padded={false}>
          <div className="border-b border-surface-light-border p-6 dark:border-surface-border">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">Stored Videos</h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  Latest ready assets from Convex.
                </p>
              </div>
              {isLoading && <StatusBadge tone="active">Loading</StatusBadge>}
            </div>
          </div>

          <div className="max-h-[42rem] space-y-2 overflow-y-auto p-3">
            {videos.length === 0 ? (
              <div className="rounded-widget border border-dashed border-surface-light-border p-6 text-sm text-slate-400 dark:border-surface-border dark:text-slate-500">
                The library will populate after your first ready upload syncs to Convex.
              </div>
            ) : (
              videos.map((video) => {
                const isSelected = video._id === selectedVideo?._id;

                return (
                  <button
                    key={video._id}
                    onClick={() => setSelectedVideoId(video._id)}
                    type="button"
                    className={`w-full rounded-widget border p-4 text-left transition ${
                      isSelected
                        ? 'border-primary-400/40 bg-primary-400/10 shadow-glow-light dark:border-primary-400/30 dark:bg-primary-400/10'
                        : 'border-surface-light-border bg-surface-light-elevated hover:border-primary-400/20 hover:bg-primary-400/5 dark:border-surface-border dark:bg-surface-elevated dark:hover:border-primary-400/20 dark:hover:bg-primary-400/5'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                          {video.title}
                        </p>
                        <p className="mt-1 truncate text-xs uppercase tracking-widest text-slate-400 dark:text-slate-500">
                          {video.sourceFileName}
                        </p>
                      </div>
                      <StatusBadge tone="good">Ready</StatusBadge>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-widest text-slate-400 dark:text-slate-500">
                      <span>{formatDuration(video.durationSeconds)}</span>
                      <span>/</span>
                      <span>{formatResolution(video)}</span>
                      <span>/</span>
                      <span>{formatDate(video.createdAt)}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

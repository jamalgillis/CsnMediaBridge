import { useEffect, useRef, useState } from 'react';
import GlassCard from '../components/GlassCard';
import StatusBadge from '../components/StatusBadge';
import TrimVideoPlayer from '../components/TrimVideoPlayer';
import { useBridge } from '../context/BridgeContext';
import type { LocalTrimSourceSnapshot, TrimClipResult } from '../shared/types';

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function clampSeconds(value: number, duration: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(duration, Math.max(0, value));
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return '0:00.00';
  }

  const totalHundredths = Math.round(value * 100);
  const wholeSeconds = Math.floor(totalHundredths / 100);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  const hundredths = totalHundredths % 100;

  const timecode = `${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${timecode}`;
  }

  return `${minutes}:${timecode}`;
}

function formatFileSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 'Unknown size';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let currentValue = value;
  let unitIndex = 0;

  while (currentValue >= 1024 && unitIndex < units.length - 1) {
    currentValue /= 1024;
    unitIndex += 1;
  }

  const precision = currentValue >= 100 || unitIndex === 0 ? 0 : 1;
  return `${currentValue.toFixed(precision)} ${units[unitIndex]}`;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function getPercent(value: number, duration: number) {
  if (!Number.isFinite(value) || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, (value / duration) * 100));
}

export default function TrimmerPage() {
  const { state } = useBridge();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [source, setSource] = useState<LocalTrimSourceSnapshot | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [inPointSeconds, setInPointSeconds] = useState(0);
  const [outPointSeconds, setOutPointSeconds] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPickingSource, setIsPickingSource] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [lastExport, setLastExport] = useState<TrimClipResult | null>(null);

  const selectionDurationSeconds = Math.max(0, outPointSeconds - inPointSeconds);
  const hasValidSelection = Boolean(source) && selectionDurationSeconds >= 0.1;
  const selectionLeftPercent = getPercent(inPointSeconds, durationSeconds);
  const selectionWidthPercent = getPercent(selectionDurationSeconds, durationSeconds);
  const playheadPercent = getPercent(currentTimeSeconds, durationSeconds);

  useEffect(() => {
    if (!source) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)
      ) {
        return;
      }

      const video = videoRef.current;
      if (!video) {
        return;
      }

      if (event.code === 'Space') {
        event.preventDefault();
        if (video.paused) {
          void video.play();
        } else {
          video.pause();
        }
        return;
      }

      if (event.code === 'KeyI') {
        event.preventDefault();
        const nextInPoint = clampSeconds(video.currentTime, durationSeconds);
        setInPointSeconds(nextInPoint);
        if (nextInPoint > outPointSeconds) {
          setOutPointSeconds(nextInPoint);
        }
        return;
      }

      if (event.code === 'KeyO') {
        event.preventDefault();
        const nextOutPoint = clampSeconds(video.currentTime, durationSeconds);
        setOutPointSeconds(nextOutPoint);
        if (nextOutPoint < inPointSeconds) {
          setInPointSeconds(nextOutPoint);
        }
        return;
      }

      if (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight') {
        return;
      }

      event.preventDefault();
      const nudgeAmount = event.shiftKey ? 1 / 30 : 1;
      const direction = event.code === 'ArrowRight' ? 1 : -1;
      const nextTime = clampSeconds(video.currentTime + direction * nudgeAmount, durationSeconds);
      video.currentTime = nextTime;
      setCurrentTimeSeconds(nextTime);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [durationSeconds, inPointSeconds, outPointSeconds, source]);

  async function handleChooseSource() {
    setIsPickingSource(true);
    setPageError(null);
    setExportNotice(null);

    try {
      const nextSource = await window.mediaBridge.chooseTrimSource();
      if (!nextSource) {
        return;
      }

      setSource(nextSource);
      setDurationSeconds(0);
      setCurrentTimeSeconds(0);
      setInPointSeconds(0);
      setOutPointSeconds(0);
      setIsPlaying(false);
      setLastExport(null);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsPickingSource(false);
    }
  }

  function jumpToTime(nextTime: number) {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const safeTime = clampSeconds(nextTime, durationSeconds);
    video.currentTime = safeTime;
    setCurrentTimeSeconds(safeTime);
  }

  function handleMarkIn() {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const nextInPoint = clampSeconds(video.currentTime, durationSeconds);
    setInPointSeconds(nextInPoint);
    if (nextInPoint > outPointSeconds) {
      setOutPointSeconds(nextInPoint);
    }
  }

  function handleMarkOut() {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const nextOutPoint = clampSeconds(video.currentTime, durationSeconds);
    setOutPointSeconds(nextOutPoint);
    if (nextOutPoint < inPointSeconds) {
      setInPointSeconds(nextOutPoint);
    }
  }

  function handleLoadedMetadata() {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const nextDuration = Number.isFinite(video.duration) ? video.duration : 0;
    setDurationSeconds(nextDuration);
    setCurrentTimeSeconds(video.currentTime);
    setInPointSeconds(0);
    setOutPointSeconds(nextDuration);
  }

  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const nextCurrentTime = clampSeconds(video.currentTime, durationSeconds || video.duration || 0);
    if (!video.paused && outPointSeconds > inPointSeconds && nextCurrentTime >= outPointSeconds) {
      video.pause();
      video.currentTime = outPointSeconds;
      setCurrentTimeSeconds(outPointSeconds);
      return;
    }

    setCurrentTimeSeconds(nextCurrentTime);
  }

  function handleInPointChange(rawValue: number) {
    const nextInPoint = clampSeconds(rawValue, durationSeconds);
    setInPointSeconds(nextInPoint);
    if (nextInPoint > outPointSeconds) {
      setOutPointSeconds(nextInPoint);
    }
  }

  function handleOutPointChange(rawValue: number) {
    const nextOutPoint = clampSeconds(rawValue, durationSeconds);
    setOutPointSeconds(nextOutPoint);
    if (nextOutPoint < inPointSeconds) {
      setInPointSeconds(nextOutPoint);
    }
  }

  async function handleExport() {
    if (!source || !hasValidSelection) {
      return;
    }

    setIsExporting(true);
    setPageError(null);
    setExportNotice(null);

    try {
      const result = await window.mediaBridge.trimClip({
        sourcePath: source.sourcePath,
        inPointSeconds,
        outPointSeconds,
      });

      setLastExport(result);
      if (result.canceled) {
        setExportNotice('Trim export canceled.');
        return;
      }

      setExportNotice(
        `Trim export finished in ${formatTime(result.durationSeconds ?? selectionDurationSeconds)} using ${result.effectiveEncoder}.`,
      );
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <GlassCard className="overflow-hidden bg-gradient-to-br from-secondary-400/12 via-white to-primary-400/10 dark:from-secondary-400/10 dark:via-surface-card dark:to-primary-400/10">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-secondary-500 dark:text-secondary-300">
              Local Trimmer
            </p>
            <h1 className="mt-3 text-3xl font-bold text-slate-900 dark:text-white">
              Mark local clips before they enter the bridge.
            </h1>
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
              Load a local MP4 or MOV file, scrub to your exact in and out points, then export a
              trimmed MP4 for the next ingest step. The preview runs through the Electron main
              process so the renderer can treat local files like normal streamable media.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge tone={state.system.ffmpegAvailable ? 'good' : 'warning'}>
              {state.system.ffmpegAvailable ? 'FFmpeg Ready' : 'FFmpeg Missing'}
            </StatusBadge>
            <StatusBadge tone={isPlaying ? 'active' : 'neutral'}>
              {isPlaying ? 'Playing' : 'Paused'}
            </StatusBadge>
            <button
              onClick={() => void handleChooseSource()}
              className="rounded-widget bg-primary-400 px-4 py-2 text-sm font-semibold text-primary-950 transition hover:bg-primary-300 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isPickingSource || isExporting}
              type="button"
            >
              {isPickingSource ? 'Opening Browser...' : source ? 'Choose Another Clip' : 'Open Local Clip'}
            </button>
          </div>
        </div>

        {(exportNotice || pageError) && (
          <div className="mt-4 space-y-2">
            {exportNotice && (
              <p className="text-sm text-secondary-700 dark:text-secondary-300">{exportNotice}</p>
            )}
            {pageError && <p className="text-sm text-red-600 dark:text-red-300">{pageError}</p>}
          </div>
        )}
      </GlassCard>

      <div className="grid gap-6 xl:grid-cols-12">
        <GlassCard className="xl:col-span-8" padded={false}>
          {source ? (
            <>
              <TrimVideoPlayer
                ref={videoRef}
                onLoadedMetadata={handleLoadedMetadata}
                onPause={() => setIsPlaying(false)}
                onPlay={() => setIsPlaying(true)}
                onTimeUpdate={handleTimeUpdate}
                sourceUrl={source.sourceUrl}
                title={source.sourceFileName}
              />

              <div className="space-y-5 p-6">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500">
                      Active Source
                    </p>
                    <h2 className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">
                      {source.sourceFileName}
                    </h2>
                    <p className="mt-2 break-all text-sm text-slate-500 dark:text-slate-400">
                      {source.sourcePath}
                    </p>
                  </div>
                  <StatusBadge tone="good">Local Preview</StatusBadge>
                </div>

                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full bg-surface-light-elevated px-3 py-1 text-xs font-semibold uppercase tracking-widest text-slate-500 dark:bg-surface-elevated dark:text-slate-400">
                    {formatFileSize(source.fileSizeBytes)}
                  </span>
                  <span className="rounded-full bg-surface-light-elevated px-3 py-1 text-xs font-semibold uppercase tracking-widest text-slate-500 dark:bg-surface-elevated dark:text-slate-400">
                    Modified {formatDate(source.modifiedAt)}
                  </span>
                  <span className="rounded-full bg-surface-light-elevated px-3 py-1 text-xs font-semibold uppercase tracking-widest text-slate-500 dark:bg-surface-elevated dark:text-slate-400">
                    Source Duration {formatTime(durationSeconds)}
                  </span>
                </div>

                <div className="space-y-3 rounded-widget border border-surface-light-border bg-surface-light-elevated p-4 dark:border-surface-border dark:bg-surface-card">
                  <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500">
                    <span>Trim Window</span>
                    <span>Playhead {formatTime(currentTimeSeconds)}</span>
                  </div>
                  <div className="relative h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    <div
                      className="absolute inset-y-0 rounded-full bg-secondary-400/50"
                      style={{
                        left: `${selectionLeftPercent}%`,
                        width: `${selectionWidthPercent}%`,
                      }}
                    />
                    <div
                      className="absolute top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_2px_rgba(15,23,42,0.4)]"
                      style={{ left: `calc(${playheadPercent}% - 2px)` }}
                    />
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-widget border border-surface-light-border bg-white/70 p-3 dark:border-surface-border dark:bg-surface-elevated">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500">
                        In
                      </p>
                      <p className="mt-2 text-xl font-bold text-slate-900 dark:text-white">
                        {formatTime(inPointSeconds)}
                      </p>
                    </div>
                    <div className="rounded-widget border border-surface-light-border bg-white/70 p-3 dark:border-surface-border dark:bg-surface-elevated">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500">
                        Out
                      </p>
                      <p className="mt-2 text-xl font-bold text-slate-900 dark:text-white">
                        {formatTime(outPointSeconds)}
                      </p>
                    </div>
                    <div className="rounded-widget border border-surface-light-border bg-white/70 p-3 dark:border-surface-border dark:bg-surface-elevated">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500">
                        Selection
                      </p>
                      <p className="mt-2 text-xl font-bold text-slate-900 dark:text-white">
                        {formatTime(selectionDurationSeconds)}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex min-h-[32rem] flex-col items-center justify-center gap-4 p-10 text-center">
              <div className="max-w-md">
                <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
                  Load a local clip to start trimming
                </h2>
                <p className="mt-3 text-sm leading-6 text-slate-500 dark:text-slate-400">
                  Start with an MP4 when you can. Chromium-backed playback is happiest there, and
                  the trim export will always write a fresh MP4 for the next stage of the workflow.
                </p>
              </div>
              <button
                onClick={() => void handleChooseSource()}
                className="rounded-widget bg-primary-400 px-4 py-2 text-sm font-semibold text-primary-950 transition hover:bg-primary-300"
                type="button"
              >
                Open Local Clip
              </button>
            </div>
          )}
        </GlassCard>

        <div className="space-y-6 xl:col-span-4">
          <GlassCard>
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">Trim Controls</h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  Mark the range, fine-tune the numbers, then export a clean MP4.
                </p>
              </div>

              <div className="grid gap-3">
                <button
                  onClick={handleMarkIn}
                  className="rounded-widget border border-secondary-400/20 bg-secondary-400/10 px-4 py-3 text-left text-sm font-semibold text-secondary-700 transition hover:bg-secondary-400/15 disabled:cursor-not-allowed disabled:opacity-60 dark:text-secondary-300"
                  disabled={!source}
                  type="button"
                >
                  Mark In at Playhead
                </button>
                <button
                  onClick={handleMarkOut}
                  className="rounded-widget border border-primary-400/20 bg-primary-400/10 px-4 py-3 text-left text-sm font-semibold text-primary-700 transition hover:bg-primary-400/15 disabled:cursor-not-allowed disabled:opacity-60 dark:text-primary-300"
                  disabled={!source}
                  type="button"
                >
                  Mark Out at Playhead
                </button>
              </div>

              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
                <label className="space-y-2 text-sm font-medium text-slate-600 dark:text-slate-300">
                  <span>In Point (seconds)</span>
                  <input
                    className="w-full rounded-widget border border-surface-light-border bg-white px-3 py-2 text-slate-900 outline-none transition focus:border-secondary-400/40 focus:ring-1 focus:ring-secondary-400/20 dark:border-surface-border dark:bg-surface-elevated dark:text-white"
                    disabled={!source}
                    max={durationSeconds || undefined}
                    min={0}
                    onChange={(event) => handleInPointChange(event.target.valueAsNumber)}
                    step="0.01"
                    type="number"
                    value={Number.isFinite(inPointSeconds) ? inPointSeconds : 0}
                  />
                </label>

                <label className="space-y-2 text-sm font-medium text-slate-600 dark:text-slate-300">
                  <span>Out Point (seconds)</span>
                  <input
                    className="w-full rounded-widget border border-surface-light-border bg-white px-3 py-2 text-slate-900 outline-none transition focus:border-primary-400/40 focus:ring-1 focus:ring-primary-400/20 dark:border-surface-border dark:bg-surface-elevated dark:text-white"
                    disabled={!source}
                    max={durationSeconds || undefined}
                    min={0}
                    onChange={(event) => handleOutPointChange(event.target.valueAsNumber)}
                    step="0.01"
                    type="number"
                    value={Number.isFinite(outPointSeconds) ? outPointSeconds : 0}
                  />
                </label>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  onClick={() => jumpToTime(inPointSeconds)}
                  className="rounded-widget border border-surface-light-border px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-secondary-400/30 hover:bg-secondary-400/5 dark:border-surface-border dark:text-slate-300 dark:hover:border-secondary-400/30 dark:hover:bg-secondary-400/5"
                  disabled={!source}
                  type="button"
                >
                  Jump to In
                </button>
                <button
                  onClick={() => jumpToTime(outPointSeconds)}
                  className="rounded-widget border border-surface-light-border px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-primary-400/30 hover:bg-primary-400/5 dark:border-surface-border dark:text-slate-300 dark:hover:border-primary-400/30 dark:hover:bg-primary-400/5"
                  disabled={!source}
                  type="button"
                >
                  Jump to Out
                </button>
                <button
                  onClick={() => jumpToTime(currentTimeSeconds - 1)}
                  className="rounded-widget border border-surface-light-border px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:bg-slate-100 dark:border-surface-border dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-surface-elevated"
                  disabled={!source}
                  type="button"
                >
                  Nudge -1s
                </button>
                <button
                  onClick={() => jumpToTime(currentTimeSeconds + 1)}
                  className="rounded-widget border border-surface-light-border px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:bg-slate-100 dark:border-surface-border dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-surface-elevated"
                  disabled={!source}
                  type="button"
                >
                  Nudge +1s
                </button>
              </div>

              <button
                onClick={() => {
                  setInPointSeconds(0);
                  setOutPointSeconds(durationSeconds);
                  jumpToTime(0);
                }}
                className="rounded-widget border border-surface-light-border px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-border dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-surface-elevated"
                disabled={!source}
                type="button"
              >
                Reset Selection
              </button>

              <button
                onClick={() => void handleExport()}
                className="rounded-widget bg-primary-400 px-4 py-3 text-sm font-semibold text-primary-950 transition hover:bg-primary-300 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!hasValidSelection || isExporting || !state.system.ffmpegAvailable}
                type="button"
              >
                {isExporting ? 'Exporting Trim...' : 'Export Trimmed MP4'}
              </button>
            </div>
          </GlassCard>

          <GlassCard>
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">Operator Notes</h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  Keyboard shortcuts stay active as long as you are not focused in an input field.
                </p>
              </div>

              <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
                <p><span className="font-semibold text-slate-900 dark:text-white">Space</span> toggles playback.</p>
                <p><span className="font-semibold text-slate-900 dark:text-white">I</span> sets the in point.</p>
                <p><span className="font-semibold text-slate-900 dark:text-white">O</span> sets the out point.</p>
                <p><span className="font-semibold text-slate-900 dark:text-white">Left/Right</span> nudges by one second.</p>
                <p><span className="font-semibold text-slate-900 dark:text-white">Shift + Left/Right</span> nudges by one frame at 30 fps.</p>
              </div>

              {lastExport && !lastExport.canceled && lastExport.outputPath && (
                <div className="rounded-widget border border-secondary-400/20 bg-secondary-400/10 p-4 text-sm text-secondary-900 dark:text-secondary-200">
                  <p className="font-semibold">Last Export</p>
                  <p className="mt-2 break-all">{lastExport.outputPath}</p>
                </div>
              )}
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}

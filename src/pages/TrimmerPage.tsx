import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
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
  const location = useLocation();
  // The library hands a retrieved archive master over through router state, so
  // "Retrieve for Processing" lands the operator on a loaded timeline rather
  // than on an empty page with a file picker.
  const handedOverSource = (location.state as { source?: LocalTrimSourceSnapshot } | null)?.source;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [source, setSource] = useState<LocalTrimSourceSnapshot | null>(handedOverSource ?? null);
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
    if (handedOverSource) {
      setSource(handedOverSource);
    }
  }, [handedOverSource?.sourcePath]);

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
    <div className="px-6 pb-11 pt-[22px]">
      <div className="mb-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <h1 className="font-display text-page text-paper">Trimmer</h1>
            <p className="mt-1.5 text-copy text-muted">
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
              className="csn-btn-primary"
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
              <p className="text-copy text-state-ok">{exportNotice}</p>
            )}
            {pageError && <p className="text-copy text-state-danger">{pageError}</p>}
          </div>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-12">
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
                    <p className="font-condensed text-overline uppercase text-dim">
                      Active Source
                    </p>
                    <h2 className="mt-2 font-display text-section text-paper">
                      {source.sourceFileName}
                    </h2>
                    <p className="mt-2 break-all text-sm text-muted">
                      {source.sourcePath}
                    </p>
                  </div>
                  <StatusBadge tone="good">Local Preview</StatusBadge>
                </div>

                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full px-3 py-1 font-condensed text-overline uppercase bg-ink-chip text-muted">
                    {formatFileSize(source.fileSizeBytes)}
                  </span>
                  <span className="rounded-full px-3 py-1 font-condensed text-overline uppercase bg-ink-chip text-muted">
                    Modified {formatDate(source.modifiedAt)}
                  </span>
                  <span className="rounded-full px-3 py-1 font-condensed text-overline uppercase bg-ink-chip text-muted">
                    Source Duration {formatTime(durationSeconds)}
                  </span>
                </div>

                <div className="space-y-3 rounded-control border p-4 border-rule bg-ink-panel">
                  <div className="flex items-center justify-between font-condensed text-overline uppercase text-dim">
                    <span>Trim Window</span>
                    <span>Playhead {formatTime(currentTimeSeconds)}</span>
                  </div>
                  <div className="relative h-3 overflow-hidden rounded-full bg-ink-tile">
                    <div
                      className="absolute inset-y-0 rounded-full bg-state-ok/50"
                      style={{
                        left: `${selectionLeftPercent}%`,
                        width: `${selectionWidthPercent}%`,
                      }}
                    />
                    <div
                      className="absolute top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-ink-panel shadow-[0_0_0_2px_rgba(15,23,42,0.4)]"
                      style={{ left: `calc(${playheadPercent}% - 2px)` }}
                    />
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-control border p-3 border-rule bg-ink-chip">
                      <p className="font-condensed text-overline uppercase text-dim">
                        In
                      </p>
                      <p className="mt-2 font-display text-section text-paper">
                        {formatTime(inPointSeconds)}
                      </p>
                    </div>
                    <div className="rounded-control border p-3 border-rule bg-ink-chip">
                      <p className="font-condensed text-overline uppercase text-dim">
                        Out
                      </p>
                      <p className="mt-2 font-display text-section text-paper">
                        {formatTime(outPointSeconds)}
                      </p>
                    </div>
                    <div className="rounded-control border p-3 border-rule bg-ink-chip">
                      <p className="font-condensed text-overline uppercase text-dim">
                        Selection
                      </p>
                      <p className="mt-2 font-display text-section text-paper">
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
                <h2 className="font-display text-section text-paper">
                  Load a local clip to start trimming
                </h2>
                <p className="mt-3 text-sm leading-6 text-muted">
                  Start with an MP4 when you can. Chromium-backed playback is happiest there, and
                  the trim export will always write a fresh MP4 for the next stage of the workflow.
                </p>
              </div>
              <button
                onClick={() => void handleChooseSource()}
                className="rounded-control bg-accent px-4 py-2 text-sm font-semibold text-paper transition hover:bg-accent-hi"
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
                <h2 className="font-display text-section text-paper">Trim Controls</h2>
                <p className="mt-1 text-sm text-muted">
                  Mark the range, fine-tune the numbers, then export a clean MP4.
                </p>
              </div>

              <div className="grid gap-3">
                <button
                  onClick={handleMarkIn}
                  className="rounded-control border border-state-ok/30 bg-state-ok/[.13] px-4 py-3 text-left text-sm font-semibold transition hover:bg-state-ok/[.16] disabled:cursor-not-allowed disabled:opacity-60 text-state-ok"
                  disabled={!source}
                  type="button"
                >
                  Mark In at Playhead
                </button>
                <button
                  onClick={handleMarkOut}
                  className="rounded-control border border-accent/40 bg-accent/[.13] px-4 py-3 text-left text-sm font-semibold transition hover:bg-accent-hi/15 disabled:cursor-not-allowed disabled:opacity-60 text-accent-hi"
                  disabled={!source}
                  type="button"
                >
                  Mark Out at Playhead
                </button>
              </div>

              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1">
                <label className="space-y-1.5 text-control font-medium text-body">
                  <span>In Point (seconds)</span>
                  <input
                    className="csn-input"
                    disabled={!source}
                    max={durationSeconds || undefined}
                    min={0}
                    onChange={(event) => handleInPointChange(event.target.valueAsNumber)}
                    step="0.01"
                    type="number"
                    value={Number.isFinite(inPointSeconds) ? inPointSeconds : 0}
                  />
                </label>

                <label className="space-y-1.5 text-control font-medium text-body">
                  <span>Out Point (seconds)</span>
                  <input
                    className="csn-input"
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
                  className="rounded-control border px-4 py-2 text-sm font-semibold transition border-rule text-body hover:border-state-ok/30 hover:bg-state-ok/5"
                  disabled={!source}
                  type="button"
                >
                  Jump to In
                </button>
                <button
                  onClick={() => jumpToTime(outPointSeconds)}
                  className="rounded-control border px-4 py-2 text-sm font-semibold transition border-rule text-body hover:border-accent-hi/30 hover:bg-accent/[.08]"
                  disabled={!source}
                  type="button"
                >
                  Jump to Out
                </button>
                <button
                  onClick={() => jumpToTime(currentTimeSeconds - 1)}
                  className="rounded-control border px-4 py-2 text-sm font-semibold transition border-rule text-body hover:border-white/[.22] hover:bg-ink-chip"
                  disabled={!source}
                  type="button"
                >
                  Nudge -1s
                </button>
                <button
                  onClick={() => jumpToTime(currentTimeSeconds + 1)}
                  className="rounded-control border px-4 py-2 text-sm font-semibold transition border-rule text-body hover:border-white/[.22] hover:bg-ink-chip"
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
                className="rounded-control border px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 border-rule text-body hover:border-white/[.22] hover:bg-ink-chip"
                disabled={!source}
                type="button"
              >
                Reset Selection
              </button>

              <button
                onClick={() => void handleExport()}
                className="rounded-control bg-accent px-4 py-3 text-sm font-semibold text-paper transition hover:bg-accent-hi disabled:cursor-not-allowed disabled:opacity-60"
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
                <h2 className="font-display text-section text-paper">Operator Notes</h2>
                <p className="mt-1 text-sm text-muted">
                  Keyboard shortcuts stay active as long as you are not focused in an input field.
                </p>
              </div>

              <div className="space-y-2 text-sm text-body">
                <p><span className="font-semibold text-paper">Space</span> toggles playback.</p>
                <p><span className="font-semibold text-paper">I</span> sets the in point.</p>
                <p><span className="font-semibold text-paper">O</span> sets the out point.</p>
                <p><span className="font-semibold text-paper">Left/Right</span> nudges by one second.</p>
                <p><span className="font-semibold text-paper">Shift + Left/Right</span> nudges by one frame at 30 fps.</p>
              </div>

              {lastExport && !lastExport.canceled && lastExport.outputPath && (
                <div className="rounded-control border border-state-ok/30 bg-state-ok/[.13] p-4 text-sm text-state-ok">
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

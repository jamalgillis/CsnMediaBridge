import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import TrimVideoPlayer from '../components/TrimVideoPlayer';
import {
  Disclosure,
  ErrorNote,
  Fact,
  FactList,
  PageHeading,
  QuietNote,
  Screen,
  Toast,
  useToast,
} from '../components/csn/bridge';
import { EmptyState, Eyebrow, GhostButton } from '../components/csn/ui';
import { useBridge } from '../context/BridgeContext';
import { formatBytes, formatWhen } from '../lib/plain';
import type { LocalTrimSourceSnapshot, TrimClipResult } from '../shared/types';

/**
 * Trim a clip.
 *
 * One band stands for the whole video: the lit stretch is the clip, the two
 * white handles are its ends, and the accent marker is where the preview is
 * sitting. Everything else — exact seconds, keyboard shortcuts, the written
 * file — is behind the disclosure, because the operator's job here is to drag
 * two handles and press export.
 */

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function clampSeconds(value: number, duration: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(duration, Math.max(0, value));
}

/** Timecode to the hundredth — the one place Bridge shows frame-level precision. */
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

function getPercent(value: number, duration: number) {
  if (!Number.isFinite(value) || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (value / duration) * 100));
}

type Drag = 'in' | 'out' | 'head';

export default function TrimmerPage() {
  const { state } = useBridge();
  const location = useLocation();
  const { toast, flash } = useToast();

  // The library hands a retrieved archive master over through router state, so
  // "Get original back" lands the operator on a loaded timeline rather than on
  // an empty page with a file picker.
  const handedOverSource = (location.state as { source?: LocalTrimSourceSnapshot } | null)?.source;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bandRef = useRef<HTMLDivElement | null>(null);

  const [source, setSource] = useState<LocalTrimSourceSnapshot | null>(handedOverSource ?? null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [inPointSeconds, setInPointSeconds] = useState(0);
  const [outPointSeconds, setOutPointSeconds] = useState(0);
  const [isPickingSource, setIsPickingSource] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [lastExport, setLastExport] = useState<TrimClipResult | null>(null);
  const [dragging, setDragging] = useState<Drag | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

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

  const jumpToTime = useCallback(
    (nextTime: number) => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      const safeTime = clampSeconds(nextTime, durationSeconds);
      video.currentTime = safeTime;
      setCurrentTimeSeconds(safeTime);
    },
    [durationSeconds],
  );

  /* ---- dragging the band ------------------------------------------------ */

  const secondsAt = useCallback(
    (clientX: number) => {
      const element = bandRef.current;
      if (!element || durationSeconds <= 0) {
        return 0;
      }
      const rect = element.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return ratio * durationSeconds;
    },
    [durationSeconds],
  );

  useEffect(() => {
    if (!dragging) {
      return;
    }

    function onMove(event: MouseEvent) {
      event.preventDefault();
      const at = secondsAt(event.clientX);
      if (dragging === 'in') {
        setInPointSeconds(Math.min(at, outPointSeconds));
      } else if (dragging === 'out') {
        setOutPointSeconds(Math.max(at, inPointSeconds));
      } else {
        jumpToTime(at);
      }
    }

    function onUp() {
      setDragging(null);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging, inPointSeconds, outPointSeconds, secondsAt, jumpToTime]);

  /* ---- keyboard --------------------------------------------------------- */

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
        handleMarkIn();
        return;
      }

      if (event.code === 'KeyO') {
        event.preventDefault();
        handleMarkOut();
        return;
      }

      if (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight') {
        return;
      }

      event.preventDefault();
      const nudgeAmount = event.shiftKey ? 1 / 30 : 1;
      const direction = event.code === 'ArrowRight' ? 1 : -1;
      jumpToTime(video.currentTime + direction * nudgeAmount);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [durationSeconds, inPointSeconds, outPointSeconds, source, jumpToTime]);

  /* ---- actions ---------------------------------------------------------- */

  async function handleChooseSource() {
    setIsPickingSource(true);
    setPageError(null);

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
      setLastExport(null);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsPickingSource(false);
    }
  }

  function handleMarkIn() {
    const next = clampSeconds(videoRef.current?.currentTime ?? currentTimeSeconds, durationSeconds);
    setInPointSeconds(next);
    if (next > outPointSeconds) {
      setOutPointSeconds(next);
    }
  }

  function handleMarkOut() {
    const next = clampSeconds(videoRef.current?.currentTime ?? currentTimeSeconds, durationSeconds);
    setOutPointSeconds(next);
    if (next < inPointSeconds) {
      setInPointSeconds(next);
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

  async function handleExport() {
    if (!source || !hasValidSelection) {
      return;
    }

    setIsExporting(true);
    setPageError(null);

    try {
      const result = await window.mediaBridge.trimClip({
        sourcePath: source.sourcePath,
        inPointSeconds,
        outPointSeconds,
      });

      setLastExport(result);
      flash(result.canceled ? 'Export canceled' : 'Clip exported');
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsExporting(false);
    }
  }

  const readouts = [
    { label: 'Start', value: formatTime(inPointSeconds) },
    { label: 'End', value: formatTime(outPointSeconds) },
    { label: 'Clip length', value: formatTime(selectionDurationSeconds) },
    { label: 'Marker', value: formatTime(currentTimeSeconds) },
  ];

  return (
    <Screen label="Trim">
      <div className="max-w-[840px] px-[30px] pt-[30px]">
        <PageHeading
          title="Trim a clip"
          subhead="Cut a short clip out of a finished video. The work happens on this machine, so nothing is uploaded twice."
        />
      </div>

      {pageError ? (
        <div className="max-w-[840px] px-[30px] pt-5">
          <ErrorNote>{pageError}</ErrorNote>
        </div>
      ) : null}

      {!state.system.ffmpegAvailable ? (
        <div className="max-w-[840px] px-[30px] pt-5">
          <QuietNote>
            Exporting needs FFmpeg, which this machine can’t find yet. You can still scrub and set
            the ends.
          </QuietNote>
        </div>
      ) : null}

      <div className="max-w-[840px] px-[30px] pt-6">
        <div className="csn-card flex flex-wrap items-center gap-3.5 px-[18px] py-4">
          <div className="min-w-[190px] flex-[1_1_240px]">
            <div className="text-[12px] text-quiet">Trimming from</div>
            <div className="mt-[3px] truncate text-row font-semibold text-paper">
              {source?.sourceFileName ?? 'No video chosen yet'}
            </div>
            <div className="mt-1 machine text-caption text-muted">
              {source
                ? `${formatBytes(source.fileSizeBytes)} · ${formatTime(durationSeconds)} · modified ${formatWhen(source.modifiedAt)}`
                : 'Pick a local MP4 or MOV, or open one from Videos.'}
            </div>
          </div>
          <GhostButton
            onClick={() => void handleChooseSource()}
            disabled={isPickingSource || isExporting}
          >
            {isPickingSource ? 'Opening…' : source ? 'Change video' : 'Choose a video'}
          </GhostButton>
        </div>
      </div>

      {!source ? (
        <div className="max-w-[840px] px-[30px] pt-6">
          <EmptyState
            title="Nothing loaded"
            body="Choose a local video to start trimming. An MP4 plays back most reliably, and the export always writes a fresh MP4."
          />
        </div>
      ) : (
        <>
          <div className="max-w-[840px] px-[30px] pt-5">
            <div className="overflow-hidden rounded-card border border-rule bg-ink-panel">
              <TrimVideoPlayer
                ref={videoRef}
                onLoadedMetadata={handleLoadedMetadata}
                onPause={() => undefined}
                onPlay={() => undefined}
                onTimeUpdate={handleTimeUpdate}
                sourceUrl={source.sourceUrl}
                title={source.sourceFileName}
              />
            </div>

            {/* One band for the whole video: the lit stretch is the clip. */}
            <div
              ref={bandRef}
              onMouseDown={(event) => {
                event.preventDefault();
                jumpToTime(secondsAt(event.clientX));
                setDragging('head');
              }}
              className="relative mt-[18px] h-11 cursor-pointer select-none overflow-hidden rounded-card border border-rule bg-ink-panel"
            >
              <div
                className="absolute inset-y-0 bg-paper/10"
                style={{ left: `${selectionLeftPercent}%`, width: `${selectionWidthPercent}%` }}
              />
              <div
                className="absolute inset-y-0 w-0.5 bg-accent"
                style={{ left: `${playheadPercent}%` }}
              />
              <div
                onMouseDown={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  setDragging('in');
                }}
                className="absolute inset-y-0 w-3 cursor-ew-resize"
                style={{ left: `calc(${selectionLeftPercent}% - 6px)` }}
              >
                <div className="mx-auto h-full w-[3px] bg-paper" />
              </div>
              <div
                onMouseDown={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  setDragging('out');
                }}
                className="absolute inset-y-0 w-3 cursor-ew-resize"
                style={{
                  left: `calc(${getPercent(outPointSeconds, durationSeconds)}% - 6px)`,
                }}
              >
                <div className="mx-auto h-full w-[3px] bg-paper" />
              </div>
            </div>

            <div className="mt-2.5 text-[12px] text-pretty text-muted">
              Drag either white handle to change the clip. Click the bar to move the red marker,
              then use Set start or Set end.
            </div>

            <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
              {readouts.map((readout) => (
                <div key={readout.label} className="flex-none rounded-chip bg-ink-chip px-[13px] py-2">
                  <div className="font-condensed text-[10.5px] font-bold uppercase tracking-[.1em] text-muted">
                    {readout.label}
                  </div>
                  <div className="mt-0.5 machine text-[15px] font-bold text-paper">
                    {readout.value}
                  </div>
                </div>
              ))}
              <span className="min-w-[8px] flex-1" />
              <GhostButton onClick={handleMarkIn}>Set start</GhostButton>
              <GhostButton onClick={handleMarkOut}>Set end</GhostButton>
            </div>
          </div>

          <div className="flex max-w-[840px] flex-wrap gap-2.5 px-[30px] pt-6">
            <GhostButton
              onClick={() => void handleExport()}
              disabled={!hasValidSelection || isExporting || !state.system.ffmpegAvailable}
            >
              {isExporting ? 'Exporting…' : 'Export clip'}
            </GhostButton>
            <GhostButton
              onClick={() => {
                setInPointSeconds(0);
                setOutPointSeconds(durationSeconds);
                jumpToTime(0);
              }}
            >
              Reset
            </GhostButton>
          </div>

          <div className="max-w-[840px] px-[30px] pt-6">
            <Disclosure open={detailsOpen} onToggle={() => setDetailsOpen((open) => !open)} />
          </div>

          {detailsOpen ? (
            <div className="max-w-[840px] px-[30px] pt-3.5">
              <Eyebrow>Keyboard</Eyebrow>
              <div className="mt-2.5">
                <FactList>
                  <Fact wide label="Space" value="Play or pause" />
                  <Fact wide label="I / O" value="Set the start or the end at the marker" />
                  <Fact wide label="← / →" value="Move the marker one second" />
                  <Fact wide label="Shift + ← / →" value="Move the marker one frame at 30 fps" />
                </FactList>
              </div>

              <div className="mt-5">
                <Eyebrow>This file</Eyebrow>
                <div className="mt-2.5">
                  <FactList>
                    <Fact wide label="Source path" value={source.sourcePath} machine />
                    <Fact
                      wide
                      label="Start / end"
                      value={`${inPointSeconds.toFixed(2)}s → ${outPointSeconds.toFixed(2)}s`}
                      machine
                    />
                    {lastExport && !lastExport.canceled && lastExport.outputPath ? (
                      <>
                        <Fact wide label="Last export" value={lastExport.outputPath} machine />
                        <Fact
                          wide
                          label="Encoded with"
                          value={lastExport.effectiveEncoder ?? '—'}
                          machine
                        />
                      </>
                    ) : null}
                  </FactList>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}

      <Toast message={toast} />
    </Screen>
  );
}

import { useEffect, useMemo, useState } from 'react';
import ManualIntakePanel from '../components/ManualIntakePanel';
import {
  Disclosure,
  ErrorNote,
  PageHeading,
  ProgressTrack,
  Screen,
  StepBar,
  TechNote,
  Toast,
  Vital,
  useToast,
} from '../components/csn/bridge';
import { Eyebrow, GhostButton, SectionHead, UnderlineTabs } from '../components/csn/ui';
import { useBridge } from '../context/BridgeContext';
import {
  formatBytes,
  isInFlight,
  isToday,
  isWaitingToRetry,
  needsAPerson,
  jobName,
  jobProgress,
  plainFailure,
  plainFinished,
  plainStage,
  remainingLabel,
  stepIndexForJob,
} from '../lib/plain';
import type { LogEntry, LogSource, StorageUsageSnapshot } from '../shared/types';

/**
 * Home.
 *
 * The screen leads with one plain answer — "1 thing needs you", "Working on 2
 * videos", "All caught up" — and then reads top to bottom in the order an
 * operator cares about: what needs you, what is happening now, what is waiting,
 * what finished. Every machine number on this screen (encoder, queue depth,
 * ffmpeg output, rclone transfers) lives under one disclosure at the bottom.
 * See design.md §4.
 */

/** The design's four log tabs, mapped onto the sources the pipeline emits. */
type LogTab = 'activity' | 'ffmpeg' | 'transfers' | 'system';

const LOG_TABS: readonly { key: LogTab; label: string }[] = [
  { key: 'activity', label: 'Activity' },
  { key: 'ffmpeg', label: 'ffmpeg' },
  { key: 'transfers', label: 'Transfers' },
  { key: 'system', label: 'System' },
];

const LOG_SOURCES: Record<LogTab, LogSource[]> = {
  activity: ['watcher', 'convex'],
  ffmpeg: ['transcode'],
  transfers: ['sync', 'offload'],
  system: ['system'],
};

function logTime(entry: LogEntry) {
  const date = new Date(entry.timestamp);
  if (Number.isNaN(date.getTime())) {
    return '--:--';
  }
  return date.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit' });
}

const GETTING_STARTED = [
  {
    title: 'Pick a folder to watch',
    body: 'Anything exported into it gets picked up on its own.',
  },
  {
    title: 'Drop in a video',
    body: 'The app waits until the file has finished copying before it starts.',
  },
  {
    title: 'Publish when it’s ready',
    body: 'You’ll see it under Videos with a link you can share.',
  },
];

export default function DashboardPage() {
  const { state, settings, retryJob, actionError, clearActionError } = useBridge();
  const { toast, flash } = useToast();

  const [advanced, setAdvanced] = useState(false);
  const [logTab, setLogTab] = useState<LogTab>('activity');
  const [openError, setOpenError] = useState<string | null>(null);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [usage, setUsage] = useState<StorageUsageSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.mediaBridge
      .getStorageUsage()
      .then((next) => {
        if (!cancelled) {
          setUsage(next);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [state.jobs.length]);

  // A job the app is going to retry by itself is not an operator's problem, so
  // it waits with the queue rather than shouting from the top of the screen.
  const attention = useMemo(() => state.jobs.filter(needsAPerson), [state.jobs]);
  const retrying = useMemo(() => state.jobs.filter(isWaitingToRetry), [state.jobs]);
  const working = useMemo(() => state.jobs.filter((job) => isInFlight(job.status)), [state.jobs]);
  const waiting = useMemo(
    () => [...state.jobs.filter((job) => job.status === 'queued'), ...retrying],
    [state.jobs, retrying],
  );
  const finished = useMemo(
    () => state.jobs.filter((job) => job.status === 'complete' && isToday(job.completedAt)),
    [state.jobs],
  );

  const isEmpty =
    attention.length === 0 && working.length === 0 && waiting.length === 0 && finished.length === 0;

  const waitingNote =
    retrying.length > 0
      ? `${waiting.length} waiting · ${retrying.length} trying again`
      : `${waiting.length} waiting`;

  const headline = isEmpty
    ? 'Ready when you are'
    : attention.length > 0
      ? `${attention.length} thing${attention.length > 1 ? 's' : ''} need${attention.length > 1 ? '' : 's'} you`
      : working.length > 0
        ? `Working on ${working.length} video${working.length > 1 ? 's' : ''}`
        : 'All caught up';

  const subhead = isEmpty
    ? 'Nothing has come through yet. Here is how it works.'
    : attention.length > 0
      ? 'Everything else is running normally. Handle the item below and the queue keeps going.'
      : state.isWatching
        ? `Watching ${settings.watchFolder}. Drop a video in there and it shows up here automatically.`
        : 'Watching is paused. Start it again from the bottom of the rail and new videos get picked up on their own.';

  const encoder =
    working.find((job) => job.encoder)?.encoder ??
    (settings.hardwareEncoderOverride === 'auto' ? 'Auto' : settings.hardwareEncoderOverride);
  const encoderLabel =
    encoder === 'videotoolbox'
      ? 'VideoToolbox'
      : encoder === 'nvenc'
        ? 'NVENC'
        : encoder === 'software'
          ? 'Software'
          : 'Auto';

  const logs = state.logs.filter((entry) => LOG_SOURCES[logTab].includes(entry.source)).slice(0, 60);

  return (
    <Screen label="Home">
      <div className="max-w-[760px] px-[30px] pt-[30px]">
        <PageHeading
          title={headline}
          subhead={subhead}
          live={attention.length > 0}
          action={
            <GhostButton onClick={() => setIntakeOpen((open) => !open)}>
              {intakeOpen ? 'Close' : 'Add a video by hand'}
            </GhostButton>
          }
        />
      </div>

      {actionError ? (
        <div className="max-w-[760px] px-[30px] pt-[22px]">
          <ErrorNote>
            {actionError}{' '}
            <button type="button" onClick={clearActionError} className="underline">
              Dismiss
            </button>
          </ErrorNote>
        </div>
      ) : null}

      {/* Watch-folder intake is the normal path; this is the hand-fed one, so it
          stays folded away until it is asked for. */}
      {intakeOpen ? (
        <div className="max-w-[760px] px-[30px] pt-[26px]">
          <ManualIntakePanel />
        </div>
      ) : null}

      {isEmpty ? (
        <div className="max-w-[760px] px-[30px] pt-[26px]">
          <div className="csn-card px-6 py-[22px]">
            <Eyebrow>Getting started</Eyebrow>
            <div className="mt-4 flex flex-col gap-4">
              {GETTING_STARTED.map((step, index) => (
                <div key={step.title} className="flex items-start gap-3.5">
                  <span className="flex h-6 w-6 flex-none items-center justify-center rounded-chip bg-ink-chip machine text-[13px] font-bold text-paper">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-copy font-semibold text-paper">{step.title}</div>
                    <div className="mt-[3px] text-caption text-pretty text-quiet">{step.body}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {attention.length > 0 ? (
        <div className="max-w-[760px] px-[30px] pt-7">
          <SectionHead
            title="NEEDS YOU"
            note={attention.length === 1 ? '1 item' : `${attention.length} items`}
          />
          <div className="mt-3 flex flex-col gap-2.5">
            {attention.map((job) => {
              const failure = plainFailure(job);
              const open = openError === job.id;
              return (
                <div key={job.id} className="csn-card px-5 py-[18px]">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-[200px] flex-[1_1_260px]">
                      <div className="text-row font-semibold text-paper">{failure.title}</div>
                      <div className="mt-[5px] text-[13px] text-pretty text-body">
                        {failure.cause}
                      </div>
                      <div className="mt-[7px] text-caption text-pretty text-quiet">
                        {failure.suggestion}
                      </div>
                    </div>
                    <div className="flex-none">
                      <GhostButton
                        onClick={() => {
                          void retryJob(job.id);
                          flash('Picking up where it left off — nothing re-converted');
                        }}
                      >
                        {failure.action}
                      </GhostButton>
                    </div>
                  </div>

                  {open ? (
                    <div className="mt-3.5">
                      <TechNote>{job.errorMessage || job.message || 'No detail recorded.'}</TechNote>
                    </div>
                  ) : null}

                  <div className="mt-3">
                    <Disclosure
                      small
                      open={open}
                      onToggle={() => setOpenError(open ? null : job.id)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {working.length > 0 ? (
        <div className="max-w-[760px] px-[30px] pt-[30px]">
          <SectionHead title="WORKING ON NOW" note="one at a time, so nothing slows down" />
          <div className="mt-3 flex flex-col gap-2.5">
            {working.map((job) => (
              <div key={job.id} className="csn-card px-5 py-[18px]">
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="min-w-[170px] flex-[1_1_220px] truncate text-row font-semibold text-paper">
                    {jobName(job)}
                  </span>
                  <span className="flex-none machine text-[13px] font-bold text-body">
                    {remainingLabel(job)}
                  </span>
                </div>
                <div className="mt-1.5 text-[13.5px] text-body">{plainStage(job)}</div>

                <div className="mt-4">
                  <StepBar active={stepIndexForJob(job)} />
                </div>

                {jobProgress(job) > 0 ? (
                  <div className="mt-4">
                    <ProgressTrack value={jobProgress(job)} live thick />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {waiting.length > 0 ? (
        <div className="max-w-[760px] px-[30px] pt-7">
          <SectionHead title="UP NEXT" note={waitingNote} />
          <div className="csn-hair mt-3">
            {waiting.map((job) => (
              <div
                key={job.id}
                className="csn-hair-row flex items-center gap-3 px-4 py-[13px]"
              >
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-paper">
                  {jobName(job)}
                </span>
                <span className="flex-none text-caption text-quiet">
                  {isWaitingToRetry(job)
                    ? job.message
                    : job.stage === 'waiting'
                      ? 'still copying into the folder'
                      : 'waiting its turn'}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {finished.length > 0 ? (
        <div className="max-w-[760px] px-[30px] pt-7">
          <SectionHead title="FINISHED TODAY" note={`${finished.length} finished`} />
          <div className="csn-hair mt-3">
            {finished.map((job) => (
              <div
                key={job.id}
                className="csn-hair-row flex flex-wrap items-center gap-3 px-4 py-[13px]"
              >
                <div className="min-w-[160px] flex-[1_1_200px]">
                  <div className="truncate text-[13.5px] text-paper">{jobName(job)}</div>
                  <div className="mt-0.5 text-[12px] text-quiet">{plainFinished(job)}</div>
                </div>
                <div className="flex-none">
                  <GhostButton
                    disabled={!job.publicUrl && !job.manifestUrl}
                    onClick={() => {
                      const url = job.publicUrl ?? job.manifestUrl;
                      if (url) {
                        void navigator.clipboard.writeText(url);
                        flash('Link copied');
                      }
                    }}
                  >
                    Copy link
                  </GhostButton>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="max-w-[760px] px-[30px] pt-[30px]">
        <Disclosure open={advanced} onToggle={() => setAdvanced((open) => !open)} />
      </div>

      {advanced ? (
        <div className="max-w-[760px] px-[30px] pt-[22px]">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2.5">
            <Vital label="Encoder" value={encoderLabel} />
            <Vital label="Queue depth" value={String(state.queueDepth)} />
            <Vital label="Disk free" value={usage ? formatBytes(usage.totalBytes - usage.usedBytes) : '—'} />
            <Vital
              label="Needs attention"
              value={String(attention.length)}
              alert={attention.length > 0}
            />
          </div>

          <div className="mt-[22px] border-b border-rule">
            <UnderlineTabs<LogTab> tabs={LOG_TABS} value={logTab} onChange={setLogTab} />
          </div>
          <div className="csn-well mt-3 max-h-[190px] overflow-y-auto">
            {logs.length === 0 ? (
              <div className="px-3.5 py-3 machine text-[12px] text-muted">
                Nothing logged here yet.
              </div>
            ) : (
              logs.map((entry) => (
                <div key={entry.id} className="flex gap-3 px-3.5 py-[5px] machine text-[12px]">
                  <span className="flex-none text-muted">{logTime(entry)}</span>
                  <span
                    className={`min-w-0 flex-1 break-all ${
                      entry.level === 'error' || entry.level === 'warn' ? 'text-accent' : 'text-body'
                    }`}
                  >
                    {entry.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}

      <Toast message={toast} />
    </Screen>
  );
}

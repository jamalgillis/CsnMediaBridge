import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import StreamLibrary from '../components/StreamLibrary';
import Thumb from '../components/csn/Thumb';
import {
  Disclosure,
  ErrorNote,
  Fact,
  FactList,
  PageHeading,
  ProgressTrack,
  Screen,
  Toggle,
  ToneChip,
  Toast,
  type ChipTone,
  useToast,
} from '../components/csn/bridge';
import { useBridge } from '../context/BridgeContext';
import { EmptyState, GhostButton, LiveDot, Segmented, UnderlineTabs } from '../components/csn/ui';
import { canConvert, useLiveStreamJobs } from '../hooks/useLiveStreamJobs';
import { formatWhen, formatWhenShort } from '../lib/plain';
import type { LiveStreamHandoffJobSnapshot } from '../shared/types';

/**
 * Live streams.
 *
 * A recording joins this queue on its own when an event ends. Turning it into
 * a library video is either this station's job, taken automatically, or an
 * operator's, one Convert at a time — the switch at the top decides which, and
 * the copy never promises something will start by itself when it will not.
 *
 * Each row states where the recording has got to; the provider ids, node keys
 * and attempt counters stay behind "Show history".
 */

type View = 'cards' | 'gallery' | 'list';

/** The conversion queue, or everything already sitting in Stream. */
type Section = 'queue' | 'library';

const SECTIONS: readonly { key: Section; label: string }[] = [
  { key: 'queue', label: 'Conversion queue' },
  { key: 'library', label: 'Stored in Stream' },
];

const VIEWS: readonly { key: View; label: string }[] = [
  { key: 'cards', label: 'Detail' },
  { key: 'gallery', label: 'Gallery' },
  { key: 'list', label: 'List' },
];

interface PlainJob {
  label: string;
  tone: ChipTone;
  /** What is happening, in the operator's words. */
  plain: string;
  inFlight: boolean;
}

function describe(job: LiveStreamHandoffJobSnapshot, autoConvert: boolean): PlainJob {
  switch (job.status) {
    case 'needs_client':
      return {
        label: 'Needs a client',
        tone: 'live',
        plain:
          'This came from a live input that is not assigned to a client yet, so nobody can say who owns it. Assign the input in the admin, and it joins the queue.',
        inFlight: false,
      };
    case 'awaiting_source':
      return {
        label: 'Getting ready',
        tone: 'waiting',
        plain:
          'The stream provider is still preparing the recording file. Long events take a few minutes.',
        inFlight: false,
      };
    case 'pending':
      return {
        label: 'Ready',
        tone: 'waiting',
        plain: autoConvert
          ? 'Ready to convert. This station will pick it up on its own within a minute.'
          : 'Ready to convert. Press Convert to turn it into a video.',
        inFlight: false,
      };
    case 'claimed':
    case 'downloading':
      return {
        label: 'Preparing',
        tone: 'live',
        plain: 'A machine has picked this up and is fetching the recording.',
        inFlight: true,
      };
    case 'processing':
      return {
        label: 'Preparing',
        tone: 'live',
        plain:
          'Recording arrived and is being prepared for streaming. It will appear under Videos when it finishes.',
        inFlight: true,
      };
    case 'uploading':
      return {
        label: 'Preparing',
        tone: 'live',
        plain: 'Sending the prepared recording to the cloud.',
        inFlight: true,
      };
    case 'registering':
      return {
        label: 'Preparing',
        tone: 'live',
        plain: 'Adding it to the library.',
        inFlight: true,
      };
    case 'completed':
      return {
        label: 'Done',
        tone: 'neutral',
        plain: 'Finished and added to Videos.',
        inFlight: false,
      };
    case 'failed':
      return {
        label: 'Needs you',
        tone: 'live',
        plain:
          job.attempts < job.maxAttempts
            ? 'This one stopped before it finished. Convert tries it again.'
            : 'This one stopped before it finished, and has used every attempt.',
        inFlight: false,
      };
    case 'canceled':
      return {
        label: 'Canceled',
        tone: 'quiet',
        plain: 'This handoff was stopped.',
        inFlight: false,
      };
    default:
      return { label: job.status, tone: 'quiet', plain: job.message ?? '', inFlight: false };
  }
}

function jobTitle(job: LiveStreamHandoffJobSnapshot) {
  return job.eventName || job.projectName || job.providerVideoId;
}

/** "Client · when", or just when, for the line under a title. */
function jobByline(job: LiveStreamHandoffJobSnapshot, when: string) {
  return job.clientName ? `${job.clientName} · ${when}` : when;
}

function endedAt(job: LiveStreamHandoffJobSnapshot) {
  return job.recordedAt ?? job.completedAt ?? job.createdAt;
}

export default function LiveStreamsPage() {
  const navigate = useNavigate();
  const { jobs, isLoading, error } = useLiveStreamJobs();
  const { settings, saveSettings } = useBridge();
  const { toast, flash } = useToast();

  const [section, setSection] = useState<Section>('queue');
  const [view, setView] = useState<View>('gallery');
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  /** The recording a Convert press is waiting on, so only its button shows it. */
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const autoConvert = settings.liveRecordings?.autoConvert ?? false;
  // One recording at a time per station, so every Convert waits while one runs.
  const stationBusy = jobs.some((job) =>
    ['claimed', 'downloading', 'processing', 'uploading', 'registering'].includes(job.status),
  );

  const rows = useMemo(
    () => jobs.map((job) => ({ job, plain: describe(job, autoConvert) })),
    [jobs, autoConvert],
  );

  function errorText(caught: unknown) {
    return caught instanceof Error ? caught.message : String(caught);
  }

  async function refresh() {
    setIsRefreshing(true);
    setPageError(null);
    try {
      await window.mediaBridge.listLiveStreamHandoffJobs();
    } catch (refreshError) {
      setPageError(errorText(refreshError));
    } finally {
      setIsRefreshing(false);
    }
  }

  async function convert(job: LiveStreamHandoffJobSnapshot) {
    setConvertingId(job._id);
    setPageError(null);
    try {
      await window.mediaBridge.convertLiveStreamRecording(job._id);
      flash(`Converting ${jobTitle(job)}`);
    } catch (convertError) {
      setPageError(errorText(convertError));
    } finally {
      setConvertingId(null);
    }
  }

  async function setAutoConvert(next: boolean) {
    setPageError(null);
    try {
      await saveSettings({ ...settings, liveRecordings: { ...settings.liveRecordings, autoConvert: next } });
      flash(next ? 'This station converts recordings on its own' : 'Recordings wait for Convert');
    } catch (saveError) {
      setPageError(errorText(saveError));
    }
  }

  // A render helper rather than a nested component: a component declared in
  // here would be a new type every render and remount its button each tick.
  function convertButton(job: LiveStreamHandoffJobSnapshot) {
    if (!canConvert(job)) {
      return null;
    }
    const busy = convertingId === job._id;
    return (
      <GhostButton
        onClick={() => void convert(job)}
        disabled={busy || convertingId !== null || stationBusy}
      >
        {busy ? 'Starting…' : job.status === 'failed' ? 'Try again' : 'Convert'}
      </GhostButton>
    );
  }

  function watch(job: LiveStreamHandoffJobSnapshot) {
    // The finished recording is a normal video, so it opens where every other
    // video opens rather than in a player of its own.
    navigate(`/player?filter=all&q=${encodeURIComponent(jobTitle(job))}`);
  }

  return (
    <Screen label="Live streams">
      <div className="max-w-[840px] px-[30px] pt-[30px]">
        <PageHeading
          title="Live streams"
          subhead="Recordings from live events. Convert new ones into library videos, or archive and download what is already stored in Stream."
        />

        <UnderlineTabs<Section> tabs={SECTIONS} value={section} onChange={setSection} className="mt-5" />
      </div>

      {section === 'library' ? (
        <div className="max-w-[1000px] px-[30px] pb-10 pt-5">
          <StreamLibrary />
        </div>
      ) : (
      <>
      <div className="max-w-[840px] px-[30px]">

        <div className="csn-card mt-4 flex flex-wrap items-center gap-3.5 px-[18px] py-3.5">
          <Toggle
            checked={autoConvert}
            onChange={(next) => void setAutoConvert(next)}
            label="Convert recordings automatically"
          />
          <div className="min-w-[200px] flex-[1_1_300px]">
            <div className="text-[13.5px] font-semibold text-paper">Convert automatically</div>
            <div className="mt-[3px] text-caption text-pretty text-muted">
              {autoConvert
                ? 'This station takes the next ready recording on its own, one at a time.'
                : 'Recordings wait here until someone presses Convert.'}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <GhostButton onClick={() => void refresh()} disabled={isRefreshing}>
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </GhostButton>
          <GhostButton onClick={() => navigate('/dashboard')}>Add a recording manually</GhostButton>
          <span className="min-w-[8px] flex-1" />
          <Segmented<View> options={VIEWS} value={view} onChange={setView} />
        </div>
      </div>

      {error || pageError ? (
        <div className="max-w-[840px] px-[30px] pt-5">
          <ErrorNote>{pageError ?? error}</ErrorNote>
        </div>
      ) : null}

      {isLoading ? null : rows.length === 0 ? (
        <div className="max-w-[840px] px-[30px] pt-6">
          <EmptyState
            title="Nothing yet"
            body="Recordings appear here by themselves once an event ends. The list refreshes every minute."
          />
        </div>
      ) : view === 'gallery' ? (
        <div className="max-w-[1000px] px-[30px] pb-10 pt-6">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-4">
            {rows.map(({ job, plain }) => (
              <div key={job._id} className="csn-card p-3">
                <button
                  type="button"
                  onClick={() => (job.playbackUrl ? watch(job) : setView('cards'))}
                  className="block w-full cursor-pointer border-none bg-transparent p-0 text-left"
                >
                  <Thumb
                    seed={job._id}
                    posterUrl={job.posterUrl}
                    showPlay={Boolean(job.playbackUrl)}
                    className="aspect-video w-full rounded-chip"
                  >
                    {plain.inFlight ? (
                      <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-chip bg-ink/[.82] px-2 py-1">
                        <LiveDot />
                        <span className="font-condensed text-[10px] font-bold uppercase tracking-[.1em] text-paper">
                          Preparing
                        </span>
                      </div>
                    ) : null}
                  </Thumb>
                  <div className="mt-[11px] truncate text-[13.5px] font-semibold text-paper">
                    {jobTitle(job)}
                  </div>
                  <div className="mt-[7px] flex flex-wrap items-center gap-[9px]">
                    <ToneChip tone={plain.tone}>{plain.label}</ToneChip>
                    <span className="truncate machine text-[11.5px] text-muted">
                      {jobByline(job, formatWhenShort(endedAt(job)))}
                    </span>
                  </div>
                </button>

                {plain.inFlight || job.status === 'failed' ? (
                  <div className="mt-2.5">
                    <ProgressTrack value={job.progress ?? 0} live={plain.inFlight} />
                  </div>
                ) : null}

                {job.playbackUrl || canConvert(job) ? (
                  <div className="mt-[11px] flex flex-wrap gap-2">
                    {convertButton(job)}
                    {job.playbackUrl ? (
                      <GhostButton onClick={() => watch(job)}>Watch</GhostButton>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : view === 'list' ? (
        <div className="max-w-[1000px] px-[30px] pb-10 pt-6">
          <div className="csn-hair">
            {rows.map(({ job, plain }) => (
              <div
                key={job._id}
                className="csn-hair-row flex flex-wrap items-center gap-3.5 px-[15px] py-3"
              >
                {plain.inFlight ? <LiveDot /> : null}
                <button
                  type="button"
                  onClick={() => (job.playbackUrl ? watch(job) : setView('cards'))}
                  className="min-w-[170px] flex-[1_1_220px] cursor-pointer border-none bg-transparent p-0 text-left"
                >
                  <div className="truncate text-[13.5px] font-semibold text-paper">
                    {jobTitle(job)}
                  </div>
                  <div className="mt-[3px] truncate machine text-[11.5px] text-muted">
                    {jobByline(job, formatWhen(endedAt(job)))} · {job.claimedByNodeKey ?? '—'} ·
                    attempt {job.attempts} of {job.maxAttempts}
                  </div>
                </button>
                <ToneChip tone={plain.tone}>{plain.label}</ToneChip>
                {job.playbackUrl || canConvert(job) ? (
                  <div className="flex flex-none gap-2">
                    {convertButton(job)}
                    {job.playbackUrl ? (
                      <GhostButton onClick={() => watch(job)}>Watch</GhostButton>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex max-w-[840px] flex-col gap-2.5 px-[30px] pt-[26px]">
          {rows.map(({ job, plain }) => {
            const open = openHistory === job._id;
            return (
              <div key={job._id} className="csn-card px-5 py-[18px]">
                <div className="flex flex-wrap items-start gap-3">
                  {plain.inFlight ? <LiveDot /> : null}
                  <div className="min-w-[200px] flex-[1_1_260px]">
                    <div className="text-row font-semibold text-paper">{jobTitle(job)}</div>
                    <div className="mt-[5px] text-[13px] text-pretty text-body">{plain.plain}</div>
                  </div>
                  <div className="flex flex-none flex-wrap items-center gap-[9px]">
                    <ToneChip tone={plain.tone}>{plain.label}</ToneChip>
                    {convertButton(job)}
                  </div>
                </div>

                {plain.inFlight || job.status === 'failed' ? (
                  <div className="mt-3.5">
                    <ProgressTrack value={job.progress ?? 0} live={plain.inFlight} thick />
                  </div>
                ) : null}

                <div className="mt-3.5">
                  <FactList sunk>
                    {job.clientName ? <Fact wide label="Client" value={job.clientName} /> : null}
                    <Fact wide label="Event ended" value={formatWhen(endedAt(job))} machine />
                    <Fact wide label="Machine" value={job.claimedByNodeKey ?? '—'} machine />
                    <Fact
                      wide
                      label="Attempts"
                      value={`${job.attempts} of ${job.maxAttempts}`}
                      machine
                    />
                    <Fact wide label="Provider id" value={job.providerVideoId} machine />
                  </FactList>
                </div>

                {job.errorMessage ? (
                  <div className="mt-3">
                    <ErrorNote>{job.errorMessage}</ErrorNote>
                  </div>
                ) : null}

                {job.playbackUrl ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2.5 rounded-chip bg-ink-chip px-[13px] py-2.5">
                    <span className="flex-none text-caption text-quiet">Watch link</span>
                    <a
                      href={job.playbackUrl}
                      className="min-w-[140px] flex-[1_1_200px] truncate machine text-caption text-body"
                    >
                      {job.playbackUrl}
                    </a>
                  </div>
                ) : null}

                <div className="mt-3">
                  <Disclosure
                    small
                    open={open}
                    onToggle={() => setOpenHistory(open ? null : job._id)}
                    showLabel="Show history"
                    hideLabel="Hide history"
                  />
                </div>

                {open ? (
                  <div className="mt-[11px]">
                    <FactList sunk>
                      <Fact wide label="Started" value={formatWhen(job.createdAt)} machine />
                      <Fact wide label="Last changed" value={formatWhen(job.updatedAt)} machine />
                      {job.completedAt ? (
                        <Fact wide label="Finished" value={formatWhen(job.completedAt)} machine />
                      ) : null}
                      {job.stage ? <Fact wide label="Stage" value={job.stage} machine /> : null}
                      {job.archiveObjectKey ? (
                        <Fact wide label="Archive key" value={job.archiveObjectKey} machine />
                      ) : null}
                      {job.distributionObjectKey ? (
                        <Fact
                          wide
                          label="Playback folder"
                          value={job.distributionObjectKey}
                          machine
                        />
                      ) : null}
                    </FactList>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      </>
      )}

      <Toast message={toast} />
    </Screen>
  );
}

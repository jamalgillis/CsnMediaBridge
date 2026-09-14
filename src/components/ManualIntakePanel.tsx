import { useState } from 'react';
import { useBridge } from '../context/BridgeContext';
import { resolveDeliveryType } from '../shared/media';
import { formatBytes, formatClock } from '../lib/plain';
import type { ManualIntakeSourceSnapshot } from '../shared/types';
import { ErrorNote, QuietNote } from './csn/bridge';
import { Eyebrow, GhostButton } from './csn/ui';

/**
 * Adding a video by hand.
 *
 * The watch folder is the normal way in; this is the exception, for a file that
 * never landed there. It keeps the Home screen's voice — one plain sentence
 * about what will happen to the file, and the delivery decision stated rather
 * than configured, because the pipeline already knows the right answer from the
 * video's length.
 */

function splitValues(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function getFallbackTitle(source: ManualIntakeSourceSnapshot | null) {
  return source?.sourceFileName.replace(/\.[^.]+$/, '') ?? '';
}

export default function ManualIntakePanel() {
  const { chooseManualIntakeSource, enqueueManualIntake, settings } = useBridge();
  const [source, setSource] = useState<ManualIntakeSourceSnapshot | null>(null);
  const [title, setTitle] = useState('');
  const [projectName, setProjectName] = useState('');
  const [eventName, setEventName] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [playlistInput, setPlaylistInput] = useState('');
  const [description, setDescription] = useState('');
  const [isChoosing, setIsChoosing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const thresholdSeconds = settings.autoProgressiveMaxDurationSeconds;
  const automaticDelivery = source?.durationSeconds
    ? resolveDeliveryType({
        requestedDelivery: 'auto',
        durationSeconds: source.durationSeconds,
        autoProgressiveMaxDurationSeconds: thresholdSeconds,
      })
    : null;

  const plannedTreatment =
    automaticDelivery === 'progressive'
      ? 'It is short, so it will be made into a single downloadable file.'
      : automaticDelivery === 'hls'
        ? 'It is long enough that it will be prepared for streaming.'
        : `Anything up to ${formatClock(thresholdSeconds)} becomes a single file; anything longer is prepared for streaming.`;

  async function handleChooseSource() {
    setIsChoosing(true);
    setLocalError(null);
    setSuccessMessage(null);

    try {
      const nextSource = await chooseManualIntakeSource();
      if (!nextSource) {
        return;
      }

      setSource(nextSource);
      if (!title.trim()) {
        setTitle(getFallbackTitle(nextSource));
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsChoosing(false);
    }
  }

  async function handleSubmit() {
    if (!source) {
      setLocalError('Choose a video first.');
      return;
    }

    setIsSubmitting(true);
    setLocalError(null);
    setSuccessMessage(null);

    try {
      await enqueueManualIntake({
        sourcePath: source.sourcePath,
        route: 'web_streaming',
        title: title.trim() || undefined,
        projectName: projectName.trim() || undefined,
        eventName: eventName.trim() || undefined,
        tags: splitValues(tagsInput),
        playlistTitles: splitValues(playlistInput),
        description: description.trim() || undefined,
      });
      setSuccessMessage(`${source.sourceFileName} is in the queue.`);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="csn-card px-5 py-[18px]">
      <Eyebrow>Add a video by hand</Eyebrow>

      <div className="mt-4 flex flex-wrap items-center gap-3.5">
        <div className="min-w-[190px] flex-[1_1_240px]">
          <div className="text-[12px] text-quiet">Video file</div>
          <div className="mt-[3px] truncate text-row font-semibold text-paper">
            {source?.sourceFileName ?? 'Nothing chosen yet'}
          </div>
          <div className="mt-1 machine text-caption text-muted">
            {source
              ? `${formatBytes(source.fileSizeBytes)} · ${formatClock(source.durationSeconds ?? 0)}`
              : 'Pick a file that never made it into the watch folder.'}
          </div>
        </div>
        <GhostButton onClick={() => void handleChooseSource()} disabled={isChoosing || isSubmitting}>
          {isChoosing ? 'Opening…' : source ? 'Change' : 'Choose a video'}
        </GhostButton>
      </div>

      <div className="mt-3.5">
        <QuietNote>{plannedTreatment}</QuietNote>
      </div>

      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
        <label className="block">
          <span className="csn-label">Title</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="csn-input"
          />
        </label>
        <label className="block">
          <span className="csn-label">Project</span>
          <input
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            className="csn-input"
          />
        </label>
        <label className="block">
          <span className="csn-label">Event</span>
          <input
            value={eventName}
            onChange={(event) => setEventName(event.target.value)}
            className="csn-input"
          />
        </label>
        <label className="block">
          <span className="csn-label">Tags</span>
          <input
            value={tagsInput}
            onChange={(event) => setTagsInput(event.target.value)}
            placeholder="baseball, full-game"
            className="csn-input"
          />
        </label>
        <label className="block">
          <span className="csn-label">Playlists</span>
          <input
            value={playlistInput}
            onChange={(event) => setPlaylistInput(event.target.value)}
            placeholder="2026 Season"
            className="csn-input"
          />
        </label>
      </div>

      <label className="mt-3.5 block">
        <span className="csn-label">Description</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          className="csn-textarea resize-none"
        />
      </label>

      {localError ? (
        <div className="mt-3.5">
          <ErrorNote>{localError}</ErrorNote>
        </div>
      ) : null}
      {successMessage ? (
        <div className="mt-3.5">
          <QuietNote>{successMessage}</QuietNote>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-[9px]">
        <GhostButton
          onClick={() => void handleSubmit()}
          disabled={!source || isSubmitting || isChoosing}
        >
          {isSubmitting ? 'Adding…' : 'Add to the queue'}
        </GhostButton>
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';
import GlassCard from './GlassCard';
import StatusBadge from './StatusBadge';
import { useBridge } from '../context/BridgeContext';
import type {
  ManualIntakeSourceSnapshot,
  ManualPipelineRoute,
} from '../shared/types';

const routeOptions: Array<{
  id: ManualPipelineRoute;
  label: string;
  detail: string;
}> = [
  {
    id: 'web_streaming',
    label: 'Web VOD',
    detail: 'Full video, auto streaming',
  },
  {
    id: 'clip_progressive',
    label: 'Clip',
    detail: 'Short clip, direct playback',
  },
  {
    id: 'review_draft',
    label: 'Review Draft',
    detail: 'VOD queued for review',
  },
];

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

function formatBytes(value: number | null | undefined) {
  if (!value) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getFallbackTitle(source: ManualIntakeSourceSnapshot | null) {
  return source?.sourceFileName.replace(/\.[^.]+$/, '') ?? '';
}

export default function ManualIntakePanel() {
  const { chooseManualIntakeSource, enqueueManualIntake } = useBridge();
  const [source, setSource] = useState<ManualIntakeSourceSnapshot | null>(null);
  const [route, setRoute] = useState<ManualPipelineRoute>('web_streaming');
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

  const selectedRoute = useMemo(
    () => routeOptions.find((option) => option.id === route) ?? routeOptions[0],
    [route],
  );

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
      setLocalError('Choose a file before sending content to the queue.');
      return;
    }

    setIsSubmitting(true);
    setLocalError(null);
    setSuccessMessage(null);

    try {
      await enqueueManualIntake({
        sourcePath: source.sourcePath,
        route,
        title: title.trim() || undefined,
        projectName: projectName.trim() || undefined,
        eventName: eventName.trim() || undefined,
        tags: splitValues(tagsInput),
        playlistTitles: splitValues(playlistInput),
        description: description.trim() || undefined,
      });
      setSuccessMessage(`${source.sourceFileName} queued for ${selectedRoute.label}.`);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <GlassCard className="col-span-full xl:col-span-4">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-section text-paper">Manual Intake</h2>
          <p className="mt-1 text-sm text-muted">
            {source ? source.sourceFileName : 'No file selected'}
          </p>
        </div>
        <StatusBadge tone={source ? 'active' : 'neutral'}>
          {source ? selectedRoute.label : 'Idle'}
        </StatusBadge>
      </div>

      <div className="space-y-4">
        <button
          type="button"
          onClick={() => void handleChooseSource()}
          disabled={isChoosing || isSubmitting}
          className="flex w-full items-center justify-center rounded-control border px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 border-rule bg-ink-chip text-paper hover:bg-ink-panel"
        >
          {isChoosing ? 'Choosing...' : source ? 'Change File' : 'Choose File'}
        </button>

        {source && (
          <div
            className="rounded-control border p-4 text-sm border-rule bg-ink"
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-paper">
                {source.sourceFileName}
              </p>
              <p className="mt-1 text-muted">
                {formatBytes(source.fileSizeBytes)}
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
          {routeOptions.map((option) => {
            const isSelected = option.id === route;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setRoute(option.id)}
                disabled={isSubmitting}
                className={`rounded-control border px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                  isSelected
                    ? 'border-accent/50 bg-accent/[.16] text-accent-hi'
                    : 'border-rule bg-ink-chip text-body hover:bg-ink-panel'
                }`}
              >
                <span className="block text-sm font-semibold">{option.label}</span>
                <span className="mt-1 block text-xs opacity-75">{option.detail}</span>
              </button>
            );
          })}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              Title
            </span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-control border px-3 py-2 text-sm outline-none transition focus:border-accent-hi border-rule bg-ink text-paper"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              Project
            </span>
            <input
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              className="w-full rounded-control border px-3 py-2 text-sm outline-none transition focus:border-accent-hi border-rule bg-ink text-paper"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              Event
            </span>
            <input
              value={eventName}
              onChange={(event) => setEventName(event.target.value)}
              className="w-full rounded-control border px-3 py-2 text-sm outline-none transition focus:border-accent-hi border-rule bg-ink text-paper"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              Tags
            </span>
            <input
              value={tagsInput}
              onChange={(event) => setTagsInput(event.target.value)}
              className="w-full rounded-control border px-3 py-2 text-sm outline-none transition focus:border-accent-hi border-rule bg-ink text-paper"
            />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            Playlists
          </span>
          <input
            value={playlistInput}
            onChange={(event) => setPlaylistInput(event.target.value)}
            className="w-full rounded-control border px-3 py-2 text-sm outline-none transition focus:border-accent-hi border-rule bg-ink text-paper"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">
            Description
          </span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            className="w-full resize-none rounded-control border px-3 py-2 text-sm outline-none transition focus:border-accent-hi border-rule bg-ink text-paper"
          />
        </label>

        {localError && (
          <div className="rounded-control border border-state-danger/30 p-3 text-sm bg-state-danger/[.12] text-state-danger">
            {localError}
          </div>
        )}

        {successMessage && (
          <div className="rounded-control border border-state-ok/30 p-3 text-sm bg-state-ok/[.13] text-state-ok">
            {successMessage}
          </div>
        )}

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!source || isSubmitting || isChoosing}
          className="w-full rounded-control bg-accent px-4 py-3 text-sm font-semibold text-paper transition hover:bg-accent-hi disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? 'Sending...' : 'Send to Queue'}
        </button>
      </div>
    </GlassCard>
  );
}

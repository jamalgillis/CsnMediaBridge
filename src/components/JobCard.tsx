import type { IngestJobSnapshot } from '../shared/types';
import ProgressBar from './ProgressBar';
import StatusBadge from './StatusBadge';

const statusConfig: Record<
  IngestJobSnapshot['status'],
  { label: string; tone: 'good' | 'active' | 'warning' | 'danger' | 'neutral' }
> = {
  queued: { label: 'Queued', tone: 'neutral' },
  checking: { label: 'Ready Check', tone: 'warning' },
  encoding: { label: 'Encoding', tone: 'active' },
  uploading: { label: 'Uploading', tone: 'active' },
  registering: { label: 'Convex', tone: 'warning' },
  complete: { label: 'Complete', tone: 'good' },
  error: { label: 'Error', tone: 'danger' },
};

interface JobCardProps {
  job: IngestJobSnapshot;
  onRetry?: (jobId: string) => void;
}

function formatTimestamp(value: string | null) {
  if (!value) return 'Waiting';
  return new Date(value).toLocaleString();
}

function formatBytes(value: number | null) {
  if (!value) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatFrameRate(value: number | null) {
  if (!value) {
    return 'FPS pending';
  }

  return `${value.toFixed(value >= 10 ? 2 : 3)} fps`;
}

export default function JobCard({ job, onRetry }: JobCardProps) {
  const status = statusConfig[job.status];
  const resolution =
    job.sourceWidth && job.sourceHeight
      ? `${job.sourceWidth}x${job.sourceHeight}`
      : 'Resolution pending';
  const displayTitle = job.title ?? job.sourceName;

  return (
    <div
      className="rounded-widget border border-surface-light-border bg-surface-light-elevated p-5
        transition-colors dark:border-surface-border dark:bg-surface-deep"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-lg font-semibold text-slate-900 dark:text-white">
              {displayTitle}
            </h4>
            {job.encoder && <StatusBadge tone="neutral">{job.encoder}</StatusBadge>}
            {job.deliveryType && <StatusBadge tone="neutral">{job.deliveryType}</StatusBadge>}
            {job.contentType && <StatusBadge tone="neutral">{job.contentType}</StatusBadge>}
          </div>
          {job.title && job.title !== job.sourceName && (
            <p className="mt-1 truncate text-xs uppercase tracking-widest text-slate-400 dark:text-slate-500">
              Source file: {job.sourceName}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
            <span>{formatBytes(job.sourceSizeBytes)}</span>
            <span className="text-slate-300 dark:text-slate-600">/</span>
            <span>{resolution}</span>
            <span className="text-slate-300 dark:text-slate-600">/</span>
            <span>{formatFrameRate(job.sourceFrameRate)}</span>
            <span className="text-slate-300 dark:text-slate-600">/</span>
            <span>{job.stage.replace(/-/g, ' ')}</span>
            <span className="text-slate-300 dark:text-slate-600">/</span>
            <span>{job.durationSeconds ? `${Math.round(job.durationSeconds)}s` : 'Duration pending'}</span>
          </div>
        </div>
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      </div>

      <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">{job.message}</p>

      <div className="space-y-3">
        <ProgressBar label="Encoding" value={job.encodingProgress} variant="primary" />
        <ProgressBar label="Uploading" value={job.uploadProgress} variant="secondary" />
      </div>

      <div className="mt-4 grid gap-3 text-xs lg:grid-cols-2">
        <div>
          <p className="uppercase tracking-widest text-slate-400 dark:text-slate-500">Started</p>
          <p className="mt-1 text-slate-700 dark:text-slate-200">{formatTimestamp(job.startedAt)}</p>
        </div>
        <div>
          <p className="uppercase tracking-widest text-slate-400 dark:text-slate-500">Completed</p>
          <p className="mt-1 text-slate-700 dark:text-slate-200">{formatTimestamp(job.completedAt)}</p>
        </div>
        <div className="lg:col-span-2">
          <p className="uppercase tracking-widest text-slate-400 dark:text-slate-500">
            {job.deliveryType === 'progressive' ? 'Playback URL' : 'Playback Manifest'}
          </p>
          <p className="mt-1 truncate text-primary-600 dark:text-primary-300">
            {job.publicUrl ?? 'Pending distribution URL'}
          </p>
        </div>
        {job.manifestUrl && job.manifestUrl !== job.publicUrl && (
          <div className="lg:col-span-2">
            <p className="uppercase tracking-widest text-slate-400 dark:text-slate-500">Manifest</p>
            <p className="mt-1 truncate text-primary-600 dark:text-primary-300">{job.manifestUrl}</p>
          </div>
        )}
        <div className="lg:col-span-2">
          <p className="uppercase tracking-widest text-slate-400 dark:text-slate-500">Poster</p>
          <p className="mt-1 truncate text-slate-700 dark:text-slate-200">
            {job.posterUrl ?? job.posterPath ?? 'Poster pending'}
          </p>
        </div>
        {job.sources.length > 0 && (
          <div className="lg:col-span-2">
            <p className="uppercase tracking-widest text-slate-400 dark:text-slate-500">Sources</p>
            <p className="mt-1 text-slate-700 dark:text-slate-200">
              {job.sources.map((source) => `${source.codec}: ${source.url}`).join(' | ')}
            </p>
          </div>
        )}
        <div className="lg:col-span-2">
          <p className="uppercase tracking-widest text-slate-400 dark:text-slate-500">Metadata</p>
          <p className="mt-1 text-slate-700 dark:text-slate-200">
            {job.tags.length > 0 ? `Tags: ${job.tags.join(', ')}` : 'No tags'}
            {job.playlistTitles.length > 0 ? ` | Playlists: ${job.playlistTitles.join(', ')}` : ''}
            {job.series ? ` | Series: ${job.series}` : ''}
            {job.recordedAt ? ` | Recorded: ${new Date(job.recordedAt).toLocaleString()}` : ''}
          </p>
          {(job.description || job.sidecarPath) && (
            <p className="mt-2 text-slate-500 dark:text-slate-400">
              {job.description ?? 'Metadata loaded from sidecar file.'}
              {job.sidecarPath ? ` Source metadata: ${job.sidecarPath}` : ''}
            </p>
          )}
        </div>
      </div>

      {job.status === 'error' && onRetry && (
        <div className="mt-4 flex justify-end">
          <button
            onClick={() => onRetry(job.id)}
            className="rounded-widget border border-red-400/20 bg-red-400/10 px-4 py-2
              text-xs font-semibold uppercase tracking-widest text-red-600
              transition hover:bg-red-400/20
              dark:text-red-300"
          >
            Retry Job
          </button>
        </div>
      )}
    </div>
  );
}

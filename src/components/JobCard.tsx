import { useState } from 'react';
import type {
  IngestJobSnapshot,
  IngestUploadAuditSnapshot,
  UploadAuditSectionSnapshot,
} from '../shared/types';
import { useBridge } from '../context/BridgeContext';
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

function formatAuditStatus(status: IngestUploadAuditSnapshot['status']) {
  switch (status) {
    case 'healthy':
      return { label: 'Audit Healthy', tone: 'good' as const };
    case 'partial':
      return { label: 'Partial Upload', tone: 'warning' as const };
    case 'missing':
      return { label: 'Upload Missing', tone: 'danger' as const };
    default:
      return { label: 'Audit Incomplete', tone: 'neutral' as const };
  }
}

function formatPipelineRoute(route: IngestJobSnapshot['pipelineRoute']) {
  if (route === 'web_streaming') return 'Manual VOD';
  if (route === 'clip_progressive') return 'Manual Clip';
  if (route === 'review_draft') return 'Review Draft';
  return null;
}

function formatObjectKeyPreview(objectKeys: string[]) {
  if (objectKeys.length === 0) {
    return 'None';
  }

  const preview = objectKeys.slice(0, 4);
  return objectKeys.length > 4
    ? `${preview.join(' | ')} | +${objectKeys.length - 4} more`
    : preview.join(' | ');
}

function AuditSection({ section }: { section: UploadAuditSectionSnapshot }) {
  const missingCount = section.missingObjectKeys.length;
  const unexpectedCount = section.unexpectedObjectKeys.length;
  const sizeMismatchCount = section.sizeMismatchObjectKeys.length;

  return (
    <div
      className="rounded-control border p-4 border-surface-hairline bg-surface-canvas"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink">{section.label}</p>
          <p className="mt-1 text-overline uppercase text-ink-dim">
            {section.storage.toUpperCase()} / {section.bucket}
          </p>
        </div>
        <StatusBadge tone={missingCount + unexpectedCount + sizeMismatchCount > 0 ? 'warning' : 'good'}>
          {missingCount + unexpectedCount + sizeMismatchCount > 0
            ? `${missingCount + unexpectedCount + sizeMismatchCount} Issue${
                missingCount + unexpectedCount + sizeMismatchCount === 1 ? '' : 's'
              }`
            : 'Matches'}
        </StatusBadge>
      </div>

      <div className="mt-3 grid gap-3 text-xs lg:grid-cols-2">
        <div>
          <p className="uppercase tracking-[.09em] text-ink-dim">Local Source</p>
          <p className="mt-1 text-ink-strong">
            {section.localPath ?? 'No local path recorded'}
          </p>
          <p className="mt-1 text-ink-muted">
            {section.localExists ? 'Local files available for comparison.' : 'Local comparison files are unavailable.'}
          </p>
        </div>
        <div>
          <p className="uppercase tracking-[.09em] text-ink-dim">Remote Prefix</p>
          <p className="mt-1 text-ink-strong">{section.remotePrefix}</p>
          <p className="mt-1 text-ink-muted">
            Expected {section.expectedObjects.length} object{section.expectedObjects.length === 1 ? '' : 's'} /
            Found {section.remoteObjects.length}
          </p>
        </div>
        <div className="lg:col-span-2">
          <p className="uppercase tracking-[.09em] text-ink-dim">Missing</p>
          <p className="mt-1 text-ink-strong">
            {formatObjectKeyPreview(section.missingObjectKeys)}
          </p>
        </div>
        <div className="lg:col-span-2">
          <p className="uppercase tracking-[.09em] text-ink-dim">Unexpected Remote Objects</p>
          <p className="mt-1 text-ink-strong">
            {formatObjectKeyPreview(section.unexpectedObjectKeys)}
          </p>
        </div>
        <div className="lg:col-span-2">
          <p className="uppercase tracking-[.09em] text-ink-dim">Size Mismatches</p>
          <p className="mt-1 text-ink-strong">
            {formatObjectKeyPreview(section.sizeMismatchObjectKeys)}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function JobCard({ job }: { job: IngestJobSnapshot }) {
  const { retryJob, auditJobUploads, resumeJobUploads, cleanupJobUploads } = useBridge();
  const [audit, setAudit] = useState<IngestUploadAuditSnapshot | null>(null);
  const [isAuditing, setIsAuditing] = useState(false);
  const [isResumingSamePrefix, setIsResumingSamePrefix] = useState(false);
  const [isCleaningRemote, setIsCleaningRemote] = useState(false);
  const status = statusConfig[job.status];
  const resolution =
    job.sourceWidth && job.sourceHeight
      ? `${job.sourceWidth}x${job.sourceHeight}`
      : 'Resolution pending';
  const displayTitle = job.title ?? job.sourceName;
  const canAuditUploads =
    Boolean(job.archiveObjectKey || job.distributionObjectKey) &&
    ['uploading', 'registering', 'error'].includes(job.status);
  const canRecoverUploads = job.status === 'error' && canAuditUploads;
  const auditStatus = audit ? formatAuditStatus(audit.status) : null;
  const routeLabel = formatPipelineRoute(job.pipelineRoute);

  async function handleAuditUploads() {
    setIsAuditing(true);
    try {
      setAudit(await auditJobUploads(job.id));
    } finally {
      setIsAuditing(false);
    }
  }

  async function handleResumeSamePrefix() {
    setIsResumingSamePrefix(true);
    try {
      await resumeJobUploads(job.id);
    } finally {
      setIsResumingSamePrefix(false);
    }
  }

  async function handleCleanupRemote() {
    setIsCleaningRemote(true);
    try {
      setAudit(await cleanupJobUploads(job.id));
    } finally {
      setIsCleaningRemote(false);
    }
  }

  return (
    <div
      className="rounded-control border p-5 transition-colors border-surface-hairline bg-surface-canvas"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-section text-ink">
              {displayTitle}
            </h4>
            {job.encoder && <StatusBadge tone="neutral">{job.encoder}</StatusBadge>}
            {routeLabel && <StatusBadge tone="active">{routeLabel}</StatusBadge>}
            {job.deliveryType && <StatusBadge tone="neutral">{job.deliveryType}</StatusBadge>}
            {job.contentType && <StatusBadge tone="neutral">{job.contentType}</StatusBadge>}
            {auditStatus && <StatusBadge tone={auditStatus.tone}>{auditStatus.label}</StatusBadge>}
          </div>
          {job.title && job.title !== job.sourceName && (
            <p className="mt-1 truncate text-overline uppercase text-ink-dim">
              Source file: {job.sourceName}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-dim">
            <span>{formatBytes(job.sourceSizeBytes)}</span>
            <span className="text-ink-muted">/</span>
            <span>{resolution}</span>
            <span className="text-ink-muted">/</span>
            <span>{formatFrameRate(job.sourceFrameRate)}</span>
            <span className="text-ink-muted">/</span>
            <span>{job.stage.replace(/-/g, ' ')}</span>
            <span className="text-ink-muted">/</span>
            <span>{job.durationSeconds ? `${Math.round(job.durationSeconds)}s` : 'Duration pending'}</span>
          </div>
        </div>
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      </div>

      <p className="mb-4 text-sm text-ink-strong">{job.message}</p>

      <div className="space-y-3">
        <ProgressBar label="Encoding" value={job.encodingProgress} variant="primary" />
        <ProgressBar label="Uploading" value={job.uploadProgress} variant="secondary" />
      </div>

      <div className="mt-4 grid gap-3 text-xs lg:grid-cols-2">
        <div>
          <p className="uppercase tracking-[.09em] text-ink-dim">Started</p>
          <p className="mt-1 text-ink-strong">{formatTimestamp(job.startedAt)}</p>
        </div>
        <div>
          <p className="uppercase tracking-[.09em] text-ink-dim">Completed</p>
          <p className="mt-1 text-ink-strong">{formatTimestamp(job.completedAt)}</p>
        </div>
        <div className="lg:col-span-2">
          <p className="uppercase tracking-[.09em] text-ink-dim">
            {job.deliveryType === 'progressive' ? 'Playback URL' : 'Playback Manifest'}
          </p>
          <p className="mt-1 truncate text-primary-200">
            {job.publicUrl ?? 'Pending distribution URL'}
          </p>
        </div>
        {job.manifestUrl && job.manifestUrl !== job.publicUrl && (
          <div className="lg:col-span-2">
            <p className="uppercase tracking-[.09em] text-ink-dim">Manifest</p>
            <p className="mt-1 truncate text-primary-200">{job.manifestUrl}</p>
          </div>
        )}
        <div className="lg:col-span-2">
          <p className="uppercase tracking-[.09em] text-ink-dim">Poster</p>
          <p className="mt-1 truncate text-ink-strong">
            {job.posterUrl ?? job.posterPath ?? 'Poster pending'}
          </p>
        </div>
        {job.sources.length > 0 && (
          <div className="lg:col-span-2">
            <p className="uppercase tracking-[.09em] text-ink-dim">Sources</p>
            <p className="mt-1 text-ink-strong">
              {job.sources.map((source) => `${source.codec}: ${source.url}`).join(' | ')}
            </p>
          </div>
        )}
        <div className="lg:col-span-2">
          <p className="uppercase tracking-[.09em] text-ink-dim">Metadata</p>
          <p className="mt-1 text-ink-strong">
            {job.tags.length > 0 ? `Tags: ${job.tags.join(', ')}` : 'No tags'}
            {job.playlistTitles.length > 0 ? ` | Playlists: ${job.playlistTitles.join(', ')}` : ''}
            {job.series ? ` | Series: ${job.series}` : ''}
            {job.recordedAt ? ` | Recorded: ${new Date(job.recordedAt).toLocaleString()}` : ''}
          </p>
          {(job.description || job.sidecarPath) && (
            <p className="mt-2 text-ink-muted">
              {job.description ?? 'Metadata loaded from sidecar file.'}
              {job.sidecarPath ? ` Source metadata: ${job.sidecarPath}` : ''}
            </p>
          )}
        </div>
      </div>

      {canAuditUploads && (
        <div className="mt-4 space-y-3 pt-4 border-surface-hairline">
          <div className="flex flex-wrap justify-end gap-2">
            <button
              onClick={() => void handleAuditUploads()}
              className="rounded-control border border-secondary-500/30 bg-secondary-500/[.13] px-4 py-2 text-overline uppercase transition hover:bg-secondary-500/20 disabled:cursor-not-allowed disabled:opacity-60 text-secondary-300"
              disabled={isAuditing}
            >
              {isAuditing ? 'Auditing...' : 'Audit Upload'}
            </button>
            {canRecoverUploads && (
              <>
                <button
                  onClick={() => void handleResumeSamePrefix()}
                  className="rounded-control border border-primary-500/40 bg-primary-500/[.13] px-4 py-2 text-overline uppercase transition hover:bg-primary-500/20 disabled:cursor-not-allowed disabled:opacity-60 text-primary-200"
                  disabled={isResumingSamePrefix}
                >
                  {isResumingSamePrefix ? 'Queueing...' : 'Resume Same Prefix'}
                </button>
                <button
                  onClick={() => void retryJob(job.id)}
                  className="rounded-control border border-state-danger/30 bg-state-danger/[.12] px-4 py-2 text-overline uppercase transition hover:bg-red-400/20 text-state-danger"
                >
                  Retry Fresh Job
                </button>
                <button
                  onClick={() => void handleCleanupRemote()}
                  className="rounded-control border px-4 py-2 text-overline uppercase transition disabled:cursor-not-allowed disabled:opacity-60 border-surface-hairline bg-surface-card text-ink-strong hover:bg-surface-elevated"
                  disabled={isCleaningRemote}
                >
                  {isCleaningRemote ? 'Cleaning...' : 'Clean Up Remote'}
                </button>
              </>
            )}
          </div>

          {audit && (
            <div className="space-y-3">
              <div
                className="rounded-control border p-4 text-sm border-surface-hairline bg-surface-card"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-ink">{audit.message}</p>
                    <p className="mt-1 text-overline uppercase text-ink-dim">
                      Audited {new Date(audit.auditedAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <StatusBadge tone={auditStatus?.tone ?? 'neutral'}>
                      {auditStatus?.label ?? 'Audit'}
                    </StatusBadge>
                    {audit.canResumeSamePrefix && <StatusBadge tone="active">Same Prefix Ready</StatusBadge>}
                    {audit.canCleanupRemote && <StatusBadge tone="warning">Remote Objects Found</StatusBadge>}
                  </div>
                </div>
              </div>

              {audit.archive && <AuditSection section={audit.archive} />}
              {audit.distribution && <AuditSection section={audit.distribution} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import type { IngestJobSnapshot, JobStage, JobStatus } from '../shared/types';

/**
 * Bridge's translation layer.
 *
 * The web app states what a thing *is* — "Probe failed — unreadable header".
 * Bridge says what happened to a person: "The connection dropped partway
 * through, so some pieces never reached the cloud", with the raw string kept
 * one click away behind a disclosure. Nothing here invents information; it only
 * renames what the pipeline already reported. See design.md §6.
 */

/** The four named steps every file walks, as an index into `PIPELINE_STEPS`. */
export function stepIndexForJob(job: IngestJobSnapshot): number {
  switch (job.status) {
    case 'queued':
    case 'checking':
      return 0;
    case 'encoding':
      return 1;
    case 'uploading':
      return 2;
    case 'registering':
      return 3;
    case 'complete':
      return 4;
    default:
      return stepIndexForStage(job.stage);
  }
}

function stepIndexForStage(stage: JobStage): number {
  switch (stage) {
    case 'waiting':
    case 'file-ready':
    case 'fingerprinting':
    case 'checking-duplicate':
      return 0;
    case 'encoding':
      return 1;
    case 'uploading-archive':
    case 'uploading-distribution':
    case 'verifying':
      return 2;
    case 'cleaning':
    case 'registering':
      return 3;
    default:
      return 0;
  }
}

/** What the machine is doing right now, said plainly. */
export function plainStage(job: IngestJobSnapshot): string {
  switch (job.stage) {
    case 'waiting':
      return 'Waiting for the file to finish copying into the folder.';
    case 'file-ready':
    case 'fingerprinting':
    case 'checking-duplicate':
      return 'Checking the file is complete and has not been brought in before.';
    case 'encoding':
      return 'Converting so it plays smoothly on phones and slow connections.';
    case 'uploading-archive':
      return 'Sending the original camera file to long-term storage.';
    case 'uploading-distribution':
      return 'Sending the playable version to the cloud.';
    case 'verifying':
      return 'Checking every piece arrived intact.';
    case 'cleaning':
      return 'Tidying up the temporary files.';
    case 'registering':
      return 'Adding it to the library.';
    case 'complete':
      return 'Finished and added to Videos.';
    case 'error':
      return 'Stopped before it finished.';
    default:
      return job.message || 'Working on it.';
  }
}

/** A job's own name, preferring the title an operator gave it. */
export function jobName(job: IngestJobSnapshot): string {
  return job.title?.trim() || job.sourceName;
}

/** Which half of the work a progress figure belongs to. */
export function jobProgress(job: IngestJobSnapshot): number {
  if (job.status === 'uploading' || job.stage.startsWith('uploading')) {
    return job.uploadProgress;
  }

  return job.encodingProgress;
}

/**
 * How much longer, estimated from how long this job has already run against
 * how far it has got. Below 5% the estimate is noise, so the percentage is
 * shown instead of a made-up time.
 */
export function remainingLabel(job: IngestJobSnapshot, now = Date.now()): string {
  const percent = Math.max(0, Math.min(100, Math.round(jobProgress(job))));
  const startedAt = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;

  if (percent >= 5 && percent < 100 && Number.isFinite(startedAt)) {
    const elapsedMs = now - startedAt;
    if (elapsedMs > 0) {
      const remainingMs = (elapsedMs * (100 - percent)) / percent;
      const minutes = Math.round(remainingMs / 60000);
      if (minutes >= 1 && minutes < 600) {
        return `about ${minutes} min left`;
      }
      if (minutes < 1) {
        return 'less than a minute left';
      }
    }
  }

  return `${percent}%`;
}

export interface PlainFailure {
  /** The headline on the "needs you" card, naming the file and what stopped. */
  title: string;
  /** What actually happened, in a sentence with no machine vocabulary. */
  cause: string;
  /** What pressing the button will do. */
  suggestion: string;
  /** The button's own words. */
  action: string;
}

/**
 * Turn a raw failure into the three sentences the "needs you" card is made of.
 * The classifier reads the pipeline's own error string but never shows it —
 * that stays behind "Show technical details".
 */
export function plainFailure(job: IngestJobSnapshot): PlainFailure {
  const name = jobName(job);
  const raw = (job.errorMessage ?? job.message ?? '').toLowerCase();
  const step = stepIndexForJob(job);

  if (/corrupt|transfer|rclone|network|econn|etimedout|timeout|socket|dns|503|502/.test(raw)) {
    return {
      title: `${name} didn’t finish uploading`,
      cause: 'The connection dropped partway through, so some pieces never reached the cloud.',
      suggestion: 'Trying again picks up where it left off — nothing needs to be re-converted.',
      action: 'Try again',
    };
  }

  if (/probe|unreadable|moov|header|invalid data|no such file|truncat/.test(raw)) {
    return {
      title: `${name} couldn’t be read`,
      cause: 'The file looks incomplete — the part that describes the video is missing.',
      suggestion:
        'If it was still copying when it was picked up, try again once the copy has finished.',
      action: 'Try again',
    };
  }

  if (/ffmpeg|encode|codec|videotoolbox|nvenc|libx264/.test(raw)) {
    return {
      title: `${name} didn’t finish converting`,
      cause: 'The converter stopped before it reached the end of the video.',
      suggestion: 'Trying again starts the conversion over from the beginning.',
      action: 'Try again',
    };
  }

  if (/convex|mutation|unauthor|token|forbidden|401|403/.test(raw)) {
    return {
      title: `${name} isn’t in the library yet`,
      cause: 'The video was converted and uploaded, but the library didn’t accept the record.',
      suggestion: 'Check the library connection in Settings, then try again.',
      action: 'Try again',
    };
  }

  return {
    title:
      step >= 2
        ? `${name} didn’t finish uploading`
        : step === 1
          ? `${name} didn’t finish converting`
          : `${name} stopped before it finished`,
    cause: 'Something interrupted this one before it reached the end.',
    suggestion: 'Trying again picks up from the last step that completed.',
    action: 'Try again',
  };
}

/**
 * A job that failed on the way to the cloud and is waiting for another go.
 *
 * These are deliberately not "needs you": the bytes are safe on disk, the
 * retry resumes into the same object keys, and nobody has to do anything. They
 * only become an operator's problem once the retries run out.
 */
export function isWaitingToRetry(job: IngestJobSnapshot) {
  return job.status === 'error' && Boolean(job.nextRetryAt);
}

/** Whether a job has stopped and genuinely wants a person. */
export function needsAPerson(job: IngestJobSnapshot) {
  return job.status === 'error' && !job.nextRetryAt;
}

/** Whether a job is still moving. */
export function isInFlight(status: JobStatus) {
  return (
    status === 'checking' || status === 'encoding' || status === 'uploading' || status === 'registering'
  );
}

/** A finished job's one-line summary, in the operator's words. */
export function plainFinished(job: IngestJobSnapshot): string {
  const parts: string[] = ['Ready to publish'];
  if (job.durationSeconds) {
    parts.push(formatClock(job.durationSeconds));
  }
  return parts.join(' · ');
}

/** 2h 14m / 42m / 42s — durations as an operator reads them, not as timecode. */
export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '—';
  }

  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

/** Byte counts at the precision an operator cares about. */
export function formatBytes(bytes: number | null | undefined): string {
  if (!Number.isFinite(bytes ?? Number.NaN) || (bytes ?? 0) <= 0) {
    return '—';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes as number;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** "Sep 7, 2026 · 8:42 PM" — the one date format Bridge uses. */
export function formatWhen(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })} · ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/** The same instant with the year dropped, for cards that are tight on room. */
export function formatWhenShort(value: string | null | undefined): string {
  return formatWhen(value).replace(/,\s*\d{4}/, '');
}

export function isToday(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

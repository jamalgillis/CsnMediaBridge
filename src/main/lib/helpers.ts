import crypto from 'node:crypto';
import path from 'node:path';

export function createId() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

export function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function joinObjectKey(...parts: Array<string | null | undefined>) {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

export function joinPublicUrl(baseUrl: string, ...parts: Array<string | null | undefined>) {
  const normalizedBase = baseUrl.trim().replace(/\/+$/g, '');
  const objectKey = joinObjectKey(...parts);
  return objectKey ? `${normalizedBase}/${objectKey}` : normalizedBase;
}

export function buildJobFolderName(sourcePath: string, jobId: string) {
  const sourceBase = slugify(path.parse(sourcePath).name) || 'vod';
  return `${sourceBase}-${jobId.slice(0, 8)}`;
}

export function parseTimemarkToSeconds(value: string | undefined) {
  if (!value) {
    return 0;
  }

  const segments = value.split(':').map((segment) => Number(segment));
  if (segments.some((segment) => Number.isNaN(segment))) {
    return 0;
  }

  while (segments.length < 3) {
    segments.unshift(0);
  }

  const [hours, minutes, seconds] = segments;
  return hours * 3600 + minutes * 60 + seconds;
}

export function formatFriendlyError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function isHardwareAccelerationFailure(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('cuda') ||
    normalized.includes('nvenc') ||
    normalized.includes('videotoolbox') ||
    normalized.includes('out of memory') ||
    normalized.includes('cannot allocate memory') ||
    normalized.includes('hardware accelerator failed') ||
    normalized.includes('vt decoder')
  );
}

export function detectPipelineError(message: string) {
  const normalized = message.toLowerCase();

  if (isHardwareAccelerationFailure(message)) {
    return 'Hardware encoding failed. Check GPU availability or change the encoder override in Settings.';
  }

  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return 'A network timeout interrupted the upload. Verify connectivity and try the job again.';
  }

  if (normalized.includes('enoent') || normalized.includes('not found')) {
    return 'A required executable or file path could not be found. Confirm ffmpeg, ffprobe, rclone, and your folders are available.';
  }

  return message;
}

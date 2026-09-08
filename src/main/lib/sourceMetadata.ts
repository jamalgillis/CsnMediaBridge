import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type {
  ContentType,
  RequestedDeliveryType,
  ReviewStatus,
  SocialDeploymentStatus,
} from '../../shared/types';

export const SUPPORTED_INGEST_EXTENSIONS = ['.mp4', '.mov', '.mkv'] as const;

export interface SourceMetadata {
  title?: string;
  description?: string;
  series?: string;
  recordedAt?: string;
  projectName?: string;
  eventName?: string;
  cameraId?: string;
  sourceNode?: string;
  reviewStatus?: ReviewStatus;
  socialStatus?: SocialDeploymentStatus;
  scheduledPublishAt?: string;
  requestedDelivery?: RequestedDeliveryType;
  contentType?: ContentType;
  tags: string[];
  playlistTitles: string[];
  sidecarPath: string | null;
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
          .filter(Boolean),
      ),
    );
  }

  if (typeof value === 'string') {
    return Array.from(
      new Set(
        value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    );
  }

  return [];
}

function normalizeRequestedDelivery(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'progressive' || normalized === 'hls') {
    return normalized;
  }

  return undefined;
}

function normalizeContentType(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'clip' || normalized === 'vod') {
    return normalized;
  }

  return undefined;
}

function normalizeReviewStatus(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'needs_review' || normalized === 'approved' || normalized === 'archived') {
    return normalized;
  }

  return undefined;
}

function normalizeSocialStatus(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (
    normalized === 'none' ||
    normalized === 'staged' ||
    normalized === 'scheduled' ||
    normalized === 'published' ||
    normalized === 'failed'
  ) {
    return normalized;
  }

  return undefined;
}

export async function loadSourceMetadata(sourcePath: string): Promise<SourceMetadata> {
  const parsed = path.parse(sourcePath);
  const candidates = [
    path.join(parsed.dir, `${parsed.name}.bridge.json`),
    path.join(parsed.dir, `${parsed.name}.metadata.json`),
  ];

  for (const candidatePath of candidates) {
    try {
      await access(candidatePath, fsConstants.R_OK);
      const raw = await readFile(candidatePath, 'utf8');
      const json = JSON.parse(raw) as Record<string, unknown>;

      return {
        title: normalizeOptionalString(json.title),
        description: normalizeOptionalString(json.description),
        series: normalizeOptionalString(json.series),
        recordedAt: normalizeOptionalString(json.recordedAt),
        projectName: normalizeOptionalString(json.projectName ?? json.project ?? json.client),
        eventName: normalizeOptionalString(json.eventName ?? json.event ?? json.shootName),
        cameraId: normalizeOptionalString(json.cameraId ?? json.camera ?? json.cameraLetter),
        sourceNode: normalizeOptionalString(json.sourceNode ?? json.source ?? json.node),
        reviewStatus: normalizeReviewStatus(json.reviewStatus ?? json.review),
        socialStatus: normalizeSocialStatus(json.socialStatus ?? json.socialDeploymentStatus),
        scheduledPublishAt: normalizeOptionalString(json.scheduledPublishAt ?? json.publishAt),
        requestedDelivery: normalizeRequestedDelivery(
          json.requestedDelivery ?? json.deliveryType ?? json.delivery,
        ),
        contentType: normalizeContentType(json.contentType),
        tags: normalizeStringArray(json.tags),
        playlistTitles: normalizeStringArray(json.playlistTitles ?? json.playlists),
        sidecarPath: candidatePath,
      };
    } catch {
      continue;
    }
  }

  return {
    requestedDelivery: undefined,
    contentType: undefined,
    reviewStatus: undefined,
    socialStatus: undefined,
    tags: [],
    playlistTitles: [],
    sidecarPath: null,
  };
}

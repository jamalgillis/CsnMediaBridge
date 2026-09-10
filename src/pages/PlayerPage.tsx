import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import StatusBadge from '../components/StatusBadge';
import StoredVideoPlayer from '../components/StoredVideoPlayer';
import { useBridge } from '../context/BridgeContext';
import { getPrimaryPlaybackUrl, inferStoredContentType, inferStoredDeliveryType } from '../shared/media';
import { swatchFor } from '../shared/csn';
import Thumb from '../components/csn/Thumb';
import {
  AddToCollectionIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CollectionIcon,
} from '../components/csn/icons';
import type {
  ContentType,
  DeliveryType,
  ReviewStatus,
  SocialDeploymentStatus,
  ArchivePreviewResult,
  StoredVideoPosterCandidate,
  StoredVideoSnapshot,
  StoredVideoStatus,
} from '../shared/types';

const STATUS_CHIP_OPTIONS: Array<'all' | StoredVideoStatus> = [
  'all',
  'ready',
  'draft',
  'archived',
  'error',
  'processing',
  'uploading',
];

const CONTENT_TYPE_CHIP_OPTIONS: Array<'all' | ContentType> = ['all', 'clip', 'vod'];
const DELIVERY_CHIP_OPTIONS: Array<'all' | DeliveryType> = ['all', 'progressive', 'hls'];
const REVIEW_STATUS_OPTIONS: ReviewStatus[] = ['needs_review', 'approved', 'archived'];
const SOCIAL_STATUS_OPTIONS: SocialDeploymentStatus[] = ['none', 'staged', 'scheduled', 'published', 'failed'];

const EDITABLE_STATUS_OPTIONS: StoredVideoStatus[] = [
  'draft',
  'ready',
  'archived',
  'error',
  'processing',
  'uploading',
];

const SORT_OPTIONS = [
  { id: 'newest', label: 'Newest' },
  { id: 'oldest', label: 'Oldest' },
  { id: 'title', label: 'Title A-Z' },
  { id: 'duration', label: 'Duration' },
  { id: 'status', label: 'Status' },
  { id: 'size', label: 'File size' },
] as const;
type SortOption = (typeof SORT_OPTIONS)[number]['id'];

/** The top bar speaks the shell's vocabulary; the library sorts by its own. */
const SORT_PARAM_TO_OPTION: Record<string, SortOption> = {
  recent: 'newest',
  name: 'title',
  duration: 'duration',
  size: 'size',
};

const LIBRARY_FILTER_OPTIONS = ['all', 'vod', 'short', 'published', 'processing'] as const;
type LibraryFilterOption = (typeof LIBRARY_FILTER_OPTIONS)[number];
const LIBRARY_FILTER_LABELS: Record<LibraryFilterOption, string> = {
  all: 'All',
  vod: 'VOD',
  short: 'Short-form',
  published: 'Published',
  processing: 'Processing',
};
const FILTER_PARAM_TO_RAIL_ID: Record<LibraryFilterOption, string> = {
  all: 'all',
  vod: 'content-type:vod',
  short: 'content-type:clip',
  published: 'social:published',
  processing: 'status:processing',
};

const PREVIEWABLE_STATUSES = new Set<StoredVideoStatus>(['ready', 'draft', 'archived']);
const DEFAULT_SERIES_OPTIONS = [
  'Friday Night Lights',
  'Game Highlights',
  'Player Spotlights',
  'Coach Interviews',
  'Weekly Recap',
  'Season Preview',
];
const DEFAULT_PLAYLIST_OPTIONS = [
  'Top Plays',
  'Full Games',
  'Game Recaps',
  'Interviews',
  'Practice Reports',
  'Signing Day',
  'Senior Night',
  'Championship Run',
];
const DEFAULT_TAG_OPTIONS = [
  'football',
  'basketball',
  'baseball',
  'softball',
  'volleyball',
  'soccer',
  'track',
  'wrestling',
  'highlights',
  'full-game',
  'interview',
  'recap',
  'varsity',
  'junior-varsity',
  'playoffs',
  'championship',
  'home-game',
  'away-game',
];

interface VideoEditorDraft {
  title: string;
  status: StoredVideoStatus;
  tagsInput: string;
  playlistInput: string;
  description: string;
  series: string;
  recordedAtInput: string;
  projectName: string;
  eventName: string;
  cameraId: string;
  sourceNode: string;
  reviewStatus: ReviewStatus;
}

type RailFilter =
  | { kind: 'all' }
  | { kind: 'status'; status: StoredVideoStatus }
  | { kind: 'content-type'; contentType: ContentType }
  | { kind: 'pipeline'; value: PipelineLayer }
  | { kind: 'architecture'; value: DeliveryArchitecture }
  | { kind: 'review'; value: ReviewStatus }
  | { kind: 'social'; value: SocialDeploymentStatus }
  | { kind: 'project'; value: string }
  | { kind: 'event'; value: string }
  | { kind: 'camera'; value: string }
  | { kind: 'source-node'; value: string }
  | { kind: 'series'; value: string }
  | { kind: 'playlist'; value: string }
  | { kind: 'tag'; value: string }
  | { kind: 'unsorted' };

interface RailItem {
  id: string;
  label: string;
  count: number;
  filter: RailFilter;
}

interface RailSection {
  id: string;
  label: string;
  collapsible: boolean;
  items: RailItem[];
}

type PipelineLayer = 'web-streaming' | 'social-staging' | 'social-scheduled' | 'master-archive';
type DeliveryArchitecture = 'hls' | 'progressive-mp4' | 'progressive-webm' | 'master-archive';

interface SingleValuePickerProps {
  label: string;
  value: string;
  options: string[];
  placeholder: string;
  onChange: (value: string) => void;
}

interface MultiValuePickerProps {
  label: string;
  values: string[];
  options: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function formatDuration(durationSeconds: number) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 'Duration pending';
  }

  const totalSeconds = Math.round(durationSeconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDate(value: string | undefined) {
  if (!value) {
    return 'Unknown date';
  }

  return new Date(value).toLocaleString();
}

function formatShortDate(value: string | undefined) {
  if (!value) {
    return 'Unknown date';
  }

  const date = new Date(value);
  // Card meta lines drop the year unless it differs from the current one.
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Exact dimensions, for the metadata table. */
function formatResolution(video: StoredVideoSnapshot) {
  if (!video.sourceWidth || !video.sourceHeight) {
    return 'Resolution pending';
  }

  return `${video.sourceWidth}x${video.sourceHeight}`;
}

/** Broadcast shorthand (4K / 1080p / …) for the dense card meta line. */
function formatResolutionShort(video: StoredVideoSnapshot) {
  const height = video.sourceHeight;
  if (!video.sourceWidth || !height) {
    return 'Resolution pending';
  }

  if (height >= 2000) return video.sourceWidth >= 7000 ? '8K' : '4K';
  if (height >= 1400) return '1440p';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  if (height >= 460) return '480p';
  return `${height}p`;
}

function formatFrameRate(value: number | undefined) {
  if (!value || value <= 0) {
    return 'Frame rate pending';
  }

  return `${value.toFixed(Number.isInteger(value) ? 0 : 3)} fps`;
}

function formatFileSize(bytes: number | undefined) {
  if (!bytes || bytes <= 0) {
    return 'Size pending';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;

  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatCodec(value: string | undefined) {
  return value?.trim() || 'Codec pending';
}

function formatStatusLabel(status: StoredVideoStatus) {
  return status[0].toUpperCase() + status.slice(1);
}

function formatContentTypeLabel(contentType: 'all' | ContentType) {
  if (contentType === 'all') return 'All Types';
  return contentType === 'clip' ? 'Clip' : 'VOD';
}

function formatDeliveryLabel(delivery: 'all' | DeliveryType) {
  if (delivery === 'all') return 'All Delivery';
  return delivery === 'progressive' ? 'Progressive' : 'HLS';
}

function formatReviewStatusLabel(status: ReviewStatus) {
  if (status === 'needs_review') return 'Needs Review';
  if (status === 'approved') return 'Approved / Verified';
  return 'Archived';
}

function formatSocialStatusLabel(status: SocialDeploymentStatus) {
  if (status === 'none') return 'Not Scheduled';
  if (status === 'staged') return 'Social Staging';
  if (status === 'scheduled') return 'Queued / Scheduled';
  if (status === 'published') return 'Published';
  return 'Failed Deployment';
}

function formatPipelineLayerLabel(layer: PipelineLayer) {
  if (layer === 'web-streaming') return 'Web Streaming';
  if (layer === 'social-staging') return 'Social Staging';
  if (layer === 'social-scheduled') return 'Social Scheduled';
  return 'Master Archive';
}

function formatArchitectureLabel(architecture: DeliveryArchitecture) {
  if (architecture === 'hls') return 'Adaptive HLS';
  if (architecture === 'progressive-mp4') return 'Progressive MP4';
  if (architecture === 'progressive-webm') return 'Progressive WebM';
  return 'Master Archive';
}

function getStatusTone(status: StoredVideoStatus): 'good' | 'active' | 'warning' | 'danger' | 'neutral' {
  if (status === 'ready') {
    return 'good';
  }

  if (status === 'error' || status === 'archived') {
    return 'danger';
  }

  if (status === 'processing' || status === 'uploading') {
    return 'active';
  }

  if (status === 'draft') {
    return 'warning';
  }

  return 'neutral';
}

function hasPlayableSource(video: StoredVideoSnapshot) {
  return Boolean(getPrimaryPlaybackUrl(video));
}

function canPreviewVideo(video: StoredVideoSnapshot) {
  return PREVIEWABLE_STATUSES.has(video.status) && hasPlayableSource(video);
}

function pickDefaultVideoId(videos: StoredVideoSnapshot[]) {
  return videos.find((video) => canPreviewVideo(video))?._id ?? videos[0]?._id ?? null;
}

function getPreviewUnavailableCopy(status: StoredVideoStatus) {
  if (status === 'processing' || status === 'uploading') {
    return {
      title: 'Playback preview is not available yet',
      body: 'This asset is still being encoded or uploaded. Preview will unlock after cloud sync finishes and the stored record reaches a stable state.',
    };
  }

  if (status === 'error') {
    return {
      title: 'Playback preview is unavailable for this asset',
      body: 'This asset hit an ingest or upload error, so the stored playback files may not exist yet. You can still inspect metadata and resolve the job from the dashboard.',
    };
  }

  return {
    title: 'Playback preview is not available yet',
    body: 'This asset is visible in the library, but it does not currently have a stable playback source that the preview screen can use. You can still update metadata and manage publish state from this page.',
  };
}

function splitCommaSeparatedValues(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  );
}

function uniqueSortedValues(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function addUniqueValue(values: string[], value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return values;
  }

  return Array.from(new Set([...values, trimmed]));
}

function toDateTimeLocalValue(value: string | undefined) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

function matchesSearch(video: StoredVideoSnapshot, rawQuery: string) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return true;
  }

  const searchableFields = [
    video.title,
    video.sourceFileName,
    video.description ?? '',
    video.series ?? '',
    video.projectName ?? '',
    video.eventName ?? '',
    video.cameraId ?? '',
    video.sourceNode ?? '',
    video.tags.join(' '),
    (video.playlistTitles ?? []).join(' '),
    video.status,
  ];

  return searchableFields.some((field) => field.toLowerCase().includes(query));
}

function buildEditorDraft(video: StoredVideoSnapshot): VideoEditorDraft {
  return {
    title: video.title,
    status: video.status,
    tagsInput: video.tags.join(', '),
    playlistInput: (video.playlistTitles ?? []).join(', '),
    description: video.description ?? '',
    series: video.series ?? '',
    recordedAtInput: toDateTimeLocalValue(video.recordedAt),
    projectName: video.projectName ?? '',
    eventName: video.eventName ?? '',
    cameraId: video.cameraId ?? '',
    sourceNode: video.sourceNode ?? '',
    reviewStatus: video.reviewStatus ?? getEffectiveReviewStatus(video),
  };
}

function getStorageStrings(video: StoredVideoSnapshot) {
  return [
    video.archiveObjectKey,
    video.distributionObjectKey,
    video.manifestUrl,
    video.masterPlaylistUrl,
    video.dashManifestUrl,
    video.playbackUrl,
    ...(video.sources ?? []).flatMap((source) => [source.objectKey, source.url]),
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
}

function hasStorageFragment(video: StoredVideoSnapshot, fragment: string) {
  const normalizedFragment = fragment.toLowerCase().replace(/^\/+/, '');
  return getStorageStrings(video).some((value) => value.replace(/^\/+/, '').includes(normalizedFragment));
}

function matchesPipelineLayer(video: StoredVideoSnapshot, layer: PipelineLayer) {
  if (layer === 'social-staging') {
    return hasStorageFragment(video, 'staging/social');
  }

  if (layer === 'social-scheduled') {
    return hasStorageFragment(video, 'scheduled/social');
  }

  if (layer === 'master-archive') {
    return Boolean(video.archiveObjectKey);
  }

  return (
    hasStorageFragment(video, 'streaming') ||
    inferStoredDeliveryType(video) === 'hls' ||
    Boolean(getPrimaryPlaybackUrl(video))
  );
}

function matchesDeliveryArchitecture(video: StoredVideoSnapshot, architecture: DeliveryArchitecture) {
  const sources = video.sources ?? [];

  if (architecture === 'master-archive') {
    return Boolean(video.archiveObjectKey);
  }

  if (architecture === 'hls') {
    return inferStoredDeliveryType(video) === 'hls';
  }

  if (architecture === 'progressive-webm') {
    return sources.some((source) => source.mimeType.includes('webm') || source.codec === 'av1') ||
      /\.webm($|\?)/i.test(video.playbackUrl ?? '');
  }

  return sources.some((source) => source.mimeType.includes('mp4') || source.codec === 'h264') ||
    /\.mp4($|\?)/i.test(video.playbackUrl ?? '') ||
    inferStoredDeliveryType(video) === 'progressive';
}

function getEffectiveReviewStatus(video: StoredVideoSnapshot): ReviewStatus {
  if (video.reviewStatus) {
    return video.reviewStatus;
  }

  if (video.status === 'archived') {
    return 'archived';
  }

  if (video.status === 'ready') {
    return 'approved';
  }

  return 'needs_review';
}

function getEffectiveSocialStatus(video: StoredVideoSnapshot): SocialDeploymentStatus {
  if (video.socialStatus) {
    return video.socialStatus;
  }

  if (
    video.status === 'error' &&
    (hasStorageFragment(video, 'staging/social') || hasStorageFragment(video, 'scheduled/social'))
  ) {
    return 'failed';
  }

  if (hasStorageFragment(video, 'staging/social')) {
    return 'staged';
  }

  if (hasStorageFragment(video, 'scheduled/social')) {
    return 'scheduled';
  }

  return 'none';
}

function buildRailSections(videos: StoredVideoSnapshot[]): RailSection[] {
  const statusCounts: Record<StoredVideoStatus, number> = {
    processing: 0,
    uploading: 0,
    draft: 0,
    ready: 0,
    error: 0,
    archived: 0,
  };
  let clipCount = 0;
  let vodCount = 0;
  let unsortedCount = 0;
  const pipelineCounts: Record<PipelineLayer, number> = {
    'web-streaming': 0,
    'social-staging': 0,
    'social-scheduled': 0,
    'master-archive': 0,
  };
  const architectureCounts: Record<DeliveryArchitecture, number> = {
    hls: 0,
    'progressive-mp4': 0,
    'progressive-webm': 0,
    'master-archive': 0,
  };
  const reviewCounts: Record<ReviewStatus, number> = {
    needs_review: 0,
    approved: 0,
    archived: 0,
  };
  const socialCounts: Record<SocialDeploymentStatus, number> = {
    none: 0,
    staged: 0,
    scheduled: 0,
    published: 0,
    failed: 0,
  };
  const projectCounts = new Map<string, number>();
  const eventCounts = new Map<string, number>();
  const cameraCounts = new Map<string, number>();
  const sourceNodeCounts = new Map<string, number>();
  const seriesCounts = new Map<string, number>();
  const playlistCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();

  for (const video of videos) {
    statusCounts[video.status] = (statusCounts[video.status] ?? 0) + 1;

    const contentType = inferStoredContentType(video);
    if (contentType === 'clip') {
      clipCount += 1;
    } else {
      vodCount += 1;
    }

    for (const layer of Object.keys(pipelineCounts) as PipelineLayer[]) {
      if (matchesPipelineLayer(video, layer)) {
        pipelineCounts[layer] += 1;
      }
    }

    for (const architecture of Object.keys(architectureCounts) as DeliveryArchitecture[]) {
      if (matchesDeliveryArchitecture(video, architecture)) {
        architectureCounts[architecture] += 1;
      }
    }

    reviewCounts[getEffectiveReviewStatus(video)] += 1;
    socialCounts[getEffectiveSocialStatus(video)] += 1;

    const projectName = video.projectName?.trim();
    if (projectName) {
      projectCounts.set(projectName, (projectCounts.get(projectName) ?? 0) + 1);
    }

    const eventName = video.eventName?.trim();
    if (eventName) {
      eventCounts.set(eventName, (eventCounts.get(eventName) ?? 0) + 1);
    }

    const cameraId = video.cameraId?.trim();
    if (cameraId) {
      cameraCounts.set(cameraId, (cameraCounts.get(cameraId) ?? 0) + 1);
    }

    const sourceNode = video.sourceNode?.trim();
    if (sourceNode) {
      sourceNodeCounts.set(sourceNode, (sourceNodeCounts.get(sourceNode) ?? 0) + 1);
    }

    const series = video.series?.trim();
    if (series) {
      seriesCounts.set(series, (seriesCounts.get(series) ?? 0) + 1);
    }

    const playlists = Array.from(
      new Set((video.playlistTitles ?? []).map((title) => title.trim()).filter(Boolean)),
    );
    for (const playlist of playlists) {
      playlistCounts.set(playlist, (playlistCounts.get(playlist) ?? 0) + 1);
    }

    for (const tag of new Set(video.tags)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }

    if (!series && playlists.length === 0) {
      unsortedCount += 1;
    }
  }

  function sortedEntries(map: Map<string, number>) {
    return Array.from(map.entries()).sort(([leftLabel, leftCount], [rightLabel, rightCount]) => {
      if (rightCount !== leftCount) {
        return rightCount - leftCount;
      }
      return leftLabel.localeCompare(rightLabel);
    });
  }

  const librarySection: RailSection = {
    id: 'library',
    label: 'Library',
    collapsible: false,
    items: [
      { id: 'all', label: 'All Assets', count: videos.length, filter: { kind: 'all' } },
      {
        id: 'status:processing',
        label: 'Processing',
        count: statusCounts.processing,
        filter: { kind: 'status', status: 'processing' },
      },
      {
        id: 'status:ready',
        label: 'Ready',
        count: statusCounts.ready,
        filter: { kind: 'status', status: 'ready' },
      },
      {
        id: 'status:draft',
        label: 'Draft',
        count: statusCounts.draft,
        filter: { kind: 'status', status: 'draft' },
      },
      {
        id: 'status:archived',
        label: 'Archived',
        count: statusCounts.archived,
        filter: { kind: 'status', status: 'archived' },
      },
      {
        id: 'status:error',
        label: 'Errors',
        count: statusCounts.error,
        filter: { kind: 'status', status: 'error' },
      },
    ],
  };

  if (unsortedCount > 0) {
    librarySection.items.push({
      id: 'unsorted',
      label: 'Unsorted',
      count: unsortedCount,
      filter: { kind: 'unsorted' },
    });
  }

  const contentTypeSection: RailSection = {
    id: 'content-type',
    label: 'Content Type',
    collapsible: false,
    items: [
      {
        id: 'content-type:clip',
        label: 'Clips',
        count: clipCount,
        filter: { kind: 'content-type', contentType: 'clip' },
      },
      {
        id: 'content-type:vod',
        label: 'VOD',
        count: vodCount,
        filter: { kind: 'content-type', contentType: 'vod' },
      },
    ],
  };

  const pipelineSection: RailSection = {
    id: 'pipeline',
    label: 'Storage & Pipeline',
    collapsible: false,
    items: (Object.keys(pipelineCounts) as PipelineLayer[]).map((value) => ({
      id: `pipeline:${value}`,
      label: formatPipelineLayerLabel(value),
      count: pipelineCounts[value],
      filter: { kind: 'pipeline', value },
    })),
  };

  const architectureSection: RailSection = {
    id: 'architecture',
    label: 'Delivery Format',
    collapsible: false,
    items: (Object.keys(architectureCounts) as DeliveryArchitecture[]).map((value) => ({
      id: `architecture:${value}`,
      label: formatArchitectureLabel(value),
      count: architectureCounts[value],
      filter: { kind: 'architecture', value },
    })),
  };

  const reviewSection: RailSection = {
    id: 'review',
    label: 'Review',
    collapsible: false,
    items: REVIEW_STATUS_OPTIONS.map((value) => ({
      id: `review:${value}`,
      label: formatReviewStatusLabel(value),
      count: reviewCounts[value],
      filter: { kind: 'review', value },
    })),
  };

  const socialSection: RailSection = {
    id: 'social',
    label: 'Social Deployment',
    collapsible: false,
    items: SOCIAL_STATUS_OPTIONS.filter((value) => value !== 'none').map((value) => ({
      id: `social:${value}`,
      label: formatSocialStatusLabel(value),
      count: socialCounts[value],
      filter: { kind: 'social', value },
    })),
  };

  const productionSection: RailSection = {
    id: 'production',
    label: 'Projects & Sources',
    collapsible: true,
    items: [
      ...sortedEntries(projectCounts).map(([value, count]) => ({
        id: `project:${value.toLowerCase()}`,
        label: value,
        count,
        filter: { kind: 'project' as const, value },
      })),
      ...sortedEntries(eventCounts).map(([value, count]) => ({
        id: `event:${value.toLowerCase()}`,
        label: value,
        count,
        filter: { kind: 'event' as const, value },
      })),
      ...sortedEntries(cameraCounts).map(([value, count]) => ({
        id: `camera:${value.toLowerCase()}`,
        label: `Camera ${value}`,
        count,
        filter: { kind: 'camera' as const, value },
      })),
      ...sortedEntries(sourceNodeCounts).map(([value, count]) => ({
        id: `source-node:${value.toLowerCase()}`,
        label: value,
        count,
        filter: { kind: 'source-node' as const, value },
      })),
    ],
  };

  const seriesSection: RailSection = {
    id: 'series',
    label: 'Series',
    collapsible: true,
    items: sortedEntries(seriesCounts).map(([value, count]) => ({
      id: `series:${value.toLowerCase()}`,
      label: value,
      count,
      filter: { kind: 'series', value },
    })),
  };

  const playlistsSection: RailSection = {
    id: 'playlists',
    label: 'Playlists',
    collapsible: true,
    items: sortedEntries(playlistCounts).map(([value, count]) => ({
      id: `playlist:${value.toLowerCase()}`,
      label: value,
      count,
      filter: { kind: 'playlist', value },
    })),
  };

  const tagsSection: RailSection = {
    id: 'tags',
    label: 'Tags',
    collapsible: true,
    items: sortedEntries(tagCounts).map(([value, count]) => ({
      id: `tag:${value.toLowerCase()}`,
      label: value,
      count,
      filter: { kind: 'tag', value },
    })),
  };

  return [
    librarySection,
    pipelineSection,
    architectureSection,
    reviewSection,
    socialSection,
    contentTypeSection,
    productionSection,
    seriesSection,
    playlistsSection,
    tagsSection,
  ];
}

function matchesRailFilter(video: StoredVideoSnapshot, filter: RailFilter): boolean {
  switch (filter.kind) {
    case 'all':
      return true;
    case 'status':
      return video.status === filter.status;
    case 'content-type':
      return inferStoredContentType(video) === filter.contentType;
    case 'pipeline':
      return matchesPipelineLayer(video, filter.value);
    case 'architecture':
      return matchesDeliveryArchitecture(video, filter.value);
    case 'review':
      return getEffectiveReviewStatus(video) === filter.value;
    case 'social':
      return getEffectiveSocialStatus(video) === filter.value;
    case 'project':
      return (video.projectName ?? '').trim() === filter.value;
    case 'event':
      return (video.eventName ?? '').trim() === filter.value;
    case 'camera':
      return (video.cameraId ?? '').trim() === filter.value;
    case 'source-node':
      return (video.sourceNode ?? '').trim() === filter.value;
    case 'series':
      return (video.series ?? '').trim() === filter.value;
    case 'playlist':
      return (video.playlistTitles ?? []).some((title) => title.trim() === filter.value);
    case 'tag':
      return video.tags.includes(filter.value);
    case 'unsorted':
      return (
        !(video.series ?? '').trim() &&
        !(video.playlistTitles ?? []).some((title) => title.trim())
      );
    default:
      return true;
  }
}

function sortVideos(videos: StoredVideoSnapshot[], option: SortOption): StoredVideoSnapshot[] {
  const copy = [...videos];

  switch (option) {
    case 'newest':
      copy.sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      );
      break;
    case 'oldest':
      copy.sort(
        (left, right) => new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime(),
      );
      break;
    case 'title':
      copy.sort((left, right) => left.title.localeCompare(right.title));
      break;
    case 'duration':
      copy.sort((left, right) => (right.durationSeconds ?? 0) - (left.durationSeconds ?? 0));
      break;
    case 'status':
      copy.sort((left, right) => left.status.localeCompare(right.status));
      break;
    case 'size':
      copy.sort(
        (left, right) => (right.sourceFileSizeBytes ?? 0) - (left.sourceFileSizeBytes ?? 0),
      );
      break;
  }

  return copy;
}

function appendCacheBust(url: string | undefined, key: string | undefined) {
  if (!url) {
    return '';
  }

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}v=${encodeURIComponent(key ?? '')}`;
}

function getEmptyLibraryCopy(hasConvexConfig: boolean) {
  if (hasConvexConfig) {
    return {
      title: 'No stored videos yet',
      body: 'Once videos are registered in Convex, they will appear here for browsing, sorting, and management.',
    };
  }

  return {
    title: 'Convex connection needed',
    body: 'Add your Convex deployment URL and mutation path in Settings so the library can load stored content.',
  };
}

const PANEL_INPUT_CLASS = [
  'w-full rounded-control border border-white/10 bg-white/5',
  'px-4 py-3 text-sm text-paper outline-none transition',
  'placeholder:text-dim',
  'focus:border-accent-hi/35 focus:ring-1 focus:ring-accent-hi/20',
].join(' ');

function SingleValuePicker({ label, onChange, options, placeholder, value }: SingleValuePickerProps) {
  const [newValue, setNewValue] = useState('');

  function handleAddValue() {
    const trimmed = newValue.trim();
    if (!trimmed) {
      return;
    }

    onChange(trimmed);
    setNewValue('');
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') {
      return;
    }

    event.preventDefault();
    handleAddValue();
  }

  return (
    <div>
      <label className="mb-2 block font-condensed text-overline uppercase text-dim">
        {label}
      </label>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr),auto]">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={PANEL_INPUT_CLASS}
        >
          <option value="">No series</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {value && (
          <button
            onClick={() => onChange('')}
            className="rounded-control border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-body transition hover:bg-white/[.08]"
            type="button"
          >
            Clear
          </button>
        )}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr),auto]">
        <input
          value={newValue}
          onChange={(event) => setNewValue(event.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={placeholder}
          className={PANEL_INPUT_CLASS}
        />
        <button
          onClick={handleAddValue}
          className="rounded-control bg-accent px-4 py-3 text-sm font-semibold text-paper transition hover:bg-accent-hi disabled:cursor-not-allowed disabled:opacity-60"
          disabled={!newValue.trim()}
          type="button"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function MultiValuePicker({ label, onChange, options, placeholder, values }: MultiValuePickerProps) {
  const [newValue, setNewValue] = useState('');
  const availableOptions = options.filter((option) => !values.includes(option));

  function handleAddValue(value: string) {
    const nextValues = addUniqueValue(values, value);
    onChange(nextValues);
    setNewValue('');
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') {
      return;
    }

    event.preventDefault();
    handleAddValue(newValue);
  }

  return (
    <div>
      <label className="mb-2 block font-condensed text-overline uppercase text-dim">
        {label}
      </label>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr),minmax(0,1fr),auto]">
        <select
          value=""
          onChange={(event) => handleAddValue(event.target.value)}
          className={PANEL_INPUT_CLASS}
        >
          <option value="">Choose existing</option>
          {availableOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <input
          value={newValue}
          onChange={(event) => setNewValue(event.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={placeholder}
          className={PANEL_INPUT_CLASS}
        />
        <button
          onClick={() => handleAddValue(newValue)}
          className="rounded-control bg-accent px-4 py-3 text-sm font-semibold text-paper transition hover:bg-accent-hi disabled:cursor-not-allowed disabled:opacity-60"
          disabled={!newValue.trim()}
          type="button"
        >
          Add
        </button>
      </div>
      {values.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {values.map((selectedValue) => (
            <button
              key={selectedValue}
              onClick={() => onChange(values.filter((value) => value !== selectedValue))}
              className="rounded-full bg-white/8 px-3 py-1 font-condensed text-overline uppercase text-body transition hover:bg-white/12"
              type="button"
            >
              {selectedValue} x
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface FilterChipGroupProps<T extends string> {
  label: string;
  options: ReadonlyArray<T>;
  value: T;
  onChange: (value: T) => void;
  renderLabel: (option: T) => string;
}

function FilterChipGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  renderLabel,
}: FilterChipGroupProps<T>) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-condensed text-overline uppercase text-dim">
        {label}
      </span>
      <div className="flex gap-1.5">
        {options.map((option) => {
          const isActive = option === value;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              className={`shrink-0 rounded-chip border px-2.5 py-1 font-mono text-micro font-semibold uppercase tracking-[.03em] transition ${
                isActive
                  ? 'border-accent/50 bg-accent/[.16] text-accent-hi'
                  : 'border-white/[.08] bg-ink-tile text-dim hover:text-muted'
              }`}
            >
              {renderLabel(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface SeriesFilterProps {
  videos: StoredVideoSnapshot[];
  value: string;
  onChange: (next: string) => void;
}

/**
 * "All series" dropdown in the library header — an elevated popover
 * listing every collection with a live count and a hue dot matching the cards.
 */
function SeriesFilter({ videos, value, onChange }: SeriesFilterProps) {
  const [open, setOpen] = useState(false);

  const counts = new Map<string, number>();
  videos.forEach((video) => {
    (video.playlistTitles ?? []).forEach((title) => {
      counts.set(title, (counts.get(title) ?? 0) + 1);
    });
  });
  const series = Array.from(counts.entries()).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );

  const rows: Array<{ label: string; key: string; count: number; swatch: string | null }> = [
    { label: 'All series', key: '', count: videos.length, swatch: null },
    ...series.map(([name, count]) => ({ label: name, key: name, count, swatch: swatchFor(name) })),
  ];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={value ? 'csn-chip-on flex items-center gap-2' : 'csn-chip-off flex items-center gap-2'}
      >
        <CollectionIcon size={14} />
        <span>{value || 'All series'}</span>
        <ChevronDownIcon size={13} className="opacity-65" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="csn-pop absolute left-0 top-[calc(100%+8px)] w-[252px]">
            <div className="px-[11px] pb-[7px] pt-2 font-condensed text-overline uppercase text-dim">
              Filter by series
            </div>
            {rows.map((row) => {
              const active = row.key === value;
              return (
                <button
                  key={row.key || '__all'}
                  type="button"
                  onClick={() => {
                    onChange(row.key);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-chip px-[11px] py-[9px] text-left text-control transition hover:bg-white/[.05] ${
                    active ? 'bg-accent/[.14] text-paper' : 'text-body'
                  }`}
                >
                  <span
                    className="h-[11px] w-[11px] flex-none rounded-[3px]"
                    style={{
                      background: row.swatch ?? 'rgba(255,255,255,.22)',
                    }}
                  />
                  <span className="flex-1 truncate">{row.label}</span>
                  <span className="font-mono text-count text-dim">{row.count}</span>
                  {active && <CheckIcon size={14} className="text-accent-hi" strokeWidth={2.4} />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default function PlayerPage() {
  const { settings } = useBridge();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const libraryFilterParam = (searchParams.get('filter') as LibraryFilterOption | null) ?? 'all';
  const collectionParam = searchParams.get('collection') ?? '';
  const [videos, setVideos] = useState<StoredVideoSnapshot[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [selectedRailItemId, setSelectedRailItemId] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | StoredVideoStatus>('all');
  const [contentTypeFilter, setContentTypeFilter] = useState<'all' | ContentType>('all');
  const [deliveryFilter, setDeliveryFilter] = useState<'all' | DeliveryType>('all');

  // Search, sort, layout and select mode live in the URL so the global top bar
  // can drive the library from any route.
  const searchQuery = searchParams.get('q') ?? '';
  const sortOption = (SORT_PARAM_TO_OPTION[searchParams.get('sort') ?? 'recent'] ?? 'newest') as SortOption;
  const viewMode: 'gallery' | 'list' = searchParams.get('layout') === 'list' ? 'list' : 'gallery';
  const selectMode = searchParams.get('select') === '1';
  const [inspectorTab, setInspectorTab] = useState<'details' | 'metadata' | 'poster'>('details');
  const [editorDraft, setEditorDraft] = useState<VideoEditorDraft | null>(null);
  const [posterCandidates, setPosterCandidates] = useState<StoredVideoPosterCandidate[]>([]);
  const [selectedPosterCandidatePath, setSelectedPosterCandidatePath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingMetadata, setIsSavingMetadata] = useState(false);
  const [isDeletingVideo, setIsDeletingVideo] = useState(false);
  const [isRepairingUrls, setIsRepairingUrls] = useState(false);
  const [archivePreview, setArchivePreview] = useState<ArchivePreviewResult | null>(null);
  const [isLoadingArchivePreview, setIsLoadingArchivePreview] = useState(false);
  const [isRetrievingArchive, setIsRetrievingArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [isGeneratingPosterCandidates, setIsGeneratingPosterCandidates] = useState(false);
  const [isApplyingPoster, setIsApplyingPoster] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [isBulkWorking, setIsBulkWorking] = useState(false);
  const assetGridRef = useRef<HTMLDivElement | null>(null);

  const hasConvexConfig = Boolean(settings.convex.deploymentUrl && settings.convex.mutationPath);
  const deferredSearchQuery = useDeferredValue(searchQuery);

  useEffect(() => {
    let isMounted = true;

    if (!hasConvexConfig) {
      setVideos([]);
      setSelectedVideoId(null);
      setEditorDraft(null);
      setLoadError(null);
      return () => {
        isMounted = false;
      };
    }

    setIsLoading(true);
    setLoadError(null);

    void window.mediaBridge
      .listStoredVideos()
      .then((storedVideos) => {
        if (!isMounted) {
          return;
        }

        setVideos(storedVideos);
        setSelectedVideoId((currentVideoId) =>
          storedVideos.some((video) => video._id === currentVideoId)
            ? currentVideoId
            : pickDefaultVideoId(storedVideos),
        );
      })
      .catch((error) => {
        if (!isMounted) {
          return;
        }

        setVideos([]);
        setSelectedVideoId(null);
        setEditorDraft(null);
        setLoadError(getErrorMessage(error));
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [hasConvexConfig, refreshKey]);

  const railSections = useMemo(() => buildRailSections(videos), [videos]);
  const railLookup = useMemo(() => {
    const lookup = new Map<string, { section: RailSection; item: RailItem }>();
    for (const section of railSections) {
      for (const item of section.items) {
        lookup.set(item.id, { section, item });
      }
    }
    return lookup;
  }, [railSections]);

  const selectedRailEntry = railLookup.get(selectedRailItemId) ?? railLookup.get('all') ?? null;
  const seriesOptions = useMemo(
    () => uniqueSortedValues([...DEFAULT_SERIES_OPTIONS, ...videos.map((video) => video.series)]),
    [videos],
  );
  const playlistOptions = useMemo(
    () => uniqueSortedValues([...DEFAULT_PLAYLIST_OPTIONS, ...videos.flatMap((video) => video.playlistTitles ?? [])]),
    [videos],
  );
  const tagOptions = useMemo(
    () => uniqueSortedValues([...DEFAULT_TAG_OPTIONS, ...videos.flatMap((video) => video.tags)]),
    [videos],
  );

  useEffect(() => {
    if (railLookup.size === 0) {
      if (selectedRailItemId !== 'all') {
        setSelectedRailItemId('all');
      }
      return;
    }

    if (!railLookup.has(selectedRailItemId)) {
      setSelectedRailItemId('all');
    }
  }, [railLookup, selectedRailItemId]);

  useEffect(() => {
    setSelectedRailItemId(FILTER_PARAM_TO_RAIL_ID[libraryFilterParam] ?? 'all');
  }, [libraryFilterParam]);

  function setLibraryFilter(next: LibraryFilterOption) {
    setSearchParams((current) => {
      const nextParams = new URLSearchParams(current);
      if (next === 'all') {
        nextParams.delete('filter');
      } else {
        nextParams.set('filter', next);
      }
      return nextParams;
    });
  }

  function setCollectionFilter(next: string) {
    setSearchParams((current) => {
      const nextParams = new URLSearchParams(current);
      if (next) {
        nextParams.set('collection', next);
      } else {
        nextParams.delete('collection');
      }
      return nextParams;
    });
  }

  function clearCollectionFilter() {
    setSearchParams((current) => {
      const nextParams = new URLSearchParams(current);
      nextParams.delete('collection');
      return nextParams;
    });
  }

  const filteredVideos = useMemo(() => {
    const filter = selectedRailEntry?.item.filter ?? { kind: 'all' as const };
    const next = videos.filter((video) => {
      if (!matchesRailFilter(video, filter)) {
        return false;
      }

      if (statusFilter !== 'all' && video.status !== statusFilter) {
        return false;
      }

      if (contentTypeFilter !== 'all' && inferStoredContentType(video) !== contentTypeFilter) {
        return false;
      }

      if (deliveryFilter !== 'all' && inferStoredDeliveryType(video) !== deliveryFilter) {
        return false;
      }

      if (collectionParam && !(video.playlistTitles ?? []).includes(collectionParam)) {
        return false;
      }

      return matchesSearch(video, deferredSearchQuery);
    });

    return sortVideos(next, sortOption);
  }, [
    videos,
    selectedRailEntry,
    statusFilter,
    contentTypeFilter,
    deliveryFilter,
    collectionParam,
    deferredSearchQuery,
    sortOption,
  ]);

  useEffect(() => {
    if (!filteredVideos.some((video) => video._id === selectedVideoId)) {
      setSelectedVideoId(pickDefaultVideoId(filteredVideos));
    }
  }, [filteredVideos, selectedVideoId]);

  const selectedVideo =
    videos.find((video) => video._id === selectedVideoId) ??
    filteredVideos[0] ??
    videos[0] ??
    null;

  useEffect(() => {
    if (!selectedVideo) {
      setEditorDraft(null);
      setPosterCandidates([]);
      setSelectedPosterCandidatePath(null);
      return;
    }

    setEditorDraft(buildEditorDraft(selectedVideo));
    setPosterCandidates([]);
    setSelectedPosterCandidatePath(null);
  }, [selectedVideo?._id, selectedVideo?.updatedAt]);

  const [derivedClips, setDerivedClips] = useState<StoredVideoSnapshot[]>([]);

  useEffect(() => {
    let cancelled = false;

    if (!selectedVideo || inferStoredContentType(selectedVideo) === 'clip') {
      setDerivedClips([]);
      return;
    }

    window.mediaBridge
      .listClipsForVideo(selectedVideo._id)
      .then((clips) => {
        if (!cancelled) {
          setDerivedClips(clips);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDerivedClips([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedVideo?._id, refreshKey]);

  // A presigned URL is scoped to one object and expires, so it is discarded
  // whenever the selection changes rather than kept around per asset.
  useEffect(() => {
    setArchivePreview(null);
    setArchiveError(null);
  }, [selectedVideo?._id]);

  async function handlePreviewArchive() {
    if (!selectedVideo?.archiveObjectKey) {
      return;
    }

    setIsLoadingArchivePreview(true);
    setArchiveError(null);
    try {
      const result = await window.mediaBridge.getArchivePreviewUrl({
        videoId: selectedVideo._id,
        archiveObjectKey: selectedVideo.archiveObjectKey,
      });
      setArchivePreview(result);
      if (result.unavailableReason) {
        setArchiveError(result.unavailableReason);
      }
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingArchivePreview(false);
    }
  }

  async function handleRetrieveArchive() {
    if (!selectedVideo?.archiveObjectKey) {
      return;
    }

    setIsRetrievingArchive(true);
    setArchiveError(null);
    try {
      const result = await window.mediaBridge.retrieveArchivedMaster({
        videoId: selectedVideo._id,
        title: selectedVideo.title,
        archiveObjectKey: selectedVideo.archiveObjectKey,
        sourceFileName: selectedVideo.sourceFileName,
      });

      if (result.source) {
        navigate('/trimmer', { state: { source: result.source } });
      }
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRetrievingArchive(false);
    }
  }

  const playableSourceUrl = selectedVideo ? getPrimaryPlaybackUrl(selectedVideo) : '';
  const previewAvailable = selectedVideo ? canPreviewVideo(selectedVideo) : false;
  const selectedPosterCandidate =
    posterCandidates.find((candidate) => candidate.localPath === selectedPosterCandidatePath) ?? null;

  async function handleRepairStoredUrls() {
    setIsRepairingUrls(true);
    setLoadError(null);
    setLibraryNotice(null);

    try {
      const result = await window.mediaBridge.repairStoredVideoUrls();
      setLibraryNotice(
        result.updated > 0
          ? `Repaired ${result.updated} stored video URL${result.updated === 1 ? '' : 's'} and refreshed the library.`
          : `No stored URLs needed repair. Checked ${result.inspected} video${result.inspected === 1 ? '' : 's'}.`,
      );
      setRefreshKey((current) => current + 1);
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setIsRepairingUrls(false);
    }
  }

  async function handleSaveMetadata(nextStatus?: StoredVideoStatus) {
    if (!selectedVideo || !editorDraft) {
      return;
    }

    setIsSavingMetadata(true);
    setLoadError(null);
    setLibraryNotice(null);

    try {
      await window.mediaBridge.updateStoredVideoMetadata({
        videoId: selectedVideo._id,
        title: editorDraft.title.trim(),
        status: nextStatus ?? editorDraft.status,
        tags: splitCommaSeparatedValues(editorDraft.tagsInput),
        playlistTitles: splitCommaSeparatedValues(editorDraft.playlistInput),
        description: editorDraft.description.trim() || null,
        series: editorDraft.series.trim() || null,
        recordedAt: editorDraft.recordedAtInput
          ? new Date(editorDraft.recordedAtInput).toISOString()
          : null,
        projectName: editorDraft.projectName.trim() || null,
        eventName: editorDraft.eventName.trim() || null,
        cameraId: editorDraft.cameraId.trim() || null,
        sourceNode: editorDraft.sourceNode.trim() || null,
        reviewStatus: editorDraft.reviewStatus,
      });

      setLibraryNotice(
        nextStatus === 'ready'
          ? 'Video published and metadata saved.'
          : nextStatus === 'draft'
            ? 'Video unpublished and metadata saved.'
            : 'Stored video metadata saved.',
      );
      setRefreshKey((current) => current + 1);
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setIsSavingMetadata(false);
    }
  }

  async function handleDeleteVideo() {
    if (!selectedVideo) {
      return;
    }

    const deleteTargets = [
      'the Convex library record',
      selectedVideo.distributionObjectKey ? 'the R2 playback package' : null,
      selectedVideo.archiveObjectKey ? 'the B2 archive file' : null,
    ].filter(Boolean);

    const confirmed = window.confirm(
      `Delete "${selectedVideo.title}"?\n\nThis will remove ${deleteTargets.join(', ')}.\n\nThis cannot be undone.`,
    );

    if (!confirmed) {
      return;
    }

    setIsDeletingVideo(true);
    setLoadError(null);
    setLibraryNotice(null);

    try {
      const result = await window.mediaBridge.deleteStoredVideo({
        videoId: selectedVideo._id,
        title: selectedVideo.title,
        sourceFileName: selectedVideo.sourceFileName,
        archiveObjectKey: selectedVideo.archiveObjectKey,
        distributionObjectKey: selectedVideo.distributionObjectKey,
      });

      setVideos((current) => current.filter((video) => video._id !== result.videoId));
      setSelectedVideoId((current) => (current === result.videoId ? null : current));
      setInspectorTab('details');
      setLibraryNotice(`Deleted ${result.title} from the library and removed its linked cloud assets.`);
      setRefreshKey((current) => current + 1);
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setIsDeletingVideo(false);
    }
  }

  function setSelectMode(next: boolean) {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next) {
          params.set('select', '1');
        } else {
          params.delete('select');
        }
        return params;
      },
      { replace: true },
    );
  }

  function toggleSelected(videoId: string) {
    setSelectedIds((current) => {
      const next = { ...current };
      if (next[videoId]) {
        delete next[videoId];
      } else {
        next[videoId] = true;
      }
      return next;
    });
  }

  const selectedCount = Object.values(selectedIds).filter(Boolean).length;

  async function handleBulkDelete() {
    const ids = Object.keys(selectedIds).filter((id) => selectedIds[id]);
    if (ids.length === 0) {
      return;
    }

    const confirmed = window.confirm(
      `Delete ${ids.length} asset${ids.length === 1 ? '' : 's'}? This will remove their Convex records and linked cloud assets. This cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }

    setIsBulkWorking(true);
    setLoadError(null);

    try {
      for (const id of ids) {
        const target = videos.find((video) => video._id === id);
        if (!target) {
          continue;
        }
        await window.mediaBridge.deleteStoredVideo({
          videoId: target._id,
          title: target.title,
          sourceFileName: target.sourceFileName,
          archiveObjectKey: target.archiveObjectKey,
          distributionObjectKey: target.distributionObjectKey,
        });
      }

      setLibraryNotice(`Deleted ${ids.length} asset${ids.length === 1 ? '' : 's'}.`);
      setSelectedIds({});
      setSelectMode(false);
      setRefreshKey((current) => current + 1);
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setIsBulkWorking(false);
    }
  }

  async function handleBulkAddToCollection() {
    const ids = Object.keys(selectedIds).filter((id) => selectedIds[id]);
    if (ids.length === 0) {
      return;
    }

    const collectionName = window.prompt('Add selected assets to which collection?')?.trim();
    if (!collectionName) {
      return;
    }

    setIsBulkWorking(true);
    setLoadError(null);

    try {
      for (const id of ids) {
        const target = videos.find((video) => video._id === id);
        if (!target) {
          continue;
        }
        await window.mediaBridge.updateStoredVideoMetadata({
          videoId: target._id,
          playlistTitles: addUniqueValue(target.playlistTitles ?? [], collectionName),
        });
      }

      setLibraryNotice(`Added ${ids.length} asset${ids.length === 1 ? '' : 's'} to "${collectionName}".`);
      setSelectedIds({});
      setSelectMode(false);
      setRefreshKey((current) => current + 1);
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setIsBulkWorking(false);
    }
  }

  async function handleGeneratePosterCandidates() {
    if (!selectedVideo || !previewAvailable || !playableSourceUrl) {
      return;
    }

    setIsGeneratingPosterCandidates(true);
    setLoadError(null);
    setLibraryNotice(null);

    try {
      const candidates = await window.mediaBridge.generateStoredVideoPosterCandidates({
        sourceUrl: playableSourceUrl,
        durationSeconds: selectedVideo.durationSeconds,
        sourceName: selectedVideo.sourceFileName,
      });
      setPosterCandidates(candidates);
      setSelectedPosterCandidatePath(candidates[0]?.localPath ?? null);
      setLibraryNotice(
        candidates.length > 0
          ? `Generated ${candidates.length} poster candidate${candidates.length === 1 ? '' : 's'}.`
          : 'No poster candidates were generated.',
      );
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setIsGeneratingPosterCandidates(false);
    }
  }

  async function handleApplyPoster() {
    if (!selectedVideo || !selectedPosterCandidate) {
      return;
    }

    setIsApplyingPoster(true);
    setLoadError(null);
    setLibraryNotice(null);

    try {
      await window.mediaBridge.applyStoredVideoPoster({
        videoId: selectedVideo._id,
        distributionObjectKey: selectedVideo.distributionObjectKey,
        candidatePath: selectedPosterCandidate.localPath,
      });
      setLibraryNotice(`Poster image updated from candidate ${selectedPosterCandidate.label}.`);
      setRefreshKey((current) => current + 1);
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setIsApplyingPoster(false);
    }
  }

  function getGalleryColumnCount() {
    if (viewMode === 'list') {
      return 1;
    }

    const gridElement = assetGridRef.current?.querySelector('[data-gallery-assets-grid]');
    if (!(gridElement instanceof HTMLElement)) {
      return 1;
    }

    const columnTemplate = window.getComputedStyle(gridElement).gridTemplateColumns;
    const columnCount = columnTemplate.split(' ').filter(Boolean).length;
    return Math.max(1, columnCount);
  }

  function selectVideoByOffset(offset: number) {
    if (filteredVideos.length === 0) {
      return;
    }

    const currentIndex = Math.max(
      0,
      filteredVideos.findIndex((video) => video._id === selectedVideoId),
    );
    const nextIndex = Math.min(Math.max(currentIndex + offset, 0), filteredVideos.length - 1);
    const nextVideo = filteredVideos[nextIndex];
    if (!nextVideo) {
      return;
    }

    setSelectedVideoId(nextVideo._id);
    window.requestAnimationFrame(() => {
      assetGridRef.current
        ?.querySelector(`[data-gallery-asset-id="${nextVideo._id}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function handleAssetGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const columnCount = getGalleryColumnCount();
    const keyOffsets: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -columnCount,
      ArrowDown: columnCount,
    };
    const offset = keyOffsets[event.key];
    if (!offset) {
      return;
    }

    event.preventDefault();
    selectVideoByOffset(offset);
  }

  const emptyLibraryCopy = getEmptyLibraryCopy(hasConvexConfig);
  return (
    <div className="px-6 pb-11 pt-[22px]">
      {/* Page header — the title lives in the body, not the top bar, as on the site. */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-page text-paper">Library</h1>
          <div className="mt-1 text-control text-muted">
            <span className="font-mono">{filteredVideos.length}</span>
            {filteredVideos.length === videos.length ? '' : ` of ${videos.length}`} asset
            {filteredVideos.length === 1 ? '' : 's'}
          </div>
        </div>

        <div className="flex flex-none items-center gap-2">
          <button
            type="button"
            onClick={() => setRefreshKey((current) => current + 1)}
            className="csn-btn-secondary"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void handleRepairStoredUrls()}
            disabled={!hasConvexConfig || isRepairingUrls}
            className="csn-btn-secondary"
          >
            {isRepairingUrls ? 'Repairing…' : 'Repair URLs'}
          </button>
        </div>
      </div>

      {/* Filter chips + series dropdown */}
      <div className="mb-5 flex flex-wrap items-center gap-[9px]">
        {LIBRARY_FILTER_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setLibraryFilter(option)}
            className={libraryFilterParam === option ? 'csn-chip-on' : 'csn-chip-off'}
          >
            {LIBRARY_FILTER_LABELS[option]}
          </button>
        ))}

        <div className="csn-rule mx-1" />

        <SeriesFilter
          videos={videos}
          value={collectionParam}
          onChange={(next) => setCollectionFilter(next)}
        />

        {collectionParam && (
          <button
            type="button"
            onClick={clearCollectionFilter}
            className="flex h-9 items-center gap-1.5 rounded-[9px] border border-rule-strong bg-transparent px-[11px] text-[12.5px] text-muted transition hover:border-white/[.22] hover:text-paper"
          >
            Clear
            <CloseIcon size={13} />
          </button>
        )}
      </div>

      {/* Secondary filters, specific to this pipeline (no equivalent on the site). */}
      <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2">
        <FilterChipGroup
          label="Status"
          options={STATUS_CHIP_OPTIONS}
          value={statusFilter}
          onChange={(value) => setStatusFilter(value)}
          renderLabel={(option) => (option === 'all' ? 'All' : formatStatusLabel(option))}
        />
        <FilterChipGroup
          label="Type"
          options={CONTENT_TYPE_CHIP_OPTIONS}
          value={contentTypeFilter}
          onChange={(value) => setContentTypeFilter(value)}
          renderLabel={(option) => (option === 'all' ? 'All' : formatContentTypeLabel(option))}
        />
        <FilterChipGroup
          label="Delivery"
          options={DELIVERY_CHIP_OPTIONS}
          value={deliveryFilter}
          onChange={(value) => setDeliveryFilter(value)}
          renderLabel={(option) => (option === 'all' ? 'All' : formatDeliveryLabel(option))}
        />
      </div>

      {/* Bulk action bar, shown once something is checked in select mode. */}
      {selectMode && selectedCount > 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-panel border border-accent/40 bg-accent/[.08] px-4 py-2.5">
          <span className="text-copy font-semibold text-paper">
            <span className="font-mono">{selectedCount}</span> selected
          </span>
          <button
            type="button"
            onClick={() => void handleBulkAddToCollection()}
            disabled={isBulkWorking}
            className="csn-btn-secondary h-9"
          >
            Add to collection
          </button>
          <button
            type="button"
            onClick={() => void handleBulkDelete()}
            disabled={isBulkWorking}
            className="csn-btn-danger h-9"
          >
            Delete
          </button>
        </div>
      )}

      {(libraryNotice || loadError || isLoading) && (
        <div className="mb-4 space-y-2">
          {isLoading && (
            <p className="rounded-control border border-accent/40 bg-accent/[.13] px-4 py-2 text-copy text-accent-hi">
              Refreshing the stored video library…
            </p>
          )}
          {libraryNotice && (
            <p className="rounded-control border border-state-ok/30 bg-state-ok/[.13] px-4 py-2 text-copy text-state-ok">
              {libraryNotice}
            </p>
          )}
          {loadError && (
            <p className="rounded-control border border-state-danger/30 bg-state-danger/[.12] px-4 py-2 text-copy text-state-danger">
              {loadError}
            </p>
          )}
        </div>
      )}

      <div className="flex min-h-0 gap-5">
        <div className="min-w-0 flex-1">
          <div
            ref={assetGridRef}
            onKeyDown={handleAssetGridKeyDown}
            tabIndex={0}
            className="outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
          >
              {filteredVideos.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-5 py-20 text-center">
                  <div className="max-w-md">
                    <h2 className="font-display text-section text-paper">
                      {videos.length === 0 ? emptyLibraryCopy.title : 'No assets match your filters.'}
                    </h2>
                    <p className="mt-2.5 text-copy leading-relaxed text-muted">
                      {videos.length === 0
                        ? emptyLibraryCopy.body
                        : 'Clear the search or relax the chip filters to bring more assets back.'}
                    </p>
                  </div>
                  {!hasConvexConfig && (
                    <Link
                      to="/settings"
                      className="csn-btn-primary mt-5"
                    >
                      Open Settings
                    </Link>
                  )}
                </div>
              ) : viewMode === 'list' ? (
                <div data-gallery-assets-grid className="flex flex-col gap-2">
                  {filteredVideos.map((video) => {
                    const isSelected = video._id === selectedVideo?._id;
                    const isChecked = Boolean(selectedIds[video._id]);
                    const posterUrl = appendCacheBust(video.posterUrl, video.updatedAt);
                    const kind = inferStoredContentType(video) === 'vod' ? 'VOD' : 'Short';

                    return (
                      <div
                        key={video._id}
                        data-gallery-asset-id={video._id}
                        onClick={() => (selectMode ? toggleSelected(video._id) : setSelectedVideoId(video._id))}
                        className={`flex cursor-pointer items-center gap-3.5 rounded-[12px] border px-3.5 py-2.5 transition ${
                          isSelected && !selectMode
                            ? 'border-accent/50 bg-accent/[.08]'
                            : isChecked
                              ? 'border-accent-hi bg-accent/[.13]'
                              : 'border-white/[.06] bg-ink-raised hover:border-white/[.16]'
                        }`}
                      >
                        {selectMode && (
                          <div
                            className={`flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[6px] border-2 ${
                              isChecked ? 'border-accent-hi bg-accent' : 'bg-transparent border-white/30'
                            }`}
                          >
                            {isChecked && (
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={3}>
                                <path d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </div>
                        )}

                        <Thumb
                          seed={video._id}
                          posterUrl={posterUrl}
                          compact
                          duration={formatDuration(video.durationSeconds)}
                          className="aspect-video w-[120px] flex-none rounded-[8px]"
                        />

                        <div className="min-w-0 flex-1">
                          <p className="truncate font-condensed text-[17px] font-bold leading-tight text-paper">
                            {video.title}
                          </p>
                          <p className="mt-[3px] font-mono text-count text-dim">
                            {formatResolutionShort(video)} · {formatFileSize(video.sourceFileSizeBytes)} · {formatShortDate(video.updatedAt)}
                          </p>
                        </div>

                        <span
                          className={`hidden flex-none sm:inline-block ${kind === 'Short' ? 'csn-kind-short' : 'csn-kind'}`}
                        >
                          {kind}
                        </span>

                        <div className="hidden flex-none lg:block">
                          <StatusBadge tone={getStatusTone(video.status)}>
                            {formatStatusLabel(video.status)}
                          </StatusBadge>
                        </div>

                        <button
                          type="button"
                          title="Add to collection"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedIds({ [video._id]: true });
                            void handleBulkAddToCollection();
                          }}
                          className="csn-quiet-btn h-8 w-8 rounded-chip"
                        >
                          <AddToCollectionIcon size={15} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div
                  data-gallery-assets-grid
                  className="grid gap-4"
                  style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))' }}
                >
                  {filteredVideos.map((video) => {
                    const isSelected = video._id === selectedVideo?._id;
                    const isChecked = Boolean(selectedIds[video._id]);
                    const posterUrl = appendCacheBust(video.posterUrl, video.updatedAt);
                    const kind = inferStoredContentType(video) === 'vod' ? 'VOD' : 'Short';

                    return (
                      <div
                        key={video._id}
                        data-gallery-asset-id={video._id}
                        onClick={() => (selectMode ? toggleSelected(video._id) : setSelectedVideoId(video._id))}
                        className={`group cursor-pointer overflow-hidden rounded-[13px] border transition ${
                          isSelected && !selectMode
                            ? 'border-accent-hi/50 shadow-[0_0_0_2px_rgba(238,21,24,0.35)]'
                            : isChecked
                              ? 'border-accent-hi shadow-[0_0_0_2px_rgba(238,21,24,0.45)]'
                              : 'border-white/[.07] hover:border-white/20'
                        } bg-ink-panel`}
                      >
                        <Thumb
                          seed={video._id}
                          posterUrl={posterUrl}
                          className="aspect-video"
                          duration={formatDuration(video.durationSeconds)}
                        >

                          {selectMode ? (
                            <div
                              className={`absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-[7px] border-2 shadow ${
                                isChecked ? 'border-accent-hi bg-accent' : 'border-white/70 bg-black/40'
                              }`}
                            >
                              {isChecked && (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={3}>
                                  <path d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>
                          ) : (
                            <span className={`absolute left-[9px] top-[9px] ${kind === 'Short' ? 'csn-kind-short' : 'csn-kind'}`}>
                              {kind}
                            </span>
                          )}

                          <div className="absolute right-[9px] top-[9px]">
                            <StatusBadge tone={getStatusTone(video.status)}>
                              {formatStatusLabel(video.status)}
                            </StatusBadge>
                          </div>

                          <div className="csn-play pointer-events-none">
                            <svg width="14" height="14" viewBox="0 0 24 24">
                              <path d="M8 5l12 7-12 7z" fill="#fff" />
                            </svg>
                          </div>

                        </Thumb>

                        <div className="px-3 pb-3 pt-2.5">
                          <p className="truncate font-condensed text-lg font-bold leading-[1.06] text-paper">
                            {video.title}
                          </p>
                          <div className="mt-1.5 flex items-center justify-between gap-2">
                            <p className="min-w-0 flex-1 truncate font-mono text-meta text-dim">
                              {formatResolutionShort(video)} · {formatFileSize(video.sourceFileSizeBytes)} · {formatShortDate(video.updatedAt)}
                            </p>
                            <div className="flex flex-none items-center gap-1.5">
                              <button
                                type="button"
                                title="Add to collection"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedIds({ [video._id]: true });
                                  void handleBulkAddToCollection();
                                }}
                                className="csn-quiet-btn h-[26px] w-[26px]"
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}>
                                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                                  <path d="M12 11v5M9.5 13.5h5" />
                                </svg>
                            </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <aside className="hidden w-[384px] flex-none xl:block">
            <div className="csn-card sticky top-0 flex max-h-[calc(100vh-140px)] flex-col overflow-hidden text-paper">
              {selectedVideo ? (
                <>
                  <div className="border-b border-white/10 px-5 pt-3">
                    <p className="mb-2 font-condensed text-overline uppercase text-dim">
                      Inspector
                    </p>
                    <div className="flex gap-5">
                      {([
                        ['details', 'Details'],
                        ['metadata', 'Metadata'],
                        ['poster', 'Posters'],
                      ] as const).map(([tabId, label]) => (
                        <button
                          key={tabId}
                          onClick={() => setInspectorTab(tabId)}
                          type="button"
                          className={inspectorTab === tabId ? 'csn-tab-on py-2.5' : 'csn-tab py-2.5'}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto px-5 py-5">
                    {inspectorTab === 'details' && (
                      <div className="space-y-5">
                        <div className="overflow-hidden rounded-card border border-white/10 bg-ink-tile">
                          {previewAvailable ? (
                            <StoredVideoPlayer controlsVisibility="hover" video={selectedVideo} />
                          ) : (
                            <div className="flex min-h-[13rem] flex-col items-center justify-center gap-3 p-5 text-center">
                              <StatusBadge tone="warning">
                                {formatStatusLabel(selectedVideo.status)}
                              </StatusBadge>
                              <div className="max-w-sm">
                                <h3 className="text-base font-semibold text-paper">
                                  {getPreviewUnavailableCopy(selectedVideo.status).title}
                                </h3>
                                <p className="mt-2 text-xs leading-5 text-muted">
                                  {getPreviewUnavailableCopy(selectedVideo.status).body}
                                </p>
                              </div>
                            </div>
                          )}
                        </div>

                        <div>
                          <h3 className="font-display text-section text-paper">{selectedVideo.title}</h3>
                          <p className="mt-1 truncate font-mono text-count text-dim">
                            {selectedVideo.sourceFileName}
                          </p>
                        </div>

                        {inferStoredContentType(selectedVideo) !== 'clip' && (
                          <div>
                            <div className="mb-2 flex items-center justify-between">
                              <p className="font-condensed text-overline uppercase text-dim">
                                Derived short-form clips
                              </p>
                              <span className="text-[10px] text-dim">{derivedClips.length}</span>
                            </div>
                            {derivedClips.length > 0 ? (
                              <div className="flex gap-2 overflow-x-auto pb-1">
                                {derivedClips.map((clip) => (
                                  <button
                                    key={clip._id}
                                    type="button"
                                    onClick={() => setSelectedVideoId(clip._id)}
                                    className="w-24 flex-none rounded-control border border-white/10 bg-white/5 p-2 text-left transition hover:border-state-ok/50"
                                  >
                                    <p className="truncate text-[11px] font-medium text-paper">{clip.title}</p>
                                    <p className="mt-0.5 text-[10px] text-muted">
                                      {clip.clipAspectRatio ?? formatResolution(clip)}
                                    </p>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-dim">No clips created from this asset yet.</p>
                            )}
                          </div>
                        )}

                        <div className="flex flex-wrap gap-1.5">
                          {[
                            formatDuration(selectedVideo.durationSeconds),
                            formatResolution(selectedVideo),
                            formatFrameRate(selectedVideo.sourceFrameRate),
                            formatFileSize(selectedVideo.sourceFileSizeBytes),
                            selectedVideo.encoder,
                          ].map((fact) => (
                            <span
                              key={fact}
                              className="rounded-chip bg-white/[.06] px-2.5 py-1 font-mono text-meta text-body"
                            >
                              {fact}
                            </span>
                          ))}
                        </div>

                        <div className="rounded-card border border-white/10 bg-white/5 p-4">
                          <p className="font-condensed text-overline uppercase text-dim">
                            Description
                          </p>
                          <p className="mt-2 text-copy leading-relaxed text-body">
                            {selectedVideo.description?.trim() ||
                              'No description has been added yet. Update from the Metadata tab.'}
                          </p>
                        </div>

                        <div className="csn-well px-4">
                          {[
                            { k: 'Added', v: formatDate(selectedVideo.createdAt) },
                            { k: 'Updated', v: formatDate(selectedVideo.updatedAt) },
                            {
                              k: 'Recorded',
                              v: selectedVideo.recordedAt ? formatDate(selectedVideo.recordedAt) : 'Not set',
                            },
                            { k: 'Delivery', v: inferStoredDeliveryType(selectedVideo) },
                            {
                              k: 'Pipeline',
                              v: formatPipelineLayerLabel(
                                matchesPipelineLayer(selectedVideo, 'social-scheduled')
                                  ? 'social-scheduled'
                                  : matchesPipelineLayer(selectedVideo, 'social-staging')
                                    ? 'social-staging'
                                    : 'web-streaming',
                              ),
                            },
                            { k: 'Content Type', v: inferStoredContentType(selectedVideo) },
                            { k: 'Video Codec', v: formatCodec(selectedVideo.sourceVideoCodec) },
                            { k: 'Audio Codec', v: formatCodec(selectedVideo.sourceAudioCodec) },
                            {
                              k: 'Review',
                              v: formatReviewStatusLabel(getEffectiveReviewStatus(selectedVideo)),
                            },
                            {
                              k: 'Social',
                              v: formatSocialStatusLabel(getEffectiveSocialStatus(selectedVideo)),
                            },
                            { k: 'Project', v: selectedVideo.projectName ?? 'Not set' },
                            { k: 'Event', v: selectedVideo.eventName ?? 'Not set' },
                            {
                              k: 'Camera / Source',
                              v:
                                [selectedVideo.cameraId, selectedVideo.sourceNode].filter(Boolean).join(' / ') ||
                                'Not set',
                            },
                            { k: 'Source File', v: selectedVideo.sourceFileName },
                          ].map((row, index, rows) => (
                            <div
                              key={row.k}
                              className={`flex items-center justify-between gap-4 py-2.5 text-[13px] ${
                                index < rows.length - 1 ? 'border-b border-white/[.05]' : ''
                              }`}
                            >
                              <span className="text-dim">{row.k}</span>
                              <span className="truncate font-mono text-[12px] text-body" title={row.v}>
                                {row.v}
                              </span>
                            </div>
                          ))}
                        </div>

                        {selectedVideo.errorMessage && (
                          <div className="rounded-card border border-state-danger/30 bg-state-danger/[.12] p-3 text-xs text-state-danger">
                            {selectedVideo.errorMessage}
                          </div>
                        )}

                        <div className="rounded-[13px] border border-white/[.07] bg-ink-raised p-4">
                          <p className="mb-2 font-condensed text-overline uppercase text-dim">Master Archive</p>
                          {selectedVideo.archiveObjectKey ? (
                            <>
                              <p
                                className="truncate font-mono text-[12px] text-body"
                                title={selectedVideo.archiveObjectKey}
                              >
                                {selectedVideo.archiveObjectKey}
                              </p>
                              <p className="mt-2 text-xs leading-5 text-muted">
                                The full-quality original in Backblaze B2. It is never served to
                                viewers — preview it here, or pull it back to disk to re-cut.
                              </p>

                              <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                  onClick={() => void handlePreviewArchive()}
                                  disabled={isLoadingArchivePreview || isRetrievingArchive}
                                  className="rounded-control border border-white/12 bg-white/[.06] px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-white/[.1] disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {isLoadingArchivePreview ? 'Signing…' : 'Preview master'}
                                </button>
                                <button
                                  onClick={() => void handleRetrieveArchive()}
                                  disabled={isRetrievingArchive || isLoadingArchivePreview}
                                  className="rounded-control border border-white/12 bg-white/[.06] px-3 py-1.5 text-xs font-semibold text-body transition hover:bg-white/[.1] disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {isRetrievingArchive ? 'Retrieving…' : 'Retrieve for processing'}
                                </button>
                              </div>

                              {isRetrievingArchive && (
                                <p className="mt-2 text-xs leading-5 text-muted">
                                  Downloading the master to the working folder. Large camera files
                                  take a while — progress is in the pipeline console.
                                </p>
                              )}

                              {archivePreview?.url && (
                                <div className="mt-3">
                                  <video
                                    key={archivePreview.url}
                                    src={archivePreview.url}
                                    controls
                                    className="w-full rounded-card border border-white/10 bg-black"
                                  />
                                  <p className="mt-2 text-xs text-dim">
                                    This preview link is scoped to this one file and expires in{' '}
                                    {Math.round(archivePreview.expiresInSeconds / 60)} minutes.
                                  </p>
                                </div>
                              )}

                              {archiveError && (
                                <div className="mt-3 rounded-card border border-state-danger/30 bg-state-danger/[.12] p-3 text-xs text-state-danger">
                                  {archiveError}
                                </div>
                              )}
                            </>
                          ) : (
                            <p className="text-xs leading-5 text-muted">
                              This asset has no archived master in Backblaze B2. Only assets
                              ingested through the pipeline carry one.
                            </p>
                          )}
                        </div>

                        {(selectedVideo.tags.length > 0 ||
                          (selectedVideo.playlistTitles?.length ?? 0) > 0 ||
                          selectedVideo.series) && (
                          <div className="rounded-[13px] border border-white/[.07] bg-ink-raised p-4">
                            <p className="mb-3 font-condensed text-overline uppercase text-dim">
                              Tags
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                              {selectedVideo.series && (
                                <span className="rounded-[7px] bg-white/[.06] px-2.5 py-1 text-xs text-body">
                                  Series: {selectedVideo.series}
                                </span>
                              )}
                              {(selectedVideo.playlistTitles ?? []).map((playlistTitle) => (
                                <span
                                  key={playlistTitle}
                                  className="rounded-[7px] bg-white/[.06] px-2.5 py-1 text-xs text-body"
                                >
                                  {playlistTitle}
                                </span>
                              ))}
                              {selectedVideo.tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="rounded-[7px] bg-white/[.06] px-2.5 py-1 text-xs text-body"
                                >
                                  #{tag}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {inspectorTab === 'metadata' && editorDraft && (
                      <div className="space-y-5">
                        <div className="rounded-card border border-white/10 bg-white/5 p-4">
                          <div className="flex flex-col gap-3">
                            <div>
                              <h3 className="text-base font-semibold text-paper">Metadata Editor</h3>
                              <p className="mt-1 text-xs text-muted">
                                Publish state, descriptive copy, and library organization all live here.
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button
                                onClick={() => void handleSaveMetadata('draft')}
                                className="rounded-control border border-state-warn/30 bg-state-warn/[.12] px-3 py-1.5 text-xs font-semibold text-state-warn transition hover:bg-state-warn/15 disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={isSavingMetadata || isDeletingVideo}
                                type="button"
                              >
                                Unpublish
                              </button>
                              <button
                                onClick={() => void handleSaveMetadata('ready')}
                                className="rounded-control bg-accent px-3 py-1.5 text-xs font-semibold text-paper transition hover:bg-accent-hi disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={isSavingMetadata || isDeletingVideo}
                                type="button"
                              >
                                Publish
                              </button>
                            </div>
                          </div>
                        </div>

                        <div className="space-y-4">
                          <div>
                            <label className="mb-2 block font-condensed text-overline uppercase text-dim">
                              Title
                            </label>
                            <input
                              value={editorDraft.title}
                              onChange={(event) =>
                                setEditorDraft((current) =>
                                  current ? { ...current, title: event.target.value } : current)
                              }
                              className={PANEL_INPUT_CLASS}
                            />
                          </div>

                          <div className="grid gap-4 sm:grid-cols-2">
                            <div>
                              <label className="mb-2 block font-condensed text-overline uppercase text-dim">
                                Status
                              </label>
                              <select
                                value={editorDraft.status}
                                onChange={(event) =>
                                  setEditorDraft((current) =>
                                    current
                                      ? { ...current, status: event.target.value as StoredVideoStatus }
                                      : current)
                                }
                                className={PANEL_INPUT_CLASS}
                              >
                                {EDITABLE_STATUS_OPTIONS.map((status) => (
                                  <option key={status} value={status}>
                                    {formatStatusLabel(status)}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div>
                              <label className="mb-2 block font-condensed text-overline uppercase text-dim">
                                Recorded At
                              </label>
                              <input
                                type="datetime-local"
                                value={editorDraft.recordedAtInput}
                                onChange={(event) =>
                                  setEditorDraft((current) =>
                                    current ? { ...current, recordedAtInput: event.target.value } : current)
                                }
                                className={PANEL_INPUT_CLASS}
                              />
                            </div>
                          </div>

                          <div className="rounded-card border border-white/10 bg-white/5 p-4">
                            <p className="font-condensed text-overline uppercase text-dim">
                              Lawn Workflow
                            </p>
                            <div className="mt-4 grid gap-4 sm:grid-cols-2">
                              <div>
                                <label className="mb-2 block font-condensed text-overline uppercase text-dim">
                                  Review Status
                                </label>
                                <select
                                  value={editorDraft.reviewStatus}
                                  onChange={(event) =>
                                    setEditorDraft((current) =>
                                      current
                                        ? { ...current, reviewStatus: event.target.value as ReviewStatus }
                                        : current)
                                  }
                                  className={PANEL_INPUT_CLASS}
                                >
                                  {REVIEW_STATUS_OPTIONS.map((status) => (
                                    <option key={status} value={status}>
                                      {formatReviewStatusLabel(status)}
                                    </option>
                                  ))}
                                </select>
                              </div>

                            </div>
                          </div>

                          <div className="rounded-card border border-white/10 bg-white/5 p-4">
                            <p className="font-condensed text-overline uppercase text-dim">
                              Ingest Metadata
                            </p>
                            <div className="mt-4 grid gap-4 sm:grid-cols-2">
                              {([
                                ['Project / Client', 'projectName', 'SS26 Launch'],
                                ['Event / Shoot', 'eventName', 'Championship postgame'],
                                ['Camera ID', 'cameraId', 'Cam A'],
                                ['Source Node', 'sourceNode', 'local vMix'],
                              ] as const).map(([label, key, placeholder]) => (
                                <div key={key}>
                                  <label className="mb-2 block font-condensed text-overline uppercase text-dim">
                                    {label}
                                  </label>
                                  <input
                                    value={editorDraft[key]}
                                    onChange={(event) =>
                                      setEditorDraft((current) =>
                                        current ? { ...current, [key]: event.target.value } : current)
                                    }
                                    placeholder={placeholder}
                                    className={PANEL_INPUT_CLASS}
                                  />
                                </div>
                              ))}
                            </div>
                          </div>

                          <SingleValuePicker
                            label="Series"
                            value={editorDraft.series}
                            options={seriesOptions}
                            placeholder="Friday Night Lights"
                            onChange={(series) =>
                              setEditorDraft((current) => (current ? { ...current, series } : current))
                            }
                          />

                          <MultiValuePicker
                            label="Playlists"
                            values={splitCommaSeparatedValues(editorDraft.playlistInput)}
                            options={playlistOptions}
                            placeholder="Top Plays"
                            onChange={(playlistTitles) =>
                              setEditorDraft((current) =>
                                current ? { ...current, playlistInput: playlistTitles.join(', ') } : current)
                            }
                          />

                          <MultiValuePicker
                            label="Tags"
                            values={splitCommaSeparatedValues(editorDraft.tagsInput)}
                            options={tagOptions}
                            placeholder="basketball"
                            onChange={(tags) =>
                              setEditorDraft((current) =>
                                current ? { ...current, tagsInput: tags.join(', ') } : current)
                            }
                          />

                          <div>
                            <label className="mb-2 block font-condensed text-overline uppercase text-dim">
                              Description
                            </label>
                            <textarea
                              value={editorDraft.description}
                              onChange={(event) =>
                                setEditorDraft((current) =>
                                  current ? { ...current, description: event.target.value } : current)
                              }
                              rows={6}
                              className={PANEL_INPUT_CLASS}
                            />
                          </div>
                        </div>

                        <div className="rounded-card border border-white/10 bg-white/5 p-4">
                          <button
                            onClick={() => void handleSaveMetadata()}
                            className="w-full rounded-control bg-state-ok px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-state-ok disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={isSavingMetadata || isDeletingVideo}
                            type="button"
                          >
                            {isSavingMetadata ? 'Saving...' : 'Save Metadata'}
                          </button>
                          <p className="mt-2 text-xs text-muted">
                            Publish moves the record to <span className="font-semibold text-paper">ready</span>.
                            Unpublish returns it to <span className="font-semibold text-paper">draft</span>.
                          </p>
                        </div>

                        <div className="rounded-card border border-state-danger/30 bg-state-danger/[.12] p-4">
                          <div className="flex flex-col gap-3">
                            <div>
                              <h3 className="text-sm font-semibold text-state-danger">Danger Zone</h3>
                              <p className="mt-1 text-xs leading-5 text-state-danger/80">
                                Delete removes this asset from the Convex library and removes linked cloud assets where
                                available.
                              </p>
                            </div>
                            <button
                              onClick={() => void handleDeleteVideo()}
                              className="rounded-control border border-state-danger/30 bg-state-danger/10 px-4 py-2 text-xs font-semibold text-state-danger transition hover:bg-state-danger/15 disabled:cursor-not-allowed disabled:opacity-60 sm:self-start"
                              disabled={isSavingMetadata || isDeletingVideo}
                              type="button"
                            >
                              {isDeletingVideo ? 'Deleting...' : 'Delete Video'}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {inspectorTab === 'poster' && (
                      <div className="space-y-5">
                        <div className="rounded-card border border-white/10 bg-white/5 p-4">
                          <div className="flex flex-col gap-3">
                            <div>
                              <h3 className="text-base font-semibold text-paper">Poster Image</h3>
                              <p className="mt-1 text-xs text-muted">
                                Generate new frame options from the stored playback asset, then push the selected
                                poster back to cloud storage and Convex.
                              </p>
                            </div>
                            <button
                              onClick={() => void handleGeneratePosterCandidates()}
                              className="rounded-control border border-accent/40 bg-accent/[.13] px-4 py-2 text-xs font-semibold text-accent-hi transition hover:bg-accent-hi/15 disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={!previewAvailable || !playableSourceUrl || isGeneratingPosterCandidates}
                              type="button"
                            >
                              {isGeneratingPosterCandidates ? 'Generating...' : 'Generate Poster Options'}
                            </button>
                          </div>
                        </div>

                        <div className="rounded-card border border-white/10 bg-white/5 p-4">
                          <p className="font-condensed text-overline uppercase text-dim">
                            Current Poster
                          </p>
                          {selectedVideo.posterUrl ? (
                            <img
                              src={appendCacheBust(selectedVideo.posterUrl, selectedVideo.updatedAt)}
                              alt={`${selectedVideo.title} poster`}
                              className="mt-3 aspect-video w-full rounded-control object-cover"
                            />
                          ) : (
                            <div className="mt-3 flex aspect-video items-center justify-center rounded-control border border-dashed border-white/10 font-condensed text-overline uppercase text-dim">
                              No Poster
                            </div>
                          )}
                        </div>

                        {posterCandidates.length === 0 ? (
                          <div className="rounded-card border border-dashed border-white/10 p-5 text-xs text-muted">
                            Generate poster options to review frame candidates here.
                          </div>
                        ) : (
                          <>
                            <div className="grid gap-3 sm:grid-cols-2">
                              {posterCandidates.map((candidate) => {
                                const isCandidateSelected = candidate.localPath === selectedPosterCandidatePath;

                                return (
                                  <button
                                    key={candidate.id}
                                    onClick={() => setSelectedPosterCandidatePath(candidate.localPath)}
                                    type="button"
                                    className={`overflow-hidden rounded-card border text-left transition ${
                                      isCandidateSelected
                                        ? 'border-accent/40 bg-accent/[.13] shadow-[0_14px_32px_rgba(238,21,24,.35)]'
                                        : 'border-white/10 bg-white/5 hover:border-white/20'
                                    }`}
                                  >
                                    <img
                                      src={candidate.imageUrl}
                                      alt={`Poster candidate at ${candidate.label}`}
                                      className="aspect-video w-full object-cover"
                                    />
                                    <div className="p-2.5">
                                      <p className="font-condensed text-overline uppercase text-dim">
                                        Candidate
                                      </p>
                                      <p className="mt-0.5 text-xs font-semibold text-paper">{candidate.label}</p>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>

                            <div className="rounded-card border border-white/10 bg-white/5 p-4">
                              <button
                                onClick={() => void handleApplyPoster()}
                                className="w-full rounded-control bg-accent px-4 py-2.5 text-sm font-semibold text-paper transition hover:bg-accent-hi disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={!selectedPosterCandidate || isApplyingPoster}
                                type="button"
                              >
                                {isApplyingPoster ? 'Applying Poster...' : 'Apply Selected Poster'}
                              </button>
                              <p className="mt-2 text-xs text-muted">
                                {selectedPosterCandidate
                                  ? `Selected frame ${selectedPosterCandidate.label}.`
                                  : 'Choose a candidate frame before applying the new poster.'}
                              </p>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center p-6 text-center">
                  <div className="max-w-sm">
                    <h3 className="font-display text-section text-paper">No asset selected</h3>
                    <p className="mt-2 text-xs leading-5 text-muted">
                      Choose a card from the gallery to open playback, metadata, and poster controls in this panel.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </aside>
      </div>
    </div>
  );
}

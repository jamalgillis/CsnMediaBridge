import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import ErrorBoundary from '../components/ErrorBoundary';
import StoredVideoPlayer from '../components/StoredVideoPlayer';
import { useBridge } from '../context/BridgeContext';
import { getPrimaryPlaybackUrl, inferStoredContentType, inferStoredDeliveryType } from '../shared/media';
import { swatchFor } from '../shared/csn';
import Thumb from '../components/csn/Thumb';
import {
  Disclosure,
  ErrorNote,
  Fact,
  FactList,
  PageHeading,
  PlatformGlyph,
  PlatformTag,
  QuietNote,
  Screen,
  StatusChip,
  Toast,
  ToneChip,
  statusLabel,
  useToast,
  type ChipTone,
} from '../components/csn/bridge';
import {
  EmptyState,
  Eyebrow,
  FilterChip,
  GhostButton,
  SectionHead,
  Segmented,
} from '../components/csn/ui';
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CollectionIcon,
  SearchIcon,
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
const FILTER_PARAM_TO_RAIL_ID: Record<LibraryFilterOption, string> = {
  all: 'all',
  vod: 'content-type:vod',
  short: 'content-type:clip',
  published: 'social:published',
  processing: 'status:processing',
};

const PREVIEWABLE_STATUSES = new Set<StoredVideoStatus>(['ready', 'draft', 'archived']);

/**
 * The four states an operator sorts by, as opposed to the six the pipeline
 * records: is it done, is it moving, or does it want me?
 */
type PlainFilter = 'all' | 'ready' | 'working' | 'attention';

const PLAIN_FILTERS: { key: PlainFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ready', label: 'Ready' },
  { key: 'working', label: 'Working' },
  { key: 'attention', label: 'Needs you' },
];

/** Player / Gallery / List — the three ways to look at the same library. */
type BrowseMode = 'player' | 'gallery' | 'list';

const BROWSE_MODES: readonly { key: BrowseMode; label: string }[] = [
  { key: 'player', label: 'Player' },
  { key: 'gallery', label: 'Gallery' },
  { key: 'list', label: 'List' },
];

/**
 * Publish state, read-only.
 *
 * Scheduling and publishing happen in the CSN web app; the node only mirrors
 * what came back. The library record carries a single deployment state rather
 * than a per-platform table, so this reports the one destination it can vouch
 * for — csn.com — and says plainly when there is nothing to report. See
 * design.md §4, "Shared publish state appears here read-only".
 */
interface PublishRow {
  platform: string;
  name: string;
  state: string;
  tone: ChipTone;
  when: string;
  url: string;
  live: boolean;
}

interface PublishSummary {
  rows: PublishRow[];
  tags: { platform: string; live: boolean }[];
  note: string;
}

function publishSummary(video: StoredVideoSnapshot): PublishSummary {
  const status = getEffectiveSocialStatus(video);
  const url = video.playbackUrl || video.masterPlaylistUrl || '';

  if (status === 'published') {
    return {
      rows: [
        {
          platform: 'Website',
          name: 'csn.com',
          state: 'Posted',
          tone: 'neutral',
          when: formatDate(video.updatedAt),
          url,
          live: true,
        },
      ],
      tags: [{ platform: 'Website', live: true }],
      note: 'Published in 1 place',
    };
  }

  if (status === 'scheduled') {
    return {
      rows: [
        {
          platform: 'Website',
          name: 'csn.com',
          state: 'Scheduled',
          tone: 'bright',
          when: formatDate(video.scheduledPublishAt),
          url: '',
          live: false,
        },
      ],
      tags: [{ platform: 'Website', live: false }],
      note: '1 scheduled',
    };
  }

  if (status === 'staged') {
    return {
      rows: [
        {
          platform: 'Website',
          name: 'csn.com',
          state: 'Draft',
          tone: 'quiet',
          when: 'not scheduled',
          url: '',
          live: false,
        },
      ],
      tags: [{ platform: 'Website', live: false }],
      note: 'Drafted, not published',
    };
  }

  if (status === 'failed') {
    return {
      rows: [
        {
          platform: 'Website',
          name: 'csn.com',
          state: 'Needs you',
          tone: 'live',
          when: formatDate(video.updatedAt),
          url: '',
          live: false,
        },
      ],
      tags: [{ platform: 'Website', live: false }],
      note: 'Publishing stopped',
    };
  }

  return { rows: [], tags: [], note: 'Not published' };
}

/** The addresses this video can be reached at, once it has any. */
function videoLinks(video: StoredVideoSnapshot) {
  return [
    { label: 'Watch link', url: getPrimaryPlaybackUrl(video) },
    { label: 'Streaming manifest', url: video.dashManifestUrl ?? '' },
    { label: 'Thumbnail', url: video.posterUrl ?? '' },
  ].filter((link) => Boolean(link.url));
}

function matchesPlainFilter(video: StoredVideoSnapshot, filter: PlainFilter) {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'ready') {
    return video.status === 'ready';
  }
  if (filter === 'working') {
    return video.status === 'processing' || video.status === 'uploading';
  }
  return video.status === 'error';
}
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
      body: 'Once videos are registered in the media library, they will appear here for browsing, sorting, and management.',
    };
  }

  return {
    title: 'Media library connection needed',
    body: 'Add the media library connection in Settings so stored content can load here.',
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
  // The four chips an operator actually sorts by. The finer status/type/
  // delivery filters below are the pipeline's own vocabulary and stay behind
  // the disclosure.
  const [plainFilter, setPlainFilter] = useState<PlainFilter>('all');
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
  const [storageOpen, setStorageOpen] = useState(false);
  const assetGridRef = useRef<HTMLDivElement | null>(null);
  const { toast, flash } = useToast();

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

      if (!matchesPlainFilter(video, plainFilter)) {
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
    plainFilter,
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
      'the media library record',
      selectedVideo.distributionObjectKey ? 'the playback package' : null,
      selectedVideo.archiveObjectKey ? 'the archive file' : null,
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
      `Delete ${ids.length} asset${ids.length === 1 ? '' : 's'}? This will remove their media library records and linked cloud assets. This cannot be undone.`,
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

  // Player / Gallery / List. The design's default is the gallery — the first
  // thing an operator wants is to see the videos, and the default action on any
  // one of them is to play it.
  const browse: BrowseMode = (() => {
    const layout = searchParams.get('layout');
    return layout === 'list' || layout === 'player' ? layout : 'gallery';
  })();

  function setBrowse(next: BrowseMode) {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next === 'gallery') {
          params.delete('layout');
        } else {
          params.set('layout', next);
        }
        return params;
      },
      { replace: true },
    );
  }

  function setSearchQuery(next: string) {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next) {
          params.set('q', next);
        } else {
          params.delete('q');
        }
        return params;
      },
      { replace: true },
    );
  }

  function openVideo(videoId: string) {
    setSelectedVideoId(videoId);
    setBrowse('player');
  }

  const plainCounts: Record<PlainFilter, number> = {
    all: videos.length,
    ready: videos.filter((video) => video.status === 'ready').length,
    working: videos.filter((video) => video.status === 'processing' || video.status === 'uploading')
      .length,
    attention: videos.filter((video) => video.status === 'error').length,
  };

  const selectedIndex = filteredVideos.findIndex((video) => video._id === selectedVideo?._id);
  const positionNote =
    selectedIndex >= 0 ? `${selectedIndex + 1} of ${filteredVideos.length}` : '';

  return (
    <Screen label="Videos">
      {/* The screen owns its own chrome: search, the four chips, and the view
          switch. There is no top bar following you around the app. */}
      <div className="flex flex-wrap items-center gap-3 border-b border-rule px-[26px] pb-[18px] pt-[22px]">
        <label className="csn-field h-9 max-w-[320px] min-w-[170px] flex-[1_1_200px] px-[11px]">
          <SearchIcon size={14} className="flex-none text-muted" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search videos…"
            className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-paper outline-none"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              title="Clear search"
              className="flex-none text-muted transition-colors hover:text-paper"
            >
              <CloseIcon size={13} />
            </button>
          ) : null}
        </label>

        <div className="flex flex-wrap items-center gap-[7px]">
          {PLAIN_FILTERS.map((filter) => (
            <FilterChip
              key={filter.key}
              label={filter.label}
              count={String(plainCounts[filter.key])}
              active={plainFilter === filter.key}
              onClick={() => setPlainFilter(filter.key)}
            />
          ))}
        </div>

        <span className="min-w-[8px] flex-1" />

        {/* Bulk selection has no slot in the design, but it is the only way to
            tidy several assets at once, so it keeps a quiet capsule here. */}
        <GhostButton onClick={() => setSelectMode(!selectMode)}>
          {selectMode ? 'Done selecting' : 'Select'}
        </GhostButton>

        <div className="flex-none">
          <Segmented<BrowseMode> options={BROWSE_MODES} value={browse} onChange={setBrowse} />
        </div>
      </div>

      {selectMode && selectedCount > 0 ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-rule bg-ink-raised px-[26px] py-3">
          <span className="machine text-[13px] font-bold text-paper">{selectedCount} selected</span>
          <GhostButton onClick={() => void handleBulkAddToCollection()} disabled={isBulkWorking}>
            Add to a playlist
          </GhostButton>
          <GhostButton onClick={() => void handleBulkDelete()} disabled={isBulkWorking}>
            Delete
          </GhostButton>
        </div>
      ) : null}

      {loadError ? (
        <div className="px-[26px] pt-5">
          <ErrorNote>{loadError}</ErrorNote>
        </div>
      ) : null}
      {libraryNotice ? (
        <div className="px-[26px] pt-5">
          <QuietNote>{libraryNotice}</QuietNote>
        </div>
      ) : null}

      {filteredVideos.length === 0 ? (
        <div className="px-[26px] py-10">
          <EmptyState
            title={videos.length === 0 ? emptyLibraryCopy.title : 'No matches'}
            body={
              videos.length === 0
                ? emptyLibraryCopy.body
                : 'Nothing matches that search. Clear it, or pick a different chip.'
            }
            action={
              !hasConvexConfig ? (
                <Link to="/settings" className="csn-btn-capsule">
                  Open Settings
                </Link>
              ) : undefined
            }
          />
        </div>
      ) : browse === 'gallery' ? (
        <div
          ref={assetGridRef}
          onKeyDown={handleAssetGridKeyDown}
          tabIndex={0}
          className="px-[26px] pb-10 pt-5 outline-none"
        >
          <div
            data-gallery-assets-grid
            className="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-4"
          >
            {filteredVideos.map((video) => {
              const isCurrent = video._id === selectedVideo?._id;
              const isChecked = Boolean(selectedIds[video._id]);
              return (
                <button
                  key={video._id}
                  type="button"
                  data-gallery-asset-id={video._id}
                  onClick={() => (selectMode ? toggleSelected(video._id) : openVideo(video._id))}
                  className={`block w-full cursor-pointer rounded-card border p-[11px] text-left transition-colors ${
                    isChecked
                      ? 'border-accent bg-ink-raised'
                      : isCurrent
                        ? 'border-rule-strong bg-ink-raised'
                        : 'border-rule bg-ink-raised hover:border-rule-strong'
                  }`}
                >
                  <Thumb
                    seed={video._id}
                    posterUrl={appendCacheBust(video.posterUrl, video.updatedAt)}
                    duration={formatDuration(video.durationSeconds)}
                    className="aspect-video w-full rounded-chip"
                  >
                    {isCurrent && !selectMode ? (
                      <span className="absolute left-[7px] top-[7px] rounded-chip bg-paper px-[7px] py-[3px] font-condensed text-[10px] font-bold uppercase tracking-[.1em] text-ink">
                        Playing
                      </span>
                    ) : null}
                    {selectMode ? (
                      <span
                        className={`absolute left-[7px] top-[7px] flex h-[22px] w-[22px] items-center justify-center rounded-chip border ${
                          isChecked ? 'border-accent bg-accent' : 'border-paper/40 bg-ink/60'
                        }`}
                      >
                        {isChecked ? <CheckIcon size={13} /> : null}
                      </span>
                    ) : null}
                  </Thumb>

                  <div className="mt-[11px] truncate text-[13.5px] font-semibold text-paper">
                    {video.title}
                  </div>
                  <div className="mt-[7px] flex flex-wrap items-center gap-[9px]">
                    <StatusChip status={video.status} />
                    <span className="machine text-[11.5px] text-muted">
                      {formatResolutionShort(video)} · {formatFileSize(video.sourceFileSizeBytes)}
                    </span>
                  </div>
                  <div className="mt-[9px] flex flex-wrap items-center gap-1.5">
                    {publishSummary(video).tags.map((tag) => (
                      <PlatformTag key={tag.platform} platform={tag.platform} live={tag.live} />
                    ))}
                    <span className="machine text-[11px] text-muted">
                      {publishSummary(video).note}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : browse === 'list' ? (
        <div
          ref={assetGridRef}
          onKeyDown={handleAssetGridKeyDown}
          tabIndex={0}
          className="px-[26px] pb-10 pt-5 outline-none"
        >
          <div data-gallery-assets-grid className="csn-hair">
            {filteredVideos.map((video) => {
              const isCurrent = video._id === selectedVideo?._id;
              const isChecked = Boolean(selectedIds[video._id]);
              return (
                <button
                  key={video._id}
                  type="button"
                  data-gallery-asset-id={video._id}
                  onClick={() => (selectMode ? toggleSelected(video._id) : openVideo(video._id))}
                  className={`flex w-full cursor-pointer flex-wrap items-center gap-3.5 border-none px-3.5 py-[11px] text-left ${
                    isChecked || isCurrent ? 'bg-ink-tile' : 'bg-ink-raised hover:bg-ink-tile'
                  }`}
                >
                  {selectMode ? (
                    <span
                      className={`flex h-[22px] w-[22px] flex-none items-center justify-center rounded-chip border ${
                        isChecked ? 'border-accent bg-accent' : 'border-paper/30'
                      }`}
                    >
                      {isChecked ? <CheckIcon size={13} /> : null}
                    </span>
                  ) : null}
                  <Thumb
                    seed={video._id}
                    posterUrl={appendCacheBust(video.posterUrl, video.updatedAt)}
                    className="aspect-video w-[88px] flex-none rounded-chip"
                  />
                  <div className="flex min-w-[150px] flex-[1_1_200px] flex-col gap-[5px]">
                    <div className="truncate text-[13.5px] font-semibold text-paper">
                      {video.title}
                    </div>
                    <div className="truncate machine text-[11.5px] text-muted">
                      {formatResolution(video)} · {formatDuration(video.durationSeconds)} ·{' '}
                      {formatFileSize(video.sourceFileSizeBytes)}
                    </div>
                  </div>
                  <div className="flex flex-none items-center gap-1.5">
                    {publishSummary(video).tags.map((tag) => (
                      <PlatformTag key={tag.platform} platform={tag.platform} live={tag.live} />
                    ))}
                  </div>
                  <span className="min-w-[90px] flex-none machine text-[11.5px] text-muted">
                    {publishSummary(video).note}
                  </span>
                  <StatusChip status={video.status} />
                </button>
              );
            })}
          </div>
        </div>
      ) : selectedVideo ? (
        <div className="flex min-h-0 flex-wrap items-stretch">
          {/* -------------------------------------------------- the video */}
          <div className="min-w-[320px] flex-[1_1_520px]">
            <div className="px-[26px] pt-6">
              <div className="relative aspect-video overflow-hidden rounded-card border border-rule bg-ink-panel">
                {previewAvailable ? (
                  <ErrorBoundary label="The player">
                    <StoredVideoPlayer video={selectedVideo} />
                  </ErrorBoundary>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center p-6">
                    <div className="max-w-[320px] text-center">
                      <div className="font-condensed text-[13px] font-bold uppercase tracking-[.12em] text-muted">
                        {statusLabel(selectedVideo.status)}
                      </div>
                      <div className="mt-2 text-[13.5px] text-pretty text-body">
                        {getPreviewUnavailableCopy(selectedVideo.status).body}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-3.5 flex flex-wrap items-center gap-[9px]">
                <GhostButton onClick={() => selectVideoByOffset(-1)}>Previous</GhostButton>
                <GhostButton onClick={() => selectVideoByOffset(1)}>Next</GhostButton>
                <span className="min-w-[8px] flex-1" />
                <span className="machine text-[12px] text-muted">{positionNote}</span>
              </div>
            </div>

            <div className="px-[26px] pt-[22px]">
              <div className="flex flex-wrap items-center gap-2.5">
                <PageHeading size="detail" title={selectedVideo.title} />
                <StatusChip status={selectedVideo.status} />
              </div>
              {selectedVideo.description ? (
                <div className="mt-2.5 text-copy text-pretty text-body">
                  {selectedVideo.description}
                </div>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-[9px]">
                <GhostButton onClick={() => setInspectorTab(inspectorTab === 'metadata' ? 'details' : 'metadata')}>
                  {inspectorTab === 'metadata' ? 'Close details' : 'Edit details'}
                </GhostButton>
                {['ready', 'draft', 'archived'].includes(selectedVideo.status) ? (
                  <GhostButton
                    disabled={isSavingMetadata}
                    onClick={() =>
                      void handleSaveMetadata(selectedVideo.status === 'ready' ? 'draft' : 'ready')
                    }
                  >
                    {selectedVideo.status === 'ready' ? 'Unpublish' : 'Publish'}
                  </GhostButton>
                ) : null}
                <GhostButton
                  disabled={!previewAvailable || isGeneratingPosterCandidates}
                  onClick={() => {
                    if (inspectorTab === 'poster') {
                      setInspectorTab('details');
                      return;
                    }
                    setInspectorTab('poster');
                    void handleGeneratePosterCandidates();
                  }}
                >
                  {inspectorTab === 'poster' ? 'Hide thumbnails' : 'Replace thumbnail'}
                </GhostButton>
                <GhostButton onClick={() => navigate('/trimmer')}>Trim a clip</GhostButton>
                {selectedVideo.status === 'archived' ? (
                  <GhostButton
                    disabled={isRetrievingArchive}
                    onClick={() => void handleRetrieveArchive()}
                  >
                    {isRetrievingArchive ? 'Fetching…' : 'Get original back'}
                  </GhostButton>
                ) : null}
              </div>
            </div>

            {inspectorTab === 'poster' ? (
              <div className="px-[26px] pt-[22px]">
                <Eyebrow>Pick a thumbnail</Eyebrow>
                <div className="mt-[7px] text-caption text-pretty text-quiet">
                  Frames pulled from the finished video. Choosing one replaces the cover image
                  everywhere.
                </div>
                {isGeneratingPosterCandidates ? (
                  <div className="mt-3 text-[13px] text-quiet">Pulling frames…</div>
                ) : (
                  <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                    {posterCandidates.map((candidate) => {
                      const isPicked = candidate.localPath === selectedPosterCandidatePath;
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          onClick={() => setSelectedPosterCandidatePath(candidate.localPath)}
                          className={`block w-full cursor-pointer rounded-card border p-2 text-left ${
                            isPicked ? 'border-rule-strong bg-ink-raised' : 'border-rule bg-ink-raised hover:border-rule-strong'
                          }`}
                        >
                          <div className="relative aspect-video w-full overflow-hidden rounded-chip bg-ink-chip">
                            <img
                              src={candidate.imageUrl}
                              alt=""
                              className="absolute inset-0 h-full w-full object-cover"
                            />
                            <span className="csn-timecode">{candidate.label}</span>
                          </div>
                          <div
                            className={`mt-2 font-condensed text-[11.5px] font-bold uppercase tracking-[.08em] ${
                              isPicked ? 'text-paper' : 'text-quiet'
                            }`}
                          >
                            {isPicked ? 'Selected' : 'Use this frame'}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-[9px]">
                  <GhostButton
                    disabled={!selectedPosterCandidate || isApplyingPoster}
                    onClick={() => void handleApplyPoster()}
                  >
                    {isApplyingPoster ? 'Saving…' : 'Use this frame'}
                  </GhostButton>
                </div>
              </div>
            ) : null}

            {selectedVideo.errorMessage ? (
              <div className="px-[26px] pt-[18px]">
                <ErrorNote>{selectedVideo.errorMessage}</ErrorNote>
              </div>
            ) : null}

            <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-[18px] px-[26px] pt-6">
              <div>
                <Eyebrow>About</Eyebrow>
                <div className="mt-2.5">
                  <FactList>
                    <Fact label="Series" value={selectedVideo.series || '—'} />
                    <Fact label="Recorded" value={formatDate(selectedVideo.recordedAt)} />
                    <Fact label="Duration" value={formatDuration(selectedVideo.durationSeconds)} />
                    <Fact label="Original file" value={selectedVideo.sourceFileName} />
                  </FactList>
                </div>
              </div>
              <div>
                <Eyebrow>The video file</Eyebrow>
                <div className="mt-2.5">
                  <FactList>
                    <Fact machine label="Resolution" value={formatResolution(selectedVideo)} />
                    <Fact machine label="Frame rate" value={formatFrameRate(selectedVideo.sourceFrameRate)} />
                    <Fact machine label="File size" value={formatFileSize(selectedVideo.sourceFileSizeBytes)} />
                    <Fact
                      machine
                      label="Delivery"
                      value={
                        inferStoredDeliveryType(selectedVideo) === 'hls'
                          ? 'Streaming (HLS)'
                          : 'Progressive (MP4)'
                      }
                    />
                    <Fact machine label="Encoded with" value={formatCodec(selectedVideo.encoder)} />
                  </FactList>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-[26px] px-[26px] pt-[22px]">
              {selectedVideo.tags.length > 0 ? (
                <div className="min-w-[180px] flex-[1_1_220px]">
                  <Eyebrow>Tags</Eyebrow>
                  <div className="mt-2.5 flex flex-wrap gap-[7px]">
                    {selectedVideo.tags.map((tag) => (
                      <span key={tag} className="csn-tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {(selectedVideo.playlistTitles ?? []).length > 0 ? (
                <div className="min-w-[180px] flex-[1_1_220px]">
                  <Eyebrow>In playlists</Eyebrow>
                  <div className="mt-2.5 flex flex-wrap gap-[7px]">
                    {(selectedVideo.playlistTitles ?? []).map((playlist) => (
                      <span key={playlist} className="csn-tag">
                        {playlist}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="px-[26px] pt-[22px]">
              <Eyebrow>Where it is published</Eyebrow>
              <div className="mt-[7px] text-caption text-pretty text-quiet">
                Read-only here — scheduling and publishing are done in the connected viewer portal.
              </div>
              {publishSummary(selectedVideo).rows.length > 0 ? (
                <div className="mt-[11px]">
                  <FactList>
                    {publishSummary(selectedVideo).rows.map((row) => (
                      <div
                        key={row.platform}
                        className="csn-hair-row flex flex-wrap items-center gap-3 px-[13px] py-[11px]"
                      >
                        <PlatformGlyph platform={row.platform} live={row.live} />
                        <div className="min-w-[130px] flex-[1_1_160px]">
                          <div className="truncate text-[13.5px] font-semibold text-paper">
                            {row.name}
                          </div>
                          <div className="mt-0.5 machine text-[11.5px] text-muted">{row.when}</div>
                        </div>
                        <ToneChip tone={row.tone}>{row.state}</ToneChip>
                        {row.url ? (
                          <a
                            href={row.url}
                            className="min-w-[120px] flex-[1_1_180px] truncate machine text-[12px] text-body"
                          >
                            {row.url}
                          </a>
                        ) : null}
                      </div>
                    ))}
                  </FactList>
                </div>
              ) : (
                <div className="mt-[11px] text-[13px] text-pretty text-quiet">
                  {selectedVideo.status === 'ready' || selectedVideo.status === 'draft'
                    ? 'Not published anywhere yet. Publishing happens in the connected viewer portal.'
                    : 'It will be publishable once processing finishes.'}
                </div>
              )}
            </div>

            <div className="px-[26px] pt-[22px]">
              <Eyebrow>Links</Eyebrow>
              {videoLinks(selectedVideo).length > 0 ? (
                <div className="mt-2.5">
                  <FactList>
                    {videoLinks(selectedVideo).map((link) => (
                      <div
                        key={link.label}
                        className="csn-hair-row flex flex-wrap items-center gap-3.5 px-3.5 py-[11px]"
                      >
                        <span className="w-[100px] flex-none text-caption text-quiet">
                          {link.label}
                        </span>
                        <a
                          href={link.url}
                          className="min-w-[120px] flex-[1_1_180px] truncate machine text-caption text-body"
                        >
                          {link.url}
                        </a>
                        <GhostButton
                          onClick={() => {
                            void navigator.clipboard.writeText(link.url);
                            flash(`${link.label} copied`);
                          }}
                        >
                          Copy
                        </GhostButton>
                      </div>
                    ))}
                  </FactList>
                </div>
              ) : (
                <div className="mt-2.5 text-[13px] text-quiet">
                  Links appear once this video finishes processing.
                </div>
              )}
            </div>

            {derivedClips.length > 0 ? (
              <div className="px-[26px] pt-[22px]">
                <SectionHead title="CLIPS FROM THIS VIDEO" note={`${derivedClips.length}`} size="sm" />
                <div className="csn-hair mt-2.5">
                  {derivedClips.map((clip) => (
                    <button
                      key={clip._id}
                      type="button"
                      onClick={() => openVideo(clip._id)}
                      className="csn-hair-row flex w-full cursor-pointer flex-wrap items-center gap-3 border-none px-3.5 py-[11px] text-left hover:bg-ink-tile"
                    >
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-paper">
                        {clip.title}
                      </span>
                      <span className="machine text-[11.5px] text-muted">
                        {formatDuration(clip.durationSeconds)}
                      </span>
                      <StatusChip status={clip.status} />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* ------------------------------------------- the machine half */}
            <div className="px-[26px] pt-[22px]">
              <Disclosure
                open={inspectorTab === 'details' && storageOpen}
                onToggle={() => {
                  setInspectorTab('details');
                  setStorageOpen((open) => !open);
                }}
                showLabel="Show storage details"
                hideLabel="Hide storage details"
              />
            </div>

            {storageOpen && inspectorTab === 'details' ? (
              <div className="px-[26px] pt-3.5">
                <FactList>
                  <Fact wide machine label="Archive key" value={selectedVideo.archiveObjectKey || '—'} />
                  <Fact
                    wide
                    machine
                    label="Playback folder"
                    value={selectedVideo.distributionObjectKey || '—'}
                  />
                  <Fact wide machine label="Added" value={formatDate(selectedVideo.createdAt)} />
                  <Fact wide machine label="Last changed" value={formatDate(selectedVideo.updatedAt)} />
                </FactList>

                {archiveError ? (
                  <div className="mt-3">
                    <ErrorNote>{archiveError}</ErrorNote>
                  </div>
                ) : null}
                {archivePreview?.url ? (
                  <div className="mt-3">
                    <QuietNote>
                      <a href={archivePreview.url} className="machine break-all underline">
                        {archivePreview.url}
                      </a>{' '}
                      — expires in {archivePreview.expiresInSeconds}s.
                    </QuietNote>
                  </div>
                ) : null}

                <div className="mt-3.5 flex flex-wrap gap-[9px]">
                  <GhostButton
                    disabled={!selectedVideo.archiveObjectKey || isLoadingArchivePreview}
                    onClick={() => void handlePreviewArchive()}
                  >
                    {isLoadingArchivePreview ? 'Opening…' : 'Preview the original'}
                  </GhostButton>
                  <GhostButton
                    disabled={!hasConvexConfig || isRepairingUrls}
                    onClick={() => void handleRepairStoredUrls()}
                  >
                    {isRepairingUrls ? 'Repairing…' : 'Repair links'}
                  </GhostButton>
                  <GhostButton onClick={() => setRefreshKey((current) => current + 1)}>
                    Refresh
                  </GhostButton>
                  <GhostButton disabled={isDeletingVideo} onClick={() => void handleDeleteVideo()}>
                    {isDeletingVideo ? 'Deleting…' : 'Delete this video'}
                  </GhostButton>
                </div>

                <div className="mt-5">
                  <Eyebrow>Narrow the list</Eyebrow>
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2">
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
                      renderLabel={(option) =>
                        option === 'all' ? 'All' : formatContentTypeLabel(option)
                      }
                    />
                    <FilterChipGroup
                      label="Delivery"
                      options={DELIVERY_CHIP_OPTIONS}
                      value={deliveryFilter}
                      onChange={(value) => setDeliveryFilter(value)}
                      renderLabel={(option) => (option === 'all' ? 'All' : formatDeliveryLabel(option))}
                    />
                    <SeriesFilter
                      videos={videos}
                      value={collectionParam}
                      onChange={(next) => setCollectionFilter(next)}
                    />
                    {collectionParam ? (
                      <GhostButton onClick={clearCollectionFilter}>Clear playlist</GhostButton>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {inspectorTab === 'metadata' && editorDraft ? (
              <div className="px-[26px] pt-[22px]">
                <Eyebrow>Edit details</Eyebrow>
                <div className="mt-3 flex flex-col gap-3.5">
                  <label className="block">
                    <span className="csn-label">Title</span>
                    <input
                      value={editorDraft.title}
                      onChange={(event) =>
                        setEditorDraft({ ...editorDraft, title: event.target.value })
                      }
                      className="csn-input"
                    />
                  </label>
                  <label className="block">
                    <span className="csn-label">Description</span>
                    <textarea
                      rows={3}
                      value={editorDraft.description}
                      onChange={(event) =>
                        setEditorDraft({ ...editorDraft, description: event.target.value })
                      }
                      className="csn-textarea"
                    />
                  </label>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3.5">
                    <SingleValuePicker
                      label="Series"
                      onChange={(next) => setEditorDraft({ ...editorDraft, series: next })}
                      options={seriesOptions}
                      placeholder="Midweek"
                      value={editorDraft.series}
                    />
                    <MultiValuePicker
                      label="Playlists"
                      onChange={(next) =>
                        setEditorDraft({ ...editorDraft, playlistInput: next.join(', ') })
                      }
                      options={playlistOptions}
                      placeholder="2026 Season"
                      values={splitCommaSeparatedValues(editorDraft.playlistInput)}
                    />
                    <MultiValuePicker
                      label="Tags"
                      onChange={(next) =>
                        setEditorDraft({ ...editorDraft, tagsInput: next.join(', ') })
                      }
                      options={tagOptions}
                      placeholder="baseball"
                      values={splitCommaSeparatedValues(editorDraft.tagsInput)}
                    />
                    <label className="block">
                      <span className="csn-label">Recorded</span>
                      <input
                        type="datetime-local"
                        value={editorDraft.recordedAtInput}
                        onChange={(event) =>
                          setEditorDraft({ ...editorDraft, recordedAtInput: event.target.value })
                        }
                        className="csn-input"
                      />
                    </label>
                    <label className="block">
                      <span className="csn-label">Event</span>
                      <input
                        value={editorDraft.eventName}
                        onChange={(event) =>
                          setEditorDraft({ ...editorDraft, eventName: event.target.value })
                        }
                        className="csn-input"
                      />
                    </label>
                    <label className="block">
                      <span className="csn-label">Project</span>
                      <input
                        value={editorDraft.projectName}
                        onChange={(event) =>
                          setEditorDraft({ ...editorDraft, projectName: event.target.value })
                        }
                        className="csn-input"
                      />
                    </label>
                    <label className="block">
                      <span className="csn-label">Camera</span>
                      <input
                        value={editorDraft.cameraId}
                        onChange={(event) =>
                          setEditorDraft({ ...editorDraft, cameraId: event.target.value })
                        }
                        className="csn-input"
                      />
                    </label>
                    <label className="block">
                      <span className="csn-label">Recorded on</span>
                      <input
                        value={editorDraft.sourceNode}
                        onChange={(event) =>
                          setEditorDraft({ ...editorDraft, sourceNode: event.target.value })
                        }
                        className="csn-input"
                      />
                    </label>
                    <label className="block">
                      <span className="csn-label">Review</span>
                      <select
                        value={editorDraft.reviewStatus}
                        onChange={(event) =>
                          setEditorDraft({
                            ...editorDraft,
                            reviewStatus: event.target.value as ReviewStatus,
                          })
                        }
                        className="csn-select w-full"
                      >
                        {REVIEW_STATUS_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {formatReviewStatusLabel(option)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="csn-label">State</span>
                      <select
                        value={editorDraft.status}
                        onChange={(event) =>
                          setEditorDraft({
                            ...editorDraft,
                            status: event.target.value as StoredVideoStatus,
                          })
                        }
                        className="csn-select w-full"
                      >
                        {EDITABLE_STATUS_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {formatStatusLabel(option)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="flex flex-wrap gap-[9px]">
                    <GhostButton
                      disabled={isSavingMetadata}
                      onClick={() => void handleSaveMetadata()}
                    >
                      {isSavingMetadata ? 'Saving…' : 'Save details'}
                    </GhostButton>
                    <GhostButton onClick={() => setEditorDraft(buildEditorDraft(selectedVideo))}>
                      Undo changes
                    </GhostButton>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="h-10" />
          </div>

          {/* --------------------------------------------------- the rail */}
          <div className="flex min-w-[260px] flex-[0_1_312px] flex-col border-l border-rule">
            <div className="px-5 pt-5">
              <Eyebrow>
                {isLoading
                  ? 'Refreshing…'
                  : `${filteredVideos.length} video${filteredVideos.length === 1 ? '' : 's'}`}
              </Eyebrow>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-5 pb-10 pt-3.5">
              {filteredVideos.map((video) => {
                const isCurrent = video._id === selectedVideo._id;
                return (
                  <button
                    key={video._id}
                    type="button"
                    onClick={() => setSelectedVideoId(video._id)}
                    className={`flex w-full cursor-pointer items-center gap-[11px] rounded-card border p-[7px] text-left transition-colors ${
                      isCurrent
                        ? 'border-rule-strong bg-ink-chip'
                        : 'border-transparent hover:bg-ink-tile'
                    }`}
                  >
                    <Thumb
                      seed={video._id}
                      posterUrl={appendCacheBust(video.posterUrl, video.updatedAt)}
                      showPlay={isCurrent}
                      className="aspect-video w-[76px] flex-none rounded-chip"
                    />
                    <div className="min-w-0 flex-1">
                      <div
                        className={`truncate text-[13px] font-semibold ${
                          isCurrent ? 'text-paper' : 'text-body'
                        }`}
                      >
                        {video.title}
                      </div>
                      <div className="mt-[3px] truncate machine text-[11.5px] text-muted">
                        {formatDuration(video.durationSeconds)} · {statusLabel(video.status)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      <Toast message={toast} />
    </Screen>
  );
}

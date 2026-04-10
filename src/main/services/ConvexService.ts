import { ConvexHttpClient } from 'convex/browser';
import path from 'node:path';
import { inferStoredContentType, inferStoredDeliveryType, getManifestUrl } from '../../shared/media';
import type {
  AppSettings,
  ContentType,
  DeliveryType,
  EffectiveHardwareEncoder,
  LogLevel,
  RepairStoredVideoUrlsResult,
  RequestedDeliveryType,
  StoredVideoSource,
  StoredVideoSnapshot,
  StoredVideoStatus,
} from '../../shared/types';
import { joinPublicUrl } from '../lib/helpers';

interface ConvexLogger {
  (level: LogLevel, message: string, jobId?: string): void;
}

interface ConvexPayload {
  title?: string;
  sourceName: string;
  sourceFingerprint?: string | null;
  requestedDelivery?: RequestedDeliveryType | null;
  deliveryType?: DeliveryType | null;
  contentType?: ContentType | null;
  archiveObjectKey: string;
  distributionObjectKey: string;
  playbackUrl: string;
  manifestUrl?: string | null;
  posterUrl?: string | null;
  sources?: StoredVideoSource[];
  encoder: EffectiveHardwareEncoder;
  durationSeconds: number;
  sourceFileSizeBytes?: number | null;
  sourceFrameRate?: number | null;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  tags?: string[];
  playlistTitles?: string[];
  description?: string | null;
  series?: string | null;
  recordedAt?: string | null;
  errorMessage?: string | null;
  status: StoredVideoStatus;
}

export type ExistingVideoRecord = StoredVideoSnapshot;

interface PaginatedVideosResponse {
  page: StoredVideoSnapshot[];
  isDone: boolean;
  continueCursor: string;
}

function buildPlaybackUrlFromStoredVideo(settings: AppSettings, video: StoredVideoSnapshot) {
  const h264Source = video.sources?.find((source) => source.codec === 'h264');
  if (h264Source?.objectKey) {
    return joinPublicUrl(settings.r2.publicBaseUrl, h264Source.objectKey);
  }

  if (video.playbackUrl) {
    try {
      const playbackUrl = new URL(video.playbackUrl);
      return joinPublicUrl(
        settings.r2.publicBaseUrl,
        video.distributionObjectKey,
        path.posix.basename(playbackUrl.pathname),
      );
    } catch {
      return video.playbackUrl;
    }
  }

  return joinPublicUrl(settings.r2.publicBaseUrl, video.distributionObjectKey);
}

export class ConvexService {
  constructor(private readonly log: ConvexLogger) {}

  private createClient(settings: AppSettings) {
    return new ConvexHttpClient(settings.convex.deploymentUrl);
  }

  private deriveFunctionPath(settings: AppSettings, functionName: string) {
    const [moduleName] = settings.convex.mutationPath.split(':');
    return `${moduleName || 'videos'}:${functionName}`;
  }

  private createUnsafeQueryClient(settings: AppSettings) {
    const client = this.createClient(settings);
    return client as unknown as {
      query: (queryPath: string, args: Record<string, unknown>) => Promise<unknown>;
    };
  }

  private createUnsafeMutationClient(settings: AppSettings) {
    const client = this.createClient(settings);
    return client as unknown as {
      mutation: (mutationPath: string, args: Record<string, unknown>) => Promise<unknown>;
    };
  }

  async findVideosBySourceFingerprint(
    settings: AppSettings,
    sourceFingerprint: string,
    jobId: string,
  ): Promise<ExistingVideoRecord[]> {
    if (!settings.convex.deploymentUrl || !settings.convex.mutationPath) {
      return [];
    }

    const unsafeClient = this.createUnsafeQueryClient(settings);

    const result = await unsafeClient.query(
      this.deriveFunctionPath(settings, 'getVideosBySourceFingerprint'),
      { sourceFingerprint },
    );

    if (!Array.isArray(result)) {
      return [];
    }

    this.log('info', `Checked Convex for existing uploads using source fingerprint.`, jobId);
    return result as ExistingVideoRecord[];
  }

  async listVideos(settings: AppSettings): Promise<StoredVideoSnapshot[]> {
    if (!settings.convex.deploymentUrl || !settings.convex.mutationPath) {
      return [];
    }

    const unsafeClient = this.createUnsafeQueryClient(settings);

    const result = await unsafeClient.query(this.deriveFunctionPath(settings, 'listVideos'), {});
    if (!Array.isArray(result)) {
      return [];
    }

    return result as StoredVideoSnapshot[];
  }

  async repairStoredVideoUrls(settings: AppSettings): Promise<RepairStoredVideoUrlsResult> {
    if (!settings.convex.deploymentUrl || !settings.convex.mutationPath) {
      throw new Error('Convex settings are incomplete. Add the deployment URL and mutation path.');
    }

    if (!settings.r2.publicBaseUrl.trim()) {
      throw new Error('R2 Public Base URL is required before stored playback URLs can be repaired.');
    }

    const videos = await this.listAllVideos(settings);
    let updated = 0;
    let skipped = 0;

    for (const video of videos) {
      const deliveryType = inferStoredDeliveryType(video);
      const nextManifestUrl =
        deliveryType === 'hls'
          ? joinPublicUrl(
              settings.r2.publicBaseUrl,
              video.distributionObjectKey,
              'master.m3u8',
            )
          : null;
      const nextPlaybackUrl =
        deliveryType === 'hls'
          ? (nextManifestUrl ?? video.playbackUrl)
          : buildPlaybackUrlFromStoredVideo(settings, video);
      const nextPosterUrl = video.posterUrl
        ? joinPublicUrl(
            settings.r2.publicBaseUrl,
            video.distributionObjectKey,
            'poster.jpg',
          )
        : null;
      const nextSources =
        deliveryType === 'progressive'
          ? (video.sources ?? []).map((source) => ({
              ...source,
              url: joinPublicUrl(settings.r2.publicBaseUrl, source.objectKey),
            }))
          : [];

      const isAlreadyCurrent =
        (getManifestUrl(video) ?? null) === nextManifestUrl &&
        video.playbackUrl === nextPlaybackUrl &&
        (video.posterUrl ?? null) === nextPosterUrl &&
        JSON.stringify(video.sources ?? []) === JSON.stringify(nextSources);

      if (isAlreadyCurrent) {
        skipped += 1;
        continue;
      }

      await this.createVodEntry(
        settings,
        {
          title: video.title,
          sourceName: video.sourceFileName,
          sourceFingerprint: video.sourceFingerprint ?? null,
          requestedDelivery: video.requestedDelivery ?? null,
          deliveryType,
          contentType: inferStoredContentType(video),
          archiveObjectKey: video.archiveObjectKey,
          distributionObjectKey: video.distributionObjectKey,
          playbackUrl: nextPlaybackUrl,
          manifestUrl: nextManifestUrl,
          posterUrl: nextPosterUrl,
          sources: nextSources,
          encoder: video.encoder,
          durationSeconds: video.durationSeconds,
          sourceFileSizeBytes: video.sourceFileSizeBytes ?? null,
          sourceFrameRate: video.sourceFrameRate ?? null,
          sourceWidth: video.sourceWidth ?? null,
          sourceHeight: video.sourceHeight ?? null,
          tags: video.tags,
          description: video.description ?? null,
          series: video.series ?? null,
          recordedAt: video.recordedAt ?? null,
          errorMessage: video.errorMessage ?? null,
          status: video.status,
        },
        `repair:${video._id}`,
      );

      updated += 1;
    }

    return {
      inspected: videos.length,
      updated,
      skipped,
    };
  }

  async createVodEntry(settings: AppSettings, payload: ConvexPayload, jobId: string) {
    if (!settings.convex.deploymentUrl || !settings.convex.mutationPath) {
      throw new Error('Convex settings are incomplete. Add the deployment URL and mutation path.');
    }

    const unsafeClient = this.createUnsafeMutationClient(settings);

    const requestPayload = {
      title: payload.title?.trim() || path.parse(payload.sourceName).name,
      sourceFileName: payload.sourceName,
      sourceFingerprint: payload.sourceFingerprint ?? undefined,
      requestedDelivery: payload.requestedDelivery ?? undefined,
      deliveryType: payload.deliveryType ?? undefined,
      contentType: payload.contentType ?? undefined,
      archiveObjectKey: payload.archiveObjectKey,
      distributionObjectKey: payload.distributionObjectKey,
      masterPlaylistUrl: payload.manifestUrl ?? undefined,
      manifestUrl: payload.manifestUrl ?? undefined,
      playbackUrl: payload.playbackUrl,
      posterUrl: payload.posterUrl ?? undefined,
      sources: payload.sources && payload.sources.length > 0 ? payload.sources : undefined,
      encoder: payload.encoder,
      durationSeconds: payload.durationSeconds,
      sourceFileSizeBytes: payload.sourceFileSizeBytes ?? undefined,
      sourceFrameRate: payload.sourceFrameRate ?? undefined,
      sourceWidth: payload.sourceWidth ?? undefined,
      sourceHeight: payload.sourceHeight ?? undefined,
      tags: payload.tags ?? undefined,
      playlistTitles: payload.playlistTitles ?? undefined,
      description: payload.description ?? undefined,
      series: payload.series ?? undefined,
      recordedAt: payload.recordedAt ?? undefined,
      createdAt: new Date().toISOString(),
      status: payload.status,
      errorMessage: payload.errorMessage ?? undefined,
    };

    await unsafeClient.mutation(settings.convex.mutationPath, requestPayload);
    this.log('info', `Synced ${payload.sourceName} with Convex (${payload.status}).`, jobId);
  }

  private async listAllVideos(settings: AppSettings): Promise<StoredVideoSnapshot[]> {
    const unsafeClient = this.createUnsafeQueryClient(settings);
    const videos: StoredVideoSnapshot[] = [];
    let cursor: string | null = null;
    let isDone = false;

    while (!isDone) {
      const result = await unsafeClient.query(
        this.deriveFunctionPath(settings, 'paginateVideos'),
        {
          paginationOpts: {
            cursor,
            numItems: 100,
          },
        },
      );

      const page = result as PaginatedVideosResponse;
      videos.push(...page.page);
      cursor = page.continueCursor;
      isDone = page.isDone;
    }

    return videos;
  }
}

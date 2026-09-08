import { ConvexHttpClient } from 'convex/browser';
import path from 'node:path';
import { inferStoredContentType, inferStoredDeliveryType, getManifestUrl } from '../../shared/media';
import type {
  AppSettings,
  ClipAspectRatio,
  ContentType,
  DeleteStoredVideoRequest,
  DeliveryType,
  DesktopNodeHeartbeat,
  EffectiveHardwareEncoder,
  LogLevel,
  RepairStoredVideoUrlsResult,
  RenderJobSnapshot,
  RequestedDeliveryType,
  ReviewStatus,
  SocialDeploymentStatus,
  StoredVideoMetadataUpdateRequest,
  StoredVideoSource,
  StorageTaskSnapshot,
  StoredVideoSnapshot,
  StoredVideoStatus,
} from '../../shared/types';
import { joinPublicUrl } from '../lib/helpers';

/**
 * Long enough for a multi-gigabyte server-side copy to finish inside one lease
 * renewal window, matching the backend's default in `convex/storage.ts`.
 */
const STORAGE_TASK_LEASE_SECONDS = 120;

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
  sourceVideoCodec?: string | null;
  sourceAudioCodec?: string | null;
  tags?: string[];
  playlistTitles?: string[];
  description?: string | null;
  series?: string | null;
  recordedAt?: string | null;
  projectName?: string | null;
  eventName?: string | null;
  cameraId?: string | null;
  sourceNode?: string | null;
  reviewStatus?: ReviewStatus | null;
  socialStatus?: SocialDeploymentStatus | null;
  scheduledPublishAt?: string | null;
  errorMessage?: string | null;
  status: StoredVideoStatus;
  sourceVideoId?: string | null;
  clipAspectRatio?: ClipAspectRatio | null;
  clipInSeconds?: number | null;
  clipOutSeconds?: number | null;
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
    return `${moduleName || 'media/videos'}:${functionName}`;
  }

  /**
   * Adds this workstation's node token to every call.
   *
   * Done once here rather than at each call site: the shared deployment rejects
   * an unauthenticated media function, and a single missed argument would fail
   * one operation at runtime on an operator's machine rather than at build
   * time. An empty token is omitted so the failure reads as "no credential
   * configured" instead of "credential rejected".
   */
  private withNodeToken(settings: AppSettings, args: Record<string, unknown>) {
    const nodeToken = settings.convex.nodeToken?.trim();
    return nodeToken ? { ...args, nodeToken } : args;
  }

  private createUnsafeQueryClient(settings: AppSettings) {
    const client = this.createClient(settings);
    const unsafeClient = client as unknown as {
      query: (queryPath: string, args: Record<string, unknown>) => Promise<unknown>;
    };

    return {
      query: (queryPath: string, args: Record<string, unknown>) =>
        unsafeClient.query(queryPath, this.withNodeToken(settings, args)),
    };
  }

  private createUnsafeMutationClient(settings: AppSettings) {
    const client = this.createClient(settings);
    const unsafeClient = client as unknown as {
      mutation: (mutationPath: string, args: Record<string, unknown>) => Promise<unknown>;
    };

    return {
      mutation: (mutationPath: string, args: Record<string, unknown>) =>
        unsafeClient.mutation(mutationPath, this.withNodeToken(settings, args)),
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

    return await this.listAllVideos(settings);
  }

  async updateVideoMetadata(settings: AppSettings, request: StoredVideoMetadataUpdateRequest) {
    if (!settings.convex.deploymentUrl || !settings.convex.mutationPath) {
      throw new Error('Convex settings are incomplete. Add the deployment URL and mutation path.');
    }

    const unsafeClient = this.createUnsafeMutationClient(settings);
    await unsafeClient.mutation(
      this.deriveFunctionPath(settings, 'updateVideoMetadata'),
      {
        videoId: request.videoId,
        title:
          request.title === undefined
            ? undefined
            : (request.title?.trim() ?? null),
        status: request.status,
        tags: request.tags === undefined ? undefined : request.tags,
        playlistTitles:
          request.playlistTitles === undefined ? undefined : request.playlistTitles,
        description: request.description === undefined ? undefined : request.description ?? null,
        series: request.series === undefined ? undefined : request.series ?? null,
        recordedAt: request.recordedAt === undefined ? undefined : request.recordedAt ?? null,
        projectName: request.projectName === undefined ? undefined : request.projectName ?? null,
        eventName: request.eventName === undefined ? undefined : request.eventName ?? null,
        cameraId: request.cameraId === undefined ? undefined : request.cameraId ?? null,
        sourceNode: request.sourceNode === undefined ? undefined : request.sourceNode ?? null,
        reviewStatus: request.reviewStatus === undefined ? undefined : request.reviewStatus ?? null,
        socialStatus: request.socialStatus === undefined ? undefined : request.socialStatus ?? null,
        scheduledPublishAt:
          request.scheduledPublishAt === undefined ? undefined : request.scheduledPublishAt ?? null,
        posterUrl: request.posterUrl === undefined ? undefined : request.posterUrl ?? null,
      },
    );
  }

  async deleteVideo(settings: AppSettings, request: DeleteStoredVideoRequest) {
    if (!settings.convex.deploymentUrl || !settings.convex.mutationPath) {
      throw new Error('Convex settings are incomplete. Add the deployment URL and mutation path.');
    }

    const unsafeClient = this.createUnsafeMutationClient(settings);
    await unsafeClient.mutation(
      this.deriveFunctionPath(settings, 'deleteVideo'),
      {
        videoId: request.videoId,
      },
    );
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
          sourceVideoCodec: video.sourceVideoCodec ?? null,
          sourceAudioCodec: video.sourceAudioCodec ?? null,
          tags: video.tags,
          description: video.description ?? null,
          series: video.series ?? null,
          recordedAt: video.recordedAt ?? null,
          projectName: video.projectName ?? null,
          eventName: video.eventName ?? null,
          cameraId: video.cameraId ?? null,
          sourceNode: video.sourceNode ?? null,
          reviewStatus: video.reviewStatus ?? null,
          socialStatus: video.socialStatus ?? null,
          scheduledPublishAt: video.scheduledPublishAt ?? null,
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
      sourceVideoCodec: payload.sourceVideoCodec ?? undefined,
      sourceAudioCodec: payload.sourceAudioCodec ?? undefined,
      tags: payload.tags ?? undefined,
      playlistTitles: payload.playlistTitles ?? undefined,
      description: payload.description ?? undefined,
      series: payload.series ?? undefined,
      recordedAt: payload.recordedAt ?? undefined,
      projectName: payload.projectName ?? undefined,
      eventName: payload.eventName ?? undefined,
      cameraId: payload.cameraId ?? undefined,
      sourceNode: payload.sourceNode ?? undefined,
      reviewStatus: payload.reviewStatus ?? undefined,
      socialStatus: payload.socialStatus ?? undefined,
      scheduledPublishAt: payload.scheduledPublishAt ?? undefined,
      createdAt: new Date().toISOString(),
      status: payload.status,
      errorMessage: payload.errorMessage ?? undefined,
      sourceVideoId: payload.sourceVideoId ?? undefined,
      clipAspectRatio: payload.clipAspectRatio ?? undefined,
      clipInSeconds: payload.clipInSeconds ?? undefined,
      clipOutSeconds: payload.clipOutSeconds ?? undefined,
    };

    await unsafeClient.mutation(settings.convex.mutationPath, requestPayload);
    this.log('info', `Synced ${payload.sourceName} with Convex (${payload.status}).`, jobId);
  }

  async listClipsForVideo(settings: AppSettings, sourceVideoId: string): Promise<StoredVideoSnapshot[]> {
    if (!settings.convex.deploymentUrl || !settings.convex.mutationPath) {
      return [];
    }

    const unsafeClient = this.createUnsafeQueryClient(settings);
    const result = await unsafeClient.query(
      this.deriveFunctionPath(settings, 'listClipsForVideo'),
      { sourceVideoId },
    );

    return Array.isArray(result) ? (result as StoredVideoSnapshot[]) : [];
  }

  async upsertDesktopNodeHeartbeat(settings: AppSettings, heartbeat: DesktopNodeHeartbeat): Promise<string | null> {
    if (!settings.convex.deploymentUrl) {
      return null;
    }

    const unsafeClient = this.createUnsafeMutationClient(settings);
    const result = await unsafeClient.mutation('media/orchestration:upsertDesktopNodeHeartbeat', {
      nodeKey: heartbeat.nodeKey,
      displayName: heartbeat.displayName,
      appVersion: heartbeat.appVersion ?? undefined,
      platform: heartbeat.platform,
      arch: heartbeat.arch,
      hostname: heartbeat.hostname ?? undefined,
      status: heartbeat.status,
      capabilities: heartbeat.capabilities,
      watchFolder: heartbeat.watchFolder ?? undefined,
      tempOutputPath: heartbeat.tempOutputPath ?? undefined,
      queueDepth: heartbeat.queueDepth,
      activeEncodingJobId: heartbeat.activeEncodingJobId ?? undefined,
      activeRenderJobId: heartbeat.activeRenderJobId ?? undefined,
      ffmpegAvailable: heartbeat.ffmpegAvailable ?? undefined,
      ffprobeAvailable: heartbeat.ffprobeAvailable ?? undefined,
      rcloneAvailable: heartbeat.rcloneAvailable ?? undefined,
      internetReachable: heartbeat.internetReachable ?? undefined,
      watcherHealthy: heartbeat.watcherHealthy ?? undefined,
      notes: heartbeat.notes,
    });

    return result ? String(result) : null;
  }

  async claimNextRenderJob(settings: AppSettings, nodeKey: string): Promise<RenderJobSnapshot | null> {
    if (!settings.convex.deploymentUrl) {
      return null;
    }

    const unsafeClient = this.createUnsafeMutationClient(settings);
    const result = await unsafeClient.mutation('media/orchestration:claimNextRenderJob', {
      nodeKey,
      leaseSeconds: 60,
    });

    return result ? (result as RenderJobSnapshot) : null;
  }

  async renewRenderJobLease(settings: AppSettings, renderJobId: string, nodeKey: string): Promise<void> {
    if (!settings.convex.deploymentUrl) {
      return;
    }

    const unsafeClient = this.createUnsafeMutationClient(settings);
    await unsafeClient.mutation('media/orchestration:renewRenderJobLease', {
      renderJobId,
      nodeKey,
      leaseSeconds: 60,
    });
  }

  async markRenderJobProgress(
    settings: AppSettings,
    request: {
      renderJobId: string;
      nodeKey: string;
      status?: RenderJobSnapshot['status'];
      progress: number;
      stage?: string;
      message?: string;
    },
  ): Promise<void> {
    if (!settings.convex.deploymentUrl) {
      return;
    }

    const unsafeClient = this.createUnsafeMutationClient(settings);
    await unsafeClient.mutation('media/orchestration:markRenderJobProgress', {
      ...request,
      leaseSeconds: 60,
    });
  }

  async markRenderJobFailed(
    settings: AppSettings,
    renderJobId: string,
    nodeKey: string,
    errorMessage: string,
  ): Promise<void> {
    if (!settings.convex.deploymentUrl) {
      return;
    }

    const unsafeClient = this.createUnsafeMutationClient(settings);
    await unsafeClient.mutation('media/orchestration:markRenderJobFailed', {
      renderJobId,
      nodeKey,
      errorMessage,
    });
  }

  async completeRenderJob(
    settings: AppSettings,
    request: {
      renderJobId: string;
      nodeKey: string;
      objectKey: string;
      url: string;
      mimeType?: string;
      durationSeconds?: number;
    },
  ): Promise<string | null> {
    if (!settings.convex.deploymentUrl) {
      return null;
    }

    const unsafeClient = this.createUnsafeMutationClient(settings);
    const result = await unsafeClient.mutation('media/orchestration:completeRenderJob', {
      renderJobId: request.renderJobId,
      nodeKey: request.nodeKey,
      objectKey: request.objectKey,
      url: request.url,
      mimeType: request.mimeType ?? undefined,
      durationSeconds: request.durationSeconds ?? undefined,
    });

    return result ? String(result) : null;
  }

  async claimNextStorageTask(
    settings: AppSettings,
    nodeKey: string,
  ): Promise<StorageTaskSnapshot | null> {
    if (!settings.convex.deploymentUrl) {
      return null;
    }

    const unsafeClient = this.createUnsafeMutationClient(settings);
    const result = await unsafeClient.mutation('media/storage:claimNextStorageTask', {
      nodeKey,
      leaseSeconds: STORAGE_TASK_LEASE_SECONDS,
    });

    return result ? (result as StorageTaskSnapshot) : null;
  }

  async renewStorageTaskLease(
    settings: AppSettings,
    storageTaskId: string,
    nodeKey: string,
  ): Promise<void> {
    if (!settings.convex.deploymentUrl) {
      return;
    }

    const unsafeClient = this.createUnsafeMutationClient(settings);
    await unsafeClient.mutation('media/storage:renewStorageTaskLease', {
      storageTaskId,
      nodeKey,
      leaseSeconds: STORAGE_TASK_LEASE_SECONDS,
    });
  }

  async completeStorageTask(
    settings: AppSettings,
    storageTaskId: string,
    nodeKey: string,
  ): Promise<void> {
    if (!settings.convex.deploymentUrl) {
      return;
    }

    const unsafeClient = this.createUnsafeMutationClient(settings);
    await unsafeClient.mutation('media/storage:completeStorageTask', {
      storageTaskId,
      nodeKey,
    });
  }

  async markStorageTaskFailed(
    settings: AppSettings,
    storageTaskId: string,
    nodeKey: string,
    errorMessage: string,
  ): Promise<void> {
    if (!settings.convex.deploymentUrl) {
      return;
    }

    const unsafeClient = this.createUnsafeMutationClient(settings);
    await unsafeClient.mutation('media/storage:markStorageTaskFailed', {
      storageTaskId,
      nodeKey,
      errorMessage,
    });
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

import { paginationOptsValidator } from "convex/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const effectiveHardwareEncoderValidator = v.union(
  v.literal("nvenc"),
  v.literal("videotoolbox"),
  v.literal("software"),
);

const requestedDeliveryValidator = v.union(
  v.literal("auto"),
  v.literal("progressive"),
  v.literal("hls"),
);

const deliveryTypeValidator = v.union(
  v.literal("progressive"),
  v.literal("hls"),
);

const contentTypeValidator = v.union(
  v.literal("clip"),
  v.literal("vod"),
);

const videoSourceCodecValidator = v.union(
  v.literal("av1"),
  v.literal("h264"),
  v.literal("hevc"),
);

const storedVideoSourceValidator = v.object({
  codec: videoSourceCodecValidator,
  mimeType: v.string(),
  url: v.string(),
  objectKey: v.string(),
});

const videoStatusValidator = v.union(
  v.literal("processing"),
  v.literal("uploading"),
  v.literal("draft"),
  v.literal("ready"),
  v.literal("error"),
  v.literal("archived"),
);

function nowIso() {
  return new Date().toISOString();
}

function trimOptional(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeTags(tags: string[] | null | undefined) {
  return Array.from(
    new Set(
      (tags ?? [])
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeSources(
  sources: Doc<"videos">["sources"] | null | undefined,
) {
  return Array.from(
    new Map(
      (sources ?? [])
        .filter((source) => source.url.trim() && source.objectKey.trim())
        .map((source) => [
          source.objectKey,
          {
            codec: source.codec,
            mimeType: source.mimeType.trim(),
            url: source.url.trim(),
            objectKey: source.objectKey.trim(),
          },
        ]),
    ).values(),
  );
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "playlist";
}

function normalizePlaylistTitles(playlistTitles: string[] | null | undefined) {
  return Array.from(
    new Set(
      (playlistTitles ?? [])
        .map((playlistTitle) => playlistTitle.trim())
        .filter(Boolean),
    ),
  );
}

function pruneUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}

type PersistedVideoFields = Omit<Doc<"videos">, "_id" | "_creationTime">;

function toPersistedVideoFields(video: Doc<"videos">): PersistedVideoFields {
  return {
    title: video.title,
    sourceFileName: video.sourceFileName,
    sourceFingerprint: video.sourceFingerprint,
    requestedDelivery: video.requestedDelivery,
    deliveryType: video.deliveryType,
    contentType: video.contentType,
    archiveObjectKey: video.archiveObjectKey,
    distributionObjectKey: video.distributionObjectKey,
    masterPlaylistUrl: video.masterPlaylistUrl,
    manifestUrl: video.manifestUrl,
    playbackUrl: video.playbackUrl,
    posterUrl: video.posterUrl,
    sources: video.sources,
    encoder: video.encoder,
    durationSeconds: video.durationSeconds,
    sourceFileSizeBytes: video.sourceFileSizeBytes,
    sourceFrameRate: video.sourceFrameRate,
    sourceWidth: video.sourceWidth,
    sourceHeight: video.sourceHeight,
    createdAt: video.createdAt,
    updatedAt: video.updatedAt,
    status: video.status,
    tags: video.tags,
    description: video.description,
    series: video.series,
    recordedAt: video.recordedAt,
    errorMessage: video.errorMessage,
  };
}

async function ensureUniquePlaylistSlug(ctx: MutationCtx, title: string) {
  const baseSlug = slugify(title);
  let nextSlug = baseSlug;
  let suffix = 2;

  while (
    await ctx.db
      .query("playlists")
      .withIndex("by_slug", (q) => q.eq("slug", nextSlug))
      .unique()
  ) {
    nextSlug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return nextSlug;
}

async function ensurePlaylistMemberships(
  ctx: MutationCtx,
  videoId: Doc<"videos">["_id"],
  playlistTitles: string[],
) {
  const normalizedTitles = normalizePlaylistTitles(playlistTitles);

  for (const playlistTitle of normalizedTitles) {
    const playlistSlug = slugify(playlistTitle);
    let playlist = await ctx.db
      .query("playlists")
      .withIndex("by_slug", (q) => q.eq("slug", playlistSlug))
      .unique();

    if (!playlist) {
      const timestamp = nowIso();
      const playlistId = await ctx.db.insert("playlists", {
        title: playlistTitle,
        slug: await ensureUniquePlaylistSlug(ctx, playlistTitle),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      playlist = await ctx.db.get(playlistId);
    }

    if (!playlist) {
      continue;
    }

    const existingMembership = await ctx.db
      .query("playlistItems")
      .withIndex("by_playlistId_and_videoId", (q) =>
        q.eq("playlistId", playlist._id).eq("videoId", videoId),
      )
      .unique();

    if (existingMembership) {
      continue;
    }

    const lastEntry = await ctx.db
      .query("playlistItems")
      .withIndex("by_playlistId_and_position", (q) =>
        q.eq("playlistId", playlist._id),
      )
      .order("desc")
      .take(1);

    await ctx.db.insert("playlistItems", {
      playlistId: playlist._id,
      videoId,
      position: (lastEntry[0]?.position ?? -1) + 1,
      addedAt: nowIso(),
    });

    await ctx.db.patch(playlist._id, {
      updatedAt: nowIso(),
    });
  }
}

export const createVodEntry = mutation({
  args: {
    title: v.string(),
    sourceFileName: v.string(),
    sourceFingerprint: v.optional(v.string()),
    requestedDelivery: v.optional(requestedDeliveryValidator),
    deliveryType: v.optional(deliveryTypeValidator),
    contentType: v.optional(contentTypeValidator),
    archiveObjectKey: v.string(),
    distributionObjectKey: v.string(),
    masterPlaylistUrl: v.optional(v.string()),
    manifestUrl: v.optional(v.string()),
    playbackUrl: v.string(),
    posterUrl: v.optional(v.string()),
    sources: v.optional(v.array(storedVideoSourceValidator)),
    encoder: effectiveHardwareEncoderValidator,
    durationSeconds: v.number(),
    sourceFileSizeBytes: v.optional(v.number()),
    sourceFrameRate: v.optional(v.number()),
    sourceWidth: v.optional(v.number()),
    sourceHeight: v.optional(v.number()),
    createdAt: v.string(),
    status: videoStatusValidator,
    tags: v.optional(v.array(v.string())),
    playlistTitles: v.optional(v.array(v.string())),
    description: v.optional(v.string()),
    series: v.optional(v.string()),
    recordedAt: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const normalizedCreatedAt = trimOptional(args.createdAt) ?? nowIso();
    const normalizedTitle = trimOptional(args.title) ?? args.sourceFileName;
    const baseRecord = pruneUndefined<PersistedVideoFields>({
      title: normalizedTitle,
      sourceFileName: args.sourceFileName,
      sourceFingerprint: trimOptional(args.sourceFingerprint),
      requestedDelivery: args.requestedDelivery,
      deliveryType: args.deliveryType,
      contentType: args.contentType,
      archiveObjectKey: args.archiveObjectKey,
      distributionObjectKey: args.distributionObjectKey,
      masterPlaylistUrl: trimOptional(args.masterPlaylistUrl),
      manifestUrl: trimOptional(args.manifestUrl),
      playbackUrl: args.playbackUrl,
      posterUrl: trimOptional(args.posterUrl),
      sources: normalizeSources(args.sources),
      encoder: args.encoder,
      durationSeconds: args.durationSeconds,
      sourceFileSizeBytes: args.sourceFileSizeBytes,
      sourceFrameRate: args.sourceFrameRate,
      sourceWidth: args.sourceWidth,
      sourceHeight: args.sourceHeight,
      createdAt: normalizedCreatedAt,
      updatedAt: nowIso(),
      status: args.status,
      tags: normalizeTags(args.tags),
      description: trimOptional(args.description),
      series: trimOptional(args.series),
      recordedAt: trimOptional(args.recordedAt),
      errorMessage: trimOptional(args.errorMessage),
    });

    const existing = await ctx.db
      .query("videos")
      .withIndex("by_distributionObjectKey", (q) =>
        q.eq("distributionObjectKey", args.distributionObjectKey),
      )
      .unique();

    if (existing) {
      const current = toPersistedVideoFields(existing);
      const replacement = pruneUndefined<PersistedVideoFields>({
        ...current,
        ...baseRecord,
        createdAt: current.createdAt,
        updatedAt: nowIso(),
      });
      await ctx.db.replace(existing._id, replacement as PersistedVideoFields);
      await ensurePlaylistMemberships(
        ctx,
        existing._id,
        args.playlistTitles ?? [],
      );
      return existing._id;
    }

    const videoId = await ctx.db.insert("videos", baseRecord as PersistedVideoFields);
    await ensurePlaylistMemberships(ctx, videoId, args.playlistTitles ?? []);
    return videoId;
  },
});

export const updateVideoMetadata = mutation({
  args: {
    videoId: v.id("videos"),
    status: v.optional(videoStatusValidator),
    tags: v.optional(v.union(v.array(v.string()), v.null())),
    playlistTitles: v.optional(v.union(v.array(v.string()), v.null())),
    description: v.optional(v.union(v.string(), v.null())),
    series: v.optional(v.union(v.string(), v.null())),
    recordedAt: v.optional(v.union(v.string(), v.null())),
    posterUrl: v.optional(v.union(v.string(), v.null())),
    errorMessage: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const video = await ctx.db.get(args.videoId);
    if (!video) {
      throw new Error("Video not found.");
    }

    const current = toPersistedVideoFields(video);
    const replacement = pruneUndefined<PersistedVideoFields>({
      ...current,
      updatedAt: nowIso(),
      status: args.status ?? current.status,
      tags:
        args.tags === undefined ? current.tags : normalizeTags(args.tags),
      posterUrl:
        args.posterUrl === undefined
          ? current.posterUrl
          : trimOptional(args.posterUrl ?? undefined),
      description:
        args.description === undefined
          ? current.description
          : trimOptional(args.description ?? undefined),
      series:
        args.series === undefined
          ? current.series
          : trimOptional(args.series ?? undefined),
      recordedAt:
        args.recordedAt === undefined
          ? current.recordedAt
          : trimOptional(args.recordedAt ?? undefined),
      errorMessage:
        args.errorMessage === undefined
          ? current.errorMessage
          : trimOptional(args.errorMessage ?? undefined),
    });

    await ctx.db.replace(video._id, replacement as PersistedVideoFields);
    await ensurePlaylistMemberships(
      ctx,
      video._id,
      args.playlistTitles === undefined ? [] : args.playlistTitles ?? [],
    );
    return video._id;
  },
});

export const listVideos = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("videos")
      .withIndex("by_createdAt")
      .order("desc")
      .take(100);
  },
});

export const paginateVideos = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("videos")
      .withIndex("by_createdAt")
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const getVideosBySourceFingerprint = query({
  args: {
    sourceFingerprint: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("videos")
      .withIndex("by_sourceFingerprint_and_createdAt", (q) =>
        q.eq("sourceFingerprint", args.sourceFingerprint),
      )
      .order("desc")
      .take(10);
  },
});

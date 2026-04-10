import { defineSchema, defineTable } from "convex/server";
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

const videoStatusValidator = v.union(
  v.literal("processing"),
  v.literal("uploading"),
  v.literal("draft"),
  v.literal("ready"),
  v.literal("error"),
  v.literal("archived"),
);

export default defineSchema({
  videos: defineTable({
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
    sources: v.optional(v.array(v.object({
      codec: videoSourceCodecValidator,
      mimeType: v.string(),
      url: v.string(),
      objectKey: v.string(),
    }))),
    encoder: effectiveHardwareEncoderValidator,
    durationSeconds: v.number(),
    sourceFileSizeBytes: v.optional(v.number()),
    sourceFrameRate: v.optional(v.number()),
    sourceWidth: v.optional(v.number()),
    sourceHeight: v.optional(v.number()),
    createdAt: v.string(),
    updatedAt: v.string(),
    status: videoStatusValidator,
    tags: v.array(v.string()),
    description: v.optional(v.string()),
    series: v.optional(v.string()),
    recordedAt: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_status_and_createdAt", ["status", "createdAt"])
    .index("by_sourceFileName", ["sourceFileName"])
    .index("by_sourceFingerprint_and_createdAt", ["sourceFingerprint", "createdAt"])
    .index("by_distributionObjectKey", ["distributionObjectKey"]),

  playlists: defineTable({
    title: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_slug", ["slug"])
    .index("by_updatedAt", ["updatedAt"]),

  playlistItems: defineTable({
    playlistId: v.id("playlists"),
    videoId: v.id("videos"),
    position: v.number(),
    addedAt: v.string(),
  })
    .index("by_playlistId_and_position", ["playlistId", "position"])
    .index("by_playlistId_and_videoId", ["playlistId", "videoId"])
    .index("by_videoId", ["videoId"]),
});

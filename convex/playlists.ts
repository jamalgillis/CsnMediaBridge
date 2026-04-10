import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";

function nowIso() {
  return new Date().toISOString();
}

function trimOptional(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "playlist";
}

function pruneUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}

type PersistedPlaylistFields = Omit<Doc<"playlists">, "_id" | "_creationTime">;

async function makeUniqueSlug(
  ctx: Parameters<typeof createPlaylist["handler"]>[0],
  title: string,
) {
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

export const createPlaylist = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const title = trimOptional(args.title);
    if (!title) {
      throw new Error("Playlist title is required.");
    }

    const timestamp = nowIso();
    const playlist = pruneUndefined<PersistedPlaylistFields>({
      title,
      slug: await makeUniqueSlug(ctx, title),
      description: trimOptional(args.description),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    return await ctx.db.insert("playlists", playlist as PersistedPlaylistFields);
  },
});

export const addVideoToPlaylist = mutation({
  args: {
    playlistId: v.id("playlists"),
    videoId: v.id("videos"),
    position: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const playlist = await ctx.db.get(args.playlistId);
    if (!playlist) {
      throw new Error("Playlist not found.");
    }

    const video = await ctx.db.get(args.videoId);
    if (!video) {
      throw new Error("Video not found.");
    }

    const existing = await ctx.db
      .query("playlistItems")
      .withIndex("by_playlistId_and_videoId", (q) =>
        q.eq("playlistId", args.playlistId).eq("videoId", args.videoId),
      )
      .unique();

    if (existing) {
      return existing._id;
    }

    const lastEntry = await ctx.db
      .query("playlistItems")
      .withIndex("by_playlistId_and_position", (q) =>
        q.eq("playlistId", args.playlistId),
      )
      .order("desc")
      .take(1);

    const nextPosition =
      args.position !== undefined
        ? Math.max(0, Math.floor(args.position))
        : (lastEntry[0]?.position ?? -1) + 1;

    const itemId = await ctx.db.insert("playlistItems", {
      playlistId: args.playlistId,
      videoId: args.videoId,
      position: nextPosition,
      addedAt: nowIso(),
    });

    await ctx.db.patch(args.playlistId, {
      updatedAt: nowIso(),
    });

    return itemId;
  },
});

export const listPlaylists = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("playlists")
      .withIndex("by_updatedAt")
      .order("desc")
      .take(100);
  },
});

export const getPlaylistBySlug = query({
  args: {
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    const playlist = await ctx.db
      .query("playlists")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();

    if (!playlist) {
      return null;
    }

    const items = await ctx.db
      .query("playlistItems")
      .withIndex("by_playlistId_and_position", (q) =>
        q.eq("playlistId", playlist._id),
      )
      .order("asc")
      .take(250);

    const videos = await Promise.all(
      items.map(async (item) => {
        const video = await ctx.db.get(item.videoId);
        return video ? { item, video } : null;
      }),
    );

    return {
      playlist,
      items: videos.filter(
        (entry): entry is { item: Doc<"playlistItems">; video: Doc<"videos"> } =>
          entry !== null,
      ),
    };
  },
});

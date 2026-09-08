#!/usr/bin/env node
/**
 * Imports the library from the standalone Media Bridge Convex deployment into
 * the merged CSN sports deployment.
 *
 * Reads through the old deployment's existing public queries — it is left
 * running and untouched, so this can be repeated and the old data stays intact
 * as a fallback until you are satisfied.
 *
 * Safe to re-run. Every row is written with the `_id` it had on the old
 * deployment in `legacyId`, and the import mutations skip anything already
 * present, so a partial run resumes cleanly rather than duplicating.
 *
 * Two ways to read the source:
 *
 *   --from-export <path>   A `npx convex export` zip or its extracted folder.
 *                          Required when the old deployment still holds data but
 *                          no longer serves the functions this script would
 *                          otherwise query — which is the normal case for a
 *                          deployment that has been superseded.
 *
 *   (default)              Live queries against OLD_CONVEX_URL. Only works while
 *                          the old deployment still serves `videos:paginateVideos`
 *                          and friends.
 *
 * Usage:
 *
 *   cd <old repo> && npx convex export --path /tmp/old.zip
 *
 *   NEW_CONVEX_URL=https://sports-deployment.convex.cloud \
 *   MEDIA_BRIDGE_NODE_TOKEN=… \
 *   node scripts/migrate-to-sports-deployment.mjs --from-export /tmp/old.zip [--dry-run]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";

const OLD_CONVEX_URL = process.env.OLD_CONVEX_URL;
const NEW_CONVEX_URL = process.env.NEW_CONVEX_URL;
const NODE_TOKEN = process.env.MEDIA_BRIDGE_NODE_TOKEN;
const DRY_RUN = process.argv.includes("--dry-run");

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : null;
}

const FROM_EXPORT = readFlag("--from-export");

/** Small enough to stay well inside a single Convex transaction's limits. */
const BATCH_SIZE = 40;

/**
 * Fields carried across beyond the required ones. An allowlist rather than a
 * spread: the schema rejects unknown fields, and a stray key from an old
 * document would fail the insert partway through a batch. Anything not listed
 * here is intentionally dropped.
 *
 * `sourceVideoId` is deliberately absent — it points at an id that does not
 * exist on the new deployment, and is rebuilt by the relink pass.
 */
const VIDEO_OPTIONAL_FIELDS = [
  "sourceFingerprint",
  "requestedDelivery",
  "deliveryType",
  "contentType",
  "masterPlaylistUrl",
  "manifestUrl",
  "posterUrl",
  "sources",
  "sourceFileSizeBytes",
  "sourceFrameRate",
  "sourceWidth",
  "sourceHeight",
  "sourceVideoCodec",
  "sourceAudioCodec",
  "description",
  "series",
  "recordedAt",
  "projectName",
  "eventName",
  "cameraId",
  "sourceNode",
  "reviewStatus",
  "socialStatus",
  "scheduledPublishAt",
  "errorMessage",
  "clipAspectRatio",
  "clipInSeconds",
  "clipOutSeconds",
];

const SOCIAL_POST_FIELDS = [
  "platforms",
  "format",
  "mediaType",
  "scheduledDate",
  "scheduledTime",
  "status",
  "caption",
  "ytVisibility",
  "ytTitle",
  "ytDesc",
];

function pick(source, fields) {
  const result = {};
  for (const field of fields) {
    if (source[field] !== undefined && source[field] !== null) {
      result[field] = source[field];
    }
  }
  return result;
}

function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function requireEnv() {
  // Reading from an export needs no access to the old deployment at all.
  const required = FROM_EXPORT
    ? [
        ["NEW_CONVEX_URL", NEW_CONVEX_URL],
        ["MEDIA_BRIDGE_NODE_TOKEN", NODE_TOKEN],
      ]
    : [
        ["OLD_CONVEX_URL", OLD_CONVEX_URL],
        ["NEW_CONVEX_URL", NEW_CONVEX_URL],
        ["MEDIA_BRIDGE_NODE_TOKEN", NODE_TOKEN],
      ];

  const missing = required.filter(([, value]) => !value?.trim());

  if (missing.length > 0) {
    console.error(`Missing required environment: ${missing.map(([name]) => name).join(", ")}`);
    process.exit(1);
  }

  if (!FROM_EXPORT && OLD_CONVEX_URL.trim() === NEW_CONVEX_URL.trim()) {
    console.error("OLD_CONVEX_URL and NEW_CONVEX_URL are the same deployment. Refusing to run.");
    process.exit(1);
  }
}

/**
 * Reads a table out of a Convex snapshot export.
 *
 * The export lays each table out as `<table>/documents.jsonl`, one JSON
 * document per line, carrying `_id` and every field — the same shape a query
 * returns, so nothing downstream needs to know where the rows came from.
 */
function readExportTable(exportRoot, table) {
  const file = path.join(exportRoot, table, "documents.jsonl");
  if (!existsSync(file)) {
    return [];
  }

  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Accepts either the zip `convex export` produces or an already-extracted folder. */
function resolveExportRoot(target) {
  if (!existsSync(target)) {
    console.error(`No export found at ${target}`);
    process.exit(1);
  }

  if (statSync(target).isDirectory()) {
    return target;
  }

  const extractedTo = mkdtempSync(path.join(tmpdir(), "csn-migrate-export-"));
  execFileSync("unzip", ["-q", "-o", target, "-d", extractedTo]);
  return extractedTo;
}

async function readAllVideos(oldClient) {
  const videos = [];
  let cursor = null;
  let isDone = false;

  while (!isDone) {
    const page = await oldClient.query("videos:paginateVideos", {
      paginationOpts: { cursor, numItems: 100 },
    });
    videos.push(...page.page);
    cursor = page.continueCursor;
    isDone = page.isDone;
  }

  return videos;
}

async function main() {
  requireEnv();

  const newClient = new ConvexHttpClient(NEW_CONVEX_URL);

  const call = async (name, args) => {
    if (DRY_RUN) return { dryRun: true };
    return await newClient.mutation(name, { ...args, nodeToken: NODE_TOKEN });
  };

  let videos = [];
  let playlists = [];
  let playlistItems = [];
  let socialPosts = [];

  if (FROM_EXPORT) {
    const exportRoot = resolveExportRoot(FROM_EXPORT);
    console.log(`Reading snapshot export at ${FROM_EXPORT}`);

    videos = readExportTable(exportRoot, "videos");
    playlists = readExportTable(exportRoot, "playlists");
    socialPosts = readExportTable(exportRoot, "socialPosts");

    // An export gives the join table directly, which is simpler and more
    // faithful than reassembling membership from a per-playlist query.
    playlistItems = readExportTable(exportRoot, "playlistItems").map((item) => ({
      legacyPlaylistId: item.playlistId,
      legacyVideoId: item.videoId,
      position: item.position ?? 0,
      addedAt: item.addedAt ?? new Date(item._creationTime ?? Date.now()).toISOString(),
    }));
  } else {
    const oldClient = new ConvexHttpClient(OLD_CONVEX_URL);
    console.log(`Reading from ${OLD_CONVEX_URL}`);

    videos = await readAllVideos(oldClient);
    playlists = await oldClient.query("playlists:listPlaylists", {});

    // Membership is only reachable through the per-playlist query when reading
    // live, so it is gathered one playlist at a time.
    for (const playlist of playlists) {
      const detail = await oldClient.query("playlists:getPlaylistBySlug", { slug: playlist.slug });
      for (const entry of detail?.items ?? []) {
        playlistItems.push({
          legacyPlaylistId: playlist._id,
          legacyVideoId: entry.video?._id ?? entry.item?.videoId,
          position: entry.item?.position ?? 0,
          addedAt: entry.item?.addedAt ?? playlist.createdAt,
        });
      }
    }

    try {
      socialPosts = await oldClient.query("socialPosts:listSocialPosts", {});
    } catch (error) {
      console.warn(`Could not read social posts (continuing): ${error.message}`);
    }
  }

  console.log(
    `Found ${videos.length} videos, ${playlists.length} playlists, ` +
      `${playlistItems.length} playlist items, ${socialPosts.length} social posts.`,
  );

  if (DRY_RUN) {
    console.log("\n--dry-run: nothing was written. Sample of the first video payload:");
    const sample = videos[0];
    if (sample) {
      console.log(
        JSON.stringify(
          {
            legacyId: sample._id,
            title: sample.title,
            status: sample.status,
            archiveObjectKey: sample.archiveObjectKey,
            carriedFields: Object.keys(pick(sample, VIDEO_OPTIONAL_FIELDS)),
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  // 1. Videos, without parent links.
  let importedVideos = 0;
  let skippedVideos = 0;
  for (const batch of chunk(videos, BATCH_SIZE)) {
    const payload = batch.map((video) => ({
      legacyId: video._id,
      title: video.title,
      sourceFileName: video.sourceFileName,
      archiveObjectKey: video.archiveObjectKey,
      distributionObjectKey: video.distributionObjectKey,
      playbackUrl: video.playbackUrl,
      encoder: video.encoder,
      durationSeconds: video.durationSeconds,
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
      status: video.status,
      tags: Array.isArray(video.tags) ? video.tags : [],
      rest: pick(video, VIDEO_OPTIONAL_FIELDS),
    }));

    const result = await call("media/migrate:importVideos", { videos: payload });
    importedVideos += result.imported;
    skippedVideos += result.skipped;
    process.stdout.write(`\r  videos: ${importedVideos} imported, ${skippedVideos} skipped`);
  }
  console.log("");

  // 2. Clip parent links, now that every video has an id here.
  const clipLinks = videos
    .filter((video) => video.sourceVideoId)
    .map((video) => ({ legacyId: video._id, legacyParentId: video.sourceVideoId }));

  if (clipLinks.length > 0) {
    let linked = 0;
    let unresolved = 0;
    for (const batch of chunk(clipLinks, BATCH_SIZE)) {
      const result = await call("media/migrate:relinkClips", { links: batch });
      linked += result.linked;
      unresolved += result.unresolved;
    }
    console.log(`  clips relinked: ${linked}${unresolved ? `, ${unresolved} unresolved` : ""}`);
  }

  // 3. Playlists, then membership.
  if (playlists.length > 0) {
    let imported = 0;
    let skipped = 0;
    for (const batch of chunk(playlists, BATCH_SIZE)) {
      const payload = batch.map((playlist) => ({
        legacyId: playlist._id,
        title: playlist.title,
        slug: playlist.slug,
        ...(playlist.description ? { description: playlist.description } : {}),
        createdAt: playlist.createdAt,
        updatedAt: playlist.updatedAt,
      }));
      const result = await call("media/migrate:importPlaylists", { playlists: payload });
      imported += result.imported;
      skipped += result.skipped;
    }
    console.log(`  playlists: ${imported} imported, ${skipped} skipped`);
  }

  const resolvableItems = playlistItems.filter((item) => item.legacyVideoId);
  if (resolvableItems.length > 0) {
    let imported = 0;
    let skipped = 0;
    let unresolved = 0;
    for (const batch of chunk(resolvableItems, BATCH_SIZE)) {
      const result = await call("media/migrate:importPlaylistItems", { items: batch });
      imported += result.imported;
      skipped += result.skipped;
      unresolved += result.unresolved;
    }
    console.log(
      `  playlist items: ${imported} imported, ${skipped} skipped` +
        `${unresolved ? `, ${unresolved} unresolved` : ""}`,
    );
  }

  // 4. Social posts.
  if (socialPosts.length > 0) {
    let imported = 0;
    let skipped = 0;
    let unresolved = 0;
    for (const batch of chunk(socialPosts, BATCH_SIZE)) {
      const payload = batch.map((post) => ({
        legacyId: post._id,
        legacyVideoId: post.videoId,
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
        rest: pick(post, SOCIAL_POST_FIELDS),
      }));
      const result = await call("media/migrate:importSocialPosts", { posts: payload });
      imported += result.imported;
      skipped += result.skipped;
      unresolved += result.unresolved;
    }
    console.log(
      `  social posts: ${imported} imported, ${skipped} skipped` +
        `${unresolved ? `, ${unresolved} unresolved` : ""}`,
    );
  }

  const status = await call("media/migrate:migrationStatus", {});
  console.log("\nDestination now holds:");
  console.log(JSON.stringify(status, null, 2));
  console.log(
    "\nThe old deployment was not modified. Verify the library in the Asset Manager " +
      "before decommissioning it.",
  );
}

main().catch((error) => {
  console.error(`\nMigration failed: ${error.message}`);
  console.error("Re-running is safe — imported rows are skipped on the next pass.");
  process.exit(1);
});

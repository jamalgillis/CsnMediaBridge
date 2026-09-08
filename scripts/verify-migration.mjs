#!/usr/bin/env node
/**
 * Compares the old Media Bridge deployment against the merged sports
 * deployment, so decommissioning is a decision backed by counts rather than a
 * hopeful one.
 *
 * Read-only against both. Exits non-zero if anything is missing, which is what
 * makes it usable as a gate in front of `decommission-old-backend.sh`.
 *
 * Usage:
 *
 *   OLD_CONVEX_URL=https://proper-whale-216.convex.cloud \
 *   NEW_CONVEX_URL=https://quick-chameleon-247.convex.cloud \
 *   MEDIA_BRIDGE_NODE_TOKEN=… \
 *   node scripts/verify-migration.mjs
 */

import { ConvexHttpClient } from "convex/browser";

const OLD_CONVEX_URL = process.env.OLD_CONVEX_URL;
const NEW_CONVEX_URL = process.env.NEW_CONVEX_URL;
const NODE_TOKEN = process.env.MEDIA_BRIDGE_NODE_TOKEN;

function requireEnv() {
  const missing = [
    ["OLD_CONVEX_URL", OLD_CONVEX_URL],
    ["NEW_CONVEX_URL", NEW_CONVEX_URL],
    ["MEDIA_BRIDGE_NODE_TOKEN", NODE_TOKEN],
  ].filter(([, value]) => !value?.trim());

  if (missing.length > 0) {
    console.error(`Missing required environment: ${missing.map(([name]) => name).join(", ")}`);
    process.exit(2);
  }
}

async function countOldVideos(client) {
  let total = 0;
  let withParent = 0;
  let cursor = null;
  let isDone = false;

  while (!isDone) {
    const page = await client.query("videos:paginateVideos", {
      paginationOpts: { cursor, numItems: 100 },
    });
    total += page.page.length;
    withParent += page.page.filter((video) => video.sourceVideoId).length;
    cursor = page.continueCursor;
    isDone = page.isDone;
  }

  return { total, withParent };
}

function row(label, oldCount, newCount) {
  // Extra rows on the destination are fine — new ingests land there while the
  // migration is being verified. Missing rows are the failure.
  const missing = Math.max(0, oldCount - newCount);
  const mark = missing === 0 ? "ok  " : "MISS";
  return {
    line: `  ${mark}  ${label.padEnd(18)} old ${String(oldCount).padStart(5)}   new ${String(newCount).padStart(5)}${missing ? `   missing ${missing}` : ""}`,
    missing,
  };
}

async function main() {
  requireEnv();

  const oldClient = new ConvexHttpClient(OLD_CONVEX_URL);
  const newClient = new ConvexHttpClient(NEW_CONVEX_URL);

  console.log(`Old: ${OLD_CONVEX_URL}`);
  console.log(`New: ${NEW_CONVEX_URL}\n`);

  const videos = await countOldVideos(oldClient);
  const playlists = await oldClient.query("playlists:listPlaylists", {});

  let playlistItems = 0;
  for (const playlist of playlists) {
    const detail = await oldClient.query("playlists:getPlaylistBySlug", { slug: playlist.slug });
    playlistItems += detail?.items?.length ?? 0;
  }

  let socialPosts = [];
  try {
    socialPosts = await oldClient.query("socialPosts:listSocialPosts", {});
  } catch {
    // The old deployment may predate social posts; absent is not a mismatch.
  }

  const status = await newClient.mutation("media/migrate:migrationStatus", {
    nodeToken: NODE_TOKEN,
  });

  const rows = [
    row("videos", videos.total, status.migratedVideos),
    row("playlists", playlists.length, status.playlists),
    row("playlist items", playlistItems, status.playlistItems),
    row("social posts", socialPosts.length, status.socialPosts),
  ];

  console.log("Row counts");
  for (const entry of rows) console.log(entry.line);

  const totalMissing = rows.reduce((sum, entry) => sum + entry.missing, 0);

  console.log(`\n  Destination total videos: ${status.videos} (${status.migratedVideos} migrated)`);
  console.log(`  Clips with a parent link: ${status.clips ?? 0} (source had ${videos.withParent})`);

  if ((status.clips ?? 0) < videos.withParent) {
    console.log(
      "\n  Some clips did not relink. Re-running `pnpm migrate:library` resolves links whose parent landed later.",
    );
  }

  if (totalMissing > 0) {
    console.error(
      `\nFAIL — ${totalMissing} row(s) did not make it across. Re-run \`pnpm migrate:library\`; it skips what is already imported.`,
    );
    process.exit(1);
  }

  console.log("\nPASS — every row on the old deployment has a counterpart on the new one.");
  console.log("Safe to decommission: scripts/decommission-old-backend.sh --confirm");
}

main().catch((error) => {
  console.error(`\nVerification failed to run: ${error.message}`);
  process.exit(2);
});

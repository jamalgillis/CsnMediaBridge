#!/usr/bin/env node
/**
 * Proves the desktop app's Convex credentials actually work.
 *
 * The app stores its node token encrypted, so a configured token cannot be
 * distinguished from a valid one by reading settings. This calls the same
 * deployment with the same credential the app would use and reports what the
 * server says.
 *
 * Read-only. Every call is a query.
 *
 * Usage:
 *
 *   NEW_CONVEX_URL=https://<deployment>.convex.cloud \
 *   MEDIA_BRIDGE_NODE_TOKEN=… \
 *   node scripts/check-connection.mjs
 */

import { ConvexHttpClient } from "convex/browser";

const URL_ = process.env.NEW_CONVEX_URL ?? process.env.CONVEX_URL;
const TOKEN = process.env.MEDIA_BRIDGE_NODE_TOKEN;

if (!URL_?.trim()) {
  console.error("Set NEW_CONVEX_URL to the deployment the desktop app points at.");
  process.exit(2);
}
if (!TOKEN?.trim()) {
  console.error("Set MEDIA_BRIDGE_NODE_TOKEN to the same token saved in the app's settings.");
  process.exit(2);
}

const client = new ConvexHttpClient(URL_);
console.log(`Deployment: ${URL_}\n`);

let failed = false;

/** Distinguishes "wrong deployment" from "bad credential" from "working". */
async function check(label, run) {
  try {
    const result = await run();
    console.log(`  ok    ${label}`);
    return result;
  } catch (error) {
    const message = String(error.message ?? error);
    failed = true;

    if (message.includes("Could not find public function")) {
      console.log(`  FAIL  ${label}`);
      console.log("        The media functions are not on this deployment — wrong URL.");
    } else if (message.includes("node token") || message.includes("admin session")) {
      console.log(`  FAIL  ${label}`);
      console.log("        The deployment rejected the token. Check it matches");
      console.log("        MEDIA_BRIDGE_NODE_TOKENS on this deployment exactly.");
    } else {
      console.log(`  FAIL  ${label}`);
      console.log(`        ${message.split("\n").filter(Boolean)[0]?.slice(0, 120)}`);
    }
    return null;
  }
}

// The public surface: proves the URL serves the media code at all, no token needed.
await check("media functions reachable", () =>
  client.query("media/catalog:listPublished", { limit: 1 }),
);

// A node-gated read: proves the token is accepted.
const videos = await check("node token accepted", () =>
  client.query("media/videos:listVideos", { nodeToken: TOKEN }),
);

if (Array.isArray(videos)) {
  console.log(`\n  Library visible to this node: ${videos.length} video(s)`);
  for (const video of videos.slice(0, 5)) {
    console.log(`    · ${video.title}  [${video.status}]`);
  }
  if (videos.length > 5) console.log(`    … and ${videos.length - 5} more`);
}

if (failed) {
  console.error("\nThe desktop app would fail with these settings.");
  process.exit(1);
}

console.log("\nPASS — URL and token are both good. The app can register ingests.");

# Storage Layout Contract

The authoritative directory structure for Backblaze B2 and Cloudflare R2, the
lifecycle rules that enforce cost, and how Convex maps between them.

This is a contract. Both CSN Media Bridge (desktop) and the Asset Manager (web) must produce
and parse keys exactly as specified here, because lifecycle rules are applied by
**prefix** — an object written to the wrong prefix is either billed forever or
deleted out from under a scheduled post.

Companion documents: `MEDIA_PIPELINE_ARCHITECTURE.md`, `HYBRID_ORCHESTRATION.md`,
`OPERATOR_SETUP_TASKS.md`.

Last reviewed: September 7, 2026

## 1. The Asset Key

Every derivative of a given source shares one stable identifier called the
**asset key**.

```
assetKey = first 16 hex characters of the source file's SHA-256 fingerprint
```

The pipeline already computes `sha256:<64 hex>` for every ingest to do duplicate
detection (`src/main/lib/sourceFingerprint.ts`), so this costs nothing extra.

### Why not the Convex document id

The original design sketch used `{convexVideoId}` in R2 keys. That cannot work
in the current ingest order: the desktop uploads to storage *first* and creates
the Convex record *after*, using the resulting public URLs. Keying on the Convex
id would require reserving a draft document before upload and patching it later,
which adds a failure mode (orphaned draft rows when an ingest dies mid-upload)
for no benefit.

The fingerprint is strictly better here:

- **Deterministic.** The same source always resolves to the same prefix, so a
  retried or resumed upload writes to the same place instead of orphaning a
  half-finished folder under a new random id.
- **Dedupe-aligned.** It is the same value duplicate detection already keys on.
- **Available early.** It is known before the first byte is uploaded.
- **Stable across re-registration.** Re-creating a Convex record does not strand
  the storage objects.

Convex remains the index. `videos.archiveObjectKey` and
`videos.distributionObjectKey` still store full keys, so nothing needs to
recompute a fingerprint to find an object.

## 2. Backblaze B2 — The Cold Vault

Permanent, never lifecycle-expired, never served directly to viewers at scale.

```text
b2://{bucket}/
│
├── masters/                                   Raw high-bitrate camera files
│   └── {projectSlug}/
│       └── {recordedDate}/                    YYYY-MM-DD
│           └── {assetKey}/
│               ├── {originalFileName}         e.g. A001_C012_0907XY.mov
│               └── sidecar.bridge.json        Ingest metadata backup
│
├── offloads/                                  Post-shoot card handoffs
│   └── {date}/                                YYYY-MM-DD
│       └── {cardPackageName}/
│           ├── offload-manifest.json          Copy audit log
│           └── raw_files/…                    Untranscoded card dump
│
└── stills/                                    Image assets
    └── {projectSlug}/
        └── {date}/
            └── {name}.webp
```

Key pattern: `masters/{projectSlug}/{recordedDate}/{assetKey}/{originalFileName}`

Rules:

- `projectSlug` is the slugified `projectName`, or `unassigned` when the ingest
  carries no project. `eventName` is *not* part of the path — it is metadata,
  and events move between projects.
- `recordedDate` is the sidecar `recordedAt` date when present, otherwise the
  ingest date. It is a filing aid, not a source of truth; Convex holds the exact
  timestamp.
- The `{assetKey}` folder guarantees two different files with the same name never
  overwrite each other, and that the same file re-ingested lands in the same
  place instead of duplicating.
- **No lifecycle rule may ever be configured on this bucket.** Deletion here is
  only ever an explicit, confirmed operator action.

## 3. Cloudflare R2 — The Active Launchpad

Split by lifecycle so that expiry rules can be applied by prefix.

```text
r2://{bucket}/
│
├── streaming/                                 PERSISTENT — VOD web playback
│   └── vod/
│       └── {assetKey}/
│           ├── master.m3u8                    HLS master playlist
│           ├── manifest.mpd                   DASH manifest for same chunks
│           ├── 0/ 1/ 2/ 3/                    CMAF fMP4 renditions
│           │   ├── index.m3u8                 HLS variant playlist
│           │   ├── init_0.mp4                 fMP4 init segment
│           │   └── segment_000.m4s …          Shared fMP4 media segments
│           ├── playback_h264.mp4              Progressive delivery variant
│           └── social-{renderJobId}.mp4       Persistent social cut of this asset
│
├── posters/                                   PERSISTENT — thumbnails
│   └── {assetKey}/
│       ├── default.jpg
│       └── candidate_01.jpg …                 Frame-capture alternatives
│
├── staging/                                   TEMPORARY — 3-day TTL
│   └── social/
│       └── {renderJobId}/
│           └── render.mp4
│
└── scheduled/                                 EPHEMERAL — 7-day TTL
    └── social/
        └── {socialPostId}/
            └── {renderJobId}.mp4
```

Rules:

- `streaming/` and `posters/` are persistent. They back the live player and
  article cards; expiring them breaks published pages.
- VOD streaming packages use one set of CMAF-style fragmented MP4 chunks. The
  HLS `master.m3u8` and DASH `manifest.mpd` files are tiny protocol manifests
  that point at the same media segments, so adding DASH does not change lifecycle
  policy or meaningfully change storage cost.
- `staging/social/` is keyed by **render job** because a staged render exists
  before anyone has decided where it will be posted.
- `scheduled/social/` is keyed by **social post** because that is the unit the
  publish scheduler and the post-publish cleanup operate on. The render job id
  is kept as the filename so a post carrying several platform variants does not
  collide with itself.
- A render job with `storageClass: "streaming"` is a *persistent* social cut —
  one meant to stay available rather than expire after posting. It is filed with
  the asset it was cut from, under the never-expiring streaming prefix, rather
  than in either social launchpad.
- The poster also ships inside the playback package upload, so
  `streaming/vod/{assetKey}/poster.jpg` exists alongside the canonical
  `posters/{assetKey}/default.jpg`. That duplicate is a few kilobytes and keeps
  the playback package self-contained for anyone reading the bucket directly;
  `posterUrl` in Convex always points at the `posters/` copy.
- Nothing else may be written at the bucket root. An unrecognized prefix is
  covered by no lifecycle rule and will be billed indefinitely.

## 4. Lifecycle Rules

Configured in the Cloudflare R2 dashboard, not in application code. Application
cleanup and provider lifecycle are belt and braces: the app deletes promptly on
success, and the provider rule catches everything the app missed because a
process crashed or a job was abandoned.

| # | Prefix             | Action                    | Purpose                                                                 |
| - | ------------------ | ------------------------- | ----------------------------------------------------------------------- |
| 1 | `staging/social/`  | Delete after **3 days**   | Scrubs abandoned or crashed browser/desktop renders.                    |
| 2 | `scheduled/social/`| Delete after **7 days**   | Safety net behind app cleanup; covers a post that never fired.          |
| 3 | `streaming/`       | *No expiry*               | Powers the VOD player.                                                  |
| 4 | `posters/`         | *No expiry*               | Powers article cards and thumbnails.                                    |

Rule 2 is a backstop with a deliberate consequence: a post scheduled **more than
7 days out** cannot rely on the lifecycle rule alone. Such posts are re-rendered
on demand near their publish time rather than parked in R2 — see
`EXECUTION_ROADMAP.md`, Phase 4.

Backblaze B2 gets **no lifecycle rules at all**. If B2 versioning is enabled,
configure it to keep only the most recent version so overwrites do not silently
double storage cost.

## 5. The Staging → Scheduled Promotion

This is the one transition that must not be skipped, because it is what keeps a
scheduled post from pointing at an object on a 72-hour fuse.

```
render completes
   └─> staging/social/{renderJobId}/render.mp4        [3-day fuse lit]
        │
        │  operator attaches the render to a scheduled post
        ▼
   promoteRenderToScheduled
        │  1. enqueue a storage task: COPY staging → scheduled
        │  2. desktop node (or trusted backend) performs the copy
        │  3. copy verified
        ▼
   scheduled/social/{socialPostId}/{renderJobId}.mp4  [protected]
        │  4. social_renders row patched to the new key + url
        │  5. staging object deleted
        ▼
   post fires ─> platform fetches from R2 ─> publish verified
        │
        ▼
   markSocialRenderPublished ─> DELETE scheduled object
```

Failure handling: if the copy fails, the `social_renders` row stays pointed at the
staging key with status `ready` and the promotion task is retried. The Convex
record is patched **only after the destination object is confirmed** — a
scheduled post never references a key that does not exist.

## 6. Who Performs Storage Mutations

R2 and B2 credentials live in exactly two places: the desktop node's encrypted
settings store, and (optionally) Convex environment variables for a trusted
backend action.

Copies and deletes are expressed as rows in a `storage_tasks` table rather than
executed inline. This keeps the design honest:

- A browser can *request* a copy or delete without holding credentials.
- The work is durable and retryable across a node restart.
- The desktop node — which already has rclone, credentials, and network paths to
  both providers — performs it, using the same transfer machinery as ingest.

The alternative, a Convex Node action holding S3 credentials and issuing
`CopyObject`/`DeleteObject` directly, is documented in `EXECUTION_ROADMAP.md` as
the path to take when studio desktops cannot be relied on to be awake. Both
consume the same `storage_tasks` queue, so adding it later is additive.

## 7. Convex Field Mapping

```typescript
// media_videos
{
  _id: "jd72b9a1k03p…",
  title: "Friday Night Game Highlights",
  sourceFingerprint: "sha256:a1b2c3d4…",           // assetKey = a1b2c3d4… (first 16)

  // Backblaze B2 — cold
  archiveObjectKey:      "masters/centex-sports/2026-09-07/a1b2c3d4e5f60718/A001_C012.mov",

  // Cloudflare R2 — hot
  distributionObjectKey: "streaming/vod/a1b2c3d4e5f60718",
  masterPlaylistUrl:     "https://cdn.example.com/streaming/vod/a1b2c3d4e5f60718/master.m3u8",
  dashManifestUrl:       "https://cdn.example.com/streaming/vod/a1b2c3d4e5f60718/manifest.mpd",
  posterUrl:             "https://cdn.example.com/posters/a1b2c3d4e5f60718/default.jpg",

  // The editorial record a viewer actually sees, once an operator attaches it.
  // Publication is decided there, not here — `status: "ready"` means the encode
  // finished, not that anyone approved it.
  contentId:             "n41f8c2b90x…",
}

// social_renders
{
  sourceVideoId: "jd72b9a1k03p…",
  renderJobId:   "kn81c…",
  socialPostId:  "mp42d…",
  storageClass:  "scheduled_social",
  objectKey:     "scheduled/social/mp42d…/kn81c….mp4",
  url:           "https://cdn.example.com/scheduled/social/mp42d…/kn81c….mp4",
  status:        "scheduled",
}
```

`storageClass` on both `render_jobs` and `social_renders` is the machine-readable
statement of which lifecycle prefix an object lives under. It must always agree
with the `objectKey` prefix:

| `storageClass`     | Required key prefix   |
| ------------------ | --------------------- |
| `streaming`        | `streaming/`          |
| `staging_social`   | `staging/social/`     |
| `scheduled_social` | `scheduled/social/`   |

Convex validates this agreement on write. A mismatch is a bug that would
otherwise surface days later as a missing video.

## 8. Legacy Layout And Migration

Installations that ingested before this contract used flat, settings-driven
prefixes:

```
b2://{bucket}/{b2.pathPrefix}/{slug}-{jobId8}/{originalFileName}     e.g. vod/archive/game-recap-4f2a91c0/…
r2://{bucket}/{r2.pathPrefix}/{slug}-{jobId8}/…                      e.g. vod/hls/game-recap-4f2a91c0/…
```

Migration policy is **forward-only, no data movement**:

- Existing objects stay exactly where they are. Their full keys are already
  recorded in Convex, so playback, retrieval, and re-processing keep working
  unchanged. There is nothing to break and nothing to rewrite.
- New ingests use the canonical layout.
- The desktop setting `storage.layout` selects the behavior: `canonical`
  (default for new installs) or `legacy` (pinned for installs that already have
  data, so an operator opts in deliberately rather than waking up to a bucket
  with two conventions and no note about why).
- The legacy `b2.pathPrefix` / `r2.pathPrefix` settings remain in place and are
  ignored when the layout is `canonical`.

Moving historical objects into the canonical layout is an optional cleanup, not
a prerequisite. If it is ever done, it is a bulk `storage_tasks` batch followed by
a Convex patch of the affected key fields — the same machinery promotion uses.

## 9. Where This Lives In Code

Backend files live in the CSN sports app, which owns the Convex codebase.

| Concern                                   | File                                            |
| ----------------------------------------- | ----------------------------------------------- |
| Key builders, asset key, layout plan      | bridge: `src/shared/storageLayout.ts`           |
| Backend validation mirror                 | csn: `convex/media/storageKeys.ts`              |
| Ingest key resolution                     | bridge: `BridgeController.buildStorageKeyPlan`  |
| Upload targets and poster publish         | bridge: `SyncService.buildSyncTargets` / `sync` |
| Render output key selection               | bridge: `BridgeController.buildRenderOutputObjectKey` |
| Copy/delete queue                         | csn: `convex/media/storage.ts`                  |
| Promotion and post-publish cleanup        | csn: `convex/media/orchestration.ts`            |
| Queue execution on the desktop            | bridge: `BridgeController.processStorageTask`   |
| Lifecycle sweeps                          | csn: `convex/crons.ts`                          |

The two key-building modules are intentional duplicates — Convex functions and
the Electron bundle are separate deployment units with no shared package, and
the backend must be able to reject a bad key even when a client is running an
old build. They are small and change together.

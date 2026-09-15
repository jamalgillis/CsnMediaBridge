# Execution Roadmap

The delivery plan for the hybrid media pipeline described in
`MEDIA_PIPELINE_ARCHITECTURE.md`, ordered so that each phase is independently
useful and nothing is built before the contract it depends on exists.

This roadmap covers the *pipeline* build-out. `ROADMAP.md` remains the broader
product backlog (review workflow, projects/events model, livestream operations);
the two do not conflict — this document sequences the storage and orchestration
substrate that several `ROADMAP.md` items are blocked on.

Last reviewed: September 8, 2026

## Phase Overview

| Phase | Outcome                                              | Repo    | Status      |
| ----- | ---------------------------------------------------- | ------- | ----------- |
| 0     | Architecture and storage contracts documented        | bridge  | Complete    |
| 1     | Canonical bucket layout enforced on new ingests      | bridge  | Complete    |
| 2     | Lifecycle machinery: storage tasks, promotion, sweep | bridge  | Complete    |
| 3     | Browser executor and desktop handoff                 | shared  | Backend complete, Asset Manager UI pending |
| 3.5   | Merge into the sports deployment + auth pass         | csn     | Code complete, deploy pending |
| 3.6   | Library import + Asset Manager ingest view           | both    | Code complete, deploy pending |
| 4     | Automated scheduled publishing to platform APIs      | csn     | Not started |
| 5     | Archive retrieval and presigned playback             | bridge  | Code complete, needs endpoint |
| 6     | Optional: trusted-backend storage executor           | csn     | Not started |

Phase 3.5 was inserted after the architecture review on September 8, 2026 —
see `CONVEX_DEPLOYMENT_TOPOLOGY.md`. It had to come before Phase 4: the media
functions were entirely unauthenticated, which was contained only while the
deployment URL lived on trusted workstations. Merging into a deployment whose
URL ships in a browser bundle made closing that a prerequisite, not a follow-up.

---

## Phase 0 — Contracts (Complete)

Everything downstream depends on a written, agreed key layout, because lifecycle
rules act on prefixes and a wrong prefix is either a permanent bill or a deleted
video.

**Delivered**

- `MEDIA_PIPELINE_ARCHITECTURE.md` — problem, hybrid execution model, output
  formats, lifecycle rationale, boundary rules.
- `STORAGE_LAYOUT.md` — the B2 and R2 directory contracts, the asset-key
  definition, lifecycle rules, Convex field mapping, legacy migration policy.
- `OPERATOR_SETUP_TASKS.md` — provider-dashboard work and open decisions.
- This roadmap.

---

## Phase 1 — Canonical Storage Layout (Complete)

Move from flat, settings-driven prefixes to the lifecycle-aware layout, without
disturbing objects that already exist.

**Delivered**

- `src/shared/storageLayout.ts` — the single implementation of the key contract:
  asset-key derivation, master/video/poster/staging/scheduled key builders,
  a prefix-to-storage-class validator, and legacy-key detection.
- `SyncService.buildSyncTargets` takes a layout plan instead of hardcoding
  `{pathPrefix}/{jobFolderName}`.
- `storage.layout` setting (`canonical` | `legacy`) with a migration that pins
  already-configured installs to `legacy` so no existing deployment changes
  behavior on upgrade.
- Settings UI exposing the layout choice with an inline explanation of what each
  option writes.

**Verification**: a new ingest with a project name writes
`masters/{project}/{date}/{assetKey}/{file}` in B2 and
`videos/{assetKey}/…` plus `posters/{assetKey}/…` in R2; an install
carrying pre-existing settings keeps writing legacy keys until an operator opts
in.

---

## Phase 2 — Lifecycle Machinery (Complete)

The transition that protects a scheduled post from the staging fuse, plus the
sweeps that keep the bucket clean when things go wrong.

**Delivered**

- `storage_tasks` table: a durable, retryable queue of `copy` and `delete`
  operations against a named provider, claimed under lease like render jobs.
- `convex/media/storage.ts` — enqueue, claim, complete, fail, retry, and list.
- `orchestration:promoteRenderToScheduled` — enqueues the staging→scheduled copy,
  and patches the `social_renders` row only after the destination is confirmed.
- `orchestration:markSocialRenderPublished` — records the publish and enqueues
  the delete of the protected object.
- `convex/crons.ts` — reaps expired render leases, fails storage tasks past
  `maxAttempts`, marks staging renders that outlived the 72-hour window as
  `expired`, and trims `desktop_job_events`.
- Desktop storage-task worker in `BridgeController`, using rclone through
  `SyncService.copyRemoteObject` / `deleteRemoteFile`.
- `storageClass` ↔ key-prefix agreement validated on every write.

**Verification**: attaching a staged render to a scheduled post produces a copy
task, the desktop executes it, the `social_renders` row flips to the
`scheduled/social/{postId}/` key, and the staging object is deleted — with the
Convex record never pointing at a key that does not exist.

---

## Phase 3 — Browser Executor And Handoff (Backend complete)

The browser-first default path and the offload panic button.

**Delivered (this repository)**

- `orchestration:enqueueRenderJob` accepts `executorType: "browser"`.
- `orchestration:claimBrowserRenderJob` — a browser claims its own job under the
  same lease model, so a closed tab releases the job instead of stranding it.
- `orchestration:offloadRenderJobToDesktop` — terminates browser ownership,
  flips `executorType` to `desktop`, resets progress, requeues, and records the
  handoff reason in `desktop_job_events`.
- `orchestration:registerBrowserRenderOutput` — registers a browser-produced
  object after a presigned upload, using the same `social_renders` shape as a
  desktop render so downstream code cannot tell the difference.
- The desktop claim query already filters `executorType: "desktop"`, so a desktop
  node will never steal a job the browser is actively encoding.

**Remaining (sports app admin — not this codebase)**

1. Web Worker wrapper around `ffmpeg.wasm` with progress reporting.
2. The `file.size` pre-check that routes over-threshold sources straight to
   `executorType: "desktop"`.
3. The **Offload to Desktop Worker** button: terminate the worker, then call
   `offloadRenderJobToDesktop`.
4. A trusted presigned-upload endpoint so the browser can PUT its output to
   `staging/social/{renderJobId}/render.mp4` without holding R2 credentials.
5. Live subscriptions to `render_jobs` / `desktop_job_events` for queue progress.

**Dependency**: item 4 needs the R2 token from Operator Task 1.3 and a decision
on where the presigning endpoint lives (a Convex action is the natural home).

---

## Phase 3.5 — Sports Deployment Merge And Auth Pass (Code complete, deploy pending)

The media pipeline moved into the CSN sports app's Convex deployment, and the
wide-open function surface was closed in the same change.

**Delivered (in `Websites/csn`)**

- `convex/mediaSchema.ts` — the nine media tables, renamed to the sports
  schema's snake_case convention and spread into `convex/schema.ts`.
- `content.media_video_id` links the editorial record to the media record, with
  a `by_related_game_and_status` index so a game page is an index read rather
  than a scan.
- `convex/media/` — the ported function modules, plus three new ones:
  - `auth.ts` — `requireMediaNode` (node token or CSN admin),
    `requireMediaOperator` (Clerk admin, returns the caller's `users` row), and
    read-side variants. Node tokens are compared in constant time and read from
    `MEDIA_BRIDGE_NODE_TOKENS`.
  - `catalog.ts` — the only unauthenticated surface, projecting fields
    explicitly so storage keys and pipeline internals never reach a viewer.
  - `playback.ts` — delivery resolution ported from the desktop's shared media
    helpers so the backend picks the same URL the app would.
- All 32 public media functions gated. `storage:enqueue` demoted to
  `internalMutation` — it took an arbitrary object key and operation, and the
  desktop worker executes whatever it finds, so exposed it was a remote-delete
  primitive for both buckets including B2 masters.
- `enqueueRenderJob` derives its requester from the verified identity;
  `requestedBy` is now a display label only.
- Media maintenance crons appended to the sports app's existing `crons.ts`.

**Delivered (in this repository)**

- Function paths namespaced to `media/*`.
- Node token added to Convex settings, encrypted at rest beside the B2 and R2
  secrets, and injected once in the Convex client factory so no call site can
  omit it.
- `convex/README.md` marking the old directory as migrated, with a warning
  against deploying from it.

**Verification**: `npx tsc --noEmit` in the sports app reports exactly the
15 pre-existing errors it had before the merge (`liveGameActions.ts` 12,
`mediaAssets.ts` 2, `http.ts` 1) and none in `convex/media/`. Two latent bugs
in the ported modules — a circular type annotation in `playlists.ts` and a
partial-row type in `socialPosts.ts` — surfaced under the sports app's
`strict: true` and were fixed. `pnpm run release:check` passes in this repo.

**Remaining**

1. Set `MEDIA_BRIDGE_NODE_TOKENS` and deploy from `Websites/csn`.
2. Issue a node token per workstation and enter it in Settings.
3. Delete `CsnMediaBridge/convex/` once the merge is confirmed live.

## Phase 3.6 — Library Import And The Ingest View (Code complete, deploy pending)

Existing library data moves across, and the Asset Manager gains the destination
where ingested media becomes publishable.

**Delivered — the import**

- `convex/media/migrate.ts` in the sports app: batched, node-token-gated import
  mutations for videos, clips, playlists, playlist membership, and social posts,
  plus a `migrationStatus` readout.
- `scripts/migrate-to-sports-deployment.mjs` here, with `pnpm migrate:library`.
  Reads either a `npx convex export` snapshot (`--from-export`) or the old
  deployment's live queries, and pushes batches. The old deployment is never
  written to, so it stays a fallback.
- **The export path is the one that matters in practice.** A superseded
  deployment keeps its data but stops serving the functions a live read would
  need, so querying it fails with `Could not find public function` while the
  rows sit there intact. Reading a snapshot sidesteps that entirely and needs no
  access to the old deployment.
- **Idempotent by construction.** Every row carries its old `_id` in `legacyId`
  and imports skip what is already present, so a partial run resumes cleanly
  instead of forcing a choice between duplicates and starting over.
- Document ids change on insert, so playlist membership and clip parentage are
  rebuilt against the new ids in a second pass rather than carried across.
  `--dry-run` reports what would move without writing.

**Delivered — the ingest view**

- `convex/media/manager.ts`: `listIngestedMedia`, `listIngestNodes`,
  `listAttachableContent`, `attachToContent`, `detachFromContent`, and
  `createContentFromMedia`. Staff-gated, projected for the UI the way
  `mediaAssets.listForManager` is.
- `apps/admin/app/assets/ingest-view.tsx`: encoder node health, delivered media,
  and the two promotion paths — **New entry** creates a draft catalog record
  from the media, **Attach** links it to one that already exists.
- Ingest moved from a drawn placeholder to a wired destination in the Asset
  Manager's Pipeline group.

**The rules this encodes**

- A finished encode is not a published video. `createContentFromMedia` writes a
  **draft** — ingest completing is not an editorial decision.
- Poster and runtime backfill onto a content row only when it has none, so a
  poster an editor chose is never overwritten by a frame grab.
- Detaching media from a *published* entry is refused, since it would leave
  viewers on an item with nothing to play.
- A node that stops heartbeating reads `offline` rather than holding its last
  reported status forever.

**Remaining**: run `pnpm migrate:library` after the deploy, then verify the
library in the Asset Manager before decommissioning the old deployment.

## Phase 4 — Automated Scheduled Publishing (Not started)

Convex owns the clock and dispatches finished renders to platform APIs.

**Planned work**

1. `media_social_posts` gains per-platform publish result rows — external post id,
   published timestamp, error, retry count — as a child table rather than arrays
   on the post document.
2. A cron tick finds posts whose `scheduledDate`/`scheduledTime` is due and whose
   render is in `scheduled_social`, then schedules a publish action per platform.
3. Per-platform Node actions:
   - **Meta**: create media container from the R2 URL, poll container status
     until `FINISHED`, then publish. Handle the async container lifecycle
     properly — publishing a container that is not finished fails opaquely.
   - **TikTok**: Content Posting API with the verified-domain media URL.
   - **YouTube**: resumable upload session, or URL-based ingest where available.
4. On verified publish: record the external id, mark the `social_renders` row
   `published`, and enqueue the `scheduled/social/` delete task.
5. On failure: exponential backoff with a bounded retry count, surfaced in both
   UIs. Rate-limit errors retry; auth errors stop and alert.
6. **Long-lead scheduling** (decision 1 in `OPERATOR_SETUP_TASKS.md`): for posts
   more than ~5 days out, do not hold an R2 object. Store the render *intent* and
   enqueue a fresh `renderJob` shortly before the publish time.

**Blocked by**: Operator Tasks 4.1–4.4. The API approvals have real lead times;
the code is a week, the approvals may not be.

---

## Phase 5 — Archive Retrieval And Presigned Playback (Code complete, needs endpoint)

Staff can see and pull back archived masters without a Backblaze login.

**Delivered**

- `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` added to the desktop
  main process. rclone cannot mint presigned URLs, which is the one thing it
  could not do here.
- `src/main/services/ArchiveService.ts` — presigns a URL for exactly one object,
  expiring in an hour. Credentials never leave the main process, and the bucket
  stays private.
- `b2.s3Endpoint` setting. B2 carries its region in the S3 hostname and SigV4
  needs the two to agree, so the region is derived from the endpoint rather than
  asked for separately — one field to get right instead of two that must match.
- Library detail gains a **Master Archive** card: *Preview master* streams the
  original in place, *Retrieve for processing* pulls it to the working folder
  and hands it straight to the trimmer with the timeline loaded.
- A retrieved master already on disk at the right size is reused instead of
  re-downloaded. These are multi-gigabyte files and a double-click should not
  cost a second transfer.

**Deliberately not done**

- **Presigning stays in the main process.** Only presigning uses the S3 SDK;
  bytes still move through `SyncService`'s rclone path, which already has
  progress, retries, and verification. Two transfer implementations to keep
  correct would be a cost with no matching benefit.
- **No Convex action for web-side preview.** That needs B2 credentials in Convex
  environment variables — decision 2 in `OPERATOR_SETUP_TASKS.md`, and a
  security-posture change worth making deliberately rather than by drift.
- **The rclone → native S3 upload migration is not part of this.** It is a
  separate refactor of a working path; folding it in would have put the upload
  pipeline at risk for a feature that does not need it. It stays in
  `ROADMAP.md`.

**Remaining**: set the B2 S3 endpoint — Operator Task 2.4.

---

## Phase 6 — Trusted-Backend Storage Executor (Optional)

Only needed if studio desktops cannot be relied on to be awake when a promotion
or cleanup task is queued.

**Planned work**

1. R2 credentials into Convex environment variables.
2. A Node action that claims from the same `storage_tasks` queue and performs
   `CopyObject` / `DeleteObject` directly.
3. A cron tick that runs the action when a task has been queued longer than a
   threshold with no desktop node online.

Because it consumes the existing queue, this is purely additive — no schema
change and no client change.

**Blocked by**: decision 2 in `OPERATOR_SETUP_TASKS.md`.

---

## Sequencing Notes

- **Phase 4 is the remaining build.** It is gated on external approvals with
  real lead times, so start the platform paperwork before the code.
- **Phase 3's remaining work lives in the sports app's admin.** Everything this
  codebase owes it is done; the contract is stable and the web app can be built
  against it now.
- **Phase 6 should not be built pre-emptively.** Add it when a promotion task is
  observed sitting queued overnight, not before.

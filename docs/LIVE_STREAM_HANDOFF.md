# Live Stream Handoff Contract

This document defines the planned integration that turns a finished Cloudflare
Stream live recording into a normal CSN Media Bridge VOD asset through Convex and
the Tauri desktop worker.

Last reviewed: September 10, 2026

## Purpose

When a live event ends, the operator should not have to manually download a
recording, drag it into a watch folder, wait for ingest, and then check whether
the VOD appeared. Cloudflare should notify a Worker, the Worker should write a
durable Convex job, and a healthy desktop node should wake up, claim the work,
run FFmpeg locally, upload the package, and register the finished video.

The desktop app still owns heavy media work. Convex owns durable state. The
Worker only receives provider events and creates queue records.

## End-To-End Flow

```
Cloudflare Stream live ends
        |
        v
Cloudflare Worker verifies webhook
        |
        v
Worker calls Convex `media/liveStream:addHandoffJob`
        |
        v
Tauri app receives live query update
        |
        v
Tauri worker calls `claimNextHandoffJob`
        |
        v
Desktop downloads recording and runs FFmpeg
        |
        v
Desktop uploads source/archive and CMAF playback assets
        |
        v
Desktop registers VOD in Convex and completes handoff job
```

## Ownership Boundaries

| Component | Owns |
| --- | --- |
| Cloudflare Stream | Producing the live recording and emitting provider webhooks |
| Cloudflare Worker | Webhook verification, normalization, idempotent job creation |
| Convex | Queue state, node leases, progress events, VOD registration state |
| Tauri Media Bridge | FFmpeg, local disk, credentials, B2/R2 transfer, operator status |
| CSN web app | Optional review, publishing, monitoring, and metadata correction |

## Convex Queue Model

The backend lives in the CSN sports app deployment. These names are proposed
contracts for that backend, not files inside this desktop repository.

### `live_stream_handoff_jobs`

Suggested schema shape:

```ts
live_stream_handoff_jobs: defineTable({
  provider: v.union(v.literal("cloudflare_stream")),
  providerVideoId: v.string(),
  providerLiveInputId: v.optional(v.string()),
  sourceDownloadUrl: v.optional(v.string()),
  sourceObjectKey: v.optional(v.string()),
  status: v.union(
    v.literal("pending"),
    v.literal("claimed"),
    v.literal("downloading"),
    v.literal("processing"),
    v.literal("uploading"),
    v.literal("registering"),
    v.literal("completed"),
    v.literal("failed"),
    v.literal("canceled")
  ),
  claimedByNodeKey: v.optional(v.string()),
  leaseExpiresAt: v.optional(v.number()),
  attempts: v.number(),
  maxAttempts: v.number(),
  projectName: v.optional(v.string()),
  eventName: v.optional(v.string()),
  recordedAt: v.optional(v.string()),
  requestedDelivery: v.optional(v.union(v.literal("auto"), v.literal("hls"))),
  archiveObjectKey: v.optional(v.string()),
  distributionObjectKey: v.optional(v.string()),
  playbackUrl: v.optional(v.string()),
  manifestUrl: v.optional(v.string()),
  dashManifestUrl: v.optional(v.string()),
  posterUrl: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  createdAt: v.string(),
  updatedAt: v.string(),
  completedAt: v.optional(v.string()),
})
  .index("by_status", ["status"])
  .index("by_provider_video", ["provider", "providerVideoId"])
  .index("by_claimed_node", ["claimedByNodeKey"])
```

Important details:

- `provider + providerVideoId` must be unique in behavior, even if Convex
  enforces that through mutation logic rather than a database constraint.
- `leaseExpiresAt` should be a number timestamp if the rest of the media backend
  uses numeric Convex times; use string ISO timestamps only if that is already
  the local convention for these queues.
- `requestedDelivery` should default to `hls` because live stream handoff is VOD
  promotion, not short clip generation.

### `live_stream_handoff_events`

Suggested schema shape:

```ts
live_stream_handoff_events: defineTable({
  handoffJobId: v.id("live_stream_handoff_jobs"),
  nodeKey: v.optional(v.string()),
  level: v.union(v.literal("info"), v.literal("warn"), v.literal("error")),
  stage: v.optional(v.string()),
  message: v.string(),
  progress: v.optional(v.number()),
  createdAt: v.string(),
})
  .index("by_handoff_job", ["handoffJobId"])
  .index("by_created_at", ["createdAt"])
```

Keep this table bounded with scheduled cleanup. Do not append large log arrays to
the handoff job document.

## Convex Function Contract

### Worker-Facing

`media/liveStream:addHandoffJob`

- Called by the Cloudflare Worker.
- Requires a Worker/service credential, not a browser session.
- Validates the provider payload.
- Upserts by `provider + providerVideoId`.
- Returns the existing job if Cloudflare retries the webhook.

`media/liveStream:markRecordingUnavailable`

- Optional.
- Used when the webhook says the live ended but the recording is not ready yet,
  or when the Worker cannot produce a usable source URL.

### Desktop-Facing

`media/liveStream:listPendingHandoffJobs`

- Live query used as a wakeup signal.
- Returns pending jobs or a compact count.
- Must not be treated as a lock.

`media/liveStream:claimNextHandoffJob`

- Mutation called by the desktop node after the live query wakes it.
- Filters `status: "pending"` or expired claimed/processing jobs.
- Sets `claimedByNodeKey`, increments `attempts`, and sets `leaseExpiresAt`.
- Returns exactly one job or `null`.

`media/liveStream:renewHandoffJobLease`

- Called during long download, transcode, and upload phases.
- Rejects if a different node owns the job.

`media/liveStream:markHandoffProgress`

- Updates status, stage, message, progress, and lease.
- Inserts a bounded event row for operator visibility.

`media/liveStream:completeHandoffJob`

- Patches final storage/playback fields.
- Marks status `completed`.
- Links to the created or updated VOD record when the backend has that relation.

`media/liveStream:markHandoffFailed`

- Records the error message and leaves the job retryable until `maxAttempts` is
  reached.

### Operator-Facing

`media/liveStream:listRecentHandoffJobs`

- Powers Dashboard or live operations views.

`media/liveStream:retryHandoffJob`

- Clears claim fields and returns a failed job to `pending`.

`media/liveStream:cancelHandoffJob`

- Cancels pending or failed work. In-flight cancellation can be phase two if it
  requires interrupting a desktop process.

## Cloudflare Worker Requirements

The Worker should do only the provider-edge work:

1. Verify the webhook signature or shared secret.
2. Parse the Cloudflare Stream event.
3. Determine whether a recording URL is available.
4. Normalize metadata into the Convex handoff shape.
5. Call `media/liveStream:addHandoffJob`.
6. Return success for duplicate webhook deliveries once Convex has an existing
   matching job.

The Worker should not run FFmpeg and should not receive desktop node tokens.

Recommended environment variables:

- `CONVEX_URL`
- `CONVEX_WORKER_TOKEN`
- `CLOUDFLARE_STREAM_WEBHOOK_SECRET`

Optional environment variables if the Worker later fetches recording metadata:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

## Tauri Desktop Worker Requirements

The Tauri app should keep two separate responsibilities:

- a live queue listener that wakes the worker when Convex changes
- a native worker that claims, processes, renews, and completes jobs

Recommended desktop behavior:

1. Open a Convex live subscription for `listPendingHandoffJobs`.
2. When a pending job appears, call a Tauri command such as
   `wake_live_handoff_worker`.
3. The Rust worker calls `claimNextHandoffJob`.
4. If it receives a job, it starts a lease renewal task.
5. It downloads the recording to the configured temp folder.
6. It runs ffprobe and resolves VOD metadata.
7. It runs FFmpeg to generate the CMAF HLS/DASH package.
8. It uploads the source to B2 and playback/poster files to R2.
9. It registers or upserts the VOD record with the existing media mutation.
10. It calls `completeHandoffJob`.
11. It removes temporary files only after upload and registration succeed.

The worker should emit Tauri events for UI progress, but Convex remains the
durable truth if the app restarts.

Current Tauri status:

- `list_live_stream_handoff_jobs` reads `media/liveStream:listRecentHandoffJobs`
  through the Convex HTTP API when Convex settings are configured.
- `wake_live_stream_handoff_worker` claims one job with
  `media/liveStream:claimNextHandoffJob` and starts a Rust background worker.
- The worker renews the lease, downloads `sourceDownloadUrl`, queues the
  recording into the local HLS ingest path, uploads/registers through the normal
  VOD flow, then calls `completeHandoffJob` or `markHandoffFailed`.
- `sourceObjectKey`-only handoffs are intentionally rejected until durable
  B2/R2 retrieval is ported.

## Processing Rules

Live handoff output should match normal long-form ingest:

- delivery type: `hls`
- content type: `vod`
- R2 playback layout: `videos/{assetKey}/`
- R2 poster layout: `posters/{assetKey}/`
- B2 master layout: `masters/{project}/{date}/{assetKey}/{sourceName}`
- playback files:
  - `master.m3u8`
  - `manifest.mpd`
  - variant playlists such as `video/1080p_6000k/stream.m3u8`
  - init files such as `video/1080p_6000k/init.mp4`
  - segments such as `video/1080p_6000k/chunk_00001.m4s`
- Convex media record includes the same playback, manifest, archive, poster,
  encoder, duration, source size, project, event, and status fields used by
  watch-folder ingest

## Reliability Requirements

- Webhook handling is idempotent.
- Desktop claiming is atomic.
- Jobs have leases and can recover after app or workstation failure.
- The source recording URL expiry path is explicit.
- Progress is visible in Convex events.
- Failed jobs can be retried without creating duplicate VOD records.
- Completed jobs must not be reprocessed if Cloudflare retries a webhook.
- R2 lifecycle rules must not delete persistent VOD playback assets.
- B2 archive upload must complete before the final VOD is marked ready unless a
  product decision explicitly allows stream-only records.

## Dashboard UX

The Tauri dashboard should add a live handoff section with:

- pending live recordings
- currently claimed recording
- desktop node assigned to the job
- current stage and progress
- retry/cancel actions for failed or pending jobs
- source provider video id
- final playback link after completion
- last error message

This should sit beside the existing ingest queue rather than replacing it. Live
handoff is another source of VOD work, not a separate media library.

## Test Fixtures

Create fixtures for:

- duplicate Cloudflare webhook delivery
- webhook with no recording URL yet
- valid recording URL
- expired recording URL
- two desktop nodes waking at the same time
- app crash after claim
- app crash after upload but before completion
- upload failure after successful transcode
- successful handoff to VOD

## Acceptance Criteria

A live stream handoff is ready for production when:

- a Cloudflare Stream webhook creates exactly one Convex job
- a Tauri desktop app receives the change without interval polling
- only one desktop node can claim and process the job
- the worker renews its lease during long media work
- a completed job appears in the normal VOD library
- a failed job shows a useful error and can be retried
- restarting the app during processing does not strand the queue
- replaying the same webhook does not duplicate storage uploads or media records

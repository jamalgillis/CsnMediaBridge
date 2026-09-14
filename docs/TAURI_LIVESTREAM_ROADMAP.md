# Tauri And Livestream Handoff Roadmap

This document lays out a practical path for rebuilding CSN Media Bridge as a
Tauri desktop app while preserving the original Electron app's workflow and
adding a Convex-backed live stream handoff queue.

Last reviewed: September 10, 2026

## Target Outcome

The Tauri version should do everything the app does today:

- watch a local ingest folder for finished source videos
- wait for files to stabilize before processing
- run FFmpeg/ffprobe with platform-aware encoder selection
- create progressive MP4/WebM clip outputs
- create CMAF-compatible HLS/DASH VOD packages
- upload source masters to Backblaze B2
- upload playback packages and posters to Cloudflare R2
- register finished media metadata with Convex
- provide a Convex-backed VOD library with search, metadata editing, status
  changes, poster replacement, archive retrieval, and trim workflows
- support manual offload of full shoot folders, local package manifests,
  resumable logs, image-to-webp conversion, and optional image-only B2 upload
- report workstation health, logs, queue state, transfer state, and desktop
  worker activity

It should also add a live stream handoff path:

```
Cloudflare Stream live input ends
        |
        v
Cloudflare Worker webhook handler
        |
        v
Convex live stream handoff queue
        |
        v
Tauri Media Bridge desktop worker
        |
        v
FFmpeg CMAF local package build
        |
        v
Backblaze B2 master archive + Cloudflare R2 playback package
        |
        v
Convex VOD/media registration
```

## Current App Baseline

> **Historical.** This roadmap was written during the migration. The Electron
> shell described below has since been removed; the Tauri host is the only host.
> See `docs/TAURI_ARCHITECTURE.md` for where things actually stand.

The app was an Electron, React, Tailwind, TypeScript desktop app. That shell
owned native work through main-process services:

| Current area | Current implementation | Tauri destination |
| --- | --- | --- |
| UI and routing | React routes in `src/App.tsx` | Keep React, run inside Tauri WebView |
| App state bridge | Electron IPC and preload bridge | Tauri commands/events |
| Watch folder ingest | `WatcherService` with `chokidar` | Rust file watcher or JS watcher behind Tauri commands |
| FFmpeg orchestration | `TranscodeService` with child processes | Rust command runner with structured progress events |
| Uploads | `SyncService` using `rclone` | Phase 1 keep `rclone`; manual intake upload is now ported |
| Settings | `electron-store` and safe storage | Tauri store + OS keychain/secure storage plugin |
| Convex writes | `ConvexHttpClient` mutation/query calls | Shared Convex client wrapper plus live subscription worker |
| Worker queue | timed claim loops | live query wakeup plus mutation-based claim/lease |
| Local media proxy | Electron HTTP proxy | Tauri localhost server or custom protocol |
| Notifications/update | Electron notification/updater | Tauri notification/updater plugins |

The safest migration strategy is not a rewrite of the media logic and UI at the
same time. Keep the product shape stable, port the shell boundary, then improve
the worker model.

## Architecture Decision

Use Tauri as the native host and keep React as the renderer.

The renderer should own interactive UI, Convex-backed library subscriptions, and
operator controls. Rust should own any operation that touches local disk, local
processes, credentials, FFmpeg, rclone, filesystem watching, or long-running
background work.

Recommended process model:

- `src-tauri/`: Rust app, commands, background workers, config, secure storage,
  filesystem, process orchestration, upload/download helpers, updater.
- `src/`: existing React renderer, gradually moved from Electron IPC to Tauri
  `invoke` commands and event listeners.
- `src/shared/`: keep portable TypeScript types and storage helpers during the
  transition. Mirror critical contracts in Rust with tests.
- Convex backend: remains in the shared CSN sports app deployment, not inside
  this desktop repository.

## Live Convex Queue Strategy

The new live handoff flow should use Convex as the durable queue and real-time
notification channel.

The desktop should not merely trust the item delivered by a live subscription.
The subscription is the wakeup signal; the claim mutation is the lock.

Recommended behavior:

1. The Tauri app starts and registers a desktop node heartbeat in Convex.
2. A lightweight JS queue client opens a Convex subscription for pending
   `live_stream_handoff_jobs` assigned to eligible desktop nodes.
3. When a pending job appears, the client emits a Tauri event or calls a Tauri
   command to wake the Rust worker.
4. The Rust worker calls a Convex claim mutation using the node token.
5. Convex atomically moves the job to `claimed`, records `claimedByNodeKey`,
   increments attempts, and sets `leaseExpiresAt`.
6. The Rust worker downloads or receives the source stream recording URL,
   validates it, and runs FFmpeg locally.
7. The worker uploads the master/archive and R2 CMAF playback package.
8. The worker calls the existing VOD registration path and marks the handoff job
   `completed`.
9. If the app crashes, lease expiry makes the job claimable again.

The live subscription keeps the worker responsive without polling for empty
work. The claim/lease mutation keeps the queue correct when more than one
desktop is online.

## Live Stream Handoff Contract

The sketch in the prompt is a good prototype. For production, add enough fields
to make the queue idempotent, recoverable, and observable.

### Convex Tables

`live_stream_handoff_jobs`

| Field | Purpose |
| --- | --- |
| `provider` | Starts as `cloudflare_stream`; leaves room for vMix, SRT recorder, or Mux later |
| `providerVideoId` | Cloudflare Stream video id or recording id |
| `providerLiveInputId` | Optional live input id for event correlation |
| `sourceDownloadUrl` | Signed or short-lived recording download URL, when available |
| `sourceObjectKey` | Optional durable object key if the Worker first stores the recording |
| `status` | `pending`, `claimed`, `downloading`, `processing`, `uploading`, `registering`, `completed`, `failed`, `canceled` |
| `claimedByNodeKey` | Desktop node currently holding the lease |
| `leaseExpiresAt` | Reclaim boundary if the app dies |
| `attempts` / `maxAttempts` | Poison-job protection |
| `projectName` / `eventName` / `recordedAt` | Metadata to carry into the VOD record |
| `requestedDelivery` | Usually `hls`; supports `auto` if later needed |
| `archiveObjectKey` | Final B2 master key after upload |
| `distributionObjectKey` | Final R2 playback prefix after upload |
| `playbackUrl` / `manifestUrl` / `dashManifestUrl` / `posterUrl` | Final playback fields |
| `errorMessage` | Last failure visible to operators |
| `createdAt` / `updatedAt` / `completedAt` | Audit timestamps |

`live_stream_handoff_events`

Use a bounded event table for progress and audit messages instead of appending
large log arrays to a job document.

Suggested event fields:

- `handoffJobId`
- `nodeKey`
- `level`
- `stage`
- `message`
- `progress`
- `createdAt`

### Convex Functions

Cloudflare Worker calls:

- `media/liveStream:addHandoffJob`
- `media/liveStream:markRecordingUnavailable`

Desktop node calls:

- `media/liveStream:listPendingHandoffJobs` as the live query
- `media/liveStream:claimNextHandoffJob`
- `media/liveStream:renewHandoffJobLease`
- `media/liveStream:markHandoffProgress`
- `media/liveStream:completeHandoffJob`
- `media/liveStream:markHandoffFailed`
- `media/videos:upsertVideo` or the existing configured registration mutation

Operator UI calls:

- `media/liveStream:listRecentHandoffJobs`
- `media/liveStream:retryHandoffJob`
- `media/liveStream:cancelHandoffJob`

### Cloudflare Worker Webhook

The Worker should verify the webhook signature, normalize the event, and write
one idempotent Convex job.

Responsibilities:

- accept Cloudflare Stream live end or recording-ready webhooks
- verify the request came from Cloudflare
- extract `providerVideoId`, live input id, recording URL, duration, and
  available metadata
- call Convex with a service credential
- upsert by `provider + providerVideoId` so retry delivery from Cloudflare does
  not enqueue duplicates
- avoid storing long-lived R2/B2 credentials in the Worker unless it is also
  responsible for copying provider recordings into durable staging storage

## Tauri Implementation Roadmap

### Phase 0: Product And Contract Freeze

Outcome: everyone knows what must remain compatible before shell migration
begins.

Deliverables:

- current Electron feature inventory signed off from `README.md` and
  `docs/FEATURES.md`
- IPC command inventory from `src/shared/ipc.ts`
- settings schema inventory from `src/shared/types.ts`
- storage contract inventory from `docs/STORAGE_LAYOUT.md`
- Convex function inventory from `docs/HYBRID_ORCHESTRATION.md`

### Current Tauri Implementation Status

The Tauri host now has a working manual intake path:

- JSON settings persistence and system health checks
- native file/folder dialogs
- manual source FFprobe inspection
- background FFmpeg worker for progressive MP4 and CMAF HLS/DASH packages
- source SHA-256 fingerprinting for canonical storage keys
- rclone upload of the source master to B2 and distribution package/poster to R2
  when storage settings are complete
- Convex VOD registration through the configured mutation path after upload
  succeeds
- dashboard state events for queued, encoding, uploading, completed, and failed
  states
- manual live handoff wake flow that lists recent Convex jobs, claims one
  pending job, renews the lease, downloads `sourceDownloadUrl`, queues local
  HLS processing, and marks the Convex handoff job completed or failed

Still pending:

- Convex library reads and metadata mutations from the Tauri host
- watch-folder ingest
- upload audit and retry/recovery
- render-job and storage-task workers
- live stream handoff live subscription wakeup from the renderer
- live stream handoff `sourceObjectKey` retrieval for durable staged recordings
- live stream handoff schema/function implementation in the CSN sports app

Exit criteria:

- every existing page has a parity checklist
- every native operation has an assigned Tauri command or background worker
- live stream handoff status model is additive to the existing media schema

### Phase 1: Tauri Shell Scaffold

Outcome: the React UI boots inside Tauri with no media work moved yet.

Deliverables:

- add `src-tauri/` with app config, icons, permissions, updater placeholders,
  and development scripts
- replace Electron Forge scripts with Tauri scripts in a branch while keeping the
  Electron app runnable until parity is reached
- configure Vite output for Tauri
- provide a compatibility layer:
  - `window.mediaBridge.invoke(...)`
  - internally maps to Electron IPC in the old app and Tauri `invoke` in the new
    app during migration
- port window controls, app metadata, notifications, and folder/file pickers

Exit criteria:

- Dashboard, Player, Trimmer, Offload, and Settings routes render in Tauri
- settings can be loaded and saved
- the app can be packaged for macOS and Windows in a basic unsigned build

### Phase 2: Native Settings And Secrets

Outcome: the Tauri app can safely store workstation configuration.

Deliverables:

- move settings persistence from `electron-store` to a Tauri-backed config store
- store B2, R2, Convex node token, and future Cloudflare Stream credentials in
  OS secure storage
- migrate existing Electron settings on first Tauri launch when possible
- add settings validation for:
  - `ffmpeg`
  - `ffprobe`
  - `rclone`
  - watch folder
  - temp output folder
  - B2 bucket/credentials
  - R2 bucket/credentials/public base URL
  - Convex deployment URL/node token

Exit criteria:

- secrets are not written to plain JSON
- incomplete settings produce actionable health notes
- existing operators do not have to re-enter non-secret settings manually

### Phase 3: Native Media Worker Parity

Outcome: the core ingest pipeline works in Tauri.

Deliverables:

- Rust command runner for FFmpeg/ffprobe with structured stdout/stderr progress
- platform encoder resolver matching current behavior:
  - Windows/NVIDIA: NVENC
  - macOS: VideoToolbox
  - fallback: libx264
- local media proxy or custom protocol for previewing local/retrieved files
- watch folder service with ready checks and duplicate active-job protection
- current delivery selection:
  - `progressive` for short clips
  - `hls` for long-form VOD
  - `auto` threshold by duration
- source fingerprinting
- poster extraction
- dashboard progress/log events

Exit criteria:

- one progressive clip ingests end to end
- one long-form VOD produces `master.m3u8`, `manifest.mpd`, and `.m4s` segments
- retrying a failed job works without restarting the app

### Phase 4: Cloud Sync Parity

Outcome: Tauri can archive, distribute, verify, and clean up media.

Deliverables:

- initial port may keep `rclone` for B2/R2 to reduce migration risk
- preserve upload progress, retries, verification, audit, resume, purge, copy,
  and delete operations
- preserve canonical storage layout:
  - B2 masters under `masters/...`
  - R2 VOD under `streaming/vod/...`
  - R2 posters under `posters/...`
  - social staging under `staging/social/...`
  - protected scheduled social under `scheduled/social/...`
- add a later milestone for native S3-compatible uploads if `rclone` progress,
  packaging, or support burden becomes the bottleneck

Exit criteria:

- uploaded objects match the storage layout contract
- upload audits catch missing, unexpected, and size-mismatched objects
- storage task copy/delete worker still works

### Phase 5: Convex Client And Existing Worker Queues

Outcome: Tauri matches today's Convex-backed app behavior.

Deliverables:

- Convex service wrapper for VOD registration, library reads, metadata updates,
  poster updates, delete, archive retrieval, desktop heartbeat, render jobs, and
  storage tasks
- node token applied centrally to every privileged media call
- live renderer subscriptions for library and queue views where useful
- background Rust worker claims jobs through mutations, never directly from
  subscription payloads
- event bridge from worker progress to React UI

Exit criteria:

- stored-video library loads and edits records
- desktop node heartbeat appears in Convex
- render jobs and storage tasks can be claimed, renewed, completed, and failed
- current Electron Convex behavior has a Tauri equivalent

### Phase 6: Live Stream Handoff MVP

Outcome: ending a Cloudflare Stream live input creates a desktop CMAF packaging
job without manual operator polling.

Deliverables:

- Convex `live_stream_handoff_jobs` and `live_stream_handoff_events`
- idempotent `addHandoffJob` mutation for Cloudflare Worker webhook calls
- `listPendingHandoffJobs` live query for the desktop wakeup path
- claim/lease/progress/complete/fail mutations
- Cloudflare Worker webhook handler
- Tauri live subscription bridge
- Rust handoff worker:
  - claim job
  - download Cloudflare Stream recording
  - optionally archive original recording to B2
  - run FFmpeg CMAF HLS/DASH packaging
  - upload package to R2
  - register VOD in Convex
  - mark handoff job complete
- Dashboard queue panel for live handoff jobs

Exit criteria:

- a synthetic webhook creates one pending job
- the Tauri desktop reacts through a Convex live update
- only one desktop can claim the job
- the job survives app restart through lease expiry
- completed output appears in the same VOD library as watch-folder ingests

### Phase 7: Operator-Grade Livestream UX

Outcome: operators can trust the handoff during real productions.

Deliverables:

- live handoff page or Dashboard section with:
  - stream/event name
  - recording status
  - assigned desktop node
  - current stage
  - progress
  - retry/cancel controls
  - final playback link
- notification when a stream recording is ready, claimed, completed, or failed
- source URL expiry handling
- failed download retry path
- duplicate webhook handling display
- event/game metadata mapping
- optional manual "promote stream recording" command for recordings that did not
  arrive through the webhook

Exit criteria:

- a non-developer operator can see what happened after a live event ends
- failed handoffs are recoverable from the UI
- every completed live handoff has traceable Convex events

### Phase 8: Release, Update, And Rollout

Outcome: the Tauri build can replace Electron on production machines.

Deliverables:

- signed macOS and Windows installers
- Tauri updater feed
- migration guide from Electron settings to Tauri settings
- rollback guidance
- workstation onboarding checklist
- smoke-test script for dependencies and credentials
- release notes for the first Tauri build

Exit criteria:

- an operator can install, configure, ingest, offload, trim, preview, and handle
  a live stream job on a clean workstation
- Electron can be retired only after the Tauri app has completed at least one
  production event workflow

## Documentation Plan

Add or update these docs as the roadmap moves:

| Document | Purpose |
| --- | --- |
| `docs/TAURI_LIVESTREAM_ROADMAP.md` | This plan |
| `docs/TAURI_ARCHITECTURE.md` | Native command/event design, Rust modules, renderer bridge |
| `docs/LIVE_STREAM_HANDOFF.md` | Cloudflare Worker, Convex queue, desktop processing contract |
| `docs/TAURI_OPERATOR_SETUP.md` | Installing the Tauri app, entering credentials, testing health |
| `docs/TAURI_RELEASES.md` | Signing, updater feed, packaging, rollback |
| `docs/CONVEX_DEPLOYMENT_TOPOLOGY.md` | Add live handoff tables/functions after backend implementation |
| `docs/FEATURES.md` | Update once Tauri reaches parity and live handoff ships |

## Suggested Rust Module Layout

```
src-tauri/src/
  main.rs
  app_state.rs
  commands/
    settings.rs
    dialogs.rs
    ingest.rs
    library.rs
    offload.rs
    trim.rs
    archive.rs
  services/
    ffmpeg.rs
    ffprobe.rs
    watcher.rs
    sync.rs
    convex.rs
    live_handoff.rs
    storage_tasks.rs
    render_jobs.rs
    media_proxy.rs
    health.rs
    updater.rs
  models/
    settings.rs
    jobs.rs
    media.rs
    storage.rs
  security/
    secrets.rs
```

Keep command handlers thin. They should validate input, call a service, and emit
events. Long-running work belongs in background tasks that can continue while
the UI changes routes.

## Testing Strategy

Required automated coverage:

- storage key generation parity between TypeScript and Rust
- settings migration from Electron format to Tauri format
- FFmpeg argument generation for progressive and HLS outputs
- Cloudflare Worker webhook idempotency
- Convex claim mutation race test with two simulated desktop nodes
- lease expiry and retry behavior
- source URL expiry/failure behavior
- upload path validation against storage class

Required manual smoke tests:

- fresh install
- dependency health check
- watch-folder ingest
- manual offload
- trim export
- poster replacement
- archive preview/retrieval
- live stream webhook to completed VOD
- app restart during processing
- network interruption during download/upload
- macOS and Windows packaging/update flow

## Open Decisions

- Whether the Tauri app keeps `rclone` permanently or moves B2/R2 uploads to
  native Rust S3-compatible clients after parity.
- Whether the Convex real-time queue listener lives in the visible renderer, a
  hidden worker window, or a small sidecar process. The simplest first version
  is a hidden WebView/JS client that wakes Rust through Tauri commands.
- Whether Cloudflare Worker passes a recording download URL directly or first
  copies the recording into durable storage and gives the desktop an object key.
- How long Cloudflare Stream recording URLs remain valid and what refresh path
  the desktop should use if a job is claimed after expiry.
- How stream events map to projects, games, teams, and editorial content in the
  sister CSN web app.
- Whether a live stream job should always produce HLS/DASH or sometimes create a
  progressive clip for short streams.

## First Implementation Slice

Start with the smallest useful path:

1. Scaffold Tauri with the existing React UI.
2. Port settings, health checks, and command/event bridge.
3. Port FFmpeg progressive ingest for one local file.
4. Port HLS/DASH packaging and R2/B2 upload.
5. Add the Convex live stream queue schema and claim/lease mutations.
6. Add a test Cloudflare Worker endpoint that creates handoff jobs.
7. Add a Tauri background worker that reacts to `pending` handoff jobs and
   produces a normal VOD library record.

That gives you a real vertical slice: a stream ends, Convex wakes the desktop,
the desktop does the native media work, and the finished video lands in the same
library operators already understand.

# Hybrid Orchestration Contract

CSN Media Bridge and the Asset Manager are separate applications that share the CSN sports
app's Convex deployment. The sports app owns the Convex codebase; both of these
are clients of it. See `CONVEX_DEPLOYMENT_TOPOLOGY.md`.

Media functions are namespaced under `media/` and every one of them requires a
credential: a provisioned node token for the desktop worker, or a Clerk session
holding the CSN admin role for an operator. The single exception is
`media/catalog.ts`, which is the public playback surface. Table names in the
merged schema are snake_case — `media_videos`, `render_jobs`, `social_renders`,
`desktop_nodes`, `desktop_job_events`, `storage_tasks`.

CSN Media Bridge is the autonomous desktop worker node. It owns local files,
watch folders, FFmpeg, hardware encoders, Backblaze B2 archive access,
Cloudflare R2 uploads, offload work, and workstation health.

The Asset Manager is the web command center. It owns browser-based asset browsing,
calendar scheduling, post composition, review, lightweight browser conversion,
and monitoring. It should write intent to Convex instead of trying to control a
desktop machine directly.

Convex is the shared source of truth between both apps.

## Shared Tables

See `MEDIA_PIPELINE_ARCHITECTURE.md` for why the pipeline is split this way and
`STORAGE_LAYOUT.md` for the object key contract both apps must honor.

The orchestration layer adds these tables (names as they appear in the merged
schema):

- `desktop_nodes`: high-churn heartbeat and capability records for active Media
  Bridge installs.
- `render_jobs`: durable work requests created by the Asset Manager or another trusted UI.
- `social_renders`: generated platform-ready MP4 outputs linked back to source
  VOD assets and optional scheduled posts.
- `desktop_job_events`: bounded progress/log events for monitoring render work
  from the Asset Manager.
- `storage_tasks`: durable copy/delete requests against B2 or R2, executed by a
  trusted worker so a browser can request privileged storage work without ever
  holding provider credentials.

Existing tables keep their current roles:

- `media_videos`: durable source VOD and clip records, linked to the editorial
  `content` row by `contentId`.
- `media_social_posts`: calendar/composer records for scheduled content.
- `media_playlists` and `media_playlist_items`: operator-facing organization,
  distinct from the viewer-facing `video_collections`.

## Web-To-Desktop Render Flow

1. The Asset Manager calls `media/orchestration:enqueueRenderJob` with a source video id,
   target platform list, aspect ratio, optional in/out points, optional
   scheduled time, and optional linked `socialPostId`.
2. A running Media Bridge desktop reports its health through
   `media/orchestration:upsertDesktopNodeHeartbeat`.
3. When the desktop is configured and healthy, it calls
   `media/orchestration:claimNextRenderJob`.
4. Convex assigns the job to that desktop by setting `claimedByNodeKey`,
   incrementing `attempts`, and setting `leaseExpiresAt`.
5. The desktop downloads the archived source master from Backblaze B2 using the
   source video's `archiveObjectKey`.
6. The desktop runs local FFmpeg reframing with the requested aspect ratio.
7. The desktop uploads the rendered MP4 to Cloudflare R2:
   - `staging/social/{renderJobId}/render.mp4`
   - `scheduled/social/{renderJobId}/render.mp4`
   - `videos/{assetKey}/social-{renderJobId}.mp4`
8. The desktop calls `media/orchestration:completeRenderJob`, which creates a
   `social_renders` record and marks the render job `ready`.
9. The Asset Manager subscribes to `render_jobs`, `social_renders`, `desktop_nodes`, and
   `desktop_job_events` to show queue progress and scheduling readiness.

## Lease And Retry Model

Render jobs are claimed with a short lease. The desktop renews or updates the
lease while work runs. If a desktop fails mid-job, another worker can reclaim
stale `claimed`, `rendering`, or `uploading` jobs after `leaseExpiresAt`.

The Asset Manager should requeue failed jobs by calling `media/orchestration:retryRenderJob`
instead of trying to invoke local desktop behavior directly.

## Browser Execution And Desktop Handoff

Browser rendering is a first-class executor, not a side path. A render job
carries `executorType`, and the same status enum covers both executors:

| Conceptual state     | `executorType` | `status`                |
| -------------------- | -------------- | ----------------------- |
| `browser_processing` | `browser`      | `claimed` / `rendering` |
| `desktop_queued`     | `desktop`      | `queued`                |
| `desktop_processing` | `desktop`      | `rendering`             |

The browser-side contract:

1. The Asset Manager calls `media/orchestration:enqueueRenderJob` with `executorType: "browser"`
   for sources under the size threshold, or `"desktop"` for anything above it.
2. Before starting its Web Worker it calls
   `media/orchestration:claimBrowserRenderJob` with a per-tab `ownerKey`, taking the
   job under the same lease model a desktop node uses. A closed tab therefore
   releases the job by lease expiry instead of stranding it.
3. It reports progress with `media/orchestration:markRenderJobProgress`, passing the
   `ownerKey` as `nodeKey`.
4. On success it uploads to `staging/social/{renderJobId}/render.mp4` through a
   presigned URL minted by a trusted backend path, then calls
   `media/orchestration:registerBrowserRenderOutput`. That produces the same
   `social_renders` shape a desktop render does, so nothing downstream needs to
   know which executor produced a file.

**Offload to Desktop Worker** is `media/orchestration:offloadRenderJobToDesktop`. The
frontend terminates its Web Worker first — freeing the tab's heap regardless of
whether the round trip succeeds — then calls the mutation. Convex flips
`executorType` to `desktop`, requeues the job, resets progress and the attempt
budget, and records the reason in `desktop_job_events`. Partial WASM output is not
resumable, so the desktop starts clean from the archived master.

The desktop claim query filters on `executorType: "desktop"`, so a desktop node
will never steal a job a browser is actively encoding.

Browsers never receive raw B2/R2 account credentials. The Asset Manager calls media
functions with the operator's Clerk session; it holds no node token.

## Storage Lifecycle Contract

Two mutations own the transitions that keep a scheduled post from pointing at an
object on a lifecycle fuse:

- `media/orchestration:promoteRenderToScheduled` enqueues a copy from
  `staging/social/` into `scheduled/social/`. It does **not** patch the
  `social_renders` row — `media/storage:completeStorageTask` does that, once a worker
  has confirmed the destination object exists. The staging copy is deleted only
  after that confirmation.
- `media/orchestration:markSocialRenderPublished` records a verified publish and
  enqueues the delete of the protected object. Persistent `streaming` renders
  are exempt; social cleanup never touches the VOD library.

Storage tasks are claimed with `media/storage:claimNextStorageTask` under a lease,
reported with `media/storage:completeStorageTask` or `media/storage:markStorageTaskFailed`,
and retried below the attempt cap. `convex/crons.ts` reaps expired leases on
both queues, marks staged renders the lifecycle rule has already removed, and
trims the event log.

## Repository Boundary

Settled: the Asset Manager is a destination inside the sports app's admin
(`Websites/csn/apps/admin/app/assets`), and the sports app owns the Convex
codebase. This desktop project is a client of it and contains no backend.

The consequence to keep in mind is release cadence. The admin app and the Convex
functions deploy together; desktop builds ship to workstations and cannot be
upgraded in lockstep. So the backend leads and must stay backwards compatible —
**additive changes only while old desktop versions are in the field.** Never
remove or rename a media function, and never narrow an argument validator.

See `CONVEX_DEPLOYMENT_TOPOLOGY.md`.

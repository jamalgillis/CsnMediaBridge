# Product Roadmap

This document captures the current product gaps, partial implementations, and future work for CSN Media Bridge so they can be reviewed and completed later.

The storage and orchestration substrate several items below depend on is now
specified and built. See `MEDIA_PIPELINE_ARCHITECTURE.md` for the design,
`STORAGE_LAYOUT.md` for the bucket contract, and `EXECUTION_ROADMAP.md` for the
phased delivery plan that supersedes the sequencing notes at the end of this
document.

For white-labeled product planning, see `WHITE_LABEL_AUTH_STRATEGY.md`.

Current focus:

- preserve the app's strong ingest and offload foundation
- keep physical media work in the desktop app and human collaboration in the sister web app
- make Convex the shared state contract between desktop ingest and browser review
- add a preemptive social staging pipeline without routing heavy media through the browser app
- separate persistent streaming assets from short-lived and scheduled social assets in R2
- expand carefully into livestream and media-operations workflows

Status key:

- `done`: already implemented
- `partial`: foundation exists, but the workflow is incomplete
- `planned`: not implemented yet, but identified as useful future work

Priority key:

- `P1`: highest impact for current CSN-style workflow
- `P2`: valuable next-layer workflow improvement
- `P3`: useful expansion after core management features are in place

Ownership key:

- `desktop`: belongs in CSN Media Bridge because it touches local files, local devices, FFmpeg, rclone/native S3 uploads, or workstation-only credentials
- `web`: belongs in the sister browser app because it is client/reviewer-facing collaboration, auth, playback review, or public distribution workflow
- `shared`: belongs in Convex/shared schema because both apps need the same source of truth
- `triggered`: initiated from the web app but executed by the desktop app or a trusted backend worker

Last reviewed: May 22, 2026

## Sister App Boundary

CSN Media Bridge should remain the ingest node and local media operations app. The sister web app should own the Lawn-style collaboration layer.

Rule of thumb:

- Desktop owns local files, watch folders, vMix recordings, trimming, FFmpeg, hardware encoders, cloud upload, poster generation, local audit, and workstation health.
- Desktop owns social-ready media rendering before cloud upload, including operator-selected framing targets such as vertical, feed, and native widescreen exports.
- Web owns Clerk-authenticated review rooms, client/reviewer permissions, timestamped comments, approvals, presence, public playback workflows, social copy, scheduling controls, and notifications.
- Convex owns universal state: assets, workflow states, review metadata, event/project associations, social publishing jobs, telemetry snapshots, and requests that need trusted execution.
- Browser users may request destructive or heavy actions, but they should not receive direct storage credentials or control local disk/encoder operations.
- The browser app should not proxy large video uploads or act as an intermediate loader for Meta/Instagram. Social APIs should fetch prepared media directly from R2 URLs coordinated by Convex.

## Storage Lifecycle Contract

Superseded by `STORAGE_LAYOUT.md`, which is now the authoritative contract and is
implemented in code. The summary below is kept for orientation; where the two
differ, the storage layout document wins.

| Path | Owner | Purpose | Lifecycle |
| --- | --- | --- | --- |
| `streaming/` | `desktop` | Production CMAF HLS/DASH playback packages for web review and VOD playback. | Persistent; never automatically deleted. |
| `posters/` | `desktop` | Thumbnails and article cards. | Persistent; never automatically deleted. |
| `staging/social/` | `desktop` | Preemptively rendered social MP4 variants ready for quick handoff. | Provider lifecycle rule deletes after 3 days. |
| `scheduled/social/` | `shared` | Social MP4 variants protected for future scheduled publishing. | Deleted by trusted cleanup after a verified publish; 7-day provider rule as a backstop. |

Status transitions protect assets from accidental lifecycle deletion. When a
render is attached to a scheduled post, `orchestration:promoteRenderToScheduled`
copies the object into `scheduled/social/` before the staging fuse can reach it,
and the Convex record is patched only after the destination is confirmed.

## Current State Summary

The app is already strong as an ingest and offload tool. It currently covers:

- automated watch-folder ingest
- FFmpeg-driven transcode and poster generation
- cloud sync to Backblaze B2 and Cloudflare R2
- Convex registration of completed media
- local trimming workflow
- manual offload with resumable logging, optional `webp` conversion, and image-only cloud upload
- Convex-backed VOD library with search, filtering, metadata editing, publish controls, and poster replacement

The main product gap is not the ingest pipe itself. The main gap is the shared Convex model that lets the desktop app register durable assets and pre-staged social renditions while the sister web app drives review, approval, copy, scheduling, and public-facing collaboration without taking over local media work.

## Already Present Or Partial

### VOD Library

- `done` `P1` Full stored video library management
  - The app now has a Convex-backed library view with browse, search, filter, and non-ready asset visibility.
  - Current code reference: `src/pages/PlayerPage.tsx`, `src/main/services/ConvexService.ts`
  - Remaining gap: batch actions and client-facing review should be implemented as shared Convex mutations with web-first UI.

### Status Model

- `done` `P1` In-app metadata editor and publish controls
  - Operators can now edit metadata and move assets between `draft` and `ready` directly in the desktop app.
  - Current code reference: `src/pages/PlayerPage.tsx`, `convex/videos.ts`
  - Remaining gap: richer workflow states such as `Ready for Review`, `Approved`, and `Published` should be shared Convex state. The web app should own reviewer-facing transitions.

### Thumbnail Extraction

- `done` `P1` Manual poster management workflow
  - The app can now generate poster candidates from stored playback assets, preview them, and apply a replacement poster back to storage and Convex.
  - Current code reference: `src/pages/PlayerPage.tsx`, `src/main/services/TranscodeService.ts`, `src/main/services/BridgeController.ts`
  - Remaining gap: smarter curation or batch poster workflows still belong to future phases.

### Failed Job Handling

- `partial` `P2` Failed ingest visibility and retry
  - The dashboard already surfaces failed ingest jobs, allows fresh retry, supports same-prefix upload resume, and can audit or clean partial cloud uploads.
  - Current code reference: `src/pages/DashboardPage.tsx`, `src/components/JobCard.tsx`
  - Gap: not a dedicated persistent failed-job queue across sessions, and not yet a cross-session historical audit screen.

### Log Visibility

- `partial` `P2` Pipeline and offload logging
  - The app already has a raw pipeline console and on-disk offload logs.
  - Current code reference: `src/components/LogConsole.tsx`, `src/main/services/OffloadService.ts`
  - Gap: no polished operator timeline or filtered history view. Client-facing review history belongs in the web app.

### Cloud Transfer Model

- `partial` `P1` Cloud upload pipeline
  - The app already uploads archive and distribution assets to B2/R2.
  - Current implementation uses rclone and configurable B2/R2 credentials.
  - Remaining gap: migrate playback and social distribution paths toward a native S3-compatible storage client where direct uploads, progress tracking, retry behavior, and lifecycle-aware path selection need tighter app control.

## Planned Feature Backlog

### Phase 1: Media Management Layer

- `done` `P1` Full VOD library management
  - The library now supports browse, search, filter, and non-ready asset views.
  - `draft`, `ready`, `archived`, `error`, `processing`, and `uploading` assets are visible from the desktop app.

- `done` `P1` In-app metadata editing
  - Operators can edit title, description, tags, playlists, series, recorded date, and status without leaving the desktop app.

- `done` `P1` Publish and unpublish controls
  - Explicit desktop controls now map publish and unpublish actions onto the existing Convex-backed status workflow.

- `done` `P1` Manual thumbnail workflow
  - Operators can now extract candidate frames, preview them, choose a poster image, and sync that poster back to storage and Convex.

### Phase 2: CSN Workflow Improvements

- `planned` `P1` `desktop` Auto-ingest of stream recordings
  - Watch for finished vMix or similar event recordings.
  - Auto-trigger ingest with pre-filled event context where possible.
  - Register finished assets to Convex only after local processing and storage upload have produced stable playback URLs.

- `planned` `P1` `shared` Review workflow state model
  - Add workflow states such as `Draft`, `Ready for Review`, `Changes Requested`, `Approved`, and `Published`.
  - Keep these separate from low-level ingest states where appropriate.
  - Desktop should display and update operator states when useful, but the web app should own reviewer-facing approval UX.

- `planned` `P1` `shared` Asset ownership and project/event model
  - Add first-class projects, events/games, organizations, and asset membership records so both apps stop relying only on tags, series, and playlists.
  - Desktop should attach assets to event/project context at ingest time when sidecar metadata or operator choices provide it.
  - Web should use the same model for review rooms, permissions, browse pages, and notifications.

- `planned` `P2` `web` Timestamped review annotations
  - Support frame/timecode comments, replies, resolved state, and reviewer attribution in the browser app.
  - Store comments in Convex by asset and timestamp/frame; do not store unbounded comment arrays on video documents.
  - Desktop may show a read-only or operator-focused comment summary later, but it should not become the primary review client.

- `planned` `P2` `shared` Batch approve and bulk library actions
  - Select multiple assets from a game or event and move them through the next step together.
  - Implement state changes as bounded Convex mutations that can be called from both apps with role checks.

- `planned` `P2` `desktop` Persistent multi-session ingest history
  - Preserve a long-lived job history instead of only session-centric ingest visibility.
  - Sync durable summaries to Convex when useful, but keep verbose local logs and raw file paths workstation-scoped.

- `planned` `P2` `shared` Storage usage dashboard
  - Surface B2 and R2 usage for operator awareness and planning.
  - Desktop can collect/upload storage audits; web can present account/project-level reporting to authorized users.

### Phase 3: Social Distribution Pipeline

- `planned` `P1` `desktop` Native social target export panel
  - Add desktop export toggles for social profiles such as `Reels 9:16`, `Feed 4:5`, and `Native 16:9`.
  - Use local FFmpeg/GPU processing for crop, pad, scale, codec, audio, duration, and container compliance before upload.
  - Register each rendered social asset in Convex with its R2 object key, public or signed fetch URL policy, target platform, aspect profile, source asset, and lifecycle status.

- `planned` `P1` `desktop` Lifecycle-aware R2 upload routing
  - Upload production review/playback packages under `/streaming/`.
  - Upload preemptive social renders under `/staging/social/` so the 24-hour lifecycle rule can clean unused assets.
  - Upload or move scheduled social renders under `/scheduled/social/` before the staging lifecycle can expire them.
  - Prefer a native S3-compatible client for high-throughput direct upload where it improves reliability over rclone for this workflow.

- `planned` `P1` `shared` Social asset and scheduling schema
  - Add social asset records linked to source videos, projects/events, aspect profiles, storage path class, caption drafts, platform target, readiness state, schedule time, and publish result.
  - Track lifecycle states such as `rendering_social`, `ready_for_social`, `scheduled`, `publishing`, `published`, `publish_failed`, and `expired`.
  - Keep social renditions as separate child records rather than adding unbounded social state arrays to video documents.

- `planned` `P1` `web` Social copy and scheduling dashboard
  - Let authorized web users review staged social assets, write captions, choose platform targets, and schedule publish times.
  - Use Clerk-authenticated Convex mutations for all scheduling and copy changes.
  - Keep heavy media handling out of the browser; the web UI should reference R2-backed social assets prepared by the desktop app.

- `planned` `P1` `triggered` Staging-to-scheduled storage protection
  - On transition from `ready_for_social` to `scheduled`, run a trusted backend operation that moves or copies the object from `/staging/social/` to `/scheduled/social/`.
  - Patch Convex only after the protected object key is confirmed.
  - Handle failures by leaving the schedule blocked and surfacing a retryable error in both apps.

- `planned` `P1` `triggered` Meta/Instagram scheduled publishing
  - Use Convex scheduled functions or CRON-style ticks to find due social publishing jobs.
  - Run trusted Convex HTTP actions or backend jobs that call the Meta Graph API with the R2 media URL.
  - Poll container status until the platform marks the upload ready, then publish and record external post IDs, timestamps, and error details in Convex.
  - After successful publish, delete the `/scheduled/social/` object through trusted cleanup and mark the social asset as `published`.

- `planned` `P2` `shared` Social lifecycle observability
  - Show which social assets are staged, scheduled, expired, published, or failed.
  - Alert when a staged asset is approaching its 24-hour deletion window without being scheduled or posted.
  - Include cleanup history so operators can understand when R2 objects were deleted by lifecycle policy versus trusted app cleanup.

### Phase 4: Livestream Operations

- `planned` `P1` `shared` Stream status dashboard
  - Add live/offline monitoring for livestream sources such as vMix tally or SRT stream health.
  - Desktop should poll local production systems and publish lightweight telemetry snapshots to Convex.
  - Web should provide mobile-friendly monitoring for operators away from the control desk.

- `planned` `P2` `triggered` Stream-to-VOD promotion
  - Let a web or desktop operator request promotion of a finished live recording into a reviewable VOD.
  - Store the request in Convex, then let the desktop app locate the local recording, trim/transcode/upload it, and register the finished asset.

- `planned` `P2` `web` Scheduled VOD publishing
  - Allow operators to choose a publish date and time for already-uploaded VOD assets.
  - This is separate from social publishing and should use Convex scheduled functions where state changes are enough.
  - The desktop app should reflect scheduled/published state but should not be required for routine scheduled publishing once assets are already uploaded.

- `planned` `P3` `web` Additional platform publishing integrations
  - Add future publishing integrations for destinations beyond Meta/Instagram using stored metadata and prepared media URLs.

## Additional Gaps To Revisit

- `planned` `P1` `shared` True event and game association model
  - Tags, series, and playlists exist, but there is no first-class event workflow yet.

- `planned` `P2` `triggered` Archive, delete, and restore management
  - Add trusted controls for managing existing assets across Convex and storage targets.
  - Browser users may request archive/delete/restore actions through authorized Convex mutations.
  - Actual cloud deletion should run through a trusted backend action or the desktop app, never through exposed browser storage credentials.
  - Social cleanup must respect lifecycle path class: persistent streaming assets should not be deleted by social post cleanup, and scheduled social assets should be removed after successful publish.

- `planned` `P1` `web` Multi-operator role and auth workflow
  - Clerk-authenticated browser roles are required for the sister app: admin, ingest operator, producer, client reviewer, and public/end-user roles where needed.
  - Desktop should act as a trusted ingest node/admin operator, not as the general client-facing auth surface.

- `planned` `P2` `shared` Ingest node identity and permissions
  - Add a clear machine/service identity for desktop registration calls so Convex can distinguish workstation ingest writes from browser user mutations.
  - Avoid accepting browser-provided user IDs for authorization decisions; derive identity server-side in Convex.

## Suggested Review Order

If this roadmap is revisited later, this is the recommended order:

1. Add richer review workflow states on top of the delivered Phase 1 library.
2. Add the shared project/event/organization model needed by both desktop ingest and browser review.
3. Add the social asset schema and R2 lifecycle contract before building social scheduling UI.
4. Add desktop social target rendering and lifecycle-aware upload routing.
5. Move client-facing review annotations, approvals, auth, social copy, and scheduling into the sister web app.
6. Add Convex/Meta publishing orchestration and trusted cleanup for `/scheduled/social/`.
7. Expand into auto-ingest from stream recordings, livestream health, stream-to-VOD requests, storage dashboards, batch workflows, and additional platform integrations.

## Review Checklist For Future Sessions

When revisiting this roadmap, confirm:

- which items are still relevant to the current CSN workflow
- which items belong in desktop, web, shared Convex schema, or trusted background execution
- which items need backend changes in Convex before either UI should ship
- which items should be grouped into a single implementation milestone
- whether any new livestream or publishing requirements have emerged
- whether any social workflow can expire safely from `/staging/social/` or must be protected under `/scheduled/social/`
- whether a proposed upload route bypasses the desktop app's responsibility for local GPU rendering and storage transfer
- whether any proposed feature violates the boundary that desktop owns local/heavy media work and web owns human collaboration

# Convex Deployment Topology

Where the backend lives, who owns it, who may call it, and why the media
pipeline shares a deployment with the CSN sports site instead of running its own.

Decided: September 8, 2026

Companion documents: `MEDIA_PIPELINE_ARCHITECTURE.md`, `STORAGE_LAYOUT.md`,
`HYBRID_ORCHESTRATION.md`, `OPERATOR_SETUP_TASKS.md`.

## 1. The Shape

```
                    ┌──────────────────────────────────────┐
                    │   Convex deployment (CSN sports)     │
                    │                                      │
   Sports site  ───▶│  content, games, teams, players …    │
   (Next.js)        │  media_videos, render_jobs, …        │◀─── the Asset Manager
                    │                                      │     (browser
   Viewers ────────▶│  convex/media/catalog.ts  (public)   │      renders,
   (unauthenticated)│                                      │      scheduling)
                    │  convex/media/*          (staff+node)│
   Media Bridge ───▶│                                      │
   (desktop node)   └──────────────────────────────────────┘
                              ▲
                              │  one codebase pushes here:
                              │  Websites/csn
```

**The sports app repository owns the Convex codebase.** `Websites/csn/convex/`
is the only source that may be deployed.

## 2. Why One Deployment

A Convex deployment can be pushed to by exactly one codebase — `npx convex
deploy` replaces the whole function set, so two repos pointing at one deployment
means whichever deploys last silently deletes the other's functions. That makes
"which repo owns it" a decision that has to be made rather than drifted into.

Beyond that mechanical fact, three things argued for merging the media pipeline
into the sports deployment rather than keeping it separate:

- **The viewer page needs one query.** A game page shows a video alongside its
  game, team, and article context. Across two deployments that cannot be one
  reactive subscription; it becomes a server-side fan-out with no reactivity and
  hand-maintained cache invalidation — a permanent tax on the exact experience
  the pipeline exists to serve.
- **`ctx.scheduler` and transactions do not cross deployments.** The publish
  flow spans `media_social_posts` → `social_renders` → `media_videos`. Split
  apart, "publish succeeded, mark it published, queue the cleanup" cannot be
  atomic, and the gap would have to be papered over with hand-rolled distributed
  consistency for no gain.
- **One auth configuration.** Clerk is already wired into the sports deployment.
  A second deployment would mean a second `auth.config.ts`, a second set of
  environment variables, and two places to get role checks right.

**When this decision should be revisited:** if CSN ever runs several client
sports sites off one media operation. At that point no single site's schema is
the natural home, and the media pipeline should become its own deployment
consumed as a service. Today the sports site is the only consumer.

## 3. Two Records Per Video

The sports app already had a content catalog. The merge does **not** collapse it
into the media pipeline's `videos` table — they are two halves of different
problems, and they stay linked rather than merged:

| | `content` | `media_videos` |
| --- | --- | --- |
| Answers | What the viewer sees | Where the bytes are |
| Owns | Title, poster, sport/team/game links, editorial workflow | Storage keys, encoder, delivery type, pipeline state |
| Written by | Editors, in the sports admin | The ingest node and the Asset Manager |
| Status means | `draft → pending_review → approved → published → archived` | `processing → uploading → ready / error` |

Linked by `content.media_video_id` and `media_videos.contentId`.

Kept separate because:

- `content` rows of type `series` and `show` have no media file at all.
- One editorial item can outlive and re-point at several renditions.
- Pipeline state is high-churn. Putting encoder progress on the row the public
  site subscribes to would invalidate viewer-facing queries on every tick.
- Collapsing an editorial workflow and a pipeline state into one enum loses
  both.

**The consequence that matters for UX:** publication is an editorial decision.
A media record reaching `ready` means the encode finished, not that anyone
approved it. Only a `content` row with `status: "published"` puts a video in
front of viewers.

## 4. Table Mapping

Media Bridge tables were renamed to the sports schema's snake_case convention on
the way in:

| Media Bridge | Sports deployment |
| --- | --- |
| `videos` | `media_videos` |
| `socialPosts` | `media_social_posts` |
| `renderJobs` | `render_jobs` |
| `socialRenders` | `social_renders` |
| `desktopNodes` | `desktop_nodes` |
| `desktopJobEvents` | `desktop_job_events` |
| `storageTasks` | `storage_tasks` |
| `playlists` | `media_playlists` |
| `playlistItems` | `media_playlist_items` |

`videos` → `media_videos` was not merely cosmetic: a table called `videos` sitting
beside a `content` table that holds videos is a standing invitation to write to
the wrong one.

Field names inside the media tables stay camelCase. The Electron client and its
shared TypeScript types already speak camelCase across roughly fifteen thousand
lines; converting them would be a mechanical mass-rename with real regression
risk and no functional benefit. **The boundary is the table**: editorial tables
are snake_case throughout, media tables are snake_case outside and camelCase
within.

Table definitions live in `Websites/csn/convex/mediaSchema.ts` and are spread
into the main schema, so the editorial model stays readable next to them.

## 5. Who May Call What

Three callers reach the deployment, and they are not interchangeable.

| Caller | Credential | Surface |
| --- | --- | --- |
| Viewer | none | `convex/media/catalog.ts` only |
| Staff operator | Clerk session with the CSN admin role | All of `convex/media/*` |
| Desktop ingest node | Provisioned node token | Worker functions and library reads |

### The public surface is one file

`convex/media/catalog.ts` is the only unauthenticated entry point into the media
pipeline. Everything else requires a node token or a CSN admin session. Keeping
it to one small file makes the security review a question that can actually be
answered — "is this file safe" — rather than one nobody finishes: "are all
thirty-odd media functions safe."

That file projects fields explicitly rather than returning rows.
`media_videos` carries storage keys, fingerprints, encoder details, node names,
and error messages; returning the document would publish the bucket layout to
anyone with devtools open.

### The desktop authenticates as a machine

The ingest worker heartbeats, claims render jobs, and executes storage tasks
with nobody signed in, often overnight. It authenticates with a provisioned
token from `MEDIA_BRIDGE_NODE_TOKENS`, not a human session — a render queue that
stops because an operator's session expired at 3am is a broken ingest station.

Operator identity is separate and is used for attribution and for authorizing
destructive actions. `enqueueRenderJob` now derives the requester from the
verified Clerk identity; `requestedBy` remains a display label and is never used
to authorize.

The node-token pattern follows `requireCsnAdminOrServiceTokenInConvex` in
`convex/csnAdminAuth.ts`, which already established it for the live game API.
Multiple comma-separated tokens are supported so one workstation can be rotated
or revoked without taking every other node offline.

**What a node token can do.** It is a trusted-workstation credential, not a
read-only one. Because the desktop app's library view lets an operator edit
metadata and delete stored videos, `updateVideoMetadata` and `deleteVideo`
accept it. A leaked token can therefore alter the media library — though not
publish anything to viewers, which requires an editorial change to `content`,
and not reach the sports schema, which these functions never touch. Issue one
token per workstation so a lost laptop can be revoked on its own, and treat
token rotation as the response to a lost machine.

The current gate assignments:

| Gate | Accepts | Functions |
| --- | --- | --- |
| `requireMediaNode` | node token or CSN admin | Worker surface, library reads and writes, ingest registration |
| `requireMediaOperator` | CSN admin only | Render requests, scheduling, promotion, browser handoff, retries |
| `requireMediaOperatorRead` | CSN admin only | Queue, node, and event monitoring |
| none | anyone | `catalog.ts` only |

**Known tradeoff:** a token passed as a function argument appears in the Convex
dashboard's function log. That is accepted for the existing service-token path,
so this follows it rather than introducing a second inconsistent scheme — but it
means node tokens are rotatable credentials, not permanent secrets.

## 6. What Changed In The Desktop App

The desktop is now a pure client of a backend it does not own:

- Function paths are namespaced: `media/videos:createVodEntry`,
  `media/orchestration:claimNextRenderJob`, `media/storage:claimNextStorageTask`.
- The node token is injected once in the Convex client factory rather than at
  each call site, so a missed argument cannot fail one operation at runtime on
  an operator's machine.
- The token is stored beside the B2 and R2 secrets, encrypted at rest by the
  same `safeStorage` path.

### The compatibility rule

Desktop builds ship to workstations and cannot be upgraded in lockstep, so the
backend must lead and outlive any given desktop version:

> **Additive changes only while old desktop versions are in the field.** Never
> remove or rename a media function, and never narrow an argument validator. A
> workstation two releases behind must keep claiming jobs.

## 7. The Old `convex/` Directory In This Repo

`CsnMediaBridge/convex/` has been ported to `Websites/csn/convex/` and is no
longer the source of truth. It is left in place for now rather than deleted
because several of its files were never committed, so removing them would be
unrecoverable.

**Do not run `npx convex deploy` from this repository.** Doing so would replace
the sports deployment's entire function set with the media functions alone,
deleting the sports site's backend.

Delete the directory once the merge is confirmed deployed — see
`EXECUTION_ROADMAP.md`, Phase 3.5.

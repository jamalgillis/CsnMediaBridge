# Media Pipeline Architecture

This is the canonical record of the CSN media pipeline design: the problem it
solves, the cooperative browser/desktop execution model, the output formats it
produces, and how storage lifecycle keeps recurring cloud cost near zero.

Companion documents:

- `CONVEX_DEPLOYMENT_TOPOLOGY.md` — which deployment this runs on, who owns the
  Convex codebase, and who may call what.
- `STORAGE_LAYOUT.md` — the exact Backblaze B2 and Cloudflare R2 directory
  contracts, lifecycle rules, and Convex field mapping.
- `HYBRID_ORCHESTRATION.md` — the Convex function contract between the desktop
  worker and the web command center.
- `OPERATOR_SETUP_TASKS.md` — the configuration work that must be done by a
  human in a provider dashboard.
- `EXECUTION_ROADMAP.md` — the phased delivery plan.

Last reviewed: September 8, 2026

## 1. The Problem

Bridging a client-side editorial workflow (the Studio CMS / Asset Manager) with
a multi-platform distribution engine means running long video transcode tasks
somewhere. Every obvious "somewhere" has a real cost:

### 1.1 Cloud transcoding is expensive

Transcoding large, high-bitrate camera files into social-ready H.264/MP4 in the
cloud — Mux, serverless workers, container jobs — bills per compute minute. A
newsroom or sports operation producing dozens of clips per event turns that into
a recurring line item that scales with output volume rather than with value.

### 1.2 Uploading masters wastes bandwidth

A 12 GB multi-camera master uploaded to the cloud only to produce a 45 MB
vertical clip is a ~250:1 waste ratio on the ingest leg. On a venue uplink that
is not a cost problem, it is a *time* problem: the upload becomes the bottleneck
that decides whether a highlight clip posts during the game or after it.

### 1.3 The browser cannot carry heavy jobs alone

`ffmpeg.wasm` inside Chrome removes cloud compute cost, but it introduces hard
client-side limits:

- **Memory ceilings.** Chrome tabs hard-crash when V8/WASM allocations exceed
  roughly 2–4 GB. Large sources cannot be held in a browser heap at all.
- **No hardware acceleration.** WebAssembly executes on an unaccelerated virtual
  CPU thread. It cannot reach NVENC, Quick Sync, or the Apple Silicon media
  engines, so it runs an order of magnitude slower than native FFmpeg on the same
  machine.
- **Tab dependency.** Closing the tab, sleeping the laptop, or a renderer OOM
  kills the job with no durable state and no resume path.

The conclusion is not "pick one." It is that short work belongs in the browser
where it is instant and free, and heavy work belongs on a machine with a GPU and
a local disk — with a durable handoff between the two.

## 2. The Solution: Browser-First With Desktop Handoff

The pipeline is a cooperative hybrid managed by a unified backend. Convex is the
single source of truth; neither client controls the other directly.

```
  Asset Manager                Convex                 CSN Media Bridge
  browser worker            state machine +              desktop node
  ffmpeg.wasm                 scheduler                native FFmpeg + GPU
        |                         |                            |
        |  enqueue renderJob      |                            |
        |------------------------>|                            |
        |  (executorType=browser) |                            |
        |                         |   claimNextRenderJob       |
        |   [ Offload pressed ]   |<---------------------------|
        |------------------------>|   (executorType=desktop)   |
        |  offloadRenderJobToDesktop                           |
        |                         |   progress / lease renew   |
        |                         |<---------------------------|
        |   live subscription     |   completeRenderJob        |
        |<------------------------|<---------------------------|
        |                         |                            |
        |                    scheduler.runAt()  --> publish to platform APIs
```

### 2.1 Browser-first execution (default path)

Short clips and small assets are encoded immediately inside a background Web
Worker using `ffmpeg.wasm`. Before starting, the frontend inspects `file.size`
and the requested output:

- Under the safety threshold (default **1.5 GB**): encode in the browser. No
  upload of the master, no cloud compute, result in seconds to low minutes.
- Over the threshold: skip the browser entirely and enqueue a desktop job. This
  is a pre-emptive bypass, not a failure path — the tab never gets the chance to
  OOM.

The threshold is a policy value, not a law of physics. It is deliberately
conservative because a crashed tab costs the operator more than a slightly
slower desktop render.

### 2.2 The desktop-handoff "panic button"

At any point during a browser render the operator can press **Offload to Desktop
Worker**. This is the escape hatch for the three cases the size check cannot
predict: a render that is running slower than expected, a laptop that needs to
close, and a source that is small on disk but expensive to encode.

On press:

1. The browser terminates its Web Worker thread immediately, freeing the heap.
2. The frontend calls `orchestration:offloadRenderJobToDesktop`.
3. Convex flips the job's `executorType` from `browser` to `desktop` and returns
   it to `queued`, discarding partial browser progress.
4. The next healthy desktop node claims it.

No work is lost that mattered — a partial WASM encode has no reusable output —
and the operator's machine is free within one animation frame.

### 2.3 The unified Convex state machine

The discussion-level states map onto the schema as follows. There is one status
enum plus an executor discriminator, rather than parallel per-executor enums:

| Conceptual state     | `executorType` | `status`               |
| -------------------- | -------------- | ---------------------- |
| `browser_processing` | `browser`      | `claimed` / `rendering`|
| `desktop_queued`     | `desktop`      | `queued`               |
| `desktop_processing` | `desktop`      | `rendering`            |
| `uploading`          | either         | `uploading`            |
| `ready`              | either         | `ready`                |
| `failed`             | either         | `failed`               |

Keeping one status enum means the queue query, the lease reaper, the retry path,
and the Asset Manager progress UI are written once and work for both executors.

### 2.4 Desktop execution and direct upload

The desktop node monitors Convex over a live connection and claims work under a
short lease. It then:

1. Resolves the source. If the raw file is still on local disk it uses that path
   directly. Otherwise it pulls the master from Backblaze B2 using the video's
   `archiveObjectKey`.
2. Transcodes with native hardware acceleration — NVENC on Windows/NVIDIA,
   VideoToolbox on Apple Silicon, software fallback otherwise.
3. Streams the finished MP4 straight to Cloudflare R2 under the lifecycle path
   that matches the job's `storageClass`.
4. Calls `completeRenderJob`, which registers a `social_renders` row and marks the
   job `ready` in the same transaction.

The master never traverses the public internet to reach a cloud encoder. Only
the finished, compressed artifact is uploaded.

### 2.5 Lease and retry model

Jobs are claimed with a lease (default 60s, renewed every 30s while working). If
a desktop dies mid-job, the lease expires and another node — or the same node
after restart — reclaims the job. `attempts` is incremented on each claim and
capped by `maxAttempts` so a poison job fails loudly instead of looping.

### 2.6 Automated scheduled delivery

Once a render lands in R2 and a publish time is set, Convex owns the clock. A
cron tick finds due `media_social_posts`, and a trusted action dispatches the R2 URL to
the Meta Graph API, TikTok Content Posting API, or YouTube Data API. Platforms
fetch the bytes from R2 directly — the browser never proxies media, and no
storage credentials leave the trusted boundary.

## 3. What The Pipeline Produces

The same source feeds both distribution surfaces because both outputs are
standard, universally supported media.

### 3.1 Social clips — flat MP4

Platform APIs require a downloadable, flat file: H.264 video, AAC audio, MP4
container. The pipeline produces vertical (9:16), square (1:1), portrait feed
(4:5), or native widescreen (16:9) variants, trimmed and reframed to the target.

Whether the encode ran in the browser Web Worker or on the desktop node, the
output file is byte-for-byte the same *kind* of artifact. Only the speed and the
size ceiling differ.

### 3.2 VOD streaming — CMAF HLS with DASH sidecar

Serving a flat MP4 to a web player wastes bandwidth and buffers on weak
connections. For portal and article playback the pipeline produces a
CMAF-compatible package: a `master.m3u8` HLS playlist, a `manifest.mpd` DASH
manifest, and one shared set of fragmented MP4 segments at multiple resolutions.
Both manifests point at the same per-variant init files and `.m4s` files, so supporting DASH
clients does not double playback storage.

The desktop node generates the full ladder with native FFmpeg and uploads the
package directory to R2 under `streaming/`. Mux remains a viable alternative
ingest path if a stream needs to exist without a desktop node available.

The `requestedDelivery` field decides which of these a given ingest produces;
`auto` routes clips at or under 60 seconds to progressive MP4 and everything
longer to HLS.

### 3.3 Master archive

The original high-bitrate camera file is archived to Backblaze B2 unmodified. It
is never served to viewers and never used for playback — it exists so any future
re-edit, re-clip, or re-encode can start from full quality instead of from a
delivery render.

### 3.4 Summary matrix

| Output          | Format                          | Storage                      | Destination                                   |
| --------------- | ------------------------------- | ---------------------------- | --------------------------------------------- |
| Social clip     | Flat `.mp4` (H.264 / AAC)       | R2 `staging/` → `scheduled/` | TikTok, Reels, Shorts, Facebook, X, YouTube    |
| VOD stream      | `.m3u8` + `.mpd` + `.m4s` segments | R2 `streaming/`            | Web portal, newsroom CMS articles, app player  |
| Poster / still  | `.jpg` / `.webp`                | R2 `posters/`, B2 `stills/`  | Thumbnails, article cards, social preview      |
| Master archive  | Original `.mov` / `.mp4`        | B2 `masters/`                | Cold vault for re-editing and re-clipping      |

## 4. Storage Lifecycle And Cost

The two storage providers have deliberately different jobs. Mixing them is what
makes media bills unpredictable.

### 4.1 Backblaze B2 — the permanent cold vault

Masters, offload card dumps, and archived stills live here forever. B2 is chosen
for storage price. Its egress cost is why nothing is *served* from it directly at
scale — retrieval is an operator action, not a viewer action.

### 4.2 Cloudflare R2 — the ephemeral launchpad and streaming buffer

R2 has **zero egress fees**. When TikTok or Instagram pulls a video from an R2
link during publishing, that transfer costs nothing. Storage is roughly
$0.015/GB-month with the first 10 GB free — so the entire cost strategy is
simply *keep the resident footprint small*.

R2 holds two categories:

- **Persistent:** `streaming/` and `posters/`. These power the VOD player and
  article cards continuously and are never auto-expired.
- **Ephemeral:** `staging/social/` and `scheduled/social/`. These are launchpads,
  not storage.

### 4.3 Social clip retention timeline

| Stage                | Path                     | Retention                   | Rationale                                                                 |
| -------------------- | ------------------------ | --------------------------- | ------------------------------------------------------------------------- |
| Staging / pre-publish| `staging/social/`        | 72 hours                    | Preview the social card, make quick edits, ride out a platform API outage. |
| Protected scheduled  | `scheduled/social/`      | Until publish + 24 hours    | A post scheduled two weeks out must survive until it fires.               |
| Post-publish         | —                        | Delete on verified publish  | The platform has copied the bytes to its own CDN; the R2 copy is dead weight. |

The critical transition is **staging → scheduled**. A staging object is on a
72-hour fuse. The moment a render is attached to a scheduled post, a trusted
backend operation copies it into `scheduled/social/` *before* that fuse can
reach it, and only then is the Convex record patched to the protected key. If the
copy fails, the schedule stays blocked and surfaces a retryable error — it never
silently points at an object that is about to evaporate.

### 4.4 Deleting from R2 does not touch B2

This is the property that makes aggressive R2 cleanup safe. Purging a social
clip from `staging/` or `scheduled/` has **no effect** on the master in B2. The
master is the durable artifact; every R2 object is a derivative that can be
regenerated from it.

The single exception is an explicit operator **Delete Asset** action in the
Library, which is defined to purge the Convex record *and* its linked cloud
objects including the B2 archive. That path is deliberately separate, explicit,
and confirmable.

## 5. Working With Archived Media

Staff never log into a Backblaze dashboard. The application is the only interface
to the archive.

### 5.1 Browsing and playback without provider logins

- **The index lives in Convex.** At ingest, Media Bridge writes the
  `archiveObjectKey` into the video record. Convex is the searchable catalog.
- **URLs are minted on demand.** The B2 bucket stays private. A trusted backend
  path (a Convex action or the desktop main process) uses the stored credentials
  to generate a short-lived presigned URL for a specific object.
- **The player consumes the URL.** A React `<video>` element or `<img>` receives
  the presigned URL and plays or renders immediately. To the operator it is a
  thumbnail grid and a click.

Credentials never reach a browser. The presigned URL is scoped to one object and
expires.

### 5.2 Retrieving an archived asset for processing

**On the desktop node** — the normal path, because it owns local disk, FFmpeg,
and hardware encoders:

1. The operator selects an archived asset and chooses *Retrieve for Processing*
   or *Create Clip*.
2. The app pulls the master from B2 to a local working folder.
3. Local FFmpeg trims, crops, and re-encodes using GPU acceleration.
4. New renders are uploaded to R2 and registered in Convex.

**From the web app** — when no desktop tooling is present:

1. The web user requests a clip of an archived asset.
2. Convex records the intent as a `renderJob` with `executorType: "desktop"`.
3. A studio desktop node wakes, pulls the master (or uses its local copy),
   encodes with hardware acceleration, and reports back.

The web app expresses intent; it never receives storage credentials and never
proxies large media.

### 5.3 What the operator sees

| Action                 | In the app                                        | In the stack                                                     |
| ---------------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| Browsing archives      | Visual library grid with search and filters       | Convex `videos` query; thumbnails via `posters/` or presigned URL |
| Viewing media          | Click an asset, playback in the preview player    | HLS from R2 `streaming/`, or presigned B2 URL for a raw master    |
| Retrieving/processing  | *Trim Clip* / *Re-process Asset*                  | Worker streams the B2 master into FFmpeg, uploads new renders     |

## 6. Boundary Rules

These rules resolve most "where does this belong" questions without further
debate:

1. **The desktop owns bytes on disk.** Local files, watch folders, FFmpeg,
   hardware encoders, rclone/S3 transfers, and workstation credentials.
2. **The web owns humans.** Auth, review, comments, approvals, captions,
   scheduling, and notifications.
3. **Convex owns truth.** Asset records, workflow state, job queues, telemetry,
   and the scheduler.
4. **Browsers state intent; they do not execute privileged work.** A browser may
   request a destructive or heavy action. It never receives B2 or R2 account
   credentials, and it never proxies a large upload.
5. **Platform APIs fetch from R2 directly.** The web app is never an intermediate
   loader for Meta, TikTok, or YouTube media.
6. **Derivatives are disposable; masters are not.** Anything in R2 can be
   rebuilt from B2. Nothing in B2 is deleted by a lifecycle rule.

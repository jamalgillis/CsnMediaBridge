# CSN Media Bridge

CSN Media Bridge is a cross-platform Tauri desktop app for automated sports media ingest and operator-facing VOD management. It watches a folder for new video files, waits until each file is stable, automatically routes short-form clips to progressive playback and longer content to CMAF-compatible HLS/DASH playback, uploads the source and distribution assets with `rclone`, and then registers the finished playback metadata with Convex. It also includes a Convex-backed library for search, metadata editing, publish control, and poster replacement, plus a manual Offload page for post-shoot folder handoff, local package creation on a designated drive, checksum-tracked `webp` image generation, and optional Backblaze B2 upload for still-image assets only.

## Documentation

- Process guide: [`docs/APP_PROCESS.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/APP_PROCESS.md)
- First-time client setup: [`docs/CLIENT_FIRST_TIME_SETUP.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/CLIENT_FIRST_TIME_SETUP.md)
- Settings guide: [`docs/SETTINGS_GUIDE.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/SETTINGS_GUIDE.md)
- Connection profiles: [`docs/CONNECTION_PROFILES.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/CONNECTION_PROFILES.md)
- Feature guide: [`docs/FEATURES.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/FEATURES.md)
- Convex deployment topology: [`docs/CONVEX_DEPLOYMENT_TOPOLOGY.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/CONVEX_DEPLOYMENT_TOPOLOGY.md)
- Media pipeline architecture: [`docs/MEDIA_PIPELINE_ARCHITECTURE.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/MEDIA_PIPELINE_ARCHITECTURE.md)
- Storage layout contract: [`docs/STORAGE_LAYOUT.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/STORAGE_LAYOUT.md)
- Operator setup tasks: [`docs/OPERATOR_SETUP_TASKS.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/OPERATOR_SETUP_TASKS.md)
- Execution roadmap: [`docs/EXECUTION_ROADMAP.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/EXECUTION_ROADMAP.md)
- Tauri and livestream handoff roadmap: [`docs/TAURI_LIVESTREAM_ROADMAP.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/TAURI_LIVESTREAM_ROADMAP.md)
- Tauri architecture: [`docs/TAURI_ARCHITECTURE.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/TAURI_ARCHITECTURE.md)
- Live stream handoff contract: [`docs/LIVE_STREAM_HANDOFF.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/LIVE_STREAM_HANDOFF.md)
- Product roadmap: [`docs/ROADMAP.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/ROADMAP.md)
- Hybrid orchestration contract: [`docs/HYBRID_ORCHESTRATION.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/HYBRID_ORCHESTRATION.md)
- Developer overview: [`docs/DEVELOPER_OVERVIEW.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/DEVELOPER_OVERVIEW.md)
- Sales summary: [`docs/SALES_SUMMARY.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/SALES_SUMMARY.md)
- Scope of work: [`docs/SCOPE_OF_WORK.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/SCOPE_OF_WORK.md)
- Release guide: [`docs/RELEASING.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/RELEASING.md)

## Developer Overview

For a quick technical orientation, start with [`docs/DEVELOPER_OVERVIEW.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/DEVELOPER_OVERVIEW.md).

At a high level, the app currently provides:

- automated watch-folder ingest for new source videos
- FFmpeg-based processing for progressive, CMAF HLS/DASH, poster, image conversion, and trim workflows
- cloud transfer through Backblaze B2 and Cloudflare R2
- Convex registration of finished media records
- Convex-backed VOD library for search, filtering, metadata editing, publish controls, and poster replacement
- manual offload of full shoot folders with resumable logging and optional image-only upload
- built-in library preview and trimmer tools for operators

## VOD Library Workflow

The `/player` route now acts as a VOD library and management surface instead of a preview-only page.

- Browse the full stored-video library from Convex instead of only ready assets.
- Search and filter by title, source file, tags, playlists, series, and status.
- Edit title, description, tags, playlists, series, recorded date, and status from the desktop app.
- Publish and unpublish assets by moving them between `ready` and `draft`.
- Generate poster-frame candidates from a stored playback asset, apply the selected poster back to Cloudflare R2, and sync the new poster URL to Convex.

## Stack

- Tauri (Rust host) + React + Tailwind CSS
- `pnpm` for install and script execution
- The Rust host in `src-tauri/src/lib.rs` drives FFmpeg, rclone and Convex directly
- Settings persist as JSON under the OS application-support directory

The renderer in `src/` talks to the host through `window.mediaBridge`, which
`src/tauriBridge.ts` maps onto Tauri commands. Nothing in the renderer knows
which host it is running on.

## Running it

```bash
pnpm install
pnpm run dev
```

For packaging:

```bash
pnpm run build
```

`pnpm run build` produces installers under `src-tauri/target/release/bundle/`.

## Sign-in

The app has two identities: the **station**, which holds a machine credential
and runs the pipeline unattended, and the **operator**, a Clerk user whose team
decides what they can see in the window. Ingest keeps running while nobody is
signed in — that is deliberate on a node meant to run overnight.

Signing in happens in the operator's real browser over OAuth 2.0 with PKCE and
a loopback redirect — Google and most providers refuse OAuth from an embedded
webview, and the tokens stay in the host rather than in webview storage.

It is off unless the station has an issuer and a client id, set either at build
time or per station under Settings → advanced → Sign-in:

```bash
CLERK_OAUTH_ISSUER=https://accounts.example.com \
CLERK_OAUTH_CLIENT_ID=your_client_id \
pnpm run build
```

See [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) for the model, why
playback is still served from a public bucket, and what signing in does **not**
protect.

## Storage credentials

A station can hold the master B2 and R2 keys, or it can fetch short-lived scoped
ones from the broker in [`worker/`](worker/README.md) — set under Settings →
advanced → Storage credentials. With a broker configured, a leaked station is
write access to one prefix for a few hours rather than delete access to
everything. Stations fall back to their local keys if the broker is unreachable.

## System Requirements

The app expects these CLIs to be available on your system `PATH`:

- `ffmpeg`
- `ffprobe`
- `rclone`

Packaged Tauri builds resolve these tools from the current `PATH`, common macOS
install paths such as `/opt/homebrew/bin` and `/usr/local/bin`, or explicit
environment overrides:

- `CSN_FFMPEG_PATH`
- `CSN_FFPROBE_PATH`
- `CSN_RCLONE_PATH`

If a GUI-launched build reports `Could not start ffprobe` even though your
terminal can run it, install this packaged build or set the matching override to
the absolute binary path.

## Platform Encoder Behavior

- `win32`: `-hwaccel cuda` with `h264_nvenc` and `-b:v 5M`
- `darwin`: `-hwaccel videotoolbox` with `h264_videotoolbox` and `-q:v 60`
- Other platforms fall back to software `libx264` so development can still proceed

The ingest pipeline now supports two delivery modes:

- `progressive` for short-form clips, exporting `H.264 MP4` plus a best-effort `AV1 WebM` rendition
- `hls` for long-form VOD, exporting a four-rung `1080p / 720p / 480p / 360p` CMAF-compatible ladder

Long-form VOD output is packaged as:

- `master.m3u8`
- `manifest.mpd`
- variant playlists
- per-variant init files such as `init_0.mp4`
- `.m4s` segments

The HLS and DASH manifests point at the same fragmented MP4 media chunks, so the
R2 playback package does not duplicate segment storage for each protocol.

## Configuration

Set these values in the app Settings screen:

- Watch folder
- Temporary output folder
- Manual offload folder
- Offload local copy mode
- Backblaze B2 bucket, key ID, application key, and archive prefix
- Backblaze offload prefix for manual image uploads
- Cloudflare R2 account ID, bucket, public base URL, access key, secret key, and distribution prefix
- Convex deployment URL and mutation path
- Optional app update feed base URL and check interval
- Optional hardware encoder override
- Auto progressive threshold in seconds

Settings are written as JSON to the OS application-support directory, readable only by the signed-in user account.

## App Updates

The desktop app can check for new packaged releases and present the appropriate update action for each platform.

- The app reads an update feed base URL from Settings.
- At runtime it checks `.../darwin/arm64/RELEASES.json` on macOS arm64 and `.../win32/x64/RELEASES` on Windows x64.
- The app reads an update feed base URL from Settings and polls
  `{baseUrl}/latest.json` on launch and on the configured interval.
- The feed is an operator setting rather than a build-time constant, so a
  station can be pointed at a different release host without a rebuild.
- Updates install in place on both platforms and the app restarts into the new
  version.
- Every artifact is signed, and Tauri verifies that signature before it writes
  anything. An unsigned or tampered artifact is refused, which is what makes
  this safe even though the macOS bundle itself is not notarized.

Releases need a signing key — see [`docs/RELEASING.md`](docs/RELEASING.md).

For release-host setup and the current Windows/macOS update policy, see [`docs/RELEASING.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/RELEASING.md) and [`.env.release.example`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/.env.release.example).

The repo includes a tag-driven GitHub Actions release workflow at
[release.yml](.github/workflows/release.yml) that builds the macOS and Windows
bundles and attaches the installers to a GitHub Release.

## Pipeline Overview

1. Watcher detects a new MP4 in the ingest folder.
2. File-ready checks wait for stable size and modified time before queueing.
3. The app inspects duration and sidecar metadata to resolve `progressive` vs `hls`.
4. FFmpeg generates either progressive clip renditions or a CMAF HLS/DASH ladder.
5. `rclone` copies the original source to Backblaze B2.
6. `rclone` copies the distribution folder to Cloudflare R2.
7. Convex receives the finished playback metadata, HLS/DASH manifest URLs when applicable, and progressive sources when applicable.

## Manual Offload Workflow

1. Open the `Offload` page and choose a shoot folder.
2. The app copies the full folder into the configured offload destination as a dated package, mirroring the source directly in the package root.
3. Each package includes an on-disk `offload-manifest.json` and `offload.log` so partial work can be referenced and resumed later.
4. Local offloads use fast metadata-based copy by default so first-time packages land sooner, while a safe checksum mode is available in Settings when stricter local verification is preferred.
5. When enabled, PNG and JPEG assets are mirrored into a `web-ready` folder as `webp` files for website use.
6. When enabled, only still-image assets are uploaded to Backblaze B2 under the configured offload prefix.
7. Video files remain local on the configured offload drive and are not uploaded.
8. The offload page supports pause and cancel controls, and resuming the same source and label reuses the existing package instead of starting from scratch.

## Notes

- The current Convex request payload is implemented in [`src/main/services/ConvexService.ts`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/src/main/services/ConvexService.ts) and is easy to adjust if your mutation expects a different argument shape.
- On Windows production systems, use the folder picker instead of hardcoding paths so you can switch to locations like `C:\\Streaming\\Ingest` without touching the code.

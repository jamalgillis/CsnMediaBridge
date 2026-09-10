# CSN Media Bridge

CSN Media Bridge is a cross-platform Electron desktop app for automated sports media ingest and operator-facing VOD management. It watches a folder for new video files, waits until each file is stable, automatically routes short-form clips to progressive playback and longer content to CMAF-compatible HLS/DASH playback, uploads the source and distribution assets with `rclone`, and then registers the finished playback metadata with Convex. It also includes a Convex-backed library for search, metadata editing, publish control, and poster replacement, plus a manual Offload page for post-shoot folder handoff, local package creation on a designated drive, checksum-tracked `webp` image generation, and optional Backblaze B2 upload for still-image assets only.

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

- Electron + React + Tailwind CSS
- `pnpm` for install and script execution
- `fluent-ffmpeg` for FFmpeg orchestration
- `chokidar` for ingest-folder monitoring
- `electron-store` for persisted settings
- Convex HTTP client support via the current official `convex` package

## Bootstrap

To start from the same scaffold this project expects:

```bash
pnpm dlx @quick-s/electron-app csn-media-bridge
cd csn-media-bridge
pnpm install
```

Then install the project dependencies and start the app:

```bash
pnpm install
pnpm run dev
```

For packaging:

```bash
pnpm run build
pnpm run make
```

To generate updater-ready release metadata for hosted desktop updates, package with an update base URL:

```bash
APP_UPDATE_BASE_URL=https://downloads.example.com/csn-media-bridge pnpm run make
```

## System Requirements

The app expects these CLIs to be available on your system `PATH`:

- `ffmpeg`
- `ffprobe`
- `rclone`

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

The app stores settings with `electron-store` and encrypts secret fields with Electron safe storage when the OS supports it.

## App Updates

The desktop app can check for new packaged releases and present the appropriate update action for each platform.

- The app reads an update feed base URL from Settings.
- At runtime it checks `.../darwin/arm64/RELEASES.json` on macOS arm64 and `.../win32/x64/RELEASES` on Windows x64.
- On Windows, the app uses the native Electron / Squirrel updater flow.
- On macOS, the app checks for newer builds and opens the hosted download. Users may still need to approve the app in `Privacy & Security` after replacing it.
- Existing installs need one manual upgrade to a version that includes the updater. After that, future builds can be discovered in-app.

When you build a release with `APP_UPDATE_BASE_URL` set, Electron Forge will generate the macOS update manifest alongside the zip artifact so you can upload both to your release host.

For release-host setup and the current Windows/macOS update policy, see [`docs/RELEASING.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/RELEASING.md) and [`.env.release.example`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/.env.release.example).

The repo also includes a tag-driven GitHub Actions release workflow at [release.yml](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/.github/workflows/release.yml) that is designed to publish GitHub Releases and deploy the updater feed to GitHub Pages.

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

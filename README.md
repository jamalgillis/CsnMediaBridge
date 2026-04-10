# CSN Media Bridge

CSN Media Bridge is a cross-platform Electron desktop app for automated sports media ingest. It watches a folder for new video files, waits until each file is stable, automatically routes short-form clips to progressive playback and longer content to HLS, uploads the source and distribution assets with `rclone`, and then registers the finished playback metadata with Convex.

## Documentation

- Process guide: [`docs/APP_PROCESS.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/APP_PROCESS.md)
- First-time client setup: [`docs/CLIENT_FIRST_TIME_SETUP.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/CLIENT_FIRST_TIME_SETUP.md)
- Settings guide: [`docs/SETTINGS_GUIDE.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/SETTINGS_GUIDE.md)
- Feature guide: [`docs/FEATURES.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/FEATURES.md)
- Release guide: [`docs/RELEASING.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/RELEASING.md)

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
- `hls` for long-form VOD, exporting a four-rung `1080p / 720p / 480p / 360p` ladder

HLS output is packaged as:

- `master.m3u8`
- variant playlists
- per-variant init files such as `init_0.mp4`
- `.m4s` segments

## Configuration

Set these values in the app Settings screen:

- Watch folder
- Temporary output folder
- Backblaze B2 bucket, key ID, application key, and archive prefix
- Cloudflare R2 account ID, bucket, public base URL, access key, secret key, and distribution prefix
- Convex deployment URL and mutation path
- Optional app update feed base URL and check interval
- Optional hardware encoder override
- Auto progressive threshold in seconds

The app stores settings with `electron-store` and encrypts secret fields with Electron safe storage when the OS supports it.

## App Updates

The desktop app can check for new packaged releases and prompt the user to install them.

- The app reads an update feed base URL from Settings.
- At runtime it checks `.../darwin/arm64/RELEASES.json` on macOS arm64 and `.../win32/x64/RELEASES` on Windows x64.
- On macOS, Electron requires the packaged app to be signed before native auto-updates will work.
- Existing installs need one manual upgrade to a version that includes the updater. After that, future builds can be discovered in-app.

When you build a release with `APP_UPDATE_BASE_URL` set, Electron Forge will generate the macOS update manifest alongside the zip artifact so you can upload both to your release host.

For signed macOS releases and release-host setup, see [`docs/RELEASING.md`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/docs/RELEASING.md) and [`.env.release.example`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/.env.release.example).

The repo also includes a tag-driven GitHub Actions release workflow at [release.yml](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/.github/workflows/release.yml) that is designed to publish GitHub Releases and deploy the updater feed to GitHub Pages.

## Pipeline Overview

1. Watcher detects a new MP4 in the ingest folder.
2. File-ready checks wait for stable size and modified time before queueing.
3. The app inspects duration and sidecar metadata to resolve `progressive` vs `hls`.
4. FFmpeg generates either progressive clip renditions or an HLS ladder.
5. `rclone` copies the original source to Backblaze B2.
6. `rclone` copies the distribution folder to Cloudflare R2.
7. Convex receives the finished playback metadata, manifest URL when applicable, and progressive sources when applicable.

## Notes

- The current Convex request payload is implemented in [`src/main/services/ConvexService.ts`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/src/main/services/ConvexService.ts) and is easy to adjust if your mutation expects a different argument shape.
- On Windows production systems, use the folder picker instead of hardcoding paths so you can switch to locations like `C:\\Streaming\\Ingest` without touching the code.

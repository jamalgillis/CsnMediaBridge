# Developer Overview

This document gives developers a fast orientation to the current scope of CSN Media Bridge.

## What The App Does

CSN Media Bridge is an Electron desktop app for media ingest, VOD management, and post-shoot offload workflows.

It currently supports:

- automated watch-folder ingest for new video files
- file-readiness checks before processing starts
- FFmpeg-based transcode and packaging workflows
- Backblaze B2 archive upload
- Cloudflare R2 playback and distribution upload
- Convex registration of finished media records
- manual offload of full shoot folders to a designated local drive
- optional `png` / `jpg` / `jpeg` to `webp` conversion for website-ready assets
- image-only Backblaze upload during offload while video remains local
- resumable offloads using `offload-manifest.json` and `offload.log`
- Convex-backed stored-video library with search, filtering, metadata editing, publish controls, and poster replacement
- built-in local trimmer for exporting trimmed MP4 clips

## Main Technical Components

- Renderer: React + Tailwind UI
- Desktop shell: Electron
- Media processing: FFmpeg and ffprobe
- Cloud transfer: `rclone`
- Persistence: Electron Store with safe-storage encryption where available
- Backend registration: Convex

## Main Process Services

- `WatcherService`
- `TranscodeService`
- `SyncService`
- `OffloadService`
- `ConvexService`
- `StoreService`
- `AppUpdateService`

## Offload Workflow

The `Offload` page is designed for straightforward post-shoot handoff:

- select a source folder
- copy the folder to a configured local offload destination
- mirror the source directly into the package root
- optionally create `web-ready/` `webp` images
- optionally upload still-image assets to Backblaze B2
- keep video files local only
- pause, cancel, and resume long-running offload jobs

## External Dependencies

The app expects these tools on `PATH`:

- `ffmpeg`
- `ffprobe`
- `rclone`

# Developer Overview

This document gives developers a fast orientation to the current scope of CSN Media Bridge.

## What The App Does

CSN Media Bridge is a Tauri desktop app for media ingest, VOD management, and post-shoot offload workflows.

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
- Desktop shell: Tauri (Rust)
- Media processing: FFmpeg and ffprobe
- Cloud transfer: `rclone`
- Persistence: JSON under the OS application-support directory
- Backend registration: Convex, over its HTTP API

## The Host

The host is a single Rust file, `src-tauri/src/lib.rs`. Every capability the
renderer can reach is a `#[tauri::command]` in it, named after the channel in
`src/shared/ipc.ts`, and grouped roughly as:

- watch-folder ingest and the file-readiness check
- transcode (progressive MP4 and CMAF HLS/DASH) and poster extraction
- rclone transfer, removal, listing and upload auditing
- Convex registration, metadata updates, deletion and URL repair
- offload: resumable copy, `webp` conversion, image-only upload
- trim export
- Backblaze presigning (SigV4, signed in-process) for archive preview
- the live-stream handoff worker
- a small local media proxy so the webview can play remote and local files

`src/tauriBridge.ts` maps `window.mediaBridge` onto those commands, so the
renderer never names a command directly.

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

# CSN Media Bridge Features

This document describes the current feature set of CSN Media Bridge.

## Core Workflow

CSN Media Bridge is a desktop ingest station for turning finished source videos into cloud-hosted VOD assets that are immediately registrable in Convex.

The end-to-end pipeline is:

1. Watch a designated ingest folder for finished source files.
2. Wait for the file to stabilize and unlock.
3. Queue the job so only one heavy transcode runs at a time.
4. Generate a two-rendition HLS package plus a poster frame.
5. Upload the source file to Backblaze B2 for archive storage.
6. Upload the HLS package to Cloudflare R2 for playback delivery.
7. Verify uploads when enabled.
8. Register or update the video in Convex with ingest status and metadata.
9. Optionally clean up local temp output after success.

## Smart Ingest and Automation

- Watches a configured ingest folder for `.mp4`, `.mov`, and `.mkv` files.
- Ignores unsupported files automatically.
- Uses repeated size and modified-time checks before queueing a file.
- Probes whether the source file can be opened before treating it as ready.
- Calculates a stable SHA-256 source fingerprint before expensive pipeline work begins.
- Checks Convex for an existing ready upload that matches the source fingerprint.
- Skips duplicate-ready ingests before transcode and upload, reusing the existing cloud asset.
- Prevents duplicate active jobs for the same source file.
- Uses a FIFO queue so only one transcode job runs at a time.
- Supports auto-starting the watcher on app launch.
- Supports retrying failed jobs from the dashboard.
- Supports automatic cleanup of local HLS output and poster files after successful upload and registration.

## Pro-Grade Transcode Engine

- Uses FFmpeg for ingest processing.
- Builds a two-rung adaptive HLS ladder.
- Produces a `1920x1080` rendition.
- Produces a `1280x720` rendition.
- Produces variant playlists, transport stream segments, and `master.m3u8`.
- Extracts source metadata with `ffprobe`, including duration, frame rate, width, and height.
- Captures source file size from the local file system.
- Generates a `poster.jpg` frame automatically when enabled.

### Encoder Support

- `Auto` hardware encoder selection by platform.
- `NVENC` override for Windows and NVIDIA workflows.
- `VideoToolbox` override for macOS.
- `Software (libx264)` override for CPU-only encoding.
- Automatic fallback from hardware encoding to software encoding when enabled and a hardware acceleration failure is detected.
- macOS VideoToolbox flow now defaults to CPU decode plus VideoToolbox encode for better stability.

## Multi-Cloud Sync

- Uploads the original source file to Backblaze B2 for long-term archive storage.
- Uploads the generated HLS package to Cloudflare R2 for playback distribution.
- Builds public playback URLs from the configured R2 public base URL and distribution object key.
- Publishes poster URLs alongside the HLS package when a poster frame is generated.
- Supports configurable upload concurrency.
- Uses `rclone` retries and retry delays during transfer operations.
- Can verify archive and distribution uploads after sync.
- Attempts checksum-based verification first, then falls back to byte-level verification when needed.

## Convex Integration

- Calls a configurable public Convex mutation after ingest status changes.
- Upserts videos by `distributionObjectKey` so repeat ingests update the same record.
- Sends non-blocking status updates during `processing`, `uploading`, and `error` states.
- Sends a final blocking `ready` registration after sync succeeds.
- Maps cloud object structure to the final public playback URL.

### Video Data Stored in Convex

Each registered video can store:

- title
- source file name
- archive object key
- distribution object key
- master playlist URL
- playback URL
- poster URL
- encoder
- duration in seconds
- source file size in bytes
- source frame rate
- source width
- source height
- created timestamp
- updated timestamp
- status
- tags
- description
- series
- recorded-at timestamp
- error message

## Metadata and Playlist Organization

- Supports ingest metadata sidecar files named `<video>.bridge.json` or `<video>.metadata.json`.
- Reads optional metadata from sidecars before processing begins.
- Supports sidecar metadata fields for:
  - `title`
  - `description`
  - `series`
  - `recordedAt`
  - `tags`
  - `playlistTitles` or `playlists`
- Stores metadata on the ingest job so operators can see it in the desktop UI.
- Registers tags, description, series, and recorded-at values in Convex.
- Automatically creates playlist relationships in Convex when `playlistTitles` metadata is supplied.

### Playlist Backend

- Separate `playlists` table for named playlists.
- Separate `playlistItems` table for ordered playlist membership.
- Public mutation: `playlists:createPlaylist`
- Public mutation: `playlists:addVideoToPlaylist`
- Public query: `playlists:listPlaylists`
- Public query: `playlists:getPlaylistBySlug`
- Automatic unique slug generation for playlists.
- Ordered playlist items through a numeric `position` field.

## Dashboard and Operator Experience

- Live watcher state and queue depth.
- Active encoder state.
- Per-job encoding progress.
- Per-job upload progress.
- Per-job stage messaging for:
  - file-ready checks
  - queue wait
  - encoding
  - archive upload
  - distribution upload
  - verification
  - Convex registration
  - cleanup
- Job history with complete and error states.
- Retry button for failed jobs.
- Job cards that display:
  - source size
  - source resolution
  - source frame rate
  - duration
  - final playback URL
  - poster path or URL
  - tags
  - playlist titles
  - series
- Toggleable xterm-based pipeline console with live FFmpeg, rclone, watcher, Convex, and system logs.

## Settings and Credential Management

- Watch folder selection.
- Temporary output folder selection.
- Hardware encoder override selection.
- Ready-check polling interval.
- Stable-pass threshold.
- Upload concurrency control.
- Toggle for automatic watcher start.
- Toggle for automatic hardware-to-software fallback.
- Toggle for poster extraction.
- Toggle for upload verification.
- Toggle for temp file cleanup after success.
- Toggle for native desktop notifications.
- Backblaze B2 bucket, prefix, and credentials.
- Cloudflare R2 account, bucket, prefix, public base URL, and credentials.
- Convex deployment URL and mutation path.
- Secrets stored with Electron Store and encrypted through Electron safe storage when available.

## Health Monitoring and Resilience

- Checks whether `ffmpeg` is available on `PATH`.
- Checks whether `ffprobe` is available on `PATH`.
- Checks whether `rclone` is available on `PATH`.
- Checks internet reachability with a recurring heartbeat.
- Tracks watcher health separately from binary availability.
- Surfaces system notes when connectivity, binaries, or folders need attention.
- Shows native desktop notifications when a job starts, succeeds, or fails.
- Preserves a clear error state on failed ingest jobs and forwards the final error state to Convex when possible.

## Required External Tools

The desktop app expects these executables to be available on `PATH`:

- `ffmpeg`
- `ffprobe`
- `rclone`

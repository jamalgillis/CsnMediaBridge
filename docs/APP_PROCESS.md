# CSN Media Bridge Process Guide

This document explains, in plain language, what CSN Media Bridge does after it is configured and running.

## Purpose

CSN Media Bridge is a desktop app that automates the path from a finished video file to a ready-to-publish VOD asset.

It is built to:

- watch for new MP4 files
- wait until each file is fully finished writing
- inspect the source and choose the correct delivery mode
- transcode short clips into progressive playback files
- transcode long-form content into a streaming-friendly HLS package
- upload the original file to archive storage
- upload the distribution package to storage
- notify Convex so the VOD can be registered in the backend

## High-Level Flow

```text
+------------------+
| New MP4 arrives  |
| in watch folder  |
+---------+--------+
          |
          v
+------------------+
| File-ready check |
| waits for stable |
| size + timestamp |
+---------+--------+
          |
          v
+------------------+
| Delivery route   |
| chooses HLS or   |
| progressive      |
+---------+--------+
          |
          v
+------------------+
| FFmpeg encodes   |
| clip renditions  |
| or HLS ladder    |
+---------+--------+
          |
          v
+------------------+
| Original MP4     |
| copied to B2     |
| archive bucket   |
+---------+--------+
          |
          v
+------------------+
| Distribution     |
| copied to R2     |
| distribution     |
+---------+--------+
          |
          v
+------------------+
| Convex mutation  |
| receives final   |
| playback metadata|
+------------------+
```

## Step By Step

### 1. The app loads its saved configuration

When CSN Media Bridge opens, it reads the settings that were previously saved in the app. These include:

- watch folder
- temporary output folder
- Backblaze B2 credentials
- Cloudflare R2 credentials
- Convex deployment details
- hardware encoder preference

It also checks whether required command-line tools are available:

- `ffmpeg`
- `ffprobe`
- `rclone`

## 2. The app watches the ingest folder

If the watcher is started, the app monitors the selected ingest folder for newly added `.mp4` files.

This is meant for a workflow where another tool, recorder, or operator exports files into that folder.

## 3. The app waits until the file is really finished

Some recording or export tools keep writing to a file for a while after the file first appears.

To avoid processing an incomplete video, the app performs a file-ready check:

- it checks the file size
- it checks the modified timestamp
- it waits until those values stop changing for a set number of passes

Only after the file is stable does the app move the job into the pipeline.

## 4. The file enters the transcode queue

Each file becomes a job in the ingest queue.

The app intentionally runs one FFmpeg encode at a time. This helps protect system resources and keeps GPU usage predictable.

The job then moves through these stages:

- waiting
- encoding
- uploading archive
- uploading distribution
- registering with Convex
- complete or error

## 5. The app decides between progressive and HLS

The ingest station resolves delivery in this order:

- sidecar metadata override if present
- otherwise `auto`, which sends videos at or below the configured threshold to progressive
- videos above the threshold go to HLS

By default, the threshold is 60 seconds.

## 6. FFmpeg builds the delivery package

For progressive clips, the app generates:

- `playback-h264.mp4`
- `playback-av1.webm` when AV1 encoding succeeds
- `poster.jpg` when poster extraction is enabled

For HLS VOD, the app generates:

- `1080p`, `720p`, `480p`, and `360p` variants
- `master.m3u8`
- variant playlists
- per-variant init files such as `init_0.mp4`
- `.m4s` segment files

Platform behavior:

- On Windows, the app prefers CUDA with `h264_nvenc`
- On macOS, the app prefers VideoToolbox with `h264_videotoolbox`
- If needed, the app can fall back to software encoding

## 7. The original MP4 is archived to Backblaze B2

After encoding starts or completes, the app uses `rclone` to copy the original `.mp4` file into the Backblaze B2 archive bucket.

This bucket is meant to keep the full source asset for long-term storage.

## 8. The distribution package is uploaded to Cloudflare R2

The app then copies the output folder to the Cloudflare R2 distribution bucket.

That bucket is meant to hold the playback-ready assets, whether that means an HLS manifest with segments or progressive clip renditions.

Using the R2 public base URL plus the uploaded object path, the app builds the final playback URL and, when relevant, the final manifest URL.

## 9. Convex is notified

Once uploads succeed, the app calls the configured Convex mutation and sends metadata such as:

- source file name
- archive object key
- distribution object key
- playback URL
- manifest URL for HLS assets
- progressive source URLs for clip assets
- encoder used
- duration

This is how the VOD becomes visible to the rest of your system.

## 10. The app shows the operator live status

While all of this happens, the dashboard updates in real time and shows:

- whether the watcher is live
- queue depth
- which job is currently encoding
- encode progress
- upload progress
- success or failure state
- raw FFmpeg and rclone output

## What Success Looks Like

On a successful run:

1. An MP4 appears in the watch folder.
2. The app waits for the file to stabilize.
3. The app resolves progressive vs HLS.
4. The app creates the delivery package.
5. The original MP4 lands in Backblaze B2.
6. The distribution files land in Cloudflare R2.
7. Convex receives the final playback metadata.
8. The job is marked complete in the dashboard.

## What Happens If Something Fails

If a problem occurs, the app marks the job as an error and keeps the details visible in the dashboard.

Common causes:

- `ffmpeg` or `rclone` missing from PATH
- bad B2 or R2 credentials
- invalid Convex deployment URL or mutation path
- network timeout during upload
- hardware encoding failure on the current machine

When that happens, the operator can inspect the log console, fix the issue, and retry the job.

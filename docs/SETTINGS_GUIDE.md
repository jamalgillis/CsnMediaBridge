# CSN Media Bridge Settings Guide

This document explains each option on the `Settings` page in plain language.

The goal of the page is simple: tell the app where to watch for finished videos, where to build distribution files, where to store manual offloads, which still-image assets can go to the cloud, and how to notify your backend when a video is ready.

## What This Page Controls

The settings page is split into five groups:

- watch and working folders
- manual offload storage
- offload copy speed and verification
- encoder and file-readiness behavior
- Backblaze B2 archive storage
- Cloudflare R2 streaming storage
- Convex backend registration

## Before You Start

Have these ready before filling out the page:

- the folder where finished MP4 files will be dropped
- a local folder with enough free disk space for processing
- a local folder where full shoot offloads should be copied
- your Backblaze B2 bucket name and credentials
- your Cloudflare R2 bucket name and credentials
- your Convex deployment URL
- your Convex mutation path

## Folder Settings

### Watch Folder

This is the folder the app monitors for new `.mp4` files.

When a new MP4 appears here, the app:

1. waits for the file to stop changing
2. adds it to the processing queue
3. starts the transcode and upload pipeline

Best practice:

- use a folder meant only for completed videos
- do not use a folder where files are constantly being edited by hand
- think of this as the app's "inbox"

Important:

- the app watches for new files added after the watcher starts
- it is looking for `.mp4` files

### Temp Output Folder

This is the local working folder the app uses while building the distribution version of each video.

This folder holds files like:

- `master.m3u8`
- `manifest.mpd`
- HLS variant playlists and `.m4s` segments
- progressive clip renditions such as `playback-h264.mp4`
- posters such as `poster.jpg`

Best practice:

- choose a fast local drive if possible
- make sure the folder has enough free space
- use a folder the app is allowed to write to

Even though the setting says "temp," this is still real output written to disk during processing, so it is worth choosing a location you can manage easily.

### Manual Offload Folder

This is the base folder used by the `Offload` page.

When you run a manual offload, the app creates a dated package here with:

- a direct mirrored copy of the selected shoot folder in the package root
- an optional `web-ready` folder containing converted `webp` images
- an `offload-manifest.json` file that tracks checksums and completed steps
- an `offload.log` file with a plain-text transfer history

Important:

- video files stay on this local drive
- the Backblaze offload step uploads picture assets only
- pause and resume reuse the same package when the source folder and offload label match

Best practice:

- choose a roomy local drive used for post-shoot handoff
- keep it separate from the watcher inbox so the two workflows stay clean
- make sure the app can create folders here

### Offload Local Copy Mode

This controls how the app verifies local original-file copies during a manual offload.

Options:

- `Fast Local Copy`: recommended for most post-shoot offloads
- `Safe Checksum Copy`: slower, but stricter

What `Fast Local Copy` means:

- the app uses clone-friendly local copies when the drive supports them
- it preserves the copied file's modified time
- it decides whether a file can be reused by comparing file size and modified time
- the manifest, log, pause, and resume behavior still stay in place

What `Safe Checksum Copy` means:

- the app reads full-file checksums for the source and copied file
- it verifies the copy by comparing checksums
- it is slower on first-pass offloads, especially with large videos

Best practice:

- use `Fast Local Copy` for normal field offloads and large post-shoot dumps
- switch to `Safe Checksum Copy` when you specifically want the slowest but strictest local verification path

## Processing Settings

### Hardware Encoder Override

This controls how the app asks FFmpeg to encode video.

Options:

- `Auto`: recommended for most setups
- `NVENC`: use NVIDIA GPU encoding
- `VideoToolbox`: use Apple hardware encoding

What `Auto` means:

- on Windows, the app prefers `NVENC`
- on macOS, the app prefers `VideoToolbox`
- on other systems, the app falls back to software encoding

Best practice:

- leave this on `Auto` unless you are troubleshooting
- only force `NVENC` or `VideoToolbox` if you know that machine supports it

### Ready Check Interval (ms)

This controls how often the app checks whether a newly detected file has finished writing.

Plain-English version:

- lower number = checks more often
- higher number = waits longer between checks

The default is `2000`, which means the app checks about every 2 seconds.

Best practice:

- keep the default unless files are arriving very slowly or you have a specific problem

### Stable Passes

This controls how many times in a row the file must look unchanged before the app trusts that it is finished.

Plain-English version:

- lower number = faster start, but higher chance of catching a file too early
- higher number = safer, but slower

The default is `3`.

With the default timing, the app usually wants to see a file stay unchanged for roughly several seconds before it starts processing.

Best practice:

- keep the default unless you know files arrive in an unusual way
- increase this if files are sometimes picked up too early

### Auto Progressive Threshold (seconds)

This controls the automatic cutoff between progressive clips and HLS VOD.

Plain-English version:

- videos at or below this duration become progressive
- videos above this duration become HLS

The default is `60`.

Best practice:

- keep the default if you mainly handle short sports clips and longer VOD
- lower it if you want more videos pushed into HLS
- raise it if you want more short-form clips delivered as direct files

## Storage Layout

This setting decides the folder structure the app writes inside both cloud buckets. It only affects *new* uploads — objects already in your buckets are never moved, and they stay reachable either way.

### Canonical (lifecycle-aware)

This is the recommended choice, and the default for a fresh install.

New ingests are filed like this:

- Backblaze B2: `masters/{project}/{date}/{asset key}/{original file name}`
- Cloudflare R2: `streaming/vod/{asset key}/` for playback, `posters/{asset key}/` for thumbnails
- Social renders: `staging/social/` while they wait, `scheduled/social/` once attached to a scheduled post

The asset key is a short fingerprint of the source file's contents, so the same file always lands in the same folder no matter how many times it is retried or re-ingested.

Why it matters: Cloudflare's automatic cleanup rules work on folder paths. Separating temporary social clips from permanent playback files is what lets short-lived clips expire on their own while your published videos stay put. Under this layout your R2 bill stays effectively at zero without anyone remembering to delete anything.

### Legacy (flat path prefixes)

The scheme the app used before the storage contract existed: everything goes under the `B2 Path Prefix` and `R2 Path Prefix` values you set below, in one flat folder per job.

If you already have videos in your buckets, the app keeps you on this setting when it updates, so nothing changes without you choosing it. Cleanup rules cannot tell temporary clips from permanent ones under this layout, so plan to switch to canonical when convenient — switching only affects what gets written next.

### B2 S3 Endpoint

This is the address the app uses to generate temporary preview links for archived master files.

Where to find it: in Backblaze, open your bucket and look for the **Endpoint** on the details panel. Add `https://` to the front.

Example:

- `https://s3.us-west-004.backblazeb2.com`

What it is used for:

- previewing an archived master in the Library without anyone logging into Backblaze
- the "Retrieve for processing" button, which pulls the original back to your working folder

What it is *not* used for: normal uploads and downloads, which use a different Backblaze connection and ignore this setting. If you leave it blank everything else still works — the two archive buttons in the Library will explain that it is missing.

### B2 Path Prefix and R2 Path Prefix

These two settings are used only by the legacy layout. They are kept, not deleted, when you switch to canonical, so your existing files stay reachable if you ever switch back.

## Backblaze B2 Settings

This section is for archive storage.

The original source MP4 is copied to Backblaze B2 so you keep the full source file after processing.

### B2 Bucket

This is the name of the Backblaze B2 bucket where the original MP4 will be stored.

Think of this as:

- your archive destination
- the place that keeps the original uploaded video

### B2 Key ID

This is the account key ID the app uses to log in to Backblaze B2 through `rclone`.

### B2 Application Key

This is the secret key that goes with the B2 Key ID.

Treat it like a password.

### B2 Path Prefix

This is the folder-style path the app uses inside the B2 bucket.

Example:

- `vod/archive`

If your bucket is the storage building, this setting is the shelf or folder path inside that building.

Best practice:

- leave the default unless you already have a bucket structure you want to follow

### Offload B2 Prefix

This is the folder-style path the manual `Offload` page uses inside the same Backblaze B2 bucket for still-image uploads.

Example:

- `offloads`

Plain-English version:

- automatic ingest archives can live under one B2 prefix
- manual post-shoot image uploads can live under another

Best practice:

- keep this separate from the normal ingest archive prefix so manual offloads stay easy to browse

## Cloudflare R2 Settings

This section is for playback storage.

The app uploads the finished distribution package here so your player can use it.

### R2 Account ID

This identifies your Cloudflare R2 account and helps the app connect to the correct R2 endpoint.

### R2 Bucket

This is the Cloudflare R2 bucket where the playback files will be uploaded.

Think of this as:

- your streaming destination
- the place that holds the final playback files

### R2 Public Base URL

This is the public web address used to build the final playback URL for the video.

The app uses this to create the final playback URLs for HLS manifests and progressive clip files.

Best practice:

- use the public URL that your video player or CDN should actually serve from

### R2 Access Key ID

This is the access key the app uses to log in to Cloudflare R2 through `rclone`.

### R2 Secret Access Key

This is the secret key that goes with the R2 access key ID.

Treat it like a password.

### R2 Path Prefix

This is the folder-style path the app uses inside the R2 bucket.

Example:

- `vod/hls`

Best practice:

- leave the default unless your bucket already has a preferred folder structure

## Convex Settings

This section tells the app how to notify your backend after a video has finished processing and uploading.

### Convex Deployment URL

This is the URL for the Convex environment the app should call.

Plain-English version:

- this tells the app which backend to talk to

### Convex Mutation Path

This is the name of the backend action the app should call after the video is ready.

The default is:

- `media/videos:createVodEntry`

Plain-English version:

- this tells the app which "save this finished video" action to run in your backend

The media functions live in a `media/` folder on the shared backend, which is why the path starts that way.

Best practice:

- do not change this unless your backend team gave you a different value

### Ingest Node Token

This is the credential that identifies this specific workstation to the shared backend.

Why it exists: the app keeps working while nobody is signed in — it picks up jobs overnight and finishes uploads after everyone has gone home. So it identifies itself as a machine rather than borrowing a person's login, which would stop working the moment that person's session expired.

What to do:

- ask an administrator to issue a token for this workstation
- paste it here; it is stored encrypted on this machine, the same way your cloud keys are
- each workstation should get its own token, so a lost laptop can be shut off without disturbing anyone else

Without it, the app can still transcode video locally, but it cannot register anything to the library or pick up render jobs.

## Watcher Setting

### Auto-start watcher on launch

If this is turned on, the app automatically starts watching the `Watch Folder` when the app opens.

This is useful for a dedicated ingest station that should start working right away.

Best practice:

- turn this on after the app has been fully tested
- leave it off while you are still setting things up or troubleshooting

## What Happens When You Click Save

When you click `Save Configuration`, the app:

- stores your settings for the next launch

## Sidecar Metadata Overrides

If a source video has a sidecar file named like `game-winner.bridge.json`, the app can override the automatic route.

Supported keys include:

- `requestedDelivery`: `auto`, `progressive`, or `hls`
- `contentType`: `clip` or `vod`
- `title`
- `description`
- `series`
- `recordedAt`
- `tags`
- `playlistTitles`

Example:

```json
{
  "title": "Game Winner",
  "requestedDelivery": "progressive",
  "contentType": "clip",
  "tags": ["basketball", "highlight"],
  "playlistTitles": ["Top Plays"]
}
```
- trims accidental extra spaces from the values
- keeps secret values in the OS application-support directory, readable only by your user account
- refreshes the watcher state so the new settings take effect

## Recommended Starting Choices

If you are setting up the app for the first time, these are safe starting points:

- `Hardware Encoder Override`: `Auto`
- `Ready Check Interval (ms)`: `2000`
- `Stable Passes`: `3`
- `Storage Layout`: `Canonical (lifecycle-aware)`
- `B2 Path Prefix`: `vod/archive` (only used by the legacy layout)
- `R2 Path Prefix`: `vod/hls` (only used by the legacy layout)
- `Convex Mutation Path`: `media/videos:createVodEntry`
- `Auto-start watcher on launch`: the app defaults this to on, but it can be safer to switch it off until testing is complete

## Settings You Must Fill In Before Processing Works

For the app to complete the full pipeline successfully, you should have all of these filled in:

- Watch Folder
- Temp Output Folder
- B2 Bucket
- B2 Key ID
- B2 Application Key
- R2 Account ID
- R2 Bucket
- R2 Public Base URL
- R2 Access Key ID
- R2 Secret Access Key
- Convex Deployment URL
- Convex Mutation Path

## Simple Mental Model

If you want the shortest possible explanation of the page:

- `Watch Folder` = where finished videos appear
- `Temp Output Folder` = where the app builds streaming files
- `B2` = where the original MP4 is archived
- `R2` = where the playback files are published
- `Convex` = how the app tells your backend that the video is ready

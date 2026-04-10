# CSN Media Bridge First-Time Client Setup

This document walks a client through the first-time setup of CSN Media Bridge.

## What You Need Before Opening the App

Please have the following ready:

- a computer with CSN Media Bridge installed
- `ffmpeg`, `ffprobe`, and `rclone` installed and available on the system PATH
- one Backblaze B2 bucket for archive storage
- one Cloudflare R2 bucket for streaming distribution
- your Backblaze B2 credentials
- your Cloudflare R2 credentials
- your Convex deployment URL
- your Convex mutation path

## Information You Will Enter

```text
+----------------------------------------------+
| You will fill in these settings in the app:  |
|                                              |
| 1. Watch Folder                              |
| 2. Temporary Output Folder                   |
| 3. Backblaze B2 bucket + keys                |
| 4. Cloudflare R2 bucket + keys               |
| 5. Convex deployment URL                     |
| 6. Convex mutation path                      |
| 7. Optional encoder override                 |
+----------------------------------------------+
```

## Step 1. Open the App

Launch CSN Media Bridge and open the `Settings` page.

This is where all first-time configuration happens.

## Step 2. Choose the Watch Folder

Click `Browse` beside `Watch Folder` and choose the folder where finished MP4 files will appear.

Examples:

- a folder where a recorder exports completed files
- a folder where an editor drops final MP4s
- a shared media folder used only for ingest

This folder should contain files that are intended for this pipeline.

## Step 3. Choose the Temporary Output Folder

Click `Browse` beside `Temp Output Folder` and choose a folder where the app can create temporary HLS output during processing.

This is where the app builds:

- variant playlists
- `master.m3u8`
- `.ts` segments

This folder should have enough disk space for temporary encode output.

## Step 4. Set the Encoder Preference

In most cases, leave `Hardware Encoder Override` set to `Auto`.

The app will choose the right default for the platform:

- Windows: NVENC when available
- macOS: VideoToolbox when available

Only change this if you have a specific troubleshooting reason.

## Step 5. Enter Backblaze B2 Settings

Fill in the archive storage section with:

- B2 bucket name
- B2 key ID
- B2 application key
- B2 path prefix

This is where the app stores the original source MP4.

## Step 6. Enter Cloudflare R2 Settings

Fill in the distribution storage section with:

- R2 account ID
- R2 bucket name
- R2 access key ID
- R2 secret access key
- R2 public base URL
- R2 path prefix

This is where the app stores the playback-ready HLS files.

## Step 7. Enter Convex Settings

Fill in:

- Convex deployment URL
- Convex mutation path

Example mutation path:

- `videos:createVodEntry`

This is how the app tells your backend that a VOD is ready.

## Step 8. Save the Configuration

Click `Save Configuration`.

The app will store these settings for future launches. Secret values are stored in the Electron settings store and protected with OS-backed safe storage when available.

## Step 9. Check System Readiness

Go to the dashboard and review the readiness panel.

You want to see:

- `FFmpeg` ready
- `Rclone` ready
- folders configured
- B2 configured
- R2 configured
- Convex configured

If something is missing, go back to `Settings` and correct it before starting the watcher.

## Step 10. Start the Watcher

From the dashboard, click `Start Watcher`.

This tells the app to begin monitoring the watch folder for new `.mp4` files.

## Step 11. Run a First Test

For the first run, use one short test MP4.

Drop the file into the watch folder and confirm the app:

1. detects the file
2. waits for the file to stabilize
3. starts the HLS transcode
4. uploads the original MP4 to B2
5. uploads the HLS output to R2
6. registers the final URL with Convex
7. marks the job complete

## What the Client Will See

On the dashboard, the client can follow:

- active jobs
- completed jobs
- encoding progress
- uploading progress
- live pipeline logs

This gives a clear view of where every job is in the process.

## Recommended First-Time Test Checklist

```text
[ ] App opens
[ ] Settings saved successfully
[ ] FFmpeg shows as ready
[ ] Rclone shows as ready
[ ] Watch folder selected
[ ] Temp output folder selected
[ ] B2 credentials entered
[ ] R2 credentials entered
[ ] Convex details entered
[ ] Watcher started
[ ] Test MP4 processed successfully
```

## If Something Goes Wrong

If the first test fails:

1. Open the dashboard log console.
2. Read the most recent FFmpeg or rclone messages.
3. Check bucket names, keys, and Convex details.
4. Confirm `ffmpeg`, `ffprobe`, and `rclone` are installed correctly.
5. Retry the job after the issue is fixed.

## Recommended Bucket Naming

A simple production naming pattern is:

- B2 archive bucket: `csn-vod-archive-prod`
- R2 distribution bucket: `csn-vod-distribution-prod`

This keeps archive storage and playback storage clearly separated.

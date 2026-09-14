# Scope Of Work

## Project Title

CSN Media Bridge Desktop Workflow Platform

## Project Objective

Build and refine a desktop application that manages media ingest, VOD library operations, post-shoot offload, local review, trimming, cloud transfer, and backend registration for a production media workflow.

## Scope

The application will provide:

- automated watch-folder ingest for incoming video assets
- file-readiness detection and queue-based job handling
- FFmpeg-powered video processing and output generation
- cloud upload of archive and playback assets
- Convex-based registration of completed media
- a desktop VOD library for searching assets, editing metadata, and controlling publish state
- manual poster selection and poster replacement for stored videos
- a manual offload workspace for post-shoot folder transfer
- clean local offload packaging that mirrors source structure directly
- optional website-image conversion to `webp`
- image-only cloud upload for offload workflows while video remains local
- resumable offloads with persistent manifest and transfer logs
- local playback review and metadata management for stored media
- local clip trimming and MP4 export tools
- centralized settings for storage, credentials, backend integration, and app behavior

## Deliverables

- cross-platform Tauri desktop application
- React-based operator interface
- configurable ingest, library, offload, trimmer, and settings views
- cloud integration for Backblaze B2 and Cloudflare R2
- Convex integration for media metadata registration
- on-disk manifest and logging support for resumable offloads
- desktop update support for packaged releases
- project documentation covering setup, features, settings, and release flow

## Technical Approach

- Tauri for desktop packaging and native system integration
- React for UI workflows
- FFmpeg and ffprobe for media processing and inspection
- `rclone` for cloud transfer and verification workflows
- JSON configuration persisted under the OS application-support directory
- Convex for backend media registration and metadata workflows

## Success Criteria

- operators can ingest new video from a watch folder without manual intervention
- operators can offload a shoot folder to a local destination with a clean mirrored copy
- image assets can be converted to `webp` and optionally uploaded to Backblaze
- video offloads remain local and are not uploaded during the offload workflow
- interrupted offloads can be resumed without restarting from zero
- ready media can be previewed, edited, and trimmed within the desktop app
- settings and credentials can be managed from the app UI

## Assumptions

- required CLI dependencies are installed and available on system `PATH`
- valid Backblaze, Cloudflare, and Convex credentials are provided
- the workstation has access to the destination drives and cloud endpoints needed for operation

## Out Of Scope

- full DAM or MAM functionality
- multi-user permissions system
- browser-based admin interface
- automated editorial timeline tooling

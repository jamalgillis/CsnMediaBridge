# Sales Summary

CSN Media Bridge is a desktop media operations app built for teams that need to ingest, offload, prepare, review, manage, and publish video assets from one workstation. It combines automated watch-folder ingest with a manual post-shoot offload workflow, giving operators a practical bridge between field media handling and cloud delivery.

The app handles the core media workflow end to end: it monitors incoming video, waits for files to finish copying, processes playback outputs with FFmpeg, uploads assets to cloud storage, and registers finished media in Convex. It also includes a Convex-backed VOD library for searching assets, editing metadata, managing publish state, and replacing poster images, plus a dedicated offload page for copying full shoot folders to a designated local drive, converting still images to `webp`, and optionally uploading only image assets to Backblaze while keeping video local.

## Key Value Points

- reduces manual handoff steps for ingest and post-shoot offload
- keeps video archiving and website image prep in one tool
- supports resumable offloads with manifest and log tracking
- gives operators built-in VOD management, preview, and trim tools
- centralizes local paths, cloud storage, backend registration, and update behavior in one desktop app

## Best-Fit Use Cases

- sports media ingest stations
- post-production handoff workstations
- small media teams managing both local archives and cloud delivery
- workflows that need video kept local while still images go to web and cloud destinations

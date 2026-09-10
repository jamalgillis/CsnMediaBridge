# Tauri Architecture

This document describes the first Tauri scaffold for CSN Media Bridge and how it
will replace the existing Electron host over time.

Last reviewed: September 10, 2026

## Current Scaffold

The Tauri app lives under `src-tauri/` and is configured to load the existing
React renderer from Vite.

Key files:

- `src-tauri/tauri.conf.json` configures the app id, main window, Vite dev URL,
  renderer build output, icons, and global Tauri API exposure.
- `src-tauri/capabilities/default.json` grants the main window Tauri core
  permissions.
- `src-tauri/src/lib.rs` exposes parity-shaped commands matching the existing
  `window.mediaBridge` API. Settings persistence, health checks, folder
  browsing, manual intake file selection, trim source selection, offload source
  inspection, manual FFprobe inspection, local FFmpeg packaging, rclone
  archive/distribution uploads, and Convex VOD registration are now
  implemented.
- `src/tauriBridge.ts` installs `window.mediaBridge` when the app is running
  under Tauri. In Electron, the preload bridge still owns that global.

The scaffold is intentionally conservative. The manual intake path now runs a
real Tauri background worker, and the live handoff commands can list recent
Convex jobs, claim one pending job, renew its lease, download a
`sourceDownloadUrl`, process it through the same FFmpeg/upload/registration
path, and complete or fail the Convex handoff job. Watch-folder ingest, upload
audit/recovery, library reads and metadata mutations, render jobs, and
`sourceObjectKey`-only handoff downloads still return safe defaults or explicit
"not ported yet" errors until those services are rewritten in Rust.

## Renderer Bridge

The app should keep one renderer-facing API:

```ts
window.mediaBridge
```

Electron currently provides that API from `src/preload.ts`. Tauri provides the
same API from `src/tauriBridge.ts`, using `window.__TAURI__.core.invoke` and
`window.__TAURI__.event.listen`.

This compatibility layer lets React pages move once, then allows the host
implementation to change underneath them.

## Command Naming

Renderer method names stay camelCase:

```ts
window.mediaBridge.getState()
window.mediaBridge.saveSettings(settings)
window.mediaBridge.wakeLiveStreamHandoffWorker()
```

Tauri Rust commands use snake_case:

```rust
get_state
save_settings
wake_live_stream_handoff_worker
```

The adapter maps between the two.

## Migration Rule

Port one native service at a time behind the existing API.

Recommended order:

1. Settings persistence. Done for JSON settings; secure secrets still pending.
2. Health checks for `ffmpeg`, `ffprobe`, `rclone`, folders, and connectivity. Done.
3. File/folder dialogs. Done.
4. Local media proxy or custom protocol.
5. FFprobe metadata inspection. Done for manual intake.
6. FFmpeg progressive transcode. Done for manual intake with software `libx264`.
7. FFmpeg CMAF HLS/DASH packaging. Done for manual intake with software `libx264`.
8. B2/R2 sync and upload audit. Upload sync is done for manual intake when
   storage settings are configured; audit/recovery is still pending.
9. Convex VOD/library calls. VOD registration is done for manual intake through
   the Convex HTTP mutation API; library reads and metadata edits are still
   pending.
10. Existing render-job and storage-task workers.
11. Live stream handoff worker. Done for manual wake, claim, lease renewal,
    `sourceDownloadUrl` download, local processing, and Convex completion;
    live subscription wakeup and `sourceObjectKey` retrieval are still pending.

Each completed service should preserve the current `MediaBridgeApi` method
shape unless there is a deliberate renderer migration.

## Live Handoff Slot

The scaffold already reserves these renderer APIs:

- `listLiveStreamHandoffJobs`
- `wakeLiveStreamHandoffWorker`
- `onLiveStreamHandoffUpdate`

These commands now connect to the Convex functions specified in
`docs/LIVE_STREAM_HANDOFF.md` for manual refresh/wake flows.

The subscription remains a wakeup signal only. The native worker must still
claim jobs through Convex mutations before processing.

## Local Validation

Available checks:

```bash
corepack pnpm run typecheck
corepack pnpm run renderer:build
corepack pnpm exec tauri --version
```

Full Tauri validation:

```bash
rustc --version
cargo --version
corepack pnpm run tauri:build
```

Rust was installed on this workstation with `rustup` using the minimal profile.
`corepack pnpm run tauri:build` produces:

- `src-tauri/target/release/bundle/macos/CSN Media Bridge.app`
- `src-tauri/target/release/bundle/dmg/CSN Media Bridge_1.0.0_aarch64.dmg`

Homebrew's `rust` formula was not used because it pulls a large `llvm@22`
dependency and failed on this machine while disk space was tight.

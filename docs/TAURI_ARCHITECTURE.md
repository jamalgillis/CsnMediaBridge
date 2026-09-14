# Tauri Architecture

This document describes the Tauri host for CSN Media Bridge, which is now the
only host. The Electron shell it replaced was removed once the last command was
ported.

Last reviewed: September 11, 2026

## Layout

The Tauri app lives under `src-tauri/` and loads the React renderer from Vite.

Key files:

- `src-tauri/tauri.conf.json` configures the app id, main window, Vite dev URL,
  renderer build output, icons, and global Tauri API exposure. The window hides
  the OS frame so the app can draw its own 38px title bar; the platform's real
  window controls are inset into that row.
- `src-tauri/capabilities/default.json` grants the main window Tauri core
  permissions.
- `src-tauri/src/lib.rs` is the host. Every capability the renderer can reach is
  a `#[tauri::command]` in it, named after the channel in `src/shared/ipc.ts`.
- `src/tauriBridge.ts` installs `window.mediaBridge` and maps it onto those
  commands.

## What The Host Owns

- **Watch-folder ingest.** A polling scan of the watch folder, plus the
  file-readiness check: a candidate must hold the same size and modification
  time across `readyCheckStablePasses` passes and be openable for reading before
  it is queued, because a large export is visible on disk long before it is
  complete.
- **Transcode.** Progressive MP4 for short clips, CMAF HLS/DASH for longer
  content, and poster extraction, all through `ffmpeg`.
- **Transfer.** rclone for archive upload, distribution upload, download,
  removal and listing, with a throwaway config written per call so credentials
  never sit on disk between transfers.
- **Upload auditing.** Comparing the local output tree against what actually
  landed in the bucket, and naming the difference — missing objects, unexpected
  objects, size mismatches.
- **Convex.** Registration, metadata updates, deletion and stored-URL repair,
  over Convex's HTTP API.
- **Offload.** A resumable card copy with a manifest, optional `webp`
  conversion, and image-only upload. Pause and cancel are checked between files,
  never mid-file.
- **Trim export**, with a software fallback when a hardware encoder gives out.
- **Archive presigning.** SigV4 query signing, done in-process, so the B2 vault
  stays private and credentials never leave the host. The signer is checked
  against AWS's published reference vectors in the crate's tests.
- **Live-stream handoff.** Claiming, lease renewal, download, processing and
  completion.
- **A local media proxy**, so the webview can play remote and local files.

- **In-app updates.** `tauri-plugin-updater`, pointed at `{baseUrl}/latest.json`
  from the operator's settings rather than the build-time endpoint, so a station
  can be retargeted without a rebuild. Checked on launch and on the configured
  interval; installs in place and restarts.

## Encoders

The encoder setting picks the codec for both ingest and trim: NVENC on Windows
and VideoToolbox on macOS when set to Automatic, or whatever the operator
chose. A hardware encode that fails part-way through is retried once in
software, and the job record is corrected to say which encoder actually
produced the file — so the library never claims hardware output it did not get.

## Authentication

Two identities, kept apart: the station holds a machine credential and runs the
pipeline unattended; the operator is a Clerk user whose team decides what the
window shows. The gate is around the router in `src/App.tsx`, never around the
Rust host — a station at the sign-in screen still ingests.

Sign-in is OAuth 2.0 + PKCE with a loopback redirect, run entirely by the host:
it binds an ephemeral port on 127.0.0.1, opens the operator's real browser, and
exchanges the code for tokens it keeps in application support. See
`docs/AUTHENTICATION.md`.

## Failing and Retrying

A transfer that stops halfway is the pipeline's most common failure, and it is
usually worth waiting out: the bytes are on disk, rclone resumes into the same
object keys, and nothing is re-converted. Those jobs retry themselves on a
backoff of 30s, 2m, 5m, 15m, 30m, and appear under "Up next" rather than "Needs
you" — nobody has to do anything.

Failures the machine will hit again regardless — an unreadable file, a missing
folder, a rejected credential, a full disk — are not retried. Retrying those
would bury a real problem under a queue that looks busy, so they stop and ask
for a person. `is_transient_failure` draws that line, and checks the permanent
markers first so a permission error that happens to mention "connection" is not
mistaken for a network blip.

## Playback

Streaming is a four-rung CMAF ladder — 1080p, 720p, 480p, 360p — in two-second
fMP4 segments with `independent_segments`, which hls.js adapts across on its
own. The local media proxy streams responses through rather than collecting
them, so a player gets the first bytes of a segment as they arrive instead of
after the whole thing has downloaded. Resume positions live in the window's
local storage, not the library: where one person got to on one station is not a
fact about the asset.

Scrub previews are sprite sheets plus a WebVTT storyboard, written into the
playback package and fed to Plyr's `previewThumbnails`. Not an HLS I-frame
playlist: that is the format HLS specifies for trick-play, but Plyr does not
read it, so it would produce nothing visible. Frames are sampled every five
seconds, stretched for long recordings so a storyboard never exceeds 600 tiles,
and tiled 5x5 — hundreds of separate images would be slower to fetch and far
more expensive to serve. The storyboard's address is derived from the playback
package rather than stored, so the library schema the CSN web app shares is
untouched.

Not built: captions, and any ladder rung above 1080p.

## Known Gaps

- **`sourceObjectKey`-only handoff downloads.** A handoff job that arrives with
  an object key rather than a download URL is not handled.
- **Deletion still uses whatever credentials the station has.** The broker has
  a `delete` purpose that grants it, but that should require an operator's
  identity rather than a station's once machine identity moves to Clerk.
- **Playback is still served from a public R2 bucket by default.** The gate
  exists and enforces team ownership; the bucket cannot actually be closed until
  the CSN sports web app moves off the same public URLs.

## Renderer Bridge

The app keeps one renderer-facing API:

```ts
window.mediaBridge
```

`src/tauriBridge.ts` provides it, using `window.__TAURI__.core.invoke` and
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

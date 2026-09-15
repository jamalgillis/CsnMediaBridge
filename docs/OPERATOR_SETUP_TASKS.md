# Operator Setup Tasks

Work that must be done by a human in a provider dashboard or a credentials
console. None of it can be done from application code, and several items block
delivery phases in `EXECUTION_ROADMAP.md`.

Each task lists what it blocks, so partial completion still unblocks partial
progress.

Last reviewed: September 8, 2026

## Priority Legend

- **BLOCKING** — a shipped phase cannot function without it.
- **REQUIRED** — needed before production use, not before development.
- **OPTIONAL** — improves cost or operations, safe to defer.

---

## 1. Cloudflare R2

### 1.1 Create the object lifecycle rules — BLOCKING (Phase 3)

Dashboard → R2 → your bucket → **Settings** → **Object lifecycle rules**.

| Rule name           | Prefix               | Action                          |
| ------------------- | -------------------- | ------------------------------- |
| `purge-staging`     | `staging/social/`    | Delete objects **3 days** after creation |
| `purge-scheduled`   | `scheduled/social/`  | Delete objects **7 days** after creation |

Add an abort rule for incomplete multipart uploads (1 day) on the whole bucket
while you are in there — orphaned multipart parts are billed and invisible in
the object listing.

Do **not** add a rule covering `videos/` or `posters/`. A bucket-wide expiry
rule will silently delete your published VOD library.

*Blocks:* automated cost control. Without it the app still deletes on the happy
path, but abandoned renders accumulate.

### 1.2 Confirm the public base URL — REQUIRED

The app needs a public HTTPS base that maps to the bucket root, either the
`pub-<hash>.r2.dev` development URL or a custom domain bound to the bucket. Set
it in Settings → Cloudflare R2 → Public base URL.

Prefer a custom domain for production. The `r2.dev` URL is rate-limited and not
intended for production traffic, and social platforms fetching a large MP4 will
notice.

*Blocks:* playback and platform fetches.

### 1.3 Verify the API token scope — REQUIRED

The R2 API token needs **Object Read & Write** on the target bucket. Promotion
(`staging/` → `scheduled/`) performs a server-side copy plus a delete, so a
read-only or write-only token will fail at the promotion step rather than at
upload — which is a confusing place to discover it.

*Blocks:* staging→scheduled promotion, post-publish cleanup.

### 1.4 Decide on CORS — REQUIRED if the web app plays from R2

If the Asset Manager plays HLS or DASH from R2 in a browser, add a CORS policy
allowing `GET` and `HEAD` from the Asset Manager origin. The desktop app proxies
media through a local loopback server and is unaffected.

Use the JSON tab in the bucket's CORS policy editor:

```json
[
  {
    "AllowedOrigins": [
      "https://centexsportsnetwork.com",
      "https://www.centexsportsnetwork.com"
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": [
      "Accept-Ranges",
      "Content-Length",
      "Content-Range",
      "ETag"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

After saving the policy, purge the cache for the R2 custom domain if the bucket
has already served the same objects. Verify with an origin-aware request:

```bash
curl -I \
  -H "Origin: https://www.centexsportsnetwork.com" \
  https://media.centexsportsnetwork.com/videos/<asset-key>/master.m3u8
```

The response should include `access-control-allow-origin`. Without that header,
browser players that fetch HLS or DASH with JavaScript can fail even when the
manifest, init fragments, and media segments return `200`.

---

## 2. Backblaze B2

### 2.1 Confirm no lifecycle rules exist — BLOCKING

Dashboard → Buckets → your bucket → **Lifecycle Settings**. It must read *Keep
all versions of the file* or *Keep only the last version*, never a rule that
hides or deletes after N days.

This is the master vault. A lifecycle rule here destroys the only full-quality
copy.

*Blocks:* archive integrity. Check this before the first production ingest.

### 2.2 Choose a versioning policy — REQUIRED

**Keep only the last version** is the right default. Because the canonical layout
keys masters by content fingerprint, re-uploading the same file writes the same
key with identical bytes — keeping all versions would store the same footage
repeatedly with no benefit.

*Blocks:* nothing, but it silently doubles or triples the storage bill if wrong.

### 2.3 Application key scope — REQUIRED

The B2 application key must allow `listFiles`, `readFiles`, `writeFiles`, and
`deleteFiles` on the bucket. Delete is needed only for the explicit *Delete
Asset* operator action; scope it out if you want that path hard-disabled.

### 2.4 Set the B2 S3 endpoint — REQUIRED

Backblaze dashboard → Buckets → your bucket. The details panel shows an
**Endpoint** like `s3.us-west-004.backblazeb2.com`.

Enter it in the desktop app under Settings → Backblaze B2 → **B2 S3 Endpoint**,
with the scheme:

```
https://s3.us-west-004.backblazeb2.com
```

The region is read from the hostname, so there is nothing else to fill in. Only
archive preview and retrieval use it — uploads and downloads go through rclone's
native B2 backend and ignore it.

*Blocks:* previewing and retrieving archived masters from the library. The app
tells you which field is missing rather than just disabling the buttons.

---

## 3. Convex

The media pipeline now shares the CSN sports app's Convex deployment. All
deploys happen from `Websites/csn` — see `CONVEX_DEPLOYMENT_TOPOLOGY.md`.

### 3.1 Set the node token environment variable — BLOCKING

**Environment variables and deploys default to different deployments.** `convex
env set` writes to **dev**; `convex deploy` publishes to **prod**. Running the
pair without flags puts the token on one deployment and the code on the other,
and every media call then fails the credential check with nothing obviously
wrong. Pass `--prod` explicitly:

```bash
cd Websites/csn
npx convex env set --prod MEDIA_BRIDGE_NODE_TOKENS "$(openssl rand -hex 32)"
```

Set it on dev too if you run the desktop app against a dev deployment:

```bash
npx convex env set MEDIA_BRIDGE_NODE_TOKENS "$(openssl rand -hex 32)"
```

Use a *different* token per deployment, so a dev credential is not also a
production one.

Verify both halves landed on the same deployment before moving on:

```bash
npx convex env list --prod | grep MEDIA_BRIDGE_NODE_TOKENS   # token present
npx convex function-spec --prod | grep -c '"media/'          # functions present
```

Every media function requires either this token or a CSN admin session. Without
it the desktop app can still transcode locally but cannot register anything.

Multiple tokens are supported as a comma-separated list, so a workstation can be
rotated or revoked without taking every other ingest node offline:

```bash
npx convex env set --prod MEDIA_BRIDGE_NODE_TOKENS "token-for-studio-a,token-for-studio-b"
```

Treat these as rotatable credentials rather than permanent secrets — a token
passed as a function argument is visible in the Convex dashboard's function log.

*Blocks:* all ingest and render work against the merged deployment.

### 3.2 Deploy from the sports app — BLOCKING

```bash
cd Websites/csn
npx convex dev      # during development
npx convex deploy   # for production
```

**Never run `npx convex deploy` from `CsnMediaBridge`.** A deployment can be
pushed to by exactly one codebase, and `deploy` replaces the entire function
set — running it from the media bridge would delete the sports site's backend.

*Blocks:* everything in Phases 2–4.

### 3.3 Point the desktop app at the shared deployment — BLOCKING

Settings → Convex:

- **Deployment URL** — the Convex deployment that actually serves the live
  sports site.

  **Verify this rather than trusting the CLI.** `npx convex env get
  CONVEX_DEPLOYMENT --prod` reports the deployment the *repository is linked to*,
  which is not necessarily the one running production — they differ whenever
  production is deployed by CI with a deploy key. Confirm by calling a public
  function against the URL:

  ```bash
  npx convex run --url https://<candidate>.convex.cloud media/catalog:listPublished '{"limit":1}'
  ```

  A deployment that answers is the live one. One that returns a bare
  `Server Error` for every function is not serving the site.
- **Mutation Path** — `media/videos:createVodEntry` (media functions are
  namespaced under `media/`).
- **Ingest Node Token** — a token from 3.1. Issue a distinct one per
  workstation so a lost laptop can be revoked on its own.

### 3.4 Confirm the Clerk issuer is set — REQUIRED

The sports app's `convex/auth.config.ts` reads `CLERK_JWT_ISSUER_DOMAIN`.
Confirm it is set on the deployment you are merging into:

```bash
npx convex env get CLERK_JWT_ISSUER_DOMAIN
```

Staff must hold the `org:admin` role in the `csn-staff` Clerk organization to
reach operator functions — the same check the sports admin already uses.

### 3.5 Import the existing library — REQUIRED

A superseded deployment usually still holds its data while no longer serving
the functions a script would query, so the import reads a snapshot export rather
than the live API. Export first, from this repository:

```bash
npx convex export --path /tmp/old-bridge-export.zip
```

Then import:

```bash
NEW_CONVEX_URL=https://<sports-prod>.convex.cloud \
MEDIA_BRIDGE_NODE_TOKEN=<a token from 3.1> \
pnpm migrate:library --from-export /tmp/old-bridge-export.zip --dry-run
```

`--dry-run` reports what would move without writing anything. Drop the flag to
run it for real.

Reading from an export needs no access to the old deployment at all, so
`OLD_CONVEX_URL` is not required on this path. Live reads remain available
(omit `--from-export`) for a source that still serves its functions.

The old deployment is only read from, never modified, so it stays available as a
fallback. The import is safe to re-run — every row is written with its old id and
anything already present is skipped, so a run interrupted halfway resumes rather
than duplicating.

Verify the library in the Asset Manager's Ingest view before decommissioning the
old deployment.

---

## 4. Social Platform APIs

Required only for Phase 4 (automated publishing). Each involves an app review
process with a real waiting period — start them early even if the code is not
ready.

### 4.1 Meta (Instagram Reels, Instagram Feed, Facebook) — REQUIRED (Phase 4)

- Create a Meta app in the developer console.
- Connect an Instagram **Business or Creator** account to a Facebook Page.
  Personal Instagram accounts cannot be published to via API, at all.
- Request `instagram_content_publish`, `pages_manage_posts`, and
  `pages_read_engagement`.
- Complete App Review. Budget days to weeks.
- Produce a long-lived Page access token and note its refresh cadence.

### 4.2 TikTok — REQUIRED (Phase 4)

- Register for the TikTok for Developers Content Posting API.
- Complete the audit required to post publicly. Unaudited apps can only post to
  private/self-only visibility, which is not useful in production.
- Note that TikTok requires the media URL domain to be verified — the R2 custom
  domain from task 1.2 must be added to the app's verified domain list.

### 4.3 YouTube — REQUIRED (Phase 4)

- Create a Google Cloud project and enable the YouTube Data API v3.
- Configure the OAuth consent screen and complete verification for the upload
  scope.
- Note the default quota: 10,000 units/day, and a video upload costs ~1,600
  units. That is roughly six uploads per day until a quota increase is granted.
  Request an increase before you need it.

### 4.4 Store the credentials — REQUIRED (Phase 4)

Platform tokens belong in Convex environment variables (`npx convex env set`),
not in the desktop app's settings store and never in the browser bundle. The
publish action is the only code that should read them.

---

## 5. Decisions Needed From You

These change what gets built and cannot be defaulted safely.

1. **Long-lead scheduling.** Should a post scheduled more than 7 days out be
   (a) re-rendered automatically shortly before its publish time, or (b) allowed
   to hold an R2 object indefinitely with the `scheduled/social/` lifecycle rule
   relaxed? Option (a) keeps cost at zero and is the roadmap default; option (b)
   is simpler but makes the bill grow with the scheduling backlog.

2. **Cleanup executor.** Storage copies and deletes currently run on the desktop
   node. If studio desktops are routinely asleep overnight, a trusted Convex
   action holding R2 credentials should take over. This requires putting R2
   credentials into Convex env vars — a security posture change worth deciding
   explicitly rather than drifting into.

3. **Legacy object migration.** Existing objects under `vod/archive/…` and
   `vod/hls/…` keep working as-is. Do you want a one-time batch move into the
   canonical layout, or is a mixed-convention bucket acceptable? Recommendation:
   leave them; the cost of moving is real and the benefit is cosmetic.

3a. **Existing library rows.** Decided: re-import. See task 3.5.

4. **Browser render threshold.** The 1.5 GB browser/desktop cutoff is a starting
   value. If your operators are on 8 GB laptops, 750 MB is safer; on 32 GB
   workstations 3 GB is reasonable. This wants one week of real telemetry before
   being fixed.

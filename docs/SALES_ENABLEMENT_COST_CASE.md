# Why We Should Adopt CSN Media Bridge — Internal Sales Case

Last updated: June 15, 2026

This document is for internal use. It translates the technical media cost assessment into a straightforward case for why our team should be selling CSN Media Bridge and why it wins on value.

---

## The Short Version

A client running a 1,000-hour VOD library with 100,000 uploaded images pays roughly **$135/month in cloud storage** — and zero in delivery/bandwidth fees on playback. That is a number most clients will not believe until they see it, because the industry default is expensive.

---

## The Problem in the Market Today

Media teams running sports or event video face one of two bad options:

**Option A — Traditional enterprise CDN (AWS, Akamai, etc.)**
Clients pay storage fees AND egress fees. Egress is bandwidth — every time a viewer hits play, someone is paying for that data to move. At scale, egress routinely dwarfs storage cost. AWS CloudFront alone bills around $0.085 per GB out, and a single hour of 1080p HLS can deliver 2–6 GB per viewer. A modest sports media library with a few thousand viewer-hours per month generates a bill that surprises people.

**Option B — Managed video platforms (Vimeo, Brightcove, etc.)**
These solve the egress problem but lock clients into per-seat or per-storage-tier pricing, often at $500–$2,000+/month for professional or enterprise plans, with limited workflow automation, no local offload support, and no ownership of their own storage.

Neither option fits small-to-mid sports media teams who need professional ingest, archive, and delivery but not an enterprise contract.

---

## What CSN Media Bridge Changes

CSN Media Bridge is a desktop app for media operations teams. It handles the full chain — from watch-folder ingest, to FFmpeg transcoding, to cloud upload, to a searchable VOD library — from a single workstation.

The key architectural choices behind its cost advantage:

| What the app uses | Why it matters to cost |
| --- | --- |
| **Cloudflare R2** for HLS playback | **Zero egress fees**. Viewers can stream all day and the bill does not move. |
| **Backblaze B2** for source archive and still images | Storage costs **$6.95/TB-month** — about 3× cheaper than AWS S3. |
| **Convex** for metadata only | The database stores records, not heavy media files, so the Convex bill stays negligible. |
| **Local-first video offloads** | Raw shoot-folder video stays on the client's drive. Cloud spend is limited to what actually needs to be cloud-accessible. |

---

## The Numbers: What Clients Actually Pay

### VOD Storage (per retained video hour, per month)

| What you keep | Monthly cost |
| --- | --- |
| Source archive in B2 | ~$0.04 |
| HLS playback package in R2 | ~$0.09 |
| **Total per VOD hour** | **~$0.13** |

Playback bandwidth on top of that: **$0.00** — R2 egress is free.

### Scaling Out — Full Library Cost

| Retained VOD library | Estimated storage/month |
| ---: | ---: |
| 50 hours | $6.40 |
| 100 hours | $12.80 |
| 250 hours | $32.00 |
| 500 hours | $64.00 |
| 1,000 hours | $127.95 |

These are storage-only numbers. There are no delivery fees on top.

### Still Images (per month)

| Images stored | Originals only | Originals + WebP |
| ---: | ---: | ---: |
| 1,000 | $0.06 | $0.07 |
| 10,000 | $0.56 | $0.72 |
| 50,000 | $2.78 | $3.61 |
| 100,000 | $5.56 | $7.23 |

---

## Real Client Scenarios

These are examples to use when pricing a potential client engagement.

### Small Sports Season
- 50 retained VOD hours, 10,000 still images with WebP conversion
- **~$7/month in cloud storage**
- Playback delivery: $0

### Active Monthly Operation
- 250 retained VOD hours, 50,000 still images with WebP
- **~$36/month in cloud storage**
- Playback delivery: $0

### Large Media Archive
- 1,000 retained VOD hours, 100,000 still images with WebP
- **~$135/month in cloud storage**
- Playback delivery: $0

For reference: a single Vimeo Business or comparable managed platform seat at this volume would cost multiples of that number, and wouldn't include a local offload or ingest workflow.

---

## Why Zero Egress Is the Real Win

This point deserves its own section because it is counterintuitive to most clients.

Traditional CDN billing means that **popular content costs more**. If a game clip goes viral internally or a highlights reel gets heavy traffic during a season, the bill spikes. Operations teams have to actively police what gets shared to avoid surprise invoices.

With R2, **popularity is free**. A clip that gets 10 views and a clip that gets 10,000 views cost the same to deliver. This removes a whole category of budget anxiety for clients and makes the value proposition easy to justify — they pay for storage once, and playback is included.

---

## What the App Delivers (Workflow Value on Top of Cost)

Cost is the hook, but the workflow is why clients stay. CSN Media Bridge provides:

- **Automated watch-folder ingest** — drop a file, the app handles the rest
- **Multi-bitrate HLS output** — 360p through 1080p, ready to stream from any device
- **Manual offload workflow** — copy full shoot folders, convert stills to WebP, upload selectively
- **Searchable VOD library** — metadata, publish state, poster image management, trim controls
- **Resumable offloads** — manifest and log tracking so large shoots don't have to restart on interruption
- **Built-in player** — preview any asset before it goes live

One app replaces a stack of separate tools: a transcoder, an S3 management client, a media database, and a video review platform.

---

## Objections and How to Handle Them

**"We already have an AWS workflow."**
> Ask what they pay per month in egress. Then show them the R2 number. Storage migration is a one-time effort; the savings are every month after.

**"We need enterprise support."**
> Backblaze and Cloudflare both offer paid support tiers. This is additive cost, not a blocker — and it still typically comes in well under managed platform pricing.

**"Our team isn't technical enough to manage this."**
> The app is a single desktop install. The operator interface is designed for media teams, not cloud engineers. The only backend credentials required are B2 and R2 API keys, which a 15-minute setup doc covers.

**"What if we grow out of it?"**
> The architecture scales linearly. $0.13/hour and $0/GB playback do not change at 5,000 hours any more than at 50. There is no tier cliff.

**"What about local storage costs?"**
> The app is explicit: shoot-folder video stays local. Clients use drives and NAS they already own. The cloud cost quoted here is for cloud-only assets only.

---

## Key Numbers to Keep Handy

| Metric | Value |
| --- | --- |
| Cost per retained VOD hour per month | $0.11–$0.16 (range by source file size) |
| Playback delivery cost | $0.00 |
| Cost per 1,000 uploaded images per month | ~$0.06–$0.08 |
| 1,000-hour VOD library, monthly | ~$128 |
| 50-hour library + 10k images, monthly | ~$7 |

---

## Summary: Why We Should Be Selling This

1. **The cost story is genuinely unusual.** Most clients have never been quoted $0 delivery fees and sub-$0.15/hour VOD storage in the same breath.
2. **The workflow addresses a real gap.** Sports and event media teams deal with ingest, local offload, and cloud delivery as three separate problems. This solves all three from one app.
3. **The architecture is defensible.** Backblaze and Cloudflare are established, reputable infrastructure providers — not startups. The cost advantage is structural, not promotional.
4. **It scales without budget surprises.** Linear pricing with zero egress means clients can grow without the contract renegotiation cycle that enterprise platforms require.
5. **The demo sells itself.** Drop a file into the watch folder, watch it transcode and upload, play it back from R2. The workflow is visible end-to-end in under five minutes.

---

*For technical pricing detail, source pricing references, and the full architecture breakdown, see `docs/MEDIA_COST_ASSESSMENT.md`.*

# Media Storage Cost Assessment

Last updated: June 15, 2026

This assessment estimates the recurring cloud cost for CSN Media Bridge VOD assets and uploaded still images. It is based on the current application behavior and public provider pricing available on June 15, 2026.

## Executive Summary

The current storage design is cost-efficient for media:

- VOD source archives are stored in Backblaze B2.
- VOD playback packages are stored in Cloudflare R2.
- Offload image uploads are stored in Backblaze B2.
- Offload video files remain local and are not uploaded by the offload workflow.
- Convex stores metadata, not the heavy media files, so Convex media storage cost should be negligible unless the architecture changes to store files in Convex.

Using the baseline assumptions below, retained VOD costs about **$0.13 per finished video hour per month** across B2 archive storage and R2 playback storage. Uploaded still images are much cheaper by comparison: **about $0.07 per 1,000 uploaded images per month** when both originals and WebP copies are uploaded.

## Current App Behavior

### VOD Ingest

For normal VOD ingest, the app:

1. Watches for completed MP4 files.
2. Transcodes/packages playback output with FFmpeg.
3. Uploads the original source MP4 to Backblaze B2.
4. Uploads playback output to Cloudflare R2.
5. Registers the completed media record in Convex.

Default storage prefixes:

| Storage | Default prefix | Purpose |
| --- | --- | --- |
| Backblaze B2 | `vod/archive` | Original source MP4 archive |
| Cloudflare R2 | `vod/hls` | Playback-ready distribution assets |

For videos longer than 60 seconds, `auto` delivery resolves to HLS. The HLS package currently creates four renditions:

| Rendition | Video bitrate |
| --- | ---: |
| 1080p | 6,000 kbps |
| 720p | 3,200 kbps |
| 480p | 1,600 kbps |
| 360p | 850 kbps |

With audio, each rung is encoded at 128 kbps. That makes the encoded HLS package approximately:

```text
Video: 6,000 + 3,200 + 1,600 + 850 = 11,650 kbps
Audio: 128 * 4 = 512 kbps
Total: 12,162 kbps
One hour: 12,162,000 bits/sec * 3,600 sec / 8 = 5.47 GB
Planning estimate with packaging overhead: 5.75 GB per VOD hour in R2
```

Short clips at or below 60 seconds may use progressive delivery instead. Progressive output is less deterministic because the H.264 encode can use hardware-specific quality settings and the optional AV1 encode depends on encoder availability.

### Uploaded Images

For manual offload, the app:

1. Copies the full source folder to a local offload package.
2. Optionally creates WebP copies under `web-ready/`.
3. Optionally uploads still-image assets to Backblaze B2.
4. Keeps video files local only.

When image upload is enabled, Backblaze receives:

- original image files
- optional WebP copies if WebP conversion is enabled

Default offload cloud prefix:

| Storage | Default prefix | Purpose |
| --- | --- | --- |
| Backblaze B2 | `offloads` | Uploaded original still images and optional `web-ready/` WebP copies |

## Provider Pricing Used

Pricing can change, so re-check before committing client-facing numbers.

| Provider | Pricing item | Rate used |
| --- | --- | ---: |
| Backblaze B2 | Storage | $6.95 per TB-month |
| Backblaze B2 | Egress | Free up to 3x average monthly storage, then $0.01/GB unless routed through eligible partners |
| Backblaze B2 | Transactions | Class A/B/C free; Class D $0.004 per 10,000 after 2,500 free per day |
| Cloudflare R2 Standard | Storage | $0.015 per GB-month |
| Cloudflare R2 Standard | Class A operations | $4.50 per million requests |
| Cloudflare R2 Standard | Class B operations | $0.36 per million requests |
| Cloudflare R2 Standard | Egress | Free |
| Convex | Database metadata | Usually negligible for this workload; paid plan starts at $25/developer/month if needed |

Free tiers that may reduce the bill:

- Backblaze B2: first 10 GB storage is free.
- Cloudflare R2 Standard: 10 GB-month storage, 1 million Class A operations, and 10 million Class B operations are free each month.
- Convex Free/Starter includes built-in database and file storage allowances, but this app stores media in B2/R2 rather than Convex file storage.

## Baseline Assumptions

These assumptions are intentionally conservative enough for planning, while still matching the current code path.

| Item | Baseline |
| --- | ---: |
| Source MP4 archive size | 6 GB per finished VOD hour |
| HLS playback package size | 5.75 GB per finished VOD hour |
| Average original still image size | 8 MB |
| Average WebP copy size | 2.4 MB |
| Image upload with WebP enabled | 10.4 MB per image |
| B2 egress from archives/offloads | Near $0 in normal operation |
| R2 egress for playback | $0 |

Actual source MP4 sizes may vary widely. A 1080p source at 8 Mbps is roughly 3.7 GB/hour; a 20 Mbps source is roughly 9.0 GB/hour. The R2 HLS estimate is more stable because the app controls the HLS ladder.

## VOD Recurring Storage Estimate

Baseline monthly cost per retained VOD hour:

```text
B2 archive: 6 GB * $0.00695/GB-month = $0.0417/month
R2 playback: 5.75 GB * $0.015/GB-month = $0.0863/month
Total: $0.128/month per retained VOD hour
```

| Retained VOD hours | B2 archive/month | R2 playback/month | Estimated total/month |
| ---: | ---: | ---: | ---: |
| 10 | $0.42 | $0.86 | $1.28 |
| 50 | $2.09 | $4.31 | $6.40 |
| 100 | $4.17 | $8.63 | $12.80 |
| 250 | $10.43 | $21.56 | $31.99 |
| 500 | $20.85 | $43.13 | $63.98 |
| 1,000 | $41.70 | $86.25 | $127.95 |

Sensitivity by source archive size:

| Source archive assumption | Total per retained VOD hour/month |
| --- | ---: |
| 3 GB/hour source | $0.107 |
| 6 GB/hour source | $0.128 |
| 10 GB/hour source | $0.156 |

## VOD Operations Estimate

Storage is the primary recurring cost. Operations are usually secondary, but HLS creates many small objects.

For a one-hour HLS VOD:

```text
2-second segments * 4 variants = about 7,200 media segment objects
Plus playlists, init segments, and poster = about 7,209 uploaded objects per hour
```

Cloudflare R2 includes 1 million Class A operations per month. Above that free tier, Class A operations cost $4.50 per million. Cloudflare rounds operation usage up to the next million-request billing unit, so the table below uses conservative rounded estimates.

| New HLS hours uploaded in a month | Approx. R2 upload objects | Estimated Class A charge after free tier |
| ---: | ---: | ---: |
| 100 | 720,900 | $0.00 |
| 250 | 1,802,250 | $4.50 |
| 500 | 3,604,500 | $13.50 |
| 1,000 | 7,209,000 | $31.50 |

Playback Class B operations are also low compared with storage. A player normally downloads one HLS variant at a time, so one viewer-hour is approximately 1,800 segment GETs plus playlist requests. If usage exceeds the 10 million free Class B operations/month, every 1,000 additional viewer-hours is roughly:

```text
1.8 million Class B requests * $0.36 / million = about $0.65 before billing-unit rounding
```

There is no R2 egress charge for playback bandwidth.

## Uploaded Images Recurring Storage Estimate

Baseline image assumptions:

```text
Original image: 8 MB
Optional WebP copy: 2.4 MB
Original + WebP: 10.4 MB per image
B2 storage: $6.95/TB-month = $0.00695/GB-month
```

| Uploaded images | Originals only/month | Originals + WebP/month |
| ---: | ---: | ---: |
| 1,000 | $0.06 | $0.07 |
| 10,000 | $0.56 | $0.72 |
| 50,000 | $2.78 | $3.61 |
| 100,000 | $5.56 | $7.23 |

Image egress should normally be near $0 if B2 is used as archive/offload storage rather than public delivery. If image files are served heavily from B2 directly, egress must be reviewed against the free 3x storage allowance and the $0.01/GB overage rate.

## Combined Example Scenarios

These examples ignore free tiers, taxes, support plans, and one-time operation spikes. Actual invoices may be slightly lower at small scale because of free tiers.

| Scenario | Retained VOD | Uploaded images | Estimated storage/month |
| --- | ---: | ---: | ---: |
| Small season | 50 VOD hours | 10,000 images with WebP | $7.12 |
| Active monthly library | 250 VOD hours | 50,000 images with WebP | $35.60 |
| Large archive | 1,000 VOD hours | 100,000 images with WebP | $135.18 |

## What Is Not Included

This estimate does not include:

- local workstation storage
- backup drives or NAS storage
- FFmpeg processing hardware, electricity, or operator time
- Cloudflare paid plan fees, custom domains, Workers, Stream, Images, or CDN services outside R2
- Backblaze paid support, Object Lock retention, replication, or capacity commitments
- Convex paid plan fees beyond metadata usage
- taxes
- media lifecycle/versioning mistakes that retain deleted or duplicate objects

## Assessment

The current architecture is appropriate for cost control:

- R2 is the right place for public VOD playback because egress is free and HLS playback can create significant bandwidth.
- B2 is a good fit for original MP4 archives and still-image offload storage because retained storage cost is low and normal archive access should not create meaningful egress.
- The expensive risk is not images; it is accumulated VOD hours. Even then, a 1,000-hour retained VOD library is estimated around $128/month for media storage before free tiers.
- R2 operation charges only become noticeable when hundreds of HLS hours are uploaded in a single month or playback reaches high viewer-hour volume. Even then, the estimate remains modest because egress is free.
- The biggest accuracy variable is original source MP4 size. Actual B2 archive cost should be recalculated from real source file sizes once a representative month of ingest exists.

## Recommendations

1. Keep the existing B2/R2 split for VOD.
2. Keep offload video local unless there is a specific archive requirement for shoot-folder video files.
3. Use lifecycle policies or periodic audits for stale offload image prefixes if clients do not need indefinite retention.
4. Add a storage usage report that totals object size by prefix:
   - B2 `vod/archive`
   - B2 `offloads`
   - R2 `vod/hls`
   - future R2 `staging/social` and `scheduled/social`
5. For client estimates, quote a range of **$0.11-$0.16 per retained VOD hour/month**, plus image storage at roughly **$0.06-$0.08 per 1,000 images/month** depending on WebP duplication.

## Sources

- Backblaze B2 pricing: https://www.backblaze.com/cloud-storage/pricing
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Convex pricing: https://www.convex.dev/pricing
- App defaults and storage prefixes: `src/shared/defaults.ts`
- VOD packaging behavior: `src/main/services/TranscodeService.ts`
- B2/R2 upload behavior: `src/main/services/SyncService.ts`
- Offload image behavior: `src/main/services/OffloadService.ts`

# CSN Credential Broker

Mints short-lived, scoped storage credentials for CSN Media Bridge stations.

## Why

Stations upload with rclone, so they need real storage credentials on the
machine. Until now those were the **master** B2 and R2 keys, typed into Settings
and left there — anyone who could read a station's disk gained permanent write
**and delete** over every asset in both buckets, and rotating meant visiting
every station.

This service holds the master keys instead. A station asks for what it needs and
gets credentials scoped to one bucket, one prefix and one set of operations,
valid for hours.

> It does not keep secrets *from* the operator, and is not trying to. The app is
> a public client on a machine they control, so anything it can obtain, they
> can. What changes is the blast radius: a leaked credential is write access to
> one prefix for a few hours, instead of delete access to everything, forever.

## Playback

`GET /media/<object key>` streams a playback object out of the bucket for an
authenticated station, so R2 can stop being public. It serves only the prefixes
in `MEDIA_ALLOWED_PREFIXES`, so the archive stays out of reach, and it honours
`Range` so seeking in a long video still works.

Team isolation is enforced by asking the library, not by reading a team out of
the path — object keys are a contract shared with the web app and deliberately
carry no tenant. `media/ownership:resolveObjectKeyOwner` returns `allowed` as
the whole answer, so a Worker running an old build cannot get subtly wrong what
the schema already knows.

Decisions are cached for a minute, keyed by the *asset* a request resolved to,
because a player fetches hundreds of segments under one folder — otherwise a
single video would be hundreds of library queries. Lookups walk the object's
ancestor prefixes the same way the resolver matches, so a segment hits the entry
its manifest created.

It **fails closed**: a library that cannot be reached returns `503` rather than
serving.

### Before turning enforcement on

`REQUIRE_TEAM_MATCH` ships **off**. An asset with no owner recorded is *refused*
once it is on, so check coverage first:

```
media/ownership:ownershipCoverage   # unowned must be zero
media/ownership:backfillOwnerOrg    # stamps existing rows
```

Stations also need `X-CSN-Node-Token`, which the app sends automatically from
its configured library credential.

## What it does not do

- **Deletion is behind its own purpose.** `ingest` and `offload` never receive
  delete capability, so a compromised station token cannot wipe the archive.
  `delete` does — and should be changed to require an operator's identity rather
  than a station's once machine identity moves to Clerk.
- **It authenticates stations, not people.** Media requests come from the app's
  host process, not the browser, so they carry the station token. Whoever is
  signed in is gated at the app's own sign-in screen, not here.

## Setup

```bash
pnpm install
```

> pnpm may report `ERR_PNPM_IGNORED_BUILDS` for `esbuild` and `workerd`. Wrangler
> still works; run `pnpm approve-builds` once to silence it.

Fill in the public values in `wrangler.toml`: `CF_ACCOUNT_ID`, `R2_BUCKET`,
`B2_BUCKET_ID`, and the prefix allowlists.

Then the secrets, none of which are ever committed:

```bash
wrangler secret put STATION_TOKENS            # one per station, newline separated
wrangler secret put CF_API_TOKEN              # Cloudflare API token with R2 admin
wrangler secret put R2_PARENT_ACCESS_KEY_ID   # access key id of that same token
wrangler secret put B2_MASTER_KEY_ID          # B2 key able to create keys
wrangler secret put B2_MASTER_APPLICATION_KEY
```

Generate a station token with something unguessable — `openssl rand -hex 32`.
Give each station its own, so one can be revoked without disturbing the rest.

```bash
pnpm run deploy
```

## Pointing a station at it

**Settings → Show advanced settings → Storage credentials**: the broker address
and that station's token.

Leave it empty and nothing changes — the station keeps using the keys in
Settings. A station refreshes credentials in the background every two hours and
**falls back to its local keys if the broker is unreachable**, so this service
being down slows nothing and stops nothing.

## API

```
POST /credentials
Authorization: Bearer <station token>

{ "purpose": "ingest" | "offload" | "delete",
  "r2Prefixes": ["streaming/vod/"],
  "b2NamePrefix": "masters/" }
```

```json
{
  "expiresAt": "2026-09-12T18:00:00.000Z",
  "r2": { "accessKeyId": "…", "secretAccessKey": "…", "sessionToken": "…" },
  "b2": { "keyId": "…", "applicationKey": "…" }
}
```

Prefixes outside the configured allowlists are refused with `403`, so a station
cannot ask for the whole bucket. `GET /health` returns `{"ok":true}`.

## Making the bucket private

Deploying this changes nothing on its own. To actually close the hole:

1. Deploy the Worker and point stations at it.
2. Turn on **Settings → advanced → Storage credentials → Stream playback through
   the broker** and confirm video still plays.
3. **Move the CSN sports web app first.** It reads the same R2 objects over the
   same public base URL, and will break the moment the bucket goes private.
4. Only then remove public access from the bucket.

Steps 1 and 2 are reversible and safe to do now; step 4 is the one that bites.

## Rotating

Replace the master keys here and redeploy. Stations pick up new credentials on
their next refresh without being touched — the reason this exists as much as the
security is.

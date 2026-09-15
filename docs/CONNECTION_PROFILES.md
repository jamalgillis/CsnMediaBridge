# Connection Profiles

Connection profiles make workstation setup repeatable without embedding
long-lived credentials in the desktop app.

## What A Profile Contains

Profiles may include:

- Convex deployment URL and media mutation path
- B2 bucket, archive prefix, and S3 endpoint
- R2 account id, bucket, playback prefix, and public base URL
- offload image prefix
- app update feed settings

Profiles intentionally exclude:

- Convex node token
- B2 key id
- B2 application key
- R2 access key id
- R2 secret access key

Those secrets still need to be issued per workstation. They are stored in the
OS keychain/Credential Manager, while `settings.json` keeps only non-secret
configuration.

## Operator Flow

1. Open Settings.
2. Import the team connection profile.
3. Add this workstation's node token and scoped B2/R2 keys.
4. Save configuration.

An already-configured workstation can export a new profile from Settings. The
exported file is safe to share with operators because credential fields are not
written to the profile.

## Build-Time Defaults

For an even shorter setup, build the desktop app with public defaults:

```bash
CSN_CONVEX_DEPLOYMENT_URL="https://example.convex.cloud" \
CSN_CONVEX_MUTATION_PATH="media/videos:createVodEntry" \
CSN_B2_BUCKET="csn-archive" \
CSN_B2_S3_ENDPOINT="https://s3.us-west-004.backblazeb2.com" \
CSN_R2_ACCOUNT_ID="account-id" \
CSN_R2_BUCKET="csn-playback" \
CSN_R2_PUBLIC_BASE_URL="https://media.example.com" \
corepack pnpm run tauri:build
```

The app still will not contain storage keys or node tokens.

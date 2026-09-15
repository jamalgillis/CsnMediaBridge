# Releasing Media Bridge

This app now supports hosted desktop updates for packaged builds.

Current release policy:

- Windows: production updater path
- macOS: signed updater artifact; notarization is still recommended before broad external distribution

## 1. Create the dedicated GitHub repo

This app is now its own local Git repository at:

- `/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge`

To create the GitHub repo from this machine:

```bash
gh auth login -h github.com
gh repo create jamalgillis/CsnMediaBridge --public --source . --remote origin --push
```

If you prefer a private repo, change `--public` to `--private`.

## 2. Enable GitHub Pages

The updater feed is designed to publish to GitHub Pages for a stable public URL while GitHub Releases stores the versioned artifacts.

After the repo exists:

1. Open repository settings.
2. Go to `Pages`.
3. Set the source to `GitHub Actions`.

The updater feed URL will become:

- `https://jamalgillis.github.io/CsnMediaBridge`

The app expects platform-specific folders below that base URL:

- macOS arm64: `.../darwin/arm64/`
- Windows x64: `.../win32/x64/`

## 3. Enable GitHub Actions releases

The workflow needs the Tauri updater signing key in GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, if the key has a password

The checked-in workflow will:

- build a signed macOS updater artifact
- build a Windows Squirrel release
- upload both sets of artifacts to GitHub Releases
- deploy the updater feed to GitHub Pages

Copy [`.env.release.example`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/.env.release.example) to your own local release env file if you also want to build release artifacts locally.

## 4. Push a release tag

The checked-in workflow at [release.yml](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/.github/workflows/release.yml) runs on tags that start with `v`.

Example:

```bash
git tag v1.0.1
git push origin v1.0.1
```

That workflow will:

- build the macOS release
- build the Windows release
- create or update the matching GitHub Release
- upload the packaged release files as release assets
- deploy the macOS and Windows updater feeds to GitHub Pages

## 5. Ship one updater-enabled build manually

Users need one manual upgrade to a build that includes the updater. After that, the app can:

- on Windows:
  - check for new builds on launch and on a timer
  - download updates in the background
  - prompt the user to install the update in-app
- on macOS:
  - check for new builds on launch and on a timer
  - install signed updater artifacts
  - still benefit from Apple notarization before being handed to non-technical operators

## Notes

In-app updates are handled by `tauri-plugin-updater`.

### The signing key

Tauri refuses to install an update it cannot verify, so releases have to be
signed. Generate a keypair once:

```bash
pnpm exec tauri signer generate -w ~/.tauri/csn-media-bridge.key
```

- The **public** key goes in `src-tauri/tauri.conf.json` under
  `plugins.updater.pubkey`. It is already there.
- The **private** key is a secret. Keep it in a password manager and add it to
  the repository's Actions secrets as `TAURI_SIGNING_PRIVATE_KEY` (paste the
  file's contents, not its path). If you set a password on the key, add that as
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` too.
- `.gitignore` covers `*.key`, but the key should never be inside the repo at
  all.

> Losing the private key means existing installs can no longer verify updates
> from you. Recovering means shipping a new public key in a build every station
> has to install by hand.

### What a tagged release does

Pushing a `v*` tag runs `.github/workflows/release.yml`, which:

1. builds signed macOS and Windows bundles,
2. attaches the installers — `.dmg`, `-setup.exe`, `.msi` — plus the signed
   updater artifacts to the GitHub Release,
3. merges each platform's entry into a single `latest.json` and deploys it to
   GitHub Pages.

Point Settings → **Feed base URL** at the directory holding `latest.json`, e.g.
`https://<owner>.github.io/<repo>`.

- Add Apple Developer ID signing and notarization to the `tauri build` step
  before sending macOS installers to non-technical operators outside your own
  controlled machines.

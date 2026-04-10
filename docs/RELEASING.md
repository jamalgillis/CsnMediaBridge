# Releasing CSN Media Bridge

This app now supports hosted desktop updates for packaged builds.

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

- `https://jamalgillis.github.io/CsnMediaBridge/downloads`

The app expects platform-specific folders below that base URL:

- macOS arm64: `.../darwin/arm64/`
- Windows x64: `.../win32/x64/`

## 3. Add GitHub Actions secrets

Add these repository secrets before pushing a release tag:

- `APPLE_CERTIFICATE_P12_BASE64`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_KEYCHAIN_PASSWORD`
- `APPLE_SIGN_IDENTITY`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

The workflow imports the `Developer ID Application` certificate into a temporary keychain, signs the mac app, notarizes it, uploads the release assets to GitHub Releases, and deploys the updater feed to GitHub Pages.

To create `APPLE_CERTIFICATE_P12_BASE64` locally:

```bash
base64 -i /path/to/DeveloperIDApplication.p12 | pbcopy
```

Copy [`.env.release.example`](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/.env.release.example) to your own local release env file if you also want signed local release builds outside CI.

## 4. Push a release tag

The checked-in workflow at [release.yml](/Users/jamalgillis/Code/Projects/Web/Apps/CsnMediaBridge/.github/workflows/release.yml) runs on tags that start with `v`.

Example:

```bash
git tag v1.0.1
git push origin v1.0.1
```

That workflow will:

- build the signed macOS release
- create or update the matching GitHub Release
- upload the packaged release files as release assets
- deploy `RELEASES.json` and the zip file to GitHub Pages

## 5. Ship one updater-enabled build manually

Users need one manual upgrade to a build that includes the updater. After that, the app can:

- check for new builds on launch and on a timer
- download updates in the background
- prompt the user to install the update in-app

## Notes

- macOS auto-updates require a signed app.
- Notarization is strongly recommended so users do not hit Gatekeeper warnings.
- GitHub CLI auth is currently invalid on this machine, so `gh auth login -h github.com` still needs to be run before creating the remote repo from here.
- There is currently no signing identity installed in Keychain on this machine, so a fully signed local macOS release still requires the `Developer ID Application` certificate to be installed locally.

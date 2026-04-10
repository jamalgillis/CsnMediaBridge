# Releasing CSN Media Bridge

This app now supports hosted desktop updates for packaged builds.

Current release policy:

- Windows: production updater path
- macOS: update-visible manual download path

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

## 3. Enable GitHub Actions releases

No additional GitHub secrets are required for the current workflow.

The checked-in workflow will:

- build an unsigned macOS release
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
  - show that a newer build exists
  - open the hosted download when the user chooses to update

## Notes

- Windows uses the native Electron / Squirrel updater path.
- macOS does not use native in-app install yet because Electron requires a signed app for automatic updates on macOS.
- macOS users can still see that an update exists, download the newer build, replace the app, and approve it in `Privacy & Security` if Gatekeeper blocks it.
- If you later add a paid Apple Developer account, the repo is already close to supporting signed/notarized macOS releases.

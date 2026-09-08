#!/usr/bin/env bash
#
# Removes this repository's ability to deploy or talk to the retired standalone
# Convex backend, now that the media functions live in the sports app.
#
# Why this exists: `convex/` here still contains a deployable schema, and
# `.env.local` still names the old deployment. Together they are a live footgun —
# `npx convex dev` in this directory would resurrect the old backend and start
# writing to it again, silently splitting the library across two databases.
#
# What it does NOT do: delete the Convex project itself. There is no CLI command
# for that; it is a dashboard action, and it is printed as a final manual step so
# it stays a deliberate choice.
#
# Run `scripts/verify-migration.mjs` first. This refuses to run without --confirm.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ "${1:-}" != "--confirm" ]]; then
  cat <<'USAGE'
Decommission the retired Media Bridge Convex backend.

This will:
  1. Archive convex/ to a timestamped tarball outside the repo
  2. Delete convex/ from this repository
  3. Neutralize the Convex entries in .env.local
  4. Drop the Convex section from CLAUDE.md

Six files under convex/ were never committed, so the archive in step 1 is the
only copy that survives. It is written outside the repo on purpose.

Verify the migration first:

  OLD_CONVEX_URL=… NEW_CONVEX_URL=… MEDIA_BRIDGE_NODE_TOKEN=… \
    node scripts/verify-migration.mjs

Then re-run with:

  scripts/decommission-old-backend.sh --confirm
USAGE
  exit 1
fi

if [[ ! -d convex ]]; then
  echo "convex/ is already gone — nothing to decommission."
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$HOME/csn-media-bridge-convex-legacy-$STAMP.tgz"

echo "==> Archiving convex/ to $ARCHIVE"
tar -czf "$ARCHIVE" convex
echo "    $(du -h "$ARCHIVE" | cut -f1) written"

echo "==> Removing convex/ from the repository"
rm -rf convex

echo "==> Neutralizing Convex entries in .env.local"
if [[ -f .env.local ]]; then
  cp .env.local ".env.local.bak-$STAMP"
  # Commented rather than deleted: the values are the only local record of which
  # deployment this app used to point at, and a commented line explains itself
  # to whoever finds it next.
  python3 - <<'PY'
import re

path = ".env.local"
with open(path) as handle:
    lines = handle.readlines()

note = (
    "# Retired: the media backend moved into the CSN sports app's Convex\n"
    "# deployment. Do not run `npx convex dev` or `npx convex deploy` here —\n"
    "# see docs/CONVEX_DEPLOYMENT_TOPOLOGY.md.\n"
)

out = []
inserted = False
for line in lines:
    if re.match(r"^(CONVEX_DEPLOYMENT|VITE_CONVEX_URL|VITE_CONVEX_SITE_URL)=", line):
        if not inserted:
            out.append(note)
            inserted = True
        out.append("# " + line)
    else:
        out.append(line)

with open(path, "w") as handle:
    handle.writelines(out)
PY
  echo "    backup at .env.local.bak-$STAMP"
else
  echo "    no .env.local — skipped"
fi

echo "==> Updating CLAUDE.md"
python3 - <<'PY'
import os, re

path = "CLAUDE.md"
if not os.path.exists(path):
    raise SystemExit(0)

with open(path) as handle:
    text = handle.read()

replacement = """<!-- convex-ai-start -->
This project has no Convex backend of its own.

The media pipeline's Convex schema and functions live in the CSN sports app at
`Websites/csn/convex/`, under `convex/media/`, sharing one deployment with the
sports site. This app is a client of it — see
`docs/CONVEX_DEPLOYMENT_TOPOLOGY.md`.

**Do not run `npx convex dev` or `npx convex deploy` from this repository.** A
Convex deployment can be pushed to by exactly one codebase, and `deploy`
replaces the entire function set.
<!-- convex-ai-end -->"""

updated, count = re.subn(
    r"<!-- convex-ai-start -->.*?<!-- convex-ai-end -->",
    replacement,
    text,
    flags=re.S,
)

if count:
    with open(path, "w") as handle:
        handle.write(updated)
    print("    CLAUDE.md now points at the sports app")
else:
    print("    no Convex block found in CLAUDE.md — left alone")
PY

cat <<EOF

Done. Remaining manual step:

  Delete the Convex project itself in the dashboard. There is no CLI command
  for it, which is a good thing — it should be a deliberate click.

    npx convex dashboard

  Settings -> Delete project. Do this only once you are satisfied the sports
  deployment has everything; the archive at
  $ARCHIVE
  holds the function source, but not the data.

Review and commit:

  git status
  git add -A && git commit -m "Retire the standalone Convex backend"
EOF

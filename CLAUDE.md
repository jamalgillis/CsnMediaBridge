<!-- convex-ai-start -->
This project has no Convex backend of its own.

The media pipeline's Convex schema and functions live in the CSN sports app at
`Websites/csn/convex/`, under `convex/media/`, sharing one deployment with the
sports site. This app is a client of it — see
`docs/CONVEX_DEPLOYMENT_TOPOLOGY.md`.

**Do not run `npx convex dev` or `npx convex deploy` from this repository.** A
Convex deployment can be pushed to by exactly one codebase, and `deploy`
replaces the entire function set.
<!-- convex-ai-end -->

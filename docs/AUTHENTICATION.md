# Authentication

Last reviewed: September 12, 2026

CSN Media Bridge has **two identities**, and keeping them apart is the whole
design.

| | What it is | What it governs |
|---|---|---|
| **The station** | A machine credential — today the Convex node token in Settings | Whether the pipeline runs: watch, convert, upload, register |
| **The operator** | A Clerk user, in a Clerk Organization | What a person sitting at the window can see and change |

This app is an unattended ingest node. `autoWatch` starts the watch-folder loop
at launch and the live-stream handoff worker claims jobs on its own — both in
the Rust host, neither of which consults the renderer. A station left at the
sign-in screen overnight still ingests everything dropped into its folder.

> That separation is not incidental. Gating the pipeline on a user session would
> mean an expired token at 2am silently stops ingest, and nobody finds out until
> morning. Sign-in governs the window, not the work.

## How sign-in works

OAuth 2.0 Authorization Code with **PKCE** and a **loopback redirect** — Clerk's
own documented flow for native applications. The whole exchange lives in the
Rust host.

```
[Bridge]  "Sign in"
    │
    ├─ binds 127.0.0.1:4517 (or 4518 / 4519 if taken)
    ├─ opens the operator's real browser at
    │  {issuer}/oauth/authorize?…&code_challenge=…&redirect_uri=http://127.0.0.1:4517/callback
    │
    │   [Browser]  Clerk → Google / password / MFA → consent (+ team picker)
    │        │
    │        └─ 302 → http://127.0.0.1:4517/callback?code=…&state=…
    │
    ├─ verifies `state`, exchanges code + verifier at {issuer}/oauth/token
    ├─ reads {issuer}/oauth/userinfo  → sub, name, email, org_id, org_name, org_slug
    └─ writes access + refresh tokens to auth.json in application support
```

### Three deliberate choices

**Sign-in happens in the real browser, not this window.** Google and most
providers refuse OAuth from an embedded webview, to stop a hostile app
harvesting credentials behind a convincing form. A browser the operator already
trusts is the right place to type a password.

**Loopback, not a custom URL scheme.** Any other application on the machine can
register `csnmediabridge://` and intercept the callback; Tauri's own docs warn a
user "could trigger a fake deep link manually." A loopback port bound by this
process cannot be claimed by another while it holds it, and RFC 8252 recommends
loopback for native apps. The port is one of three fixed values rather than an
ephemeral one, because authorization servers generally match the redirect URI
exactly — every port has to be registered, so the set is kept small and known.
`state` is checked on the way back so another page cannot drive the callback.

**Identity has a fallback.** `/oauth/userinfo` is an OpenID Connect endpoint,
and an instance need not serve it to a token granted only OAuth scopes. When it
refuses, the operator's name, email and organization are read from the access
token's own claims instead — Clerk issues those as JWTs. The token is not
verified there, deliberately: it came back over TLS from a token endpoint this
process had just called, so it has not crossed a trust boundary.

**Tokens live in the host, not the webview.** The refresh token is long-lived.
It sits in `auth.json` in the application-support directory, not in webview
local storage where a page bug could reach it. The renderer never sees a token;
it calls `getToken()` and the host hands over an access token, refreshing first
if the old one is spent.

### Teams

`user:org:read` is in the requested scopes. That makes Clerk show an
organization picker on the consent screen and puts `org_id` in the token and on
`/userinfo`. `org_name` and `org_slug` usually come back too, but an instance
only has to advertise `org_id`, so the displayed team name falls back through
slug to a generic label rather than showing a bare identifier.

`offline_access` is requested alongside them. That is the scope that asks for a
refresh token; without it the session ends when the access token expires and the
operator is bounced back to the gate a day later.

**The team is bound to the token at consent time.** Switching teams means
signing in again and picking a different one — there is no in-app switcher,
because the token cannot be re-scoped without a new authorization.

### Turning it on

Sign-in is **off** unless the station has both an issuer and a client id. They
are public values, settable two ways:

```bash
CLERK_OAUTH_ISSUER=https://accounts.example.com \
CLERK_OAUTH_CLIENT_ID=your_client_id \
pnpm run build
```

…or per station under **Settings → advanced → Sign-in**, which is what makes a
single white-label build retargetable at a different Clerk instance without a
rebuild.

### Setting up the Clerk OAuth application

This needs an **OAuth application** (Clerk acting as the identity provider), not
just social connections.

1. **Enable the `Public` option on the app.** A desktop binary cannot keep a
   secret — anyone can decompile it — so this is a public client and PKCE stands
   in for the client secret. Clerk enforces that pairing: PKCE is required for
   clients without a secret, and the token exchange this app performs sends no
   secret at all.

   Leaving it confidential fails at the **token exchange**, not at sign-in: the
   browser completes, the code comes back, and then the token endpoint answers
   `401 invalid_client`. If the dashboard offers no way to convert an existing
   application, create a new one and choose public at creation.

   To check without signing in, post a deliberately invalid code to the token
   endpoint with no secret. `invalid_client` means it is still confidential;
   `invalid_grant` means client authentication passed and the app is public.
2. **Never put the Client Secret in this app.** It belongs to a server-side
   client. If one was generated, it stays unused; regenerate it if it has been
   pasted anywhere.
3. **Enable the scopes the app asks for** on the OAuth application:
   `profile`, `email`, `offline_access`, `user:org:read`. An instance listing a
   scope under `scopes_supported` is not enough — each application has its own
   allowlist, and one missing scope fails the whole sign-in with
   `invalid_scope`.

   `openid` is **not** requested. It only yields an ID token, which this app
   never reads, and Clerk OAuth applications do not necessarily permit it.
   Asking for a scope the client is not granted fails everything, so it is left
   out rather than requested on the chance it is useful.
4. **Register all three redirect URIs**, since the app falls back through them
   when a port is taken:
   - `http://127.0.0.1:4517/callback`
   - `http://127.0.0.1:4518/callback`
   - `http://127.0.0.1:4519/callback`
5. Take the **issuer** from the Discovery URL — everything before
   `/.well-known/openid-configuration` — and the **Client ID**. Both are public.

The endpoint paths this app builds (`/oauth/authorize`, `/oauth/token`,
`/oauth/userinfo`) are the ones Clerk lists on that page, so nothing else needs
configuring.

A station with neither value runs exactly as it did before sign-in existed: no
gate, every screen reachable. That keeps un-migrated stations working, and
Settings → Team says so plainly so nobody mistakes an ungated station for a
secure one.

## What is not built

### The storage gatekeeper — built, not yet switched on

`GET /media/<object key>` on the broker streams playback for an authenticated
station, and the app can route playback through it (Settings → advanced →
Storage credentials). Both are off by default, because the bucket is still
public and the **CSN sports web app reads the same objects** — it breaks the
moment the bucket goes private, so the two have to move together.

With `REQUIRE_TEAM_MATCH` on, it also enforces that the station's organization
owns the asset — by asking `media/ownership:resolveObjectKeyOwner` in the
library rather than reading a team out of the object key, since keys are a
contract shared with the web app and carry no tenant. It fails closed, and
refuses assets that have no owner recorded, so run
`media/ownership:ownershipCoverage` and the backfill before switching it on.

Until the bucket is private, playback is served from **R2 over its public base
URL** and anyone with a URL can fetch a video. B2 — the cold archive — is
already private, and archive previews are signed in-process with SigV4
(`presign_b2_object_url`).

> Sign-in does **not** protect the videos. It decides what the window shows you.
> A token in the renderer cannot gate a public CDN, because nothing on that path
> reads an `Authorization` header. Filtering the UI by team is not
> authorization: a URL copied from the app, or read out of the Convex record,
> still works in `curl`.

Closing it means a Cloudflare Worker in front of a private bucket that verifies
the Clerk token and checks the caller's team owns the asset. `getToken()` exists
for exactly that call. Two things to know first:

- **The CSN sports web app reads the same R2 keys.** Making the bucket private
  breaks the web app unless both move together.
- **Do not put the team in the object key.** Keys follow
  `docs/STORAGE_LAYOUT.md`, and that layout is a contract with the sports app.
  The Worker should ask Convex which team owns an asset — no migration, and it
  works for everything already stored.

### Offline

There is no offline mode as a feature, but the split holds: local work carries
on and cloud work waits.

A signed-in station stays signed in with no network. The session loads from disk
at launch, and a renewal that cannot reach the service keeps the session rather
than ending it — being unable to *ask* whether a session is valid is not the
same as being told it is not. Only an outright refusal signs the operator out.
Without that distinction a station in a truck would lock itself out overnight,
including from screens that need no network at all.

### The write credentials — now brokered

This was the larger exposure, and it is addressed. A station with a broker
configured no longer holds the master B2 and R2 keys: it receives credentials
scoped to one bucket, one prefix and one set of operations, valid for hours.

- **R2** — `POST /accounts/{id}/r2/temp-access-credentials`, `object-read-write`
  on the streaming and poster prefixes. These are SigV4 *session* credentials,
  so rclone gets a `session_token` alongside them.
- **B2** — `b2_create_key` with `validDurationInSeconds`, `namePrefix` and
  `bucketIds`. Capabilities never include `deleteFiles` for routine work.

Two properties matter more than the scoping. Credentials refresh in the
background, so no transfer ever waits on the broker; and a station **falls back
to its local keys when the broker is unreachable**, so the service being down
slows nothing and stops nothing. Leaving the broker unset keeps the previous
behaviour exactly.

The service and its setup live in `worker/`.

> Still true: this does not keep secrets *from* the operator, and does not try
> to. A public client on a machine someone controls can always be read. What
> changed is the blast radius — write access to one prefix for a few hours,
> rather than delete access to everything, forever.

### Machine identity in Clerk

The station still authenticates to Convex with its node token rather than a
Clerk machine credential. Moving it would need the **sports app's** Convex
deployment to accept Clerk-issued machine tokens — work in that repo, which per
`CLAUDE.md` this one must never deploy to.

## Where the code is

| Path | What |
|---|---|
| `src-tauri/src/lib.rs` | `auth_sign_in`, `auth_status`, `auth_sign_out`, `auth_get_token`, and the PKCE + loopback exchange |
| `src/auth/authClient.ts` | Thin wrapper over those commands |
| `src/auth/AuthContext.tsx` | `useAuth()` — status, person, team, `getToken()` |
| `src/auth/SignInScreen.tsx` | The gate |
| `src/App.tsx` | Gate around the router, never around the pipeline |

Nothing outside `src/auth/` and the host's auth section knows the provider is
Clerk.

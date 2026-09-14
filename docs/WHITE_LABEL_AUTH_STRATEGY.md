# White-Label Authentication Strategy

This note captures the current auth direction for a future white-labeled
version of CSN Media Bridge and its companion web app.

## Recommendation

Use WorkOS for a white-labeled, multi-tenant platform unless the overriding goal
is the fastest possible Next.js implementation with prebuilt UI. Clerk remains a
good fit for small-team B2B and CSN-operated deployments, but WorkOS is the
better long-term foundation if the product is sold to many organizations that
may bring their own IT, SSO, directory sync, and security requirements.

Human authentication and machine authentication should stay separate:

- Human operators, admins, clients, and reviewers authenticate through the web
  identity provider.
- Desktop stations authenticate with scoped machine credentials. A station must
  keep ingesting and converting overnight without depending on a human session.

## Why WorkOS Fits White Labeling

A white-labeled version is likely to have multiple customer organizations, each
with their own operators, reviewers, brand, security rules, and eventually
identity-provider expectations. WorkOS is designed around that shape:

- Organizations are first-class and can own data, users, memberships, roles, and
  policies.
- Enterprise SSO and directory sync are core paths rather than late-stage
  add-ons.
- Admin Portal gives customer IT teams a place to manage SSO and directory
  setup without CSN building every screen.
- Multiple applications can share one identity layer, which maps well to a web
  admin app, public/review web surfaces, desktop clients, and later mobile or
  CLI surfaces.
- RBAC can be driven by organization memberships and, for larger customers, by
  identity-provider groups.

The product should still keep its own ownership model in Convex. Auth identifies
who a user is and which organization context they are acting in; Convex remains
the source of truth for media ownership, live-input mappings, storage keys,
handoff jobs, and workstation permissions.

## Where Clerk Still Makes Sense

Clerk is still a strong choice when speed and polished product UI matter most:

- It has excellent React and Next.js ergonomics.
- Organizations, roles, permissions, invitations, organization switching,
  verified domains, and prebuilt account UI are straightforward.
- It is a pragmatic fit for CSN-operated deployments and smaller tenants that do
  not need SSO or SCIM on day one.

The main concern is not capability so much as future posture. If white-label
customers start asking for SSO, directory sync, enterprise administration, and
custom security policies, WorkOS is more naturally aligned with those deals.

## Product Architecture Direction

For the future white-labeled product:

- Use an organization-required B2B model. All user-visible media operations
  should happen in an organization context, not a personal workspace.
- Store tenant ownership in Convex using stable organization identifiers and
  slugs. Do not rely on client-supplied owner arguments.
- Keep desktop station credentials tenant-scoped and rotatable. Treat lost
  machines as credential-rotation events.
- Let operations staff have an operations organization or elevated role that can
  support all tenants, while tenant stations and tenant users only see their own
  recordings.
- Avoid coupling Cloudflare, Backblaze, or Convex deployment secrets to a human
  login session. Long-running media work must survive sign-out, sleep/wake, and
  overnight operation.
- Plan for custom domains and branded login surfaces per white-label customer,
  but keep the backend media contract shared.

## Open Questions

- Whether each white-label customer gets a separate Convex deployment or shares
  one deployment with strict tenant scoping.
- Whether storage is fully per-tenant, shared with tenant prefixes, or hybrid.
- Whether customer IT admins need self-service station token management.
- Whether a white-label deployment should support both WorkOS and Clerk through
  an internal auth adapter during a transition period.
- How much of the current CSN media operations role should become a productized
  "platform support" role.

## Near-Term Decision

Keep the current CSN implementation working as-is. If an identical white-labeled
app is created, start the new product with WorkOS unless there is a deliberate
decision to optimize only for MVP speed.

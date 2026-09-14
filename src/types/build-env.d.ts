/// <reference types="vite/client" />

/**
 * Build-time defaults, substituted by Vite's `define` (see
 * `vite.renderer.config.ts`).
 *
 * A build can be shipped with a team's public backend coordinates already baked
 * in, so an operator installing on a new station does not have to type a bucket
 * name and a deployment URL before the app can do anything. Secrets never travel
 * this way — only the things a connection profile would carry.
 */
declare const __APP_UPDATE_BASE_URL__: string;
/** Clerk OAuth coordinates. Empty means this build has no sign-in. */
declare const __CLERK_OAUTH_ISSUER__: string;
declare const __CLERK_OAUTH_CLIENT_ID__: string;
declare const __CSN_BROKER_URL__: string;
declare const __CSN_B2_BUCKET__: string;
declare const __CSN_B2_PATH_PREFIX__: string;
declare const __CSN_B2_S3_ENDPOINT__: string;
declare const __CSN_R2_ACCOUNT_ID__: string;
declare const __CSN_R2_BUCKET__: string;
declare const __CSN_R2_PATH_PREFIX__: string;
declare const __CSN_R2_PUBLIC_BASE_URL__: string;
declare const __CSN_CONVEX_DEPLOYMENT_URL__: string;
declare const __CSN_CONVEX_MUTATION_PATH__: string;
declare const __CSN_OFFLOAD_B2_PATH_PREFIX__: string;

import type { AuthSnapshot } from '../shared/types';

/**
 * The renderer's view of sign-in.
 *
 * All of it lives in the Rust host: the browser handoff, the loopback
 * listener, the token exchange and the refresh token on disk. The window only
 * asks who is signed in and asks for a token when it needs one, so no
 * credential is ever held in webview storage where a page bug could reach it.
 */

function bridge() {
  return window.mediaBridge;
}

export async function readAuthStatus(): Promise<AuthSnapshot> {
  return bridge().authStatus();
}

/** Opens the operator's real browser and resolves once they come back. */
export async function startSignIn(): Promise<AuthSnapshot> {
  return bridge().authSignIn();
}

export async function signOut(): Promise<AuthSnapshot> {
  return bridge().authSignOut();
}

/**
 * A valid access token, renewed by the host if the old one is spent. Null when
 * the station is signed out — which is normal on an unattended node, so every
 * caller has to handle it rather than assume an operator is present.
 */
export async function getAccessToken(): Promise<string | null> {
  return bridge().authGetToken();
}

export function onAuthUpdate(listener: (snapshot: AuthSnapshot) => void) {
  return bridge().onAuthUpdate(listener);
}

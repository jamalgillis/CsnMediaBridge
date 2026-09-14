import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthPerson, AuthSnapshot, AuthStatus, AuthTeam } from '../shared/types';
import { getAccessToken, onAuthUpdate, readAuthStatus, signOut, startSignIn } from './authClient';

/**
 * Who is at the station.
 *
 * A narrow surface on purpose: nothing outside `src/auth/` knows that Clerk is
 * the provider, and no token ever reaches React state. The host holds the
 * tokens and hands one over only when something is about to make a request.
 */

export type { AuthPerson, AuthTeam, AuthStatus };

interface AuthValue {
  /** `checking` covers the first read, before the host has answered. */
  status: AuthStatus | 'checking';
  error: string | null;
  /** True while the operator is away in their browser. */
  isSigningIn: boolean;
  person: AuthPerson | null;
  team: AuthTeam | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<AuthSnapshot | null>(null);
  const [status, setStatus] = useState<AuthStatus | 'checking'>('checking');
  const [error, setError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);

  useEffect(() => {
    let cancelled = false;

    function apply(next: AuthSnapshot) {
      if (cancelled) {
        return;
      }
      setSnapshot(next);
      setStatus(next.status);
    }

    void readAuthStatus()
      .then(apply)
      .catch((readError: unknown) => {
        if (cancelled) {
          return;
        }
        // A host that cannot answer is treated as ungated rather than locking
        // the operator out of a station that was working a moment ago.
        setError(readError instanceof Error ? readError.message : String(readError));
        setStatus('unconfigured');
      });

    const unsubscribe = onAuthUpdate(apply);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const handleSignIn = useCallback(async () => {
    setIsSigningIn(true);
    setError(null);

    try {
      const next = await startSignIn();
      setSnapshot(next);
      setStatus(next.status);
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : String(signInError));
    } finally {
      setIsSigningIn(false);
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    try {
      const next = await signOut();
      setSnapshot(next);
      setStatus(next.status);
    } catch (signOutError) {
      setError(signOutError instanceof Error ? signOutError.message : String(signOutError));
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      error,
      isSigningIn,
      person: snapshot?.person ?? null,
      team: snapshot?.team ?? null,
      signIn: handleSignIn,
      signOut: handleSignOut,
      getToken: getAccessToken,
    }),
    [status, error, isSigningIn, snapshot, handleSignIn, handleSignOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider.');
  }

  return value;
}

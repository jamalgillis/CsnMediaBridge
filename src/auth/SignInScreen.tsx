import { ErrorNote, PageHeading, QuietNote } from '../components/csn/bridge';
import { GhostButton } from '../components/csn/ui';
import TitleBar from '../components/TitleBar';
import { useAuth } from './AuthContext';

/**
 * The gate.
 *
 * Signing in happens in the operator's real browser, not in this window —
 * Google and most identity providers refuse OAuth from an embedded webview, and
 * a browser the operator already trusts is the right place to type a password
 * anyway. The screen says so, so being sent to Safari or Chrome does not look
 * like something going wrong.
 *
 * It also says the station keeps working while nobody is signed in, because on
 * an unattended ingest node that is what someone needs to know before walking
 * away from a locked screen.
 */
export default function SignInScreen() {
  const { error, isSigningIn, signIn } = useAuth();

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-ink text-paper">
      <TitleBar />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[560px] px-[30px] pb-12 pt-[12vh]">
          <PageHeading
            title="Sign in"
            subhead="This station belongs to a team. Signing in decides which videos you see and what you can change."
          />

          <div className="pt-7">
            <GhostButton onClick={() => void signIn()} disabled={isSigningIn}>
              {isSigningIn ? 'Waiting for your browser…' : 'Sign in'}
            </GhostButton>
          </div>

          {isSigningIn ? (
            <div className="pt-4 text-[13px] text-pretty text-quiet">
              Your browser has opened. Finish signing in there and this window will carry on by
              itself.
            </div>
          ) : null}

          {error ? (
            <div className="pt-5">
              <ErrorNote>{error}</ErrorNote>
            </div>
          ) : null}

          <div className="pt-7">
            <QuietNote>
              Converting and uploading carry on while nobody is signed in — this station keeps
              working overnight. Signing in is only needed to look at the library or change
              settings.
            </QuietNote>
          </div>
        </div>
      </main>
    </div>
  );
}

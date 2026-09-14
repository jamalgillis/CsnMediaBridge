import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useBridge } from '../context/BridgeContext';
import { hasLiveStreamAttention, useLiveStreamJobs } from '../hooks/useLiveStreamJobs';
import { GhostButton, LiveDot } from './csn/ui';

/**
 * The rail.
 *
 * Bridge is an operator's station, not a pipeline console, so its navigation is
 * set in sentence-case sans rather than the site's condensed shout, and every
 * label names a thing the operator does — "Offload a card", "Trim a clip" —
 * rather than the subsystem behind it. A red dot on an item is the only signal
 * in the rail, and it means exactly one thing: something there needs you.
 *
 * The watcher lives in the footer because it is the app's own "live": while it
 * runs, videos arrive on their own and the rest of the app has work to show.
 */
const NAV_ITEMS = [
  { label: 'Home', to: '/dashboard' },
  { label: 'Live streams', to: '/live' },
  { label: 'Offload a card', to: '/offload' },
  { label: 'Videos', to: '/player' },
  { label: 'Trim a clip', to: '/trimmer' },
  { label: 'Settings', to: '/settings' },
] as const;

export default function Sidebar() {
  const { state, startWatching, stopWatching, checkForAppUpdates, installAppUpdate } = useBridge();
  const { jobs } = useLiveStreamJobs();
  const { status: authStatus, person, team, signOut } = useAuth();

  const needsAttention = state.jobs.some((job) => job.status === 'error');
  const liveNeedsAttention = hasLiveStreamAttention(jobs);

  const alerts: Record<string, boolean> = {
    '/dashboard': needsAttention,
    '/live': liveNeedsAttention,
  };

  const appUpdate = state.appUpdate;
  const updateActionable = appUpdate.status === 'downloaded' || appUpdate.status === 'available';

  return (
    <aside className="flex w-rail flex-none flex-col border-r border-rule bg-ink">
      {/* The lockup: the accent square that stands in for the CSN mark, and the
          one word this window is. */}
      <div className="flex-none px-4 pb-3.5 pt-4">
        <div className="flex items-center gap-[9px]">
          <div className="h-6 w-6 flex-none rounded-chip bg-accent" />
          <div className="font-display text-[19px] uppercase leading-none tracking-[.01em] text-paper">
            Bridge
          </div>
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-1">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `${isActive ? 'csn-nav-on' : 'csn-nav'} mb-0.5`}
          >
            <span className="flex-1 truncate text-left">{item.label}</span>
            {alerts[item.to] ? (
              <span className="h-[7px] w-[7px] flex-none rounded-full bg-accent" />
            ) : null}
          </NavLink>
        ))}
      </nav>

      {/* Who is at the station, and which team's work this is. A station with no
          sign-in configured shows nothing here rather than an empty slot. */}
      {authStatus === 'signed-in' && person ? (
        <div className="flex-none border-t border-rule-soft px-4 pb-3.5 pt-3.5">
          {team ? (
            <div className="truncate text-copy font-semibold text-paper">{team.name}</div>
          ) : null}

          <div className="mt-1.5 truncate text-caption text-quiet" title={person.email ?? undefined}>
            {person.name}
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="csn-disclosure mt-1.5 text-[12.5px]"
          >
            Sign out
          </button>
        </div>
      ) : null}

      <div className="flex-none border-t border-rule-soft px-4 pb-4 pt-3.5">
        <div className="flex items-center gap-2">
          <LiveDot dim={!state.isWatching} />
          <span className="text-caption text-body">
            {state.isWatching ? 'Watching for new videos' : 'Not watching'}
          </span>
        </div>
        <div className="mt-[11px] flex flex-col gap-2">
          <GhostButton onClick={() => void (state.isWatching ? stopWatching() : startWatching())}>
            {state.isWatching ? 'Pause watching' : 'Start watching'}
          </GhostButton>

          {/* The updater only takes a slot in the rail when it has something to
              say; otherwise it stays in Settings. */}
          {updateActionable ? (
            <GhostButton onClick={() => void installAppUpdate()} title={appUpdate.message}>
              {appUpdate.status === 'available' ? 'Download update' : 'Install update'}
            </GhostButton>
          ) : appUpdate.status === 'error' ? (
            <GhostButton onClick={() => void checkForAppUpdates()} title={appUpdate.message}>
              Retry update check
            </GhostButton>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

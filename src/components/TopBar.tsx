import { useLocation } from 'react-router-dom';
import { useBridge } from '../context/BridgeContext';
import StatusBadge from './StatusBadge';
import ThemeSwitch from './ThemeSwitch';

export default function TopBar() {
  const location = useLocation();
  const {
    state,
    startWatching,
    stopWatching,
    checkForAppUpdates,
    installAppUpdate,
  } = useBridge();
  const appUpdate = state.appUpdate;
  const updateBadge =
    appUpdate.status === 'downloaded'
      ? { tone: 'good' as const, label: 'Update Ready' }
      : appUpdate.status === 'available'
        ? { tone: 'warning' as const, label: 'Update Available' }
      : appUpdate.status === 'downloading'
        ? { tone: 'active' as const, label: 'Update Downloading' }
        : appUpdate.status === 'checking'
          ? { tone: 'neutral' as const, label: 'Checking Updates' }
          : appUpdate.status === 'error'
            ? { tone: 'danger' as const, label: 'Update Error' }
            : null;

  const topBarCopy =
    location.pathname === '/settings'
      ? {
          title: 'Settings',
          subtitle: 'Credentials, watch folders, and encoder controls',
        }
      : location.pathname === '/player'
        ? {
            title: 'Player View',
            subtitle: 'Review stored HLS outputs from the Convex library',
          }
        : location.pathname === '/trimmer'
          ? {
              title: 'Trim View',
              subtitle: 'Mark local clips and export a clean MP4 before ingest',
            }
        : {
            title: 'CSN Media Bridge',
            subtitle: 'Universal VOD Ingest',
          };

  return (
    <header
      className="sticky top-0 z-20 border-b border-surface-light-border bg-white/80 px-6 py-4
        backdrop-blur-xl dark:border-surface-border dark:bg-surface-deep/80"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        {/* Left: title */}
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-widest text-slate-400 dark:text-slate-500">
            {topBarCopy.subtitle}
          </p>
          <h2 className="mt-1 truncate text-xl font-bold text-slate-900 dark:text-white">
            {topBarCopy.title}
          </h2>
        </div>

        {/* Center: search */}
        <div className="hidden flex-1 justify-center md:flex">
          <div className="relative w-full max-w-sm">
            <svg
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <input
              type="text"
              placeholder="Search..."
              className="w-full rounded-widget border border-surface-light-border bg-surface-light-elevated py-2 pl-10 pr-4
                text-sm text-slate-700 outline-none transition
                placeholder:text-slate-400
                focus:border-primary-400/40 focus:ring-1 focus:ring-primary-400/20
                dark:border-surface-border dark:bg-surface-card dark:text-slate-200
                dark:placeholder:text-slate-500
                dark:focus:border-primary-400/40"
            />
          </div>
        </div>

        {/* Right: status + actions */}
        <div className="flex flex-wrap items-center gap-3">
          {state.isWatching ? (
            <StatusBadge tone="active">Watcher Live</StatusBadge>
          ) : (
            <StatusBadge tone="warning">Watcher Stopped</StatusBadge>
          )}

          {updateBadge ? <StatusBadge tone={updateBadge.tone}>{updateBadge.label}</StatusBadge> : null}

          <button
            onClick={() => void (state.isWatching ? stopWatching() : startWatching())}
            className="rounded-widget bg-primary-400 px-4 py-2 text-sm font-semibold text-primary-950
              transition hover:bg-primary-300 active:bg-primary-500"
          >
            {state.isWatching ? 'Stop Watcher' : 'Start Watcher'}
          </button>

          {appUpdate.status === 'downloaded' || appUpdate.status === 'available' ? (
            <button
              onClick={() => void installAppUpdate()}
              className="rounded-widget border border-secondary-400/30 bg-secondary-400/10 px-4 py-2 text-sm font-semibold
                text-secondary-700 transition hover:bg-secondary-400/20 dark:text-secondary-300"
              title={appUpdate.message}
            >
              {appUpdate.status === 'available' ? 'Download Update' : 'Install Update'}
            </button>
          ) : (
            <button
              onClick={() => void checkForAppUpdates()}
              disabled={
                appUpdate.status === 'unsupported' ||
                appUpdate.status === 'disabled' ||
                appUpdate.status === 'checking' ||
                appUpdate.status === 'downloading'
              }
              className="rounded-widget border border-surface-light-border bg-surface-light-elevated px-4 py-2 text-sm font-semibold
                text-slate-700 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-60
                dark:border-surface-border dark:bg-surface-elevated dark:text-slate-200 dark:hover:bg-surface-card"
              title={appUpdate.message}
            >
              {appUpdate.status === 'checking'
                ? 'Checking...'
                : appUpdate.status === 'downloading'
                  ? 'Downloading...'
                  : 'Check Updates'}
            </button>
          )}

          <ThemeSwitch />

          {/* Notification bell */}
          <button
            className="relative flex h-8 w-8 items-center justify-center rounded-widget
              text-slate-500 transition-colors
              hover:bg-surface-light-elevated hover:text-slate-700
              dark:text-slate-400 dark:hover:bg-surface-elevated dark:hover:text-white"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
            </svg>
            {(state.activeEncodingJobId || appUpdate.status === 'downloaded' || appUpdate.status === 'available') && (
              <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary-400" />
            )}
          </button>

          {/* User avatar */}
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-400/10 text-xs font-bold text-primary-500 dark:text-primary-400">
            OP
          </div>
        </div>
      </div>
    </header>
  );
}

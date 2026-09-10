import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useBridge } from '../context/BridgeContext';
import { GridIcon, ListIcon, PlusIcon, SearchIcon, SelectIcon } from './csn/icons';

/**
 * The app's top bar, built on the site header's chrome: black ground, one
 * hairline rule under it, capsule search and segmented control. Search, sort,
 * layout, select and upload sit above every view and drive the library wherever
 * you happen to be. Library state lives in the URL so this bar stays stateless.
 */
export default function TopBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);
  const { state, startWatching, stopWatching, checkForAppUpdates, installAppUpdate } = useBridge();

  const query = searchParams.get('q') ?? '';
  const sort = searchParams.get('sort') ?? 'recent';
  const layout = searchParams.get('layout') === 'list' ? 'list' : 'grid';
  const selectMode = searchParams.get('select') === '1';

  const [draftQuery, setDraftQuery] = useState(query);
  useEffect(() => setDraftQuery(query), [query]);

  /** Merge params onto the library route, arriving there from any view. */
  function updateLibrary(changes: Record<string, string | null>) {
    const next = new URLSearchParams(location.pathname === '/player' ? searchParams : undefined);
    Object.entries(changes).forEach(([key, value]) => {
      if (value === null || value === '') {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    });
    if (!next.has('filter')) {
      next.set('filter', 'all');
    }
    navigate(`/player?${next.toString()}`);
  }

  // ⌘K / Ctrl-K focuses search, matching the hint rendered in the field.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const appUpdate = state.appUpdate;
  const updateActionable = appUpdate.status === 'downloaded' || appUpdate.status === 'available';

  return (
    <header className="flex h-topbar flex-none items-center gap-[13px] border-b border-rule bg-ink px-[22px]">
      {/* The site's search affordance is a rounded capsule on the tile surface. */}
      <form
        className="csn-field w-[380px] flex-none rounded-full px-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          updateLibrary({ q: draftQuery });
        }}
      >
        <SearchIcon size={16} className="flex-none text-dim" />
        <input
          ref={searchRef}
          value={draftQuery}
          onChange={(event) => setDraftQuery(event.target.value)}
          onBlur={() => {
            if (draftQuery !== query) {
              updateLibrary({ q: draftQuery });
            }
          }}
          placeholder="Search assets, tags…"
          className="min-w-0 flex-1 border-none bg-transparent text-copy text-paper outline-none"
        />
        <span className="csn-kbd">⌘K</span>
      </form>

      <select
        value={sort}
        onChange={(event) => updateLibrary({ sort: event.target.value })}
        className="csn-select flex-none"
      >
        <option value="recent">Most recent</option>
        <option value="name">Name</option>
        <option value="duration">Duration</option>
        <option value="size">File size</option>
      </select>

      {/* Segmented control, as on the site: a capsule track, the active option
          inverted to paper-on-ink. */}
      <div className="flex flex-none gap-0.5 rounded-full border border-white/[.08] bg-ink-tile p-[3px]">
        {(
          [
            ['grid', GridIcon, 'Grid'],
            ['list', ListIcon, 'List'],
          ] as const
        ).map(([key, Icon, title]) => (
          <button
            key={key}
            type="button"
            title={title}
            onClick={() => updateLibrary({ layout: key })}
            className={`flex h-[30px] w-[34px] items-center justify-center rounded-full transition-colors ${
              layout === key ? 'bg-paper text-ink' : 'text-muted hover:text-paper'
            }`}
          >
            <Icon size={16} />
          </button>
        ))}
      </div>

      <div className="csn-rule" />

      <button
        type="button"
        title="Select multiple"
        onClick={() => updateLibrary({ select: selectMode ? null : '1' })}
        className={selectMode ? 'csn-chip-on h-control px-[15px]' : 'csn-btn-secondary'}
      >
        <SelectIcon size={16} />
        Select
      </button>

      <button type="button" onClick={() => navigate('/dashboard#intake')} className="csn-btn-primary">
        <PlusIcon size={16} />
        Upload
      </button>

      <div className="csn-rule" />

      {/* Watcher and updater are this app's own operational controls; they take
          the slot the site's header gives to the account button. A running
          watcher is this app's "live", so it wears the site's live dot. */}
      <button
        type="button"
        onClick={() => void (state.isWatching ? stopWatching() : startWatching())}
        className={state.isWatching ? 'csn-chip-on h-control px-[15px]' : 'csn-btn-secondary'}
        title={state.isWatching ? 'Watcher is running' : 'Watcher is stopped'}
      >
        <span
          className={`h-[7px] w-[7px] flex-none rounded-full ${
            state.isWatching ? 'animate-csnpulse bg-accent' : 'bg-faint'
          }`}
        />
        {state.isWatching ? 'Watching' : 'Paused'}
      </button>

      {updateActionable ? (
        <button
          type="button"
          onClick={() => void installAppUpdate()}
          className="csn-btn-accent h-control"
          title={appUpdate.message}
        >
          {appUpdate.status === 'available' ? 'Download update' : 'Install update'}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void checkForAppUpdates()}
          disabled={
            appUpdate.status === 'unsupported' ||
            appUpdate.status === 'disabled' ||
            appUpdate.status === 'checking' ||
            appUpdate.status === 'downloading'
          }
          className="csn-icon-btn"
          title={appUpdate.message ?? 'Check for updates'}
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.9}
            className={appUpdate.status === 'checking' ? 'animate-csnpulse' : undefined}
            aria-hidden="true"
          >
            <path d="M20 12a8 8 0 1 1-2.3-5.6" />
            <path d="M20 4v3.5h-3.5" />
          </svg>
        </button>
      )}
    </header>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useBridge } from '../context/BridgeContext';
import { GridIcon, ListIcon, PlusIcon, SearchIcon, SelectIcon } from './spool/icons';

/**
 * Spool's top bar is global — search, sort, layout, select and upload sit above
 * every view, and drive the library wherever you happen to be. Library state
 * lives in the URL so this bar can stay stateless.
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
    <header className="flex h-topbar flex-none items-center gap-[13px] border-b border-surface-hairline bg-surface-canvas px-[22px]">
      <form
        className="spool-field w-[380px] flex-none"
        onSubmit={(event) => {
          event.preventDefault();
          updateLibrary({ q: draftQuery });
        }}
      >
        <SearchIcon size={16} className="flex-none text-ink-dim" />
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
          className="min-w-0 flex-1 border-none bg-transparent text-body text-ink outline-none"
        />
        <span className="spool-kbd">⌘K</span>
      </form>

      <select
        value={sort}
        onChange={(event) => updateLibrary({ sort: event.target.value })}
        className="spool-select flex-none"
      >
        <option value="recent">Most recent</option>
        <option value="name">Name</option>
        <option value="duration">Duration</option>
        <option value="size">File size</option>
      </select>

      <div className="flex flex-none gap-0.5 rounded-control border border-surface-hairline bg-surface-field p-[3px]">
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
            className={`flex h-[30px] w-[34px] items-center justify-center rounded-chip transition ${
              layout === key ? 'bg-white/10 text-ink' : 'text-ink-dim hover:text-ink-muted'
            }`}
          >
            <Icon size={16} />
          </button>
        ))}
      </div>

      <div className="spool-rule" />

      <button
        type="button"
        title="Select multiple"
        onClick={() => updateLibrary({ select: selectMode ? null : '1' })}
        className={selectMode ? 'spool-chip-on h-control px-[15px]' : 'spool-btn-secondary'}
      >
        <SelectIcon size={16} />
        Select
      </button>

      <button type="button" onClick={() => navigate('/dashboard#intake')} className="spool-btn-primary">
        <PlusIcon size={16} />
        Upload
      </button>

      <div className="spool-rule" />

      {/* Watcher and updater are this app's own operational controls; they take
          the slot Spool gives to the account avatar. */}
      <button
        type="button"
        onClick={() => void (state.isWatching ? stopWatching() : startWatching())}
        className={state.isWatching ? 'spool-chip-on h-control px-[15px]' : 'spool-btn-secondary'}
        title={state.isWatching ? 'Watcher is running' : 'Watcher is stopped'}
      >
        <span
          className={`h-[7px] w-[7px] flex-none rounded-full ${
            state.isWatching ? 'animate-spoolpulse bg-state-posted' : 'bg-ink-dim'
          }`}
        />
        {state.isWatching ? 'Watching' : 'Paused'}
      </button>

      {updateActionable ? (
        <button
          type="button"
          onClick={() => void installAppUpdate()}
          className="spool-btn-accent h-control"
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
          className="spool-icon-btn"
          title={appUpdate.message ?? 'Check for updates'}
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.9}
            className={appUpdate.status === 'checking' ? 'animate-spoolpulse' : undefined}
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

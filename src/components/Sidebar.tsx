import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { inferStoredContentType } from '../shared/media';
import type { StorageUsageSnapshot, StoredVideoSnapshot } from '../shared/types';
import {
  CollectionIcon,
  DashboardIcon,
  GridIcon,
  OffloadIcon,
  PlusIcon,
  ProcessingIcon,
  PublishedIcon,
  SettingsIcon,
  ShortformIcon,
  TrimmerIcon,
  VodIcon,
} from './spool/icons';

const OPERATIONS_ITEMS = [
  { label: 'Dashboard', to: '/dashboard', icon: <DashboardIcon /> },
  { label: 'Offload', to: '/offload', icon: <OffloadIcon /> },
  { label: 'Trimmer', to: '/trimmer', icon: <TrimmerIcon /> },
  { label: 'Settings', to: '/settings', icon: <SettingsIcon /> },
];

function navClass(active: boolean) {
  return active ? 'spool-nav-on' : 'spool-nav';
}

function formatBytes(bytes: number) {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) {
    return `${(gb / 1024).toFixed(1)} TB`;
  }
  return `${Math.round(gb)} GB`;
}

function StorageFooter({ usage }: { usage: StorageUsageSnapshot | null }) {
  if (!usage) {
    return (
      <div className="mt-auto border-t border-white/[.06] px-[18px] pb-[18px] pt-4">
        <div className="text-caption text-ink-dim">No working folder configured</div>
      </div>
    );
  }

  const ratio = usage.totalBytes > 0 ? usage.usedBytes / usage.totalBytes : 0;
  const percent = Math.min(100, Math.max(0, ratio * 100));
  // The bar turns amber then red as the operator's drive fills up.
  const barClass =
    ratio >= 0.9
      ? 'bg-state-danger'
      : ratio >= 0.75
        ? 'bg-state-processing'
        : 'bg-gradient-to-r from-primary-500 to-primary-400';

  return (
    <div className="mt-auto border-t border-white/[.06] px-[18px] pb-[18px] pt-4">
      <div className="mb-[7px] flex justify-between text-caption text-ink-muted">
        <span className="truncate" title={usage.path}>
          {usage.label}
        </span>
        <span className="flex-none font-mono text-ink-strong">
          {formatBytes(usage.usedBytes)} / {formatBytes(usage.totalBytes)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-[4px] bg-white/[.08]">
        <div className={`h-full rounded-[4px] ${barClass}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export default function Sidebar() {
  const location = useLocation();
  const [videos, setVideos] = useState<StoredVideoSnapshot[]>([]);
  const [usage, setUsage] = useState<StorageUsageSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([window.mediaBridge.listStoredVideos(), window.mediaBridge.getStorageUsage()])
      .then(([nextVideos, nextUsage]) => {
        if (!cancelled) {
          setVideos(nextVideos);
          setUsage(nextUsage);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVideos([]);
          setUsage(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [location.pathname, location.search]);

  const counts = {
    all: videos.length,
    vod: videos.filter((video) => inferStoredContentType(video) === 'vod').length,
    short: videos.filter((video) => inferStoredContentType(video) === 'clip').length,
    published: videos.filter((video) => video.socialStatus === 'published').length,
    processing: videos.filter((video) => video.status === 'processing').length,
  };

  const collectionCounts = new Map<string, number>();
  videos.forEach((video) => {
    (video.playlistTitles ?? []).forEach((title) => {
      collectionCounts.set(title, (collectionCounts.get(title) ?? 0) + 1);
    });
  });
  const collections = Array.from(collectionCounts.entries()).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );

  const searchParams = new URLSearchParams(location.search);
  const isLibraryRoute = location.pathname === '/player';
  const activeFilter = isLibraryRoute ? (searchParams.get('filter') ?? 'all') : null;
  const activeCollection = isLibraryRoute ? searchParams.get('collection') : null;

  const libraryLink = (filter: string) => `/player?filter=${filter}`;
  const libraryActive = (filter: string) => activeFilter === filter && !activeCollection;

  const LIBRARY_ITEMS = [
    { key: 'all', label: 'All assets', icon: <GridIcon />, count: counts.all, tone: 'text-ink-dim' },
    { key: 'vod', label: 'VOD masters', icon: <VodIcon />, count: counts.vod, tone: 'text-ink-dim' },
    { key: 'short', label: 'Short-form', icon: <ShortformIcon />, count: counts.short, tone: 'text-ink-dim' },
    {
      key: 'published',
      label: 'Published',
      icon: <PublishedIcon />,
      count: counts.published,
      tone: 'text-ink-dim',
    },
    {
      key: 'processing',
      label: 'Processing',
      icon: <ProcessingIcon />,
      count: counts.processing,
      tone: 'text-state-processing',
    },
  ] as const;

  return (
    <aside className="flex w-rail flex-none flex-col border-r border-surface-hairline bg-surface-rail">
      <div className="flex h-topbar flex-none items-center gap-[11px] border-b border-white/[.06] px-5">
        <div className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[9px] bg-mark">
          <div className="h-2.5 w-2.5 rounded-full border-[2.5px] border-surface-rail" />
        </div>
        <div className="truncate text-[16.5px] font-extrabold tracking-[-.02em] text-ink">
          Media Bridge
        </div>
        <div className="spool-tag ml-auto">CSN</div>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-3.5">
        <div className="spool-section-label pt-1.5">Library</div>
        {LIBRARY_ITEMS.map((item) => (
          <NavLink key={item.key} to={libraryLink(item.key)} className={navClass(libraryActive(item.key))}>
            {item.icon}
            <span className="flex-1 truncate">{item.label}</span>
            <span className={`font-mono text-count ${item.tone}`}>{item.count}</span>
          </NavLink>
        ))}
        <div className="spool-section-label">Collections</div>
        {collections.map(([name, count]) => (
          <NavLink
            key={name}
            to={`/player?filter=all&collection=${encodeURIComponent(name)}`}
            className={navClass(activeCollection === name)}
          >
            <CollectionIcon />
            <span className="flex-1 truncate">{name}</span>
            <span className="font-mono text-count text-ink-dim">{count}</span>
          </NavLink>
        ))}
        {/* Collections are derived from playlist titles, so a new one is made by
            tagging an asset rather than by creating an empty container. */}
        <NavLink to="/player?filter=all&collections=new" className="spool-nav text-ink-faint">
          <PlusIcon />
          <span className="flex-1 truncate">New collection</span>
        </NavLink>

        <div className="spool-section-label">Operations</div>
        {OPERATIONS_ITEMS.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => navClass(isActive)}>
            {item.icon}
            <span className="flex-1 truncate">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <StorageFooter usage={usage} />
    </aside>
  );
}

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
} from './csn/icons';

const OPERATIONS_ITEMS = [
  { label: 'Dashboard', to: '/dashboard', icon: <DashboardIcon /> },
  { label: 'Offload', to: '/offload', icon: <OffloadIcon /> },
  { label: 'Trimmer', to: '/trimmer', icon: <TrimmerIcon /> },
  { label: 'Settings', to: '/settings', icon: <SettingsIcon /> },
];

function navClass(active: boolean) {
  return active ? 'csn-nav-on' : 'csn-nav';
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
        <div className="text-caption text-dim">No working folder configured</div>
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
        ? 'bg-state-warn'
        : 'bg-gradient-to-r from-accent to-accent-hi';

  return (
    <div className="mt-auto border-t border-white/[.06] px-[18px] pb-[18px] pt-4">
      <div className="mb-[7px] flex justify-between text-caption text-muted">
        <span className="truncate" title={usage.path}>
          {usage.label}
        </span>
        <span className="flex-none font-mono text-body">
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
    { key: 'all', label: 'All assets', icon: <GridIcon />, count: counts.all, tone: 'text-dim' },
    { key: 'vod', label: 'VOD masters', icon: <VodIcon />, count: counts.vod, tone: 'text-dim' },
    { key: 'short', label: 'Short-form', icon: <ShortformIcon />, count: counts.short, tone: 'text-dim' },
    {
      key: 'published',
      label: 'Published',
      icon: <PublishedIcon />,
      count: counts.published,
      tone: 'text-dim',
    },
    {
      key: 'processing',
      label: 'Processing',
      icon: <ProcessingIcon />,
      count: counts.processing,
      tone: 'text-state-warn',
    },
  ] as const;

  return (
    <aside className="flex w-rail flex-none flex-col border-r border-rule bg-ink">
      {/* The site's lockup, verbatim: Anton wordmark with the accent dot on the
          baseline. The app name rides beside it in the condensed label voice. */}
      <div className="flex h-topbar flex-none items-center gap-2.5 border-b border-rule px-5">
        <span className="flex items-baseline gap-[7px]">
          <span className="font-display text-[26px] tracking-[.02em] text-paper">CSN</span>
          <span className="block h-[7px] w-[7px] flex-none rounded-full bg-accent" />
        </span>
        <span className="truncate font-condensed text-[15px] font-bold uppercase tracking-[.12em] text-muted">
          Media Bridge
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-3.5">
        <div className="csn-section-label pt-1.5">Library</div>
        {LIBRARY_ITEMS.map((item) => (
          <NavLink key={item.key} to={libraryLink(item.key)} className={navClass(libraryActive(item.key))}>
            {item.icon}
            <span className="flex-1 truncate">{item.label}</span>
            <span className={`tnum font-sans text-[11px] ${item.tone}`}>{item.count}</span>
          </NavLink>
        ))}
        <div className="csn-section-label">Collections</div>
        {collections.map(([name, count]) => (
          <NavLink
            key={name}
            to={`/player?filter=all&collection=${encodeURIComponent(name)}`}
            className={navClass(activeCollection === name)}
          >
            <CollectionIcon />
            <span className="flex-1 truncate">{name}</span>
            <span className="tnum font-sans text-[11px] text-ghost">{count}</span>
          </NavLink>
        ))}
        {/* Collections are derived from playlist titles, so a new one is made by
            tagging an asset rather than by creating an empty container. */}
        <NavLink to="/player?filter=all&collections=new" className="csn-nav text-faint">
          <PlusIcon />
          <span className="flex-1 truncate">New collection</span>
        </NavLink>

        <div className="csn-section-label">Operations</div>
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

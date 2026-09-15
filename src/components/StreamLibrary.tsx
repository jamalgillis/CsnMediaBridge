import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Thumb from './csn/Thumb';
import { ErrorNote, ProgressTrack, Toggle, ToneChip } from './csn/bridge';
import { EmptyState, GhostButton } from './csn/ui';
import { SearchIcon } from './csn/icons';
import { formatBytes, formatClock, formatWhen } from '../lib/plain';
import type { StreamRecording, StreamTransferSnapshot } from '../shared/types';

/**
 * Recordings already stored in Cloudflare Stream.
 *
 * Two ways out for each: a copy in the Backblaze archive, or a file on this
 * machine. Both stream straight from Stream — the archive copy never touches
 * this disk. A recording already in the archive says so, and that is checked
 * against the archive itself rather than remembered, so a copy made by the
 * backlog script counts too.
 */

const ACTIVE: ReadonlySet<StreamTransferSnapshot['status']> = new Set([
  'preparing',
  'transferring',
  'verifying',
]);

function errorText(caught: unknown) {
  return caught instanceof Error ? caught.message : String(caught);
}

function transferPercent(transfer: StreamTransferSnapshot) {
  if (transfer.status === 'preparing') {
    return transfer.percentPrepared;
  }
  if (transfer.bytesTotal && transfer.bytesTotal > 0) {
    return (transfer.bytesDone / transfer.bytesTotal) * 100;
  }
  return transfer.status === 'transferring' ? 0 : 100;
}

function transferLine(transfer: StreamTransferSnapshot) {
  const verb = transfer.kind === 'archive' ? 'Archiving' : 'Saving';
  switch (transfer.status) {
    case 'preparing':
      return transfer.message ?? 'Asking the streaming provider to prepare the file.';
    case 'transferring':
      return transfer.bytesTotal
        ? `${verb} · ${formatBytes(transfer.bytesDone)} of ${formatBytes(transfer.bytesTotal)}`
        : `${verb} · ${formatBytes(transfer.bytesDone)}`;
    case 'verifying':
      return 'Checking the archive copy.';
    case 'done':
      return transfer.kind === 'archive' ? 'Archived.' : `Saved to ${transfer.destination}`;
    case 'canceled':
      return 'Canceled.';
    case 'failed':
      return transfer.errorMessage ?? 'Stopped.';
    default:
      return '';
  }
}

export default function StreamLibrary() {
  const [recordings, setRecordings] = useState<StreamRecording[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [archived, setArchived] = useState<Set<string>>(new Set());
  const [archiveChecked, setArchiveChecked] = useState(false);
  const [transfers, setTransfers] = useState<StreamTransferSnapshot[]>([]);

  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [liveOnly, setLiveOnly] = useState(true);

  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // A newer request replaces an older one still in flight, so a slow page for
  // an old search cannot land on top of the current results.
  const requestSeq = useRef(0);

  const loadFirstPage = useCallback(async () => {
    const seq = (requestSeq.current += 1);
    setIsLoading(true);
    setError(null);
    try {
      const page = await window.mediaBridge.listStreamRecordings({
        search: appliedSearch || null,
        liveOnly,
      });
      if (seq === requestSeq.current) {
        setRecordings(page.recordings);
        setNextBefore(page.nextBefore);
      }
    } catch (loadError) {
      if (seq === requestSeq.current) {
        setRecordings([]);
        setNextBefore(null);
        setError(errorText(loadError));
      }
    } finally {
      if (seq === requestSeq.current) {
        setIsLoading(false);
      }
    }
  }, [appliedSearch, liveOnly]);

  const refreshArchived = useCallback(async () => {
    try {
      setArchived(new Set(await window.mediaBridge.listArchivedStreamUids()));
      setArchiveChecked(true);
    } catch (archiveError) {
      // The list is still useful without the badges; say why they are missing.
      setArchiveChecked(false);
      setActionError(errorText(archiveError));
    }
  }, []);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  useEffect(() => {
    void refreshArchived();

    let isMounted = true;
    void window.mediaBridge.listStreamTransfers().then((next) => {
      if (isMounted) setTransfers(next);
    });
    const unsubscribe = window.mediaBridge.onStreamTransfersUpdate((next) => setTransfers(next));
    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [refreshArchived]);

  // A finished archive copy changes what the badges should say.
  const finishedArchives = transfers.filter((t) => t.kind === 'archive' && t.status === 'done').length;
  useEffect(() => {
    if (finishedArchives > 0) {
      void refreshArchived();
    }
  }, [finishedArchives, refreshArchived]);

  const transferByUid = useMemo(
    () => new Map(transfers.map((transfer) => [transfer.uid, transfer])),
    [transfers],
  );

  async function loadMore() {
    if (!nextBefore) return;
    const seq = requestSeq.current;
    setIsLoadingMore(true);
    try {
      const page = await window.mediaBridge.listStreamRecordings({
        before: nextBefore,
        search: appliedSearch || null,
        liveOnly,
      });
      if (seq === requestSeq.current) {
        setRecordings((current) => [
          ...current,
          ...page.recordings.filter((next) => !current.some((seen) => seen.uid === next.uid)),
        ]);
        setNextBefore(page.nextBefore);
      }
    } catch (loadError) {
      setActionError(errorText(loadError));
    } finally {
      setIsLoadingMore(false);
    }
  }

  async function archive(recording: StreamRecording) {
    setActionError(null);
    try {
      await window.mediaBridge.archiveStreamRecording(recording);
    } catch (startError) {
      setActionError(errorText(startError));
    }
  }

  async function download(recording: StreamRecording) {
    setActionError(null);
    try {
      await window.mediaBridge.downloadStreamRecording(recording);
    } catch (startError) {
      setActionError(errorText(startError));
    }
  }

  const activeCount = transfers.filter((transfer) => ACTIVE.has(transfer.status)).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <form
          className="csn-field h-9 max-w-[320px] min-w-[170px] flex-[1_1_220px] px-[11px]"
          onSubmit={(event) => {
            event.preventDefault();
            setAppliedSearch(search.trim());
          }}
        >
          <SearchIcon size={14} className="flex-none text-muted" />
          <input
            id="stream-library-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search recordings… (Enter)"
            className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-paper outline-none"
          />
        </form>
        <div className="flex items-center gap-2.5">
          <Toggle checked={liveOnly} onChange={setLiveOnly} label="Live recordings only" />
          <span className="text-[13px] text-body">Live recordings only</span>
        </div>
        <span className="min-w-[8px] flex-1" />
        <GhostButton
          onClick={() => {
            void loadFirstPage();
            void refreshArchived();
          }}
          disabled={isLoading}
        >
          {isLoading ? 'Loading…' : 'Refresh'}
        </GhostButton>
      </div>

      <div className="text-caption text-pretty text-muted">
        Archiving copies the recording to cloud storage without using space on this machine. The
        streaming provider keeps its copy either way. It sends a re-encoded MP4, not the file the encoder originally
        sent.
        {activeCount > 0 ? ` ${activeCount} transfer${activeCount === 1 ? '' : 's'} running.` : ''}
        {!archiveChecked && !error ? ' Archive status unavailable.' : ''}
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}

      {isLoading ? null : !error && recordings.length === 0 ? (
        <EmptyState
          title="No recordings"
          body={
            appliedSearch
              ? `Nothing from the streaming provider matches "${appliedSearch}".`
              : liveOnly
                ? 'The streaming provider has no live recordings you can see. Turn off "Live recordings only" to include uploaded videos.'
                : 'The streaming provider has no videos you can see.'
          }
        />
      ) : (
        <div className="csn-hair">
          {recordings.map((recording) => {
            const transfer = transferByUid.get(recording.uid);
            const running = transfer ? ACTIVE.has(transfer.status) : false;
            const inArchive = archived.has(recording.uid);
            const title = recording.name || recording.uid;

            return (
              <div key={recording.uid} className="csn-hair-row flex flex-wrap items-start gap-3.5 px-[15px] py-3.5">
                <Thumb
                  seed={recording.uid}
                  posterUrl={recording.thumbnailUrl ?? undefined}
                  className="aspect-video w-[132px] flex-none rounded-chip"
                  duration={recording.durationSeconds ? formatClock(recording.durationSeconds) : null}
                  compact
                />

                <div className="flex min-w-[200px] flex-[1_1_260px] flex-col gap-[5px]">
                  <div className="truncate text-[13.5px] font-semibold text-paper" title={title}>
                    {title}
                  </div>
                  <div className="truncate machine text-[11.5px] text-muted">
                    {[recording.clientName ?? 'No client assigned', formatWhen(recording.createdAt), formatBytes(recording.sizeBytes)]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {inArchive ? <ToneChip tone="neutral">In archive</ToneChip> : null}
                    {!recording.readyToStream ? <ToneChip tone="waiting">Still processing</ToneChip> : null}
                    {!recording.clientName ? <ToneChip tone="quiet">Unassigned</ToneChip> : null}
                  </div>

                  {transfer ? (
                    <div className="mt-1.5 flex flex-col gap-1.5">
                      {running ? <ProgressTrack value={transferPercent(transfer)} live /> : null}
                      <div
                        className={`text-[12.5px] text-pretty ${
                          transfer.status === 'failed' ? 'text-accent' : 'text-body'
                        }`}
                      >
                        {transferLine(transfer)}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-none flex-wrap items-center gap-2">
                  {running ? (
                    <GhostButton onClick={() => void window.mediaBridge.cancelStreamTransfer(recording.uid)}>
                      Cancel
                    </GhostButton>
                  ) : (
                    <>
                      <GhostButton
                        onClick={() => void archive(recording)}
                        disabled={!recording.readyToStream}
                        title={inArchive ? 'Already archived. Archiving again replaces that copy.' : undefined}
                      >
                        {inArchive ? 'Archive again' : 'Archive'}
                      </GhostButton>
                      <GhostButton onClick={() => void download(recording)} disabled={!recording.readyToStream}>
                        Download
                      </GhostButton>
                      {transfer ? (
                        <GhostButton onClick={() => void window.mediaBridge.dismissStreamTransfer(recording.uid)}>
                          Clear
                        </GhostButton>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {nextBefore && !isLoading ? (
        <div>
          <GhostButton onClick={() => void loadMore()} disabled={isLoadingMore}>
            {isLoadingMore ? 'Loading…' : 'Load older recordings'}
          </GhostButton>
        </div>
      ) : null}
    </div>
  );
}

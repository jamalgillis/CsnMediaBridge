import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Disclosure,
  ErrorNote,
  Fact,
  FactList,
  PageHeading,
  ProgressTrack,
  QuietNote,
  Screen,
  Toast,
  useToast,
} from '../components/csn/bridge';
import { GhostButton } from '../components/csn/ui';
import { useBridge } from '../context/BridgeContext';
import { formatBytes } from '../lib/plain';
import type { OffloadSourceSnapshot, OffloadTaskSnapshot } from '../shared/types';

/**
 * Offload a card.
 *
 * The screen is a copy in progress, stated as phases rather than as a task
 * record: where the files come from, where they go, and how far each phase has
 * got. What gets skipped is said out loud, and so is the one thing an operator
 * always wants to know before starting — that nothing is deleted from the card.
 */

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const RUNNING_STATUSES = ['preparing', 'copying', 'converting', 'uploading'];

export default function OffloadPage() {
  const { settings, state, saveSettings } = useBridge();
  const { toast, flash } = useToast();

  const [source, setSource] = useState<OffloadSourceSnapshot | null>(null);
  const [jobName, setJobName] = useState('');
  const [isPickingSource, setIsPickingSource] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<OffloadTaskSnapshot | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // The two "what to include" preferences live in Settings, so a card offloads
  // the same way every time; this screen only reflects them.
  const convertImagesToWebp = settings.offload.convertImagesToWebp;
  const uploadImagesToCloud = settings.offload.uploadImagesToCloud;

  const b2Configured = Boolean(settings.b2.bucket && settings.b2.keyId && settings.b2.applicationKey);
  const canConvertImages = state.system.ffmpegAvailable !== false;
  const canUploadImages = b2Configured && state.system.rcloneAvailable !== false;

  const webpOn = convertImagesToWebp && canConvertImages;
  const uploadOn = uploadImagesToCloud && canUploadImages;

  useEffect(() => {
    let isMounted = true;

    void window.mediaBridge
      .getOffloadTask()
      .then((task) => {
        if (!isMounted || !task) {
          return;
        }
        setActiveTask(task);
        setJobName((current) => current || task.jobName);
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setPageError(getErrorMessage(error));
        }
      });

    const unsubscribe = window.mediaBridge.onOffloadUpdate((task) => {
      setActiveTask(task);
      setJobName((current) => current || task.jobName);
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  const isTaskRunning = Boolean(activeTask && RUNNING_STATUSES.includes(activeTask.status));
  const isPaused = activeTask?.status === 'paused';
  const isResumable = Boolean(
    source &&
      activeTask &&
      ['paused', 'error', 'canceled'].includes(activeTask.status) &&
      activeTask.sourcePath === source.sourcePath &&
      activeTask.jobName === (jobName.trim() || source.sourceName),
  );
  const canStart = Boolean(source) && Boolean(settings.offload.localFolder) && !isSubmitting && !isTaskRunning;

  async function handleChooseSource() {
    setIsPickingSource(true);
    setPageError(null);

    try {
      const nextSource = await window.mediaBridge.chooseOffloadSource();
      if (!nextSource) {
        return;
      }
      setSource(nextSource);
      setJobName(nextSource.sourceName);
      setActiveTask(null);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsPickingSource(false);
    }
  }

  async function handleStart() {
    if (!source) {
      return;
    }

    setIsSubmitting(true);
    setPageError(null);

    try {
      const result = await window.mediaBridge.runOffloadTask({
        sourcePath: source.sourcePath,
        jobName: jobName.trim() || source.sourceName,
        convertImagesToWebp: webpOn,
        uploadToB2: uploadOn,
      });
      setActiveTask(result);
      flash(isResumable ? 'Picking up where it left off' : 'Copying — nothing is removed from the card');
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handlePause() {
    try {
      const result = await window.mediaBridge.pauseOffloadTask();
      if (result) {
        setActiveTask(result);
        flash('Paused — pick up any time');
      }
    } catch (error) {
      setPageError(getErrorMessage(error));
    }
  }

  async function handleCancel() {
    try {
      const result = await window.mediaBridge.cancelOffloadTask();
      if (result) {
        setActiveTask(result);
        flash('Stopped — what copied so far is kept');
      }
    } catch (error) {
      setPageError(getErrorMessage(error));
    }
  }

  const intro =
    'Copies everything off a camera card onto your offload drive. ' +
    (uploadOn
      ? webpOn
        ? 'Video stays local; photos also get web-friendly copies and go to the cloud.'
        : 'Video stays local; photos also go to the cloud.'
      : webpOn
        ? 'Everything stays on the drive — photos also get web-friendly copies.'
        : 'Everything stays on the drive; nothing is uploaded.');

  const skipped = [
    !webpOn ? 'web-friendly copies' : null,
    !uploadOn ? 'the photo upload' : null,
  ].filter(Boolean) as string[];

  const phases = [
    {
      key: 'copy',
      label: 'Copying video and photos',
      detail: activeTask
        ? `${activeTask.copiedFiles} of ${activeTask.totalFiles} files`
        : source
          ? `${source.fileCount} files · ${formatBytes(source.totalBytes)}`
          : 'waiting for a card',
      value: activeTask?.copyProgress ?? 0,
      on: true,
    },
    {
      key: 'webp',
      label: 'Making web-friendly photo copies',
      detail: activeTask
        ? `${activeTask.convertedImageCount} of ${activeTask.imageCount} photos`
        : 'starts alongside the copy',
      value: activeTask?.conversionProgress ?? 0,
      on: webpOn || Boolean(activeTask?.webReadyPath),
    },
    {
      key: 'upload',
      label: 'Sending photos to the cloud',
      detail: activeTask?.uploadEnabled ? activeTask.message : 'starts when copying finishes',
      value: activeTask?.uploadProgress ?? 0,
      on: uploadOn || Boolean(activeTask?.uploadEnabled),
    },
  ].filter((phase) => phase.on);

  async function setPreference(key: 'convertImagesToWebp' | 'uploadImagesToCloud', next: boolean) {
    await saveSettings({ ...settings, offload: { ...settings.offload, [key]: next } });
  }

  return (
    <Screen label="Offload">
      <div className="max-w-[760px] px-[30px] pt-[30px]">
        <PageHeading title="Offload a card" subhead={intro} />
      </div>

      {pageError ? (
        <div className="max-w-[760px] px-[30px] pt-5">
          <ErrorNote>{pageError}</ErrorNote>
        </div>
      ) : null}

      <div className="flex max-w-[760px] flex-col gap-2.5 px-[30px] pt-[26px]">
        <div className="csn-card px-5 py-[18px]">
          <div className="flex flex-wrap items-center gap-3.5">
            <div className="min-w-[190px] flex-[1_1_240px]">
              <div className="text-[12px] text-quiet">Copying from</div>
              <div className="mt-[3px] break-all text-row font-semibold text-paper">
                {source?.sourcePath ?? 'No card chosen yet'}
              </div>
              <div className="mt-1 text-caption text-quiet">
                {source
                  ? `${source.fileCount} files · ${formatBytes(source.totalBytes)} · ${source.imageCount} photos, ${source.videoCount} clips`
                  : 'Choose a camera card, shuttle drive, or shoot folder.'}
              </div>
            </div>
            <GhostButton
              onClick={() => void handleChooseSource()}
              disabled={isPickingSource || isSubmitting || isTaskRunning}
            >
              {isPickingSource ? 'Opening…' : source ? 'Change' : 'Choose a card'}
            </GhostButton>
          </div>

          <div className="mt-4 border-t border-rule-soft pt-4">
            <div className="text-[12px] text-quiet">Copying to</div>
            <div className="mt-[3px] break-all text-copy text-body">
              {settings.offload.localFolder ? (
                `${settings.offload.localFolder}/${jobName.trim() || source?.sourceName || '…'}/`
              ) : (
                <>
                  No offload drive set yet —{' '}
                  <Link to="/settings" className="underline">
                    choose one in Settings
                  </Link>
                  .
                </>
              )}
            </div>
          </div>
        </div>

        {phases.map((phase) => (
          <div key={phase.key} className="csn-card px-5 py-4">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="min-w-[140px] flex-[1_1_180px] text-copy font-semibold text-paper">
                {phase.label}
              </span>
              <span className="flex-none machine text-caption text-quiet">{phase.detail}</span>
            </div>
            <div className="mt-3">
              <ProgressTrack value={phase.value} thick />
            </div>
          </div>
        ))}
      </div>

      <div className="flex max-w-[760px] flex-wrap gap-2.5 px-[30px] pt-5">
        {isTaskRunning ? (
          <GhostButton onClick={() => void handlePause()}>Pause</GhostButton>
        ) : (
          <GhostButton onClick={() => void handleStart()} disabled={!canStart}>
            {isSubmitting ? 'Starting…' : isResumable || isPaused ? 'Resume' : 'Start copying'}
          </GhostButton>
        )}
        <GhostButton onClick={() => void handleCancel()} disabled={!isTaskRunning && !isPaused}>
          Cancel
        </GhostButton>
      </div>

      {skipped.length > 0 ? (
        <div className="max-w-[760px] px-[30px] pt-4">
          <QuietNote>
            Skipping {skipped.join(' and ')} — you can turn that back on in{' '}
            <Link to="/settings" className="underline">
              Settings
            </Link>
            .
          </QuietNote>
        </div>
      ) : null}

      {!canConvertImages && convertImagesToWebp ? (
        <div className="max-w-[760px] px-[30px] pt-2.5">
          <QuietNote>
            Web-friendly copies need FFmpeg, which this machine can’t find, so that phase is off for
            now.
          </QuietNote>
        </div>
      ) : null}
      {!canUploadImages && uploadImagesToCloud ? (
        <div className="max-w-[760px] px-[30px] pt-2.5">
          <QuietNote>
            Sending photos to the cloud needs rclone and cloud storage set up, so that phase is off
            for now.
          </QuietNote>
        </div>
      ) : null}

      <div className="max-w-[760px] px-[30px] pt-3.5 text-caption text-pretty text-muted">
        Nothing is deleted from the card. You can stop and resume this copy whenever you need to.
      </div>

      <div className="max-w-[760px] px-[30px] pt-[22px]">
        <Disclosure
          open={detailsOpen}
          onToggle={() => setDetailsOpen((open) => !open)}
          showLabel="Show technical details"
          hideLabel="Hide technical details"
        />
      </div>

      {detailsOpen ? (
        <div className="flex max-w-[760px] flex-col gap-4 px-[30px] pt-3.5">
          <label className="block">
            <span className="csn-label">Name this offload</span>
            <input
              value={jobName}
              onChange={(event) => setJobName(event.target.value)}
              placeholder={source?.sourceName ?? 'Championship postgame shoot'}
              disabled={isTaskRunning}
              className="csn-input"
            />
          </label>

          <FactList>
            <div className="csn-hair-row flex flex-wrap items-center gap-3.5 px-4 py-3.5">
              <div className="min-w-[180px] flex-[1_1_240px]">
                <div className="text-copy font-semibold text-paper">
                  Make web-friendly photo copies
                </div>
                <div className="mt-[3px] text-caption text-pretty text-quiet">
                  Saves a smaller webp version of every photo next to the originals.
                </div>
              </div>
              <GhostButton
                onClick={() => void setPreference('convertImagesToWebp', !convertImagesToWebp)}
              >
                {convertImagesToWebp ? 'On' : 'Off'}
              </GhostButton>
            </div>
            <div className="csn-hair-row flex flex-wrap items-center gap-3.5 px-4 py-3.5">
              <div className="min-w-[180px] flex-[1_1_240px]">
                <div className="text-copy font-semibold text-paper">Send photos to the cloud</div>
                <div className="mt-[3px] text-caption text-pretty text-quiet">
                  Uploads the photos only. Video always stays on the offload drive.
                </div>
              </div>
              <GhostButton
                onClick={() => void setPreference('uploadImagesToCloud', !uploadImagesToCloud)}
              >
                {uploadImagesToCloud ? 'On' : 'Off'}
              </GhostButton>
            </div>
          </FactList>

          <FactList>
            <Fact wide label="Copy mode" value={settings.offload.localCopyMode} machine />
            <Fact
              wide
              label="Local package"
              value={activeTask?.localDestinationPath ?? '—'}
              machine
            />
            <Fact wide label="Web-ready folder" value={activeTask?.webReadyPath ?? '—'} machine />
            <Fact wide label="Cloud prefix" value={activeTask?.cloudObjectKey ?? '—'} machine />
            <Fact wide label="Manifest" value={activeTask?.manifestPath ?? '—'} machine />
            <Fact wide label="Transfer log" value={activeTask?.logPath ?? '—'} machine />
            <Fact
              wide
              label="Reused files"
              value={activeTask ? String(activeTask.skippedFiles) : '—'}
              machine
            />
            <Fact
              wide
              label="Bytes copied"
              value={
                activeTask
                  ? `${formatBytes(activeTask.copiedBytes)} of ${formatBytes(activeTask.totalBytes)}`
                  : '—'
              }
              machine
            />
          </FactList>

          {activeTask?.errorMessage ? <ErrorNote>{activeTask.errorMessage}</ErrorNote> : null}
        </div>
      ) : null}

      <Toast message={toast} />
    </Screen>
  );
}

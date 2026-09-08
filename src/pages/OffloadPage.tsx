import { useEffect, useState } from 'react';
import GlassCard from '../components/GlassCard';
import ProgressBar from '../components/ProgressBar';
import StatusBadge from '../components/StatusBadge';
import { useBridge } from '../context/BridgeContext';
import type { OffloadSourceSnapshot, OffloadTaskSnapshot } from '../shared/types';

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function formatFileSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 'Unknown size';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let currentValue = value;
  let unitIndex = 0;

  while (currentValue >= 1024 && unitIndex < units.length - 1) {
    currentValue /= 1024;
    unitIndex += 1;
  }

  const precision = currentValue >= 100 || unitIndex === 0 ? 0 : 1;
  return `${currentValue.toFixed(precision)} ${units[unitIndex]}`;
}

function getTaskTone(task: OffloadTaskSnapshot | null): 'good' | 'active' | 'warning' | 'danger' | 'neutral' {
  if (!task) {
    return 'neutral';
  }

  if (task.status === 'complete') {
    return 'good';
  }

  if (task.status === 'error') {
    return 'danger';
  }

  return 'active';
}

function getTaskLabel(task: OffloadTaskSnapshot | null) {
  if (!task) {
    return 'No Offload Yet';
  }

  return task.status[0].toUpperCase() + task.status.slice(1);
}

function ToggleCard({
  title,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className="flex items-start gap-3 rounded-control border p-4 border-surface-hairline bg-surface-canvas"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        className="mt-1 h-4 w-4 rounded text-primary-200 focus:ring-primary-400 disabled:cursor-not-allowed disabled:opacity-60 border-surface-hairline bg-transparent"
      />
      <span>
        <span className="block font-medium text-ink">{title}</span>
        <span className="mt-1 block text-sm text-ink-muted">
          {description}
        </span>
      </span>
    </label>
  );
}

const INPUT_CLASS = 'spool-input h-11';

export default function OffloadPage() {
  const { settings, state } = useBridge();
  const [source, setSource] = useState<OffloadSourceSnapshot | null>(null);
  const [jobName, setJobName] = useState('');
  const [convertImagesToWebp, setConvertImagesToWebp] = useState(true);
  const [uploadToB2, setUploadToB2] = useState(false);
  const [isPickingSource, setIsPickingSource] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<OffloadTaskSnapshot | null>(null);

  const b2Configured = Boolean(
    settings.b2.bucket && settings.b2.keyId && settings.b2.applicationKey,
  );
  const canConvertImages = state.system.ffmpegAvailable !== false;
  const canUploadImages = b2Configured && state.system.rcloneAvailable !== false;

  useEffect(() => {
    let isMounted = true;

    void window.mediaBridge.getOffloadTask()
      .then((task) => {
        if (!isMounted || !task) {
          return;
        }

        setActiveTask(task);
        setJobName((current) => current || task.jobName);
      })
      .catch((error) => {
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

  useEffect(() => {
    if (!canConvertImages) {
      setConvertImagesToWebp(false);
    }
  }, [canConvertImages]);

  useEffect(() => {
    if (!canUploadImages) {
      setUploadToB2(false);
    }
  }, [canUploadImages]);

  const isTaskRunning = Boolean(
    activeTask &&
    ['preparing', 'copying', 'converting', 'uploading'].includes(activeTask.status),
  );
  const isResumableTask = Boolean(
    source &&
    activeTask &&
    ['paused', 'error', 'canceled'].includes(activeTask.status) &&
    activeTask.sourcePath === source.sourcePath &&
    activeTask.jobName === (jobName.trim() || source.sourceName),
  );
  const canStart =
    Boolean(source) &&
    Boolean(settings.offload.localFolder) &&
    !isSubmitting &&
    !isTaskRunning;
  const imageSummary = source
    ? `${source.fileCount} files, ${source.imageCount} images, ${source.videoCount} video files, ${source.otherCount} other files.`
    : 'Choose a shoot folder to see the offload summary.';

  async function handleChooseSource() {
    setIsPickingSource(true);
    setPageError(null);
    setNotice(null);

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

  async function handleStartOffload() {
    if (!source) {
      return;
    }

    setIsSubmitting(true);
    setPageError(null);
    setNotice(null);

    try {
      const result = await window.mediaBridge.runOffloadTask({
        sourcePath: source.sourcePath,
        jobName: jobName.trim() || source.sourceName,
        convertImagesToWebp,
        uploadToB2,
      });

      setActiveTask(result);
      setNotice(result.message);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handlePauseOffload() {
    try {
      const result = await window.mediaBridge.pauseOffloadTask();
      if (result) {
        setActiveTask(result);
        setNotice(result.message);
      }
    } catch (error) {
      setPageError(getErrorMessage(error));
    }
  }

  async function handleCancelOffload() {
    try {
      const result = await window.mediaBridge.cancelOffloadTask();
      if (result) {
        setActiveTask(result);
        setNotice(result.message);
      }
    } catch (error) {
      setPageError(getErrorMessage(error));
    }
  }

  return (
    <div className="px-6 pb-11 pt-[22px]">
      <div className="mb-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <h1 className="text-page text-ink">Offload</h1>
            <p className="mt-1.5 text-body text-ink-muted">
              Pick a post-shoot folder, copy the full shoot to your designated local drive, generate
              a parallel `web-ready` set of `webp` images for website use, and optionally upload only
              the picture assets to Backblaze B2. Video files always stay local in the copied package.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge tone={state.system.ffmpegAvailable ? 'good' : 'warning'}>
              {state.system.ffmpegAvailable ? 'FFmpeg Ready' : 'FFmpeg Missing'}
            </StatusBadge>
            <StatusBadge tone={state.system.rcloneAvailable ? 'good' : 'warning'}>
              {state.system.rcloneAvailable ? 'Rclone Ready' : 'Rclone Missing'}
            </StatusBadge>
            <StatusBadge tone={getTaskTone(activeTask)}>{getTaskLabel(activeTask)}</StatusBadge>
            <button
              type="button"
              onClick={() => void handleChooseSource()}
              disabled={isPickingSource || isSubmitting || isTaskRunning}
              className="spool-btn-primary"
            >
              {isPickingSource ? 'Opening Browser…' : source ? 'Choose Another Folder' : 'Choose Shoot Folder'}
            </button>
            <button
              type="button"
              onClick={() => void handlePauseOffload()}
              disabled={!isTaskRunning}
              className="spool-btn-secondary"
            >
              Pause
            </button>
            <button
              type="button"
              onClick={() => void handleCancelOffload()}
              disabled={!isTaskRunning}
              className="spool-btn-danger"
            >
              Cancel
            </button>
          </div>
        </div>

        {(notice || pageError) && (
          <div className="mt-4 space-y-2">
            {notice && <p className="text-body text-secondary-300">{notice}</p>}
            {pageError && <p className="text-body text-state-danger">{pageError}</p>}
          </div>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-12">
        <GlassCard className="xl:col-span-8">
          <div className="flex flex-col gap-6">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-control border p-4 border-surface-hairline bg-surface-canvas">
                <p className="text-overline uppercase text-ink-dim">
                  Selected Source
                </p>
                <p className="mt-3 text-section text-ink">
                  {source?.sourceName ?? 'No folder selected'}
                </p>
                <p className="mt-2 text-sm text-ink-muted">
                  {source?.sourcePath ?? 'Choose a folder from a camera card, shuttle drive, or local shoot archive.'}
                </p>
              </div>

              <div className="rounded-control border p-4 border-surface-hairline bg-surface-canvas">
                <p className="text-overline uppercase text-ink-dim">
                  Destination
                </p>
                <p className="mt-3 text-section text-ink">
                  {settings.offload.localFolder || 'Configure in Settings'}
                </p>
                <p className="mt-2 text-sm text-ink-muted">
                  Full packages mirror the selected source directly inside the dated offload bundle, with an optional `web-ready/` folder for converted images. Video files stay in that clean copied structure and are not sent to the cloud.
                </p>
                <p className="mt-2 text-sm text-ink-muted">
                  Local copy mode:{' '}
                  {settings.offload.localCopyMode === 'fast'
                    ? 'Fast metadata copy'
                    : 'Safe checksum copy'}
                  .
                </p>
              </div>
            </div>

            <div>
              <label className="mb-2 block text-overline uppercase text-ink-dim">
                Offload Label
              </label>
              <input
                value={jobName}
                onChange={(event) => setJobName(event.target.value)}
                placeholder="Championship postgame shoot"
                className={INPUT_CLASS}
              />
              <p className="mt-2 text-sm text-ink-muted">
                This label names the generated local package folder and the image-only cloud prefix.
              </p>
            </div>

            <div className="grid gap-4">
              <ToggleCard
                title="Create web-ready image copies"
                description="Converts every PNG, JPG, and JPEG in the selected folder into mirrored `.webp` files under `web-ready/` for website delivery."
                checked={convertImagesToWebp}
                onChange={setConvertImagesToWebp}
                disabled={!canConvertImages || isSubmitting}
              />
              <ToggleCard
                title="Upload picture assets to Backblaze B2"
                description="Uploads still-image assets only. Original images mirror the clean local package structure, and optional `web-ready` webp copies go alongside them in Backblaze while video files remain local."
                checked={uploadToB2}
                onChange={setUploadToB2}
                disabled={!canUploadImages || isSubmitting}
              />
            </div>

            <div className="rounded-control border border-primary-500/40 p-4 text-sm bg-primary-500/[.13] text-primary-200">
              {settings.offload.localFolder
                ? `Video files and full local packages will be written under ${settings.offload.localFolder}.`
                : 'Set an offload destination folder in Settings before you start.'}
              {settings.offload.localFolder
                ? settings.offload.localCopyMode === 'fast'
                  ? ' Fast mode uses clone-friendly copies plus size and modified-time checks to speed up first-time local offloads.'
                  : ' Safe mode reads full-file checksums before and after local copy for stricter verification.'
                : ''}
              {uploadToB2
                ? ` Image uploads will land under ${settings.b2.bucket}/${settings.offload.b2PathPrefix || 'offloads'}.`
                : ''}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-6 border-surface-hairline">
              <div className="text-sm text-ink-muted">
                {imageSummary} {source ? `Source size: ${formatFileSize(source.totalBytes)}.` : ''}
              </div>
              <button
                type="button"
                onClick={() => void handleStartOffload()}
                disabled={!canStart}
                className="rounded-control bg-primary-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-primary-400 active:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting
                  ? 'Offloading...'
                  : isResumableTask
                    ? 'Resume Offload'
                    : 'Start Offload'}
              </button>
            </div>
          </div>
        </GlassCard>

        <div className="space-y-6 xl:col-span-4">
          <GlassCard>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-overline uppercase text-ink-dim">
                  Latest Task
                </p>
                <h2 className="mt-2 text-section text-ink">
                  {activeTask?.jobName ?? 'Waiting'}
                </h2>
              </div>
              <StatusBadge tone={getTaskTone(activeTask)}>{getTaskLabel(activeTask)}</StatusBadge>
            </div>

            <div className="mt-5 space-y-4">
              <ProgressBar
                label="Overall"
                value={activeTask?.overallProgress ?? 0}
                variant="primary"
              />
              <ProgressBar
                label="Copy"
                value={activeTask?.copyProgress ?? 0}
                variant="secondary"
              />
              {convertImagesToWebp || Boolean(activeTask?.webReadyPath) ? (
                <ProgressBar
                  label="WebP"
                  value={activeTask?.conversionProgress ?? 0}
                  variant="secondary"
                />
              ) : null}
              {uploadToB2 || activeTask?.uploadEnabled ? (
                <ProgressBar
                  label="Image Upload"
                  value={activeTask?.uploadProgress ?? 0}
                  variant="secondary"
                />
              ) : null}
            </div>

            <div className="mt-5 space-y-3 text-sm text-ink-strong">
              <p>{activeTask?.message ?? 'No manual offload has run yet.'}</p>
              {activeTask ? (
                <>
                  <p>
                    {activeTask.copiedFiles} of {activeTask.totalFiles} files copied.{' '}
                    {formatFileSize(activeTask.copiedBytes)} of {formatFileSize(activeTask.totalBytes)}.
                  </p>
                  <p>
                    {activeTask.convertedImageCount} image conversions completed. {activeTask.skippedFiles} verified files were reused from the existing package.
                  </p>
                </>
              ) : null}
            </div>
          </GlassCard>

          <GlassCard>
            <p className="text-overline uppercase text-ink-dim">
              Package Paths
            </p>
            <div className="mt-4 space-y-4 text-sm text-ink-strong">
              <div>
                <p className="font-semibold text-ink">Local Package</p>
                <p className="mt-1 break-all">{activeTask?.localDestinationPath ?? 'Waiting for first offload.'}</p>
              </div>
              <div>
                <p className="font-semibold text-ink">Web-ready Images</p>
                <p className="mt-1 break-all">{activeTask?.webReadyPath ?? 'Enable image conversion to generate this folder.'}</p>
              </div>
              <div>
                <p className="font-semibold text-ink">Backblaze Image Prefix</p>
                <p className="mt-1 break-all">{activeTask?.cloudObjectKey ?? 'Enable Backblaze upload to generate this image-only prefix.'}</p>
              </div>
              <div>
                <p className="font-semibold text-ink">Manifest</p>
                <p className="mt-1 break-all">{activeTask?.manifestPath ?? 'Starts after the first offload package is created.'}</p>
              </div>
              <div>
                <p className="font-semibold text-ink">Transfer Log</p>
                <p className="mt-1 break-all">{activeTask?.logPath ?? 'Starts after the first offload package is created.'}</p>
              </div>
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}

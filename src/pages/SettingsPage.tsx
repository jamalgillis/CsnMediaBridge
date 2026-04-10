import { useEffect, useState, type FormEvent } from 'react';
import GlassCard from '../components/GlassCard';
import { useBridge } from '../context/BridgeContext';
import type { AppSettings } from '../shared/types';

function Label({ children }: { children: string }) {
  return (
    <span className="mb-2 block text-xs font-medium uppercase tracking-widest text-slate-400 dark:text-slate-500">
      {children}
    </span>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className="flex items-start gap-3 rounded-widget border border-surface-light-border
        bg-surface-light-elevated p-4
        dark:border-surface-border dark:bg-surface-deep"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 rounded border-slate-300 text-primary-400
          focus:ring-primary-400 dark:border-surface-border dark:bg-transparent"
      />
      <span>
        <span className="block font-medium text-slate-800 dark:text-white">{title}</span>
        <span className="mt-1 block text-sm text-slate-500 dark:text-slate-400">
          {description}
        </span>
      </span>
    </label>
  );
}

const INPUT_CLASS = [
  'w-full rounded-widget border border-surface-light-border bg-surface-light-elevated',
  'px-4 py-3 text-sm text-slate-900 outline-none transition',
  'placeholder:text-slate-400',
  'focus:border-primary-400/40 focus:ring-1 focus:ring-primary-400/20',
  'dark:border-surface-border dark:bg-surface-deep dark:text-white',
  'dark:placeholder:text-slate-500',
  'dark:focus:border-primary-400/40',
].join(' ');

const BROWSE_CLASS = [
  'rounded-widget border border-surface-light-border bg-surface-light-elevated',
  'px-4 py-3 text-xs font-semibold uppercase tracking-widest text-slate-600',
  'transition hover:bg-slate-200',
  'dark:border-surface-border dark:bg-surface-elevated dark:text-slate-200',
  'dark:hover:bg-surface-card',
].join(' ');

export default function SettingsPage() {
  const { settings, state, saveSettings, browseDirectory, isSavingSettings } = useBridge();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  async function browseInto(field: 'watchFolder' | 'tempOutputPath') {
    const selected = await browseDirectory();
    if (!selected) return;
    setDraft((current) => ({ ...current, [field]: selected }));
    setNotice(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveSettings(draft);
    setNotice('Settings saved and watcher state refreshed.');
  }

  return (
    <GlassCard>
      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-8">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">Pipeline Settings</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Configure the ingest paths, cloud destinations, and Convex mutation the desktop app uses
            after every successful encode.
          </p>
        </div>

        <div className="grid gap-8 xl:grid-cols-2">
          <div className="space-y-4">
            <div>
              <Label>Watch Folder</Label>
              <div className="flex gap-2">
                <input
                  value={draft.watchFolder}
                  onChange={(e) => setDraft({ ...draft, watchFolder: e.target.value })}
                  className={INPUT_CLASS}
                />
                <button
                  type="button"
                  onClick={() => void browseInto('watchFolder')}
                  className={BROWSE_CLASS}
                >
                  Browse
                </button>
              </div>
            </div>

            <div>
              <Label>Temp Output Folder</Label>
              <div className="flex gap-2">
                <input
                  value={draft.tempOutputPath}
                  onChange={(e) => setDraft({ ...draft, tempOutputPath: e.target.value })}
                  className={INPUT_CLASS}
                />
                <button
                  type="button"
                  onClick={() => void browseInto('tempOutputPath')}
                  className={BROWSE_CLASS}
                >
                  Browse
                </button>
              </div>
            </div>

            <div>
              <Label>Hardware Encoder Override</Label>
              <select
                value={draft.hardwareEncoderOverride}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    hardwareEncoderOverride: e.target.value as AppSettings['hardwareEncoderOverride'],
                  })
                }
                className={INPUT_CLASS}
              >
                <option value="auto">Auto (platform default)</option>
                <option value="nvenc">NVENC</option>
                <option value="videotoolbox">VideoToolbox</option>
                <option value="software">Software (libx264)</option>
              </select>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Ready Check Interval (ms)</Label>
                <input
                  type="number"
                  value={draft.readyCheckIntervalMs}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      readyCheckIntervalMs: Number(e.target.value) || draft.readyCheckIntervalMs,
                    })
                  }
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <Label>Stable Passes</Label>
                <input
                  type="number"
                  value={draft.readyCheckStablePasses}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      readyCheckStablePasses: Number(e.target.value) || draft.readyCheckStablePasses,
                    })
                  }
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <Label>Upload Concurrency</Label>
                <input
                  type="number"
                  value={draft.uploadConcurrency}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      uploadConcurrency: Number(e.target.value) || draft.uploadConcurrency,
                    })
                  }
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <Label>Auto Progressive Threshold (seconds)</Label>
                <input
                  type="number"
                  value={draft.autoProgressiveMaxDurationSeconds}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      autoProgressiveMaxDurationSeconds:
                        Number(e.target.value) || draft.autoProgressiveMaxDurationSeconds,
                    })
                  }
                  className={INPUT_CLASS}
                />
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <Label>B2 Bucket</Label>
              <input
                value={draft.b2.bucket}
                onChange={(e) => setDraft({ ...draft, b2: { ...draft.b2, bucket: e.target.value } })}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <Label>B2 Key ID</Label>
              <input
                value={draft.b2.keyId}
                onChange={(e) => setDraft({ ...draft, b2: { ...draft.b2, keyId: e.target.value } })}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <Label>B2 Application Key</Label>
              <input
                type="password"
                value={draft.b2.applicationKey}
                onChange={(e) =>
                  setDraft({ ...draft, b2: { ...draft.b2, applicationKey: e.target.value } })
                }
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <Label>B2 Path Prefix</Label>
              <input
                value={draft.b2.pathPrefix}
                onChange={(e) =>
                  setDraft({ ...draft, b2: { ...draft.b2, pathPrefix: e.target.value } })
                }
                className={INPUT_CLASS}
              />
            </div>
          </div>
        </div>

        <div className="grid gap-8 xl:grid-cols-2">
          <div className="space-y-4">
            <div>
              <Label>R2 Account ID</Label>
              <input
                value={draft.r2.accountId}
                onChange={(e) =>
                  setDraft({ ...draft, r2: { ...draft.r2, accountId: e.target.value } })
                }
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <Label>R2 Bucket</Label>
              <input
                value={draft.r2.bucket}
                onChange={(e) => setDraft({ ...draft, r2: { ...draft.r2, bucket: e.target.value } })}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <Label>R2 Public Base URL</Label>
              <input
                value={draft.r2.publicBaseUrl}
                onChange={(e) =>
                  setDraft({ ...draft, r2: { ...draft.r2, publicBaseUrl: e.target.value } })
                }
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <Label>R2 Access Key ID</Label>
              <input
                value={draft.r2.accessKeyId}
                onChange={(e) =>
                  setDraft({ ...draft, r2: { ...draft.r2, accessKeyId: e.target.value } })
                }
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <Label>R2 Secret Access Key</Label>
              <input
                type="password"
                value={draft.r2.secretAccessKey}
                onChange={(e) =>
                  setDraft({ ...draft, r2: { ...draft.r2, secretAccessKey: e.target.value } })
                }
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <Label>R2 Path Prefix</Label>
              <input
                value={draft.r2.pathPrefix}
                onChange={(e) =>
                  setDraft({ ...draft, r2: { ...draft.r2, pathPrefix: e.target.value } })
                }
                className={INPUT_CLASS}
              />
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <Label>Convex Deployment URL</Label>
              <input
                value={draft.convex.deploymentUrl}
                onChange={(e) =>
                  setDraft({ ...draft, convex: { ...draft.convex, deploymentUrl: e.target.value } })
                }
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <Label>Convex Mutation Path</Label>
              <input
                value={draft.convex.mutationPath}
                onChange={(e) =>
                  setDraft({ ...draft, convex: { ...draft.convex, mutationPath: e.target.value } })
                }
                className={INPUT_CLASS}
              />
            </div>

            <div className="rounded-widget border border-surface-light-border bg-surface-light-elevated p-4 dark:border-surface-border dark:bg-surface-deep">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white">App Updates</h3>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Existing installs can check this feed for new desktop builds and prompt the user to install them.
                  </p>
                </div>
                <span className="rounded-full border border-surface-light-border px-3 py-1 text-xs font-semibold uppercase tracking-widest text-slate-500 dark:border-surface-border dark:text-slate-400">
                  v{state.appUpdate.currentVersion}
                </span>
              </div>

              <div className="mt-4 space-y-4">
                <ToggleRow
                  title="Enable in-app updates"
                  description="Checks the hosted release feed on launch and on a schedule, then offers an install prompt when a newer build is ready."
                  checked={draft.appUpdates.enabled}
                  onChange={(checked) =>
                    setDraft({
                      ...draft,
                      appUpdates: { ...draft.appUpdates, enabled: checked },
                    })
                  }
                />

                <div>
                  <Label>Update Feed Base URL</Label>
                  <input
                    value={draft.appUpdates.baseUrl}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        appUpdates: { ...draft.appUpdates, baseUrl: e.target.value },
                      })
                    }
                    placeholder="https://downloads.example.com/csn-media-bridge"
                    className={INPUT_CLASS}
                  />
                </div>

                <div>
                  <Label>Update Check Interval (minutes)</Label>
                  <input
                    type="number"
                    value={draft.appUpdates.checkIntervalMinutes}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        appUpdates: {
                          ...draft.appUpdates,
                          checkIntervalMinutes:
                            Number(e.target.value) || draft.appUpdates.checkIntervalMinutes,
                        },
                      })
                    }
                    className={INPUT_CLASS}
                  />
                </div>

                <div className="rounded-widget border border-primary-400/20 bg-primary-50 p-4 text-sm text-primary-700 dark:bg-primary-400/10 dark:text-primary-200">
                  The updater uses platform-specific folders under this URL. For example, macOS arm64 expects
                  `RELEASES.json` under `.../darwin/arm64`, and Windows Squirrel expects `RELEASES`
                  under `.../win32/x64`.
                </div>

                <div className="rounded-widget border border-surface-light-border bg-white/70 p-4 text-sm text-slate-600 dark:border-surface-border dark:bg-surface-card dark:text-slate-300">
                  {state.appUpdate.message}
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <ToggleRow
                title="Auto-start watcher on launch"
                description="Recommended once the ingest station is fully configured."
                checked={draft.autoWatch}
                onChange={(checked) => setDraft({ ...draft, autoWatch: checked })}
              />
              <ToggleRow
                title="Fallback to software if hardware encode fails"
                description="Retries the transcode with libx264 when NVENC or VideoToolbox runs into trouble."
                checked={draft.autoFallbackToSoftware}
                onChange={(checked) => setDraft({ ...draft, autoFallbackToSoftware: checked })}
              />
              <ToggleRow
                title="Generate poster frame"
                description="Extracts a poster image near the 10-second mark and publishes it with the HLS output."
                checked={draft.extractPosterFrame}
                onChange={(checked) => setDraft({ ...draft, extractPosterFrame: checked })}
              />
              <ToggleRow
                title="Verify uploads after sync"
                description="Runs an rclone verification pass after archive and distribution uploads complete."
                checked={draft.verifyUploads}
                onChange={(checked) => setDraft({ ...draft, verifyUploads: checked })}
              />
              <ToggleRow
                title="Clean up temp output after success"
                description="Deletes local HLS segments and poster files once the cloud upload and registration finish."
                checked={draft.autoCleanupTempFiles}
                onChange={(checked) => setDraft({ ...draft, autoCleanupTempFiles: checked })}
              />
              <ToggleRow
                title="Desktop notifications"
                description="Shows native system alerts when a job starts, succeeds, or fails."
                checked={draft.enableNotifications}
                onChange={(checked) => setDraft({ ...draft, enableNotifications: checked })}
              />
            </div>

            <div className="rounded-widget border border-primary-400/20 bg-primary-50 p-4 text-sm text-primary-700 dark:bg-primary-400/10 dark:text-primary-200">
              Auto delivery uses sidecar metadata first. When a source is set to `auto`, videos at
              or below the threshold become progressive clips and longer videos become HLS VOD.
            </div>

            <div className="rounded-widget border border-primary-400/20 bg-primary-50 p-4 text-sm text-primary-700 dark:bg-primary-400/10 dark:text-primary-200">
              Secrets are stored through Electron Store with Electron safe storage encryption when
              the operating system supports it.
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-surface-light-border pt-6 dark:border-surface-border">
          <div className="text-sm text-slate-500 dark:text-slate-400">
            {notice ?? 'Save to persist and apply changes.'}
          </div>
          <button
            type="submit"
            disabled={isSavingSettings}
            className="rounded-widget bg-primary-400 px-5 py-3 text-sm font-semibold text-primary-950
              transition hover:bg-primary-300 active:bg-primary-500
              disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSavingSettings ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      </form>
    </GlassCard>
  );
}

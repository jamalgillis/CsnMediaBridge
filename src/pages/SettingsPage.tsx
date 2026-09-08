import { useEffect, useState, type FormEvent } from 'react';
import { useBridge } from '../context/BridgeContext';
import type { AppSettings } from '../shared/types';

function Label({ children }: { children: string }) {
  return (
    <span className="spool-label">{children}</span>
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
      className="flex items-start gap-3 rounded-control border p-4 border-surface-hairline bg-surface-canvas"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 rounded text-primary-200 focus:ring-primary-400 border-surface-hairline bg-transparent"
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

const SELECT_CLASS = 'spool-select h-11 w-full text-body text-ink';

const BROWSE_CLASS = 'spool-btn-secondary h-11 px-4';

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

  async function browseOffloadFolder() {
    const selected = await browseDirectory();
    if (!selected) return;
    setDraft((current) => ({
      ...current,
      offload: {
        ...current.offload,
        localFolder: selected,
      },
    }));
    setNotice(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveSettings(draft);
    setNotice('Settings saved and watcher state refreshed.');
  }

  return (
    <div className="px-6 pb-11 pt-[22px]">
      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-7">
        <div>
          <h1 className="text-page text-ink">Settings</h1>
          <p className="mt-1.5 max-w-2xl text-body text-ink-muted">
            Configure the ingest paths, manual offload destinations, cloud targets, and Convex
            mutation the desktop app uses after every successful encode or offload.
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
              <Label>Manual Offload Drive / Folder</Label>
              <div className="flex gap-2">
                <input
                  value={draft.offload.localFolder}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      offload: { ...draft.offload, localFolder: e.target.value },
                    })
                  }
                  className={INPUT_CLASS}
                />
                <button
                  type="button"
                  onClick={() => void browseOffloadFolder()}
                  className={BROWSE_CLASS}
                >
                  Browse
                </button>
              </div>
            </div>

            <div>
              <Label>Offload Local Copy Mode</Label>
              <select
                value={draft.offload.localCopyMode}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    offload: {
                      ...draft.offload,
                      localCopyMode: e.target.value as AppSettings['offload']['localCopyMode'],
                    },
                  })
                }
                className={SELECT_CLASS}
              >
                <option value="fast">Fast Local Copy (recommended)</option>
                <option value="safe">Safe Checksum Copy</option>
              </select>
              <p className="mt-2 text-sm text-ink-muted">
                {draft.offload.localCopyMode === 'fast'
                  ? 'Uses clone-friendly local copies plus size and modified-time checks for much faster first-pass offloads. Resume, manifest, and log behavior still stay in place.'
                  : 'Reads and verifies full-file checksums for each local original copy. This is slower, but it is the strictest local verification mode.'}
              </p>
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
                className={SELECT_CLASS}
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
              <Label>Storage Layout</Label>
              <select
                value={draft.storage.layout}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    storage: {
                      ...draft.storage,
                      layout: e.target.value as AppSettings['storage']['layout'],
                    },
                  })
                }
                className={SELECT_CLASS}
              >
                <option value="canonical">Canonical (lifecycle-aware)</option>
                <option value="legacy">Legacy (flat path prefixes)</option>
              </select>
              <p className="mt-2 text-sm text-ink-muted">
                {draft.storage.layout === 'canonical'
                  ? 'New ingests write masters/{project}/{date}/{assetKey}/ in B2 and streaming/vod/{assetKey}/ plus posters/{assetKey}/ in R2, so R2 lifecycle rules can expire social renders without touching published playback assets. Objects already uploaded stay exactly where they are.'
                  : 'New ingests write the flat {path prefix}/{job folder}/ scheme used before the storage contract. R2 lifecycle rules cannot separate temporary social renders from permanent playback assets under this layout.'}
              </p>
            </div>
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
              <Label>B2 S3 Endpoint</Label>
              <input
                value={draft.b2.s3Endpoint}
                onChange={(e) =>
                  setDraft({ ...draft, b2: { ...draft.b2, s3Endpoint: e.target.value } })
                }
                placeholder="https://s3.us-west-004.backblazeb2.com"
                className={INPUT_CLASS}
              />
              <p className="mt-2 text-sm text-ink-muted">
                Needed only to preview and retrieve archived masters from the library. Copy it
                from your bucket&apos;s details page in Backblaze — the region is read from the
                address. Uploads and downloads do not use this.
              </p>
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
              {draft.storage.layout === 'canonical' ? (
                <p className="mt-2 text-sm text-ink-muted">
                  Unused by the canonical layout. Kept so existing objects stay reachable if you
                  switch back to legacy.
                </p>
              ) : null}
            </div>
            <div>
              <Label>Offload Image B2 Prefix</Label>
              <input
                value={draft.offload.b2PathPrefix}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    offload: { ...draft.offload, b2PathPrefix: e.target.value },
                  })
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
              {draft.storage.layout === 'canonical' ? (
                <p className="mt-2 text-sm text-ink-muted">
                  Unused by the canonical layout. Kept so existing objects stay reachable if you
                  switch back to legacy.
                </p>
              ) : null}
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
              <p className="mt-2 text-sm text-ink-muted">
                Media functions live under <code>media/</code> on the shared deployment, so this
                normally reads <code>media/videos:createVodEntry</code>.
              </p>
            </div>
            <div>
              <Label>Ingest Node Token</Label>
              <input
                type="password"
                value={draft.convex.nodeToken}
                onChange={(e) =>
                  setDraft({ ...draft, convex: { ...draft.convex, nodeToken: e.target.value } })
                }
                className={INPUT_CLASS}
              />
              <p className="mt-2 text-sm text-ink-muted">
                Identifies this workstation to the shared deployment. The ingest worker runs when
                nobody is signed in, so it authenticates as a machine rather than borrowing an
                operator&apos;s session. Ask an administrator to issue one; without it the app can
                still transcode locally but cannot register anything.
              </p>
            </div>

            <div className="rounded-control border p-4 border-surface-hairline bg-surface-canvas">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-ink">App Updates</h3>
                  <p className="mt-1 text-sm text-ink-muted">
                    Existing installs can check this feed for new desktop builds. Windows can install in-app, while macOS opens the latest download and may need a security approval after replacement.
                  </p>
                </div>
                <span className="rounded-full border px-3 py-1 text-overline uppercase border-surface-hairline text-ink-muted">
                  v{state.appUpdate.currentVersion}
                </span>
              </div>

              <div className="mt-4 space-y-4">
                <ToggleRow
                  title="Enable in-app updates"
                  description="Checks the hosted release feed on launch and on a schedule, then offers the correct update action for the current platform."
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

                <div className="rounded-control border border-primary-500/40 p-4 text-sm bg-primary-500/[.13] text-primary-200">
                  The updater uses platform-specific folders under this URL. For example, macOS arm64 expects
                  `RELEASES.json` under `.../darwin/arm64`, and Windows Squirrel expects `RELEASES`
                  under `.../win32/x64`.
                </div>

                <div className="rounded-control border p-4 text-sm border-surface-hairline bg-surface-card text-ink-strong">
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

            <div className="rounded-control border border-primary-500/40 p-4 text-sm bg-primary-500/[.13] text-primary-200">
              Auto delivery uses sidecar metadata first. When a source is set to `auto`, videos at
              or below the threshold become progressive clips and longer videos become HLS VOD.
            </div>

            <div className="rounded-control border border-primary-500/40 p-4 text-sm bg-primary-500/[.13] text-primary-200">
              Secrets are stored through Electron Store with Electron safe storage encryption when
              the operating system supports it.
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-6 border-surface-hairline">
          <div className="text-sm text-ink-muted">
            {notice ?? 'Save to persist and apply changes.'}
          </div>
          <button
            type="submit"
            disabled={isSavingSettings}
            className="spool-btn-primary h-11 px-5"
          >
            {isSavingSettings ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      </form>
    </div>
  );
}

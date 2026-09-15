import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  Disclosure,
  PageHeading,
  QuietNote,
  Screen,
  Toast,
  Toggle,
  ToneChip,
  useToast,
} from '../components/csn/bridge';
import { Eyebrow, GhostButton } from '../components/csn/ui';
import { useAuth } from '../auth/AuthContext';
import { useBridge } from '../context/BridgeContext';
import type { AppSettings } from '../shared/types';

/**
 * Settings.
 *
 * The essentials are here: the folders, how videos get encoded, what the app
 * does on its own, and whether the cloud accounts are connected. Everything a
 * pipeline engineer sets once — buckets, prefixes, keys, ready-check passes,
 * the update feed — lives under one "Show support settings" disclosure, in the
 * same hairline rows but in the machine voice. See design.md §4.
 */

/** One essential row: a plain label and hint on the left, the control on the right. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="csn-hair-row flex flex-wrap items-center gap-3.5 px-4 py-3.5">
      <div className="min-w-[180px] flex-[1_1_240px]">
        <div className="text-copy font-semibold text-paper">{label}</div>
        {hint ? <div className="mt-[3px] text-caption text-pretty text-quiet">{hint}</div> : null}
      </div>
      <div className="flex flex-none items-center justify-end gap-2">{children}</div>
    </div>
  );
}

/** One advanced row: the machine's own name for a thing, and its value. */
function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="csn-hair-row flex flex-wrap items-center gap-3.5 px-4 py-3">
      <div className="min-w-[170px] flex-[1_1_220px] text-[13px] text-body">{label}</div>
      <div className="flex w-[300px] max-w-full flex-none items-center gap-2">{children}</div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <Eyebrow>{title}</Eyebrow>
      <div className="csn-hair mt-2.5">{children}</div>
    </div>
  );
}

/** The right-hand slot's read-only form: values stay condensed and tabular. */
function Value({ children }: { children: ReactNode }) {
  return (
    <span className="max-w-[250px] break-all text-right text-[13px] text-body">{children}</span>
  );
}

const ENCODER_OPTIONS: { value: AppSettings['hardwareEncoderOverride']; label: string }[] = [
  { value: 'auto', label: 'Automatic — let the app choose' },
  { value: 'videotoolbox', label: 'Apple hardware (VideoToolbox)' },
  { value: 'nvenc', label: 'NVIDIA hardware (NVENC)' },
  { value: 'software', label: 'Software — slowest, best quality' },
];

const SUPPORT_SETTINGS_ENABLED =
  typeof __SUPPORT_SETTINGS_ENABLED__ === 'boolean' ? __SUPPORT_SETTINGS_ENABLED__ : false;

export default function SettingsPage() {
  const {
    settings,
    state,
    saveSettings,
    importConnectionProfile,
    exportConnectionProfile,
    browseDirectory,
    isSavingSettings,
  } = useBridge();
  const { toast, flash } = useToast();
  const { status: authStatus, person, team, signOut } = useAuth();
  const isAuthConfigured = authStatus !== 'unconfigured';

  const [draft, setDraft] = useState<AppSettings>(settings);
  const [supportOpen, setSupportOpen] = useState(false);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  async function browseInto(field: 'watchFolder' | 'tempOutputPath') {
    const selected = await browseDirectory();
    if (!selected) return;
    setDraft((current) => ({ ...current, [field]: selected }));
  }

  async function browseOffloadFolder() {
    const selected = await browseDirectory();
    if (!selected) return;
    setDraft((current) => ({
      ...current,
      offload: { ...current.offload, localFolder: selected },
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveSettings(draft);
    flash('Settings saved');
  }

  async function handleImport() {
    const result = await importConnectionProfile();
    if (result.canceled) {
      return;
    }
    setDraft(result.settings);
    flash(`Imported ${result.profileName ?? 'connection profile'}`);
  }

  async function handleExport() {
    const result = await exportConnectionProfile('Media Bridge Connection Profile');
    if (!result.canceled) {
      flash('Exported — secrets were left out');
    }
  }

  const archiveConnected = Boolean(draft.b2.bucket && draft.b2.keyId && draft.b2.applicationKey);
  const playbackConnected = Boolean(
    draft.r2.bucket && draft.r2.accessKeyId && draft.r2.secretAccessKey,
  );
  const libraryConnected = Boolean(draft.convex.deploymentUrl && draft.convex.nodeToken);

  // One signed manifest lists every platform, so there is a single address to
  // show rather than a path per platform.
  const feedManifestUrl = draft.appUpdates.baseUrl.trim()
    ? `${draft.appUpdates.baseUrl.trim().replace(/\/+$/, '')}/latest.json`
    : 'nothing yet — set a feed address above';

  return (
    <Screen label="Settings">
      <form onSubmit={(event) => void handleSubmit(event)}>
        <div className="max-w-[700px] px-[30px] pt-[30px]">
          <PageHeading
            title="Settings"
            subhead="The essentials are here. Everything else has a sensible default."
            action={
              <ToneChip tone={dirty ? 'live' : 'neutral'}>
                {dirty ? 'Unsaved changes' : 'Saved'}
              </ToneChip>
            }
          />
        </div>

        <div className="flex max-w-[700px] flex-col gap-5 px-[30px] pt-6">
          {dirty ? (
            <div
              role="status"
              aria-live="polite"
              className="sticky top-3 z-20 flex flex-wrap items-center gap-3 rounded-card border border-accent bg-ink px-4 py-3 text-[13px] text-pretty text-paper shadow-live"
            >
              <span className="min-w-[220px] flex-1">
                Changes are only in this draft. Save changes before leaving Settings.
              </span>
              <button
                type="submit"
                disabled={isSavingSettings}
                className="csn-btn-primary"
              >
                {isSavingSettings ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          ) : null}

          <Group title="Folders">
            <Row
              label="Watch this folder"
              hint="New videos dropped here are picked up automatically."
            >
              <Value>{draft.watchFolder || 'Not set'}</Value>
              <GhostButton onClick={() => void browseInto('watchFolder')}>Change</GhostButton>
            </Row>
            <Row label="Offload drive" hint="Where camera cards get copied.">
              <Value>{draft.offload.localFolder || 'Not set'}</Value>
              <GhostButton onClick={() => void browseOffloadFolder()}>Change</GhostButton>
            </Row>
          </Group>

          <Group title="Quality">
            <Row
              label="How videos are encoded"
              hint="Automatic suits most footage. Software is slowest but gives the best picture."
            >
              <select
                value={draft.hardwareEncoderOverride}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    hardwareEncoderOverride: event.target
                      .value as AppSettings['hardwareEncoderOverride'],
                  })
                }
                className="csn-select max-w-[250px]"
              >
                {ENCODER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row
              label="Make a thumbnail"
              hint="Grabs a still from the video to use as its cover image."
            >
              <Toggle
                label="Make a thumbnail"
                checked={draft.extractPosterFrame}
                onChange={(next) => setDraft({ ...draft, extractPosterFrame: next })}
              />
            </Row>
            <Row
              label="Make scrubbing previews"
              hint="Small images along the progress bar, so you can find a moment without playing through it."
            >
              <Toggle
                label="Make scrubbing previews"
                checked={draft.generateScrubThumbnails}
                onChange={(next) => setDraft({ ...draft, generateScrubThumbnails: next })}
              />
            </Row>
          </Group>

          <Group title="Behaviour">
            <Row label="Start watching when the app opens">
              <Toggle
                label="Start watching when the app opens"
                checked={draft.autoWatch}
                onChange={(next) => setDraft({ ...draft, autoWatch: next })}
              />
            </Row>
            <Row
              label="Tidy up temporary files"
              hint="Only after the video is safely uploaded."
            >
              <Toggle
                label="Tidy up temporary files"
                checked={draft.autoCleanupTempFiles}
                onChange={(next) => setDraft({ ...draft, autoCleanupTempFiles: next })}
              />
            </Row>
            <Row
              label="Check every upload arrived"
              hint="Reads the files back after they are sent, so nothing goes missing quietly."
            >
              <Toggle
                label="Check every upload arrived"
                checked={draft.verifyUploads}
                onChange={(next) => setDraft({ ...draft, verifyUploads: next })}
              />
            </Row>
            <Row
              label="Keep going in software if the hardware encoder fails"
              hint="Slower, but the video still gets made."
            >
              <Toggle
                label="Keep going in software if the hardware encoder fails"
                checked={draft.autoFallbackToSoftware}
                onChange={(next) => setDraft({ ...draft, autoFallbackToSoftware: next })}
              />
            </Row>
            <Row label="Notify me when a video finishes">
              <Toggle
                label="Notify me when a video finishes"
                checked={draft.enableNotifications}
                onChange={(next) => setDraft({ ...draft, enableNotifications: next })}
              />
            </Row>
          </Group>

          <Group title="Offloading a card">
            <Row
              label="Make web-friendly photo copies"
              hint="Saves a smaller webp version of every photo next to the originals."
            >
              <Toggle
                label="Make web-friendly photo copies"
                checked={draft.offload.convertImagesToWebp}
                onChange={(next) =>
                  setDraft({ ...draft, offload: { ...draft.offload, convertImagesToWebp: next } })
                }
              />
            </Row>
            <Row
              label="Send photos to the cloud"
              hint="Uploads the photos only. Video always stays on the offload drive."
            >
              <Toggle
                label="Send photos to the cloud"
                checked={draft.offload.uploadImagesToCloud}
                onChange={(next) =>
                  setDraft({ ...draft, offload: { ...draft.offload, uploadImagesToCloud: next } })
                }
              />
            </Row>
          </Group>

          <Group title="Team">
            {isAuthConfigured ? (
              <>
                <Row label="Signed in as" hint={person?.email ?? undefined}>
                  <Value>{authStatus === 'signed-in' ? (person?.name ?? '—') : 'Not signed in'}</Value>
                </Row>
                <Row label="Team" hint="Decides which videos this station shows you.">
                  <Value>{team?.name ?? 'No team selected'}</Value>
                </Row>

                <Row
                  label="Sign out"
                  hint="Converting and uploading carry on while nobody is signed in."
                >
                  <GhostButton onClick={() => void signOut()}>Sign out</GhostButton>
                </Row>
              </>
            ) : (
              <div className="csn-hair-row px-4 py-3.5 text-[13px] text-pretty text-quiet">
                This station does not require sign-in. Anyone at this machine can use every screen.
              </div>
            )}
          </Group>

          <Group title="Connections">
            <Row
              label="Archive storage"
              hint="Keeps the original camera file, permanently."
            >
              <ToneChip tone={archiveConnected ? 'neutral' : 'quiet'}>
                {archiveConnected ? 'Connected' : 'Not set up'}
              </ToneChip>
            </Row>
            <Row label="Playback storage" hint="Serves the video to viewers.">
              <ToneChip tone={playbackConnected ? 'neutral' : 'quiet'}>
                {playbackConnected ? 'Connected' : 'Not set up'}
              </ToneChip>
            </Row>
            <Row label="Media library" hint="Where video records live.">
              <ToneChip tone={libraryConnected ? 'neutral' : 'quiet'}>
                {libraryConnected ? 'Connected' : 'Not set up'}
              </ToneChip>
            </Row>
          </Group>

          {SUPPORT_SETTINGS_ENABLED ? (
            <div>
              <Disclosure
                open={supportOpen}
                onToggle={() => setSupportOpen((open) => !open)}
                showLabel="Show support settings"
                hideLabel="Hide support settings"
              />
            </div>
          ) : null}

          {SUPPORT_SETTINGS_ENABLED && supportOpen ? (
            <>
              <Group title="Connection profile">
                <div className="csn-hair-row flex flex-wrap items-center gap-3.5 px-4 py-3.5">
                  <div className="min-w-[170px] flex-[1_1_220px] text-[13px] text-pretty text-body">
                    Shared connection details load in one step. This workstation’s secret keys
                    never travel in the profile.
                  </div>
                  <div className="flex flex-none gap-2">
                    <GhostButton onClick={() => void handleImport()} disabled={isSavingSettings}>
                      Import
                    </GhostButton>
                    <GhostButton onClick={() => void handleExport()}>Export</GhostButton>
                  </div>
                </div>
              </Group>

              <Group title="Storage credentials">
                <div className="csn-hair-row px-4 py-3.5 text-[13px] text-pretty text-quiet">
                  With a broker set, this station never holds the master storage keys — it
                  receives ones scoped to a single bucket and prefix that expire within hours.
                  Leave it empty to keep using the keys below.
                </div>
                <FieldRow label="Broker address">
                  <input
                    value={draft.broker.url}
                    onChange={(event) =>
                      setDraft({ ...draft, broker: { ...draft.broker, url: event.target.value } })
                    }
                    placeholder="https://credentials.example.workers.dev"
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Station token">
                  <input
                    type="password"
                    value={draft.broker.token}
                    onChange={(event) =>
                      setDraft({ ...draft, broker: { ...draft.broker, token: event.target.value } })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <Row
                  label="Route playback through the broker"
                  hint="Needed before playback storage can be made private. Turn this on only once the connected viewer portal is ready."
                >
                  <Toggle
                    label="Route playback through the broker"
                    checked={draft.broker.streamMedia}
                    onChange={(next) =>
                      setDraft({ ...draft, broker: { ...draft.broker, streamMedia: next } })
                    }
                  />
                </Row>
              </Group>

              <Group title="Archive storage">
                <FieldRow label="Bucket">
                  <input
                    value={draft.b2.bucket}
                    onChange={(event) =>
                      setDraft({ ...draft, b2: { ...draft.b2, bucket: event.target.value } })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Key ID">
                  <input
                    value={draft.b2.keyId}
                    onChange={(event) =>
                      setDraft({ ...draft, b2: { ...draft.b2, keyId: event.target.value } })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Application key">
                  <input
                    type="password"
                    value={draft.b2.applicationKey}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        b2: { ...draft.b2, applicationKey: event.target.value },
                      })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="S3 endpoint">
                  <input
                    value={draft.b2.s3Endpoint}
                    onChange={(event) =>
                      setDraft({ ...draft, b2: { ...draft.b2, s3Endpoint: event.target.value } })
                    }
                    placeholder="https://s3.us-west-004.backblazeb2.com"
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Prefix">
                  <input
                    value={draft.b2.pathPrefix}
                    onChange={(event) =>
                      setDraft({ ...draft, b2: { ...draft.b2, pathPrefix: event.target.value } })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Stills prefix">
                  <input
                    value={draft.offload.b2PathPrefix}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        offload: { ...draft.offload, b2PathPrefix: event.target.value },
                      })
                    }
                    className="csn-input"
                  />
                </FieldRow>
              </Group>

              <Group title="Playback storage">
                <FieldRow label="Account ID">
                  <input
                    value={draft.r2.accountId}
                    onChange={(event) =>
                      setDraft({ ...draft, r2: { ...draft.r2, accountId: event.target.value } })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Bucket">
                  <input
                    value={draft.r2.bucket}
                    onChange={(event) =>
                      setDraft({ ...draft, r2: { ...draft.r2, bucket: event.target.value } })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Access key ID">
                  <input
                    value={draft.r2.accessKeyId}
                    onChange={(event) =>
                      setDraft({ ...draft, r2: { ...draft.r2, accessKeyId: event.target.value } })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Secret access key">
                  <input
                    type="password"
                    value={draft.r2.secretAccessKey}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        r2: { ...draft.r2, secretAccessKey: event.target.value },
                      })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Prefix">
                  <input
                    value={draft.r2.pathPrefix}
                    onChange={(event) =>
                      setDraft({ ...draft, r2: { ...draft.r2, pathPrefix: event.target.value } })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Public base URL">
                  <input
                    value={draft.r2.publicBaseUrl}
                    onChange={(event) =>
                      setDraft({ ...draft, r2: { ...draft.r2, publicBaseUrl: event.target.value } })
                    }
                    className="csn-input"
                  />
                </FieldRow>
              </Group>

              <Group title="Sign-in provider">
                <FieldRow label="Sign-in address">
                  <input
                    value={draft.auth.issuer}
                    onChange={(event) =>
                      setDraft({ ...draft, auth: { ...draft.auth, issuer: event.target.value } })
                    }
                    placeholder="https://accounts.example.com"
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Client id">
                  <input
                    value={draft.auth.clientId}
                    onChange={(event) =>
                      setDraft({ ...draft, auth: { ...draft.auth, clientId: event.target.value } })
                    }
                    className="csn-input"
                  />
                </FieldRow>
              </Group>

              <Group title="Media library">
                <FieldRow label="Deployment">
                  <input
                    value={draft.convex.deploymentUrl}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        convex: { ...draft.convex, deploymentUrl: event.target.value },
                      })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Mutation">
                  <input
                    value={draft.convex.mutationPath}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        convex: { ...draft.convex, mutationPath: event.target.value },
                      })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Node token">
                  <input
                    type="password"
                    value={draft.convex.nodeToken}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        convex: { ...draft.convex, nodeToken: event.target.value },
                      })
                    }
                    className="csn-input"
                  />
                </FieldRow>
              </Group>

              <QuietNote>
                The node token identifies this workstation to the shared deployment. The ingest
                worker runs when nobody is signed in, so it authenticates as a machine rather than
                borrowing an operator’s session. Without one the app still converts locally but
                cannot register anything.
              </QuietNote>

              <Group title="Pipeline">
                <FieldRow label="Temp output folder">
                  <input
                    value={draft.tempOutputPath}
                    onChange={(event) => setDraft({ ...draft, tempOutputPath: event.target.value })}
                    className="csn-input"
                  />
                  <GhostButton onClick={() => void browseInto('tempOutputPath')}>Change</GhostButton>
                </FieldRow>
                <FieldRow label="Storage layout">
                  <select
                    value={draft.storage.layout}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        storage: {
                          ...draft.storage,
                          layout: event.target.value as AppSettings['storage']['layout'],
                        },
                      })
                    }
                    className="csn-select w-full"
                  >
                    <option value="canonical">Canonical (lifecycle-aware)</option>
                    <option value="legacy">Legacy (flat path prefixes)</option>
                  </select>
                </FieldRow>
                <FieldRow label="Offload copy mode">
                  <select
                    value={draft.offload.localCopyMode}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        offload: {
                          ...draft.offload,
                          localCopyMode: event.target
                            .value as AppSettings['offload']['localCopyMode'],
                        },
                      })
                    }
                    className="csn-select w-full"
                  >
                    <option value="fast">Fast (size and modified-time checks)</option>
                    <option value="safe">Safe (full-file checksums)</option>
                  </select>
                </FieldRow>
                <FieldRow label="Ready-check passes">
                  <input
                    type="number"
                    value={draft.readyCheckStablePasses}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        readyCheckStablePasses:
                          Number(event.target.value) || draft.readyCheckStablePasses,
                      })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Ready-check interval (ms)">
                  <input
                    type="number"
                    value={draft.readyCheckIntervalMs}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        readyCheckIntervalMs:
                          Number(event.target.value) || draft.readyCheckIntervalMs,
                      })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Upload concurrency">
                  <input
                    type="number"
                    value={draft.uploadConcurrency}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        uploadConcurrency: Number(event.target.value) || draft.uploadConcurrency,
                      })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Progressive threshold (s)">
                  <input
                    type="number"
                    value={draft.autoProgressiveMaxDurationSeconds}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        autoProgressiveMaxDurationSeconds:
                          Number(event.target.value) || draft.autoProgressiveMaxDurationSeconds,
                      })
                    }
                    className="csn-input"
                  />
                </FieldRow>
              </Group>

              <Group title={`App updates — v${state.appUpdate.currentVersion}`}>
                <Row
                  label="Check for new versions"
                  hint="Checks on launch and on the interval below, then installs and restarts."
                >
                  <Toggle
                    label="Check for new versions"
                    checked={draft.appUpdates.enabled}
                    onChange={(next) =>
                      setDraft({ ...draft, appUpdates: { ...draft.appUpdates, enabled: next } })
                    }
                  />
                </Row>
                <FieldRow label="Feed base URL">
                  <input
                    value={draft.appUpdates.baseUrl}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        appUpdates: { ...draft.appUpdates, baseUrl: event.target.value },
                      })
                    }
                    placeholder="https://jamalgillis.github.io/CsnMediaBridge"
                    className="csn-input"
                  />
                </FieldRow>
                <FieldRow label="Check every (minutes)">
                  <input
                    type="number"
                    value={draft.appUpdates.checkIntervalMinutes}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        appUpdates: {
                          ...draft.appUpdates,
                          checkIntervalMinutes:
                            Number(event.target.value) || draft.appUpdates.checkIntervalMinutes,
                        },
                      })
                    }
                    className="csn-input"
                  />
                </FieldRow>
                <div className="csn-hair-row px-4 py-3 machine text-[12.5px] text-pretty break-all text-quiet">
                  The app polls {feedManifestUrl}. {state.appUpdate.message}
                </div>
              </Group>

              <QuietNote>
                Secrets are stored in this machine’s application support folder, readable only
                by your user account.
              </QuietNote>
            </>
          ) : null}

          <div
            id="settings-save-actions"
            className={`flex flex-wrap items-center gap-3 rounded-card border px-4 py-3 transition-colors ${
              dirty ? 'border-accent bg-accent/[.08]' : 'border-rule bg-transparent'
            }`}
          >
            <button type="submit" disabled={isSavingSettings || !dirty} className="csn-btn-primary">
              {isSavingSettings ? 'Saving…' : dirty ? 'Save unsaved changes' : 'Saved'}
            </button>
            <span className="text-caption text-muted">
              {dirty ? 'These changes are not saved yet.' : 'Everything here is saved.'}
            </span>
          </div>
        </div>
      </form>

      <Toast message={toast} />
    </Screen>
  );
}

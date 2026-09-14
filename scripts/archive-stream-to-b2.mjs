#!/usr/bin/env node
/**
 * Archive Cloudflare Stream recordings to the Backblaze B2 cold archive.
 *
 * Cloudflare Stream is a delivery service, not an archive: it holds a
 * transcoded copy of a broadcast for as long as you keep paying for the
 * minutes, and there is no master anywhere else. This walks the account,
 * asks Stream for a downloadable MP4 of each recording, and puts it in the
 * same archive the ingest pipeline writes to, under the same layout:
 *
 *     masters/<project>/<YYYY-MM-DD>/<stream-uid>/<name>.mp4
 *     masters/<project>/<YYYY-MM-DD>/<stream-uid>/<name>.json
 *
 * The sidecar carries the Stream metadata and the SHA-256 of the file beside
 * it, because an archive nobody can identify in five years is not an archive.
 *
 * Nothing is ever deleted from Cloudflare. Deciding a recording is safe to
 * remove from Stream is a separate judgement, made after checking this
 * finished, by a person.
 *
 * Written for a one-off backlog run: it is resumable, it skips what is
 * already archived without paying to download it again, and one bad
 * recording does not stop the rest.
 *
 * Recordings stream straight from Stream into B2 and never touch the local
 * disk, so a multi-hour broadcast needs no free space on this machine. The
 * upload is checked afterwards by comparing the size B2 reports with the bytes
 * that went through, and the SHA-256 is computed on the way past.
 *
 * Usage:
 *   CF_API_TOKEN=... node scripts/archive-stream-to-b2.mjs --dry-run
 *   CF_API_TOKEN=... node scripts/archive-stream-to-b2.mjs
 *
 * Options:
 *   --dry-run     List what would be archived and stop. Run this first.
 *   --all         Include videos that did not come from a live input.
 *   --limit N     Stop after N recordings. Useful for a first real run.
 *   --work-dir P  Where the ledger lives.
 *   --self-test   Stream a small sample into a local folder through the same
 *                 upload path, check it, and stop. Needs no token and touches
 *                 neither Cloudflare nor B2.
 *   --help
 *
 * The API token needs Account > Stream > Edit. Asking Stream to prepare a
 * download is a POST, which a Read-only token is very likely refused.
 */

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const MASTERS_PREFIX = 'masters';
const UNASSIGNED_PROJECT = 'unassigned';
/** Generating an MP4 of a long broadcast is not quick. */
const DOWNLOAD_READY_TIMEOUT_MS = 45 * 60 * 1000;
const DOWNLOAD_POLL_INTERVAL_MS = 5000;

const SETTINGS_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'CSN Media Bridge',
  'settings.json',
);

/* ------------------------------------------------------------- arguments */

function parseArguments(argv) {
  const options = { dryRun: false, all: false, limit: Infinity, workDir: null, selfTest: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--all') {
      options.all = true;
    } else if (argument === '--limit') {
      options.limit = Number.parseInt(argv[(index += 1)], 10);
      if (!Number.isFinite(options.limit) || options.limit < 1) {
        throw new Error('--limit needs a whole number of recordings.');
      }
    } else if (argument === '--work-dir') {
      options.workDir = argv[(index += 1)];
      if (!options.workDir) {
        throw new Error('--work-dir needs a path.');
      }
    } else if (argument === '--self-test') {
      options.selfTest = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unrecognised option: ${argument}`);
    }
  }

  return options;
}

/* ---------------------------------------------------------------- naming */

/** Matches `slugify_segment` in the Rust host, so keys line up with ingest. */
function slugify(value, fallback) {
  let slug = '';
  let previousDash = false;

  for (const character of String(value ?? '').toLowerCase()) {
    if (/[a-z0-9]/.test(character)) {
      slug += character;
      previousDash = false;
    } else if (!previousDash && slug.length > 0) {
      slug += '-';
      previousDash = true;
    }
  }

  slug = slug.replace(/-+$/, '');
  return slug.length > 0 ? slug.slice(0, 64) : fallback;
}

function dateSegment(isoTimestamp) {
  const candidate = String(isoTimestamp ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(candidate)
    ? candidate.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
}

/**
 * The Stream uid stands in for the pipeline's content hash. It is stable and
 * unique, which means an already-archived recording can be recognised before
 * anything is downloaded rather than after.
 */
function archiveKeyFor(video) {
  const project = slugify(video.meta?.projectName ?? video.meta?.name, UNASSIGNED_PROJECT);
  const name = slugify(video.meta?.name, video.uid);
  const folder = `${MASTERS_PREFIX}/${project}/${dateSegment(video.created)}/${video.uid}`;
  return { folder, video: `${folder}/${name}.mp4`, sidecar: `${folder}/${name}.json` };
}

/* ------------------------------------------------------------ cloudflare */

async function cloudflare(token, url, init = {}) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });

    // Rate limiting and a service having a bad minute are both worth waiting
    // out; a wrong token is not.
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 4) {
        throw new Error(`Cloudflare returned HTTP ${response.status} after ${attempt} attempts.`);
      }
      await delay(attempt * 4000);
      continue;
    }

    const body = await response.json().catch(() => null);

    if (!response.ok || !body?.success) {
      const detail = body?.errors?.map((error) => `${error.code}: ${error.message}`).join('; ');
      throw new Error(detail || `Cloudflare returned HTTP ${response.status}.`);
    }

    return body.result;
  }

  throw new Error('Cloudflare did not respond.');
}

/** Walks the account by creation time; Stream pages with an `after` cursor. */
async function listStreamVideos(token, accountId) {
  const videos = [];
  let after = '1970-01-01T00:00:00Z';

  for (;;) {
    const url = `${CLOUDFLARE_API}/accounts/${accountId}/stream?limit=1000&asc=true&after=${encodeURIComponent(after)}`;
    const page = await cloudflare(token, url);

    if (!Array.isArray(page) || page.length === 0) {
      return videos;
    }

    // The cursor is inclusive, so the last item of a page opens the next one.
    const fresh = page.filter((video) => !videos.some((seen) => seen.uid === video.uid));
    videos.push(...fresh);

    if (fresh.length === 0) {
      return videos;
    }

    after = page[page.length - 1].created;
    process.stderr.write(`  …${videos.length} videos listed\n`);
  }
}

/**
 * Stream will not hand over an MP4 until it has made one, which for a long
 * broadcast takes minutes. Asking is idempotent: a second request returns the
 * download already in progress.
 */
async function readyDownloadUrl(token, accountId, uid) {
  const endpoint = `${CLOUDFLARE_API}/accounts/${accountId}/stream/${uid}/downloads`;
  let result = await cloudflare(token, endpoint, { method: 'POST' });
  const startedAt = Date.now();

  for (;;) {
    const download = result?.default;

    if (download?.status === 'ready') {
      return download.url;
    }

    if (download?.status === 'error') {
      throw new Error(download.errorReasonText || 'Stream could not prepare a download.');
    }

    if (Date.now() - startedAt > DOWNLOAD_READY_TIMEOUT_MS) {
      throw new Error(
        `Stream was still preparing the download after ${Math.round(DOWNLOAD_READY_TIMEOUT_MS / 60000)} minutes.`,
      );
    }

    await delay(DOWNLOAD_POLL_INTERVAL_MS);
    result = await cloudflare(token, endpoint);
  }
}

/* ----------------------------------------------------------------- rclone */

function runRclone(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('rclone', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => reject(new Error(`Could not start rclone: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim().split('\n').slice(-8).join('\n') || `rclone exited ${code}.`));
      }
    });
  });
}

/**
 * Built here rather than reused from ~/.config/rclone so this runs on the same
 * credentials as the pipeline. `no_check_bucket` matters: the keys are scoped
 * to a prefix, so rclone's "does this bucket exist, shall I make one" dance
 * comes back refused and fails the upload.
 */
async function writeRcloneConfig(b2, workDir) {
  const configPath = path.join(workDir, 'rclone.conf');
  await fsp.writeFile(
    configPath,
    [
      '[csnb2]',
      'type = b2',
      `account = ${b2.keyId}`,
      `key = ${b2.applicationKey}`,
      'no_check_bucket = true',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return configPath;
}

/**
 * Streams one URL into an rclone target without writing it locally.
 *
 * `rclone rcat` reads the body on stdin and switches to a chunked upload once
 * it passes the cutoff, which is how a file of unknown length reaches B2. The
 * size from `Content-Length`, when Stream sends one, lets rclone allocate the
 * upload up front. Backpressure matters: writing faster than rclone reads would
 * buffer the whole broadcast in this process's memory, which is the failure
 * this function exists to avoid.
 */
async function streamToRemote(url, configPath, target) {
  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(`Downloading the recording returned HTTP ${response.status}.`);
  }

  const declaredLength = Number(response.headers.get('content-length'));
  const args = ['rcat', target, '--config', configPath, '--retries', '1', '--low-level-retries', '10'];
  if (Number.isFinite(declaredLength) && declaredLength > 0) {
    args.push('--size', String(declaredLength));
  }

  const child = spawn('rclone', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolve, reject) => {
    child.on('error', (error) => reject(new Error(`Could not start rclone: ${error.message}`)));
    child.on('close', (code) => resolve(code));
  });
  // A closed pipe surfaces as rclone's exit code below; the write error itself
  // carries nothing more useful.
  child.stdin.on('error', () => {});

  const hash = createHash('sha256');
  let bytes = 0;

  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      bytes += chunk.length;
      if (!child.stdin.write(chunk)) {
        await new Promise((resolve) => {
          child.stdin.once('drain', resolve);
          child.once('close', resolve);
        });
      }
      if (child.exitCode !== null) {
        break;
      }
    }
  } finally {
    child.stdin.end();
  }

  const code = await exited;
  if (code !== 0) {
    throw new Error(stderr.trim().split('\n').slice(-8).join('\n') || `rclone exited ${code}.`);
  }
  if (bytes === 0) {
    throw new Error('The recording downloaded as an empty file.');
  }
  if (Number.isFinite(declaredLength) && declaredLength > 0 && bytes !== declaredLength) {
    throw new Error(`Stream sent ${bytes} bytes but promised ${declaredLength}; the download was cut short.`);
  }

  return { bytes, sha256: hash.digest('hex') };
}

/** Streams a small text body, for the sidecar. */
async function writeTextToRemote(text, configPath, target) {
  const url = `data:application/json;base64,${Buffer.from(text).toString('base64')}`;
  await streamToRemote(url, configPath, target);
}

/** The size the remote actually holds, so "uploaded" is checked, not assumed. */
async function remoteSize(configPath, target) {
  const listing = JSON.parse(
    await runRclone(['lsjson', target, '--config', configPath, '--files-only']),
  );
  return listing[0]?.Size ?? null;
}

async function listArchivedUids(configPath, bucket) {
  const listing = await runRclone([
    'lsjson',
    `csnb2:${bucket}/${MASTERS_PREFIX}`,
    '--config',
    configPath,
    '--recursive',
    '--files-only',
  ]).catch((error) => {
    // A prefix nobody has written to yet lists as nothing, not as a failure.
    if (/directory not found|not found/i.test(error.message)) {
      return '[]';
    }
    throw error;
  });

  const uids = new Set();
  for (const entry of JSON.parse(listing)) {
    // masters/<project>/<date>/<uid>/<file>
    const segments = String(entry.Path ?? '').split('/');
    if (segments.length >= 3 && /\.mp4$/i.test(entry.Name ?? '')) {
      uids.add(segments[segments.length - 2]);
    }
  }
  return uids;
}

/* ----------------------------------------------------------------- ledger */

async function readLedger(ledgerPath) {
  try {
    return JSON.parse(await fsp.readFile(ledgerPath, 'utf8'));
  } catch {
    return {};
  }
}

async function writeLedger(ledgerPath, ledger) {
  await fsp.writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

/* ------------------------------------------------------------------- main */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * Proves the streaming path end to end without Cloudflare or B2: a sample body
 * goes through `streamToRemote` into a local folder, and the result is checked
 * for size and hash against what was sent.
 */
async function selfTest() {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'archive-stream-selftest-'));
  const configPath = path.join(folder, 'empty.conf');
  await fsp.writeFile(configPath, '');

  try {
    // Larger than rclone's streaming cutoff, so the chunked path is exercised.
    const sample = randomBytes(3 * 1024 * 1024 + 17);
    const url = `data:video/mp4;base64,${sample.toString('base64')}`;
    const target = path.join(folder, 'out', 'sample.mp4');

    const { bytes, sha256 } = await streamToRemote(url, configPath, target);
    const written = await fsp.readFile(target);
    const expected = createHash('sha256').update(sample).digest('hex');

    const checks = [
      ['bytes streamed', bytes === sample.length],
      ['hash of stream', sha256 === expected],
      ['file on target', written.length === sample.length],
      ['hash of target', createHash('sha256').update(written).digest('hex') === expected],
      ['size via lsjson', (await remoteSize(configPath, target)) === sample.length],
    ];

    await writeTextToRemote('{"ok":true}\n', configPath, path.join(folder, 'out', 'sample.json'));
    checks.push(['sidecar written', (await fsp.readFile(path.join(folder, 'out', 'sample.json'), 'utf8')) === '{"ok":true}\n']);

    for (const [name, ok] of checks) {
      process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${name}\n`);
    }
    if (checks.some(([, ok]) => !ok)) {
      process.exitCode = 1;
    }
  } finally {
    await fsp.rm(folder, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(`${fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]}*/\n`);
    return;
  }

  if (options.selfTest) {
    await selfTest();
    return;
  }

  const token = process.env.CF_API_TOKEN;
  if (!token) {
    throw new Error(
      'CF_API_TOKEN is not set. Make a Cloudflare API token with Account > Stream > Edit and pass it in the environment.',
    );
  }

  const settings = JSON.parse(await fsp.readFile(SETTINGS_PATH, 'utf8'));
  const accountId = process.env.CF_ACCOUNT_ID || settings.r2?.accountId;
  const b2 = settings.b2 ?? {};

  if (!accountId) {
    throw new Error('No Cloudflare account id in settings or CF_ACCOUNT_ID.');
  }
  if (!b2.keyId || !b2.applicationKey || !b2.bucket) {
    throw new Error('Backblaze B2 is not configured in the app settings.');
  }

  const workDir =
    options.workDir ?? path.join(path.dirname(SETTINGS_PATH), 'stream-archive');
  await fsp.mkdir(workDir, { recursive: true });

  const ledgerPath = path.join(workDir, 'ledger.json');
  const ledger = await readLedger(ledgerPath);
  const configPath = await writeRcloneConfig(b2, workDir);

  try {
    process.stderr.write(`Listing Cloudflare Stream videos in account ${accountId}…\n`);
    const allVideos = await listStreamVideos(token, accountId);

    const candidates = allVideos.filter((video) => {
      if (!options.all && !video.liveInput) return false;
      if (!video.readyToStream) return false;
      return true;
    });

    process.stderr.write(
      `\n${allVideos.length} videos in Stream, ${candidates.length} ${options.all ? '' : 'live '}recordings ready to archive.\n`,
    );

    process.stderr.write('Checking what is already in the archive…\n');
    const archived = await listArchivedUids(configPath, b2.bucket);

    const pending = candidates.filter(
      (video) => !archived.has(video.uid) && ledger[video.uid]?.status !== 'archived',
    );

    process.stderr.write(
      `${candidates.length - pending.length} already archived, ${pending.length} to do.\n\n`,
    );

    if (options.dryRun) {
      for (const video of pending) {
        const keys = archiveKeyFor(video);
        process.stdout.write(
          `${video.uid}  ${formatBytes(video.size ?? 0).padStart(10)}  ${keys.video}\n`,
        );
      }
      process.stderr.write(
        `\nDry run: nothing was downloaded or uploaded. ${pending.length} recordings would be archived.\n`,
      );
      return;
    }

    let archivedCount = 0;
    let failedCount = 0;

    for (const video of pending.slice(0, options.limit)) {
      const keys = archiveKeyFor(video);
      const label = video.meta?.name || video.uid;

      process.stderr.write(`\n${label}\n  ${video.uid} · ${formatBytes(video.size ?? 0)}\n`);

      try {
        process.stderr.write('  asking Stream for a download…\n');
        const url = await readyDownloadUrl(token, accountId, video.uid);

        process.stderr.write('  streaming to B2…\n');
        const target = `csnb2:${b2.bucket}/${keys.video}`;
        const { bytes, sha256 } = await streamToRemote(url, configPath, target);

        const stored = await remoteSize(configPath, target);
        if (stored !== bytes) {
          throw new Error(`B2 holds ${stored ?? 'nothing'} bytes but ${bytes} were sent.`);
        }
        process.stderr.write(`  stored ${formatBytes(bytes)}, size verified\n`);

        await writeTextToRemote(
          `${JSON.stringify(
            {
              source: 'cloudflare_stream',
              accountId,
              uid: video.uid,
              name: video.meta?.name ?? null,
              created: video.created ?? null,
              durationSeconds: video.duration ?? null,
              liveInputId: video.liveInput ?? null,
              width: video.input?.width ?? null,
              height: video.input?.height ?? null,
              streamSizeBytes: video.size ?? null,
              archivedSizeBytes: bytes,
              sha256,
              archivedAt: new Date().toISOString(),
              objectKey: keys.video,
            },
            null,
            2,
          )}\n`,
          configPath,
          `csnb2:${b2.bucket}/${keys.sidecar}`,
        );

        ledger[video.uid] = {
          status: 'archived',
          objectKey: keys.video,
          sizeBytes: bytes,
          sha256,
          archivedAt: new Date().toISOString(),
        };
        await writeLedger(ledgerPath, ledger);

        archivedCount += 1;
        process.stderr.write(`  archived → ${keys.video}\n`);
      } catch (error) {
        failedCount += 1;
        ledger[video.uid] = {
          status: 'failed',
          error: error.message,
          failedAt: new Date().toISOString(),
        };
        await writeLedger(ledgerPath, ledger);
        process.stderr.write(`  FAILED: ${error.message}\n`);
      }
    }

    process.stderr.write(
      `\nDone. ${archivedCount} archived, ${failedCount} failed. Ledger: ${ledgerPath}\n`,
    );
    if (failedCount > 0) {
      process.stderr.write('Re-running skips what succeeded and retries the rest.\n');
      process.exitCode = 1;
    }
  } finally {
    // The config holds the B2 application key.
    await fsp.rm(configPath, { force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`\n${error.message}\n`);
  process.exitCode = 1;
});

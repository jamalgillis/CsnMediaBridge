/**
 * The credential broker.
 *
 * CSN Media Bridge stations upload with rclone, which means they need storage
 * credentials on the machine. Until now those were the *master* B2 and R2 keys,
 * typed into Settings and left there — so anyone who could read a station's
 * disk gained permanent write and delete over every asset in both buckets.
 *
 * This service holds the master keys instead, and hands a station only what it
 * needs for the work in front of it: credentials scoped to one bucket, one
 * prefix, and one set of operations, that expire in hours rather than never.
 *
 * It does not try to keep secrets *from* the operator. The app is a public
 * client on a machine they control, so anything it can obtain, they can. What
 * this changes is the blast radius: a leaked credential is write access to one
 * prefix for a few hours, instead of delete access to everything, forever.
 */

interface Env {
  CF_ACCOUNT_ID: string;
  MEDIA: R2Bucket;
  MEDIA_ALLOWED_PREFIXES: string;
  REQUIRE_TEAM_MATCH: string;
  /** Convex deployment that answers who owns an object key. */
  CONVEX_URL: string;
  R2_BUCKET: string;
  B2_BUCKET_ID: string;
  CREDENTIAL_TTL_SECONDS: string;
  R2_ALLOWED_PREFIXES: string;
  B2_ALLOWED_PREFIXES: string;

  /** Newline- or comma-separated station tokens. Secret. */
  STATION_TOKENS: string;
  /** Cloudflare API token with R2 admin, used as the parent for temp creds. Secret. */
  CF_API_TOKEN: string;
  /** Access key id of that same R2 token. Secret. */
  R2_PARENT_ACCESS_KEY_ID: string;
  /** B2 master application key, able to create keys. Secret. */
  B2_MASTER_KEY_ID: string;
  B2_MASTER_APPLICATION_KEY: string;
}

/**
 * What a station is asking to do. Capabilities follow from this rather than
 * from the caller, so a station token cannot talk its way into deletion.
 */
type Purpose = 'ingest' | 'offload' | 'delete';

const PURPOSES: Record<Purpose, { r2: boolean; b2: boolean; destructive: boolean }> = {
  ingest: { r2: true, b2: true, destructive: false },
  offload: { r2: false, b2: true, destructive: false },
  // Deleting is the one thing a routine transfer never needs, so it is kept
  // behind its own purpose. See the note in README.md: this should require an
  // operator's identity, not just a station's, once machine identity moves to
  // Clerk.
  delete: { r2: true, b2: true, destructive: true },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Compares without leaking how much of the token matched through timing.
 */
function constantTimeEquals(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  // Length alone is not secret, but the comparison still runs to completion.
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

function isKnownStation(token: string, env: Env): boolean {
  const known = env.STATION_TOKENS.split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  // Every token is checked, so the work does not depend on which one matched.
  return known.reduce(
    (matched, candidate) => constantTimeEquals(candidate, token) || matched,
    false,
  );
}

/**
 * Refuses anything outside the configured prefixes.
 *
 * Without this a station could ask for credentials over the whole bucket and
 * the broker would dutifully mint them, which would give back everything this
 * service exists to take away.
 */
function withinAllowed(requested: string[], allowed: string): string[] | null {
  const permitted = allowed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (requested.length === 0) {
    return permitted;
  }

  const normalized = requested.map((prefix) => prefix.replace(/^\/+/, ''));
  const ok = normalized.every((prefix) =>
    permitted.some((allowedPrefix) => prefix.startsWith(allowedPrefix)),
  );

  return ok ? normalized : null;
}

async function mintR2Credentials(
  env: Env,
  prefixes: string[],
  destructive: boolean,
  ttlSeconds: number,
) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/temp-access-credentials`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
      body: JSON.stringify({
        bucket: env.R2_BUCKET,
        parentAccessKeyId: env.R2_PARENT_ACCESS_KEY_ID,
        // `object-read-write` cannot delete a bucket or change its settings;
        // it is the narrowest permission that still allows an upload.
        permission: destructive ? 'admin-read-write' : 'object-read-write',
        ttlSeconds,
        prefixes,
      }),
    },
  );

  const body = (await response.json()) as {
    success?: boolean;
    result?: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
    errors?: { message: string }[];
  };

  if (!response.ok || !body.success || !body.result) {
    throw new Error(
      `R2 refused to mint credentials: ${body.errors?.map((e) => e.message).join('; ') ?? response.status}`,
    );
  }

  return body.result;
}

async function mintB2Credentials(
  env: Env,
  namePrefix: string,
  destructive: boolean,
  ttlSeconds: number,
) {
  const authorization = await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
    headers: {
      Authorization: `Basic ${btoa(`${env.B2_MASTER_KEY_ID}:${env.B2_MASTER_APPLICATION_KEY}`)}`,
    },
  });

  if (!authorization.ok) {
    throw new Error(`B2 would not authorize the broker: ${authorization.status}`);
  }

  const auth = (await authorization.json()) as {
    accountId: string;
    authorizationToken: string;
    apiInfo: { storageApi: { apiUrl: string } };
  };

  // Read is included so the app can verify an upload arrived; delete never is,
  // unless the request was explicitly for that purpose.
  const capabilities = ['listBuckets', 'listFiles', 'readFiles', 'writeFiles'];
  if (destructive) {
    capabilities.push('deleteFiles');
  }

  const created = await fetch(`${auth.apiInfo.storageApi.apiUrl}/b2api/v4/b2_create_key`, {
    method: 'POST',
    headers: {
      Authorization: auth.authorizationToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      accountId: auth.accountId,
      capabilities,
      keyName: `bridge-${Date.now()}`,
      validDurationInSeconds: ttlSeconds,
      bucketIds: [env.B2_BUCKET_ID],
      namePrefix,
    }),
  });

  if (!created.ok) {
    throw new Error(`B2 refused to mint a key: ${created.status} ${await created.text()}`);
  }

  const key = (await created.json()) as { applicationKeyId: string; applicationKey: string };
  return key;
}


/* ------------------------------------------------------------------ playback */

/**
 * Decisions already made, so an HLS video does not cost one Convex query per
 * segment.
 *
 * Keyed by the *asset* a request resolved to rather than the object, because a
 * player fetches hundreds of segments under one asset folder. Lookups walk the
 * object's ancestor prefixes, mirroring how the resolver itself matches, so a
 * segment hits the entry its manifest created.
 *
 * Per isolate and short-lived on purpose: revoking access should take effect in
 * seconds, not whenever a Worker happens to recycle.
 */
const OWNERSHIP_CACHE = new Map<string, { allowed: boolean; expiresAt: number }>();
const OWNERSHIP_CACHE_MS = 60_000;

async function stationFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  // Enough to separate stations without keeping the token itself in a map key.
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** `a/b/c.m4s` -> [`a/b/c.m4s`, `a/b`, `a`]; closest first. */
function ancestorKeys(objectKey: string): string[] {
  const segments = objectKey.split('/').filter(Boolean);
  const keys = [objectKey];
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    keys.push(segments.slice(0, depth).join('/'));
  }
  return keys;
}

function cachedDecision(station: string, objectKey: string): boolean | null {
  const now = Date.now();
  for (const key of ancestorKeys(objectKey)) {
    const hit = OWNERSHIP_CACHE.get(`${station}:${key}`);
    if (hit && hit.expiresAt > now) {
      return hit.allowed;
    }
  }
  return null;
}

/**
 * Asks the library whether this station's organization owns the asset behind an
 * object key.
 *
 * The library returns `allowed` as the whole answer — the broker deliberately
 * does not re-derive ownership from paths or names, so a Worker running an old
 * build cannot get subtly wrong what the schema already knows.
 */
async function stationOwnsObject(
  env: Env,
  nodeToken: string,
  objectKey: string,
): Promise<{ allowed: boolean; reason?: string; matchedKey?: string }> {
  const response = await fetch(`${env.CONVEX_URL.replace(/\/+$/, '')}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'media/ownership:resolveObjectKeyOwner',
      args: { objectKey, nodeToken },
      format: 'json',
    }),
  });

  if (!response.ok) {
    throw new Error(`Convex answered ${response.status}`);
  }

  const body = (await response.json()) as {
    status?: string;
    value?: { allowed?: boolean; reason?: string; matchedKey?: string };
    errorMessage?: string;
  };

  if (body.status !== 'success' || !body.value) {
    throw new Error(body.errorMessage ?? 'Convex refused the ownership query');
  }

  return {
    allowed: Boolean(body.value.allowed),
    reason: body.value.reason,
    matchedKey: body.value.matchedKey,
  };
}

/**
 * Streams a playback object out of the bucket for an authenticated station.
 *
 * This exists so R2 can stop being public. With `REQUIRE_TEAM_MATCH` on it also
 * answers "does this station's organization own this asset?", by asking the
 * library rather than reading a team out of the path — object keys are a
 * contract shared with the web app and deliberately carry no tenant.
 *
 * It fails closed: a library that cannot be reached refuses the request rather
 * than serving it.
 */
async function serveMedia(
  request: Request,
  env: Env,
  objectKey: string,
  stationToken: string,
): Promise<Response> {
  if (env.REQUIRE_TEAM_MATCH === 'true') {
    const nodeToken = request.headers.get('X-CSN-Node-Token')?.trim();
    if (!nodeToken) {
      return json(
        {
          error: 'unauthorized',
          message: 'Team-scoped playback needs the station library credential.',
        },
        401,
      );
    }

    const station = await stationFingerprint(stationToken);
    let allowed = cachedDecision(station, objectKey);

    if (allowed === null) {
      try {
        const decision = await stationOwnsObject(env, nodeToken, objectKey);
        allowed = decision.allowed;
        OWNERSHIP_CACHE.set(`${station}:${decision.matchedKey ?? objectKey}`, {
          allowed,
          expiresAt: Date.now() + OWNERSHIP_CACHE_MS,
        });
        if (!allowed) {
          console.warn('Refused playback', { objectKey, reason: decision.reason });
        }
      } catch (error) {
        console.error('Could not resolve ownership', error);
        return json(
          { error: 'unavailable', message: 'Could not check who owns this asset.' },
          503,
        );
      }
    }

    if (!allowed) {
      return json({ error: 'forbidden', message: 'That asset belongs to another team.' }, 403);
    }
  }

  const allowed = env.MEDIA_ALLOWED_PREFIXES.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  // Keeps the archive out of reach even though it lives in the same account.
  if (!allowed.some((prefix) => objectKey.startsWith(prefix))) {
    return json({ error: 'forbidden', message: 'That path is not served here.' }, 403);
  }

  // Range matters: a player seeking in a long video asks for byte ranges, and
  // answering with the whole object would stall playback and waste egress. R2
  // parses the Range header itself, so it is handed over rather than reparsed.
  const object = await env.MEDIA.get(objectKey, {
    range: request.headers,
    onlyIf: request.headers,
  });

  if (!object) {
    return json({ error: 'not_found' }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  // These are private assets; no shared cache should keep a copy.
  headers.set('Cache-Control', 'private, max-age=60');

  // `get` returns a body-less object when a conditional request already
  // matched, and when only metadata came back.
  if (!('body' in object) || !object.body) {
    return new Response(null, { status: 304, headers });
  }

  if (object.range && 'offset' in object.range && 'length' in object.range) {
    const start = object.range.offset ?? 0;
    const end = start + (object.range.length ?? 0) - 1;
    headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }

  return new Response(object.body, { status: 200, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true });
    }

    const isCredentials = url.pathname === '/credentials' && request.method === 'POST';
    const isMedia = url.pathname.startsWith('/media/') && request.method === 'GET';

    if (!isCredentials && !isMedia) {
      return json({ error: 'not_found' }, 404);
    }

    const header = request.headers.get('Authorization') ?? '';
    if (!header.startsWith('Bearer ')) {
      return json({ error: 'unauthorized', message: 'Missing station token.' }, 401);
    }

    if (!isKnownStation(header.slice('Bearer '.length).trim(), env)) {
      return json({ error: 'unauthorized', message: 'Unknown station.' }, 401);
    }

    if (isMedia) {
      return serveMedia(
        request,
        env,
        decodeURIComponent(url.pathname.slice('/media/'.length)),
        header.slice('Bearer '.length).trim(),
      );
    }

    let body: { purpose?: string; r2Prefixes?: string[]; b2NamePrefix?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: 'invalid_request', message: 'Body must be JSON.' }, 400);
    }

    const purpose = (body.purpose ?? 'ingest') as Purpose;
    const plan = PURPOSES[purpose];
    if (!plan) {
      return json({ error: 'invalid_request', message: `Unknown purpose '${purpose}'.` }, 400);
    }

    const ttlSeconds = Number(env.CREDENTIAL_TTL_SECONDS) || 3600;

    const r2Prefixes = withinAllowed(body.r2Prefixes ?? [], env.R2_ALLOWED_PREFIXES);
    if (plan.r2 && !r2Prefixes) {
      return json({ error: 'forbidden', message: 'Requested R2 prefix is not allowed.' }, 403);
    }

    const requestedB2Prefix = (body.b2NamePrefix ?? '').replace(/^\/+/, '');
    const b2Allowed = withinAllowed(
      requestedB2Prefix ? [requestedB2Prefix] : [],
      env.B2_ALLOWED_PREFIXES,
    );
    if (plan.b2 && !b2Allowed) {
      return json({ error: 'forbidden', message: 'Requested B2 prefix is not allowed.' }, 403);
    }

    // A station that names no prefix gets the narrowest configured one rather
    // than the whole bucket.
    const b2Prefix = requestedB2Prefix || b2Allowed?.[0] || '';

    try {
      const [r2, b2] = await Promise.all([
        plan.r2 ? mintR2Credentials(env, r2Prefixes ?? [], plan.destructive, ttlSeconds) : null,
        plan.b2
          ? mintB2Credentials(env, b2Prefix, plan.destructive, ttlSeconds)
          : null,
      ]);

      return json({
        // A little earlier than the real expiry, so a station renews before a
        // transfer starts failing mid-flight.
        expiresAt: new Date(Date.now() + (ttlSeconds - 120) * 1000).toISOString(),
        r2: r2
          ? {
              accessKeyId: r2.accessKeyId,
              secretAccessKey: r2.secretAccessKey,
              sessionToken: r2.sessionToken,
            }
          : null,
        b2: b2 ? { keyId: b2.applicationKeyId, applicationKey: b2.applicationKey } : null,
      });
    } catch (error) {
      // The reason is logged for an operator of this service, but the station
      // is told only that it failed — the message can name buckets and keys.
      console.error('Could not mint credentials', error);
      return json({ error: 'upstream_failed', message: 'Could not mint credentials.' }, 502);
    }
  },
};

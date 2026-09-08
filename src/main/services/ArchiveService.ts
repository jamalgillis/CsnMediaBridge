/**
 * Short-lived, single-object access to the Backblaze B2 master vault.
 *
 * The vault is private and nobody on staff has a Backblaze login — the app is
 * the only way in. This mints a presigned URL for one object so an operator can
 * preview an archived master in the library without the bucket ever being
 * public and without credentials leaving the main process.
 *
 * Presigning is the only thing done with the S3 SDK here. Moving actual bytes
 * stays with `SyncService`'s rclone path, which already has progress reporting,
 * retries, and verification — duplicating that against a second client would be
 * two transfer implementations to keep correct for no gain.
 */

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppSettings, LogLevel } from '../../shared/types';

interface ArchiveLogger {
  (level: LogLevel, message: string, jobId?: string): void;
}

/**
 * Long enough to scrub through a long master, short enough that a URL copied
 * out of devtools is not a lasting credential.
 */
const DEFAULT_EXPIRY_SECONDS = 60 * 60;

const B2_ENDPOINT_PATTERN = /^https:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com\/?$/i;

/**
 * B2's S3 endpoint carries its region in the hostname, and SigV4 needs the
 * region to match. Deriving it from the endpoint keeps that to one field an
 * operator has to get right instead of two that must agree.
 */
export function parseB2Endpoint(endpoint: string) {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(B2_ENDPOINT_PATTERN);
  if (!match) {
    return null;
  }

  return { endpoint: trimmed, region: match[1].toLowerCase() };
}

export class ArchiveService {
  constructor(private readonly log: ArchiveLogger) {}

  /**
   * Explains what is missing rather than returning a bare false, so the UI can
   * tell an operator which setting to fill in instead of just disabling a button.
   */
  getUnavailableReason(settings: AppSettings) {
    if (!settings.b2.bucket.trim()) {
      return 'Set the Backblaze B2 bucket in Settings before previewing archived masters.';
    }

    if (!settings.b2.keyId.trim() || !settings.b2.applicationKey.trim()) {
      return 'Backblaze B2 credentials are required before previewing archived masters.';
    }

    if (!settings.b2.s3Endpoint.trim()) {
      return 'Set the B2 S3 endpoint in Settings, for example https://s3.us-west-004.backblazeb2.com.';
    }

    if (!parseB2Endpoint(settings.b2.s3Endpoint)) {
      return `"${settings.b2.s3Endpoint}" is not a Backblaze S3 endpoint. It should look like https://s3.us-west-004.backblazeb2.com.`;
    }

    return null;
  }

  isAvailable(settings: AppSettings) {
    return this.getUnavailableReason(settings) === null;
  }

  private createClient(settings: AppSettings) {
    const parsed = parseB2Endpoint(settings.b2.s3Endpoint);
    if (!parsed) {
      throw new Error(this.getUnavailableReason(settings) ?? 'B2 S3 endpoint is not configured.');
    }

    return new S3Client({
      endpoint: parsed.endpoint,
      region: parsed.region,
      credentials: {
        accessKeyId: settings.b2.keyId,
        secretAccessKey: settings.b2.applicationKey,
      },
    });
  }

  /**
   * A time-limited URL for exactly one archived object.
   *
   * Returned to the renderer for playback and never persisted — a new one is
   * minted each time an operator opens an asset, so a stale URL in a React
   * state tree expires on its own rather than lingering as a shareable link.
   */
  async getPresignedObjectUrl(
    settings: AppSettings,
    objectKey: string,
    expiresInSeconds = DEFAULT_EXPIRY_SECONDS,
  ) {
    const reason = this.getUnavailableReason(settings);
    if (reason) {
      throw new Error(reason);
    }

    const normalizedKey = objectKey.trim().replace(/^\/+/, '');
    if (!normalizedKey) {
      throw new Error('An archive object key is required.');
    }

    const client = this.createClient(settings);

    try {
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: settings.b2.bucket, Key: normalizedKey }),
        { expiresIn: Math.max(60, Math.min(24 * 60 * 60, expiresInSeconds)) },
      );

      // The key is logged; the signature is not.
      this.log('info', `Signed archive preview URL for ${normalizedKey}.`);
      return url;
    } finally {
      client.destroy();
    }
  }
}

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { AddressInfo } from 'node:net';
import { createId } from '../lib/helpers';

const ALLOWED_PROTOCOLS = new Set(['http', 'https']);
const MEDIA_MIME_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4a': 'audio/mp4',
  '.m4s': 'video/iso.segment',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ts': 'video/mp2t',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
};

function applyCorsHeaders(response: ServerResponse) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', '*');
}

function copyResponseHeader(
  upstreamHeaders: Headers,
  response: ServerResponse,
  headerName: string,
) {
  const value = upstreamHeaders.get(headerName);
  if (value) {
    response.setHeader(headerName, value);
  }
}

function getRequestTarget(request: IncomingMessage) {
  if (!request.url) {
    return null;
  }

  const requestUrl = new URL(request.url, 'http://127.0.0.1');
  const pathSegments = requestUrl.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  const [protocol, host, ...pathParts] = pathSegments;
  if (!protocol || !host || !ALLOWED_PROTOCOLS.has(protocol)) {
    return null;
  }

  const pathname = `/${pathParts.join('/')}`;
  return `${protocol}://${host}${pathname}${requestUrl.search}`;
}

export class MediaProxyService {
  private server: Server | null = null;
  private origin: string | null = null;
  private startPromise: Promise<string> | null = null;
  private readonly localFileTokens = new Map<string, string>();

  async getProxyUrl(remoteUrl: string | null | undefined) {
    if (!remoteUrl) {
      return remoteUrl ?? undefined;
    }

    const remote = new URL(remoteUrl);
    if (!ALLOWED_PROTOCOLS.has(remote.protocol.replace(':', ''))) {
      return remoteUrl;
    }

    const origin = await this.ensureStarted();
    const protocol = remote.protocol.replace(':', '');
    return `${origin}/${protocol}/${remote.host}${remote.pathname}${remote.search}`;
  }

  async getLocalFileUrl(filePath: string) {
    const origin = await this.ensureStarted();

    let token = this.localFileTokens.get(filePath);
    if (!token) {
      token = createId();
      this.localFileTokens.set(filePath, token);
    }

    return `${origin}/local/${token}/${encodeURIComponent(path.basename(filePath))}`;
  }

  async stop() {
    this.startPromise = null;

    if (!this.server) {
      this.origin = null;
      return;
    }

    const server = this.server;
    this.server = null;
    this.origin = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async ensureStarted() {
    if (this.origin) {
      return this.origin;
    }

    if (this.startPromise) {
      return await this.startPromise;
    }

    this.startPromise = new Promise<string>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response);
      });

      server.once('error', (error) => {
        this.startPromise = null;
        reject(error);
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo | null;
        if (!address) {
          this.startPromise = null;
          reject(new Error('Media proxy did not receive a listening address.'));
          return;
        }

        this.server = server;
        this.origin = `http://127.0.0.1:${address.port}`;
        resolve(this.origin);
      });
    });

    return await this.startPromise;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    applyCorsHeaders(response);

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Method not allowed.');
      return;
    }

    if (request.url?.startsWith('/local/')) {
      await this.handleLocalFileRequest(request, response);
      return;
    }

    const targetUrl = getRequestTarget(request);
    if (!targetUrl) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid proxy target.');
      return;
    }

    try {
      const upstreamResponse = await fetch(targetUrl, {
        headers: {
          accept: request.headers.accept ?? '*/*',
          ...(typeof request.headers.range === 'string'
            ? { range: request.headers.range }
            : {}),
        },
        method: request.method,
        redirect: 'follow',
      });

      response.statusCode = upstreamResponse.status;
      response.statusMessage = upstreamResponse.statusText;

      copyResponseHeader(upstreamResponse.headers, response, 'accept-ranges');
      copyResponseHeader(upstreamResponse.headers, response, 'cache-control');
      copyResponseHeader(upstreamResponse.headers, response, 'content-length');
      copyResponseHeader(upstreamResponse.headers, response, 'content-range');
      copyResponseHeader(upstreamResponse.headers, response, 'content-type');
      copyResponseHeader(upstreamResponse.headers, response, 'etag');
      copyResponseHeader(upstreamResponse.headers, response, 'last-modified');

      if (request.method === 'HEAD' || !upstreamResponse.body) {
        response.end();
        return;
      }

      Readable.fromWeb(upstreamResponse.body as NodeReadableStream).pipe(response);
    } catch (error) {
      response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : 'Media proxy request failed.');
    }
  }

  private async handleLocalFileRequest(request: IncomingMessage, response: ServerResponse) {
    const filePath = this.getLocalFilePath(request.url);
    if (!filePath) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Unknown local media token.');
      return;
    }

    const fileStats = await stat(filePath).catch(() => null);
    if (!fileStats?.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Local media file not found.');
      return;
    }

    const contentType = MEDIA_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const rangeHeader = typeof request.headers.range === 'string' ? request.headers.range : null;

    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', contentType);

    if (!rangeHeader) {
      response.setHeader('Content-Length', String(fileStats.size));

      if (request.method === 'HEAD') {
        response.writeHead(200);
        response.end();
        return;
      }

      createReadStream(filePath).pipe(response);
      return;
    }

    const byteRange = this.parseByteRange(rangeHeader, fileStats.size);
    if (!byteRange) {
      response.writeHead(416, {
        'Content-Range': `bytes */${fileStats.size}`,
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end('Requested range not satisfiable.');
      return;
    }

    const { start, end } = byteRange;
    const chunkSize = end - start + 1;

    response.writeHead(206, {
      'Content-Length': String(chunkSize),
      'Content-Range': `bytes ${start}-${end}/${fileStats.size}`,
    });

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    createReadStream(filePath, { start, end }).pipe(response);
  }

  private getLocalFilePath(requestUrl: string | undefined) {
    if (!requestUrl) {
      return null;
    }

    const pathname = new URL(requestUrl, 'http://127.0.0.1').pathname;
    const [, scope, token] = pathname.split('/');
    if (scope !== 'local' || !token) {
      return null;
    }

    for (const [filePath, registeredToken] of this.localFileTokens.entries()) {
      if (registeredToken === token) {
        return filePath;
      }
    }

    return null;
  }

  private parseByteRange(rangeHeader: string, fileSize: number) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/i);
    if (!match) {
      return null;
    }

    const [, startValue, endValue] = match;

    if (!startValue && !endValue) {
      return null;
    }

    if (!startValue) {
      const suffixLength = Number(endValue);
      if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
        return null;
      }

      const start = Math.max(fileSize - suffixLength, 0);
      return { start, end: fileSize - 1 };
    }

    const start = Number(startValue);
    const end = endValue ? Number(endValue) : fileSize - 1;

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      start >= fileSize
    ) {
      return null;
    }

    return { start, end: Math.min(end, fileSize - 1) };
  }
}

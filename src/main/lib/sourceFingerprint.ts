import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function computeSourceFingerprint(sourcePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(sourcePath);

    stream.on('data', (chunk) => {
      hash.update(chunk);
    });

    stream.on('error', (error) => {
      reject(error);
    });

    stream.on('end', () => {
      resolve(`sha256:${hash.digest('hex')}`);
    });
  });
}

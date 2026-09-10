import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const sourcePath = process.argv[2] ?? 'assets/icon.png';
const outputPath = process.argv[3] ?? 'src-tauri/icons/icon.png';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);

  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function unfilterScanlines(data, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const output = Buffer.alloc(stride * height);
  let inputOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = data[inputOffset];
    inputOffset += 1;
    const rowOffset = y * stride;
    const previousRowOffset = rowOffset - stride;

    for (let x = 0; x < stride; x += 1) {
      const raw = data[inputOffset + x];
      const left = x >= bytesPerPixel ? output[rowOffset + x - bytesPerPixel] : 0;
      const above = y > 0 ? output[previousRowOffset + x] : 0;
      const upperLeft =
        y > 0 && x >= bytesPerPixel ? output[previousRowOffset + x - bytesPerPixel] : 0;

      if (filter === 0) output[rowOffset + x] = raw;
      else if (filter === 1) output[rowOffset + x] = (raw + left) & 0xff;
      else if (filter === 2) output[rowOffset + x] = (raw + above) & 0xff;
      else if (filter === 3) output[rowOffset + x] = (raw + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) {
        output[rowOffset + x] = (raw + paethPredictor(left, above, upperLeft)) & 0xff;
      } else {
        throw new Error(`Unsupported PNG filter ${filter}.`);
      }
    }

    inputOffset += stride;
  }

  return output;
}

function encodeRgbaScanlines(rgb, width, height) {
  const rgbaStride = width * 4;
  const output = Buffer.alloc((rgbaStride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const outputRowOffset = y * (rgbaStride + 1);
    const inputRowOffset = y * width * 3;
    output[outputRowOffset] = 0;

    for (let x = 0; x < width; x += 1) {
      const inputOffset = inputRowOffset + x * 3;
      const outputOffset = outputRowOffset + 1 + x * 4;
      output[outputOffset] = rgb[inputOffset];
      output[outputOffset + 1] = rgb[inputOffset + 1];
      output[outputOffset + 2] = rgb[inputOffset + 2];
      output[outputOffset + 3] = 255;
    }
  }

  return output;
}

const input = await readFile(sourcePath);
if (!input.subarray(0, 8).equals(PNG_SIGNATURE)) {
  throw new Error(`${sourcePath} is not a PNG file.`);
}

let offset = 8;
let ihdr = null;
const idatChunks = [];
const ancillaryChunks = [];

while (offset < input.length) {
  const length = input.readUInt32BE(offset);
  const type = input.subarray(offset + 4, offset + 8).toString('ascii');
  const data = input.subarray(offset + 8, offset + 8 + length);
  offset += 12 + length;

  if (type === 'IHDR') ihdr = Buffer.from(data);
  else if (type === 'IDAT') idatChunks.push(Buffer.from(data));
  else if (type !== 'IEND' && type !== 'PLTE' && type !== 'tRNS') {
    ancillaryChunks.push(makeChunk(type, Buffer.from(data)));
  }
}

if (!ihdr) {
  throw new Error(`${sourcePath} is missing an IHDR chunk.`);
}

const width = ihdr.readUInt32BE(0);
const height = ihdr.readUInt32BE(4);
const bitDepth = ihdr[8];
const colorType = ihdr[9];
const interlace = ihdr[12];

if (bitDepth !== 8 || colorType !== 2 || interlace !== 0) {
  throw new Error('Only 8-bit non-interlaced RGB PNG icons are supported.');
}

const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
const rgb = unfilterScanlines(inflated, width, height, 3);
const rgbaScanlines = encodeRgbaScanlines(rgb, width, height);

const outputIhdr = Buffer.from(ihdr);
outputIhdr[9] = 6;

const chunks = [
  PNG_SIGNATURE,
  makeChunk('IHDR', outputIhdr),
  ...ancillaryChunks,
  makeChunk('IDAT', zlib.deflateSync(rgbaScanlines)),
  makeChunk('IEND', Buffer.alloc(0)),
];

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, Buffer.concat(chunks));

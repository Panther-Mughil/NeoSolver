/**
 * Minimal, dependency-free ustar writer (+ gzip).
 *
 * Implements exactly what plan §4.7 requires: 512-byte headers, octal
 * mode/uid/gid/size/mtime, the header checksum, `prefix` splitting for long
 * names, 512-byte data padding, and the two-zero-block terminator.
 *
 * Proven correct by a round-trip test that shells out to the real system `tar`.
 */

import zlib from 'node:zlib';
import { NeoError } from './errors.mjs';

const BLOCK_SIZE = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
/** Deterministic mtime keeps the archive byte-reproducible; 0 is valid ustar. */
export const DEFAULT_MTIME = 0;

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(String(value ?? ''), 'utf8');
  if (bytes.length > length) {
    throw new NeoError('tar_field_overflow', 502, `tar field overflow for "${value}"`);
  }
  bytes.copy(buffer, offset, 0, bytes.length);
}

function writeOctal(buffer, offset, length, value) {
  const digits = Math.max(1, length - 1);
  const text = Number(value).toString(8);
  if (text.length > digits) {
    throw new NeoError('tar_field_overflow', 502, `tar numeric field overflow for ${value}`);
  }
  buffer.write(text.padStart(digits, '0'), offset, digits, 'ascii');
  buffer[offset + length - 1] = 0;
}

/**
 * Split a long path across the ustar `name` and `prefix` fields.
 * @returns {{name: string, prefix: string}}
 */
function splitName(path) {
  if (Buffer.byteLength(path, 'utf8') <= NAME_MAX) return { name: path, prefix: '' };

  const parts = path.split('/');
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    const prefix = parts.slice(0, index).join('/');
    const name = parts.slice(index).join('/');
    if (Buffer.byteLength(prefix, 'utf8') <= PREFIX_MAX && Buffer.byteLength(name, 'utf8') <= NAME_MAX) {
      return { name, prefix };
    }
  }
  throw new NeoError(
    'path_too_long',
    502,
    `the path "${path}" cannot be represented in a ustar archive (name >100 bytes and no usable prefix split). Use ?format=sh instead.`,
  );
}

function buildHeader({ path, size, mtime, mode = 0o644, typeflag = '0' }) {
  const header = Buffer.alloc(BLOCK_SIZE);
  const { name, prefix } = splitName(path);

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtime);
  // Checksum field is written as spaces while the sum is computed.
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 1, 'ascii');
  writeString(header, 157, 100, ''); // linkname
  writeString(header, 257, 6, 'ustar'); // magic ("ustar\0")
  header[262] = 0;
  writeString(header, 263, 2, '00'); // version
  writeString(header, 265, 32, 'root'); // uname
  writeString(header, 297, 32, 'root'); // gname
  writeOctal(header, 329, 8, 0); // devmajor
  writeOctal(header, 337, 8, 0); // devminor
  writeString(header, 345, PREFIX_MAX, prefix);

  let checksum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) checksum += header[index];
  const checksumText = checksum.toString(8).padStart(6, '0');
  header.write(checksumText, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

/**
 * Build an uncompressed ustar archive.
 * @param {Array<{path: string, content: string}>} files
 * @param {{mtime?: number}} [options]
 * @returns {Buffer}
 */
export function buildTar(files, { mtime = DEFAULT_MTIME } = {}) {
  const chunks = [];
  for (const file of files) {
    const data = Buffer.from(file.content, 'utf8');
    chunks.push(buildHeader({ path: file.path, size: data.length, mtime }));
    chunks.push(data);
    const padding = (BLOCK_SIZE - (data.length % BLOCK_SIZE)) % BLOCK_SIZE;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2)); // terminator
  return Buffer.concat(chunks);
}

/**
 * Build a gzip-compressed ustar archive.
 * @param {Array<{path: string, content: string}>} files
 * @param {{mtime?: number, gzipOptions?: object}} [options]
 * @returns {Buffer}
 */
export function buildTarGz(files, { mtime = DEFAULT_MTIME, gzipOptions } = {}) {
  return zlib.gzipSync(buildTar(files, { mtime }), { level: 9, ...gzipOptions });
}

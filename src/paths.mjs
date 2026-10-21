/**
 * Path sanitisation and solution-size limits.
 *
 * The file map comes from a language model reading remote input, so it is
 * treated as hostile. A single bad path rejects the WHOLE response — nothing is
 * silently dropped, because a partial write would leave a broken workspace.
 */

import { NeoError, unsafePath, emptySolution, unprocessableReply } from './errors.mjs';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * @param {string} raw
 * @returns {string} the clean relative path
 * @throws {NeoError} `unsafe_path` (502)
 */
export function sanitisePath(raw) {
  const reject = (reason) => {
    throw unsafePath(`refusing to use the path ${JSON.stringify(raw)}: ${reason}. Nothing was rendered.`);
  };

  if (typeof raw !== 'string') reject('not a string');
  if (raw === '') reject('empty path');
  if (CONTROL_CHARS.test(raw)) reject('contains control characters (NUL or similar)');
  if (raw.includes('\\')) reject('contains a Windows path separator');
  if (raw.startsWith('/')) reject('absolute path');
  if (raw.startsWith('-')) reject('leading "-" (would be read as an option)');

  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment === '') reject('empty path segment (leading, trailing or doubled "/")');
    if (segment === '.') reject('"." segment');
    if (segment === '..') reject('".." segment (path traversal)');
  }

  return segments.join('/');
}

/**
 * Validate the whole model-provided file map into an ordered array.
 *
 * @param {Record<string, string>} fileMap
 * @param {{maxFiles?: number, maxTotalBytes?: number}} limits
 * @returns {Array<{path: string, content: string}>} sorted by path
 */
export function collectFiles(fileMap, { maxFiles = 64, maxTotalBytes = 4 * 1024 * 1024 } = {}) {
  if (!fileMap || typeof fileMap !== 'object') {
    throw emptySolution('the model reply contained no file map. Nothing was rendered.');
  }

  const entries = Object.entries(fileMap);
  if (entries.length === 0) {
    throw emptySolution('the model returned zero files. Nothing was rendered.');
  }

  const seen = new Set();
  const out = [];
  let totalBytes = 0;

  for (const [rawPath, content] of entries) {
    const path = sanitisePath(rawPath);

    if (seen.has(path)) {
      throw new NeoError(
        'duplicate_path',
        502,
        `the model returned the path "${path}" more than once — the result is ambiguous. Nothing was rendered.`,
      );
    }
    seen.add(path);

    if (typeof content !== 'string') {
      throw unprocessableReply(
        `the content for "${path}" is not a string (got ${content === null ? 'null' : typeof content}). Nothing was rendered.`,
      );
    }

    totalBytes += Buffer.byteLength(content, 'utf8');
    out.push({ path, content });
  }

  if (out.length > maxFiles) {
    throw new NeoError(
      'too_many_files',
      502,
      `the model returned ${out.length} files, which exceeds the limit of ${maxFiles}. Nothing was rendered.`,
    );
  }
  if (totalBytes > maxTotalBytes) {
    throw new NeoError(
      'solution_too_large',
      502,
      `the model returned ${totalBytes} bytes of files, which exceeds the limit of ${maxTotalBytes}. Nothing was rendered.`,
    );
  }

  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

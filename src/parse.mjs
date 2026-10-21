/**
 * Tolerant extraction of files from a model reply.
 *
 * Five ordered strategies (plan §4.4). The primary contract is one fenced code
 * block per file, annotated with the file's path in the info string; the JSON
 * strategies remain as fallbacks for models that insist on JSON. If every
 * strategy fails the caller raises a 502 and NOTHING is rendered.
 */

import { NeoError } from './errors.mjs';

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;

/** Shape a candidate JS value into `{files, notes}`, or return null. */
function shape(value) {
  if (!value || typeof value !== 'object') return null;

  if (Object.prototype.hasOwnProperty.call(value, 'files')) {
    // An explicit envelope is authoritative: take its map as-is, including
    // names without a dot or slash, so that a hostile path reaches the
    // sanitiser and is rejected with the right error instead of being dropped.
    const files = filesFrom(value.files, { requirePathShape: false });
    if (files) {
      return { files, notes: typeof value.notes === 'string' ? value.notes : '' };
    }
  }

  const asMap = filesFrom(value, { requirePathShape: true });
  if (asMap) {
    return { files: asMap, notes: typeof value.notes === 'string' ? value.notes : '' };
  }
  return null;
}

/** Accept `{path: content}`, `{path: {content}}` and `[{path, content}]`. */
function filesFrom(candidate, { requirePathShape = true } = {}) {
  if (Array.isArray(candidate)) {
    const out = Object.create(null);
    let found = false;
    for (const entry of candidate) {
      if (!entry || typeof entry !== 'object') continue;
      const path = entry.path ?? entry.name ?? entry.file ?? entry.filename;
      const content = entry.content ?? entry.text ?? entry.code ?? entry.source;
      if (typeof path === 'string' && typeof content === 'string') {
        // A JSON object cannot hold a duplicate key, but a list can. Silently
        // keeping the last one would write a file the model did not intend, so
        // the whole response is rejected (plan §8).
        if (Object.prototype.hasOwnProperty.call(out, path)) {
          throw new NeoError(
            'duplicate_path',
            502,
            `the model returned the path "${path}" more than once — the result is ambiguous. Nothing was rendered.`,
          );
        }
        out[path] = content;
        found = true;
      }
    }
    return found ? out : null;
  }

  if (!candidate || typeof candidate !== 'object') return null;

  const out = Object.create(null);
  let found = false;
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value === 'string') {
      out[key] = value;
      found = true;
    } else if (value && typeof value === 'object') {
      const inner = value.content ?? value.text;
      if (typeof inner === 'string') {
        out[key] = inner;
        found = true;
      }
    }
  }
  if (!found) return null;

  if (requirePathShape) {
    // Guard against reading an envelope such as {"notes":"..."} as a file map.
    const looksLikePaths = Object.keys(out).some((key) => key.includes('/') || key.includes('.'));
    return looksLikePaths ? out : null;
  }
  return out;
}

/**
 * Escape RAW control characters that appear INSIDE a JSON string literal.
 *
 * Models routinely embed a literal newline or tab in a JSON string instead of
 * the required `\n` / `\t` escape. A tiny scanner tracks whether it is inside a
 * string (respecting backslash escapes) and rewrites only those bytes, so text
 * outside string literals stays byte-identical. Deliberately does NOT repair
 * unescaped quotes or truncated JSON — those are out of scope.
 *
 * @param {string} text
 * @returns {string}
 */
function repairJson(text) {
  const source = String(text);
  let out = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (!inString) {
      out += char;
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      out += char;
      inString = false;
      continue;
    }
    if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else out += char;
  }
  return out;
}

function tryJson(text) {
  const trimmed = String(text).trim();
  if (trimmed === '') return null;
  try {
    return shape(JSON.parse(repairJson(trimmed)));
  } catch (error) {
    // Do not swallow a structural rejection (duplicate path, unsafe shape).
    if (error instanceof NeoError) throw error;
    return null;
  }
}

/** Strategy 3: strip a ```json … ``` wrapper (with any surrounding prose). */
function fromFencesWhole(text) {
  const source = String(text);
  const match = /```(?:json|JSON)?\s*\n([\s\S]*?)```/.exec(source);
  if (!match) return null;
  return tryJson(match[1]);
}

/** Strategy 4: first `{` through last `}`. */
function fromBraces(text) {
  const source = String(text);
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return tryJson(source.slice(start, end + 1));
}

/**
 * Recover the file path from a fence info string, or null when there is none.
 *
 * The path may be preceded by a language tag (`jsx App.jsx`) and a `file=`,
 * `filename=`, `path=` or `title=` prefix is stripped. Everything from the
 * first path-looking token onwards is taken, so a path containing spaces
 * (`src/components/Ünïcode Panel.jsx`) survives intact.
 *
 * @param {string} info
 * @returns {string|null}
 */
function pathFromInfo(info) {
  const tokens = String(info)
    .split(/[\s,;]+/)
    .map((token) => token.replace(/^(?:file|filename|path|title)=/i, '').replace(/^["'`]|["'`]$/g, ''))
    .filter((token) => token !== '');
  const start = tokens.findIndex((token) => token.includes('/') || /\.[a-z0-9]{2,6}$/i.test(token));
  if (start === -1) return null;
  return tokens.slice(start).join(' ');
}

/** Strategy 1: fenced blocks annotated with a filename in the info string. */
function fromAnnotatedFences(text) {
  const source = String(text);
  FENCE.lastIndex = 0;
  const files = Object.create(null);
  let found = false;
  let match;
  while ((match = FENCE.exec(source)) !== null) {
    const candidate = pathFromInfo(match[1]);
    if (!candidate) continue;
    files[candidate] = match[2];
    found = true;
  }
  return found ? { files, notes: '' } : null;
}

/** Strategy 5: one unlabelled code block plus exactly one target hint. */
function fromSingleFenceAndTarget(text, targets) {
  if (targets.length !== 1) return null;
  const source = String(text);
  FENCE.lastIndex = 0;
  const blocks = [];
  let match;
  while ((match = FENCE.exec(source)) !== null) {
    const info = match[1].trim();
    if (info === '' || /^(?:sh|json|bash|javascript|js|jsx|css|html|text|plain)$/i.test(info)) {
      blocks.push(match[2]);
    }
  }
  if (blocks.length !== 1) return null;
  return { files: { [targets[0]]: blocks[0] }, notes: '' };
}

/**
 * @param {string} text model reply
 * @param {{targets?: string[]}} [options]
 * @returns {{files: Record<string, string>, notes: string, strategy: number}|null}
 */
export function parseReply(text, { targets = [] } = {}) {
  const strategies = [
    () => fromAnnotatedFences(text),
    () => tryJson(text),
    () => fromFencesWhole(text),
    () => fromBraces(text),
    () => fromSingleFenceAndTarget(text, targets),
  ];

  for (let index = 0; index < strategies.length; index += 1) {
    let result = null;
    try {
      result = strategies[index]();
    } catch (error) {
      // A structurally valid reply that is unsafe/ambiguous must fail loudly
      // rather than fall through to a laxer strategy.
      if (error instanceof NeoError) throw error;
      result = null;
    }
    if (result && result.files && Object.keys(result.files).length > 0) {
      return { ...result, strategy: index + 1 };
    }
  }
  return null;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderShell, CONTENT_TYPES, FORMATS, usageText } from '../src/render.mjs';
import { run, listFiles } from './helpers/processes.mjs';

/**
 * Hostile content: quotes, EOF-like text, heredoc-lookalike lines, command
 * substitution, CRLF, no trailing newline, an empty file, unicode and spaces and
 * shell metacharacters in paths, and a path deep enough to need ustar prefix
 * splitting.
 */
const HOSTILE_FILES = [
  {
    path: 'App.jsx',
    content:
      'export default function App() {\n' +
      '  const hostile = `quotes: \'single\' and "double"`;\n' +
      '  return <p title=\'a\'>{hostile}</p>;\n' +
      '}\n',
  },
  { path: 'styles/style.css', content: ':root {\r\n  --neo-accent: #4f9cf9;\r\n}\r\n' },
  {
    path: 'notes/EOF.txt',
    content:
      "NEO_EOF_1\nNEO_EOF_2\nEOF\n<<'X'\ncat > 'file'\n$(whoami)\n`id`\n#!/bin/sh\nrm -rf /\n",
  },
  { path: 'no-trailing-newline.js', content: 'const answer = 42;' },
  { path: 'empty.txt', content: '' },
  { path: 'src/components/Ünïcode Panel.jsx', content: 'export default function P() { return null; }\n' },
  { path: 'src/we;ird & name/「quoted」.js', content: 'export const weird = true;\n' },
];

// `[` is the POSIX test builtin, used as `if [ ... ]`.
const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'set',
  'exit',
  'while',
  'do',
  'done',
  'return',
  '[',
]);
// `chmod` is coreutils and is used intentionally: a write that fails on a
// read-only file retries once after `chmod u+w`.
const COREUTILS = new Set(['mkdir', 'base64', 'cat', 'chmod']);

/** Mask single-quoted regions so metacharacters inside paths do not split. */
const maskQuoted = (line) => line.replace(/'[^']*'/g, "''");

/** Count occurrences of a quote character that are not backslash-escaped. */
function countUnescaped(line, ch) {
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === ch && line[i - 1] !== '\\') count += 1;
  }
  return count;
}

/**
 * Every token in command position, with heredoc bodies and comments removed.
 * Shell keywords are reported so the caller can allow them explicitly.
 *
 * A double-quoted VALUE may span lines, e.g.
 *
 *     neo_statuses="$neo_statuses
 *         App.jsx: written"
 *
 * Nothing inside such a string is a command, so continuation lines are skipped
 * until the closing quote. Without this the status labels are mistaken for
 * commands (`App.jsx:` reads as a program named `App.jsx:`).
 */
function commandTokens(script) {
  const tokens = [];
  let heredoc = null;
  let inDoubleValue = false;

  for (const raw of script.split('\n')) {
    const line = raw.trim();
    if (heredoc !== null) {
      if (line === heredoc) heredoc = null;
      continue;
    }
    if (inDoubleValue) {
      if (countUnescaped(line, '"') % 2 === 1) inDoubleValue = false;
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;

    for (const part of maskQuoted(line).split(/[;&|]+/)) {
      const trimmed = part.trim();
      if (trimmed === '') continue;
      const words = trimmed.split(/\s+/);
      // Skip leading shell keywords so `if base64 -d > f` reports `base64`,
      // not `if`.
      let index = 0;
      while (index < words.length && KEYWORDS.has(words[index])) index += 1;
      const token = words[index];
      if (token === undefined) continue;
      if (/^[0-9$'"]/.test(token)) continue; // an argument, not a command
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // variable assignment
      tokens.push(token);
    }

    const opened = /<<'([^']+)'\s*$/.exec(line);
    if (opened) heredoc = opened[1];

    if (/^[A-Za-z_][A-Za-z0-9_]*="/.test(line) && countUnescaped(line, '"') % 2 === 1) {
      inDoubleValue = true;
    }
  }
  return tokens;
}

function renderAndRun(files, { testCommand = null, shellEnv = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'neosolver-sh-'));
  try {
    const script = renderShell(files, { testCommand });
    writeFileSync(path.join(dir, 'solution.sh'), script);
    const result = run('sh solution.sh', { cwd: dir, env: shellEnv });
    return { dir, script, result };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

test('the default format is the shell script', () => {
  assert.equal(FORMATS[0], 'sh');
  assert.equal(CONTENT_TYPES.sh, 'text/x-shellscript');
  assert.equal(CONTENT_TYPES.tar, 'application/gzip');
  assert.equal(CONTENT_TYPES.json, 'application/json');
});

test('hostile content is reproduced byte-for-byte under POSIX sh', () => {
  const { dir, result } = renderAndRun(HOSTILE_FILES);
  try {
    assert.equal(result.status, 0, `sh failed:\n${result.stderr}`);
    for (const file of HOSTILE_FILES) {
      const written = readFileSync(path.join(dir, file.path));
      assert.ok(
        written.equals(Buffer.from(file.content, 'utf8')),
        `${file.path} differs: ${JSON.stringify(written.toString('utf8'))}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('byte-for-byte fidelity also holds with POSIXLY_CORRECT=1', () => {
  const { dir, result } = renderAndRun(HOSTILE_FILES, { shellEnv: { POSIXLY_CORRECT: '1' } });
  try {
    assert.equal(result.status, 0, `sh failed:\n${result.stderr}`);
    assert.equal(readFileSync(path.join(dir, 'no-trailing-newline.js'), 'utf8'), 'const answer = 42;');
    assert.equal(statSync(path.join(dir, 'empty.txt')).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the script passes a POSIX syntax check', () => {
  const { dir, script } = renderAndRun(HOSTILE_FILES);
  try {
    const check = run('sh -n solution.sh', { cwd: dir });
    assert.equal(check.status, 0, check.stderr);
    assert.match(script.split('\n')[0], /^#!\/bin\/sh$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only coreutils commands appear in the file-writing phase', () => {
  const { dir, script } = renderAndRun(HOSTILE_FILES);
  try {
    const writePhase = script.slice(0, script.indexOf('printf'));
    const tokens = commandTokens(writePhase);
    assert.ok(tokens.length > 0, 'expected to find commands in the write phase');
    for (const token of tokens) {
      if (KEYWORDS.has(token)) continue; // `set -e` and friends
      assert.ok(COREUTILS.has(token), `non-coreutils command in the write phase: ${token}`);
    }
    // And specifically nothing beyond the three allowed coreutils (shell
    // keywords such as `set -e` are stripped first).
    const commands = [...new Set(tokens)].filter((token) => !KEYWORDS.has(token)).sort();
    assert.deepEqual(commands, ['base64', 'chmod', 'mkdir']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the whole script uses nothing outside coreutils, the test runner and shell keywords', () => {
  const { dir, script } = renderAndRun(HOSTILE_FILES, { testCommand: 'npm test' });
  try {
    const allowed = new Set([...COREUTILS, 'printf', 'sh', ...KEYWORDS]);
    for (const token of commandTokens(script)) {
      assert.ok(allowed.has(token), `unexpected command in the generated script: ${token}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unique heredoc delimiters are used even when the content contains NEO_EOF_1', () => {
  const { dir, script } = renderAndRun(HOSTILE_FILES);
  try {
    assert.match(script, /<<'NEO_EOF_1'/);
    assert.match(script, /NEO_EOF_1\n[A-Za-z0-9+/=]/); // actual base64 payload follows
    assert.ok(script.includes("<<'NEO_EOF_2'"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a passing test command is reported as PASS (exit 0)', () => {
  const { dir, result } = renderAndRun(HOSTILE_FILES, { testCommand: 'true' });
  try {
    assert.equal(result.status, 0);
    assert.match(result.stdout, /=== NeoSolver: test result: PASS \(exit 0\) ===/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a FAILING test command is reported, does not abort, and still exits 0', () => {
  const { dir, result } = renderAndRun(HOSTILE_FILES, { testCommand: 'exit 3' });
  try {
    assert.equal(result.status, 0, 'the script must exit 0 even when tests fail');
    assert.match(result.stdout, /=== NeoSolver: test result: FAIL \(exit 3\) ===/);
    // It must continue past the failure and still print the final code.
    assert.match(result.stdout, /=== NeoSolver: final code ===/);
    assert.match(result.stdout, /=== NeoSolver: done ===/);
    assert.match(result.stdout, /export default function App/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('?test=none skips the tests entirely', () => {
  const { dir, result } = renderAndRun(HOSTILE_FILES, { testCommand: null });
  try {
    assert.equal(result.status, 0);
    assert.match(result.stdout, /tests skipped/);
    assert.ok(!result.stdout.includes('running tests'), 'no test run should be attempted');
    assert.ok(!commandTokens(readFileSync(path.join(dir, 'solution.sh'), 'utf8')).includes('sh'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the final code of every written file is printed', () => {
  const { dir, result } = renderAndRun(HOSTILE_FILES, { testCommand: null });
  try {
    for (const file of HOSTILE_FILES) {
      assert.ok(result.stdout.includes(`--- ${file.path} ---`), `missing header for ${file.path}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing file write aborts with a non-zero status', () => {
  // `base64 -d > '<dir that does not exist>'` cannot succeed, so set -e must fire.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'neosolver-sh-fail-'));
  try {
    const script = renderShell([{ path: 'missing-dir/file.txt', content: 'x' }], { testCommand: null })
      .replace(/^mkdir -p .*$/m, 'true # mkdir neutralised');
    writeFileSync(path.join(dir, 'solution.sh'), script);
    const result = run('sh solution.sh', { cwd: dir });
    assert.notEqual(result.status, 0, 'a failed write must not exit 0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the generated script creates exactly the expected tree and nothing else', () => {
  const { dir } = renderAndRun(HOSTILE_FILES, { testCommand: null });
  try {
    const expected = HOSTILE_FILES.map((file) => file.path).sort();
    assert.deepEqual(listFiles(dir).filter((file) => file !== 'solution.sh'), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usage text derives its one-liners from the request base URL', () => {
  const text = usageText({ baseUrl: 'https://solver.example.com' });
  assert.match(text, /curl -s https:\/\/solver\.example\.com\/s\/neo -T tests\.js \| sh/);
  assert.match(text, /curl -s https:\/\/solver\.example\.com -T tests\.js \| sh/);
  assert.match(text, /NEOSOLVER_ALLOW_ANON=1/);
  assert.match(text, /Get \/healthz|GET \/healthz/);
  assert.match(text, /-d strips newlines/);
  assert.match(text, /trailing slash/i);
  assert.ok(!text.includes('<YOUR-DOMAIN>'));
});

test('usage text mentions anon mode only when it is enabled', () => {
  assert.ok(!usageText({ baseUrl: 'http://x' }).includes('no token is required'));
  assert.ok(usageText({ baseUrl: 'http://x', allowAnon: true }).includes('no token is required'));
});

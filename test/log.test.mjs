/**
 * The logger's file sink.
 *
 * It exists so an unattended service keeps a bounded log: the file rotates to a
 * single `<file>.1` once the next line would pass the cap. Logging must never be
 * able to break the service, so an unwritable path has to degrade to stderr
 * rather than throw.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '../src/log.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'neo-log-'));
/** A stream that discards output, so tests do not print to the console. */
const silentStream = () => ({ write() {} });

test('lines reach the file and known secrets are redacted', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'service.log');
    const log = createLogger({
      level: 'debug',
      secrets: ['super-secret-key'],
      filePath: file,
      fileMaxBytes: 1 << 20,
      stream: silentStream(),
    });

    log.info('hello', { detail: 'key=super-secret-key' });
    log.close();

    const text = readFileSync(file, 'utf8');
    assert.match(text, /INFO {2}hello/);
    assert.match(text, /\[REDACTED\]/);
    assert.ok(!text.includes('super-secret-key'), 'the secret must never be written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file rotates to <file>.1 instead of growing without bound', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'service.log');
    const cap = 1024;
    const log = createLogger({ level: 'info', filePath: file, fileMaxBytes: cap, stream: silentStream() });

    for (let i = 0; i < 200; i += 1) log.info(`line ${i} ${'x'.repeat(40)}`);
    log.close();

    assert.ok(existsSync(`${file}.1`), 'a rotated generation must exist');
    assert.ok(statSync(file).size <= cap, `live file exceeded the cap: ${statSync(file).size}`);
    assert.ok(statSync(`${file}.1`).size <= cap, `rotated file exceeded the cap: ${statSync(`${file}.1`).size}`);
    // One generation only: no unbounded chain.
    assert.ok(!existsSync(`${file}.2`), 'rotation must keep a single previous generation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotation can be disabled with a zero cap', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'service.log');
    const log = createLogger({ level: 'info', filePath: file, fileMaxBytes: 0, stream: silentStream() });
    for (let i = 0; i < 100; i += 1) log.info(`line ${i} ${'x'.repeat(40)}`);
    log.close();
    assert.ok(statSync(file).size > 0);
    assert.ok(!existsSync(`${file}.1`), 'a zero cap must disable rotation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unwritable log path degrades to the stream instead of throwing', () => {
  const captured = [];
  const log = createLogger({
    level: 'info',
    filePath: '/proc/definitely/not/writable/service.log',
    stream: { write: (chunk) => captured.push(chunk) },
  });

  assert.doesNotThrow(() => log.info('still works'));
  log.close();

  const text = captured.join('');
  assert.match(text, /cannot open log file/);
  assert.match(text, /still works/, 'logging must continue on stderr');
});

test('close() is safe to call twice', () => {
  const dir = tempDir();
  try {
    const log = createLogger({ filePath: join(dir, 'a.log'), stream: silentStream() });
    log.close();
    assert.doesNotThrow(() => log.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

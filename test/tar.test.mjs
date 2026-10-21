import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildTar, buildTarGz } from '../src/tar.mjs';
import { hasCommand, listFiles, run } from './helpers/processes.mjs';
import { EXPECTED_DIR, readTree } from './helpers/mock-provider.mjs';

const TAR_AVAILABLE = hasCommand('tar');

const LONG_PATH =
  'src/deeply/nested/directory/structure/that/definitely/exceeds/one/hundred/characters/so/that/ustar/prefix/splitting/is/exercised/Component.jsx';

const HOSTILE = [
  { path: 'App.jsx', content: 'export default function App() { return null; }\n' },
  { path: 'styles/style.css', content: ':root {\r\n  --x: 1;\r\n}\r\n' },
  { path: 'no-trailing-newline.js', content: 'const answer = 42;' },
  { path: 'empty.txt', content: '' },
  { path: 'src/components/Ünïcode Panel.jsx', content: 'export default function P() {}\n' },
  { path: LONG_PATH, content: 'export default function Deep() {}\n' },
];

function inTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'neosolver-tar-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the long path really does need ustar prefix splitting', () => {
  assert.ok(LONG_PATH.length > 100, 'fixture path must exceed the 100-byte name field');
});

test('the ustar header is structurally valid', () => {
  const buffer = buildTar([{ path: 'a.txt', content: 'hello' }]);
  // one header + 512 bytes of data (padded) + two zero blocks
  assert.equal(buffer.length, 512 + 512 + 1024);

  const header = buffer.subarray(0, 512);
  assert.equal(header.subarray(257, 263).toString('binary'), 'ustar\u0000');
  assert.equal(header.subarray(263, 265).toString('ascii'), '00');
  assert.equal(header.subarray(0, 5).toString('ascii'), 'a.txt');
  assert.equal(header.subarray(156, 157).toString('ascii'), '0');
  assert.equal(parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, ''), 8), 5);
  assert.equal(parseInt(header.subarray(100, 108).toString('ascii').replace(/\0.*$/, ''), 8), 0o644);

  // Checksum: sum of the header with the checksum field read as spaces.
  const expected = parseInt(header.subarray(148, 154).toString('ascii'), 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of copy) sum += byte;
  assert.equal(expected, sum);

  // Terminator blocks.
  assert.ok(buffer.subarray(buffer.length - 1024).every((byte) => byte === 0));
});

test('data is padded to a 512-byte boundary', () => {
  const buffer = buildTar([{ path: 'a.txt', content: 'x'.repeat(600) }]);
  assert.equal(buffer.length, 512 + 1024 + 1024);
});

const tarTest = test('round-trips through the real system tar', { skip: !TAR_AVAILABLE }, () => {
  inTempDir((dir) => {
    writeFileSync(path.join(dir, 'archive.tgz'), buildTarGz(HOSTILE));

    const listed = run('tar -tzf archive.tgz', { cwd: dir });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split('\n').sort(), HOSTILE.map((f) => f.path).sort());

    const verbose = run('tar -tzvf archive.tgz', { cwd: dir });
    assert.equal(verbose.status, 0, verbose.stderr);
    assert.match(verbose.stdout, /root\/root/);

    const out = path.join(dir, 'out');
    const extracted = run(`mkdir -p out && tar -xzf archive.tgz -C out`, { cwd: dir });
    assert.equal(extracted.status, 0, extracted.stderr);

    for (const file of HOSTILE) {
      const written = readFileSync(path.join(out, file.path));
      assert.ok(
        written.equals(Buffer.from(file.content, 'utf8')),
        `${file.path} did not survive the tar round-trip`,
      );
    }
    assert.deepEqual(listFiles(out), HOSTILE.map((f) => f.path).sort());
  });
});

test('the real fixture tree round-trips through system tar byte-for-byte', { skip: !TAR_AVAILABLE }, () => {
  const tree = readTree(EXPECTED_DIR);
  const files = Object.entries(tree)
    .map(([filePath, content]) => ({ path: filePath, content }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  inTempDir((dir) => {
    writeFileSync(path.join(dir, 'fixture.tgz'), buildTarGz(files));
    const extracted = run('mkdir -p out && tar -xzf fixture.tgz -C out', { cwd: dir });
    assert.equal(extracted.status, 0, extracted.stderr);

    for (const file of files) {
      assert.ok(
        readFileSync(path.join(dir, 'out', file.path)).equals(
          readFileSync(path.join(EXPECTED_DIR, file.path)),
        ),
        `${file.path} differs after extraction`,
      );
    }
    assert.deepEqual(listFiles(path.join(dir, 'out')), files.map((f) => f.path));
  });
});

test('tar output is deterministic across builds', () => {
  const a = buildTarGz(HOSTILE);
  const b = buildTarGz(HOSTILE);
  assert.ok(a.equals(b));
});

test('a path that ustar cannot represent is rejected, not silently truncated', () => {
  const impossible = `${'d'.repeat(120)}/${'e'.repeat(120)}/${'f'.repeat(120)}/${'g'.repeat(120)}/file.js`;
  assert.throws(
    () => buildTar([{ path: impossible, content: 'x' }]),
    (error) => error.code === 'path_too_long' && error.status === 502,
  );
});

test('a directory-only prefix still splits into name and prefix fields', () => {
  const deep = `${'a/'.repeat(60)}file.js`.replace(/\/$/, '');
  const buffer = buildTar([{ path: deep, content: 'x' }]);
  const nameField = buffer.subarray(0, 100).toString('binary').replace(/\0.*$/, '');
  const prefixField = buffer.subarray(345, 500).toString('binary').replace(/\0.*$/, '');
  assert.equal(`${prefixField}/${nameField}`, deep);
});

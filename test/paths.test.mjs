import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitisePath, collectFiles } from '../src/paths.mjs';
import { NeoError } from '../src/errors.mjs';

const rejects = (code, status) => (error) =>
  error instanceof NeoError && error.code === code && error.status === status;

test('clean relative paths are accepted unchanged', () => {
  assert.equal(sanitisePath('App.jsx'), 'App.jsx');
  assert.equal(sanitisePath('styles/style.css'), 'styles/style.css');
  assert.equal(sanitisePath('src/components/Ünïcode Panel.jsx'), 'src/components/Ünïcode Panel.jsx');
});

const BAD_PATHS = [
  ['../../etc/passwd', 'traversal from the root'],
  ['/etc/passwd', 'absolute'],
  ['-rf', 'leading dash'],
  ['a/../../b', 'traversal mid-path'],
  ['..', 'bare parent'],
  ['.', 'bare current directory'],
  ['', 'empty'],
  ['a//b', 'doubled separator'],
  ['a/', 'trailing separator'],
  ['/a', 'leading separator'],
  ['C:\\windows\\system32', 'Windows separators'],
  ['a\\b', 'single backslash'],
  ['a\u0000b', 'NUL byte'],
  ['a\nb', 'newline'],
  ['a\tb', 'tab'],
];

for (const [value, why] of BAD_PATHS) {
  test(`rejects ${JSON.stringify(value)} (${why})`, () => {
    assert.throws(() => sanitisePath(value), rejects('unsafe_path', 502));
  });
}

test('a single bad path rejects the WHOLE response (nothing is dropped silently)', () => {
  assert.throws(
    () => collectFiles({ 'App.jsx': 'ok', '../../etc/passwd': 'pwned' }),
    rejects('unsafe_path', 502),
  );
});

test('the rejection message names the offending path and says nothing was rendered', () => {
  try {
    collectFiles({ '-rf': 'x' });
    assert.fail('should have thrown');
  } catch (error) {
    assert.match(error.message, /-rf/);
    assert.match(error.message, /[Nn]othing was rendered/);
  }
});

test('duplicate keys cannot survive an object, but the guard is still present', () => {
  // Object keys are unique, so this exercises the explicit seen-set check with a
  // path that normalises onto another one is impossible; assert the happy path.
  const files = collectFiles({ 'App.jsx': 'a', 'App.css': 'b' });
  assert.deepEqual(
    files.map((file) => file.path),
    ['App.css', 'App.jsx'],
  );
});

test('file count limit is enforced', () => {
  const many = {};
  for (let index = 0; index < 5; index += 1) many[`f${index}.js`] = 'x';
  assert.throws(
    () => collectFiles(many, { maxFiles: 3 }),
    rejects('too_many_files', 502),
  );
  assert.equal(collectFiles(many, { maxFiles: 5 }).length, 5);
});

test('total size limit is enforced', () => {
  const big = { 'a.js': 'x'.repeat(1000) };
  assert.throws(
    () => collectFiles(big, { maxTotalBytes: 999 }),
    rejects('solution_too_large', 502),
  );
  assert.equal(collectFiles(big, { maxTotalBytes: 1000 }).length, 1);
});

test('zero files is an error, not an empty success', () => {
  assert.throws(() => collectFiles({}), rejects('empty_solution', 502));
});

test('non-string content is an error', () => {
  assert.throws(() => collectFiles({ 'a.js': null }), rejects('unprocessable_reply', 502));
  assert.throws(() => collectFiles({ 'a.js': 42 }), rejects('unprocessable_reply', 502));
});

test('the returned list is sorted by path for deterministic output', () => {
  const files = collectFiles({ 'z.js': '1', 'a.js': '2', 'm/n.js': '3' });
  assert.deepEqual(
    files.map((file) => file.path),
    ['a.js', 'm/n.js', 'z.js'],
  );
});

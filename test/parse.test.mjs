import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseReply } from '../src/parse.mjs';
import { NeoError } from '../src/errors.mjs';

const FILES = {
  'App.jsx': 'export default function App() { return null; }',
  'styles/style.css': '.app { color: red; }',
};
const ENVELOPE = JSON.stringify({ files: FILES, notes: 'a note' });

const plain = (files) => Object.fromEntries(Object.entries(files));

test('strategy 1 — fenced blocks annotated with a filename', () => {
  const reply = [
    'Here you go:',
    '',
    '```jsx App.jsx',
    'export default function App() {}',
    '```',
    '',
    '```css styles/style.css',
    '.app { color: red; }',
    '```',
  ].join('\n');

  const result = parseReply(reply);
  assert.equal(result.strategy, 1);
  assert.deepEqual(plain(result.files), {
    'App.jsx': 'export default function App() {}\n',
    'styles/style.css': '.app { color: red; }\n',
  });
});

test('strategy 1 — the fenced-block format carries MULTIPLE files', () => {
  const reply = [
    '```App.jsx',
    'export default function App() {}',
    '```',
    '',
    '```css App.css',
    '.app {\n  color: red;\n}',
    '```',
    '',
    '```html index.html',
    '<div id="root"></div>',
    '```',
  ].join('\n');

  const result = parseReply(reply);
  assert.equal(result.strategy, 1);
  assert.deepEqual(plain(result.files), {
    'App.jsx': 'export default function App() {}\n',
    'App.css': '.app {\n  color: red;\n}\n',
    'index.html': '<div id="root"></div>\n',
  });
});

test('strategy 1 — file=/path= prefixes and paths containing spaces still parse', () => {
  const result = parseReply(
    '```jsx file=src/components/Ünïcode Panel.jsx\nexport default function P() {}\n```',
  );
  assert.equal(result.strategy, 1);
  assert.deepEqual(plain(result.files), {
    'src/components/Ünïcode Panel.jsx': 'export default function P() {}\n',
  });
});

test('strategy 2 — bare JSON', () => {
  const result = parseReply(ENVELOPE);
  assert.equal(result.strategy, 2);
  assert.deepEqual(plain(result.files), FILES);
  assert.equal(result.notes, 'a note');
});

test('strategy 2 — a literal newline inside a JSON string is repaired', () => {
  const raw = '{\n  "files": {\n    "App.jsx": "line one\nline two"\n  }\n}';
  const result = parseReply(raw);
  assert.equal(result.strategy, 2);
  assert.deepEqual(plain(result.files), { 'App.jsx': 'line one\nline two' });
});

test('strategy 2 — a literal tab inside a JSON string is repaired', () => {
  const raw = '{"files": {"App.jsx": "a\tb"}}';
  const result = parseReply(raw);
  assert.equal(result.strategy, 2);
  assert.deepEqual(plain(result.files), { 'App.jsx': 'a\tb' });
});

test('the JSON repair pass leaves already-escaped strings untouched', () => {
  const value = 'a\tb\nc\\d';
  const result = parseReply(JSON.stringify({ files: { 'App.jsx': value } }));
  assert.deepEqual(plain(result.files), { 'App.jsx': value });
});

test('strategy 3 — JSON inside ```json fences', () => {
  const result = parseReply(`\`\`\`json\n${ENVELOPE}\n\`\`\``);
  assert.equal(result.strategy, 3);
  assert.deepEqual(plain(result.files), FILES);
});

test('strategy 3 — JSON inside a fence wrapped in prose', () => {
  const result = parseReply(`Certainly!\n\`\`\`json\n${ENVELOPE}\n\`\`\`\nHope that helps.`);
  assert.equal(result.strategy, 3);
  assert.deepEqual(plain(result.files), FILES);
});

test('strategy 4 — JSON inside prose', () => {
  const result = parseReply(`Sure — here is the solution.\n\n${ENVELOPE}\n\nLet me know.`);
  assert.equal(result.strategy, 4);
  assert.deepEqual(plain(result.files), FILES);
});

test('strategy 5 — a single unlabelled block with exactly one target', () => {
  const result = parseReply('```\nconsole.log(1)\n```', { targets: ['script.js'] });
  assert.equal(result.strategy, 5);
  assert.deepEqual(plain(result.files), { 'script.js': 'console.log(1)\n' });
});

test('strategy 5 requires exactly one target', () => {
  assert.equal(parseReply('```\nconsole.log(1)\n```', { targets: [] }), null);
  assert.equal(parseReply('```\nconsole.log(1)\n```', { targets: ['a.js', 'b.js'] }), null);
});

test('a path-keyed map without the files envelope is still accepted', () => {
  const result = parseReply(JSON.stringify({ 'App.jsx': 'x', 'script.js': 'y' }));
  assert.deepEqual(plain(result.files), { 'App.jsx': 'x', 'script.js': 'y' });
});

test('the array form is accepted', () => {
  const result = parseReply(JSON.stringify({ files: [{ path: 'App.jsx', content: 'x' }] }));
  assert.deepEqual(plain(result.files), { 'App.jsx': 'x' });
});

test('total garbage yields null, so the caller renders nothing', () => {
  assert.equal(parseReply('I am sorry, I cannot help with that. ###'), null);
  assert.equal(parseReply(''), null);
  assert.equal(parseReply('   '), null);
});

test('a JSON envelope with an empty files map is not a success', () => {
  assert.equal(parseReply('{"files":{}}'), null);
});

test('duplicate paths in the array form are rejected, never last-wins', () => {
  const reply = JSON.stringify({
    files: [
      { path: 'App.jsx', content: 'first' },
      { path: 'App.jsx', content: 'second' },
    ],
  });
  assert.throws(
    () => parseReply(reply),
    (error) =>
      error instanceof NeoError && error.code === 'duplicate_path' && error.status === 502,
  );
});

test('a duplicate is reported instead of falling through to a laxer strategy', () => {
  // The fence-wrapped duplicate must still be a hard failure, not a re-parse.
  const reply = `\`\`\`json\n${JSON.stringify({
    files: [
      { path: 'a.js', content: '1' },
      { path: 'a.js', content: '2' },
    ],
  })}\n\`\`\``;
  assert.throws(() => parseReply(reply), (error) => error.code === 'duplicate_path');
});

test('non-string content is left for the path validator to reject', () => {
  const result = parseReply(JSON.stringify({ files: { 'App.jsx': 'ok', 'other.js': 42 } }));
  assert.deepEqual(plain(result.files), { 'App.jsx': 'ok' });
});

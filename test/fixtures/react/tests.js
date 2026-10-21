// The challenge test file. It is POSTed verbatim to NeoSolver; it is never
// copied into the challenge environment — it already lives there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

test('App.jsx default-exports a NeoSolver component', () => {
  const source = read('App.jsx');
  assert.match(source, /export default/);
  assert.match(source, /NeoSolver/);
});

test('styles/style.css defines the accent custom property', () => {
  assert.match(read('styles/style.css'), /--neo-accent/);
});

test('index.html mounts script.js as a module from #root', () => {
  const html = read('index.html');
  assert.match(html, /<div id="root">/);
  assert.match(html, /<script[^>]+type="module"[^>]+src="script\.js"/);
});

test('script.js renders into #root', () => {
  assert.match(read('script.js'), /getElementById\('root'\)/);
});

test('the deeply nested component was written', () => {
  const deep =
    'src/deeply/nested/directory/structure/that/definitely/exceeds/one/hundred/characters/so/that/ustar/prefix/splitting/is/exercised/Component.jsx';
  assert.ok(existsSync(path.join(root, deep)), `${deep} is missing`);
});

test('unicode and spaces in paths survive', () => {
  assert.match(read('src/components/Ünïcode Panel.jsx'), /Ünïcode/);
});

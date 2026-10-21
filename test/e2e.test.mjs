/**
 * End-to-end: the real `bin/neosolver.mjs` service, the real mock-provider CLI,
 * and the real `curl`, `sh`, `tar` and `npm` binaries — exactly the pipeline the
 * sandbox runs.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  compareTree,
  FIXTURES,
  hasCommand,
  listFiles,
  makeTempDir,
  removeDir,
  run,
  startRealStack,
} from './helpers/processes.mjs';

const CURL = hasCommand('curl');
const TAR = hasCommand('tar');
const NPM = hasCommand('npm');

const REACT_DIR = path.join(FIXTURES, 'react');
const EXPECTED_DIR = path.join(REACT_DIR, 'expected');
const FAILING_DIR = path.join(FIXTURES, 'failing');
const TESTS_JS = path.join(REACT_DIR, 'tests.js');

/** The challenge workspace files that already exist before the model runs. */
const WORKSPACE_FILES = ['package.json', 'tests.js'];
const IGNORE = WORKSPACE_FILES;

const quote = (value) => `'${String(value).split("'").join("'\\''")}'`;

/** A test file with hostile bytes, used to prove byte-identity end to end. */
const HOSTILE_TEST_FILE =
  "// SCENARIO:echo\n" +
  "test('quotes', () => { expect(\"a\\nb\").toBe('c'); });\n" +
  'carriage return follows\r\n' +
  'unicode: Ünïcode — “curly”, 日本語\n' +
  'EOF\n' +
  '<<EOF\n' +
  'last line has no trailing newline';

let stack;
let hostileFile;
let tmpRoot;

before(async () => {
  if (!CURL) return;
  stack = await startRealStack({ token: 'neo' });
  tmpRoot = makeTempDir('neosolver-e2e-');
  hostileFile = path.join(tmpRoot, 'hostile-tests.js');
  writeFileSync(hostileFile, HOSTILE_TEST_FILE);
});

after(async () => {
  if (stack) await stack.close();
  if (tmpRoot) removeDir(tmpRoot);
});

/** Create a temp challenge workspace pre-populated like the real one. */
function makeWorkspace(name, source = REACT_DIR) {
  const dir = path.join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const file of WORKSPACE_FILES) copyFileSync(path.join(source, file), path.join(dir, file));
  return dir;
}

const e2e = (name, fn) => test(name, { skip: !CURL }, fn);

// ---------------------------------------------------------------------------
// The documented one-liners
// ---------------------------------------------------------------------------

e2e('curl -T | sh writes the tree byte-for-byte and reports PASS', () => {
  const dir = makeWorkspace('one-liner-put');
  const result = run(`curl -s ${stack.baseUrl}/s/neo -T ${quote(TESTS_JS)} | sh`, { cwd: dir });

  assert.equal(result.status, 0, `sh exited ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /=== NeoSolver: wrote \d+ file\(s\) ===/);
  assert.match(result.stdout, /=== NeoSolver: test result: PASS \(exit 0\) ===/);
  assert.match(result.stdout, /=== NeoSolver: final code ===/);
  assert.match(result.stdout, /=== NeoSolver: done ===/);

  const comparison = compareTree(dir, EXPECTED_DIR, { ignore: IGNORE });
  assert.deepEqual(comparison.missing, [], 'missing files');
  assert.deepEqual(comparison.differing, [], 'files that differ byte-for-byte');
  assert.deepEqual(comparison.extra, [], 'unexpected extra files');
  assert.equal(comparison.checked, 7);
});

e2e('curl --data-binary | sh writes the same tree', () => {
  const dir = makeWorkspace('one-liner-post');
  const result = run(
    `curl -s ${stack.baseUrl}/s/neo --data-binary @${quote(TESTS_JS)} | sh`,
    { cwd: dir },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /test result: PASS \(exit 0\)/);
  assert.deepEqual(compareTree(dir, EXPECTED_DIR, { ignore: IGNORE }).differing, []);
});

e2e('POST /solve with an X-Token header is equivalent', () => {
  const dir = makeWorkspace('solve-header');
  const result = run(
    `curl -s -X POST ${stack.baseUrl}/solve -H 'X-Token: neo' --data-binary @${quote(TESTS_JS)} | sh`,
    { cwd: dir },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(compareTree(dir, EXPECTED_DIR, { ignore: IGNORE }).differing, []);
});

// ---------------------------------------------------------------------------
// npm test in the extracted fixture
// ---------------------------------------------------------------------------

test('npm test passes inside the extracted React fixture', { skip: !CURL || !NPM }, () => {
  const dir = makeWorkspace('npm-test');
  const extracted = run(`curl -s ${stack.baseUrl}/s/neo -T ${quote(TESTS_JS)} | sh`, { cwd: dir });
  assert.equal(extracted.status, 0, extracted.stderr);

  const tested = run('npm test', { cwd: dir });
  assert.equal(tested.status, 0, `npm test failed\n${tested.stdout}\n${tested.stderr}`);
  assert.match(tested.stdout, /pass 6/);
  assert.match(tested.stdout, /fail 0/);
});

test('the tests included in the generated script output report PASS', { skip: !CURL || !NPM }, () => {
  const dir = makeWorkspace('npm-via-script');
  const result = run(`curl -s ${stack.baseUrl}/s/neo -T ${quote(TESTS_JS)} | sh`, { cwd: dir });
  // The script itself ran `npm test`; its output is part of the response.
  assert.match(result.stdout, /pass 6/);
  assert.match(result.stdout, /test result: PASS/);
});

// ---------------------------------------------------------------------------
// A failing suite must still exit 0
// ---------------------------------------------------------------------------

test('a deliberately failing fixture is reported as FAIL and the script still exits 0', { skip: !CURL || !NPM }, () => {
  const dir = makeWorkspace('failing-suite', FAILING_DIR);
  const result = run(`curl -s ${stack.baseUrl}/s/neo -T ${quote(TESTS_JS)} | sh`, { cwd: dir });

  assert.equal(result.status, 0, 'a failing test run must not make the script exit non-zero');
  assert.match(result.stdout, /=== NeoSolver: test result: FAIL \(exit [1-9]\d*\) ===/);
  assert.match(result.stdout, /=== NeoSolver: final code ===/);
  assert.match(result.stdout, /=== NeoSolver: done ===/);
  // Nothing was allowed to abort early.
  assert.deepEqual(compareTree(dir, EXPECTED_DIR, { ignore: IGNORE }).differing, []);
});

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

test('?format=tar extracts with the system tar into the same tree', { skip: !CURL || !TAR }, () => {
  const dir = path.join(tmpRoot, 'tar-extract');
  mkdirSync(dir, { recursive: true });

  const listed = run(
    `curl -s -X POST '${stack.baseUrl}/solve?format=tar' -H 'X-Token: neo' --data-binary @${quote(TESTS_JS)} | tar -tzf -`,
    { cwd: dir },
  );
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.trim().split('\n').length, 7);

  // `tar -C out` requires the directory to exist.
  mkdirSync(path.join(dir, 'out'), { recursive: true });

  const extracted = run(
    `curl -s -X POST '${stack.baseUrl}/solve?format=tar' -H 'X-Token: neo' --data-binary @${quote(TESTS_JS)} | tar -xzf - -C out`,
    { cwd: dir },
  );
  assert.equal(extracted.status, 0, extracted.stderr);

  const comparison = compareTree(path.join(dir, 'out'), EXPECTED_DIR, { ignore: IGNORE });
  assert.deepEqual(comparison.missing, []);
  assert.deepEqual(comparison.differing, []);
  assert.deepEqual(comparison.extra, []);
});

// ---------------------------------------------------------------------------
// Byte identity of the request body (the `curl -d` regression guard)
// ---------------------------------------------------------------------------

for (const [name, curlArgs] of [
  ['-T (PUT)', (file) => `-T ${quote(file)}`],
  ['--data-binary (POST)', (file) => `--data-binary @${quote(file)}`],
]) {
  test(`the request body arrives byte-identical with curl ${name}`, { skip: !CURL }, () => {
    const response = run(
      `curl -s ${stack.baseUrl}/s/neo?format=json ${curlArgs(hostileFile)}`,
      { cwd: tmpRoot },
    );
    assert.equal(response.status, 0, response.stderr);

    const files = JSON.parse(response.stdout).files;
    const echoed = Buffer.from(files['tests.js'], 'utf8');
    const original = readFileSync(hostileFile);
    assert.ok(
      echoed.equals(original),
      `body was altered.\n sent: ${JSON.stringify(original.toString())}\n recv: ${JSON.stringify(echoed.toString())}`,
    );
  });
}

test('curl -d really does corrupt the body, which is why it is forbidden', { skip: !CURL }, () => {
  // The scenario marker goes LAST on purpose: `-d` strips newlines, and if the
  // marker were followed by more text the stripping would merge it into a
  // different name ("SCENARIO:echo" + "test(1)" reads as "echotest"), which
  // selects another mock scenario instead of the echo used to observe the body.
  const file = path.join(tmpRoot, 'd-corrupt.js');
  writeFileSync(file, "test('a');\nsecond line\nthird line\n// SCENARIO:echo");

  const response = run(
    `curl -s -X POST '${stack.baseUrl}/s/neo?format=json' -d @${quote(file)}`,
    { cwd: tmpRoot },
  );
  assert.equal(response.status, 0, response.stderr);

  const echoed = Buffer.from(JSON.parse(response.stdout).files['tests.js'], 'utf8');
  const original = readFileSync(file);
  assert.ok(
    !echoed.equals(original),
    'expected -d to strip newlines; if this ever changes the README warning can be revisited',
  );
  assert.ok(!echoed.includes(Buffer.from('\n')), 'the newline-stripping is the documented hazard');
});

// ---------------------------------------------------------------------------
// Anon mode: the shortest possible client
// ---------------------------------------------------------------------------

test('anon mode: the tokenless one-liner works end to end', { skip: !CURL }, async () => {
  const anon = await startRealStack({ allowAnon: true });
  try {
    const dir = makeWorkspace('anon-tokenless');
    // `curl -T tests.js <base>` becomes `PUT /tests.js`, because curl appends the
    // local file name to a URL with no file part.
    const result = run(`curl -s ${anon.baseUrl} -T ${quote(TESTS_JS)} | sh`, { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /test result: PASS/);
    assert.deepEqual(compareTree(dir, EXPECTED_DIR, { ignore: IGNORE }).differing, []);
  } finally {
    await anon.close();
  }
});

test('anon mode: PUT /solve and PUT / both work', { skip: !CURL }, async () => {
  const anon = await startRealStack({ allowAnon: true });
  try {
    for (const url of [`${anon.baseUrl}/solve`, `${anon.baseUrl}/`]) {
      const dir = makeWorkspace(`anon-${url.endsWith('/solve') ? 'solve' : 'root'}`);
      const result = run(`curl -s ${url} -T ${quote(TESTS_JS)} | sh`, { cwd: dir });
      assert.equal(result.status, 0, `${url}: ${result.stderr}`);
      assert.match(result.stdout, /test result: PASS/);
    }
  } finally {
    await anon.close();
  }
});

test('non-anon mode rejects the tokenless one-liner with 401', { skip: !CURL }, () => {
  const dir = path.join(tmpRoot, 'no-token');
  mkdirSync(dir, { recursive: true });
  const result = run(`curl -s -o body.txt -w '%{http_code}' '${stack.baseUrl}/solve?format=json' -T ${quote(TESTS_JS)}`, {
    cwd: dir,
  });
  assert.equal(result.stdout.trim(), '401');
  const body = readFileSync(path.join(dir, 'body.txt'), 'utf8');
  assert.equal(JSON.parse(body).error.code, 'unauthorized');
  assert.ok(!body.includes('test-provider-key-xyz'));
});

// ---------------------------------------------------------------------------
// Auth and limits over the real socket
// ---------------------------------------------------------------------------

test('a wrong token is 401 over the real socket', { skip: !CURL }, () => {
  const result = run(
    `curl -s -o /dev/null -w '%{http_code}' -X POST ${stack.baseUrl}/solve -H 'X-Token: wrong' --data-binary @${quote(TESTS_JS)}`,
    { cwd: tmpRoot },
  );
  assert.equal(result.stdout.trim(), '401');
});

test('an oversized body is 413 over the real socket', { skip: !CURL }, async () => {
  const small = await startRealStack({ token: 'neo', env: { NEOSOLVER_MAX_BODY: '2048' } });
  try {
    const big = path.join(tmpRoot, 'big-tests.js');
    writeFileSync(big, `// ${'x'.repeat(8000)}\n`);
    const result = run(
      `curl -s -o body2.txt -w '%{http_code}' -X POST ${small.baseUrl}/solve -H 'X-Token: neo' --data-binary @${quote(big)}`,
      { cwd: tmpRoot },
    );
    assert.equal(result.stdout.trim(), '413');
    assert.match(readFileSync(path.join(tmpRoot, 'body2.txt'), 'utf8'), /NEOSOLVER_MAX_BODY/);
  } finally {
    await small.close();
  }
});

test('healthz and usage are reachable without a token', { skip: !CURL }, () => {
  const health = run(`curl -s ${stack.baseUrl}/healthz`, { cwd: tmpRoot });
  assert.equal(health.stdout.trim(), '{"ok":true}');

  const usage = run(`curl -s ${stack.baseUrl}/`, { cwd: tmpRoot });
  assert.match(usage.stdout, /-T tests\.js \| sh/);
});

test('the usage text echoes the Host the client used', { skip: !CURL }, () => {
  const result = run(
    `curl -s -H 'Host: solver.example.com' -H 'X-Forwarded-Proto: https' ${stack.baseUrl}/`,
    { cwd: tmpRoot },
  );
  assert.match(result.stdout, /curl -s https:\/\/solver\.example\.com\/s\/neo -T tests\.js \| sh/);
});

// ---------------------------------------------------------------------------
// ?test negotiation over the real socket
// ---------------------------------------------------------------------------

test('?test=none skips the suite in the shipped script', { skip: !CURL }, () => {
  const dir = makeWorkspace('test-none');
  const result = run(`curl -s '${stack.baseUrl}/s/neo?test=none' -T ${quote(TESTS_JS)} | sh`, { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tests skipped/);
  assert.ok(!result.stdout.includes('pass 6'), 'the suite must not have run');
  assert.deepEqual(compareTree(dir, EXPECTED_DIR, { ignore: IGNORE }).differing, []);
});

test('?test=<cmd> overrides the suite', { skip: !CURL }, () => {
  const dir = makeWorkspace('test-custom');
  const result = run(
    `curl -s '${stack.baseUrl}/s/neo?test=${encodeURIComponent('echo CUSTOM_TEST_RAN')}' -T ${quote(TESTS_JS)} | sh`,
    { cwd: dir },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CUSTOM_TEST_RAN/);
  assert.match(result.stdout, /test result: PASS/);
});

test('?test=exit%203 reports FAIL with exit 3 and still exits 0', { skip: !CURL }, () => {
  const dir = makeWorkspace('test-failing-cmd');
  const result = run(
    `curl -s '${stack.baseUrl}/s/neo?test=${encodeURIComponent('exit 3')}' -T ${quote(TESTS_JS)} | sh`,
    { cwd: dir },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /test result: FAIL \(exit 3\)/);
  assert.match(result.stdout, /=== NeoSolver: final code ===/);
});

// ---------------------------------------------------------------------------
// Unsafe replies render nothing over the real socket
// ---------------------------------------------------------------------------

for (const [name, scenarioName] of [
  ['traversal', 'traversal'],
  ['absolute', 'absolute'],
  ['leading dash', 'dash'],
  ['mid traversal', 'dotdot'],
  ['duplicate', 'duplicate'],
]) {
  test(`an unsafe ${name} reply renders nothing (no files written)`, { skip: !CURL }, () => {
    const dir = path.join(tmpRoot, `unsafe-${scenarioName}`);
    mkdirSync(dir, { recursive: true });
    const body = path.join(dir, 'tests.js');
    writeFileSync(body, `SCENARIO:${scenarioName}\n// challenge test\n`);

    const result = run(`curl -s ${stack.baseUrl}/s/neo -T ${quote(body)} | sh`, { cwd: dir });
    // The failure is rendered as a shell script (the default format), so `sh`
    // prints the readable message to STDERR, not to stdout.
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.ok(
      combined.includes('unsafe_path') || combined.includes('duplicate_path'),
      `expected an error payload, got: ${combined.slice(0, 300)}`,
    );
    assert.deepEqual(
      listFiles(dir).filter((file) => file !== 'tests.js'),
      [],
      'no output file may be created',
    );
  });
}

test('a garbage reply is 502 over the real socket', { skip: !CURL }, () => {
  const body = path.join(tmpRoot, 'garbage-tests.js');
  writeFileSync(body, 'SCENARIO:garbage\nno json here at all\n');
  // ?format=json keeps the exact status; the streamed `sh` format commits 200.
  const result = run(
    `curl -s -o /dev/null -w '%{http_code}' '${stack.baseUrl}/s/neo?format=json' -T ${quote(body)}`,
    { cwd: tmpRoot },
  );
  assert.equal(result.stdout.trim(), '502');
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

test('SIGTERM shuts the service down cleanly', async () => {
  const extra = await startRealStack({ token: 'neo' });
  try {
    const alive = await fetch(`${extra.baseUrl}/healthz`).then((response) => response.status);
    assert.equal(alive, 200);

    const exited = new Promise((resolve) => extra.service.once('exit', resolve));
    extra.service.kill('SIGTERM');
    const code = await exited;
    assert.equal(code, 0, 'a clean SIGTERM should exit 0');

    await assert.rejects(() => fetch(`${extra.baseUrl}/healthz`));
  } finally {
    await extra.close();
  }
});

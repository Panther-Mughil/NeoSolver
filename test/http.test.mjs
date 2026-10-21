import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startStack, request, scenario, TEST_FILE } from './helpers/service.mjs';
import { checkToken } from '../src/server.mjs';
import { renderErrorShell } from '../src/render.mjs';

const KEY = 'test-provider-key';

/** Minimal test-file body, so the prompt contains no incidental "- " lines. */
const SCENARIO_BODY = 'SCENARIO:default\n';

/** Raw request, so tests can control the Host header undici would not let us set. */
function rawRequest(baseUrl, { path = '/', method = 'GET', headers = {}, body = null } = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function withStack(options, fn) {
  const stack = await startStack(options);
  try {
    return await fn(stack);
  } finally {
    await stack.close();
  }
}

// ---------------------------------------------------------------------------
// Unauthenticated surface
// ---------------------------------------------------------------------------

test('GET /healthz is 200 {"ok":true} without a token', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/healthz', method: 'GET', token: null });
    assert.equal(result.status, 200);
    assert.match(result.contentType, /application\/json/);
    assert.deepEqual(JSON.parse(result.text), { ok: true });
  });
});

test('GET / serves plain-text usage without a token', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/', method: 'GET', token: null });
    assert.equal(result.status, 200);
    assert.match(result.contentType, /text\/plain/);
    assert.match(result.text, /NeoSolver/);
  });
});

test('GET / derives the domain from the Host and X-Forwarded-Proto headers', async () => {
  await withStack({}, async (stack) => {
    const result = await rawRequest(stack.baseUrl, {
      path: '/',
      headers: { Host: 'solver.example.com', 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(result.status, 200);
    assert.match(result.text, /curl -s https:\/\/solver\.example\.com\/s\/neo -T tests\.js \| sh/);
    assert.match(result.text, /curl -s https:\/\/solver\.example\.com -T tests\.js \| sh/);
  });
});

test('GET / falls back to the bind address when the Host header is unusable', async () => {
  await withStack({}, async (stack) => {
    const result = await rawRequest(stack.baseUrl, { path: '/', headers: { Host: 'not a host!!' } });
    assert.equal(result.status, 200);
    assert.match(result.text, /curl -s http:\/\/127\.0\.0\.1:\d+\/s\/neo -T tests\.js \| sh/);
  });
});

test('GET / on a forwarded host without X-Forwarded-Proto uses http', async () => {
  await withStack({}, async (stack) => {
    const result = await rawRequest(stack.baseUrl, { path: '/', headers: { Host: 'example.test' } });
    assert.match(result.text, /curl -s http:\/\/example\.test\/s\/neo -T tests\.js \| sh/);
  });
});

test('an unknown path is a 404 and an unsupported method is a 405', async () => {
  await withStack({}, async (stack) => {
    const notFound = await request(stack.baseUrl, { path: '/nonsense', method: 'POST' });
    assert.equal(notFound.status, 404);

    const method = await request(stack.baseUrl, { path: '/solve', method: 'GET', token: null });
    assert.equal(method.status, 405);

    const health = await request(stack.baseUrl, { path: '/healthz', method: 'POST', token: null });
    assert.equal(health.status, 405);
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test('POST /solve without a token is 401 and never mentions the provider key', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'json' },
      token: null,
      body: TEST_FILE,
    });
    assert.equal(result.status, 401);
    assert.equal(JSON.parse(result.text).error.code, 'unauthorized');
    assert.ok(!result.text.includes(KEY));
  });
});

test('POST /solve with a wrong token is 401', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', token: 'nope', body: TEST_FILE });
    assert.equal(result.status, 401);
    assert.ok(!result.text.includes(KEY));
  });
});

test('a near-miss token of a different length is still 401 (no throw)', async () => {
  await withStack({}, async (stack) => {
    // (A trailing space cannot be tested over HTTP: header values are trimmed by
    // the client stack. Non-Latin-1 tokens are covered by the unit test below.)
    for (const token of ['ne', 'neoo', 'nope', 'NEO', 'neö']) {
      const result = await request(stack.baseUrl, { path: '/solve', token, body: TEST_FILE });
      assert.equal(result.status, 401, `token ${JSON.stringify(token)} should fail`);
    }
  });
});

test('checkToken never throws for odd input and is exact about lengths', () => {
  assert.equal(checkToken('neo', 'neo'), true);
  assert.equal(checkToken(null, 'neo'), false);
  assert.equal(checkToken(undefined, 'neo'), false);
  assert.equal(checkToken('', 'neo'), false);
  assert.equal(checkToken('ne', 'neo'), false);
  assert.equal(checkToken('neoo', 'neo'), false);
  assert.equal(checkToken('𝔫𝔢𝔬', 'neo'), false);
  assert.equal(checkToken('néo', 'neo'), false);
  assert.equal(checkToken('a b', 'a b'), true);
  // Anon mode accepts anything, including nothing at all.
  assert.equal(checkToken(null, null), true);
  assert.equal(checkToken('anything', null), true);
});

test('Authorization: Bearer is accepted as well as X-Token', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      token: null,
      headers: { Authorization: 'Bearer neo' },
      body: TEST_FILE,
    });
    assert.equal(result.status, 200);
  });
});

// ---------------------------------------------------------------------------
// /s/<token> route: equivalence and tolerance
// ---------------------------------------------------------------------------

test('POST /s/<token> and PUT /s/<token> are equivalent to /solve with a header', async () => {
  await withStack({}, async (stack) => {
    for (const method of ['POST', 'PUT']) {
      const viaPath = await request(stack.baseUrl, { path: '/s/neo', method, token: null, body: TEST_FILE });
      assert.equal(viaPath.status, 200, `${method} /s/neo`);

      const viaHeader = await request(stack.baseUrl, { path: '/solve', method, token: 'neo', body: TEST_FILE });
      assert.equal(viaHeader.status, 200, `${method} /solve`);
      assert.equal(viaPath.text, viaHeader.text, 'both forms must produce identical output');
    }
  });
});

test('a 3-character token works end to end', async () => {
  await withStack({ token: 'abc' }, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/s/abc', token: null, body: TEST_FILE });
    assert.equal(result.status, 200);
    assert.equal(result.contentType, 'text/x-shellscript');
  });
});

test('a bad path token is 401', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/s/wrong', token: null, body: TEST_FILE });
    assert.equal(result.status, 401);
  });
});

test('a trailing slash after the token is tolerated', async () => {
  await withStack({}, async (stack) => {
    // `curl -T tests.js .../s/neo/` becomes `PUT /s/neo/tests.js`.
    for (const path of ['/s/neo/', '/s/neo/tests.js', '/s/neo/anything/else']) {
      const result = await request(stack.baseUrl, { path, method: 'PUT', token: null, body: TEST_FILE });
      assert.equal(result.status, 200, path);
    }
  });
});

test('a percent-encoded token is decoded before comparison', async () => {
  await withStack({ token: 'a b' }, async (stack) => {
    const encoded = await request(stack.baseUrl, { path: '/s/a%20b', token: null, body: TEST_FILE });
    assert.equal(encoded.status, 200);

    const wrong = await request(stack.baseUrl, { path: '/s/a%20c', token: null, body: TEST_FILE });
    assert.equal(wrong.status, 401);

    // A token containing URL-unsafe characters is also reachable via encoding.
    const hash = await withStack({ token: 'x#y' }, async (inner) =>
      request(inner.baseUrl, { path: '/s/x%23y', token: null, body: TEST_FILE }),
    );
    assert.equal(hash.status, 200);
  });
});

test('malformed percent-encoding in the path is a 400', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/s/%E0%A4%A', token: null, body: TEST_FILE });
    assert.equal(result.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Anon mode
// ---------------------------------------------------------------------------

test('anon mode: PUT / works with no token at all', async () => {
  await withStack({ allowAnon: true }, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/', method: 'PUT', token: null, body: TEST_FILE });
    assert.equal(result.status, 200);
    assert.equal(result.contentType, 'text/x-shellscript');
  });
});

test('anon mode: POST / works with no token at all', async () => {
  await withStack({ allowAnon: true }, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/', method: 'POST', token: null, body: TEST_FILE });
    assert.equal(result.status, 200);
  });
});

test('anon mode: the curl-appended path (PUT /tests.js) is accepted', async () => {
  await withStack({ allowAnon: true }, async (stack) => {
    // `curl -s <base> -T tests.js` sends `PUT /tests.js` because the URL has no
    // file part and curl appends the local file name.
    const result = await request(stack.baseUrl, { path: '/tests.js', method: 'PUT', token: null, body: TEST_FILE });
    assert.equal(result.status, 200);
  });
});

test('anon mode: PUT /solve still works', async () => {
  await withStack({ allowAnon: true }, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', method: 'PUT', token: null, body: TEST_FILE });
    assert.equal(result.status, 200);
  });
});

test('anon mode logs a loud warning and advertises the tokenless one-liner', async () => {
  await withStack({ allowAnon: true }, async (stack) => {
    await request(stack.baseUrl, { path: '/solve', token: null, body: TEST_FILE });
    const warnings = stack.logger.records.filter((record) => record.level === 'warn');
    assert.ok(
      warnings.some((record) => /AUTHENTICATION IS DISABLED|anonymous request/i.test(record.message)),
      'expected an anon-mode warning per request',
    );
    const usage = await request(stack.baseUrl, { path: '/', method: 'GET', token: null });
    assert.match(usage.text, /no token is required/);
  });
});

test('non-anon mode still 401s a tokenless request to a stray path', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/tests.js', method: 'PUT', token: null, body: TEST_FILE });
    assert.equal(result.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Body limits and shape
// ---------------------------------------------------------------------------

test('a body larger than NEOSOLVER_MAX_BODY is 413', async () => {
  await withStack({ env: { NEOSOLVER_MAX_BODY: '1024' } }, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'json' },
      body: 'x'.repeat(4096),
    });
    assert.equal(result.status, 413);
    assert.equal(JSON.parse(result.text).error.code, 'payload_too_large');
    assert.match(result.text, /NEOSOLVER_MAX_BODY/);
  });
});

test('a body exactly at the limit is accepted', async () => {
  await withStack({ env: { NEOSOLVER_MAX_BODY: '4096' } }, async (stack) => {
    const prefix = 'SCENARIO:default\n';
    const body = prefix + 'x'.repeat(4096 - Buffer.byteLength(prefix));
    assert.equal(Buffer.byteLength(body), 4096);
    const result = await request(stack.baseUrl, { path: '/solve', body });
    assert.equal(result.status, 200);
  });
});

test('an empty body is 400 and never reaches the provider', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', body: '' });
    assert.equal(result.status, 400);
    assert.match(result.text, /no test file supplied/);
    assert.equal(stack.provider.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Format negotiation
// ---------------------------------------------------------------------------

test('the default representation is text/x-shellscript', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', body: TEST_FILE });
    assert.equal(result.status, 200);
    assert.equal(result.contentType, 'text/x-shellscript');
    assert.match(result.text, /^#!\/bin\/sh/);
  });
});

test('?format=json returns files, notes, model and usage', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', query: { format: 'json' }, body: TEST_FILE });
    assert.equal(result.contentType, 'application/json');
    const body = JSON.parse(result.text);
    assert.ok(Object.keys(body.files).includes('App.jsx'));
    assert.equal(typeof body.notes, 'string');
    assert.equal(body.usage.total_tokens, 300);
    // Pure data: no test execution happened.
    assert.ok(!('testCommand' in body));
  });
});

test('?format=tar returns a gzip archive', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', query: { format: 'tar' }, body: TEST_FILE });
    assert.equal(result.contentType, 'application/gzip');
    assert.equal(result.buffer[0], 0x1f);
    assert.equal(result.buffer[1], 0x8b);
  });
});

test('an unknown format is a 400', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', query: { format: 'zip' }, body: TEST_FILE });
    assert.equal(result.status, 400);
    assert.match(result.text, /unknown format/);
  });
});

// ---------------------------------------------------------------------------
// test command negotiation
// ---------------------------------------------------------------------------

test('the default script runs npm test and prints the test result', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', body: TEST_FILE });
    assert.match(result.text, /sh -c 'npm test'/);
    assert.match(result.text, /test result/);
  });
});

test('?test=<cmd> overrides the test command inside the script', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { test: 'node --test tests.js' },
      body: TEST_FILE,
    });
    assert.match(result.text, /sh -c 'node --test tests\.js'/);
  });
});

test('?test=none skips the tests', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', query: { test: 'none' }, body: TEST_FILE });
    assert.match(result.text, /tests skipped/);
    assert.ok(!result.text.includes('sh -c'));
  });
});

test('the script never executes tests for tar or json output', async () => {
  await withStack({}, async (stack) => {
    const tar = await request(stack.baseUrl, { path: '/solve', query: { format: 'tar' }, body: TEST_FILE });
    assert.ok(!tar.buffer.includes(Buffer.from('npm test')));
    const json = await request(stack.baseUrl, { path: '/solve', query: { format: 'json' }, body: TEST_FILE });
    assert.ok(!json.text.includes('sh -c'));
  });
});

// ---------------------------------------------------------------------------
// Errors that must render NOTHING
// ---------------------------------------------------------------------------

const UNSAFE = [
  ['traversal', 'traversal'],
  ['absolute', 'absolute'],
  ['leading dash', 'dash'],
  ['mid traversal', 'dotdot'],
];

for (const [name, scenarioName] of UNSAFE) {
  test(`a reply containing an unsafe path (${name}) is 502 with nothing rendered`, async () => {
    await withStack({}, async (stack) => {
      const result = await request(stack.baseUrl, {
        path: '/solve',
        query: { format: 'json' },
        body: scenario(scenarioName),
      });
      assert.equal(result.status, 502, result.text);
      assert.equal(JSON.parse(result.text).error.code, 'unsafe_path');
      assert.match(result.text, /Nothing was rendered/);
      assert.ok(!result.text.includes('#!/bin/sh'), 'nothing may be rendered');
      assert.ok(!result.text.includes('base64 -d'), 'nothing may be rendered');
    });
  });
}

test('a duplicate path in a list reply is 502 with nothing rendered', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'json' },
      body: scenario('duplicate'),
    });
    assert.equal(result.status, 502, result.text);
    assert.equal(JSON.parse(result.text).error.code, 'duplicate_path');
    assert.ok(!result.text.includes('#!/bin/sh'));
  });
});

test('an empty files map is 502', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'json' },
      body: scenario('empty'),
    });
    assert.equal(result.status, 502);
    assert.ok(!result.text.includes('#!/bin/sh'));
  });
});

test('a totally unparseable reply is 502 carrying a bounded excerpt', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'json' },
      body: scenario('garbage'),
    });
    assert.equal(result.status, 502);
    const error = JSON.parse(result.text).error;
    assert.equal(error.code, 'unprocessable_reply');
    assert.ok(error.message.length < 800, 'the excerpt must be bounded');
    assert.ok(!result.text.includes('#!/bin/sh'));
  });
});

test('the too-many-files limit is a 502', async () => {
  await withStack({ env: { NEOSOLVER_MAX_FILES: '1' } }, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'json' },
      body: TEST_FILE,
    });
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.text).error.code, 'too_many_files');
  });
});

test('the total-size limit is a 502', async () => {
  await withStack({ env: { NEOSOLVER_MAX_TOTAL_BYTES: '10' } }, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'json' },
      body: TEST_FILE,
    });
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.text).error.code, 'solution_too_large');
  });
});

// ---------------------------------------------------------------------------
// Error responses: shell by default, JSON on request
// ---------------------------------------------------------------------------

test('an error on the default format is a POSIX shell script and keeps the status', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', token: null, body: TEST_FILE });
    assert.equal(result.status, 401, 'the HTTP status must not change');
    assert.match(result.contentType, /text\/x-shellscript/);
    assert.match(result.text, /^#!\/bin\/sh/);
    assert.match(result.text, /NeoSolver: HTTP 401 unauthorized/);
    assert.match(result.text, /Hint:/);
    assert.ok(!result.text.includes(KEY), 'never leaks the provider key');
  });
});

test('a failure after the stream starts still gives a readable script that exits non-zero', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', body: scenario('garbage') });
    // The shell response is streamed, so the status is committed before the model
    // answer is known. The failure still surfaces: the script names the real
    // status and exits non-zero.
    assert.equal(result.status, 200);
    assert.match(result.contentType, /text\/x-shellscript/);
    const dir = mkdtempSync(join(tmpdir(), 'neo-err-'));
    const file = join(dir, 'body.sh');
    writeFileSync(file, result.text, 'utf8');
    const proc = spawnSync('sh', [file], { cwd: dir, encoding: 'utf8' });
    assert.equal(proc.status, 1, 'the error script must exit non-zero');
    assert.match(proc.stderr, /NeoSolver: HTTP 502 unprocessable_reply/);
  });
});

test('the default sh response is streamed rather than length-delimited', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', body: TEST_FILE });
    assert.equal(result.status, 200);
    assert.equal(
      result.response.headers.get('content-length'),
      null,
      'a streamed body must not send a content-length',
    );
    assert.match(result.response.headers.get('transfer-encoding') ?? '', /chunked/);
    assert.ok(result.text.startsWith('#!/bin/sh\n# NeoSolver: solving'), 'the prefix must arrive first');
    assert.match(result.text, /=== NeoSolver: per-file status ===/);
  });
});

test('the stream prefix carries no timing, so the script stays deterministic', async () => {
  await withStack({}, async (stack) => {
    const first = await request(stack.baseUrl, { path: '/solve', body: TEST_FILE });
    const second = await request(stack.baseUrl, { path: '/solve', body: TEST_FILE });
    assert.equal(first.text, second.text);
  });
});

test('?format=json and ?format=tar stay buffered and keep exact statuses', async () => {
  await withStack({}, async (stack) => {
    const json = await request(stack.baseUrl, { path: '/solve', query: { format: 'json' }, body: TEST_FILE });
    assert.equal(json.status, 200);
    assert.notEqual(json.response.headers.get('content-length'), null, 'buffered responses keep a length');

    const failed = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'json' },
      body: scenario('garbage'),
    });
    assert.equal(failed.status, 502, 'a buffered format keeps the real status');
  });
});

test('a slow streamed solve emits keep-alive comments so a proxy cannot drop it', async () => {
  await withStack({ env: { NEOSOLVER_HEARTBEAT_MS: '50' } }, async (stack) => {
    // The `slow` scenario holds the provider for 3s, so a 50ms heartbeat fires.
    const result = await request(stack.baseUrl, { path: '/solve', body: scenario('slow') });
    assert.equal(result.status, 200);
    assert.match(result.text, /# NeoSolver: still solving/);
    assert.match(
      result.text,
      /=== NeoSolver: per-file status ===/,
      'the script must still complete normally around the keep-alives',
    );
  });
});

test('the heartbeat can be disabled', async () => {
  await withStack({ env: { NEOSOLVER_HEARTBEAT_MS: '0' } }, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', body: scenario('slow') });
    assert.equal(result.status, 200);
    assert.ok(!result.text.includes('# NeoSolver: still solving'));
  });
});

test('?format=json keeps the JSON error body and the same status', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'json' },
      token: null,
      body: TEST_FILE,
    });
    assert.equal(result.status, 401);
    assert.match(result.contentType, /application\/json/);
    assert.equal(JSON.parse(result.text).error.code, 'unauthorized');
  });
});

test('?format=tar keeps the JSON error body', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'tar' },
      token: null,
      body: TEST_FILE,
    });
    assert.equal(result.status, 401);
    assert.equal(JSON.parse(result.text).error.code, 'unauthorized');
  });
});

test('a non-solve route still returns a JSON error', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/nonsense', method: 'POST' });
    assert.equal(result.status, 404);
    assert.match(result.contentType, /application\/json/);
    assert.equal(JSON.parse(result.text).error.code, 'not_found');
  });
});

test('an error message can never become executable code', () => {
  const evil = renderErrorShell({
    code: 'unprocessable_reply',
    status: 502,
    message: "x'; touch PWNED; echo '",
  });
  const dir = mkdtempSync(join(tmpdir(), 'neo-inj-'));
  const file = join(dir, 'evil.sh');
  writeFileSync(file, evil, 'utf8');
  const proc = spawnSync('sh', [file], { cwd: dir, encoding: 'utf8' });
  assert.equal(proc.status, 1);
  assert.ok(!existsSync(join(dir, 'PWNED')), 'the message must never be executed');
  assert.match(proc.stderr, /PWNED/, 'the message is still printed literally');
});

// ---------------------------------------------------------------------------
// Tolerant parsing, over real HTTP
// ---------------------------------------------------------------------------

for (const [name, expectedStatus] of [
  ['default', 200],
  ['fenced', 200],
  ['prose', 200],
  ['annotated', 200],
]) {
  test(`tolerant parsing over HTTP: ${name}`, async () => {
    await withStack({}, async (stack) => {
      const result = await request(stack.baseUrl, { path: '/solve', body: scenario(name) });
      assert.equal(result.status, expectedStatus);
      assert.match(result.text, /^#!\/bin\/sh/);
    });
  });
}

test('strategy 5 works over HTTP when exactly one target is hinted', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { target: 'App.jsx' },
      body: scenario('single'),
    });
    assert.equal(result.status, 200);
    assert.match(result.text, /--- App\.jsx ---/);
  });
});

test('repeated ?target= hints are all forwarded to the prompt', async () => {
  await withStack({}, async (stack) => {
    await request(stack.baseUrl, {
      path: '/solve',
      query: { target: ['App.jsx', 'styles/style.css'] },
      body: TEST_FILE,
    });
    const prompt = stack.provider.requests[0].messages.find((message) => message.role === 'user').content;
    assert.match(prompt, /- App\.jsx/);
    assert.match(prompt, /- styles\/style\.css/);
  });
});

test('the X-Targets header is forwarded to the prompt', async () => {
  await withStack({}, async (stack) => {
    await request(stack.baseUrl, {
      path: '/solve',
      headers: { 'X-Targets': 'App.jsx, styles/style.css , MenuItem.jsx' },
      body: SCENARIO_BODY,
    });
    const prompt = stack.provider.requests[0].messages.find((message) => message.role === 'user').content;
    assert.match(prompt, /- App\.jsx/);
    assert.match(prompt, /- styles\/style\.css/);
    assert.match(prompt, /- MenuItem\.jsx/);
  });
});

test('X-Targets and ?target= merge, dedupe and drop empty entries', async () => {
  await withStack({}, async (stack) => {
    await request(stack.baseUrl, {
      path: '/solve',
      query: { target: ['App.jsx', '', 'App.css'] },
      headers: { 'X-Targets': 'App.jsx, ,App.css,TaskList.jsx' },
      body: SCENARIO_BODY,
    });
    const prompt = stack.provider.requests[0].messages.find((message) => message.role === 'user').content;
    const hints = prompt.split('\n').filter((line) => line.startsWith('- '));
    assert.deepEqual(hints, ['- App.jsx', '- App.css', '- TaskList.jsx']);
  });
});

test('target hints from X-Targets are capped so a caller cannot inflate the prompt', async () => {
  await withStack({}, async (stack) => {
    const many = Array.from({ length: 100 }, (_, i) => `file${i}.jsx`).join(',');
    await request(stack.baseUrl, { path: '/solve', headers: { 'X-Targets': many }, body: SCENARIO_BODY });
    const prompt = stack.provider.requests[0].messages.find((message) => message.role === 'user').content;
    const hints = prompt.split('\n').filter((line) => line.startsWith('- '));
    assert.equal(hints.length, 64);
  });
});

test('a request with no target hints still carries no hint list', async () => {
  await withStack({}, async (stack) => {
    await request(stack.baseUrl, { path: '/solve', body: SCENARIO_BODY });
    const prompt = stack.provider.requests[0].messages.find((message) => message.role === 'user').content;
    assert.equal(prompt.split('\n').filter((line) => line.startsWith('- ')).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Model negotiation
// ---------------------------------------------------------------------------

test('?model= outside NEOSOLVER_ALLOWED_MODELS is a 400', async () => {
  await withStack({ env: { NEOSOLVER_ALLOWED_MODELS: 'allowed-a,allowed-b' } }, async (stack) => {
    const denied = await request(stack.baseUrl, {
      path: '/solve',
      query: { model: 'sneaky', format: 'json' },
      body: TEST_FILE,
    });
    assert.equal(denied.status, 400);
    assert.equal(JSON.parse(denied.text).error.code, 'bad_request');
    assert.equal(stack.provider.requests.length, 0, 'the provider must not be called');

    const allowed = await request(stack.baseUrl, { path: '/solve', query: { model: 'allowed-a' }, body: TEST_FILE });
    assert.equal(allowed.status, 200);
    assert.equal(stack.provider.requests[0].model, 'allowed-a');
  });
});

test('with no allowlist any ?model= is forwarded', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', query: { model: 'whatever' }, body: TEST_FILE });
    assert.equal(result.status, 200);
    assert.equal(stack.provider.requests[0].model, 'whatever');
  });
});

// ---------------------------------------------------------------------------
// Provider failures over HTTP
// ---------------------------------------------------------------------------

test('a provider 401 becomes 502 with an actionable message and no key', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'json' },
      body: scenario('provider401'),
    });
    assert.equal(result.status, 502);
    assert.match(result.text, /NEOSOLVER_PROVIDER_KEY/);
    assert.ok(!result.text.includes(KEY));
    // No stack trace: only the documented {code, message} shape is returned.
    const error = JSON.parse(result.text).error;
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message']);
    assert.ok(!/\bat .*\.mjs:\d+/.test(error.message), 'a stack frame leaked');
    assert.ok(!error.message.includes('\n'), 'no multi-line stack');
  });
});

test('a provider 500 becomes 502 after one retry', async () => {
  await withStack({}, async (stack) => {
    // ?format=json keeps the exact status: the default `sh` format is streamed,
    // so its status is committed to 200 before the model answer is known.
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'json' },
      body: scenario('provider500'),
    });
    assert.equal(result.status, 502);
    assert.equal(stack.provider.requests.length, 2);
  });
});

test('a provider timeout becomes 504', async () => {
  await withStack({ env: { NEOSOLVER_TIMEOUT_MS: '300' } }, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'json' },
      body: scenario('slow'),
    });
    assert.equal(result.status, 504);
    assert.equal(JSON.parse(result.text).error.code, 'provider_timeout');
  });
});

test('a provider HTML error page becomes 502', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'json' },
      body: scenario('html'),
    });
    assert.equal(result.status, 502);
    assert.match(result.text, /non-JSON/);
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test('the service survives a client that disconnects mid-request', async () => {
  await withStack({}, async (stack) => {
    const controller = new AbortController();
    const pending = fetch(`${stack.baseUrl}/solve`, {
      method: 'POST',
      headers: { 'X-Token': 'neo', 'content-type': 'text/plain' },
      body: TEST_FILE,
      signal: controller.signal,
    }).catch(() => 'aborted');
    controller.abort();
    await pending;

    const health = await request(stack.baseUrl, { path: '/healthz', method: 'GET', token: null });
    assert.equal(health.status, 200);
  });
});

test('the response is a POSIX sh script that writes the model files and runs the tests', async () => {
  await withStack({}, async (stack) => {
    const result = await request(stack.baseUrl, { path: '/solve', body: TEST_FILE });
    assert.ok(result.text.startsWith('#!/bin/sh\n'));
    // `set -e` was deliberately removed: one unwritable file must not abort the
    // whole run, so every file is attempted and reported individually.
    assert.ok(!/^set -e$/m.test(result.text), 'set -e must not come back');
    assert.match(result.text, /=== NeoSolver: per-file status ===/);
    assert.match(result.text, /base64 -d > 'App\.jsx' <<'NEO_EOF_\d+'/);
    assert.match(result.text, /mkdir -p 'styles'/);
    assert.match(result.text, /=== NeoSolver: final code ===/);
    // The same input renders deterministically.
    const again = await request(stack.baseUrl, { path: '/solve', body: TEST_FILE });
    assert.equal(result.text, again.text);
  });
});

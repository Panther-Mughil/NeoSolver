/**
 * Model-fallback behaviour.
 *
 * A model can fail in two ways: the provider call fails (timeout / 429 / 5xx /
 * network) or the model answers with something that cannot be turned into
 * files. Both deserve exactly one attempt on the fallback model. A credential
 * or permission failure must NOT fall back — that would hide an operator
 * problem by quietly spending a second model.
 *
 * These tests drive `solve()` directly with a fetch stub that answers per model
 * id, so the behaviour is deterministic and no network is involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { solve } from '../src/solve.mjs';

const PRIMARY = 'primary/model';
const FALLBACK = 'fallback/model';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  redact: (value) => value,
};

function baseConfig(overrides = {}) {
  return {
    model: PRIMARY,
    fallbackModel: FALLBACK,
    providerUrlResolved: 'https://provider.invalid/v1/chat/completions',
    providerKey: 'test-key',
    timeoutMs: 2000,
    maxFiles: 16,
    maxTotalBytes: 1 << 20,
    allowedModels: [],
    ...overrides,
  };
}

const GOOD_REPLY = '```jsx App.jsx\nexport default function App() {\n  return null;\n}\n```\n';
const GARBAGE_REPLY = 'I am afraid I cannot help with that. Here is some prose and no blocks.';

/** A stand-in for the fetch Response the provider layer consumes. */
function respond(status, payload) {
  const isObject = typeof payload === 'object' && payload !== null;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async text() {
      return isObject ? JSON.stringify(payload) : String(payload);
    },
  };
}

function completion(content, model) {
  return {
    choices: [{ message: { role: 'assistant', content } }],
    usage: { total_tokens: 1 },
    model,
  };
}

/**
 * @param {(model: string, attemptForModel: number) => object} plan
 * @returns {{impl: Function, calls: string[]}}
 */
function stubFetch(plan) {
  const calls = [];
  const impl = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    calls.push(model);
    return plan(model, calls.filter((value) => value === model).length);
  };
  return { impl, calls };
}

test('the fallback answers when the primary keeps returning 5xx', async () => {
  const { impl, calls } = stubFetch((model) =>
    model === PRIMARY ? respond(503, { error: { message: 'upstream boom' } }) : respond(200, completion(GOOD_REPLY, model)),
  );

  const result = await solve({ testFile: 'x', config: baseConfig(), fetchImpl: impl, logger });

  assert.equal(result.fellBack, true);
  assert.deepEqual(result.attempts, [PRIMARY, FALLBACK]);
  assert.equal(result.model, FALLBACK);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, 'App.jsx');
  // The provider layer retries the primary once itself, then the fallback runs once.
  assert.deepEqual(calls, [PRIMARY, PRIMARY, FALLBACK]);
});

test('the fallback answers when the primary reply cannot be parsed', async () => {
  const { impl, calls } = stubFetch((model) =>
    model === PRIMARY ? respond(200, completion(GARBAGE_REPLY, model)) : respond(200, completion(GOOD_REPLY, model)),
  );

  const result = await solve({ testFile: 'x', config: baseConfig(), fetchImpl: impl, logger });

  assert.equal(result.fellBack, true);
  assert.equal(result.model, FALLBACK);
  assert.equal(result.files.length, 1);
  assert.deepEqual(calls, [PRIMARY, FALLBACK]);
});

test('the fallback answers when the primary is rate-limited', async () => {
  const { impl, calls } = stubFetch((model) =>
    model === PRIMARY ? respond(429, { error: { message: 'slow down' } }) : respond(200, completion(GOOD_REPLY, model)),
  );

  const result = await solve({ testFile: 'x', config: baseConfig(), fetchImpl: impl, logger });

  assert.equal(result.fellBack, true);
  assert.equal(result.model, FALLBACK);
  assert.deepEqual(calls, [PRIMARY, PRIMARY, FALLBACK]);
});

test('a provider credential failure never falls back', async () => {
  const { impl, calls } = stubFetch(() => respond(401, { error: { message: 'bad key' } }));

  await assert.rejects(
    () => solve({ testFile: 'x', config: baseConfig(), fetchImpl: impl, logger }),
    (error) => error.code === 'provider_error',
  );
  assert.deepEqual(calls, [PRIMARY], 'the fallback must not be spent on an auth failure');
});

test('a permission failure (403) never falls back', async () => {
  const { impl, calls } = stubFetch(() => respond(403, { error: { message: 'not in plan' } }));

  await assert.rejects(
    () => solve({ testFile: 'x', config: baseConfig(), fetchImpl: impl, logger }),
    (error) => error.code === 'provider_error',
  );
  assert.deepEqual(calls, [PRIMARY]);
});

test('an empty fallback model disables the fallback', async () => {
  const { impl, calls } = stubFetch(() => respond(503, { error: { message: 'boom' } }));

  await assert.rejects(
    () => solve({ testFile: 'x', config: baseConfig({ fallbackModel: '' }), fetchImpl: impl, logger }),
    (error) => error.code === 'provider_error',
  );
  assert.deepEqual(calls, [PRIMARY, PRIMARY], 'only the primary and its internal retry');
});

test('a fallback equal to the primary is not attempted a second time', async () => {
  const { impl, calls } = stubFetch(() => respond(503, { error: { message: 'boom' } }));

  await assert.rejects(
    () => solve({ testFile: 'x', config: baseConfig({ fallbackModel: PRIMARY }), fetchImpl: impl, logger }),
    (error) => error.code === 'provider_error',
  );
  assert.deepEqual(calls, [PRIMARY, PRIMARY]);
});

test('a hostile path from the primary is NOT retried on the fallback', async () => {
  // Path-safety failures mean the model produced something unsafe. Falling back
  // would hide that rather than fix it, so the error must surface.
  const hostile = '```jsx ../../etc/passwd\npwned\n```\n';
  const { impl, calls } = stubFetch((model) => respond(200, completion(hostile, model)));

  await assert.rejects(
    () => solve({ testFile: 'x', config: baseConfig(), fetchImpl: impl, logger }),
    (error) => error.code === 'unsafe_path',
  );
  assert.deepEqual(calls, [PRIMARY]);
});

test('a successful primary never touches the fallback', async () => {
  const { impl, calls } = stubFetch((model) => respond(200, completion(GOOD_REPLY, model)));

  const result = await solve({ testFile: 'x', config: baseConfig(), fetchImpl: impl, logger });

  assert.equal(result.fellBack, false);
  assert.deepEqual(result.attempts, [PRIMARY]);
  assert.deepEqual(calls, [PRIMARY]);
});

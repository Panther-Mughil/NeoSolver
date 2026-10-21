/**
 * Bounded concurrency.
 *
 * The server is single-threaded and holds no shared mutable state, so
 * simultaneous solves are already correct. What must be verified is the
 * BOUNDING: a burst queues FIFO up to a limit, beyond that it is refused with
 * 503 + Retry-After, and every slot is returned afterwards (including when a
 * request fails), because a leaked slot would permanently shrink capacity.
 *
 * The mock provider's `slow` scenario holds each request for 3 s, which makes
 * the requests genuinely overlap instead of completing one after another.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startStack, request, scenario } from './helpers/service.mjs';

async function withStack(options, fn) {
  const stack = await startStack(options);
  try {
    return await fn(stack);
  } finally {
    await stack.close();
  }
}

/** Fire `count` solves at once and return their results in order. */
function burst(baseUrl, count, options = {}) {
  return Promise.all(
    Array.from({ length: count }, () =>
      request(baseUrl, { path: '/solve', body: scenario('slow'), ...options }),
    ),
  );
}

test('five simultaneous solves all succeed under the default limits', async () => {
  await withStack({}, async (stack) => {
    const results = await burst(stack.baseUrl, 5);
    assert.deepEqual(
      results.map((result) => result.status),
      [200, 200, 200, 200, 200],
    );
    for (const result of results) assert.match(result.contentType, /text\/x-shellscript/);
  });
});

test('requests beyond maxConcurrency queue, and beyond the queue are refused with 503', async () => {
  await withStack({ env: { NEOSOLVER_MAX_CONCURRENCY: '2', NEOSOLVER_QUEUE_LIMIT: '1' } }, async (stack) => {
    const results = await burst(stack.baseUrl, 5);
    const statuses = results.map((result) => result.status);

    const served = statuses.filter((status) => status === 200);
    const refused = results.filter((result) => result.status === 503);

    assert.equal(served.length, 3, `expected 2 in flight + 1 queued to be served, got: ${statuses.join(',')}`);
    assert.equal(refused.length, 2, `expected 2 refused, got: ${statuses.join(',')}`);

    for (const result of refused) {
      assert.equal(result.response.headers.get('retry-after'), '5', 'a 503 must tell the caller when to retry');
      assert.match(result.text, /service_unavailable/);
    }
  });
});

test('a capacity 503 is a readable shell error on the default format', async () => {
  await withStack({ env: { NEOSOLVER_MAX_CONCURRENCY: '1', NEOSOLVER_QUEUE_LIMIT: '0' } }, async (stack) => {
    const results = await burst(stack.baseUrl, 2);
    const refused = results.find((result) => result.status === 503);
    assert.ok(refused, `expected one 503, got: ${results.map((r) => r.status).join(',')}`);
    assert.match(refused.contentType, /text\/x-shellscript/);
    assert.match(refused.text, /^#!\/bin\/sh/);
    assert.match(refused.text, /NeoSolver: HTTP 503 service_unavailable/);
  });
});

test('slots are returned after a burst, so capacity is not leaked', async () => {
  await withStack({ env: { NEOSOLVER_MAX_CONCURRENCY: '1', NEOSOLVER_QUEUE_LIMIT: '0' } }, async (stack) => {
    // First burst: one served, one refused.
    await burst(stack.baseUrl, 2);

    // If the served request had leaked its slot, this would now be a 503.
    const after = await request(stack.baseUrl, { path: '/solve', body: scenario('default') });
    assert.equal(after.status, 200, 'capacity must be restored once the work finishes');
  });
});

test('a failing request also returns its slot', async () => {
  await withStack({ env: { NEOSOLVER_MAX_CONCURRENCY: '1', NEOSOLVER_QUEUE_LIMIT: '0' } }, async (stack) => {
    // An unparseable reply fails inside the slot; the slot must still come back.
    // ?format=json keeps the exact status (the streamed `sh` format commits 200).
    const failed = await request(stack.baseUrl, {
      path: '/solve',
      query: { format: 'json' },
      body: scenario('garbage'),
    });
    assert.equal(failed.status, 502);

    const after = await request(stack.baseUrl, { path: '/solve', body: scenario('default') });
    assert.equal(after.status, 200, 'a failed request must not leak its slot');
  });
});

test('a call that is refused by capacity does not consume a slot', async () => {
  await withStack({ env: { NEOSOLVER_MAX_CONCURRENCY: '1', NEOSOLVER_QUEUE_LIMIT: '0' } }, async (stack) => {
    // Many refusals in a row, then confirm the single slot still works.
    const refused = await Promise.all(
      Array.from({ length: 3 }, () => request(stack.baseUrl, { path: '/solve', body: scenario('slow') })),
    );
    assert.equal(refused.filter((result) => result.status === 503).length, 2);

    const after = await request(stack.baseUrl, { path: '/solve', body: scenario('default') });
    assert.equal(after.status, 200);
  });
});

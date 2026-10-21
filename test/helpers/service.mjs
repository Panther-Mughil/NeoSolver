/**
 * Test helpers: an in-process NeoSolver + mock provider stack, plus a
 * collection of assertion utilities.
 */

import { loadConfig } from '../../src/config.mjs';
import { createServer } from '../../src/server.mjs';
import { startMockProvider } from './mock-provider.mjs';

/** A logger that records instead of writing, so test output stays readable. */
export function silentLogger() {
  const records = [];
  const push = (level) => (message, fields) => records.push({ level, message, fields });
  return {
    records,
    error: push('error'),
    warn: push('warn'),
    info: push('info'),
    debug: push('debug'),
    redact: (text) => String(text),
  };
}

export function listen(server, port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address()));
  });
}

export function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

/**
 * Start a mock provider and a NeoSolver service wired to it, both in-process on
 * ephemeral ports.
 */
export async function startStack(options = {}) {
  const {
    allowAnon = false,
    token = 'neo',
    providerKey = 'test-provider-key',
    model = 'mock-1',
    env = {},
    logger = silentLogger(),
  } = options;

  const provider = await startMockProvider(0);
  const config = loadConfig({
    NEOSOLVER_PROVIDER_URL: provider.url(),
    NEOSOLVER_PROVIDER_KEY: providerKey,
    NEOSOLVER_MODEL: model,
    ...(allowAnon ? { NEOSOLVER_ALLOW_ANON: '1' } : { NEOSOLVER_TOKEN: token }),
    ...env,
  });

  const server = createServer(config, { logger });
  const address = await listen(server);

  return {
    provider,
    config,
    server,
    logger,
    token,
    providerKey,
    allowAnon,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await closeServer(server);
      await closeServer(provider.server);
    },
  };
}

/**
 * Perform a request against the service and read the body as bytes.
 *
 * @param {string} baseUrl
 * @param {{path?: string, method?: string, token?: string|null, body?: string|Buffer,
 *          query?: Record<string, string|string[]>, headers?: Record<string,string>}} [options]
 */
export async function request(baseUrl, options = {}) {
  const { path = '/solve', method = 'POST', token = 'neo', body = '', query = {}, headers = {} } = options;

  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else url.searchParams.set(key, value);
  }

  const finalHeaders = { ...headers };
  if (token !== null && finalHeaders['X-Token'] === undefined && finalHeaders.Authorization === undefined) {
    finalHeaders['X-Token'] = token;
  }
  if (body !== null && body !== '' && finalHeaders['content-type'] === undefined) {
    finalHeaders['content-type'] = 'text/plain';
  }

  const response = await fetch(url, {
    method,
    headers: finalHeaders,
    body: body === null || body === '' ? undefined : body,
  });
  const buffer = Buffer.from(await response.arrayBuffer());

  return {
    response,
    status: response.status,
    contentType: response.headers.get('content-type'),
    buffer,
    text: buffer.toString('utf8'),
  };
}

/** A minimal, realistic challenge test file used by most HTTP tests. */
export const TEST_FILE = [
  "import { test } from 'node:test';",
  '',
  "test('it works', () => {});",
  '',
].join('\n');

/** Scoped marker the mock provider reads to pick a scenario. */
export const scenario = (name) => `SCENARIO:${name}\n${TEST_FILE}`;

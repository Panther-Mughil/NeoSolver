import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseEndpoint, callChatCompletion, extractContent } from '../src/provider.mjs';
import { buildMessages } from '../src/prompt.mjs';
import { loadConfig } from '../src/config.mjs';
import { startMockProvider } from './helpers/mock-provider.mjs';
import { closeServer, silentLogger } from './helpers/service.mjs';

const PROVIDER_KEY = 'provider-key-must-never-leak-1234567890';

// ---------------------------------------------------------------------------
// Endpoint normalisation
// ---------------------------------------------------------------------------

const NORMALISATION_CASES = [
  ['api.example.com', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/v1', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/v1/', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/v1/chat/completions', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/v1/chat/completions/', 'https://api.example.com/v1/chat/completions'],
  ['http://127.0.0.1:11434', 'http://127.0.0.1:11434/v1/chat/completions'],
  ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1/chat/completions'],
  ['https://api.example.test/v1', 'https://api.example.test/v1/chat/completions'],
  ['https://api.example.test/v1/chat/completions', 'https://api.example.test/v1/chat/completions'],
  ['api.example.com/openai', 'https://api.example.com/openai/v1/chat/completions'],
];

for (const [input, expected] of NORMALISATION_CASES) {
  test(`normaliseEndpoint(${JSON.stringify(input)})`, () => {
    assert.equal(normaliseEndpoint(input), expected);
  });
}

test('normaliseEndpoint trims whitespace and drops query/hash', () => {
  assert.equal(
    normaliseEndpoint('  https://api.example.com/v1?x=1#y  '),
    'https://api.example.com/v1/chat/completions',
  );
});

test('normaliseEndpoint rejects unusable input', () => {
  assert.throws(() => normaliseEndpoint(''), (error) => error.status === 502);
  assert.throws(() => normaliseEndpoint('ftp://api.example.com'), (error) => error.status === 502);
});

// ---------------------------------------------------------------------------
// Response extraction
// ---------------------------------------------------------------------------

test('extractContent handles chat messages, legacy text and content parts', () => {
  assert.equal(extractContent({ choices: [{ message: { content: 'hello' } }] }), 'hello');
  assert.equal(extractContent({ choices: [{ text: 'legacy' }] }), 'legacy');
  assert.equal(
    extractContent({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }),
    'ab',
  );
  assert.equal(extractContent({ choices: [] }), null);
  assert.equal(extractContent({}), null);
});

// ---------------------------------------------------------------------------
// Live calls against the mock provider
// ---------------------------------------------------------------------------

const messagesFor = (scenario) =>
  buildMessages({ testFile: `SCENARIO:${scenario}\nimport { test } from 'node:test';\n`, targets: [] });

async function withMock(fn) {
  const mock = await startMockProvider(0);
  const logger = silentLogger();
  const config = loadConfig({
    NEOSOLVER_TOKEN: 'neo',
    NEOSOLVER_PROVIDER_URL: mock.url(),
    NEOSOLVER_PROVIDER_KEY: PROVIDER_KEY,
    NEOSOLVER_MODEL: 'mock-1',
    NEOSOLVER_TIMEOUT_MS: '750',
  });
  try {
    return await fn({ config, mock, logger });
  } finally {
    await closeServer(mock.server);
  }
}

test('a successful call returns the assistant text, usage and model', async () => {
  await withMock(async ({ config, mock, logger }) => {
    const result = await callChatCompletion({
      config,
      model: 'mock-1',
      messages: messagesFor('default'),
      logger,
    });
    assert.match(result.content, /"files"/);
    assert.equal(result.model, 'mock-1');
    assert.equal(result.usage.total_tokens, 300);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].authorization, `Bearer ${PROVIDER_KEY}`);
  });
});

test('a provider 401 becomes 502 and never leaks the key', async () => {
  await withMock(async ({ config, logger }) => {
    await assert.rejects(
      () => callChatCompletion({ config, model: 'm', messages: messagesFor('provider401'), logger }),
      (error) => {
        assert.equal(error.status, 502);
        assert.equal(error.code, 'provider_error');
        assert.match(error.message, /401/);
        assert.match(error.message, /NEOSOLVER_PROVIDER_KEY/);
        assert.ok(!error.message.includes(PROVIDER_KEY), 'the key leaked into the error message');
        return true;
      },
    );
  });
});

test('a provider 500 is retried once, then surfaces as 502', async () => {
  await withMock(async ({ config, mock, logger }) => {
    await assert.rejects(
      () =>
        callChatCompletion({
          config,
          model: 'm',
          messages: messagesFor('provider500'),
          logger,
          backoffMs: 10,
        }),
      (error) => error.status === 502 && /500/.test(error.message),
    );
    assert.equal(mock.requests.length, 2, 'expected exactly one retry');
  });
});

test('a 429 is retried once and then succeeds', async () => {
  await withMock(async ({ config, mock, logger }) => {
    const result = await callChatCompletion({
      config,
      model: 'm',
      messages: messagesFor('provider429'),
      logger,
      backoffMs: 10,
    });
    assert.match(result.content, /"files"/);
    assert.equal(mock.requests.length, 2);
  });
});

test('a non-JSON body (HTML error page) becomes 502 with a bounded excerpt', async () => {
  await withMock(async ({ config, logger }) => {
    await assert.rejects(
      () => callChatCompletion({ config, model: 'm', messages: messagesFor('html'), logger }),
      (error) => {
        assert.equal(error.status, 502);
        assert.match(error.message, /non-JSON/);
        assert.ok(error.message.length < 1200, 'the excerpt must be bounded');
        return true;
      },
    );
  });
});

test('a provider that never answers becomes 504 naming the resolved URL', async () => {
  await withMock(async ({ config, logger }) => {
    await assert.rejects(
      () =>
        callChatCompletion({
          config,
          model: 'm',
          messages: messagesFor('slow'),
          logger,
          backoffMs: 10,
        }),
      (error) => {
        assert.equal(error.status, 504);
        assert.equal(error.code, 'provider_timeout');
        assert.match(error.message, /127\.0\.0\.1/);
        return true;
      },
    );
  });
});

test('an unreachable provider becomes 502 after the retry', async () => {
  const config = loadConfig({
    NEOSOLVER_TOKEN: 'neo',
    NEOSOLVER_PROVIDER_URL: 'http://127.0.0.1:1',
    NEOSOLVER_PROVIDER_KEY: PROVIDER_KEY,
    NEOSOLVER_MODEL: 'm',
    NEOSOLVER_TIMEOUT_MS: '500',
  });
  await assert.rejects(
    () =>
      callChatCompletion({
        config,
        model: 'm',
        messages: messagesFor('default'),
        logger: silentLogger(),
        backoffMs: 10,
      }),
    (error) => error.status === 502 && /could not reach/.test(error.message),
  );
});

test('the resolved endpoint is what is actually called', async () => {
  await withMock(async ({ config, mock, logger }) => {
    await callChatCompletion({ config, model: 'mock-1', messages: messagesFor('notes'), logger });
    assert.equal(mock.requests.length, 1);
    assert.equal(config.providerUrlResolved, `${mock.url()}/v1/chat/completions`);
  });
});

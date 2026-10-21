import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadConfig,
  resolveModel,
  describeConfig,
  ConfigError,
  ConfigValueError,
} from '../src/config.mjs';

const GOOD_KEY = 'key-abcdefghijklmnop';

const baseEnv = (extra = {}) => ({
  NEOSOLVER_PROVIDER_URL: 'https://api.example.test/v1',
  NEOSOLVER_PROVIDER_KEY: GOOD_KEY,
  NEOSOLVER_MODEL: 'some-model',
  NEOSOLVER_TOKEN: 'neo',
  ...extra,
});

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'neosolver-config-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('defaults match plan §4.9', () => {
  const config = loadConfig(baseEnv({}));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.maxBody, 1048576);
  assert.equal(config.timeoutMs, 120000);
  assert.equal(config.maxFiles, 64);
  assert.equal(config.maxTotalBytes, 4194304);
  assert.equal(config.testCommand, 'npm test');
  assert.equal(config.logLevel, 'info');
  assert.equal(config.allowAnon, false);
  assert.equal(config.providerUrlResolved, 'https://api.example.test/v1/chat/completions');
});

test('the provider URL is normalised at load time', () => {
  const config = loadConfig(baseEnv({ NEOSOLVER_PROVIDER_URL: 'api.example.test' }));
  assert.equal(config.providerUrlResolved, 'https://api.example.test/v1/chat/completions');
});

test('a completely empty environment names every missing variable', () => {
  try {
    loadConfig({  });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.deepEqual(error.missing, [
      'NEOSOLVER_TOKEN',
      'NEOSOLVER_PROVIDER_URL',
      'NEOSOLVER_PROVIDER_KEY',
      'NEOSOLVER_MODEL',
    ]);
    for (const name of error.missing) assert.match(error.message, new RegExp(name));
  }
});

test('one missing variable is named on its own', () => {
  const env = baseEnv({});
  delete env.NEOSOLVER_MODEL;
  try {
    loadConfig(env);
    assert.fail('should have thrown');
  } catch (error) {
    assert.deepEqual(error.missing, ['NEOSOLVER_MODEL']);
  }
});

test('an empty-string variable counts as missing', () => {
  try {
    loadConfig(baseEnv({ NEOSOLVER_MODEL: '   ' }));
    assert.fail('should have thrown');
  } catch (error) {
    assert.deepEqual(error.missing, ['NEOSOLVER_MODEL']);
  }
});

test('NEOSOLVER_ALLOW_ANON=1 removes the token requirement', () => {
  const env = baseEnv({ NEOSOLVER_ALLOW_ANON: '1' });
  delete env.NEOSOLVER_TOKEN;
  const config = loadConfig(env);
  assert.equal(config.allowAnon, true);
  assert.equal(config.token, null);
});

test('without anon mode the token is still mandatory', () => {
  const env = baseEnv({});
  delete env.NEOSOLVER_TOKEN;
  assert.throws(() => loadConfig(env), (error) => error.missing.includes('NEOSOLVER_TOKEN'));
});

test('a SHORT operator-chosen token is accepted verbatim', () => {
  for (const token of ['neo', 'abc', 'daily']) {
    assert.equal(loadConfig(baseEnv({ NEOSOLVER_TOKEN: token })).token, token);
  }
});

test('the provider key can come from NEOSOLVER_PROVIDER_KEY_FILE', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'key.txt');
    writeFileSync(file, `${GOOD_KEY}\n`);
    const env = baseEnv({ NEOSOLVER_PROVIDER_KEY_FILE: file });
    delete env.NEOSOLVER_PROVIDER_KEY;
    const config = loadConfig(env);
    assert.equal(config.providerKey, GOOD_KEY);
    assert.match(config.providerKeySource, /NEOSOLVER_PROVIDER_KEY_FILE/);
  });
});

test('precedence: NEOSOLVER_PROVIDER_KEY beats the key file', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'key.txt');
    writeFileSync(file, 'from-key-file');

    const config = loadConfig(
      baseEnv({
        NEOSOLVER_PROVIDER_KEY: 'from-env',
        NEOSOLVER_PROVIDER_KEY_FILE: file,
      }),
    );
    assert.equal(config.providerKey, 'from-env');
    assert.equal(config.providerKeySource, 'NEOSOLVER_PROVIDER_KEY');
  });
});

test('an unreadable or empty key file is a startup error, not a silent fallback', () => {
  withTempDir((dir) => {
    const env = baseEnv({ NEOSOLVER_PROVIDER_KEY_FILE: path.join(dir, 'nope.txt') });
    delete env.NEOSOLVER_PROVIDER_KEY;
    assert.throws(() => loadConfig(env), (error) => error instanceof ConfigValueError);

    const empty = path.join(dir, 'empty.txt');
    writeFileSync(empty, '   \n');
    const env2 = baseEnv({ NEOSOLVER_PROVIDER_KEY_FILE: empty });
    delete env2.NEOSOLVER_PROVIDER_KEY;
    assert.throws(() => loadConfig(env2), (error) => error instanceof ConfigValueError);
  });
});

test('bad numeric and enum values are rejected with a clear message', () => {
  assert.throws(
    () => loadConfig(baseEnv({ NEOSOLVER_PORT: 'not-a-port' })),
    (error) => error instanceof ConfigValueError && /NEOSOLVER_PORT/.test(error.message),
  );
  assert.throws(
    () => loadConfig(baseEnv({ NEOSOLVER_MAX_BODY: '-5' })),
    (error) => error instanceof ConfigValueError,
  );
  assert.throws(
    () => loadConfig(baseEnv({ NEOSOLVER_LOG_LEVEL: 'chatty' })),
    (error) => error instanceof ConfigValueError && /NEOSOLVER_LOG_LEVEL/.test(error.message),
  );
});

test('NEOSOLVER_ALLOWED_MODELS is parsed and enforced', () => {
  const config = loadConfig(baseEnv({ NEOSOLVER_ALLOWED_MODELS: 'a, b ,c' }));
  assert.deepEqual(config.allowedModels, ['a', 'b', 'c']);
  assert.equal(resolveModel(config, 'b'), 'b');
  assert.equal(resolveModel(config, null), config.model);
  assert.throws(() => resolveModel(config, 'd'), (error) => error.status === 400);
});

test('with no allowlist any model id may be requested', () => {
  const config = loadConfig(baseEnv({}));
  assert.deepEqual(config.allowedModels, []);
  assert.equal(resolveModel(config, 'anything-goes'), 'anything-goes');
});

test('describeConfig never exposes key material', () => {
  const config = loadConfig(baseEnv({}));
  const described = JSON.stringify(describeConfig(config));
  assert.ok(!described.includes(GOOD_KEY));
  assert.match(described, /set \(redacted\)/);
});

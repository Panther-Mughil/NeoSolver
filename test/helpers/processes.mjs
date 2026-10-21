/**
 * Helpers for the end-to-end tests: spawn the real `bin/neosolver.mjs` and the
 * real mock-provider CLI, wait for their startup lines, and drive them with the
 * real `curl` and `tar` binaries.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures');

export function hasCommand(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() !== '';
}

export function makeTempDir(prefix = 'neosolver-test-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Wait until `child` prints a line matching `pattern`. */
export function waitForOutput(child, pattern, { timeoutMs = 15000, label = 'process' } = {}) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs} ms waiting for ${label} to match ${pattern}`));
    }, timeoutMs);

    const onData = (chunk) => {
      buffered += chunk.toString();
      const match = pattern.exec(buffered);
      if (match) {
        cleanup();
        resolve({ line: match[0], match, output: buffered });
      }
    };

    const onExit = (code) => {
      cleanup();
      reject(new Error(`${label} exited with code ${code} before matching ${pattern}. Output:\n${buffered}`));
    };

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    }

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

export function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, 4000).unref();
  });
}

/**
 * Start the mock provider CLI and the real service, on ephemeral ports, and
 * return their base URLs. Both are the actual programs a deployment runs.
 */
export async function startRealStack({ token = 'neo', allowAnon = false, env = {}, mockEnv = {} } = {}) {
  // Never let a developer's shell leak real NEOSOLVER_* config into a test run.
  const base = { ...process.env };
  for (const key of Object.keys(base)) if (key.startsWith('NEOSOLVER_')) delete base[key];

  const mock = spawn(process.execPath, [path.join(REPO_ROOT, 'test', 'e2e', 'serve-mock-provider.mjs')], {
    env: { ...base, MOCK_PORT: '0', ...mockEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const mockReady = await waitForOutput(mock, /http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions/, {
    label: 'mock provider',
  });
  const providerUrl = /http:\/\/127\.0\.0\.1:\d+/.exec(mockReady.line)[0];

  const service = spawn(process.execPath, [path.join(REPO_ROOT, 'bin', 'neosolver.mjs'), 'serve'], {
    env: {
      ...base,
      NEOSOLVER_HOST: '127.0.0.1',
      NEOSOLVER_PORT: '0',
      NEOSOLVER_PROVIDER_URL: providerUrl,
      NEOSOLVER_PROVIDER_KEY: 'test-provider-key-xyz',
      NEOSOLVER_MODEL: 'mock-1',
      NEOSOLVER_LOG_LEVEL: 'info',
      ...(allowAnon ? { NEOSOLVER_ALLOW_ANON: '1' } : { NEOSOLVER_TOKEN: token }),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serviceReady = await waitForOutput(service, /listening on 127\.0\.0\.1:\d+/, { label: 'neosolver' });
  const port = /listening on 127\.0\.0\.1:(\d+)/.exec(serviceReady.line)[1];

  return {
    providerUrl,
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    token,
    allowAnon,
    service,
    mock,
    async close() {
      await stopChild(service);
      await stopChild(mock);
    },
  };
}

/** Run a command with `sh -c`, returning status/stdout/stderr. */
/**
 * Environment for a spawned command.
 *
 * A nested `node --test` that inherits the outer runner's `NODE_TEST_CONTEXT`
 * suppresses its own reporter (no "pass N" output) and exits 0 even when tests
 * fail — which would make every PASS/FAIL assertion in these tests meaningless.
 * Never pass it through.
 */
function childEnv(extra) {
  const base = { ...process.env, ...extra };
  delete base.NODE_TEST_CONTEXT;
  return base;
}

export function run(command, { cwd, env, input } = {}) {
  const result = spawnSync('sh', ['-c', command], {
    cwd,
    env: childEnv(env),
    input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Recursively list every file under `dir`, relative and POSIX-separated. */
export function listFiles(dir, rel = '') {
  const out = [];
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, child));
    else out.push(child);
  }
  return out.sort();
}

/**
 * Assert `actualDir` contains every file of `expectedDir` byte-for-byte.
 * @returns {{checked: number, extra: string[]}}
 */
export function compareTree(actualDir, expectedDir, { ignore = [] } = {}) {
  const expected = listFiles(expectedDir);
  const actual = listFiles(actualDir).filter((file) => !ignore.includes(file));
  const missing = [];
  const differing = [];

  for (const file of expected) {
    const actualPath = path.join(actualDir, file);
    if (!existsSync(actualPath) || !statSync(actualPath).isFile()) {
      missing.push(file);
      continue;
    }
    const wanted = readFileSync(path.join(expectedDir, file));
    const got = readFileSync(actualPath);
    if (!wanted.equals(got)) differing.push(file);
  }

  const extra = actual.filter((file) => !expected.includes(file));
  return { checked: expected.length, missing, differing, extra };
}

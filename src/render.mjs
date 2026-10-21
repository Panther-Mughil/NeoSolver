/**
 * Response renderers.
 *
 * `sh` is the DEFAULT: `tar` is not guaranteed to exist in the challenge
 * terminal, but `sh` always does. `tar` and `json` are pure data — only the
 * `sh` script self-verifies (runs the tests and prints the final code).
 */

import { buildTarGz } from './tar.mjs';

export const FORMATS = Object.freeze(['sh', 'tar', 'json']);

export const CONTENT_TYPES = Object.freeze({
  sh: 'text/x-shellscript',
  tar: 'application/gzip',
  json: 'application/json',
});

/** Wrap a value in single quotes for `sh`, escaping embedded single quotes. */
function shQuote(value) {
  return `'${String(value).split("'").join("'\\''")}'`;
}

/**
 * Flatten arbitrary text so it can be printed by a one-line `printf '%s\n'`.
 *
 * Control characters (including NUL and newlines) are replaced with spaces: a
 * literal NUL would truncate the argument in `sh`, and embedded newlines would
 * split the generated line. The result is still passed through {@link shQuote},
 * which neutralises every shell metacharacter.
 */
function oneLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Human-readable next step for an error code, so the script is actionable. */
const ERROR_HINTS = Object.freeze({
  bad_request: 'check the URL and its ?options; GET / prints the accepted forms.',
  unauthorized: 'send the token as X-Token, Authorization: Bearer, or in the /s/<token> path.',
  not_found: 'check the URL; POST/PUT the test file to /solve or /s/<token>.',
  method_not_allowed: 'use POST or PUT for the solve endpoint.',
  payload_too_large: 'send a smaller test file, or raise NEOSOLVER_MAX_BODY on the server.',
  rate_limited: 'wait a moment and retry.',
  provider_error: 'retry; the upstream model provider failed.',
  provider_timeout: 'retry; the upstream model provider timed out.',
  empty_solution: 'try again, or split the request into fewer ?target= files.',
  unsafe_path: 'try again; the model returned a path that cannot be written safely.',
  unprocessable_reply: 'try again, or split the request into fewer ?target= files.',
});

/**
 * The `sh` representation of a FAILED request.
 *
 * The default client pipeline is `curl ... | sh`, so a JSON error body is piped
 * into the shell and produces a meaningless `error: command not found`. When the
 * negotiated format is `sh`, the error is instead a tiny POSIX shell script that
 * writes a clear message to STDERR and exits non-zero. The HTTP status code is
 * NOT changed — only the body representation.
 *
 * Everything interpolated here is single-quoted and escaped via {@link shQuote},
 * so a hostile message can never become executable code.
 *
 * @param {{code: string, status: number, message: string}} error
 * @returns {string}
 */
export function renderErrorShell({ code, status, message }) {
  const hint = ERROR_HINTS[code] ?? 'retry; if the problem persists, check the server log.';
  const head = `NeoSolver: HTTP ${status} ${code}: ${oneLine(message)}`;
  return [
    '#!/bin/sh',
    `# NeoSolver error response (HTTP ${status} ${code}).`,
    `printf '%s\\n' ${shQuote(head)} >&2`,
    `printf '%s\\n' ${shQuote(`Hint: ${hint}`)} >&2`,
    'exit 1',
    '',
  ].join('\n');
}

/**
 * Render a POSIX shell script that does the whole job in one command:
 *   1. writes every file (coreutils only: mkdir, base64, chmod),
 *   2. runs the test command,
 *   3. prints a clearly delimited PASS/FAIL + exit code,
 *   4. prints the final code of every written file (cat).
 *
 * There is NO `set -e`: nothing aborts after the first failure. If a write
 * fails (read-only file, or one owned by another user) the script does
 * `chmod u+w` on the path and retries once; if it still fails the failure is
 * recorded and every remaining file is still attempted. A failing test run is
 * reported and then the script continues. The script exits non-zero only if at
 * least one file write failed — and only after it has attempted and printed
 * everything (including the final code of every file it DID write).
 *
 * @param {Array<{path: string, content: string}>} files
 * @param {{testCommand?: string|null}} [options]
 * @returns {string}
 */
export function renderShell(files, { testCommand = null } = {}) {
  const lines = [];
  lines.push('#!/bin/sh');
  lines.push('# NeoSolver — generated response.');
  lines.push(`# 1. writes ${files.length} file(s) using coreutils only (mkdir, base64, chmod)`);
  if (testCommand) lines.push(`# 2. runs the tests (${testCommand}) and reports PASS/FAIL`);
  else lines.push('# 2. tests skipped');
  lines.push('# 3. prints a per-file status block and the final code of every file with cat');
  lines.push('# A failing test run does NOT abort this script; nor does a failed file write.');
  lines.push('');

  lines.push('neo_written=0');
  lines.push('neo_failed=0');
  lines.push("neo_statuses=''");
  lines.push("neo_failed_hints=''");

  // appends one status line to the aggregated status block (a real newline
  // inside the double-quoted shell string — sh does not expand `\n`)
  const statusAppend = (path, status) =>
    `  neo_statuses="$neo_statuses
    ${path}: ${status}"`;

  let counter = 0;
  for (const file of files) {
    counter += 1;
    const flag = `neo_ok_${counter}`;
    const delimiter = `NEO_EOF_${counter}`;
    const encoded = Buffer.from(file.content, 'utf8').toString('base64');
    const payload = [];
    for (let index = 0; index < encoded.length; index += 76) {
      payload.push(encoded.slice(index, index + 76));
    }

    const slash = file.path.lastIndexOf('/');
    if (slash > 0) lines.push(`mkdir -p ${shQuote(file.path.slice(0, slash))}`);
    lines.push(`${flag}=0`);
    // Attempt 1.
    lines.push(`if base64 -d > ${shQuote(file.path)} <<'${delimiter}'`);
    lines.push(...payload);
    lines.push(delimiter);
    lines.push('then');
    lines.push(`  ${flag}=1`);
    lines.push('  neo_written=$((neo_written + 1))');
    lines.push(statusAppend(file.path, 'written'));
    lines.push('else');
    // Attempt 2: make the destination writable and retry exactly once.
    lines.push(`  chmod u+w ${shQuote(file.path)}`);
    lines.push(`  if base64 -d > ${shQuote(file.path)} <<'${delimiter}'`);
    lines.push(...payload);
    lines.push(delimiter);
    lines.push('  then');
    lines.push(`    ${flag}=1`);
    lines.push('    neo_written=$((neo_written + 1))');
    lines.push(statusAppend(file.path, 'written'));
    lines.push('  else');
    lines.push('    neo_failed=$((neo_failed + 1))');
    lines.push(
      statusAppend(
        file.path,
        'FAILED (could not write it, even after chmod u+w; it may be read-only or owned by another user)',
      ),
    );
    lines.push(
      `    neo_failed_hints="$neo_failed_hints
Try: chmod u+w ${shQuote(file.path)}"`,
    );
    lines.push('  fi');
    lines.push('fi');
  }

  lines.push('');
  lines.push("printf '%s\\n' ''");
  lines.push("printf '%s\\n' '=== NeoSolver: per-file status ==='");
  lines.push("printf '%s\\n' \"$neo_statuses\"");
  lines.push(`printf '%s\\n' "=== NeoSolver: wrote $neo_written file(s) ==="`);
  if (files.length > 0) {
    lines.push('if [ "$neo_failed" -gt 0 ]; then');
    lines.push(
      `printf '%s\\n' "=== NeoSolver: could not write $neo_failed file(s) — they may be owned by another user or read-only. ==="`,
    );
    lines.push("printf '%s\\n' \"$neo_failed_hints\"");
    lines.push('fi');
  }

  if (testCommand) {
    lines.push('if [ "$neo_written" -gt 0 ]; then');
    lines.push(`  printf '%s\\n' ${shQuote(`=== NeoSolver: running tests: ${testCommand} ===`)}`);
    lines.push(`  if sh -c ${shQuote(testCommand)}; then`);
    lines.push(`    printf '%s\\n' ${shQuote('=== NeoSolver: test result: PASS (exit 0) ===')}`);
    lines.push('  else');
    lines.push('    printf \'%s\\n\' "=== NeoSolver: test result: FAIL (exit $?) ==="');
    lines.push('  fi');
    lines.push('else');
    lines.push(`  printf '%s\\n' ${shQuote('=== NeoSolver: no file was written, so the tests were skipped ===')}`);
    lines.push('fi');
  } else {
    lines.push(`printf '%s\\n' ${shQuote('=== NeoSolver: tests skipped (?test=none) ===')}`);
  }

  lines.push("printf '%s\\n' ''");
  lines.push(`printf '%s\\n' ${shQuote('=== NeoSolver: final code ===')}`);
  counter = 0;
  for (const file of files) {
    counter += 1;
    // Only files that WERE written have their code printed.
    lines.push(`if [ "$neo_ok_${counter}" -eq 1 ]; then`);
    lines.push(`  printf '%s\\n' ${shQuote(`--- ${file.path} ---`)}`);
    lines.push(`  cat ${shQuote(file.path)}`);
    lines.push("  printf '\\n'");
    lines.push('fi');
  }
  lines.push(`printf '%s\\n' ${shQuote('=== NeoSolver: done ===')}`);
  lines.push('');
  // Exit non-zero only if at least one write failed — after everything else has
  // been attempted and printed.
  lines.push('if [ "$neo_failed" -gt 0 ]; then');
  lines.push('  exit 1');
  lines.push('fi');
  lines.push('exit 0');
  lines.push('');
  return lines.join('\n');
}

/**
 * `?format=json` — inspection representation. Pure data, no test execution.
 * @param {{files: Array<{path: string, content: string}>, notes?: string, usage?: object|null, model?: string|null}} solution
 */
export function renderJson(solution) {
  const files = Object.create(null);
  for (const file of solution.files) files[file.path] = file.content;
  return `${JSON.stringify(
    {
      files,
      notes: solution.notes ?? '',
      model: solution.model ?? null,
      usage: solution.usage ?? null,
    },
    null,
    2,
  )}\n`;
}

/**
 * `?format=tar` — gzip'd ustar archive. Pure data, no test execution.
 * @param {Array<{path: string, content: string}>} files
 */
export function renderTar(files) {
  return buildTarGz(files);
}

/**
 * Plain-text usage served at `GET /` (no auth).
 *
 * `baseUrl` is derived from the incoming request (Host + X-Forwarded-Proto), so
 * the printed one-liner matches the domain the client actually used and no
 * domain is hardcoded.
 */
export function usageText({ allowAnon = false, baseUrl = 'http://127.0.0.1:8787', exampleToken = 'neo' } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const lines = [
    'NeoSolver — send your challenge test file, get the solution files back.',
    '',
    'The default response is a POSIX shell script that writes every file, runs the',
    'tests, prints the PASS/FAIL result and then prints the final code. Pipe it into sh:',
    '',
    `  curl -s ${base}/s/${exampleToken} -T tests.js | sh`,
    `  curl -s ${base} -T tests.js | sh      # only when NEOSOLVER_ALLOW_ANON=1`,
    '',
    'The token is chosen by the operator and may be short (e.g. "myteam7").',
    `Do not add a trailing slash: \`...-T tests.js ${base}/s/${exampleToken}/\` sends the (wrong)`,
    `path \`/s/${exampleToken}/tests.js\`, because curl appends the file name to a URL`,
    'that ends in a slash. A trailing slash is tolerated by the server anyway.',
    'Never use `curl -d @tests.js`: -d strips newlines and corrupts the file.',
    '',
    'Alternates: ?format=tar (| tar -xzf -), ?format=json. Options: ?test=<cmd>,',
    '?test=none, ?model=<id>, &target=<path>. Health: GET /healthz',
  ];
  if (allowAnon) {
    lines.push('');
    lines.push('This instance runs with NEOSOLVER_ALLOW_ANON=1: no token is required.');
  }
  lines.push('');
  return lines.join('\n');
}

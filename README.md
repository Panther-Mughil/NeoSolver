# NeoSolver

Send a coding challenge's test file from a terminal, get the solution files back.

```bash
curl -s https://solver.example.com/s/myteam7 -T tests.js | sh
```

That is the entire client. Nothing is installed, created, or uploaded inside the
challenge environment — the terminal is used only to *send* the test file and to
*run* the returned script.

**Contents:** [Quick start](#quick-start) · [Verify](#3-verify-it-works) ·
[Configure](#configuration-reference) · [Day to day](#using-it-day-to-day) ·
[Troubleshooting](#troubleshooting) · [Deploy](#deployment) · [Security](#security)

---

## The problem it solves

Some challenge environments block copy/paste, so you cannot copy a test file out
or paste a solution in. But their terminal usually has outbound internet.

This service sits on a machine you control, receives the test file, asks a model
for the source files that make it pass, and returns a shell script that writes
those files, runs the tests, and prints the result — all inside that terminal.

### How it works

```
challenge terminal                your machine                  model provider
──────────────────                ────────────                  ──────────────
curl -T tests.js  ──────────────► NeoSolver  ──chat/completions─►
                  ◄────────────── shell script ◄─────────────────
| sh  → writes files, runs tests, prints PASS/FAIL and the code
```

The model reply is treated as untrusted input: absolute paths, `..`, leading
`-`, duplicate paths, oversized file sets and control characters are all
rejected, and **nothing is written unless the whole file set is safe**.

## Requirements

- **Node.js 20 or newer** — uses the built-in `fetch`, `node --test` and
  `AbortSignal`. Check with `node -v`.
- **No npm dependencies.** There is nothing to `npm install`.
- An **OpenAI-compatible chat-completions endpoint** and an API key for it.
  Any provider that accepts `POST {base}/v1/chat/completions` works.
- The machine running the challenge must be able to **reach this host over the
  network** (it needs outbound internet, and this service needs to be reachable
  from it — over your LAN or through a public URL).

## Quick start

### 1. Collect your provider details

You need three things from your model provider's dashboard/docs:

| What | Where to find it | What it looks like |
|---|---|---|
| **Base URL** | "API base", "endpoint", or their curl example | `https://api.example.com/v1` |
| **Model id** | their model list | an exact id string, e.g. `vendor/model-name` |
| **API key** | "API keys" page | a long secret string |

The base URL is forgiving — any of these work, and the service appends the rest:

```
https://api.example.com
https://api.example.com/v1
https://api.example.com/v1/chat/completions
```

### 2. Install

```bash
git clone <this repo> neosolver
cd neosolver
cp neosolver.env.example neosolver.env
```

### 3. Configure

Edit `neosolver.env` and set these four. Everything else has a working default.

```bash
NEOSOLVER_TOKEN=myteam7                            # you invent this
NEOSOLVER_PROVIDER_URL=https://api.example.com/v1   # from step 1
NEOSOLVER_MODEL=vendor/model-name                   # from step 1
NEOSOLVER_PROVIDER_KEY=sk-...                       # from step 1
```

Optionally add a second model so a slow or failing primary gets one retry:

```bash
NEOSOLVER_FALLBACK_MODEL=other-vendor/other-model
```

### 4. Start

```bash
./start.sh start -d     # background
./start.sh status       # should say running, and GET /healthz: {"ok":true}
```

It refuses to start if a required value is missing — naming each one — and
refuses to double-start.

### 5. Verify it works

Before involving any proxy, prove the model and the write path work **locally**:

```bash
mkdir -p /tmp/neosolver-check && cd /tmp/neosolver-check

cat > tests.js <<'EOF'
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
test('hello.txt greets', () => {
  if (!readFileSync('hello.txt', 'utf8').toLowerCase().includes('hello')) {
    throw new Error('no greeting');
  }
});
EOF

curl -s 'http://127.0.0.1:8787/s/myteam7?test=none' \
  -H 'X-Targets: hello.txt' -T tests.js | sh

cat hello.txt          # the model should have written this
```

You should see a per-file status block with `hello.txt: written`, and the file
should exist. `?test=none` skips the test runner for this smoke test; in a real
challenge it runs `npm test` by default.

If that works, the rest is just networking.

### 6. Use it from a challenge

```bash
curl -s https://solver.example.com/s/myteam7 \
  -H 'X-Targets: App.jsx,App.css,index.html,script.js' \
  -T tests.js | sh
```

## Configuration reference

Four values are required; the rest are optional.

| Variable | Default | Meaning |
|---|---|---|
| `NEOSOLVER_TOKEN` | **required** | Short token you invent; typed on every challenge |
| `NEOSOLVER_PROVIDER_URL` | **required** | Your provider's OpenAI-compatible base |
| `NEOSOLVER_MODEL` | **required** | Exact model id your provider expects |
| `NEOSOLVER_PROVIDER_KEY` | **required** | Your API key (or use `_KEY_FILE`) |
| `NEOSOLVER_FALLBACK_MODEL` | *(empty)* | One retry model, see [model fallback](#model-fallback) |
| `NEOSOLVER_PROVIDER_KEY_FILE` | *(empty)* | Read the key from a file instead (e.g. a secret mount) |
| `NEOSOLVER_ALLOWED_MODELS` | *(empty)* | Comma list; `?model=` outside it is a `400` |
| `NEOSOLVER_HOST` | `127.0.0.1` | Use `0.0.0.0` if a proxy on another host must reach it |
| `NEOSOLVER_PORT` | `8787` | Listening port |
| `NEOSOLVER_ALLOW_ANON` | `0` | `1` disables client auth — see [Security](#security) |
| `NEOSOLVER_MAX_BODY` | `1048576` | Max test-file size in bytes |
| `NEOSOLVER_TIMEOUT_MS` | `120000` | Per provider call |
| `NEOSOLVER_MAX_FILES` | `64` | Max files the model may return |
| `NEOSOLVER_MAX_TOTAL_BYTES` | `4194304` | Max total size of those files |
| `NEOSOLVER_MAX_CONCURRENCY` | `8` | Solves running at once |
| `NEOSOLVER_QUEUE_LIMIT` | `32` | Requests allowed to wait; beyond → `503` |
| `NEOSOLVER_HEARTBEAT_MS` | `15000` | Keep-alive comment during a streamed solve |
| `NEOSOLVER_TEST_COMMAND` | `npm test` | Command the returned script runs |
| `NEOSOLVER_LOG_LEVEL` | `info` | `error`/`warn`/`info`/`debug` |
| `NEOSOLVER_LOG_FILE` | *(empty)* | Log file (rotated); empty = stderr only |
| `NEOSOLVER_LOG_MAX_BYTES` | `5242880` | Rotate to `<file>.1` past this; `0` disables |

Validate without starting:

```bash
node bin/neosolver.mjs --check-config
```

### start.sh commands

| Command | Meaning |
|---|---|
| `./start.sh` | foreground (Ctrl-C stops) |
| `./start.sh start -d` | background |
| `./start.sh status` | pid, port, `GET /healthz` |
| `./start.sh restart -d` | stop then start |
| `./start.sh stop` / `./stop.sh` | stop |
| `./start.sh --help` | usage |

### HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST`/`PUT` | `/solve` | test file in the body |
| `POST`/`PUT` | `/s/<token>` | same, token in the path |
| `GET` | `/healthz` | liveness, no auth |
| `GET` | `/` | usage text, no auth |

Per-request options: `?format=sh|tar|json`, `?test=<cmd>`, `?test=none`,
`?model=<id>`, `?target=<path>` (repeatable), or the `X-Targets` header.

## Using it day to day

### Pinning the files you want

The model decides which files to produce. Tell it with the **`X-Targets`
header** — it contains no character the shell treats specially:

```bash
curl -s https://solver.example.com/s/myteam7 \
  -H 'X-Targets: App.jsx,App.css,index.html,script.js,styles/style.css' \
  -T App.test.js | sh
```

The repeatable `?target=` query works too and both can be combined (query first,
then header; duplicates dropped; 64 max):

```bash
curl -s 'https://solver.example.com/s/myteam7?target=App.jsx&target=App.css' -T App.test.js | sh
```

### Paths are relative to your current directory

The returned script writes relative to where you run it. So:

| You are in | Put in `-H` | Lands at |
|---|---|---|
| project root | `src/components/Card.jsx` | `<root>/src/components/Card.jsx` |
| `src/` | `components/Card.jsx` | `<root>/src/components/Card.jsx` |
| `src/` | `src/components/Card.jsx` | ❌ `<root>/src/src/components/Card.jsx` |

When in doubt, run from the project root.

### Three ways to get no files

| Mistake | Result |
|---|---|
| `curl -d @tests.js` | **`-d` strips newlines** and corrupts the test file. Use `-T` or `--data-binary`. |
| Trailing slash `.../s/myteam7/` | `curl -T` appends the filename → `PUT /s/myteam7/tests.js` → **404**. |
| Unquoted `?target=a&target=b` | The shell splits on `&`; you send a `GET` with no file. Quote the URL. |

### Read-only files

If a target file cannot be written, the script retries once after `chmod u+w`,
reports `FAILED (...)` for that file, **continues with the rest**, runs the tests,
and exits non-zero. Nothing is silently skipped.

### Model fallback

`NEOSOLVER_FALLBACK_MODEL` is tried for **exactly one** extra attempt:

| Falls back | Does **not** fall back |
|---|---|
| timeout, `429`, `5xx`, network error | credential/permission failure (`401`/`403`) |
| an answer that cannot be parsed | an unsafe or ambiguous path |

An operator problem must never be hidden by quietly spending a second model.
Every solve logs `fellBack=yes|no`.

### Streaming

The default `sh` response streams: the shebang and `# NeoSolver: solving` go out
immediately, then the script when the model answers. This keeps proxies from
timing out a slow solve, and shows progress instead of a blank cursor. A
keep-alive comment is written every `NEOSOLVER_HEARTBEAT_MS`.

Because the status is committed before the answer is known, a failure *after*
streaming starts arrives as a script that prints the error and exits non-zero.
Use `?format=json` when you need exact HTTP statuses.

## Troubleshooting

Start with the server log (or `./start.sh status`), then match the symptom.

| Symptom | Cause | Fix |
|---|---|---|
| `sh: line 1: error: command not found` | The body was **not** a shell script — a proxy error page or a JSON error got piped into `sh`. | Re-run with `?format=json` and look at the real message |
| `NeoSolver: HTTP 401 unauthorized` | Wrong or missing token | Check `NEOSOLVER_TOKEN` and the `/s/<token>` path |
| `NeoSolver: HTTP 404` | Trailing slash after the token | Use `/s/myteam7`, not `/s/myteam7/` |
| `NeoSolver: HTTP 413` | Test file larger than `NEOSOLVER_MAX_BODY` | Raise it, or send less |
| `NeoSolver: HTTP 429 rate_limited` | Provider throttling | Wait, retry, or lower `NEOSOLVER_MAX_CONCURRENCY` |
| `NeoSolver: HTTP 502 unprocessable_reply` | The model's answer could not be parsed | Retry; send fewer `?target=` files per call |
| `NeoSolver: HTTP 503 service_unavailable` | Concurrency slots + queue full | Retry; raise `NEOSOLVER_MAX_CONCURRENCY` |
| `NeoSolver: HTTP 504 provider_timeout` | Provider did not answer in `NEOSOLVER_TIMEOUT_MS` | Retry; a fallback model helps |
| Request arrived as `GET` / `405` | Unquoted `&` split your command | Quote the URL |
| File written but content corrupted | `curl -d` used instead of `-T` | `-T` or `--data-binary` |
| `FAILED (could not write it, even after chmod u+w)` | File is read-only or owned by another user | `chmod -R u+w .`, or run where you can write |
| Blank terminal for minutes | A slow model call (streaming line should show) | Wait; check the log for `solved ... ms=` |
| `EADDRINUSE` | Another instance already on that port | `./start.sh status`, or change `NEOSOLVER_PORT` |
| Service dies right after starting | Launched from a shell that was then closed | Run `./start.sh start -d`; consider adding `setsid` to the detach line |

## Deployment

Put it behind any reverse proxy you already run and terminate TLS there.

Two things matter:

1. **Bind a reachable interface** — `NEOSOLVER_HOST=0.0.0.0`. With `127.0.0.1` a
   proxy on another host cannot reach it.
2. **Give the proxy a long response timeout.** Responses stream, so most proxies
   are fine — but one that insists on a *complete* response within N seconds
   still cuts a very slow solve. Raise it, or leave the origin unproxied.

Example (Nginx Proxy Manager fields in parentheses):

```
domain            solver.example.com
scheme            http
forward host/ip   192.0.2.10        (Forward Hostname / IP)
forward port      8787              (Forward Port)
```

On a container platform: set the four required values as **secrets**, leave
`NEOSOLVER_LOG_FILE` empty (the platform captures stderr), use
`NEOSOLVER_HOST=0.0.0.0`, and start the process with
`node bin/neosolver.mjs serve`.

## Security

- The provider key is never logged, never returned in a response, and redacted
  from every log line and error message.
- **Use a long random token if the service is reachable from the internet.** A
  short token is guessable, and every guess that lands spends your credits.
- `NEOSOLVER_ALLOW_ANON=1` disables client auth entirely. Anyone who can reach
  the port can then spend your credits — only use it behind a proxy that
  enforces its own access control.
- Model output is never trusted: paths are sanitised, sets are size-capped, and
  generated scripts single-quote and escape every path and message so a hostile
  reply cannot become executable code.

## Development

```bash
node --test test/          # 223 tests, zero dependencies
node bin/neosolver.mjs --help
```

Layout: `bin/` entry point · `src/` service (config, provider, prompt, parse,
paths, render, server, log) · `test/` suite with a mock provider and fixtures.

## Limitations

- One request is one model call; a challenge with many files takes longer. The
  streamed response is what keeps a slow call alive.
- The service is stateless — nothing is remembered between requests.
- The `sh` format needs only `mkdir`, `base64`, `chmod` and `cat` on the client.
  `?format=tar` is produced by a small built-in ustar writer.

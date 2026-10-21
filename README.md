# NeoSolver

Send a coding challenge's test file from a terminal, get the solution files back.

```bash
curl -s https://solver.example.com/s/myteam7 -T tests.js | sh
```

That is the whole client. Nothing is installed, created, or uploaded inside the
challenge environment — the terminal is only used to *send* the test file and to
*run* the returned script.

---

## How it works

1. A terminal sends a challenge's test file (`-T tests.js`) to this service.
2. The service asks an OpenAI-compatible model for the source files that make
   that test file pass.
3. It answers with a POSIX shell script that **writes every file**, **runs the
   tests**, prints a per-file status block, and then prints the final code of
   every file it wrote.

The model reply is untrusted input: absolute paths, `..`, leading `-`, duplicate
paths, oversized file sets and control characters are all rejected, and nothing is
written unless the whole file set is safe.

## Requirements

- **Node.js 20 or newer** (uses the built-in `fetch`, `node --test`, and `AbortSignal`).
- **No npm dependencies** — nothing to install.
- An **OpenAI-compatible chat-completions endpoint** and an API key for it.
  Any provider that speaks `POST {base}/v1/chat/completions` will do.

## Install

```bash
git clone <this repo> neosolver
cd neosolver
cp neosolver.env.example neosolver.env
$EDITOR neosolver.env      # set the 4 required values (see below)
./start.sh start -d
./start.sh status
```

`start.sh` refuses to start if a required value is missing, naming each one, and
refuses to double-start.

| Command | Meaning |
|---|---|
| `./start.sh` | start in the foreground (Ctrl-C stops it) |
| `./start.sh start -d` | start in the background |
| `./start.sh status` | running/stopped, pid, port, `GET /healthz` |
| `./start.sh restart -d` | stop then start |
| `./start.sh stop` | stop |
| `./stop.sh` | same as `./start.sh stop` |
| `./start.sh --help` | usage |

## Configure

Four values are required; everything else has a sensible default.

| Variable | Required | Meaning |
|---|---|---|
| `NEOSOLVER_TOKEN` | ✅ | Short token **you** choose. Typed by hand on every challenge. |
| `NEOSOLVER_PROVIDER_URL` | ✅ | Your provider's OpenAI-compatible base URL. |
| `NEOSOLVER_MODEL` | ✅ | The exact model id your provider expects. |
| `NEOSOLVER_PROVIDER_KEY` | ✅ | Your provider's API key (or use `NEOSOLVER_PROVIDER_KEY_FILE`). |

The key may also live in a file:

```bash
NEOSOLVER_PROVIDER_KEY_FILE=/run/secrets/provider-key
```

It is never logged, never returned in a response, and redacted everywhere.

Check your configuration without starting:

```bash
node bin/neosolver.mjs --check-config
```

## Client usage

Pin the files you expect with the **`X-Targets` header** — it contains no
character the shell treats specially, so a lost quote cannot silently break it:

```bash
curl -s https://solver.example.com/s/myteam7 \
  -H 'X-Targets: App.jsx,App.css,index.html,script.js,styles/style.css' \
  -T App.test.js | sh
```

The repeatable `?target=` query form works too, and both can be combined
(query values first, then the header; duplicates dropped; 64 max):

```bash
curl -s 'https://solver.example.com/s/myteam7?target=App.jsx&target=App.css' -T App.test.js | sh
```

**Paths are relative to the directory you run the command from.** If your
components live under `src/`, either run from the project root and use
`src/components/Card.jsx`, or `cd src` and use `components/Card.jsx`.

### Three ways to get no files

| Mistake | Result |
|---|---|
| `curl -d @tests.js` | **`-d` strips newlines** and corrupts the test file. Use `-T` or `--data-binary`. |
| Trailing slash: `.../s/myteam7/` | `curl -T` then appends the filename → `PUT /s/myteam7/tests.js` → 404. |
| Unquoted `?target=a&target=b` | The shell splits on `&`; the request quietly becomes a `GET` with no body. Quote the URL. |

Files that are read-only are retried once after `chmod u+w`; if they still cannot
be written the script says which ones failed and why, and exits non-zero.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST`/`PUT` | `/solve` | the test file in the body |
| `POST`/`PUT` | `/s/<token>` | same, token in the path |
| `GET` | `/healthz` | liveness, no auth |
| `GET` | `/` | usage text, no auth |

Per request: `?format=sh|tar|json`, `?test=<cmd>`, `?test=none`, `?model=<id>`,
`?target=<path>` (repeatable), or the `X-Targets` header.

## Models and the fallback

`NEOSOLVER_MODEL` is the primary. `NEOSOLVER_FALLBACK_MODEL` (optional) is tried
for **exactly one** extra attempt, and only when a different model can plausibly
help:

| Falls back | Does **not** fall back |
|---|---|
| timeout, HTTP 429, 5xx, network error | credential/permission failure (401/403) |
| an answer that cannot be parsed | an unsafe or ambiguous file path |

That split is deliberate: an operator problem must not be hidden by quietly
spending a second model. Every solve logs `fellBack=yes|no`.

## Concurrency

| Variable | Default | Meaning |
|---|---|---|
| `NEOSOLVER_MAX_CONCURRENCY` | `8` | solves running at once |
| `NEOSOLVER_QUEUE_LIMIT` | `32` | requests allowed to wait; beyond this → `503` + `Retry-After: 5` |

A solve holds an upstream socket for the whole model call, so the burst is
bounded rather than unbounded. `0` refuses as soon as the slots are taken.

## Streaming

The default `sh` response is **streamed**: the shebang and a status comment go
out immediately, and the script follows when the model answers.

- a reverse proxy that times out an origin producing nothing (for example
  Cloudflare's ~100 s, error `524`) cannot kill a slow solve;
- the terminal shows `# NeoSolver: solving` instead of a blank cursor.

While the model works, a keep-alive comment is written every
`NEOSOLVER_HEARTBEAT_MS` (default `15000`; `0` disables) so a proxy cannot drop a
silent body either. Because the status is committed before the answer is known, a
failure after streaming starts arrives as a script that prints the error and
exits non-zero — ask for `?format=json` when you need the exact HTTP status.

`?format=json` and `?format=tar` are never streamed and keep their exact status
codes and `Content-Length`.

## Errors

The default client is `curl ... | sh`, so an error is rendered as a script that
prints a readable message and exits non-zero:

```
NeoSolver: HTTP 502 unprocessable_reply: the model reply could not be parsed
Hint: try again, or split the request into fewer ?target= files
```

`?format=json` and `?format=tar` return the JSON error object with the real
status (`400`, `401`, `413`, `429`, `502`, `503`, `504`). `/healthz`, `GET /` and
unknown routes always answer in JSON/plain text.

## Logging

| Variable | Default | Meaning |
|---|---|---|
| `NEOSOLVER_LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `NEOSOLVER_LOG_FILE` | empty (stderr only) | the service appends here |
| `NEOSOLVER_LOG_MAX_BYTES` | `5242880` | rotate to `<file>.1` past this; `0` disables |

One previous generation is kept, so an unattended service cannot fill the disk.
stderr is still echoed live when attached to a terminal, and it is what a
container platform captures when no log file is configured.

## Deployment

Put it behind any reverse proxy you already run and terminate TLS there. Two
things matter:

1. **Bind a reachable interface** — `NEOSOLVER_HOST=0.0.0.0`, not `127.0.0.1`, or
   a proxy on another host cannot reach it.
2. **Give the proxy a long enough response timeout.** Requests stream, so a
   proxy that requires a *complete* response within N seconds will still cut a
   very slow solve. Raise it, or leave the origin unproxied.

Example (Nginx Proxy Manager fields in parentheses):

```
domain            solver.example.com
scheme            http
forward host/ip   192.0.2.10          (Forward Hostname / IP)
forward port      8787               (Forward Port)
```

On a container platform, set the four required variables as secrets, leave
`NEOSOLVER_LOG_FILE` empty (the platform captures stderr), and point the process
at `node bin/neosolver.mjs serve`.

## Security

- The provider key is never logged, never returned, and redacted everywhere.
- `NEOSOLVER_ALLOW_ANON=1` disables client auth entirely. Anyone who can reach
  the port can then spend your provider credits; only use it behind a proxy that
  enforces its own access control.
- If the service is reachable from the internet, use a **long random token** —
  a short one is guessable and every guess that lands spends your credits.
- Generated scripts single-quote and escape every path and message, so a hostile
  model reply can never become executable code.

## Tests

```bash
node --test test/
```

## Limitations

- One request is one model call. A large challenge (many files) can take a while;
  the streamed response is what keeps a slow call alive.
- The service holds no state, so nothing is remembered between requests.
- `tar` output is produced by a small built-in ustar writer; `sh` (the default)
  needs only `mkdir`, `base64`, `chmod` and `cat` on the client.

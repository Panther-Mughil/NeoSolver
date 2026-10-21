#!/bin/sh
# NeoSolver launcher.
#
#   ./start.sh              start in the foreground (Ctrl-C stops it)
#   ./start.sh start        same
#   ./start.sh start -d     start in the background, logging to ./logs/neosolver.log
#   ./start.sh stop         stop the process named in ./neosolver.pid
#   ./start.sh restart      stop, then start (pass -d to restart detached)
#   ./start.sh status       running/stopped, pid, port, GET /healthz
#   ./start.sh --help       this text
#
# POSIX sh only — no bashisms.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR" || exit 1

PIDFILE="$SCRIPT_DIR/neosolver.pid"
LOGDIR="$SCRIPT_DIR/logs"
LOGFILE="$LOGDIR/neosolver.log"
ENVFILE="$SCRIPT_DIR/neosolver.env"
DOTENV="$SCRIPT_DIR/.env"
ENTRY="bin/neosolver.mjs"
NODE_BIN=${NODE_BIN:-node}

DEFAULT_HOST=127.0.0.1
DEFAULT_PORT=8787

usage() {
  cat <<'EOF'
NeoSolver launcher

Usage:
  ./start.sh [start] [-d|--detach]   Start the service
  ./start.sh stop                    Stop the service named in ./neosolver.pid
  ./start.sh restart [-d]            Stop then start
  ./start.sh status                  Show pid, port and GET /healthz
  ./start.sh --help                  Show this help

Environment is read from ./neosolver.env and then ./.env (if present).

Required variables:
  NEOSOLVER_PROVIDER_URL    OpenAI-compatible base (domain, origin, /v1 or full URL)
  NEOSOLVER_MODEL           default model id
  NEOSOLVER_TOKEN           a SHORT token you choose, unless NEOSOLVER_ALLOW_ANON=1

The provider key is resolved automatically, in this order:
  1. NEOSOLVER_PROVIDER_KEY
  2. NEOSOLVER_PROVIDER_KEY_FILE (a file containing the raw key)

Client one-liner (run inside the challenge terminal; nothing is created there):
  curl -s http://<host>:<port>/s/<your-token> -T tests.js | sh
  curl -s http://<host>:<port> -T tests.js | sh     # only with NEOSOLVER_ALLOW_ANON=1

No trailing slash after the token: `curl -T tests.js .../s/neo/` sends the wrong
path `/s/neo/tests.js`, because curl appends the file name to a URL ending in "/".
Never use `curl -d @tests.js`: -d strips newlines and corrupts the test file.
EOF
}

log() {
  printf '%s\n' "$*"
}

warn() {
  printf '%s\n' "$*" >&2
}

# Load ./neosolver.env then ./.env; values are exported to the service.
load_env() {
  for _file in "$ENVFILE" "$DOTENV"; do
    [ -f "$_file" ] || continue
    set -a
    # shellcheck disable=SC1090
    if ! . "$_file"; then
      warn "NeoSolver: could not read $_file"
      exit 1
    fi
    set +a
  done
}

# Refuse to start unless every required variable is present and real.
check_required() {
  _missing=""
  [ -n "${NEOSOLVER_PROVIDER_URL:-}" ] || _missing="$_missing NEOSOLVER_PROVIDER_URL"
  [ -n "${NEOSOLVER_MODEL:-}" ] || _missing="$_missing NEOSOLVER_MODEL"
  if [ "${NEOSOLVER_ALLOW_ANON:-}" != "1" ]; then
    [ -n "${NEOSOLVER_TOKEN:-}" ] || _missing="$_missing NEOSOLVER_TOKEN"
  fi

  # The provider key may be supplied directly or via a key file.
  _key_ok=no
  [ -n "${NEOSOLVER_PROVIDER_KEY:-}" ] && _key_ok=yes
  if [ "$_key_ok" = "no" ] && [ -n "${NEOSOLVER_PROVIDER_KEY_FILE:-}" ]; then
    [ -r "${NEOSOLVER_PROVIDER_KEY_FILE}" ] && _key_ok=yes
  fi
  [ "$_key_ok" = "yes" ] || _missing="$_missing NEOSOLVER_PROVIDER_KEY"

  if [ -n "$_missing" ]; then
    warn "NeoSolver: refusing to start — missing required environment variable(s):"
    for _name in $_missing; do
      warn "  - $_name"
    done
    warn ""
    warn "Create $ENVFILE from the example:  cp neosolver.env.example neosolver.env"
    warn "NEOSOLVER_TOKEN is a short token you choose yourself (e.g. myteam)."
    warn "Set NEOSOLVER_ALLOW_ANON=1 to disable client auth entirely."
    warn "NEOSOLVER_PROVIDER_KEY is the API key issued by your model provider"
    warn "  (or point NEOSOLVER_PROVIDER_KEY_FILE at a file containing it)."
    return 1
  fi

  for _name in NEOSOLVER_PROVIDER_URL NEOSOLVER_PROVIDER_KEY NEOSOLVER_MODEL NEOSOLVER_TOKEN; do
    eval "_value=\${$_name:-}"
    [ -n "$_value" ] || continue
    case "$_value" in
      *'<'*'>'* | *changeme* | *CHANGEME* | *your-* | *your_* | *placeholder* | *xxxx* | *YOUR_*)
        warn "NeoSolver: refusing to start — $_name still looks like a placeholder (\"$_value\")."
        warn "Edit $ENVFILE and put your real value there."
        return 1
        ;;
    esac
  done
  return 0
}

pid_from_file() {
  [ -f "$PIDFILE" ] || return 1
  _pid=$(tr -d ' \t\r\n' <"$PIDFILE" 2>/dev/null)
  case "$_pid" in
    '' | *[!0-9]*) return 1 ;;
  esac
  printf '%s' "$_pid"
}

# True only if the pid exists AND is actually a NeoSolver process.
is_neosolver_pid() {
  _pid=$1
  kill -0 "$_pid" 2>/dev/null || return 1
  if [ -r "/proc/$_pid/cmdline" ]; then
    _cmdline=$(tr '\0' ' ' <"/proc/$_pid/cmdline" 2>/dev/null)
    case "$_cmdline" in
      *neosolver*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  return 0
}

lan_ip() {
  _ip=""
  if command -v hostname >/dev/null 2>&1; then
    _ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi
  if [ -z "$_ip" ] && command -v ip >/dev/null 2>&1; then
    _ip=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n 1)
  fi
  printf '%s' "$_ip"
}

print_banner() {
  _host=${NEOSOLVER_HOST:-$DEFAULT_HOST}
  _port=${NEOSOLVER_PORT:-$DEFAULT_PORT}
  _lan=$(lan_ip)

  case "$_host" in
    0.0.0.0 | :: | '*') _reach=${_lan:-127.0.0.1} ;;
    *) _reach=$_host ;;
  esac

  log "NeoSolver"
  log "  bind            : ${_host}:${_port}"
  log "  local URL       : http://127.0.0.1:${_port}"
  [ -n "$_lan" ] && log "  LAN URL         : http://${_lan}:${_port}"
  log "  provider        : ${NEOSOLVER_PROVIDER_URL:-<unset>}"
  log "  provider key    : [REDACTED] (set; never logged or returned)"
  log "  model           : ${NEOSOLVER_MODEL:-<unset>}"

  if [ "${NEOSOLVER_ALLOW_ANON:-}" = "1" ]; then
    log "  token           : ANON (NEOSOLVER_ALLOW_ANON=1 — no token required)"
    log "  client one-liner: curl -s http://${_reach}:${_port} -T tests.js | sh"
    warn ""
    warn "WARNING: client authentication is DISABLED. Anyone who can reach this"
    warn "         port can spend your provider credits. Only safe behind a proxy."
    warn ""
  else
    log "  token           : ${NEOSOLVER_TOKEN:-<unset>} (chosen by you — short is fine)"
    log "  client one-liner: curl -s http://${_reach}:${_port}/s/${NEOSOLVER_TOKEN:-<unset>} -T tests.js | sh"
  fi
  return 0
}

start_service() {
  _detach=$1

  load_env
  check_required || exit 1

  if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    warn "NeoSolver: '$NODE_BIN' not found in PATH. Node >= 20 is required."
    exit 1
  fi
  if [ ! -f "$SCRIPT_DIR/$ENTRY" ]; then
    warn "NeoSolver: $ENTRY is missing from $SCRIPT_DIR."
    exit 1
  fi

  # Final authority: the service's own loader (it also resolves the key).
  if ! "$NODE_BIN" "$SCRIPT_DIR/$ENTRY" --check-config >/dev/null 2>&1; then
    warn "NeoSolver: configuration rejected by the service:"
    "$NODE_BIN" "$SCRIPT_DIR/$ENTRY" --check-config 2>&1 >/dev/null | sed 's/^/  /' >&2
    exit 1
  fi

  _existing=$(pid_from_file) || _existing=""
  if [ -n "$_existing" ] && is_neosolver_pid "$_existing"; then
    warn "NeoSolver: already running (pid $_existing)."
    warn "Use './start.sh restart' to restart it, or './start.sh stop' to stop it."
    exit 1
  fi
  if [ -n "$_existing" ] || [ -f "$PIDFILE" ]; then
    log "NeoSolver: removing stale pidfile ($PIDFILE)."
    rm -f "$PIDFILE"
  fi

  print_banner

  if [ "$_detach" = "yes" ]; then
    mkdir -p "$LOGDIR" || exit 1
    # The service owns its own log file (NEOSOLVER_LOG_FILE, with rotation), so
    # stderr goes to a separate file. It then carries only what never reached the
    # logger: crash traces, or output written before the logger opened.
    STDERRLOG="$LOGDIR/neosolver.stderr"
    log "NeoSolver: starting in the background."
    log "NeoSolver: service log: ${NEOSOLVER_LOG_FILE:-$STDERRLOG}"
    log "NeoSolver: crash output: $STDERRLOG"
    NEOSOLVER_PIDFILE="$PIDFILE" nohup "$NODE_BIN" "$ENTRY" serve >>"$STDERRLOG" 2>&1 &
    _pid=$!
    printf '%s\n' "$_pid" >"$PIDFILE"
    sleep 1
    if is_neosolver_pid "$_pid"; then
      log "NeoSolver: running (pid $_pid)."
      return 0
    fi
    warn "NeoSolver: failed to start. Last log lines from ${NEOSOLVER_LOG_FILE:-$LOGFILE}:"
    tail -n 20 "${NEOSOLVER_LOG_FILE:-$LOGFILE}" 2>/dev/null >&2
    rm -f "$PIDFILE"
    exit 1
  fi

  log "NeoSolver: starting in the foreground (Ctrl-C to stop) ..."
  printf '%s\n' "$$" >"$PIDFILE"
  NEOSOLVER_PIDFILE="$PIDFILE" exec "$NODE_BIN" "$ENTRY" serve
}

stop_service() {
  _pid=$(pid_from_file) || _pid=""

  if [ -z "$_pid" ]; then
    if [ -f "$PIDFILE" ]; then
      log "NeoSolver: not running (removing stale $PIDFILE)."
      rm -f "$PIDFILE"
    else
      log "NeoSolver: not running (no $PIDFILE)."
    fi
    return 0
  fi

  if ! is_neosolver_pid "$_pid"; then
    log "NeoSolver: pid $_pid from $PIDFILE is not a live NeoSolver; removing stale pidfile."
    rm -f "$PIDFILE"
    return 0
  fi

  log "NeoSolver: stopping pid $_pid ..."
  kill "$_pid" 2>/dev/null

  _waited=0
  while [ "$_waited" -lt 50 ]; do
    kill -0 "$_pid" 2>/dev/null || break
    sleep 0.2
    _waited=$((_waited + 1))
  done

  if kill -0 "$_pid" 2>/dev/null; then
    warn "NeoSolver: pid $_pid still alive after 10s; sending SIGKILL."
    kill -9 "$_pid" 2>/dev/null
    sleep 0.3
  fi

  rm -f "$PIDFILE"
  log "NeoSolver: stopped."
  return 0
}

status_service() {
  load_env
  _host=${NEOSOLVER_HOST:-$DEFAULT_HOST}
  _port=${NEOSOLVER_PORT:-$DEFAULT_PORT}
  _pid=$(pid_from_file) || _pid=""

  if [ -n "$_pid" ] && is_neosolver_pid "$_pid"; then
    log "NeoSolver: running (pid $_pid)"
  else
    log "NeoSolver: stopped"
    if [ -f "$PIDFILE" ]; then
      log "  note: stale pidfile $PIDFILE — run './start.sh stop' to clear it"
    fi
  fi
  log "  bind host : $_host"
  log "  bind port : $_port"

  if command -v curl >/dev/null 2>&1; then
    _health=$(curl -s -m 3 "http://127.0.0.1:${_port}/healthz" 2>/dev/null)
    if [ -n "$_health" ]; then
      log "  GET /healthz: $_health"
    else
      log "  GET /healthz: no response (is the service listening on ${_port}?)"
    fi
  else
    log "  GET /healthz: curl not available"
  fi
  return 0
}

COMMAND=start
DETACH=no

for _arg in "$@"; do
  case "$_arg" in
    start) COMMAND=start ;;
    stop) COMMAND=stop ;;
    restart) COMMAND=restart ;;
    status) COMMAND=status ;;
    -d | --detach) DETACH=yes ;;
    -h | --help | help) COMMAND=help ;;
    *)
      warn "NeoSolver: unknown argument '$_arg'"
      COMMAND=help
      ;;
  esac
done

case "$COMMAND" in
  start) start_service "$DETACH" ;;
  stop) stop_service ;;
  status) status_service ;;
  restart)
    stop_service
    start_service "$DETACH"
    ;;
  *) usage ;;
esac

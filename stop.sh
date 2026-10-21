#!/bin/sh
# Stop the NeoSolver service.
#
#   ./stop.sh            stop the service named in ./neosolver.pid
#   ./stop.sh --help     this text
#
# Thin wrapper over ./start.sh stop so the pidfile logic lives in one place.
# POSIX sh only — no bashisms.

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
NeoSolver — stop

Usage:
  ./stop.sh            Stop the service named in ./neosolver.pid
  ./stop.sh --help     Show this help

Reporting "not running" is not an error; the exit status is 0 either way.
EOF
    exit 0
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$SCRIPT_DIR/start.sh" stop "$@"

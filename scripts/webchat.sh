#!/usr/bin/env bash
# Start/stop the omp-webchat bridge. Meant to be double-clicked through
# `webchat.cmd`, but every action works from a shell too.
#
#   webchat.sh [start]   start if needed, then open the browser (idempotent)
#   webchat.sh stop      stop the server (and its omp child) on the port
#   webchat.sh restart
#   webchat.sh status
#
# Override the port with OMP_WEBCHAT_PORT, the binary with BUN.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${OMP_WEBCHAT_PORT:-7788}"
RUN_DIR="$ROOT/.run"
# One file set per port: two bridges (a second project, a scratch port) must not overwrite each
# other's PID, or `stop` kills the wrong server.
SUFFIX=""
[ "$PORT" = 7788 ] || SUFFIX="-$PORT"
PID_FILE="$RUN_DIR/webchat$SUFFIX.pid"
OUT_LOG="$RUN_DIR/webchat$SUFFIX.log"
ERR_LOG="$RUN_DIR/webchat$SUFFIX.err.log"
URL="http://127.0.0.1:$PORT/"

case "$(uname -s)" in
	MINGW* | MSYS* | CYGWIN*) IS_WIN=1 ;;
	*) IS_WIN=0 ;;
esac

BUN="${BUN:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun.exe")}"

say() { printf '%s\n' "$*"; }

# PIDs listening on the port. Catches a server started by hand, not just ours.
port_pids() {
	if [ "$IS_WIN" = 1 ]; then
		netstat -ano 2>/dev/null | awk -v p=":$PORT" '$2 ~ p"$" && $4 == "LISTENING" { print $5 }' | sort -u
	else
		ss -ltnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p"$" { if (match($0, /pid=[0-9]+/)) print substr($0, RSTART + 4, RLENGTH - 4) }' | sort -u
	fi
}

alive() {
	local pid
	pid="$(cat "$PID_FILE" 2>/dev/null)" || return 1
	[ -n "$pid" ] || return 1
	if [ "$IS_WIN" = 1 ]; then
		# MSYS would rewrite /FI into a path; the flag must reach tasklist verbatim
		MSYS_NO_PATHCONV=1 tasklist /FI "PID eq $pid" /NH 2>/dev/null | grep -q "[[:space:]]$pid[[:space:]]"
	else
		kill -0 "$pid" 2>/dev/null
	fi
}

serving() { curl -fsS --max-time 2 "${URL}api/info" >/dev/null 2>&1; }

open_browser() {
	if [ "$IS_WIN" = 1 ]; then
		cmd //c start "" "$URL" >/dev/null 2>&1
	elif [ "$(uname -s)" = Darwin ]; then
		open "$URL"
	else
		xdg-open "$URL" >/dev/null 2>&1 &
	fi
}

kill_pid() {
	local pid="$1"
	if [ "$IS_WIN" = 1 ]; then
		# /T also takes the omp child down; the server has no console to receive a close signal
		MSYS_NO_PATHCONV=1 taskkill /F /T /PID "$pid" >/dev/null 2>&1
	else
		kill "$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null
	fi
}

start() {
	if serving; then
		say "already running: $URL"
		open_browser
		return 0
	fi
	if [ -n "$(port_pids)" ]; then
		say "error: port $PORT is taken by PID $(port_pids | tr '\n' ' ')— stop it first" >&2
		return 1
	fi
	mkdir -p "$RUN_DIR"
	if ! command -v "$BUN" >/dev/null 2>&1 && [ ! -x "$BUN" ]; then
		say "error: bun not found; set BUN=/path/to/bun" >&2
		return 1
	fi

	say "starting omp-webchat on $URL"
	# `launch.ts` re-spawns the server detached with its stdio on the log files, so closing the
	# shortcut's console (or this shell) leaves it running.
	local pid
	pid="$(cd "$ROOT" && OMP_WEBCHAT_PORT="$PORT" "$BUN" run scripts/launch.ts 2>>"$ERR_LOG" | tr -d '\r' | grep -oE '^[0-9]+$' | tail -n 1)"
	[ -n "$pid" ] || {
		say "error: could not start the server" >&2
		tail -n 20 "$ERR_LOG" >&2 2>/dev/null
		return 1
	}
	printf '%s\n' "$pid" >"$PID_FILE"

	# Wait for the listener rather than trusting the spawn.
	for _ in $(seq 1 40); do
		if serving; then
			say "ready: $URL   (log: $OUT_LOG)"
			open_browser
			return 0
		fi
		if ! alive; then break; fi
		sleep 0.5
	done
	say "error: the server did not answer on $URL" >&2
	say "---- $ERR_LOG ----" >&2
	tail -n 20 "$ERR_LOG" >&2 2>/dev/null
	return 1
}

stop() {
	local pids pid stopped=0
	pids="$(port_pids)"
	if alive; then
		pid="$(cat "$PID_FILE")"
		kill_pid "$pid"
		stopped=1
	fi
	for pid in $pids; do
		kill_pid "$pid"
		stopped=1
	done
	rm -f "$PID_FILE"
	if [ "$stopped" = 1 ]; then
		say "stopped omp-webchat on port $PORT"
	else
		say "not running on port $PORT"
	fi
}

case "${1:-start}" in
	start) start ;;
	stop) stop ;;
	restart)
		stop
		start
		;;
	install)
		# Recreate the desktop shortcuts from this checkout's path.
		if [ "$IS_WIN" != 1 ]; then
			say "install only applies on Windows (desktop shortcuts)" >&2
			exit 2
		fi
		WIN_ROOT="$(cygpath -w "$ROOT" 2>/dev/null || printf '%s' "$ROOT")"
		MSYS_NO_PATHCONV=1 powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$ROOT/scripts/shortcuts.ps1" 2>/dev/null || printf '%s/scripts/shortcuts.ps1' "$ROOT")" -Root "$WIN_ROOT"
		;;
	status)
		if serving; then
			say "running: $URL (pid $(cat "$PID_FILE" 2>/dev/null || port_pids | tr '\n' ' '))"
		else
			say "not running on port $PORT"
			exit 1
		fi
		;;
	*)
		say "usage: webchat.sh [start|stop|restart|status|install]" >&2
		exit 2
		;;
	esac

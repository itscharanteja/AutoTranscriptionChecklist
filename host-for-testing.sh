#!/usr/bin/env bash
# Temporarily exposes this app on the public internet so someone else can test
# it, using Cloudflare's free, no-signup "quick tunnel" (cloudflared).
#
# Why a tunnel is needed at all (not just running the servers):
#  - The browser's microphone API only works over HTTPS (or localhost) -- a
#    tester on another machine needs an HTTPS URL, not http://localhost:3000.
#  - The frontend opens a WebSocket directly to the backend (not proxied
#    through Next.js), so the backend needs its own public URL too, not just
#    the frontend.
#
# Ctrl+C stops everything and tears down both tunnels. Nothing here is
# persistent -- rerun this script for a new (temporary) public URL each time.
set -uo pipefail

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "error: cloudflared not found. Install it first:" >&2
  echo "  brew install cloudflared" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"

if [ ! -d "$BACKEND_DIR/.venv" ]; then
  echo "error: backend/.venv not found. Run this first:" >&2
  echo "  cd backend && python3.12 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" >&2
  exit 1
fi
if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  echo "error: frontend/node_modules not found. Run this first:" >&2
  echo "  cd frontend && npm install" >&2
  exit 1
fi

# Next.js locks dev servers per PROJECT DIRECTORY, not per port -- a second
# `next dev` against this same frontend/ will silently fail to serve (even on
# a different port) if one is already running. Port 8000 conflicts the same
# way for the backend. Catch both here with a clear message instead of
# producing a tunnel that 502s.
if lsof -nP -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "error: port 8000 is already in use (probably your own backend already running)." >&2
  echo "  Stop it first, then rerun this script." >&2
  exit 1
fi
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "error: port 3000 is already in use (probably your own frontend already running)." >&2
  echo "  Stop it first, then rerun this script -- Next.js won't run a second dev" >&2
  echo "  server for the same project even on a different port." >&2
  exit 1
fi

BACKEND_TUNNEL_LOG="$(mktemp)"
FRONTEND_TUNNEL_LOG="$(mktemp)"

# Job control, so each backgrounded job below becomes its own process group --
# lets cleanup() kill a job's children (e.g. uvicorn's reload worker, npm's
# spawned `next` binary), not just the immediate wrapper process.
set -m

BACKEND_PID=""
FRONTEND_PID=""
BACKEND_TUNNEL_PID=""
FRONTEND_TUNNEL_PID=""

cleanup() {
  echo
  echo "Stopping servers and tunnels..."
  [ -n "$BACKEND_PID" ] && kill -- "-$BACKEND_PID" 2>/dev/null
  [ -n "$FRONTEND_PID" ] && kill -- "-$FRONTEND_PID" 2>/dev/null
  [ -n "$BACKEND_TUNNEL_PID" ] && kill -- "-$BACKEND_TUNNEL_PID" 2>/dev/null
  [ -n "$FRONTEND_TUNNEL_PID" ] && kill -- "-$FRONTEND_TUNNEL_PID" 2>/dev/null
  wait 2>/dev/null
  rm -f "$BACKEND_TUNNEL_LOG" "$FRONTEND_TUNNEL_LOG"
}
trap cleanup EXIT INT TERM

wait_for_tunnel_url() {
  local log_file="$1"
  local found=""
  for _ in $(seq 1 30); do
    found=$(grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' "$log_file" | head -1)
    [ -n "$found" ] && break
    sleep 1
  done
  echo "$found"
}

echo "Starting backend -> http://localhost:8000"
(cd "$BACKEND_DIR" && source .venv/bin/activate && exec uvicorn server:app --port 8000) &
BACKEND_PID=$!

echo "Opening a tunnel to the backend..."
cloudflared tunnel --url http://localhost:8000 > "$BACKEND_TUNNEL_LOG" 2>&1 &
BACKEND_TUNNEL_PID=$!

BACKEND_URL="$(wait_for_tunnel_url "$BACKEND_TUNNEL_LOG")"
if [ -z "$BACKEND_URL" ]; then
  echo "error: backend tunnel URL never appeared. Log:" >&2
  cat "$BACKEND_TUNNEL_LOG" >&2
  exit 1
fi
BACKEND_WSS_URL="${BACKEND_URL/https:/wss:}"
echo "Backend tunnel ready: $BACKEND_URL"

echo "Starting frontend -> http://localhost:3000 (pointed at the tunneled backend)"
(cd "$FRONTEND_DIR" && NEXT_PUBLIC_BACKEND_WS_URL="$BACKEND_WSS_URL" exec npm run dev) &
FRONTEND_PID=$!

echo "Opening a tunnel to the frontend..."
cloudflared tunnel --url http://localhost:3000 > "$FRONTEND_TUNNEL_LOG" 2>&1 &
FRONTEND_TUNNEL_PID=$!

FRONTEND_URL="$(wait_for_tunnel_url "$FRONTEND_TUNNEL_LOG")"
if [ -z "$FRONTEND_URL" ]; then
  echo "error: frontend tunnel URL never appeared. Log:" >&2
  cat "$FRONTEND_TUNNEL_LOG" >&2
  exit 1
fi

echo
echo "=================================================================="
echo " Share this URL with your tester:"
echo ""
echo "   $FRONTEND_URL"
echo ""
echo " (This is a free, temporary Cloudflare tunnel -- no uptime guarantee,"
echo " and the URL changes every time you rerun this script.)"
echo "=================================================================="
echo
echo "Press Ctrl+C to stop everything."

wait

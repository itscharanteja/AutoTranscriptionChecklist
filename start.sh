#!/usr/bin/env bash
# Starts the backend (FastAPI/uvicorn) and frontend (Next.js) dev servers together.
# Ctrl+C stops both, including their child processes (uvicorn's --reload worker,
# npm's spawned `next` process).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"

if [ ! -d "$BACKEND_DIR/.venv" ]; then
  echo "error: backend/.venv not found. Run this first:" >&2
  echo "  cd backend && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" >&2
  exit 1
fi

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  echo "error: frontend/node_modules not found. Run this first:" >&2
  echo "  cd frontend && npm install" >&2
  exit 1
fi

# Job control, so each backgrounded job below becomes its own process group --
# lets cleanup() kill a job's children (e.g. uvicorn's reload worker, npm's
# spawned `next` binary), not just the immediate wrapper process.
set -m

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo
  echo "Stopping servers..."
  [ -n "$BACKEND_PID" ] && kill -- "-$BACKEND_PID" 2>/dev/null
  [ -n "$FRONTEND_PID" ] && kill -- "-$FRONTEND_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

echo "Starting backend  -> http://localhost:8000"
(cd "$BACKEND_DIR" && source .venv/bin/activate && exec uvicorn server:app --port 8000 --reload) &
BACKEND_PID=$!

echo "Starting frontend -> http://localhost:3000"
(cd "$FRONTEND_DIR" && exec npm run dev) &
FRONTEND_PID=$!

wait

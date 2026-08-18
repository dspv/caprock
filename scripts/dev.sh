#!/usr/bin/env bash
# Run the Caprock daemon and the Vite dev server together for local development.
# The daemon listens on :4173 (API + WS + embedded UI); Vite serves the live UI on
# :5173 and proxies /v1 to the daemon (see ui/vite.config.ts).
set -euo pipefail
cd "$(dirname "$0")/.."

export CAPROCK_DATA_DIR="${CAPROCK_DATA_DIR:-$PWD/.caprock}"
mkdir -p "$CAPROCK_DATA_DIR"

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

go run ./cmd/caprock up --no-open --no-hooks &
(cd ui && npm run dev) &
wait

#!/bin/sh
# stand.sh <dir> <port> [daemon-binary]
# An isolated daemon for the benchmark: its own HOME, data dir and port, a fake
# `claude` first on PATH, no hooks installed, and one session started through
# POST /v1/agents so it has a PTY the terminals can attach to. Never the live
# daemon. Prints the session id. Stop it with: kill $(cat <dir>/daemon.pid)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
D=$1; PORT=$2; BIN=${3:-caprock}
mkdir -p "$D/home" "$D/data" "$D/work/demo-repo" "$D/bin"
D=$(cd "$D" && pwd)
cp "$here/fake-claude" "$D/bin/claude"
chmod +x "$D/bin/claude"
cd "$D"
HOME="$D/home" CAPROCK_DATA_DIR="$D/data" PATH="$D/bin:/usr/bin:/bin" \
  nohup "$BIN" up --foreground --no-hooks --no-open --port "$PORT" --data-dir "$D/data" > "$D/daemon.log" 2>&1 &
echo $! > "$D/daemon.pid"
i=0
until curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; do
  i=$((i + 1)); [ $i -gt 40 ] && { echo "daemon did not start; see $D/daemon.log" >&2; exit 1; }
  sleep 0.25
done
curl -s -X POST -H 'Content-Type: application/json' "http://127.0.0.1:$PORT/v1/agents" \
  -d "{\"cwd\":\"$D/work/demo-repo\"}" | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p' | tee "$D/sid"

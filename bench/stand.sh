#!/bin/sh
# stand.sh <dir> <port> <daemon-binary> [sessions]
# A throwaway daemon for the benchmark, never the live one: its own HOME, data
# dir, port and service label, the fake `claude` first on PATH, no hooks, no
# update checks, desktop notifications off, the app's global hotkey off. It
# starts <sessions> (default 10) fake sessions through POST /v1/agents, each in
# its own directory work/sNN (its output rate is work/sNN/.fake_lps), and
# seeds one Claude Code transcript for the phone's chat view. Writes
# <dir>/sids (one session id per line) and <dir>/chat-sid.
# Stop it with: kill $(cat <dir>/daemon.pid)
# Ported from the Tauri spike's app/bench/stand.sh (one session).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
D=$1; PORT=$2; BIN=$3; N=${4:-10}
case "$PORT" in 4173|22776) echo "refusing port $PORT: that is a live daemon's port" >&2; exit 1 ;; esac
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is in use (lsof); pick another" >&2; exit 1
fi
mkdir -p "$D/home" "$D/data" "$D/bin"
D=$(cd "$D" && pwd)
BIN=$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")
echo "$BIN" > "$D/daemon.bin"
echo "$PORT" > "$D/port"
cp "$here/fake-claude" "$D/bin/claude"
chmod +x "$D/bin/claude"
cat > "$D/data/config.json" <<EOF
{"port": $PORT, "update_checks": false, "open_browser": false, "notify_approval": false, "notify_finished": false}
EOF
echo '{"accelerator": null}' > "$D/data/app-hotkey.json"
python3 "$here/chat-transcript.py" "$D/home" > "$D/chat-sid"
i=1
while [ $i -le "$N" ]; do
  dir=$(printf '%s/work/s%02d' "$D" $i)
  mkdir -p "$dir"; echo 0 > "$dir/.fake_lps"
  i=$((i + 1))
done
cd "$D"
HOME="$D/home" CAPROCK_DATA_DIR="$D/data" CAPROCK_SERVICE_LABEL=dev.caprock.bench PATH="$D/bin:/usr/bin:/bin" \
  nohup "$BIN" up --foreground --no-hooks --no-open --port "$PORT" --data-dir "$D/data" > "$D/daemon.log" 2>&1 &
echo $! > "$D/daemon.pid"
i=0
until curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; do
  i=$((i + 1)); [ $i -gt 80 ] && { echo "daemon did not start; see $D/daemon.log" >&2; exit 1; }
  sleep 0.25
done
: > "$D/sids"
i=1
while [ $i -le "$N" ]; do
  dir=$(printf '%s/work/s%02d' "$D" $i)
  curl -s -X POST -H 'Content-Type: application/json' "http://127.0.0.1:$PORT/v1/agents" \
    -d "{\"cwd\":\"$dir\"}" | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p' >> "$D/sids"
  i=$((i + 1))
done
[ "$(grep -c . "$D/sids")" -eq "$N" ] || { echo "could not start $N sessions; see $D/daemon.log" >&2; exit 1; }
cat "$D/sids"

#!/bin/sh
# busy-stand.sh <dir> <port> <daemon-binary>
# The stand for busy.mjs (bench/README.md § Typing beside busy agents): a
# throwaway daemon — its own HOME, data dir, port and service label, started
# with `env -i` so no key or setting of the real user leaks in — with three
# projects (alpha, beta, gamma), each holding two fake `claude` sessions and
# one shell: nine tabs. alpha's second session prints 20 lines a second; the
# rest are silent. Writes <dir>/tabs, one "<project-id> <kind> <session-id>
# <name> <cwd>" per line.
#
# busy-stand.sh stop <daemon-binary>
# Kills (-9) the daemon, every pty-host it ran and the sessions under them.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = stop ]; then
  pids=$(pgrep -f "$2" || true)
  all="$pids"
  for p in $pids; do
    kids=$(pgrep -P "$p" || true)
    all="$all $kids"
    for k in $kids; do all="$all $(pgrep -P "$k" || true)"; done
  done
  # shellcheck disable=SC2086
  [ -n "$(echo $all)" ] && kill -9 $all 2>/dev/null || true
  exit 0
fi
D=$1; PORT=$2; BIN=$3
case "$PORT" in 4173|22776) echo "refusing port $PORT: that is a live daemon's port" >&2; exit 1 ;; esac
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is in use; pick another" >&2; exit 1; fi
case "$D/" in
  "$HOME"/Desktop/*|"$HOME"/Documents/*|"$HOME"/Downloads/*)
    echo "refusing $D: under Desktop, Documents or Downloads (macOS asks about those); use \$TMPDIR" >&2; exit 1 ;;
esac
# Only ever replaces a stand of its own.
if [ -n "$(ls -A "$D" 2>/dev/null)" ] && [ ! -f "$D/.busy-stand" ]; then
  echo "refusing $D: not empty and not a stand this script made" >&2; exit 1
fi
rm -rf "$D"; mkdir -p "$D/home" "$D/data" "$D/bin"; : > "$D/.busy-stand"
D=$(cd "$D" && pwd)
BIN=$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")
cp "$here/fake-claude" "$D/bin/claude"; chmod +x "$D/bin/claude"
cat > "$D/data/config.json" <<EOF
{"port": $PORT, "update_checks": false, "open_browser": false, "notify_approval": false, "notify_finished": false}
EOF
echo '{"accelerator": null}' > "$D/data/app-hotkey.json"
for p in alpha beta gamma; do mkdir -p "$D/work/$p"; echo -1 > "$D/work/$p/.fake_lps"; done
cd "$D"
env -i HOME="$D/home" CAPROCK_DATA_DIR="$D/data" CAPROCK_SERVICE_LABEL=dev.caprock.busybench \
  PATH="$D/bin:/usr/bin:/bin" TERM=xterm-256color SHELL=/bin/zsh \
  nohup "$BIN" up --foreground --no-hooks --no-open --port "$PORT" --data-dir "$D/data" > "$D/daemon.log" 2>&1 &
echo $! > "$D/daemon.pid"
i=0
until curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; do
  i=$((i + 1)); [ $i -gt 80 ] && { echo "daemon did not start; see $D/daemon.log" >&2; exit 1; }
  sleep 0.25
done
: > "$D/tabs"
for p in alpha beta gamma; do
  pid=$(curl -s -X POST -H 'Content-Type: application/json' "http://127.0.0.1:$PORT/v1/projects" -d "{\"path\":\"$D/work/$p\"}" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("project") or d)["id"])')
  for k in 1 2; do
    mkdir -p "$D/work/$p/s$k"
    rate=-1; [ "$p" = alpha ] && [ $k = 2 ] && rate=20
    echo $rate > "$D/work/$p/s$k/.fake_lps"
    sid=$(curl -s -X POST -H 'Content-Type: application/json' "http://127.0.0.1:$PORT/v1/agents" -d "{\"cwd\":\"$D/work/$p/s$k\"}" \
      | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p')
    echo "$pid session $sid $p-s$k $D/work/$p/s$k" >> "$D/tabs"
  done
  sh=$(curl -s -X POST -H 'Content-Type: application/json' "http://127.0.0.1:$PORT/v1/shells" -d "{\"project_id\":$pid}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["shell"]["id"])')
  echo "$pid shell $sh $p-shell $D/work/$p" >> "$D/tabs"
done
[ "$(grep -c . "$D/tabs")" -eq 9 ] || { echo "could not open nine tabs; see $D/daemon.log" >&2; exit 1; }
cat "$D/tabs"

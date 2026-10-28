#!/bin/sh
# stand.sh <dir> <port> <daemon-binary> [sessions] [db-copy]
# A preview daemon for the window-memory run (bench/README.md § The window's memory): env -i, its own
# HOME, data dir, port and service label, the file secret store, the fake
# claude first on PATH (bench/fake-claude for a session, testdata/fakeclaude
# for a headless -p call), GIT_OPTIONAL_LOCKS=0 so a git status on a project
# from a copied DB never rewrites that repo's index. [db-copy] is a database
# to start from (a copy, made with `sqlite3 -readonly <live db> "VACUUM INTO
# '<copy>'"`; never the live file), cloned into the stand.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
R=$(cd "$here/../.." && pwd)
D=$1; PORT=$2; BIN=$3; N=${4:-8}; DB=${5:-}
case "$PORT" in 4173|22776) echo "refusing live port" >&2; exit 1 ;; esac
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT in use" >&2; exit 1; fi
rm -rf "$D"
mkdir -p "$D/home" "$D/data" "$D/bin" "$D/tmp"
D=$(cd "$D" && pwd)
echo "$BIN" > "$D/daemon.bin"
echo "$PORT" > "$D/port"
[ -n "$DB" ] && cp -c "$DB" "$D/data/caprock.db"
cp "$R/bench/fake-claude" "$D/bin/fake-tui"
chmod +x "$D/bin/fake-tui"
# -p (Second Brain's headless call) goes to testdata/fakeclaude; a session to the busy TUI fake.
(cd "$R" && go build -o "$D/bin/fakeclaude-go" ./testdata/fakeclaude)
cat > "$D/bin/claude" <<EOF
#!/bin/sh
for a in "\$@"; do case "\$a" in -p|--print) exec "$D/bin/fakeclaude-go" "\$@" ;; esac; done
exec "$D/bin/fake-tui" "\$@"
EOF
chmod +x "$D/bin/claude"
cat > "$D/data/config.json" <<EOF
{"port": $PORT, "update_checks": false, "open_browser": false, "notify_approval": false, "notify_finished": false}
EOF
echo '{"accelerator": null}' > "$D/data/app-hotkey.json"
echo '{"background": false}' > "$D/data/app.json"
i=1
while [ $i -le "$N" ]; do
  dir=$(printf '%s/work/s%02d' "$D" $i)
  mkdir -p "$dir"; echo 0 > "$dir/.fake_lps"
  i=$((i + 1))
done
cd "$D"
env -i HOME="$D/home" TMPDIR="$D/tmp" CAPROCK_DATA_DIR="$D/data" CAPROCK_SECRET_STORE=file \
  CAPROCK_SERVICE_LABEL=dev.caprock.memtest GIT_OPTIONAL_LOCKS=0 PATH="$D/bin:/usr/bin:/bin" \
  nohup "$BIN" up --foreground --no-hooks --no-open --port "$PORT" --data-dir "$D/data" > "$D/daemon.log" 2>&1 &
echo $! > "$D/daemon.pid"
i=0
until curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; do
  i=$((i + 1)); [ $i -gt 400 ] && { echo "daemon did not start; see $D/daemon.log" >&2; exit 1; }
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
cat "$D/sids"

#!/bin/sh
# run-linux.sh [--no-build] [--runs N] [--port P] [--work DIR] [--out DIR]
# The Linux counterpart of run-macos.sh, for a machine nobody is using
# (Ubuntu 24.04 under GNOME, Wayland and X11 — .ai/22-app-plan.md § Definition
# of done). Written for WP-16; not yet run on Linux.
#
# Differences from macOS:
#   - the app is the release executable (no bundle copy); it opens on screen,
#   - procs-linux.py measures the app's process tree (WebKitGTK's processes are
#     its children); footprint is PSS, disk is /proc/<pid>/io write_bytes,
#   - the hidden-window CPU row is not scripted (the snapshot build hides its
#     window on macOS only),
#   - the app reads the throwaway HOME; XAUTHORITY and the display variables
#     are passed through from this shell.
# Needs: Go, Node 22, Rust, WebKitGTK 4.1 (app/README.md), google-chrome
# (or CHROME=<path>) for the phone harness.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
RUNS=2; PORT=4393; BUILD=1
WORK=${TMPDIR:-/tmp}/caprock-bench
OUT=$here/results-$(date +%F)-linux
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --runs) RUNS=$2; shift ;;
    --port) PORT=$2; shift ;;
    --work) WORK=$2; shift ;;
    --out) OUT=$2; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$WORK" "$OUT"
WORK=$(cd "$WORK" && pwd); OUT=$(cd "$OUT" && pwd)
export TMPDIR="$WORK"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"
PATH="$HOME/.cargo/bin:$PATH"

if [ "$BUILD" = 1 ]; then
  (cd "$repo" && make ui && go build -o "$WORK/caprock" ./cmd/caprock && make app-sidecar)
  (cd "$repo/app" && { [ -d node_modules ] || npm ci; } && npx tauri build --bundles deb --features snapshot)
fi
EXE="$repo/app/src-tauri/target/release/caprock-app"
DEB=$(ls "$repo"/app/src-tauri/target/release/bundle/deb/*.deb 2>/dev/null | head -1 || true)
python3 - "$DEB" > "$OUT/size.json" <<'EOF'
import json, os, sys
p = sys.argv[1]
print(json.dumps({"dmg_mb": round(os.path.getsize(p) / 2**20, 1) if p else None, "note": "the .deb (download size row)"}))
EOF
node -e 'import("'"$here"'/lib.mjs").then((m) => console.log(JSON.stringify(m.machineInfo(), null, 2)))' > "$OUT/machine.json"

r=1
while [ "$r" -le "$RUNS" ]; do
  D="$WORK/stand-r$r"
  rm -rf "$D"
  "$here/stand.sh" "$D" "$PORT" "$WORK/caprock" 10 > /dev/null
  node "$here/app.mjs" --stand "$D" --app "$EXE" --out "$OUT/app-r$r.json" || echo "app harness run $r failed" >&2
  node "$here/phone.mjs" --stand "$D" --out "$OUT/phone-r$r.json" || echo "phone harness run $r failed" >&2
  kill "$(cat "$D/daemon.pid")" 2>/dev/null || true
  sleep 1
  pkill -f "$D/" 2>/dev/null || true
  r=$((r + 1))
done
python3 "$here/report.py" "$OUT" > "$OUT/summary.md"
cat "$OUT/summary.md"

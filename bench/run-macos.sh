#!/bin/sh
# run-macos.sh [--no-build] [--runs N] [--port P] [--work DIR] [--out DIR] [--phases a,b] [--no-phone]
# Every budget row of .ai/21-app.md § Budgets on this Mac, in one command
# (bench/README.md):
#   1. builds the daemon and a `--features snapshot` app bundle from this checkout,
#   2. copies the bundle under another bundle id (dev.caprock.bench), re-signs
#      it ad hoc, and never launches the installed Caprock.app,
#   3. per run: a throwaway stand (stand.sh) on a free port, the app harness
#      (app.mjs) and the phone harness (phone.mjs), then the stand is stopped,
#   4. writes <out>/app-rN.json, phone-rN.json, size.json, machine.json and
#      summary.md (report.py).
# Defaults: 2 runs, port 4393, work dir $TMPDIR/caprock-bench, out bench/results-<today>.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
RUNS=2; PORT=4393; BUILD=1; PHASES=""; PHONE=1
WORK=${TMPDIR:-/tmp}/caprock-bench
OUT=$here/results-$(date +%F)
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --runs) RUNS=$2; shift ;;
    --port) PORT=$2; shift ;;
    --work) WORK=$2; shift ;;
    --out) OUT=$2; shift ;;
    --phases) PHASES=$2; shift ;;
    --no-phone) PHONE=0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$WORK" "$OUT"
WORK=$(cd "$WORK" && pwd); OUT=$(cd "$OUT" && pwd)
export TMPDIR="$WORK"   # Chrome's throwaway profile lands here too
PATH="$HOME/.cargo/bin:$PATH"

if [ "$BUILD" = 1 ]; then
  (cd "$repo" && make ui && go build -o "$WORK/caprock" ./cmd/caprock && make app-sidecar)
  (cd "$repo/app" && { [ -d node_modules ] || npm ci; } && npx tauri build --bundles app --features snapshot)
fi
COPY="$WORK/Caprock Bench.app"
rm -rf "$COPY"
cp -R "$repo/app/src-tauri/target/release/bundle/macos/Caprock.app" "$COPY"
plutil -replace CFBundleIdentifier -string dev.caprock.bench "$COPY/Contents/Info.plist"
plutil -replace CFBundleName -string "Caprock Bench" "$COPY/Contents/Info.plist"
codesign --force --deep -s - "$COPY"

# Download size: the bundle as the release ships it (a compressed .dmg made
# with hdiutil, which needs no Finder), without the snapshot feature's few KB
# mattering at this scale.
rm -f "$WORK/size.dmg"
hdiutil create -quiet -format UDZO -srcfolder "$repo/app/src-tauri/target/release/bundle/macos/Caprock.app" -volname Caprock "$WORK/size.dmg"
python3 - "$WORK/size.dmg" "$COPY" "$repo" > "$OUT/size.json" <<'EOF'
import json, os, subprocess, sys
dmg, app = sys.argv[1], sys.argv[2]
kb = int(subprocess.run(["du", "-sk", app], capture_output=True, text=True).stdout.split()[0])
out = {"dmg_mb": round(os.path.getsize(dmg) / 2**20, 1), "app_mb": round(kb / 1024, 1), "note": "hdiutil UDZO of this build's .app (arm64, with the snapshot feature)"}
# The shipped universal .dmg of the latest release, when gh can see it.
try:
    r = subprocess.run(["gh", "release", "view", "--json", "tagName,assets"], capture_output=True, text=True, cwd=sys.argv[3])
except OSError:
    r = subprocess.CompletedProcess([], 1)
if r.returncode == 0:
    rel = json.loads(r.stdout)
    for a in rel["assets"]:
        if a["name"].endswith(".dmg"):
            out.update(release_dmg_mb=round(a["size"] / 2**20, 1), download_note=f"macOS, {a['name']}")
print(json.dumps(out))
EOF

node -e 'import("'"$here"'/lib.mjs").then((m) => console.log(JSON.stringify(m.machineInfo(), null, 2)))' > "$OUT/machine.json"

r=1
while [ "$r" -le "$RUNS" ]; do
  D="$WORK/stand-r$r"
  rm -rf "$D"
  "$here/stand.sh" "$D" "$PORT" "$WORK/caprock" 10 > /dev/null
  node "$here/app.mjs" --stand "$D" --app "$COPY" --out "$OUT/app-r$r.json" ${PHASES:+--phases "$PHASES"} || echo "app harness run $r failed" >&2
  [ "$PHONE" = 0 ] || node "$here/phone.mjs" --stand "$D" --out "$OUT/phone-r$r.json" || echo "phone harness run $r failed" >&2
  kill "$(cat "$D/daemon.pid")" 2>/dev/null || true
  sleep 1
  pkill -f "$D/" 2>/dev/null || true   # the stand's sessions and their terminal holders
  r=$((r + 1))
done
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$COPY" 2>/dev/null || true
python3 "$here/report.py" "$OUT" > "$OUT/summary.md"
cat "$OUT/summary.md"

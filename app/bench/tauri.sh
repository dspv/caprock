#!/bin/sh
# tauri.sh <stand-dir> <out.json> <keys> <lines-per-second> <term|dash|idle> [extra app args...]
# Runs the Tauri app's built-in typing benchmark (src-tauri/src/bench.rs)
# against a stand made by stand.sh. BENCH_T0 is the wall clock just before
# launching, for cold start to first echo. Launched through LaunchServices in
# the background (open -g): the app is then its own "responsible process", so
# WebKit's helper processes are charged to it (procs.py), and it never takes
# focus. Keys are injected in-process into the app's own window only.
#   APP=<path to .app> overrides the bundle.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
D=$1; OUT=$2; KEYS=$3; LPS=$4; MODE=$5
shift 5
APP=${APP:-"$here/src-tauri/target/release/bundle/macos/Caprock Spike.app"}
echo "$LPS" > "$D/work/demo-repo/.fake_lps"
rm -f "$OUT"
PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$D/data/runtime.json")
python3 -c '
import os, sys, time
t0 = repr(time.time() * 1000)
os.execvp("open", ["open", "-g", "-n", "-W", "--env", "BENCH_T0=" + t0] + sys.argv[1:])' \
  --env "BENCH_PROCS=$here/bench/procs.py" --env "BENCH_LPS=$LPS" "$APP" --args --port "$PORT" --sid "$(cat "$D/sid")" \
  --bench-out "$OUT" --bench-keys "$KEYS" --bench-mode "$MODE" "$@"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print({k: d.get(k) for k in ("client","lps","n","timeouts","paint_p50_ms","paint_p95_ms","socket_p50_ms","keydown_p50_ms","ipc_report_p50_ms","pane_to_first_echo_paint_ms","nav_to_first_echo_paint_ms","launch_to_first_echo_paint_ms","warm_open_to_first_echo_paint_ms","watch_cpu_pct","rss_mb_end","renderer","cols","rows","timer_res_ms")})' "$OUT"

#!/bin/sh
# run-tauri.sh <stand-dir> <out-dir>: the spike's Tauri matrix.
set -u
here=$(cd "$(dirname "$0")" && pwd)
D=$1; O=$(cd "$2" && pwd)
for r in 1 2; do
  for lps in 0 200 1000; do
    for mode in term dash; do
      "$here/tauri.sh" "$D" "$O/tauri-$mode-$lps-r$r.json" 100 "$lps" "$mode" --bench-watch 20 --bench-warm-opens 3 || echo "failed $mode $lps $r"
      sleep 2
    done
  done
  "$here/tauri.sh" "$D" "$O/tauri-idle-0-r$r.json" 0 0 idle --bench-watch 30 || echo "failed idle $r"
done
echo 0 > "$D/work/demo-repo/.fake_lps"

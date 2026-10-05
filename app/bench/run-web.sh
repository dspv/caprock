#!/bin/sh
# run-web.sh <stand-dir> <out-dir>: the web dashboard in Chrome (web.mjs), same matrix.
set -u
here=$(cd "$(dirname "$0")" && pwd)
D=$1; O=$(cd "$2" && pwd)
PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$D/data/runtime.json")
for r in 1 2; do
  for lps in 0 200 1000; do
    echo "$lps" > "$D/work/demo-repo/.fake_lps"
    node "$here/web.mjs" "$PORT" "$(cat "$D/sid")" master 100 20 > "$O/web-master-$lps-r$r.json" || echo "failed web $lps $r"
    sleep 2
  done
done
echo 0 > "$D/work/demo-repo/.fake_lps"

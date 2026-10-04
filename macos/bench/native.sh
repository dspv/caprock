#!/bin/sh
# native.sh <stand-dir> <out.json> <keys> <lines-per-second> [extra app args...]
# Runs the app's built-in typing benchmark (Sources/CaprockMac/Bench.swift)
# against a stand made by stand.sh. The fake claude reads its output rate from
# <stand>/work/demo-repo/.fake_lps.
#   extra args used for the spike's table: --bench-size 1645x660 --bench-watch 20 [--bench-metal]
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
D=$1; OUT=$2; KEYS=$3; LPS=$4
shift 4
echo "$LPS" > "$D/work/demo-repo/.fake_lps"
rm -f "$OUT"
"$here/build/Caprock.app/Contents/MacOS/Caprock" --data-dir "$D/data" --bench-session "$(cat "$D/sid")" \
  --bench-out "$OUT" --bench-keys "$KEYS" --bench-quit "$@"
cat "$OUT"

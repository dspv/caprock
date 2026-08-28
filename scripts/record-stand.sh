#!/usr/bin/env bash
#
# Serve a scrubbed dashboard to record video from, and hold it open.
#
# The screenshots have a scrubber; video did not, and the difference matters
# more here: a screenshot can be replaced after posting and a video cannot. The
# script note for the first video says "rename the projects before recording",
# which is a manual step nobody will remember at 1am.
#
# So this does what `make shots` does — snapshot the database, rename every
# project that is not on the allow-list, rewrite the activity feed — and then
# stops, leaving a daemon running on its own port with its own copy. Record
# from that. Ctrl-C tears it down.
#
# The live daemon on 4173 is never touched: this reads its database through
# sqlite's own backup and serves a copy.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PORT="${CAPROCK_RECORD_PORT:-4291}"
WORK="$(mktemp -d)"

DATA_DIR="${CAPROCK_DATA_DIR:-$HOME/Library/Application Support/caprock}"
if [ ! -f "$DATA_DIR/caprock.db" ]; then
  echo "no database at $DATA_DIR/caprock.db — set CAPROCK_DATA_DIR" >&2
  exit 1
fi

# The published binary by default, so what is recorded is what a viewer will
# install. CAPROCK_RECORD_BIN overrides it for showing something unreleased.
BIN="${CAPROCK_RECORD_BIN:-$(command -v caprock || true)}"
if [ -z "$BIN" ]; then
  make build-go >/dev/null
  BIN="./bin/caprock"
fi

cleanup() {
  echo
  echo "→ stopping the recording stand"
  HOME="$WORK/home" CAPROCK_DATA_DIR="$WORK/data" "$BIN" down >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

echo "→ snapshotting the database (read-only; the live one is untouched)"
mkdir -p "$WORK/data"
sqlite3 "$DATA_DIR/caprock.db" ".backup '$WORK/data/caprock.db'"

echo "→ preparing the scrubber"
python3 -m venv "$WORK/venv" >/dev/null
"$WORK/venv/bin/pip" install --quiet websocket-client

echo "→ scrubbing project names and the activity feed"
# shots.py refuses to run if the scrub fails, and its scrub is the same one
# the published screenshots go through. Reusing it means video and stills can
# never disagree about what is safe to show.
CAPROCK_SHOT_DB="$WORK/data/caprock.db" "$WORK/venv/bin/python" - <<'PY'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("shots", "scripts/shots.py")
m = importlib.util.module_from_spec(spec)
sys.argv = ["shots.py"]
spec.loader.exec_module(m)
if not m.scrub():
    print("refusing to serve: the database was not scrubbed", file=sys.stderr)
    sys.exit(1)
PY

echo "→ starting the stand on :$PORT"
# A HOME of its own, with an empty ~/.claude/projects.
#
# This is the part that took three wrong theories to find. The daemon reads
# transcripts from $HOME/.claude/projects and backfills whatever it finds — so
# a stand started on a scrubbed copy immediately re-ingested the real
# transcripts and put every real path straight back. The scrub was working
# perfectly; the daemon was undoing it a second later.
#
# Pointing HOME at an empty directory leaves it nothing to read, so the copy
# stays exactly as the scrub left it.
mkdir -p "$WORK/home/.claude/projects"

# Hooks are installed into that throwaway HOME rather than suppressed.
#
# The dashboard shows a "hooks not installed" banner when they are missing,
# and it is telling the truth — so the fix is to not be missing them, not to
# hide the warning. Editing the real ~/.claude/settings.json for a recording
# would be unacceptable; editing one inside a temp directory that is deleted
# on Ctrl-C is free.
HOME="$WORK/home" "$BIN" up --no-open --yes --port "$PORT" --data-dir "$WORK/data" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do
  curl -sf "http://127.0.0.1:$PORT/v1/status" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sf "http://127.0.0.1:$PORT/v1/status" >/dev/null 2>&1; then
  echo "the stand did not come up on :$PORT" >&2
  exit 1
fi

cat <<EOF

  Recording stand ready:  http://127.0.0.1:$PORT

  Real figures, scrubbed project names. Record from this window, not from
  4173 — the live dashboard has your repository names on it, and a video
  cannot be replaced after it is posted.

  Ctrl-C when you are done.

EOF

# Hold until interrupted. The trap tears the stand down.
while true; do sleep 3600; done

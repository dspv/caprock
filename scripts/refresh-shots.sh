#!/usr/bin/env bash
#
# Re-take every documented screenshot and open a PR with the result.
#
# The screenshots go stale silently: a release changes a screen, and the README
# and the site keep showing the previous one until somebody notices. Nobody
# notices, because the person reading the README is the person who has never
# seen the product.
#
# This is deliberately not a CI job. The shots are taken against a copy of a
# real database — that is what makes them worth showing — and CI has no such
# database. Generating a plausible one would put invented figures in front of
# the public, which rule 6 forbids. So it runs where the data is, on a machine
# that already has Caprock installed, and its output arrives as a PR that a
# person looks at before it is merged.
#
# Usage:
#   scripts/refresh-shots.sh            # capture, commit to a branch, open a PR
#   scripts/refresh-shots.sh --no-pr    # capture and commit only
#   scripts/refresh-shots.sh --dry-run  # capture into a temp dir, change nothing
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# A port of its own: the daemon serving the shots reads a copy of the database
# and must not be the one the user is looking at.
PORT=4290
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

DRY_RUN=0
OPEN_PR=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-pr) OPEN_PR=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# The live database, read through sqlite's own backup rather than copied: a
# plain `cp` of a database being written to yields a file that may not open.
DATA_DIR="${CAPROCK_DATA_DIR:-$HOME/Library/Application Support/caprock}"
if [ ! -f "$DATA_DIR/caprock.db" ]; then
  echo "no database at $DATA_DIR/caprock.db — set CAPROCK_DATA_DIR" >&2
  exit 1
fi

echo "→ snapshotting the database (read-only; the live one is untouched)"
mkdir -p "$WORK/data"
sqlite3 "$DATA_DIR/caprock.db" ".backup '$WORK/data/caprock.db'"

# The published binary, not a working tree build: the header carries the
# version, and a README showing "dev build" tells the reader they are looking
# at something unreleased. CAPROCK_SHOT_BIN overrides it for testing an
# unreleased change.
SHOT_BIN="${CAPROCK_SHOT_BIN:-$(command -v caprock || true)}"
if [ -z "$SHOT_BIN" ]; then
  echo "→ no installed caprock on PATH; building one"
  make build-go >/dev/null
  SHOT_BIN="./bin/caprock"
fi
echo "→ shooting with $SHOT_BIN ($("$SHOT_BIN" --version))"

# --no-hooks so a throwaway daemon never edits the user's Claude Code settings.
echo "→ starting a daemon on :$PORT against the copy"
"$SHOT_BIN" up --no-open --no-hooks --port "$PORT" --data-dir "$WORK/data" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do
  curl -sf "http://127.0.0.1:$PORT/v1/status" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sf "http://127.0.0.1:$PORT/v1/status" >/dev/null 2>&1; then
  echo "the shot daemon did not come up on :$PORT" >&2
  exit 1
fi
# Stop it through the CLI rather than by hitting /v1/shutdown directly: that
# endpoint is gated by a per-run token, and `caprock down` is the thing that
# knows how to present it. CAPROCK_DATA_DIR points it at the throwaway daemon,
# so this can never stop the one the user is looking at.
stop_shot_daemon() {
  CAPROCK_DATA_DIR="$WORK/data" "$SHOT_BIN" down >/dev/null 2>&1 || true
}
trap 'stop_shot_daemon; rm -rf "$WORK"' EXIT

# websocket-client drives Chrome's debugging protocol and is not a dependency
# of anything else here, so it lives in a throwaway venv.
echo "→ preparing the capture environment"
python3 -m venv "$WORK/venv" >/dev/null
"$WORK/venv/bin/pip" install --quiet websocket-client

OUT="$WORK/out"
mkdir -p "$OUT"
echo "→ capturing"
# shots.py refuses to run if it cannot scrub the database first: publishing a
# screenshot of real repository names is not a thing to discover afterwards.
CAPROCK_SHOT_DB="$WORK/data/caprock.db" "$WORK/venv/bin/python" \
  scripts/shots.py "http://localhost:$PORT" "$OUT"

if [ "$DRY_RUN" = "1" ]; then
  echo "→ dry run: shots are in $OUT (kept until this shell exits)"
  trap - EXIT
  echo "$OUT"
  exit 0
fi

echo "→ updating docs/"
cp "$OUT"/*.png docs/

# The site keeps its own copy on purpose: pulling from master would mean this
# script changes what is published on caprock.dev, and a screenshot refresh
# should not be able to do that on its own.
SITE="${CAPROCK_WEB:-$REPO_ROOT/../caprock-web}"
if [ -d "$SITE/public" ]; then
  echo "→ copying into the site's own copy at $SITE/public/shots/"
  mkdir -p "$SITE/public/shots"
  cp "$OUT"/*.png "$SITE/public/shots/"
  echo "  (commit those separately — this script does not touch the site's git)"
fi

if ! git diff --quiet -- docs/; then
  BRANCH="shots/$(git describe --tags --abbrev=0 2>/dev/null || date +%Y-%m-%d)"
  echo "→ committing to $BRANCH"
  git checkout -q -b "$BRANCH" 2>/dev/null || git checkout -q "$BRANCH"
  git add docs/*.png
  git commit -q -m "docs(shots): refresh the dashboard screenshots

Taken against a copy of a real database, with project names and paths
scrubbed by scripts/shots.py.

Claude-Session: https://claude.ai/code/session_01DR8fggA2LRHcjNWUsqtDcF"
  if [ "$OPEN_PR" = "1" ]; then
    git push -q -u origin "$BRANCH"
    gh pr create --fill --title "docs(shots): refresh the dashboard screenshots" \
      --body "Re-taken on $(git describe --tags --abbrev=0 2>/dev/null || echo 'the current build').

Look at the images before merging: the scrubber renames project directories,
and a name it has never seen is renamed rather than published, but the only
real check is a person looking at what is about to be public."
  fi
else
  echo "→ no visible change; nothing to commit"
fi

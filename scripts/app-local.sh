#!/usr/bin/env bash
#
# Build the macOS app from this checkout and put it in place of the installed
# one, for trying a change without a release (`make app-local`). The app then
# swaps its own daemon for the one it carries (ADR-040), so the daemon is the
# new build too, and sessions keep running in their pty-hosts (ADR-033).
#
#   make app-local           build, install over /Applications/Caprock.app, relaunch
#   make app-local-revert    back to the released app (and, through it, daemon)
#
# What makes it quick, and what it leaves out:
#
# - The host's architecture only, the .app only: no universal binary, no .dmg.
# - A cargo target directory of its own (app/src-tauri/target/app-local), kept
#   between runs, with the release profile's fat LTO and single codegen unit
#   turned off and incremental compilation on: a change to the shell's own
#   code recompiles one crate instead of re-linking every dependency. Still a
#   release build (no debug assertions, no inspector).
# - CARGO_BUILD_JOBS defaults to 4: this compiles WebKit bindings and swaps
#   on a 16 GB machine with more.
# - The dashboard (ui/) is rebuilt only when its files changed since the last
#   run; a clean ui/ next to the committed internal/api/dist needs no build.
#
# The version is <last tag>-dev+<commit>, with .dirty.<time> when the tree has
# uncommitted changes: About Caprock and the daemon both show it, and the
# update notice does not offer the release it was built after.
#
# Environment:
#   APP_DIR=/Applications    where Caprock.app is installed
#   APP_LAUNCH=open          open (LaunchServices), exec (the executable, with
#                            this environment plus APP_LOCAL_ENV: for an
#                            isolated test copy, see app/README.md), none
#   APP_LOCAL_ENV            KEY=VALUE words added to the app's environment
#                            when APP_LAUNCH=exec (HOME, CAPROCK_DATA_DIR, PATH…)
#   CARGO_BUILD_JOBS=4       parallel rustc jobs
#   CAPROCK_DATA_DIR         the data directory whose daemon to watch
#                            (default: the one the app uses)
#
# Quitting the running copy is SIGTERM to its process, which the app turns
# into its own Quit (src/sigterm.rs); no AppleScript, no System Events.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ "$(uname -s)" != Darwin ]]; then
  echo "app-local: the macOS app only; nothing to do on $(uname -s). Use 'make app' or 'make app-bundle' here."
  exit 0
fi

die() { echo "app-local: $*" >&2; exit 1; }

REVERT=0
case "${1:-}" in
  "") ;;
  --revert) REVERT=1 ;;
  *) die "usage: scripts/app-local.sh [--revert]" ;;
esac

APP_DIR="${APP_DIR:-/Applications}"
APP_LAUNCH="${APP_LAUNCH:-open}"
DEST="$APP_DIR/Caprock.app"
DATA_DIR="${CAPROCK_DATA_DIR:-$HOME/Library/Application Support/caprock}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
export PATH="$HOME/.cargo/bin:$PATH"

T0=$SECONDS
LAST=$SECONDS
step() { # step <label>: announce the next step
  echo "→ $1"
}
took() { # took <label>: how long since the last mark
  local now=$SECONDS
  printf '  %-26s %4ds\n' "$1" $((now - LAST))
  LAST=$now
}

# --- the running daemon, for before/after -----------------------------------
daemon_version() {
  local rt="$DATA_DIR/runtime.json" port
  [[ -f "$rt" ]] || return 0
  port="$(sed -n 's/.*"port":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$rt" | head -1)"
  [[ -n "$port" ]] || return 0
  # /healthz is {"status":"ok","version":…}; /v1/status has other versions too.
  curl -s --max-time 1 "http://127.0.0.1:$port/healthz" \
    | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1
}

# --- quit the installed copy -------------------------------------------------
# Only the process running from $DEST: a test copy elsewhere, or the real app
# while a test copy is replaced, is left alone.
app_pids() {
  local pid cmd
  for pid in $(pgrep -x caprock-app || true); do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    [[ "$cmd" == "$DEST/Contents/MacOS/caprock-app"* ]] && echo "$pid"
  done
  return 0
}

quit_app() {
  local pids
  pids="$(app_pids)"
  [[ -n "$pids" ]] || { echo "  not running"; return 0; }
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 50); do
    [[ -z "$(app_pids)" ]] && { echo "  quit (pid ${pids//$'\n'/ })"; return 0; }
    sleep 0.2
  done
  echo "  did not quit within 10 s; stopping it (sessions run in the daemon, not here)"
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null || true
  sleep 0.5
}

launch_app() {
  case "$APP_LAUNCH" in
    open) open -a "$DEST" ;;
    exec)
      mkdir -p "$REPO_ROOT/app/src-tauri/target/app-local"
      # shellcheck disable=SC2086 # APP_LOCAL_ENV is a list of KEY=VALUE words
      nohup env ${APP_LOCAL_ENV:-} "$DEST/Contents/MacOS/caprock-app" \
        >"$REPO_ROOT/app/src-tauri/target/app-local/app.log" 2>&1 &
      disown
      ;;
    none) echo "  APP_LAUNCH=none: not started" ;;
    *) die "APP_LAUNCH is open, exec or none, not $APP_LAUNCH" ;;
  esac
}

# Waits for the app to put its daemon in place: the version it carries
# answering on the data directory's port.
wait_daemon() {
  local want="$1" have=""
  [[ "$APP_LAUNCH" == none ]] && return 0
  for _ in $(seq 1 120); do
    have="$(daemon_version)"
    [[ "$have" == "$want" ]] && { echo "  daemon $want is running"; return 0; }
    sleep 0.5
  done
  echo "  the daemon still says '${have:-nothing}' after 60 s, not $want."
  echo "  Open the app: it shows what it is doing with the daemon."
  return 1
}

BEFORE="$(daemon_version || true)"

if [[ "$REVERT" == 1 ]]; then
  command -v brew >/dev/null || die "Homebrew is not installed; download the app from https://github.com/dspv/caprock/releases/latest"
  step "quitting $DEST"
  quit_app
  step "reinstalling the released app"
  brew reinstall --cask dspv/tap/caprock-app
  WANT="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist")"
  step "launching Caprock $WANT"
  launch_app
  wait_daemon "$WANT" || true
  echo "daemon ${BEFORE:-not running} → $(daemon_version || true); $((SECONDS - T0)) s"
  exit 0
fi

command -v rustc >/dev/null || die "rustc not found: install Rust with rustup (see app/README.md)"
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"

# --- version ------------------------------------------------------------------
BASE="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || echo v0.0.0)"
BASE="${BASE#v}"
VERSION="$BASE-dev+$(git rev-parse --short=7 HEAD)"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  VERSION="$VERSION.dirty.$(date +%Y%m%dT%H%M%S)"
fi
echo "Caprock $VERSION for $TRIPLE → $DEST"

CACHE="app/src-tauri/target/app-local"
mkdir -p "$CACHE" app/src-tauri/binaries

# --- dashboard ----------------------------------------------------------------
step "dashboard"
ui_print() {
  git ls-files -co --exclude-standard -z -- ui ':!ui/node_modules' \
    | xargs -0 shasum 2>/dev/null | shasum | cut -d' ' -f1
}
PRINT="$(ui_print)"
STAMP="$CACHE/ui.print"
if [[ -f "$STAMP" && "$(cat "$STAMP")" == "$PRINT" ]]; then
  echo "  unchanged since the last build"
elif [[ ! -f "$STAMP" && -z "$(git status --porcelain -- ui internal/api/dist)" ]]; then
  echo "  ui/ and internal/api/dist are as committed: no build needed"
else
  (cd ui && { [[ -d node_modules ]] || npm ci --no-audit --no-fund; } && npm run build --silent)
fi
echo "$PRINT" >"$STAMP"
took "dashboard"

# --- daemon -------------------------------------------------------------------
step "daemon (sidecar)"
CGO_ENABLED=0 go build -trimpath \
  -ldflags "-s -w -X github.com/dspv/caprock/internal/version.Version=$VERSION" \
  -o "app/src-tauri/binaries/caprock-$TRIPLE" ./cmd/caprock
took "daemon"

# --- app ----------------------------------------------------------------------
step "Caprock.app (release, $TRIPLE, CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS)"
(cd app && { [[ -d node_modules ]] || npm ci --no-audit --no-fund; })
(
  cd app
  export CARGO_TARGET_DIR="$REPO_ROOT/$CACHE/cargo"
  export CARGO_PROFILE_RELEASE_LTO=false
  export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
  export CARGO_PROFILE_RELEASE_INCREMENTAL=true
  npx tauri build --bundles app --config "{\"version\":\"$VERSION\"}" 2>&1 \
    | grep -vE '^\s+(Compiling|Running|Fresh) ' || exit "${PIPESTATUS[0]}"
)
BUILT="$CACHE/cargo/release/bundle/macos/Caprock.app"
[[ -d "$BUILT" ]] || die "tauri did not produce $BUILT"
took "app"

# The bundle says what it is, and carries the daemon it was built with.
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$BUILT/Contents/Info.plist"; }
[[ "$(plist CFBundleIdentifier)" == dev.caprock.app ]] || die "bundle id is $(plist CFBundleIdentifier)"
[[ "$(plist CFBundleShortVersionString)" == "$VERSION" ]] || die "app version is $(plist CFBundleShortVersionString), not $VERSION"
SIDECAR="$("$BUILT/Contents/MacOS/caprock" version)"
[[ "$SIDECAR" == "caprock $VERSION "* ]] || die "the bundled daemon says: $SIDECAR"
codesign --verify --deep --strict "$BUILT" || die "the signature does not verify"
# Built here, never downloaded: nothing for Gatekeeper to hold back.
if xattr -r "$BUILT" 2>/dev/null | grep -q com.apple.quarantine; then
  die "the built bundle carries a quarantine flag"
fi

# --- install ------------------------------------------------------------------
step "installing over $DEST"
mkdir -p "$APP_DIR"
NEW="$APP_DIR/.Caprock.app.new"
OLD="$APP_DIR/.Caprock.app.old"
rm -rf "$NEW" "$OLD"
# Copied beside the old one first, so the swap below is two renames on one
# volume and the app is never half there.
ditto "$BUILT" "$NEW"
quit_app
if [[ -d "$DEST" ]]; then
  mv "$DEST" "$OLD"
fi
if ! mv "$NEW" "$DEST"; then
  [[ -d "$OLD" ]] && mv "$OLD" "$DEST"
  die "could not move the new bundle into place; the old one is back"
fi
rm -rf "$OLD"
took "install"

step "launching"
launch_app
wait_daemon "$VERSION" || true
took "daemon swap"

echo
echo "Caprock $VERSION installed in $((SECONDS - T0)) s"
echo "  daemon: ${BEFORE:-not running} → $(daemon_version || true)"
echo "  back to the release: make app-local-revert"

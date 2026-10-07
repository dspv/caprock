#!/usr/bin/env bash
# update-build.sh <work>: the two app builds the update end-to-end check
# (update.mjs) installs one over the other. Both are `--features snapshot`
# builds of this checkout under their own bundle id (dev.caprock.updtest, so
# WebKit storage and the window state are never the real app's), signed with
# a throwaway minisign key made here, pointing the updater at a loopback
# server on port 28741 (plain http, allowed for these builds only).
#
#   <work>/key, key.pub              the throwaway key (password "e2e")
#   <work>/v1/Caprock.app            0.0.1-e2e, the installed app
#   <work>/v2/Caprock_0.0.2-e2e_universal.app.tar.gz(.sig)   the update
#
# Slow (two release builds); CARGO_BUILD_JOBS defaults to 2 so the machine
# stays usable. macOS only.
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { echo "macOS only" >&2; exit 1; }
W="${1:?usage: bench/update-build.sh <work>}"
mkdir -p "$W"; W="$(cd "$W" && pwd)"
case "$W/" in "$HOME"/Desktop/*|"$HOME"/Documents/*|"$HOME"/Downloads/*) echo "refusing $W: a folder macOS guards" >&2; exit 1 ;; esac
R="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH" CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
(cd "$R/app" && { [[ -d node_modules ]] || npm ci; })
[[ -f "$W/key" ]] || (cd "$R/app" && npx tauri signer generate --ci -w "$W/key" -p e2e >/dev/null)
cat > "$W/conf.json" <<JSON
{"identifier": "dev.caprock.updtest",
 "plugins": {"updater": {"pubkey": "$(cat "$W/key.pub")", "endpoints": ["http://127.0.0.1:28741/latest.json"], "dangerousInsecureTransportProtocol": true}},
 "bundle": {"createUpdaterArtifacts": true}}
JSON
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$W/key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=e2e
B="$R/app/src-tauri/target/release/bundle/macos"
build() {
  echo "→ $1" >&2
  (cd "$R" && make app-sidecar VERSION="$1" >/dev/null)
  (cd "$R/app" && npx tauri build --bundles app --features snapshot --config "{\"version\":\"$1\"}" --config "$W/conf.json" >&2)
}
build 0.0.1-e2e
rm -rf "$W/v1" && mkdir -p "$W/v1" && cp -R "$B/Caprock.app" "$W/v1/"
build 0.0.2-e2e
rm -rf "$W/v2" && mkdir -p "$W/v2"
cp "$B/Caprock.app.tar.gz" "$W/v2/Caprock_0.0.2-e2e_universal.app.tar.gz"
cp "$B/Caprock.app.tar.gz.sig" "$W/v2/Caprock_0.0.2-e2e_universal.app.tar.gz.sig"
echo "built: $W/v1/Caprock.app, $W/v2/" >&2

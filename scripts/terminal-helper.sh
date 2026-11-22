#!/usr/bin/env bash
#
# Assemble and sign Caprock Terminal.app, the macOS helper the terminal
# holder runs in (ADR-101), from a built caprock-pty-host.
#
#   scripts/terminal-helper.sh <caprock-pty-host> <out dir> [version]
#
# Writes "<out dir>/Caprock Terminal.app": Contents/Info.plist from
# app/src-tauri/helper/Info.plist (bundle id dev.caprock.terminal, the
# microphone usage string, no Dock icon), Contents/MacOS/caprock-pty-host
# (the binary given, universal or not) and the app's icon. tauri.conf.json's
# bundle.macOS.files puts the result in Caprock.app/Contents/Helpers/, and
# the app installs it beside its daemon in <data_dir>/bin/.
#
# The bundler signs the app and its sidecars but not a nested bundle, and
# signing the app fails on unsigned code inside it, so the helper is signed
# here first, the way the app will be (APPLE_SIGNING_IDENTITY, as
# scripts/app-release.sh describes): the hardened runtime and
# app/src-tauri/helper/Entitlements.plist (com.apple.security.device.audio-input)
# always, and
#
# - "Developer ID Application: …": with a secure timestamp. In GitHub
#   Actions with APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD set (the
#   secrets release.yml passes to app-release.sh, which `tauri build` imports
#   into a keychain of its own later), the certificate is imported into a
#   temporary keychain under RUNNER_TEMP for this one signature, and the
#   keychain is deleted and the search list restored before the script
#   exits, so the bundler meets no second copy of the identity. Elsewhere the
#   identity must already be in a keychain (a release made by hand).
# - a certificate SHA-1 (the self-signed fallback that
#   scripts/macos-selfsign-keychain.sh put on the search list): signed with it.
# - unset or "-": ad-hoc.
#
# macOS only. Raises no dialog: codesign with an ad-hoc identity or with a
# key whose partition list allows it reads no password from anyone.
#
set -euo pipefail

die() { echo "terminal-helper: $*" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXE="${1:-}"
OUT="${2:-}"
VERSION="${3:-0.0.0}"
[[ -f "$EXE" && -n "$OUT" ]] || die "usage: scripts/terminal-helper.sh <caprock-pty-host> <out dir> [version]"
[[ "$(uname -s)" == Darwin ]] || die "the helper is a macOS bundle"
# CFBundleShortVersionString is numbers and dots only: 0.187.0-dev+abc → 0.187.0.
VERSION="$(sed -E 's/^v//; s/[^0-9.].*$//' <<<"$VERSION")"
[[ "$VERSION" =~ ^[0-9]+(\.[0-9]+)*$ ]] || VERSION=0.0.0

SRC="$REPO_ROOT/app/src-tauri/helper"
APP="$OUT/Caprock Terminal.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
sed "s/@VERSION@/$VERSION/g" "$SRC/Info.plist" >"$APP/Contents/Info.plist"
plutil -lint -s "$APP/Contents/Info.plist" || die "Info.plist does not parse"
cp "$EXE" "$APP/Contents/MacOS/caprock-pty-host"
chmod 755 "$APP/Contents/MacOS/caprock-pty-host"
cp "$REPO_ROOT/app/src-tauri/icons/icon.icns" "$APP/Contents/Resources/icon.icns"

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
[[ "$IDENTITY" == "-" ]] && IDENTITY=""
args=(--force --options runtime --entitlements "$SRC/Entitlements.plist")
KC=""
restore_search_list() {
  [[ -n "$KC" ]] || return 0
  security list-keychains -d user -s ${ORIGINAL_LIST[@]+"${ORIGINAL_LIST[@]}"} || true
  security delete-keychain "$KC" || true
  rm -f "$RUNNER_TEMP/caprock-terminal-helper.p12"
}
if [[ "$IDENTITY" == "Developer ID Application: "* ]]; then
  args+=(--timestamp)
  if [[ -n "${APPLE_CERTIFICATE:-}" ]]; then
    [[ "${GITHUB_ACTIONS:-}" == true && -n "${RUNNER_TEMP:-}" ]] ||
      die "APPLE_CERTIFICATE is for CI only; by hand, put the identity in a keychain and unset it"
    [[ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ]] || die "APPLE_CERTIFICATE is set but APPLE_CERTIFICATE_PASSWORD is not"
    KC="$RUNNER_TEMP/caprock-terminal-helper.keychain-db"
    P12="$RUNNER_TEMP/caprock-terminal-helper.p12"
    KC_PW="$(openssl rand -hex 24)"
    ORIGINAL_LIST=()
    while IFS= read -r k; do
      k="${k#"${k%%[![:space:]]*}"}"
      k="${k#\"}"
      k="${k%\"}"
      [[ -n "$k" ]] && ORIGINAL_LIST+=("$k")
    done < <(security list-keychains -d user)
    trap restore_search_list EXIT
    printf '%s' "$APPLE_CERTIFICATE" | base64 --decode >"$P12"
    security create-keychain -p "$KC_PW" "$KC"
    security set-keychain-settings -lut 3600 "$KC"
    security unlock-keychain -p "$KC_PW" "$KC"
    security import "$P12" -k "$KC" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null
    rm -f "$P12"
    # Lets codesign use the key without a dialog.
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PW" "$KC" >/dev/null
    security list-keychains -d user -s "$KC" ${ORIGINAL_LIST[@]+"${ORIGINAL_LIST[@]}"}
    args+=(--keychain "$KC")
  fi
  args+=(--sign "$IDENTITY")
elif [[ -n "$IDENTITY" ]]; then
  args+=(--sign "$IDENTITY")
else
  args+=(--sign -)
fi

codesign "${args[@]}" "$APP"
codesign --verify --strict "$APP" || die "the helper's signature does not verify"
echo "  ok: $APP ($VERSION), signed ${IDENTITY:-ad-hoc}"

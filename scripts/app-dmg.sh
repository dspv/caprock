#!/usr/bin/env bash
#
# The macOS .dmg around a built Caprock.app, with its branded window, made
# without Finder (scripts/app-release.sh and ci.yml's macOS app job run it).
#
#   scripts/app-dmg.sh build <Caprock.app> <out.dmg>   # make (and sign) the .dmg
#   scripts/app-dmg.sh check <mount point>             # check a mounted one's window
#
# Why not Tauri's own .dmg: its bundler lays the window out with a Finder
# AppleScript and skips that whenever CI=true (tauri-bundler's
# bundle/macos/dmg/mod.rs passes --skip-jenkins), so every .dmg release.yml
# built opened as a plain white folder: no .DS_Store, so no background
# picture, no icon positions, no window size. dmgbuild writes the .DS_Store
# directly: the same layout on a runner, on a workstation, with no Finder
# window, no AppleScript and no automation prompt.
#
# The layout is bundle.macOS.dmg in app/src-tauri/tauri.conf.json, read by
# scripts/dmg-settings.py. dmgbuild and its two libraries are pinned with
# hashes in app/packaging/dmg-requirements.txt and installed into a venv
# under app/src-tauri/target/dmgbuild/ (Python 3.10 or later).
#
# Signing follows what Tauri did with its .dmg: with APPLE_SIGNING_IDENTITY
# set and not "-", codesign the image with it. With APPLE_CERTIFICATE and
# APPLE_CERTIFICATE_PASSWORD too (release.yml), the certificate is imported
# into a temporary keychain the way Tauri imports it for the .app, because
# Tauri deletes its own keychain when it finishes; the keychain is removed and
# the search list restored on exit. Notarizing and stapling stay with
# app-release.sh, after this.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "app-dmg: $*" >&2; exit 1; }

REQ="$REPO_ROOT/app/packaging/dmg-requirements.txt"
CONF="$REPO_ROOT/app/src-tauri/tauri.conf.json"
VENV="$REPO_ROOT/app/src-tauri/target/dmgbuild/venv"

# The venv, (re)made when it is missing or the pins changed.
venv() {
  if [[ -x "$VENV/bin/python" ]] && cmp -s "$REQ" "$VENV/requirements.txt"; then return; fi
  local py
  py="$(command -v python3)" || die "python3 not found (3.10 or later)"
  "$py" -c 'import sys; sys.exit(sys.version_info < (3, 10))' ||
    die "$py is $("$py" -V 2>&1), dmgbuild needs Python 3.10 or later"
  rm -rf "$VENV"
  "$py" -m venv "$VENV"
  "$VENV/bin/python" -m pip install -q --disable-pip-version-check --no-input \
    --only-binary=:all: --require-hashes -r "$REQ" || die "pip install -r $REQ failed"
  cp "$REQ" "$VENV/requirements.txt"
}

check() {
  local mnt="$1"
  [[ -d "$mnt" ]] || die "no mount point $mnt"
  venv
  "$VENV/bin/python" "$REPO_ROOT/scripts/dmg_window.py" check "$mnt" "$CONF"
}

KC="" KC_LIST=()
cleanup_keychain() {
  [[ -n "$KC" ]] || return 0
  security list-keychains -d user -s ${KC_LIST[@]+"${KC_LIST[@]}"} >/dev/null 2>&1 || true
  security delete-keychain "$KC" >/dev/null 2>&1 || true
  rm -rf "$(dirname "$KC")"
  KC=""
}

# The temporary keychain with APPLE_CERTIFICATE in it, as tauri-macos-sign's
# Keychain::with_certificate makes one.
import_certificate() {
  local dir pw p12
  dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/caprock-dmg-sign.XXXXXX")"
  KC="$dir/sign.keychain-db"
  p12="$dir/cert.p12"
  pw="$(openssl rand -hex 24)"
  while IFS= read -r k; do
    k="${k#"${k%%[![:space:]]*}"}"
    k="${k#\"}"
    k="${k%\"}"
    [[ -n "$k" ]] && KC_LIST+=("$k")
  done < <(security list-keychains -d user)
  trap cleanup_keychain EXIT
  printf '%s' "$APPLE_CERTIFICATE" | base64 --decode >"$p12"
  security create-keychain -p "$pw" "$KC"
  security unlock-keychain -p "$pw" "$KC"
  security import "$p12" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -k "$KC" >/dev/null
  rm -f "$p12"
  security set-keychain-settings -t 3600 -u "$KC"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pw" "$KC" >/dev/null
  security list-keychains -d user -s ${KC_LIST[@]+"${KC_LIST[@]}"} "$KC"
}

build() {
  local app="$1" dmg="$2"
  [[ "$(uname -s)" == Darwin ]] || die "the .dmg builds on macOS only"
  [[ -d "$app" && "$(basename "$app")" == *.app ]] || die "$app is not an .app bundle"
  venv
  local volname
  volname="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$app/Contents/Info.plist" 2>/dev/null || basename "$app" .app)"
  mkdir -p "$(dirname "$dmg")"
  rm -f "$dmg"
  "$VENV/bin/dmgbuild" -s "$REPO_ROOT/scripts/dmg-settings.py" \
    -D app="$app" -D conf="$CONF" "$volname" "$dmg" >/dev/null || die "dmgbuild failed"
  [[ -s "$dmg" ]] || die "dmgbuild made no $dmg"

  local identity="${APPLE_SIGNING_IDENTITY:-}"
  if [[ -z "$identity" || "$identity" == "-" ]]; then
    echo "  $(basename "$dmg"): window laid out, not signed (ad-hoc, as Tauri left it)"
    return
  fi
  local kc=()
  if [[ -n "${APPLE_CERTIFICATE:-}" && -n "${APPLE_CERTIFICATE_PASSWORD:-}" ]]; then
    import_certificate
    kc=(--keychain "$KC")
  fi
  codesign --force -s "$identity" ${kc[@]+"${kc[@]}"} "$dmg" || die "codesign of $(basename "$dmg") failed"
  cleanup_keychain
  codesign --verify "$dmg" || die "$(basename "$dmg") does not verify after signing"
  echo "  $(basename "$dmg"): window laid out, signed"
}

case "${1:-}" in
  build) [[ $# -eq 3 ]] || die "usage: scripts/app-dmg.sh build <Caprock.app> <out.dmg>"; build "$2" "$3" ;;
  check) [[ $# -eq 2 ]] || die "usage: scripts/app-dmg.sh check <mount point>"; check "$2" ;;
  *) die "usage: scripts/app-dmg.sh build <Caprock.app> <out.dmg> | check <mount point>" ;;
esac

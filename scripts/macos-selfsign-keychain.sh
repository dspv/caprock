#!/usr/bin/env bash
#
# Make Caprock's stable self-signed code-signing identity available to
# `tauri build` on a macOS CI runner (.ai/21-app.md § Privacy prompts on
# macOS).
#
# Why: an ad-hoc signature's designated requirement is its cdhash, which
# changes with every build, so macOS privacy settings (TCC: the microphone,
# Desktop, Documents, Downloads) take every release for a new program and
# ask again. Signed with one certificate, the requirement becomes
# `identifier "…" and certificate leaf = H"…"`, the same for every build, and
# an answer given once survives updates. Gatekeeper still treats the app as
# from an unidentified developer, as with ad-hoc; that is Developer ID's job.
#
# Reads MACOS_SELFSIGN_P12_BASE64 and MACOS_SELFSIGN_P12_PASSWORD (GitHub
# secrets). When either is empty it does nothing and the build stays ad-hoc
# (`signingIdentity: "-"` in tauri.conf.json), so pull requests from forks and
# local builds work without them. Otherwise it imports the identity into a
# temporary keychain under RUNNER_TEMP, puts that keychain on the runner's
# search list, and writes APPLE_SIGNING_IDENTITY (the certificate's SHA-1,
# which Tauri passes to codesign in place of the config's "-") to GITHUB_ENV.
#
# CI only: it changes the keychain search list of the account it runs in, so
# it refuses to run outside GitHub Actions. Never run it on a workstation.
#
set -euo pipefail

die() { echo "macos-selfsign-keychain: $*" >&2; exit 1; }

if [[ -z "${MACOS_SELFSIGN_P12_BASE64:-}" || -z "${MACOS_SELFSIGN_P12_PASSWORD:-}" ]]; then
  echo "  MACOS_SELFSIGN_P12_* unset: the app stays ad-hoc signed (macOS asks again after each update)"
  exit 0
fi
[[ "$(uname -s)" == Darwin ]] || die "macOS only"
[[ "${GITHUB_ACTIONS:-}" == true && -n "${RUNNER_TEMP:-}" && -n "${GITHUB_ENV:-}" ]] ||
  die "CI only: this edits the keychain search list"

KC="$RUNNER_TEMP/caprock-selfsign.keychain-db"
P12="$RUNNER_TEMP/caprock-selfsign.p12"
KC_PW="$(openssl rand -hex 24)"
trap 'rm -f "$P12"' EXIT

printf '%s' "$MACOS_SELFSIGN_P12_BASE64" | base64 --decode >"$P12"
security create-keychain -p "$KC_PW" "$KC"
security set-keychain-settings -lut 21600 "$KC"
security unlock-keychain -p "$KC_PW" "$KC"
security import "$P12" -k "$KC" -P "$MACOS_SELFSIGN_P12_PASSWORD" -T /usr/bin/codesign >/dev/null
# Lets codesign use the key without a dialog.
security set-key-partition-list -S apple-tool:,apple: -s -k "$KC_PW" "$KC" >/dev/null
# codesign finds identities on the search list only; keep the runner's own.
existing=()
while IFS= read -r k; do
  k="${k#"${k%%[![:space:]]*}"}"
  k="${k#\"}"
  k="${k%\"}"
  [[ -n "$k" ]] && existing+=("$k")
done < <(security list-keychains -d user)
security list-keychains -d user -s "$KC" ${existing[@]+"${existing[@]}"}

# Without -v: a self-signed certificate is not trusted, and need not be;
# codesign signs with it all the same, and TCC matches the leaf's hash.
SHA1="$(security find-identity -p codesigning "$KC" | awk '/"Caprock Self-Signed Code Signing"/ {print $2; exit}')"
[[ "$SHA1" =~ ^[0-9A-F]{40}$ ]] || die "no \"Caprock Self-Signed Code Signing\" identity in the .p12"

echo "APPLE_SIGNING_IDENTITY=$SHA1" >>"$GITHUB_ENV"
echo "  ok: signing with the Caprock self-signed identity $SHA1"

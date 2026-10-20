#!/usr/bin/env bash
#
# Prepare `tauri build` on a macOS CI runner to sign Caprock.app with the
# Developer ID certificate and notarize it (.ai/21-app.md § Privacy prompts on
# macOS, docs/RELEASING.md § The desktop app).
#
# Reads the GitHub secrets APPLE_CERTIFICATE (the .p12, base64),
# APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY ("Developer ID
# Application: <Company> (<TEAMID>)"), APPLE_TEAM_ID, and for notarization
# APPLE_API_KEY (the App Store Connect key id), APPLE_API_ISSUER and
# APPLE_API_KEY_P8 (the .p8 file's contents).
#
# - Without APPLE_CERTIFICATE it does nothing: scripts/macos-selfsign-keychain.sh
#   (the next step) signs with the self-signed identity, or the build stays
#   ad-hoc, so a release never breaks for want of these secrets.
# - With the certificate it writes APPLE_SIGNING_IDENTITY to GITHUB_ENV, which
#   also tells macos-selfsign-keychain.sh to stand aside. The certificate
#   itself is not imported here: `tauri build` imports it into a temporary
#   keychain of its own when APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD
#   are in its environment (release.yml passes them to app-release.sh).
# - With the three API key secrets as well it writes the .p8 to a 0600 file
#   under RUNNER_TEMP and exports APPLE_API_KEY_PATH, so `tauri build`
#   notarizes and staples the .app and app-release.sh notarizes and staples
#   the .dmg. Without them the build is Developer ID signed but not notarized,
#   with a warning, and the cask keeps its quarantine step.
#
# CI only: it refuses to run outside GitHub Actions. Reads no keychain and
# raises no dialog.
#
set -euo pipefail

die() { echo "macos-developer-id: $*" >&2; exit 1; }

if [[ -z "${APPLE_CERTIFICATE:-}" ]]; then
  echo "  APPLE_CERTIFICATE unset: no Developer ID; the self-signed identity or ad-hoc signs the app"
  exit 0
fi
[[ "$(uname -s)" == Darwin ]] || die "macOS only"
[[ "${GITHUB_ACTIONS:-}" == true && -n "${RUNNER_TEMP:-}" && -n "${GITHUB_ENV:-}" ]] ||
  die "CI only (by hand, put the identity in a keychain and set APPLE_SIGNING_IDENTITY for app-release.sh)"
[[ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ]] || die "APPLE_CERTIFICATE is set but APPLE_CERTIFICATE_PASSWORD is not"
[[ "${APPLE_SIGNING_IDENTITY:-}" == "Developer ID Application: "* ]] ||
  die "APPLE_SIGNING_IDENTITY must be the certificate's full name, \"Developer ID Application: <Company> (<TEAMID>)\""
if [[ -n "${APPLE_TEAM_ID:-}" ]]; then
  [[ "$APPLE_SIGNING_IDENTITY" == *"($APPLE_TEAM_ID)" ]] || die "APPLE_SIGNING_IDENTITY does not end in (APPLE_TEAM_ID)"
  echo "APPLE_TEAM_ID=$APPLE_TEAM_ID" >>"$GITHUB_ENV"
fi

echo "APPLE_SIGNING_IDENTITY=$APPLE_SIGNING_IDENTITY" >>"$GITHUB_ENV"

if [[ -z "${APPLE_API_KEY:-}" || -z "${APPLE_API_ISSUER:-}" || -z "${APPLE_API_KEY_P8:-}" ]]; then
  echo "  warning: APPLE_API_KEY, APPLE_API_ISSUER or APPLE_API_KEY_P8 unset: Developer ID signed, NOT notarized"
  exit 0
fi

DIR="$RUNNER_TEMP/caprock-notary"
P8="$DIR/AuthKey_${APPLE_API_KEY}.p8"
mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077
if [[ "$APPLE_API_KEY_P8" == *"BEGIN PRIVATE KEY"* ]]; then
  printf '%s\n' "$APPLE_API_KEY_P8" >"$P8"
else
  # The secret stored base64-encoded instead of as the file's text.
  printf '%s' "$APPLE_API_KEY_P8" | base64 --decode >"$P8"
fi
grep -q "BEGIN PRIVATE KEY" "$P8" || die "APPLE_API_KEY_P8 is not a .p8 private key"

echo "APPLE_API_KEY_PATH=$P8" >>"$GITHUB_ENV"
echo "  ok: Developer ID signing and notarization for this build"

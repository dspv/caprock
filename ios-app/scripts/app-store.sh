#!/usr/bin/env bash
#
# Archive Caprock for iPhone, sign it for App Store distribution and upload it
# to App Store Connect (ADR-083, ios-app/README.md § Release). Run by
# .github/workflows/ios-release.yml after the phone's page is built and synced
# into ios-app/ios; never on the owner's Mac.
#
# Reads:
#   APPSTORE_API_KEY_ID, APPSTORE_API_ISSUER_ID, APPSTORE_API_KEY_P8
#       the App Store Connect Team API key (the .p8 text, or base64 of it)
#   APPLE_TEAM_ID        the team (CYBRIX LLC)
#   BUILD_NUMBER         CFBundleVersion; the workflow passes the run number
#   MARKETING_VERSION    CFBundleShortVersionString (default 1.0)
#   DESTINATION          upload (default) or export: export stops at a signed
#                        .ipa in $OUT and uploads nothing
#   SIGNING              auto (default), cloud or certificate:
#     cloud        Xcode signs with a cloud-managed Apple Distribution
#                  certificate it fetches with the API key. Needs a key whose
#                  role may use cloud-managed distribution certificates (Admin).
#     certificate  Xcode signs with the Apple Distribution certificate in
#                  IOS_DIST_CERT_P12 (base64 .p12) / IOS_DIST_CERT_PASSWORD,
#                  imported into a throwaway keychain; the API key (App Manager
#                  is enough) fetches or creates the App Store profile.
#                  IOS_PROFILE_B64 (a base64 App Store .mobileprovision)
#                  replaces even that: manual signing, no profile created.
#     auto         certificate when IOS_DIST_CERT_P12 is set, else cloud.
#   OUT                  where the archive, the .ipa and the logs go
#
# CI only: it refuses to run outside GitHub Actions, raises no dialog and
# reads no keychain but the throwaway one it makes.
#
set -euo pipefail

die() { echo "app-store: $*" >&2; exit 1; }

[[ "$(uname -s)" == Darwin ]] || die "macOS only"
[[ "${GITHUB_ACTIONS:-}" == true && -n "${RUNNER_TEMP:-}" ]] || die "CI only (.github/workflows/ios-release.yml)"
for v in APPSTORE_API_KEY_ID APPSTORE_API_ISSUER_ID APPSTORE_API_KEY_P8 APPLE_TEAM_ID BUILD_NUMBER; do
  [[ -n "${!v:-}" ]] || die "$v is not set"
done
[[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]] || die "BUILD_NUMBER must be a whole number, not $BUILD_NUMBER"
MARKETING_VERSION="${MARKETING_VERSION:-1.0}"
[[ "$MARKETING_VERSION" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]] || die "MARKETING_VERSION must look like 1.0 or 1.0.1"
DESTINATION="${DESTINATION:-upload}"
[[ "$DESTINATION" == upload || "$DESTINATION" == export ]] || die "DESTINATION is upload or export"
SIGNING="${SIGNING:-auto}"
if [[ "$SIGNING" == auto ]]; then
  if [[ -n "${IOS_DIST_CERT_P12:-}" ]]; then SIGNING=certificate; else SIGNING=cloud; fi
fi
[[ "$SIGNING" == cloud || "$SIGNING" == certificate ]] || die "SIGNING is auto, cloud or certificate"
OUT="${OUT:-$RUNNER_TEMP/ios-release}"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)/ios/App/App.xcodeproj"
[[ -d "$PROJECT" ]] || die "no Xcode project at $PROJECT"
[[ -f "$(dirname "$PROJECT")/App/public/index.html" ]] || die "the phone's page is not synced in: run vite build --mode remote and cap sync ios first"

mkdir -p "$OUT"
chmod 700 "$OUT"
umask 077

# The API key, as a file xcodebuild can read.
KEYDIR="$RUNNER_TEMP/caprock-asc"
mkdir -p "$KEYDIR"
P8="$KEYDIR/AuthKey_${APPSTORE_API_KEY_ID}.p8"
if [[ "$APPSTORE_API_KEY_P8" == *"BEGIN PRIVATE KEY"* ]]; then
  printf '%s\n' "$APPSTORE_API_KEY_P8" >"$P8"
else
  printf '%s' "$APPSTORE_API_KEY_P8" | base64 --decode >"$P8"
fi
grep -q "BEGIN PRIVATE KEY" "$P8" || die "APPSTORE_API_KEY_P8 is not a .p8 private key"
AUTH=(-allowProvisioningUpdates
  -authenticationKeyPath "$P8"
  -authenticationKeyID "$APPSTORE_API_KEY_ID"
  -authenticationKeyIssuerID "$APPSTORE_API_ISSUER_ID")

STYLE=automatic
PROFILE_NAME=""
KEYCHAIN=""
cleanup() {
  [[ -n "$KEYCHAIN" ]] && security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
  rm -rf "$KEYDIR"
}
trap cleanup EXIT

if [[ "$SIGNING" == certificate ]]; then
  [[ -n "${IOS_DIST_CERT_P12:-}" && -n "${IOS_DIST_CERT_PASSWORD:-}" ]] ||
    die "SIGNING=certificate needs IOS_DIST_CERT_P12 and IOS_DIST_CERT_PASSWORD"
  KEYCHAIN="$RUNNER_TEMP/caprock-ios.keychain-db"
  KCPASS="$(openssl rand -hex 24)"
  security create-keychain -p "$KCPASS" "$KEYCHAIN"
  security set-keychain-settings -lut 3600 "$KEYCHAIN"
  security unlock-keychain -p "$KCPASS" "$KEYCHAIN"
  printf '%s' "$IOS_DIST_CERT_P12" | base64 --decode >"$KEYDIR/dist.p12"
  security import "$KEYDIR/dist.p12" -k "$KEYCHAIN" -P "$IOS_DIST_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPASS" "$KEYCHAIN" >/dev/null
  # Searched first, beside the runner's own keychains.
  # shellcheck disable=SC2046
  security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
  security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "Apple Distribution" ||
    die "IOS_DIST_CERT_P12 holds no Apple Distribution identity"
  if [[ -n "${IOS_PROFILE_B64:-}" ]]; then
    STYLE=manual
    printf '%s' "$IOS_PROFILE_B64" | base64 --decode >"$KEYDIR/app.mobileprovision"
    security cms -D -i "$KEYDIR/app.mobileprovision" >"$KEYDIR/profile.plist"
    PROFILE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :Name' "$KEYDIR/profile.plist")"
    UUID="$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$KEYDIR/profile.plist")"
    mkdir -p "$HOME/Library/MobileDevice/Provisioning Profiles"
    cp "$KEYDIR/app.mobileprovision" "$HOME/Library/MobileDevice/Provisioning Profiles/$UUID.mobileprovision"
  fi
fi
echo "app-store: version $MARKETING_VERSION ($BUILD_NUMBER), signing: $SIGNING ($STYLE), destination: $DESTINATION"

# 1. The archive, unsigned: a signed archive would need an Apple Development
#    certificate and a development profile, and a development profile needs a
#    registered device. Signing happens once, at the export, for the store.
xcodebuild -project "$PROJECT" -scheme App -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$OUT/Caprock.xcarchive" \
  -onlyUsePackageVersionsFromResolvedFile \
  MARKETING_VERSION="$MARKETING_VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  archive 2>&1 | tee "$OUT/archive.log" | tail -n 40

# 2. The export: signed for App Store Connect and, with destination upload,
#    sent there (the build then appears under the app's builds after
#    processing). ExportOptions.plist is written here, not committed, so the
#    team and the signing mode come from one place.
OPTS="$OUT/ExportOptions.plist"
/usr/libexec/PlistBuddy -c 'Clear dict' "$OPTS" >/dev/null 2>&1 || true
pb() { /usr/libexec/PlistBuddy -c "$1" "$OPTS" >/dev/null; }
pb "Add :method string app-store-connect"
pb "Add :destination string $DESTINATION"
pb "Add :teamID string $APPLE_TEAM_ID"
pb "Add :signingStyle string $STYLE"
pb "Add :uploadSymbols bool true"
pb "Add :manageAppVersionAndBuildNumber bool false"
if [[ "$STYLE" == manual ]]; then
  pb "Add :signingCertificate string Apple Distribution"
  pb "Add :provisioningProfiles dict"
  pb "Add :provisioningProfiles:dev.caprock.ios string $PROFILE_NAME"
fi
plutil -lint "$OPTS"

set +e
xcodebuild -exportArchive \
  -archivePath "$OUT/Caprock.xcarchive" \
  -exportOptionsPlist "$OPTS" \
  -exportPath "$OUT/export" \
  "${AUTH[@]}" >"$OUT/export.log" 2>&1
status=$?
set -e
tail -n 60 "$OUT/export.log"

if grep -q "Cloud signing permission error" "$OUT/export.log"; then
  die "the API key may not use cloud-managed distribution certificates. Either make a Team key with the Admin role, or add an Apple Distribution certificate as IOS_DIST_CERT_P12 / IOS_DIST_CERT_PASSWORD (ios-app/README.md § Signing)"
fi
[[ $status -eq 0 ]] || die "export failed with status $status (see export.log in the run's artifact)"
if [[ "$DESTINATION" == upload ]]; then
  echo "app-store: uploaded Caprock $MARKETING_VERSION ($BUILD_NUMBER) to App Store Connect"
else
  ls -l "$OUT/export"
  echo "app-store: signed .ipa in $OUT/export, nothing uploaded"
fi

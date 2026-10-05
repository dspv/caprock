#!/usr/bin/env bash
#
# Build the macOS desktop app for a release tag, check it, attach it to that
# tag's GitHub release, and render the Homebrew cask (WP-17).
#
# The daemon release comes first (goreleaser, from release.yml or by hand);
# this adds Caprock_<version>_universal.dmg to it. The app carries a daemon
# built from the same commit with the same version stamp, so it must run on a
# clean checkout of the tag itself.
#
# Release.yml's app-macos job runs this same script; run it by hand when
# Actions is down:
#
#   git checkout vX.Y.Z
#   make app-release TAG=vX.Y.Z                          # build, check, upload
#   make app-release TAG=vX.Y.Z ARGS=--no-upload         # build and check only
#   make app-release TAG=vX.Y.Z ARGS="--no-upload --cask-pr"
#
# Flags:
#   --no-upload  build, check and render; do not touch the GitHub release
#   --clobber    replace a .dmg already attached to the release
#   --cask-pr    open a pull request on dspv/homebrew-tap with the cask
#
# Output: app/src-tauri/target/app-release/ (the .dmg and caprock-app.rb).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

die() { echo "app-release: $*" >&2; exit 1; }

TAG="${1:-}"
[[ -n "$TAG" ]] || die "usage: scripts/app-release.sh vX.Y.Z [--no-upload] [--clobber] [--cask-pr]"
shift
UPLOAD=1 CLOBBER="" CASK_PR=0
for arg in "$@"; do
  case "$arg" in
    --no-upload) UPLOAD=0 ;;
    --clobber) CLOBBER="--clobber" ;;
    --cask-pr) CASK_PR=1 ;;
    *) die "unknown flag $arg" ;;
  esac
done

[[ "$(uname -s)" == Darwin ]] || die "the macOS app builds on macOS only"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "$TAG is not vX.Y.Z"
VERSION="${TAG#v}"

# The same tag: the daemon inside the app is built from this checkout.
TAG_COMMIT="$(git rev-parse -q --verify "$TAG^{commit}")" || die "no tag $TAG here (git fetch --tags)"
[[ "$(git rev-parse HEAD)" == "$TAG_COMMIT" ]] || die "HEAD is not $TAG: git checkout $TAG first"
git diff --quiet HEAD -- || die "the checkout has uncommitted changes"

if [[ "$UPLOAD" == 1 ]]; then
  gh release view "$TAG" >/dev/null 2>&1 || die "no GitHub release $TAG yet: publish the daemon release first"
fi

export PATH="$HOME/.cargo/bin:$PATH"
command -v rustup >/dev/null && rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

OUT="app/src-tauri/target/app-release"
rm -rf "$OUT" && mkdir -p "$OUT" app/src-tauri/binaries

echo "→ daemon $VERSION, universal"
for arch in arm64 amd64; do
  CGO_ENABLED=0 GOOS=darwin GOARCH="$arch" go build -trimpath \
    -ldflags "-s -w -X github.com/dspv/caprock/internal/version.Version=$VERSION" \
    -o "$OUT/caprock-$arch" ./cmd/caprock
done
lipo -create -output app/src-tauri/binaries/caprock-universal-apple-darwin "$OUT/caprock-arm64" "$OUT/caprock-amd64"

echo "→ Caprock.app and .dmg"
(cd app && { [[ -d node_modules ]] || npm ci; } && npx tauri build \
  --target universal-apple-darwin --bundles app,dmg \
  --config "{\"version\":\"$VERSION\"}")

DMG_NAME="Caprock_${VERSION}_universal.dmg"
BUILT="app/src-tauri/target/universal-apple-darwin/release/bundle/dmg/$DMG_NAME"
[[ -f "$BUILT" ]] || die "tauri did not produce $BUILT"
cp "$BUILT" "$OUT/$DMG_NAME"
DMG="$OUT/$DMG_NAME"

echo "→ checking $DMG_NAME"
hdiutil verify "$DMG" >/dev/null
MNT="$(mktemp -d)"
hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$MNT" "$DMG" >/dev/null
trap 'hdiutil detach "$MNT" -quiet || true' EXIT
APP="$MNT/Caprock.app"
[[ -d "$APP" ]] || die "no Caprock.app in the .dmg"
[[ -L "$MNT/Applications" ]] || die "no Applications link in the .dmg"
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$APP/Contents/Info.plist"; }
[[ "$(plist CFBundleIdentifier)" == dev.caprock.app ]] || die "bundle id is $(plist CFBundleIdentifier)"
[[ "$(plist CFBundleShortVersionString)" == "$VERSION" ]] || die "app version is $(plist CFBundleShortVersionString)"
codesign --verify --deep --strict "$APP" || die "the signature does not verify"
codesign -dv "$APP" 2>&1 | grep -q '^Signature=adhoc' || die "the app is not ad-hoc signed"
for bin in caprock-app caprock; do
  archs="$(lipo -archs "$APP/Contents/MacOS/$bin")"
  [[ "$archs" == *x86_64* && "$archs" == *arm64* ]] || die "$bin is $archs, not universal"
done
daemon="$("$APP/Contents/MacOS/caprock" version)"
[[ "$daemon" == "caprock $VERSION "* ]] || die "the bundled daemon says: $daemon"
hdiutil detach "$MNT" -quiet && trap - EXIT

SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
sed -e "s/@VERSION@/$VERSION/" -e "s/@SHA256@/$SHA/" app/packaging/caprock-app.rb.tmpl > "$OUT/caprock-app.rb"
echo "  ok: ad-hoc signed, universal, dev.caprock.app $VERSION, bundles $daemon"
echo "  $(du -h "$DMG" | cut -f1)  sha256 $SHA"

if [[ "$UPLOAD" == 1 ]]; then
  echo "→ attaching to the $TAG release"
  gh release upload "$TAG" "$DMG" $CLOBBER
fi

if [[ "$CASK_PR" == 1 ]]; then
  echo "→ cask pull request on dspv/homebrew-tap"
  TAP="$(mktemp -d)"
  gh repo clone dspv/homebrew-tap "$TAP" -- --depth 1 -q
  mkdir -p "$TAP/Casks" && cp "$OUT/caprock-app.rb" "$TAP/Casks/caprock-app.rb"
  git -C "$TAP" checkout -q -b "caprock-app-$VERSION"
  git -C "$TAP" add Casks/caprock-app.rb
  git -C "$TAP" commit -q -m "caprock-app $VERSION"
  git -C "$TAP" push -q -u origin "caprock-app-$VERSION"
  (cd "$TAP" && gh pr create --title "caprock-app $VERSION" \
    --body "The desktop app's cask for $TAG, rendered by scripts/app-release.sh in dspv/caprock.")
fi

echo ""
echo "Cask: $OUT/caprock-app.rb"

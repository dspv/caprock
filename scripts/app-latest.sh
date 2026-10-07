#!/usr/bin/env bash
#
# Give a release's desktop-app files names without a version, add them to
# checksums.txt, and mark the release Latest.
#
# The site's download buttons link
#
#   https://github.com/dspv/caprock/releases/latest/download/<name>
#
# which only works if every release carries the same <name>. Tauri puts the
# version in each file name, so this attaches a copy of each under a fixed
# one, beside the versioned file (the cask and older links keep using that):
#
#   Caprock_<v>_universal.dmg    → Caprock-macOS.dmg
#   Caprock_<v>_x64-setup.exe    → Caprock-Windows-setup.exe
#   Caprock_<v>_amd64.AppImage   → Caprock-Linux.AppImage
#   Caprock_<v>_amd64.deb        → Caprock-Linux.deb
#   Caprock-<v>-1.x86_64.rpm     → Caprock-Linux.rpm
#
# goreleaser publishes the release without marking it Latest
# (.goreleaser.yaml, make_latest: false), because the app files arrive minutes
# later from other jobs and /releases/latest/download/ would 404 in between.
# This marks it Latest once all five are attached; with one missing it stops
# and the previous release stays Latest, so the site's buttons keep working.
# A prerelease is never marked Latest.
#
# release.yml's app-latest job runs it after the app jobs. By hand, after
# attaching the app files (docs/RELEASING.md):
#
#   make app-latest TAG=vX.Y.Z
#   make app-latest TAG=vX.Y.Z ARGS=--allow-missing   # Latest even with gaps
#
# It also writes latest.json, the desktop app's update manifest, from the
# signed updater bundles' .sig files (scripts/app-update-manifest.py).
#
# Safe to re-run: the copies, checksums.txt and latest.json are replaced each
# time.
#
set -euo pipefail

die() { echo "app-latest: $*" >&2; exit 1; }

TAG="${1:-}"
[[ -n "$TAG" ]] || die "usage: scripts/app-latest.sh vX.Y.Z [--allow-missing]"
shift
ALLOW_MISSING=0
for arg in "$@"; do
  case "$arg" in
    --allow-missing) ALLOW_MISSING=1 ;;
    *) die "unknown flag $arg" ;;
  esac
done
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "$TAG is not vX.Y.Z"
VERSION="${TAG#v}"

STABLE=(Caprock-macOS.dmg Caprock-Windows-setup.exe Caprock-Linux.AppImage Caprock-Linux.deb Caprock-Linux.rpm)

# The fixed name for one of this version's app files; nothing for anything else.
stable_name() {
  case "$1" in
    "Caprock_${VERSION}_universal.dmg") echo Caprock-macOS.dmg ;;
    "Caprock_${VERSION}_x64-setup.exe") echo Caprock-Windows-setup.exe ;;
    "Caprock_${VERSION}_amd64.AppImage") echo Caprock-Linux.AppImage ;;
    "Caprock_${VERSION}_amd64.deb") echo Caprock-Linux.deb ;;
    # rpm rewrites a prerelease version, so match its shape, not the string.
    Caprock-*.x86_64.rpm) echo Caprock-Linux.rpm ;;
  esac
}

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

ASSETS="$(gh release view "$TAG" --json assets -q '.assets[].name')" ||
  die "no GitHub release $TAG"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/files" "$WORK/sum"

FILES=() COPIES=()
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  stable="$(stable_name "$name")"
  [[ -n "$stable" ]] || continue
  echo "→ $name → $stable"
  gh release download "$TAG" --pattern "$name" --dir "$WORK/files"
  cp "$WORK/files/$name" "$WORK/files/$stable"
  FILES+=("$name" "$stable")
  COPIES+=("$WORK/files/$stable")
done <<<"$ASSETS"

MISSING=()
for s in "${STABLE[@]}"; do
  [[ " ${FILES[*]:-} " == *" $s "* ]] || MISSING+=("$s")
done

if [[ ${#COPIES[@]} -gt 0 ]]; then
  echo "→ attaching ${#COPIES[@]} file(s) without a version"
  gh release upload "$TAG" "${COPIES[@]}" --clobber

  # checksums.txt is goreleaser's; keep its lines, replace any app lines a
  # previous run wrote, add this run's, sorted by file name as goreleaser does.
  echo "→ checksums.txt"
  gh release download "$TAG" --pattern checksums.txt --dir "$WORK/sum"
  {
    grep -Ev '[[:space:]]Caprock[-_]' "$WORK/sum/checksums.txt" || true
    (cd "$WORK/files" && sha256 "${FILES[@]}")
  } | LC_ALL=C sort -k2 >"$WORK/checksums.txt"
  gh release upload "$TAG" "$WORK/checksums.txt" --clobber
fi

# latest.json for the app's updater (F20, ADR-042), from the .sig files the
# app jobs attached beside each signed bundle. Attached before the Latest
# mark, so releases/latest/download/latest.json always names files that are
# there. A release without signatures (the key not configured) gets none,
# and the app's Update button says so; that never blocks Latest.
echo "→ latest.json"
mkdir -p "$WORK/sig"
SIGS="$(grep -E "^Caprock_${VERSION//./\\.}_.*\.sig\$" <<<"$ASSETS" || true)"
if [[ -n "$SIGS" ]]; then
  while IFS= read -r sig; do
    gh release download "$TAG" --pattern "$sig" --dir "$WORK/sig"
  done <<<"$SIGS"
fi
set +e
python3 "$(dirname "${BASH_SOURCE[0]}")/app-update-manifest.py" "$TAG" "$WORK/sig" --out "$WORK/latest.json"
rc=$?
set -e
case "$rc" in
  0) gh release upload "$TAG" "$WORK/latest.json" --clobber ;;
  3) echo "  warning: no signed app update in $TAG: the app's Update button offers the release page instead" ;;
  *) die "latest.json: app-update-manifest.py failed" ;;
esac

if [[ "$TAG" == *-* ]]; then
  echo "  $TAG is a prerelease: not marked Latest"
  exit 0
fi
if [[ ${#MISSING[@]} -gt 0 && "$ALLOW_MISSING" == 0 ]]; then
  die "$TAG has no ${MISSING[*]}: not marked Latest, the previous release still is. Attach the missing app files and run this again, or pass --allow-missing."
fi
[[ ${#MISSING[@]} -eq 0 ]] || echo "  warning: marking Latest without ${MISSING[*]}; those download links 404 until attached"
gh release edit "$TAG" --latest >/dev/null
echo "  $TAG is Latest: https://github.com/dspv/caprock/releases/latest/download/Caprock-macOS.dmg"

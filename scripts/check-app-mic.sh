#!/usr/bin/env bash
#
# Check that a built Caprock.app may ask for the microphone (ADR-045): the
# app and its daemon sidecars are signed with the hardened runtime, which
# refuses the microphone without a prompt to a program lacking
# com.apple.security.device.audio-input, and the app's Info.plist says why
# it asks. The same for Caprock Terminal.app in Contents/Helpers (ADR-101),
# which answers for everything a Caprock terminal runs: its executable
# carries the entitlement and its own Info.plist the usage string, under its
# own bundle id. Reads the bundle only; records nothing and raises no dialog.
#
#   scripts/check-app-mic.sh path/to/Caprock.app
#
set -euo pipefail

die() { echo "check-app-mic: $*" >&2; exit 1; }

APP="${1:-}"
[[ -d "$APP" ]] || die "usage: scripts/check-app-mic.sh path/to/Caprock.app"

for bin in caprock-app caprock caprock-pty-host; do
  exe="$APP/Contents/MacOS/$bin"
  [[ -f "$exe" ]] || die "no $bin in $APP"
  ents="$(codesign -d --entitlements - --xml "$exe" 2>/dev/null || true)"
  [[ "$ents" == *"com.apple.security.device.audio-input"* ]] ||
    die "$bin is not signed with com.apple.security.device.audio-input"
done

why="$(/usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" "$APP/Contents/Info.plist" 2>/dev/null || true)"
[[ -n "$why" ]] || die "Info.plist has no NSMicrophoneUsageDescription"

HELPER="$APP/Contents/Helpers/Caprock Terminal.app"
[[ -d "$HELPER" ]] || die "no Caprock Terminal.app in Contents/Helpers"
hplist() { /usr/libexec/PlistBuddy -c "Print :$1" "$HELPER/Contents/Info.plist" 2>/dev/null || true; }
[[ "$(hplist CFBundleIdentifier)" == dev.caprock.terminal ]] ||
  die "Caprock Terminal.app's bundle id is '$(hplist CFBundleIdentifier)', not dev.caprock.terminal"
[[ "$(hplist CFBundleExecutable)" == caprock-pty-host ]] ||
  die "Caprock Terminal.app's executable is '$(hplist CFBundleExecutable)', not caprock-pty-host"
[[ -n "$(hplist NSMicrophoneUsageDescription)" ]] || die "Caprock Terminal.app's Info.plist has no NSMicrophoneUsageDescription"
hexe="$HELPER/Contents/MacOS/caprock-pty-host"
[[ -x "$hexe" ]] || die "no caprock-pty-host in Caprock Terminal.app"
ents="$(codesign -d --entitlements - --xml "$hexe" 2>/dev/null || true)"
[[ "$ents" == *"com.apple.security.device.audio-input"* ]] ||
  die "Caprock Terminal.app is not signed with com.apple.security.device.audio-input"
# flags=0x10000(runtime), or 0x10002(adhoc,runtime) on an ad-hoc build.
[[ "$(codesign -dv "$hexe" 2>&1)" =~ flags=0x[0-9a-f]+\([a-z,-]*runtime ]] || die "Caprock Terminal.app is signed without the hardened runtime"

echo "  ok: microphone entitlement on caprock-app, caprock, caprock-pty-host and Caprock Terminal.app, usage strings present"

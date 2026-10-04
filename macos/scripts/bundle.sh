#!/bin/sh
# Build Caprock.app from the SwiftPM executable. Needs only the Command Line
# Tools (no Xcode). Unsigned apart from the ad-hoc signature the linker adds.
#   macos/scripts/bundle.sh [out-dir]   → <out-dir>/Caprock.app (default macos/build)
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$here/build"}
cd "$here"
swift build -c release
bin=$(swift build -c release --show-bin-path)/CaprockMac
app="$out/Caprock.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/Caprock"
# SwiftTerm's Metal shaders; it looks in Contents/Resources for this bundle.
cp -R "$(dirname "$bin")/SwiftTerm_SwiftTerm.bundle" "$app/Contents/Resources/"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Caprock</string>
  <key>CFBundleDisplayName</key><string>Caprock</string>
  <key>CFBundleIdentifier</key><string>dev.caprock.mac.spike</string>
  <key>CFBundleExecutable</key><string>Caprock</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.0-spike</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <!-- The daemon is plain http on loopback. -->
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST
codesign --force --sign - "$app" >/dev/null 2>&1 || true
echo "$app"

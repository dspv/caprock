#!/bin/sh
# Builds the Mac preview of Caprock Mail into build/Caprock Mail.app: a
# WebKit window on the running Caprock daemon's <daemon>/?mail=1 (README.md).
# Needs the Xcode command line tools (swiftc, iconutil) and rsvg-convert
# (brew install librsvg) for the icon. Signed ad hoc: for this machine only.
set -eu
cd "$(dirname "$0")"
app="build/Caprock Mail.app"
tmp=$(mktemp -d)
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
swiftc -O -o "$app/Contents/MacOS/caprock-mail" main.swift -framework Cocoa -framework WebKit
set_dir="$tmp/AppIcon.iconset"
mkdir "$set_dir"
for s in 16 32 128 256 512; do
  rsvg-convert -w "$s" -h "$s" icon.svg -o "$set_dir/icon_${s}x${s}.png"
  rsvg-convert -w $((s * 2)) -h $((s * 2)) icon.svg -o "$set_dir/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$set_dir" -o "$app/Contents/Resources/AppIcon.icns"
cp Info.plist "$app/Contents/Info.plist"
codesign --force --sign - "$app"
rm -rf "$tmp"
echo "built $app"

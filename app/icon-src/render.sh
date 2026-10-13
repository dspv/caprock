#!/bin/sh
# Renders the desktop app's icons in app/src-tauri/icons from icon.svg: the
# PNGs, the macOS .icns (iconutil) and the Windows .ico (ImageMagick). Needs
# rsvg-convert (brew install librsvg) and magick; the outputs are committed,
# so a build never needs either. tray.png is the menu-bar template, from tray.svg.
set -eu
cd "$(dirname "$0")"
out=../src-tauri/icons
tmp=$(mktemp -d)
png() { rsvg-convert -w "$1" -h "$1" icon.svg -o "$2"; }
png 32 "$out/32x32.png"
png 128 "$out/128x128.png"
png 256 "$out/128x128@2x.png"
png 512 "$out/icon.png"
set_dir="$tmp/icon.iconset"
mkdir "$set_dir"
for s in 16 32 128 256 512; do
  png "$s" "$set_dir/icon_${s}x${s}.png"
  png $((s * 2)) "$set_dir/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$set_dir" -o "$out/icon.icns"
for s in 16 24 32 48 64 256; do png "$s" "$tmp/ico-$s.png"; done
magick "$tmp"/ico-16.png "$tmp"/ico-24.png "$tmp"/ico-32.png "$tmp"/ico-48.png "$tmp"/ico-64.png "$tmp"/ico-256.png "$out/icon.ico"
rsvg-convert -w 64 -h 64 tray.svg -o "$out/tray.png"
rm -rf "$tmp"

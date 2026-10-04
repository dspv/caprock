#!/bin/sh
# Renders the home-screen icons in ui/public from ui/icons/*.svg, which are the
# favicon's mark drawn full-bleed. Run after changing either; needs rsvg-convert
# (brew install librsvg). The PNGs are committed, so a build never needs it.
set -eu
cd "$(dirname "$0")/../ui"
rsvg-convert -w 180 -h 180 icons/icon.svg -o public/apple-touch-icon.png
rsvg-convert -w 192 -h 192 icons/icon.svg -o public/icon-192.png
rsvg-convert -w 512 -h 512 icons/icon.svg -o public/icon-512.png
rsvg-convert -w 512 -h 512 icons/icon-maskable.svg -o public/icon-maskable-512.png

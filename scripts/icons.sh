#!/bin/sh
# Renders the extension's PNG icons from the xrn tile: icons/icon.svg (the same file as the tile on
# xrnhub's Apps page) for 32 px and up, and icon-16.svg (a bigger glyph and a thinner stripe, which
# stay readable on a few pixels) for 16 and 24. Every size goes into the manifest's "icons" and
# "action.default_icon": a browser picks the next size up for its slot and scales it down, and
# Chromium on Android draws the toolbar icon at 20 dp, 55 px on a 2.75x phone. Needs rsvg-convert
# (librsvg).
set -eu
cd "$(dirname "$0")/../icons"
for s in 16 24; do rsvg-convert -w "$s" -h "$s" icon-16.svg -o "icon$s.png"; done
for s in 32 48 64 96 128 256; do rsvg-convert -w "$s" -h "$s" icon.svg -o "icon$s.png"; done

#!/bin/sh
# Usage: icons/render.sh [github-app-logo.png]
# Renders the PNG icons in public/ from favicon.svg and maskable.svg. Needs rsvg-convert (librsvg).
set -eu
cd "$(dirname "$0")/.."
icon() { rsvg-convert -w "$2" -h "$2" "$1" -o "public/$3"; }
icon public/favicon.svg 16 favicon-16.png
icon public/favicon.svg 32 favicon-32.png
icon public/favicon.svg 192 icon-192.png
icon public/favicon.svg 512 icon-512.png
icon icons/maskable.svg 512 icon-maskable-512.png
icon icons/maskable.svg 180 apple-touch-icon.png
# With a path, also renders the 500 px GitHub App logo there. GitHub has no API for it: upload it in the app settings.
if [ $# -gt 0 ]; then rsvg-convert -w 500 -h 500 icons/maskable.svg -o "$1"; fi

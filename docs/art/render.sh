#!/usr/bin/env bash
# Renders every SVG in $1 to a 2x PNG with a transparent background, then quantizes it.
# Needs Chrome (set CHROME to its binary), pngquant, ImageMagick and rg.
set -euo pipefail
dir=$(cd "$1" && pwd)
chrome=${CHROME:-$(ls -d ~/.agent-browser/browsers/chrome-*/chrome 2>/dev/null | tail -1)}
for svg in "$dir"/*.svg; do
  base=${svg%.svg}
  w=$(rg -o 'width="([0-9]+)"' -r '$1' -m1 "$svg" | head -1)
  h=$(rg -o 'height="([0-9]+)"' -r '$1' -m1 "$svg" | head -1)
  printf '<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>%s' "$(cat "$svg")" > "$base.html"
  "$chrome" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --default-background-color=00000000 --window-size="$w,$h" --screenshot="$base.raw.png" "file://$base.html" >/dev/null 2>&1
  pngquant --force --quality=80-95 --strip --output "$base.png" "$base.raw.png"
  rm "$base.raw.png" "$base.html"
  echo "$(basename "$base").png $(identify -format '%wx%h' "$base.png") $(stat -c %s "$base.png")B"
done

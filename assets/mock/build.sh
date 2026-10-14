#!/bin/sh
# Render the README screenshots from mock data (no account or transcripts
# needed). Needs google-chrome (or $CHROME) and ImageMagick.
#
#   assets/mock/build.sh [outdir]      default: assets/
set -e
here=$(dirname "$(readlink -f "$0")")
repo=$(readlink -f "$here/../..")
out=${1:-$repo/assets}
chrome=${CHROME:-google-chrome-stable}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Inline the real pixel-art scenes from house.js so the mock never drifts.
sed -n '/^const W = 48/,/^\/\*\* The scene for one level/p' "$repo/claude-usage@nauer/lib/house.js" | sed '$d' > "$tmp/scene.js"
python3 -c 'import sys; t=open(sys.argv[1]).read(); open(sys.argv[2],"w").write(t.replace("/*SCENE*/", open(sys.argv[3]).read()))' \
    "$here/template.html" "$tmp/index.html" "$tmp/scene.js"
cp "$here/mock.js" "$tmp/"

mkdir -p "$out"
for v in ${VIEWS:-topbar limits value days hours house}; do
    "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
        --default-background-color=00000000 --window-size=1400,1600 --virtual-time-budget=2000 \
        --screenshot="$out/screenshot-$v.png" "file://$tmp/index.html#$v" 2>/dev/null
    magick "$out/screenshot-$v.png" -trim +repage "$out/screenshot-$v.png"
    echo "$out/screenshot-$v.png"
done

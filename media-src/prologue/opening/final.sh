#!/usr/bin/env bash
# High-res pass: re-render each approved draft at GPT Image 2.5 quality high, 4k, into final/.
# The draft is passed as the first reference so the approved composition is kept.
set -euo pipefail
cd "$(dirname "$0")"
S=ref-illustrated-style.png
keep() {  # keep <name> <prompt> [env...]
  local name=$1 prompt=$2; shift 2
  local tmp; tmp=$(mktemp)
  { echo "Re-render the first reference image at full detail and quality: keep exactly the same composition, framing, characters, poses, colours and lighting; only add finer line work, brush texture and detail. Use the last reference image for the drawing style."
    cat "prompts/$prompt"; } > "$tmp"
  env "$@" ./gen.sh "$name" high 4k "$tmp" "drafts/$name.png" "$S"
  rm -f "$tmp"
}
keep 01-book-closed 01-book-closed.txt LETTERBOX=1 WALL_ANCHOR=0.75 &
keep 02-book-opening 02-book-opening.txt LETTERBOX=1 WALL_ANCHOR=0.6 &
keep 03-page-bethlehem 03-page-bethlehem.txt LETTERBOX=1 &
keep 04a-family-square 04a-family-square.txt LETTERBOX=1 &
keep 04-aerial-bethlehem 04-aerial-bethlehem.txt WALL_ANCHOR=0.4 &
keep 05-storybook-pasture 05-storybook-pasture.txt WALL_ANCHOR=0.35 &
wait
cp ref-real-pasture.jpg final/06-real-pasture.jpg && python3 crop_wall.py final/06-real-pasture.jpg 0.35
python3 contact_sheet.py final

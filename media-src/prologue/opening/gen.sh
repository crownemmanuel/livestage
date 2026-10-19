#!/usr/bin/env bash
# Generate one opening still with Higgsfield (GPT Image 2.5 by default), framed for the 4:1 LED wall.
#   gen.sh <name> <quality> <resolution> <prompt-file> [reference-image ...]
# Draft pass: quality low, resolution 1k (writes drafts/). Final pass: quality high, resolution 4k (writes final/).
#
# The wall is 3072 × 768 (4:1) and no model outputs 4:1, so every image is generated at 21:9
# with a framing instruction (subject in the middle band), kept as the master <name>.png, and
# cropped to the wall as <name>-wall.png (3072 × 768 for finals). Video clips use the 21:9
# masters as first/last frames and get the same crop afterwards.
# WALL_ANCHOR (0 = keep the top, 1 = keep the bottom, default 0.5) moves the crop.
set -euo pipefail
cd "$(dirname "$0")"
name=$1 quality=$2 res=$3 prompt_file=$4; shift 4
refs=()
for r in "$@"; do refs+=(--image-references "$r"); done
out=drafts; [ "$quality" = low ] || out=final
mkdir -p "$out"
FRAMING="Framing: this picture will be shown on an ultra-wide 4:1 LED wall, cropped to a 4:1 strip through the middle of the image. Keep the whole subject and every important detail inside the central horizontal band (the middle 55% of the height). The top and bottom fifth of the image must hold only simple, uneventful sky, darkness, tabletop or ground that can be cut away. Spread the scene wide rather than tall."
# LETTERBOX=1 for tall subjects (objects, figures) that the plain framing note doesn't keep in the band:
# the model paints the picture inside a true 4:1 strip between black bars, and the crop removes the bars.
if [ "${LETTERBOX:-0}" = 1 ]; then
  FRAMING="Format: an ultra-wide letterboxed cinema frame. Solid pure-black bars fill the top 21% and the bottom 21% of the image edge to edge; the picture exists only in the 4:1 panoramic strip between them, and the whole subject, including its top and bottom edges, fits completely inside that strip with a little breathing room. Nothing crosses into the black bars."
fi
# MODEL=nano_banana_flash (Nano Banana 2) for a more illustrated look; it has no quality tiers.
MODEL=${MODEL:-gpt_image_2_5}
extra=(--quality "$quality" --variant sunburst)
[ "$MODEL" = gpt_image_2_5 ] || extra=()
json=$(higgsfield generate create "$MODEL" \
  --prompt "$(cat "$prompt_file")
$FRAMING" \
  --aspect_ratio 21:9 --resolution "$res" ${extra[@]+"${extra[@]}"} \
  ${refs[@]+"${refs[@]}"} --wait --wait-timeout 15m --json)
echo "$json" > "$out/$name.json"
url=$(echo "$json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
job=d[0] if isinstance(d,list) else d
print(job.get('result_url') or '')")
[ -n "$url" ] || { echo "no image url in result for $name" >&2; exit 1; }
curl -fsSL "$url" -o "$out/$name.png"
python3 crop_wall.py "$out/$name.png" "${WALL_ANCHOR:-0.5}"
echo "$out/$name.png"

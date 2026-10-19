#!/usr/bin/env bash
# The whole opening as ONE Seedance 2.5 take: the stills are reference images (not locked first/last frames)
# and the prompt describes the camera move beat by beat. Output is cropped to 4:1 like vgen.sh.
#   oneshot.sh [seconds=30]   (RES=480p default; RES=1080p for the final)
set -euo pipefail
cd "$(dirname "$0")"
secs=${1:-30} RES=${RES:-480p}
out=clips/drafts; [ "$RES" = 480p ] || out=clips/final
mkdir -p "$out"
K=keyframes
json=$(higgsfield generate create seedance_2_5 \
  --prompt "$(cat prompts/clips/oneshot.txt)" \
  --mode omni_reference --resolution "$RES" --aspect_ratio 21:9 --duration "$secs" --generate_audio false \
  --image-references $K/01-book-closed.png --image-references $K/02-book-opening.png \
  --image-references $K/03-page-bethlehem.png --image-references $K/04a-family-square.png \
  --image-references $K/04-aerial-bethlehem.png --image-references $K/05-storybook-pasture.png \
  --wait --wait-timeout 45m --json)
echo "$json" > "$out/oneshot.json"
url=$(echo "$json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
job=d[0] if isinstance(d,list) else d
print(job.get('result_url') or '')")
[ -n "$url" ] || { echo "no video url in result" >&2; exit 1; }
curl -fsSL "$url" -o "$out/oneshot-raw.mp4"
ffmpeg -v error -y -i "$out/oneshot-raw.mp4" \
  -vf "crop=iw:trunc(iw/8)*2:0:(ih-trunc(iw/8)*2)/2" -an -c:v libx264 -crf 16 -pix_fmt yuv420p -g 12 -keyint_min 12 -sc_threshold 0 -movflags +faststart "$out/oneshot.mp4"
echo "$out/oneshot.mp4 $(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -of csv=p=0 "$out/oneshot.mp4")"

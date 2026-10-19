#!/usr/bin/env bash
# Generate one opening clip with Higgsfield Seedance 2.5 between two keyframes, then crop it to 4:1.
#   vgen.sh <name> <start-keyframe> <end-keyframe> <seconds> <prompt-file>
# Drafts: 480p (clips/drafts/); RES=1080p for finals (clips/final/). Seedance 2.0 fast and
# Seedance 2.5 draft mode both return "Not found" on this account, so drafts are plain 480p (3 credits/s).
# Keyframes come from keyframes.py (21:9 frames with the 4:1 picture letterboxed in the middle).
set -euo pipefail
cd "$(dirname "$0")"
name=$1 start=$2 end=$3 secs=$4 prompt_file=$5
RES=${RES:-480p}
out=clips/drafts; [ "$RES" = 480p ] || out=clips/final
mkdir -p "$out"
LETTERBOX_NOTE="The frame is letterboxed: solid black bars stay fixed across the top and bottom for the whole clip and nothing ever enters them; all the picture and all the motion stay inside the wide strip in the middle. Smooth, continuous single camera move, no cuts, no text."
json=$(higgsfield generate create seedance_2_5 \
  --prompt "$(cat "$prompt_file")
$LETTERBOX_NOTE" \
 --mode omni_reference --resolution "$RES" --aspect_ratio 21:9 --duration "$secs" --generate_audio false \
  --start-image "$start" --end-image "$end" --wait --wait-timeout 30m --json)
echo "$json" > "$out/$name.json"
url=$(echo "$json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
job=d[0] if isinstance(d,list) else d
print(job.get('result_url') or '')")
[ -n "$url" ] || { echo "no video url in result for $name" >&2; exit 1; }
curl -fsSL "$url" -o "$out/$name-raw.mp4"
# Cut the letterbox off: keep the middle 4:1 strip (same geometry as keyframes.py).
ffmpeg -v error -y -i "$out/$name-raw.mp4" \
  -vf "crop=iw:trunc(iw/8)*2:0:(ih-trunc(iw/8)*2)/2" -an -c:v libx264 -crf 16 -pix_fmt yuv420p -g 12 -keyint_min 12 -sc_threshold 0 -movflags +faststart "$out/$name.mp4"
echo "$out/$name.mp4 $(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -of csv=p=0 "$out/$name.mp4")"

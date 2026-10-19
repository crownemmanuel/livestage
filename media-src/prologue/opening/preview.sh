#!/usr/bin/env bash
# Stitch the opening clips into one 4:1 preview with its audio, to judge timing before building the cue.
#   [ONESHOT=1] [AUDIO=narration] preview.sh [drafts|final]  ->  renders/prologue-opening-preview.mp4
# Audio: title theme at 0, flute at 24.4 s, NAR-01 at 26.3 s ("David" lands 7.31 s into it), as in docs/PROLOGUE_OPENING.md.
# Picture: v1…v6, then the existing push-in (cropped like the app: anchorY 0.35) and the field loop.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../../.. && pwd)
SRC=clips/${1:-drafts}
A=$ROOT/public/media/prologue/audio
M=$ROOT/public/media/prologue
OUT=$ROOT/renders; TMP=$OUT/tmp-opening; mkdir -p "$TMP"
W=1536 H=384  # half the wall, 4:1
# A keyframe every 0.5 s: the app re-seeks a video that drifts from the show clock, and with
# long keyframe gaps (x264's default is 10 s) every re-seek decodes seconds of video and stutters.
GOP="-g 12 -keyint_min 12 -sc_threshold 0"
n=0; list=$TMP/list.txt; : > "$list"
norm() {  # norm <input> [crop-anchor]: scale/crop to W×H at the clips' native 24 fps
  local anchor=${2:-0.5}; n=$((n+1))
  ffmpeg -v error -y -i "$1" -an -vf "scale=$W:-2,crop=$W:$H:0:(ih-$H)*$anchor,fps=24,setsar=1" \
    -c:v libx264 -crf 18 -pix_fmt yuv420p $GOP "$TMP/$n.mp4"
  echo "file '$TMP/$n.mp4'" >> "$list"
}
if [ "${ONESHOT:-0}" = 1 ]; then  # ONESHOT=1: the single-take opening, then the morph clip
  if [ ! -f "$SRC/oneshot.mp4" ] && [ -f "$SRC/opening-a-runway.mp4" ]; then
    # Part 1 + part 2 (Runway, extended by reference); drop part 2's first frames, which repeat part 1's end.
    ffmpeg -v error -y -ss 0.08 -i "$SRC/opening-b-runway.mp4" -an -c:v libx264 -crf 16 -pix_fmt yuv420p "$TMP/b-trim.mp4"
    printf "file '%s'\nfile '%s'\n" "$PWD/$SRC/opening-a-runway.mp4" "$TMP/b-trim.mp4" > "$TMP/ab.txt"
    ffmpeg -v error -y -f concat -safe 0 -i "$TMP/ab.txt" -c:v libx264 -crf 16 -pix_fmt yuv420p "$SRC/oneshot.mp4"
  fi
  norm "$SRC/oneshot.mp4"; norm "$SRC/v6-painting-turns-real.mp4"
else
  for c in v1-book-opens v2-into-page v3-page-comes-alive v4-follow-david-out v5-glide-to-pasture v6-painting-turns-real; do
    norm "$SRC/$c.mp4"
  done
fi
norm "$M/p1-push-in.mp4" 0.35
norm "$M/p1-fields-loop.mp4" 0.35
ffmpeg -v error -y -f concat -safe 0 -i "$list" -c copy "$TMP/picture.mp4"
d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP/picture.mp4")
if [ "${AUDIO:-title}" = narration ]; then
  # AUDIO=narration: no title theme. The voice and music stems of the Script project's
  # prologue mix, from where the narration starts (26.3 s), so every line keeps the
  # audiobook's gaps (David's guide vocals, mixed 13 dB under the narrator in the stem,
  # are lifted 10 dB so they can be heard for timing): NAR-01 at 0 s ("David" 7.31 s), NAR-02 8.75 s, David's line
  # 24.0 s, his Psalm 23 Part 1 31.38 s, NAR-03 51.04 s.
  STEMS=/Users/emmanuelcrown/Documents/Videos/Salvation/Script/multimedia/prologue-video/assets/audio
  ffmpeg -v error -y -i "$TMP/picture.mp4" -ss 26.3 -i "$STEMS/music.wav" -ss 26.3 -i "$STEMS/vo.wav" \
    -filter_complex "[2]volume=10dB:enable='between(t,23.9,50.2)'[v];[1][v]amix=inputs=2:normalize=0,alimiter=limit=0.95,apad[a]" \
    -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -movflags +faststart -t "$d" "$OUT/prologue-opening-preview.mp4"
  echo "$OUT/prologue-opening-preview.mp4 (picture ${d}s; narration from 0 s, David's line 24.0 s, psalm 31.4 s)"
  exit 0
fi
ffmpeg -v error -y -i "$TMP/picture.mp4" -i "$A/title-theme.mp3" -i "$A/flute.mp3" -i "$A/narrator/NAR-01.mp3" \
  -filter_complex "[1]adelay=0|0[t];[2]adelay=24400|24400[f];[3]adelay=26300|26300[n];[t][f][n]amix=inputs=3:normalize=0,apad[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -movflags +faststart -t "$d" "$OUT/prologue-opening-preview.mp4"
echo "$OUT/prologue-opening-preview.mp4 (picture ${d}s; 'David' is at 33.61 s)"

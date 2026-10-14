#!/usr/bin/env bash
# Builds public/media/prologue from the raw Runway outputs in media-src/prologue.
set -euo pipefail
P=/Users/emmanuelcrown/Documents/Projects/livestage/public/media/prologue
SRC=${SRC:-/Users/emmanuelcrown/Documents/Projects/livestage/media-src/prologue}
K="format=yuva444p,chromakey=0x16C44A:0.15:0.07,despill=type=green:mix=0.7:expand=0.05,format=yuva420p"
VP9=(-c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -crf 26 -b:v 0 -row-mt 1 -deadline good -cpu-used 2)
cd "$P"
step=${1:-all}

if [[ $step == all || $step == stills ]]; then
  for pair in a0-wide:p1-wide-start a3-fields-clean:p1-fields-clean b1-rock:p2-rock b2-lion-rock:p2-lion-rock c1-david-lion:p3-david-lion d1-battlefield:p4-battlefield s1-sky:p3-sky; do
    [[ -f $SRC/${pair%%:*}.png ]] && ffmpeg -v error -y -i "$SRC/${pair%%:*}.png" -q:v 3 "${pair##*:}.jpg"
  done
  cp "$SRC/p1-push-in.mp4" p1-push-in.mp4
  cp "$SRC/p1-fields-loop.mp4" p1-fields-loop.mp4
  cp "$SRC/p1-p2-timelapse.mp4" p1-to-p2-timelapse.mp4
  cp "$SRC/p2-lion-climb.mp4" "$SRC/p2-lion-idle.mp4" "$SRC/p2-lion-charge.mp4" "$SRC/p4-battlefield-loop.mp4" .
fi

if [[ $step == all || $step == sheep ]]; then
  # Key the flock, play the 10 s loop twice and mux the 20 s bleating ambience loop.
  ffmpeg -v error -y -stream_loop 1 -i "$SRC/p1-sheep-green.mp4" -i "$SRC/sheep-ambience.mp3" \
    -filter_complex "[0:v]$K[v]" -map "[v]" -map 1:a "${VP9[@]}" -c:a libopus -b:a 128k -t 20.083 p1-sheep-cutout.webm
fi

if [[ $step == all || $step == goliath ]]; then
  ffmpeg -v error -y -i "$SRC/p4-goliath-taunt-green.mp4" -vf "$K" "${VP9[@]}" -an p4-goliath-taunt-cutout.webm
  # Trimmed to start at the stone impact; the app's projectile flies the stone in.
  ffmpeg -v error -y -ss 1.30 -i "$SRC/p4-goliath-fall-green.mp4" -vf "$K" "${VP9[@]}" -an p4-goliath-fall-cutout.webm
  if [[ -f $SRC/p4-goliath-enter-green.mp4 ]]; then
    ffmpeg -v error -y -i "$SRC/p4-goliath-enter-green.mp4" -vf "$K" "${VP9[@]}" -an p4-goliath-enter-cutout.webm
  fi
fi

if [[ $step == all || $step == p3 ]]; then
  [[ -f $SRC/p3-david-lion-loop.mp4 ]] && cp "$SRC/p3-david-lion-loop.mp4" .
  # Sky transition: tilt up from David on the lion, then down into the Valley of Elah.
  if [[ -f $SRC/p3-tilt-up.mp4 ]]; then
    ffmpeg -v error -y -i "$SRC/p3-tilt-up.mp4" -i "$SRC/p4-tilt-down.mp4" \
      -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0[v]" -map "[v]" -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart p3-to-p4-sky.mp4
  fi
fi

if [[ $step == all || $step == mac ]]; then
  # HEVC-with-alpha twins for macOS (WKWebView cannot decode VP9 alpha).
  for f in *.webm; do
    ffmpeg -v error -y -c:v libvpx-vp9 -i "$f" -map 0:v -map "0:a?" -pix_fmt bgra -c:v hevc_videotoolbox -alpha_quality 0.8 -allow_sw 1 -tag:v hvc1 -b:v 5M -c:a aac -b:a 128k "${f%.webm}.mov"
  done
fi

for f in *.webm *.mp4 *.mov; do
  [[ -f $f ]] && echo "$f $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f") $(du -h "$f" | cut -f1)"
done

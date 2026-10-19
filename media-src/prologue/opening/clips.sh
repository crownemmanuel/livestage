#!/usr/bin/env bash
# Animate the opening chain: every clip starts on the previous clip's last keyframe.
# Drafts by default (Seedance 2.5, 480p). Lengths target the timeline in docs/PROLOGUE_OPENING.md.
set -euo pipefail
cd "$(dirname "$0")"
K=keyframes P=prompts/clips
./vgen.sh v0-book-idle         $K/01-book-closed.png      $K/01-book-closed.png      5 $P/v0-book-idle.txt &
./vgen.sh v1-book-opens        $K/01-book-closed.png      $K/02-book-opening.png     6 $P/v1-book-opens.txt &
./vgen.sh v2-into-page         $K/02-book-opening.png     $K/03-page-bethlehem.png   5 $P/v2-into-page.txt &
./vgen.sh v3-page-comes-alive  $K/03-page-bethlehem.png   $K/04a-family-square.png   5 $P/v3-page-comes-alive.txt &
./vgen.sh v4-follow-david-out  $K/04a-family-square.png   $K/04-aerial-bethlehem.png 6 $P/v4-follow-david-out.txt &
./vgen.sh v5-glide-to-pasture  $K/04-aerial-bethlehem.png $K/05-storybook-pasture.png 6 $P/v5-glide-to-pasture.txt &
./vgen.sh v6-painting-turns-real $K/05-storybook-pasture.png $K/06-real-pasture.png  4 $P/v6-painting-turns-real.txt &
wait

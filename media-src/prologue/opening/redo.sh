#!/usr/bin/env bash
# Rebuild every opening draft in the chosen look (GPT Image 2.5 + prompts/style.txt), in dependency order.
set -euo pipefail
cd "$(dirname "$0")"
S=ref-illustrated-style.png
# 1. no dependencies
LETTERBOX=1 ./gen.sh 04a-family-square low 1k prompts/04a-family-square.txt $S &
LETTERBOX=1 WALL_ANCHOR=0.75 ./gen.sh 01-book-closed low 1k prompts/01-book-closed.txt $S &
WALL_ANCHOR=0.35 ./gen.sh 05-storybook-pasture low 1k prompts/05-storybook-pasture.txt ref-real-pasture.jpg $S &
wait
# 2. need stage 1
WALL_ANCHOR=0.4 ./gen.sh 04-aerial-bethlehem low 1k prompts/04-aerial-bethlehem.txt drafts/04a-family-square.png $S &
LETTERBOX=1 WALL_ANCHOR=0.6 ./gen.sh 02-book-opening low 1k prompts/02-book-opening.txt drafts/01-book-closed.png $S &
wait
# 3. needs stage 2
LETTERBOX=1 ./gen.sh 03-page-bethlehem low 1k prompts/03-page-bethlehem.txt drafts/02-book-opening.png drafts/04a-family-square.png $S
python3 contact_sheet.py drafts

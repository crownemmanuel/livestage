#!/usr/bin/env python3
"""Make the video keyframes: each still's 4:1 wall crop, letterboxed into a 21:9 frame.

Seedance outputs 21:9 at most. Giving it every first/last frame in the same letterbox
(the wall picture in the middle, black bars above and below) keeps the bars fixed for
the whole chain, so cutting them off afterwards gives a clean 4:1 clip.

    python3 keyframes.py [final|drafts]   ->  keyframes/<name>.png  (2520 × 1080)
"""
from __future__ import annotations

import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else "final"
W, H = 2520, 1080
BAND = round(W / 4)  # 630 px: the 4:1 picture

NAMES = ["01-book-closed", "02-book-opening", "03-page-bethlehem", "04a-family-square",
         "04-aerial-bethlehem", "05-storybook-pasture", "06-real-pasture"]

os.makedirs(os.path.join(HERE, "keyframes"), exist_ok=True)
for name in NAMES:
    wall = os.path.join(HERE, SRC, f"{name}-wall.png")
    if not os.path.exists(wall):
        print(f"skip {name}: no wall crop")
        continue
    pic = Image.open(wall).convert("RGB").resize((W, BAND), Image.LANCZOS)
    frame = Image.new("RGB", (W, H), (0, 0, 0))
    frame.paste(pic, (0, (H - BAND) // 2))
    dest = os.path.join(HERE, "keyframes", f"{name}.png")
    frame.save(dest)
    print(dest)

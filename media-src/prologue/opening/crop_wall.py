#!/usr/bin/env python3
"""Crop a 21:9 master still to the 4:1 LED wall (3072 × 768).

    python3 crop_wall.py <image.png> [anchorY]   ->  <image>-wall.png

anchorY: 0 keeps the top of the image, 1 the bottom, 0.5 the middle (default).
The crop is full width; it is scaled to 3072 × 768 when the source is wide enough,
otherwise kept at its native width (drafts).
"""
import os
import sys

from PIL import Image

WALL_W, WALL_H = 3072, 768

src = sys.argv[1]
anchor = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
im = Image.open(src).convert("RGB")

# Letterboxed images (gen.sh LETTERBOX=1): trim the black bars first.
gray = im.convert("L")
def dark(y: int) -> bool:
    row = gray.crop((0, y, im.width, y + 1)).getextrema()
    return row[1] < 24
top_bar = 0
while top_bar < im.height // 3 and dark(top_bar):
    top_bar += 1
bottom_bar = im.height
while bottom_bar > im.height * 2 // 3 and dark(bottom_bar - 1):
    bottom_bar -= 1
if top_bar > 4 or im.height - bottom_bar > 4:
    im = im.crop((0, top_bar, im.width, bottom_bar))

h = round(im.width * WALL_H / WALL_W)
if h <= im.height:
    top = round((im.height - h) * anchor)
    wall = im.crop((0, top, im.width, top + h))
else:  # the strip came out wider than 4:1: trim the sides instead
    w = round(im.height * WALL_W / WALL_H)
    left = (im.width - w) // 2
    wall = im.crop((left, 0, left + w, im.height))
if wall.width >= WALL_W:
    wall = wall.resize((WALL_W, WALL_H), Image.LANCZOS)
base, _ = os.path.splitext(src)
wall.save(f"{base}-wall.png")
print(f"{base}-wall.png {wall.width}x{wall.height}")

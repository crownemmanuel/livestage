#!/usr/bin/env python3
"""Contact sheet of the opening, as the 3072 × 768 (4:1) LED wall shows it.

Stacks each still's wall crop (<name>-wall.png, made by crop_wall.py) in shot order.
The thin line marks the bottom fifth of the wall that actors and set usually block.

    python3 media-src/prologue/opening/contact_sheet.py [drafts|final]
"""
from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FOLDER = sys.argv[1] if len(sys.argv) > 1 else "drafts"
W, H = 1600, 400  # each strip, 4:1
LABEL = 40

SHOTS = [
    ("01-book-closed", "1  The Holy Bible, closed (title music)"),
    ("02-book-opening", "2  The cover opens, pages flip, light pours out"),
    ("03-page-bethlehem", "3  The pages settle on Bethlehem; camera pushes into the page"),
    ("04a-family-square", "4  Into the page: Jesse's house at dawn; David is sent out with the sheep"),
    ("04-aerial-bethlehem", "5  Drone rises and follows David out of town toward the fields"),
    ("05-storybook-pasture", "6  Lands on the pasture, still painted (morph start)"),
    ("06-real-pasture", "7  Morph end: the real plate; lights up on the real David"),
]

try:
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Georgia.ttf", 24)
except OSError:
    font = ImageFont.load_default()

strips = []
for name, label in SHOTS:
    path = os.path.join(HERE, FOLDER, f"{name}-wall.png")
    if not os.path.exists(path):
        continue
    im = Image.open(path).convert("RGB").resize((W, H), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    y = H - H // 5
    for x in range(0, W, 24):
        d.line([x, y, x + 12, y], fill=(255, 255, 255), width=1)
    strip = Image.new("RGB", (W, H + LABEL), (18, 16, 14))
    strip.paste(im, (0, LABEL))
    ImageDraw.Draw(strip).text((12, 8), label, fill=(243, 234, 214), font=font)
    strips.append(strip)

sheet = Image.new("RGB", (W + 24, sum(s.height + 12 for s in strips) + 12), (10, 9, 8))
y = 12
for s in strips:
    sheet.paste(s, (12, y))
    y += s.height + 12
dest = os.path.join(HERE, FOLDER, "contact-sheet.jpg")
sheet.save(dest, quality=88)
print(dest)

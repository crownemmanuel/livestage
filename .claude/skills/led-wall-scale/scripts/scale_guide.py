#!/usr/bin/env python3
"""Draw the LED wall's scale guide: the 3072 x 768 canvas with its 16 x 4 test grid and
life-size figures, measured from docs/stage-reference/wall-scale-photo.jpg.

    python3 .claude/skills/led-wall-scale/scripts/scale_guide.py [--actor-height 1.75]
    python3 .claude/skills/led-wall-scale/scripts/scale_guide.py --overlay still-wall.png   (check a 4:1 still)

Writes into docs/stage-reference/:
  wall-scale-guide.png      3072 x 768, labelled, for people (planning, checking a still)
  wall-scale-ref-21x9.png   the same figures without labels, letterboxed into 21:9 (2520 x 1080),
                            to attach to an image/video generation as a layout and scale reference

Calibration (see SKILL.md): an adult standing on the riser at the wall's bottom edge measured
~425 px tall and ~420 px arm span, i.e. 1 m ~= 425 / actor_height px. The stage floor near the
wall is ~0.5 m below the wall's bottom edge.
"""
from __future__ import annotations

import argparse
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
OUT = os.path.join(ROOT, "docs", "stage-reference")
W, H = 3072, 768
MEASURED_PX = 425  # the photographed actor, head to feet, in wall pixels
FLOOR_BELOW_WALL_M = 0.5  # stage floor under the wall's bottom edge


def font(size: int) -> ImageFont.ImageFont:
    for f in ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()


def person(d: ImageDraw.ImageDraw, cx: float, feet_y: float, h: float, fill, arms: bool = False):
    """A simple standing silhouette, h pixels tall, feet at feet_y (may be below the canvas)."""
    head = h * 0.13
    top = feet_y - h
    d.ellipse([cx - head / 2, top, cx + head / 2, top + head], fill=fill)
    sh = top + head * 1.15
    d.rounded_rectangle([cx - h * 0.12, sh, cx + h * 0.12, sh + h * 0.36], radius=h * 0.03, fill=fill)  # torso
    hip = sh + h * 0.36
    d.rectangle([cx - h * 0.11, hip, cx - h * 0.015, feet_y], fill=fill)  # legs
    d.rectangle([cx + h * 0.015, hip, cx + h * 0.11, feet_y], fill=fill)
    if arms:
        d.rectangle([cx - h * 0.5, sh + h * 0.02, cx + h * 0.5, sh + h * 0.07], fill=fill)
    else:
        d.rectangle([cx - h * 0.17, sh, cx - h * 0.125, sh + h * 0.38], fill=fill)
        d.rectangle([cx + h * 0.125, sh, cx + h * 0.17, sh + h * 0.38], fill=fill)


def lion(d: ImageDraw.ImageDraw, x0: float, feet_y: float, ppm: float, fill):
    """Side view of an adult male lion: ~1.2 m at the shoulder, ~2.5 m nose to rump, plus tail."""
    sh = 1.2 * ppm
    body_l = 2.0 * ppm
    leg = sh * 0.48
    d.rounded_rectangle([x0, feet_y - sh, x0 + body_l, feet_y - leg], radius=sh * 0.2, fill=fill)  # body
    for fx in (0.08, 0.25, 0.72, 0.88):
        d.rectangle([x0 + body_l * fx, feet_y - leg - 2, x0 + body_l * fx + sh * 0.13, feet_y], fill=fill)
    d.ellipse([x0 + body_l * 0.85, feet_y - sh * 1.25, x0 + body_l * 0.85 + sh * 0.55, feet_y - sh * 0.7], fill=fill)  # mane/head
    d.line([x0, feet_y - sh * 0.85, x0 - 0.8 * ppm, feet_y - sh * 0.45], fill=fill, width=int(sh * 0.06))  # tail


def draw(labels: bool, actor_m: float) -> Image.Image:
    ppm = MEASURED_PX / actor_m
    floor_y = H + FLOOR_BELOW_WALL_M * ppm  # stage floor, below the canvas
    im = Image.new("RGB", (W, H), (32, 32, 36))
    d = ImageDraw.Draw(im)
    grid = (88, 88, 96)
    for i in range(17):
        d.line([(i * W / 16, 0), (i * W / 16, H)], fill=grid, width=2)
    for i in range(5):
        d.line([(0, i * H / 4), (W, i * H / 4)], fill=grid, width=2)
    d.rectangle([1, 1, W - 2, H - 2], outline=(220, 40, 40), width=4)

    # Eye lines: an actor on the riser (feet at the wall's bottom edge) and one on the stage floor.
    eye_riser = H - (actor_m * 0.92) * ppm
    eye_floor = floor_y - (actor_m * 0.92) * ppm
    d.line([(0, eye_riser), (W, eye_riser)], fill=(90, 170, 255), width=3)
    d.line([(0, eye_floor), (W, eye_floor)], fill=(80, 220, 140), width=3)

    f = font(26)
    person(d, 0.12 * W, H, actor_m * ppm, (235, 235, 235), arms=True)  # the photographed pose
    person(d, 0.30 * W, floor_y, actor_m * ppm, (150, 220, 160))  # actor on the stage floor
    lion(d, 0.40 * W, H, ppm, (230, 180, 90))
    goliath_m = 2.9
    person(d, 0.86 * W, H, goliath_m * ppm, (200, 120, 110))  # "six cubits and a span"
    if labels:
        g = font(34)
        d.text((16, 12), f"LED wall 3072 x 768 (4:1). Grid square 192 px = {192 / ppm:.2f} m.  1 m = {ppm:.0f} px at the wall.  Actor height {actor_m:.2f} m = {actor_m * ppm:.0f} px.", fill=(240, 240, 240), font=g)
        d.text((0.12 * W + 0.55 * actor_m * ppm, H - actor_m * ppm), f"Actor on the riser\n(feet at the wall's edge)\n{actor_m * ppm:.0f} px = {actor_m * ppm / H:.0%} of height", fill=(255, 255, 255), font=f)
        d.text((0.30 * W + 0.22 * actor_m * ppm, floor_y - actor_m * ppm), f"Actor on the stage floor\n(0.5 m below the wall)", fill=(150, 220, 160), font=f)
        d.text((0.40 * W, H - 1.62 * ppm - 40), f"Lion, 1.2 m at the shoulder = {1.2 * ppm:.0f} px", fill=(230, 180, 90), font=f)
        d.text((0.86 * W - 0.2 * goliath_m * ppm - 420, H - goliath_m * ppm + 40), f"Goliath 2.9 m = {goliath_m * ppm:.0f} px ({goliath_m * ppm / H:.0%})", fill=(200, 120, 110), font=f)
        d.text((W - 900, eye_riser - 36), "eye line, actor on the riser", fill=(90, 170, 255), font=f)
        d.text((W - 900, eye_floor - 36), "eye line, actor on the stage floor", fill=(80, 220, 140), font=f)
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--actor-height", type=float, default=1.68, help="height in metres of the person in the photo (5 ft 6 in)")
    ap.add_argument("--overlay", help="a 4:1 wall image to check: writes <name>-scale-check.png with the figures over it")
    a = ap.parse_args()
    if a.overlay:
        still = Image.open(a.overlay).convert("RGB").resize((W, H), Image.LANCZOS)
        figs = draw(True, a.actor_height)
        mask = figs.convert("L").point(lambda v: 150 if v > 70 else 0)  # figures, lines and labels only
        still.paste(figs, (0, 0), mask)
        dest = os.path.splitext(a.overlay)[0] + "-scale-check.png"
        still.save(dest)
        print(dest)
        return
    os.makedirs(OUT, exist_ok=True)
    draw(True, a.actor_height).save(os.path.join(OUT, "wall-scale-guide.png"))
    plain = draw(False, a.actor_height).resize((2520, 630), Image.LANCZOS)
    ref = Image.new("RGB", (2520, 1080), (0, 0, 0))
    ref.paste(plain, (0, (1080 - 630) // 2))
    ref.save(os.path.join(OUT, "wall-scale-ref-21x9.png"))
    print(os.path.join(OUT, "wall-scale-guide.png"))
    print(os.path.join(OUT, "wall-scale-ref-21x9.png"))


if __name__ == "__main__":
    main()

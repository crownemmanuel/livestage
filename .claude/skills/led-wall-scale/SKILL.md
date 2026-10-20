---
name: led-wall-scale
description: Real-world scale and perspective of the Salvation show's LED wall (3072 x 768, 4:1), measured from a photo of a person in front of the test grid. Use before generating or reviewing any image or video for the wall where size matters next to the live actors (a lion, Goliath, David on screen, crowds, doors, set extensions), to size figures in pixels, place the horizon, attach the scale reference to a generation, or check a still with the overlay.
---

# LED wall scale

The wall is **3072 x 768 px (4:1)**. Its test pattern (Output Settings → Test pattern) is a 16 x 4 grid of **192 px squares**. The reference photo `docs/stage-reference/wall-scale-photo.jpg` shows a 1.68 m (5 ft 6 in) adult standing on a riser whose top is level with the wall's bottom edge, arms out, against that grid.

## Calibration (from the photo)

| | Wall pixels | Notes |
|---|---|---|
| The 1.68 m adult, head to feet, on the riser | **~425 px** = 55% of the wall's height | arm span ~420 px agrees |
| 1 metre at the wall's plane | **~253 px** | from the 1.68 m height; rerun the script with `--actor-height` to recalibrate |
| Grid square (192 px) | ~0.76 m | the wall is therefore ~12.1 m x 3.0 m |
| Stage floor near the wall | ~0.5 m (~126 px) below the wall's bottom edge | a 1.68 m actor on the floor shows from y ~ 469 down |
| Eye line, actor on the riser | y ~ 377 (49% down) | |
| Eye line, actor on the stage floor | y ~ 503 (65% down) | the usual case during scenes |

Sizes of things next to a live actor (feet at the wall's bottom edge):

| Subject | Real size | On the wall |
|---|---|---|
| Adult / actor | 1.68 m | ~425 px (55%); a 1.80 m actor ~455 px |
| Teenage David | ~1.6 m | ~405 px (53%) |
| Adult male lion | 1.2 m at the shoulder, ~2.5 m long | ~305 px tall (40%), ~630 px long (+ tail) |
| Sheep | ~0.8 m at the back | ~200 px (26%) |
| Goliath ("six cubits and a span") | ~2.9 m | ~735 px (96%) at true size, but **do not use it**: true size reads too small on the wall. Make him bigger than the wall (low angle, cut off at the shins, helmet at the top edge) |
| Door / doorway | ~2 m | ~505 px (66%) |
| One-storey house | ~3 m | the wall's full height |

Measured on the painted family square: the brothers are ~650-700 px tall, ~1.6x life size. That is fine for storybook pages played to a dark stage; any shot with a live actor in front of the wall needs life-size figures.

## How to use it when generating

1. **Decide whether the shot is life-size.** If a live actor is on stage in front of it (David with the lion, David facing Goliath, a street the cast walks in front of), it must be life-size. Storybook pages played while the stage is dark can be any scale.
   **A life-size shot is a window, not a film.** The audience must believe the lion (or Goliath) is really there, just behind the wall, so: a locked-off camera at a standing person's eye level (horizon ~65% down), a normal lens (no wide-angle, no dramatic low angle), real-time speed (no slow motion), and no close-ups. A subject coming toward the audience ends at its true size with its feet on the wall's bottom edge (a lion: shoulder ~40% of the height); it never grows past that or ends with a face filling the wall. Things further back are smaller by perspective, never bigger. The one exception is a climax that cuts straight to a blackout (the lion's charge in 1.2): it may rush all the way to the front and fill the wall in its last second.
2. **Put the numbers in the prompt as fractions of the frame**, which image and video models follow better than metres. For the 4:1 wall strip: "the lion stands with its feet on the bottom edge of the picture and its shoulder at about 40% of the picture's height; the horizon sits about 65% down, at a standing person's eye level; leave the left third of the foreground empty for a live actor."
3. **Attach the scale reference** `docs/stage-reference/wall-scale-ref-21x9.png` (21:9, letterboxed like our other keyframes) as one of the reference images, with one job: "@ImageN: scale and placement guide only: match the size and ground line of the silhouettes; ignore its colours, grid and shapes." Use it with GPT Image 2.5 and Seedance reference mode; drop it if a model starts copying the grid.
4. **Check the result:** crop to 4:1 (`media-src/prologue/opening/crop_wall.py`), then
   `python3 .claude/skills/led-wall-scale/scripts/scale_guide.py --overlay <still>-wall.png`
   and look at `<still>-wall-scale-check.png`: the figures should line up with the guide's silhouettes.
5. **In the app**, life-size cut-outs (clip actors with `layout`) can be scaled by these pixel heights; the Goliath default was tuned to fill the wall top to bottom, which matches ~2.9 m.

## Files

- `docs/stage-reference/wall-scale-photo.jpg`: the photo the calibration comes from.
- `docs/stage-reference/wall-scale-guide.png`: labelled 3072 x 768 guide for people.
- `docs/stage-reference/wall-scale-ref-21x9.png`: unlabelled guide, letterboxed, to attach to generations.
- `scripts/scale_guide.py`: regenerates both (`--actor-height` to recalibrate) and makes overlay checks (`--overlay`).

If the riser, the wall height or the seating changes, take a new photo with a person in front of the test pattern and remeasure: the person's height in grid squares (one square is 192 px) is all the script needs.

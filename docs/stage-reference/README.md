# Stage reference

Measurements of the real LED wall (3072 x 768, 4:1) for sizing visuals next to the live actors.

- `wall-scale-photo.jpg`: a 1.68 m (5 ft 6 in) adult on the riser at the wall's bottom edge, arms out, in front of the test pattern (16 x 4 grid of 192 px squares). They measure ~425 px tall, so 1 m is ~253 px at the wall and the wall is ~12.1 m x 3.0 m.
- `wall-scale-guide.png`: the wall with life-size silhouettes (actor on the riser, actor on the stage floor, lion, Goliath) and the two eye lines.
- `wall-scale-ref-21x9.png`: the same without labels, letterboxed to 21:9, to attach to an image or video generation as a scale reference.

How to use them, the size table, and the overlay check are in the project skill [`.claude/skills/led-wall-scale/SKILL.md`](../../.claude/skills/led-wall-scale/SKILL.md). Regenerate with `python3 .claude/skills/led-wall-scale/scripts/scale_guide.py --actor-height <metres>`.

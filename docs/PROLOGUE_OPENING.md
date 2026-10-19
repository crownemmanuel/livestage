# Prologue opening: the Book (in progress)

The first ~35 seconds of the show, from house-to-black to the lights coming up on David. It replaces the old P1 push-in opening; everything after it (the fields, the flock, the lion) stays as described in [PROLOGUE.md](PROLOGUE.md).

**Status (2026-10-19):** draft stills only (GPT Image 2.5, low quality, 1k) in `media-src/prologue/opening/drafts/`. Nothing is in the show yet. Next: approve the look, then animate 480p drafts, then high quality.

## The idea

A painted storybook world that turns real just before the audience sees the real David.

1. House to black. Title music. On the wall, an illustrated **Holy Bible** lies on a table by lamplight.
2. The cover opens by itself, the pages flip, and light pours out.
3. The pages settle on a painting of Bethlehem at dawn; the camera pushes into the page.
4. Through the light, we arrive in the painted **town square of Bethlehem** at dawn, outside Jesse's house: old Jesse in the doorway, his seven older sons busy with their own things, and the youngest, little storybook David, sent out with the sheep ("the youngest of eight brothers… every job nobody else wanted").
5. Drone shot: the camera rises and follows David and the flock out of town, over the hills and down to the pasture.
6. As it lands, the painting **morphs into the real pasture plate** the show already uses.
7. "…there was a young shepherd called **David**": the lights fade up on the real David, who walked to his mark in the blackout.

The storybook look follows the illustrated style reference (`media-src/prologue/opening/ref-illustrated-style.png`, the anointing image): a 2D hand-drawn animated-feature look with ink outlines and cel shading, not a painted photo. The shared style text is `prompts/style.txt`. **Storybook David and his family are Black** (dark brown skin; David has short curly black hair, a cream tunic, a muted red sash and a leather sling). Every later storybook image of David (the bear, the boy growing up, the anointing) must use the same description; the Script project's old intro prompts say olive skin and are out of date. The chosen model is GPT Image 2.5 with the hand-drawn style text; Nano Banana 2 (`MODEL=nano_banana_flash`) was the more cartoon-like alternative.

## Timeline

Times are seconds after the single GO that starts the opening. Audio comes from the audiobook project and is in `public/media/prologue/audio/`.

| Time | Wall | Audio | Stage |
| --- | --- | --- | --- |
| 0 | Closed Bible (still 1) | `title-theme.mp3` starts (25.05 s) | House and stage go black (Hog). David walks to his glow-tape mark. |
| ~1–9 | V1: the cover opens, pages flip, light grows (1 → 2) | | |
| ~9–14 | V2: pages settle on Bethlehem; push into the page (2 → 3) | | |
| ~14–24 | V3: through the light into the drone flight (3 → 4). Optional title "SALVATION · House of David" as live text. | | |
| 24.4 | V4: the dive down the hillside (4 → 5) | `flute.mp3` | |
| 26.3 | | `narrator/NAR-01.mp3`: "Once upon a time…" | |
| ~29–31.5 | V5: painted pasture morphs into the real plate (5 → `p1-wide-start`) | "…in the little town of Bethlehem" | |
| 33.6 | Real pasture | "…called **David**." (7.31 s into NAR-01) | Hog cue: warm light fades up on David over ~3 s. |
| 33.6 → | Existing push-in, then the field loop and the flock | NAR-02 follows | |

The clip lengths are targets: the animation pass fits them so V5 lands before "there was a young shepherd".

## How it runs in the app

Everything hangs off **one GO**, so picture, music, narration and the light cue stay locked to the same clock every night (the operator never has to hit a word).

- **Scene 1.1** gets a new clip actor, *Opening (Book → Bethlehem)*, layered over the existing *Fields* actor. Its rest pose shows the closed Bible (a short idle loop: lamp flicker, drifting motes), so the book can sit on the wall before the GO if wanted.
- Clips are chained on shared first/last frames (the same pattern as the rest of the prologue): V1 book-closed → book-open, V2 → page, V3 → aerial, V4 → painted pasture, V5 → real pasture. Each cut lands on a matching frame, so it plays as one continuous move.
- **Cue 1 "Open the Book"** (fires on GO) carries:
  - the clips in order (each `delay` = the sum of the previous clip lengths),
  - `sound` `title-theme` at 0, `flute` at 24.4, `NAR-01` at 26.3,
  - optional title text layer show/hide,
  - `send` Hog cue for house/stage to black at 0 and **lights up on David at 33.6**,
  - the existing Fields push-in at the moment V5 lands, so the hand-off to the real plate is invisible.
- The old "Push in (Once upon a time)" cue is absorbed into this one.
- Fallback (rule 6): if the timed Hog cue is not wanted, the lighting operator takes it on the word "David"; the wall is unaffected.

### The morph (V5)

Still 5 is a painted copy of the real plate `p1-wide-start` with the same composition, so painted → real can be done two ways:

- **Generated clip** (Seedance first frame = still 5, last frame = the real plate): the paint turns real while the camera is still moving. Costs one short clip.
- **Free fallback:** an in-app crossfade between still 5 and the real plate. The two are aligned, so it reads as the painting coming to life, not two pictures ghosting.

## Framing for the 4:1 wall

The LED wall is **3072 × 768 (4:1)**. No model outputs 4:1 (GPT Image 2.5 and Seedance top out at 21:9), so:

1. Every image is generated at 21:9 with a framing note that keeps the subject in the middle 4:1 band. For tall subjects (the book), `LETTERBOX=1 ./gen.sh …` asks for black bars so the picture is painted inside a true 4:1 strip.
2. The full 21:9 frame is kept as the master (`<name>.png`); video clips use the masters as first and last frames.
3. `crop_wall.py` cuts the wall version (`<name>-wall.png`, 3072 × 768 for finals; `WALL_ANCHOR` moves the crop). Clips get the same crop after generation.

A 21:9 frame loses about 42% of its height on the wall. The real prologue plates are 2912 px wide, a little under the wall's 3072, so their HQ re-renders should come out wider. `contact_sheet.py` stacks the wall crops in shot order.

### Encoding for playback

Every video the app plays must have a keyframe at least every 0.5–1 s, its native frame rate (the Seedance clips are 24 fps) and `+faststart`. The app keeps each video locked to the show clock and re-seeks one that drifts too far; with x264's default 10 s keyframe gap a re-seek decodes seconds of video and stalls. (The bigger cause of the opening's judder was the app correcting drift every frame; see ARCHITECTURE.md.) `vgen.sh`, `oneshot.sh` and `preview.sh` encode with `-g 12 -keyint_min 12 -sc_threshold 0 -movflags +faststart`.

## Draft → final

1. Drafts: stills at `--quality low --resolution 1k` (`gen.sh <name> low 1k …`), clips as 480p Seedance drafts.
2. Approve each still, then re-render it high quality (`gen.sh <name> high 4k …` writes to `final/`). The animation uses the finals as first/last frames.
3. Clips go to `public/media/prologue/opening/` with stable file names, so swapping a 480p draft for the HQ render needs no scene changes (same as the rest of the prologue).
4. All media lives under `public/media/prologue/`, which is what the show package export carries to the production machine.

Prompts are in `media-src/prologue/opening/prompts/`; every generation's job record (`*.json`, with the model, prompt and source URL) sits next to its image.

## Open decisions

- Hog cuelist numbers for "house and stage to black" and "lights up on David" (placeholders until the lighting designer gives them).
- Whether the app plays the narration for the whole prologue, or only NAR-01 in the opening and the sound desk plays the rest.
- Title card over the flight: yes or no.

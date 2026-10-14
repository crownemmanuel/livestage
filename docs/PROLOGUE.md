# Prologue (P1–P4)

The opening of *Salvation 2026: The House of David*. These scenes are built from AI video: generated stills, then image-to-video clips with matched first and last frames, so every cut lands on the same frame. Live effects (fog, shake, sling stone, blackout) run on top in the app.

All clips are **480p drafts**. Re-render them in HQ and swap them in (see [Swapping in HQ renders](#swapping-in-hq-renders)); no scene changes are needed.

## Running it

| Scene | GO | What happens | Voiceover sync (`audiobook/assets/regenerated/narrator/`) |
| --- | --- | --- | --- |
| **P1 Once Upon a Time** | Push in | 8 s push-in on the fields. As it lands, the field loop and the cut-out flock (with bleats) take over. | GO on the first words of NAR-01, "Once upon a time…" (8.0 s). The move lands on "…a young shepherd called David." |
| | Time-lapse to the wilderness | Takes P2 through a 10 s day-to-night time-lapse travel video. | GO as David's song to the sheep ends, so it lands on "Then one day…" (NAR-04). |
| **P2 The Lion on the Rock** | Lion climbs onto the rock | The lion rises up behind the ledge and walks out to the tip (6 s), then watches on a loop. | "…a lion came." (end of NAR-04) |
| | Lion roars and charges → lights out | **Cuts in immediately**: roar, leap, charge at the audience. Blackout 4.75 s later, on its face. | Real David runs. |
| | In the dark: David on the lion | Takes P3 with a cut. The wall stays black. | |
| **P3 David's Song** | Lights up | 2.5 s fade up on David standing on the lion (looping tableau). | "The lion lost." (NAR-05). The lights come up on the punchline. Real David leaves the stage and sings. |
| | Up to the heavens → Valley of Elah | 14 s travel video: tilt up from David to the Milky Way, then down through storm clouds into the battlefield. | GO on "And the boy grew." (NAR-07). It lands for "Years later…" (NAR-08, 26.8 s). |
| **P4 The Valley of Elah** | Goliath enters | He strides in from the right and plants himself, filling the wall top to bottom, then taunts on a loop. | "…their champion walked into the valley" (about 6 s into NAR-08). He's on his mark for "His name was Goliath." |
| | Sling! | Stone flies left to right (0.55 s) and flashes on his helmet. He drops shield and spear (small shake at +2.6 s), sinks to his knees and falls face down (earthquake at +6.4 s). | GO as real David releases, after "The battle is the LORD'S!" |

Notes:

- Each cue carries its sync note. Show Mode displays it under the cue.
- Blackout survives a TAKE, so P3 is taken in the dark and revealed with its first cue.
- **Interrupt** clips (the lion's charge, Goliath's fall) cut in the moment they're cued. Other clips wait for the current clip or loop to end so the cut lands on a matching frame.

## Adjusting to the stage

- **Flock size and position** (P1): select *Sheep (cut-out, stage left)* in the Scene Builder and change Scale, X/Y and Mirror under the cut-out layout. Shrinking slides the flock toward the horizon, so it reads as further away.
- **Goliath** (P4): same controls. The default (scale 0.73, pivot at his feet) fills a 32:9 wall from top to bottom.
  - If you move or scale him, update the *Sling stone* effect's Target X/Y (canvas fractions) so it still hits the helmet.
  - Turn up *Glow + streak* if the stone is hard to see on the wall.
- **Shake strength**: the two Shake effects in P4 (*shield hits the ground* and *Goliath hits the ground*) have Intensity, Duration and Frequency.
- **Vertical framing**: plates are 21:9 and the default wall is 32:9, so each plate is cropped top and bottom.
  - Background `anchorY` (0 = show the top, 1 = the bottom) sets the crop: P1 0.35, P2 0.05 (keeps the lion's mane on the ledge), P3 0.42, P4 0.5.
  - Keep each video actor's `anchorY` equal to its plate's.
  - Travel videos glide between the two plates' framings automatically.

## Media pipeline

Raw Runway outputs live in `media-src/prologue/` (not bundled). `media-src/prologue/build.sh` turns them into the show files in `public/media/prologue/`. It:

- converts the stills to JPG;
- chroma-keys the green-screen clips (sheep, Goliath) into VP9-alpha WebMs with despill;
- loops the flock twice to 20 s and muxes in the 20 s bleating ambience;
- trims Goliath's fall to start at the stone impact (1.30 s), so the app's stone flies in instead of the model's;
- stitches the tilt-up and tilt-down into one sky travel video.

```bash
bash media-src/prologue/build.sh
```

Steps: `stills`, `sheep`, `goliath` or `p3` (default `all`).

### Runway tasks

Stills were made with GPT Image 2.5 Sunburst (2K, 21:9). Clips are Seedance 2.5 drafts (480p, 21:9), which can be enhanced to 1080p within 7 days of creation (until about 2026-10-17).

| File in `media-src/prologue/` | Runway task |
| --- | --- |
| a0-wide.png (push-in start) | 940a2699-86c8-4650-9635-df8223da3c28 |
| a1-fields.png (fields hero, with flock) | cd673f80-8513-4e50-a627-e98404cf0498 |
| a2-sheep-green.png (flock on green) | 1f621f57-2244-4021-a84d-5e43579e6556 |
| a3-fields-clean.png (fields, no sheep) | 7e682637-8e59-441a-ae36-12f963ce0d7d |
| b1-rock.png (Lion Rock, night) | 3eea0710-0504-4335-916d-ee79c9662554 |
| b2-lion-rock.png (lion on the ledge) | 74d7b0b3-5f72-436f-ad6c-d549fc8f3320 |
| c1-david-lion.png (David on the lion) | 3ce2fa9a-a9ff-44f7-ad9a-1fcbbf8cc246 |
| s1-sky.png (Milky Way) | 6acc7cef-be90-4c70-b653-f20eee04b5e5 |
| d1-battlefield.png (Valley of Elah) | f3586fa0-c34a-4cb2-8cf0-f8ca0d5c9315 |
| d2-goliath-hero.png (Goliath in the valley) | aae8c875-eecf-4420-a4f1-548e7aabadf8 |
| d3-goliath-green.png (Goliath on green) | 9b0404cb-2f5b-42d9-a46a-52ba0e4eb647 |
| p1-push-in.mp4 (8 s, A0 → A1) | e172f20b-e5b3-4a40-82e2-0b652468dab8 |
| p1-fields-loop.mp4 (10 s, A3 → A3) | 350910d6-8093-4f79-99c6-ffe07183b622 |
| p1-sheep-green.mp4 (10 s, A2 → A2) | 20af21a9-085e-4699-b40a-55db240b78be |
| p1-p2-timelapse.mp4 (10 s, A1 → B1) | 0469a550-a1c7-4fcc-b49c-8e0bb6a528e4 |
| p2-lion-climb.mp4 (6 s, B1 → B2) | 261782a6-0ee2-434a-844e-349575f0c69b |
| p2-lion-idle.mp4 (8 s, B2 → B2) | 4f083454-2eef-4345-9dcf-173727475a63 |
| p2-lion-charge.mp4 (5 s, from B2) | ed2b587f-7a57-4be9-88cc-4e87c90d0dfd |
| p3-david-lion-loop.mp4 (10 s, C1 → C1) | 2c475cfe-f445-41c8-8311-3b3f90134b3d |
| p3-tilt-up.mp4 (6 s, C1 → S1) | 181ab1e7-0d5f-4f7d-a38f-eebd2b2440ae |
| p4-tilt-down.mp4 (8 s, S1 → D1) | 5b8eb38d-e398-4528-a762-55193fc03700 |
| p4-battlefield-loop.mp4 (10 s, D1 → D1) | 52a4d31e-adaf-4ad0-90e2-66a7eb05c7f1 |
| p4-goliath-enter-green.mp4 (6 s, green → D3) | 1bdd93ca-a06a-4f93-846b-9605ef676186 |
| p4-goliath-taunt-green.mp4 (10 s, D3 → D3) | ddc007c0-9617-4667-bf80-f96489a6e820 |
| p4-goliath-fall-green.mp4 (8 s, from D3) | 16929bef-8193-40d5-b400-f668fcc5c8a6 |
| sheep-ambience.mp3 (20 s loop) | df0ab8fd-375d-4954-abfe-3399a37404de |

### Swapping in HQ renders

1. Enhance or re-render the clip in Runway and download it.
2. Save it over the file with the **same name** in `media-src/prologue/`.
3. Run `bash media-src/prologue/build.sh`.

The scenes reference the built files by name, so nothing else changes.

If you change the fall clip, re-measure when the stone hits and update the trim in `build.sh` (`-ss 1.30`). Re-measure the two shake delays as well: shield and spear land about 2.05 s into the trimmed clip, and Goliath hits the ground at about 5.85 s.

## Known draft issues

- **Goliath's fall**: the model drew its own stone. The trim removes it, but a faint trail line lingers near the top for about 0.7 s.
  - For the HQ version, regenerate without a stone in the prompt ("he is suddenly struck on the forehead, his head snaps back…").
- **Crop on a 32:9 wall**: Goliath's helmet crest touches the top edge, and the lower part of the fallen lion is cropped in P3. Adjust Scale or `anchorY` to taste.
- **Sheep loop seam**: the start and end frames match closely but not perfectly (about 34 dB PSNR). A slight pop is possible every 10 s.
- **Transparent WebM**: the cut-outs need a Chromium webview (Windows / WebView2). macOS WKWebView may not show VP9 alpha. Test on the show machine, or export HEVC-with-alpha for Mac.

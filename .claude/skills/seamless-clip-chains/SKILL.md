---
name: seamless-clip-chains
description: How to generate AI video clips that cut into each other on the LED wall with no visible jump (the method that made the 1.2 lion seamless), and how to soften joins that don't match. Use when planning or generating a character who climbs, idles, talks, loops or falls across several clips played by a clip actor, or when cuts between clips look hard.
---

# Seamless clip chains

A clip actor plays a chain of clips: an entrance, an idle loop, an action, more loops. The audience sees a "cut" wherever one clip hands over to the next. The 1.2 lion (climb → pace-and-roar loop → lunge) shows no cut at all. The Goliath talking clips did, at first. This is what made the difference.

## Why the lion is seamless

1. **One keyframe owns every join.** Before any video, make the keyframe for each *resting state* (`k1` empty rock, `k2` lion on the rock). Every clip that starts or ends at that state is generated with that exact image as its **start frame and/or end frame** (`startFrame` / `endFrame` on Runway Seedance):
   - climb: start `k1` → end `k2`
   - pace-and-roar loop: start `k2` → end `k2`
   - lunge: start `k2` → end (free, or black)
   Both sides of every join are pinned to the same picture, so the last frame of one clip and the first frame of the next are nearly identical.
2. **The same generator and settings for every clip:** Runway Seedance 2.5, 21:9, the same draft → enhance → upscale path. A different model (or a reference-image-only generation) frames the shot slightly differently: wider, darker, shifted. That is a visible jump.
3. **The same 4:1 crop for every clip in the chain** (same strip offset in the letterboxed frame).
4. **Joins happen only at clip boundaries.** Loops are clips with `autoIdle`. A following clip with `interrupt: false` waits for the loop to come back to its first frame (the keyframe) before cutting. Use `interrupt: true` only where the cut must be instant and something hides it (a flash, a blackout, an impact).

## Talking clips: let Seedance speak, then change the voice

To keep a talking clip seamless, generate it like any other clip in the chain: **start and end frame = the keyframe**, and put the line in the prompt in quotes. Seedance invents a voice and lip-syncs to it. Then:

1. Extract the clip's audio (`ffmpeg -vn … .mp3`).
2. Run it through the ElevenLabs **voice changer** (speech-to-speech, `eleven_multilingual_sts_v2`) with the character's voice (Goliath: `ysswSXp8U9dFpzPJqFje`). The words and timing stay the same, so the lip-sync still matches.
   - The ElevenLabs connector needs the audio at a public https link and reads `.mp4` as video. Host the `.mp3` with `higgsfield upload create file.mp3` (it returns a cloudfront URL), then attach it to a flow, add a `voice-changer` node connected to it, and run it.
3. Mix the converted voice back under the clip's own rain and ambience, and encode it with the same crop as the rest of the chain.

Tested on 2026-10-20 with Goliath's two lines: the joins with the loops measured 3–4 (invisible), against 11–18 for the reference-video method below.

## What broke the Goliath talking clips (the reference-video method)

- Lip-sync on Runway needs the voice passed as a reference video, and **reference videos cannot be combined with start/end frames**. The frame then only goes in as a reference image, so the model reframes the shot slightly (about 2% wider), and every join jumps.
- An edit-source video (`referenceVideo`) keeps the source video's own shape and ignores `ratio` (it came back 16:9).

## Checklist for a new chain

1. List the resting states and make one keyframe for each (with the scale guide when size matters).
2. Generate every clip with start/end frames from those keyframes. Loops use the same keyframe at both ends.
3. Measure every join: compare the last frame of clip A with the first frame of clip B (mean pixel difference on 0–255). Under about 5 is invisible. Rain or weather alone gives about 9. Above about 12 is a visible jump.
4. Talking clips: use the voice-changer method above. Only if a clip truly can't take start/end frames:
   - pin the framing in the prompt ("The video IS the picture @frame… pixel for pixel… locked off… no zoom");
   - measure scale and offset against the neighbouring clip and correct it in ffmpeg (`scale` + `crop`);
   - start it at a loop boundary (`interrupt: false`);
   - give the actor a **crossfade** (below).
5. Wire it: clip actor `frameAspect: 4`, `fit: cover`, not matted; poses chain the clips (`startPose` / `endPose`), and loops use `autoIdle`.

## Softening joins that don't match: crossfade

Clip actors have `crossfade` (seconds; 0 = hard cut, the default). For that long after a clip starts, the clip it replaced keeps playing underneath while the new one fades in on top; their audio crossfades too. 1–1.5 s hides small framing or weather differences. Set it in the inspector ("Crossfade (s)") or by MCP (`component_update` with `{crossfade: 1.5}`). Neither the lion nor Goliath uses it now (both chains are pinned to keyframes).

Don't rely on crossfade for big differences (a different pose or size): it reads as a dissolve. Fix the frames instead.

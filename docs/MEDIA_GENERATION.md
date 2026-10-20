# Generating video for the wall

How the show's AI video is made, so any agent can continue it. The worked example is the prologue (1.2 lion, 1.3 David on the lion, 1.4 Goliath): sources and prompts are in `media-src/prologue/p2-hq`, `p3-hq` and `p4-hq`.

## Ground rules

- **Ask first.** Show the prompts and get the user's go-ahead before spending credits (Runway, Higgsfield, ElevenLabs).
- **Never commit video files.** Video extensions are ignored by git; keep sources in `media-src/` and wall-ready files in `public/media/`.
- **No music in any clip.** Say it explicitly in every prompt: "Sound: only the diegetic sound of the scene: …. No music, no score, no soundtrack, no drums, no text." Music and narration are played by the app as separate cues.
- **Don't put live actors on screen.** For example, David is played live; he never appears in the Goliath clips.
- **Scale:** read the `led-wall-scale` skill. Life-size subjects stand behind the wall as if it were a window. Goliath is the exception: he is drawn bigger than the wall.

## Pipeline (Runway)

Use Runway for everything (the `runway` MCP), so every clip comes from the same model with the same framing and colour. Mixing generators (e.g. a Higgsfield clip between Runway clips) made the picture jump at the cut: the other model framed the shot slightly wider and darker.

1. **Keyframes** with GPT Image 2.5 (Higgsfield CLI). Make a low-quality draft first, then high quality in 4K. Compose for the 4:1 wall inside a 21:9 frame with black bars (the `LETTERBOX` framing in `media-src/prologue/opening/gen.sh`). To control size and position, draw a flat magenta placement guide on the plate and ask the model to replace it (`p2-hq/guide.py`, `p4-hq/guide_profile.py`).
2. **Drafts:** `generate_video`, model `seedance-2.5`, `draft: true` (480p), ratio 21:9, with start and end frames. Loops use the same image as their first and last frame.
3. **Approved draft → 1080p:** `enhance_video_draft` with the draft's task id.
4. **1080p → 4K:** `upscale_video` with the enhance task id. The 4K file can lose its audio track; take the audio from the 1080p file.
5. **Crop to the wall:** cut a 3072×768 strip out of the picture between the bars. Clips that cut together must use the same crop. Check every join by comparing the last frame of one clip with the first frame of the next (mean pixel difference: under ~5 is invisible, rain alone gives ~9).
6. **Encode for playback:** H.264 at 24 fps with a short GOP (`-g 12 -keyint_min 12 -sc_threshold 0 -movflags +faststart`); see `docs/PROLOGUE_OPENING.md`.

Seedance writes its own sound effects from the prompt. Describe exactly what we should hear.

## Lip-sync to a recorded voice on Runway (the black-video trick)

Runway's video tool takes no audio input. To make a character speak a line recorded elsewhere (ElevenLabs, or the audiobook), wrap the line in a video:

1. Make a black video that carries the voice, a little longer than the line:
   ```bash
   ffmpeg -f lavfi -i color=c=black:s=1280x548:r=24 -i line.mp3 -filter_complex "[1:a]apad=whole_dur=9[a]" -map 0:v -map "[a]" -t 9 -c:v libx264 -crf 30 -pix_fmt yuv420p -c:a aac -b:a 192k line-black.mp4
   ```
2. Upload it (`init_upload` → `curl` PUT → `complete_upload`) and pass it in `referenceVideos` with its `durationSeconds`.
3. `referenceVideos` cannot be combined with `startFrame`/`endFrame`. Pass the character's frame in `referenceImages` with a `tag` instead, and say in the prompt that it is the exact first and last frame.
4. In the prompt: "@Video1 is used only for its audio: it is CHARACTER's voice. Ignore its black picture. CHARACTER speaks that audio, lip-synced exactly to every word, with the same timing." Then describe the performance.
5. After rendering, put the original recording back onto the clip in place of the model's re-voiced audio, so the voice is exactly the recorded one.

What made it hold the framing (tested 2026-10-20 on Goliath's taunt):
- Set `ratio: "21:9"` on the generation. Do **not** pass the voice as the edit source (`referenceVideo`): an edit keeps the source video's own shape and ignores `ratio` (it came back 16:9 and zoomed in).
- Attach the exact first frame (21:9, with its black bars) in `referenceImages` with a tag (e.g. `frame`). Start the prompt with "The video IS the picture @frame brought to life: exactly the same wide shot … pixel for pixel … camera locked off on a tripod: no zoom, no push-in, no reframing, no close-up". End with "Final frame: identical to @frame."
- Even then the model frames about 2% wider. Measure scale and offset against the neighbouring clip's frame and correct it in ffmpeg (`scale` + `crop`) so the cut is clean.
- Moderation: avoid words like "child" or "small" in the prompt (the input check flags them).

Goliath's voice is the ElevenLabs library voice "Malvoryx" (`ysswSXp8U9dFpzPJqFje`), the same as the audiobook (`~/Documents/Videos/Salvation/Script/audiobook/cast.json`).

## Seamless chains

See the project skill `.claude/skills/seamless-clip-chains` for why the 1.2 lion cuts are invisible (shared keyframes as start/end frames, one generator, one crop, joins at loop boundaries) and for the clip-actor `crossfade` setting that softens joins that don't match.

## Wiring into the app

- Each segment is a clip of a **clip actor** (`frameAspect: 4`, `fit: cover`, not matted). Poses chain the clips: a clip with `autoIdle` plays whenever the actor rests in its start pose, and a finished clip holds its last frame.
- Clips that must start the moment their cue fires (a stone hit) use `interrupt: true`. Clips that should start on a matching frame wait for the loop to end (`interrupt: false`).
- Put shakes, the sling stone and other effects on the cue with delays timed to the clip. Use the effects in the app, not shakes baked into the video, so they can be retimed.
- A scene that ends in black: put the black frames in the clip itself. Don't use the app's blackout, which carries over into the next scene.

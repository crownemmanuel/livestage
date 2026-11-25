# Generating video for the wall

How the show's AI video is made, so any agent can continue it. The worked example is the prologue (1.2 lion, 1.3 David on the lion, 1.4 Goliath): sources and prompts are in the show's `edits/prologue/p2-hq`, `p3-hq` and `p4-hq`.

## Ground rules

- **Ask first.** Show the prompts and get the user's go-ahead before spending money (KreatorFlow, Kie.ai, Runway, Higgsfield, ElevenLabs); `gen.py video --dry-run` prints the request and the price.
- **Log every generation, so any scene can be regenerated.** Each generation (image, video, upscale) gets a line in the `prompts.jsonl` of the folder under the show's `edits/` its output lands in. `gen.py` writes it for you; anything made another way is written with `media-src/tools/genlog.py add` when the job starts. Record the LiveStage scenes (code and id) and asset ids it feeds, the model and settings, the source files (paths in the show folder, or a Runway task id when a source only exists there), the task id, the credits and the full prompt. Mark each take `used`, `draft`, `rejected` or `superseded`, and keep every source file you cut or prepared next to the log. To redo a scene, start with `python3 media-src/tools/genlog.py find <scene code, scene id, asset id or any text>`. It prints the prompts and sources that made it. (The 1.7 walk-in prompt once had to be dug out of an old session; Runway `list_recent` + `get_task` and the session-transcript search can recover older ones.)
- **Never commit video files.** Video extensions are ignored by git; keep sources in the show's `edits/` and wall-ready files in its scene folders (see "Where media lives" below).
- **No music in any clip.** Say it explicitly in every prompt: "Sound: only the diegetic sound of the scene: …. No music, no score, no soundtrack, no drums, no text." Music and narration are played by the app as separate cues.
- **Don't put live actors on screen.** For example, David is played live; he never appears in the Goliath clips.
- **Scale:** read the `led-wall-scale` skill. Life-size subjects stand behind the wall as if it were a window. Goliath is the exception: he is drawn bigger than the wall.

## Pipeline (KreatorFlow + Kie.ai, the default from 2026-10-28)

Video is generated through `media-src/tools/gen.py`, which talks to two pay-per-second APIs instead of Runway credits. Keys go in the repo-root `.env` (`KREATORFLOW_API_KEY`, `KIE_API_KEY`; names in `.env.example`). Every run logs itself in the folder's `prompts.jsonl` and writes `<out>.json` beside the clip.

| Model | Provider | `--model` | Price (10 s) | Notes |
|---|---|---|---|---|
| Seedance 2.0 Fast | KreatorFlow | `fast` (default) | $0.58 480p · $0.84 720p · $1.83 1080p | up to 10 s, 21:9 ok, no 4K |
| Seedance 2.0 | KreatorFlow | `seedance` | $1.10 720p · $2.40 1080p · $5.80 4K | up to 15 s |
| Seedance 2.5 | KreatorFlow | `seedance-2.5` | $2.07 720p · $4.44 1080p | up to 30 s |
| Kling 3.0 | Kie.ai | `kling` / `kling-pro` / `kling-4k` | $0.70, $1.00 with sound | 16:9, 9:16, 1:1 only (follows the first frame) |
| Topaz upscale | Kie.ai | `gen.py upscale --factor 2` | per clip, see Kie.ai | input file ≤ 50 MB |

The default is **Seedance 2.0 Fast at 720p**, then **Topaz 2x** for the wall, instead of rendering at 1080p/4K: 720p at 21:9 is 1706×720, so 2x gives 3412×1440, enough for the 3072×768 crop.

1. **Keyframes:** as before (GPT Image 2.5 on Runway or Higgsfield, 21:9, `LETTERBOX` framing).
2. **Draft:** `gen.py video <folder> --out <code>-<name>.mp4 --prompt-file p.txt --first a.png --last b.png --scenes 1.2 --res 480p` ($0.58). Add `--dry-run` first to show the request and price and get the go-ahead.
3. **Approved → 720p:** same command at the default `--res 720p` (keep `--seed` from the draft's JSON when the API returned one; Seedance does not promise the same take).
4. **720p → wall size:** `gen.py upscale <folder> --in <clip>.mp4` (Topaz 2x on Kie.ai, writes `<clip>-2x.mp4`).
5. **Crop and encode** as in the Runway pipeline below (steps 5 and 6).

Google Flow (the `google-flow` skill, 16:9 only): a whole wall still or shot goes in **letterboxed**, the 4:1 picture with black bars top and bottom (`.claude/skills/google-flow/scripts/letterbox.py frame`), and the band is cropped back out of the clip; never outpaint the still to fill 16:9. A 16:9 patch of a plate needs no bars.

Seedance rules that still hold: describe the exact sound (or leave `--audio` off and let the app play it), start and end frames cannot be combined with reference images on KreatorFlow, and a photo of a real person is refused as a reference. Kling is the second opinion when Seedance keeps missing a motion; its frames must be 16:9 (it follows the first frame's shape), so crop the 21:9 keyframes to 16:9 first and accept a different crop for that clip. Lip-sync to a recorded voice: KreatorFlow takes `--ref-audio` directly, so the black-video trick below is only needed on Runway.

Open until the keys arrive: the KreatorFlow upload response field names (`gen.py` reads `direct_upload_url` / `upload_id` and prints the response if they differ) and the Topaz price on Kie.ai. Run `gen.py models` once to confirm the aliases and durations.

## Pipeline (Runway, until 2026-10-28)

Runway is still available (the `runway` MCP) and remains the route for `enhance_video_draft` and edits of clips that already live there. Keep one generator per chain of clips (Runway or KreatorFlow), never mixed: mixing generators made the picture jump at the cut.

1. **Keyframes** with GPT Image 2.5 (Higgsfield CLI). Make a low-quality draft first, then high quality in 4K. Compose for the 4:1 wall inside a 21:9 frame with black bars (the `LETTERBOX` framing in `edits/prologue/opening/gen.sh`). To control size and position, draw a flat magenta placement guide on the plate and ask the model to replace it (`p2-hq/guide.py`, `p4-hq/guide_profile.py`).
2. **Drafts:** `generate_video`, model `seedance-2.5`, `draft: true` (480p), ratio 21:9, with start and end frames. Loops use the same image as their first and last frame.
3. **Approved draft → 1080p:** `enhance_video_draft` with the draft's task id.
4. **1080p → 4K:** `upscale_video` with the enhance task id. The 4K file can lose its audio track; take the audio from the 1080p file.
5. **Crop to the wall:** scale to 3072 wide and cut a 3072×768 strip out of the picture between the bars (`media-src/tools/wallcrop.py crop`; `wallcrop.py find MASTER WALL` measures the strip a clip already on the wall used, so a redo matches it). Clips that cut together must use the same crop. Check every join by comparing the last frame of one clip with the first frame of the next (mean pixel difference: under ~5 is invisible, rain alone gives ~9).
6. **Encode for playback:** H.264 at 24 fps with a short GOP (`-g 12 -keyint_min 12 -sc_threshold 0 -movflags +faststart`); see `docs/PROLOGUE_OPENING.md`.

Seedance writes its own sound effects from the prompt. Describe exactly what we should hear.

## Giving a clip a character's voice (voice changer)

When a clip speaks in the model's voice and should speak in a cast voice, keep the clip's own audio and change only the voice:

1. Export the clip's audio exactly as it is (`-c:a copy`: no resampling, no clean-up).
2. Run it through ElevenLabs' voice changer (speech-to-speech, `eleven_multilingual_sts_v2`) with the character's voice, background removal off.
3. Put the result back on the same picture. It follows the original syllable for syllable, so the lips stay in sync.

`python3 media-src/tools/voicechange.py MASTER.mp4 VOICE_ID OUT.mp4 --vf "<wall crop>"` does all three, cropping the master to the wall in the same pass. Never generate the line again with text-to-speech and lay it over the clip: its pacing differs and the lips drift (1.4's "They send me a child?" did, until it was redone this way on 2026-11-09).

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

## Still plates, animated patches and cut-outs

A still backdrop stays sharp when only parts of it move: animate 16:9 patches and feather them in (the `still-plate-patches` skill). A subject that arrives on cue (the goat that walks into 2.1's street) is generated inside a crop of the plate, cut out, animated on green and played as its own transparent layer (the `plate-cutouts` skill), so nothing already rendered is rendered again.

## Seamless chains

See the project skill `.claude/skills/seamless-clip-chains` for why the 1.2 lion cuts are invisible (shared keyframes as start/end frames, one generator, one crop, joins at loop boundaries) and for the clip-actor `crossfade` setting that softens joins that don't match.

## Wiring into the app

- Each segment is a clip of a **clip actor** (`frameAspect: 4`, `fit: cover`, not matted). Poses chain the clips: a clip with `autoIdle` plays whenever the actor rests in its start pose (several on one pose take turns in list order, each cut where it ends), and a finished clip holds its last frame.
- Clips that must start the moment their cue fires (a stone hit) use `interrupt: true`. Clips that should start on a matching frame wait for the loop to end (`interrupt: false`).
- Put shakes, the sling stone and other effects on the cue with delays timed to the clip. Use the effects in the app, not shakes baked into the video, so they can be retimed.
- A scene that ends in black: put the black frames in the clip itself. Don't use the app's blackout, which carries over into the next scene.

## Where media lives

Show media never lives in the repository (the repo is the app). Each show has a folder in the **workspace** (app Settings → Workspace folder, MCP `workspace_get`; default `~/Documents/LiveStage`):

```
<workspace>/<show>/
    .show.json                         written by the app: which show this folder is
    <Group or scene>/images|audio|video|other/    finals: what the wall plays
    edits/                             everything editable, for agents and people to work in:
        edit/<scene>/                  Premiere edits (editkit.py)
        <any work folder>/             sources, drafts, test renders, per-show scripts, prompts.jsonl logs
        archive/                       superseded and unused media, MOVES-<date>.json undo records
```

`EDITS="$(python3 media-src/tools/workspace.py)"` gives the edits folder; `gen.py`, `genlog.py` and `editkit.py` find it the same way (`SLS_SHOW=<folder name>` picks a show when there are several, `SLS_EDITS` overrides). The tools themselves are code and stay in the repo (`media-src/tools/`).

- **Finals**: one folder per running-order group (or per ungrouped scene, named from the scene name without codes), with `images/`, `audio/`, `video/` and `other/` (3D models) inside. File names are lowercase-hyphenated and start with the running-order code of the main scene that uses them: `1.4-goliath-walk-in.mp4`, `2.1-goat-walk-in-solid.webm` (+ `.mov` twin).
- **An asset plays a final through `rel`**, its place in the show folder: `patch project/assets/<id>/rel` = `Prologue/video/1.4-goliath-walk-in.mp4` (`macRel` for the `.mov` twin). The app plays the workspace file whenever it is there; reload the show or call `workspace_set` after setting `rel` so the running app picks it up. `asset_import` still copies into the app data folder for now: for show media, copy the file into the show folder and set `rel` instead.
- **Replacing a final**: put the new file beside the old one under a new name (the app caches by URL), archive the old one in `edits/archive/<its place>`, and repoint `rel` (scenes reference assets by id, so nothing else changes). `editkit.py deliver` does this for Premiere edits.
- App built-ins that are not show content stay in the repo's `public/media/`: `announcements/`, `sfx/`, `lion-proof/`, `shepherd-photo/`, `voice-samples/`, `banners/`, `pbr-valley/` and `app-demo/prologue-v1/` (the demo project's prologue). `public/media/scenes/` and the old `media-src/` work folders are from before the workspace and are being retired.

### Housekeeping (every media task ends with this)

1. **Finals only in the show's scene folders**, editable work only in `<show>/edits/` (`edits/edit/<scene>/` for Premiere edits). Never leave a render, draft or test clip in a final folder, in the repo or in `/tmp`.
2. **Archive what you replaced or made while working**: the old final, rN renders you no longer use, scratch crops and test encodes go to `edits/archive/` with their relative path. Never delete.
3. **Record moves** in `edits/archive/MOVES-<date>.json` (`{"moves": [{"from", "to"}]}`) so any move can be undone.
4. **Check before you archive**: a file is in use if an asset (`rel`, `macRel`, `url` or `macUrl`), an edit folder (`edit.json`, `build.py`, `sources/`) or a build script points at it. `list_assets` + `genlog.py find <asset id>` show this. Deleting a scene does not delete its assets: archive their media only after confirming nothing else uses them.
5. **Packages and cloud sync** will carry the show's finals; `edits/` stays on the computer it was made on (see docs/SHOW_PACKAGE.md).

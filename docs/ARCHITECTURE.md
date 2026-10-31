# Architecture

## One authority, many views

```
┌──────────────────────── Operator window (authoritative) ────────────────────────┐
│ Project store (scenes, assets, output settings) ──autosave──► app data / project.json │
│ Show store: program (live) runtime + preview runtime + actor poses               │
│ Services: 60 Hz actor simulation · cue runner · keyboard · thunder (if audio host)│
│ Views: PREVIEW monitor ◄─ preview runtime      PROGRAM monitor ◄─ program runtime │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                │ Tauri events (BroadcastChannel in browser dev)
                │  "project": assets + output settings        (on change)
                │  "program": live state (on change) + each run's scene once
                │  "poses":   actor poses                      (≤ 30 Hz)
                ▼
┌──────────── Audience output window (pure view) ────────────┐
│ Renders exactly what the PROGRAM monitor renders.          │
│ Sends back: "hello" (resync) and a 1 s health heartbeat.   │
└─────────────────────────────────────────────────────────────┘
```

There is only one playback engine: the operator window's state. The operator also runs the show-control I/O (`engine/io.ts`, native MIDI/OSC in `src-tauri/src/io.rs`) and the live-state persistence (`engine/persist.ts`), and it polls media time markers at 60 Hz. The PROGRAM monitor and the audience output render that same state with the same React/Three.js code (`render/StageView.tsx`). Nothing drifts, because every animated value is a **pure function of a shared clock**:

- `performance.timeOrigin + performance.now()` gives the same wall clock in every window on the machine.
- Each scene instance (`SceneRuntime`) has its own scene clock (`clock.base`, `clock.pausedAt`). **Freeze** stops it, and every effect, tween and video holds its frame. Video transport (hold, scrub, resume) is built on it: a scrub moves `clock.base` and records `clock.reached`, so markers and timed cues never fire for a stretch that was jumped over or replayed ([VIDEO_TRANSPORT.md](VIDEO_TRANSPORT.md)).
- Changes are stored as *timestamped events*, never as per-frame values. Examples: an effect's `{active, changedAt}`, a background change `{current, previous, changedAt, dur}`, a time-of-day tween `{from, to, at, dur}`, a camera move `{from, to, at, dur}`, a lightning strike `{at, seed}`. Every view evaluates them at "now" and gets the same answer.
- Procedural motion (rain drops, grass sway, birds, sheep, walkers, lightning bolt shapes) uses seeded randomness plus time, so the geometry matches in every window.
- Video layers are slaved to the clock. Each frame, `syncVideo` compares `currentTime` with the expected media time, but corrects rarely: WebKit (the desktop app) stalls on every seek and every `playbackRate` change, so per-frame correction makes a video judder and fall behind. Drift inside a dead band (50 ms muted, 120 ms with sound) is left alone; beyond it the rate steps ±5% once until the drift settles; beyond 0.6 s (or across a loop wrap) it hard-seeks, at most every 1.5 s, then waits 1 s before judging drift again. The output window reports each playing video's seeks, rate changes and drift in its heartbeat (`status` → `output.status.video`). Media files need a keyframe at least every second (see PROLOGUE_OPENING.md, Encoding for playback). Speed ramps (`media.speed`) are stored as `{from, to, at, dur}` and media time is their integral, so a ramp never jumps; reverse playback scrubs by seeking.
- Sound cues (`sound` actions) play in the window that hosts audio (`engine/audio.ts`), one copy per sound file: firing the same sound again (re-firing its cue, re-taking the scene) fades the playing copy out over 0.15 s and starts the new one, so a GO pressed twice never stacks the narration. Different sounds still overlap. Taking another scene (or re-taking the same one) fades the previous run's sounds out over 0.8 s, unless the sound action has `keepPlaying: true` ("keep playing into next scene" in the cue editor) and the TAKE carries the story on: the next scene in the running order, or one the live scene's cues take (`ProgramState.continues`). A retake or a jump (rehearsing out of order) fades even those out over 0.8 s, so the scene's own cue starts its song from the top; a scene with `stopCarriedSounds` ("Stop music from earlier scenes" in its settings) fades those carried sounds out over 3 s when it is taken. A sound with `loop: true` starts again from the top until something fades it out, so a music bed can run under scenes of any length; with "fade out chosen audio…" a later cue (the song, say) can fade just that bed, and the cue editor lists keep-playing music from other scenes for this. Likewise, re-firing a cue drops the delayed actions still waiting from its earlier run (`runCue` in `engine/operator.ts`; pending actions carry their cue id, also through crash recovery), so a cue that builds a timeline restarts it cleanly. Use the layer op `restart` to replay a video from the top.
- Music survives restarts and follows jumps. A run's `sounds` list says what is playing (`core/music.ts` `soundLives`: an event stops when a later copy of the same file, a later `fadeOthers` or the end of its file stops it), and a TAKE that carries the story on copies the keep-playing sounds into the new run's list (`carriedSounds`, same ids, `at` rebased to the new scene clock), so the persisted program always holds the music playing. An audio host that meets a sound it has not played (it restarted, the live state was restored, it just took over from the other window) starts it where the clock says it is now with a 0.5 s fade-in; a window that stops being the audio host fades its sounds out. The **music chase** (`engine/musicChase.ts`, show-wide `chaseMusic`, default on): firing a cue by hand out of order, or taking a scene out of running order, works out from the cues alone what would be playing there had the show run in sequence (`nominalMusic`: time cues at their time, follow cues after the one before, video cues at their marker, GO cues at the time they last fired in a run in sequence, learned into `Project.cueTimings`) and adds `chase` sound events (`at` in the past, so they start part-way) plus a stop event fading what would not be playing; the status bar says "Music chased: … → 1:42". Fire now also marks the cues before the fired one as passed, and drops the sound actions other cues still had waiting.
- An `audio.fade` action fades audio out at its moment without starting anything (the same `which` / `fade` as `fadeOthers`; a `SoundEvent` with no asset): where a music bed stops.
- A sound action can fade other audio out as it starts (`fadeOthers`: `"all"` or a list of mixer keys, plus a fade time; "as it starts" in the cue editor). It is a timestamped event: `engine/audio.ts` ramps the other cue sounds down from the sound's start, and `videoAudioFade` in `core/runtime.ts` scales video sound by the time since that event, so every window agrees.
- The live mixer (Show mode, top of the right panel; `engine/mixer.ts`, `ui/show/MixerPanel.tsx`) lists every source sounding on the wall, each with an icon and colour for what it is: cue sounds by the asset's `audioRole` (music violet, voice blue, ambience green, effect orange; guessed from the file name when unset, `audioRoleOf`) and video sound in amber. The speakers are chosen under Settings → Audio output, not in the mixer. It lists cue sounds (reported by the audio host; the output window sends them in its heartbeat) and video layers, video backgrounds and video actors with their sound on. Each fader is a trim in `ProgramState.mix` (`sound:<assetId>` or a component id → 0..1), multiplied into the designed volume by `engine/audio.ts` and the `syncVideo` calls. The trims are the show's sound levels: the operator window keeps `ProgramState.mix` and the show file's `Project.mix` in step (`startSoundLevels` in `engine/operator.ts`), so a fader move is saved with the show (it survives takes, reloads and restarts) and travels with show packages and cloud sync, and a show taken in brings its levels to the mixer. Levels changed on this computer that differ from an incoming version's are always asked about (`SOUND_LEVELS` in `core/showMerge.ts`, see SHOW_PACKAGE.md). The output window gets them with the rest of the program.
- Camera moves are Hermite curves: a move that starts while another is running carries that move's velocity into the new curve (`fromVel`), so chained moves never kink. A follow shot keeps `camera.follow`, and the view re-targets the smoothed actor position every frame. Hand-held sway comes from three incommensurate sines of scene time and also drives the 2.5D parallax of plates and cut-outs.
- Program broadcasts are coalesced to 30 Hz (a TAKE goes immediately) and re-sent every 5 s; the runtime's copy of the scene never carries thumbnails. The scene definition inside a runtime (components, cues, text styles) travels **once per run**, keyed by the runtime key (`packProgram` / `unpackProgram` in `core/bus.ts`): the output keeps the scene object it already has and only the live state (clocks, cue pointer, effects, layers) is replaced, so a live-state update never re-renders the React tree under a canvas or redraws a text texture (the canvas content is memoised on the scene object, `SceneContent` in `render/SceneCanvas.tsx`). An output that lacks a run's scene asks for a full resync (`hello`). Messages are addressed to the other window (`emitTo`), not broadcast back into the sender.

The one continuous, input-driven state is the **lion**. It is simulated authoritatively in the operator window at 60 Hz (`core/sim.ts`), then broadcast at up to 30 Hz with a timestamp. Views extrapolate from that timestamp and smooth toward it (`render/actors/motion.ts`), so the output moves as fluidly as the operator preview.

### Why not mirror pixels?

Copying rendered frames between windows (capture → encode → IPC → decode) adds latency and costs more than re-rendering. Two renders of identical deterministic state are cheaper and frame-accurate.

## Preview vs program

| | Preview runtime | Program runtime |
| --- | --- | --- |
| Created when | A scene is selected | TAKE LIVE (or a `takeScene` cue) |
| Reflects builder edits | Immediately (reconciled without restarting) | No: it holds a snapshot of the scene taken at TAKE |
| Sent to the output | Never | Always |

The right-hand control panel and cue list target **program** only when the selected scene *is* the live scene (red banner). Otherwise they target **preview** (green banner). The live cue strip under the PROGRAM monitor always targets program.

## Build timeline (`core/timeline.ts`, `ui/builder/SceneTimeline.tsx`)

Under the Build preview, the selected scene is drawn as tracks: what plays when, cue by cue. The layout is a pure function of the scene and the media lengths (`sceneTimeline`), so the panel and the agent's `timeline` command agree.

- **Cue starts.** Timed cues sit at their real times: a scene time, the cue before plus `after` (follow), or the first time playback passes the media marker that fires them (video). A GO cue has no time until it is pressed, so it sits at its planned **hold** after the cue before (`Cue.hold`, set by dragging the GO line's handle; double-click returns to the guess). Unset, the hold is guessed from how long the cue before runs, music aside (a song runs under the action); for the first GO, from the transition in. The hold is planning data only: GO still fires when pressed.
- **Everything else follows the engine's rules** from those starts: clips land on their next clean cut point (`scheduleClip`, so a clip that waited shows where it was asked for) and hand over to their pose's idle loop, which fills the wait (striped); one copy of a sound plays at a time; `fadeOthers` fades the sounds it names as a sound starts, and music it names that the scene never started is drawn as carried in from an earlier scene; the take fades the scene's sounds, except those that keep playing. Effects that run show as spans with their fade, one-shot effects and lights / MIDI / OSC (cue sends and media markers) as points.
- **Scrubbing** (`previewAtTime` in `engine/operator.ts`): a click or drag in the ruler or an empty stretch of a track rebuilds the preview runtime from the top, applies every cue action up to that moment at its own scene time (the reducer is pure and takes the time), and holds there. The runtime keeps its key, so the canvas and its decoders stay mounted while dragging. The actions those cues still have to do, and follow cues due later, wait on the preview's scene clock (`sceneWaits`), so they hold with it and run when it plays on. Nothing is sent out (sends, timers, announcements, blackout and takes are skipped, as in any preview).
- **Views.** The timeline is a tab beside the run sheet (one or the other fills the space under the preview), and the scene list and components panel fold away so it can take the whole width.
- **Pop-ups.** Clicking a block selects it (and its component). Double-clicking a block or a diamond opens that action's settings over the timeline (`TimelineAction.tsx`, the run sheet's own action editor); double-clicking an empty moment, or **+ Add** at the playhead, adds any run-sheet action there (lights, StageLight, StageMics, a sound…), anchored to the cue that stretch belongs to. A media marker's diamond opens its video's markers pop-up (the same pop-up as the scrub bar's "markers on this video"). A block with no cue is what the scene starts with, or a loop filling a wait.
- **Run show** (`startRun` in `engine/operator.ts`): a rehearsal run in the preview. The scene starts from its TAKE; when the next cue in line is a GO and its planned start on the timeline comes, it fires by itself; take-scene actions are followed (Build selects the next scene and music that keeps playing carries over, `carriedSounds`), and a scene that runs out without one goes on to the next in running order. Holding the preview holds the run. Nothing is sent out.
- **Preview sound** (`engine/previewAudio.ts`): while Build mode is open, the preview's cue sounds play on this computer's default output (never the show's audio device, which only the program uses). Nothing runs per frame: when the preview's clock or sound events change, what should be sounding is worked out again with `soundLives` (the program's rules), so a scrub, hold or resume puts each sound where the clock is. The timeline's speaker button mutes it.
- **Editing** (`core/timelineEdit.ts`): every edge belongs to one cue, never to an absolute time across a GO. Dragging a block moves its action into the cue whose stretch it lands in (the last cue starting at or before that time), with the rest as its delay, so a sound dropped after GO 5 follows GO 5 however late it comes (Alt: copy). Dragging a block's right edge moves what stops it: a sound's `audio.fade` (made when nothing fades it yet; a sound faded by another sound's `fadeOthers` is taken out of that list and faded on its own; past the take it keeps playing into the next scene), a layer's hide, an effect's stop. Dragging a sound's left edge trims its start: the action moves and its `trimStart` (seconds cut off the top of the file) changes by as much, so what plays after the edge stays where it was; its `fadeIn` runs from the new start and `fadeOut` fades into the end of the file. The dots in a sound's top corners set its fade lengths: the left one its `fadeIn`; the right one its fade-out, keeping where it ends (its own `audio.fade` gets longer and starts earlier, a shared fade or `fadeOthers` is swapped for one of its own, and a sound that ends with its file gets a `fadeOut`). The take's fade and a sound playing on into the next scene have no fade-out dot. A sound's `levels` (a duck under a live voice) are part of its sound event, timed from its start, so they carry into the next scene with it and a restarted audio host or a music chase puts them back where the clock says. Dragging a timed or follow cue's flag moves the cue; a GO's line sets its hold. While dragging, the edit is applied to a copy of the scene and laid out again, so clips that wait for cut points, fades and later cues show where they will really land. Delete removes the selected block's action. Undo / redo (⌘Z / ⇧⌘Z in the timeline) keep snapshots of the scene's cues, and refuse to undo over edits made since in the run sheet.

## Rendering pipeline (`render/SceneCanvas.tsx`)

Each scene instance is one WebGL canvas. A custom compositor draws four passes in order:

1. **Back** (orthographic, logical canvas pixels): media backgrounds, "behind 3D" layers, day/night grade for video.
2. **World** (perspective): sky dome, distant ridges, terrain, rocks, trees, grass, procedural elements, lion, 3D models, world-space billboards, rain. Lit by sun, moon, sky fill and lightning flash, with depth-aware exponential fog.
3. **Front** (orthographic): "in front of 3D" layers.
4. **FX** (orthographic): layered low-lying fog, haze, lightning bolts and flash, travel haze, dissolve mask.

The logical LED canvas (any width × height) defines the orthographic space and the camera aspect. The camera stores a **horizontal** field of view, so ultra-wide walls (for example 4096 × 1024) show more panorama instead of zooming in. The canvas element itself renders at the *displayed* pixel size, never above the logical resolution.

Scaling modes: **fit** (letterbox), **fill** (crop), **stretch**, and **native** (1:1 device pixels, centred, cropped if too large).

### Transitions (`render/StageView.tsx`)

During a transition the outgoing and incoming scenes are mounted as two canvases. The incoming one mounts at TAKE, so it loads while the transition runs.

| Kind | Implementation |
| --- | --- |
| Cut | Instant swap |
| Crossfade | Incoming canvas opacity 0 → 1 |
| Fade to black | Black overlay up, swap at the midpoint, overlay down |
| Dissolve | Noise-threshold mask that multiplies the incoming canvas's premultiplied alpha, revealing it over the outgoing one |
| Camera travel | Outgoing camera accelerates forward, incoming camera decelerates into its framing, crossfade at the midpoint through an atmospheric bloom |
| Soft wipe | Directional mask with a ragged, soft edge (direction and softness on the transition) |
| Burn away | Noise mask with a glowing, flickering fire edge ("the storybook tears away") |
| Video | Full-frame transition video on top (time-synced). The destination is already rendered underneath and is revealed as the video's last 10% fades, so there are no black frames. The video's vertical framing glides from the outgoing plate's `anchorY` to the incoming one's, so both ends line up with the plates. Optional transition audio. |

## Data model (`core/types.ts`)

- **Project**: scenes, asset library, effect presets, output settings. Saved as JSON in the app data folder via an atomic write (temp file, then rename), autosaved shortly after every edit, and exportable/importable as a show file.
- **Scene**: environment preset, components, camera shots, named stage markers, cues and the default transition into it.
- **Components** (each has a unique id and is fully serializable):
  - `background`: environment look (time of day, storm) or media plate (fit, crop, loop, in/out, speed).
  - `video` / `image`: back, front or world placement; crop, mask, blend mode, chroma key, entrance/exit animation, looping walkers.
  - `model`: GLB/glTF with clip, loop, tint and material overrides.
  - `actor`: the lion. GLB *or* procedural placeholder, clip mapping, speeds, stride, playing-area bounds.
  - `procedural`: built-in birds, sheep, campfire and town lights.
  - `clipActor` (video actor): a photoreal character made of pre-rendered, full-frame AI clips. Each clip is tagged with the pose it starts and ends on (for example `empty → hero` for the walk-in, `hero → hero` for the roar). A requested clip is scheduled for the next clean cut point: immediately when idle, at the end of the current clip, or at the next loop boundary. Cuts therefore land on matching frames. A clip marked **interrupt** skips the wait and cuts in at once (for urgent beats out of gentle idle loops, such as the lion's charge). Finished clips hold their last frame, or hand over to their end pose's auto-idle loop. If the rest pose has an auto-idle loop, it runs from the moment the scene is taken, and clearing the actor returns to it. Clips are fitted to the plate's aspect and vertical framing, and follow the plate's Ken Burns pan/zoom and parallax, so frames line up with the background. A full-wall clip with alpha (a goat walking into a street) therefore stays on its spot while the plate drifts. Actors stack in scene order.
  - `effect`: rain, snow, lightning, fog, haze, wind, day/night, starfield, divine light (god rays), heat shimmer, window/torch lights (light up one by one), screen shake or projectile (sling stone), with parameters. Shake and projectile are one-shot triggers. Reusable via project-level presets. Any live parameter can also be set from a cue (`effect.param`).
  - `text`: titles, captions and verses drawn glyph by glyph into a texture plus an "order map"; the shader reveals letter by letter, word by word, typewriter or burn-in without redrawing.
  - `names`: the genealogy. A Canvas-2D tree (branches, gold bloom, burn to a stump with embers, blossom, crown text), a thin line of plain names, one big name at a time, or names flying up like embers. Driven by `names` cue actions (next / set / all / burn / restore / bloom).
  - `route`: a glowing line drawn over a map image (with Ken Burns zoom) by a `route` cue.
  - Media backgrounds can carry Ken Burns pan/zoom, parallax, reverse playback and time markers; clips can carry time markers too.
- **I/O** (`project.io`): MIDI/OSC ports, OSC targets, MSC device id, triggers (`match` → `action`). Outgoing messages are `IoMessage`s sent by `send` cue actions, media markers and the TAKE/GO announcements.
- **Cue**: a list of actions, each with an optional delay: lion action, walk/run to marker, place, show/hide, effect start/stop/trigger, effect parameter, background, layer show/hide/restart, camera shot, time of day, take another scene, play a video-actor clip, blackout on/off, freeze/resume, play a sound, send MIDI/OSC, names (tree) ops, route ops, video speed ramp. Delays are scheduled by absolute wall-clock time and persisted so they survive a reload. Cues carry operator notes (shown under the cue and in the GO card in Show Mode). A cue fires on GO (default), at a scene time, a set time after the cue before it (follow), or from a media marker (video); a GO cue may carry a planned `hold` for the Build timeline (above). A cue that will fire by itself carries an **AUTO** tag; GO (button, G, or the console) still fires it early, as does its **Fire now** button (`nextCueIsAuto` in `core/runtime.ts`). **Fire now** on any cue rewinds the list to it: the cues after it are un-fired and GO points at the next one; time cues already behind the clock then wait for GO instead of all firing at once (`cueFired` with `rewind`). A time cue scrubbed past, or a follow whose cue before it never fired, goes back to a normal GO.

### Photoreal pipeline (AI plates and clips)

1. Generate a hero frame (character in the scene) and a clean plate (the same frame with the character removed).
2. Generate clips with image-to-video using first/last-frame conditioning so clips chain on shared poses.
3. Add the plate as a media background and the clips to a video actor. Cues fire clips; live effects layer on top.

Video frames are uploaded by three.js without sRGB decoding, so the media shader decodes them itself (`decodeSrgb`); without that, video looks washed out.

### Photoreal 3D environment ("shepherd-photoreal")

The Shepherd's Valley photoreal scene pushes Three.js toward photorealism with a hybrid of photography and 3D:

- **Backdrop:** a 4:1 photographic panorama (AI) on a camera-centred sphere, mapped as a cylinder (110° span, horizon at 47.6%). It is lifted slightly (`elevOffset`) because the photo looks down over a valley from higher ground.
- **Terrain:** a hilltop pasture that falls away about 200 m out. Its photo ground texture uses Inigo Quilez-style randomised tiling, bump detail from the texture's own luminance, and large-scale colour variation. With distance it dissolves into the panorama, projected along the view direction, so the 3D field and the photograph join without a seam.
- **Sprites:** photographic cut-outs (trees, sheep, rocks), background-removed and colour-keyed, rendered as camera-facing instanced billboards. They cast alpha-tested shadows, darken where they meet the ground, and pick up distance haze from the panorama. Grass is crossed cards near the camera only, with wind sway.
- **Lighting:** the sun is placed where it is in the photo (low, front-left). Image-based lighting is built from the panorama with PMREM. Everything photographic follows `photoGrade()`, which ties brightness to the scene's light level and cools toward night.
- **Camera look:** per-scene HDR finish (`scene.look`). The scene renders into a half-float MSAA target, then gets bloom, white balance, Khronos PBR Neutral tone mapping, contrast/saturation, vignette and grain. Neutral tone mapping keeps photographic textures faithful.

All photos are preloaded at startup in every window, so TAKE only pays for shader compilation (about 1–2 s cold). Use a crossfade or fade into it rather than a cut.

### Scanned-asset 3D environment ("shepherd-pbr")

The pasture's ground shape (`terrainHeight("shepherd-valley")`, so the flock, fire, markers and camera shots of a pasture scene carry over) rendered with real assets instead of procedural primitives (`src/render/env/pbr`, media in `public/media/pbr-valley/`, all CC0 from Poly Haven):

- **Sky and light:** an equirectangular HDRI is the visible dome (fading to the procedural starry sky at night) and, through PMREM, the image-based lighting of every standard material in the scene, including GLB actors and models. The sun's azimuth is read from the image's brightest texel (`hdri.ts`), elevation still follows the time of day. The hemisphere light and the scene fog are scaled down because the image supplies its own sky light and haze.
- **Ground:** a scanned PBR set (albedo, normal, roughness, AO) with Inigo Quilez no-tile sampling, a second set blended in on slopes and worn patches, vertex tints for dry patches, and a far olive tint so distant slopes read as scrub, not sand.
- **Props:** photogrammetry trees, shrubs, rocks and grass clumps from `manifest.ts`, each glTF turned into one `InstancedMesh` per mesh and scattered deterministically (seeded; the stage apron, the flock and the fire stay clear). Leaves and grass sway in the wind through `onBeforeCompile`. Counts are tuned for about 15 M triangles a frame; the hero tree is 1 M triangles on its own.
- **Not done yet:** screen-space ambient occlusion, cascaded shadows for the far field, level of detail for the trees, a realistic rigged lion (the stand-in is a low-poly CC0 model).

## Media formats

The two webviews decode video with the platform's own player (AVFoundation on macOS, Media Foundation on Windows), in hardware, and hand each frame to WebGL. What that path plays well was measured on this project (October 2026, Apple silicon):

| | Plays | Does not |
| --- | --- | --- |
| H.264 | up to 4096 px wide or high (the hardware decoder's ceiling, level 5.2) | wider frames decode, but reach WebGL as a green picture with garbage along the top |
| Frames over 1000 KiB | any frame up to about 1 MB | the asset protocol (library files) answers each range request with at most 1000 KiB (`tauri::protocol::asset` MAX_LEN) and the Mac's player does not reassemble a bigger frame: the bottom of that picture plays green. A detailed wall-size keyframe passes 1 MB (the Scene 1 street plate at CRF 16: 1.27 MB), so wall renders cap the frame size with x264's VBV buffer (`-x264-params vbv-maxrate=40000:vbv-bufsize=7000`, frames ≤ ~875 KB) and the optimiser does the same with libx264 on a Mac (VideoToolbox cannot cap a frame). The probe reports `max_frame_bytes`; `asset_check` reports `big-frame` |
| HEVC | up to 8K on a Mac | on Windows only with the paid HEVC extension |
| VP9 / AV1 (WebM) | Windows; VP9 alpha is the transparent format there | VP9 alpha on a Mac (use the HEVC-alpha twin, `macUrl`) |
| ProRes / Motion JPEG | yes, at disk-reading bit rates | |

WebKit caches a video by its URL: a file rewritten in place keeps playing its old contents (or none) until the app restarts, so a re-rendered library file gets a new file name and the asset points at it.

HEVC alpha on a Mac reaches WebGL **opaque** when the `<video>` element itself is uploaded (every clear pixel arrives with alpha 1, so a full-wall cut-out paints black over the plate), while a WebCodecs `VideoFrame` taken from the same element keeps its alpha. So on WebKit a video whose asset `hasAlpha` uploads a `VideoFrame` of its current picture (`useVideo(url, { alpha })` in `render/layers/video.ts`), about 3-4 ms for a 3072 x 768 frame.

A seek lands on the previous keyframe and decodes forward, so a long GOP stalls every scrub and every drift correction; the index (`moov`) must come before the media data (`+faststart`) or playback waits for the whole file. Nothing above the wall's own size is ever shown, and every window (preview, program, output) decodes its own copy, so an oversize file costs three times.

**The wall format**, which the app makes itself: H.264 High, scaled to fit the output canvas (never upscaled), the file's own frame rate, a keyframe every half second, yuv420p, stereo AAC, fast start, about 0.3 bits per pixel per frame (25 Mbit/s at 3072 × 768, 30 fps; between 8 and 60).

- **Probe** (`src-tauri/src/media.rs`, `media_probe`): a small ISO BMFF / QuickTime box walker (no external tool) reads codec, profile and level, size, frame rate, keyframe spacing from the sync-sample table, audio and fast start. WebM gets its codec ids only.
- **Check** (`src/core/mediaCheck.ts`): the rules above, as problems with a severity (`error`: will not play or look right; `warn`: plays, but costs or stalls) and whether re-encoding fixes them.
- **Optimise** (`media_optimise`, `src/engine/media.ts`): ffmpeg re-encodes into the wall format using the hardware encoder when there is one (VideoToolbox on a Mac, NVENC / QuickSync elsewhere, else x264), with progress events; the asset then points at the new `*.wall.mp4` and the old library copy goes. ffmpeg is looked for next to the app's own executable (the bundled sidecar, below), in `SLS_FFMPEG`, then on the machine (`brew install ffmpeg`). Without it the file is still probed and the library shows why it will not play, with the reason in the tooltip.
- **Bundled ffmpeg**: the release build carries a static ffmpeg as a Tauri sidecar (`bundle.externalBin` = `binaries/ffmpeg` in `src-tauri/tauri.conf.json`), so optimising works on a show computer with nothing installed. `scripts/fetch-ffmpeg.ts` downloads it into `src-tauri/binaries/ffmpeg-<target-triple>` (`pnpm fetch:ffmpeg`; `tauri build` and `tauri dev` run it first, because tauri-build refuses to compile when a sidecar is missing), verifies the SHA-256 pinned in the script, and skips the download once the pinned version is there. The folder is not in git. Tauri strips the triple when it copies the file next to the executable (`LiveStage.app/Contents/MacOS/ffmpeg`, `ffmpeg.exe` beside the `.exe` on Windows), which is the first place `find_ffmpeg` looks, so the dev build (`target/debug/ffmpeg`) uses the same ffmpeg as the release. Pinned builds: ffmpeg 9.0.2, macOS arm64 from ffmpeg.martin-riedl.de (VideoToolbox, x264) and Windows x64 from gyan.dev (essentials: NVENC, QuickSync, AMF, x264). Both are **GPL v3** builds, chosen over LGPL ones because x264, the software H.264 fallback, is GPL. ffmpeg runs as a separate program the app starts, so the app's own licence is unaffected, but the ffmpeg source for the shipped version must stay available (github.com/FFmpeg/FFmpeg, tag `n9.0.2`); the fetch script writes the same notice to `src-tauri/binaries/README.txt`. To move to a new ffmpeg, update the version, URL and hash in the script after checking the hash the source publishes.
- **On import** (library button, the agent's `asset_import`) every video is probed; one with an `error`, or far bigger than the wall, or with long keyframe gaps, or without fast start, is optimised at once. Alpha video (HEVC alpha, VP9 WebM) is never re-encoded. The agent's `asset_check` / `asset_optimise` do the same on demand.

Video elements are created in an effect, never during render: React may run a render twice and keep one result, and a `<video>` from the discarded render would stay in the page buffering with a decoder of its own.

### Video playback and sync (`render/layers/video.ts`)

- **Slaved to the clock, corrected rarely.** A playing video is compared with the scene clock every frame but touched only in steps (a ±5 % rate nudge beyond the dead band, a hard seek beyond 0.6 s), because the platform player stalls on every seek and rate change. A **looping** video whose loop is the whole file (`loop` in `SyncWant`) has its drift measured on the loop circle: around the wrap the element and the clock are never exactly together, and measuring the raw difference (almost a whole clip) used to force a hard seek at every loop, each followed by several seconds at 1.05× to catch up again. Measured on the output heartbeat before the fix: one seek per 8 s loop, 100-250 ms drift after it; after: no seeks, ~30 ms drift.
- **Warm and cold elements.** Every loaded `<video>` holds a platform decoder session and its buffered file. A clip actor keeps only the clips that can come next **warm** (`setWarm`): the one on screen or fading out, the queued one, every clip whose start pose is the actor's current pose, and the clips the cue under the GO pointer would start; the rest have no `src`. A scene with an eight-clip actor went from 11 loaded videos per canvas (×3 canvases across the two windows) to 2-4. A clip that was cold when its turn came loads in ~200 ms; the clip before it holds its last frame until the new one has a picture.
- **Heartbeat diagnostics.** The output window reports once a second (Output settings, the agent's `status`): fps and the slowest frame, per-video seeks / rate changes / drift / dropped frames, `upload` (milliseconds spent handing video frames to WebGL: ~0.1 ms per frame on the GPU path, whole milliseconds mean a software copy), `videoElements` (loaded / total) and `stalls` (frames over 40 ms with the last bus message before them). In development the operator window exposes the same counters as `window.__slsVideoStats()` and `window.__slsUploadStats()`.
- **A hidden window does not render.** macOS stops `requestAnimationFrame` in an occluded or off-Space webview and the operator window's frame loop with it; the output window on the wall's display is never occluded in a show, but if it reports 0 fps that is the first thing to check.

## Effects engine

Effects are generic components rendered by the same code in every scene. They are not baked into scenes.

| Effect | 3D environments | Flat video plates |
| --- | --- | --- |
| Rain | 3 depth layers of camera-volume streaks plus ground splash rings | Same streak layers (the camera still exists) |
| Lightning | Branching bolt overlay, multi-pulse flash, sky/cloud illumination, light flash on 3D objects, synthesised or imported thunder after a delay | Same, with a stronger screen flash. Optional imported bolt video (additive). |
| Fog | Scene fog density plus layered drifting screen fog | Layered drifting screen fog |
| Haze | Fog density, ridge aerial perspective, horizon band | Horizon band |
| Wind | Grass gusts, rain slant, cloud and fog speed | Rain slant, fog speed |
| Day/night | Relights sky, sun/moon path, stars, moon, light colours, fog colour, campfire and town lights | Crossfade to a matching night plate (another background) and/or a multiply colour grade |

## Resilience

See [RECOVERY.md](RECOVERY.md). In short: `state.json` (live program, poses, pending actions) written on change; `restoreLiveState()` on start; an output watchdog that reopens a dead output window and tears down and recreates a hung one (window present, no heartbeat for 8 s); `webglcontextlost` handled per canvas with a rebuild, forced after 3 s if the browser never restores the context; contexts released on unmount; the 60 Hz service tick and the output heartbeat driven from a Worker (`core/steadyTimer.ts`) so a hidden or covered window cannot throttle them, with overdue delayed actions fired by the tick; error boundaries around every panel and canvas; a global error log surfaced in the top bar. Performance findings and what to measure: [PERFORMANCE.md](PERFORMANCE.md).

## Audio

Program audio (thunder, transition audio, unmuted video layers) plays in exactly one window, the **audio host**. That is the output window while it is open and responding; otherwise (closed, or silent for 3.5 s) it is the operator window. There is no setting for it. On Windows both WebView2 instances start with `--autoplay-policy=no-user-gesture-required`, because nobody clicks the output window.

## Source map

```
src/core/       data model, clock, runtime reducer, actor sim, effects registry, platform (Tauri/browser), bus
src/store/      zustand stores: project (operator only), show (both windows), model info
src/engine/     operator services (sim loop, cues, keyboard, broadcast, watchdog, markers), program audio, io (MIDI/OSC), persist (live state)
src/render/     StageView (slots, transitions, standby, guides), SceneCanvas (compositor, camera rig), env/, actors/, layers/ (media, clip actors, text, names, route), effects/ (rain/snow, overlays, atmos, impact)
src/ui/         TopBar, SceneList, OutputSettings, show/ (Show Mode), builder/ (Scene Builder)
src/agent/      agent control: command catalogue (spec), handlers, path edits, WebSocket bridge to mcp/server.ts
mcp/            MCP server for AI agents (stdio ⇄ WebSocket bridge), smoke test; see AGENT_CONTROL.md
src-tauri/      Rust shell: plugins, native output-window creation, app lifecycle, MIDI (midir) and OSC (rosc) I/O
```

### Weather on imported photographic geometry

The existing Day / Night, rain and fog effect components also drive imported GLB environments. Their controls appear under Effects in the right-hand show panel; generic MCP `component_add`, `run_action` and `effect.param` actions use the same registries and runtime. Unlit glTF materials (photographed or baked surfaces, including distant scenery) multiply their original colour by the shared-clock `mediaGrade`, so night/storm fades affect the photographs without applying lighting twice. This is a colour grade: baked sunlight and shadows do not move. Lit props under a plate-matched key light dim and cool with time of day. Original material alpha/transparency are retained through model fades, including feathered ground edges. Rain is a camera-relative 3D volume with depth testing; fog combines scene depth fog with the existing low drifting overlay. Neither effect generates wet-surface reflections or physically relights photographic interiors.

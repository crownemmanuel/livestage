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
                │  "program": live runtime, standby, transition (on change)
                │  "poses":   actor poses                      (≤ 30 Hz)
                ▼
┌──────────── Audience output window (pure view) ────────────┐
│ Renders exactly what the PROGRAM monitor renders.          │
│ Sends back: "hello" (resync) and a 1 s health heartbeat.   │
└─────────────────────────────────────────────────────────────┘
```

There is only one playback engine: the operator window's state. The PROGRAM monitor and the audience output render that same state with the same React/Three.js code (`render/StageView.tsx`). Nothing drifts, because every animated value is a **pure function of a shared clock**:

- `performance.timeOrigin + performance.now()` gives the same wall clock in every window on the machine.
- Each scene instance (`SceneRuntime`) has its own scene clock (`clock.base`, `clock.pausedAt`). **Freeze** stops it, and every effect, tween and video holds its frame.
- Changes are stored as *timestamped events*, never as per-frame values. Examples: an effect's `{active, changedAt}`, a background change `{current, previous, changedAt, dur}`, a time-of-day tween `{from, to, at, dur}`, a camera move `{from, to, at, dur}`, a lightning strike `{at, seed}`. Every view evaluates them at "now" and gets the same answer.
- Procedural motion (rain drops, grass sway, birds, sheep, walkers, lightning bolt shapes) uses seeded randomness plus time, so the geometry matches in every window.
- Video layers are slaved to the clock. Each frame, `syncVideo` compares `currentTime` with the expected media time. Large drift triggers a hard seek; small drift is corrected by nudging `playbackRate`, so there is no constant re-seeking stutter.

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
  - `clipActor` (video actor): a photoreal character made of pre-rendered, full-frame AI clips. Each clip is tagged with the pose it starts and ends on (for example `empty → hero` for the walk-in, `hero → hero` for the roar). A requested clip is scheduled for the next clean cut point: immediately when idle, at the end of the current clip, or at the next loop boundary. Cuts therefore land on matching frames. A clip marked **interrupt** skips the wait and cuts in at once (for urgent beats out of gentle idle loops, such as the lion's charge). Finished clips hold their last frame, or hand over to their end pose's auto-idle loop. If the rest pose has an auto-idle loop, it runs from the moment the scene is taken, and clearing the actor returns to it. Clips are fitted to the plate's aspect and vertical framing so frames line up with the background. Actors stack in scene order.
  - `effect`: rain, lightning, fog, haze, wind, day/night, screen shake or projectile (sling stone), with parameters. Shake and projectile are one-shot triggers. Reusable via project-level presets.
- **Cue**: a list of actions, each with an optional delay: lion action, walk/run to marker, place, show/hide, effect start/stop/trigger, background, layer show/hide/restart, camera shot, time of day, take another scene, play a video-actor clip, blackout on/off. Cues can carry operator notes (shown under the cue in Show Mode).

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

## Audio

Program audio (thunder, transition audio, unmuted video layers) plays in exactly one window, the **audio host**. That is the output window when it is open and selected in Output settings; otherwise it is the operator window. On Windows both WebView2 instances start with `--autoplay-policy=no-user-gesture-required`, because nobody clicks the output window.

## Source map

```
src/core/       data model, clock, runtime reducer, actor sim, effects registry, platform (Tauri/browser), bus
src/store/      zustand stores: project (operator only), show (both windows), model info
src/engine/     operator services (sim loop, cues, keyboard, broadcast) and program audio
src/render/     StageView (slots, transitions, standby, guides), SceneCanvas (compositor), env/, actors/, layers/, effects/
src/ui/         TopBar, SceneList, OutputSettings, show/ (Show Mode), builder/ (Scene Builder)
src-tauri/      Rust shell: plugins, native output-window creation, app lifecycle
```

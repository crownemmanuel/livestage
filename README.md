# Salvation Live Studio

Real-time visual production and show control for theatrical LED walls, built for **Salvation 2026: The House of David**.

Version 1 is a working desktop app (Tauri 2 + React + Three.js). It is not a mockup. It has two modes:

- **Scene Builder**: design scenes, import media, layer and configure components, edit cues and camera moves. Edits only touch the preview.
- **Show Mode**: run the show. Browsing and selecting scenes never changes the wall. Only **TAKE LIVE**, live cues or controls targeting the live scene do.

It ships with the opening of the show (the prologue, built from AI video), the **whole rest of the show scaffolded from the script** (every `[LED: …]` cue has a scene with its components, cues and operator notes; see [docs/SHOW_MAP.md](docs/SHOW_MAP.md)), two prototype 3D scenes and a compositing template. The prologue scenes:

| Scene | What it tests |
| --- | --- |
| 01 · Prologue 1 · Once Upon a Time | Push-in on the Bethlehem fields, then a looping field with a separate cut-out flock (with bleats) you can scale and move to match the real sheep |
| 02 · Prologue 2 · The Lion on the Rock | Day-to-night time-lapse travel video in; the lion climbs onto the ledge, watches on a loop, then charges the audience on GO; the wall blacks out |
| 03 · Prologue 3 · David's Song | Taken in the dark; lights up on David standing on the lion, looping while real David sings |
| 04 · Prologue 4 · The Valley of Elah | Sky move in; a giant cut-out Goliath enters and taunts; **Sling!** flies a stone left to right, he drops shield and spear (shake), kneels and falls (earthquake) |
| 05 · David and the Lion | Interactive lion (keyboard and cues), rain, lightning and thunder, fog, haze, wind, day/dusk/night/storm looks, camera moves |
| 06 · David and the Lion · Photoreal (AI proof) | The AI-video pipeline: an AI-generated plate plus a **video actor** lion whose clips chain on a shared pose (walk-in → roar), with the live rain, fog and lightning over it |
| 07 · The Shepherd's Valley | A different location: pasture, sheep, birds, olive trees, the shepherds' fire, distant town lights at night, camera-travel transition from Scene 05 |
| 08 · The Shepherd's Valley · Photoreal | How far Three.js can go toward photorealism: photographic panorama, photo-textured 3D field, photographic trees, sheep, rocks and grass, and an HDR camera finish |
| 09 · Nazareth Marketplace (template) | Layered AI-video compositing: plate background, looping transparent walkers, screen and multiply overlays. Import assets to fill it. |

## Run it

Requirements: Node 20+ with pnpm, plus a Rust toolchain. On Windows you also need the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (MSVC build tools and the WebView2 runtime, which Windows 11 already has).

```bash
pnpm install
```

```bash
pnpm tauri dev
```

To build an installer (`.msi`/`.exe` on Windows, `.dmg` on macOS):

```bash
pnpm tauri build
```

UI-only development in a browser (no Rust needed) also works:

```bash
pnpm dev
```

Open http://localhost:1430. **Open output** pops up a second browser window that acts as the audience output. Double-click it to go fullscreen. Browser mode keeps imported media only until reload and saves the show to `localStorage`.

## Operating basics

| Action | How |
| --- | --- |
| Take the selected scene live | **TAKE LIVE**, or Ctrl/⌘ + Enter |
| Fire the next live cue | **GO** under the Program monitor, or `G` |
| Back / skip / repeat cue, cancel pending delays | Buttons next to GO |
| Freeze all motion on the wall | **Freeze** (resumes exactly where it stopped) |
| Hold, scrub and resume the live video | **Hold** under the Program monitor (or `P`), drag the bar, **Resume** ([VIDEO_TRANSPORT.md](docs/VIDEO_TRANSPORT.md)) |
| Safe standby visual | **STANDBY** (fades the wall to the title card or image) |
| Drive the lion | **Arm keyboard** on the lion card, then `W A S D` to move, `Q`/`E` to turn, `Shift` to run, `1`–`7` for actions, `Space` to stop |

## Production hardening

- **Recovery**: the live state is saved on every change; a reload or crash of the operator window comes back on the same scene, same next cue, same blackout, with pending delayed actions re-armed. A crashed output window is reopened automatically. Lost GPU contexts rebuild themselves; every panel has an error boundary. See [docs/RECOVERY.md](docs/RECOVERY.md).
- **Show control**: MIDI in/out (notes, CC, program change, MIDI Show Control) and OSC over UDP, with a Learn button, a monitor log, built-in `/sls/…` commands, MSC cue-following for the Hog 4, `Send MIDI / OSC` cue actions and **clip time markers** that send a message when playback passes a time. See [docs/SHOW_CONTROL.md](docs/SHOW_CONTROL.md).
- **Smoother camera**: moves chain without a kink (Hermite blend carrying the current velocity), follow shots keep tracking the lion, a quintic "smooth" ease, hand-held sway, and 2.5D parallax on plates and cut-outs.
- **New components**: titles (letter/word/typewriter/burn-in reveals), the family tree of names (grow, burn to a stump, blossom, fly as embers), map routes (glowing line over a map with zoom), Ken Burns on plates, reverse and speed-ramped video, snow, starfield, divine light, heat shimmer, window/torch lights, soft wipe and burn transitions, freeze and sound cues, effect-parameter cues.
- **Show Mode**: a big GO with the next cue and its operator note always in view, a status bar (output health, saving, I/O counters, keys), bigger cue rows, `Shift+B` blackout, `Esc` cancels pending actions, `↑/↓` moves the preview.

The right-hand panel always shows a banner saying what it controls:
- **CONTROLLING LIVE OUTPUT** (red): the selected scene is on the wall.
- **REHEARSING IN PREVIEW** (green): nothing you press reaches the audience.

## Documentation

- [docs/SHOW_MAP.md](docs/SHOW_MAP.md): every LED cue in the script, the scene that serves it, and the media still to generate.
- [docs/SHOW_CONTROL.md](docs/SHOW_CONTROL.md): MIDI / OSC / Hog 4 set-up, built-in commands, time markers.
- [docs/RECOVERY.md](docs/RECOVERY.md): what survives a reload, crash or GPU reset, and the pre-show checklist.
- [docs/SHOW_PACKAGE.md](docs/SHOW_PACKAGE.md): moving the show and its media to the show computer (show packages, optional Firebase cloud sync), with versions and per-scene conflict choices.
- [docs/AGENT_CONTROL.md](docs/AGENT_CONTROL.md): the MCP server that lets an AI agent run and build the show (`.mcp.json`, tools, safety).
- [docs/PROLOGUE.md](docs/PROLOGUE.md): the prologue's cues, voiceover sync points, media pipeline and how to swap in HQ renders.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how playback stays in sync across windows, the rendering pipeline and the data model.
- [docs/LION_ASSET.md](docs/LION_ASSET.md): requirements for the real lion model and how to swap it in.
- [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md): decisions made where the brief was incomplete, known limitations and next steps.

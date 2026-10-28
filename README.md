# LiveStage

LiveStage is the software built to power the live stage production of **Salvation**, the stage play ([salvationplay.com](https://salvationplay.com)): real-time effects on the LED wall, and show control for the lighting and special effects. This season's show is **Salvation 2026: The House of David**. The show itself is not in this repository: a show is a file you import (a show package or cloud sync, see [docs/SHOW_PACKAGE.md](docs/SHOW_PACKAGE.md)).

Version 1 is a working desktop app (Tauri 2 + React + Three.js). It is not a mockup. It has two modes:

- **Scene Builder**: design scenes, import media, layer and configure components, edit cues and camera moves. Edits only touch the preview.
- **Show Mode**: run the show. Browsing and selecting scenes never changes the wall. Only **TAKE LIVE**, live cues or controls targeting the live scene do.

It ships with a two-scene demo show:

| Scene | What it shows |
| --- | --- |
| 1 · David and the Lion · Photoreal (AI proof) | The AI-video pipeline: an AI-generated plate plus a **video actor** lion whose clips chain on a shared pose (walk-in → roar → pacing), with live rain, fog, wind and lightning over it |
| 2 · The Shepherd's Valley | A real-time 3D location: pasture, sheep, birds, olive trees, the shepherds' fire, distant town lights at night, day/golden/night looks and camera moves |

## Run it

Requirements: Node 20+ with pnpm, plus a Rust toolchain. On Windows you also need the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (MSVC build tools and the WebView2 runtime, which Windows 11 already has).

```bash
pnpm install
```

```bash
pnpm tauri dev
```

To build an installer on this computer (`.msi`/`.exe` on Windows, `.dmg` on macOS):

```bash
pnpm build:installer
```

Releases for the show computer are built by GitHub Actions from a version tag, and the installed app updates itself from them when the operator says so (More → Check for updates). See [docs/RELEASES.md](docs/RELEASES.md).
Both commands first fetch the static ffmpeg the app bundles (about 60 MB on a Mac, 110 MB on Windows, once per target), which re-encodes imported video into the wall format on a show computer with nothing installed. It lands in `src-tauri/binaries/`, outside git; `pnpm fetch:ffmpeg --all` fetches every target, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (Media formats) has the sources, checksums and licence (GPL v3).

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

- [docs/SHOW_CONTROL.md](docs/SHOW_CONTROL.md): MIDI / OSC / Hog 4 set-up, built-in commands, time markers.
- [docs/RECOVERY.md](docs/RECOVERY.md): what survives a reload, crash or GPU reset, and the pre-show checklist.
- [docs/SHOW_PACKAGE.md](docs/SHOW_PACKAGE.md): moving the show and its media to the show computer (show packages, optional Firebase cloud sync), with versions and per-scene conflict choices.
- [docs/RELEASES.md](docs/RELEASES.md): cutting a release (version, tag, push), the GitHub Actions build, the signing key, and how the show computer updates.
- [docs/AGENT_CONTROL.md](docs/AGENT_CONTROL.md): the MCP server that lets an AI agent run and build the show (`.mcp.json`, tools, safety).
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how playback stays in sync across windows, the rendering pipeline and the data model.
- [docs/LION_ASSET.md](docs/LION_ASSET.md): requirements for the real lion model and how to swap it in.
- [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md): decisions made where the brief was incomplete, known limitations and next steps.

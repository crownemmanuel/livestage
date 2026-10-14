# Assumptions, limitations and next steps

## The brief was cut off

The brief stopped partway through **§12B (Video-Based Camera Travel)**, at "Avoid black frames or visible flashes during…". Everything after that point was never received, including the rest of §12, any later sections and the acceptance criteria. V1 fills the gap with these decisions. Please review them.

| Topic | Decision taken |
| --- | --- |
| §12B video transitions | Implemented as described. The destination scene mounts underneath when TAKE is pressed and is revealed as the transition video's final 10% fades out, so no black frame appears. Video length is read automatically. Optional transition audio. |
| §12C (presumed: real-time 3D camera travel) | Implemented as the **Camera travel** transition. The outgoing camera flies forward, the incoming camera arrives, and they crossfade through atmospheric haze. Scene 01's "Travel to Shepherd's Valley" cue uses it. |
| Camera moves within a scene | Saved camera shots with duration and easing, optionally following the lion. |
| Cue system | Cues are lists of timestamped actions with optional delays. Operator gets GO, back, skip, repeat, fire any cue, cancel pending delays, and a freeze for all motion. |
| Safety | Separate preview and program. TAKE is never automatic. Colour banners show what each control affects. STANDBY fades to a safe title card. The live scene can't be deleted. Closing the operator window closes the output. Autosave uses atomic writes. |
| Keyboard shortcuts | Ctrl/⌘+Enter takes live; `G` is GO. Lion keys only work while **Arm keyboard** is on, and never while typing in a field. |
| MIDI, DMX/lighting integration, show automation (mentioned in the vision) | Built: MIDI in/out, MSC, OSC in/out, triggers with Learn, time markers on clips, TAKE/GO announcements. See [SHOW_CONTROL.md](SHOW_CONTROL.md). DMX itself stays on the lighting console. |

## Asset decisions

- **Lion**: a clearly labelled procedural placeholder, built on the same component the real GLB will use. See [LION_ASSET.md](LION_ASSET.md).
- **Environments**: built procedurally (terrain, grass, rocks, olive trees, sky, clouds, distant ridges, sheep, birds, fire, town lights), so the prototype runs with no downloaded assets. They are stylised, not photoreal. Following the brief's core philosophy, the route to photoreal backdrops is AI-generated plates imported as **media backgrounds**, with the lion and effects composited over them. Every scene already supports this, with a shadow catcher under the lion on flat plates.
- **Scene 03** is a compositing *template*: empty media slots that show a "NO ASSET" marker in operator previews only. It demonstrates walker layers, blend modes and grading once you import plates.

## Known limitations

- **Native output verification**: on this development Mac I verified, inside the real Tauri app, that the output window is created natively, receives program state, sends heartbeats, and that the project saves and reloads. The app's windows weren't on a visible Space during the automated run, so its native frame rate couldn't be measured there. Rendering and output sync were verified with the same code in a browser. **Check on the Windows show machine**: open the output on the LED display, watch the fps readout in the top bar, and run a full cue list.
- `availableMonitors()` returned an empty list on this Mac (a Tauri/macOS quirk). The app falls back to the primary and current monitor. On Windows with two displays, check that both are listed in Output settings.
- Each preview/program view renders the scene independently, so 3–4 GPU renders run during a transition. Fine on a discrete GPU; at very large canvases, lower **Target frame rate** or close Scene Builder previews during the show.
- Video can't be relit. Night on a video plate uses a matching night plate (crossfade) and/or a colour grade.
- Environment ↔ media background switches inside one scene cut rather than crossfade. Use separate scenes plus a transition for those.
- Transparent video needs a codec the platform's webview decodes with alpha: VP9 WebM alpha on Windows (WebView2), HEVC alpha on macOS.
- Browser dev mode stores imported media as session-only blob URLs. The desktop app copies media into the app data folder.

## Suggested next steps

1. Choose and license the hero lion. Map its clips and tune stride (about an hour of work once the asset exists).
2. Generate AI plates for both locations (day/night pairs) and a camera-travel video between them, then A/B them against the procedural worlds on the actual wall.
3. Add a timecode-driven cue mode (MIDI timecode / LTC) if the show moves to a locked audio track; MIDI/OSC triggers are done.
4. Add an on-canvas transform gizmo in Scene Builder (V1 uses numeric/slider fields).
5. Add GPU-side single render with an output-window mirror, if the show machine struggles with multiple views.

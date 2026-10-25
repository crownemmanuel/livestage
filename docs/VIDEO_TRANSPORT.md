# Video transport: hold, scrub, resume

When an actor misses a beat, the operator can hold the wall on the current frame, scrub the video to a point, and resume from there. It works on the PREVIEW monitor and on the LIVE program wall.

## Operating

| Action | How |
| --- | --- |
| Hold / resume the live wall | **Hold** / **Resume** in the transport bar under the PROGRAM monitor, or `P` when the live scene is the selected one (otherwise `P` holds the preview, the same rule as `G`) |
| Scrub the live wall | Hold first. Then drag the bar: a ghost playhead shows where you will land, and the wall cuts there once, when you let go. The −5 / −1 / +1 / +5 s buttons step the held wall |
| Jump to a marker | Click its tick (live wall: while held) |
| Pick which video the bar follows | The video menu in the bar (backgrounds, video layers, video-actor clips) |
| Preview | Play / pause next to the preview's scene clock; dragging the preview's bar scrubs it (and pauses it) at once |

The PROGRAM monitor shows a **HELD** badge while the live scene is held. Hold is the same as **Freeze** (`clock` cue action, `/sls/freeze`, the `freeze` MCP tool): the whole scene stops on this frame, including effects and camera moves, and the sound stops with the picture: the videos' and the sound cues' (narration, music). Resume carries on from exactly the frame on screen.

## How it works

Transport is per scene and is built on the scene clock (`SceneRuntime.clock`), so it stays a pure function of timestamped events:

- **Hold** sets `clock.pausedAt`; **resume** moves `clock.base` forward by the time held.
- **Scrub** of a background or video layer moves `clock.base` (the scene clock jumps, so every video, effect and tween in the scene shows that moment). Scrubbing a video actor's clip replaces the actor's clip segment.
- The output window renders the broadcast runtime; a reload of the operator window restores it from `state.json`. Both land on the same frame and position.
- Audio: unmuted video plays from the `<video>` element in the audio host window, which `syncVideo` pauses, parks on the scrubbed frame and plays again with the clock.
- Sound cues (`sound` action, Web Audio in `engine/audio.ts`) follow the same clock: Hold silences them where they are, resume carries on from there, and a scrub moves them with the picture. A sound carried over from an earlier scene (`keepPlaying`) holds and resumes with the wall and moves by as much as the scrub. A sound fired while the scene is held starts when it resumes.

The live wall only scrubs while it is held (in the UI and over MCP), so an accidental drag never jumps what the audience sees.

## Markers and timed cues on a scrub

Rule: **markers and scene-time cues fire only during normal playback, the first time playback passes their moment in this run of the scene.**

- **Jumping forward** over a marker or a time cue does not fire it. A skipped cue stays in the run sheet: GO it by hand if it is still wanted.
- **Scrubbing back and playing again** does not fire markers or time cues that already fired; they fire again only once playback passes the furthest point reached before the scrub.
- **Holding** fires nothing.
- A video that **loops by itself**, a clip that **starts again** (new clip, layer restart, background change) is a new pass: its markers fire again, as before.
- After a **reload** of the operator window, only markers in the last half second fire (a fresh clip's first frames still count); earlier ones are not re-sent.

The furthest point is stored in the runtime, not in the poller: `clock.reached` (scene ms, set by `seek`) and a clip segment's `skip` (clip seconds, set by `clip.seek`). See `pollMarkers` / `pollTimedCues` in `src/engine/operator.ts`.

## Agents

The MCP tool `transport` (status, hold, resume, toggle, seek, nudge in video seconds) drives the same code; `seek` and `freeze` work on the scene clock. On program, `seek` / `transport seek|nudge` are refused unless the scene is held. See [AGENT_CONTROL.md](AGENT_CONTROL.md).

# Video transport: hold, scrub, resume

When an actor misses a beat, the operator can hold the wall on the current frame, scrub the video to a point, and resume from there. It works on the PREVIEW monitor and on the LIVE program wall.

## Operating

| Action | How |
| --- | --- |
| Hold / resume the live wall | **Hold** / **Resume** in the transport bar under the PROGRAM monitor, or `P` when the live scene is the selected one (otherwise `P` holds the preview, the same rule as `G`) |
| Scrub the live wall | Hold first. Then drag the bar: a ghost playhead shows where you will land, and the wall cuts there once, when you let go. The −5 / −1 / +1 / +5 s buttons step the held wall |
| Jump to a marker | Click its tick (live wall: while held) |
| Pick which video the bar follows | The video menu in the bar (backgrounds, video layers, video-actor clips, and **Whole scene**, which scrubs scene time itself: use it to get back to a moment whose video is no longer on screen) |
| Go back to a cue | The ↺ button on a cue already passed (live wall or preview): the scene returns to that cue's moment and plays on from there |
| Preview | Play / pause next to the preview's scene clock; dragging the preview's bar scrubs it (and pauses it) at once |

The PROGRAM monitor shows a **HELD** badge while the live scene is held. Hold is the same as **Freeze** (`clock` cue action, `/sls/freeze`, the `freeze` MCP tool): the whole scene stops on this frame, including effects and camera moves, and the sound stops with the picture: the videos' and the sound cues' (narration, music). Resume carries on from exactly the frame on screen.

## How it works

Transport is per scene and is built on the scene clock (`SceneRuntime.clock`), so it stays a pure function of timestamped events:

- **Hold** sets `clock.pausedAt`; **resume** moves `clock.base` forward by the time held.
- **Scrub** of a background, a video layer, a video character's playing clip or the whole scene rebuilds the run at that moment (`seekScene` in `src/engine/operator.ts`), like scrubbing a video: from the top, every cue action up to that moment applied at its own scene time, so layers, videos, sounds, effects, clips and the GO pointer are what they were then. GO cues sit where they were pressed in this run (remembered across seeks); cues that fire by themselves where they fire. A GO not pressed yet is not applied by a scrub forward. Scrubbing a video character's clip that is not playing puts the actor on that clip alone.
- The output window renders the broadcast runtime; a reload of the operator window restores it from `state.json`. Both land on the same frame and position.
- Audio: unmuted video plays from the `<video>` element in the audio host window, which `syncVideo` pauses, parks on the scrubbed frame and plays again with the clock.
- Delayed cue actions and follow cues wait on the scene clock, not the wall clock: a hold holds them, and a scrub re-arms the ones still ahead of the new moment.
- Sound cues (`sound` action, Web Audio in `engine/audio.ts`) follow the same clock: Hold silences them where they are, resume carries on from there, and a scrub moves them with the picture. A sound carried over from an earlier scene (`keepPlaying`) holds and resumes with the wall and moves by as much as the scrub. A sound fired while the scene is held starts when it resumes.

The live wall only scrubs while it is held (in the UI and over MCP), so an accidental drag never jumps what the audience sees.

## Cues, markers and timed cues on a scrub

Rule: **a scrub puts the scene where a video would be. Everything up to the moment counts as played; everything after it plays again.**

- **Scrubbing back** un-fires the cues after that moment: GO points at the first of them, and markers and time cues fire again when playback reaches them.
- **Scrubbing forward** applies the cues that would have fired by themselves in between (time cues, follows, video markers) without sending their lights / MIDI / OSC; a GO cue not pressed in this run waits for GO.
- **Go back to a cue** (↺ on a passed cue, or `cue fire` on one): the scene goes to that cue's moment as the run had it (a skipped GO before it at its planned hold) and plays on from there; that cue's own lights / MIDI / OSC go out again.
- Lights / MIDI / OSC, timers, announcements, blackout and takes are never replayed for the stretch jumped over; on the live wall the ones still ahead go out at their moment.
- **Holding** fires nothing, and delayed actions wait.
- A video that **loops by itself**, a clip that **starts again** (new clip, layer restart, background change) is a new pass: its markers fire again.
- After a **reload** of the operator window, only markers in the last half second fire (a fresh clip's first frames still count); earlier ones are not re-sent.

The point the run has played to is stored in the runtime: `clock.reached` (scene ms, set by a seek) and a clip segment's `skip` (clip seconds, set by `clip.seek`). See `seekScene`, `pollMarkers` and `pollTimedCues` in `src/engine/operator.ts`.

## Agents

The MCP tool `transport` (status, hold, resume, toggle, seek, nudge in video seconds) drives the same code (source `scene` scrubs the whole scene); `seek` and `freeze` work on the scene clock. On program, `seek` / `transport seek|nudge` are refused unless the scene is held. See [AGENT_CONTROL.md](AGENT_CONTROL.md).

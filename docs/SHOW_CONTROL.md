# Show control: MIDI and OSC

The app talks to the lighting console (Hog 4) and to sound in both directions. Everything lives under **I/O** in the top bar.

## What goes in and out

| Direction | Carrier | Used for |
| --- | --- | --- |
| In | MIDI Show Control (MSC) GO | The console drives the wall: cue `12` takes scene 12, cue `12.3` fires cue 3 of scene 12 (taking the scene first if it is not live). Turn this off with **Follow MSC cues**. |
| In | MIDI note / CC / program change | Anything else you map under **Incoming triggers** (GO, take, blackout, standby, freeze, preview selection). |
| In | OSC over UDP | Built-in commands (below) plus any address you map under Incoming triggers. |
| Out | OSC | `Send MIDI / OSC` cue actions, clip time markers, and the optional announcement of every TAKE and GO. |
| Out | MIDI note / CC / PC / MSC | The same cue actions and time markers over MIDI. |

### Built-in OSC commands (no mapping needed)

| Address | Arguments | Does |
| --- | --- | --- |
| `/sls/go` | | GO (next live cue) |
| `/sls/back` | | Step the next-cue pointer back |
| `/sls/take` | scene number | Take that scene live |
| `/sls/next` | | Take the scene after the live one |
| `/sls/cue` | scene number, cue number | Fire that cue (takes the scene first if needed) |
| `/sls/select` | scene number | Put that scene in the preview |
| `/sls/blackout` | 0/1 (none = toggle) | Lights out / up |
| `/sls/standby` | 0/1 (none = toggle) | Standby visual on / off |
| `/sls/freeze` | 0/1 (none = toggle) | Freeze / resume all motion |

### Announcements (out)

With **Announce TAKE / GO** on, every TAKE sends `/sls/scene <number> <name>` and every GO sends `/sls/cue <scene> <cue> <name>` to the chosen target, so the console (or a logger) always knows where the wall is.

## Sending at a moment in a clip

A clip can carry **time markers** (Scene Builder → the clip inside a video actor, or any video layer / plate → Time markers). When live playback passes the marker's time the message is sent, once. Markers on a looping clip fire on every pass. Example: a marker at 2.5 s on the lion's charge clip that sends `/hog/playback/go/3` so the lighting strobe fires exactly on the leap.

Markers only fire from the live (PROGRAM) show, never from previews, and never twice for the same pass.

## Hog 4 set-up

**Hog → app (MSC):**
1. On the Hog: Setup → Network → select the console → Settings → MIDI: enable *MIDI Show Control out*, device ID 0 (or match the app's **MSC device ID**).
2. Connect a MIDI cable / USB-MIDI interface to the show computer. In the app, I/O → MIDI → Enabled, pick the input.
3. Give the Hog cuelist cue numbers that match the app's scene numbers (and `scene.cue` for individual cues). With **Follow MSC cues** on, the wall follows the console's GO.

**Hog → app (OSC):** Setup → Network → Open Sound Control: enable OSC In/Out, set the app's computer as the OSC target with the app's listen port (default 9000). The Hog sends LED/status messages such as `/hog/status/led/go/1 1` when a master's GO is pressed; map those under Incoming triggers with **Learn** (press Learn, then press GO on the console).

**App → Hog (OSC):** add the console as an OSC target: its HogNet IP (172.31.0.1 on this rig) and the OSC In port shown in its Settings → Open Sound Control (7001). Only OSC In needs to be on. The Mac's USB Ethernet adapter needs a fixed IP on HogNet (172.31.0.3, mask 255.255.0.0, router blank).

The Hog only acts on playback commands when the number arrives as an OSC **string**; an int or float is silently ignored (tested on the console, 2026-10-18). The app sends args of any `/hog/playback/...` address as text automatically, so type them plainly:

| On the Hog | Address | Args |
| --- | --- | --- |
| GO cuelist 515 | `/hog/playback/go/0` | `515` |
| Jump to cue 3 of cuelist 515 | `/hog/playback/go/0` | `515.3` (cue 10 is `515.10`) |
| Halt / resume cuelist 515 | `/hog/playback/halt/0`, `/hog/playback/resume/0` | `515` |
| Release cuelist 515 | `/hog/playback/release/0` | `515` |
| GO / release scene 2 | `/hog/playback/go/1`, `/hog/playback/release/1` | `2` |
| Run macro 4 | `/hog/playback/go/2` | `4` |

To release one list and start another at a given cue, give the cue two `Send MIDI / OSC` actions: release first, then GO with `list.cue`. Hardware keys (`/hog/hardware/go/<master>`, `1` press / `0` release) are in the ETC manual but were not confirmed working on this console; prefer the playback paths. Use the **Test** button on any message to try it.

**App → Hog (MSC):** send MSC GO with the Hog's device ID and the cue number; the Hog must have MSC in enabled.

## Monitor and test

I/O → **Monitor** shows every message in and out with a timestamp, and the **Incoming triggers** tab has three "simulate" buttons so the whole chain can be rehearsed without a console. The status bar in Show Mode shows the in/out counters and the last message.

## In a browser (development)

Chrome supports Web MIDI (it asks for permission when you open the I/O dialog or enable MIDI). OSC needs UDP sockets, so it works only in the desktop app.

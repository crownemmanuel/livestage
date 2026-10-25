# Show control: MIDI and OSC

The app talks to the lighting console (Hog 4) and to sound in both directions. Everything lives under **Settings** in the top bar: a list of sections on the left (Lighting console, Lighting library, Receive from console, Incoming triggers, MIDI, Other OSC devices, Audio output, Monitor), the chosen one on the right.

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

A clip can carry **time markers**. The quickest way: in Build, pick the video on the **timeline** under the preview (or isolate it in *On stage*), scrub to the moment and press **Marker at …**. A marker either fires a step of the run sheet or sends lighting / MIDI / OSC (a new one starts as a Hog Lighting action). A step whose *Fires* is *When a video reaches a time* is the same thing seen from the run sheet. Example: a marker at 1.8 s on the lion's run clip that GOes the strobe cuelist exactly on the leap. See [BUILD_GUIDE.md](BUILD_GUIDE.md).

Messages from markers only leave from the live (PROGRAM) show; in the preview, markers that fire a step still run it for rehearsal. A marker never fires twice for the same pass, and scrubbing never fires markers: not the ones jumped over, not the ones replayed after scrubbing back ([VIDEO_TRANSPORT.md](VIDEO_TRANSPORT.md)).

## Hog 4 set-up

**Hog → app (MSC):**
1. On the Hog: Setup → Network → select the console → Settings → MIDI: enable *MIDI Show Control out*, device ID 0 (or match the app's **MSC device ID**).
2. Connect a MIDI cable / USB-MIDI interface to the show computer. In the app, Settings → MIDI → MIDI on, pick the input.
3. Give the Hog cuelist cue numbers that match the app's scene numbers (and `scene.cue` for individual cues). With **Follow MSC cues** on, the wall follows the console's GO.

**Hog → app (OSC):** Setup → Network → Open Sound Control: enable OSC In/Out, set the app's computer as the OSC target with the app's listen port (default 9000). The Hog sends LED/status messages such as `/hog/status/led/go/1 1` when a master's GO is pressed; map those under Incoming triggers with **Learn** (press Learn, then press GO on the console).

**App → Hog (OSC):** **Settings** → *Lighting console*: the console's HogNet IP (172.31.0.1 on this rig) and its OSC In port (7001). Nothing needs switching on to send; *Listen for OSC* is only for receiving. On the Hog only OSC In needs to be on. The Mac's USB Ethernet adapter needs a fixed IP on HogNet (172.31.0.3, mask 255.255.0.0, router blank).

**Lighting library** (Settings → Lighting library): name each Hog cuelist, scene or macro once ("Rain lights" = cuelist 515). Cues point at the library entry, so renumbering it there updates every cue. The ▶ / ■ buttons GO / release it on the console as a test. It starts with the cuelists on the venue console's playback bar.

**Firing from a cue:** Build → Cues → *Add action* → **Lighting (Hog 4)**. Pick GO / Release / Halt / Resume, then a library entry or *Cuelist / Scene / Macro #…* with a number; the bookmark button saves a typed number to the library by name. *cue* (GO on a cuelist only) jumps to that cue; empty means the list's next cue. *master* (GO only): if the list sits on a master, put the master number here and the app pushes that fader to full just before the GO (`/hog/hardware/fader/<master>` 255). A list on a master plays at its fader's level, so a GO on a lowered fader runs the cue with no light. Lists the app fires and that sit on no master play at full and need nothing here. Clip time markers use the same editor.

Under the hood this sends `/hog/playback/<go|release|halt|resume>/<0 cuelist | 1 scene | 2 macro>` with the number as an OSC **string** (`"515"`, `"515.2"`): the Hog silently ignores int and float arguments (tested on the console, 2026-10-18). A *Custom OSC* message to a `/hog/playback/...` address is sent the same way.

To release one list and start another at a given cue, give the cue two Lighting actions: Release the first list, then GO the second with its cue number. Hardware keys (`/hog/hardware/go/<master>`, `1` press / `0` release) are in the ETC manual but were not confirmed working on this console; prefer the playback paths. Use the **Test** button on any message to try it: it shows the exact OSC it sent and asks whether the console reacted (nothing comes back over OSC to tell the app). *No, nothing happened* lists what to check, most likely first: a lowered master fader, OSC In off on the console, a list or cue number that does not exist, the network.

**App → Hog (MSC):** send MSC GO with the Hog's device ID and the cue number; the Hog must have MSC in enabled.

## Monitor and test

**Settings** → **Monitor** shows every message in and out with a timestamp, and the **Incoming triggers** section has three "simulate" buttons so the whole chain can be rehearsed without a console. The status bar in Show Mode shows the in/out counters and the last message.

## In a browser (development)

Chrome supports Web MIDI (it asks for permission when you open Settings or enable MIDI). OSC needs UDP sockets, so it works only in the desktop app.

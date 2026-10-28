# Show control: MIDI and OSC

The app talks to the lighting console (Hog 4), the StageLight lighting desk and sound in both directions. Everything lives under **Settings** in the top bar: a list of sections on the left (Lighting console, Lighting library, StageLight, Receive from console, Incoming triggers, MIDI, Other OSC devices, StageMics (dLive), Audio output, Monitor), the chosen one on the right.

## What goes in and out

| Direction | Carrier | Used for |
| --- | --- | --- |
| In | MIDI Show Control (MSC) GO | The console drives the wall: cue `12` takes scene 12, cue `12.3` fires cue 3 of scene 12 (taking the scene first if it is not live). Turn this off with **Follow MSC cues**. |
| In | MIDI note / CC / program change | Anything else you map under **Incoming triggers** (GO, take, blackout, standby, freeze, preview selection). |
| In | OSC over UDP | Built-in commands (below) plus any address you map under Incoming triggers. |
| Out | OSC | `Send MIDI / OSC` cue actions, clip time markers, and the optional announcement of every TAKE and GO. |
| Out | MIDI note / CC / PC / MSC | The same cue actions and time markers over MIDI. |
| Out | OSC to StageLight | StageLight cue actions and time markers: GO a page or cue, named triggers, stop, blackout, master ([below](#stagelight-lighting-desk)). Optionally every TAKE and GO as a named trigger. |
| In | StageLight replies | Its hello (version, armed, running page and cue), refusals, and its GO announcements (shown in Settings → StageLight). |
| Out | OSC to StageMics | Mics live / muted, voice effects, StageMics' scenes and cues ([below](#stagemics-dlive)). StageMics owns the dLive sound desk. |
| In | StageMics replies | StageMics' hello, active cue and mic states (shown in Settings). |

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

A clip can carry **time markers**. The quickest way: in Build, pick the video on the **timeline** under the preview (or isolate it in *On stage*), scrub to the moment and press **Marker at …**. A marker either fires a step of the run sheet or sends lighting / MIDI / OSC (a new one starts as a StageLight GO when the StageLight link is on, else as a Hog Lighting action). A step whose *Fires* is *When a video reaches a time* is the same thing seen from the run sheet. Example: a marker at 1.8 s on the lion's run clip that GOes the strobe cuelist exactly on the leap. See [BUILD_GUIDE.md](BUILD_GUIDE.md).

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

## StageMics (dLive)

LiveStage does not talk to the sound desk itself. **StageMics**, the mic app ([crownemmanuel/StageMics](https://github.com/crownemmanuel/StageMics)), owns the Allen & Heath dLive: it knows each scene's cast and mic cues, the voice effects and the backstage mic checks. LiveStage tells it what to do over OSC from a cue or a clip's time marker, and StageMics does it on the desk and can put things back. (LiveStage's earlier direct dLive link was folded into StageMics; old show files load with any direct desk messages removed.)

### Set-up

Settings → *StageMics (dLive)*: switch on *Send to StageMics*, its IP address (127.0.0.1 when it runs on this computer) and OSC port (1451, shown in StageMics under Build → Settings → Network control). LiveStage pings it every few seconds; the status says *answering* once it replies with `/sound/hello`. Replies arrive on LiveStage's OSC listen port, so switch on *Receive from console → Listen for OSC* to see them (with it off the status stays *sent*). When it answers, the section also shows its active cue and every mic's state. The switch belongs to this computer: a show file from another machine never switches it on.

### Messages

Add them like a lighting action: Build → Cues → *Add action* → **StageMics (dLive)**, or in a time marker's *Send* editor pick *StageMics (dLive)*. Every editor has a **Test** button that sends it now and shows exactly the OSC that went out.

| StageMics command | OSC | Notes |
| --- | --- | --- |
| Select scene | `/sound/scene/select s:sceneId` | Shows it on StageMics' screen, changes no mic. *This scene* = the scene the cue or marker belongs to. |
| Activate scene | `/sound/scene/activate s:sceneId` | Selects it and applies its first cue. |
| Go to cue | `/sound/cue/go s:sceneId i:cue` | Applies exactly that cue (1-based). |
| Next cue | `/sound/cue/next` | |
| End scene | `/sound/scene/end` | Mutes every mic of the active scene. |
| Mic live / muted | `/sound/mic s:who i:1/0` | `who` = the mic number or the character's name. |
| Voice effect | `/sound/fx s:who s:preset [s:amount]` | `none` switches it off; amount light / medium / full. |
| Restore | `/sound/restore` | Re-applies the active cue. |
| Panic | `/sound/panic` | Mutes every mic. |

Every argument to StageMics is an OSC string or int32, and commands set a state rather than toggle, so a repeated packet is harmless.

### Recipe: an actor lip-syncs part of a song

Joseph sings live through the instrumental but mimes the verse to his recorded vocal. The vocal is in the track LiveStage plays (a video layer or background with sound, or a video character's clip).

1. In StageMics, Joseph's mic is live in the scene's cue.
2. In Build, select the track, scrub the timeline to where his recorded vocal starts and press **Marker at …**. Set it to *Send* → *StageMics* → *Mic live / muted*, mic `Joseph`, *Muted*.
3. Scrub to where the vocal ends, add a second marker: mic `Joseph`, *Live*.
4. Rehearse with the track live: the I/O monitor shows `/sound/mic "Joseph" 0` and `… 1` at those times. Nobody presses a key.

### Restore when a track stops or jumps

Markers fire only during normal playback, once per pass; scrubbing never fires the markers jumped over or replays the ones already passed ([VIDEO_TRANSPORT.md](VIDEO_TRANSPORT.md)). So if the track above stopped after the mute marker, Joseph would stay muted. To prevent that, when a live track (or a video character's clip) has sent StageMics *mic* or *voice effect* message from a marker, directly or through a cue the marker runs, and then **stops** (hidden, another clip, background changed), **restarts**, is **scrubbed** in either direction, or another scene is **taken** before the track reaches its natural end, LiveStage sends `/sound/restore` once and StageMics puts every mic back to its active cue. Playing to the end needs nothing. The I/O monitor logs why (`StageMics restore: Track restarted after moving a mic`).

### Safety

- Messages only leave from the live (PROGRAM) show; the preview never reaches StageMics.
- The **Test** buttons send to StageMics at once, and StageMics acts on the real desk unless it is in dry run (StageMics → Build → Desk). Use dry run or its pretend desk when the desk is in use.

## StageLight (lighting desk)

StageLight is the show's own lighting desk app (pages with cue lists, crossfades, auto-follow, Art-Net out). LiveStage drives it over OSC, the same UDP path as the Hog: no connection, sub-millisecond on the same Mac, and nothing in LiveStage ever waits for it. The protocol is StageLight's `docs/SISTER-APPS.md`.

### Set-up

Settings → **StageLight**: switch on *Send to StageLight* (this computer only: a show file from another machine never switches it on), its IP address (127.0.0.1 when it runs on this Mac) and OSC port (**1461** on the show desk; development desks use other ports such as 1471). LiveStage pings it every 5 s with `/stagelight/ping <listen port>`; the status says *answering* once `/stagelight/hello` comes back, with StageLight's version, whether its output is armed or preview-only, and the page and cue it is running. Replies arrive on LiveStage's OSC listen port, so switching on *Send to StageLight* also switches on *Receive from console → Listen for OSC* (if it is switched off again, the status stays *sent*). While listening, every message to StageLight leaves from the listen port, so StageLight's refusals (`/stagelight/error`) come back too and show in red in Settings and in the Monitor.

To also see StageLight's GOs (from its own GO button, auto-follow, another app): in StageLight, ☰ → Network & triggers → *Send to*, add an OSC target at LiveStage's IP and listen port with **announce** on. Each GO then arrives as `/stagelight/cue/live pageId pageName cueNumber cueName entryId`: shown as *Last GO* in Settings → StageLight, logged in the Monitor, and matchable under **Incoming triggers** (so a light cue can drive the wall too).

If StageLight runs on another computer, switch its listener to *Show network* and allow this computer's IP there.

**Picking from StageLight's lists.** StageLight 0.3 and later publish a catalog: its pages with their cue lists, its named triggers and its library cues. LiveStage asks for it (`/stagelight/catalog <listen port>`) whenever StageLight's hello carries a revision different from the one it holds, so an edit in StageLight shows up here within a ping (5 s). The catalog arrives as one small message per item (`/stagelight/catalog/begin`, `…/page`, `…/cue`, `…/trigger`, `…/library`, `…/end`); LiveStage checks the counts and asks again if a packet went missing. Cues then pick pages, cues, triggers and library cues from lists and store StageLight's IDs (`/stagelight/go/cue "scene-1" "e2"`), so a rename in StageLight changes nothing here; the names at the time of picking are kept as a label. The last catalog is kept in the show file, so cues can be built while StageLight is off ("as last read" in Settings). A pick StageLight no longer has is marked ⚠ in the editor. *Type a name…* in every list still allows a name or number StageLight resolves itself, and with an older StageLight (no catalog) the fields are text boxes. Settings → StageLight shows the catalog's size and has **Refresh**.

### Messages

Build → Cues → *Add action* → **StageLight**, or in a time marker's *Send to* pick *StageLight*. Every editor has a **Test** button: it sends now, shows the exact OSC, and, because StageLight answers, says whether StageLight refused it (and why) or announced the GO.

| Command | OSC | Notes |
| --- | --- | --- |
| GO, cue *Next cue* | `/stagelight/go [s:page]` | Next cue of that page's cue list; *running page* = the page that is running. Auto-follow cues continue in StageLight. |
| GO, a cue picked | `/stagelight/go/cue s:page i\|s:cue` | That cue of the page. Picked from the catalog it is the entry ID; a typed cue that is a plain number goes as int32, anything else as a string. |
| Named trigger | `/stagelight/trigger s:name` | **Recommended.** The name (`lion.leap`, `chorus`) is mapped to an action inside StageLight, so the lighting operator can renumber or remap without touching the show here. |
| Back | `/stagelight/back` | Previous cue on the running page. |
| Stop | `/stagelight/stop [f:fade]` | Fade to dark; empty fade = StageLight's default (1.5 s). |
| Clear | `/stagelight/clear [f:fade]` | Release manual changes back to the cue. |
| Blackout | `/stagelight/blackout i:1\|0` | On / off. |
| Master | `/stagelight/master f:0..1` | The editor takes a percentage. |
| Play library cue | `/stagelight/play s:cue [f:fade]` | A cue from StageLight's library, outside any page. |
| LED wall media | `/stagelight/ledwall s:media` | StageLight's LED wall preview; `off` = blank. |

Pages and cues are StageLight's own: a name (case-insensitive), an ID, or a 1-based number. Commands set a state, so a repeated packet is harmless.

**Mirror TAKE and GO as named triggers** (Settings → StageLight): every live TAKE also sends `/stagelight/trigger "scene.<code>"` and every GO `/stagelight/trigger "cue.<code>.<n>"`, with the running-order code the operator sees (`scene.12`, `scene.1.2`, `cue.12.3`). Map only the ones that should do something in StageLight; StageLight refuses the others, which is expected and logged as info, not as an error. Nothing is mirrored from the preview.

### Recipe: a light cue on the lion's leap

1. In StageLight, map a named trigger `lion.leap` to *GO cue* "Act 1" cue 4 (its auto-follow chain runs from there).
2. In Build, select the lion's *run* clip on the timeline, scrub to 1.8 s and press **Marker at …**. *Send to* → *StageLight* → *Named trigger* `lion.leap`. **Test** shows `/stagelight/trigger "lion.leap" → 127.0.0.1:1461`.
3. On the live run, at exactly 1.8 s into the clip, StageLight GOes cue 4. The rules of all markers apply: only from PROGRAM, once per pass, never while scrubbing.

### Safety

- Messages only leave from the live (PROGRAM) show; the preview never reaches StageLight (cue actions and markers rehearse without sending).
- **Test** sends to StageLight at once. If StageLight's output is armed, the real rig follows. Test against a development desk on its own port when the show desk is in use.
- `pnpm stagelight:check` tests the protocol offline; `pnpm stagelight:check --port 1471` also sends a ping, a GO and a trigger to a desk on that port and prints its answers. `node mcp/check.ts --stagelight 1471` does the same through the running app. All refuse port 1461 unless given `--production`.

## Audio output (Dante)

**Settings → Audio output** picks the speakers for all of the app's sound (cue sounds, thunder, announcements, video sound). The choice belongs to the computer, not the show file. Dante devices are listed first.

- **Mac:** the list comes from CoreAudio (`src-tauri/src/audio.rs`). The webview can only play on the Mac's default output, so choosing a device makes it the Mac's output while the app runs, and the previous one comes back on quit.
- **Windows:** the list comes from the webview (WebView2), which lists every playback device, the same names as vMix's WDM list, Dante Virtual Soundcard included while it runs. Choosing one moves only this app's sound (`setSinkId`, `engine/audioOutput.ts`). WebView2 names its outputs, and plays to a named one, only once the page may use a microphone, so the app asks for it on its own and the Rust side grants it to the app's own pages without a prompt. Nothing is recorded. It needs at least one input device to ask with; Dante Virtual Soundcard provides one. If the list still shows only "Computer default", start Dante Virtual Soundcard and press **Show all outputs**.
- **Dante Virtual Soundcard must run in WDM mode** for the app to see it. It runs one engine at a time, ASIO or WDM, and ASIO bypasses Windows' own audio, so only ASIO apps (vMix lists it as "Dante Virtual Soundcard (x64)") can use it then. To switch: in the Dante Virtual Soundcard window press **Stop**, set **Settings → Audio Interface** to **WDM**, press **Start**. In WDM mode it has 16 channels as 8 stereo pairs, each its own Windows output: **DVS Transmit 1-2**, **3-4** … Pick the pair whose channels you want in Dante Controller. ASIO apps on the same computer then lose it, so point vMix at a DVS Transmit output as well (a different pair, or the same one: WDM outputs are shared). When the app finds the Dante ASIO driver installed but no DVS outputs, Settings → Audio output says this.
- To avoid Windows resampling, set each DVS Transmit output's default format (Control Panel → Sound → the output → Properties → Advanced) to the Dante sample rate shown in Dante Virtual Soundcard (usually 48000 Hz).
- On the Mac, sound plays in stereo on the device's channels 1+2. On Dante, check those channels in Dante Controller.

## Monitor and test

**Settings** → **Monitor** shows every message in and out with a timestamp, and the **Incoming triggers** section has three "simulate" buttons so the whole chain can be rehearsed without a console. The status bar in Show Mode shows the in/out counters and the last message.

## In a browser (development)

Chrome supports Web MIDI (it asks for permission when you open Settings or enable MIDI). OSC needs UDP sockets, so it works only in the desktop app.

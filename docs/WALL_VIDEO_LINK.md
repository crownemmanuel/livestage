# Wall video link (LiveStage → StageLight)

LiveStage can stream the picture the LED wall shows to StageLight, which puts it on the virtual LED wall of its 3D visualizer. StageLight shows its lights delayed by the measured video latency, so a light cue fired with a clip lands on the visualizer with the frame it belongs to, and the operator sees how the rig meets each clip.

It is a rehearsal tool:

- **Off at every start** of the app, switched on by hand (Settings → StageLight → Wall video, or the MCP `wall_video` command). The size, frame rate and port are remembered; "on" is not.
- **Program by default.** It captures the operator window's own **PROGRAM** monitor: the same picture the wall shows, put together the same way (both scene canvases during a transition, the transition video, the fade to black, standby and blackout). The **Preview** monitor can be chosen instead. It never reads the audience output window.
- **Nothing of it runs while it is off.** The sender is a separate module loaded with `import()` only when the switch goes on. It registers its render hook, worker and socket itself and removes all of them when switched off. The only code that exists while it is off is the switch: the setting, a few static `data-` attributes on the monitors' elements, and a boolean read when a *preview* cue sends a StageLight message (never on a live cue).

## Choice of method

| Option | Verdict |
| --- | --- |
| **NDI** | Rejected. It needs a native SDK (≈ 30–60 MB of runtime per platform), the licence forbids bundling without their terms and branding, and there is no WebView path: frames would have to go webview → Rust → NDI and back out to a webview in StageLight. The user has already seen NDI stutter. Built for full-resolution, low-latency production video, which a visualizer does not need. |
| **MJPEG over HTTP** (`multipart/x-mixed-replace`) | Close second. No SDK, an `<img>` plays it. But it carries **no per-frame timestamp** the page can read, so the light delay cannot be calibrated from the stream. |
| **JPEG frames over a WebSocket** | **Chosen.** No SDK and no native code on either side. Every frame carries LiveStage's clock time in a small binary header, so StageLight measures latency per frame. The socket also carries control messages (hello, clock-sync pings, viewer count, pause when nobody watches). At 1024×256 a JPEG is 20–60 KB, so 25 fps is about 1 MB/s, trivial on loopback or a LAN. Encoding happens in a Worker (`OffscreenCanvas.convertToBlob`), so the operator window's main thread only takes a GPU-side snapshot of the canvas. |
| **WebRTC** | Rejected. It is the lowest-bandwidth option, but needs signalling, ICE and a peer connection on StageLight's Node side (no built-in WebRTC in Node). Its jitter buffer adds its own variable delay, and its timestamps are hard to map back to the show clock. Too heavy for a preview. |
| **Syphon / shared memory** | Rejected. Same Mac only, needs native code in both apps (Objective-C/Metal on macOS, Spout on Windows), and neither app's view is a native GL surface (both are web views). |

### Why the frames come from the operator's monitors, and how

The output window is never touched: the known output hang ([ARCHITECTURE.md](ARCHITECTURE.md), "Output lost") comes from a synchronous GPU wait in that window, so nothing new runs there. The operator window's PROGRAM monitor renders the same state with the same code as the output window (that is the architecture's point), so its picture is what goes to the wall.

On every R3F frame where the monitor's top scene canvas was drawn, and at most at the chosen fps, the sender takes each visible scene canvas with `new VideoFrame(canvas)` (or `createImageBitmap(canvas)` where WebCodecs is missing). It does this right after the render, in the same task, so the drawing buffer is still valid and no `preserveDrawingBuffer` is needed. It reads no pixels on the main thread and touches no WebGL state. For the program it also reads the inline opacity of the monitor's HTML layers (they are written per frame by the program's own compositor) and snapshots the transition video while it is visible. It finds them by static attributes (`data-stage-source`, `data-wall-slot`, `data-wall-layer`). The snapshots are transferred to a Worker, which draws them in the monitor's stacking order with their opacities over the wall's background colour (scene slots, transition video, fade to black, standby colour with its picture or text, blackout), scales to the stream size, encodes JPEG and sends it. In Build mode the program monitor is not on screen; the status then says so and nothing is sent.

Only one frame is in flight at a time. While the worker is busy, or the socket still has data queued (`bufferedAmount > 0`), new frames are **dropped, never queued**, so latency stays flat when something is slow. The resolution is that of the preview canvas, scaled down: an operator preview drawn smaller than the stream size gives a softer stream, but never a slower one.

Measured cost: see "Measurements" at the end.

## Endpoints and ports

StageLight hosts the socket and LiveStage connects to it as a client, the same way it connects to the MCP bridge. LiveStage needs no new server and no native code. It reuses the StageLight host already set under Settings → StageLight (`io.stagelight.host`).

| Port | Who listens | What |
| --- | --- | --- |
| **1455** (default, `LIGHTS_WALL_PORT` in StageLight, *port* in LiveStage's wall video settings) | StageLight (Node), `0.0.0.0` | `ws://<host>:1455/wall/in`: the ingest. One sender at a time; a new sender replaces the old one. |
| StageLight's own HTTP port (1460 on a show computer, 1470/1480/… on dev desks) | StageLight (Node), `127.0.0.1` | `ws://127.0.0.1:<port>/api/wall`: the relay to StageLight's own windows (main window and pop-out visualizer). Same origin as the UI, so it is never exposed on the LAN. |

1455 clashes with nothing in use: LiveStage dev 1430, agent bridge 1431, test profiles 1440/1441, StageLight 1460/1461 (show), 1470/1471, 1475/1476, 1480/1481, 1490/1491, 1510/1511, 1520/1521 (dev desks). A dev StageLight sets `LIGHTS_WALL_PORT` to its own port (for example 1485 beside 1480/1481), and the LiveStage test profile points its wall video port there.

StageLight accepts ingest connections only from loopback and the addresses allowed by its OSC allowlist (if it has one), and refuses frames larger than 2 MB.

## Wire protocol (version 1)

WebSocket. **Binary messages are frames; text messages are JSON control messages.** All numbers are little-endian. All times are **epoch milliseconds as floats**, read as `performance.timeOrigin + performance.now()` (the shared show clock in LiveStage, [ARCHITECTURE.md](ARCHITECTURE.md)). On one machine both apps read the same clock; across a LAN they are related by the measured `offset` (below).

### Frame (binary, LiveStage → StageLight → views)

```
offset size type  field
0      4    ascii magic   "LSWV"
4      1    u8    version 1
5      1    u8    codec   1 = JPEG, 2 = WebP
6      2    u16   width   pixels of the encoded image
8      2    u16   height
10     2    u16   flags   bit 0: the streamed scene is frozen (scene clock held)
                          bit 1: no scene selected (image is the background colour)
12     4    u32   seq     frame number since the sender connected, +1 per frame sent (gaps = dropped)
16     8    f64   stamp   LiveStage clock time this picture shows: when its render ran
24     8    f64   sentAt  LiveStage clock time the encoded frame went on the socket
32     ...        image   the JPEG/WebP bytes, to the end of the message
```

`stamp` is the moment that matters: a light cue LiveStage fires at time T belongs with the frame whose `stamp` is T. `sentAt − stamp` is LiveStage's capture + encode time (reported, not used for sync).

StageLight relays frames to its views **unchanged** (same bytes), after recording `recvAt` on its side.

### Control messages (text JSON)

LiveStage → StageLight, on connect and whenever any field changes:

```json
{ "t": "hello", "app": "LiveStage", "version": "0.6.0", "protocol": 1, "source": "program",
  "width": 1024, "height": 256, "fps": 25, "scene": "1.4 Valley of Elah", "wall": [3072, 768] }
```

StageLight → LiveStage, on connect and when they change:

```json
{ "t": "hello", "app": "StageLight", "version": "0.5.3", "protocol": 1, "armed": false }
{ "t": "viewers", "n": 2 }
```

`viewers` is the number of StageLight windows showing the stream. LiveStage only shows it in its status: **nothing pauses the stream automatically**. It runs from the moment the switch goes on until it goes off, whoever is watching and whatever StageLight's output state. The one thing that stops frames is the operator window itself being fully hidden or covered: WebKit then stops its frame loop, and the monitors stop drawing too.

StageLight may report what it sees, so LiveStage's status line shows the far end:

```json
{ "t": "stats", "fps": 24.8, "latency": 46.2, "jitter": 4.1, "delay": 46.0, "offset": 0.3 }
```

(`latency` = median of `shownAt − (stamp − offset)` over the last 2 s in ms, `jitter` = its spread (p90 − p10), `delay` = the light delay StageLight applies including the manual offset, `offset` = clock offset in ms.)

Clock sync, StageLight → LiveStage → StageLight (every second, and 5 times quickly after connecting):

```json
{ "t": "ping", "id": 17, "s": 1763317000123.4 }
{ "t": "pong", "id": 17, "s": 1763317000123.4, "l": 1763317000124.9 }
```

StageLight times the round trip (`rtt = now − s`) and estimates `offset = l − (s + rtt / 2)`, the LiveStage clock minus the StageLight clock. It keeps the sample with the smallest `rtt` from the last 10 seconds (the quickest round trip is the least distorted). On one machine the offset is ≈ 0 and serves as a check. StageLight passes `offset` to its views in a text message on `/api/wall`:

```json
{ "t": "sync", "offset": 0.3, "rtt": 0.6 }
{ "t": "source", "connected": true, "hello": { … LiveStage's hello … } }
```

## Calibration: how lights and video line up

Two things arrive at StageLight at different speeds:

1. **The light cue.** LiveStage fires it at time T (preview cue, timed cue or video marker), sends it to StageLight over OSC (≈ 1–2 ms), and StageLight's engine computes the new look from then on.
2. **The video frame showing time T.** It is rendered at T, captured, encoded, sent, decoded and drawn: typically 30–70 ms later.

So the visualizer shows **video as soon as it arrives**, and **delays its light rendering by the video's measured latency**. It keeps a short history (≈ 1 s) of engine light frames, each stamped with the StageLight clock time it was computed. When it draws a video frame with stamp `S`, it draws the lights as they were at StageLight time `S − offset + manual`. Between frames it interpolates or holds the nearest earlier light frame. Because the delay comes from each frame's own stamp, it follows latency changes automatically. No round-trip test is needed on one machine, and across a LAN the clock offset covers it.

- **Manual offset** (StageLight, beside the readout, −200…+200 ms, default 0, saved per computer): added to the delay. Positive = lights later. It is there for what the stamps cannot see: a monitor's own lag, or a cue the operator times deliberately early.
- **When the feed stops** (no frame for 1 s, or the sender disconnects), the visualizer stops delaying and shows lights live again. The readout says "Wall video: no feed".
- **Output armed** in StageLight changes nothing: the stream keeps playing and the lights stay delayed to it. Only StageLight's own wall video switch (beside the readout) or LiveStage's switch turns it off.

Residual error: about one engine stream tick (StageLight's light frames) plus LiveStage's cue polling (60 Hz), so under 30 ms. LiveStage's own video sync dead band (50 ms muted, [ARCHITECTURE.md](ARCHITECTURE.md)) comes on top, and is the same on the real wall.

## Preview cues reach StageLight while the link streams the preview

With the **Program** source, the light cues are the live show's own: they reach StageLight the way they always do. A cue fired in the preview normally sends nothing out of the building. While the wall video link is **on with the Preview source**, a preview cue's **StageLight** messages (`send` actions and video-marker messages of type `stagelight`) are sent to StageLight too, so the rig on the visualizer reacts to the rehearsal. This happens only while StageLight's last hello (≤ 12 s old) says its output is **not armed** ("preview only"), so rehearsal never moves real lights. Every other message type (Hog, MIDI, sound desk, StageMics) still leaves only from the live show. The status line says when preview light cues are held back because StageLight is armed.

## LiveStage side

- Setting (per computer, never in the show file): `on` (always false at start), `source` (`program`, default, or `preview`), `width` (768 / 1024 / 1536; the height follows the wall's aspect), `fps` (15 / 20 / 25 / 30, default 25), `quality` (JPEG, default 0.7), `port` (1455). Kept under localStorage key `sls.wallVideo`.
- Status: off / connecting / connected (StageLight version, viewers), frames sent and dropped, achieved fps, bytes per second, main-thread capture time (mean / max ms), worker encode time, and StageLight's reported latency/jitter. The status lives in the always-loaded settings store, and is filled only while the link runs.
- MCP: `wall_video` (`{on?, source?, width?, fps?, quality?, port?}`): switches the link and changes its settings, and always returns the status. It does not reach the audience. With the Preview source it can send StageLight cues from the preview, but only to an unarmed StageLight.
- Files: `src/engine/wallVideoLink.ts` (setting, status store, switch; loads the rest), `src/engine/wallVideo.ts` (capture hook, worker, socket; lazy), `src/engine/wallVideoWorker.ts` (encode + socket), the Settings → StageLight section.

## StageLight side

- Ingest server on `LIGHTS_WALL_PORT` (default 1455), WebSocket `/wall/in`; relay `/api/wall` on the main HTTP server for its own windows. Node has no built-in WebSocket server, so a minimal RFC 6455 implementation (upgrade handshake, binary/text frames, ping/pong, close; no extensions) of about 150 lines, without dependencies.
- Virtual LED wall: while frames arrive, the stream replaces the LED wall media on the wall plane (decode with `createImageBitmap(blob)`, upload into one reused texture, `fit` as for media). It goes back to the chosen media when the feed stops.
- Engine light frames carry their computed-at time, so the views can delay them.
- Readout on the visualizer: `Wall video · 25 fps · 1024×256 · latency 46 ms ±4 · lights +46 ms`, plus the manual offset control.
- MCP: `lights_wall_video_status` (feed, fps, latency, jitter, delay, offset, viewers) and a setter for the manual offset.

## Measurements

LiveStage side, measured 2026-11-16 on the user's MacBook (macOS 26, 100 Hz display), in the desktop app (WebKit), with a test instance playing the demo show's photoreal valley scene in the preview, streaming 1024×256 at 25 fps, JPEG 0.7, to a stand-in receiver on the same Mac:

| | Link off | Link on |
| --- | --- | --- |
| Operator frame interval, 800 frames | mean 10.00 ms, p99 11, max 12–13, none > 20 ms | mean 10.00–10.04 ms, p99 11–12, max 12 (one 23 ms frame right at switch-on), ≤ 1 > 20 ms |
| Main-thread capture per frame (`new VideoFrame(canvas)`) | not loaded | 1.0 ms mean, 2 ms max (WebKit reports time in 1 ms steps) |
| Same call on bigger canvases (bench) | | 1 ms at 1024×256 and 1536×384, 2 ms (max 3) at 3072×768 |
| Worker scale + JPEG encode | | 2.5–3.2 ms |
| Frame size / bandwidth | | 38–54 KB, 7.7–10.5 Mbit/s at 25 fps |
| Render → frame received (loopback) | | median 2–4 ms, p90 3–5 ms, max 6 ms; no frames dropped in 2,300 |
| Clock sync (same Mac) | | rtt 0.3–0.5 ms, offset 0.3–1.1 ms |

While off, only `wallVideoLink.ts` (the switch) is loaded: `wallVideo.ts` and the worker appear in the page's resource list only after the switch goes on.

Notes:

- The stream is as sharp as the preview canvas it comes from. In Show mode that canvas is about 500–570 px wide (preview panel × DPR 1.25), so the stream is upscaled to 1024. That is fine for watching the rig react on the visualizer; a larger preview gives a sharper stream at the same cost.
- Frames are stamped with the operator window's clock, and the clock pings are answered by the worker. In WebKit both clocks step in 1 ms and can differ by about a millisecond, which is far below a light frame.
- A hidden or fully covered operator window stops its frame loop (WebKit), so nothing is captured then. That is the same behaviour as the preview itself.

### End to end with StageLight (same Mac, 2026-11-16)

LiveStage test instance (desktop app, Program source, 1024×256 at 25 fps), StageLight dev desk with the receiver (`claude/wall-video-receiver-…` branch, its own ports, output unarmed, fake I/O), StageLight's visualizer in headless Chrome:

- **Flash test.** A scene of timed cues, each cutting a full-wall white layer on or off and sending `play "Flash test" fade 0` / `stop 0` to StageLight. It was taken live on the test instance's program, which had no output window and no console targets. StageLight's sync probe compared the drawn video steps with the drawn (delayed) light steps over 8 cuts in two viewer windows: **7 on the same frame (0 ms), 1 one frame late (+41 ms)**.
- **Latency** (frame stamp → drawn in StageLight's window): median 10.6–12.8 ms, jitter (p90 − p10) 11–12 ms, at 23.6–25 fps, 2 frames dropped in 2,600.
- **Program composite:** checked by eye on received frames: a crossfade between scenes, standby fading in over a scene, and the standby card.
- **Operator cost with the photoreal scene live on program:** frame interval mean 10.00 ms, p99 12 ms with the link on, against 10.02–10.04 ms and p99 14–15 ms with it off (no difference beyond noise). Capture 1.2–1.7 ms per frame (max 3 ms), worker encode 3.1–3.3 ms.

The clock offset StageLight measured on one Mac was a few ms (WebKit's clock origin is not exactly Node's). That is why both sides map stamps through the measured offset rather than assuming zero.

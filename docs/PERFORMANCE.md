# Performance and stability

What keeps the wall smooth, what was found in the audit of 27 October 2026, what changed, and what to measure before trusting a machine with a show. Companion to [ARCHITECTURE.md](ARCHITECTURE.md) (how rendering and playback work) and [RECOVERY.md](RECOVERY.md) (what happens when something breaks).

## The shape of the cost

The app is three renderers of one state: the PREVIEW and PROGRAM monitors in the operator window and the audience output window. Each is a WebGL canvas drawing four passes (back plates, 3D world, front layers, overlays), each decodes its own copy of every video it shows (hardware, through the platform player), and the output window is a second webview process. Per frame, the work that matters is:

| Where | Cost | Bound by |
| --- | --- | --- |
| Video decode | one hardware decoder session per warm `<video>` (×3 windows/canvases) | number of warm elements, frame size (≤ 4096 px H.264, ≤ 1 MB per frame through the asset protocol) |
| Frame upload | `texImage2D(video)` once per new video frame (not per rendered frame: three.js uploads on `requestVideoFrameCallback`) | ~0.1 ms on the GPU path; whole milliseconds mean a software copy (heartbeat `upload`) |
| Rendering | four `gl.render` passes, MSAA, fullscreen overlay shaders, optional HDR finish | canvas pixels (rendered at the displayed size, never above the logical wall), number of overlay effects |
| Main-thread JS | frame state, `syncVideo` per video, React work when state changes | number of components; how often the React tree re-renders |
| IPC | program broadcasts operator → output, ≤ 30 Hz | payload size |

## Found and fixed (2026-10-27)

1. **Every program broadcast re-rendered the output's whole scene tree and redrew its text textures.** The `program` message carried the full scene definition every time (on every cue, on every 30 Hz update during a scrub, and in the five-second safety resend), and it arrived in the output as fresh objects. Anything keyed on component identity did its work again: text layers redraw a 3072-pixel-wide canvas glyph by glyph with glow passes and upload two textures; media materials reapply their settings; the React tree under every canvas reconciles. This is the likely source of the unexplained 40–120 ms stalls "every few seconds with no video playing" seen in the output heartbeat on 20 October: five seconds is the resend period. Fix: the scene travels **once per run** and the output keeps the object it has (`packProgram` / `unpackProgram` in `src/core/bus.ts`, cache in `OutputApp`); the canvas content is memoised on the scene object (`SceneContent` in `src/render/SceneCanvas.tsx`); the periodic resend carries live state only (an output missing a scene asks for a full resync). Measured: a live-state broadcast is 1.3 KB against 6.3–7.7 KB with the scene (scene 2.1 of the show, Prologue 5 of the scaffold). Messages are also addressed to the other window (`emitTo`) instead of being serialised back into the sender, which halved the IPC work per message.
2. **A hung output window was never recovered.** The watchdog only reopened the output when the window had gone; a window whose page had frozen (WebKit waiting forever for a video frame, seen the same day) stayed black with the banner saying "reopening". It is now torn down and recreated after 8 s without a heartbeat ([RECOVERY.md](RECOVERY.md), "If the output window hangs").
3. **A lost WebGL context that the browser never restored left the canvas dead.** The canvas now rebuilds itself after 3 s regardless.
4. **A hidden or covered operator window slowed the show down.** Browsers throttle a hidden page's timers to about once a second (Chromium also backgrounds occluded windows), so the 60 Hz loop that fires marker cues, time cues and follow cues, and every delayed action, could land up to a second late while StageMics or StageLight covered the operator window. The service tick and the output heartbeat now run from a Worker (`src/core/steadyTimer.ts`), which is not throttled, and the tick fires overdue delayed actions and follows itself. Verified: the output's heartbeat kept arriving from a hidden browser tab (rAF stopped, fps 0, heartbeat on time).
5. **Shadows on flat plate scenes.** Most of the show is a media plate with video actors on it and nothing 3D, yet the sun cast shadows (a 2048² depth pass per canvas per frame, shadow chunks in every lit shader, a shadow-catcher plane). Shadows are now on only when the scene has a 3D environment or a 3D caster (actor, model, procedural element).
6. **Windows (WebView2) flags.** Both windows now start with `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows` (the operator window behind another app keeps running at full rate) and `--ignore-gpu-blocklist` (the GPU is used even on a driver Chromium would blocklist; software WebGL cannot draw a 3072 × 768 wall at 60 fps anyway). Both windows must share identical arguments (`tauri.conf.json` and `BROWSER_ARGS` in `lib.rs`).

## Checked and already right

- Video decodes in hardware through the platform player (AVFoundation / Media Foundation); frames reach WebGL on the GPU path; a texture is uploaded only when the player has a new frame.
- Drift correction touches the player rarely and in steps (dead band, ±5 % nudge, hard seek only beyond 0.6 s or a wrap), because every seek and rate change stalls the player; looping clips are judged on the loop circle.
- Clip actors keep only the clips that can come next warm (`setWarm`); the rest hold no decoder.
- Files are probed at import and re-encoded into the wall format when they would not play well (frame size, level, keyframe spacing, fast start, frame bytes).
- The renderer asks for the high-performance GPU, renders at the displayed size (never above the logical wall), releases each canvas's context on unmount, and runs the frame loop on `requestAnimationFrame` (a frame-rate cap, when set, is aligned to the display's refresh).
- Rust commands that read or hash files run off the main thread (`spawn_blocking`); the show file and live state are written atomically (temp file, rename).
- Background throttling is disabled for both webviews in the Tauri configuration.

## Where the remaining cost is

- **Three decodes per playing video** (preview when it shows the live scene, program monitor, output) is the price of "one state, many views" without pixel mirroring. Hardware decode on Apple silicon and on a show PC with a dGPU handles several 3072 × 768 streams; the limit is warm decoder count. Keep scenes to a few plates and let clip actors stay cold; split a scene when it needs many videos at once (the Scene 1 day cycle was split for this reason).
- **Shader compilation at TAKE** (about 1–2 s cold for the photoreal environment, less for plates) blocks the output's frame loop, so the outgoing picture freezes for that long on a cut. Use a crossfade or fade into heavy scenes. A possible next step is to pre-mount the preview's scene hidden in the output (costs a WebGL context and warm decoders there) or to compile its programs with `KHR_parallel_shader_compile` before first use.
- **Text layers** redraw with Canvas 2D glow passes (`shadowBlur`), which is slow when it runs; it now runs only when the text or its style really changes. Names and route layers redraw their canvas each frame while animating, bounded at 3072 px wide.
- **Fullscreen overlay effects** (fog, haze, heat, glow, stars, lightning) each cost a fullscreen fragment pass at the output's pixel size; the LED processor takes 1920 × 720, so that is the size that matters.
- **Operator UI** panels that subscribe to the whole `program` (top bar, show mode, preview tools) re-render up to 30 times a second during a scrub. Operator-only cost; the wall is unaffected.
- **Project autosave** writes the whole show file including scene thumbnails about a second after an edit; fine during building, irrelevant during a show.

## Windows show machine

- WebView2 decodes with Media Foundation: H.264 and (with the paid extension) HEVC; transparent clips must be VP9 WebM there (HEVC alpha is the Mac's). See "Media formats" in ARCHITECTURE.md.
- Dante Virtual Soundcard must run in WDM mode for the app to see it ([SHOW_CONTROL.md](SHOW_CONTROL.md)).
- After installing a build, open the output and read the heartbeat: 60 fps, worst frame under 20 ms, `upload` well under 1 ms per frame, no stalls while a video loops. Whole milliseconds of `upload` per frame mean the GPU video path is not in use (driver, blocklist, remote desktop session).

## How to measure

- **Output heartbeat** (Settings → Screens shows fps and worst frame; the agent's `status` → `output.status` has everything): `fps`, `frameMs`, `stalls` (frames over 40 ms with the bus message that preceded them), `upload` (ms spent handing video frames to WebGL and how many), `videoElements` (loaded / total), and per playing video `seeks`, `rateChanges`, `driftAvgMs`, `driftMaxMs`, `dropped`.
- In development the operator window has `window.__slsVideoStats()` and `window.__slsUploadStats()`.
- Expected after the 2026-10-27 changes: no stall on the five-second resend; stalls only at a TAKE (shader compile) or when a plate switches; one video → `videoElements.warm` of 1–4 per canvas.
- Measuring on the Mac has traps: a covered operator window reports `document.hidden` and stops rendering (not the heartbeat any more), and a fullscreen output lives on its own Space. Measure with the app in front or in the browser at the dev port.

## Hung-output recovery, tested on the Mac (2026-10-27)

Output open on the dev Mac (scene 2.1, 60 fps), its WebContent process frozen with `kill -STOP`: the I/O log said "Output window stopped responding" 4 s after the last heartbeat and "not responding (no heartbeat for 11 s): recreating it" at 10 s; a new WebContent process appeared 2 s later and the new window reported 60 fps with the program within a second. Each webview has its own WebContent process, so freezing the output's never touched the operator. (A process frozen with SIGSTOP cannot be terminated by WebKit and lingers until `kill -CONT`; a page hung inside a sync call, the real case, is killable.) To repeat: `ps -axo pid,etime,command | grep WebKit.WebContent` and pick the process that appeared when the output opened.

## Not yet exercised on hardware

- The WebView2 flags on the Windows show machine (both windows must start; check fps and `upload`).

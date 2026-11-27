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

## Found and fixed (2026-11-14)

1. **Hidden videos were seeked about 25 times a second.** A video layer that is not shown yet (or was hidden), a plate that is not the current one and a walker between crossings were parked on "where the clock says the video is", a time that moves on every frame. A paused element chasing a moving time seeks again as soon as the last seek lands (each a decode from the previous keyframe, and for a cut-out a `VideoFrame` copy of 3-4 ms on the main thread), for a picture nobody sees, in every canvas that has the scene (preview, program monitor, output). A scene with three plates and two cut-outs waiting for their cue therefore kept four decoders busier than the one video on screen. This is very likely what made scenes with many videos glitch (the Scene 1 day cycle was split into four scenes for it). Now a hidden video waits, paused, on the frame its next showing starts from (showing a layer or switching to a plate starts it from its top), so it costs nothing while hidden and its first frame is already decoded when its cue fires (`parkedAt` in `src/render/layers/MediaLayers.tsx`). Measured in the browser build with one 6 s clip: 50 completed seeks in 3 s chasing the clock, none parked. The heartbeat's `video` list now also names a paused video that was seeked in the last second (`paused: true`), so this cannot hide again.
2. **The outgoing plate jumped when the plate changed.** Only the current plate's start time is kept in the runtime; the plate fading out fell back to "started at scene time 0", so from the second plate change of a scene on, the outgoing video (and its Ken Burns move) jumped to another position during the crossfade, usually with a hard seek. The view now remembers the start each plate had while it was current.
3. **Cue sounds were decoded when their cue fired, and never released.** A sound file was fetched and decoded the first time its cue ran: a good part of a second for a four-minute song, so its first play started late and out of step with the picture. Every file ever played then stayed decoded for the rest of the session: a four-minute stereo song is about 90 MB of samples, a whole show several gigabytes in the window that draws the wall. The operator now names the sounds that are about to be needed (the live scene's and what is sounding, the next scene's and scenes its cues take, the previewed scene's, the announcements; `soundsToWarm` in `src/engine/operator.ts`, bus message `warm`) and the audio host decodes those ahead and lets the rest go (`warmSounds` in `src/engine/audio.ts`). The heartbeat reports `soundsReady`.
4. **Thunder dropped a frame at the flash.** The synthesised thunder filled 5-7 s of noise sample by sample at the strike, on the main thread of the audio host (the output window): 5-15 ms exactly when the lightning flashes. The noise is now made once, a millisecond at a time, soon after the window starts, and each thunder plays a different stretch of it.
5. **A TAKE waited for files to be opened.** A TAKE with a video transition opened that video to read its length before taking, every time; a TAKE out of running order waited up to 1.5 s for any cue sound whose length was unknown, and a sound whose file is missing cost that at every such TAKE (the failed probe was retried each time, with a 4 s timeout of its own). Lengths are now learned ahead and whenever the show changes (`warmShowMedia`), a TAKE waits at most 150 ms for one still missing, a failed probe is not retried for 30 s, and at most three files are probed at once.
6. **Small per-frame work.** `syncVideo` wrote `muted`, `volume` and `loop` to every video element on every frame (now only on change); every quad of a clip actor scheduled the whole actor again for itself (now once per frame per actor); `videoAudioFade` and the cut-out shake allocated arrays per video per frame (now nothing when the scene has no sound events or shakes). Still images are decoded off the main thread before their texture is handed over (`HTMLImageElement.decode()`), instead of during the first frame that draws them. The upload counters now include alpha video (the `VideoFrame` path), which they missed.

7. **Every seek re-sent and re-rendered the scene.** A seek (a scrub step, ±1 s, "go back to this cue") rebuilds the run from its scene, and each rebuild made a fresh deep copy of the scene definition: the memoised tree under the canvas re-rendered, text textures were redrawn, and on a live seek the whole scene went to the output again (the stall of 2026-10-27 no. 1, once per seek). A scene object now has one runtime copy, shared by every run of it (`runtimeScene` in `src/core/runtime.ts`); checked in the app: the scene object is the same across seeks.
8. **Every edit sent the whole asset library to the output.** Each edit hands out a fresh copy of the show (`update` in `store/project.ts`), so the library and the output settings changed identity on every edit, a slider drag in Build included. That rebuilt the stage context of both operator canvases and sent a `project` message (114 KB for the current show) to the output, unthrottled, where the live scene's tree re-rendered each time. The operator now passes the library and the settings on only when their contents differ, and the message is throttled to five a second.
9. **Shaders of hidden things compiled on their cue.** three compiles a material the first time its object is drawn and skips hidden objects, so the first rain, lightning bolt, fog, title or cut-out of a run compiled on the frame its cue fired (and again in every run: each TAKE is a new GL context). Everything in the scene, hidden or not, is now compiled when the canvas mounts, while the TAKE's transition covers it (`gl.compile` in the compositor, once on the first frame and once 1.5 s later for layers that mount late).
10. **The output watchdog could tear down a healthy output.** After a stall of the operator window (or a step of the computer's clock) the watchdog ran before the output's queued heartbeats and saw eight silent seconds. It now skips a round after a late tick and checks again for a heartbeat after asking whether the window exists. Reopening the output also took the keyboard from the operator window on a Mac (G did nothing until a click); focus is handed back.
11. **A transition ended on a page timer.** `finishTransition` ran from `setTimeout`, which a covered window may run late; until it ran, a TAKE from the console was refused. The 60 Hz tick (worker-driven) now ends an overdue transition too.

12. **Native commands that blocked the main thread.** A non-async Tauri command runs on the main thread, which also carries every bus message and MIDI/OSC event. `osc_send` resolved its host name there on every send (a `.local` name that is gone blocked for the resolver's timeout on each 5 s ping) and now only queues the message for one sender thread, which keeps the order, reuses its sockets and caches addresses; errors found after queuing arrive as `sls://osc-error` and go to the I/O log. `system_fonts` read every font file (835 MB, 1.2 s on the dev Mac) the first time a font picker opened and now runs off the main thread, reads only name tables and caches. `audio_outputs` (polled every 3 s) runs off the main thread. MIDI clock, time code and active sensing are dropped before they reach the page.
13. **Operator window renders.** Show-mode panels that selected the whole live state (`Monitors`, `TakeBar`, `CueList`, `TopBar`, `FramingBar`) re-rendered on every fader step; they now select the fields they read. The top bar's clock, the audio-host check and the transport's 120 ms tick no longer re-render their parents while nothing moves. The asset picker scanned the show once per mounted picker on every edit (about 50 ms per slider step on a ten-clip actor) and now does it once; the Media tab shows cached thumbnails instead of a `<video>` per card.
14. **Effects.** Lightning kept no bolt material between strikes, so every strike compiled its shader and built its geometry on the flash frame (now a pool, same bolt shapes). Fog shades only where fog can be. Per-frame colour parsing and small allocations in the frame state, lights, overlays and the stone throw are gone. A text canvas that changed size after its first upload could never update its texture (a blank or stale title): the texture is now freed on resize.

## Freeze, then jump (2026-11-26)

Reported in the Prologue: the picture stops for a moment and carries on further along, as the lion comes out and in the opening Book. Measured with `scripts/playback-bench` (a `WKWebView` serving the files like Tauri's `asset://` protocol, and headless Chrome) on the dev Mac, with the Prologue's own files (H.264 High 3072 × 768, 24 fps, 10-25 Mbit/s).

**What it is.** A video on the wall is decoded by the platform player (in hardware) and drawn by WebGL: the page's main thread uploads each new frame to a texture and draws. When the main thread is busy, nothing is drawn, the player plays on underneath, and the next frame drawn is further along. With the main thread held 300 ms every 2 s, WebKit showed 167 of 192 frames with four 326 ms gaps and four media jumps, Chromium 158 of 192 with 347 ms gaps: the same picture in both engines. One video alone plays clean in both (191 of 192 frames, worst gap 66-68 ms, `asset://` and HTTP alike), so the decoder, the files and the asset protocol are not the cause. Whatever holds the main thread is.

**What held it.**

| What | WebKit (Mac app) | Chromium (Electron, WebView2) |
| --- | --- | --- |
| Compile + link 30 programs, then read their status (what the first draw after `gl.compile` did) | 145-150 ms; 1.6 s on a first run | 1.47 s on a first run |
| The same 30 programs again in a **new context** (every TAKE is one) | 140-145 ms again: no program cache across contexts | 45 ms (program cache) |
| The same with `KHR_parallel_shader_compile`, not waited on | ~1 ms on the main thread (linking 320-620 ms in the background) | 0 ms (717 ms in the background) |
| A TAKE in the app, beyond the shaders (dev build, profiled) | | React mounting the scene 60-110 ms, info-log reads 15 ms, first texture uploads 25 ms, context 14 ms |
| Starting a parked clip (play to moving), visible page | ~20-50 ms behind after the start | 2-22 ms |
| Seek of a playing clip (keyframe every ½ s) | 21-31 ms to `seeked` | |
| Decoding a 40 MB WAV, tearing down three players, losing a context, uploading a 3072 × 768 image | each under 15 ms | each under 15 ms |

So at every TAKE the window that shows the scene stood still for a few hundred milliseconds (the new scene's tree, then every shader compiled and waited for on the first frame), and with it every other canvas of that window, the scene going out included, while their videos ran on: a freeze and a jump on the outgoing picture during a crossfade, in the operator's monitors and on the wall. In headless Chrome with the show loaded, the TAKE of Prologue 0 then Prologue 2 gave frame gaps of 233, 67 and 217 ms.

**Changed.**

1. **Shaders compile off the main thread** (`compileAsync`, `KHR_parallel_shader_compile`), and a new canvas draws nothing until they are linked (it is clear, so the slot under it shows; 2.5 s at most). three's first-use info-log reads are off outside development (`checkShaderErrors`). See the compositor in `src/render/SceneCanvas.tsx`.
2. **A new scene is built in slices** (`Sliced`: the content mounts in a React transition, a few milliseconds per frame), not in one task.
   With 1 and 2, the same two TAKEs in headless Chrome: **no frame over 40 ms**. The scene draws as before (checked on the Lion Rock plate and the lion on the rock).
3. **Scenes nobody can see are not drawn**: a program slot at opacity 0, and every slot while an opaque video transition with a picture covers the wall (`unseenSlots` in `src/render/frame.ts`). In the 10 s transition into the lion scene that is about 300 frames of two whole scenes the window no longer draws behind the video. A canvas not drawn keeps its last frame; its videos stay in sync.
4. **A clip that starts is left to get going** for a second before its drift is judged (`START_GRACE` in `src/render/layers/video.ts`). A clip with sound (the lion has sound on the wall) was hard-seeked as soon as it was 0.25 s off the clock, with no grace after a start, so any start-up lag or stall past that seeked it within frames of coming on. The sound limit is now 0.45 s, and a seek of a playing video aims ahead by what seeks take in that window (`seekLead`, learned from `seeked`), so it lands on the clock instead of behind it and is not followed by another. Measured in headless Chrome over the Prologue: no hard seek of the lion clips (they start 37-56 ms behind and settle).
5. **The transition video is no longer chased.** It was seeked whenever it was a quarter second off the clock, which it is at its start (opened at the TAKE, it needs a moment to load). It is drawn by the browser itself, so it plays through any stall of the page: now it is caught up only when half a second off, at most every 1.5 s.
6. **The playback log** (`src/engine/playbackLog.ts`, MCP `playback_log`): every output frame over 40 ms, every hard seek of a playing video (file, drift, start-up lag) and every hold-up of the operator window over 100 ms, with the live scene and scene time, kept in the operator. Clear it before a run-through, read it after: the next hitch names its scene, its second and its cause. The output heartbeat also reports `startLagMs`, `playingSeeks` per video and `seekLeadMs`.

**Measured in the Mac app (release build), and what is left.** The TAKE holds are gone, but the lion scene still froze for 3-5 s at its clip hand-offs. `sample` of the app's processes during the scene shows the WebKit GPU process's main thread stuck 4-5 s in `MediaPlayerPrivateAVFoundation::rateChanged` → `-[AVPlayerItem currentTime]` (waiting on a MediaToolbox lock), while the operator page waits on it in `HTMLMediaElement::play` → `AudioSession::tryToSetActive` and in WebGL's `prepareForDisplay`. The holds start when a clip's player is loaded (`src` + `load`), switched (one clip paused, the next played) or released. The clips use the same codec as clips that play clean (H.264 High 5.0, 3072 × 768, 24 fps), and muting the lion changed nothing (`probe4.html`, `probe5.html`). While the operator is held, its cues reach the output late, so the output starts the next clip late and seeks: the visible skip. Every `<video>` on the Mac is an AVPlayer in the one GPU process both windows share, so this is inside WebKit, not in the app. Chromium (WebView2 on Windows, Electron) has its own media pipeline and no AVPlayer. Fix under way: decode wall clips with WebCodecs in a worker instead of `<video>`.

**WebCodecs, measured in the bench.** `probe6.html` does `probe5.html`'s lion hand-offs (warm, start with sound, stop, release) with the 1.2 clips decoded by `VideoDecoder` in a worker: an MP4 demuxer reads the file with range requests, each frame is the one for the page's clock, uploaded to WebGL from its `VideoFrame`, and the clip's sound is its AAC track decoded with `decodeAudioData` and played through Web Audio. No `<video>` on the page. macOS 26.3, WebKit 21623; headless Chrome 158.

| | `<video>` (`probe5`) | WebCodecs (`probe6`) |
| --- | --- | --- |
| Holds over 50 ms, three webviews in one GPU process (operator + output) | 55-76 ms at each hand-off | none; 553 of 553 frames on time in each view |
| GPU process main thread in `MediaPlayerPrivateAVFoundation::rateChanged` → `-[AVPlayerItem currentTime]` (`sample`, 27 s) | 148 ms | 0 (idle the whole run; decoding is VideoToolbox through `LibWebRTCCodecsProxy`) |
| Page waits in `HTMLMediaElement::play` / `AudioSession::tryToSetActive` | yes | none |
| Main thread held 300 ms every 2 s | (freeze and jump, above) | the worker decodes on; after each hold the right frame, no seek, no late frame |
| Memory, one window, median / peak footprint | GPU 256 / 412 MB, page 136 / 179 MB | GPU 326 / 457 MB, page 195 / 238 MB |

The bench reproduces the AVPlayer wait in milliseconds, not the app's seconds; what matters is that WebCodecs never enters that code. `asset://` (answers of at most 1000 KiB, like Tauri) and HTTP measure the same. Chromium plays the same run with no clip hold.

What the decoders do with these files (`wcdebug.html`; H.264 High 5.0, 3072 × 768, 24 fps, B-frames, closed GOPs with a keyframe every 0.5 s, `moov` first):

| | WebKit | Chromium |
| --- | --- | --- |
| Frames taken in before the first comes out | 11 (it holds a full reorder buffer) | 2 |
| One GOP (12 frames) fed and flushed: the cost of a seek | 17-24 ms (27 ms average, 44 ms worst with three windows decoding) | 11-16 ms |
| Whole file decoded as fast as it goes | 787 fps (33 × real time) | 1166 fps |
| Upload of a `VideoFrame` to a texture | 0.24 ms average, 5 ms worst | 0.08 ms |
| `decodeAudioData` of a 12 s AAC track (as ADTS) | 7-9 ms | 17-18 ms |

So the decoder is fed one whole GOP at a time and flushed: the timing is the same in both engines, and a seek is the same operation as playing on. This needs closed GOPs: x264, which the import optimiser uses where it can, writes them by default, and the 1.2 clips have them; a file with open GOPs (pictures shown before their keyframe) has to be found when it is opened and played another way. Two things shaped the worker: WebKit's 11-frame hold (a feeder that waits for frames before feeding more never gets one), and WebKit's worker `fetch` going through the page's main thread (reads waited up to 250 ms while the page was held), so the worker reads two GOPs ahead. It holds at most 15 decoded frames per clip (about 3.5 MB each), the page at most 4.

**WebCodecs in the app** (`output.videoEngine`, ARCHITECTURE.md "Wall video on WebCodecs"). Measured 2026-11-26 in a release build of the Mac app on a copy of the show (its own data folder, lights and sound links off), 1.2 taken on program and left to run its cues (climb at 9 s, pace loop, lunge at the loop's end, then 1.3), with `sample` of that app's WebKit GPU process and both pages for 46 s. The same run on the platform player, same build, for comparison:

| Lion on the rock (1.2), release build | `<video>` (`videoEngine: element`) | WebCodecs (`auto` on the Mac) |
| --- | --- | --- |
| Operator holds (`playback_log`) | 4.8 s and 4.2 s, at the lunge | none |
| Output | a 4.1 s stall; the lunge hard-seeked 4.8 s off the clock | 60 fps throughout; one 80 ms frame at the TAKE; no seeks |
| Frames shown | climb 100 in 6 s, gaps of whole seconds | every frame: climb 145/145, pace 289 (one loop, seamless wrap), lunge 143/143, transition 238/241 |
| Worst lag of the frame on screen | 159-183 ms | one frame (≤ 38 ms) |
| GPU process in `MediaPlayerPrivateAVFoundation::rateChanged` → `-[AVPlayerItem currentTime]` | ~8 s of samples | 0 (no AVFoundation player frame at all) |
| Pages in `HTMLMediaElement::play` / `AudioSession` | (as before) | none; WebGL's per-frame `prepareForDisplay` only |
| Peak footprint, GPU / operator / output | 731 / 671 / 1067 MB | 1021 / 741 / 970 MB |

The clip's sound played through Web Audio throughout. The GPU process holds more with WebCodecs: each warm clip keeps its first GOP decoded (12 frames at 3072 × 768) in every window that shows the scene, and the operator's monitors decode the same clips again at full size. The rest of the Prologue (1.1, 1.3, 1.4 with its GO cues) played at 60 fps with no seek beyond one decoder restart at the start of 1.1 (one frame, 38 ms, right after a 101 ms frame at the TAKE). Headless Chrome (Chromium, `webcodecs`) ran 1.1-1.7 the same way. Two things found on the way: a parked looping clip that came up threw away the GOP it had decoded ahead (its loop span arrives only when it plays), and a clip that came up a little after its stamped start counted as a seek; both now keep their frames.

**Still in the way of a perfect picture.**

- Anything else that holds the page's main thread still freezes WebGL video: the design has one thread for React, the operator's messages and drawing. In a development build React is several times slower than in a release: rehearse on a release build.
- First texture uploads (15 ms per 3072 × 768 image in Chromium, 4-5 ms in WebKit) still land on the frame a scene first draws; `createImageBitmap` uploads would take most of that off.
- Every TAKE is a new WebGL context, so programs and textures are made again each time (WebKit keeps no program cache). One long-lived context per window would make them once per show.
- The operator window decodes the live scene again for its program monitor (and the previewed scene) at full size, in the same GPU process as the output, for monitors 563 px wide: low-resolution proxies for the monitors would take most of that load off.

**Native app or Electron?** Electron is Chromium, and on Windows Tauri already runs on Chromium (WebView2): it would change only the Mac side. There Chromium starts clips faster and keeps compiled programs between contexts, but it freezes and jumps on a busy main thread exactly as WebKit does, so it is not the fix. Moving more into Rust does not help either while the picture is drawn in the webview. What OBS, mpv and media servers do differently is draw the output on a thread of its own, fed by decoders on their own threads, so nothing the interface does can hold a frame. The web equivalent is to draw the wall in a Worker (`OffscreenCanvas`, with WebCodecs decoding the files off the main thread); the native one is a Rust output (wgpu, VideoToolbox / Media Foundation) with the webview kept for the operator interface, which means rewriting the renderer. Either is a project of its own; measure the release build with the changes above first.

## Checked and already right

- Video decodes in hardware through the platform player (AVFoundation / Media Foundation); frames reach WebGL on the GPU path; a texture is uploaded only when the player has a new frame.
- Drift correction touches the player rarely and in steps (dead band, ±5 % nudge, hard seek only beyond 0.6 s or a wrap), because every seek and rate change stalls the player; looping clips are judged on the loop circle.
- Clip actors keep only the clips that can come next warm (`setWarm`); the rest hold no decoder.
- Files are probed at import and re-encoded into the wall format when they would not play well (frame size, level, keyframe spacing, fast start, frame bytes).
- The renderer asks for the high-performance GPU, renders at the displayed size (never above the logical wall), releases each canvas's context on unmount, and runs the frame loop on `requestAnimationFrame` (a frame-rate cap, when set, is aligned to the display's refresh).
- Rust commands that read or hash files run off the main thread (`spawn_blocking`); the show file and live state are written atomically (temp file, rename).
- Background throttling is disabled for both webviews in the Tauri configuration.

## Where the remaining cost is

- **Transparent video that is not alpha-packed.** On the Mac a cut-out (HEVC with alpha) reaches WebGL through a `VideoFrame` taken on the main thread, 3-4 ms per frame for a 3072 × 768 clip, in each canvas that shows it (three for the live scene); an opaque video costs ~0.1 ms. Packing the clip (`asset_optimise { pack: true }`, "Alpha-packed video" below) puts it on the opaque path. The show's cut-outs are not converted yet.
- **Three decodes per playing video** (preview when it shows the live scene, program monitor, output) is the price of "one state, many views" without pixel mirroring. Hardware decode on Apple silicon and on a show PC with a dGPU handles several 3072 × 768 streams; the limit is warm decoder count. Keep scenes to a few plates and let clip actors stay cold; split a scene when it needs many videos at once (the Scene 1 day cycle was split for this reason).
- **Shader compilation at TAKE** (about 1–2 s cold for the photoreal environment, less for plates) now runs in the background (`KHR_parallel_shader_compile`, since 2026-11-26) and the new canvas draws once it is done, so it no longer holds the window; a heavy scene simply appears that much later on a cut. Use a crossfade or fade into heavy scenes.
- **Text layers** redraw with Canvas 2D glow passes (`shadowBlur`), which is slow when it runs; it now runs only when the text or its style really changes. Names and route layers redraw their canvas each frame while animating, bounded at 3072 px wide.
- **Fullscreen overlay effects** (fog, haze, heat, glow, stars, lightning) each cost a fullscreen fragment pass at the output's pixel size; the LED processor takes 1920 × 720, so that is the size that matters.
- **Operator UI** panels that subscribe to the whole `program` (top bar, show mode, preview tools) re-render up to 30 times a second during a scrub. Operator-only cost; the wall is unaffected.
- **Project autosave** writes the whole show file including scene thumbnails about a second after an edit; fine during building, irrelevant during a show.

## Alpha-packed video (2026-11-15)

A transparent clip can be stored as one opaque H.264 file at twice the picture's height, colour over matte, and put together in the shader (`Asset.alphaPacked`; format and conversion in ARCHITECTURE.md, "Media formats"). It uploads like any opaque video, so the Mac's per-frame `VideoFrame` copy goes, and one file serves Mac and Windows.

Measured in the browser build (headless Chrome on the dev server, Apple M5 Max, ANGLE Metal, one canvas, `window.__slsUploadStats()` over 8 s of playback, clips made from the demo lion cut-out):

| Clip | Upload per frame |
| --- | --- |
| VP9-alpha WebM, 3072 × 768 | 0.14-0.15 ms |
| Alpha-packed H.264, 3072 × 1536 | 0.08-0.10 ms |
| VP9-alpha WebM, 992 × 432 | 0.05 ms |
| Alpha-packed H.264, 992 × 864 | 0.08 ms |

What this shows and what it does not: Chromium keeps a `<video>`'s alpha, so it has no `VideoFrame` path and both rows are GPU uploads there; the numbers prove only that a wall-size packed frame stays on the fast path. The 3-4 ms `VideoFrame` copy exists only in WebKit (the Mac app) and was not re-measured: outside the desktop app there is no WebKit to run. The packed path in the Mac app is the plain H.264 upload, measured there at ~0.1 ms for a 3072 × 768 plate; a 3072 × 1536 packed frame in the app is still to be measured (output heartbeat `upload`, or `window.__slsUploadStats()` in a development build).

Picture check, same build: the demo cut-out played packed and unpacked in the same place over the plate and over white. Inside the subject the two match (mean difference 0.1 of 255, PSNR 47-48 dB, SSIM 0.999). They differ along the one-pixel edge of the matte, where the packed clip is brighter (up to 60 of 255 on bright fur): the unpacked clip's edge is mixed with the black under its clear pixels when the layer is scaled, a thin dark rim the packed clip does not have.

## Windows show machine

- WebView2 decodes with Media Foundation: H.264 and (with the paid extension) HEVC; transparent clips must be VP9 WebM there (HEVC alpha is the Mac's) or alpha-packed H.264, which plays on both. See "Media formats" in ARCHITECTURE.md.
- Dante Virtual Soundcard must run in WDM mode for the app to see it ([SHOW_CONTROL.md](SHOW_CONTROL.md)).
- After installing a build, open the output and read the heartbeat: 60 fps, worst frame under 20 ms, `upload` well under 1 ms per frame, no stalls while a video loops. Whole milliseconds of `upload` per frame mean the GPU video path is not in use (driver, blocklist, remote desktop session).

## How to measure

- **Output heartbeat** (Settings → Screens shows fps and worst frame; the agent's `status` → `output.status` has everything): `fps`, `frameMs`, `stalls` (frames over 40 ms with the bus message that preceded them), `upload` (ms spent handing video frames to WebGL and how many), `videoElements` (loaded / total), per playing video `seeks`, `playingSeeks`, `startLagMs`, `rateChanges`, `driftAvgMs`, `driftMaxMs`, `dropped`, and `seekLeadMs`.
- **Playback log** (MCP `playback_log`): every stall of the output, hard seek of a playing video and hold-up of the operator window since it was cleared, with scene and scene time. Clear it before a run-through, read it after.
- In development the operator window has `window.__slsVideoStats()` and `window.__slsUploadStats()`.
- Expected after the 2026-10-27 changes: no stall on the five-second resend; stalls only at a TAKE (shader compile) or when a plate switches; one video → `videoElements.warm` of 1–4 per canvas.
- Measuring on the Mac has traps: a covered operator window reports `document.hidden` and stops rendering (not the heartbeat any more), and a fullscreen output lives on its own Space. Measure with the app in front or in the browser at the dev port.

## Hung-output recovery, tested on the Mac (2026-10-27)

Output open on the dev Mac (scene 2.1, 60 fps), its WebContent process frozen with `kill -STOP`: the I/O log said "Output window stopped responding" 4 s after the last heartbeat and "not responding (no heartbeat for 11 s): recreating it" at 10 s; a new WebContent process appeared 2 s later and the new window reported 60 fps with the program within a second. Each webview has its own WebContent process, so freezing the output's never touched the operator. (A process frozen with SIGSTOP cannot be terminated by WebKit and lingers until `kill -CONT`; a page hung inside a sync call, the real case, is killable.) To repeat: `ps -axo pid,etime,command | grep WebKit.WebContent` and pick the process that appeared when the output opened.

## Not yet exercised on hardware

- The WebView2 flags on the Windows show machine (both windows must start; check fps and `upload`).

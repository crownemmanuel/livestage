# Playback bench

Measures how a webview plays the wall's videos, outside the app: the same engine (WebKit through a `WKWebView`
on the Mac, Chromium through headless Chrome, which is also what Electron and WebView2 run), the same files, the same
upload to WebGL. Used for the measurements in [docs/PERFORMANCE.md](../../docs/PERFORMANCE.md) (2026-11-26).

The display must be on and the screen unlocked for anything that draws (`bench.html`): a hidden WebKit page stops
drawing and throttles its timers, and the numbers mean nothing. `probe.html` reads synchronous costs, which hold
either way.

```bash
cd scripts/playback-bench
python3 serve.py 8765 &                       # loopback server with byte ranges; /f/<absolute path> serves a file
swiftc -O -o /tmp/bench bench.swift -framework AppKit -framework WebKit
```

Any free port works (the WebKit bench answers `asset://` with the page's own origin).

Pages (query parameters; `src`, `v1`.., `img`, `wav`, `v` are URL-encoded absolute paths):

- `bench.html?src=<file>&via=asset|http&dur=8` plays a video for `dur` seconds and counts frames shown, gaps over
  100 ms, media jumps (`skips`), start-up time and upload time. `block=300&every=2000` holds the main thread that
  long that often; `seekAt=3` seeks +2 s while playing; `chase=1` applies a seek-when-off-by-0.25-s rule.
  `src=a,b,c` with `bench <url> 3` runs three webviews at once (one GPU process, like the operator and output).
- `probe.html?via=…&v1=&v2=&v3=&img=&wav=&mp3=` main-thread cost of what a TAKE does: loading and starting
  videos, a WebGL context, compiling 30 programs (blocking and with `KHR_parallel_shader_compile`), the same
  programs again in a new context, image and video uploads, sound decoding, tearing down.
- `probe4.html?via=http&v=&v2=` does starting a video, or turning its sound on, hold the page (muted, with sound,
  unmuted while playing; drawn into WebGL)? `probe5.html?climb=&pace=&lunge=&music=1&mutedAll=1` the lion's clip
  hand-offs as the wall does them (warm, start with sound, stop, cold).
- `probe6.html?via=http|asset&climb=&pace=&lunge=&music=1` probe5's hand-offs with the clips decoded by WebCodecs
  in a worker (`wc/worker.js`, demuxer `wc/mp4.js`) instead of `<video>`: frame for the page's clock uploaded
  from the `VideoFrame`, sound decoded with `decodeAudioData` and played through Web Audio. Reports holds, frames
  shown and late per clip, upload times and the worker's GOP decode times. `hold=300&every=2000` blocks the main
  thread to show the worker decoding on. `sound=0` leaves the sound out.
- `wcdebug.html?v=` the engine's `VideoDecoder` on one file: frames out after each chunk (how many it holds before
  the first comes out), one GOP fed and flushed (a seek), the whole file as fast as it decodes.
- `probe2.html?v=` cost of play, pause, seeks and rate changes on one player. `probe3.html?v=` start-up lag of a
  parked video, muted and with sound (at volume 0.001).

`via=asset` serves the file through a custom URL scheme that answers like Tauri's `asset://` protocol (one range
response of at most 1000 KiB); `via=http` through the loopback server.

```bash
/tmp/bench "http://127.0.0.1:8765/bench.html?src=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' /path/to/clip.mp4)&via=asset&dur=8" 1
./chrome.sh "http://127.0.0.1:8765/probe.html?via=http&v1=…" 90      # Chromium; prints what the page reported
```

The WebKit bench opens a small window at the bottom left of the screen for each run.

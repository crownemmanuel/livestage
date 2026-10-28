# Agent control (MCP)

An AI agent (Claude Code, Claude Desktop, or any MCP client) can drive the running app: look at it, run the show, and build scenes, cues and settings. It goes through the same stores and engine the operator uses, so everything it does shows up in the UI and saves like an operator edit.

```
agent ⇄ stdio (MCP) ⇄ mcp/server.ts ⇄ WebSocket 127.0.0.1:1431 ⇄ operator window (src/agent/bridge.ts)
```

## Set up

The MCP server is registered for Claude Code in [.mcp.json](../.mcp.json) (`node mcp/server.ts`, Node 22.18+ for TypeScript type stripping). Claude Code asks once to allow it. For another client, use:

```json
{ "command": "node", "args": ["/absolute/path/to/livestage/mcp/server.ts"] }
```

Then run the app as usual (`pnpm tauri dev`, `pnpm dev` + http://localhost:1430, or the installed build). The operator window connects to the bridge by itself within a few seconds, and keeps retrying while no agent is running.

- **Agent badge** (top bar, next to the save tick): shows while an agent is connected; its tooltip says how many changes it made and the last one. Click it to disconnect and switch agent control off on this machine; click the crossed-out badge to allow it again.
- Every change an agent makes is written to the I/O log as `Agent → <tool>` (Settings → Monitor).
- Several agent sessions can run at once: the first MCP server hosts the bridge, later ones relay through it and take over if it exits.
- Desktop app and a browser tab both open? Both connect. Agents drive the desktop app unless told otherwise (`connections` tool, or `SLS_AGENT_APP=browser`).
- Port: `SLS_AGENT_PORT` for the MCP server, `localStorage["sls.agentPort"]` or `VITE_SLS_AGENT_PORT` (build time) in the app. A second test instance on its own port never takes commands meant for the show machine.

### Safety

- The bridge listens on 127.0.0.1 only. App connections must come from the dev server or the desktop shell origin; a second MCP server proves itself with a token in `~/.salvation-live/agent-1431.token`, which web pages cannot read.
- Tools that reach the audience, the lighting console or another machine are marked **[LIVE]**. The server's instructions tell agents to use them during a show only when the operator asks.
- `eval` (run JavaScript in the operator window) only works in development builds.
- The preview never reaches the wall; edits change the show file and the preview, and the live scene keeps its own copy until `update_live_scene` or the next TAKE.

## Tools

Scene, component, cue, group, timer and asset arguments accept ids or names; scenes also take their code (`1.2`) or number.

| Tool | What it does |
| --- | --- |
| **Look** | |
| `status` | Overview: mode, selection, the live scene (time, next cue, layers, effects, clips), wall state, preview, output window, timers, MIDI/OSC, errors, bridge |
| `list_scenes` | Running order with codes, groups, counts, selected/live flags |
| `get_scene` | One scene as stored |
| `get_runtime` | Playback state of preview or program |
| `timeline` | A scene as the Build timeline lays it out: cue start times (GO cues at planned holds) and every track's items in scene seconds |
| `list_assets` | Media library |
| `get` | Any value by path (`project/…`, `show/…`, `io/…`, `ui/…`) |
| `schema` | Live reference: component defaults, cue action types, effect parameters, transitions, I/O messages (with every StageLight and StageMics shape, and the OSC each StageLight one becomes) |
| `screenshot` | Picture of the preview or program monitor (the window must be drawing) |
| `io_log` | MIDI/OSC/agent log |
| `stagemics_status` | StageMics (owns the dLive): link on, address, answering, its version and desk connection, active cue and mic states. Sends nothing |
| `stagelight_status` | StageLight link: on, address, mirror, reach (answering / sent / error / off), its hello (version, output armed, running page and cue), last GO announcement, last refusal, catalog state and size. Sends nothing |
| `stagelight_catalog` | StageLight's pages with cue lists (entry IDs, names, auto-follow), named triggers and library cues, as last read (kept in the show file); `refresh` re-reads it. StageLight messages given to any tool may use names or numbers: they are stored as these IDs with a `label` |
| `list_store_actions` | Raw store actions for `call_action` |
| `connections` | Connected app windows; choose desktop or browser |
| **Run the show** | |
| `select_scene` | Load a scene in the preview |
| `take` [LIVE] | TAKE a scene live, optional transition |
| `cue` | GO (also fires a next cue that would fire by itself, early), fire (a cue's Fire now button: rewinds the list to that cue), set pointer, and back, skip, repeat (no buttons on screen; agents and MIDI/OSC only), on preview or program. On program, GO or fire during a video transition ends the transition so the cue shows at once |
| `preview_step` | Preview the scene as it looks after N cues |
| `preview_time` | Preview the scene as it looks N seconds into its Build timeline (GO cues at their planned holds), held on that frame |
| `preview_run` | Run the show in the preview from a scene's TAKE: GO cues fire at their planned holds, takes go on to the next scene; `on: false` stops it |
| `run_action` | Run any cue action now |
| `transport` [LIVE] | Hold, resume, seek or nudge the scene's video in its own seconds; the live wall scrubs only while held ([VIDEO_TRANSPORT.md](VIDEO_TRANSPORT.md)) |
| `seek`, `freeze` [LIVE] | Scene clock: jump (program only while held), freeze / resume |
| `cancel_pending`, `restart_preview` | Pending actions, restart the preview |
| `blackout`, `standby` [LIVE] | Wall-wide controls |
| `timer`, `timer_overlay`, `announce` [LIVE] | Show timers, on-screen clock, front-of-house announcements |
| `mixer` [LIVE] | Live mixer: list what is sounding on the wall (cue sounds, video with sound) and trim one source's volume, or reset all. The trims are the show's sound levels, saved in the show file (`project/mix`) |
| `music_at` | The cue sounds that would be playing just before a cue fires (or as a scene is taken) had the show run in sequence, and how far into each file: what the music chase starts on a jump. Shows the chase setting (`project/chaseMusic`), the learned GO timings (`project/cueTimings`) and what the live wall plays now |
| `audio_output` [LIVE] | List this computer's audio outputs (native CoreAudio devices on the Mac; every Windows playback device through the webview; Dante flagged in both; on Windows `danteNotListed` says when Dante Virtual Soundcard needs switching to WDM mode) and route all of the app's sound to one, or back to the computer default |
| `next_transition` | Transition for the next TAKE |
| `io_send` [LIVE] | Send MIDI / OSC / MSC / Hog 4 (lighting items by name; `master` raises a fader before a GO) or StageMics commands (`{type: "sound", op: "mic", who: "Joseph", live: false}` …; StageMics acts on the dLive). Returns the exact OSC sent for StageMics and StageLight |
| `stagelight_send` [LIVE] | Send one StageLight command now (GO page or cue, named trigger, back, stop, clear, blackout, master, library cue, LED wall) and report the OSC sent and StageLight's answer: a refusal with its reason, or its GO announcement |
| `io_inject` | Simulate an incoming MIDI/OSC message to test triggers |
| `output_window` [LIVE] | Open, close or check the audience output |
| `ui` | Show/Build mode, selected component, isolate (solo), hidden components |
| `update_live_scene` [LIVE] | Push edits onto the running live scene |
| **Build** | |
| `scene_create`, `scene_update`, `scene_duplicate`, `scene_delete`, `scene_move`, `scene_group` | Scenes and running order |
| `group_update` | Rename, recolour, flow, move or dissolve a group |
| `component_add`, `component_update`, `component_remove`, `component_arrange` | Components (built from the app's defaults, deep-merged edits) |
| `cue_add`, `cue_update`, `cue_remove`, `cue_move` | Cues, with any actions and fire mode. A StageLight action is `{type: "send", message: {type: "stagelight", op: "goCue", page: "Act 1", cue: "4"}}`; StageLight messages are checked (a trigger needs a name, GO cue a page) and tidied. To edit or remove one action, `get_scene`, change the list and `cue_update` it back |
| `markers` | Time markers by video name: list every video's markers (and what each does), add or change one (`{name, at, message}` or `cue` to run instead), remove one. Markers send from PROGRAM only, once per pass, never while scrubbing |
| `stagelight_link` | Set up the StageLight link (on, IP, port, mirror TAKE / GO as triggers `scene.<code>` / `cue.<code>.<n>`), ping it and return `stagelight_status` |
| `upsert`, `remove` | Any list by path: camera shots, media markers, clips, timers, announcements, triggers, OSC targets, Hog items, presets (StageLight messages in markers are checked as in `cue_add`) |
| `patch` | Set / merge / insert / remove anything in the show file in one change; returns the old values |
| `asset_import`, `asset_remove` | Library media (local file or URL). An imported video is probed and, when the wall would not play it well, re-encoded into the wall format on the way in (`optimise: false` to only report) |
| `asset_check` | What a video is (codec, size, frame rate, keyframe gap, bit rate, audio) and whether the wall plays it well: problems with severity and whether optimising fixes them; the encoder tools on this machine |
| `asset_optimise` | Re-encode a library video into the wall format (H.264, fitted to the wall, keyframe every ½ s, fast start); `force` when no problem was found |
| `asset_reveal` | Open the operator's Finder / Explorer with an asset's file selected (desktop app only) |
| `output_settings` | Wall size, scaling, standby card, timer style |
| `project` | Save, export/import a show file, reset to the demo, rename. Import needs `levels` (`local` or `incoming`) when the file's sound levels differ from this computer's |
| `package_export` | Write a show package (show file, versioned manifest, every media file) for another computer; desktop app ([SHOW_PACKAGE.md](SHOW_PACKAGE.md)) |
| `package_import` | Take in a show package: `dryRun` for the plan, per-conflict `choices` (`incoming`, `local`, `media`, `both`) or `resolve`; the `mix` conflict (sound levels set here that differ from the package's) needs a choice in replace mode too; refuses while live unless `allowLive` |
| `cloud_status` | Cloud sync (Firebase): set up, account, local and cloud versions |
| `cloud_push` [LIVE] | Push this show as the next cloud version (refused when the cloud is ahead, unless `force`) |
| `cloud_pull` | Take in the cloud's latest version, like `package_import` |
| `update_check` | This app's version and whether a newer release is published on GitHub, with its notes ([RELEASES.md](RELEASES.md)) |
| `update_install` [LIVE] | Only when the operator asks: download the update, install it and restart the app (the output window closes); refused while a scene is live and in development builds |
| `call_action` | Call any store action by name (escape hatch) |
| `eval` | Development builds: run JavaScript in the operator window |

## How it fits together

- [src/agent/spec.ts](../src/agent/spec.ts): the command catalogue (names, descriptions, JSON Schemas, live/destructive/read-only). The MCP server lists these as tools; nothing is duplicated.
- [src/agent/handlers.ts](../src/agent/handlers.ts): the implementation of each command against the stores and `engine/operator.ts`. Typed as `Record<AgentCommand, Handler>`, so a command without a handler does not compile.
- [src/agent/paths.ts](../src/agent/paths.ts): path addressing, deep merge, patch operations and JSON-safe summaries.
- [src/agent/bridge.ts](../src/agent/bridge.ts): the operator window's WebSocket client, the on/off switch and the I/O log lines.
- [src/render/snap.ts](../src/render/snap.ts): screenshots, taken by the compositor right after it draws a frame.
- [mcp/server.ts](../mcp/server.ts): the MCP server (stdio), the bridge host/relay, and the file-system parts (reading files for `asset_import`, show-file export/import).
- [mcp/check.ts](../mcp/check.ts): smoke test (`pnpm mcp:check`, `node mcp/check.ts --build`).

### Recipe: a StageLight cue from a cue and from a video

```text
stagelight_link {enabled: true, host: "127.0.0.1", port: 1461}        → reach "answering" (needs project/io/osc/enabled)
cue_add {scene: "1.2", cue: {name: "Lights up", actions: [{type: "send", message: {type: "stagelight", op: "goCue", page: "Act 1", cue: "4"}}]}}
markers {scene: "1.2", op: "upsert", media: "Lion", clip: "Run", marker: {name: "Leap", at: 1.8, message: {type: "stagelight", op: "trigger", name: "lion.leap"}}}
stagelight_send {message: {op: "trigger", name: "lion.leap"}}           → wire + StageLight's answer (only when the operator asks: it may move real lights)
```

`node mcp/check.ts --build` exercises the StageLight cue action and markers in a scratch scene (nothing is sent); `node mcp/check.ts --stagelight 1471` pings, GOes and fires a trigger on a development desk through the app, then puts the link back.

Keeping it in step with new features: see the checklist in [AGENTS.md](../AGENTS.md).

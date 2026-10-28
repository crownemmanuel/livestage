# LiveStage Sound

A small show-control app for the actors' radio mics. It owns the connection to the Allen & Heath dLive and mutes / unmutes the drama mics scene by scene and cue by cue, puts "voice effects" on them (sends into the desk's FX units), and gives the crew a phone page for the backstage mic check. LiveStage (the LED-wall app) drives it over OSC; an agent can drive it over MCP.

It is deliberately light and separate from LiveStage: a Node service (`sound/server/`, no build step) and two small React pages (`sound/ui/`, built to `sound/dist/`). Nothing from LiveStage's UI, no Three.js.

## Starting it

```bash
pnpm sound            # builds the screens if needed, starts the service, opens the operator window
pnpm sound:serve      # the service only (no window)
pnpm sound:dev        # screens with hot reload on http://localhost:1452 (run sound:serve as well)
pnpm sound:build      # build the screens into sound/dist/
pnpm sound:check      # end-to-end test against the pretend desk (never touches a real desk)
pnpm fake-dlive       # a pretend dLive on 127.0.0.1:51325 (see below)
pnpm sound:mcp        # the MCP server (an agent starts it; see "Agents")
```

`pnpm sound` opens the operator screen as a chromeless app window (Chrome, Edge or Brave with `--app`, using its own profile in the data folder), else the default browser. If the service is already running it just opens the window.

On a Mac, two scripts for you to run once (they are not run for you):

- `bash sound/macos/make-app.sh` makes **~/Applications/LiveStage Sound.app**, a double-clickable launcher for this checkout.
- `bash sound/macos/install-launchagent.sh` keeps the service running from login (restarted if it stops), so LiveStage and the phones always find it. `--remove` takes it out again.

Service options (arguments or environment):

| Argument | Env | Default |
| --- | --- | --- |
| `--data <dir>` | `SOUND_DATA_DIR` | `~/Library/Application Support/LiveStage Sound/` |
| `--dist <dir>` | `SOUND_DIST_DIR` | `sound/dist` next to the server |
| `--http-port <n>` | `SOUND_HTTP_PORT` | 1450 |
| `--osc-port <n>` | `SOUND_OSC_PORT` | 1451 |
| `--desk-readonly` | `SOUND_DESK_READONLY=1` | off: only questions ever go to the desk |
| `--open` | | open the operator window once listening |

Once HTTP and OSC are listening it prints one machine-readable line, then keeps logging:

```
SOUND_READY {"url":"http://localhost:1450","http":1450,"osc":1451,"data":"…","pid":123}
```

SIGTERM / SIGINT save the show and the live state and close every socket. A port that is already taken makes it exit (code 2 for HTTP, 1 for OSC).

## Ports

| Port | What |
| --- | --- |
| 1450 TCP | operator screen `/`, backstage page `/backstage`, JSON API `/api/…`, WebSocket `/ws` |
| 1451 UDP | OSC commands from LiveStage |
| 1452 TCP | `pnpm sound:dev` only |

The service listens on every interface so phones on the LAN reach `/backstage`. The operator screen, its WebSocket and the API answer **only this computer** (a LAN visitor to `/` is sent to `/backstage`) unless Build → Settings → "Allow the operator screen from other computers" is ticked. The backstage page can only assign mics and confirm scenes. Requests from a web page on another origin are refused.

## Data

In the data folder, every write is a temp file + rename:

- `show.json`: mics → desk inputs, characters, scenes (cast, per-scene mic assignment, cues), effect presets. Versioned (`version`), migrated on load (`migrateShow` in `sound/server/model.ts`); a file that cannot be read is kept as `show.json.broken-<time>` and the app starts from the demo show.
- `settings.json`: this computer's desk address, sync mode, cloud keys.
- `live.json`: the active scene / cue / effects and the send levels effects took over, so a restart shows where the show was. Nothing is re-sent to the desk on start.
- `photos/`: character photos. `sound.log`: the log (also on Build → Settings).

A first start seeds a demo show (the mock-up's cast and scenes). **Import from LiveStage** is the real path.

## What the operator sees

**Show mode**: scenes on the left; the scene header with **Activate scene**, **Next cue** (with the next cue's name) and **End scene**; the cue strip (more than 7 cues: 5 around the current one with "N earlier" / "+N more"); a card per cast member in mic order (compact when more than 6) with a big **LIVE / MUTED** toggle; tap the face or name for the voice-effect panel (None / presets, Light / Medium / Full). **MUTE ALL** in the top bar, the **All mics** drawer with all 12, an amber banner when a mic that is not in the active scene is live, status pills for the dLive, LiveStage (lime: OSC in the last 20 s) and sync, and the QR button for the backstage page.

What a card shows is what the **desk** reports: if someone mutes a channel on the surface, the card follows. While the desk link is down the screen says so, and mic changes wait and go out the moment it is back.

There is a slot for signal meters (`runtime.meters`, `Engine.setMeters(source, {mic: 0–1})`), e.g. a future Dante feed. With no meter source nothing that needs audio is shown.

**Build mode**: the scene's cast (add / remove), the cue grid (rows = cues, columns = cast, ON / OFF cells, effect and trigger columns, add / reorder / delete), characters (name, male / female placeholder, photo upload, default mic, colour), effect presets, desk mics + connection, backstage sync with the QR code, settings + log, and **Import scenes from LiveStage**.

## Rules the app follows

- A cue lists who is live; everyone else in the scene's cast is muted. Mics not in the cast are left alone (the stray banner shows them).
- Applying a cue mutes first, then sets effects, then opens mics. Activating another scene also mutes the previous scene's mics that the new one does not use and clears their effects.
- **End scene** mutes the active scene's mics and clears effects. **MUTE ALL** mutes all 12. Both write the mutes at once (nothing waits on fades or the network) and fire on the button's press, not its release; MUTE ALL goes over the WebSocket and over HTTP as well.
- A backstage mic swap in the live scene re-applies the current cue so the right people stay live, and mutes a mic nobody in the scene wears any more.
- Effects: each preset is a list of sends from the mic's channel into FX sends at a dB level, with fade in / out. Amount: Light −10 dB, Medium as set, Full +6 dB (clamped to +10). Fades step the send level about 20 times a second. Clearing puts each send back to the level it had before the effect took it (remembered, also across a restart; −∞ if unknown).
- On connect the app asks the desk (read-only) for the names and mutes of the 12 mic inputs, and the names / mutes / faders of the FX sends, returns and DCAs the presets use, and the send levels. Build → Effect presets warns when a return is at −∞ or a DCA is muted (on the show desk FX return 3 "DELAY" was parked at −∞ and DCA 10 "FX" muted: the effect is then silent).
- **Dry run** (the default on a fresh install): nothing is sent; the screen plays the desk. Switch to "dLive desk" in Build → Desk.

## Desk setup

On the dLive: Utility → Control → MIDI. MIDI over TCP on port 51325 (no login; 51327 is TLS and is not used), base MIDI channel 12 on the show desk. The app spreads over channels N…N+4 as in `shared/dlive.ts`. In Build → Desk set the address (192.168.1.70 on the show network), port 51325 and base channel 12, then choose "dLive desk".

Mic k is desk input 76 + k by default (inputs 77–88, named Drama1 … Dram12 on the show desk). **Detect from desk** reads the names of inputs 1–128 and maps mics by names like `Drama 3`, `Drama3`, `Dram12`, `Radio 4`, `RF5`, `Mic 6`.

## Import from LiveStage

Build → Import scenes from LiveStage:

- **This computer's LiveStage show**: `~/Library/Application Support/org.salvation.livestudio/project.json` (`%APPDATA%\org.salvation.livestudio\` on Windows).
- **LiveStage while it runs**: asks the open app over its agent bridge (port 1431, the token in `~/.salvation-live/agent-1431.token`) with the read-only `list_scenes` and `status` commands only. Needs LiveStage's MCP server running (it hosts the bridge).
- **A show file**: `project.json`, or `show.json` from a `.slshow` package, picked in the browser; or a path to a file or a `.slshow` folder.

Scene ids are LiveStage's (`scene_…`), codes are LiveStage's display numbers (`7`, `2.1`, the same rule as `src/core/groups.ts`). Re-importing merges: scenes that still exist keep their cast and cues (name and code updated), new scenes are added, scenes LiveStage no longer has are marked "Gone from LiveStage" and kept until you delete them. The first real import removes the demo scenes; characters stay.

## OSC protocol (UDP 1451)

Defined in `shared/soundProtocol.ts`. Every argument is a string or int32; commands set a state, never toggle, so sending twice is harmless. `who` is a mic number (`"3"`), a character id or a character name (case-insensitive); a character resolves to their mic in the active scene (else the selected scene, else their default mic). Scene ids are LiveStage scene ids (codes and names work too).

| Address | Arguments | Does |
| --- | --- | --- |
| `/sound/scene/select` | s:sceneId | Show the scene on the operator screen; no mic changes |
| `/sound/scene/activate` | s:sceneId | Activate the scene and apply its first cue |
| `/sound/scene/end` | | Mute the active scene's mics and leave it |
| `/sound/cue/go` | s:sceneId i:cue (1-based) | Apply exactly that cue |
| `/sound/cue/next` | | Apply the active scene's next cue |
| `/sound/mic` | s:who i:live (1/0) | Set one mic live or muted |
| `/sound/fx` | s:who s:preset ("none" clears) [s:amount] | Voice effect on one mic |
| `/sound/restore` | | Re-apply the active cue |
| `/sound/panic` | | Mute every mic |
| `/sound/ping` | i:version | Answer with `/sound/hello` |

Replies go to the address and port of the last `/sound/ping`:

| Address | Arguments | When |
| --- | --- | --- |
| `/sound/hello` | i:protocolVersion s:appVersion i:deskConnected | After a ping |
| `/sound/state/mic` | i:mic s:name i:live | Whenever a mic changes, from any source (cue, operator, the desk surface) |
| `/sound/state/cue` | s:sceneId i:cue (0 = none) | Whenever the active cue changes |

Bundles are accepted. Errors (unknown scene, no such cue) are logged, not answered.

## Backstage mic check

The phone page (`/backstage`): two chips at the top, **LIVE** (the scene on stage) and **NEXT** (the scene to check now), each with a tick when it is checked; tapping one makes the phone follow it. By default the phone follows NEXT, so when the operator takes a scene live the phone moves on to the following one by itself, buzzes and shows "Next up: scene … Check the mics." The arrows browse any scene (the phone then stops following until a chip is tapped). The scene's cast is listed with their mic numbers; tap the big number for a 1–12 grid showing who holds each (offstage holders dimmed), pick one to assign (swaps if a cast member had it), and **All good** confirms the scene.

**Mic checks without the radio.** A check records who, when, and exactly which person was on which mic (the phone sends the list it was showing). It counts only while the scene still matches: a mic swap clears it, and a change to the cast or a default mic turns it amber ("changed since the check"). The operator sees a lime tick next to each checked scene in the scene list and "Backstage checked · name · time" under the scene title. NEXT normally follows the running order (the scene after the live one that has a cast); **Send to backstage as next** on any scene points the phones at it instead (it stays until that scene goes live), and **Ask to check again** clears a check. Workflow: while scene N runs, backstage checks N+1; the operator sees the tick before taking it. A change goes to the Sound app at once and updates that scene's mic mapping; the operator can undo it in Build ("Undo backstage mic changes").

The QR code (top bar button, or Build → Backstage) encodes the page's address. Two sync modes, chosen there:

### 1. Local network (default, real time)

The QR code is `http://<this computer's LAN address>:1450/backstage`. If the computer has several addresses, pick the one the phones' Wi-Fi is on. Phones talk to the service over a WebSocket.

### 2. Cloud (when the Wi-Fi is down and phones use mobile data)

Firebase **Realtime Database** over REST and server-sent events (no SDK). The Sound app signs in anonymously, claims `/sound/<showId>/<joinKey>/owner`, mirrors what the page needs to `…/show` (scenes, casts, characters with a 64 px photo thumbnail, no full photos), and streams `…/backstage` (`assign/<scene>/<character> = mic`, `stamp/<scene>`, `checked/<scene>`). Per scene the newer change wins. The same backstage page works from a static host: the QR code carries the database URL, the public API key, the show id and the join key in the URL's `#c=…` (the part after `#` is never sent to the web server); the page signs in anonymously and talks straight to the database.

The rules (`firebase/database.rules.json`): nobody can read or list `/sound` or `/sound/<showId>`; a signed-in user who knows a path `/sound/<showId>/<joinKey>` (join key ≥ 20 characters, 24 random base64url by default) can read it and write only `backstage` (mic numbers 1–32, timestamps, `{by, at}` checks); only the owning Sound app can write `show`, and `owner` can be set once. **New key** in Build → Backstage cuts off old QR codes.

#### Setting up cloud sync (you do this; nothing is deployed by the app)

1. In the Firebase project (the same one as LiveStage's cloud sync works): **Build → Realtime Database → Create database**.
2. **Authentication → Sign-in method → Anonymous: enable.**
3. Publish the rules: paste `firebase/database.rules.json` in Realtime Database → Rules, or `cd firebase && npx firebase-tools deploy --only database --project <project>`. (This does not touch the Storage rules.)
4. Host the backstage page: `pnpm sound:build`, then host the contents of `sound/dist/` (only `backstage.html` and `assets/` are needed). For Firebase Hosting add to `firebase/firebase.json`: `"hosting": { "public": "../sound/dist" }` and run `npx firebase-tools deploy --only hosting --project <project>`. The page URL is then `https://<project>.web.app/backstage.html`.
5. In the Sound app, Build → Backstage → Cloud: paste the web config (`const firebaseConfig = {…}`, it needs `apiKey`, `projectId`, `databaseURL`), set **Hosted page** to the URL from step 4, and switch the mode to **Cloud**. The QR code then points at the hosted page.

Until a hosted URL is set, the cloud QR code uses this computer's address (handy for testing, useless without the LAN).

#### Trying cloud mode without a project

```bash
pnpm sound:emulator   # Firebase Auth (9099) + Realtime Database (9000) emulators with the rules (Java 11+)
```

Then in Build → Backstage → Cloud set Project `demo-sls`, any API key (e.g. `fake-api-key`), Emulator host `127.0.0.1`, and switch to Cloud.

## Agents (MCP)

`sound/mcp.ts` is a stdio MCP server that talks to the running service's API (`SOUND_HTTP_PORT` to pick the port). Add it to an MCP client as `node /path/to/livestage/sound/mcp.ts`.

| Tool | Marks | Does |
| --- | --- | --- |
| `status` | read-only | Desk link, active scene / cue, every mic's live state as the desk reports it, effects, LiveStage and sync |
| `list_scenes` | read-only | Scenes with code, id, cast with mics, cue labels |
| `activate_scene` | live | Activate a scene (first cue) |
| `cue_go` | live | Apply one cue |
| `next_cue` | live | Next cue of the active scene |
| `end_scene` | live | Mute the active scene's mics and leave it |
| `mic` | live | One mic live or muted |
| `fx` | live | Voice effect on one mic |
| `panic` | live, destructive | Mute every mic |

## JSON API

All on `http://localhost:1450`, this computer only:

- `GET /api/ping`, `GET /api/status`, `GET /api/state` (show, runtime, settings, links, log), `GET /api/commands` (the command table).
- `POST /api/cmd` with `{"cmd": "...", "args": {...}}`, or `POST /api/<cmd>` with the args as the body. Answers `{"ok": true, "result": …}` or `{"ok": false, "error": "…"}` (400).
- `POST /api/photo/<characterId>` with `{"data": "data:image/jpeg;base64,…", "thumb": "data:…"}`.
- `GET /api/qr?text=…`: a QR code as SVG.

Every command (`sound/server/spec.ts`) goes through `Engine.run()` in `sound/server/engine.ts`: the operator screen, the backstage page, OSC, the API, MCP and the cloud all use the same handler, which validates, changes state, sends the desk its bytes and tells every screen.

## The pretend desk

`pnpm fake-dlive` (or `node scripts/fake-dlive.ts --port 51325 --host 127.0.0.1 --midi 12`) is a TCP server that speaks the dLive's MIDI over TCP: it keeps mutes, faders, names, colours and send levels, answers the "get" questions like the desk, logs every message, and relays every change to the other connected clients (so a second client can play someone on the surface). Seeded like the show desk: inputs 77–88 named Drama1 … Dram12 (muted), mono FX sends 2 "HALL" and 3 "DELAY", FX return 3 "DELAY" at −∞, DCA 10 "FX" muted. `kill -USR2 <pid>` prints its state.

## Safety notes

- A fresh install starts in **dry run**: nothing reaches a console until someone chooses "dLive desk" (and confirms the address).
- The app only ever writes mutes of the 12 mic inputs and send levels from those inputs into the presets' FX sends. It never sends faders, names, colours or scene recalls.
- Everything else it sends is a question (names, mutes, faders, send levels), including a heartbeat every 4 s that notices a dead link within ~13 s and reconnects with backoff (0.5 s … 10 s).
- `SOUND_DESK_READONLY=1` lets you look at a live desk with only questions going out (mutes and sends are logged, not sent).
- The desk is shared with church services: the dLive's own scenes may change channel names or mutes; the app shows what the desk reports and does not fight it.

## Code

| File | What |
| --- | --- |
| `shared/dlive.ts`, `shared/soundProtocol.ts` | dLive bytes and parser; the OSC contract with LiveStage (shared, read-only for this app) |
| `sound/server/model.ts` | data model, defaults, demo show, migrations (also used by the UI) |
| `sound/server/logic.ts` | pure rules: who wears which mic, what a cue means, resolving `who` |
| `sound/server/engine.ts` | the command handler, cue application, fades, desk events |
| `sound/server/desk.ts` | TCP link with reconnect and heartbeat |
| `sound/server/osc.ts` | OSC encode / decode and the UDP listener |
| `sound/server/http.ts` | static files, API, uploads, WebSocket, access rules |
| `sound/server/importer.ts` | LiveStage show files, packages, the agent bridge; merge |
| `sound/server/cloud.ts` | Realtime Database mirror (REST + SSE) |
| `sound/server/main.ts`, `args.ts`, `window.ts`, `store.ts` | wiring, options, app window, files |
| `sound/ui/` | operator app (`index.html`) and backstage page (`backstage.html`) |
| `sound/mcp.ts`, `sound/check.ts`, `sound/launch.ts`, `sound/macos/` | MCP server, end-to-end check, `pnpm sound`, Mac launcher scripts |
| `scripts/fake-dlive.ts` | the pretend desk |
| `firebase/database.rules.json` | Realtime Database rules for the cloud backstage |

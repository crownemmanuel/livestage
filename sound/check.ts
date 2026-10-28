#!/usr/bin/env node
// End-to-end check of LiveStage Sound against the pretend desk (scripts/fake-dlive.ts). Never touches a real
// desk: it starts its own fake desk, its own service (scratch data folder, test ports) and drives it the way
// LiveStage (OSC), the operator (API), the backstage page (WebSocket), the desk surface (a second TCP client)
// and an agent (MCP) would.
//
//   node sound/check.ts [--keep]   (--keep leaves the scratch folder for a look)

import { spawn, type ChildProcess } from "node:child_process";
import { createSocket } from "node:dgram";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DliveParser, dliveMute, type DliveEvent } from "../shared/dlive.ts";
import { SOUND_OSC, SOUND_OSC_REPLY } from "../shared/soundProtocol.ts";
import { decodeOsc, encodeOsc, type OscMessage } from "./server/osc.ts";

const here = dirname(fileURLToPath(import.meta.url));
// Override with SOUND_CHECK_HTTP / _OSC / _DESK when something else on this computer holds these ports.
const DESK_PORT = Number(process.env.SOUND_CHECK_DESK ?? 51399);
const HTTP = Number(process.env.SOUND_CHECK_HTTP ?? 1460);
const OSC = Number(process.env.SOUND_CHECK_OSC ?? 1461);
const data = mkdtempSync(join(tmpdir(), "sound-check-"));
writeFileSync(join(data, "settings.json"), JSON.stringify({ version: 1, desk: { host: "127.0.0.1", port: DESK_PORT, baseChannel: 12, mode: "desk" } }));

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await sleep(50);
  }
  return false;
}

const procs: ChildProcess[] = [];
function start(file: string, args: string[], env: Record<string, string> = {}) {
  const p = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p);
  p.stdout!.on("data", () => {});
  p.stderr!.on("data", (d) => process.env.CHECK_VERBOSE && process.stderr.write(d));
  return p;
}
const startDesk = () => start(join(here, "..", "scripts", "fake-dlive.ts"), ["--port", String(DESK_PORT), "--quiet"]);

// ---------------------------------------------------------------- the pieces

let desk = startDesk();
await sleep(400);
start(join(here, "server", "main.ts"), [], { SOUND_DATA_DIR: data, SOUND_HTTP_PORT: String(HTTP), SOUND_OSC_PORT: String(OSC) });

async function api(cmd: string, args: Record<string, unknown> = {}) {
  const r = await fetch(`http://127.0.0.1:${HTTP}/api/cmd`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd, args }) });
  return (await r.json()) as { ok: boolean; result?: any; error?: string };
}
const status = async () => (await (await fetch(`http://127.0.0.1:${HTTP}/api/status`)).json()) as { desk: { status: string }; mics: { mic: number; live?: boolean; deskName?: string; fx?: string; waiting?: boolean }[]; cue: { n: number } | null };
const micLive = async (n: number) => (await status()).mics.find((m) => m.mic === n)?.live;

/** "The desk surface": a second client that sees every change the app makes (the desk relays them). */
const surfaceEvents: DliveEvent[] = [];
let surface: Socket = new Socket();
function connectSurface() {
  surface = new Socket();
  const parser = new DliveParser(12);
  surface.on("data", (b: Buffer) => surfaceEvents.push(...parser.push(b)));
  surface.on("error", () => {});
  surface.connect(DESK_PORT, "127.0.0.1");
}
connectSurface();
const sawMute = (input: number, muted: boolean) => surfaceEvents.some((e) => e.type === "mute" && e.channel.kind === "input" && e.channel.number === input && e.muted === muted);

/** "LiveStage": OSC over UDP, collecting replies. */
const replies: OscMessage[] = [];
const udp = createSocket("udp4");
udp.on("message", (b) => replies.push(...decodeOsc(b)));
await new Promise<void>((r) => udp.bind(0, "127.0.0.1", () => r()));
const osc = (address: string, ...args: (string | number)[]) => udp.send(encodeOsc(address, args), OSC, "127.0.0.1");

try {
  ok("service answers", await until(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${HTTP}/api/ping`)).ok;
    } catch {
      return false;
    }
  }, 5000));
  ok("desk connected", await until(async () => (await status()).desk.status === "connected", 5000));
  ok("desk names read (mic 1 = In 77 Drama1, mic 12 = Dram12)", await until(async () => {
    const s = await status();
    return s.mics[0].deskName === "Drama1" && s.mics[11].deskName === "Dram12";
  }));
  ok("mic state read from the desk (all muted)", await until(async () => (await status()).mics.every((m) => m.live === false)));

  // ---- OSC from LiveStage
  osc(SOUND_OSC.ping, 1);
  ok("/sound/ping → /sound/hello", await until(() => replies.some((m) => m.address === SOUND_OSC_REPLY.hello && m.args[0] === 1 && m.args[2] === 1)));
  osc(SOUND_OSC.sceneActivate, "demo_7");
  ok("/sound/scene/activate demo_7: Mary + Martha live on the desk", await until(() => sawMute(77, false) && sawMute(80, false)));
  ok("… Gabriel stays muted", !sawMute(79, false));
  ok("… /sound/state/mic replies (1 Mary 1)", await until(() => replies.some((m) => m.address === SOUND_OSC_REPLY.mic && m.args[0] === 1 && m.args[1] === "Mary" && m.args[2] === 1)));
  ok("… /sound/state/cue demo_7 1", replies.some((m) => m.address === SOUND_OSC_REPLY.cue && m.args[0] === "demo_7" && m.args[1] === 1));

  osc(SOUND_OSC.cueGo, "demo_7", 2);
  ok("/sound/cue/go demo_7 2: Gabriel live, Martha muted", await until(() => sawMute(79, false) && sawMute(80, true)));
  ok("… Heaven fades In 79 into FX send 3 up to 0 dB", await until(() => surfaceEvents.some((e) => e.type === "send" && e.from.number === 79 && e.to.kind === "monoFxSend" && e.to.number === 3 && e.level === 0x6b), 3500));
  ok("… and FX send 2 to −5 dB", await until(() => surfaceEvents.some((e) => e.type === "send" && e.from.number === 79 && e.to.number === 2 && e.level === 0x61)));

  // ---- someone on the desk surface
  surface.write(Uint8Array.from(dliveMute(11, { kind: "input", number: 77 }, true)));
  ok("mute on the desk surface → app shows Mary muted", await until(async () => (await micLive(1)) === false));
  ok("… and tells LiveStage (1 Mary 0)", await until(() => replies.some((m) => m.address === SOUND_OSC_REPLY.mic && m.args[0] === 1 && m.args[2] === 0)));
  osc(SOUND_OSC.restore);
  ok("/sound/restore puts Mary back live", await until(async () => (await micLive(1)) === true));

  osc(SOUND_OSC.mic, "martha", 1);
  ok("/sound/mic martha 1 (by name)", await until(async () => (await micLive(4)) === true));
  osc(SOUND_OSC.mic, "4", 0);
  ok("/sound/mic 4 0 (by number)", await until(async () => (await micLive(4)) === false));
  osc(SOUND_OSC.fx, "Gabriel", "Echo", "full");
  ok("/sound/fx Gabriel Echo full", await until(async () => (await status()).mics[2].fx === "Echo"));
  ok("… FX send 3 at +6 dB", await until(() => surfaceEvents.some((e) => e.type === "send" && e.from.number === 79 && e.to.number === 3 && e.level === 0x77), 2500));
  ok("… HALL send fades back to −inf", await until(() => surfaceEvents.some((e) => e.type === "send" && e.from.number === 79 && e.to.number === 2 && e.level === 0), 3500));
  osc(SOUND_OSC.fx, "3", "none");
  ok("/sound/fx 3 none: DELAY send back to −inf", await until(() => surfaceEvents.filter((e) => e.type === "send" && e.from.number === 79 && e.to.number === 3).at(-1)?.type === "send" && (surfaceEvents.filter((e) => e.type === "send" && e.from.number === 79 && e.to.number === 3).at(-1) as { level: number }).level === 0, 3500));

  osc(SOUND_OSC.cueNext);
  ok("/sound/cue/next → Q3", await until(async () => (await status()).cue?.n === 3));
  const bad = await api("cue.go", { scene: "demo_7", cue: 9 });
  ok("a cue that does not exist is refused", !bad.ok && /no cue 9/.test(bad.error ?? ""), bad.error);

  // ---- stray mic + panic
  surface.write(Uint8Array.from(dliveMute(11, { kind: "input", number: 88 }, false)));
  ok("mic 12 opened on the surface shows live", await until(async () => (await micLive(12)) === true));
  osc(SOUND_OSC.panic);
  ok("/sound/panic: every mic muted on the desk", await until(async () => (await status()).mics.every((m) => m.live === false)));
  ok("… the surface saw In 88 muted", sawMute(88, true));

  osc(SOUND_OSC.sceneActivate, "demo_12");
  await until(async () => (await status()).cue?.n === 1);
  osc(SOUND_OSC.sceneEnd);
  ok("/sound/scene/end", await until(async () => (await status()).cue === null));

  // ---- backstage page (WebSocket, LAN role)
  const bs = new WebSocket(`ws://127.0.0.1:${HTTP}/ws?role=backstage`);
  const bsMsgs: any[] = [];
  bs.on("message", (m) => bsMsgs.push(JSON.parse(String(m))));
  await new Promise((r) => bs.once("open", r));
  ok("backstage gets the scenes", await until(() => bsMsgs.some((m) => m.t === "backstage" && m.view.scenes.length > 3)));
  bs.send(JSON.stringify({ t: "cmd", id: 1, cmd: "assign", args: { scene: "demo_7", character: "ch_mary", mic: 3 } }));
  ok("backstage assign: Mary → mic 3 swaps with Gabriel", await until(() => bsMsgs.some((m) => m.t === "backstage" && m.view.scenes.find((s: any) => s.id === "demo_7")?.mics.ch_mary === 3 && m.view.scenes.find((s: any) => s.id === "demo_7")?.mics.ch_gabriel === 1)));
  bs.send(JSON.stringify({ t: "cmd", id: 2, cmd: "panic", args: {} }));
  ok("backstage cannot run panic", await until(() => bsMsgs.some((m) => m.t === "res" && m.id === 2 && !m.ok)));
  bs.send(JSON.stringify({ t: "cmd", id: 3, cmd: "scene.confirm", args: { scene: "demo_7", by: "Sam" } }));
  ok("backstage confirm", await until(() => bsMsgs.some((m) => m.t === "backstage" && m.view.scenes.find((s: any) => s.id === "demo_7")?.checked?.by === "Sam")));
  bs.close();
  const bsOp = new WebSocket(`ws://127.0.0.1:${HTTP}/ws?role=operator`);
  ok("operator WebSocket from this computer is allowed", await new Promise((r) => { bsOp.once("open", () => r(true)); bsOp.once("error", () => r(false)); }));
  bsOp.close();

  // ---- mapping from desk names
  await api("mics.set", { mics: [{ n: 1, channel: 50 }] });
  const det = await api("mics.detect");
  ok("detect from desk maps mic 1 back to In 77 (Drama1)", det.ok && det.result.changed.some((c: any) => c.mic === 1 && c.channel === 77), JSON.stringify(det.result ?? det.error));

  // ---- the desk goes away and comes back
  desk.kill();
  ok("desk loss is noticed", await until(async () => (await status()).desk.status !== "connected", 3000));
  await api("mic", { who: "Joseph", live: true });
  ok("a mic change while the desk is away waits", (await status()).mics[1].waiting === true);
  desk = startDesk();
  ok("desk reconnects", await until(async () => (await status()).desk.status === "connected", 12000));
  ok("… the waiting change goes out (Joseph live on the new desk)", await until(async () => (await micLive(2)) === true, 3000));
  connectSurface();

  // ---- import from a LiveStage show file (merge keeps cues)
  const show = {
    name: "Test show",
    groups: [{ id: "g1", name: "Prologue" }],
    scenes: [
      { id: "scene_a", name: "Prologue 1", groupId: "g1" },
      { id: "scene_b", name: "Prologue 2", groupId: "g1" },
      { id: "scene_c", name: "Scene 1" },
    ],
  };
  const imp = await api("import.livestage", { from: "json", json: JSON.stringify(show) });
  ok("import a LiveStage show file", imp.ok && imp.result.added.join() === "1.1,1.2,2", JSON.stringify(imp.result ?? imp.error));
  await api("scene.cast", { scene: "scene_c", cast: ["ch_mary"] });
  await api("cue.add", { scene: "scene_c", label: "Hello" });
  show.scenes = [show.scenes[2], { id: "scene_d", name: "Scene 2" }] as typeof show.scenes;
  const re = await api("import.livestage", { from: "json", json: JSON.stringify(show) });
  ok("re-import merges (1 new, 2 gone, cues kept)", re.ok && re.result.added.length === 1 && re.result.removed.length === 2, JSON.stringify(re.result ?? re.error));
  const list = (await api("scenes.list")).result as { id: string; code: string; cues: string[]; removed?: boolean }[];
  ok("… scene_c kept its cue and is now scene 1", list.find((s) => s.id === "scene_c")?.cues[0] === "Q1 Hello" && list.find((s) => s.id === "scene_c")?.code === "1");
  const local = join(homedir(), "Library", "Application Support", "org.salvation.livestudio", "project.json");
  if (existsSync(local)) {
    const real = await api("import.livestage", { from: "json", json: readFileSync(local, "utf8"), dryRun: true });
    ok("dry run against this computer's LiveStage show", real.ok, real.ok ? `${real.result.added.length} scenes would be added` : real.error);
  }

  // ---- MCP
  const client = new Client({ name: "sound-check", version: "1.0.0" });
  const env = Object.fromEntries(Object.entries({ ...process.env, SOUND_HTTP_PORT: String(HTTP) }).filter((e): e is [string, string] => typeof e[1] === "string"));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, "mcp.ts")], env, stderr: "ignore" }));
  const { tools } = await client.listTools();
  ok("MCP tools", ["status", "list_scenes", "activate_scene", "cue_go", "next_cue", "end_scene", "mic", "fx", "panic"].every((n) => tools.some((t) => t.name === n)), tools.map((t) => t.name).join(", "));
  ok("MCP marks panic destructive and live", !!tools.find((t) => t.name === "panic")?.annotations?.destructiveHint && !!tools.find((t) => t.name === "panic")?.annotations?.openWorldHint);
  const st = (await client.callTool({ name: "status", arguments: {} })) as { content: { text: string }[]; isError?: boolean };
  ok("MCP status", !st.isError && JSON.parse(st.content[0].text).desk.status === "connected");
  const mic = (await client.callTool({ name: "mic", arguments: { who: "Mary", live: false } })) as { isError?: boolean };
  ok("MCP mic Mary muted", !mic.isError && (await micLive(1)) === false);
  await client.close();
} catch (e) {
  failures++;
  console.log(`FAIL ${e instanceof Error ? e.stack : e}`);
} finally {
  for (const p of procs) p.kill("SIGTERM");
  surface.destroy();
  udp.close();
  await sleep(400);
  if (!process.argv.includes("--keep")) rmSync(data, { recursive: true, force: true });
  else console.log(`scratch data: ${data}`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

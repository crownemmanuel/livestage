// Smoke test for the MCP server: starts it like an agent would, checks the tool list against the
// spec, and (when the app is running) exercises read-only tools.
//
//   node mcp/check.ts            tool list + read-only calls
//   node mcp/check.ts --build    also builds a scratch scene in the preview, screenshots it, deletes it
//   node mcp/check.ts --package  also writes a show package to a temp folder, dry-runs taking it back in,
//                                and deletes it (desktop app; counts the show's package version up by one)
//   node mcp/check.ts --stagelight 1471 [--page "Act 1"] [--trigger test]
//                                also sends a ping, a GO and a named trigger to a StageLight desk on
//                                127.0.0.1:<port> and prints its answers, then puts the link back
//                                (desktop app; never 1461, the show desk, unless --production)
//
// The --build run never touches the live wall.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AGENT_COMMANDS } from "../src/agent/spec.ts";

const here = dirname(fileURLToPath(import.meta.url));
const build = process.argv.includes("--build");
const pkg = process.argv.includes("--package");
const argOf = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const stagelightPort = argOf("--stagelight") ? Number(argOf("--stagelight")) : null;
if (stagelightPort === 1461 && !process.argv.includes("--production")) {
  console.error("Refusing to test against UDP 1461: that is the show's StageLight desk. Use a dev desk (1471) or add --production.");
  process.exit(2);
}

const client = new Client({ name: "sls-mcp-check", version: "1.0.0" });
// Pass the environment through (the SDK otherwise drops it), so SLS_AGENT_PORT picks the app to check.
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, "server.ts")], env, stderr: "inherit" }));

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
};

const { tools } = await client.listTools();
const names = new Set(tools.map((t) => t.name));
const missing = Object.keys(AGENT_COMMANDS).filter((n) => !names.has(n));
ok(`tool list (${tools.length} tools)`, missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : "");

type Content = { type: string; text?: string; data?: string; mimeType?: string };
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  const textPart = r.content.find((c) => c.type === "text")?.text ?? "";
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(textPart);
  } catch {
    /* error text */
  }
  return { error: r.isError ? textPart : null, json, image: r.content.find((c) => c.type === "image") };
}

const status = await call("status");
if (status.error) {
  console.log(`skip live checks: ${status.error}`);
} else {
  ok("status", !!status.json?.app, `${status.json.app.show}, ${status.json.app.scenes} scenes, mode ${status.json.app.mode}, bridge ${status.json.bridge.mode}`);
  ok("spec versions match", !status.json.bridge.warning, status.json.bridge.warning ?? "");
  const scenes = await call("list_scenes");
  ok("list_scenes", Array.isArray(scenes.json), `${scenes.json?.length} rows`);
  const schema = await call("schema", { topic: "cueActions" });
  ok("schema cueActions", Array.isArray(schema.json?.cueActions?.types), `${schema.json?.cueActions?.types?.length} action types`);
  const weather = await call("schema", { topic: "effects" });
  ok("schema weather controls", ["daynight", "rain", "fog"].every((type) => weather.json?.effects?.some((e: { type: string }) => e.type === type)));
  const width = await call("get", { path: "project/output/canvasWidth" });
  ok("get path", typeof width.json === "number", String(width.json));
  ok("bad path explains", !!(await call("get", { path: "project/nope/x" })).error);
  ok("io_log", Array.isArray((await call("io_log", { limit: 5 })).json));
  const tl = await call("timeline", status.json.preview ? {} : { scene: scenes.json?.[0]?.id });
  ok("timeline", Array.isArray(tl.json?.cues) && Array.isArray(tl.json?.tracks), tl.error ?? `${tl.json?.cues?.length} cues, ${tl.json?.tracks?.length} tracks, ${tl.json?.end} s`);
  if (status.json.preview) {
    // Read-only: where the preview's video is, without holding or moving it.
    const tr = await call("transport", { target: "preview", op: "status" });
    ok("transport status (preview)", typeof tr.json?.held === "boolean", tr.error ?? (tr.json?.video ? `${tr.json.video.label} ${tr.json.video.position}/${tr.json.video.duration} s` : "no video"));
  }
  const check = await call("asset_check");
  ok("asset_check", Array.isArray(check.json?.assets), JSON.stringify(check.json).slice(0, 200));
  const mix = await call("mixer");
  ok("mixer (read)", Array.isArray(mix.json?.sources), mix.error ?? `${mix.json?.sources?.length ?? 0} sources playing`);
  // The mixer's levels are the show file's sound levels (project/mix).
  const saved = (await call("get", { path: "project/mix" })).json ?? {};
  const sameLevels = JSON.stringify(Object.entries(saved).sort()) === JSON.stringify(Object.entries(mix.json?.trims ?? {}).sort());
  ok("mixer levels saved in the show", sameLevels, `${Object.keys(saved).length} saved level(s)`);
  const firstScene = scenes.json?.[0]?.scenes?.[0]?.id ?? scenes.json?.[0]?.id;
  if (firstScene) {
    const music = await call("music_at", { scene: firstScene });
    ok("music_at", Array.isArray(music.json?.sounds), music.error ?? `${music.json?.sounds?.length} sound(s) at the top of ${music.json?.scene?.name}, chase ${music.json?.chase ? "on" : "off"}`);
  }
  const out = await call("audio_output");
  ok("audio_output (read)", Array.isArray(out.json?.native), out.error ?? `${out.json?.native?.length ?? 0} native, ${out.json?.web?.length ?? 0} web outputs`);
  // Read-only: StageMics reach (sends nothing).
  const sm = await call("stagemics_status");
  ok("stagemics_status", !sm.error, sm.error ?? `StageMics ${typeof sm.json === "string" ? sm.json : sm.json?.reach}`);
  const io = await call("schema", { topic: "io" });
  ok("schema io lists StageMics messages", ["sound"].every((t) => io.json?.io?.outgoing?.some((m: { type: string }) => m.type === t)), io.error ?? "");
  const sl = await call("stagelight_status");
  ok("stagelight_status", typeof sl.json?.enabled === "boolean", sl.error ?? `link ${sl.json?.enabled ? `${sl.json.host}:${sl.json.port}, ${sl.json.reach}` : "off"}`);
  const slCat = await call("stagelight_catalog");
  ok("stagelight_catalog", typeof slCat.json?.state === "string", slCat.error ?? (slCat.json?.pages ? `${slCat.json.pages.length} pages, ${slCat.json.triggers.length} triggers` : slCat.json?.note));
  const ioSchema = await call("schema", { topic: "io" });
  ok("schema io lists StageLight", ioSchema.json?.io?.outgoing?.some((m: { type: string }) => m.type === "stagelight") && Array.isArray(ioSchema.json?.io?.stagelight?.shapes), ioSchema.error ?? "");
  const cloud = await call("cloud_status");
  ok("cloud_status", typeof cloud.json?.configured === "boolean", cloud.error ?? (cloud.json?.configured ? `${cloud.json.project}, signed in: ${cloud.json.signedIn}` : "not set up"));
  if (status.json.app.desktop) {
    // Asks GitHub; before the first published release it must still explain itself.
    const upd = await call("update_check");
    ok("update_check", typeof upd.json?.current === "string" || /release/i.test(upd.error ?? ""), upd.error ?? (upd.json?.available ? `${upd.json.current} → ${upd.json.available.version}` : `${upd.json?.current}, up to date`));
  }

  if (build) {
    const before = status.json.selected?.scene?.id ?? null;
    const sc = await call("scene_create", { name: "MCP check (delete me)", props: { environment: "none" } });
    ok("scene_create", !!sc.json?.id, sc.error ?? sc.json?.code);
    const id = sc.json?.id;
    if (id) {
      const bg = await call("component_add", { scene: id, kind: "background", name: "Sky", props: { source: "environment", env: { timeOfDay: 0.3, storm: 0 } } });
      ok("component_add background", !!bg.json?.id, bg.error ?? "");
      const title = await call("component_add", { scene: id, kind: "text", name: "Title", props: { text: "MCP CHECK", initiallyVisible: false } });
      ok("component_add text", !!title.json?.id, title.error ?? "");
      const cue = await call("cue_add", { scene: id, cue: { name: "Show title", actions: [{ type: "layer", layerId: title.json?.id, op: "show" }] } });
      ok("cue_add", !!cue.json?.id, cue.error ?? "");
      const upd = await call("component_update", { scene: id, component: "Title", patch: { color: "#ffd27a", size: 0.14 } });
      ok("component_update by name", upd.json?.color === "#ffd27a", upd.error ?? "");
      // StageLight cue actions and time markers are only stored here: nothing is taken live, nothing is sent.
      const slCue = await call("cue_add", { scene: id, cue: { name: "Lights", actions: [{ type: "send", message: { type: "stagelight", op: "go/cue", page: 2, cue: 4 } }] } });
      const slMsg = slCue.json ? (await call("get", { path: `project/scenes/${id}/cues/${slCue.json.id}/actions/0/message` })).json : null;
      ok("cue_add StageLight action (normalized)", slMsg?.op === "goCue" && slMsg?.page === "2" && slMsg?.cue === "4", slCue.error ?? JSON.stringify(slMsg));
      ok("cue_add refuses a StageLight trigger without a name", !!(await call("cue_add", { scene: id, cue: { name: "Bad", actions: [{ type: "send", message: { type: "stagelight", op: "trigger" } }] } })).error);
      const slUpd = await call("cue_update", { scene: id, cue: "Lights", patch: { actions: [{ type: "send", message: { type: "stagelight", op: "trigger", name: "check.trigger" } }] } });
      ok("cue_update StageLight action", !slUpd.error, slUpd.error ?? "");
      const vid = await call("component_add", { scene: id, kind: "video", name: "Clip" });
      const mk = await call("markers", { scene: id, op: "upsert", media: "Clip", marker: { name: "Leap", at: 1.8, message: { type: "stagelight", op: "trigger", name: "lion.leap" } } });
      ok("markers upsert StageLight send", mk.json?.added === true && /lion\.leap/.test(mk.json?.marker?.does ?? ""), vid.error ?? mk.error ?? "");
      const mkEdit = mk.json ? await call("markers", { scene: id, op: "upsert", media: "Clip", marker: { id: mk.json.marker.id, at: 2.2, message: { type: "stagelight", op: "goCue", page: "Act 1", cue: 3 } } }) : null;
      ok("markers edit", mkEdit?.json?.marker?.at === 2.2 && mkEdit.json.marker.message.cue === "3", mkEdit?.error ?? "");
      const mkList = await call("markers", { scene: id });
      ok("markers list", mkList.json?.videos?.[0]?.markers?.length === 1, mkList.error ?? "");
      ok("markers remove", !(await call("markers", { scene: id, op: "remove", media: "Clip", id: "Leap" })).error);
      const pt = await call("patch", { ops: [{ op: "set", path: `project/scenes/${id}/notes`, value: "patched" }] });
      ok("patch", pt.json?.applied === 1, pt.error ?? "");
      ok("select_scene", !(await call("select_scene", { scene: id })).error);
      await new Promise((r) => setTimeout(r, 600));
      const at = await call("preview_time", { seconds: 0.5 });
      ok("preview_time (preview)", at.json?.sceneTime === 0.5, at.error ?? JSON.stringify(at.json?.sceneTime));
      const run = await call("preview_run", { on: true });
      const stop = await call("preview_run", { on: false });
      ok("preview_run start / stop (preview)", run.json?.running === true && stop.json?.running === false, run.error ?? stop.error ?? undefined);
      await call("restart_preview");
      await new Promise((r) => setTimeout(r, 300));
      const go = await call("cue", { target: "preview", op: "go" });
      ok("cue go (preview)", go.json?.cuePointer === 1, go.error ?? JSON.stringify(go.json?.nextCue));
      await new Promise((r) => setTimeout(r, 1500));
      const rt = await call("get_runtime", { target: "preview" });
      ok("title visible after GO", rt.json?.layers?.some((l: { name: string; visible: boolean }) => l.name === "Title" && l.visible), rt.error ?? "");
      const held = await call("transport", { target: "preview", op: "hold" });
      ok("transport hold (preview)", held.json?.held === true, held.error ?? "");
      ok("transport nudge without a video explains", !!(await call("transport", { target: "preview", op: "nudge", seconds: -1 })).error);
      const resumed = await call("transport", { target: "preview", op: "resume" });
      ok("transport resume (preview)", resumed.json?.held === false, resumed.error ?? "");
      const fade = await call("run_action", { target: "preview", action: { type: "audio.fade", which: "all", fade: 1 } });
      ok("run_action audio.fade (preview)", !fade.error, fade.error ?? "");
      const shot = await call("screenshot", { target: "preview", width: 640 });
      if (shot.image?.data) {
        const file = join(tmpdir(), "sls-mcp-check.jpg");
        writeFileSync(file, Buffer.from(shot.image.data, "base64"));
        ok("screenshot", true, file);
      } else ok("screenshot", false, shot.error ?? "no image");
      if (before) await call("select_scene", { scene: before });
      const del = await call("scene_delete", { scene: id });
      ok("scene_delete", !del.error, del.error ?? "");
    }
  }

  if (pkg && status.json.app.desktop) {
    const dir = join(tmpdir(), `sls-mcp-check-${process.pid}.slshow`);
    const ex = await call("package_export", { dir });
    ok("package_export", !!ex.json?.version, ex.error ?? `v${ex.json?.version}, ${ex.json?.files} files, ${ex.json?.megabytes} MB, missing ${ex.json?.missing?.length}`);
    const im = await call("package_import", { dir, dryRun: true });
    const plan = im.json?.plan;
    ok("package_import dry run of own package", !!plan && plan.conflicts.length === 0 && plan.incoming.length === 0, im.error ?? `${plan?.unchanged} unchanged`);
    rmSync(dir, { recursive: true, force: true });
  } else if (pkg) console.log("skip package checks: the desktop app is needed");

  if (stagelightPort && status.json.app.desktop) {
    // End to end against a StageLight desk: ping/hello, a GO, a named trigger. Puts the link back afterwards.
    const before = (await call("get", { path: "project/io/stagelight" })).json;
    const off = await call("stagelight_link", {}); // a fresh show gets its I/O settings here
    const listening = (await call("get", { path: "project/io/osc/enabled" })).json;
    if (!listening) await call("patch", { ops: [{ op: "set", path: "project/io/osc/enabled", value: true }] });
    const link = await call("stagelight_link", { enabled: true, host: "127.0.0.1", port: stagelightPort, mirror: false });
    ok(`StageLight on ${stagelightPort} answers ping`, link.json?.reach === "answering", link.error ?? JSON.stringify(link.json?.hello ?? link.json));
    const cat = await call("stagelight_catalog", { refresh: true });
    ok(`StageLight catalog`, !!cat.json, cat.error ?? (cat.json?.pages ? `revision ${cat.json.revision}: ${cat.json.pages.map((p: { name: string; cues: unknown[] }) => `${p.name} (${p.cues.length})`).join(", ")}; triggers ${cat.json.triggers.map((t: { name: string }) => t.name).join(", ")}` : cat.json?.note));
    const page = argOf("--page") ?? "1";
    const go = await call("stagelight_send", { message: { op: "go", page } });
    ok(`StageLight GO page ${page}`, !!go.json && !(typeof go.json.answer === "object" && go.json.answer?.error), go.error ?? `${go.json.wire} → ${JSON.stringify(go.json.answer)}`);
    const trig = argOf("--trigger") ?? "test";
    const tr = await call("stagelight_send", { message: { op: "trigger", name: trig } });
    ok(`StageLight trigger "${trig}"`, !!tr.json && !(typeof tr.json.answer === "object" && tr.json.answer?.error), tr.error ?? `${tr.json.wire} → ${JSON.stringify(tr.json.answer)}`);
    const bad = await call("stagelight_send", { message: { op: "trigger", name: "no.such.trigger.check" } });
    ok("StageLight refuses an unknown trigger", typeof bad.json?.answer === "object" && !!bad.json.answer?.error, bad.error ?? JSON.stringify(bad.json?.answer));
    await call("patch", { ops: [{ op: "set", path: "project/io/stagelight", value: before ?? { enabled: false, host: off.json?.host ?? "127.0.0.1", port: off.json?.port ?? 1461, mirror: false } }, ...(listening ? [] : [{ op: "set", path: "project/io/osc/enabled", value: false }])] });
  } else if (stagelightPort) console.log("skip StageLight checks: the desktop app is needed");
}

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

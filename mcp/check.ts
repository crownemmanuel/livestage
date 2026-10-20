// Smoke test for the MCP server: starts it like an agent would, checks the tool list against the
// spec, and (when the app is running) exercises read-only tools.
//
//   node mcp/check.ts            tool list + read-only calls
//   node mcp/check.ts --build    also builds a scratch scene in the preview, screenshots it, deletes it
//   node mcp/check.ts --package  also writes a show package to a temp folder, dry-runs taking it back in,
//                                and deletes it (desktop app; counts the show's package version up by one)
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
  const width = await call("get", { path: "project/output/canvasWidth" });
  ok("get path", typeof width.json === "number", String(width.json));
  ok("bad path explains", !!(await call("get", { path: "project/nope/x" })).error);
  ok("io_log", Array.isArray((await call("io_log", { limit: 5 })).json));
  if (status.json.preview) {
    // Read-only: where the preview's video is, without holding or moving it.
    const tr = await call("transport", { target: "preview", op: "status" });
    ok("transport status (preview)", typeof tr.json?.held === "boolean", tr.error ?? (tr.json?.video ? `${tr.json.video.label} ${tr.json.video.position}/${tr.json.video.duration} s` : "no video"));
  }
  const check = await call("asset_check");
  ok("asset_check", Array.isArray(check.json?.assets), JSON.stringify(check.json).slice(0, 200));
  const mix = await call("mixer");
  ok("mixer (read)", Array.isArray(mix.json?.sources), mix.error ?? `${mix.json?.sources?.length ?? 0} sources playing`);
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
      const pt = await call("patch", { ops: [{ op: "set", path: `project/scenes/${id}/notes`, value: "patched" }] });
      ok("patch", pt.json?.applied === 1, pt.error ?? "");
      ok("select_scene", !(await call("select_scene", { scene: id })).error);
      await new Promise((r) => setTimeout(r, 600));
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
}

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

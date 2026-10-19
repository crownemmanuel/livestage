// Smoke test for the MCP server: starts it like an agent would, checks the tool list against the
// spec, and (when the app is running) exercises read-only tools.
//
//   node mcp/check.ts            tool list + read-only calls
//   node mcp/check.ts --build    also builds a scratch scene in the preview, screenshots it, deletes it
//
// The --build run never touches the live wall.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AGENT_COMMANDS } from "../src/agent/spec.ts";

const here = dirname(fileURLToPath(import.meta.url));
const build = process.argv.includes("--build");

const client = new Client({ name: "sls-mcp-check", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, "server.ts")], stderr: "inherit" }));

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
}

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

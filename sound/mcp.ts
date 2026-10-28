#!/usr/bin/env node
// LiveStage Sound MCP server: lets an agent run the radio mics through the running Sound app.
//
//   agent ⇄ (stdio, MCP) ⇄ this server ⇄ (HTTP 127.0.0.1:1450/api) ⇄ Sound service ⇄ dLive
//
// Every tool goes through the service's one command handler (the same one the operator screen, the
// backstage page and OSC from LiveStage use). Run: node sound/mcp.ts   (SOUND_HTTP_PORT to change port)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SOUND_HTTP_PORT } from "../shared/soundProtocol.ts";

const PORT = Number(process.env.SOUND_HTTP_PORT) || SOUND_HTTP_PORT;
const BASE = `http://127.0.0.1:${PORT}`;
const NOT_RUNNING = `The LiveStage Sound app is not running on port ${PORT}. Start it with \`pnpm sound\` (or \`pnpm sound:serve\`).`;

type Json = Record<string, unknown>;
interface Tool {
  description: string;
  command: string;
  params: Json;
  required?: string[];
  readOnly?: boolean;
  live?: boolean;
  destructive?: boolean;
  map?: (a: Json) => Json;
}

const who = { type: ["string", "integer"], description: "Mic number (3), character id, or character name (case-insensitive). A character resolves to their mic in the active scene." };
const scene = { type: "string", description: "Scene id (LiveStage's scene_…), code (7, 2.1) or name." };

export const SOUND_TOOLS: Record<string, Tool> = {
  status: { readOnly: true, command: "status", params: {}, description: "Desk link (connected / dry run / offline), the active scene and cue, every mic's live state as the desk reports it, effects, LiveStage and sync status. Start here." },
  list_scenes: { readOnly: true, command: "scenes.list", params: {}, description: "Scenes in running order: code, id, name, cast with mics, cue labels, which is live / next for backstage, and the backstage mic check (ok = checked these exact mics, stale = changed since, none)." },
  activate_scene: { live: true, command: "scene.activate", params: { scene }, required: ["scene"], description: "Make a scene active and apply its first cue: its cast's mics go live or muted as the cue says; mics of the previous scene that this one does not use are muted." },
  cue_go: { live: true, command: "cue.go", params: { scene: { ...scene, description: "Scene (default: the active scene)." }, cue: { type: ["integer", "string"], description: "1-based cue number, cue id, or cue label." } }, required: ["cue"], description: "Apply exactly one cue's mic and effect state." },
  next_cue: { live: true, command: "cue.next", params: {}, description: "Apply the active scene's next cue." },
  end_scene: { live: true, command: "scene.end", params: {}, description: "Mute every mic of the active scene, clear its effects and leave it." },
  mic: { live: true, command: "mic", params: { who, live: { type: "boolean", description: "true = live (unmuted), false = muted." } }, required: ["who", "live"], description: "Set one mic live or muted on the desk." },
  extra: { live: true, command: "extra", params: { extra: { type: ["string", "integer"], description: "Extra channel name (Dante 1), id, or desk input number." }, live: { type: "boolean" }, db: { type: ["number", "null"], description: "Fader in dB; null = off." } }, required: ["extra"], description: "Show-wide extra channels such as the Dante music players: mute / unmute and set the level." },
  level: { live: true, command: "level", params: { who, db: { type: ["number", "null"], description: "Fader in dB: 0 = unity, +10 max, null or ≤ −54 = off." } }, required: ["who", "db"], description: "Set one mic's fader level on the desk." },
  fx: { live: true, command: "fx", params: { who, preset: { type: "string", description: "Effect preset name or id, or 'none' to clear." }, amount: { enum: ["light", "medium", "full"], description: "Default: the current amount, else medium." } }, required: ["who", "preset"], description: "Put a voice effect on a mic (fades its FX sends), or clear it." },
  set_next_scene: { command: "scene.next", params: { scene: { type: ["string", "null"], description: "Scene id, code or name; null = follow the running order again." } }, required: ["scene"], description: "Tell backstage which scene to mic-check next; their phones move to it." },
  ask_recheck: { command: "scene.recheck", params: { scene }, required: ["scene"], description: "Clear a scene's backstage mic check so the crew checks it again." },
  panic: { live: true, destructive: true, command: "panic", params: {}, description: "MUTE ALL: mute every mic at once." },
};

async function api(command: string, args: Json): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(`${BASE}/api/cmd`, { method: "POST", headers: { "Content-Type": "application/json", "X-Sound-Source": "mcp" }, body: JSON.stringify({ cmd: command, args }), signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error(NOT_RUNNING);
  }
  const j = (await r.json()) as { ok: boolean; result?: unknown; error?: string };
  if (!j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j.result;
}

const mcp = new Server(
  { name: "livestage-sound", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions: [
      "Runs the actors' radio mics on the Allen & Heath dLive through the LiveStage Sound app.",
      "Call `status` first. Tools marked [LIVE] change what the audience hears: during a show, only use them when the operator asked. `panic` mutes every mic.",
      "Mic state in `status` is what the desk reports (someone on the desk surface may have changed it).",
    ].join("\n"),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(SOUND_TOOLS).map(([name, t]) => ({
    name,
    description: `${t.live ? "[LIVE] " : ""}${t.description}`,
    inputSchema: { type: "object" as const, properties: t.params, required: t.required, additionalProperties: false },
    annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: !!t.live },
  })),
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const t = SOUND_TOOLS[req.params.name];
  if (!t) return { content: [{ type: "text", text: `Unknown tool ${req.params.name}` }], isError: true };
  try {
    const args = (req.params.arguments ?? {}) as Json;
    const out = await api(t.command, t.map ? t.map(args) : args);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] };
  } catch (e) {
    return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
});

await mcp.connect(new StdioServerTransport());
console.error(`[sound-mcp] ready: ${Object.keys(SOUND_TOOLS).length} tools → ${BASE}`);
process.stdin.on("close", () => process.exit(0));

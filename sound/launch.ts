#!/usr/bin/env node
// `pnpm sound`: build the screens if they are missing or older than their sources, start the Sound
// service, and open the operator screen as an app window. When the service is already running (e.g. from
// the LaunchAgent), only the window opens.
//
//   node sound/launch.ts [--no-open] [--rebuild]

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOUND_HTTP_PORT } from "../shared/soundProtocol.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const port = Number(process.env.SOUND_HTTP_PORT) || SOUND_HTTP_PORT;
const open = !process.argv.includes("--no-open");

function newest(dir: string): number {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

const built = join(here, "dist", "index.html");
const sources = Math.max(newest(join(here, "ui")), statSync(join(here, "server", "model.ts")).mtimeMs, statSync(join(here, "server", "logic.ts")).mtimeMs);
if (process.argv.includes("--rebuild") || !existsSync(built) || statSync(built).mtimeMs < sources) {
  console.log("[sound] building the screens…");
  const vite = join(repo, "node_modules", "vite", "bin", "vite.js");
  const r = spawnSync(process.execPath, [vite, "build", "--config", join(here, "ui", "vite.config.ts"), "--logLevel", "warn"], { cwd: repo, stdio: "inherit" });
  if (r.status !== 0) {
    console.error("[sound] the build failed; starting with the previous screens (if any)");
  }
}

// Already running? Then just show it.
let running = false;
try {
  const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
  running = ((await r.json()) as { app?: string }).app === "livestage-sound";
} catch {
  /* not running */
}

if (running) {
  console.log(`[sound] already running on port ${port}`);
  if (open) {
    const { openAppWindow } = await import("./server/window.ts");
    openAppWindow(`http://localhost:${port}`, (m) => console.log(`[sound] ${m}`));
  }
} else {
  if (open) process.argv.push("--open");
  await import("./server/main.ts");
}

// Thin platform layer: Tauri when running as the desktop app, browser APIs
// when the UI is opened in a plain browser during development.

import type { Asset, AssetType, OutputSettings, Project } from "./types";
import { uid } from "./ids";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Safari / WKWebView (the macOS Tauri webview): plays HEVC alpha but not VP9 alpha. */
export const isWebKit =
  typeof navigator !== "undefined" && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);

/** The URL this webview should play for an asset (its HEVC-alpha twin on WebKit, when there is one). */
export function playableUrl(a: Asset | undefined | null): string | null {
  if (!a) return null;
  return isWebKit && a.macUrl ? a.macUrl : a.url;
}

export const windowRole: "operator" | "output" =
  typeof window !== "undefined" &&
  (location.pathname.endsWith("/output.html") ||
    new URLSearchParams(location.search).get("window") === "output" ||
    location.hash === "#output")
    ? "output"
    : "operator";

// ---------------------------------------------------------------- monitors

export interface MonitorInfo {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  primary: boolean;
}

export async function listMonitors(): Promise<MonitorInfo[]> {
  if (isTauri) {
    const { availableMonitors, primaryMonitor, currentMonitor } = await import("@tauri-apps/api/window");
    const [all, prim, cur] = await Promise.all([availableMonitors(), primaryMonitor(), currentMonitor()]);
    // Some macOS setups report an empty list from availableMonitors(); fall back to
    // the monitors we can still see so placement keeps working.
    const mons = all.length ? all : [prim, cur].filter((m, i, a): m is NonNullable<typeof m> => !!m && a.findIndex((x) => x?.name === m.name) === i);
    return mons.map((m, i) => ({
      name: m.name ?? `Display ${i + 1}`,
      x: m.position.x,
      y: m.position.y,
      width: m.size.width,
      height: m.size.height,
      scaleFactor: m.scaleFactor,
      primary: !!prim && prim.name === m.name && prim.position.x === m.position.x,
    }));
  }
  const s = window.screen;
  return [
    {
      name: "Browser screen",
      x: 0,
      y: 0,
      width: Math.round(s.width * devicePixelRatio),
      height: Math.round(s.height * devicePixelRatio),
      scaleFactor: devicePixelRatio,
      primary: true,
    },
  ];
}

// ---------------------------------------------------------------- output window

let browserOutput: Window | null = null;

export async function isOutputOpen(): Promise<boolean> {
  if (isTauri) {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    return !!(await WebviewWindow.getByLabel("output"));
  }
  return !!browserOutput && !browserOutput.closed;
}

export async function openOutputWindow(settings: OutputSettings): Promise<void> {
  outputClosedByUs = false;
  if (!isTauri) {
    if (!browserOutput || browserOutput.closed) {
      browserOutput = window.open(
        "/output.html",
        "sls-output",
        `popup,width=${settings.windowWidth},height=${settings.windowHeight}`,
      );
    }
    browserOutput?.focus();
    return;
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const { PhysicalPosition, LogicalSize } = await import("@tauri-apps/api/dpi");
  const { invoke } = await import("@tauri-apps/api/core");
  const monitors = await listMonitors();
  const mon =
    monitors.find((m) => m.name === settings.monitorName) ?? monitors.find((m) => !m.primary) ?? monitors[0];

  // Created natively so it shares the operator window's WebView settings (see lib.rs).
  const sf = mon?.scaleFactor ?? 1;
  await invoke("ensure_output_window", {
    x: mon ? mon.x / sf + 40 : 40,
    y: mon ? mon.y / sf + 40 : 40,
    width: settings.windowWidth,
    height: settings.windowHeight,
  });
  const win = await WebviewWindow.getByLabel("output");
  if (!win) throw new Error("Output window could not be created");
  await win.setFullscreen(false);
  if (mon) await win.setPosition(new PhysicalPosition(mon.x + (settings.fullscreen ? 0 : 40), mon.y + (settings.fullscreen ? 0 : 40)));
  if (!settings.fullscreen) await win.setSize(new LogicalSize(settings.windowWidth, settings.windowHeight));
  await win.show();
  if (settings.fullscreen) await win.setFullscreen(true);
}

/** Set while the operator closes the output on purpose, so the watchdog does not reopen it. */
export let outputClosedByUs = false;

export async function closeOutputWindow(): Promise<void> {
  outputClosedByUs = true;
  if (!isTauri) {
    browserOutput?.close();
    browserOutput = null;
    return;
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const win = await WebviewWindow.getByLabel("output");
  await win?.close();
}

// ---------------------------------------------------------------- persistence

const LS_KEY = "sls.project.v1";
const PROJECT_FILE = "project.json";

export async function loadProjectFile(): Promise<Project | null> {
  try {
    if (isTauri) {
      const fs = await import("@tauri-apps/plugin-fs");
      if (!(await fs.exists(PROJECT_FILE, { baseDir: fs.BaseDirectory.AppData }))) return null;
      return JSON.parse(await fs.readTextFile(PROJECT_FILE, { baseDir: fs.BaseDirectory.AppData }));
    }
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error("Failed to load project", e);
    return null;
  }
}

export async function saveProjectFile(p: Project): Promise<void> {
  const data = JSON.stringify(p);
  if (isTauri) {
    const fs = await import("@tauri-apps/plugin-fs");
    await fs.mkdir("", { baseDir: fs.BaseDirectory.AppData, recursive: true }).catch(() => {});
    // Write to a temp file then rename so a crash mid-save never corrupts the show file.
    await fs.writeTextFile(`${PROJECT_FILE}.tmp`, data, { baseDir: fs.BaseDirectory.AppData });
    await fs.rename(`${PROJECT_FILE}.tmp`, PROJECT_FILE, {
      oldPathBaseDir: fs.BaseDirectory.AppData,
      newPathBaseDir: fs.BaseDirectory.AppData,
    });
    return;
  }
  try {
    localStorage.setItem(LS_KEY, data);
  } catch (e) {
    console.warn("localStorage save failed (project too large?)", e);
  }
}

// ---------------------------------------------------------------- live state (crash / reload recovery)

const STATE_FILE = "state.json";
const LS_STATE = "sls.state.v1";

export async function loadStateFile<T>(): Promise<T | null> {
  try {
    if (isTauri) {
      const fs = await import("@tauri-apps/plugin-fs");
      if (!(await fs.exists(STATE_FILE, { baseDir: fs.BaseDirectory.AppData }))) return null;
      return JSON.parse(await fs.readTextFile(STATE_FILE, { baseDir: fs.BaseDirectory.AppData }));
    }
    const raw = localStorage.getItem(LS_STATE);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error("Failed to load live state", e);
    return null;
  }
}

export async function saveStateFile(state: unknown): Promise<void> {
  const data = JSON.stringify(state);
  if (isTauri) {
    const fs = await import("@tauri-apps/plugin-fs");
    await fs.writeTextFile(`${STATE_FILE}.tmp`, data, { baseDir: fs.BaseDirectory.AppData });
    await fs.rename(`${STATE_FILE}.tmp`, STATE_FILE, { oldPathBaseDir: fs.BaseDirectory.AppData, newPathBaseDir: fs.BaseDirectory.AppData });
    return;
  }
  try {
    localStorage.setItem(LS_STATE, data);
  } catch {
    /* quota: live state is best effort */
  }
}

/** Export the show file to a user-chosen location. */
export async function exportProject(p: Project): Promise<string | null> {
  const data = JSON.stringify(p, null, 2);
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const fs = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: "salvation-show.slsproj.json", filters: [{ name: "Show file", extensions: ["json"] }] });
    if (!path) return null;
    await fs.writeTextFile(path, data);
    return path;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  a.download = "salvation-show.slsproj.json";
  a.click();
  return a.download;
}

export async function importProject(): Promise<Project | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const fs = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, filters: [{ name: "Show file", extensions: ["json"] }] });
    if (!path || Array.isArray(path)) return null;
    return JSON.parse(await fs.readTextFile(path));
  }
  const file = await pickBrowserFiles(".json", false);
  return file[0] ? JSON.parse(await file[0].text()) : null;
}

// ---------------------------------------------------------------- assets

const EXT: Record<AssetType, string[]> = {
  image: ["png", "jpg", "jpeg", "webp", "avif", "gif"],
  video: ["mp4", "webm", "mov", "m4v"],
  model: ["glb", "gltf"],
  audio: ["mp3", "wav", "ogg", "m4a", "aac", "flac"],
};

export function assetTypeFor(name: string): AssetType | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  for (const t of Object.keys(EXT) as AssetType[]) if (EXT[t].includes(ext)) return t;
  return null;
}

function pickBrowserFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

/**
 * Import media into the asset library. In the desktop app files are copied
 * into the app data folder so the show keeps working if the originals move.
 */
export async function importAssets(only?: AssetType): Promise<Asset[]> {
  const types = only ? [only] : (Object.keys(EXT) as AssetType[]);
  const exts = types.flatMap((t) => EXT[t]);
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const fs = await import("@tauri-apps/plugin-fs");
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const picked = await open({ multiple: true, filters: [{ name: "Media", extensions: exts }] });
    if (!picked) return [];
    const paths = Array.isArray(picked) ? picked : [picked];
    const dir = await join(await appDataDir(), "assets");
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const out: Asset[] = [];
    for (const src of paths) {
      const name = src.split(/[\\/]/).pop() ?? "asset";
      const type = assetTypeFor(name);
      if (!type) continue;
      const id = uid("asset");
      const fileName = `${id}_${name}`;
      const dest = await join(dir, fileName);
      await fs.copyFile(src, dest);
      out.push({ id, name, type, url: convertFileSrc(dest), path: dest, file: `assets/${fileName}`, hasAlpha: guessAlpha(name) });
    }
    return out;
  }
  const files = await pickBrowserFiles(exts.map((e) => `.${e}`).join(","), true);
  return files.flatMap((f) => {
    const type = assetTypeFor(f.name);
    if (!type) return [];
    return [{ id: uid("asset"), name: f.name, type, url: URL.createObjectURL(f), ephemeral: true, hasAlpha: guessAlpha(f.name) }];
  });
}

/** Store generated media (e.g. a text-to-speech MP3) in the library like an imported file. */
export async function saveGeneratedAsset(bytes: Uint8Array, name: string, type: AssetType): Promise<Asset> {
  const id = uid("asset");
  if (isTauri) {
    const fs = await import("@tauri-apps/plugin-fs");
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const dir = await join(await appDataDir(), "assets");
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const fileName = `${id}_${name.replace(/[\\/:*?"<>|]/g, "-")}`;
    const dest = await join(dir, fileName);
    await fs.writeFile(dest, bytes);
    return { id, name, type, url: convertFileSrc(dest), path: dest, file: `assets/${fileName}` };
  }
  const blob = new Blob([bytes as BlobPart], { type: type === "audio" ? "audio/mpeg" : "application/octet-stream" });
  return { id, name, type, url: URL.createObjectURL(blob), ephemeral: true };
}

function guessAlpha(name: string) {
  const n = name.toLowerCase();
  return n.endsWith(".png") || n.endsWith(".webp") || n.endsWith(".webm") || n.includes("alpha");
}

/** Bundled media URLs ("/media/…") that are files in the repo's public/ folder (development builds; else none). */
export async function bundledOnDisk(urls: (string | undefined)[]): Promise<Set<string>> {
  const list = [...new Set(urls.filter((u): u is string => !!u && u.startsWith("/media/")))];
  if (!isTauri || !list.length) return new Set();
  const { invoke } = await import("@tauri-apps/api/core");
  const found = await invoke<boolean[]>("bundled_on_disk", { urls: list });
  return new Set(list.filter((_, i) => found[i]));
}

/** The portable key of a library file from its absolute path (show files from before keys existed). */
function legacyKey(path: string, root: string): string {
  const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = norm(path);
  const r = norm(root);
  if (p.toLowerCase().startsWith(r.toLowerCase() + "/")) return p.slice(r.length + 1);
  // A path from another computer: the file may have been copied into this one's library.
  return `assets/${p.split("/").pop()}`;
}

/**
 * Point assets at the files on this machine (asset protocol URLs depend on the install path). An asset
 * with a portable `file` key plays its local copy when there is one; media that ships with the app
 * (`/media/…`) falls back to the bundled file.
 */
export async function resolveAssetUrls(assets: Asset[]): Promise<Asset[]> {
  if (!isTauri) return assets;
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  // On the build computer (development build) media in the repo's public/ folder wins over local copies.
  const onDisk = await bundledOnDisk(assets.flatMap((a) => [a.url, a.macUrl]));
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  const fs = await import("@tauri-apps/plugin-fs");
  const root = await appDataDir();
  const local = async (key: string | undefined) => {
    if (!key) return null;
    const ok = await fs.exists(key, { baseDir: fs.BaseDirectory.AppData }).catch(() => false);
    return ok ? join(root, ...key.split("/")) : null;
  };
  return Promise.all(
    assets.map(async (a) => {
      const file = a.file ?? (a.path ? legacyKey(a.path, root) : undefined);
      const [p, mp] = await Promise.all([onDisk.has(a.url) ? null : local(file), a.macUrl && onDisk.has(a.macUrl) ? null : local(a.macFile)]);
      const out: Asset = { ...a };
      if (file) out.file = file;
      if (p) {
        out.path = p;
        out.url = convertFileSrc(p);
      } else if (a.path) out.url = convertFileSrc(a.path);
      if (mp) out.macUrl = convertFileSrc(mp);
      return out;
    }),
  );
}

// Files on disk: ~/Library/Application Support/LiveStage Sound/ (SOUND_DATA_DIR overrides, e.g. for tests).
// Every write goes to a temp file first and is then renamed over the old one, so a crash never leaves half a file.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { demoShow, migrateSettings, migrateShow, defaultSettings, type Settings, type SoundShow } from "./model.ts";

function defaultDir() {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "LiveStage Sound");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "LiveStage Sound");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "livestage-sound");
}

export const DATA_DIR = process.env.SOUND_DATA_DIR || defaultDir();
export const PHOTO_DIR = join(DATA_DIR, "photos");
const SHOW_FILE = join(DATA_DIR, "show.json");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const LIVE_FILE = join(DATA_DIR, "live.json");

mkdirSync(PHOTO_DIR, { recursive: true });

export function writeAtomic(file: string, data: string | Uint8Array) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function readJson(file: string): unknown | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function loadShow(log: (m: string) => void): SoundShow {
  try {
    const raw = readJson(SHOW_FILE);
    if (raw === undefined) {
      const demo = demoShow();
      saveShow(demo);
      log("first start: seeded the demo show");
      return demo;
    }
    return migrateShow(raw);
  } catch (e) {
    // Keep the unreadable file for a human to look at, and start from the demo rather than not at all.
    const keep = `${SHOW_FILE}.broken-${Date.now()}`;
    try {
      copyFileSync(SHOW_FILE, keep);
    } catch {
      /* nothing to keep */
    }
    log(`show.json could not be read (${e instanceof Error ? e.message : e}); kept it as ${keep} and started from the demo show`);
    return demoShow();
  }
}

export function saveShow(show: SoundShow) {
  writeAtomic(SHOW_FILE, JSON.stringify(show, null, 1));
}

export function loadSettings(log: (m: string) => void): Settings {
  try {
    const raw = readJson(SETTINGS_FILE);
    return raw === undefined ? defaultSettings() : migrateSettings(raw);
  } catch (e) {
    log(`settings.json could not be read (${e instanceof Error ? e.message : e}); using defaults`);
    return defaultSettings();
  }
}

export function saveSettings(s: Settings) {
  writeAtomic(SETTINGS_FILE, JSON.stringify(s, null, 1));
}

/** What was live when the app last ran: shown again after a restart, never re-sent to the desk on its own. */
export interface LiveFile {
  activeSceneId: string | null;
  /** The scene backstage was told to check next, when the operator set it. */
  nextSceneId?: string | null;
  nextPinned?: boolean;
  cue: number;
  fx: Record<string, { preset: string; amount: "light" | "medium" | "full" }>;
  /** Send levels from before an effect took them over, per mic → send key, so clearing puts them back. */
  bases: Record<string, Record<string, number>>;
  savedAt: number;
}

export function loadLive(): LiveFile | null {
  try {
    const raw = readJson(LIVE_FILE) as LiveFile | undefined;
    if (!raw || typeof raw !== "object") return null;
    // Older than a day: a previous show, not this one.
    if (Date.now() - (raw.savedAt ?? 0) > 24 * 3600 * 1000) return null;
    return { activeSceneId: raw.activeSceneId ?? null, nextSceneId: raw.nextSceneId ?? null, nextPinned: !!raw.nextPinned, cue: raw.cue ?? -1, fx: raw.fx ?? {}, bases: raw.bases ?? {}, savedAt: raw.savedAt };
  } catch {
    return null;
  }
}

export function saveLive(l: LiveFile) {
  writeAtomic(LIVE_FILE, JSON.stringify(l));
}

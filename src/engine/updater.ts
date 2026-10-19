// App updates from the GitHub releases (docs/RELEASES.md).
//
// Nothing here downloads, installs or restarts on its own. The background check only tells the
// operator that a new version exists; installing is always the operator's (or an agent's, when
// the operator asked) explicit action, and it is refused while a scene is live on the wall: the
// restart closes the audience output.

import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { isTauri } from "@/core/platform";
import { useProject } from "@/store/project";
import { isLive } from "./showTransfer";

export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "error";

export interface AvailableUpdate {
  version: string;
  date?: string;
  notes?: string;
}

interface UpdaterState {
  /** This app's version (null until read, or outside the desktop app). */
  current: string | null;
  phase: UpdatePhase;
  available: AvailableUpdate | null;
  checkedAt: number | null;
  /** Bytes of the update downloaded so far (total 0 = unknown). */
  progress: { done: number; total: number } | null;
  error: string | null;
  /** More → Check for updates. */
  dialogOpen: boolean;
}

export const useUpdater = create<UpdaterState>(() => ({
  current: null,
  phase: "idle",
  available: null,
  checkedAt: null,
  progress: null,
  error: null,
  dialogOpen: false,
}));

const set = useUpdater.setState;
let pending: Update | null = null;
let downloaded = false;

const message = (e: unknown) => {
  const text = e instanceof Error ? e.message : String(e);
  // No release published yet, or the repository is private / unreachable.
  if (/valid release JSON|404/i.test(text)) return "No published release found on GitHub yet.";
  return text;
};

/** Why an update cannot be installed right now, or null when it can. */
export function installBlocker(): string | null {
  if (!isTauri) return "Updates install in the desktop app.";
  if (import.meta.env.DEV) return "This is a development build (pnpm tauri dev): update it from git. Installed copies of the app update here.";
  if (isLive()) return "A scene is live on the wall. Put the wall on Standby to install the update.";
  return null;
}

export function openUpdates() {
  set({ dialogOpen: true });
  const s = useUpdater.getState();
  const busy = s.phase === "checking" || s.phase === "downloading" || s.phase === "installing";
  if (!busy && (!s.checkedAt || Date.now() - s.checkedAt > 60_000)) void checkForUpdate().catch(() => {});
}

let checking: Promise<AvailableUpdate | null> | null = null;

/** Ask GitHub whether a newer version exists. Downloads nothing. `quiet`: a failure leaves no trace. */
export function checkForUpdate({ quiet = false } = {}): Promise<AvailableUpdate | null> {
  if (!isTauri) return Promise.reject(new Error("Updates are checked by the desktop app"));
  const s = useUpdater.getState();
  if (s.phase === "downloading" || s.phase === "installing") return Promise.resolve(s.available);
  if (!quiet) set({ phase: "checking", error: null });
  checking ??= (async () => {
    try {
      if (!useUpdater.getState().current) set({ current: await getVersion() });
      const u = await check({ timeout: 30_000 });
      if (u && pending && downloaded && u.version === pending.version) {
        void u.close().catch(() => {}); // keep the one already downloaded
      } else {
        void pending?.close().catch(() => {});
        pending = u;
        downloaded = false;
      }
      const available = pending ? { version: pending.version, date: pending.date, notes: pending.body?.trim() || undefined } : null;
      set({ phase: !pending ? "current" : downloaded ? "ready" : "available", available, checkedAt: Date.now(), error: null });
      return available;
    } finally {
      checking = null;
    }
  })();
  return checking.catch((e) => {
    if (!quiet) set({ phase: "error", error: message(e), checkedAt: Date.now() });
    throw new Error(message(e));
  });
}

const fail = (e: unknown): never => {
  set({ phase: "error", progress: null, error: message(e) });
  throw new Error(message(e));
};

/** Download the update found by the last check (once). Refused while a scene is live. */
export async function downloadUpdate(version?: string): Promise<void> {
  const blocker = installBlocker();
  if (blocker) throw new Error(blocker);
  const u = pending;
  if (!u) throw new Error("No update to install. Check for updates first.");
  if (version && version !== u.version) throw new Error(`The available update is ${u.version}, not ${version}. Check again.`);
  const phase = useUpdater.getState().phase;
  if (phase === "downloading" || phase === "installing") throw new Error("The update is already downloading or installing");
  if (downloaded) return;
  set({ phase: "downloading", progress: { done: 0, total: 0 }, error: null });
  let done = 0;
  try {
    await u.download((ev) => {
      if (ev.event === "Started") set({ progress: { done: 0, total: ev.data.contentLength ?? 0 } });
      else if (ev.event === "Progress") {
        done += ev.data.chunkLength;
        set((s) => ({ progress: { done, total: s.progress?.total ?? 0 } }));
      }
    });
  } catch (e) {
    fail(e);
  }
  downloaded = true;
  set({ phase: "ready", progress: null });
}

/** Install the downloaded update and restart the app. Checks again that nothing is live. */
export async function applyUpdate(): Promise<void> {
  const blocker = installBlocker();
  if (blocker) throw new Error(blocker);
  const u = pending;
  if (!u || !downloaded) throw new Error("The update is not downloaded yet");
  set({ phase: "installing", error: null });
  try {
    await useProject.getState().save();
    // On Windows the installer closes the app and starts the new version itself.
    await u.install();
    await relaunch();
  } catch (e) {
    fail(e);
  }
}

/**
 * The operator's Install and restart. `stillWanted` is asked once the download is done: when it
 * says no, or a scene went live meanwhile, the update waits downloaded ("ready") for another Install.
 */
export async function installUpdate({ version, stillWanted = () => true }: { version?: string; stillWanted?: () => boolean } = {}): Promise<"restarting" | "downloaded"> {
  await downloadUpdate(version);
  if (installBlocker() || !stillWanted()) return "downloaded";
  await applyUpdate();
  return "restarting";
}

/** Operator window, installed app only: look for a new version shortly after start, then every few hours. */
export function startUpdateChecks(): () => void {
  if (!isTauri || import.meta.env.DEV) return () => {};
  const run = () => void checkForUpdate({ quiet: true }).catch(() => {});
  const first = setTimeout(run, 20_000);
  const every = setInterval(run, 6 * 3600_000);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

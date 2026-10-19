// Moving the show between computers: show packages and cloud sync, as operations the
// operator UI and the agent both use. Taking in another version never happens silently while a scene
// is live on the wall: the caller has to say so.

import { loadCloudSettings, pushShow, readCloudVersion, type CloudSettings } from "@/core/cloud";
import { exportPackage, importPackage, previewImport, readPackage, type ImportOptions, type ImportPreview, type IncomingPackage } from "@/core/showPackage";
import { migrateProject, useProject } from "@/store/project";
import { useShow } from "@/store/show";

/** A scene is on the wall (not standby). */
export function isLive(): boolean {
  const p = useShow.getState().program;
  return !!p.runtime && !p.standby;
}

export async function exportShowPackage(dir: string) {
  const P = useProject.getState();
  await P.save();
  const res = await exportPackage(P.project, dir);
  // Remember the version just sent, so the next one counts on from it.
  useProject.getState().update((p) => {
    p.lineage = res.project.lineage;
  });
  await useProject.getState().save();
  return { dir: res.dir, version: res.version, files: res.files, megabytes: Math.round(res.bytes / 1e5) / 10, missing: res.missing };
}

export async function openShowPackage(dir: string): Promise<{ pkg: IncomingPackage; preview: ImportPreview }> {
  const pkg = await readPackage(dir, migrateProject);
  return { pkg, preview: previewImport(useProject.getState().project, pkg) };
}

export class LiveShowError extends Error {
  constructor(what: "take-in" | "push" = "take-in") {
    super(
      what === "push"
        ? "A scene is live on the wall. Uploading now competes with playback for disk and network; confirm to push anyway."
        : "A scene is live on the wall. Taking in another version now could change media that is playing; confirm to do it anyway.",
    );
  }
}

export async function takeInShowPackage(pkg: IncomingPackage, opts: ImportOptions & { allowLive?: boolean }) {
  if (isLive() && !opts.allowLive) throw new LiveShowError();
  const P = useProject.getState();
  await P.save();
  const res = await importPackage(P.project, pkg, opts);
  await useProject.getState().replaceProject(res.project);
  await useProject.getState().save();
  return { version: pkg.manifest.version, via: pkg.via ?? "package", scenes: res.project.scenes.length, copied: res.copied, alreadyHere: res.skipped, failed: res.failed, missing: res.missing, keptOwnDiffering: res.keptOwnDiffering };
}

// ---------------------------------------------------------------- cloud sync

export async function cloudSettingsOrThrow(): Promise<CloudSettings> {
  const s = await loadCloudSettings();
  if (!s) throw new Error("Cloud sync is off: enter the Firebase project's keys in More → Cloud sync");
  if (!s.refreshToken) throw new Error("Not signed in to the cloud: sign in under More → Cloud sync");
  return s;
}

/** Send this show as the next cloud version. A live scene needs `allowLive` (uploading competes with playback). */
export async function cloudPush(opts: { allowLive?: boolean; force?: boolean } = {}) {
  if (isLive() && !opts.allowLive) throw new LiveShowError("push");
  const s = await cloudSettingsOrThrow();
  const P = useProject.getState();
  await P.save();
  const res = await pushShow(s, P.project, { force: opts.force });
  useProject.getState().update((p) => {
    p.lineage = res.project.lineage;
  });
  await useProject.getState().save();
  return { version: res.version, uploaded: res.uploaded, alreadyInCloud: res.alreadyThere, megabytesUploaded: res.megabytesUploaded, missing: res.missing };
}

/** Read the current cloud version (nothing changes) and plan the merge, like opening a package. */
export async function cloudOpen(showId?: string): Promise<{ pkg: IncomingPackage; preview: ImportPreview }> {
  const s = await cloudSettingsOrThrow();
  const pkg = await readCloudVersion(s, showId ?? useProject.getState().project.lineage?.showId, migrateProject);
  return { pkg, preview: previewImport(useProject.getState().project, pkg) };
}

// Moving the show between computers: show packages (and, later, cloud sync) as operations the
// operator UI and the agent both use. Taking in another version never happens silently while a scene
// is live on the wall: the caller has to say so.

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
  constructor() {
    super("A scene is live on the wall. Taking in another version now could change media that is playing; confirm to do it anyway.");
  }
}

export async function takeInShowPackage(pkg: IncomingPackage, opts: ImportOptions & { allowLive?: boolean }) {
  if (isLive() && !opts.allowLive) throw new LiveShowError();
  const P = useProject.getState();
  await P.save();
  const res = await importPackage(P.project, pkg, opts);
  await useProject.getState().replaceProject(res.project);
  await useProject.getState().save();
  return { version: pkg.manifest.version, scenes: res.project.scenes.length, copied: res.copied, alreadyHere: res.skipped, failed: res.failed, missing: res.missing };
}

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { isTauri } from "@/core/platform";
import { levelDifferences, SOUND_LEVELS, type MergeChoice, type MergeItem } from "@/core/showMerge";
import type { Project } from "@/core/types";
import { defaultPackageName, onPackageProgress, PACKAGE_EXT, previewImport, type ImportPreview, type IncomingPackage } from "@/core/showPackage";
import { exportShowPackage, isLive, openShowPackage, takeInShowPackage } from "@/engine/showTransfer";
import { useProject } from "@/store/project";

type State =
  | { kind: "idle" }
  | { kind: "working"; title: string }
  | { kind: "exported"; result: Awaited<ReturnType<typeof exportShowPackage>> }
  | { kind: "review"; pkg: IncomingPackage; preview: ImportPreview }
  | { kind: "imported"; result: Awaited<ReturnType<typeof takeInShowPackage>> }
  | { kind: "levels"; project: Project; differ: number }
  | { kind: "error"; message: string };

const useDialog = create<{ state: State; set(s: State): void }>((set) => ({ state: { kind: "idle" }, set: (state) => set({ state }) }));

/** More menu → Import show file…: replaces the show; asks first when its sound levels differ from this computer's. */
export async function startShowFileImport(p: Project) {
  const differ = levelDifferences(useProject.getState().project.mix, p.mix);
  if (differ) useDialog.getState().set({ kind: "levels", project: p, differ });
  else await useProject.getState().replaceProject(p);
}

/** More menu → Export show package…: pick where, then write it. */
export async function startPackageExport() {
  const { set } = useDialog.getState();
  if (!isTauri) return set({ kind: "error", message: "Show packages are written by the desktop app (the browser cannot copy media files)." });
  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({ title: "Export show package", defaultPath: defaultPackageName(useProject.getState().project) });
  if (!picked) return;
  const dir = picked.endsWith(`.${PACKAGE_EXT}`) ? picked : `${picked.replace(/\.json$/i, "")}.${PACKAGE_EXT}`;
  set({ kind: "working", title: "Writing the show package…" });
  try {
    set({ kind: "exported", result: await exportShowPackage(dir) });
  } catch (e) {
    set({ kind: "error", message: String(e) });
  }
}

/** More menu → Import show package…: pick the folder (or open `dir`), then review before anything changes. */
export async function startPackageImport(dir?: string) {
  const { set } = useDialog.getState();
  if (!isTauri) return set({ kind: "error", message: "Show packages are opened by the desktop app (the browser cannot copy media files)." });
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = dir ?? (await open({ title: `Choose a show package (.${PACKAGE_EXT} folder)`, directory: true, multiple: false }));
  if (!picked || Array.isArray(picked)) return;
  set({ kind: "working", title: "Reading the package…" });
  try {
    const { pkg, preview } = await openShowPackage(picked);
    set({ kind: "review", pkg, preview });
  } catch (e) {
    set({ kind: "error", message: String(e) });
  }
}

/** Show the review (versions, conflicts, choices) for an incoming version that is already read (a package or a cloud version). */
export function showIncoming(pkg: IncomingPackage) {
  useDialog.getState().set({ kind: "review", pkg, preview: previewImport(useProject.getState().project, pkg) });
}

const CHOICE_LABEL: Record<MergeChoice, string> = { incoming: "Take incoming", local: "Keep mine", media: "Keep mine + add its media", both: "Keep both" };

function choiceLabel(it: MergeItem, c: MergeChoice) {
  if (it.upstream === "removed") return c === "incoming" ? "Remove it" : "Keep it";
  if (it.here === "removed") return c === "incoming" ? "Restore it" : "Leave it removed";
  return CHOICE_LABEL[c];
}

function what(it: MergeItem) {
  const s = (w: MergeItem["here"]) => (w === "unchanged" ? "unchanged" : w);
  return `Here: ${s(it.here)} · incoming: ${s(it.upstream)}`;
}

export function PackageProgress() {
  const [p, setP] = useState<{ done: number; total: number; key: string } | null>(null);
  useEffect(() => {
    let off = () => {};
    void onPackageProgress(setP).then((f) => (off = f));
    return () => off();
  }, []);
  if (!p || !p.total) return null;
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded bg-well">
        <div className="h-full bg-preview transition-[width]" style={{ width: `${(100 * p.done) / p.total}%` }} />
      </div>
      <div className="truncate text-[11px] text-muted-foreground tabular">
        {p.done} / {p.total} {p.key}
      </div>
    </div>
  );
}

function Review({ pkg, preview }: { pkg: IncomingPackage; preview: ImportPreview }) {
  const set = useDialog((s) => s.set);
  const here = useProject((s) => s.project.lineage);
  const [mode, setMode] = useState<"merge" | "replace">(preview.unrelated ? "replace" : "merge");
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({});
  const [allowLive, setAllowLive] = useState(false);
  const live = isLive();
  const m = pkg.manifest;
  const items = preview.plan.items;
  // This computer's sound levels are asked about on their own, in both modes.
  const levels = items.find((x) => x.key === SOUND_LEVELS && x.state === "conflict");
  const levelsDiffer = levelDifferences(useProject.getState().project.mix, pkg.show.mix);
  const conflicts = items.filter((x) => x.state === "conflict" && x !== levels);
  const incoming = items.filter((x) => x.state === "incoming");
  const local = items.filter((x) => x.state === "local");
  const same = items.filter((x) => x.state === "same").length;
  const mb = Math.round(m.files.reduce((n, f) => n + f.size, 0) / 1e5) / 10;

  const go = async () => {
    set({ kind: "working", title: pkg.via === "cloud" ? "Downloading media and taking in the show…" : "Copying media and taking in the show…" });
    try {
      set({ kind: "imported", result: await takeInShowPackage(pkg, { mode, choices, allowLive }) });
    } catch (e) {
      set({ kind: "error", message: String(e) });
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          Take in “{m.showName}” v{m.version}
        </DialogTitle>
        <DialogDescription>
          {pkg.via === "cloud" ? "From the cloud. " : ""}Made on a {m.from}, {new Date(m.createdAt).toLocaleString()}. {m.files.length} media files, {mb} MB.{" "}
          {here?.showId === m.showId && (here.received || here.sent)
            ? `This computer ${[here.received && `last took in v${here.received.version}`, here.sent && `last sent v${here.sent}`].filter(Boolean).join(" and ")}.`
            : "This computer's show has never taken in a version of this show."}
        </DialogDescription>
      </DialogHeader>

      {preview.older && (
        <p className="flex gap-2 rounded-md border border-armed/40 bg-armed/10 p-2 text-[12px]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-armed" /> This computer already has this version (it was sent from here or taken in before).
        </p>
      )}
      {m.missing.length > 0 && (
        <p className="flex gap-2 rounded-md border border-armed/40 bg-armed/10 p-2 text-[12px]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-armed" /> {m.missing.length} media file(s) were missing when it was made: {m.missing.slice(0, 4).join(", ")}
          {m.missing.length > 4 ? "…" : ""}
        </p>
      )}

      <div className="flex gap-1">
        <Button size="sm" variant={mode === "merge" ? "secondary" : "outline"} onClick={() => setMode("merge")}>
          Merge (keep what changed here)
        </Button>
        <Button size="sm" variant={mode === "replace" ? "secondary" : "outline"} onClick={() => setMode("replace")}>
          Replace the whole show
        </Button>
      </div>

      {levels && (
        <div className="rounded-md border border-armed/40 p-2 text-[12px]">
          <div className="font-semibold">Sound levels</div>
          <p className="mt-0.5 text-muted-foreground">
            {levelsDiffer} live mixer level{levelsDiffer === 1 ? "" : "s"} set on this computer differ{levelsDiffer === 1 ? "s" : ""} from the incoming version's{levels.upstream === "unchanged" ? " (it did not change its levels)" : ""}. Which should the show use?
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {(["local", "incoming"] as const).map((o) => {
              const on = (choices[SOUND_LEVELS] ?? "local") === o;
              return (
                <Button key={o} size="xs" variant={on ? "secondary" : "outline"} className={cn(on && "ring-1 ring-preview")} onClick={() => setChoices({ ...choices, [SOUND_LEVELS]: o })}>
                  {o === "local" ? "Keep this computer's levels" : `Use the ${pkg.via === "cloud" ? "cloud's" : "package's"} levels`}
                </Button>
              );
            })}
          </div>
        </div>
      )}

      {mode === "replace" ? (
        <p className="text-[12px] text-muted-foreground">
          Every scene, cue and setting is replaced by the incoming version{preview.unrelated ? "" : `, including ${local.length + conflicts.length} change(s) made on this computer`}. This computer's
          output display and MIDI ports stay as they are.
        </p>
      ) : (
        <div className="space-y-3 text-[12px]">
          {conflicts.length > 0 && (
            <div className="space-y-1.5">
              <div className="font-semibold text-armed">Changed on both sides ({conflicts.length}): choose for each</div>
              {conflicts.map((it) => {
                const c = choices[it.key] ?? it.choice;
                return (
                  <div key={it.key} className="rounded-md border border-armed/40 p-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{it.label}</span>
                      <span className="text-[11px] text-muted-foreground">{what(it)}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {it.options.map((o) => (
                        <Button key={o} size="xs" variant={c === o ? "secondary" : "outline"} className={cn(c === o && "ring-1 ring-preview")} onClick={() => setChoices({ ...choices, [it.key]: o })}>
                          {choiceLabel(it, o)}
                        </Button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {incoming.length > 0 && (
            <div>
              <div className="font-semibold">Updated from the {pkg.via === "cloud" ? "cloud" : "package"} ({incoming.length})</div>
              <div className="text-muted-foreground">{incoming.map((x) => `${x.label}${x.upstream === "removed" ? " (removed)" : x.upstream === "added" ? " (new)" : ""}`).join(" · ")}</div>
            </div>
          )}
          {local.length > 0 && (
            <div>
              <div className="font-semibold">Kept as changed on this computer ({local.length})</div>
              <div className="text-muted-foreground">{local.map((x) => x.label).join(" · ")}</div>
            </div>
          )}
          <div className="text-muted-foreground">{same} unchanged. New media is added to the library either way.</div>
        </div>
      )}

      {live && (
        <label className="flex items-start gap-2 rounded-md border border-live/50 bg-live/10 p-2 text-[12px]">
          <input type="checkbox" className="mt-0.5" checked={allowLive} onChange={(e) => setAllowLive(e.target.checked)} />
          <span>A scene is live on the wall. Media it is playing may be replaced. Take it in anyway.</span>
        </label>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={() => set({ kind: "idle" })}>
          Cancel
        </Button>
        <Button variant={mode === "replace" ? "destructive" : "default"} disabled={live && !allowLive} onClick={() => void go()}>
          {mode === "replace" ? "Replace show" : conflicts.length ? `Merge with ${conflicts.length} choice(s)` : "Merge"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function ShowPackageDialog() {
  const { state, set } = useDialog();
  const open = state.kind !== "idle";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && state.kind !== "working" && set({ kind: "idle" })}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[640px]">
        {state.kind === "working" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" /> {state.title}
              </DialogTitle>
              <DialogDescription>Large video takes a while. Keep the app open.</DialogDescription>
            </DialogHeader>
            <PackageProgress />
          </>
        )}
        {state.kind === "review" && <Review pkg={state.pkg} preview={state.preview} />}
        {state.kind === "exported" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-preview" /> Show package v{state.result.version} written
              </DialogTitle>
              <DialogDescription className="break-all">{state.result.dir}</DialogDescription>
            </DialogHeader>
            <p className="text-[12px]">
              {state.result.files} media files, {state.result.megabytes} MB. Copy the whole folder to the other computer and choose More → Import show package.
            </p>
            {state.result.missing.length > 0 && (
              <p className="flex gap-2 text-[12px] text-armed">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> Not included (file not found): {state.result.missing.join(", ")}
              </p>
            )}
            <DialogFooter>
              <Button onClick={() => set({ kind: "idle" })}>Done</Button>
            </DialogFooter>
          </>
        )}
        {state.kind === "imported" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-preview" /> Took in v{state.result.version}
              </DialogTitle>
              <DialogDescription>
                {state.result.scenes} scenes. {state.result.copied} media files {state.result.via === "cloud" ? "downloaded" : "copied"}, {state.result.alreadyHere} already here.
              </DialogDescription>
            </DialogHeader>
            {(state.result.failed.length > 0 || state.result.missing.length > 0 || state.result.keptOwnDiffering.length > 0) && (
              <div className="space-y-1 text-[12px] text-armed">
                {state.result.failed.map((f) => (
                  <div key={f.key}>
                    Could not copy {f.key}: {f.error}
                  </div>
                ))}
                {state.result.missing.length > 0 && <div>Not in the package: {state.result.missing.join(", ")}</div>}
                {state.result.keptOwnDiffering.length > 0 && (
                  <div>
                    Kept this computer's own version of {state.result.keptOwnDiffering.length} media file(s) in public/media, which differ from the incoming ones (a development build uses its repo's media):{" "}
                    {state.result.keptOwnDiffering.join(", ")}
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              <Button onClick={() => set({ kind: "idle" })}>Done</Button>
            </DialogFooter>
          </>
        )}
        {state.kind === "levels" && <LevelsChoice project={state.project} differ={state.differ} />}
        {state.kind === "error" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="size-4 text-destructive" /> Show package
              </DialogTitle>
              <DialogDescription className="break-words">{state.message}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => set({ kind: "idle" })}>Close</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Importing a show file whose sound levels differ from this computer's: which levels to keep. */
function LevelsChoice({ project, differ }: { project: Project; differ: number }) {
  const set = useDialog((s) => s.set);
  const take = async (keepMine: boolean) => {
    set({ kind: "idle" });
    await useProject.getState().replaceProject(keepMine ? { ...project, mix: useProject.getState().project.mix } : project);
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Import “{project.name}”: sound levels</DialogTitle>
        <DialogDescription>
          The show file replaces the whole show. {differ} of the live mixer levels on this computer differ from the levels saved in the file. Which levels should the show use?
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={() => set({ kind: "idle" })}>
          Cancel
        </Button>
        <Button variant="outline" onClick={() => void take(false)}>
          Use the file's levels
        </Button>
        <Button onClick={() => void take(true)}>Keep this computer's levels</Button>
      </DialogFooter>
    </>
  );
}

import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startProgramAudio, unlockAudio } from "@/engine/audio";
import { cueControl, startOperatorServices, takeScene } from "@/engine/operator";
import { useProject } from "@/store/project";
import { useShow } from "@/store/show";
import { TopBar } from "@/ui/TopBar";
import { ShowMode } from "@/ui/show/ShowMode";
import { BuilderMode } from "@/ui/builder/BuilderMode";
import { preloadPhotoAssets } from "@/render/env/photoreal/shared";

function syncPreview() {
  const { project, selectedSceneId } = useProject.getState();
  const scene = project.scenes.find((s) => s.id === selectedSceneId) ?? null;
  useShow.getState().setPreview(scene, { keepState: true });
}

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

export function OperatorApp() {
  const loaded = useProject((s) => s.loaded);
  const mode = useProject((s) => s.mode);

  useEffect(() => {
    preloadPhotoAssets();
    void useProject
      .getState()
      .load()
      .then(syncPreview)
      .then(async () => {
        if (import.meta.env.DEV && import.meta.env.VITE_SLS_SELFTEST) (await import("@/dev/selftest")).runSelfTest();
      });
    const stopServices = startOperatorServices();
    const stopAudio = startProgramAudio(() => {
      const s = useShow.getState();
      const outputUp = !!s.outputStatus && Date.now() - s.outputSeenAt < 3500;
      return s.output.audioHost === "operator" || !outputUp;
    });

    // Selecting a scene only changes the PREVIEW; edits refresh it without restarting.
    const unsub = useProject.subscribe((s, prev) => {
      if (s.selectedSceneId !== prev.selectedSceneId) {
        const scene = s.project.scenes.find((x) => x.id === s.selectedSceneId) ?? null;
        useShow.getState().setPreview(scene);
      } else if (s.project !== prev.project) {
        const a = s.project.scenes.find((x) => x.id === s.selectedSceneId);
        const b = prev.project.scenes.find((x) => x.id === s.selectedSceneId);
        if (a && a !== b && stripThumb(a) !== stripThumb(b)) syncPreview();
      }
    });

    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        const id = useProject.getState().selectedSceneId;
        if (id && !useShow.getState().program.transition) void takeScene(id);
      } else if (e.code === "KeyG" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
        cueControl.go("program");
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    return () => {
      stopServices();
      stopAudio();
      unsub();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col">
        <TopBar />
        <div className="min-h-0 flex-1">{!loaded ? <div className="grid h-full place-items-center text-muted-foreground">Loading show…</div> : mode === "show" ? <ShowMode /> : <BuilderMode />}</div>
      </div>
    </TooltipProvider>
  );
}

/** Thumbnail updates alone should not refresh the preview. */
function stripThumb(s: { thumbnail: string | null } | undefined) {
  if (!s) return "";
  return JSON.stringify({ ...s, thumbnail: null });
}

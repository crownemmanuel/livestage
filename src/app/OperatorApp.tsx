import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { startProgramAudio, unlockAudio } from "@/engine/audio";
import { learnSoundLengths } from "@/engine/musicChase";
import { startAudioRouting } from "@/engine/audioOutput";
import { cancelPending, cueControl, restoreLiveState, startOperatorServices, takeScene } from "@/engine/operator";
import { toggleHoldFor } from "@/engine/transport";
import { useProject } from "@/store/project";
import { useShow } from "@/store/show";
import { TopBar } from "@/ui/TopBar";
import { ShowMode } from "@/ui/show/ShowMode";
import { BuilderMode } from "@/ui/builder/BuilderMode";
import { ErrorBoundary, installGlobalErrorLog } from "@/ui/ErrorBoundary";
import { preloadPhotoAssets } from "@/render/env/photoreal/shared";
import { startAgentBridge } from "@/agent/bridge";
import { startUpdateChecks } from "@/engine/updater";
import { guardWindowDrops } from "@/ui/mediaDrop";

function syncPreview() {
  const { project, selectedSceneId } = useProject.getState();
  const scene = project.scenes.find((s) => s.id === selectedSceneId) ?? null;
  useShow.getState().setPreview(scene, { keepState: true });
}

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  // A scrub bar keeps focus after a drag: it owns only its arrow keys, so P and G still work.
  if (el instanceof HTMLInputElement && el.type === "range") return /^(Arrow|Home|End|Page)/.test(e.key);
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable || el.getAttribute("role") === "slider");
}

export function OperatorApp() {
  const loaded = useProject((s) => s.loaded);
  const mode = useProject((s) => s.mode);

  useEffect(() => {
    installGlobalErrorLog();
    preloadPhotoAssets();
    // Services first, so the restored program is broadcast and persisted from the first moment.
    const stopServices = startOperatorServices();
    // AI agents (MCP) drive the app through the same stores and engine as the operator.
    const stopAgent = startAgentBridge();
    // Installed app only: look for a new version on GitHub (never downloads or installs by itself).
    const stopUpdates = startUpdateChecks();
    void useProject
      .getState()
      .load()
      .then(async () => {
        const resumed = await restoreLiveState();
        const st = useShow.getState();
        // Open on the live scene after a reload, otherwise on the first scene.
        if (resumed && st.program.runtime) useProject.getState().selectScene(st.program.runtime.scene.id);
        syncPreview();
        // The music chase needs the lengths of the show's sounds; learn them in the background.
        void learnSoundLengths(15000);
        if (import.meta.env.DEV && import.meta.env.VITE_SLS_SELFTEST) (await import("@/dev/selftest")).runSelfTest();
      });
    const stopRouting = startAudioRouting();
    // Just started, the output window may be up and playing without having been heard from yet: wait for its
    // heartbeat before playing (and bringing back) the show's sound here.
    const audioFrom = Date.now() + 4000;
    const stopAudio = startProgramAudio(() => {
      const s = useShow.getState();
      const outputUp = !!s.outputStatus && Date.now() - s.outputSeenAt < 3500;
      return !outputUp && Date.now() > audioFrom;
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
      const proj = useProject.getState();
      const show = useShow.getState();
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        const id = proj.selectedSceneId;
        if (id && !show.program.transition) void takeScene(id);
      } else if (e.code === "KeyG" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
        // Same as the cue list's GO next: the live scene when it is selected, otherwise the preview.
        const live = show.program.runtime;
        cueControl.go(live && !show.program.standby && live.scene.id === proj.selectedSceneId ? "program" : "preview");
      } else if (e.code === "KeyP" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.repeat) {
        // Hold / resume, with the same target rule as G.
        toggleHoldFor(proj.selectedSceneId);
      } else if (e.code === "KeyB" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.repeat) {
        show.setBlackout(!show.program.blackout?.on);
      } else if (e.code === "Escape") {
        cancelPending("program");
      } else if ((e.code === "ArrowDown" || e.code === "ArrowUp") && !e.ctrlKey && !e.metaKey && !e.altKey && proj.mode === "show") {
        e.preventDefault();
        const scenes = proj.project.scenes;
        const i = scenes.findIndex((s) => s.id === proj.selectedSceneId);
        const n = scenes[Math.max(0, Math.min(scenes.length - 1, i + (e.code === "ArrowDown" ? 1 : -1)))];
        if (n) proj.selectScene(n.id);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    const stopDropGuard = guardWindowDrops();

    return () => {
      stopDropGuard();
      stopServices();
      stopAgent();
      stopUpdates();
      stopAudio();
      stopRouting();
      unsub();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full flex-col">
        <ErrorBoundary name="top bar">
          <TopBar />
        </ErrorBoundary>
        <div className="min-h-0 flex-1">
          {!loaded ? (
            <div className="grid h-full place-items-center text-muted-foreground">Loading show…</div>
          ) : mode === "show" ? (
            <ErrorBoundary name="show mode">
              <ShowMode />
            </ErrorBoundary>
          ) : (
            <ErrorBoundary name="scene builder">
              <BuilderMode />
            </ErrorBoundary>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

/** Thumbnail updates alone should not refresh the preview. */
function stripThumb(s: { thumbnail: string | null } | undefined) {
  if (!s) return "";
  return JSON.stringify({ ...s, thumbnail: null });
}

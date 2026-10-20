import { useEffect } from "react";
import { now } from "@/core/clock";
import { onBus, send } from "@/core/bus";
import { isTauri } from "@/core/platform";
import { playingCueSounds, startProgramAudio, unlockAudio } from "@/engine/audio";
import { StageView } from "@/render/StageView";
import { takeVideoSyncStats } from "@/render/layers/video";
import { useShow } from "@/store/show";
import { preloadPhotoAssets } from "@/render/env/photoreal/shared";
import { ErrorBoundary, installGlobalErrorLog } from "@/ui/ErrorBoundary";

/**
 * Audience output window: a pure view of the operator's program state.
 * No controls, no cursor, no chrome.
 */
export function OutputApp() {
  const scaling = useShow((s) => s.output.scaling);
  const safe = useShow((s) => s.output.safeArea.showOnOutput);
  const audioHere = useShow((s) => s.output.audioHost === "output");

  useEffect(() => {
    document.body.classList.add("output-window");
    installGlobalErrorLog();
    preloadPhotoAssets();
    const off = onBus((msg) => {
      if (msg.type === "project") useShow.setState({ assets: msg.assets, output: msg.output });
      else if (msg.type === "program") useShow.setState({ program: msg.program });
      else if (msg.type === "poses") useShow.setState({ programPoses: msg.program, fromPoses: msg.from, posesAt: now() });
    });
    void send({ type: "hello" });
    const stopAudio = startProgramAudio(() => useShow.getState().output.audioHost === "output");

    // Heartbeat with measured frame rate so the operator can see output health.
    let frames = 0;
    let worst = 0;
    let last = performance.now();
    let raf = 0;
    const loop = () => {
      const t = performance.now();
      worst = Math.max(worst, t - last);
      last = t;
      frames++;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const hb = setInterval(() => {
      void send({
        type: "output-status",
        status: {
          fps: frames,
          frameMs: Math.round(worst),
          width: Math.round(window.innerWidth * devicePixelRatio),
          height: Math.round(window.innerHeight * devicePixelRatio),
          dpr: devicePixelRatio,
          fullscreen: !!document.fullscreenElement || (window.innerWidth === screen.width && window.innerHeight === screen.height),
          video: takeVideoSyncStats(),
          sounds: playingCueSounds(),
        },
      });
      if (import.meta.env.DEV && import.meta.env.VITE_SLS_SELFTEST) {
        console.warn("[selftest:output]", document.visibilityState, "hidden:", document.hidden, "frames:", frames, "size:", innerWidth, innerHeight);
      }
      frames = 0;
      worst = 0;
    }, 1000);

    const bye = () => void send({ type: "output-bye" });
    window.addEventListener("beforeunload", bye);
    // Browser dev mode only: double-click toggles fullscreen (the desktop app controls this from the operator).
    const dbl = () => {
      unlockAudio();
      if (isTauri) return;
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    };
    window.addEventListener("dblclick", dbl);
    window.addEventListener("pointerdown", unlockAudio);
    return () => {
      off();
      stopAudio();
      cancelAnimationFrame(raf);
      clearInterval(hb);
      bye();
      window.removeEventListener("beforeunload", bye);
      window.removeEventListener("dblclick", dbl);
      window.removeEventListener("pointerdown", unlockAudio);
    };
  }, []);

  return (
    <div className="fixed inset-0 bg-black">
      <ErrorBoundary name="output" retryAfter={1000} fallback={null}>
        <StageView source="program" isOutput scaling={scaling} maxDpr={3} showSafeArea={safe} audio={audioHere} />
      </ErrorBoundary>
    </div>
  );
}

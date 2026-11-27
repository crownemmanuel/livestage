import { useEffect } from "react";
import { now } from "@/core/clock";
import { onBus, send, unpackProgram } from "@/core/bus";
import { isTauri } from "@/core/platform";
import { steadyInterval } from "@/core/steadyTimer";
import type { Scene } from "@/core/types";
import { heldCueSounds, playingCueSounds, startProgramAudio, unlockAudio, warmSoundCount, warmSounds } from "@/engine/audio";
import { startAudioRouting } from "@/engine/audioOutput";
import { StageView } from "@/render/StageView";
import { takeVideoSyncStats, videoSeekLead } from "@/render/layers/video";
import { codecPlayerCount, codecRefusals } from "@/render/video/codecVideo";
import { takeUploadStats } from "@/render/uploadStats";
import { useShow } from "@/store/show";
import { preloadPhotoAssets } from "@/render/env/photoreal/shared";
import { ErrorBoundary, installGlobalErrorLog } from "@/ui/ErrorBoundary";

function countVideos() {
  const all = document.querySelectorAll("video");
  let warm = 0;
  all.forEach((v) => {
    if (v.hasAttribute("src") || v.currentSrc) warm++;
  });
  return { total: all.length, warm };
}

/**
 * Audience output window: a pure view of the operator's program state.
 * No controls, no cursor, no chrome.
 */
export function OutputApp() {
  const scaling = useShow((s) => s.output.scaling);
  const safe = useShow((s) => s.output.safeArea.showOnOutput);

  useEffect(() => {
    document.body.classList.add("output-window");
    installGlobalErrorLog();
    preloadPhotoAssets();
    let lastBusAt = 0;
    let lastBusType = "";
    // Scene definitions by runtime key: a live-state update keeps the scene object the view already
    // renders, so nothing keyed on component identity (text textures, material settings) redoes its work.
    const scenes = new Map<string, Scene>();
    let resyncAt = 0;
    const off = onBus((msg) => {
      lastBusAt = performance.now();
      lastBusType = msg.type;
      if (msg.type === "project") useShow.setState({ assets: msg.assets, output: msg.output });
      else if (msg.type === "program") {
        const program = unpackProgram(msg, scenes);
        if (program) useShow.setState({ program });
        else if (performance.now() - resyncAt > 1000) {
          // A run whose scene never arrived (started late, or a message was lost): ask for everything.
          resyncAt = performance.now();
          void send({ type: "hello" });
        }
      } else if (msg.type === "poses") useShow.setState({ programPoses: msg.program, fromPoses: msg.from, posesAt: now() });
      else if (msg.type === "warm") warmSounds(msg.sounds);
    });
    void send({ type: "hello" });
    const stopRouting = startAudioRouting();
    const stopAudio = startProgramAudio(() => true);

    // Heartbeat with measured frame rate so the operator can see output health.
    let frames = 0;
    let worst = 0;
    let stalls: { ms: number; sinceBusMs: number; bus: string }[] = [];
    let last = performance.now();
    let raf = 0;
    // Set while the window is not being drawn at all (hidden, minimised, or covered by another window: the
    // browser stops its frames), so the first frame back is not counted as a stall of that whole time.
    let undrawn = document.hidden;
    const onVisibility = () => {
      if (document.hidden) undrawn = true;
    };
    document.addEventListener("visibilitychange", onVisibility);
    const loop = () => {
      const t = performance.now();
      const gap = t - last;
      if (!undrawn) {
        worst = Math.max(worst, gap);
        if (gap > 40 && stalls.length < 8) stalls.push({ ms: Math.round(gap), sinceBusMs: Math.round(t - lastBusAt), bus: lastBusType });
      }
      undrawn = false;
      last = t;
      frames++;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    let lastBeat = performance.now();
    // From a worker, so the heartbeat keeps its second even if this window is ever hidden or covered.
    const stopHeartbeat = steadyInterval(() => {
      const beat = performance.now();
      // A whole second without a frame while this beat still came on time: the page was free, the browser
      // just was not drawing it (covered). A held page delays the beat too, and that stays a stall.
      if (frames === 0 && beat - lastBeat < 1300) undrawn = true;
      lastBeat = beat;
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
          heldSounds: heldCueSounds(),
          soundsReady: warmSoundCount(),
          upload: takeUploadStats(),
          videoElements: countVideos(),
          codecPlayers: codecPlayerCount(),
          codecRefused: codecRefusals(),
          stalls,
          seekLeadMs: Math.round(videoSeekLead() * 1000),
        },
      });
      stalls = [];
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
      stopRouting();
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      stopHeartbeat();
      bye();
      window.removeEventListener("beforeunload", bye);
      window.removeEventListener("dblclick", dbl);
      window.removeEventListener("pointerdown", unlockAudio);
    };
  }, []);

  return (
    <div className="fixed inset-0 bg-black">
      <ErrorBoundary name="output" retryAfter={1000} fallback={null}>
        <StageView source="program" isOutput scaling={scaling} maxDpr={3} showSafeArea={safe} audio /* always the audio host while it runs; the operator takes over when it is down */ />
      </ErrorBoundary>
    </div>
  );
}

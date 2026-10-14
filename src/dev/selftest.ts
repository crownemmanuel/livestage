// Dev-only smoke test of native paths, enabled with VITE_SLS_SELFTEST=1.
// Results are logged with a [selftest] prefix (Vite forwards them to the terminal).
import { closeOutputWindow, isTauri, listMonitors, loadProjectFile, openOutputWindow } from "@/core/platform";
import { takeScene } from "@/engine/operator";
import { useProject } from "@/store/project";
import { useShow } from "@/store/show";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.warn("[selftest]", ...a);

let ran = false;

export async function runSelfTest() {
  if (ran) return; // StrictMode runs effects twice in dev
  ran = true;
  try {
    log("tauri:", isTauri, "operator visibility:", document.visibilityState);
    let n = 0;
    const t0 = performance.now();
    await new Promise<void>((r) => {
      const f = () => (++n >= 30 || performance.now() - t0 > 1500 ? r() : requestAnimationFrame(f));
      requestAnimationFrame(f);
      setTimeout(r, 1600);
    });
    log("operator rAF frames in ~1.5s:", n);
    const mons = await listMonitors();
    log("monitors:", JSON.stringify(mons));
    const w = await import("@tauri-apps/api/window");
    log("raw available:", JSON.stringify(await w.availableMonitors()), "primary:", JSON.stringify(await w.primaryMonitor()), "current:", JSON.stringify(await w.currentMonitor()));
    await useProject.getState().save();
    const saved = await loadProjectFile();
    log("project saved+reloaded:", !!saved, "scenes:", saved?.scenes.length);

    const out = { ...useProject.getState().project.output, fullscreen: false, windowWidth: 960, windowHeight: 270 };
    await openOutputWindow(out);
    log("output window opened");
    await wait(4000);
    log("output heartbeat (behind main):", JSON.stringify(useShow.getState().outputStatus));
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    await (await WebviewWindow.getByLabel("output"))?.setFocus();
    await wait(2500);
    log("output heartbeat (focused):", JSON.stringify(useShow.getState().outputStatus));

    const s1 = useProject.getState().project.scenes[0];
    await takeScene(s1.id, { kind: "fadeblack", duration: 1, videoAssetId: null, audioAssetId: null, travelDistance: 60 });
    await wait(3000);
    const st = useShow.getState();
    log("program:", st.program.runtime?.scene.name, "standby:", st.program.standby, "output fps:", st.outputStatus?.fps, "worst frame ms:", st.outputStatus?.frameMs);
    await wait(3000);
    log("output fps after 6s:", useShow.getState().outputStatus?.fps);
    await closeOutputWindow();
    useShow.setState({ outputStatus: null, outputSeenAt: 0 });
    await wait(1500);
    log("closed; heartbeat cleared:", useShow.getState().outputStatus === null);
    log("DONE");
  } catch (e) {
    log("FAILED", String(e));
  }
}

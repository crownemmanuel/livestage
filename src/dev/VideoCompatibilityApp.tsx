// Silent, preview-only native rendering harness. No operator services, live-state
// restoration, autosave, audio routing or output window are started here.
import { useEffect, useState } from "react";
import { startAgentBridge } from "@/agent/bridge";
import { StageView } from "@/render/StageView";
import { useProject } from "@/store/project";
import { useShow } from "@/store/show";

export function VideoCompatibilityApp() {
  const loaded = useProject((s) => s.loaded);
  const scenes = useProject((s) => s.project.scenes);
  const selected = useProject((s) => s.selectedSceneId);
  const [error, setError] = useState("");
  useEffect(() => {
    const sync = () => {
      const { project, selectedSceneId } = useProject.getState();
      useShow.setState((s) => ({ assets: project.assets, output: project.output, program: { ...s.program, mix: project.mix ?? {} } }));
      useShow.getState().setPreview(project.scenes.find((s) => s.id === selectedSceneId) ?? null);
    };
    const off = useProject.subscribe((s, prev) => {
      if (s.loaded && (s.selectedSceneId !== prev.selectedSceneId || s.project !== prev.project)) sync();
    });
    const stopAgent = startAgentBridge();
    void useProject.getState().load().then(sync).catch((e) => setError(String(e)));
    return () => { off(); stopAgent(); };
  }, []);
  return (
    <main className="flex h-screen flex-col gap-4 bg-background p-6 text-foreground">
      <h1>Video compatibility preview · silent · no live output</h1>
      <select value={selected ?? ""} onChange={(e) => useProject.getState().selectScene(e.target.value)} className="bg-background">
        {scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      {error ? <p role="alert">{error}</p> : !loaded ? <p>Loading media…</p> : (
        <div className="min-h-0 flex-1"><StageView source="preview" maxDpr={1} /></div>
      )}
    </main>
  );
}

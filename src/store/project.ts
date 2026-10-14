import { create } from "zustand";
import { defaultProject, LION_PROOF_ASSETS, PROLOGUE_ASSETS, PROLOGUE_DEMO, prologueScenes, LION_PROOF_CUTOUTS, LION_PROOF_DEMO, lionProofIdleClip, lionProofLayout, lionProofScene, SHEPHERD_PHOTOREAL_DEMO, shepherdPhotorealScene } from "@/core/defaultProject";
import { cloneComponent, cloneScene, defaultOutput, makeScene } from "@/core/factories";
import { loadProjectFile, refreshAssetUrls, saveProjectFile } from "@/core/platform";
import type { Asset, OutputSettings, Project, Scene, SceneComponent } from "@/core/types";

export type AppMode = "show" | "builder";

interface ProjectStore {
  project: Project;
  loaded: boolean;
  dirty: boolean;
  savedAt: number | null;
  saveError: string | null;
  mode: AppMode;
  selectedSceneId: string | null;
  selectedComponentId: string | null;

  load(): Promise<void>;
  save(): Promise<void>;
  replaceProject(p: Project): void;
  resetToDemo(): void;
  setMode(m: AppMode): void;
  selectScene(id: string | null): void;
  selectComponent(id: string | null): void;

  update(fn: (draft: Project) => void): void;
  updateScene(id: string, fn: (s: Scene) => void): void;
  addScene(): string;
  duplicateScene(id: string): string | null;
  deleteScene(id: string): void;
  moveScene(id: string, dir: -1 | 1): void;

  addComponent(sceneId: string, c: SceneComponent): void;
  updateComponent(sceneId: string, compId: string, fn: (c: SceneComponent) => void): void;
  duplicateComponent(sceneId: string, compId: string): void;
  removeComponent(sceneId: string, compId: string): void;
  moveComponent(sceneId: string, compId: string, dir: -1 | 1): void;

  addAssets(a: Asset[]): void;
  removeAsset(id: string): void;
  setOutput(partial: Partial<OutputSettings>): void;
  setThumbnail(sceneId: string, dataUrl: string): void;
}

function renumber(p: Project) {
  p.scenes.forEach((s, i) => (s.number = i + 1));
}

/** Fill fields added in later versions so old show files keep loading. */
function migrate(p: Project): Project {
  const out = { ...defaultOutput(), ...p.output };
  out.safeArea = { ...defaultOutput().safeArea, ...p.output?.safeArea };
  out.standby = { ...defaultOutput().standby, ...p.output?.standby };
  const merged: Project = { ...p, output: out, effectPresets: p.effectPresets ?? [], assets: p.assets ?? [], demoAdditions: p.demoAdditions ?? [] };
  // Merge new built-in demo content once; if the user later deletes it, it stays deleted.
  if (!merged.demoAdditions!.includes(LION_PROOF_DEMO)) {
    const have = new Set(merged.assets.map((a) => a.id));
    merged.assets = [...merged.assets, ...LION_PROOF_ASSETS.filter((a) => !have.has(a.id))];
    merged.scenes = [...merged.scenes];
    merged.scenes.splice(Math.min(1, merged.scenes.length), 0, lionProofScene(2));
    renumber(merged);
    merged.demoAdditions = [...merged.demoAdditions!, LION_PROOF_DEMO];
  }
  // v1 of the proof scene predates vertical framing; frame it so the mane is not cropped.
  if (!merged.demoAdditions!.includes("lion-proof-anchor")) {
    for (const sc of merged.scenes) {
      for (const c of sc.components) {
        const isProofPlate = c.kind === "background" && c.media.assetId === "asset_lp_plate";
        const isProofActor = c.kind === "clipActor" && c.clips.some((k) => k.assetId === "asset_lp_walk");
        if ((isProofPlate || isProofActor) && c.anchorY === undefined) c.anchorY = 0.3;
      }
    }
    merged.demoAdditions = [...merged.demoAdditions!, "lion-proof-anchor"];
  }
  // Add the pacing idle loop to shows that got the proof scene before it existed.
  if (!merged.demoAdditions!.includes("lion-proof-idle")) {
    const have = new Set(merged.assets.map((a) => a.id));
    merged.assets = [...merged.assets, ...LION_PROOF_ASSETS.filter((a) => !have.has(a.id))];
    for (const sc of merged.scenes) {
      for (const c of sc.components) {
        if (c.kind === "clipActor" && c.clips.some((k) => k.assetId === "asset_lp_walk") && !c.clips.some((k) => k.assetId === "asset_lp_idle")) {
          c.clips.push(lionProofIdleClip());
        }
      }
    }
    merged.demoAdditions = [...merged.demoAdditions!, "lion-proof-idle"];
  }
  // Pair each proof clip with its cut-out version and give the actor a layout.
  if (!merged.demoAdditions!.includes("lion-proof-cutout")) {
    const have = new Set(merged.assets.map((a) => a.id));
    merged.assets = [...merged.assets, ...LION_PROOF_ASSETS.filter((a) => !have.has(a.id))];
    for (const sc of merged.scenes) {
      for (const c of sc.components) {
        if (c.kind !== "clipActor" || !c.clips.some((k) => k.assetId === "asset_lp_walk")) continue;
        for (const k of c.clips) if (k.assetId && LION_PROOF_CUTOUTS[k.assetId] && !k.cutoutAssetId) k.cutoutAssetId = LION_PROOF_CUTOUTS[k.assetId];
        c.layout ??= lionProofLayout();
      }
    }
    merged.demoAdditions = [...merged.demoAdditions!, "lion-proof-cutout"];
  }
  // The photoreal Shepherd's Valley experiment, placed right after the procedural one.
  if (!merged.demoAdditions!.includes(SHEPHERD_PHOTOREAL_DEMO)) {
    const at = merged.scenes.findIndex((s) => s.environment === "shepherd-valley");
    merged.scenes = [...merged.scenes];
    merged.scenes.splice(at >= 0 ? at + 1 : merged.scenes.length, 0, shepherdPhotorealScene(0));
    renumber(merged);
    merged.demoAdditions = [...merged.demoAdditions!, SHEPHERD_PHOTOREAL_DEMO];
  }
  // The prologue (P1–P4) opens the show, so it goes first.
  if (!merged.demoAdditions!.includes(PROLOGUE_DEMO)) {
    const have = new Set(merged.assets.map((a) => a.id));
    merged.assets = [...PROLOGUE_ASSETS.filter((a) => !have.has(a.id)), ...merged.assets];
    merged.scenes = [...prologueScenes(), ...merged.scenes];
    renumber(merged);
    merged.demoAdditions = [...merged.demoAdditions!, PROLOGUE_DEMO];
  }
  // Prologue tweaks after the first run-through: a stone the audience can see, P3 framed lower.
  if (!merged.demoAdditions!.includes("prologue-tweaks-1")) {
    for (const sc of merged.scenes) {
      for (const c of sc.components) {
        if (c.kind === "effect" && c.effect === "projectile" && c.name === "Sling stone" && c.params.size === 0.018) {
          c.params = { ...c.params, size: 0.03, glow: 1.2 };
        }
        const isP3 =
          (c.kind === "background" && c.media.assetId === "asset_pr_david_lion") ||
          (c.kind === "clipActor" && c.clips.some((k) => k.assetId === "asset_pr_david_loop"));
        if (isP3 && (c.kind === "background" || c.kind === "clipActor") && c.anchorY === 0.35) c.anchorY = 0.42;
      }
    }
    merged.demoAdditions = [...merged.demoAdditions!, "prologue-tweaks-1"];
  }
  // Built-in assets ship with the app: keep their definitions in step with the code.
  const builtIn = new Map([...PROLOGUE_ASSETS, ...LION_PROOF_ASSETS].map((a) => [a.id, a]));
  merged.assets = merged.assets.map((a) => (a.builtIn && builtIn.has(a.id) ? { ...builtIn.get(a.id)! } : a));
  return merged;
}

export const useProject = create<ProjectStore>((set, get) => ({
  project: defaultProject(),
  loaded: false,
  dirty: false,
  savedAt: null,
  saveError: null,
  mode: "show",
  selectedSceneId: null,
  selectedComponentId: null,

  async load() {
    const saved = await loadProjectFile();
    const project = saved ? migrate(saved) : defaultProject();
    project.assets = await refreshAssetUrls(project.assets);
    set({ project, loaded: true, dirty: !saved, selectedSceneId: project.scenes[0]?.id ?? null });
  },

  async save() {
    try {
      await saveProjectFile(get().project);
      set({ dirty: false, savedAt: Date.now(), saveError: null });
    } catch (e) {
      set({ saveError: String(e) });
    }
  },

  replaceProject(p) {
    const project = migrate(p);
    set({ project, dirty: true, selectedSceneId: project.scenes[0]?.id ?? null, selectedComponentId: null });
  },

  resetToDemo() {
    const project = defaultProject();
    set({ project, dirty: true, selectedSceneId: project.scenes[0]?.id ?? null, selectedComponentId: null });
  },

  setMode: (mode) => set({ mode }),
  selectScene: (id) => set({ selectedSceneId: id, selectedComponentId: null }),
  selectComponent: (id) => set({ selectedComponentId: id }),

  update(fn) {
    const draft = structuredClone(get().project);
    fn(draft);
    set({ project: draft, dirty: true });
  },

  updateScene(id, fn) {
    get().update((p) => {
      const s = p.scenes.find((x) => x.id === id);
      if (s) fn(s);
    });
  },

  addScene() {
    const s = makeScene(get().project.scenes.length + 1, "New Scene");
    get().update((p) => p.scenes.push(s));
    set({ selectedSceneId: s.id });
    return s.id;
  },

  duplicateScene(id) {
    const src = get().project.scenes.find((s) => s.id === id);
    if (!src) return null;
    const copy = cloneScene(src, 0);
    get().update((p) => {
      p.scenes.splice(p.scenes.findIndex((s) => s.id === id) + 1, 0, copy);
      renumber(p);
    });
    set({ selectedSceneId: copy.id });
    return copy.id;
  },

  deleteScene(id) {
    const scenes = get().project.scenes;
    const idx = scenes.findIndex((s) => s.id === id);
    get().update((p) => {
      p.scenes = p.scenes.filter((s) => s.id !== id);
      renumber(p);
    });
    const next = get().project.scenes[Math.min(idx, get().project.scenes.length - 1)];
    set({ selectedSceneId: next?.id ?? null });
  },

  moveScene(id, dir) {
    get().update((p) => {
      const i = p.scenes.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.scenes.length) return;
      [p.scenes[i], p.scenes[j]] = [p.scenes[j], p.scenes[i]];
      renumber(p);
    });
  },

  addComponent(sceneId, c) {
    get().updateScene(sceneId, (s) => s.components.push(c));
    set({ selectedComponentId: c.id });
  },

  updateComponent(sceneId, compId, fn) {
    get().updateScene(sceneId, (s) => {
      const c = s.components.find((x) => x.id === compId);
      if (c) fn(c);
    });
  },

  duplicateComponent(sceneId, compId) {
    let newId: string | null = null;
    get().updateScene(sceneId, (s) => {
      const i = s.components.findIndex((x) => x.id === compId);
      if (i < 0) return;
      const copy = cloneComponent(s.components[i]);
      newId = copy.id;
      s.components.splice(i + 1, 0, copy);
    });
    if (newId) set({ selectedComponentId: newId });
  },

  removeComponent(sceneId, compId) {
    get().updateScene(sceneId, (s) => {
      s.components = s.components.filter((c) => c.id !== compId);
      for (const cue of s.cues) {
        cue.actions = cue.actions.filter((a) => !Object.values(a).includes(compId));
      }
      for (const sh of s.cameraShots) if (sh.followActorId === compId) sh.followActorId = null;
    });
    if (get().selectedComponentId === compId) set({ selectedComponentId: null });
  },

  moveComponent(sceneId, compId, dir) {
    get().updateScene(sceneId, (s) => {
      const i = s.components.findIndex((c) => c.id === compId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.components.length) return;
      [s.components[i], s.components[j]] = [s.components[j], s.components[i]];
    });
  },

  addAssets(a) {
    get().update((p) => p.assets.push(...a));
  },

  removeAsset(id) {
    get().update((p) => {
      p.assets = p.assets.filter((a) => a.id !== id);
    });
  },

  setOutput(partial) {
    get().update((p) => Object.assign(p.output, partial));
  },

  setThumbnail(sceneId, dataUrl) {
    const p = get().project;
    const scenes = p.scenes.map((s) => (s.id === sceneId ? { ...s, thumbnail: dataUrl } : s));
    set({ project: { ...p, scenes }, dirty: true });
  },
}));

export const selectedScene = (s: ProjectStore) => s.project.scenes.find((x) => x.id === s.selectedSceneId) ?? null;

// Autosave shortly after every edit. Show files are small; saving often is cheap insurance.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useProject.subscribe((s, prev) => {
  if (!s.loaded || s.project === prev.project || !s.dirty) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void useProject.getState().save(), 900);
});

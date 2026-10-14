import { create } from "zustand";
import type { LionAction } from "@/core/types";

/** What a loaded GLB actually contains, so the builder can flag missing clips. */
export interface ModelInfo {
  clips: string[];
  missing: LionAction[];
  error?: string;
}

interface ModelInfoStore {
  byAsset: Record<string, ModelInfo>;
  setInfo(assetId: string, info: Omit<ModelInfo, "error">): void;
  setError(assetId: string, error: string): void;
}

export const useModelInfo = create<ModelInfoStore>((set, get) => ({
  byAsset: {},
  setInfo(assetId, info) {
    const cur = get().byAsset[assetId];
    if (cur && cur.clips.join() === info.clips.join() && cur.missing.join() === info.missing.join()) return;
    set({ byAsset: { ...get().byAsset, [assetId]: { ...info } } });
  },
  setError(assetId, error) {
    set({ byAsset: { ...get().byAsset, [assetId]: { clips: [], missing: [], error } } });
  },
}));

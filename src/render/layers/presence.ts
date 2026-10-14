import { useCallback } from "react";
import { clamp } from "@/core/clock";
import { useStage } from "../frame";

/** 0..1 visibility of a layer/element, including its fade in/out. */
export function useLayerPresence(id: string, fadeSec: number) {
  const { getRt, frame } = useStage();
  return useCallback(() => {
    const l = getRt()?.layers[id];
    if (!l) return 0;
    const k = fadeSec <= 0 ? 1 : clamp((frame.t - l.changedAt) / (fadeSec * 1000), 0, 1);
    return l.visible ? k : 1 - k;
  }, [getRt, frame, id, fadeSec]);
}

// On-demand pictures of a monitor for the agent bridge. WebGL canvases do not keep their pixels
// after a frame, so the compositor hands over its canvas right after drawing when one is asked for.

import type { SlotRole } from "./frame";

interface SnapRequest {
  role: SlotRole;
  width: number;
  resolve: (dataUrl: string) => void;
  reject: (e: Error) => void;
}

const requests: SnapRequest[] = [];

export function requestSnap(role: SlotRole, width: number, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req: SnapRequest = { role, width, resolve, reject };
    requests.push(req);
    setTimeout(() => {
      const i = requests.indexOf(req);
      if (i < 0) return;
      requests.splice(i, 1);
      reject(new Error(`The ${role === "live" ? "program" : role} monitor did not draw a frame (is it on screen, and is the window visible?)`));
    }, timeoutMs);
  });
}

/** Called by the compositor after each frame it draws. */
export function serveSnaps(role: SlotRole, src: HTMLCanvasElement, canvasW: number, canvasH: number) {
  if (!requests.length) return;
  for (let i = requests.length - 1; i >= 0; i--) {
    const r = requests[i];
    if (r.role !== role) continue;
    requests.splice(i, 1);
    try {
      const c = document.createElement("canvas");
      c.width = r.width;
      c.height = Math.max(16, Math.round((r.width * canvasH) / canvasW));
      c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
      r.resolve(c.toDataURL("image/jpeg", 0.85));
    } catch (e) {
      r.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

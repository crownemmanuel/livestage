// How long this window spends handing video frames to WebGL (texImage2D / texSubImage2D from a
// <video>). On the fast path the browser passes the decoded frame to the GPU and the call returns
// in well under a millisecond; a slow path (software decode, a format the GPU copy refuses) shows
// up here as whole milliseconds per frame. The output heartbeat reports it once a second.

let ms = 0;
let count = 0;
const seen = new WeakSet<object>();

export function instrumentUploads(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  if (seen.has(gl)) return;
  seen.add(gl);
  for (const name of ["texImage2D", "texSubImage2D"] as const) {
    const raw = gl[name] as unknown as (...a: unknown[]) => void;
    (gl as unknown as Record<string, unknown>)[name] = function (this: WebGLRenderingContext, ...args: unknown[]) {
      const src = args[args.length - 1];
      if (typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement) {
        const t0 = performance.now();
        raw.apply(this, args);
        ms += performance.now() - t0;
        count++;
      } else raw.apply(this, args);
    };
  }
}

/** Upload time and count since the last call, then reset. */
export function takeUploadStats(): { ms: number; count: number } {
  const out = { ms: Math.round(ms * 10) / 10, count };
  ms = 0;
  count = 0;
  return out;
}

if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __slsUploadStats?: unknown }).__slsUploadStats = takeUploadStats;

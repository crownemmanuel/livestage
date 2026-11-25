// A repeating timer that keeps its pace while the window is hidden or covered.
//
// Browsers throttle a hidden page's timers (Chromium to once a second, WebKit similarly, and
// Chromium backgrounds a fully occluded window too). In a show the operator may well cover the
// operator window with StageMics or StageLight for a moment; the 60 Hz loop that fires marker
// and time cues, and the output's one-second heartbeat, must not slow down when that happens.
// Timers inside a Worker are not throttled, so the beat comes from a tiny worker and the page
// only receives its messages. Falls back to setInterval where workers are unavailable.

export function steadyInterval(fn: () => void, ms: number): () => void {
  let worker: Worker | null = null;
  let url: string | null = null;
  try {
    if (typeof Worker !== "undefined" && typeof Blob !== "undefined") {
      // Each tick carries the time the worker sent it (both sides read the same clock: timeOrigin + now).
      const src = "let t=null;onmessage=e=>{if(t)clearInterval(t);t=setInterval(()=>postMessage(performance.timeOrigin+performance.now()),e.data)};";
      url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      worker = new Worker(url);
      // After the page stalls (a long frame, a blocked main thread), the ticks the worker sent meanwhile
      // arrive back to back: 60 per second of stall at 60 Hz. The first of them runs; the rest (ticks that
      // waited in the queue longer than one interval, arriving less than an interval after the last run)
      // are dropped. Callers work out elapsed time from the clock themselves, so nothing is lost.
      let lastRun = -Infinity;
      worker.onmessage = (e: MessageEvent) => {
        const at = performance.timeOrigin + performance.now();
        const sent = typeof e.data === "number" ? e.data : at;
        if (at - sent > ms && at - lastRun < ms) return;
        lastRun = at;
        fn();
      };
      worker.postMessage(ms);
    }
  } catch {
    worker = null;
  }
  if (!worker) {
    const h = setInterval(fn, ms);
    return () => clearInterval(h);
  }
  return () => {
    worker!.terminate();
    if (url) URL.revokeObjectURL(url);
  };
}

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
      const src = "let t=null;onmessage=e=>{if(t)clearInterval(t);t=setInterval(()=>postMessage(0),e.data)};";
      url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      worker = new Worker(url);
      worker.onmessage = () => fn();
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

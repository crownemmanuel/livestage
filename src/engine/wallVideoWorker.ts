// Wall video worker (docs/WALL_VIDEO_LINK.md): owns the socket to StageLight, scales and encodes each
// frame the operator window hands it, and answers StageLight's clock pings here, off the main thread,
// so a busy operator window never distorts the clock sync.

const MAGIC = [0x4c, 0x53, 0x57, 0x56]; // "LSWV"
const HEADER = 32;
const RETRY_MS = 2000;

type Img = VideoFrame | ImageBitmap;
/** Drawing steps, bottom to top (WallOp in wallVideo.ts). */
type Op =
  | { k: "img"; img: Img; a: number; fit: "fill" | "cover"; posY?: number }
  | { k: "fill"; color: string; a: number }
  | { k: "standby"; a: number; color: string; text: string; sub: string; img: string | null; fit: "fill" | "cover" | "contain" };
type Frame = { t: "frame"; ops: Op[]; stamp: number; flags: number; width: number; height: number; quality: number };
type ToWorker = { t: "config"; url: string; hello: object } | { t: "hello"; hello: object } | Frame | { t: "asset"; key: string; img: ImageBitmap } | { t: "close" };

const scope = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null; close(): void };
const clock = () => performance.timeOrigin + performance.now();
const post = (m: unknown) => scope.postMessage(m);

let url = "";
let hello: object | null = null;
let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let closing = false;
let seq = 0;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
/** The standby picture (one at a time), by its URL. */
let asset: { key: string; img: ImageBitmap } | null = null;
let asked = "";

const closeAll = (ops: Op[]) => ops.forEach((o) => o.k === "img" && o.img.close());

function sourceSize(img: Img) {
  return "displayWidth" in img ? { sw: img.displayWidth, sh: img.displayHeight } : { sw: img.width, sh: img.height };
}

/** Draw a picture into w×h: stretched, or covering / contained like CSS object-fit. */
function place(c: OffscreenCanvasRenderingContext2D, img: CanvasImageSource & Img, w: number, h: number, fit: "fill" | "cover" | "contain", posY = 0.5) {
  const { sw, sh } = sourceSize(img);
  if (fit === "fill" || !sw || !sh) return c.drawImage(img, 0, 0, w, h);
  const s = fit === "cover" ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh);
  const dw = sw * s;
  const dh = sh * s;
  c.drawImage(img, (w - dw) / 2, (h - dh) * posY, dw, dh);
}

function drawOp(c: OffscreenCanvasRenderingContext2D, o: Op, w: number, h: number) {
  c.globalAlpha = Math.max(0, Math.min(1, o.a));
  if (o.k === "fill") {
    c.fillStyle = o.color;
    c.fillRect(0, 0, w, h);
  } else if (o.k === "img") {
    place(c, o.img, w, h, o.fit, o.posY);
  } else {
    c.fillStyle = o.color;
    c.fillRect(0, 0, w, h);
    if (o.img) {
      if (asset?.key === o.img) place(c, asset.img, w, h, o.fit);
      else if (asked !== o.img) {
        asked = o.img;
        post({ t: "needAsset", key: o.img });
      }
    } else if (o.text) {
      // As the standby card draws it: Georgia, 9% / 4% of the height, spaced capitals.
      c.fillStyle = "#d9cfb8";
      c.textAlign = "center";
      c.textBaseline = "middle";
      const spaced = c as OffscreenCanvasRenderingContext2D & { letterSpacing?: string };
      c.font = `400 ${Math.round(h * 0.09)}px Georgia, "Times New Roman", serif`;
      spaced.letterSpacing = "0.35em";
      c.fillText(o.text, w / 2, o.sub ? h * 0.47 : h / 2);
      if (o.sub) {
        c.globalAlpha *= 0.65;
        spaced.letterSpacing = "0.25em";
        c.font = `400 ${Math.round(h * 0.04)}px Georgia, "Times New Roman", serif`;
        c.fillText(o.sub, w / 2, h * 0.47 + h * 0.085);
      }
      spaced.letterSpacing = "0px";
    }
  }
  c.globalAlpha = 1;
}

function connect() {
  if (retry) clearTimeout(retry);
  retry = null;
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  ws = null;
  if (closing || !url) return;
  post({ t: "state", state: "connecting" });
  let sock: WebSocket;
  try {
    sock = new WebSocket(url);
  } catch (e) {
    post({ t: "state", state: "connecting", error: String(e) });
    retry = setTimeout(connect, RETRY_MS);
    return;
  }
  sock.binaryType = "arraybuffer";
  ws = sock;
  sock.onopen = () => {
    seq = 0;
    if (hello) sock.send(JSON.stringify(hello));
    post({ t: "state", state: "connected" });
  };
  sock.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    let m: { t?: string; [k: string]: unknown };
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.t === "ping") sock.send(JSON.stringify({ t: "pong", id: m.id, s: m.s, l: clock() }));
    else if (m.t === "hello") post({ t: "stagelight", version: String(m.version ?? ""), armed: typeof m.armed === "boolean" ? m.armed : null });
    else if (m.t === "viewers") post({ t: "viewers", n: Number(m.n) || 0 });
    else if (m.t === "stats") post({ t: "stats", fps: Number(m.fps) || 0, latency: Number(m.latency) || 0, jitter: Number(m.jitter) || 0, delay: Number(m.delay) || 0, offset: Number(m.offset) || 0 });
  };
  sock.onerror = () => {
    /* onclose follows */
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    if (closing) return;
    post({ t: "state", state: "connecting", error: `No StageLight wall video at ${url}` });
    retry = setTimeout(connect, RETRY_MS);
  };
}

async function encode(f: Frame) {
  const sock = ws;
  // Drop, never queue: a frame only goes when the socket has sent everything before it.
  if (!sock || sock.readyState !== WebSocket.OPEN || sock.bufferedAmount > 0) {
    closeAll(f.ops);
    post({ t: "skip" });
    return;
  }
  const t0 = performance.now();
  try {
    if (!canvas || canvas.width !== f.width || canvas.height !== f.height) {
      canvas = new OffscreenCanvas(f.width, f.height);
      ctx = canvas.getContext("2d", { alpha: false });
    }
    if (!ctx) throw new Error("no 2D context");
    for (const o of f.ops) {
      try {
        drawOp(ctx, o, f.width, f.height);
      } catch {
        // This engine cannot draw a VideoFrame into a 2D canvas: the sender switches to ImageBitmaps.
        if (o.k === "img" && "displayWidth" in o.img) {
          closeAll(f.ops);
          post({ t: "badSource" });
          return;
        }
      }
    }
    closeAll(f.ops);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: f.quality });
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    const out = new Uint8Array(HEADER + jpeg.byteLength);
    const dv = new DataView(out.buffer);
    out.set(MAGIC, 0);
    dv.setUint8(4, 1);
    dv.setUint8(5, 1);
    dv.setUint16(6, f.width, true);
    dv.setUint16(8, f.height, true);
    dv.setUint16(10, f.flags, true);
    dv.setUint32(12, seq++ >>> 0, true);
    dv.setFloat64(16, f.stamp, true);
    out.set(jpeg, HEADER);
    if (ws !== sock || sock.readyState !== WebSocket.OPEN) {
      post({ t: "skip" });
      return;
    }
    dv.setFloat64(24, clock(), true);
    sock.send(out);
    post({ t: "sent", bytes: out.byteLength, encodeMs: performance.now() - t0 });
  } catch {
    try {
      closeAll(f.ops);
    } catch {
      /* closed */
    }
    post({ t: "skip" });
  }
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.t === "config") {
    hello = m.hello;
    if (m.url !== url) {
      url = m.url;
      connect();
    } else if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(hello));
  } else if (m.t === "hello") {
    hello = m.hello;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(hello));
  } else if (m.t === "frame") void encode(m);
  else if (m.t === "asset") {
    asset?.img.close();
    asset = { key: m.key, img: m.img };
  }
  else if (m.t === "close") {
    closing = true;
    if (retry) clearTimeout(retry);
    ws?.close(1000, "off");
    setTimeout(() => scope.close(), 100);
  }
};

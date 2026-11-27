// Draws a decoded VideoFrame into a plain <canvas>: the transition video layer on the WebCodecs player (StageView),
// which sits above the scene canvases as an HTML layer, like the <video> it replaces. WebGL, because uploading a
// VideoFrame to a texture is the fast path in both engines (0.1-0.3 ms for 3072 x 768); a 2D canvas may copy it
// through the CPU. The canvas keeps its drawing buffer so the wall video link can take it at any moment.

interface Gl {
  gl: WebGL2RenderingContext;
  tex: WebGLTexture;
}

const contexts = new WeakMap<HTMLCanvasElement, Gl | null>();

function setup(canvas: HTMLCanvasElement): Gl | null {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
  if (!gl) return null;
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, "#version 300 es\nout vec2 uv;void main(){vec2 p=vec2(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.);uv=vec2(p.x*.5+.5,.5-p.y*.5);gl_Position=vec4(p,0,1);}"));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, "#version 300 es\nprecision mediump float;in vec2 uv;uniform sampler2D t;out vec4 o;void main(){o=vec4(texture(t,uv).rgb,1.);}"));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { gl, tex };
}

/** Draw `frame` filling `canvas` (sized to the frame; CSS object-fit places it). */
export function drawFrame(canvas: HTMLCanvasElement, frame: VideoFrame) {
  const w = frame.displayWidth;
  const h = frame.displayHeight;
  if (!w || !h) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  let c = contexts.get(canvas);
  if (c === undefined) {
    c = setup(canvas);
    contexts.set(canvas, c);
  }
  if (!c || c.gl.isContextLost()) return;
  const { gl, tex } = c;
  gl.viewport(0, 0, w, h);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

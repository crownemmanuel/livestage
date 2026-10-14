// Cinematic "camera" finish: the scene renders into a linear HDR target, then
// bloom + white balance + filmic tone curve + grade + vignette + grain.
import * as THREE from "three";
import type { LookSettings } from "@/core/types";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const BRIGHT = /* glsl */ `
uniform sampler2D tSrc;
uniform float threshold;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float k = smoothstep(threshold, threshold * 1.6 + 0.1, l);
  gl_FragColor = vec4(c * k, 1.0);
}
`;

const BLUR = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 dir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
  c += texture2D(tSrc, vUv + dir * 1.3846).rgb * 0.3162162;
  c += texture2D(tSrc, vUv - dir * 1.3846).rgb * 0.3162162;
  c += texture2D(tSrc, vUv + dir * 3.2308).rgb * 0.0702703;
  c += texture2D(tSrc, vUv - dir * 3.2308).rgb * 0.0702703;
  gl_FragColor = vec4(c, 1.0);
}
`;

const FINAL = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloomA;
uniform sampler2D tBloomB;
uniform float bloom;
uniform float exposure;
uniform float contrast;
uniform float saturation;
uniform float warmth;
uniform float vignette;
uniform float grain;
uniform float time;
uniform vec2 aspect;
varying vec2 vUv;

// Khronos PBR Neutral tone mapping: keeps photographic textures faithful
// while gracefully rolling off highlights.
vec3 neutral(vec3 color) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  const float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, newPeak * vec3(1.0), g);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  c += (texture2D(tBloomA, vUv).rgb * 0.6 + texture2D(tBloomB, vUv).rgb * 0.8) * bloom;
  c *= exposure;
  c *= vec3(1.0 + warmth * 0.08, 1.0, 1.0 - warmth * 0.1);
  c = neutral(max(c, 0.0));
  // grade in display space
  vec3 d = toSRGB(clamp(c, 0.0, 1.0));
  float l = dot(d, vec3(0.2126, 0.7152, 0.0722));
  d = mix(vec3(l), d, saturation);
  d = (d - 0.5) * contrast + 0.5;
  vec2 q = (vUv - 0.5) * aspect;
  d *= 1.0 - vignette * smoothstep(0.25, 0.95, dot(q, q) * 1.6);
  d += (hash(vUv * 1013.0 + fract(time) * 37.0) - 0.5) * grain;
  gl_FragColor = vec4(clamp(d, 0.0, 1.0), 1.0);
}
`;

export class PostFX {
  scene: THREE.WebGLRenderTarget;
  private bloomA: THREE.WebGLRenderTarget;
  private bloomB: THREE.WebGLRenderTarget;
  private tmpA: THREE.WebGLRenderTarget;
  private tmpB: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private qscene = new THREE.Scene();
  private bright: THREE.ShaderMaterial;
  private blur: THREE.ShaderMaterial;
  final: THREE.ShaderMaterial;
  private w = 0;
  private h = 0;

  constructor() {
    const opts = { type: THREE.HalfFloatType, depthBuffer: false } as const;
    this.scene = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.bloomA = new THREE.WebGLRenderTarget(1, 1, opts);
    this.bloomB = new THREE.WebGLRenderTarget(1, 1, opts);
    this.tmpA = new THREE.WebGLRenderTarget(1, 1, opts);
    this.tmpB = new THREE.WebGLRenderTarget(1, 1, opts);
    this.bright = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: BRIGHT, uniforms: { tSrc: { value: null }, threshold: { value: 0.85 } }, depthTest: false, depthWrite: false });
    this.blur = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: BLUR, uniforms: { tSrc: { value: null }, dir: { value: new THREE.Vector2() } }, depthTest: false, depthWrite: false });
    this.final = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FINAL,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: null },
        tBloomA: { value: null },
        tBloomB: { value: null },
        bloom: { value: 0.3 },
        exposure: { value: 1 },
        contrast: { value: 1 },
        saturation: { value: 1 },
        warmth: { value: 0 },
        vignette: { value: 0.2 },
        grain: { value: 0.03 },
        time: { value: 0 },
        aspect: { value: new THREE.Vector2(1, 1) },
      },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.final);
    this.quad.frustumCulled = false;
    this.qscene.add(this.quad);
  }

  setSize(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.scene.setSize(w, h);
    this.bloomA.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.tmpA.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.bloomB.setSize(Math.max(1, w >> 3), Math.max(1, h >> 3));
    this.tmpB.setSize(Math.max(1, w >> 3), Math.max(1, h >> 3));
  }

  private pass(gl: THREE.WebGLRenderer, mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    gl.setRenderTarget(target);
    gl.render(this.qscene, this.cam);
  }

  private blurInto(gl: THREE.WebGLRenderer, src: THREE.WebGLRenderTarget, tmp: THREE.WebGLRenderTarget, out: THREE.WebGLRenderTarget, spread: number) {
    const u = this.blur.uniforms;
    u.tSrc.value = src.texture;
    u.dir.value.set(spread / src.width, 0);
    this.pass(gl, this.blur, tmp);
    u.tSrc.value = tmp.texture;
    u.dir.value.set(0, spread / src.height);
    this.pass(gl, this.blur, out);
  }

  /** Composite the HDR scene target to the screen with the look applied. */
  finish(gl: THREE.WebGLRenderer, look: LookSettings, time: number, flashBoost = 0) {
    this.bright.uniforms.tSrc.value = this.scene.texture;
    this.bright.uniforms.threshold.value = look.bloomThreshold;
    this.pass(gl, this.bright, this.bloomA);
    this.blurInto(gl, this.bloomA, this.tmpA, this.bloomA, 1.5);
    this.blurInto(gl, this.bloomA, this.tmpB, this.bloomB, 2.5);
    this.blurInto(gl, this.bloomB, this.tmpB, this.bloomB, 2.5);
    const u = this.final.uniforms;
    u.tScene.value = this.scene.texture;
    u.tBloomA.value = this.bloomA.texture;
    u.tBloomB.value = this.bloomB.texture;
    u.bloom.value = look.bloom + flashBoost;
    u.exposure.value = look.exposure;
    u.contrast.value = look.contrast;
    u.saturation.value = look.saturation;
    u.warmth.value = look.warmth;
    u.vignette.value = look.vignette;
    u.grain.value = look.grain;
    u.time.value = time;
    u.aspect.value.set(this.w / Math.max(1, this.h), 1).normalize().multiplyScalar(1.4);
    this.pass(gl, this.final, null);
  }

  dispose() {
    [this.scene, this.bloomA, this.bloomB, this.tmpA, this.tmpB].forEach((t) => t.dispose());
    [this.bright, this.blur, this.final].forEach((m) => m.dispose());
  }
}

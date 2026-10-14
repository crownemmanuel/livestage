// Shared constants and GLSL for the photoreal (photo-based) environment.
import * as THREE from "three";
import { cached } from "../../cache";
import { smoothstep } from "@/core/clock";
import type { FrameState } from "../../frame";

export const PHOTO_BASE = "/media/shepherd-photo/";

/** Backdrop panorama mapping: horizontal span (radians) and horizon line (fraction from the top). */
export const BACKDROP = {
  span: (110 * Math.PI) / 180,
  horizonV: 0.476,
  aspect: 8192 / 2032,
  /**
   * The panorama was shot from higher ground looking over a valley; lift it so its
   * valley floor sits just beyond the edge of our hilltop pasture (tan of the angle).
   */
  elevOffset: 0.06,
};
/** Height of the image on a unit cylinder: span / aspect. */
export const BACKDROP_HSCALE = BACKDROP.span / BACKDROP.aspect;

export function photoTexture(file: string, opts: { srgb?: boolean; repeat?: boolean; aniso?: number } = {}) {
  return cached(`photo:${file}`, () => {
    const t = new THREE.TextureLoader().load(PHOTO_BASE + file);
    t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.anisotropy = opts.aniso ?? 8;
    if (opts.repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  });
}

/** Sample the panorama in a world direction (returns linear colour). */
export const BACKDROP_GLSL = /* glsl */ `
uniform sampler2D uBackdrop;
uniform sampler2D uBackdropNight;
uniform float uNightMix;
uniform float uSpan;
uniform float uHorizonV;
uniform float uHScale;
uniform float uElevOffset;
uniform vec3 uBackdropGrade;
uniform vec3 uSkyTop;
vec3 backdropAt(vec3 dir) {
  float th = atan(dir.x, -dir.z);
  float u = 0.5 + th / uSpan;
  float te = dir.y / max(length(dir.xz), 1e-4);
  float v = uHorizonV - (te - uElevOffset) / uHScale;
  vec2 uv = vec2(clamp(u, 0.0005, 0.9995), 1.0 - clamp(v, 0.002, 0.998));
  vec3 day = texture2D(uBackdrop, uv).rgb;
  vec3 night = texture2D(uBackdropNight, uv).rgb;
  vec3 c = mix(day, night, uNightMix);
  // above the photo: continue into the sky colour
  float above = smoothstep(0.0, 0.06, -v);
  c = mix(c, uSkyTop, above);
  return c * uBackdropGrade;
}
`;

export function backdropUniforms() {
  return {
    uBackdrop: { value: photoTexture("backdrop-golden.jpg", { aniso: 4 }) },
    uBackdropNight: { value: photoTexture("backdrop-golden.jpg", { aniso: 4 }) },
    uNightMix: { value: 0 },
    uSpan: { value: BACKDROP.span },
    uHorizonV: { value: BACKDROP.horizonV },
    uHScale: { value: BACKDROP_HSCALE },
    uElevOffset: { value: BACKDROP.elevOffset },
    uBackdropGrade: { value: new THREE.Color(1, 1, 1) },
    uSkyTop: { value: new THREE.Color(0.551, 0.687, 0.826).convertSRGBToLinear() },
  };
}

/** Texture lookup that hides tiling (Inigo Quilez, "texture repetition" technique 3). */
export const NOTILE_GLSL = /* glsl */ `
vec4 hash4(vec2 p) {
  return fract(sin(vec4(1.0 + dot(p, vec2(37.0, 17.0)), 2.0 + dot(p, vec2(11.0, 47.0)), 3.0 + dot(p, vec2(41.0, 29.0)), 4.0 + dot(p, vec2(23.0, 31.0)))) * 103.0);
}
vec3 textureNoTile(sampler2D samp, vec2 uv) {
  vec2 iuv = floor(uv);
  vec2 fuv = fract(uv);
  vec4 ofa = hash4(iuv + vec2(0.0, 0.0));
  vec4 ofb = hash4(iuv + vec2(1.0, 0.0));
  vec4 ofc = hash4(iuv + vec2(0.0, 1.0));
  vec4 ofd = hash4(iuv + vec2(1.0, 1.0));
  vec2 ddx = dFdx(uv);
  vec2 ddy = dFdy(uv);
  ofa.zw = sign(ofa.zw - 0.5);
  ofb.zw = sign(ofb.zw - 0.5);
  ofc.zw = sign(ofc.zw - 0.5);
  ofd.zw = sign(ofd.zw - 0.5);
  vec2 uva = uv * ofa.zw + ofa.xy; vec2 ddxa = ddx * ofa.zw; vec2 ddya = ddy * ofa.zw;
  vec2 uvb = uv * ofb.zw + ofb.xy; vec2 ddxb = ddx * ofb.zw; vec2 ddyb = ddy * ofb.zw;
  vec2 uvc = uv * ofc.zw + ofc.xy; vec2 ddxc = ddx * ofc.zw; vec2 ddyc = ddy * ofc.zw;
  vec2 uvd = uv * ofd.zw + ofd.xy; vec2 ddxd = ddx * ofd.zw; vec2 ddyd = ddy * ofd.zw;
  vec2 b = smoothstep(0.25, 0.75, fuv);
  return mix(mix(textureGrad(samp, uva, ddxa, ddya).rgb, textureGrad(samp, uvb, ddxb, ddyb).rgb, b.x),
             mix(textureGrad(samp, uvc, ddxc, ddyc).rgb, textureGrad(samp, uvd, ddxd, ddyd).rgb, b.x), b.y);
}
`;

const NIGHT_TINT = new THREE.Color(0.55, 0.66, 1.0);

/**
 * Photo grade shared by everything derived from the golden-hour photographs:
 * brightness follows the scene's light level (relative to golden hour), the
 * colour cools toward night, storms darken, lightning flashes brighten.
 */
export function photoGrade(f: FrameState, out: THREE.Color) {
  const night = smoothstep(0.55, 1, f.tod);
  const level = Math.min(1.15, f.ambient / 0.95);
  out.setRGB(1, 1, 1).lerp(NIGHT_TINT, night).multiplyScalar(level * (1 - 0.35 * f.storm));
  return out;
}

/** Every photo the photoreal valley uses; preloaded at startup so TAKE never waits on downloads. */
export const PHOTO_FILES = [
  "backdrop-golden.jpg",
  "ground-pasture.jpg",
  "tree1.png",
  "tree2.png",
  "tree3.png",
  "sheep1.png",
  "sheep2.png",
  "sheep3.png",
  "rock1.png",
  "rock2.png",
  "grass1.png",
  "grass2.png",
  "grass3.png",
];

export function preloadPhotoAssets() {
  for (const f of PHOTO_FILES) photoTexture(f, f.startsWith("ground") ? { repeat: true, aniso: 16 } : {});
}

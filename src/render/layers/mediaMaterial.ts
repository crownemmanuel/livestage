import * as THREE from "three";
import type { BlendMode, ChromaKey, Crop, LayerMask } from "@/core/types";

const vert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const frag = /* glsl */ `
uniform sampler2D map;
uniform float opacity;
uniform vec4 crop; // left, right, top, bottom
uniform float flipX;
uniform float chroma;
uniform vec3 keyColor;
uniform float similarity;
uniform float smoothness;
uniform float spill;
uniform float maskShape;
uniform float feather;
uniform float blendMode; // 0 normal, 1 add, 2 screen, 3 multiply
uniform vec3 grade;
uniform float decodeSrgb;
varying vec2 vUv;

// three.js uploads video frames without sRGB decoding (linear internal format),
// so custom shaders must decode them or colours come out washed out.
vec3 srgbToLinear(vec3 c) {
  return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, step(c, vec3(0.04045)));
}

vec2 rgbToUv(vec3 c) {
  return vec2(c.r * -0.169 + c.g * -0.331 + c.b * 0.5 + 0.5, c.r * 0.5 + c.g * -0.419 + c.b * -0.081 + 0.5);
}

void main() {
  vec2 uv = vUv;
  if (flipX > 0.5) uv.x = 1.0 - uv.x;
  vec2 tuv = vec2(mix(crop.x, 1.0 - crop.y, uv.x), mix(crop.w, 1.0 - crop.z, uv.y));
  vec4 c = texture2D(map, tuv);
  if (decodeSrgb > 0.5) c.rgb = srgbToLinear(c.rgb);
  float a = c.a;
  if (chroma > 0.5) {
    float d = distance(rgbToUv(c.rgb), rgbToUv(keyColor));
    float m = smoothstep(similarity, similarity + smoothness, d);
    a *= m;
    // suppress key-colour spill on remaining edges
    float s = pow(clamp(1.0 - smoothstep(similarity, similarity + spill + 0.001, d), 0.0, 1.0), 1.5);
    float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
    c.rgb = mix(c.rgb, vec3(lum), s * spill * 2.0);
  }
  float m = 1.0;
  if (maskShape > 0.5 && maskShape < 1.5) {
    float e = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    m = smoothstep(0.0, max(feather, 0.0001), e);
  } else if (maskShape > 1.5) {
    float r = length((vUv - 0.5) * 2.0);
    m = 1.0 - smoothstep(1.0 - max(feather * 2.0, 0.0001), 1.0, r);
  }
  a *= m * opacity;
  c.rgb *= grade;
  if (blendMode < 0.5) gl_FragColor = vec4(c.rgb, a);
  else if (blendMode < 1.5) gl_FragColor = vec4(c.rgb, a);
  else if (blendMode < 2.5) gl_FragColor = vec4(c.rgb * a, a);
  else gl_FragColor = vec4(mix(vec3(1.0), c.rgb, a), 1.0);
  #include <colorspace_fragment>
}
`;

export function makeMediaMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    uniforms: {
      map: { value: null },
      opacity: { value: 1 },
      crop: { value: new THREE.Vector4() },
      flipX: { value: 0 },
      chroma: { value: 0 },
      keyColor: { value: new THREE.Color("#00ff00") },
      similarity: { value: 0.35 },
      smoothness: { value: 0.08 },
      spill: { value: 0.3 },
      maskShape: { value: 0 },
      feather: { value: 0.05 },
      blendMode: { value: 0 },
      grade: { value: new THREE.Color(1, 1, 1) },
      decodeSrgb: { value: 0 },
    },
  });
}

/** Set the texture and whether the shader must decode it (video frames). */
export function setMap(mat: THREE.ShaderMaterial, tex: THREE.Texture | null) {
  mat.uniforms.map.value = tex;
  mat.uniforms.decodeSrgb.value = tex && (tex as THREE.VideoTexture).isVideoTexture && tex.colorSpace === THREE.SRGBColorSpace ? 1 : 0;
}

export function applyBlend(mat: THREE.ShaderMaterial, mode: BlendMode) {
  mat.uniforms.blendMode.value = { normal: 0, add: 1, screen: 2, multiply: 3 }[mode];
  if (mode === "add") mat.blending = THREE.AdditiveBlending;
  else if (mode === "screen") {
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneMinusSrcColorFactor;
  } else if (mode === "multiply") {
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.DstColorFactor;
    mat.blendDst = THREE.ZeroFactor;
  } else mat.blending = THREE.NormalBlending;
}

export function applyMediaSettings(
  mat: THREE.ShaderMaterial,
  o: { crop: Crop; flipX?: boolean; chroma?: ChromaKey; mask?: LayerMask },
) {
  const u = mat.uniforms;
  u.crop.value.set(o.crop.left, o.crop.right, o.crop.top, o.crop.bottom);
  u.flipX.value = o.flipX ? 1 : 0;
  if (o.chroma) {
    u.chroma.value = o.chroma.enabled ? 1 : 0;
    u.keyColor.value.set(o.chroma.color);
    u.similarity.value = o.chroma.similarity;
    u.smoothness.value = o.chroma.smoothness;
    u.spill.value = o.chroma.spill;
  } else u.chroma.value = 0;
  if (o.mask) {
    u.maskShape.value = { none: 0, rect: 1, ellipse: 2 }[o.mask.shape];
    u.feather.value = o.mask.feather;
  }
}

/** Operator-only marker for empty asset slots. */
let missingTex: THREE.CanvasTexture | null = null;
export function missingTexture() {
  if (missingTex) return missingTex;
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 288;
  const g = c.getContext("2d")!;
  for (let y = 0; y < 288; y += 32) for (let x = 0; x < 512; x += 32) {
    g.fillStyle = (x + y) % 64 === 0 ? "rgba(255,0,170,0.28)" : "rgba(40,0,30,0.28)";
    g.fillRect(x, y, 32, 32);
  }
  g.strokeStyle = "rgba(255,80,190,0.9)";
  g.lineWidth = 6;
  g.strokeRect(3, 3, 506, 282);
  g.fillStyle = "#fff";
  g.font = "bold 38px sans-serif";
  g.textAlign = "center";
  g.fillText("NO ASSET", 256, 135);
  g.font = "22px sans-serif";
  g.fillText("operator preview only", 256, 175);
  missingTex = new THREE.CanvasTexture(c);
  missingTex.colorSpace = THREE.SRGBColorSpace;
  return missingTex;
}

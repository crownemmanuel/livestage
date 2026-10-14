import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { smoothstep } from "@/core/clock";
import { NOISE_GLSL } from "../glsl";
import { useStage } from "../frame";
import { debugHidden } from "../debug";

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // pin to far plane
}
`;

const frag = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform float uSunVis;
uniform float uNight;
uniform float uStorm;
uniform float uTime;
uniform float uFlash;
uniform float uWind;
uniform float uAmbient;
varying vec3 vDir;
${NOISE_GLSL}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float stars(vec3 d) {
  vec3 p = d * 320.0;
  vec3 i = floor(p);
  vec3 f = fract(p) - 0.5;
  float h = hash13(i);
  if (h < 0.9965) return 0.0;
  vec3 o = vec3(hash13(i + 1.7), hash13(i + 3.1), hash13(i + 5.9)) - 0.5;
  float s = smoothstep(0.16, 0.0, length(f - o * 0.6));
  float tw = 0.7 + 0.3 * sin(uTime * (1.5 + h * 30.0) + h * 100.0);
  return s * tw * (h - 0.9965) / 0.0035;
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float hk = pow(clamp(1.0 - max(h, 0.0), 0.0, 1.0), 2.6);
  vec3 col = mix(uZenith, uHorizon, hk);
  if (h < 0.0) col = uHorizon * mix(0.9, 0.6, clamp(-h * 6.0, 0.0, 1.0));

  float sd = max(dot(d, uSunDir), 0.0);
  float clear = 1.0 - uStorm * 0.85;
  col += uSunColor * (pow(sd, 6.0) * 0.28 + pow(sd, 48.0) * 0.5) * uSunVis * clear;
  col += uSunColor * smoothstep(0.99935, 0.99965, sd) * 6.0 * uSunVis * clear;

  float md = dot(d, uMoonDir);
  vec3 moonCol = vec3(0.85, 0.9, 1.0);
  col += moonCol * smoothstep(0.99955, 0.99972, md) * 2.4 * uNight * clear;
  col += moonCol * pow(max(md, 0.0), 220.0) * 0.18 * uNight;

  col += vec3(0.9, 0.93, 1.0) * stars(d) * uNight * smoothstep(0.0, 0.15, h) * clear * 1.6;

  // Clouds: a scrolling fbm layer projected onto the dome.
  vec2 cp = d.xz / (max(h, 0.0) + 0.08) * 0.55;
  cp += vec2(uTime * 0.006 * (0.4 + uWind), uTime * 0.0025);
  float n = fbm6(cp * 1.2);
  float cover = mix(0.56, 0.18, uStorm);
  float cloud = smoothstep(cover, cover + 0.28, n) * smoothstep(-0.02, 0.18, h);
  float shade = fbm4(cp * 2.3 + 4.0);
  vec3 lit = mix(vec3(1.0), uHorizon * 1.15, 0.3) * mix(1.0, 0.16, uNight);
  vec3 dark = vec3(0.2, 0.22, 0.26) * mix(1.0, 0.35, uNight);
  vec3 cc = mix(lit, dark, clamp(uStorm * 0.85 + shade * 0.35, 0.0, 1.0));
  cc += uSunColor * pow(sd, 3.0) * 0.45 * uSunVis * (1.0 - uStorm * 0.6);
  cc += vec3(0.75, 0.8, 1.0) * uFlash * (0.8 + shade);
  col = mix(col, cc, cloud * mix(0.82, 0.97, uStorm));
  col += vec3(0.6, 0.65, 0.85) * uFlash * 0.22;

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function Sky() {
  const { frame } = useStage();
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uZenith: { value: new THREE.Color() },
          uHorizon: { value: new THREE.Color() },
          uSunDir: { value: new THREE.Vector3() },
          uSunColor: { value: new THREE.Color() },
          uMoonDir: { value: new THREE.Vector3() },
          uSunVis: { value: 1 },
          uNight: { value: 0 },
          uStorm: { value: 0 },
          uTime: { value: 0 },
          uFlash: { value: 0 },
          uWind: { value: 0 },
          uAmbient: { value: 1 },
        },
      }),
    [],
  );
  const geo = useMemo(() => new THREE.SphereGeometry(5000, 64, 32), []);

  useFrame(({ camera }, _dt) => {
    const u = mat.uniforms;
    u.uZenith.value.copy(frame.zenith);
    u.uHorizon.value.copy(frame.horizon);
    u.uSunDir.value.copy(frame.sunDir);
    u.uSunColor.value.copy(frame.sunColor);
    u.uMoonDir.value.copy(frame.moonDir);
    u.uSunVis.value = smoothstep(-0.08, 0.05, frame.sunDir.y);
    u.uNight.value = smoothstep(0.62, 0.95, frame.tod);
    u.uStorm.value = frame.storm;
    u.uTime.value = frame.ts;
    u.uFlash.value = frame.flash;
    u.uWind.value = frame.windNow;
    u.uAmbient.value = frame.ambient;
    mesh.position.copy(camera.position);
    mesh.visible = !debugHidden.has("sky");
  });

  const mesh = useMemo(() => {
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = -10;
    return m;
  }, [geo, mat]);

  return <primitive object={mesh} />;
}

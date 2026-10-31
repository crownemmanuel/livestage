// The scanned-asset valley ("shepherd-pbr"): the pasture's ground shape lit by a real
// HDRI sky (image-based lighting + visible dome), a PBR ground (scanned textures with
// hidden tiling), and photogrammetry trees, rocks and grass placed as instances.
// Night falls back to the procedural starry sky as the dome fades out.
import { Suspense, useEffect, useMemo } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { fbm, rng, valueNoise } from "@/core/noise";
import { smoothstep, lerp } from "@/core/clock";
import { terrainHeight } from "@/core/terrain";
import { NOISE_GLSL } from "../../glsl";
import { cached } from "../../cache";
import { useStage } from "../../frame";
import { NOTILE_GLSL } from "../photoreal/shared";
import { Sky } from "../Sky";
import { Grass } from "../Grass";
import { loadHdri, PBR_BASE } from "./hdri";
import { PBR_MANIFEST, type GroundSet, type ScatterSpec } from "./manifest";

const PRESET = "shepherd-pbr" as const;

/** Wind uniforms shared by every swaying material (one object, updated once per frame). */
const wind = { uTime: { value: 0 }, uWind: { value: 0.2 } };
/** The sky image and its grade, shared by the dome and the ground (which dissolves into it with distance). */
const sky = { tSky: { value: null as THREE.Texture | null }, uSkyOn: { value: 0 }, uDay: { value: 1 }, uExposure: { value: 1 }, uGrade: { value: new THREE.Color(1, 1, 1) } };

const SKY_GLSL = /* glsl */ `
uniform sampler2D tSky;
uniform float uSkyOn;
uniform float uExposure;
uniform vec3 uGrade;
vec3 skyAt(vec3 d) {
  vec2 uv = vec2(atan(d.z, d.x) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
  return texture2D(tSky, uv).rgb * uExposure * uGrade;
}
`;

// ---------------------------------------------------------------- sky dome + image-based lighting

const domeVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const domeFrag = /* glsl */ `
uniform float uDay;
varying vec3 vDir;
${SKY_GLSL}
void main() {
  vec3 c = skyAt(normalize(vDir));
  gl_FragColor = vec4(c, uDay);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function HdriSky({ hdr }: { hdr: THREE.DataTexture }) {
  const { frame } = useStage();
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: domeVert,
        fragmentShader: domeFrag,
        side: THREE.BackSide,
        depthWrite: false,
        transparent: true,
        fog: false,
        uniforms: sky,
      }),
    [],
  );
  useEffect(() => {
    sky.tSky.value = hdr;
    sky.uSkyOn.value = 1;
    return () => {
      sky.uSkyOn.value = 0;
    };
  }, [hdr]);
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(5000, 64, 32), mat);
    m.frustumCulled = false;
    m.renderOrder = -9;
    return m;
  }, [mat]);

  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const rt = pmrem.fromEquirectangular(hdr);
    scene.environment = rt.texture;
    return () => {
      scene.environment = null;
      rt.dispose();
      pmrem.dispose();
    };
  }, [gl, scene, hdr]);

  const grade = useMemo(() => new THREE.Color(), []);
  useFrame(({ camera }) => {
    mesh.position.copy(camera.position);
    const dusk = smoothstep(0.3, 0.55, frame.tod);
    const night = smoothstep(0.55, 0.9, frame.tod);
    // The image is a daytime sky: warm it toward sunset, then hand over to the starry dome.
    grade.setRGB(1, 1, 1).lerp(tmpWarm, dusk).multiplyScalar(lerp(1, 0.55, dusk) * (1 - 0.6 * frame.storm));
    sky.uGrade.value.copy(grade);
    sky.uDay.value = 1 - night;
    sky.uExposure.value = PBR_MANIFEST.hdriExposure;
    const s = scene as THREE.Scene & { environmentIntensity: number };
    s.environmentIntensity = PBR_MANIFEST.hdriExposure * lerp(1, 0.08, night) * (1 - 0.5 * frame.storm) + frame.flash * 0.5;
  });
  return <primitive object={mesh} />;
}
const tmpWarm = new THREE.Color(1.0, 0.72, 0.48);

// ---------------------------------------------------------------- ground

function groundTexture(file: string, srgb: boolean) {
  return cached(`pbr:${file}`, () => {
    const t = new THREE.TextureLoader().load(PBR_BASE + file);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 16;
    return t;
  });
}

/** The pasture grid with world-space UVs, a tint for dry/green patches and a mask for worn ground. */
function buildGround(tile: number) {
  const SEG_X = 300;
  const SEG_Z = 320;
  const A = 5;
  const sA = Math.sinh(A);
  const warp = (u: number, neg: number, pos: number) => (u < 0 ? -neg : pos) * (Math.sinh(A * Math.abs(u)) / sA);
  const verts = (SEG_X + 1) * (SEG_Z + 1);
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const col = new Float32Array(verts * 3);
  const blend = new Float32Array(verts);
  const dry = new THREE.Color(1.1, 1.02, 0.78);
  const c = new THREE.Color();
  let i = 0;
  for (let iz = 0; iz <= SEG_Z; iz++) {
    const z = -20 + warp((iz / SEG_Z) * 2 - 1, 2200, 160);
    for (let ix = 0; ix <= SEG_X; ix++) {
      const x = warp((ix / SEG_X) * 2 - 1, 2000, 2000);
      const h = terrainHeight(PRESET, x, z);
      const e = 0.35;
      const hx = terrainHeight(PRESET, x + e, z) - terrainHeight(PRESET, x - e, z);
      const hz = terrainHeight(PRESET, x, z + e) - terrainHeight(PRESET, x, z - e);
      const n = new THREE.Vector3(-hx, 2 * e, -hz).normalize();
      pos.set([x, h, z], i * 3);
      nrm.set([n.x, n.y, n.z], i * 3);
      uv.set([x / tile, z / tile], i * 2);
      const dryK = Math.min(1, Math.max(0, fbm(x * 0.018 + 4, z * 0.018, 3) * 1.6 - 0.4));
      const shade = 0.9 + 0.2 * valueNoise(x * 0.25, z * 0.25);
      c.setRGB(1, 1, 1).lerp(dry, dryK * 0.7).multiplyScalar(shade);
      col.set([c.r, c.g, c.b], i * 3);
      const dirt = Math.max(0, valueNoise(x * 0.06 + 10, z * 0.06) - 0.68) * 2.5;
      const slope = 1 - n.y;
      blend[i] = Math.min(1, dirt + Math.max(0, (slope - 0.1) * 5));
      i++;
    }
  }
  const idx = new Uint32Array(SEG_X * SEG_Z * 6);
  let k = 0;
  for (let iz = 0; iz < SEG_Z; iz++) {
    for (let ix = 0; ix < SEG_X; ix++) {
      const a = iz * (SEG_X + 1) + ix;
      idx.set([a, a + SEG_X + 1, a + 1, a + 1, a + SEG_X + 1, a + SEG_X + 2], k);
      k += 6;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aBlend", new THREE.BufferAttribute(blend, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

function groundMaterial(set: GroundSet, alt: GroundSet | null) {
  const mat = new THREE.MeshStandardMaterial({
    map: groundTexture(set.diffuse, true),
    normalMap: groundTexture(set.normal, false),
    roughnessMap: groundTexture(set.roughness, false),
    aoMap: set.ao ? groundTexture(set.ao, false) : null,
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    color: "#ffffff",
  });
  const uniforms = {
    ...sky,
    uMap2: { value: alt ? groundTexture(alt.diffuse, true) : mat.map },
    uNormal2: { value: alt ? groundTexture(alt.normal, false) : mat.normalMap },
    uRough2: { value: alt ? groundTexture(alt.roughness, false) : mat.roughnessMap },
    uTile2: { value: alt ? set.tile / alt.tile : 1 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aBlend;\nvarying float vBlend;\nvarying vec3 vWPos;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvBlend = aBlend;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying float vBlend;
        varying vec3 vWPos;
        uniform sampler2D uMap2;
        uniform sampler2D uNormal2;
        uniform sampler2D uRough2;
        uniform float uTile2;
        float gDist;
        ${NOISE_GLSL}
        ${NOTILE_GLSL}
        ${SKY_GLSL}`,
      )
      .replace(
        "#include <map_fragment>",
        `gDist = length(vWPos.xz - cameraPosition.xz);
        vec3 a1 = textureNoTile(map, vMapUv);
        vec3 a2 = textureNoTile(uMap2, vMapUv * uTile2);
        vec3 alb = mix(a1, a2, vBlend);
        // large-scale variation so the field never reads as one repeated photo
        float mid = fbm4(vWPos.xz * 0.21 + 7.0) - 0.5;
        float broad = fbm4(vWPos.xz * 0.045 + 3.0) - 0.5;
        alb *= 1.0 + mid * 0.28 + broad * 0.3;
        // far slopes: low-frequency scrub patches so the hills do not read as one flat tone
        float far = smoothstep(60.0, 360.0, gDist);
        float veg = smoothstep(0.45, 0.78, fbm4(vWPos.xz * 0.012 + 11.0));
        alb = mix(alb, vec3(0.36, 0.38, 0.2), far * 0.5);
        alb = mix(alb, alb * vec3(0.5, 0.56, 0.36), veg * far * 0.8);
        diffuseColor.rgb *= alb;`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#ifdef USE_NORMALMAP_TANGENTSPACE
        {
          vec3 n1 = textureNoTile(normalMap, vNormalMapUv) * 2.0 - 1.0;
          vec3 n2 = textureNoTile(uNormal2, vNormalMapUv * uTile2) * 2.0 - 1.0;
          vec3 mapN = normalize(mix(n1, n2, vBlend));
          mapN.xy *= normalScale * (1.0 - 0.8 * smoothstep(30.0, 140.0, gDist));
          normal = normalize(tbn * mapN);
        }
        #endif`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
        {
          float r1 = texture2D(roughnessMap, vRoughnessMapUv).g;
          float r2 = texture2D(uRough2, vRoughnessMapUv * uTile2).g;
          roughnessFactor *= mix(r1, r2, vBlend);
        }
        #endif`,
      )
      .replace(
        "#include <opaque_fragment>",
        `#include <opaque_fragment>
        {
          // the far field dissolves into the photographed landscape of the sky image
          vec3 toFrag = vWPos - cameraPosition;
          float k = smoothstep(160.0, 420.0, length(toFrag.xz)) * uSkyOn;
          gl_FragColor.rgb = mix(gl_FragColor.rgb, skyAt(normalize(toFrag)), k);
        }`,
      );
  };
  return mat;
}

function Ground() {
  const m = PBR_MANIFEST;
  const geo = cached("pbr-ground", () => buildGround(m.ground.tile));
  const mat = cached("pbr-ground-mat", () => groundMaterial(m.ground, m.groundAlt));
  return <mesh geometry={geo} material={mat} receiveShadow dispose={null} />;
}

// ---------------------------------------------------------------- scanned props as instances

const windChunk = /* glsl */ `
#include <begin_vertex>
{
  #ifdef USE_INSTANCING
  vec3 ipos = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  #else
  vec3 ipos = vec3(0.0);
  #endif
  float hgt = clamp(position.y / uHeight, 0.0, 1.0);
  float ph = ipos.x * 0.31 + ipos.z * 0.17;
  float gust = 0.6 + 0.4 * sin(uTime * 0.55 + ipos.x * 0.04);
  float bend = hgt * hgt * uSway * uWind * gust;
  transformed.x += bend * (0.6 * sin(uTime * 1.9 + ph) + 0.4);
  transformed.z += bend * 0.3 * sin(uTime * 1.3 + ph * 1.7);
}`;

function addWind(mat: THREE.Material, height: number, sway: number) {
  const m = mat as THREE.MeshStandardMaterial;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = wind.uTime;
    shader.uniforms.uWind = wind.uWind;
    shader.uniforms.uHeight = { value: height };
    shader.uniforms.uSway = { value: sway };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform float uWind;\nuniform float uHeight;\nuniform float uSway;")
      .replace("#include <begin_vertex>", windChunk);
  };
  m.customProgramCacheKey = () => `wind`;
}

/** Deterministic placements for one scatter spec; the stage apron, the flock and the fire stay clear. */
function placements(spec: ScatterSpec): THREE.Matrix4[] {
  const r = rng(spec.seed);
  const [x0, x1, z0, z1] = spec.area;
  const out: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let tries = 0; tries < spec.count * 12 && out.length < spec.count; tries++) {
    const x = x0 + r() * (x1 - x0);
    let z = z0 + r() * (z1 - z0);
    if (spec.nearBias) z = z1 - Math.pow(r(), 1 + spec.nearBias) * (z1 - z0);
    if (Math.abs(x) < 7 && z > -60 && spec.height > 1.5) continue; // the playing area in front of the stage
    if (Math.hypot(x + 4, z + 30) < 14 && spec.height > 1.5) continue; // the flock
    if (Math.hypot(x - 7, z + 16) < 3) continue; // the fire
    const s = spec.scale[0] + r() * (spec.scale[1] - spec.scale[0]);
    e.set(0, r() * Math.PI * 2, 0);
    q.setFromEuler(e);
    const y = terrainHeight(PRESET, x, z) - (spec.sink ?? 0.05) * s;
    out.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s, s)));
  }
  return out;
}

/** Every mesh of a glTF as one InstancedMesh (geometry baked into the model's own frame). */
function instancedFromGltf(gltf: GLTF, spec: ScatterSpec, mats: THREE.Matrix4[]) {
  gltf.scene.updateMatrixWorld(true);
  const meshes: THREE.InstancedMesh[] = [];
  gltf.scene.traverse((o) => {
    const src = o as THREE.Mesh;
    if (!src.isMesh) return;
    const geo = src.geometry.clone().applyMatrix4(src.matrixWorld);
    const material = (Array.isArray(src.material) ? src.material[0] : src.material).clone() as THREE.MeshStandardMaterial;
    const cutout = material.alphaTest > 0 || material.transparent;
    if (cutout) {
      material.transparent = false;
      material.alphaTest = Math.max(material.alphaTest, 0.4);
      material.side = THREE.DoubleSide;
    }
    if (spec.wind === "all" || (spec.wind === "leaves" && cutout)) addWind(material, spec.height, spec.wind === "all" ? 0.12 : 0.25);
    const im = new THREE.InstancedMesh(geo, material, Math.max(1, mats.length));
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.count = mats.length;
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    meshes.push(im);
  });
  return meshes;
}

function ScatterGroup({ specs, kind }: { specs: ScatterSpec[]; kind: string }) {
  const gltfs = useLoader(GLTFLoader, specs.map((s) => PBR_BASE + s.file));
  const meshes = useMemo(
    () =>
      specs.flatMap((spec, i) =>
        cached(`pbr-scatter:${kind}:${spec.file}:${spec.seed}:${spec.count}`, () => instancedFromGltf(gltfs[i], spec, placements(spec))),
      ),
    [gltfs, specs, kind],
  );
  return (
    <>
      {meshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
    </>
  );
}

function Props() {
  const m = PBR_MANIFEST;
  return (
    <>
      {m.trees.length > 0 && <ScatterGroup specs={m.trees} kind="trees" />}
      {m.rocks.length > 0 && <ScatterGroup specs={m.rocks} kind="rocks" />}
      {m.grass.length > 0 && <ScatterGroup specs={m.grass} kind="grass" />}
    </>
  );
}

// ---------------------------------------------------------------- scene

function SkyLoader() {
  const hdr = useLoader(HdriAsLoader, PBR_MANIFEST.hdri);
  return <HdriSky hdr={hdr} />;
}

/** Adapter so useLoader can suspend on the shared HDRI promise. */
class HdriAsLoader extends THREE.Loader<THREE.DataTexture, string> {
  load(file: string, onLoad: (t: THREE.DataTexture) => void, _p?: unknown, onError?: (e: unknown) => void) {
    loadHdri(file).then(onLoad, onError);
  }
}

export function PbrValley() {
  const { frame } = useStage();
  useFrame(() => {
    wind.uTime.value = frame.ts;
    wind.uWind.value = frame.windNow;
  });
  return (
    <>
      <Sky />
      <Suspense fallback={null}>
        <SkyLoader />
      </Suspense>
      <Ground />
      <Grass preset={PRESET} />
      <Suspense fallback={null}>
        <Props />
      </Suspense>
    </>
  );
}

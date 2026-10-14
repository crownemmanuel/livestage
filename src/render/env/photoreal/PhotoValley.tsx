import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { terrainHeight } from "@/core/terrain";
import type { ProceduralComponent } from "@/core/types";
import { cached } from "../../cache";
import { NOISE_GLSL } from "../../glsl";
import { useStage } from "../../frame";
import { BACKDROP_GLSL, backdropUniforms, NOTILE_GLSL, photoGrade, photoTexture } from "./shared";
import { PhotoGrass, PhotoSprites } from "./PhotoSprites";

const PRESET = "shepherd-photoreal" as const;

// ---------------------------------------------------------------- backdrop

function Backdrop() {
  const { frame } = useStage();
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position = p.xyww;
          }`,
        fragmentShader: /* glsl */ `
          varying vec3 vDir;
          ${BACKDROP_GLSL}
          void main() {
            gl_FragColor = vec4(backdropAt(normalize(vDir)), 1.0);
            #include <colorspace_fragment>
          }`,
        uniforms: backdropUniforms(),
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    [],
  );
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(4000, 96, 48), mat);
    m.frustumCulled = false;
    m.renderOrder = -10;
    return m;
  }, [mat]);
  useFrame(({ camera }) => {
    mesh.position.copy(camera.position);
    photoGrade(frame, mat.uniforms.uBackdropGrade.value);
  });
  return <primitive object={mesh} />;
}

// ---------------------------------------------------------------- environment lighting from the photo

function PhotoIBL() {
  const { frame } = useStage();
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const envScene = new THREE.Scene();
    const mat = new THREE.ShaderMaterial({
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vDir; ${BACKDROP_GLSL} void main(){ vec3 d = normalize(vDir);
        // below the horizon the light comes from sunlit grass, not the photo's distant field
        vec3 c = d.y < -0.02 ? vec3(0.16, 0.14, 0.07) : backdropAt(d);
        gl_FragColor = vec4(c, 1.0); }`,
      uniforms: backdropUniforms(),
      side: THREE.BackSide,
    });
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), mat));
    const pmrem = new THREE.PMREMGenerator(gl);
    let rt: THREE.WebGLRenderTarget | null = null;
    const tex = mat.uniforms.uBackdrop.value as THREE.Texture;
    // The panorama may still be loading; build the light probe once it has pixels.
    const poll = setInterval(() => {
      const img = tex.image as HTMLImageElement | undefined;
      if (!img || !img.complete || !img.naturalWidth) return;
      clearInterval(poll);
      rt = pmrem.fromScene(envScene, 0.02, 0.1, 500);
      scene.environment = rt.texture;
    }, 100);
    return () => {
      clearInterval(poll);
      scene.environment = null;
      rt?.dispose();
      pmrem.dispose();
      mat.dispose();
    };
  }, [gl, scene]);
  useFrame(() => {
    // The probe is golden hour; scale it with the scene's light level.
    (scene as THREE.Scene & { environmentIntensity: number }).environmentIntensity = 0.55 * Math.min(1.2, frame.ambient) * (1 - 0.4 * frame.storm);
  });
  return null;
}

// ---------------------------------------------------------------- terrain

function buildPhotoTerrain() {
  const SEG_X = 280;
  const SEG_Z = 300;
  const A = 5;
  const sA = Math.sinh(A);
  const warp = (u: number, neg: number, pos: number) => (u < 0 ? -neg : pos) * (Math.sinh(A * Math.abs(u)) / sA);
  const pos = new Float32Array((SEG_X + 1) * (SEG_Z + 1) * 3);
  const nrm = new Float32Array(pos.length);
  let i = 0;
  for (let iz = 0; iz <= SEG_Z; iz++) {
    const z = -20 + warp((iz / SEG_Z) * 2 - 1, 1800, 140);
    for (let ix = 0; ix <= SEG_X; ix++) {
      const x = warp((ix / SEG_X) * 2 - 1, 1800, 1800);
      const h = terrainHeight(PRESET, x, z);
      const e = 0.4;
      const n = new THREE.Vector3(
        -(terrainHeight(PRESET, x + e, z) - terrainHeight(PRESET, x - e, z)),
        2 * e,
        -(terrainHeight(PRESET, x, z + e) - terrainHeight(PRESET, x, z - e)),
      ).normalize();
      pos.set([x, h, z], i * 3);
      nrm.set([n.x, n.y, n.z], i * 3);
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
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

function PhotoTerrain() {
  const { frame } = useStage();
  const { mat, uniforms } = useMemo(() => {
    const uniforms = {
      ...backdropUniforms(),
      uGround: { value: photoTexture("ground-pasture.jpg", { repeat: true, aniso: 16 }) },
      uTile: { value: 2.6 },
      uBlendNear: { value: 70 },
      uBlendFar: { value: 210 },
      uBump: { value: 2.2 },
    };
    // No scene fog: aerial perspective comes from the photograph itself (backdrop projection).
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.97, metalness: 0, color: "#ffffff", fog: false });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
        .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec3 vWPos;
          uniform sampler2D uGround;
          uniform float uTile;
          uniform float uBlendNear;
          uniform float uBlendFar;
          uniform float uBump;
          float gHeight;
          ${NOISE_GLSL}
          ${NOTILE_GLSL}
          ${BACKDROP_GLSL}`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          vec3 g = textureNoTile(uGround, vWPos.xz / uTile);
          // large-scale variation so the field is not uniform: greener dips, drier crowns, worn patches
          float m1 = fbm4(vWPos.xz * 0.018);
          float m2 = fbm4(vWPos.xz * 0.06 + 7.0);
          g *= 0.82 + 0.36 * m1;
          // warm the texture toward the golden field in the photograph
          g *= vec3(1.1, 1.0, 0.68);
          g = mix(g, g * vec3(1.12, 1.02, 0.72), smoothstep(0.55, 0.78, m2));
          gHeight = dot(g, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb *= g;`,
        )
        .replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>
          {
            // bump from the photo's own luminance (screen-space derivatives)
            vec3 sx = dFdx(-vViewPosition);
            vec3 sy = dFdy(-vViewPosition);
            vec3 r1 = cross(sy, normal);
            vec3 r2 = cross(normal, sx);
            float det = dot(sx, r1);
            float fade = 1.0 - smoothstep(10.0, 60.0, length(vViewPosition));
            vec3 grad = sign(det) * (dFdx(gHeight) * r1 + dFdy(gHeight) * r2) * uBump * fade;
            normal = normalize(abs(det) * normal - grad);
          }`,
        )
        .replace(
          "#include <opaque_fragment>",
          `#include <opaque_fragment>
          {
            // dissolve the 3D field into the photographic backdrop with distance
            vec3 toFrag = vWPos - cameraPosition;
            float k = smoothstep(uBlendNear, uBlendFar, length(toFrag.xz));
            gl_FragColor.rgb = mix(gl_FragColor.rgb, backdropAt(normalize(toFrag)), k);
          }`,
        );
    };
    return { mat, uniforms };
  }, []);
  useFrame(() => photoGrade(frame, uniforms.uBackdropGrade.value));
  const geo = cached("photo-terrain", buildPhotoTerrain);
  return <mesh geometry={geo} material={mat} receiveShadow dispose={null} />;
}

// ---------------------------------------------------------------- scene

export function PhotoValley({ sheep }: { sheep: ProceduralComponent | null }) {
  return (
    <>
      <Backdrop />
      <PhotoIBL />
      <PhotoTerrain />
      <PhotoGrass />
      <PhotoSprites sheep={sheep} />
    </>
  );
}

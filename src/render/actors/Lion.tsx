import { Component, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { fbm } from "@/core/noise";
import { LION_ACTION_INFO } from "@/core/lion";
import type { ActorComponent, EnvironmentPreset, LionAction } from "@/core/types";
import { useModelInfo } from "@/store/modelInfo";
import { NOISE_GLSL } from "../glsl";
import { cached } from "../cache";
import { useStage } from "../frame";
import { blendPose, computePose, newPose } from "./lionPose";
import { useActorMotion, type ActorFrame } from "./motion";

interface Props {
  comp: ActorComponent;
  preset: EnvironmentPreset;
}

export function Lion({ comp, preset }: Props) {
  const { assets } = useStage();
  const asset = comp.assetId ? assets.find((a) => a.id === comp.assetId) : undefined;
  const motion = useActorMotion(comp, preset);
  if (asset) {
    return (
      <ModelErrorBoundary key={asset.url} fallback={<ProceduralLion comp={comp} motion={motion} />} assetId={asset.id}>
        <Suspense fallback={null}>
          <GlbLion comp={comp} url={asset.url} assetId={asset.id} motion={motion} />
        </Suspense>
      </ModelErrorBoundary>
    );
  }
  return <ProceduralLion comp={comp} motion={motion} />;
}

// ---------------------------------------------------------------- shared bits

function ContactShadow({ motion }: { motion: ActorFrame }) {
  const { frame } = useStage();
  const { mesh, mat } = useMemo(() => {
    const tex = cached("blob-shadow", () => {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const g = c.getContext("2d")!;
      const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
      grd.addColorStop(0, "rgba(0,0,0,0.85)");
      grd.addColorStop(0.5, "rgba(0,0,0,0.4)");
      grd.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grd;
      g.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    });
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 2;
    return { mesh, mat };
  }, []);
  useFrame(() => {
    mesh.position.set(motion.x, motion.y + 0.03, motion.z);
    mesh.rotation.z = motion.heading;
    mesh.scale.set(1.5, 2.9, 1);
    // contact shadow matters most when the sun is weak (night, storm)
    mat.opacity = motion.visible * (0.35 + 0.35 * (1 - Math.min(1, frame.sunIntensity / 2)));
    mesh.visible = motion.visible > 0.01;
  });
  return <primitive object={mesh} />;
}

function applyVisibility(root: THREE.Object3D, v: number) {
  root.visible = v > 0.01;
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const mm of Array.isArray(m) ? m : [m]) {
      mm.transparent = v < 0.999;
      mm.opacity = v;
      mm.depthWrite = v > 0.5;
    }
  });
}

// ---------------------------------------------------------------- procedural placeholder

function furMaterial(color: string, rough = 0.92) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vLP;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLP = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vLP;\n${NOISE_GLSL}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float fur = fbm4(vLP.xy * 38.0 + vLP.z * 21.0);
        float furPatch = fbm4(vLP.xz * 4.0 + 3.0);
        diffuseColor.rgb *= 0.82 + fur * 0.3 + furPatch * 0.12;`,
      );
  };
  return m;
}

function maneGeometry() {
  const g = new THREE.IcosahedronGeometry(0.5, 4);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = fbm(v.x * 7 + 2, v.y * 7 + v.z * 5, 4);
    const tuft = 0.86 + n * 0.42;
    v.multiplyScalar(tuft);
    // shaggier underneath and behind, flatter in front of the face
    if (v.z > 0.15) v.z *= 0.6;
    if (v.y < 0) v.y *= 1.25;
    p.setXYZ(i, v.x * 1.06, v.y * 1.08, v.z);
  }
  g.computeVertexNormals();
  return g;
}

interface Rig {
  root: THREE.Group;
  body: THREE.Group;
  neck: THREE.Group;
  head: THREE.Group;
  jaw: THREE.Group;
  chest: THREE.Mesh;
  legs: { hip: THREE.Group; knee: THREE.Group; baseHip: number; baseKnee: number }[];
  tail: THREE.Group[];
}

function buildRig(): Rig {
  const coat = furMaterial("#b98b52");
  const coatLight = furMaterial("#c9a06a");
  const mane = furMaterial("#7b4f2a", 1);
  const dark = new THREE.MeshStandardMaterial({ color: "#2a1a12", roughness: 0.7 });
  const mouth = new THREE.MeshStandardMaterial({ color: "#5a1c1a", roughness: 0.6 });
  const tooth = new THREE.MeshStandardMaterial({ color: "#e9e1cf", roughness: 0.4 });
  const eye = new THREE.MeshStandardMaterial({ color: "#3a2608", roughness: 0.2, emissive: "#140c02" });

  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, pos: [number, number, number], scale: [number, number, number] = [1, 1, 1], rot: [number, number, number] = [0, 0, 0]) => {
    const o = new THREE.Mesh(g, m);
    o.position.set(...pos);
    o.scale.set(...scale);
    o.rotation.set(...rot);
    o.castShadow = true;
    o.receiveShadow = true;
    return o;
  };
  const sphere = (r: number, d = 24) => new THREE.SphereGeometry(r, d, Math.round(d * 0.75));
  const capsule = (r: number, l: number) => new THREE.CapsuleGeometry(r, l, 8, 16);

  const root = new THREE.Group();
  root.rotation.order = "YXZ";
  const body = new THREE.Group();
  body.position.y = 1.0;
  root.add(body);

  body.add(mesh(capsule(0.36, 1.0), coat, [0, 0, -0.05], [0.92, 1.0, 1], [Math.PI / 2, 0, 0]));
  const chest = mesh(sphere(0.43), coat, [0, 0.02, 0.42], [0.95, 1.05, 1.0]);
  body.add(chest);
  body.add(mesh(sphere(0.34), coatLight, [0, -0.12, 0.05], [0.9, 0.8, 1.6]));
  body.add(mesh(sphere(0.37), coat, [0, 0.03, -0.55], [0.95, 1.0, 1.0]));

  const neck = new THREE.Group();
  neck.position.set(0, 0.16, 0.62);
  body.add(neck);
  neck.add(mesh(capsule(0.22, 0.3), coat, [0, 0.05, 0.12], [1, 1, 1], [1.0, 0, 0]));
  // Mane wraps the neck and frames the face rather than enclosing it.
  neck.add(mesh(maneGeometry(), mane, [0, 0.08, -0.02], [0.82, 0.92, 0.78]));
  neck.add(mesh(maneGeometry(), mane, [0, -0.14, 0.12], [0.62, 0.6, 0.6]));

  const head = new THREE.Group();
  head.position.set(0, 0.17, 0.42);
  neck.add(head);
  head.add(mesh(sphere(0.22), coat, [0, 0, 0], [0.98, 0.92, 1.08]));
  head.add(mesh(sphere(0.15), coatLight, [0, -0.07, 0.19], [1.05, 0.82, 1.25]));
  head.add(mesh(sphere(0.055, 12), dark, [0, -0.02, 0.35], [1.2, 0.8, 0.8]));
  head.add(mesh(sphere(0.026, 10), eye, [0.085, 0.06, 0.17]));
  head.add(mesh(sphere(0.026, 10), eye, [-0.085, 0.06, 0.17]));
  head.add(mesh(sphere(0.06, 10), coat, [0.15, 0.16, -0.06], [1, 1, 0.6]));
  head.add(mesh(sphere(0.06, 10), coat, [-0.15, 0.16, -0.06], [1, 1, 0.6]));
  const fang = new THREE.ConeGeometry(0.014, 0.06, 6);
  head.add(mesh(fang, tooth, [0.045, -0.15, 0.3], [1, 1, 1], [Math.PI, 0, 0]));
  head.add(mesh(fang, tooth, [-0.045, -0.15, 0.3], [1, 1, 1], [Math.PI, 0, 0]));
  head.add(mesh(sphere(0.1, 12), mouth, [0, -0.12, 0.16], [0.9, 0.4, 1.4]));
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.11, 0.02);
  head.add(jaw);
  jaw.add(mesh(sphere(0.1), coatLight, [0, -0.04, 0.18], [1.0, 0.45, 1.6]));
  jaw.add(mesh(fang, tooth, [0.04, -0.01, 0.31], [0.8, 0.8, 0.8]));
  jaw.add(mesh(fang, tooth, [-0.04, -0.01, 0.31], [0.8, 0.8, 0.8]));

  const legs: Rig["legs"] = [];
  const legDefs: [number, number, number, boolean][] = [
    [0.19, -0.08, 0.5, true],
    [-0.19, -0.08, 0.5, true],
    [0.2, -0.08, -0.6, false],
    [-0.2, -0.08, -0.6, false],
  ];
  for (const [x, y, z, front] of legDefs) {
    const hip = new THREE.Group();
    hip.position.set(x, y, z);
    body.add(hip);
    hip.add(mesh(capsule(front ? 0.12 : 0.15, 0.32), coat, [0, -0.22, 0], [1, 1, front ? 1.05 : 1.3]));
    const knee = new THREE.Group();
    knee.position.set(0, -0.46, front ? 0.0 : -0.04);
    hip.add(knee);
    knee.add(mesh(capsule(0.075, 0.3), coat, [0, -0.2, 0]));
    knee.add(mesh(sphere(0.1, 14), coatLight, [0, -0.42, 0.05], [1.0, 0.55, 1.35]));
    // Hind legs: thigh angled forward, shin angled back (the hock shape).
    legs.push({ hip, knee, baseHip: front ? -0.04 : 0.22, baseKnee: front ? 0.04 : 0.42 });
  }

  const tail: THREE.Group[] = [];
  let parent: THREE.Object3D = body;
  const base = new THREE.Group();
  base.position.set(0, 0.16, -0.88);
  body.add(base);
  parent = base;
  const seg = capsule(0.042, 0.12);
  for (let i = 0; i < 7; i++) {
    const g = new THREE.Group();
    if (i > 0) g.position.set(0, 0, -0.15);
    parent.add(g);
    g.add(mesh(seg, coat, [0, 0, -0.075], [1, 1, 1], [Math.PI / 2, 0, 0]));
    tail.push(g);
    parent = g;
  }
  parent.add(mesh(sphere(0.075, 12), dark, [0, 0, -0.2], [0.9, 0.9, 1.4]));

  return { root, body, neck, head, jaw, chest, legs, tail };
}

function ProceduralLion({ comp, motion }: { comp: ActorComponent; motion: ActorFrame }) {
  const rig = useMemo(buildRig, []);
  const poses = useMemo(() => ({ cur: newPose(), prev: newPose(), out: newPose() }), []);

  useEffect(() => () => rig.root.traverse((o) => (o as THREE.Mesh).geometry?.dispose()), [rig]);

  useFrame(() => {
    applyVisibility(rig.root, motion.visible);
    if (!motion.ready) return;
    const { cur, prev, out } = poses;
    computePose(cur, motion.action, motion.actionT, motion.gaitPhase);
    if (motion.blend < 1) {
      computePose(prev, motion.prev, motion.prevT, motion.gaitPhase);
      blendPose(prev, cur, motion.blend, out);
    } else blendPose(cur, cur, 1, out);

    const s = comp.scale;
    rig.root.position.set(motion.x, motion.y, motion.z);
    // Lying down rolls the body about its own centre and lowers it until the
    // flank rests on the ground (torso radius ≈ 0.36 m).
    const lieK = Math.min(1, out.lie / 1.35);
    rig.root.rotation.set(motion.pitch * (1 - lieK), motion.heading, 0);
    rig.root.scale.setScalar(s);
    rig.body.position.set(0, 1.0 + out.bodyY + (0.4 - (1.0 + out.bodyY)) * lieK, out.bodyZ);
    rig.body.rotation.set(-out.bodyPitch, 0, out.bodyRoll + out.lie);
    rig.chest.scale.set(0.95 + out.breathe * 0.025, 1.05 + out.breathe * 0.03, 1.0);
    rig.neck.rotation.set(-out.neckPitch, out.neckYaw + out.headYaw * 0.35, 0);
    rig.head.rotation.set(-out.headPitch, out.headYaw * 0.65, 0);
    rig.jaw.rotation.x = out.jaw * 0.75;
    rig.legs.forEach((l, i) => {
      l.hip.rotation.x = -(l.baseHip + out.legs[i].hip);
      l.knee.rotation.x = l.baseKnee + out.legs[i].knee;
    });
    rig.tail.forEach((g, i) => {
      const k = i / rig.tail.length;
      // Tail hangs from the rump and curls up toward the tuft (J shape).
      g.rotation.x = i === 0 ? -1.05 + out.tailLift : 0.06 + out.tailCurl * k * 0.45;
      g.rotation.y = out.tailSwing * (0.3 + k * 0.3);
    });
  });

  return (
    <>
      <primitive object={rig.root} />
      <ContactShadow motion={motion} />
    </>
  );
}

// ---------------------------------------------------------------- GLB lion

class ModelErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode; assetId: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    console.error("Model failed to load", e);
    useModelInfo.getState().setError(this.props.assetId, String(e));
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function GlbLion({ comp, url, assetId, motion }: { comp: ActorComponent; url: string; assetId: string; motion: ActorFrame }) {
  const gltf = useGLTF(url);
  const { model, mixer, actions } = useMemo(() => {
    const model = cloneSkinned(gltf.scene);
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        const m = (o as THREE.Mesh).material;
        (o as THREE.Mesh).material = Array.isArray(m) ? m.map((x) => x.clone()) : m.clone();
      }
    });
    const mixer = new THREE.AnimationMixer(model);
    const actions = new Map<string, THREE.AnimationAction>();
    for (const clip of gltf.animations) {
      const a = mixer.clipAction(clip);
      a.play();
      a.setEffectiveWeight(0);
      actions.set(clip.name, a);
    }
    return { model, mixer, actions };
  }, [gltf]);

  useEffect(() => {
    const names = gltf.animations.map((c) => c.name);
    const missing = (Object.keys(LION_ACTION_INFO) as LionAction[]).filter((a) => {
      const n = comp.clipMap[a];
      return !n || !names.includes(n);
    });
    useModelInfo.getState().setInfo(assetId, { clips: names, missing });
  }, [gltf, comp.clipMap, assetId]);

  const outer = useMemo(() => new THREE.Group(), []);
  useEffect(() => {
    outer.add(model);
    return () => {
      outer.remove(model);
    };
  }, [outer, model]);

  const clipTime = (action: LionAction, t: number) => {
    const name = comp.clipMap[action] ?? comp.clipMap.idle;
    const a = name ? actions.get(name) : undefined;
    if (!a) return null;
    const d = a.getClip().duration || 1;
    let time: number;
    if (action === "walk" || action === "run" || action === "turn") time = (((motion.gaitPhase % 1) + 1) % 1) * d;
    else if (LION_ACTION_INFO[action].loop) time = t % d;
    else time = Math.min(t, d - 1e-3);
    return { a, time };
  };

  useFrame(() => {
    applyVisibility(outer, motion.visible);
    if (!motion.ready) return;
    for (const a of actions.values()) a.setEffectiveWeight(0);
    const prev = motion.blend < 1 ? clipTime(motion.prev, motion.prevT) : null;
    const cur = clipTime(motion.action, motion.actionT);
    if (prev) {
      prev.a.time = prev.time;
      prev.a.setEffectiveWeight(1 - motion.blend);
    }
    if (cur) {
      cur.a.time = cur.time;
      cur.a.setEffectiveWeight(prev && prev.a === cur.a ? 1 : motion.blend < 1 && prev ? motion.blend : 1);
    }
    mixer.update(0);
    outer.position.set(motion.x, motion.y, motion.z);
    outer.rotation.set(motion.pitch, motion.heading + comp.modelYaw, 0, "YXZ");
    outer.scale.setScalar(comp.scale);
  });

  return (
    <>
      <primitive object={outer} />
      <ContactShadow motion={motion} />
    </>
  );
}

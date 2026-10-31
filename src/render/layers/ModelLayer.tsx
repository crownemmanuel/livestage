import { Component, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { ModelComponent } from "@/core/types";
import { useModelInfo } from "@/store/modelInfo";
import { useStage } from "../frame";
import { useLayerPresence } from "./presence";

class Boundary extends Component<{ children: ReactNode; assetId: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    useModelInfo.getState().setError(this.props.assetId, String(e));
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function ModelLayer({ comp }: { comp: ModelComponent }) {
  const { assets } = useStage();
  const asset = comp.assetId ? assets.find((a) => a.id === comp.assetId) : undefined;
  if (!asset) return null;
  return (
    <Boundary key={asset.url} assetId={asset.id}>
      <Suspense fallback={null}>
        <GlbModel comp={comp} url={asset.url} assetId={asset.id} />
      </Suspense>
    </Boundary>
  );
}

function GlbModel({ comp, url, assetId }: { comp: ModelComponent; url: string; assetId: string }) {
  const { getRt, frame } = useStage();
  const anisotropy = useThree((s) => Math.min(8, s.gl.capabilities.getMaxAnisotropy()));
  const gltf = useGLTF(url);
  const presence = useLayerPresence(comp.id, 1);
  const { model, mixer, materials, surfaces, unlit } = useMemo(() => {
    const model = cloneSkinned(gltf.scene);
    const materials: THREE.MeshStandardMaterial[] = [];
    const surfaces: { material: THREE.Material; opacity: number; transparent: boolean; depthWrite: boolean }[] = [];
    const unlit: { material: THREE.MeshBasicMaterial; color: THREE.Color }[] = [];
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = Array.isArray(mesh.material) ? mesh.material.map((x) => x.clone()) : mesh.material.clone();
      mesh.material = m;
      // Ground and walls viewed at a grazing angle otherwise shimmer badly.
      // GLTF textures are shared: tune sampling, never replace or dispose them here.
      for (const material of Array.isArray(m) ? m : [m]) {
        surfaces.push({ material, opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite });
        if ((material as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
          unlit.push({ material: material as THREE.MeshBasicMaterial, color: (material as THREE.MeshBasicMaterial).color.clone() });
        }
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture && value.anisotropy !== anisotropy) {
            value.anisotropy = anisotropy;
            value.needsUpdate = true;
          }
        }
      }
      for (const mm of Array.isArray(m) ? m : [m]) if ((mm as THREE.MeshStandardMaterial).isMeshStandardMaterial) materials.push(mm as THREE.MeshStandardMaterial);
    });
    return { model, mixer: new THREE.AnimationMixer(model), materials, surfaces, unlit };
  }, [gltf, anisotropy]);
  const base = useMemo(() => materials.map((m) => ({ color: m.color.clone(), roughness: m.roughness, metalness: m.metalness })), [materials]);

  useEffect(() => {
    useModelInfo.getState().setInfo(assetId, { clips: gltf.animations.map((c) => c.name), missing: [] });
  }, [gltf, assetId]);

  useEffect(() => {
    model.traverse((o) => {
      o.castShadow = comp.castShadow;
      o.receiveShadow = true;
    });
    const tint = new THREE.Color(comp.material.tint);
    materials.forEach((m, i) => {
      m.color.copy(base[i].color).multiply(tint);
      m.roughness = comp.material.roughness ?? base[i].roughness;
      m.metalness = comp.material.metalness ?? base[i].metalness;
      m.emissive.copy(m.color).multiplyScalar(comp.material.emissive);
    });
  }, [model, materials, base, comp.castShadow, comp.material]);

  const action = useMemo(() => {
    mixer.stopAllAction();
    const clip = gltf.animations.find((c) => c.name === comp.clip) ?? (comp.clip === null ? gltf.animations[0] : undefined);
    if (!clip) return null;
    const a = mixer.clipAction(clip);
    a.play();
    return a;
  }, [mixer, gltf, comp.clip]);

  const tint = useMemo(() => new THREE.Color(comp.material.tint), [comp.material.tint]);

  useFrame(() => {
    const rt = getRt();
    const v = presence();
    model.visible = v > 0.01;
    surfaces.forEach(({ material, opacity, transparent, depthWrite }) => {
      material.transparent = transparent || v < 0.999;
      material.opacity = opacity * v;
      material.depthWrite = depthWrite && v > 0.5;
    });
    // glTF unlit materials contain photographed/baked light. Apply the same
    // timestamp-driven night/storm grade as media, without lighting them twice.
    unlit.forEach(({ material, color }) => {
      material.color.copy(color).multiply(tint).multiply(frame.mediaGrade);
    });
    model.position.set(...comp.position);
    model.rotation.set(...(comp.rotation.map((d) => (d * Math.PI) / 180) as [number, number, number]));
    model.scale.setScalar(comp.scale);
    if (action && rt) {
      const l = rt.layers[comp.id];
      const d = action.getClip().duration || 1;
      const el = Math.max(0, (frame.t - (l?.startAt ?? 0)) / 1000);
      action.time = comp.loop ? el % d : Math.min(el, d - 1e-3);
      mixer.update(0);
    }
  });

  return <primitive object={model} />;
}

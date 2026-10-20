import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clipStateAt } from "@/core/clipActor";
import { defaultActorLayout } from "@/core/factories";
import { playableUrl } from "@/core/platform";
import type { ClipActorComponent, ClipDef } from "@/core/types";
import { mixLevel } from "@/store/show";
import { videoAudioFade } from "@/core/runtime";
import { QUAD_VERT } from "../glsl";
import { useStage } from "../frame";
import { applyMediaSettings, makeMediaMaterial, setMap } from "./mediaMaterial";
import { plateParallax } from "./MediaLayers";
import { syncVideo, useVideo, videoDuration } from "./video";

/**
 * Full-frame video actor: one quad per clip, only the scheduled one visible.
 * `order` (the component's index in the scene) stacks actors in scene order.
 */
export function ClipActorLayer({ comp, order = 0 }: { comp: ClipActorComponent; order?: number }) {
  return (
    <>
      {comp.clips.map((c) => (
        <ClipQuad key={c.id} actor={comp} clip={c} order={order} />
      ))}
    </>
  );
}

// Cast shadow from a cut-out: the silhouette reflected about the ground line,
// flattened and softened, drawn dark under the character.
const shadowFrag = /* glsl */ `
uniform sampler2D map;
uniform float flipX;
uniform float ground;   // uv.y of the ground contact line (y up)
uniform float squash;   // how flat the shadow lies
uniform float shear;    // sideways lean from the sun direction
uniform float opacity;
varying vec2 vUv;
float alphaAt(vec2 p) {
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 0.0;
  return texture2D(map, p).a;
}
void main() {
  vec2 uv = vUv;
  if (flipX > 0.5) uv.x = 1.0 - uv.x;
  float below = ground - uv.y;
  if (below < -0.01) discard;
  vec2 src = vec2(uv.x - shear * below, ground + below / squash);
  float a = 0.0;
  for (int i = -2; i <= 2; i++) {
    for (int j = -1; j <= 1; j++) {
      a += alphaAt(src + vec2(float(i) * 0.004, float(j) * 0.01));
    }
  }
  a /= 15.0;
  float fade = 1.0 - smoothstep(0.0, 0.35, below / squash);
  gl_FragColor = vec4(0.0, 0.0, 0.0, a * fade * opacity);
}
`;

function ClipQuad({ actor, clip, order }: { actor: ClipActorComponent; clip: ClipDef; order: number }) {
  const { assets, getRt, frame, canvasW, canvasH, audio } = useStage();
  // Cut-out mode prefers the transparent version of the clip when one exists.
  const srcId = actor.matted && clip.cutoutAssetId ? clip.cutoutAssetId : clip.assetId;
  const asset = srcId ? assets.find((a) => a.id === srcId) : undefined;
  const video = useVideo(playableUrl(asset));
  const mat = useMemo(makeMediaMaterial, []);
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.frustumCulled = false;
    return m;
  }, [mat]);
  const shadowMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: shadowFrag,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        uniforms: { map: { value: null }, flipX: { value: 0 }, ground: { value: 0.25 }, squash: { value: 0.22 }, shear: { value: 0.6 }, opacity: { value: 0.5 } },
      }),
    [],
  );
  const shadow = useMemo(() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
    m.frustumCulled = false;
    return m;
  }, [shadowMat]);
  useEffect(() => {
    mesh.renderOrder = 5 + order * 0.01;
    shadow.renderOrder = 4.995 + order * 0.01;
  }, [mesh, shadow, order]);

  useEffect(() => {
    applyMediaSettings(mat, { crop: { left: 0, right: 0, top: 0, bottom: 0 } });
  }, [mat]);

  // Never wrap: a finished clip must hold its last frame, not flash back to frame 0.
  useEffect(() => {
    if (video) video.video.loop = clip.loop;
  }, [video, clip.loop]);

  useFrame(() => {
    const rt = getRt();
    if (!rt || !video) {
      mesh.visible = shadow.visible = false;
      return;
    }
    const st = clipStateAt(actor, rt.clipActors?.[actor.id], frame.t);
    const active = st.clip?.id === clip.id;
    const dur = videoDuration(video) || clip.duration;
    if (active) {
      const time = clip.loop ? st.localT % dur : Math.min(st.localT, dur - 0.04);
      syncVideo(video, { play: st.playing && rt.clock.pausedAt === null, time, rate: 1, muted: actor.muted || !audio, volume: actor.volume * mixLevel(actor.id) * videoAudioFade(rt, actor.id, frame.t) }, frame.wall);
    } else {
      // Park on frame 0 so the clip can cut in instantly when its turn comes.
      syncVideo(video, { play: false, time: 0, rate: 1, muted: true, volume: 0 }, frame.wall);
    }
    // While a seek is in flight the texture still holds the last frame: keep showing it.
    mesh.visible = active && (video.video.readyState >= 2 || (video.video.seeking && video.video.readyState >= 1));
    shadow.visible = mesh.visible && !!actor.matted && (actor.layout?.shadow ?? 0) > 0;
    if (!mesh.visible) return;

    setMap(mat, video.texture);
    mat.uniforms.opacity.value = 1;
    mat.uniforms.grade.value.copy(frame.mediaGrade);

    // Frame rectangle: fitted to the plate's aspect and framing so it lines up with the background.
    const aspect = actor.frameAspect > 0 ? actor.frameAspect : video.video.videoWidth / Math.max(1, video.video.videoHeight);
    const canvasAspect = canvasW / canvasH;
    let w = canvasW;
    let h = canvasH;
    if (actor.fit === "cover") {
      if (aspect > canvasAspect) w = canvasH * aspect;
      else h = canvasW / aspect;
    } else if (actor.fit === "contain") {
      if (aspect > canvasAspect) h = canvasW / aspect;
      else w = canvasH * aspect;
    }
    const cy = ((actor.anchorY ?? 0.5) - 0.5) * Math.max(0, h - canvasH);

    // Cut-out actors can be laid out freely: scale about the ground contact point,
    // optionally sliding the feet toward the horizon so smaller reads as further away.
    const L = actor.matted ? (actor.layout ?? defaultActorLayout()) : defaultActorLayout();
    const s = actor.matted ? Math.max(0.05, L.scale) : 1;
    const targetV = (L.depthLink ? L.horizonY + (L.pivotY - L.horizonY) * s : L.pivotY) + (actor.matted ? L.y : 0);
    const targetU = L.pivotX + (actor.matted ? L.x : 0);
    // 2.5D parallax: full-frame clips move exactly with their plate, cut-outs (nearer) 1.6× as much.
    const par = plateParallax(rt);
    const over = actor.matted ? 1 : 1 + 2 * par;
    const parK = actor.matted ? 1.6 : 1;
    const px = (targetU - 0.5) * w + frame.swayX * par * parK * canvasW;
    const py = cy + (0.5 - targetV) * h - frame.swayY * par * parK * canvasH * 0.5;
    const mirror = actor.matted && L.mirror;
    const offU = (mirror ? 0.5 - L.pivotX : L.pivotX - 0.5) * w * s;
    const offV = (0.5 - L.pivotY) * h * s;
    mesh.scale.set(w * s * over, h * s * over, 1);
    mesh.position.set(px - offU, py - offV, 0);
    mat.uniforms.flipX.value = mirror ? 1 : 0;

    if (shadow.visible) {
      shadow.scale.copy(mesh.scale);
      shadow.position.copy(mesh.position);
      const u = shadowMat.uniforms;
      u.map.value = video.texture;
      u.flipX.value = mirror ? 1 : 0;
      u.ground.value = 1 - L.pivotY;
      u.shear.value = mirror ? -0.6 : 0.6;
      // Weaker shadows when the light is dim (night, storm).
      u.opacity.value = L.shadow * Math.min(1, 0.35 + frame.ambient * 0.65);
    }
  });

  return (
    <>
      <primitive object={shadow} />
      <primitive object={mesh} />
    </>
  );
}

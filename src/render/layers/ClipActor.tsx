import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clipStateAt } from "@/core/clipActor";
import { defaultActorLayout } from "@/core/factories";
import { playableUrl } from "@/core/platform";
import type { ClipActorComponent, ClipDef, EffectComponent, SceneRuntime } from "@/core/types";
import { mixLevel } from "@/store/show";
import { videoAudioFade } from "@/core/runtime";
import { QUAD_VERT } from "../glsl";
import { isCutOutShake, shakeOffset } from "../effects/Impact";
import { useStage } from "../frame";
import { applyMediaSettings, makeMediaMaterial, setMap } from "./mediaMaterial";
import { plateKenBurns, plateParallax } from "./MediaLayers";
import { setWarm, syncVideo, useVideo, videoDuration, type VideoHandle } from "./video";

/**
 * Full-frame video actor: one quad per clip, only the scheduled one visible.
 * `order` (the component's index in the scene) stacks actors in scene order.
 */
export function ClipActorLayer({ comp, order = 0 }: { comp: ClipActorComponent; order?: number }) {
  // Every clip's video, so a quad can tell whether the clip taking over from it has a frame yet.
  const handles = useMemo(() => new Map<string, VideoHandle>(), []);
  return (
    <>
      {comp.clips.map((c) => (
        <ClipQuad key={c.id} actor={comp} clip={c} order={order} handles={handles} />
      ))}
    </>
  );
}

/** Does the cue the GO pointer is on start this clip? */
function nextCueStarts(rt: SceneRuntime, actorId: string, clipId: string): boolean {
  const cue = rt.scene.cues[rt.cuePointer];
  return !!cue && cue.actions.some((a) => a.type === "clip" && a.actorId === actorId && a.clipId === clipId);
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

function ClipQuad({ actor, clip, order, handles }: { actor: ClipActorComponent; clip: ClipDef; order: number; handles: Map<string, VideoHandle> }) {
  const { assets, getRt, frame, canvasW, canvasH, audio, role } = useStage();
  // Cut-out mode prefers the transparent version of the clip when one exists.
  const srcId = actor.matted && clip.cutoutAssetId ? clip.cutoutAssetId : clip.assetId;
  const asset = srcId ? assets.find((a) => a.id === srcId) : undefined;
  // Cold until the frame loop decides the clip can come next (see setWarm): an actor with ten
  // clips must not hold ten decoders in every window for the one clip that is on screen.
  const video = useVideo(playableUrl(asset), { lazy: true, alpha: asset?.hasAlpha });
  useEffect(() => {
    if (!video) return;
    handles.set(clip.id, video);
    return () => {
      if (handles.get(clip.id) === video) handles.delete(clip.id);
    };
  }, [handles, clip.id, video]);
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
    const art = rt.clipActors?.[actor.id];
    const st = clipStateAt(actor, art, frame.t);
    const dur = videoDuration(video) || clip.duration;
    // Crossfade: for `crossfade` seconds after a clip starts, the clip it replaced keeps playing underneath.
    const xf = Math.max(0, actor.crossfade ?? 0) * 1000;
    const since = st.segment ? frame.t - st.segment.at : Infinity;
    let fadeIn = 1;
    let outgoing: ReturnType<typeof clipStateAt> | null = null;
    if (xf > 0 && since < xf && st.segment) {
      fadeIn = Math.max(0, since / xf);
      const prev = clipStateAt(actor, { segments: (art?.segments ?? []).filter((x) => x !== st.segment) }, frame.t);
      if (prev.clip && prev.clip.id !== st.clip?.id) outgoing = prev;
    }
    const isOut = outgoing?.clip?.id === clip.id;
    const active = st.clip?.id === clip.id || isOut;
    const cur = isOut && outgoing ? outgoing : st;
    // Warm (loaded, decoder held): the clip on screen or fading out, the queued one, every clip that
    // can follow from the actor's pose, and the clips the next cue would start. The rest stay cold.
    const near = active || st.queued?.clip.id === clip.id || clip.startPose === st.pose || nextCueStarts(rt, actor.id, clip.id);
    setWarm(video, near);
    // A clip that was cold when its turn came is still loading: the clip before it holds its last
    // frame until the new one has a picture, instead of a flash of bare background.
    let holding = false;
    if (!active && st.clip && st.segment) {
      const taking = handles.get(st.clip.id);
      if (!taking || taking.video.readyState < 2) {
        const at = st.segment.at;
        let prev: { clipId: string; at: number } | null = null;
        for (const s of art?.segments ?? []) if (s.at < at && (!prev || s.at > prev.at)) prev = s;
        holding = prev?.clipId === clip.id;
      }
    }
    if (active) {
      const time = clip.loop ? cur.localT % dur : Math.min(cur.localT, dur - 0.04);
      const vol = actor.volume * mixLevel(actor.id) * videoAudioFade(rt, actor.id, frame.t) * (isOut ? 1 - fadeIn : fadeIn);
      syncVideo(video, { play: cur.playing && rt.clock.pausedAt === null, time, rate: 1, muted: actor.muted || !audio, local: role === "preview", volume: vol, loop: clip.loop ? dur : undefined }, frame.wall);
    } else if (holding) {
      syncVideo(video, { play: false, time: clip.loop ? video.video.currentTime : Math.max(0, dur - 0.04), rate: 1, muted: true, volume: 0 }, frame.wall);
    } else if (near) {
      // Park on frame 0 so the clip can cut in instantly when its turn comes.
      syncVideo(video, { play: false, time: 0, rate: 1, muted: true, volume: 0 }, frame.wall);
    }
    // While a seek is in flight the texture still holds the last frame: keep showing it.
    mesh.visible = (active || holding) && (video.video.readyState >= 2 || (video.video.seeking && video.video.readyState >= 1));
    shadow.visible = mesh.visible && !!actor.matted && (actor.layout?.shadow ?? 0) > 0;
    if (!mesh.visible) return;

    setMap(mat, video.texture);
    // The incoming clip draws over the outgoing one and fades in; the outgoing one stays solid underneath.
    mat.uniforms.opacity.value = isOut || holding ? 1 : fadeIn;
    mesh.renderOrder = 5 + order * 0.01 + (isOut ? 0 : 0.005);
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
    const fx = frame.swayX * par * parK * canvasW;
    const fy = cy - frame.swayY * par * parK * canvasH * 0.5;
    const px = (targetU - 0.5) * w + fx;
    const py = (0.5 - targetV) * h + fy;
    const mirror = actor.matted && L.mirror;
    const offU = (mirror ? 0.5 - L.pivotX : L.pivotX - 0.5) * w * s;
    const offV = (0.5 - L.pivotY) * h * s;
    // The clips lie on the plate, so they follow its Ken Burns pan/zoom (about the frame's centre).
    const kb = plateKenBurns(rt, frame.t);
    mesh.scale.set(w * s * over * kb.scale, h * s * over * kb.scale, 1);
    // "Cut-outs only" shakes: the plate video shakes by itself (footsteps baked in); a cut-out (keyed or
    // transparent clip) follows it.
    const sh = actor.matted || asset?.hasAlpha ? cutOutShake(rt, frame.t) : null;
    mesh.position.set(fx + (px - offU - fx) * kb.scale + kb.x * canvasW + (sh ? sh.dx * canvasH : 0), fy + (py - offV - fy) * kb.scale - kb.y * canvasH - (sh ? sh.dy * canvasH : 0), 0);
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

function cutOutShake(rt: SceneRuntime | null | undefined, t: number) {
  const comps = (rt?.scene.components ?? []).filter((c): c is EffectComponent => c.kind === "effect" && c.effect === "shake" && isCutOutShake(c, rt));
  if (!comps.length) return null;
  const o = shakeOffset(comps, rt, t);
  return o.peak > 0 ? o : null;
}

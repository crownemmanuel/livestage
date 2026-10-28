import { useEffect, useMemo, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clamp, easeOut, lerp, smootherstep } from "@/core/clock";
import { playableUrl } from "@/core/platform";
import { hash2 } from "@/core/noise";
import { mediaElapsed, mediaRate, videoAudioFade } from "@/core/runtime";
import { mixLevel } from "@/store/show";
import type { BackgroundComponent, EntranceKind, ImageLayerComponent, KenBurns, MediaSettings, VideoLayerComponent } from "@/core/types";
import { useStage } from "../frame";
import { applyBlend, applyMediaSettings, makeMediaMaterial, missingTexture, setMap } from "./mediaMaterial";
import { mediaTime, syncVideo, useVideo, videoDuration, type VideoHandle } from "./video";

export function useImageTexture(url: string | null) {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    if (!url) return setTex(null);
    let alive = true;
    new THREE.TextureLoader().load(
      url,
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        if (alive) setTex(t);
        else t.dispose();
      },
      undefined,
      (e) => console.warn("image failed", url, e),
    );
    return () => {
      alive = false;
    };
  }, [url]);
  useEffect(() => () => tex?.dispose(), [tex]);
  return tex;
}

function texAspect(tex: THREE.Texture | null, video: HTMLVideoElement | null) {
  if (video && video.videoWidth) return video.videoWidth / video.videoHeight;
  const img = tex?.image as { width?: number; height?: number } | undefined;
  return img?.width && img.height ? img.width / img.height : 16 / 9;
}

/** Entrance/exit animation factor and offsets. Anything unknown (a text-only name like "burn" or "rise") fades. */
function entrance(kind: EntranceKind, k: number) {
  const e = easeOut(k);
  switch (kind) {
    case "none":
      return { opacity: k >= 1 ? 1 : k > 0 ? 1 : 0, dx: 0, dy: 0, scale: 1 };
    default:
    case "fade":
      return { opacity: k, dx: 0, dy: 0, scale: 1 };
    case "slide-left":
      return { opacity: Math.min(1, k * 3), dx: (1 - e) * 0.35, dy: 0, scale: 1 };
    case "slide-right":
      return { opacity: Math.min(1, k * 3), dx: -(1 - e) * 0.35, dy: 0, scale: 1 };
    case "slide-up":
      return { opacity: Math.min(1, k * 3), dx: 0, dy: (1 - e) * 0.25, scale: 1 };
    case "scale":
      return { opacity: k, dx: 0, dy: 0, scale: 0.6 + 0.4 * e };
  }
}

/** Ken Burns state at `elapsed` seconds: pan (canvas fractions) and scale. */
export function kenBurnsAt(kb: KenBurns | undefined, elapsed: number) {
  if (!kb?.enabled) return { x: 0, y: 0, scale: 1 };
  let k = kb.duration > 0 ? elapsed / kb.duration : 1;
  if (kb.loop === "loop") k = k - Math.floor(k);
  else if (kb.loop === "pingpong") {
    const c = k - Math.floor(k / 2) * 2;
    k = c <= 1 ? c : 2 - c;
  } else k = clamp(k, 0, 1);
  k = smootherstep(k);
  return { x: lerp(kb.from.x, kb.to.x, k), y: lerp(kb.from.y, kb.to.y, k), scale: lerp(kb.from.scale, kb.to.scale, k) };
}

type LayerComp = VideoLayerComponent | ImageLayerComponent;

/** Loop period when the element's own loop (whole file) is the wanted loop, so drift is judged on the circle. */
function nativeLoop(m: MediaSettings, video: VideoHandle): number | undefined {
  return m.loop && m.startTime === 0 && m.endTime == null ? videoDuration(video) || undefined : undefined;
}

interface InstanceState {
  visible: boolean;
  x: number;
  y: number;
  scale: number;
  flip: boolean;
  /** seconds this instance's media has been playing */
  elapsed: number;
}

/** Deterministic walker instance placement (people crossing the frame). */
function walkerInstance(c: LayerComp, i: number, elapsed: number, out: InstanceState) {
  const w = c.walker;
  const span = Math.abs(w.toX - w.fromX);
  const travel = span / Math.max(0.001, w.speed);
  const cycle = travel + Math.max(w.delayMax, w.delayMin);
  const offset = (i / Math.max(1, w.instances)) * cycle * 0.61 + hash2(w.seed, i) * cycle * 0.3;
  const tl = elapsed + offset;
  const k = Math.floor(tl / cycle);
  const within = tl - k * cycle;
  const start = w.delayMin + hash2(k + w.seed, i * 7.1) * Math.max(0, w.delayMax - w.delayMin);
  if (within < start || within > start + travel) {
    out.visible = false;
    return;
  }
  const f = (within - start) / travel;
  const dir = w.direction;
  const from = dir > 0 ? w.fromX : w.toX;
  const to = dir > 0 ? w.toX : w.fromX;
  out.visible = true;
  out.x = from + (to - from) * f;
  out.y = (c.placement === "world" ? 0 : c.screen.y) + (hash2(k * 3.3 + i, w.seed) - 0.5) * 2 * w.yJitter;
  out.scale = 1 + (hash2(k + i * 13.7, w.seed * 0.3) - 0.5) * 2 * w.scaleJitter;
  out.flip = dir < 0;
  out.elapsed = within - start;
}

interface LayerProps {
  comp: LayerComp;
}

/** A video or image layer in back/front (screen) or world placement, with walkers. */
export function MediaLayer({ comp }: LayerProps) {
  const count = comp.walker.enabled ? Math.max(1, Math.min(12, comp.walker.instances)) : 1;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <MediaInstance key={i} comp={comp} index={i} />
      ))}
    </>
  );
}

function MediaInstance({ comp, index }: { comp: LayerComp; index: number }) {
  const { assets, getRt, frame, canvasW, canvasH, isOutput, audio, role } = useStage();
  const assetId = comp.kind === "video" ? comp.media.assetId : comp.assetId;
  const asset = assetId ? assets.find((a) => a.id === assetId) : undefined;
  const isVideo = comp.kind === "video";
  const video = useVideo(isVideo && asset ? playableUrl(asset) : null, { alpha: asset?.hasAlpha });
  const image = useImageTexture(!isVideo && asset ? asset.url : null);
  const mat = useMemo(makeMediaMaterial, []);
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.frustumCulled = false;
    return m;
  }, [mat]);
  const inst = useMemo<InstanceState>(() => ({ visible: true, x: 0, y: 0, scale: 1, flip: false, elapsed: 0 }), []);

  useEffect(() => {
    applyBlend(mat, comp.blend);
    applyMediaSettings(mat, { crop: comp.crop, chroma: comp.kind === "video" ? comp.chroma : undefined, mask: comp.mask });
    mat.needsUpdate = true;
  }, [mat, comp]);

  useFrame(({ camera }) => {
    const rt = getRt();
    const lr = rt?.layers[comp.id];
    const tex: THREE.Texture | null = video?.texture ?? image ?? (!isOutput && !asset ? missingTexture() : null);
    if (!rt || !lr || !tex) {
      mesh.visible = false;
      if (video) video.video.pause();
      return;
    }
    const t = frame.t;
    const a = comp.anim ?? { enter: "fade", exit: "fade", duration: 0.5 };
    const k = clamp((t - lr.changedAt) / (a.duration * 1000 || 1), 0, 1);
    const anim = lr.visible ? entrance(a.enter, k) : entrance(a.exit, 1 - k);
    const presence = anim.opacity;
    const elapsed = (t - lr.startAt) / 1000;

    if (comp.walker.enabled) walkerInstance(comp, index, elapsed, inst);
    else {
      inst.visible = true;
      inst.x = comp.placement === "world" ? comp.world.position[0] : comp.screen.x;
      inst.y = comp.placement === "world" ? 0 : comp.screen.y;
      inst.scale = 1;
      inst.flip = false;
      inst.elapsed = elapsed;
    }
    const show = presence > 0.001 && inst.visible;
    mesh.visible = show;

    if (video) {
      const m = (comp as VideoLayerComponent).media;
      // Walkers stagger their playback; a single layer follows the speed ramps.
      const mediaSec = comp.walker.enabled ? (inst.elapsed + index * 1.37) * m.playbackRate : mediaElapsed(rt, comp.id, lr.startAt, t, m.playbackRate);
      const time = mediaTime(m, mediaSec, videoDuration(video));
      const rate = comp.walker.enabled ? m.playbackRate : mediaRate(rt, comp.id, t, m.playbackRate);
      syncVideo(video, { play: show && rt.clock.pausedAt === null, time, rate: Math.abs(rate), muted: m.muted || !audio, local: role === "preview", volume: m.volume * presence * mixLevel(comp.id) * videoAudioFade(rt, comp.id, t), reverse: m.reverse || rate < 0, loop: nativeLoop(m, video), once: !m.loop }, frame.wall);
    }
    if (!show) return;

    setMap(mat, tex);
    let opacity = comp.opacity * presence;
    let rot = 0;
    let scale = inst.scale * anim.scale;
    let dy = anim.dy;
    if (comp.kind === "image" && comp.motion.type !== "none") {
      const mt = frame.ts * comp.motion.speed * Math.PI * 2;
      if (comp.motion.type === "float") dy += Math.sin(mt) * comp.motion.amount;
      if (comp.motion.type === "spin") rot += frame.ts * comp.motion.speed * Math.PI * 2;
      if (comp.motion.type === "pulse") {
        scale *= 1 + Math.sin(mt) * comp.motion.amount;
        opacity *= 1 - comp.motion.amount * 0.5 * (1 - Math.sin(mt));
      }
    }
    mat.uniforms.opacity.value = opacity;
    mat.uniforms.grade.value.copy(frame.mediaGrade);
    mat.uniforms.flipX.value = (comp.screen.flipX ? 1 : 0) ^ (inst.flip ? 1 : 0);
    const cw = 1 - comp.crop.left - comp.crop.right;
    const ch = 1 - comp.crop.top - comp.crop.bottom;
    const aspect = (texAspect(tex, video?.video ?? null) * Math.max(0.01, cw)) / Math.max(0.01, ch);

    if (comp.placement === "world") {
      const h = comp.world.height * scale;
      mesh.scale.set(h * aspect, h, 1);
      const [, py, pz] = comp.world.position;
      mesh.position.set(inst.x + anim.dx * 10, py + h / 2 + inst.y + dy * 4, pz);
      if (comp.world.billboard) mesh.rotation.set(0, Math.atan2(camera.position.x - mesh.position.x, camera.position.z - mesh.position.z), 0);
      else mesh.rotation.set(0, comp.world.rotationY, 0);
    } else {
      const wpx = comp.screen.width * canvasW * scale;
      mesh.scale.set(wpx, wpx / aspect, 1);
      // Front layers (closest to the audience) drift the most with the camera sway.
      const par = plateParallax(rt) * (comp.placement === "front" ? 1.6 : 0.6);
      mesh.position.set((inst.x + anim.dx - 0.5) * canvasW + frame.swayX * par * canvasW, (0.5 - inst.y - dy) * canvasH - frame.swayY * par * canvasH * 0.5, 0);
      mesh.rotation.set(0, 0, (-comp.screen.rotation * Math.PI) / 180 + rot);
    }
  });

  return <primitive object={mesh} />;
}

/** Parallax amount of the scene's current plate (0 when it has none). */
export function plateParallax(rt: import("@/core/types").SceneRuntime): number {
  const bg = rt.scene.components.find((c) => c.id === rt.background.current);
  return bg?.kind === "background" ? (bg.parallax ?? 0) : 0;
}

/** Ken Burns pan/zoom of the scene's current plate at `t` (ms), so what lies on the plate moves with it. */
export function plateKenBurns(rt: import("@/core/types").SceneRuntime, t: number) {
  const bg = rt.scene.components.find((c) => c.id === rt.background.current);
  if (bg?.kind !== "background") return kenBurnsAt(undefined, 0);
  const startAt = rt.background.changedAt > -1e8 ? rt.background.changedAt : 0;
  return kenBurnsAt(bg.kenBurns, (t - startAt) / 1000);
}

/** Fit a frame of `aspect` into the canvas with the given fit mode and vertical framing. */
export function fitFrame(fit: "cover" | "contain" | "stretch", aspect: number, canvasW: number, canvasH: number, anchorY = 0.5) {
  const canvasAspect = canvasW / canvasH;
  let w = canvasW;
  let h = canvasH;
  if (fit === "cover") {
    if (aspect > canvasAspect) w = canvasH * aspect;
    else h = canvasW / aspect;
  } else if (fit === "contain") {
    if (aspect > canvasAspect) h = canvasW / aspect;
    else w = canvasH * aspect;
  }
  return { w, h, cy: (anchorY - 0.5) * Math.max(0, h - canvasH) };
}

// ---------------------------------------------------------------- media backgrounds

/** Full-frame media background with fit/crop, crossfade on activation, Ken Burns and parallax. */
export function MediaBackground({ comp }: { comp: BackgroundComponent }) {
  const { assets, getRt, frame, canvasW, canvasH, isOutput, audio, role } = useStage();
  const asset = comp.media.assetId ? assets.find((a) => a.id === comp.media.assetId) : undefined;
  const isVideo = asset?.type === "video";
  const video = useVideo(isVideo ? playableUrl(asset) : null, { alpha: asset?.hasAlpha });
  const image = useImageTexture(asset && !isVideo ? asset.url : null);
  const mat = useMemo(makeMediaMaterial, []);
  const mesh = useMemo(() => new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat), [mat]);
  useEffect(() => {
    applyMediaSettings(mat, { crop: comp.crop });
  }, [mat, comp.crop]);

  useFrame(() => {
    const rt = getRt();
    if (!rt) return;
    const bg = rt.background;
    const isCur = bg.current === comp.id;
    const isPrev = bg.previous === comp.id;
    const k = bg.dur <= 0 ? 1 : clamp((frame.t - bg.changedAt) / bg.dur, 0, 1);
    const presence = isCur ? k : isPrev && k < 1 ? 1 : 0;
    const tex = (video?.texture ?? image) || (!isOutput && !asset ? missingTexture() : null);
    mesh.visible = presence > 0 && !!tex;
    mesh.renderOrder = isCur ? 1 : 0;
    const startAt = isCur && bg.changedAt > -1e8 ? bg.changedAt : 0;
    if (video) {
      const mediaSec = mediaElapsed(rt, comp.id, startAt, frame.t, comp.media.playbackRate);
      const rate = mediaRate(rt, comp.id, frame.t, comp.media.playbackRate);
      const time = mediaTime(comp.media, mediaSec, videoDuration(video));
      syncVideo(
        video,
        { play: presence > 0 && rt.clock.pausedAt === null, time: Math.max(0, time), rate: Math.abs(rate), muted: comp.media.muted || !audio || !isCur, local: role === "preview", volume: comp.media.volume * mixLevel(comp.id) * videoAudioFade(rt, comp.id, frame.t), reverse: comp.media.reverse || rate < 0, loop: nativeLoop(comp.media, video), once: !comp.media.loop },
        frame.wall,
      );
    }
    if (!mesh.visible || !tex) return;
    setMap(mat, tex);
    mat.uniforms.opacity.value = comp.opacity * (isCur ? k : 1);
    mat.uniforms.grade.value.copy(frame.mediaGrade);
    const cw = 1 - comp.crop.left - comp.crop.right;
    const ch = 1 - comp.crop.top - comp.crop.bottom;
    const aspect = (texAspect(tex, (video as VideoHandle | null)?.video ?? null) * cw) / Math.max(0.01, ch);
    const { w, h, cy } = fitFrame(comp.fit, aspect, canvasW, canvasH, comp.anchorY ?? 0.5);
    // Ken Burns pan/zoom, then parallax (overscanned so the edges never show).
    const kb = kenBurnsAt(comp.kenBurns, (frame.t - startAt) / 1000);
    const par = comp.parallax ?? 0;
    const s = kb.scale * (1 + 2 * par);
    mesh.scale.set(w * s, h * s, 1);
    mesh.position.set(kb.x * canvasW + frame.swayX * par * canvasW, cy - kb.y * canvasH - frame.swayY * par * canvasH * 0.5, 0);
  });
  return <primitive object={mesh} />;
}

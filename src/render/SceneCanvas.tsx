import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, createPortal, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { clamp, easeIn, easeOut, now } from "@/core/clock";
import { evalCamera, followPose } from "@/core/runtime";
import type { ActorPoses, Asset, LookSettings, SceneRuntime } from "@/core/types";
import { PostFX } from "./post";
import { makeFrameState, StageContext, updateFrame, useStage, type SlotRole, type StageCtx, type TransitionView } from "./frame";
import { Sky } from "./env/Sky";
import { Rocks, Terrain, Trees } from "./env/Terrain";
import { Grass } from "./env/Grass";
import { Mountains } from "./env/Mountains";
import { Lights } from "./env/Lights";
import { ProceduralElement } from "./env/Procedural";
import { PhotoValley } from "./env/photoreal/PhotoValley";
import { Lion } from "./actors/Lion";
import { MediaBackground, MediaLayer } from "./layers/MediaLayers";
import { ModelLayer } from "./layers/ModelLayer";
import { ClipActorLayer } from "./layers/ClipActor";
import { TextLayer } from "./layers/TextLayer";
import { NamesLayer } from "./layers/NamesLayer";
import { RouteLayer } from "./layers/RouteLayer";
import { ProjectileOverlay, ShakeDriver } from "./effects/Impact";
import { Rain } from "./effects/Rain";
import { DissolveMask, FogOverlay, HazeOverlay, LightningOverlay, TravelHaze } from "./effects/Overlays";
import { GlowOverlay, HeatOverlay, LightsOverlay, StarsOverlay } from "./effects/Atmos";
import { recordError } from "@/ui/ErrorBoundary";

export interface SceneCanvasProps {
  role: SlotRole;
  /** Runtime key the canvas was mounted for; content is built from this runtime's scene. */
  runtime: SceneRuntime;
  getRt: () => SceneRuntime | null;
  getPoses: () => { poses: ActorPoses; at: number };
  getTransition: () => TransitionView | null;
  assets: Asset[];
  canvasW: number;
  canvasH: number;
  isOutput: boolean;
  audio: boolean;
  dpr: number;
  targetFps: number;
  background: string;
  onCapture?: (dataUrl: string) => void;
}

/** One scene instance rendered into its own WebGL canvas. Re-creates itself if the GPU context is lost. */
export function SceneCanvas(p: SceneCanvasProps) {
  const frame = useMemo(makeFrameState, []);
  const ctx = useMemo<StageCtx>(
    () => ({
      role: p.role,
      getRt: p.getRt,
      getPoses: p.getPoses,
      getTransition: p.getTransition,
      assets: p.assets,
      canvasW: p.canvasW,
      canvasH: p.canvasH,
      isOutput: p.isOutput,
      audio: p.audio,
      frame,
    }),
    [p.role, p.getRt, p.getPoses, p.getTransition, p.assets, p.canvasW, p.canvasH, p.isOutput, p.audio, frame],
  );
  const limited = p.targetFps > 0 && p.targetFps < 59;
  const [gen, setGen] = useState(0);
  const glRef = useRef<THREE.WebGLRenderer | null>(null);
  const dead = useRef(false);
  // Browsers allow only a handful of live WebGL contexts per page. Every TAKE mounts a new
  // canvas, so release the old context the moment its canvas goes, instead of waiting for GC.
  useEffect(
    () => () => {
      dead.current = true;
      try {
        glRef.current?.forceContextLoss();
      } catch {
        /* already gone */
      }
    },
    [],
  );

  return (
    <Canvas
      key={gen}
      dpr={p.dpr}
      shadows
      frameloop={limited ? "demand" : "always"}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance", failIfMajorPerformanceCaveat: false }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
        gl.outputColorSpace = THREE.SRGBColorSpace;
        glRef.current = gl;
        const el = gl.domElement;
        // A lost context (driver reset, GPU hiccup) must never leave the wall frozen: let the
        // browser restore it, then rebuild this canvas from the same runtime.
        el.addEventListener("webglcontextlost", (e) => {
          if (dead.current) return;
          e.preventDefault();
          recordError(`WebGL context lost (${p.role}); rebuilding`);
        });
        el.addEventListener("webglcontextrestored", () => {
          if (!dead.current) setGen((g) => g + 1);
        });
      }}
      style={{ position: "absolute", inset: 0 }}
    >
      <StageContext.Provider value={ctx}>
        {limited && <FrameLimiter fps={p.targetFps} />}
        <FrameDriver />
        <CameraRig />
        <SceneContent runtime={p.runtime} background={p.background} onCapture={p.onCapture} />
      </StageContext.Provider>
    </Canvas>
  );
}

/** Frame-rate cap aligned to the display's refresh (a timer-driven cap judders). */
function FrameLimiter({ fps }: { fps: number }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const interval = 1000 / fps;
    let last = 0;
    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last >= interval - 1.5) {
        last = t - ((t - last) % interval);
        invalidate();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [fps, invalidate]);
  return null;
}

function FrameDriver() {
  const { getRt, frame } = useStage();
  useFrame(() => {
    const rt = getRt();
    if (rt) updateFrame(frame, rt, now());
  }, -10);
  return null;
}

function CameraRig() {
  const { getRt, getPoses, getTransition, frame, canvasW, canvasH } = useStage();
  const set = useThree((s) => s.set);
  const camera = useMemo(() => {
    const c = new THREE.PerspectiveCamera(40, canvasW / canvasH, 0.1, 9000);
    (c as unknown as { manual: boolean }).manual = true;
    return c;
  }, [canvasW, canvasH]);
  const fwd = useMemo(() => new THREE.Vector3(), []);
  const right = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const look = useMemo(() => new THREE.Vector3(), []);
  // Smoothed follow destination so a 30 Hz pose feed never steps the camera.
  const follow = useRef<{ x: number; z: number; ready: boolean }>({ x: 0, z: 0, ready: false });
  useLayoutEffect(() => {
    set({ camera });
  }, [camera, set]);

  useFrame((_, dt) => {
    const rt = getRt();
    if (!rt) return;
    const cam = rt.camera;
    let to = cam.to;
    if (cam.follow) {
      const { poses, at } = getPoses();
      const a = poses[cam.follow.actorId];
      if (a) {
        const moving = a.action === "walk" || a.action === "run" || a.action === "turn";
        const ext = moving ? clamp((frame.wall - at) / 1000, 0, 0.12) : 0;
        const tx = a.pos[0] + Math.sin(a.heading) * a.speed * ext;
        const tz = a.pos[1] + Math.cos(a.heading) * a.speed * ext;
        const f = follow.current;
        if (!f.ready || Math.hypot(tx - f.x, tz - f.z) > 6) {
          f.x = tx;
          f.z = tz;
          f.ready = true;
        } else {
          const k = 1 - Math.exp(-dt * 5);
          f.x += (tx - f.x) * k;
          f.z += (tz - f.z) * k;
        }
        to = followPose([f.x, f.z], cam.follow.offset, cam.to.hfov);
      }
    } else follow.current.ready = false;
    const pose = evalCamera(cam, frame.t, to);
    camera.position.set(...pose.position);
    look.set(...pose.target);
    // Hand-held sway: a little position drift and a slower aim drift, scaled to the shot's distance.
    if (frame.swayX !== 0 || frame.swayY !== 0) {
      const dist = Math.max(1, camera.position.distanceTo(look));
      camera.lookAt(look);
      right.setFromMatrixColumn(camera.matrix, 0);
      camera.position.addScaledVector(right, frame.swayX * 0.05).addScaledVector(up, frame.swayY * 0.03);
      look.addScaledVector(right, frame.swayX * 0.02 * dist).addScaledVector(up, frame.swayY * 0.012 * dist);
    }
    camera.lookAt(look);
    if (frame.swayRoll !== 0) camera.rotateZ(frame.swayRoll * 0.01);
    // Travel transition: fly forward out of the old location, arrive into the new one.
    const tr = getTransition();
    if (tr && tr.spec.kind === "travel") {
      const d = tr.spec.travelDistance;
      const off = tr.side === "out" ? d * easeIn(clamp(tr.p / 0.65, 0, 1)) : -d * (1 - easeOut(clamp((tr.p - 0.35) / 0.65, 0, 1)));
      camera.getWorldDirection(fwd);
      fwd.y = 0;
      fwd.normalize();
      camera.position.addScaledVector(fwd, off);
      camera.position.y += Math.abs(off) * 0.06;
    }
    camera.aspect = canvasW / canvasH;
    const hf = (pose.hfov * Math.PI) / 180;
    camera.fov = (2 * Math.atan(Math.tan(hf / 2) / camera.aspect) * 180) / Math.PI;
    // Framing: render only the zoomed window of the full view, at full resolution.
    if (frame.frameZoom > 1.0001) {
      const w = canvasW / frame.frameZoom;
      const h = canvasH / frame.frameZoom;
      camera.setViewOffset(canvasW, canvasH, frame.frameX * canvasW - w / 2, frame.frameY * canvasH - h / 2, w, h);
    } else if (camera.view) camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }, -8);
  return null;
}

/** Renders back layers, the 3D world, front layers and overlays in order. */
function Compositor({ back, front, fx, children, background, onCapture, look }: { back: ReactNode; front: ReactNode; fx: ReactNode; children: ReactNode; background: string; onCapture?: (d: string) => void; look?: LookSettings }) {
  const { canvasW, canvasH, frame } = useStage();
  const post = useMemo(() => new PostFX(), []);
  useEffect(() => () => post.dispose(), [post]);
  const bufSize = useMemo(() => new THREE.Vector2(), []);
  const scenes = useMemo(() => ({ back: new THREE.Scene(), front: new THREE.Scene(), fx: new THREE.Scene() }), []);
  const ortho = useMemo(() => new THREE.OrthographicCamera(-canvasW / 2, canvasW / 2, canvasH / 2, -canvasH / 2, -100, 100), [canvasW, canvasH]);
  const bg = useMemo(() => new THREE.Color(background), [background]);
  const captured = useRef(false);
  const mountedAt = useMemo(() => performance.now(), []);

  useFrame(({ gl, scene, camera }) => {
    gl.autoClear = false;
    // The flat layers share the framing with the 3D camera.
    if (ortho.zoom !== frame.frameZoom || ortho.position.x !== (frame.frameX - 0.5) * canvasW || ortho.position.y !== (0.5 - frame.frameY) * canvasH) {
      ortho.zoom = frame.frameZoom;
      ortho.position.set((frame.frameX - 0.5) * canvasW, (0.5 - frame.frameY) * canvasH, 0);
      ortho.updateProjectionMatrix();
    }
    if (look?.enabled) {
      // HDR path: back + world into a linear float target, then the camera finish to screen.
      gl.getDrawingBufferSize(bufSize);
      post.setSize(bufSize.x, bufSize.y);
      gl.setRenderTarget(post.scene);
      gl.setClearColor(bg, 1);
      gl.clear(true, true, true);
      gl.render(scenes.back, ortho);
      gl.clearDepth();
      gl.render(scene, camera);
      post.finish(gl, look, frame.ts, frame.flash * 0.25);
      gl.setRenderTarget(null);
      gl.clearDepth();
    } else {
      gl.setRenderTarget(null);
      gl.setClearColor(bg, 1);
      gl.clear(true, true, true);
      gl.render(scenes.back, ortho);
      gl.clearDepth();
      gl.render(scene, camera);
      gl.clearDepth();
    }
    gl.render(scenes.front, ortho);
    gl.render(scenes.fx, ortho);
    if (onCapture && !captured.current && performance.now() - mountedAt > 1800) {
      captured.current = true;
      try {
        const src = gl.domElement;
        const c = document.createElement("canvas");
        c.width = 320;
        c.height = Math.max(40, Math.round((320 * canvasH) / canvasW));
        c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
        onCapture(c.toDataURL("image/jpeg", 0.7));
      } catch {
        /* thumbnails are cosmetic */
      }
    }
  }, 1);

  return (
    <>
      {createPortal(back, scenes.back)}
      {createPortal(front, scenes.front)}
      {createPortal(fx, scenes.fx)}
      {children}
    </>
  );
}

function SceneContent({ runtime, background, onCapture }: { runtime: SceneRuntime; background: string; onCapture?: (d: string) => void }) {
  const { getRt } = useStage();
  const scene = runtime.scene;
  const preset = scene.environment;
  const comps = scene.components;
  const envGroup = useRef<THREE.Group>(null);

  // A media background hides the procedural world once it has fully faded in.
  useFrame(() => {
    const rt = getRt();
    if (!envGroup.current || !rt) return;
    const cur = comps.find((c) => c.id === rt.background.current);
    envGroup.current.visible = !(cur?.kind === "background" && cur.source === "media");
  });

  const flat = preset === "none";
  const back = (
    <>
      {comps.map((c) => (c.kind === "background" && c.source === "media" ? <MediaBackground key={c.id} comp={c} /> : null))}
      {comps.map((c, i) => (c.kind === "clipActor" ? <ClipActorLayer key={c.id} comp={c} order={i} /> : null))}
      {comps.map((c) => ((c.kind === "video" || c.kind === "image") && c.placement === "back" ? <MediaLayer key={c.id} comp={c} /> : null))}
    </>
  );
  const front = (
    <>
      {comps.map((c) => ((c.kind === "video" || c.kind === "image") && c.placement === "front" ? <MediaLayer key={c.id} comp={c} /> : null))}
      {comps.map((c) => (c.kind === "route" ? <RouteLayer key={c.id} comp={c} /> : null))}
      {comps.map((c) => (c.kind === "names" ? <NamesLayer key={c.id} comp={c} /> : null))}
      {comps.map((c) => (c.kind === "text" ? <TextLayer key={c.id} comp={c} /> : null))}
      {comps.map((c) => (c.kind === "effect" && c.effect === "projectile" ? <ProjectileOverlay key={c.id} comp={c} /> : null))}
    </>
  );
  const shakes = comps.filter((c): c is Extract<typeof c, { kind: "effect" }> => c.kind === "effect" && c.effect === "shake");
  const fx = (
    <>
      {comps.map((c) => {
        if (c.kind !== "effect") return null;
        switch (c.effect) {
          case "stars":
            return <StarsOverlay key={c.id} comp={c} />;
          case "haze":
            return <HazeOverlay key={c.id} comp={c} />;
          case "heat":
            return <HeatOverlay key={c.id} comp={c} />;
          case "fog":
            return <FogOverlay key={c.id} comp={c} />;
          case "lights":
            return <LightsOverlay key={c.id} comp={c} />;
          case "glow":
            return <GlowOverlay key={c.id} comp={c} />;
          case "lightning":
            return <LightningOverlay key={c.id} comp={c} flat={flat} />;
          default:
            return null;
        }
      })}
      <TravelHaze />
      <DissolveMask />
    </>
  );

  return (
    <Compositor back={back} front={front} fx={fx} background={background} onCapture={onCapture} look={scene.look}>
      <Lights plate={flat ? scene.plateLight ?? null : null} />
      {shakes.length > 0 && <ShakeDriver comps={shakes} />}
      {preset === "shepherd-photoreal" ? (
        <group ref={envGroup}>
          <PhotoValley sheep={comps.find((c): c is Extract<typeof c, { kind: "procedural" }> => c.kind === "procedural" && c.element === "sheep") ?? null} />
        </group>
      ) : preset !== "none" ? (
        <group ref={envGroup}>
          <Sky />
          <Mountains preset={preset} />
          <Terrain preset={preset} />
          <Rocks preset={preset} />
          <Trees preset={preset} />
          <Grass preset={preset} />
        </group>
      ) : (
        <ShadowCatcher opacity={scene.plateLight?.shadow ?? 0.45} />
      )}
      {comps.map((c) => {
        switch (c.kind) {
          case "actor":
            return <Lion key={c.id} comp={c} preset={preset} />;
          case "procedural":
            // the photoreal valley draws its own photographic flock
            if (preset === "shepherd-photoreal" && c.element === "sheep") return null;
            return <ProceduralElement key={c.id} comp={c} preset={preset} />;
          case "model":
            return <ModelLayer key={c.id} comp={c} />;
          case "video":
          case "image":
            return c.placement === "world" ? <MediaLayer key={c.id} comp={c} /> : null;
          case "effect":
            return c.effect === "rain" || c.effect === "snow" ? <Rain key={c.id} comp={c} preset={preset} /> : null;
          default:
            return null;
        }
      })}
    </Compositor>
  );
}

/** Invisible ground that only receives shadows, so 3D actors sit on flat video plates. */
function ShadowCatcher({ opacity }: { opacity: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[200, 200]} />
      <shadowMaterial opacity={opacity} />
    </mesh>
  );
}

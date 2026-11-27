import { memo, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, createPortal, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { clamp, easeIn, easeOut, now } from "@/core/clock";
import { evalCamera, followPose } from "@/core/runtime";
import type { ActorPoses, Asset, LookSettings, SceneRuntime } from "@/core/types";
import { PostFX } from "./post";
import { makeFrameState, StageContext, unseenSlots, updateFrame, useStage, type SlotRole, type StageCtx, type TransitionView } from "./frame";
import { Sky } from "./env/Sky";
import { Rocks, Terrain, Trees } from "./env/Terrain";
import { Grass } from "./env/Grass";
import { Mountains } from "./env/Mountains";
import { Lights } from "./env/Lights";
import { ProceduralElement } from "./env/Procedural";
import { PhotoValley } from "./env/photoreal/PhotoValley";
import { PbrValley } from "./env/pbr/PbrValley";
import { Lion } from "./actors/Lion";
import { MediaBackground, MediaLayer } from "./layers/MediaLayers";
import { ModelLayer } from "./layers/ModelLayer";
import { ClipActorLayer } from "./layers/ClipActor";
import { CountdownLayer, TextLayer } from "./layers/TextLayer";
import { NamesLayer } from "./layers/NamesLayer";
import { RouteLayer } from "./layers/RouteLayer";
import { ProjectileOverlay, ShakeDriver } from "./effects/Impact";
import { Rain } from "./effects/Rain";
import { DissolveMask, FogOverlay, HazeOverlay, LightningOverlay, TravelHaze } from "./effects/Overlays";
import { GlowOverlay, HeatOverlay, LightsOverlay, StarsOverlay } from "./effects/Atmos";
import { recordError } from "@/ui/ErrorBoundary";
import { serveSnaps } from "./snap";
import { instrumentUploads } from "./uploadStats";

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

/** How long a lost WebGL context may take to come back before the canvas is rebuilt without it. */
const RESTORE_WAIT_MS = 3000;

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
        // three reads every program's info logs on its first use to report shader errors: a round trip to the GPU
        // process per program, on the main thread, the frame a new scene first draws. Only while developing.
        gl.debug.checkShaderErrors = import.meta.env.DEV;
        glRef.current = gl;
        instrumentUploads(gl.getContext());
        const el = gl.domElement;
        // A lost context (driver reset, GPU hiccup) must never leave the wall frozen: let the
        // browser restore it, then rebuild this canvas from the same runtime. Not every browser
        // restores a lost context (WebKit may not): if nothing comes within RESTORE_WAIT_MS a new
        // canvas is built anyway. `retired` marks this context once its successor is on the way.
        let retired = false;
        let restoreTimer: ReturnType<typeof setTimeout> | null = null;
        const rebuild = () => {
          if (retired || dead.current) return;
          retired = true;
          if (restoreTimer) clearTimeout(restoreTimer);
          restoreTimer = null;
          setGen((g) => g + 1);
        };
        el.addEventListener("webglcontextlost", (e) => {
          if (retired || dead.current) return;
          e.preventDefault();
          recordError(`WebGL context lost (${p.role}); rebuilding`);
          if (!restoreTimer) restoreTimer = setTimeout(rebuild, RESTORE_WAIT_MS);
        });
        el.addEventListener("webglcontextrestored", rebuild);
      }}
      style={{ position: "absolute", inset: 0 }}
      // Lets the wall video link (engine/wallVideo.ts, loaded only while it is on) find the preview canvas.
      data-stage-role={p.role}
    >
      <StageContext.Provider value={ctx}>
        {limited && <FrameLimiter fps={p.targetFps} />}
        <FrameDriver />
        <CameraRig />
        <Sliced>
          <SceneContent runtime={p.runtime} background={p.background} onCapture={p.onCapture} />
        </Sliced>
      </StageContext.Provider>
    </Canvas>
  );
}

/**
 * Builds the scene's content as a transition, so React renders it in slices of a few milliseconds between frames
 * instead of in one task. A TAKE mounts a whole scene tree in every window that shows it (hundreds of components
 * and three objects): measured 60-110 ms of main thread in one go in a development build, during which every
 * other canvas of the window, the scene going out included, stood still while its videos played on, then jumped.
 * The canvas draws nothing until its content is there and its shaders are compiled (see the compositor), and a
 * new scene comes in under a transition, so building it over a few frames shows nowhere.
 */
function Sliced({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(false);
  useEffect(() => startTransition(() => setOn(true)), []);
  return on ? <>{children}</> : null;
}

/**
 * Keep one failing layer from freezing the wall. Every canvas in a window is drawn from one shared
 * animation-frame loop, one canvas after the other, with nothing catching errors: a per-frame callback
 * that throws (a layer meeting data it did not expect) ends that frame there, every frame, so the canvases
 * after it are never drawn again (the incoming scene behind a failing outgoing one, say), and no error
 * boundary sees it. Each per-frame callback of this canvas is therefore run guarded: one that throws is
 * reported once, skipped for a second and tried again, while everything else keeps drawing.
 */
type FrameRef = { current: (...args: unknown[]) => void };
function makeFrameGuard(role: SlotRole) {
  const guarded = new WeakSet<object>();
  let seen: unknown = null;
  let seenLength = -1;
  const guard = (ref: FrameRef) => {
    if (guarded.has(ref)) return;
    guarded.add(ref);
    let inner = ref.current;
    let failedAt = 0;
    let reported = 0;
    const run = (...args: unknown[]) => {
      if (failedAt && performance.now() - failedAt < 1000) return;
      try {
        inner(...args);
        failedAt = 0;
      } catch (e) {
        failedAt = performance.now();
        if (reported++ < 3) recordError(`Render error in the ${role === "live" ? "program" : role} picture (that layer is skipped and retried): ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    // The same ref object stays registered (the loop and its unsubscribe hold it); React keeps assigning
    // the latest callback to `current`, which now lands in `inner`.
    Object.defineProperty(ref, "current", { configurable: true, get: () => run, set: (fn: FrameRef["current"]) => (inner = fn) });
  };
  /** Guard every callback registered so far. Called at the top of each frame; does nothing when the list is unchanged. */
  return (subscribers: { ref: unknown }[]) => {
    if (subscribers === seen && subscribers.length === seenLength) return;
    seen = subscribers;
    seenLength = subscribers.length;
    for (const sub of subscribers) guard(sub.ref as FrameRef);
  };
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
  const { getRt, frame, role } = useStage();
  const get = useThree((s) => s.get);
  const guardFrames = useMemo(() => makeFrameGuard(role), [role]);
  useFrame(() => {
    // First callback of the frame (lowest priority number): put the guard on any callback added since.
    guardFrames(get().internal.subscribers);
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
  const { canvasW, canvasH, frame, role, getRt } = useStage();
  const post = useMemo(() => new PostFX(), []);
  useEffect(() => () => post.dispose(), [post]);
  const bufSize = useMemo(() => new THREE.Vector2(), []);
  const scenes = useMemo(() => ({ back: new THREE.Scene(), front: new THREE.Scene(), fx: new THREE.Scene() }), []);
  const ortho = useMemo(() => new THREE.OrthographicCamera(-canvasW / 2, canvasW / 2, canvasH / 2, -canvasH / 2, -100, 100), [canvasW, canvasH]);
  const bg = useMemo(() => new THREE.Color(background), [background]);
  const captured = useRef(false);
  const mountedAt = useMemo(() => performance.now(), []);
  /** Shader warm-ups done: one on the first frame, one a little later for layers that mount late. */
  const warmed = useRef(0);
  /** The first warm-up's programs are linked: only then is anything drawn (see below). */
  const ready = useRef(false);

  useFrame(({ gl, scene, camera }) => {
    gl.autoClear = false;
    // three compiles a material's shader the first time the object is drawn, and skips hidden objects: rain,
    // a lightning bolt, fog, a title or a cut-out that waits for its cue compiled on the frame the cue fired,
    // a dropped frame (or several) exactly on the beat, again in every run because each TAKE is a new GL
    // context. So everything in the scene is compiled once up front, hidden or not, while the TAKE's
    // transition covers it, against the same targets it will be drawn to.
    //
    // And off the main thread: compileAsync hands the programs to the driver (KHR_parallel_shader_compile) and
    // polls until they are linked. The first draw used to come straight after a plain compile and waited for
    // every program on the main thread, which is the window's only thread: measured in WebKit, 140-150 ms for
    // 30 programs at every TAKE (WebKit keeps no compiled programs between contexts; Chromium does, ~45 ms),
    // over a second on a machine that has never compiled them. For that long every canvas in the window stood
    // still while its videos played on underneath, so the picture froze and then jumped. Now nothing is drawn
    // until the programs are ready (the new canvas is clear, so the slot under it shows), and the window keeps
    // drawing everything else meanwhile. A lost context never reports ready: draw after 2.5 s regardless.
    if (warmed.current === 0 || (warmed.current === 1 && performance.now() - mountedAt > 1500)) {
      warmed.current++;
      const first = warmed.current === 1;
      try {
        if (look?.enabled) {
          gl.getDrawingBufferSize(bufSize);
          post.setSize(bufSize.x, bufSize.y);
          gl.setRenderTarget(post.scene);
        } else gl.setRenderTarget(null);
        // compileAsync compiles at the call (against the render target set now) and resolves when linked.
        const jobs = [gl.compileAsync(scenes.back, ortho), gl.compileAsync(scene, camera)];
        gl.setRenderTarget(null);
        jobs.push(gl.compileAsync(scenes.front, ortho), gl.compileAsync(scenes.fx, ortho));
        if (first) void Promise.all(jobs).then(() => (ready.current = true));
      } catch (e) {
        console.warn("shader warm-up failed", e);
        ready.current = true;
      }
      if (first) setTimeout(() => (ready.current = true), 2500);
    }
    if (!ready.current) return;
    // A program slot nobody can see (opacity 0, or under an opaque transition video) keeps its last frame.
    if (role !== "preview") {
      const rt = getRt();
      if (rt && unseenSlots.has(rt.key)) return;
    }
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
    serveSnaps(role, gl.domElement, canvasW, canvasH);
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

/**
 * The scene's content tree. Memoised on the scene definition: live state (clocks, cues, effects) is
 * read each frame through getRt, so a live-state update must not re-render the React tree beneath
 * (up to 30 times a second during a scrub, and on every program broadcast in the output window).
 */
const SceneContent = memo(
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
  // Shadows cost a depth pass per frame and shadow chunks in every lit shader. A media plate with
  // nothing 3D on it (most of the show) has nothing to cast them, so the sun casts none there.
  const casters = comps.some((c) => c.kind === "actor" || c.kind === "model" || c.kind === "procedural");
  const shadows = !flat || casters;
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
      {comps.map((c) => (c.kind === "text" ? c.timerId ? <CountdownLayer key={c.id} comp={c} /> : <TextLayer key={c.id} comp={c} /> : null))}
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
      <Lights shadows={shadows} plate={flat ? scene.plateLight ?? null : null} skyFill={preset === "shepherd-pbr" ? 0.25 : 1} fogScale={preset === "shepherd-pbr" ? 0.45 : 1} />
      {shakes.length > 0 && <ShakeDriver comps={shakes} />}
      {preset === "shepherd-photoreal" ? (
        <group ref={envGroup}>
          <PhotoValley sheep={comps.find((c): c is Extract<typeof c, { kind: "procedural" }> => c.kind === "procedural" && c.element === "sheep") ?? null} />
        </group>
      ) : preset === "shepherd-pbr" ? (
        <group ref={envGroup}>
          <PbrValley />
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
      ) : casters ? (
        <ShadowCatcher opacity={scene.plateLight?.shadow ?? 0.45} />
      ) : null}
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
  },
  (a, b) => a.runtime.scene === b.runtime.scene && a.background === b.background && a.onCapture === b.onCapture,
);

/** Invisible ground that only receives shadows, so 3D actors sit on flat video plates. */
function ShadowCatcher({ opacity }: { opacity: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[200, 200]} />
      <shadowMaterial opacity={opacity} />
    </mesh>
  );
}

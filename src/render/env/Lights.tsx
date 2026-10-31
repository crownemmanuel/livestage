import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { PlateLight } from "@/core/types";
import { smoothstep } from "@/core/clock";
import { useStage } from "../frame";

/**
 * Sun, moon, sky fill and lightning illumination. Also drives scene fog so
 * real 3D geometry gets depth-aware haze/fog. On flat-plate scenes `plate`
 * replaces the sun with a key light matched to the footage.
 */
/**
 * `skyFill` scales the hemisphere light and `fogScale` the scene fog: an image-lit environment
 * supplies its own sky light and aerial haze, so both get a fraction.
 */
export function Lights({ shadows = true, plate, skyFill = 1, fogScale = 1 }: { shadows?: boolean; plate?: PlateLight | null; skyFill?: number; fogScale?: number }) {
  const { frame } = useStage();
  const plateDir = useMemo(() => new THREE.Vector3(), []);
  const nightKey = useMemo(() => new THREE.Color("#9fb4ff"), []);
  const scene = useThree((s) => s.scene);
  const { sun, moon, hemi, flash } = useMemo(() => {
    const sun = new THREE.DirectionalLight("#ffffff", 3);
    sun.castShadow = shadows;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -32;
    c.right = 32;
    c.top = 32;
    c.bottom = -32;
    c.near = 1;
    c.far = 260;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    const moon = new THREE.DirectionalLight("#9fb4ff", 0);
    c.updateProjectionMatrix();
    const hemi = new THREE.HemisphereLight("#bcd3ee", "#8a7350", 1);
    const flash = new THREE.DirectionalLight("#cfd8ff", 0);
    flash.position.set(-20, 120, -80);
    return { sun, moon, hemi, flash };
  }, [shadows]);

  useEffect(() => {
    const fog = new THREE.FogExp2("#c0c8d0", 0.002);
    scene.fog = fog;
    scene.add(sun.target, moon.target);
    return () => {
      scene.fog = null;
      scene.remove(sun.target, moon.target);
    };
  }, [scene, sun, moon]);

  useFrame(() => {
    // Keep the shadow frustum centred on the playing area. Shadow casters stay
    // fixed (toggling castShadow recompiles shaders mid-show); at night the sun
    // sits below the horizon at zero intensity, so its shadows simply vanish.
    const focus = new THREE.Vector3(0, 0, -14);
    sun.target.position.copy(focus);
    if (plate) {
      // Azimuth 0 = light from the audience, 90 = from stage right; elevation above the horizon.
      const az = (plate.azimuth * Math.PI) / 180;
      const el = (plate.elevation * Math.PI) / 180;
      plateDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
      sun.position.copy(focus).addScaledVector(plateDir, 120);
      const night = smoothstep(0.25, 1, frame.tod);
      sun.color.set(plate.color).lerp(nightKey, night);
      sun.intensity = plate.intensity * (1 - 0.96 * night) * (1 - 0.6 * frame.storm) + frame.flash * 2;
      moon.intensity = 0;
      hemi.color.set(plate.ambient).lerp(nightKey, night * 0.65);
      hemi.groundColor.set(plate.ambient).multiplyScalar(0.45);
      hemi.intensity = plate.ambientIntensity * (1 - 0.72 * night) + frame.flash * 2;
      flash.intensity = frame.flash * 4;
      const fogP = scene.fog as THREE.FogExp2 | null;
      if (fogP) {
        fogP.color.copy(frame.fogColor);
        fogP.density = frame.fogLevel * 0.004;
      }
      return;
    }
    sun.position.copy(focus).addScaledVector(frame.sunDir, 120);
    sun.color.copy(frame.sunColor);
    sun.intensity = frame.sunIntensity;
    moon.target.position.copy(focus);
    moon.position.copy(focus).addScaledVector(frame.moonDir, 120);
    moon.intensity = frame.moonIntensity;
    hemi.color.copy(frame.hemiSky);
    hemi.groundColor.copy(frame.hemiGround);
    hemi.intensity = frame.hemiIntensity * skyFill;
    flash.intensity = frame.flash * 4;
    const fog = scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.color.copy(frame.fogColor);
      fog.density = frame.sceneFogDensity * fogScale;
    }
  });

  return (
    <>
      <primitive object={sun} />
      <primitive object={moon} />
      <primitive object={hemi} />
      <primitive object={flash} />
    </>
  );
}

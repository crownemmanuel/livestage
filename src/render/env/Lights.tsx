import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useStage } from "../frame";

/**
 * Sun, moon, sky fill and lightning illumination. Also drives scene fog so
 * real 3D geometry gets depth-aware haze/fog.
 */
export function Lights({ shadows = true }: { shadows?: boolean }) {
  const { frame } = useStage();
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
    sun.position.copy(focus).addScaledVector(frame.sunDir, 120);
    sun.color.copy(frame.sunColor);
    sun.intensity = frame.sunIntensity;
    moon.target.position.copy(focus);
    moon.position.copy(focus).addScaledVector(frame.moonDir, 120);
    moon.intensity = frame.moonIntensity;
    hemi.color.copy(frame.hemiSky);
    hemi.groundColor.copy(frame.hemiGround);
    hemi.intensity = frame.hemiIntensity;
    flash.intensity = frame.flash * 4;
    const fog = scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.color.copy(frame.fogColor);
      fog.density = frame.sceneFogDensity;
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

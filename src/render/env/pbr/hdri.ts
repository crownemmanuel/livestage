// HDRI sky for the scanned-asset valley: loaded once per window, shared by the
// visible sky dome and the image-based lighting. The sun's horizontal direction
// is read from the image (its brightest texel) so shadows fall where the sky
// says they should.
import * as THREE from "three";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

export const PBR_BASE = "/media/pbr-valley/";

/** Unit xz direction toward the sun in the loaded HDRI (y is left to the time of day). */
export const hdriSun = new THREE.Vector3(0.3, 0, -0.95).normalize();

const loads = new Map<string, Promise<THREE.DataTexture>>();

/** Load an equirectangular .hdr (linear float) once per window. */
export function loadHdri(file: string): Promise<THREE.DataTexture> {
  let p = loads.get(file);
  if (!p) {
    p = new Promise((resolve, reject) => {
      new RGBELoader().setDataType(THREE.FloatType).load(
        PBR_BASE + file,
        (tex) => {
          tex.mapping = THREE.EquirectangularReflectionMapping;
          tex.needsUpdate = true;
          findSun(tex);
          resolve(tex);
        },
        undefined,
        reject,
      );
    });
    loads.set(file, p);
  }
  return p;
}

/**
 * Brightest texel of the panorama → world direction, using three's own equirect
 * convention (`equirectUv`): u = atan(z, x) / 2π + 0.5, v = asin(y) / π + 0.5,
 * with v = 0 at the bottom row (the loader flips the image).
 */
function findSun(tex: THREE.DataTexture) {
  const img = tex.image as { width: number; height: number; data: Float32Array };
  const { width: w, height: h, data } = img;
  if (!(data instanceof Float32Array)) return;
  let best = -1;
  let bx = 0;
  let by = 0;
  // Only the upper half (above the horizon) can hold the sun; stride keeps this quick on 4K.
  for (let y = 0; y < h / 2; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const l = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
      if (l > best) {
        best = l;
        bx = x;
        by = y;
      }
    }
  }
  const u = (bx + 0.5) / w;
  const v = 1 - (by + 0.5) / h;
  const theta = (u - 0.5) * Math.PI * 2;
  const phi = (v - 0.5) * Math.PI;
  const cp = Math.cos(phi);
  hdriSun.set(cp * Math.cos(theta), 0, cp * Math.sin(theta));
  if (hdriSun.lengthSq() < 1e-6) hdriSun.set(0.3, 0, -0.95);
  hdriSun.normalize();
  hdriSunElevation = phi;
}

/** Elevation (radians) of the sun in the HDRI; informative only, the show's time of day sets the real one. */
export let hdriSunElevation = 0.4;

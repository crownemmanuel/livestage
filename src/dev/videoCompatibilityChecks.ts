// Run through agent eval in a native dev webview. Uses synthetic pixels only:
// colour above a left-opaque/right-clear mask, composited over a blue background.
import * as THREE from "three";
import { applyMediaSettings, makeMediaMaterial, setMap } from "@/render/layers/mediaMaterial";

export function checkPackedAlphaMaterial() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 8;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, 8, 4);
  ctx.fillStyle = "white";
  ctx.fillRect(0, 4, 4, 4);
  ctx.fillStyle = "black";
  ctx.fillRect(4, 4, 4, 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.userData.alphaPacked = true;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  const renderer = new THREE.WebGLRenderer({ alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(64, 32);
  renderer.setClearColor(0x0000ff, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;
  const material = makeMediaMaterial();
  applyMediaSettings(material, { crop: { left: 0, right: 0, top: 0, bottom: 0 } });
  setMap(material, texture);
  const geometry = new THREE.PlaneGeometry(2, 2);
  scene.add(new THREE.Mesh(geometry, material));
  const gl = renderer.getContext();
  const pixel = (x: number, y: number) => {
    const p = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
    return [...p];
  };
  const red = (p: number[]) => p[0] > 240 && p[1] < 10 && p[2] < 10;
  const blue = (p: number[]) => p[2] > 240 && p[0] < 10 && p[1] < 10;
  try {
    renderer.render(scene, camera);
    const normal = { left: pixel(8, 16), right: pixel(56, 16), top: pixel(8, 31), bottom: pixel(8, 0) };
    material.uniforms.flipX.value = 1;
    renderer.render(scene, camera);
    const flipped = { left: pixel(8, 16), right: pixel(56, 16) };
    material.uniforms.crop.value.set(0.25, 0.25, 0.125, 0.125);
    renderer.render(scene, camera);
    const cropped = { left: pixel(8, 16), right: pixel(56, 16) };
    const error = gl.getError();
    return {
      normal, flipped, cropped, error,
      passed: !error && red(normal.left) && blue(normal.right) && red(normal.top) && red(normal.bottom)
        && blue(flipped.left) && red(flipped.right) && blue(cropped.left) && red(cropped.right),
    };
  } finally {
    material.dispose();
    geometry.dispose();
    texture.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

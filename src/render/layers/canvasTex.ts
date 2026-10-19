// Shared helpers for layers drawn with Canvas 2D and uploaded as textures
// (titles, the family tree, map routes).
import * as THREE from "three";
import type { BuiltInFont, TextFont } from "@/core/types";

export const FONT_STACK: Record<BuiltInFont, string> = {
  serif: `"Cormorant Garamond", "Palatino Linotype", Palatino, "Book Antiqua", "Hoefler Text", Georgia, serif`,
  sans: `Inter, "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`,
  display: `"Cinzel", "Trajan Pro", "Palatino Linotype", "Hoefler Text", Georgia, serif`,
  mono: `ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace`,
};

/** CSS font-family for a built-in stack or an installed family (falling back to sans). */
export function fontFamily(font: TextFont): string {
  return font in FONT_STACK ? FONT_STACK[font as BuiltInFont] : `"${font.replace(/["\\]/g, "")}", ${FONT_STACK.sans}`;
}

export function fontString(font: TextFont, weight: number, px: number, italic = false) {
  return `${italic ? "italic " : ""}${weight} ${px.toFixed(1)}px ${fontFamily(font)}`;
}

export interface CanvasTex {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  w: number;
  h: number;
}

export function makeCanvasTex(w: number, h: number): CanvasTex {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(w));
  canvas.height = Math.max(2, Math.round(h));
  const ctx = canvas.getContext("2d", { alpha: true })!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = 4;
  return { canvas, ctx, texture, w: canvas.width, h: canvas.height };
}

export function resizeCanvasTex(c: CanvasTex, w: number, h: number) {
  const W = Math.max(2, Math.round(w));
  const H = Math.max(2, Math.round(h));
  if (c.canvas.width === W && c.canvas.height === H) return false;
  c.canvas.width = W;
  c.canvas.height = H;
  c.w = W;
  c.h = H;
  return true;
}

/** Texture width for a full-canvas overlay: crisp on the wall, bounded for upload cost. */
export function overlayTexWidth(canvasW: number) {
  return Math.min(3072, Math.max(1024, canvasW));
}

/** Load an image for canvas drawing (cross-origin safe for asset:// and blob: URLs). */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image failed: ${url}`));
    img.src = url;
  });
}

/** Standard overlay material for a canvas texture in the ortho layers. */
export function makeOverlayMaterial(texture: THREE.Texture, blend: "normal" | "add" | "screen" | "multiply" = "normal") {
  const m = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  if (blend === "add" || blend === "screen") m.blending = THREE.AdditiveBlending;
  else if (blend === "multiply") m.blending = THREE.MultiplyBlending;
  return m;
}

export function hexToRgba(hex: string, a: number) {
  const c = new THREE.Color(hex);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
}

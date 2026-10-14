// Geometry and generated data are expensive to build (terrain, grass, rocks)
// and identical for every view, so build once per window and share them.
// three.js uploads shared geometry separately to each WebGL context.
const store = new Map<string, unknown>();

export function cached<T>(key: string, build: () => T): T {
  if (!store.has(key)) store.set(key, build());
  return store.get(key) as T;
}

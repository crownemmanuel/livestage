// Sound effects that ship with the app, served from /media/sfx. Loops are FLAC so they repeat with no gap.

import type { Asset } from "./types";

export const SFX_ASSETS: Asset[] = [
  // Steady heavy rain, a 60 s seamless loop cut from Rain.wav (the stock file's fade-in left out). 1.4 Goliath.
  { id: "asset_sfx_rain", name: "Sound FX · Rain (loop).flac", type: "audio", url: "/media/sfx/rain-loop.flac", builtIn: true, audioRole: "ambience" },
];

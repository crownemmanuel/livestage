# Lion asset: requirements and swap-in

## Current state

V1 ships with a **procedural placeholder lion**, built from primitives and animated in code (`src/render/actors/Lion.tsx` and `lionPose.ts`). The operator UI labels it clearly as **PLACEHOLDER MODEL**. It exercises every control the real asset will use:

- Idle, walk and run, with the gait cycle locked to distance travelled (no foot sliding)
- Turning in place, roar, attack (with forward lunge), hit reaction (with recoil), and fall (stays down, gets up on the next command)
- Smooth blending between actions, ground following on uneven terrain, contact shadow and playing-area bounds

It is **not** photoreal and is not meant to be. No realistic animal was silently substituted, and no animations are faked as if they came from an asset.

## Why there is no real lion in the repo

No model was downloaded without your approval. A licensable, production-quality, rigged and animated lion has to be chosen by you. Likely sources:

| Source | Notes |
| --- | --- |
| Commercial marketplaces (Fab, CGTrader, TurboSquid, Sketchfab Store) | Search "lion rigged animated". Production lions with groom-like fur cards and a full clip set typically cost US$50–400. Check that the licence allows **live public performance**. |
| Commission an artist | Best result for a hero creature; budget for fur cards plus about eight clips. |
| Sketchfab CC-BY downloads | Quality varies. CC-BY requires credit in the programme. |
| Free Quaternius/Poly-style animals | CC0 but stylised. Fine as a better placeholder, not for the final show. |

## Asset specification

| Item | Requirement |
| --- | --- |
| Format | **GLB** (binary glTF 2.0) with textures embedded |
| Scale | Real-world metres (shoulder height about 1.0–1.2 m). Use **Scale** in the inspector if not. |
| Facing | +Z forward is preferred. Otherwise set **Model yaw fix** in the inspector. |
| Origin | Between the feet, at ground level |
| Rig | Skinned, ideally ≤ 100 bones, up to 4 influences per vertex |
| Materials | PBR metallic-roughness. Fur as alpha-tested cards or a baked shell texture (true groom/hair systems are not supported in real time). |
| Polycount | 30k–120k triangles is comfortable on a GTX/RTX-class GPU at 4K |
| Clips | In place, **without** root motion: `Idle`, `Walk` (loop), `Run` (loop), `Roar`, `Attack`, `Hit`, `Death`/`Fall`. Optional: `TurnL`/`TurnR`. |

## Swapping it in

1. Scene Builder → **Asset library → Import** → choose the `.glb`. It is copied into the show library.
2. Select the **Lion** component → **Rigged GLB** → choose the asset.
3. In **Clip mapping**, map each action to a clip name found in the file. Missing clips are listed in red; those actions fall back to idle.
4. Tune **Stride walk/run**: the metres covered by one full loop of the walk/run clip. Walk the lion with the keyboard and adjust until the paws stop sliding. Playback of locomotion clips is driven by distance travelled, so once the stride is right, feet stay planted at any speed.
5. Adjust **Walk/Run speed**, **Scale** and **Model yaw fix** as needed.

Cues, keyboard control and the operator panel don't need any changes. If the file fails to load, the app logs the error, shows it in the inspector and falls back to the placeholder, so the show keeps running.

One-shot timings (roar 2.8 s, attack 1.7 s, hit 1.1 s, fall 1.8 s) are defined in `src/core/lion.ts`. Align them with the real clip lengths when the asset arrives.

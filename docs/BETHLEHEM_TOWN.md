# Bethlehem in 3D (Act I, Scene 1)

The Bethlehem of Act I is one 3D town in Blender (`media-src/blender/bethlehem-town.blend`, built by
`media-src/blender/build_town.py`). It is the scale and layout reference for every Bethlehem backdrop: we move the
camera through it, export a rough render plus the camera move, and hand both to the image and video models
(GPT Image / Nano Banana for stills, Seedance for moving shots) to make the high-fidelity version. Because every
shot comes from one model of the town, the houses, doors, workshop and hills stay in the same places from shot to
shot, at the right size next to the live actors.

Scene 15 (No Room in the House of David) and the Act II Bethlehem scenes reuse this town later (night, crowded,
snow). Nazareth (Scenes 2–10) is a separate town, with Joseph's home on the left.

## The town (all units metres; x runs left → right as the audience sees it, y goes away from them)

| Place | Where | Script moment | Notes |
|---|---|---|---|
| South road and town gate | far **left**, x ≈ −34 | Joseph arrives "from the house-left aisle", dusty from the road | low town wall, an arched gate, the road winding down into the hills |
| The street of doors | left and centre, facing the audience | the kids burst on; IX-04 "every door is open wide" | six houses, each with its own front door on a hinge (doors open on cue), steps, jars, awnings, laundry |
| The square and well | centre, x ≈ 0 | "Welcome Home": townspeople flood in, Dinah with her water jar | a stone well, the bread oven with smoke, a potter's stall, the old men's game-board bench, a fig tree |
| Rooftops | above the street | kids running along rooftops during the song (Multimedia Guide) | flat roofs with parapets and ladders, a second row stepping up the hill |
| Jacob's house | **right**, x ≈ 17 | Sarah calls "JOSEPH?!" from a doorway; Sarah and Jacob wave from it at the farewell | its own door, an upper window |
| Jacob's workshop | **right**, x ≈ 11, joined to the house | The Workshop (late afternoon gold) | open front, workbench, tools on the back wall, planks, shavings, lamp; walk-in interior so the camera can push inside |
| North road out | far **right**, x ≈ 26 | Farewell: Joseph walks out toward Nazareth | the road climbs away past the last house into the hills; the map (TR-02) takes over from here |
| Hills and hill town | behind everything | the same hills as the prologue | terraced slopes, olive groves, the upper town on the ridge |

Joseph's home in Bethlehem is on the right of the wall (stage left), as in [SCENE_BACKDROPS.md](SCENE_BACKDROPS.md).

## Cameras (named cameras in the .blend; the wall is 4:1)

| Camera | Shot | Move on the wall |
|---|---|---|
| `cam-01-arrival` | the south road and gate | follows Joseph in from the left as he climbs on stage: slow track right along the street |
| `cam-02-street` | the whole street of doors (BG-01) | rest position for most of the scene; the doors open for IX-04 |
| `cam-03-square` | wider, slightly higher, centred on the square | for "Welcome Home": crowd and rooftops in view |
| `cam-04-workshop` | push from the street into the workshop | "Shift to Jacob's workshop": the camera travels in instead of a cut |
| `cam-05-farewell` | from the street toward the north road | follows Joseph out to the right, then rises over the rooftops to the hills (hands over to the map) |

All cameras sit at the eye height of an audience member looking at the wall (about 1.7 m), so a 1.75 m person on
stage and a doorway on the wall match. Scale markers (1.75 m figures) mark where actors stand; they are hidden in
renders.

## Movement on the wall (what is alive)

- Always: oven smoke, laundry and awnings in the breeze, palms and the fig tree swaying, pigeons on the roofs,
  small distant townspeople, the morning light slowly moving.
- On cue: IX-04 doors swing open with neighbours leaning out; banners and faces in windows during "Welcome Home";
  kids running along the rooftops.
- Camera: follows Joseph on arrival and departure; pushes into the workshop; rises at the farewell.

Blender gives the layout, scale and camera paths. The finished picture comes from rendering those paths as
references for the image and video models (Seedance with the Blender render as the motion reference).

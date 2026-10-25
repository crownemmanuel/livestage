# Scene backdrops (the play after the prologue)

How the main LED backdrop for each scene of the play is made, and what each one must contain. Source for scene content: the Script project (`~/Documents/Videos/Salvation/Script/Salvation House of David Script.md` and `… Multimedia Guide.md`, which names each backdrop BG-01, BG-02 …). Generation pipeline and rules: [MEDIA_GENERATION.md](MEDIA_GENERATION.md).

## The wall is part of the set (most important)

The LED wall is an extension of the physical stage, not a video screen. Everything on it stays at the true scale of the live actors and the set: a doorway on the wall is a real doorway's height next to a 1.75 m actor, the street on the wall continues the stage floor, and the camera sits at audience eye height (about 1.7 m) looking at the set as if through a window.

- Never push or zoom the camera into a place (e.g. into Jacob's workshop) so that it fills the wall: the objects blow up past life size and the illusion of a set breaks. Change location the way a theatre does: the set itself moves, opens, turns or is replaced (see "Set changes" below), or the camera travels sideways along the street at eye height.
- Small, slow camera moves are fine when they keep scale: a gentle drift or a sideways track following an actor.
- Big moves (fly-overs, the map, the sky) belong to transitions where the stage is dark or the moment is clearly a storybook/vision, never while actors stand in front of the wall.

## Look

- Photoreal, cinematic, warm: the reference is `media-src/scenes/refs/backdrop-style-village.png`. Sandstone and mud-brick houses, wooden doors, clay jars and barrels, palms and olive trees, oil lamps glowing in doorways, an evening/morning sky, a packed-earth street in front. Not storybook (the parchment look is only for the prologue story).
- Framed for the 4:1 wall (3072 × 768) inside a 21:9 letterboxed image (`LETTERBOX=1`), like every other wall image.
- The street runs along the front of the picture at the actors' level, so the set reads as the space just behind the live actors. Keep the lower centre clear (people stand in front of it); no large figures in the backdrop.
- People: Israelites of the ancient Near East with an olive-brown Middle Eastern skin tone. Background townspeople only, small and few.
- Doors that the script opens or closes (IX-04 in Scene 1, IX-17 in Scene 15) must be clear, separate, front-facing doors so they can be cut out as their own layers.

## Placement rule: Joseph's home

| Town | Joseph's home | Why |
|---|---|---|
| **Bethlehem** (Scenes 1, 15) | on the **right** of the wall | the script puts Jacob's workshop *stage left*, which is the audience's right |
| **Nazareth** (Scenes 5, 7, 8, 9, 11, 13 and the coda) | on the **left** of the wall | |

Keep the same side in every variant of a backdrop (day, night, crowded, snow) so the house never jumps.

## Scene list

| Scene | Backdrop | Setting | Must contain |
|---|---|---|---|
| 1 Joseph Is Back! | BG-01 Bethlehem street, morning | a Bethlehem street at morning; hills beyond | Jacob's carpentry workshop on the **right** (open front, bench, tools, sawdust light); a row of houses with separate front doors along the street (they swing open on "every door is open wide"); a doorway Sarah calls from; oven smoke, pigeons on roofs, laundry, a few distant townspeople |
| 1 (The Workshop) | BG-02 Jacob's workshop interior | late-afternoon gold | old workbench, tools on the walls, shafts of light with sawdust |
| 1 (Farewell) | TR-02 map | Bethlehem → Nazareth | map line north to Nazareth |
| 2 The Chair | BG-03 Nazareth marketplace, midday | busier and dustier than Bethlehem | awnings, a donkey cart, merchants, a goat; Miriam's low courtyard wall continuing onto the wall |
| 3 Mary's House | BG-04 Eli's house and lane, evening | quiet, warm | lamps in doorways, a neighbour taking in washing, a cat on a wall |
| 5, 7, 8, 9, 11, 13 | BG-05 Joseph's workshop street and house (Nazareth) | half-built / finished; day / night | Joseph's house and workshop on the **left** |
| 6, 10, 12 | BG-06 Nazareth square | decorated / night torches | |
| 7 | BG-07 the well at golden hour | layered | |
| 15 No Room | BG-01N Bethlehem street at night, overflowing | the **same street and doors as Scene 1** | Jacob's house still on the right; travellers, tents, carts, people on roofs, family banners; snow later |
| 16 The Manger | BG-11 lower room of Hannah's house | nearly dark | rough stone, a lamp, animal silhouettes |
| 17 | BG-10 Bethlehem hills at night | starry sky, sheep, Bethlehem on its hill | |

Drafts live in `media-src/scenes/<scene>/` (low quality first, 4K once approved).

## Set changes (how the wall changes location, Broadway style)

The wall changes place the way a big physical set does, always at stage scale:

- **Trucked flats:** houses and walls slide in from the wings (left/right) on hidden tracks and lock into place.
- **Fly system:** pieces drop in from above (the fly loft) or rise out of view; a painted sky or drop flies in or out.
- **Revolve / turntable:** a building turns around to show its inside (a house front turns to become the workshop interior).
- **Pop-up / unfolding:** a storybook page or flat folds up into 3D (the prologue's parchment becoming the real street).
- **Scrim reveal:** a painted gauze in front is lit from the front (opaque), then the light moves behind it and the real set appears through it.
- **Lighting shift:** the same set, a new time of day (morning → late-afternoon gold for the workshop), no movement at all.

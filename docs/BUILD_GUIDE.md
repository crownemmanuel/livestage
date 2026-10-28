# Building a scene

## Scenes, groups and steps

- **Scene = a place.** One look on the wall: a background, characters, effects. A new place is a new scene.
- **Group = a run of places that play as one piece** (the Prologue: fields → lion rock → David's song → Goliath …). Groups have a colour and fold away in the scene list; their scenes are numbered 1.1, 1.2 … With *GO continues into the next scene* on (group ⋯ menu), GO after a scene's last step takes the next scene of the group, so the operator just keeps pressing GO.
  Start a group from the selected scene (folder + button above the list) or a scene's ⋯ menu → *Move to group*. The running-order number MSC and `/sls/take` use is in the tooltip on the number.
- **Step (cue) = a moment inside a place.** Build → **Run sheet**. Each step has:
  - **Fires**: *On GO* (default), *At a scene time* (seconds after TAKE), *After cue N fires* (+ seconds: a follow), or *When a video reaches a time* (a marker on a clip or video). GO always works too: it fires the next step early.
  - its actions (video clip, Lighting (Hog 4), sound, effect …), each with an optional delay ⏱,
  - an operator note: the line to GO on.

Example, the lion: one scene (*The Lion on the Rock*), one video character (*Lion*) whose clips are its **moves** (climb, idle loop, run). Step 1 *Lion arrives* plays *climb*, which settles into the *idle* loop by itself; step 2 *Lion charges* plays *run* when the operator is ready. A strobe on the leap is a marker on the *run* clip at 1.8 s.

## The preview

- It shows the **whole scene** (the label above it says so) and never reaches the wall.
- **Show at:** *Start · 1 · 2 …* puts the preview at the moment after that step (delays dropped).
- **Isolate** (⊙ on a row of *On stage*) shows one item on its own on black; the timeline follows it.
- **Timeline** under the preview: pick a video or clip, drag to scrub, **Marker at …** adds a marker at the playhead (it starts as a StageLight GO when the StageLight link is on, else a Hog GO). Ticks: green = fires a step, amber = sends lighting (Hog or StageLight) / MIDI / OSC. Click a tick to jump to it; the list below edits them.

## On stage

Everything in the scene, with when it comes in (*at start* or *cue N*). A video character's clips are listed under it as its moves; click one to put it on the timeline.

In the preview, automatic steps (scene time, follow, video) run for rehearsal but never switch the preview to another scene and never send to the console.

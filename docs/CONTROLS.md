# Controls — camera, mouse look, movement, interaction and building

This is the key map, the two camera modes and the suspension rules for the world view. It is the
source of truth the HUD wording must match. The input module that implements it is
`src/game-input.js`, built on the pure helpers in `src/camera-controls.js`; the step-by-step wiring for
the shell is in [the task 33 handoff](handoff/task-33-camera-controls.md).

**Status.** The module and its tests are delivered. It is **not yet wired into `app.js`** — only the
task 38 shell owner wires it (task 33 owns no shell file). Every statement below about the shipped
interface is read from the source in this tree (`app.js`, `src/camera-controls.js`, `server.js`); no
browser check was performed by this task, and `npm run browser` was not run.

## The key map

Every gameplay action is reachable from the keyboard. Nothing in this table needs a pointer.

| Action | Keys | What the module emits | Server call behind it |
|---|---|---|---|
| Walk one tile | `W` `A` `S` `D`, or the arrow keys | `move` with one cardinal direction | `POST /move` (first person: the direction is relative to the view; third person: the absolute cardinal) |
| Turn left / right | `Q` / `E` | `look` with the new facing | `POST /agents/:id/look` |
| Tilt up / down | `R` / `F` | `look` with the new facing | `POST /agents/:id/look` |
| Mouse look | drag on the world canvas (the pointer is captured for the drag) | `look` with the new facing | `POST /agents/:id/look` |
| Switch view mode | `V` (or the **First person** button) | `camera` with the new mode | none — the camera is client-side only |
| Use the aimed fixture | `Enter`, `Space` or `I` | `interact` | `POST /interact` (with `Idempotency-Key`) |
| Choose a frontier block | `1`–`7` (frontier areas, while building) | `build` with the block type | `POST /frontier/build` (placing it stays a pointer pick or the typed coordinate form) |
| Climb one authored layer | **Step-up mode** button, then the movement keys | `move` (routed to climb) | `POST /climb` |
| Release capture / stand down | `Escape` | `cancel` (only when it released a capture) | none |
| Turn-mode rotation | **Turn mode** button, then `W`/`A`/`S`/`D` | `look` with a 0.35-rad step | `POST /agents/:id/look` |

Text parity, for a viewer who cannot use a pointer: the **Walk to a tile** form (`Tile X` / `Tile Y`)
plans a real route and walks it one checked step at a time; the interaction panel's `Tile X` / `Tile Y`
and `Read this tile` read a fixture; the **Approach the …** button walks to a fixture out of reach; the
crop, recipe, posture and ambassador controls are ordinary labelled buttons. All of that is shipped
behaviour (`app.js:805-817,2288-2369`) and the module does not remove it.

### The `E` key, resolved

`E` **turns the camera** and the interaction keys are **`Enter`**, **`Space`** and **`I`**
(`src/camera-controls.js:22-31`). The shipped HUD hint and target line say "E to interact"
(`app.js:756,769,2216`) and `docs/GAME_INTERFACE.md:10` repeats it. That is wrong: `E` cannot both turn
and interact.

**This task chose to keep the binding and correct the wording** — the same resolution the world-HUD
spec already requires (`docs/specs/world-hud.md:57-62`; `docs/GAME_EXPERIENCE.md` §5.1). Task 33 cannot
edit `app.js`, so the deliverable is the module plus **the exact wording the shell must show**. The shell
owner must replace the three strings below (and the same claim in `docs/GAME_INTERFACE.md`):

| Where | Replace | With |
|---|---|---|
| `app.js:756` (HUD control hint, playing) | `WASD to walk · Drag to look · E to interact` | `WASD to walk · Drag to look · Enter, Space or I to interact` |
| `app.js:769` and `app.js:2216` (target line) | `${fixture.label} · E to interact` | `${fixture.label} · Enter, Space or I to interact` |
| `docs/GAME_INTERFACE.md:10` | "E to interact" | "Enter, Space or I to interact" |

The module exports those strings so the shell cannot drift from the binding:
`INTERACTION_KEY_LABEL === 'Enter, Space or I'`, `CONTROL_HINTS.playing`,
`CONTROL_HINTS.firstPerson`, `CONTROL_HINTS.observing`, `controlHint({ playing, mode })` and
`targetHint(fixture)`. The aim line (`reticleText`) already prints the correct set from the same
constant.

## The two camera modes

| Mode | Eye | What it can see |
|---|---|---|
| `first-person` (default) | inside the resident's own column, 1.35 m above the stored layer | exactly what a resident at that tile and layer can see |
| `third-person` | the same height and the same look direction, slid straight back along the ground to a shoulder distance (3.2 tiles by default) | the resident and its surroundings, from behind |

The third-person camera **cannot reveal geometry a first-person player could not see**, and it
**respects the elevation layer**, by construction (`cameraView` in `src/camera-controls.js`):

- It keeps the first-person eye height, so it never rises above the stored layer to look over a wall.
- It slides back only through tiles the injected `blocksView` predicate allows at that layer. A solid
  tile, or a column more than one layer above the resident (`THIRD_PERSON_MAX_STEP`), stops the boom in
  front of it, so the camera never crosses a wall and never sees the far side of one.
- If there is no clear tile behind (a solid wall at the resident's back), the boom length is zero and
  the camera falls back to the resident's own eye — a safe position, not a clipped one.

The shell supplies the predicate through `createViewBlocker({ isSolid, layerAt, maxStep })`, keeping
this module free of any world import. `isSolid` should be the same occupancy question the server asks
(`!walkable(tile) || solidSceneryAt(tile, objects)`), and `layerAt` the column surface
(`surfaceAt(x, y, blockLayers(blocks))`). The renderer's third-person view is the `orbit` camera
(`src/voxel-geometry.js`); the module reports `mode: 'third-person'` and the shell maps it to
`cameraMode: 'orbit'`.

Switching modes is client-side only and writes nothing: it never moves the resident and never changes
the stored position, and it cancels any pending look so a drag from the old mode cannot fire in the
new one.

## Suspension — typing and menus stand the shortcuts down

Gameplay shortcuts are **suspended** whenever the key press is not meant for the world. A suspended
press produces **no intent at all** and is not prevented, so the focused control keeps the key.

| Suspension | Trigger | Where it is detected |
|---|---|---|
| Typing | the event target is `INPUT`, `SELECT`, `TEXTAREA` or `BUTTON`, or is content-editable | the key event (`shortcutSuspended`) |
| A dialog is open | `document.querySelector('dialog[open]')` is non-null | the DOM (`app.js` already does this) |
| A modifier is held | `Ctrl`, `Meta` or `Alt` | the key event |
| A menu or drawer is open | the shell calls `input.suspend('menu')` / `'chat'` | the shell's own state |

Suspension is **counted**: two callers can suspend independently and the shortcuts resume only when
both have resumed (`input.suspend('menu')` … `input.resume('menu')` … `input.suspended`). This mirrors
the shipped guard in `app.js:1110` exactly, including the deliberate `BUTTON` exemption so `Enter` and
`Space` still activate a focused quickbar control.

Pointer look is suspended too: while a dialog or drawer is open the canvas does not start a drag.

## What the module never does

- **It never authors a position.** A `move` intent carries one cardinal direction and nothing else; a
  `look` intent carries an absolute facing for the server to store. No intent carries an `x`, `y` or
  `z` the client invented. A picked tile, when a click resolves one, comes from the renderer's raycast
  through the injected `pickAt`, never from this module.
- **It never writes.** Turning is a look and never a movement; interacting names a fixture action, not
  an outcome. Every intent is handed to the shell, which makes the shipped server call.
- **It never weakens a limit.** Reach, distance, budget, throttles and refusals stay the server's.

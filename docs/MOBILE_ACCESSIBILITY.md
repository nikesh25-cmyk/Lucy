# Mobile and accessibility experience — touch controls and a scoped responsive layer

**Status: delivered as a module, a scoped stylesheet and the wiring recipe. Not yet rendered on a
screen.** `app.js`, `index.html`, `style.css`, `nemo-theme.css` and `game-theme.css` belong to the
integration task (task 38), so this branch ships the pieces and the exact steps to attach them; it
does not turn the world screen on by itself. Read §5 before promising a user anything.

**No browser check was performed by this task.** No page was opened, no pointer was emulated and no
screenshot was taken. `npm run browser` was deliberately not run: no scenario can be added without
`app.js`, and driving the existing scenarios would change nothing about this module. Every number
below is recomputed by the test suite from the stylesheet and the module in this tree
(`tests/mobile-styles.test.js`, `tests/touch-controls.test.js`) and printed when those tests run.

Related: [the game experience specification](GAME_EXPERIENCE.md), [the world HUD](specs/world-hud.md),
[interaction flows](specs/flows.md), [the measured baseline in task 13](handoff/task-13-newcomer-journey.md),
[the delivered handoff](handoff/task-37-mobile-accessibility.md).

---

## 1. What "usable on a smaller screen" was taken to mean

Four requirements, each made checkable.

| Requirement | How it is delivered | How it is checked |
|---|---|---|
| Movement, camera, interaction and building reachable by touch | `src/ui/touch-controls.js` renders a movement pad, a camera drag surface and interaction/build affordances | `tests/touch-controls.test.js` drives every control against a stub document and an injected clock |
| Nothing assumed about mouse, hover or a physical keyboard | Pointer Events only; every control a labelled native `<button>`; no `:hover` rule; the keyboard path is the browser's own button activation | asserted from both source files |
| Reduced motion honoured, nothing essential carried by motion | animation is opt-in under `prefers-reduced-motion: no-preference`; a `reduce` block and the module's own `.nm-touch-reduced` class both suppress it; state is `aria-pressed`, `disabled` and live-region text | `tests/mobile-styles.test.js` counts every `transition`/`animation` declaration and requires each to be inside the opt-in query or a suppression |
| No regression to keyboard navigation, contrast or target size | the module binds no key event at all, so the shipped world key map is untouched; every control is at or above 44 px; every text pair is at or above 4.5:1, above the lowest value task 13 measured | `tests/mobile-styles.test.js`, plus the task 13 assertions that still run unchanged |

---

## 2. The touch-control API

`src/ui/touch-controls.js` — no dependency, no import, no side effect on load. It imports nothing at
all, which is why the four parallel tasks that own `src/camera-controls.js`, `src/game-input.js` and
the UI modules cannot collide with it.

### 2.1 The injected input interface

The module decides **no world rule**. It turns a gesture into an intent and hands the intent to the
interface the integration owner injects. Only `walk` is required; a missing member disables exactly
the controls that would use it and changes nothing else.

| Member | Called with | The owner maps it to |
|---|---|---|
| `walk(direction)` | `'up' \| 'left' \| 'down' \| 'right'` | `controlStep(direction)` — the shipped one-grid-step path, including camera-relative first-person walking, Turn mode and Step-up mode |
| `look({ yaw, pitch })` | a **relative** rotation in radians | `queueLook(state.facing.yaw + yaw, state.facing.pitch + pitch)` — `queueLook` takes an absolute facing, so the delta must be added by the owner |
| `pick({ x, y })` | client pixels, for a gesture that stayed under the drag threshold | the shipped canvas pick path, or omitted |
| `interact()` | nothing | `usePickedFixture()` — the single-flight, idempotency-keyed interaction path |
| `build()` | nothing | the same behaviour the `Build` HUD control has (frontier toggle, own-garden tools, route to the frontier) |
| `affordance(name)` | `'chat' \| 'tools'` | `setGameDrawer(name)` |

### 2.2 `createTouchControls(options)`

| Option | Default | Meaning |
|---|---|---|
| `document` | — (required) | the document to render into; there is no global fallback, so the module can be constructed in a test runner |
| `mount` | — (required) | the element the control surface is appended to |
| `surface` | `null` | the element the camera drag listens on (the world canvas). Without it, dragging is unavailable and the Look buttons remain |
| `input` | `{}` | the interface above |
| `canWalk()` | `() => true` | whether a resident is acting in an unpaused world |
| `hasFixture()` | `() => false` | whether the aim line names a fixture, which is what enables `Use` |
| `isBuilding()` | `() => false` | flips the build control's label between `Build` and `Finish` |
| `status` | `''` | the text in the polite live region |
| `reducedMotion()` | `() => false` | adds `nm-touch-reduced` to the container |
| `now`, `schedule`, `cancel` | `Date.now`, `setTimeout`, `clearTimeout` | injected so a hold-repeat can be tested without waiting |

Returns `{ root, buttons, groups, status, model, refresh, setEnabled, destroy, press, look, dragging, enabled }`.
`buttons` is a `Map` from control name (`up`, `left`, `down`, `right`, `look-left`, `look-right`,
`interact`, `build`, `chat`, `tools`) to its element. Call `refresh()` after the world state changes;
call `destroy()` before re-rendering the world (it removes every listener, cancels a hold, restores
the surface's `touch-action` and removes the container).

### 2.3 Gesture rules (all asserted)

| Rule | Value |
|---|---|
| A gesture under the drag threshold is a tap, over it a drag — never both | `DRAG_THRESHOLD = 6` px of accumulated travel |
| One pointer owns the drag, so a second finger can hold a movement key at the same time | the first `pointerdown` with `isPrimary !== false` |
| A press steps immediately; holding repeats after a delay, at an interval above the server's 120 ms step throttle | `HOLD_DELAY_MS = 320`, `HOLD_REPEAT_MS = 160` |
| A stuck gesture stops | `HOLD_LIMIT = 60` repeats |
| One direction at a time | starting a hold stops any other hold |
| A pointer press never double-steps through the `click` it generates; a keyboard activation steps exactly once | a click within `CLICK_SUPPRESS_MS = 700` of the press belongs to that press |
| A drag turns the camera the way the shipped controls do | drag right decreases yaw, exactly as `Look right` does; drag up decreases pitch, exactly as the ↑ direction does |
| The drag never exceeds the renderer's own tilt clamp | `MAX_PITCH = 1.4`, the value `app.js#clampFacing` already uses |
| The camera is reachable without a drag | `Look left` / `Look right`, at the shipped `LOOK_STEP = 0.35` |

### 2.4 Why the drag has buttons beside it

A drag is a **path-based gesture**. WCAG 2.2 SC 2.5.1 requires a single-pointer alternative for every
function that a path or multipoint gesture performs, so the camera cannot be drag-only. `Look left`
and `Look right` are that alternative, they use the same relative `look` intent as the drag, and they
are the same 0.35-radian step the shipped camera buttons use. Nothing about the camera is available
only by dragging.

---

## 3. The stylesheet scoping rule

`game-mobile.css` is a **new** stylesheet. `style.css`, `nemo-theme.css` and `game-theme.css` are
read-only for this task and are unchanged; `index.html` is unchanged too, so the file is loaded by the
integration owner and not by this branch.

**The rule: every selector in `game-mobile.css` begins with the container class `.nm-touch`, and
every media query contains only `.nm-touch` selectors.** The test enforces it:

- every selector matches `/^\.nm-touch\b/` — including inside media queries;
- no bare element selector (`button`, `canvas`, `body`, `p`, …);
- no id selector;
- no selector belonging to the desktop shell (`.game-`, `.world-`, `.tabs`, `.card`, `.sidebar`,
  `.movement`, `.welcome`);
- no `:hover` selector and no bare `:focus` (only `:focus-visible`);
- the only `!important` declarations are the reduced-motion suppression;
- the main stylesheets do not reference `game-mobile.css` at all, so the layer cannot be switched on
  by accident.

The class names are also cross-checked against the module: `game-mobile.css` may only style classes
`src/ui/touch-controls.js` renders (plus the two documented placement classes the owner adds). A
renamed class in either file fails the suite, so the two cannot drift apart.

### 3.1 Classes

| Class | Set by | Purpose |
|---|---|---|
| `nm-touch` | module | the container; static and full-width by default |
| `nm-touch-floating` | owner | adds `position:absolute; left:0; right:0; bottom:0` for a bar over the canvas |
| `nm-touch-always` | owner | keeps the layer visible on a wide fine-pointer screen |
| `nm-touch-pad`, `nm-touch-camera`, `nm-touch-actions` | module | the three named groups |
| `nm-touch-key`, `nm-touch-up/left/down/right` | module | the movement keys and their grid placement |
| `nm-touch-action`, `nm-touch-look`, `nm-touch-interact/build/chat/tools` | module | the affordances |
| `nm-touch-status` | module | the polite live region |
| `nm-touch-reduced` | module | suppresses transitions when `prefers-reduced-motion` is on |

The container is `pointer-events:none` and the controls re-enable it for themselves, so the world
keeps its own gestures in the gaps between the buttons.

---

## 4. Measured accessibility numbers

All of these are recomputed from `game-mobile.css` by `tests/mobile-styles.test.js` on every run and
printed as `measured targets…`, `measured contrast…` and `measured layout…`. They are not restated
from this document anywhere in the code.

### 4.1 Touch targets

| Control | Declared minimum | Measured |
|---|---|---|
| Pad key | `min-width`/`min-height` 44 px, raised to 52 px on a coarse pointer | **44 px** base, **52 px** coarse |
| Pad grid column / row | `minmax(44px,52px)`, raised to `minmax(48px,56px)` on a coarse pointer | **48 px** coarse minimum |
| Affordance (`Use`, `Build`, `Chat`, `More`) | `min-width` 44 px, `min-height` 44 px → 48 px coarse | **44 px** wide, **48 px** tall coarse |
| Camera (`Look left`, `Look right`) | `min-width` 76 px, `min-height` 44 px → 48 px coarse | **76 × 44 px** |

Every value is at or above the project's 44-pixel convention, and the raise is keyed on
`@media(pointer:coarse)`, which applies at **every** width — so a wide tablet and a phone in landscape
are covered, not only a narrow window.

### 4.2 Contrast

| Pair | Measured | Threshold |
|---|---|---|
| Pad key label (`#f6f0d8` on `#0a2b25`) | **13.26:1** | 4.5:1 |
| Affordance label | **13.26:1** | 4.5:1 |
| Pressed key label (`#133429` on `#e5dea8`) | **9.89:1** | 4.5:1 |
| Disabled key label (`#c4d5c4` on `#0a2b25`) | **9.86:1** | 4.5:1 |
| Live-region status text (`#edf0dc` on `#092a24`) | **13.23:1** | 4.5:1 |
| Focus ring (`#ded6a5`) on a key | **10.3:1** | 3:1 (non-text) |
| Focus ring on the world (`#071b19`) | **12.09:1** | 3:1 (non-text) |
| Key edge on the world | **3.48:1** | 3:1 (non-text) |

The lowest text ratio in this stylesheet is 9.86:1. Task 13's lowest measured text pair anywhere in
the application is the aim line at **4.82:1**; nothing here regresses that, because this layer adds no
rule to an existing surface — it only adds controls whose own pairs are measured above.

The disabled state deliberately declares `opacity:1` and its own legible colour. `nemo-theme.css`
already fades every disabled button (`button:disabled{opacity:.45}`), which would drop this pair to
about 6.4:1 against the dark key; the stylesheet does not rely on the shell's fade.

### 4.3 No horizontal scrolling

| Check | Measured |
|---|---|
| Any `width`/`min-width`/`max-width`/logical equivalent declared in px | **none exceeds 320 px** (the widest is the 76 px camera button) |
| Container | `width:100%`, `max-width:100%`, `box-sizing:border-box` |
| Widest unflexible row — the 3-column pad | 3 × 48 px columns + 2 × 6 px gaps = **156 px**, + **12 px** container padding = **168 px** of a 320 px viewport |
| Camera and action rows | `flex-wrap:wrap`, so they wrap instead of overflowing |
| Widest single control | 76 px + 12 px padding = **88 px** of 320 px |
| `overflow-x: scroll/auto/hidden`, `white-space: nowrap` | **none declared** |

Nothing in the layer can force a page wider than the screen it is drawn on.

### 4.4 The acceptance claim, item by item

> **Core play and observation work without hover, tiny controls or horizontal scrolling.**

| Part of the claim | Evidence | Where it is measured |
|---|---|---|
| Core **play** — movement, camera, interaction, building | the pad sends `walk`, the drag and the Look buttons send `look`, `Use` sends `interact` only when `hasFixture()` is true, `Build` sends `build` and relabels to `Finish` while building | `tests/touch-controls.test.js` |
| Core **observation** — a visitor with no resident | `canWalk()` is the owner's, and returns true for a visitor in an unpaused world; `interact` stays disabled without a fixture; the status text says it is observing; a tap on the surface calls `pick` | the wiring recipe in §5 step 3, plus the model test |
| **Without hover** | the stylesheet declares no `:hover` selector at all (the only `hover` token is the `hover:hover` device feature in the wide-screen gate), and the module binds no mouse or hover listener | `tests/mobile-styles.test.js`, `tests/touch-controls.test.js` |
| **Without tiny controls** | every control is at or above 44 px; 48–52 px on a coarse pointer, at every width; the focus ring is 10.3:1 on a key | §4.1 |
| **Without horizontal scrolling** | no declared width above 320 px; the widest unflexible row measures 168 px of a 320 px viewport; the other rows wrap; nothing is clipped or scrolled sideways | §4.3 |
| **Keyboard navigation preserved** | the module binds no `keydown`/`keyup`/`focus` listener, so the shipped world key map, the dialogs and the drawers are untouched; controls are native buttons, so Tab and Enter/Space still reach and activate them; a keyboard activation steps exactly once while a pointer press does not double-fire through its own click | `tests/touch-controls.test.js` |
| **Contrast preserved** | the layer adds controls with pairs of 9.86:1 and above and changes no existing rule, so task 13's measured minimum (the aim line at 4.82:1) cannot be lowered by this task | §4.2 |

---

## 5. Wiring steps for the integration owner (task 38)

Four edits, all in files this task does not own.

**1. Load the stylesheet** — in `index.html`, after `game-theme.css`:

```html
<link rel="stylesheet" href="/game-mobile.css">
```

**2. Import the module** — in `app.js`:

```js
import { createTouchControls, hasCoarsePointer, prefersReducedMotion } from './src/ui/touch-controls.js';
```

**3. Mount it from the world view**, after the canvas exists and before `render()` finishes. The
following is a complete recipe, not a sketch: the deltas, the disabled states and the re-render
lifecycle are all handled.

```js
let touchControls = null;
function touchStatusText(world, agent) {
  if (!agent) return 'Observing. Drag the world to look; the Look buttons turn it one step at a time.';
  if (state.world.paused) return 'The world is paused. Movement and interaction are refused by the server.';
  if (state.building) return 'Building. Choose a block and tap the ground to place it.';
  return 'Press a direction to walk one tile, and hold it to keep walking. Drag the world to look.';
}
function mountTouchControls(map, canvas, world, agent) {
  touchControls?.destroy();
  touchControls = null;
  // The desktop interface is unchanged on a wide fine-pointer screen; the stylesheet also hides the
  // layer there unless it carries nm-touch-always.
  if (!state.gamePresentation) return;
  if (!hasCoarsePointer(window.matchMedia) && !window.matchMedia('(max-width: 900px)').matches) return;
  touchControls = createTouchControls({
    document,
    mount: map,
    surface: canvas,
    input: {
      walk: (direction) => controlStep(direction),
      // queueLook takes an absolute facing, so the *relative* rotation the drag reports is added here.
      look: ({ yaw, pitch }) => queueLook(state.facing.yaw + yaw, state.facing.pitch + pitch),
      interact: () => guarded(() => usePickedFixture()),
      // The HUD's own Build control already routes by the kind of world; reuse it rather than
      // restating that rule. Give it an id in gameHud(): `build.id = 'game-build-button';`
      build: () => document.querySelector('#game-build-button')?.click(),
      affordance: (name) => setGameDrawer(name === 'chat' ? 'chat' : 'tools'),
    },
    // A visitor has no resident, and the shipped movement controls stay usable for them because a
    // step with no agent pans the view instead of walking. So an unpaused world is walkable whether
    // or not someone is acting in it.
    canWalk: () => {
      const acting = viewedAgent();
      if (state.world.paused) return false;
      return acting ? acting.status === 'active' : true;
    },
    hasFixture: () => Boolean(state.interaction?.fixture),
    isBuilding: () => Boolean(state.building),
    status: () => touchStatusText(world, agent),
    reducedMotion: () => prefersReducedMotion(window.matchMedia),
  });
}
```

Call `mountTouchControls(map, canvas, world, agent)` from `renderWorld()` immediately after
`paintWorld()`, and call `touchControls?.refresh()` from `syncWorldControls()` so the pad's disabled
state and the live-region text follow the world on every three-second refresh and every delta frame.
`renderView()` already tears the world down, so add `touchControls?.destroy()` beside the existing
`voxelView.destroy()` there.

**4. Placement.** Two supported placements, both scoped:

- *Flow* (simplest, works in the pixel-map fallback too): mount into the world panel, and the
  container lays itself out full-width and wrapping.
- *Floating over the canvas*: mount into the world panel or the `.game-hud` and add the
  `nm-touch-floating` class, which absolutely positions the bar along the bottom. The container is
  `pointer-events:none` and the buttons re-enable it, so the world's own drag still reaches the
  canvas through the gaps.

Do not add `nm-touch` rules to any other stylesheet, and do not import `src/camera-controls.js` or
`src/game-input.js` into `src/ui/touch-controls.js`: the injected interface above is the whole
coupling, which is what keeps this layer compatible with the four parallel tasks that own those files.

---

## 6. Migration and rollback

- **No schema change.** The database stays at version **21**; no table, column, trigger or migration
  is added or touched. There is nothing to migrate.
- **No new dependency.** `package.json` and `package-lock.json` are unchanged; no npm install is
  needed. `scripts/browser-suite.mjs`, `scripts/e2e-smoke.mjs` and `.github/` are unchanged.
- **No data, no state.** The module writes no storage and sends no request of its own; every intent
  goes through an existing `app.js` path, so no new server contract exists to roll back.
- **Rollback.** `game-mobile.css` and `src/ui/touch-controls.js` are inert until the two lines in §5
  step 1 and step 2 are added. To roll the feature back, delete the `<link>` tag and the import (and
  the `mountTouchControls` call); to roll the branch back, delete the six new files — the two sources
  (`src/ui/touch-controls.js`, `game-mobile.css`), the two tests (`tests/touch-controls.test.js`,
  `tests/mobile-styles.test.js`) and the two documents (`docs/MOBILE_ACCESSIBILITY.md`,
  `docs/handoff/task-37-mobile-accessibility.md`) — then run `git diff --stat` against `d07814d` and
  expect an empty tree. No other file in this branch references them.
- **Partial rollout.** The stylesheet hides the layer on a wide fine-pointer screen by itself, so
  shipping both files and both wiring lines exposes the controls on small screens and touch devices
  only. Passing `nm-touch-always` is the explicit opt-in for everything else.

---

## 7. Limitations, stated plainly

1. **Nothing renders this today.** The controls exist as a module and a stylesheet; no screen in this
   branch shows them, because `app.js` and `index.html` belong to task 38. "Usable movement, camera,
   interaction and building controls on smaller screens" is therefore delivered as *the module, the
   scoped stylesheet and a verified wiring recipe*, not as an observed screen.
2. **No browser check.** No box was measured in a browser. The target sizes and the layout arithmetic
   are read from the stylesheet's own declarations; the module's gesture behaviour is proven against a
   stub document and an injected clock. Real pointer capture, real `touch-action` behaviour and the
   browser's own `click`-after-touch `detail` value are not observable here.
3. **The cascade reader is a simplification**, exactly as in task 13: selectors are matched verbatim,
   specificity is ignored, and declarations inside a media query are read as if the query applied. It
   is the strictest reading for target sizes and colours, but a higher-specificity rule elsewhere
   could in principle win without failing these tests.
4. **The desktop shell is out of scope.** The quickbar's horizontal scroll, the hidden `calling-hud`,
   the `E to interact` wording defect in the HUD hint and the minimap's size on small screens are all
   recorded in [the game experience specification](GAME_EXPERIENCE.md) and belong to task 38.
5. **The 44-pixel floor is a stylesheet declaration, not a rendered box.** A very long translated
   label could exceed the minimum; the module's labels are short and fixed, and the rows wrap.
6. **The layer is not a substitute for the keyboard path.** It is additive: the shipped WASD / arrow /
   Q E R F / Enter Space I map, the typed `Walk to a tile` form and the pixel-map fallback all remain,
   and this module deliberately binds no key event so it cannot shadow them.

## 8. Residual risks

- **The `look` contract is the one place a wiring mistake is silent.** `look` receives a *relative*
  rotation; mapping it to a function that expects an absolute facing turns the camera wrongly instead
  of failing. §5 step 3 shows the addition explicitly and `tests/touch-controls.test.js` pins the sign
  convention (`Look right` decreases yaw).
- **The drag surface is shared with the voxel renderer.** The module sets `touch-action:none` on the
  surface it is handed and restores it on `destroy()`. The shipped `.voxel-canvas` already declares
  `touch-action:none` in `style.css`, so in practice nothing changes — but the owner should confirm the
  renderer's own orbit drag still works after attaching, since both listen on the same element.
- **Hybrid devices.** `(pointer:fine)` describes the *primary* pointer, so a laptop with both a mouse
  and a touchscreen hides the layer by default. `nm-touch-always` is the documented escape.
- **Two-finger play depends on distinct `pointerId`s**, which every current browser supplies; a
  browser that reuses one id for a second finger would let the drag and the pad fight. The module
  prefers the primary pointer and refuses a second drag owner, so the failure mode is a camera that
  does not turn, never a walk in the wrong direction.
- **Zoom and very large text.** The width arithmetic assumes a 320 CSS-pixel viewport. A user at 200 %
  zoom on a 390-pixel phone has ~195 CSS pixels, where the pad's 156 px still fits but the camera row
  wraps to two rows; nothing overflows, but the layout is untested at that width (see §7.2).

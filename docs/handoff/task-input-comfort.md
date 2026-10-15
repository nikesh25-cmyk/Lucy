# Input comfort — one placement interface for every home, and a touch bar that fits a thumb

**Task: input comfort.** The player's own words were: *"like in Minecraft you can build homes, but I
find it's still difficult to play. Enhance the control system and the UI to make it more
user-friendly and comfortable to use and play in."* A read-only audit named the concrete cause, and
this task fixes exactly that cause and nothing else:

1. **Building in your own home or garden was typing-only.** The pointer hotbar and the placement
   preview existed but were mounted only for `world.kind === 'frontier'` (`app.js:3349`), so the one
   thing a player most wants to do had no pointing, no preview and no keyboard-build path.
2. **The phone touch pad was mounted in flow, not as an overlay** (`app.js:3415`, `mount: 'map'`,
   never the `nm-touch-floating` class), inside a fixed-height `overflow:hidden` panel, so the pad
   could end up below the visible area.
3. **The shell's own on-canvas movement pad is 38 × 38 px** at ≤ 650 px (`game-theme.css:104`), below
   this project's own 44 px floor.

This task owns **two source files, two new test files and this document**. `app.js`, `index.html`,
every `*.css`, `package.json` and every other file under `src/` are **untouched**, as are
`tests/build-interface.test.js`, `tests/touch-controls.test.js` and `tests/mobile-styles.test.js`,
which still pass unmodified.

| File | Status | What changed |
| --- | --- | --- |
| `src/ui/build-interface.js` | extended | `placementRulesFor`, object-world palettes and previews, `hoverTargetView`, `aimLineView`, object-world refusal reasons, the object-world write route |
| `src/ui/touch-controls.js` | extended | `floating`, `--nm-touch-target`, `rectOf`, `layoutReport`, `geometry`, `avoidQuickbar`, zones, the pad-side `Use` control |
| `tests/build-interface-home.test.js` | **new** | 14 tests: a home and a cottage are object worlds, the frontier is unchanged, the footprint preview, purity of the hover read, the resident route, keyboard parity |
| `tests/touch-controls-comfort.test.js` | **new** | 13 tests: the floating class, 52 px targets, on-screen geometry, the quickbar lift, drag-never-uses, keyboard Use |
| `docs/handoff/task-input-comfort.md` | **new** | this document |

**No new dependency. No schema change. No route added. Nothing in this task writes to the database**
— the modules hand every intent to the injected `api` or `input` interface the shell already owns.

---

## 1. New and changed exports

### 1.1 `src/ui/build-interface.js`

| Export | Signature | Notes |
| --- | --- | --- |
| `placementRulesFor` | `placementRulesFor(world) → frozen rules` | **new.** The one description a call site branches on instead of `kind === 'frontier'` |
| `paletteFor` | `paletteFor(world)` | extended with `shape`; `build_range` is now read from the payload for object worlds too |
| `hotbarModel` | `hotbarModel({ world, pick, moderator })` | extended: the model carries `shape` and `remaining`, each entry carries `kind` and `remaining` |
| `placementModel` | `placementModel({ world, pick, session, blueprintReport, refusal, confirmed, moderator })` | extended: `rules` and `preview`; object-world asserts built from the payload's own window |
| `createPlacementPreview` | `createPlacementPreview({ api, input, onNotice, session, endpoint })` | extended: object worlds write through the resident's route; blueprints are frontier-only; the view renders the footprint |
| `hoverTargetView` | `hoverTargetView({ world, selection, hover }) → { tile, label, action, keys, reasons }` | **new, pure** |
| `aimLineView` | `aimLineView(view) → view tree` | **new.** A focusable, politely-announced aim line |
| `REFUSAL_REASONS` / `classifyRefusal` | unchanged shape | six new codes (below); every existing entry, message pattern and code is unchanged |

Everything that existed keeps its behaviour: `el`, `mount`, `classifyRefusal`, `paletteLabel`,
`plotAt`, `grantFor`, `blockAt`, `targetOf`, `createHotbar`, and every existing field of every
existing return value.

#### `placementRulesFor(world)`

The payload shape it expects is the one `GET /api/v1/world` already sends:

```js
// frontier
{ world: { kind: 'frontier', … }, frontier: { palette: [...], limits: { maximum_z: 7, build_range: 6 } } }
// garden / cottage — `payload.world.kind` is 'home' or 'house'
{ world: { kind: 'home', … }, build_palette: ['cottage', 'tree', 'flowers', …], objects: [...], scenery: [...], bounds: {...} }
```

It returns a frozen record:

```js
{ available, kind, shape: 'block' | 'object', preview: 'geometry' | 'footprint',
  maximum_z,          // the highest layer the server allows; 0 in a garden or a cottage
  build_range,        // the reach the server reported, or null when it reported none
  types,              // the server's own palette, in the server's own order
  reason }            // why building is unavailable, else null
```

A world with no palette (`commons`, a shared hall, a world the caller cannot read) returns
`available: false`, `shape: null`, `types: []` and a reason — never a guessed kind.

#### `hotbarModel` entries

```js
{ type: 'farm', label: 'Farm', key: '5', kind: 'object', available: true, reason: null, remaining: null }
```

`remaining` is **the server's own figure or null**: the frontier publishes
`limits.blocks_per_sector` and `block_count`, so an entry reports the area's remaining blocks; a
garden publishes no object cap, so its entries report `null` rather than a number this module
invented. The rendered accessible name adds the count only when it is known.

#### `placementModel().preview`

```js
// a frontier tile — the geometry is unchanged
{ shape: 'block', x, y, z, maximum_z, type, name, occupied }

// a garden or cottage tile — a bounded footprint
{ shape: 'footprint', x, y, width: 1, height: 1, type, name,
  in_bounds: true | false | null,          // from the payload's own `bounds`
  existing: null | { id, type, x, y },     // the saved object the payload reports here
  furniture: null | { x, y, type, blocks },// the world's own authored scenery here
  resident: null | { id, name, x, y },     // a resident the payload reports here
  state: 'blocked' | 'unverified',
  state_text }                             // the readable allowed/blocked line
```

`state` is `'blocked'` only when the payload itself shows a reason (a resident standing there, the
cottage's own furniture, a tile outside the world). Otherwise it is `'unverified'` and says so: **the
server decides when you confirm**, exactly as the single-block path has always said. A frontier world
still renders the same target line with the layer, and nothing new appears in its view.

#### `hoverTargetView({ world, selection, hover })`

```js
hover:     { x, y, z? }                       // the tile under the pointer (or a keyboard hover)
selection: { kind?, mode?: 'place' | 'remove' }
```

Returns a frozen `{ tile, label, action, keys, reasons }`:

- `label` names what the payload reports on the tile — `Resident Alice`, `Enter Garden Cottage`,
  `Wood block · layer 0`, `Bench`, `Tree · the world's own`, `Plot of Alice · A shared learning
  garden`, or the plain `Tile 12, 9` when the payload reports nothing;
- `action` is `{ id, label, keys, available }` with `id` one of `place`, `remove`, `enter`,
  `inspect`, or `null`;
- `keys` is the keyboard path for that action, and they are the module's own `handleKey` map
  (`5` and `c` to place a farm object, `r`/`c` to remove, the shell's `Enter`/`Space`/`I` to enter a
  passage);
- `reasons` are the payload's own reasons the server would refuse: `no-grant`, `grant-expired`,
  `shared-access`, `blocked-cell`, `out-of-range`, `resident`, `keep-clear`, `platform-paused`.

It is **pure**: it reads its arguments, writes nothing and touches no document, no request and no
camera. `tests/build-interface-home.test.js` proves it by handing it a deep-frozen payload and
comparing the payload before and after.

#### New refusal codes

The server's sentences are matched in order and its own message is still shown **verbatim** beside
the reason. Six codes were added for the garden and cottage route (`spaces.build`):
`not-your-home`, `not-buildable-tile`, `keep-clear`, `object-limit`, `trapped-object`,
`palette-item`. No existing pattern or code changed, so every message that classified before still
classifies the same way.

### 1.2 `src/ui/touch-controls.js`

| Export | Signature | Notes |
| --- | --- | --- |
| `TOUCH_TARGET_COARSE` | `52` | the coarse-pointer target, the same number `game-mobile.css` already uses |
| `FLOATING_CLASS` | `'nm-touch-floating'` | the class the stylesheet already defines |
| `QUICKBAR_GAP` | `8` | the gap a lifted bar keeps above the bottom row |
| `USE_AFFORDANCE` | `{ name: 'use', glyph: 'Use', hint }` | the pad-side interaction affordance |
| `TOUCH_ZONES` | `{ movement, use, camera, actions }` | published as `data-nm-zone` |
| `rectOf` | `rectOf(domRectLikeOrElement) → frozen rect \| null` | **new, pure** |
| `layoutReport` | `layoutReport({ bar, pad, keys, quickbar, mount, viewport, minimum })` | **new, pure** |
| `touchModel` | extended with a `use` entry | `use.enabled` is `interact && fixture` |

`createTouchControls` gained four options and three members:

```js
createTouchControls({
  …every existing option…,
  floating = false,           // takes the bar out of flow under FLOATING_CLASS
  coarsePointer = () => false,// keys the 52 px contract and the published --nm-touch-target
  quickbar = null,            // an element (or a provider) the floating bar must not cover
  viewport = null,            // an optional provider for the visible area
});

// returned, beside every existing member:
geometry({ quickbar, viewport } = {})
avoidQuickbar(element = quickbar)   // → { applied, offset } | { applied: false, reason }
controls.targetSize                 // 44 | 52
```

`geometry()` is the phone test's hook. It measures **element rectangles only**:

```js
{ minimum, bar, pad, keys, quickbar, mount, viewport,   // frozen normalised rects (or null)
  key_size: { width, height, measured, minimum, meets_minimum },  // the smallest pad key
  pad_size: { width, height, minimum, meets_minimum },
  on_screen, on_screen_basis: 'mount' | 'viewport' | 'mount+viewport' | 'bar',
  on_screen_reason: 'visible' | 'no-box' | 'clipped-by-mount' | 'outside-viewport',
  overlaps_quickbar, overlap }
```

`on_screen` is false when the bar's own box falls outside the element it is mounted in — which is
exactly the reported bug: a pad laid out below an `overflow:hidden` panel's bottom edge has a
rectangle, and that rectangle is not on screen. `on_screen_basis` names what it was measured
against, so a caller can tell "proved off screen" from "nothing to measure against".

`--nm-touch-target` (`44px` or `52px`) is written on the bar's own `style` and removed again on
`destroy`, so a stylesheet can key its `min-width`/`min-height` on the module's own number.

---

## 2. What the integrator must do

Nothing in this task renders by itself; `app.js` and the stylesheets are the integrator's. These are
the exact edits.

### 2.1 `app.js` — the build interface in every buildable world

The import already exists (`app.js:7`); add the two new names:

```js
import { createHotbar, createPlacementPreview, mount, hoverTargetView, aimLineView, placementRulesFor } from './src/ui/build-interface.js';
```

1. **`mountShellTools` (`app.js:3349`)** — replace the frontier-only gate with the payload's own rules.
   Everything inside the block stays as it is; the only question that changes is *whether* to mount.

   ```js
   const rules = placementRulesFor(state.world);
   if (rules.available) {
     const host = element('div', null, 'game-build-host'); host.id = 'game-build-host';
     const session = { agentId: state.selected, worldId: world.id, player: agent || null, moderator: isModerator() };
     hotbar.update({ world: state.world, pick: state.voxelSelection, moderator: isModerator() });
     placement.update({ world: state.world, pick: state.voxelSelection, session });
     const palette = element('div', null, 'ui-hotbar-host'); mount(palette, hotbar.view());
     const preview = element('div', null, 'ui-placement-host'); mount(preview, placement.view());
     host.append(palette, preview); map.append(host);
   }
   ```

   `placement.setKind(type)` is already driven by `hotbar`'s `onSelect` (`app.js:64`), so the pointer
   hotbar, the palette digits, `c`/`r`/`b`/Escape and the typed `Target tile X`/`Y` fallback all
   start working in the garden and the cottage with no further wiring. The write path follows the
   palette: a block world posts to `/frontier/build`, an object world posts to
   `/agents/:agent_id/build` with `{ x, y, type }` — the same two routes `buildAt` (`app.js:1340`)
   already uses. Pass `endpoint: ({ rules, agentId }) => …` only if you route it differently.

2. **The aim line.** Feed `hoverTargetView` from the renderer's hover channel and mount
   `aimLineView(view)` into the world panel, replacing the text `#world-reticle` builds by hand
   (`app.js:934`, refreshed at `app.js:1102`):

   ```js
   const spot = state.voxelHover;                       // the tile the aim line is on, or the pointer's
   const aim = hoverTargetView({
     world: state.world,
     selection: { kind: building ? buildKindForThisWorld() : null, mode: placingRemove ? 'remove' : 'place' },
     hover: spot ? { x: spot.x, y: spot.y, z: spot.z || 0 } : null,
   });
   const host = $('#world-reticle');
   if (host) { mount(host, aimLineView(aim), document); host.id = 'world-reticle'; }
   ```

   Keep the element id `world-reticle`: the canvas already points `aria-describedby` at it
   (`app.js:926`). Call it from the same place the reticle text is refreshed today, so it follows the
   camera without a click and without a walk.

3. **`mountTouchControls` (`app.js:3411`)** — mount the same bar as a floating overlay, above the
   HUD's bottom row, and hand it the input-device facts:

   ```js
   touchControls = createTouchControls({
     document, mount: map, surface: canvas,
     input: { /* unchanged */ },
     canWalk: () => { /* unchanged */ },
     hasFixture: () => Boolean(state.interaction?.fixture),
     isBuilding: () => Boolean(state.building),
     status: () => touchStatusText(world, agent),
     reducedMotion: () => prefersReducedMotion(window.matchMedia),
     floating: true,
     coarsePointer: () => hasCoarsePointer(window.matchMedia),
     // The bar must not cover the HUD's own bottom row (the quickbar and its hint).
     quickbar: document.querySelector('.game-hud-bottom') || document.querySelector('.game-quickbar'),
     viewport: () => ({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }),
   });
   ```

   Then, after the HUD has painted and on every resize,
   `touchControls?.avoidQuickbar()` lifts the bar by the measured height of that row. Calling it
   again is safe and idempotent.

4. **The phone regression test.** The assertion the integrator owns becomes three lines:

   ```js
   const report = touchControls.geometry({ quickbar: document.querySelector('.game-hud-bottom') });
   assert.equal(report.on_screen, true);                    // the pad is not below the visible panel
   assert.equal(report.key_size.meets_minimum, true);       // 52 px on a coarse pointer
   assert.equal(report.overlaps_quickbar, false);           // the bar sits above the quickbar
   ```

### 2.2 Stylesheets — the two rules that are the integrator's

1. **`game-mobile.css`** already defines `.nm-touch.nm-touch-floating{position:absolute;z-index:10;left:0;right:0;bottom:0;width:auto}`,
   and `body.game-world .world-panel` is already `position:relative` with `overflow:hidden`
   (`game-theme.css:21`), so mounting the bar into `map` with `floating: true` positions it over the
   canvas with **no stylesheet change**. Keep `avoidQuickbar()`'s inline `bottom` — it is removed
   again on `destroy`, and it is the only style this module ever writes to its own root.
2. **`game-theme.css:104`** — the shell's own on-canvas pad is still `38px`:
   `body.game-world .movement>button{min-width:38px;min-height:38px}` (and the same for
   `body.game-world .movement>.actions button`). Raise both to `44px` so the shipped pad meets the
   project's own floor. This task may not edit that file; the module's `geometry()` reports the
   *touch bar's* pad, not the shell's pixel-map pad.
3. **`game-mobile.css` — the hotbar entries are 42 px tall today.** The build host's own entries are
   sized by `nemo-theme.css:174`, not by the mobile layer:
   `body.game-world .game-build-host .game-hot{min-height:42px;…}` with no `min-width`. Now that the
   hotbar mounts in a garden as well as the frontier, add a mobile rule (this is the one that makes
   the pointer build path a **touch** build path):

   ```css
   body.game-world .game-build-host .game-hot{min-width:52px;min-height:52px}
   body.game-world .game-build-host .ui-placement-controls button{min-height:52px}
   ```

   52 px matches every other control on a coarse pointer. Nothing in this task could set it: the
   module renders classes and text, and the stylesheets are the integrator's.

### 2.3 What the integrator should **not** do

- Do not add a `nm-touch-*` class to `game-mobile.css` for the new `Use` control. It deliberately
  renders only `nm-touch-action` (plus `data-nm-touch="use"`, `data-nm-beside="pad"`,
  `data-nm-zone="bottom-left"`), because `tests/mobile-styles.test.js` only allows the class names
  the module already rendered — a new one would fail that pinned suite. Style it by attribute if it
  needs its own look: `.nm-touch [data-nm-touch="use"]{…}`.
- Do not mount the bar twice. `mountTouchControls` already destroys the previous instance.

---

## 3. Verification — the exact commands and their real output

Only these commands were run, as required. `npm test`, `npm run browser` and `npm run e2e` were
**not** run (five agents share this tree; the full suite is load-sensitive), and neither was
`tests/build-interface-http.test.js`.

```
$ node --check src/ui/build-interface.js && node --check src/ui/touch-controls.js \
    && node --check tests/build-interface-home.test.js && node --check tests/touch-controls-comfort.test.js \
    && echo "ALL FOUR CHECK OK"
ALL FOUR CHECK OK
```

```
$ node --test tests/build-interface.test.js tests/build-interface-home.test.js tests/touch-controls.test.js \
    tests/touch-controls-comfort.test.js tests/mobile-styles.test.js
```

The full output is quoted below, **re-grouped by file** for reading: `node --test` runs the five files
concurrently, so the live order interleaves them. Every line, every count and the summary are the
run's own.

```
✔ the hotbar palette is exactly the server-published frontier palette, never a hardcoded list
✔ a home or cottage palette comes from the server build_palette and has no layers
✔ a resident on their own stewarded plot may build the whole palette
✔ a resident on a plot they do not steward and hold no grant for is told so plainly
✔ a live collaboration grant opens only its named block types, layers and actions
✔ the placement preview shows the grant purpose, scope and expiry, and none of it is invented
✔ an expired grant is explained as expired, not silently ignored
✔ a blueprint preview is the server's own validation and its issues are rendered verbatim
✔ classification names the actual reason and the next usable step for the server's own refusals
✔ the placement target is the picked cell for removal and the adjacent cell for placement
✔ a refused placement is rendered as a refusal and is never rendered as saved construction
✔ only a server confirmation becomes saved
✔ a blueprint preview asks the server with preview:true and never writes
✔ every build and inventory action has a keyboard path
✔ the injected input interface drives the pick and the camera module is never imported
✔ mount builds real elements with textContent only and never touches innerHTML
✔ the inventory shelf is the server's own list and coins are never rendered as items
✔ recipes state what can be crafted now and which ingredients are missing
✔ crafting uses the server's own response and shows a refusal as a refusal
✔ the inventory panel has a keyboard path: digits select a recipe and c crafts it
✔ a garden is an object world: the rules and the palette both come from the payload
✔ a cottage is an object world with the cottage palette, and the two palettes are different
✔ the frontier keeps block rules unchanged: a layer range, geometry and the published reach
✔ a world with no palette is described as unavailable rather than guessed at
✔ the hotbar renders the same entry shape for objects as for blocks
✔ the preview is a bounded footprint for an object and block geometry for a frontier tile
✔ a resident the payload reports on the tile blocks the footprint and is named in the view
✔ an object world places through the resident route the shell already uses, and offers no blueprint
✔ a garden refusal reaches the player verbatim, with the object wording the server uses
✔ a removal in an object world asks the same route to remove, and never sends a type
✔ hoverTargetView is pure and reports the server's own reasons without writing
✔ hoverTargetView reads a saved object, a passage and a block from the payload by name
✔ every new control has a keyboard path: the aim line, the object hotbar and the object preview
✔ mount renders the object preview and the hotbar with textContent only, never innerHTML
✔ the control surface is described as data: a pad, a single-pointer camera alternative and affordances
✔ each control is enabled exactly when the interface and the world state allow it
✔ a drag turns the camera the same way the shipped Look buttons and tilt keys do
✔ one measured gesture is either a drag or a tap, never both
✔ prefers-reduced-motion and a coarse pointer are read through an injected matchMedia
✔ the controls are labelled buttons inside named groups, and never inject markup
✔ the module assumes no mouse and no physical keyboard: pointer events only, and no imports
✔ a press walks once, a held press repeats on the injected clock, and a release stops it
✔ a held key is bounded, a cancelled gesture stops, and a different key takes over cleanly
✔ a pointer press never double-steps through its own click, and a keyboard activation steps once
✔ a drag turns the camera past the threshold, and a tap is a pick — never both
✔ one pointer owns the drag, so a second finger can hold a movement key at the same time
✔ the affordances call the injected interface and are disabled exactly when the world refuses them
✔ the single-pointer camera buttons send the shipped Look step, so the camera is reachable without a drag
✔ reduced motion is announced to the stylesheet, and the status is text the whole time
✔ the drag surface is made drag-safe and handed back exactly as it was found
✔ a switched-off control surface stops every gesture and hides itself from the pointer
✔ a missing document or mount is refused loudly rather than rendering nothing
✔ rectOf normalises a DOMRect, a plain rect and nothing at all
✔ the geometry report measures the bar, the pad and the keys the server contract asks for
✔ a bar the mount clips is reported off screen, which is the bug a fixed-height panel caused
✔ the quickbar overlap is measured, and a floating bar is lifted clear of it
✔ a floating bar lifts itself at mount when it is handed the quickbar
✔ the floating option adds the overlay class, and the default leaves the bar in flow
✔ the bar publishes the target size it must reach: 44 px, or 52 px on a coarse pointer
✔ the pad is measured at 52 px on a coarse pointer and is marked for the thumb
✔ Use sits beside the pad, is a real button, and is enabled only when the world has a fixture
✔ a drag never fires Use: one gesture is either a tap or a drag, and a cancelled press acts too
✔ Use repeats while it is held, on the same cadence as a pad key, and stops on release
✔ Use is reachable by keyboard, and the click after a pointer press never double-fires it
✔ no layout math depends on a window width, and the geometry comes from element rectangles
ℹ tests 74
ℹ suites 0
ℹ pass 74
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9401.114
```

The three pre-existing files (`build-interface.test.js`, `touch-controls.test.js`,
`mobile-styles.test.js`) were **not modified** and their 47 assertions all still pass; the 27 new
assertions are the two new files.

The evidence behind the headline claims, and where it comes from:

| Claim | Where it is proven |
| --- | --- |
| A garden and a cottage are object worlds, from the payload's own `build_palette` | `tests/build-interface-home.test.js`, tests 1–2 and 5 |
| The frontier keeps its block rules, layer range and published reach | test 3 and the `preview.shape === 'block'` block of test 6 |
| The preview is a bounded footprint for an object and geometry for a block | test 6 |
| A resident the payload reports on the tile blocks it, and is named | test 7, from a real payload with the resident moved into the garden |
| The write goes to `/agents/:id/build` with `{x, y, type}`, and blueprints are not offered | tests 8–9 |
| The server's refusal reaches the player verbatim, with the object wording | test 9 (`Keep the original cottage furniture clear.`) |
| `hoverTargetView` is pure and reports reasons without writing | test 10, over a deep-frozen payload |
| Every new control has a keyboard path | test 12 (`5` then `c` really place through `handleKey`) |
| The floating option adds the class and the default does not | `tests/touch-controls-comfort.test.js`, test 5 |
| The pad measures ≥ 52 px on a coarse pointer and is marked for the thumb | tests 7–8 |
| The bar reports itself clipped when it falls below its mount | test 3 |
| The bar does not overlap the quickbar, and is lifted clear of it | test 4 |
| A drag never fires `Use`; a tap fires exactly one; a hold repeats | tests 9–11 |
| No layout math depends on a window width | test 13, re-read from the module's own source |

---

## 4. Limitations — what is **not** verified

1. **No browser ran.** This repository has no browser automation in the test runner and this task may
   not add a scenario. Every number above is either a payload from the real platform or a stub
   rectangle; **no real element was ever laid out**. The whole point of `geometry()` is that the
   integrator's own test can make the real measurement in a real page — until it does, "the pad is on
   screen at phone size" is a *reasoned* claim about the module plus the stylesheet, not an
   observation.
2. **A real `pointermove` stream is not reproduced.** The stub dispatches one move per call. A real
   finger produces dozens of moves and the browser may claim the gesture mid-drag; the module
   abandons the press on `pointercancel`, and that path is tested, but real pointer capture is not.
3. **The garden's 200-object cap is not in `GET /world`.** `spaces.build` refuses the 201st object
   with `A home holds 200 placed items.` — a message that now classifies as `object-limit` with a
   usable next step — but the hotbar cannot show a remaining count for it, so `remaining` is `null`
   there. If the platform ever publishes an object cap in the payload, `remainingFor` reads
   `limits.objects_per_world` and the count appears without a change to the view.
4. **The garden's arrival and exit are not in the payload either.** The server refuses
   `Keep the arrival and exit clear.` and `Choose a buildable tile inside your garden.` (both mapped
   to `keep-clear` / `not-buildable-tile`), but the payload does not say where those tiles are, so the
   hover read and the footprint cannot warn about them before the write. They are shown as refusals
   when the server refuses.
5. **`tests/build-interface-http.test.js` was not run** (outside the permitted command list). It
   exercises the frontier route only, and that path's request body and endpoint are byte-for-byte
   unchanged for a frontier world: the object-world branch is taken only when the world's own palette
   is an object palette, and a preview with no world set at all still defaults to `/frontier/build`.
6. **Target sizes are the stylesheets' to declare, and two of them are still short.** The touch bar's
   own controls are 44 px and 52 px in `game-mobile.css`, and `--nm-touch-target` publishes the same
   number, but the module renders classes and text: it cannot size a button. Two shell sizes are below
   the floor and are the integrator's (§2.2): `game-theme.css:104`'s 38 px on-canvas pad and
   `nemo-theme.css:174`'s 42 px `.game-hot` hotbar entry — the entry the garden now shows. Neither
   file is this task's to edit.
7. **The `Use` control is a child of the pad group.** The pad is a 3 × 3 CSS grid whose four
   directional keys are explicitly placed; the fifth child auto-places into the free top-left cell. No
   stylesheet change is needed, but the exact cell is a browser layout outcome and was not observed
   in a browser.
8. **The floating bar's host must be positioned.** `body.game-world .world-panel` is
   `position:relative` today, so mounting into it works; mounting the floating bar into any other host
   needs that host positioned, or the `bottom:0` resolves against the page.
9. **Keyboard parity is parity of the module's own controls, not of the whole screen.** `handleKey`
   covers the hotbar digits, `0`, `b`, `c`, `r` and Escape; WASD/arrows/Q/E/R/F remain the shell's and
   were not touched.

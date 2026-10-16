# Task 33 — camera and desktop controls

A game-input module with an explicit, dependency-injected interface: two camera modes, mouse look with
pointer capture, movement/interaction/building routed as intents, and the suspension rules — delivered
without touching the shell, which task 38 owns.

- **Branch:** `task-33-camera-controls`, based on `verify-game-wave-b` at **`d07814d`**
  (`Merge branch 'task-32-characters' into verify-game-wave-b`).
- **Schema: unchanged.** No migration. No new dependency; `package.json` and `package-lock.json` are
  **untouched**.
- Work tree: `work/t33`. Base gates at `d07814d`: **600 tests** (delivered: **622**), e2e 15/15,
  content seal 89 definitions (the packet's "86" is stale for this wave), schema 21.

## 1. Files

| File | Change |
|---|---|
| `src/camera-controls.js` | **changed** — added the camera-mode geometry (`CAMERA_MODES`, `normalizeCameraMode`, `firstPersonView`, `cameraView`, `createViewBlocker`, `EYE_HEIGHT`, `BOOM_LENGTH`, `THIRD_PERSON_MAX_STEP`, `CAMERA_TOGGLE_KEYS`, `MAX_PITCH`, `wrapYaw`, `clampPitch`), the suspension helpers (`SUSPEND_REASONS`, `SHORTCUT_EXEMPT_TAGS`, `shortcutSuspended`, `createSuspension`) and the interface wording (`INTERACTION_KEY_LABEL`, `CONTROL_HINTS`, `controlHint`, `targetHint`); `keyIntent` gained an optional `camera` flag and a `V` binding; `reticleText` now reads the label from `INTERACTION_KEY_LABEL` (identical output). |
| `src/game-input.js` | **new** — `createGameInput`, the stateful controller (`INTENT_KINDS`, `LOOK_STEP`, `DRAG_YAW`, `DRAG_PITCH`). |
| `tests/game-input.test.js` | **new** — 10 tests: modes, eye geometry, the third-person no-reveal/elevation rules, the key map and wording, move/look/interact/build intents, look coalescing, the view key, suspension and keyboard parity. |
| `tests/game-input-capture.test.js` | **new** — 6 tests: pointer capture, drag-vs-pick, pointer lock, Escape, dialog-owned Escape, DOM attach/detach, "no intent carries a position". |
| `docs/CONTROLS.md` | **new** — the key map, the two modes, the suspension rules and the `E`-key resolution. |
| `docs/handoff/task-33-camera-controls.md` | **new** — this file. |

Not touched (owned elsewhere or forbidden by the packet): `app.js`, `index.html`, `style.css`,
`nemo-theme.css`, `server.js`, `package.json`, `src/voxel-world.js`, `src/voxel-geometry.js`,
`src/scene/**`, `src/characters.js`, `src/footprints.js`, `world.js`, `content/**`, `assets/**`,
`scripts/browser-suite.mjs`, `.github/`, `HANDOFF.md`, `docs/VERIFICATION.md`, `outputs/Lucy`. The four
parallel UI modules (`src/ui/*`, `game-mobile.css`) were not created or touched.

## 2. The module interface

`createGameInput(options)` returns one controller. It is deliberately dependency-injected: the shell
passes its own DOM, clock, world context, occupancy predicate and output sink, so a UI module consumes
the returned interface **without importing this file**.

### Injected dependencies (`options`)

| Option | Default | Purpose |
|---|---|---|
| `document` | `globalThis.document` | reads `activeElement`, `dialog[open]`, `pointerLockElement`, `exitPointerLock`; falls back safely when absent |
| `target` | `null` | the element that owns pointer capture (the world canvas) |
| `clock` / `schedule` / `cancel` / `lookDelay` | `Date.now` / `setTimeout` / `clearTimeout` / `150` | the look coalescer's time source (the shipped 150 ms window) |
| `onIntent` | `() => {}` | **the single output** — every intent goes through it |
| `blocksView` | `() => false` | `(x, y, layer) => boolean`, the third-person boom's occupancy test |
| `boomLength` | `3.2` | shoulder distance in tiles |
| `worldContext` | `() => ({})` | `() => ({ frontier, palette, agent, fixture, building, lookMode })`, read on every key press |
| `pickAt` | `null` | `({clientX, clientY, pointerId}) => selection \| null`, the renderer's raycast for a click |
| `isSuspended` | `() => false` | `() => boolean`, the shell's own menu/drawer state |

### Returned controller

| Member | Behaviour |
|---|---|
| `attach(node = target, { keys = true, pointer = true })` | binds `pointerdown/move/up/cancel/lostpointercapture` on the canvas and `keydown` on the document; returns `detach()` |
| `detach()` | removes every listener it added; returns the count |
| `cameraMode` / `setCameraMode(mode, { silent })` / `toggleCameraMode()` | the current mode; `setCameraMode` emits `{kind:'camera'}` unless `silent`; unknown modes normalise to `first-person` |
| `facing` / `setFacing({yaw, pitch})` | the stored facing; the shell restores the server's facing here |
| `position` / `setPosition({x, y, z})` | the stored position; the shell writes the server's position here — the module never authors one |
| `selection` / `setSelection(pick)` | the last picked tile (integer `x`/`y`), for the interaction panel |
| `view(overrides)` | `{ mode, eye, target, distance, blocked, layer }` for the renderer |
| `press(key, event)` | one key as an intent, or `null`; `event` may carry `{ tagName, isContentEditable, dialogOpen, ctrlKey, metaKey, altKey }` |
| `lookBy(dYaw, dPitch)` | a programmatic look (the on-screen Look buttons) |
| `escape()` / `lock()` / `unlock()` | release the capture / request pointer lock / exit it |
| `pointerDown/Move/Up/Cancel(event)` / `pointerLockChange()` | drive a gesture directly (the DOM path calls these) |
| `captured` / `captureId` / `dragging` | capture state |
| `suspended` / `suspendReasons` / `suspend(reason)` / `resume(reason)` / `resumeAll()` | counted suspension |
| `pendingLook` | whether a coalesced look is queued |

### Intents emitted to `onIntent` (`INTENT_KINDS`)

| Intent | Shape | The shell's server call |
|---|---|---|
| move | `{ kind:'move', direction }` | `POST /move` (or `/climb` in step-up mode) — `direction` is view-relative in first person, absolute in third person |
| look | `{ kind:'look', yaw, pitch }` | `POST /agents/:id/look` |
| interact | `{ kind:'interact' }` | `POST /interact` with `Idempotency-Key` |
| build | `{ kind:'build', type }` | `POST /frontier/build` (the placement itself stays a pick or the typed form) |
| camera | `{ kind:'camera', mode }` | none — client-side view change |
| capture | `{ kind:'capture', captured, reason }` | none — notification |
| pick | `{ kind:'pick', selection }` | none — the shell reads the tile (`GET /interact`) and walks/builds |
| cancel | `{ kind:'cancel', reason }` | none — Escape released a capture |

**No intent ever carries a position.** A `move` intent is a direction; a `look` intent is a facing; a
`pick` selection is the renderer's own raycast result. The tests assert this for every intent kind.

### Pure helpers added to `src/camera-controls.js`

- `cameraView(position, facing, { mode, boomLength, blocksView })` → `{ mode, eye, target, distance, blocked, layer }`.
  First person returns the resident's eye; third person returns the boom-clamped eye.
- `firstPersonView(position, facing)` → `{ eye, direction, yaw, pitch, layer }` (eye height `1.35`, the
  same geometry as `src/voxel-geometry.js`).
- `createViewBlocker({ isSolid, layerAt, maxStep })` → the `blocksView` predicate.
- `shortcutSuspended({ tagName, isContentEditable, dialogOpen, modifier })` and `createSuspension()`.
- `controlHint({ playing, mode })`, `targetHint(fixture)`, `INTERACTION_KEY_LABEL`.

## 3. The `E` key — resolution

`E` **turns the camera**; the interaction keys are **`Enter`**, **`Space`** and **`I`**
(`src/camera-controls.js:22-31`). The HUD hint and target line say "E to interact"
(`app.js:756,769,2216`) and `docs/GAME_INTERFACE.md:10` repeats it — a defect, because `E` cannot both
turn and interact.

**Chosen resolution: keep the binding, correct the wording.** This is what the world-HUD spec already
requires (`docs/specs/world-hud.md:57-62`) and what the aim line already prints. Task 33 cannot edit
`app.js`, so the deliverable is the module plus **the exact wording the shell must show**, exported so
it cannot drift:

| Where | Replace | With |
|---|---|---|
| `app.js:756` | `WASD to walk · Drag to look · E to interact` | `WASD to walk · Drag to look · Enter, Space or I to interact` |
| `app.js:769` and `app.js:2216` | `${fixture.label} · E to interact` | `${fixture.label} · Enter, Space or I to interact` |
| `docs/GAME_INTERFACE.md:10` | "E to interact" | "Enter, Space or I to interact" |

Use `INTERACTION_KEY_LABEL` (`'Enter, Space or I'`), `controlHint({ playing, mode })` and
`targetHint(fixture)` from `src/game-input.js` (re-exported from `src/camera-controls.js`) rather than
retyping the string. The alternative — binding `E` to interact and moving turn to another key — was
rejected because it would change the turn keys, break the shipped tests, and contradict the
world-HUD spec.

## 4. Wiring steps for the integration owner (task 38)

The module is **not wired**. The shell owns `app.js`; the steps below are the whole of the integration.

1. **Serve the module.** In `server.js`, next to `files.set('/src/camera-controls.js', …)`
   (`server.js:76`), add:
   `files.set('/src/game-input.js', ['src/game-input.js', 'text/javascript; charset=utf-8']);`
2. **Syntax-gate it.** In `package.json`, add `node --check src/game-input.js` to the `check` script
   (it already lists `src/camera-controls.js`).
3. **Import it** in `app.js`:
   `import { createGameInput } from './src/game-input.js';` and
   `import { createViewBlocker, INTERACTION_KEY_LABEL, controlHint, targetHint } from './src/camera-controls.js';`
4. **Construct one controller** after the canvas exists (near `voxelView = createVoxelWorld(...)`,
   `app.js:165`):
   ```js
   const gameInput = createGameInput({
     target: canvas,
     blocksView: createViewBlocker({
       isSolid: (x, y) => !walkable({ x, y }, definition()) || solidSceneryAt({ x, y }, state.world.objects || []),
       layerAt: (x, y) => surfaceAt(x, y, blockLayers(state.world.blocks || [])),
     }),
     worldContext: () => ({
       frontier: definition().kind === 'frontier', palette: state.world.frontier?.palette || [],
       agent: Boolean(viewedAgent()), fixture: Boolean(state.interaction?.fixture), building: Boolean(state.building),
       lookMode: Boolean(state.lookMode),
     }),
     isSuspended: () => Boolean(state.gameMenuOpen || state.gameDrawer),
     onIntent: handleIntent,
   });
   ```
   (`surfaceAt`/`blockLayers` are in `src/elevation.js`; `createViewBlocker` keeps this module free of a
   world import.)
5. **Map intents** to the shipped calls in one `handleIntent(intent)`:
   - `move` → `state.climbing ? climbAgent(intent.direction) : moveAgent(intent.direction)`.
   - `look` → `queueLook(intent.yaw, intent.pitch, { apply: false }); applyFacing();`.
   - `interact` → `guarded(() => usePickedFixture())`.
   - `build` → `state.buildKind = intent.type; state.building = true; renderView();`.
   - `camera` → `state.firstPerson = intent.mode === 'first-person'; voxelView?.setCameraMode(intent.mode === 'first-person' ? 'first-person' : 'orbit');`.
   - `pick` / `cancel` → nothing here (the shipped pick path and the Escape handler already cover them).
6. **Replace the inline keydown** (`app.js:1110`) with `gameInput.press`:
   ```js
   document.addEventListener('keydown', (event) => {
     if (state.tab !== 'world') return;
     const intent = gameInput.press(event.key, {
       tagName: event.target.tagName, isContentEditable: event.target.isContentEditable,
       ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey,
     });
     if (intent) { event.preventDefault(); handleIntent(intent); }
   });
   ```
   `press` already applies the shipped guard (INPUT/SELECT/TEXTAREA/BUTTON, content-editable, an open
   dialog, a held modifier), so the world stands down exactly when it does today.
7. **Wire the view toggle** (`toggleFirstPerson`, `app.js:374`/`854-859`) to
   `gameInput.toggleCameraMode()` and persist `sessionStorage` from the returned mode, keeping the
   shipped `nemoworld-first-person` key so the preference survives a refresh.
8. **Reconcile the pointer.** The shipped renderer already captures the pointer for its own drag-look
   and raycast pick (`src/voxel-world.js:368-395`). Two owners on one canvas must not both look. Choose
   one:
   - **(a) Keep the renderer's pointer path.** Do **not** call `gameInput.attach()`'s pointer half; feed
     the renderer's `onLook` into `gameInput.setFacing({ yaw, pitch })` and its `onPick` into
     `gameInput.setSelection(pick)`. Call `gameInput.escape()` from the Escape handler so Escape also
     releases the renderer's capture. To let `escape()` release the renderer's captured pointer, give
     the controller the pointer id (bind `pointerdown`/`pointerup` in the capture phase, or call
     `canvas.releasePointerCapture(id)` directly).
   - **(b) Let the module own the drag.** Call `gameInput.attach(canvas)` and route `onIntent`'s `look`
     to `applyFacing()`; keep the renderer's `onPick` only, or supply `pickAt` if the renderer exposes
     one.
   Style (a) is the smaller change and is recommended until the renderer exposes a pick accessor.
9. **Suspend on menus.** In `toggleGameMenu` (`app.js:461`) call `gameInput.suspend('menu')` /
   `resume('menu')`; in `setGameDrawer` (`app.js:460`) call `suspend('chat'|'tools')` /
   `resume(…)`. The `isSuspended` predicate already covers it if you prefer; the counted reasons let
   both coexist.
10. **Fix the wording** (§3): replace the three strings with `controlHint`/`targetHint`.

## 5. Migration and rollback

- **Schema: unchanged.** No table, column, index, trigger, view or `PRAGMA user_version` was touched. No
  stored record is written or rewritten by this module — it emits intents; the shell makes the shipped
  calls that already wrote before.
- **Rollback** is a checkout of `d07814d`. Nothing else imports `src/game-input.js` yet, so reverting is
  a file deletion; `src/camera-controls.js` keeps every pre-existing export unchanged, so `app.js`,
  `src/spaces.js` and `world.js` are unaffected.

## 6. Limitations and residual risks

- **Not wired, not browser-checked.** `npm run browser` was **not run** (the packet forbids it: no
  scenario can be added without `app.js`). The module is verified by module tests only. `app.js` still
  uses its own inline keydown and its own pointer handling until task 38 wires the controller.
- **Third-person enforcement depends on wiring.** `cameraView` computes the no-reveal eye position, but
  the shipped renderer owns the actual camera. Until the shell feeds the mode and `blocksView`, the
  renderer's `orbit` camera does **not** apply the clamp. The module cannot verify the occupancy it is
  told about — `blocksView` is the shell's answer, so a wrong predicate gives a wrong camera.
- **Two pointer owners share one canvas.** The renderer already captures the pointer
  (`src/voxel-world.js:382-385`). §4 step 8 names the reconciliation; until it is chosen, the module's
  pointer half is an unused alternative.
- **`pick` needs the renderer's raycast.** Without a `pickAt` accessor the module emits
  `{ kind:'pick', selection: null }`; the shell keeps the renderer's own `onPick` for the tile. The
  shipped raycast was not modified.
- **Pitch clamp is global (±1.4 rad).** The renderer clamps per mode (`orbit` 0.3–1.22). The shell
  should clamp on `setFacing` if it wants the orbit range; `cameraView` clamps only to `MAX_PITCH`.
- **`BUTTON` exempts the shortcuts** (mirroring `app.js:1110`). After clicking a HUD button, gameplay
  keys resume only when focus leaves the button. This is the shipped behaviour, reproduced on purpose.
- **`V` is lower-case only.** `event.key === 'v'` switches the view; `Shift+V` is not bound. The
  on-screen **First person** button remains the pointer path.
- **`Escape` is not consumed when a dialog is open** — the dialog owns it, exactly as today. `Escape`
  while a menu or drawer is open is left for the shell to close (`app.js:1493`).
- **The suspension predicate is the shell's.** The module cannot know that a drawer is open unless the
  shell suspends or supplies `isSuspended`; if the shell does neither, a key pressed while a drawer is
  open still becomes an intent.

## 7. Verification (actual output)

Delivered tree frozen before the runs below. Interpreter: `export PATH="$PWD/../node-bin:$PATH"`
(Node **v24.19.0**, the runtime symlink `work/node-bin/node` the packet prescribes). No browser was
launched.

```
$ npm run check
> node --check server.js && node --check src/media.js && … && node --check src/guilds.js
  && node --check src/camera-controls.js && … && node --check scripts/load-harness.mjs
CHECK_EXIT=0            (every file the gate lists parses, including the changed src/camera-controls.js)

$ node --check src/game-input.js
GAME_INPUT_CHECK_EXIT=0 (the new module parses; it is NOT yet in package.json's check list — see §4 step 2)

$ npm test
ℹ tests 622
ℹ suites 0
ℹ pass 622
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 152536.506875
TEST_EXIT=0             (baseline at d07814d is 600; +22 = 14 new tests in tests/game-input.test.js
                         and 8 in tests/game-input-capture.test.js; the pre-existing
                         tests/camera-controls.test.js and tests/interaction-controls.test.js still pass)

$ node --test tests/game-input.test.js tests/game-input-capture.test.js
ℹ tests 22
ℹ pass 22
ℹ fail 0

$ npm run e2e
SUMMARY  15 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API
E2E_EXIT=0

$ node scripts/seal-content.mjs --check
Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.
SEAL_EXIT=0

$ git apply --check ../task-33-camera-controls.patch   (in a detached worktree at d07814d)
PATCH_APPLIES_CLEAN=yes
```

**No browser check was performed.** `npm run browser` was **not run** — the packet forbids it (no
scenario can be added without `app.js`) and the module is not wired. Every statement above about UI
behaviour is a source reading, not an observation.

## 8. Reproducing

```sh
cd work/t33 && export PATH="$PWD/../node-bin:$PATH"
npm run check && npm test && npm run e2e
node --test tests/game-input.test.js tests/game-input-capture.test.js
node scripts/seal-content.mjs --check
```

The patch is `../task-33-camera-controls.patch` (`git format-patch -1 HEAD`); it applies cleanly to the
baseline `d07814d`.

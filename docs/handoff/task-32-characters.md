# Task 32 — characters and animation

Branch **`task-32-characters`**, base commit **`c753c14`** (`verify-game-wave-a`, *Merge branch
'task-30-asset-library' into verify-game-wave-a*). Schema is unchanged at **21**; this task adds no
table, column, migration, route, asset or dependency.

Deliverable: a character module with an explicit integration interface, because the renderer
(`src/voxel-world.js`, `src/scene/**`) is owned by a parallel task and the application shell
(`app.js`, `index.html`, the stylesheets) by the integration task.

## Changed files

| File | What it is |
| --- | --- |
| `src/characters.js` | **New.** One appearance system, nameplates, the batch key, the body builder |
| `src/character-animation.js` | **New.** The confirmed-movement tracker and the animation state machine |
| `tests/characters.test.js` | **New.** 9 tests: appearance, labels, key, batch, real Three.js raycast |
| `tests/character-animation.test.js` | **New.** 10 tests: interpolation, refusal, jump, states, poses, a real fixture |
| `docs/CHARACTERS.md` | **New.** The appearance system, the state machine, the nameplate rules, the bounds |
| `docs/handoff/task-32-characters.md` | **New.** This file |

Nothing else was touched. `src/voxel-world.js`, `src/voxel-geometry.js`, `src/scene/**`, `app.js`,
`index.html`, `style.css`, `nemo-theme.css`, `src/camera-controls.js`, `world.js`, `src/footprints.js`,
`src/spaces.js`, `src/atmosphere.js`, `content/**`, `assets/**`, `scripts/browser-suite.mjs`,
`package.json`, `.github/`, `HANDOFF.md`, `docs/VERIFICATION.md` and `outputs/Lucy` are all unchanged.

## The module interface

```js
import {
  charactersScene, charactersVisualKey, characterNameplate, characterNameplates,
  appearanceFor, spriteAppearance, renderableCharacters, animatedCharacters, nameplateTier,
  CHARACTER_LIMITS, NAMEPLATE_LIMITS, BODY, ARM_POSES, CHARACTER_BODY_BOXES, SEALED_EXPRESSIONS,
} from './characters.js';
import { createMotionTracker, characterState, characterPose, confirmedExpression, confirmedFacing,
  MOTION_TWEEN_MS, WALK_FRAMES, EXPRESSION_MS, MOTION_LIMITS } from './character-animation.js';
```

| Symbol | Contract |
| --- | --- |
| `charactersScene(batch, participants, self, { tracker, time, animated })` | **The drop-in replacement for `peopleScene`.** `batch` is whatever the renderer's own `cubeBatch(resources)` returns (`add(x, height, y, width, depth, length, color, pick, style)` and `finish()`). It returns exactly what `batch.finish()` returns: `{ group, pickables, cubes, batches }`. Throws a descriptive error when the batch does not implement that. |
| `charactersVisualKey(participants, self, { tracker, time })` | **The drop-in replacement for `peopleVisualKey`.** A stable JSON key over exactly the fields the drawn geometry depends on. |
| `createMotionTracker({ tweenMs, limit, clock })` | The one place a confirmed position becomes a drawn one. `confirm(item)`, `position(id, time)`, `display(item, time)`, `reconcile(id)`, `isSettling(time)`, `entries()`, `size`, `clear()`. |
| `characterState(item, { tracker, time, animated })` | The confirmed animation state: `{ state: 'idle'\|'walking'\|'seated'\|'interacting', phase, action, facing, direction, position, confirmed, elevation, t }`. |
| `characterPose(state)` | The bounded pose numbers the body builder uses: `{ lift, seated, legDepth, swing, arm: { left, right }, lean, phase }`. |
| `characterNameplate(item, { position, distance, appearance })` | One label: `{ name, role, text, kind, tier, anchor, distance, sprite }`, with a strict allowlist of input fields. |
| `characterNameplates(participants, self, { tracker, time, limit })` | The bounded label set, nearest first. |
| `appearanceFor(item)` / `spriteAppearance(sprite)` | The resolved appearance record, and the sealed appearance sheet for a stored `sprite`. |
| `renderableCharacters(participants, self)` | The bounding and self-appending rule, identical to the renderer's `renderablePeople`. |
| `paintCharacter(batch, item, self, options)` | One character, if a caller needs a single body. |

Design, measurements and the bound list: [`docs/CHARACTERS.md`](../CHARACTERS.md).

## Exact wiring steps for the renderer owner (`src/voxel-world.js`)

Five small edits. Line numbers are from the base commit `c753c14`; nothing else in the file changes.

1. **Import** (with the other imports at the top):
   ```js
   import { charactersScene, charactersVisualKey, createMotionTracker } from './characters.js';
   ```
2. **One tracker per scene.** In `createVoxelScene()`, beside the other per-scene locals
   (`src/voxel-world.js:337`):
   ```js
   const tracker = createMotionTracker();
   ```
3. **Seed the confirmed positions every update.** In `update()`, immediately after `drawnPeople` and
   `drawnSelf` are computed (`src/voxel-world.js:350-351`):
   ```js
   const time = Date.now();
   for (const item of drawnPeople) tracker.confirm(item);
   if (drawnSelf) tracker.confirm(drawnSelf);
   ```
4. **The visual key — one expression.** Replace `peopleVisualKey(drawnPeople, drawnSelf)` at
   `src/voxel-world.js:352` with:
   ```js
   charactersVisualKey(drawnPeople, drawnSelf, { tracker, time })
   ```
   Keep the surrounding `options.rebuildPeople === true` branch exactly as it is.
5. **The batch — one line.** Replace `peopleScene(resources, drawnPeople, drawnSelf)` at
   `src/voxel-world.js:355` with:
   ```js
   charactersScene(cubeBatch(resources), drawnPeople, drawnSelf, { tracker, time })
   ```
   Everything around it stays: `peopleBatch.group.name = 'voxel-characters'`, `root.add(...)`,
   `peopleKey = nextPeopleKey`, and the reuse guard above it. **`refreshPeoplePicks` stays as it is** —
   every character pick the module emits already carries `{ x, y, z, type: 'participant', participant }`
   with the **confirmed** tile, which is the shape that function and `voxelPick` already expect.

Optional, and recommended:

6. **Release the tracker on destroy.** `createVoxelScene().destroy()` (`src/voxel-world.js:388`): add
   `tracker.clear();`.
7. **Expose the two questions the shell needs** from `createVoxelWorld` (the object returned at
   `src/voxel-world.js:477-506`, assigned to the module-level `voxelView` at `app.js:28,165`):
   ```js
   isAnimating() { return contents.isAnimating(); },                    // scene: tracker.isSettling(Date.now())
   reconcileCharacter(id) { return contents.reconcileCharacter(id); },
   ```
   The scene exposes them as:
   ```js
   isAnimating() { return tracker.isSettling(Date.now()); },
   reconcileCharacter(id) { const changed = tracker.reconcile(id); if (changed) paint(); return changed; },
   ```
   The renderer has no animation loop, so **while `isAnimating()` is true something must repaint.**
   The shell already runs exactly that loop for the pixel map — `paintWorld()` is the repaint
   (`app.js:165` renders the 3D view; `app.js:218-224` is the loop). The one-line shell change at
   `app.js:223` includes the 3D view in the loop condition:
   ```js
   if (presenceSettling(performance.now()) || voxelView?.isAnimating?.()) presenceFrame = requestAnimationFrame(step);
   ```
   This is the change that makes a remote avatar *glide* in the 3D view. Today the shell passes
   `position: displayPosition` (`app.js:165`) — the interpolated camera target of the local player —
   while `state.world.participants` still hold confirmed tiles, which is the gap task 16 recorded:
   "Smooth remote motion in 3D needs a change to the renderer's participant contract"
   (`docs/handoff/task-16-realtime-presence.md`). The renderer's own tracker is that change.
8. **Reconcile on a refused move.** `reconcilePresence(id)` (`app.js:213-216`) already snaps the pixel
   map and repaints. Add the 3D path beside it:
   ```js
   voxelView?.reconcileCharacter?.(id);
   ```
   This is optional for correctness — a refusal never changes the stored tile, so the tween always ends
   on a tile the server confirmed — but it makes the refusal immediate in the 3D view too, exactly as
   it is in the map.

### What may be deleted, and the one test that must be updated first

- `peopleScene` (`src/voxel-world.js:304-331`), `PEOPLE_FIELDS` (`:278`) and `renderablePeople`
  (`:281-284`) become dead once step 5 lands. `renderableCharacters` is the same function.
- **`peopleVisualKey` is imported by `tests/voxel-world.test.js:7` and asserted at lines 135-136 and
  162.** Delete the function and that test fails to import. Those assertions are about *the renderer's*
  key, not about the module, and `tests/voxel-world.test.js` is not owned by this task. Either keep
  `peopleVisualKey` as a thin wrapper, or move those three assertions to `charactersVisualKey` in the
  same edit. **Do not delete the coverage** — `charactersVisualKey` carries the same properties
  (roster order, curated profile fields, the selected character) and the module tests already assert
  them, so the assertions can be re-pointed rather than removed.
- The neighbouring test at `tests/voxel-world.test.js:126-160` asserts that a poll changing
  `last_seen`, `accepted_contributions`, `emote` and `emote_until`-as-a-*string* rebuilds nothing. That
  stays true with the module, deliberately: a non-numeric `emote_until` draws no expression, so it is
  not a drawn field. A payload with a **numeric, unexpired** `emote_until` does rebuild once when the
  expression starts and once when it settles, because the expression is now drawn.

## Migration and rollback

**No schema change: the database stays at version 21.** No table, column, index, trigger, view,
migration, route, permission or content definition is added or altered. `content/**` is read through
the existing `src/content.js` resolver and nothing is re-sealed; `src/characters.js` adds no content
entry (asserted: 20 appearance definitions before and after).

Rollback is a revert of this branch. Because nothing is wired, a revert removes only the module, its
tests and its two documents and changes no runtime behaviour at all. If the renderer owner has already
wired steps 1-5, the revert restores `peopleScene`/`peopleVisualKey` and the avatars go back to the
previous bodies — there is no stored state, no background job, no credential and no configuration to
unwind.

## Tests actually run

Every gate below was run on this tree, in this order.

### `npm run check` — exit 0

```
> nemoworld@1.0.0 check
> node --check server.js && … && node --check scripts/load-harness.mjs
check exit=0
```

The shipped script enumerates its files explicitly (`package.json` is not owned by this task), so it
does **not** cover the two new modules. They were syntax-checked directly, with the exit codes recorded:

```
node --check src/characters.js           -> exit 0
node --check src/character-animation.js  -> exit 0
node --check tests/characters.test.js    -> exit 0
node --check tests/character-animation.test.js -> exit 0
```

### `npm test` — exit 0, **584 tests, 584 pass, 0 fail, 0 skipped**

Three full runs were recorded and every one reported the same counts. Durations varied with machine
load (77.8 s, 144.6 s, 214.9 s — the third on the tree as finally committed). The last run's summary:

```
ℹ tests 584
ℹ suites 0
ℹ pass 584
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 214860.015875
TEST-EXIT=0
```

Baseline on this branch before the change: **565 tests, 565 pass, 0 fail, 0 skipped** in 90.0 s. The
19 new tests are included and every pre-existing test still passes unchanged.

### `npm run e2e` — exit 0, **15/15 steps pass**

```
SUMMARY  15 steps passed, 0 failed
  result  PASS — the shipped server serves this scenario end to end over its own HTTP API
E2E-EXIT=0
```

Unchanged from the baseline: the module adds no route, no schema and no server behaviour.

### `npm run browser` — **not run, and not claimed**

The browser acceptance suite's scenarios live in `scripts/browser-suite.mjs`, which this task does not
own, and adding a scenario to it is outside the file ownership this task was given. There is therefore
**no browser scenario for the character module and no visual coverage claim of any kind**: no page was
opened, no click was made, no screenshot was taken and no frame time was measured. Saying so plainly is
the honest alternative to claiming coverage that does not exist.

## Gate results

| Gate | Result |
| --- | --- |
| `npm run check` | **exit 0** (31 files parse), plus four direct `node --check` runs on the new files and tests, all exit 0 |
| `npm test` | **exit 0 — 584 tests, 584 pass, 0 fail, 0 skipped** (two full runs, identical counts) |
| `npm run e2e` | **exit 0 — 15/15 steps pass** |
| `npm run browser` | **not run** — no scenario can be added in this task's file ownership; no visual coverage claimed |

## What the module tests prove

`tests/characters.test.js` (9 tests):

| Test | What it proves |
| --- | --- |
| one appearance system | A human, an AI resident and a country ambassador (from a **real `Platform` fixture**) resolve to one family, one geometry, one height, one clearance; a plain body is exactly the 12 measured boxes, a calling adds only its emblem badge, an ambassador only its NPC marker; the standing top is 1.38 m and the marker top 1.515 m — so the module reproduces the shipped silhouette exactly |
| sealed definitions | The 20 appearance sheets, 7 agent colours, 4 skin tones and 8 callings are read from the sealed layer, the sealed sprite resolves by the stored number (`spriteAppearance(4) === null`, `'16'` refused), a malformed colour is refused, and `content.entries('appearance')` is still 20 |
| nameplates | The name, the role by public kind and calling, the anchor above the head, the three distance tiers, truncation with `…`, and the neutral fallback for an empty name or an unknown kind |
| no leakage | A payload carrying an operator email, capabilities, limitations, a memory record, a private conversation and a private journal produces a label that contains none of them, and whose key set is exactly the nine label fields |
| the visual key | Volatile fields (presence, name, title, `last_seen`, `status`, `operator`, `accepted_contributions`, roster order) key identically; a stale, string, unknown or already-expired expression keys identically; the drawn tile, elevation, stance, colour, kind, calling, expression window, sprite and the playing character each change the key; a walk frame differs from a settled pose and a settled pose is stable |
| the batch contract | `charactersScene` throws without the batch interface, returns `batch.finish()`, emits only positive boxes inside the tile with a participant pick on integer coordinates, keeps the renderer's 220 bound, and animates at most 24 |
| a real raycast | The module's own output is built into real `InstancedMesh` objects and a real `THREE.Raycaster` pick resolves the body to the participant's **confirmed** tile; the self ring is the family's lantern gold |
| the seated measurement | A seated stance lowers the top by exactly 0.26 m and keeps the box count, and no arm or hand pose reaches above the standing head top |
| the sealed vocabulary | The module's expression list is exactly the sealed expression cosmetics minus `none`, and unknown words never animate |

`tests/character-animation.test.js` (10 tests):

| Test | What it proves |
| --- | --- |
| first sight | The display equals the confirmed tile, no slide from an origin, no settling; fractional and unplaced records are refused rather than tracked |
| the two confirmed tiles | Exact positions at `t = 0`, `½`, and `1`, monotone in between, never before the previous tile or past the newest, landing exactly on the confirmed tile |
| the walk cycle | Exactly the four sealed frames appear, the first and last samples are at rest, the facing is the direction of the confirmed step (`up`/`down`/`left`/`right`), and a walker beyond the animation bound keeps its drawn tile but is posed at rest |
| refusal and jump | `reconcile` snaps to the stored tile and returns the state to idle; a two-tile change, a two-layer change and a world change each snap instead of gliding; one grid step still glides |
| a repeat poll | Returns `{ changed: false, snapped: false }` and lets an in-flight tween keep interpolating; the next confirmed step glides from the drawn position |
| expressions | The window is `EXPRESSION_MS`, the two frames are the action then the rest, and `none`, a string `emote_until`, a missing `emote_until`, an unknown word and a non-string are all refused; the precedence is seated → interacting → walking → idle |
| poses | The idle, seated, five expression and four stride poses, the arm table, the lean, the 0.09 m swing, and the drawn geometry never leaving the confirmed segment while the **pick** stays on the confirmed tile |
| facing | The stored yaw quantised to four cardinals and wrapped, a missing `yaw` defaulting to neutral, and a confirmed step winning over the yaw |
| bounds | The tracked set stays at its limit and evicts the least recently confirmed record; the limit matches the renderer's 220 |
| a real fixture | Real `Platform` steps: the stored tile is the newest confirmed one, the display glides and lands on it, a **real server refusal** (the 120 ms move throttle, 429) confirms nothing new and reconciles to the unmoved stored tile, a **real stored expression** animates for exactly its stored window, and a real `posture` change draws the seated lift |

## Honest limitations

- **The module is not visible in the game.** Nothing is wired until the renderer owner performs the
  five edits above and the integration owner adds the one-line animation-loop condition. Until then
  this is a module with tests, and the shipped game draws the old bodies through `peopleScene`.
- **No browser check and no visual evidence.** No screenshot, no FPS, no latency, no contrast or pixel
  measurement. The browser suite was not extended (not owned by this task) and was not run for this
  feature.
- **The walk cycle advances only when the caller repaints.** The renderer has no animation loop, so
  the four striding frames appear only while something calls `update()` again. Wiring step 7 is what
  makes stride visible; without it an avatar snaps between tiles with no swing, which is what the
  shipped renderer does today.
- **Client and server clocks are assumed close.** An expression is drawn while `now < emote_until`,
  where `emote_until` is the *server's* epoch-ms. A large client-clock skew would shorten or lengthen
  the drawn window; the caller should pass the server clock where it has one. The module never extends
  a window the server did not store, and a payload it cannot check numerically draws nothing.
- **Legibility is a stated contract, not a measurement.** The 12 px minimum, the 18 m/40 m tiers and
  the 24-label bound are rules for whichever layer draws the labels; they were not measured on screen.
- **Nameplates are not drawn by this module.** It returns the text, the role, the tier and the world
  anchor. The renderer's label layer (DOM overlay or 2D canvas) must place them, and the pinned Three.js
  bundle has no text or image support, so WebGL text is deliberately not attempted.
- **The visual key is wider than the key it replaces.** It now includes the expression and the walk
  frame, so a batch rebuilds when an expression starts or settles (once each) and up to four times per
  confirmed step. The reuse test's own payload still keys identically. This is a deliberate change and
  the renderer owner should know it before wiring.
- **Anonymous visitors and self.** First person still omits the player's own avatar in the renderer;
  the module only appends `self` when the roster omits it, exactly as `renderablePeople` did. No
  first-person change was made or is proposed here.
- **The 24-avatar animation bound is a policy choice, not a measurement.** It bounds how many avatars
  swing their limbs; the interpolation and the drawn positions are unaffected by it.
- **No new art, no dependency, no re-seal.** The module adds no asset, no font, no texture, no model
  and no package, and re-bundles nothing. The 20 sealed CC0 sheets are read, never rewritten.

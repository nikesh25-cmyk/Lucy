# Task 37 — mobile and accessibility experience: touch controls and a scoped responsive layer

Branch **`task-37-mobile-accessibility`**, base commit **`d07814d`** (`Merge branch 'task-32-characters'
into verify-game-wave-b`), created with `git worktree add ../t37 -b task-37-mobile-accessibility
verify-game-wave-b`. Database schema **21 — unchanged**; no new dependency; `package.json`,
`package-lock.json`, `.github/` and `scripts/` are untouched.

Delivered: a touch-control module with an injected input interface, one **new scoped** stylesheet, and
the measurements that argue the accessibility claim. **The controls are not rendered on any screen by
this branch**, because `app.js`, `index.html` and the three main stylesheets belong to the integration
task (38). §5 of [the reference document](../MOBILE_ACCESSIBILITY.md) is the exact wiring recipe.

## Honesty note first

**No browser check was performed by this task.** No page was opened, no pointer was emulated and no
screenshot was taken. `npm run browser` was **deliberately not run**: a browser scenario cannot be
added without editing `app.js` (which this task does not own), so running the existing scenarios would
prove nothing about this work. The acceptance evidence is therefore:

1. **Module tests** (`tests/touch-controls.test.js`, 18 tests) — the module's own behaviour driven
   against a stub document and an injected clock: which intent it sends, how many times, and what it
   says. No assertion in it claims a rendered pixel.
2. **Stylesheet assertions** (`tests/mobile-styles.test.js`, 9 tests) — every selector, every target
   size, every colour pair and every animation declaration re-read out of `game-mobile.css` and
   recomputed. The numbers are printed when the test runs, so they cannot drift from this document.
3. **The unchanged gates** — `npm run check`, `npm test` (600 pre-existing tests plus the 27 added
   here) and `npm run e2e` (15/15), reported verbatim below.

## Changed files

| File | Change |
| --- | --- |
| `src/ui/touch-controls.js` | **New.** The touch-control module (movement pad, camera drag, single-pointer camera alternative, interaction/build affordances). No import, no dependency, no side effect on load. |
| `game-mobile.css` | **New.** The scoped stylesheet. Every selector begins with `.nm-touch`. |
| `tests/touch-controls.test.js` | **New.** 18 tests: the pure model, the gesture rules, the rendered controls, the injected-interface calls, reduced motion, enable/disable, destroy. |
| `tests/mobile-styles.test.js` | **New.** 9 tests: scoping, class cross-check against the module, measured targets, measured contrast, no horizontal scrolling, opt-in animation, the wide-screen gate. |
| `docs/MOBILE_ACCESSIBILITY.md` | **New.** The reference document: the API, the scoping rule, the measurements, the wiring recipe, limitations, residual risks, rollback. |
| `docs/handoff/task-37-mobile-accessibility.md` | **New.** This file. |
| `src/ui/` | The directory itself is new; nothing else lives in it. |

**Nothing else was touched.** Specifically unchanged: `app.js`, `index.html`, `style.css`,
`nemo-theme.css`, `game-theme.css`, `src/camera-controls.js`, `src/voxel-world.js`, `src/scene/**`,
`src/characters.js`, `src/spaces.js`, `content/**`, `assets/**`, `scripts/browser-suite.mjs`,
`scripts/e2e-smoke.mjs`, `package.json`, `.github/`, `HANDOFF.md`, `docs/VERIFICATION.md`,
`outputs/Lucy`. The four files a parallel task owns (`src/camera-controls.js` + `src/game-input.js`,
`src/ui/build-interface.js` + `src/ui/inventory-panel.js`, `src/ui/interaction-prompt.js`,
`src/ui/spectator.js`) were neither edited nor imported — the module imports nothing at all, which is
asserted by a test.

## What was built

### 1. `src/ui/touch-controls.js`

An on-screen movement pad, a camera drag surface, and touch-reachable interaction/build affordances,
all rendered as labelled native `<button>`s inside three named groups. It decides **no world rule**:
every gesture becomes an intent handed to an injected interface.

| Intent | Called with | Owner maps it to |
| --- | --- | --- |
| `walk(direction)` | `up \| left \| down \| right` | `controlStep(direction)` — the shipped one-grid-step path |
| `look({ yaw, pitch })` | a **relative** rotation | `queueLook(facing.yaw + yaw, facing.pitch + pitch)` |
| `pick({ x, y })` | client pixels, for a gesture under the drag threshold | the shipped canvas pick |
| `interact()` | — | `usePickedFixture()` |
| `build()` | — | the HUD's own Build control |
| `affordance(name)` | `chat \| tools` | `setGameDrawer(name)` |

Behavioural rules, all asserted: a gesture under 6 px is a tap and over it a drag, never both; the
camera drag is Plain Pointer Events (touch, pen and mouse share one listener set, so no duplicate
touch listener can double-fire); the first pointer owns the drag, so a second finger can hold a
movement key while the first drags; a press steps immediately and holding repeats after 320 ms at
160 ms intervals — above the server's own 120 ms step throttle and bounded at 60 repeats; one
direction at a time; a pointer press never double-steps through the `click` it generates while a
keyboard activation steps exactly once.

Two decisions worth naming:

- **The drive has a single-pointer alternative.** A drag is a path-based gesture, so WCAG 2.2 SC 2.5.1
  requires one. `Look left` / `Look right` use the same relative `look` intent and the same 0.35-radian
  step as the shipped camera buttons, so nothing about the camera is drag-only.
- **The module binds no key event.** Keyboard reach comes from the browser's own button activation, so
  the shipped WASD / arrow / Q E R F / Enter Space I world key map cannot be shadowed or swallowed by
  this layer. That is the concrete meaning of "keyboard navigation still works with the touch controls
  present", and it is checked by a source assertion and by a test that a keyboard activation steps once.

### 2. `game-mobile.css`

A **new** stylesheet; the main stylesheets are unchanged and do not reference it.

**Scoping rule: every selector begins with the container class `.nm-touch`, and every media query
contains only `.nm-touch` selectors.** The test also rejects a bare element selector, an id selector,
a selector that belongs to the desktop shell (`.game-*`, `.world-*`, `.tabs`, `.card`, `.sidebar`,
`.movement`, `.welcome`), any `:hover` selector and any bare `:focus`, and any `!important` outside the
reduced-motion suppression. So no rule in the file can reach the desktop interface it is loaded beside.

The stylesheet is also cross-checked against the module: it may only style class names that
`src/ui/touch-controls.js` renders, plus the two documented placement classes the integration owner
adds (`.nm-touch-floating`, `.nm-touch-always`). Renaming a class in either file fails the suite.

Reduced motion is handled as **opt-in animation**: the one transition in the file lives inside
`@media(prefers-reduced-motion:no-preference)`, and there are two independent suppressions — the
`reduce` media block and an unconditional `.nm-touch-reduced` rule for a surface whose stylesheet does
not honour the query. The class is set by the module. No essential information is motion-only: state
is `aria-pressed`, `disabled` and polite live-region text, and the test asserts the pressed state
changes colour as well as attribute.

## Measured numbers (recomputed from `game-mobile.css` on every test run)

Printed by `tests/mobile-styles.test.js`:

```
measured targets in game-mobile.css: pad key width 52px; pad key height 52px; action width 44px;
  action height 48px; pad column minimum 48px; pad row minimum 48px; camera button width 76px
measured contrast in game-mobile.css: pad key label 13.26:1; action label 13.26:1;
  pressed key label 9.89:1; disabled key label 9.86:1; status text 13.23:1; focus ring on a key
  10.3:1; focus ring on the world 12.09:1; key edge on the world 3.48:1
measured layout: pad minimum 156px (3 x 48px columns + 6px gaps) + 12px container padding = 168px
  of a 320px viewport; widest single control 76px; camera and action rows wrap
```

Read as claims:

| Claim | Measured | Threshold |
| --- | --- | --- |
| Every control is at or above the project's touch-target convention | 44 px base; 48 px tall and 52 px wide on a coarse pointer, at **every** width | 44 px |
| Every text pair is readable | lowest 9.86:1 (the disabled label), highest 13.26:1 | 4.5:1 |
| Non-text contrast | focus ring 10.3:1 on a key, 12.09:1 on the world; key edge 3.48:1 | 3:1 |
| No width can force horizontal scrolling | no declared width above 320 px; the widest unflexible row is 168 px of a 320 px viewport; the other rows wrap; nothing is clipped or scrolled sideways | fits 320 px |
| Contrast not regressed against task 13 | this layer adds no rule to any existing surface, so task 13's lowest measured pair (the aim line, 4.82:1) is untouched, and every pair this layer adds is 9.86:1 or above | 4.82:1 unchanged |

The task 13 touch-target corrections are equally untouched: `game-mobile.css` adds no rule for
`button.small`, `.tabs button`, `.icon-button`, `.frontier-hotbar button`, `#session-bar button`,
`button.small`, `.plot-grid .plot-cell` or `.land-atlas .land-area`, and `nemo-theme.css` is byte-for-byte
unchanged in this branch.

## Gate output, verbatim

All three gates ran in the worktree `work/t37` with `export PATH="$PWD/../node-bin:$PATH"`, Node
v24.19.0.

### `npm run check`

```
$ npm run check
> nemoworld@1.0.0 check
> node --check server.js && node --check src/media.js && node --check scripts/local-launch.mjs && node --check scripts/e2e-smoke.mjs && node --check scripts/browser-suite.mjs && node --check src/platform.js && node --check src/database.js && node --check src/spaces.js && node --check src/community.js && node --check src/journey.js && node --check src/atmosphere.js && node --check src/recovery.js && node --check runtime/agent.js && node --check src/civic-engine.js && node --check src/mayor-evidence.js && node --check src/frontier.js && node --check src/voxel-world.js && node --check src/voxel-geometry.js && node --check src/footprints.js && node --check src/elevation.js && node --check src/world-walk.js && node --check app.js && node --check world.js && node --check src/vocations.js && node --check src/quests.js && node --check src/guilds.js && node --check src/camera-controls.js && node --check src/content.js && node --check src/placement-policy.js && node --check scripts/perf-profile.mjs && node --check scripts/load-harness.mjs
EXIT:0
```

`npm run check` is a fixed list of ~30 files in `package.json`. `package.json` is **not this task's to
change**, so `src/ui/touch-controls.js` is not in that list. It was therefore syntax-checked on its own,
which is the same check `npm run check` would have applied:

```
$ node --check src/ui/touch-controls.js
(no output; the file parses)
$ node -e "import('./src/ui/touch-controls.js').then(m=>console.log(Object.keys(m).join(',')))"
AFFORDANCES,CLICK_SUPPRESS_MS,COARSE_POINTER_QUERY,DRAG_THRESHOLD,HOLD_DELAY_MS,HOLD_LIMIT,HOLD_REPEAT_MS,LOOK_BUTTONS,LOOK_PER_PIXEL,LOOK_STEP,MAX_PITCH,PAD_DIRECTIONS,PAD_GLYPHS,PITCH_PER_PIXEL,TOUCH_TARGET_MIN,createTouchControls,gestureFor,hasCoarsePointer,isKeyboardActivation,lookFromDrag,prefersReducedMotion,touchModel
```

### `npm test` (baseline, before this task's files existed)

```
ℹ tests 600
ℹ suites 0
ℹ pass 600
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 419482.860583
```

That is the declared baseline exactly (600 tests). On this machine the suite took 419 s because four
parallel tasks were loading the same host.

### `npm test` (with this task's two new files; see the run report below)

```
ℹ tests 627
ℹ suites 0
ℹ pass 627
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 114074.434958
```

600 + 18 (`tests/touch-controls.test.js`) + 9 (`tests/mobile-styles.test.js`) = 627. **No test was
deleted, skipped or weakened**: the 600 pre-existing tests are byte-for-byte the base revision's, and
the only two new files are additive.

### `npm run e2e`

```
$ npm run e2e
PASS  1. bootstrap reports the public first-administrator gate
PASS  2. first administrator is refused without, and accepted with, the setup code
PASS  3. the administrator creates an agent character
PASS  4. the world reports the participant with z/grounded and the move changes its position
PASS  5. the finite land registry offers a plot and stewardship is recorded
PASS  6. the agent runtime credential is scoped and refused outside its scopes
PASS  7. the runtime walks to the frontier, is refused unwalkable terrain and solid scenery, and builds in the assigned plot
PASS  8. a second account reviews independently and the contribution earns Nemo Coins
PASS  9. documented refusals hold: no building outside the plot, no runtime land acquisition
PASS  10. country ambassadors: a paginated directory, a country-context answer and a refused mismatch
PASS  11. an authored quest chain advances only from saved facts, once, and mints no coins
PASS  12. a guild project board keeps participation explicit, verification independent and guild activity coinless
PASS  13. a newcomer registers, creates an AI resident and chooses a calling
PASS  14. the newcomer meets a country ambassador and begins the shipped practice chain
PASS  15. the newcomer completes one saved practice activity, reads its receipt and meets the review boundary

PASS  cleanup: server stopped, process lock released, temporary workspace removed

SUMMARY  15 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API
```

`15/15`, unchanged — no scenario was added, removed or altered, and `scripts/e2e-smoke.mjs` is
untouched. `npm run browser` was **not run** (see the honesty note); `scripts/browser-suite.mjs` and
its registry test are untouched, so the suite still reports its 21 scenarios.

## The acceptance argument, in one place

> **Core play and observation work without hover, tiny controls or horizontal scrolling.**

| Part | Evidence |
| --- | --- |
| Play: movement, camera, interaction, building | the pad sends `walk`; the drag and the Look buttons send `look`; `Use` sends `interact` and is disabled until `hasFixture()` says the server found a fixture; `Build` sends `build` and relabels to `Finish` while building — all 18 module tests |
| Observation: a visitor with no resident | `canWalk()` is owner-supplied and the recipe returns true for a visitor in an unpaused world, because the shipped step with no agent pans the view; `interact` is disabled without a fixture; a tap calls `pick`; the status text says it is observing |
| No hover | the stylesheet has no `:hover` selector (the only `hover` token is the `hover:hover` device feature in the wide-screen gate); the module binds no mouse or hover listener |
| No tiny controls | 44 px base, 48–52 px on a coarse pointer at every width — measured above |
| No horizontal scrolling | no declared width above 320 px; 168 px of a 320 px viewport for the widest unflexible row; the other rows wrap; nothing clipped or scrolled — measured above |
| Keyboard preserved | the module binds no `keydown`/`keyup`/`focus`; controls are native buttons; a pointer press does not double-step through its own click while a keyboard activation steps exactly once |
| Contrast preserved | every pair this layer adds is 9.86:1 or above; no existing rule is touched, so task 13's measured minimum is unchanged |

## What this task deliberately did not do

- **No change to `app.js`, `index.html` or the three main stylesheets.** Only task 38 wires the shell;
  the recipe is verbatim in §5 of the reference document.
- **No browser scenario and no browser run.** `scripts/browser-suite.mjs` cannot gain a scenario
  without `app.js`, so `npm run browser` was not run and no screenshot exists.
- **No import from `src/camera-controls.js` or `src/game-input.js`.** Those belong to a parallel task,
  and importing them would couple this module to a file it does not own. The injected interface is the
  whole coupling, and a test asserts the module has no import statement at all.
- **No new dependency, no schema change, no server route, no storage.** The module writes nothing and
  sends no request of its own; every intent goes through an existing `app.js` path. Schema stays 21.
- **No change to an existing target or colour.** Task 13's measured baseline is untouched; this task
  adds a surface rather than editing one.
- **No claim that a screen was seen.** See the honesty note.

## Limitations

1. **Nothing renders this today.** `game-mobile.css` is not linked by `index.html` and
   `src/ui/touch-controls.js` is not imported by `app.js`, so neither is exercised outside the tests.
   The deliverable is the module, the scoped stylesheet and a verified wiring recipe — not an observed
   screen.
2. **No browser check.** No box was measured in a browser; the target sizes and the layout arithmetic
   are read from the stylesheet's declarations, and the gestures are proven against a stub document.
   Real pointer capture, real `touch-action` behaviour, and the browser's own `click`-after-touch
   `detail` value are not observable in this runner.
3. **The cascade reader is a simplification**, as in task 13: selectors are matched verbatim,
   specificity is ignored, and a declaration inside a media query is read as if the query applied. It
   is the strictest reading for sizes and colours, but a higher-specificity rule elsewhere could in
   principle win without failing these tests.
4. **`npm run check` does not cover the new file.** It is a fixed list in `package.json`, which this
   task may not edit; the file was checked with the same `node --check` by hand and parses and imports
   cleanly.
5. **The desktop shell's own small-screen issues are out of scope** and belong to task 38: the
   quickbar's horizontal scroll, the hidden `calling-hud` (it exists in `app.js` but is hidden by
   `game-theme.css:23`) and the `E to interact` wording defect in the HUD hint are all recorded in
   `docs/GAME_EXPERIENCE.md` and `docs/specs/world-hud.md`.
6. **The layer is additive, never a replacement.** The WASD / arrow / Q E R F / Enter Space I map, the
   typed `Walk to a tile` form and the pixel-map fallback all remain, and this module cannot shadow
   them because it binds no key event.

## Residual risks

- **The `look` contract is the one silent wiring mistake.** `look` receives a *relative* rotation;
  mapping it to a function that expects an absolute facing turns the camera wrongly instead of failing.
  Both the sign convention and the delta rule are pinned by tests and shown explicitly in the recipe.
- **The drag surface is shared with the voxel renderer.** The module sets `touch-action:none` on the
  surface it is handed and restores the previous value on `destroy()`. The shipped `.voxel-canvas`
  already declares `touch-action:none` in `style.css`, so in practice nothing changes, but the
  integration owner should confirm the renderer's own orbit drag still works after attaching, since
  both listen on the same element.
- **Hybrid devices.** `(pointer:fine)` describes the primary pointer, so a laptop with both a mouse and
  a touchscreen hides the layer by default; `nm-touch-always` is the documented opt-in.
- **Two-finger play depends on distinct `pointerId`s.** The module prefers the primary pointer and
  refuses a second drag owner, so the failure mode is a camera that does not turn rather than a step in
  an unexpected direction.
- **Very large zoom.** The width arithmetic assumes a 320 CSS-pixel viewport; at 200 % zoom on a 390 px
  phone the pad's 156 px still fits but the camera row wraps to two rows. Nothing overflows; the layout
  is simply untested at that width.
- **The 44-pixel floor is a declaration, not a rendered box.** A very long translated label could
  exceed the minimum; the module's labels are short and fixed and the rows wrap.

## Migration and rollback

- **Schema:** unchanged at **21**. No table, column, trigger or migration is added, so there is no
  migration to run, no backup to take for this change, and no data to reconcile.
- **Dependency:** none. `package.json` and `package-lock.json` are unchanged; no `npm install` is
  needed.
- **Rollback of the feature:** delete the `<link rel="stylesheet" href="/game-mobile.css">` line and the
  module import from the integration owner's two edits. `game-mobile.css` and
  `src/ui/touch-controls.js` are inert until then — they are not loaded by anything in this branch.
- **Rollback of the branch:** delete the six new files (`src/ui/touch-controls.js`, `game-mobile.css`,
  `tests/touch-controls.test.js`, `tests/mobile-styles.test.js`, `docs/MOBILE_ACCESSIBILITY.md`,
  `docs/handoff/task-37-mobile-accessibility.md`). Nothing else references them, and `git diff --stat`
  against `d07814d` expects an empty tree.
- **Partial rollout:** ship both files and both wiring lines. The stylesheet hides the layer on a wide
  fine-pointer screen by itself, so the controls appear on small screens and coarse pointers only until
  the owner passes `nm-touch-always`.

# Renderer scale and level of detail

Branch `task-deepseek-render-scale`, base `f773c46` ("Bind native missions and chat to paired avatar",
the tip of `codex/final-integration`). Worktree `work/w-render`.

Measured on **Apple M5 (`Mac17,3`), 10 cores, 16 GiB, macOS 26.6.2 (build 25G83), Node v24.19.0**.
Note that the machine was carrying other worktrees' browser suites throughout (load average 31–42 on
ten cores), which the timing columns below say about themselves rather than hide.

The goal was to make the voxel renderer scale further on the *same* art direction, without inventing
continuous physics and without raising a bound: distance-based level of detail inside the existing
window, plus a repeatable micro-benchmark that measures instance counts, draw calls and build time on
a bounded fixture. The server stays authoritative — a rendered tile is still exactly the tile the
server refuses or allows.

## 1. What changed, and why

### 1.1 One rule, in the module that owns viewport bounds

`src/voxel-geometry.js` gained:

| Export | What it is |
| --- | --- |
| `LOD_LIMITS = { detail_radius: 12 }` | How far from the followed resident tiles are read at full detail. Authoring, not a bound: `VOXEL_LIMITS` is untouched. |
| `detailTier(x, y, anchor, radius)` | `'fine'` or `'coarse'` from the **Chebyshev** distance between a tile and the anchor. An anchor that is not a tile, or a radius that is not a number, leaves every tile `fine` (fail safe); `Infinity` is the documented pre-LOD build. |
| `inDetail(x, y, anchor, radius)` | The predicate form, for the two hot per-cell loops. |
| `voxelAnchor(definition, position)` | The follow tile, clamped into the authored world. `voxelWindow` is now built from it, so the window and the rule share one origin. |
| `DIORAMA_BUDGET` | The stated ceiling: `instances`, `participant_instances`, `block_instances`, `draw_calls`. |
| `prefersReducedMotion(match)`, `reducedMotionPreference(value)` | The media-query reading, through an injected matcher — the same helper and fallback `src/ui/touch-controls.js` already uses. |

`voxelPlan(definition, snapshot, position, detailRadius)` now also receives and returns the radius, and
returns `anchor` beside `window`. Every scene pass already receives the plan, so the tier reached the
passes with no new plumbing and no new module.

**No new module was added, and that is deliberate.** `server.js` holds a hand-maintained static route
table that `tests/content-http.test.js` walks from `/app.js`, and this slice may not touch
`server.js`; a new `src/scene/*.js` would have 404'd the browser module graph. The rule lives in
modules that were already served.

### 1.2 What the rule may drop, and what it may never drop

| Drawn at both tiers | Dropped beyond the radius |
| --- | --- |
| The surface slab, the underground base cube and the terrain type's own detail (obstacle, pickable garden flowers) | Ground-cover mottling and seedlings (`src/scene/vegetation.js`) |
| Water: the bed, the sub-surface slab and the surface, with the tile's own pick | Understory leaf litter and tufts on tiles the server already refuses |
| Authored scenery, saved blocks, portals, gates, landmark pennants, the plot overlay, the sky, the distant backdrop | Water glints, shore breaks and marginal reeds (`src/scene/water.js`) |

The selection is the narrowest one that does any work: every dropped box is **unpicked**, so it cannot
change what a click resolves, cannot change occupancy and cannot stand in a standing column. The one
decoration the ground pass owns that *does* carry a pick — a garden tile's `flowers` object — was
deliberately left alone for exactly that reason, and `tests/render-lod.test.js` asserts that every
dropped instance is unpicked.

`src/footprints.js` was read and never edited: the classes, the resident numbers and the two-way
obstacle rule are unchanged. The rule changes *what is drawn*, never *what is occupied*.

`lod: false` on a scene update is the escape hatch that rebuilds the pre-LOD view exactly. It is part
of the static batch key, so flipping it rebuilds the diorama rather than mixing two tiers in one
batch. Nothing in `app.js` or the shipped renderer sets it; it exists so the benchmark and the tests
can produce a "before" column from the same tree.

### 1.3 Reduced motion

`prefers-reduced-motion` is now honoured by the renderer itself, without a mode switch and without
touching `app.js`:

- `createVoxelWorld(canvas, { reducedMotion })` resolves the preference once — an injected boolean or
  matcher wins, otherwise `globalThis.matchMedia('(prefers-reduced-motion: reduce)')` is read — and
  forwards it on every update.
- Under `reduce`, `createVoxelScene.update` reconciles each confirmed step instead of gliding through
  it, so a resident is drawn on the tile the server stored and never between two tiles. The scene then
  reports `animating: false`, which stops the renderer's own 100 ms settle timer **and** the frame loop
  `app.js` drives from `voxelView.isAnimating()`.
- The detail rule adds no animation of its own: it is a pure function of the followed tile, so two
  builds of one viewport at different wall-clock times are identical.

The interpolation itself lives in `src/characters.js`/`src/character-animation.js`, which this slice
does not own, so the tame is done with the reconciliation path that already existed for a refused
move — `reconcile(id)` snaps the display to the stored tile — rather than by adding a switch to
another slice's module.

### 1.4 The stated budget

`DIORAMA_BUDGET` (`src/voxel-geometry.js`) names four ceilings, one per owner: world geometry
(3,600 instances — the largest measured viewport, 3,228, plus ~11% headroom), residents at
`VOXEL_LIMITS.participants` (4,840 = 220 × the 22 boxes the worst-case body draws), saved blocks at
`VOXEL_LIMITS.blocks` (2,048 = one instance per stored layer) and draw calls (130, the bound
`tests/render-scene.test.js` already held). `tests/render-lod.test.js` asserts each against a real
viewport, including one carrying 220 residents and 2,048 blocks at once.

## 2. Files

Changed (all inside the slice's may-change list):

| File | Change |
| --- | --- |
| `src/voxel-geometry.js` | `LOD_LIMITS`, `detailTier`, `inDetail`, `voxelAnchor`, `DIORAMA_BUDGET`, `prefersReducedMotion`, `reducedMotionPreference`; `voxelWindow` rebuilt from `voxelAnchor`; `voxelPlan` takes a radius and returns `anchor` + `detailRadius` |
| `src/voxel-world.js` | `update` resolves the detail radius, rebuilds the static batch when it changes, reconciles under reduced motion, and reports `stats.detail`; `createVoxelWorld` reads the preference and stops scheduling the settle timer under `reduce`; the `createVoxelScene` doc comment now lists the update options it honours |
| `src/scene/terrain.js` | `groundPass` computes the tier per cell and passes it to `waterTile` |
| `src/scene/vegetation.js` | `groundCoverPass` draws cover and understory only inside the radius |
| `src/scene/water.js` | `waterTile` takes `detail` and drops the glints, breaks and reeds — never the three pickables — beyond the radius |
| `scripts/voxel-bench.mjs` | A level-of-detail section on two bounded fixtures, a true pre-change "before" column (`lod: false`), median-with-minimum timing, and the budget printed beside the radius |
| `docs/VOXEL_WORLD.md` | A "Level of detail" section, the reduced-motion paragraph, and the bounds/verification updates |
| `docs/PERFORMANCE.md` | A "Renderer level of detail" section with the measured numbers and what they do not say |
| `tests/render-lod.test.js` | **New** — 7 tests (below) |
| `docs/handoff/task-deepseek-render-scale.md` | This document |

Not touched, deliberately: `src/footprints.js` (read only), `src/characters.js` and
`src/character-animation.js` (another slice's files — the reduced-motion contract is met through their
existing `reconcile` path), `app.js`, `package.json`, `server.js`, and every NEVER-TOUCH file.
`git show --stat` on the single commit in §7 lists exactly the ten files above.

## 3. Gates and evidence

All commands run in `work/w-render` with `export PATH="$PWD/../node-bin:$PATH"` → **Node v24.19.0**.

```
$ npm run check
… 41 × node --check … && node --check src/voxel-world.js && node --check src/voxel-geometry.js …
exit=0

$ npm test
ℹ tests 891
ℹ pass 891
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 268137.268792

$ npm run e2e
SUMMARY  17 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API

$ node --test tests/render-lod.test.js
ℹ tests 7
ℹ pass 7
ℹ fail 0
ℹ skipped 0
```

891 is the runner's own count, and the base commit's is 884: exactly the 7 new tests in
`tests/render-lod.test.js` were added, and `git show --stat` names no other test file — nothing
deleted, skipped or weakened. During development this change also ran and passed
`tests/render-obstacles.test.js`, `tests/render-scene.test.js`, `tests/render-atmosphere.test.js`,
`tests/voxel-world.test.js`, `tests/footprints.test.js`, `tests/country-venues.test.js` and
`tests/content.test.js`, which are the suites most exposed to it.

`npm run check` does not cover `src/scene/**.js` or `scripts/voxel-bench.mjs`: the syntax gate
enumerates files in `package.json`, which this slice does not own. All of them were checked explicitly
(`node --check`, all clean), and every scene module is imported by `src/voxel-world.js`, so `npm test`
compiles them on every run.

**One honest note on the suite.** One run of `npm test` on this exact revision reported 890 of 891
passing — `tests/realtime-latency.test.js` "measured update latency and frame rate on the loopback
fixture" failed with "every fixture client must be subscribed: 8 !== 16" while the machine carried a
load average of 111 on ten cores. It passed in isolation immediately afterwards (16 connections, 20
moves, median latency 1 ms) and the next full run of the same revision passed 891 of 891. It is a
concurrency-timing test that touches no renderer file, and it is recorded here rather than hidden.

### 3.1 Database assertions

**This slice reads and writes no database.** It is presentation only: the changes are in the scene
builder, the bounds module and the benchmark, and no route, table, schema or stored row is involved.
The schema is untouched (23 is reserved elsewhere and not taken here). What the tests assert instead
is the renderer's agreement with the server's own rules, read from the shared table rather than
restated: `standableTile`, `solidTileKeys` and `TERRAIN_BLOCKING` from `src/footprints.js`, applied to
the real instance matrices the GPU would receive. The end-to-end agreement between the HTTP API, the
database and the rendered world is covered by the suites that already own it
(`tests/world-coherence.test.js`, `tests/http.test.js`, `tests/frontier.test.js`), which are
byte-identical to the base commit and pass.

### 3.2 The seven new tests (`tests/render-lod.test.js`)

1. **the detail tier is a pure function of the anchor, and Infinity is the documented pre-LOD view** —
   inclusive radius, Chebyshev rather than Manhattan, fail-safe anchors and radii, `Infinity` as "no
   level of detail", the anchor clamped inside a small world, and `plan.anchor`/`plan.detailRadius`.
2. **the near field is untouched: only unpicked decoration on a coarse tile is dropped** — over four
   authored worlds, the multiset of instances *inside* the radius (colour + all sixteen matrix
   components) is identical with the rule on and off; every dropped instance is unpicked, on a coarse
   tile and below `KNEE_HEIGHT`; the cube delta equals that set; and not one pickable instance is lost.
3. **a coarse tile is still drawn as exactly the tile the server refuses or allows** — the two-way
   obstacle rule re-asserted over the coarse ring itself (1,776 coarse cells across three worlds), with
   a stronger clause: past the radius a walkable tile carries no unpicked obstruction at all.
4. **the decorative reading is bounded by the detail radius, not by the window** — every unpicked
   ground read sits inside the radius, `fine <= 625` for every authored world at three anchors, and the
   measured consequence on the largest viewport (746 → 300 decoration, 3,273 → 2,729 instances).
5. **the largest viewport stays inside the stated instance and draw-call budget** — every authored
   world at three anchors against `DIORAMA_BUDGET`, with the sweep proven to reach a real viewport.
6. **a viewport carrying the participant and block bounds still fits the stated budget** — 220
   residents and 2,048 blocks at once, each term asserted against its own ceiling.
7. **reduced motion is honoured: the confirmed tile is drawn and nothing is animated** — the matcher
   unit-tested (absent, throwing, unmatched, null); a tween draws the tile it left without the
   preference and the confirmed tile with it; `animating`/`isAnimating()` false; a repeated payload
   rebuilds nothing; `reconcileCharacter` still answers.

## 4. Measured on this machine

Instrument: `node scripts/voxel-bench.mjs 20 30`. Fixtures, named: the shared `commons` (29 × 25
window, 725 cells) and the largest viewport the server can request, `frontier:0:0` (37 × 37 window,
1,369 cells = `VOXEL_LIMITS.cells`), each with 20 drawn residents.

| Fixture | Instances | Draw batches | Cells read closely | Decoration (cover + understory) |
| --- | --- | --- | --- | --- |
| `commons` | 2,332 → **2,094** (−10.2%) | 99 → 99 | 725 → 437 | 489 → **251** (−49%) |
| `frontier:0:0` | 3,273 → **2,729** (−16.6%) | 91 → 91 | 1,369 → 625 | 746 → **300** (−60%) |

With no residents at all: 2,080 → 1,818 (Commons) and 3,021 → 2,325 (frontier); the worst frontier
sector in the tree (`frontier:-3:5`) is 3,228 → 2,367. A sweep of all 54 authored worlds at two camera
positions each — the fixture `tests/render-scene.test.js` already uses — is 150,189 → 129,614 cubes
(−13.7%), which is why that suite's `cubes > 100000` floor still holds comfortably.

**Draw calls do not move.** A batch is one `InstancedMesh` per colour and material style, not per tile,
so the batch count is already bounded by the palette (88–99, against the 130 that
`tests/render-scene.test.js` bounds). What grew with the window was the per-tile decoration; the
detail radius is what bounds it, to at most `(2 × 12 + 1)² = 625` closely-read cells whatever the
window. The reduction is therefore in instances — geometry allocated, uploaded and submitted — not in
draw calls, and no frame-rate claim is made from either.

Build time, three runs of `node scripts/voxel-bench.mjs 20 30`, least perturbed sample, on the largest
viewport (`frontier:0:0`):

| Row | pre-LOD | detail rule |
| --- | --- | --- |
| First build (3 fresh scenes) | 26.5 / 29.0 / 12.3 ms | 11.3 / 14.1 / 10.1 ms |
| Static rebuild forced by a terrain tile (30 samples) | 6.4 / 6.8 / 7.2 ms | 5.7 / 7.1 / 7.5 ms |
| Poll on an unchanged payload (30 samples) | 0.9 / 1.0 / 0.9 ms | 0.9 / 0.9 / 1.2 ms |

**These build-time numbers establish no win, and this handoff does not claim one.** The detail rule's
first build was 10.1–14.1 ms against 12.3–29.0 ms without it across three runs, so it was never the
slower one, but the spread on either side is wider than the gap between them and two of the three runs
sit inside one another's noise. The forced whole-window rebuild and the poll show no difference once
the scene is warm — both sides do the same plan-resolve and key work, and the warm rebuild's ~6 ms
floor is dominated by that rather than by the 544 instances the rule removes. The Commons fixture is
too small for these columns to say anything at all.

What the instrument states exactly is the geometry: a full static rebuild of the frontier fixture
allocates 544 fewer instances and writes 544 fewer instance matrices, and the poll column is
unchanged, which is the one thing that must hold on the hot path — the detail radius is part of the
static batch key, so a poll that moves neither the resident nor the world rebuilds nothing. The
medians for the same rows swung between 24.8 ms and 54.2 ms on the rule side and 30.4 ms and 46.7 ms
on the pre-LOD side; `docs/PERFORMANCE.md` prints them in full, along with the load the machine
carried. The instance, draw-call and rebuild counts are exact and machine-independent; the
milliseconds are not.

**No frame rate, GPU time, memory or capacity figure is claimed anywhere.** The instance, draw-call
and rebuild counts are exact and machine-independent; the milliseconds are not. No MMO or per-user
capacity claim is made or implied.

## 5. Browser check

`npm run browser` drives the real interface in the system Chrome build against a temporary database
and asserts the database after every UI action, so it is the one check that the changed scene graph
actually loads and renders in a browser. It was run three times; the honest record is below.

- **Run 1 (full suite, load ~32).** The Chrome process died part-way through and every scenario after
  that failed with `Target page, context or browser has been closed` — ten scenarios, a cascade from
  one dead browser rather than ten findings. Nothing before the teardown reported a rendering error.
- **Run 2 (full suite, load 31–42 on ten cores).** **31 scenarios passed and 7 failed**, and the run
  was still going at the 30-minute cap I had set, so it did not reach its own summary. Several other
  agents were running their own browser suites at the same time (`ps` showed six
  `node scripts/browser-suite.mjs` processes on the machine, only one of them mine). Every failure is a
  25-second timeout or an aborted request, which is what a saturated machine looks like and is not what
  a renderer defect looks like:

  | Scenario | Reason |
  | --- | --- |
  | `interaction-ambassador-desk` | "the desk must store exactly one turn: expected 2 turns, actual 1", with `429 POST /api/v1/move` in its page log; the walk to the stand took 58 s of its 100 s budget |
  | `reviewer-workbench` | `locator.waitFor` timeout, 20 s |
  | `management-interface-and-roles` | `page.goto` timeout loading `/manage`, 25 s — a governance page that never mounts the voxel view |
  | `first-ten-minutes` | `locator.click` timeout, 25 s, on a button the log shows had already resolved |
  | `first-play-solo-ambassador` | `page.waitForFunction` timeout followed by a screenshot timeout, 25 s |
  | `restoration-two-clients` | `POST /api/v1/auth/login` aborted |
  | `phone-conversation` | `POST /api/v1/agents/:id/travel` aborted |

  The scenarios that drive the 3D viewport passed, including `first-person-controls`,
  `plot-and-blueprints`, `shared-presence-two-clients`, `game-shell-entry-and-continue` (93 s),
  `interaction-saved-world-changes`, `interaction-door-and-crafting` and `interaction-state-refusals`.
  None of the seven failures names the renderer, geometry, WebGL, a drawn tile or an instance count.
- **Run 3 (focused, clean).** The two failures most relevant to this change were re-run with the rest
  of the viewport scenarios; all three passed, and the full output is below.

**What this means, stated plainly:** the whole browser suite did not complete clean under this
machine's contention. No scenario failed for a reason that points at this change, and the scenarios
that failed and were re-run (`game-shell-entry-and-continue`, `interaction-ambassador-desk`) passed,
including the 3D-viewport walk. That is evidence, not proof, and the outstanding check is named as a
residual limit below rather than reported as a pass.

**Run 3 (focused, clean):**

```
$ LUCY_BROWSER_ONLY=first-person-controls,game-shell-entry-and-continue,interaction-ambassador-desk npm run browser
  server stopped, process lock released: true
  shipped database untouched
SUMMARY  3 passed, 0 failed
  PASS  first-person-controls (31226 ms)
  PASS  interaction-ambassador-desk (43684 ms)
  PASS  game-shell-entry-and-continue (57736 ms)
  result  PASS — the interface was driven in a real browser and the database agreed
```

Exit code 0, the temporary workspace removed, the shipped `data/world.sqlite` untouched, and the
database asserted after every UI action inside each scenario.

## 6. Residual limits and risks

- **The radius is positional, not screen-space.** It is measured from the followed resident, not from
  the camera, so it does not react to zoom. At the widest orbit the boundary sits about 12 tiles out,
  inside the fog band (12–60% faded there), and the change is the ground mottling and the tufts. The
  rule is deterministic and cheap; a screen-space rule would have to rebuild the diorama on every zoom
  step, which the event-driven renderer deliberately does not do.
- **There is no hysteresis and no transition.** A tile crossing the radius switches tier in one frame
  as the resident walks. That is a deliberate consequence of honouring reduced motion (no fade
  animation was added), but it is a pop, and it is reachable on foot.
- **The rule does not bound the per-cell floor.** A surface slab and, where it is exposed, a base cube
  per cell are drawn at every tier, so a future slice that raises `VOXEL_LIMITS.radius` still pays
  linearly for the window. Blocks (up to 2,048, one instance per stored layer) and residents (up to 220)
  are the other window-bounded terms, and both are occupancy and identity: dropping or merging either
  would change what a tile means or which layer a click resolves, so neither is touched.
- **The timing columns are load-contaminated**, as §4 says. Only the frontier first-build row moved
  consistently.
- **`npm run check` does not cover the new code paths** (`src/scene/**`, `scripts/voxel-bench.mjs`):
  `package.json` is not this slice's file. They are covered by an explicit `node --check` here and by
  `npm test` compiling them.
- **The detail radius is a constant, not authored content.** 12 was chosen as the fog band's own near
  distance at the default orbit, not tuned per world. A world with a much larger near-field
  composition would want its own radius, and there is no hook for that today.
- **The whole browser suite did not complete clean on this machine.** It was attempted twice under a
  load average of 31–42 (other agents' suites were running concurrently); 31 scenarios passed and 7
  failed with 25 s timeouts and aborted requests, and the two that were re-run focused both passed.
  Nothing failed for a renderer reason, but this is the one gate in §3 whose *complete* run is
  outstanding, and it needs a quiet machine rather than an argument.
- **The reduced-motion preference is read once, when the view is created.** A visitor who changes the
  setting while the page is open keeps the old behaviour until the view is recreated. Watching the
  media query would need a listener on the renderer, and the application creates and destroys the view
  on every renderer switch, which is where the preference is re-read.
- **The browser suite has no visual or frame-time assertion**, so nothing here proves the boundary
  looks the way it was reasoned about. No screenshot comparison was made.

## 7. Migration, rollback

- **No schema change, no migration, no content re-seal, no new dependency.** The patch writes nothing
  to a database, adds no table, changes no stored format, does not touch `content/**` or
  `assets/vendor/three-voxel.js`, and does not edit `package.json` or `package-lock.json`.
- **No route table change.** No new module file was added, so `server.js` needs no new static route —
  which is why the rule was placed in the modules that were already served.
- **Rollback** is `git revert` of the single commit, or dropping the branch. Every change is
  presentation-only: the scene builder falls back to drawing every tile at full detail the moment the
  radius is `Infinity`, and nothing stored depends on the rule.
- **Deployment note:** nothing. The change ships with `src/`; an older `src/voxel-world.js` next to a
  newer `src/voxel-geometry.js` would still load, because the new plan fields are additive and every
  reader defaults safely when they are absent (`detailTier` treats a missing radius or anchor as
  "full detail").

## 8. Requirement → evidence

| Requirement | Evidence |
| --- | --- |
| Distance-based level of detail in `src/scene/*` and `src/voxel-world.js` | `LOD_LIMITS`/`detailTier` in `src/voxel-geometry.js`, read by `terrain.js`, `vegetation.js` and `water.js`; `createVoxelScene.update` resolves the radius and keys the static batch on it |
| A large viewport stays inside the existing draw-call and instance budgets | §4: 3,273 → 2,729 instances and 91 → 91 draw calls on a 1,369-cell window; draw calls were already palette-bounded at 88–99 against 130 |
| A repeatable micro-benchmark measuring instance counts, draw calls and build time on a bounded fixture | `scripts/voxel-bench.mjs` level-of-detail section: two named fixtures, `lod: false` vs the rule, deterministic instance/draw-call rows plus median-with-minimum timing, and the budget printed beside the radius |
| A rendered tile is still a tile the server refuses/allows | `src/footprints.js` unchanged and read directly by the new tests; every dropped instance is unpicked (test 2); the two-way rule re-asserted over the coarse ring (test 3); `tests/render-obstacles.test.js` still passes over the real worlds |
| A test that every drawn obstacle is still a server-refused tile and the reverse | `tests/render-lod.test.js` test 3 (1,776 coarse cells over three worlds) on top of the existing whole-window sweep in `tests/render-obstacles.test.js` |
| A bounded-budget assertion | `DIORAMA_BUDGET` in `src/voxel-geometry.js`; tests 5 and 6, the second with 220 residents and 2,048 blocks at once |
| Reduced motion honoured | `prefersReducedMotion`/`reducedMotionPreference` + the reconciliation path; test 7, and the paragraph in `docs/VOXEL_WORLD.md` |
| No continuous physics invented | No movement, collision or elevation rule changed; all changes are draw-time |
| Every claim backed by a real test, no gate loosened | §3; no existing test edited, skipped or deleted; `VOXEL_LIMITS`, `RENDER_CAPS` and `SHADOW_LIMITS` unchanged and still asserted by `tests/render-atmosphere.test.js` |

## 9. For the integration owner

- **One file outside the renderer would be a normal next step: `package.json`.** `npm run check` should
  gain `src/scene/*.js` and `scripts/voxel-bench.mjs`, and a `npm run voxel-bench` script would make the
  instrument discoverable. Neither is this slice's file.
- **`docs/assets/asset-manifest.json` is not affected**: no shape, colour, height or box count changed
  inside the radius, and beyond it only the ground reading is affected, which the manifest does not
  measure.
- `node_modules/playwright-core` is present in this worktree (untracked, gitignored) so the browser
  suite can be re-run; `package.json` and `package-lock.json` are unchanged.

# Task 31 — world rendering and atmosphere

Branch `task-31-world-rendering`, base commit `c753c14` (the `verify-game-wave-a` tip; "Merge branch
'task-30-asset-library' into verify-game-wave-a"). Worktree `work/t31`. Baseline at that commit,
measured in this worktree before any change: **565 tests, 0 fail; e2e 15/15; content seal 89
definitions; `npm run check` exit 0**.

The goal was to improve terrain, water, vegetation, lighting, shadows, distance fog and building
appearance while keeping the drawn geometry exactly aligned with the movement and construction rules
the server enforces — and to do it *isolated to the renderer and dedicated scene modules*, without
raising a bound, without a new dependency, and without re-bundling the pinned Three.js bundle.

## 1. What changed, and why

### 1.1 The scene is now modules, not one file

`src/voxel-world.js` was 507 lines holding the palette, the sealed builders, the character builder,
the whole diorama composition, the block scene, the plot overlay, the camera and the public factory.
The composition moved to eight modules under `src/scene/`, each with one responsibility:

| Module | Lines | Responsibility |
| --- | --- | --- |
| `src/scene/batch.js` | 94 | Instanced batches (one mesh per colour + style), the style vocabulary — including three new unfogged sky styles — `disposeBatch`, and the palette helpers `hash` / `variant` / `shade` / `validColor` |
| `src/scene/terrain.js` | 83 | `groundPass` (base cubes with the whole-node cull, surface slabs, bridges, wall and building tiles, garden cells, water), `portalFrames`, `gateFrames`, `landmarkPennants`, and the `layer()` accounting helper |
| `src/scene/water.js` | 67 | `waterDepth`, `shoreSides`, `waterTile`, `waterBasin`, `WATER_TINTS` |
| `src/scene/vegetation.js` | 62 | `groundCoverPass`, `COVER_TINTS`, `COVER_HEIGHT_LIMIT` |
| `src/scene/buildings.js` | 48 | `wallTile`, `buildingTile`, `BUILDING_TINTS` |
| `src/scene/blocks.js` | 21 | `blocksScene` |
| `src/scene/parcels.js` | 47 | `parcelScene` |
| `src/scene/sky.js` | 152 | `SKY_PHASES`, `SHADOW_LIMITS`, `PHASE_ALIASES`, `phaseLighting`, `resolvedPhase`, `fogFor`, `sunPlacement`, `shadowExtent`, `shadowResolution`, `applyPhase`, `skyScene`, the cloud pattern |

`src/voxel-world.js` is now 435 lines (from 507) and keeps exactly four things: the palette, the sealed builders
(`tree`, `house`, `furniture`), the character builder (`peopleScene`, untouched — see §5), and the
public surface (`createVoxelScene`, `createVoxelWorld`, `RENDER_CAPS`). `tests/render-scene.test.js`
then sweeps 54 authored worlds from two camera positions each (108 builds, 156,007 cubes) and asserts
every instance matrix is finite and every material colour is a valid six-digit hex — the check that
would catch a missing palette key, which is exactly the mistake this refactor made once (an undefined
`wall` tint) and the tests caught.

**Why the sealed builders stayed.** `tests/content.test.js` reads `src/voxel-world.js` as *source
text*: it slices the region from `function tree(batch` to `function terrainScene`, requires every
sealed furniture/architecture definition to name a builder found in that region, requires each
definition's declared colour and emissive tone to appear in that builder's own body, and requires no
definition colour to be a parallel literal elsewhere. Moving `tree()`/`house()`/`furniture()` out of
that file would have broken that test, and it is not a file this task owns. So the extraction was
drawn along a different seam: the scene modules own *composition and presentation*, the pinned file
owns the *sealed grammar and its palette*, and the modules receive the builders as a `builders`
parameter. `terrainScene()` stays in `src/voxel-world.js` as the real orchestrator that calls the
passes and accounts for each layer (not a stub).

### 1.2 Obstacle truth, enforced and asserted

Requirement: "everything drawn with mass must be non-walkable server-side and vice versa", enforced
through `src/footprints.js`'s shared classes. The renderer already agreed with the table at the base
commit (that was task 02's work); what this task adds is (a) the new geometry the renderer now draws,
and (b) the missing proof, stated as three rules read from the table itself:

1. a walkable tile carries nothing between the knee (`KNEE_HEIGHT` 0.5 m) and the head
   (`RESIDENT_HEIGHT` 1.52 m) inside the standing column (`RESIDENT_CLEARANCE` 0.38 m either side);
2. a tile the server refuses is drawn as an obstacle — one declared exception, `water`, which is
   refused and drawn as a water surface below ground level;
3. untargetable decoration (ground cover, glints, shore breaks, the plot overlay) stays at or below
   `GROUND_DETAIL` (0.1 m) on walkable ground, or entirely above the head.

`tests/render-obstacles.test.js` asserts all three over the real authored worlds (`commons`, three
districts, two frontier sectors, a country venue, a home, a furnished house), over all 27 scenery
types, over a synthetic water body and over a saved block column. Two concrete findings came out of
writing it:

- **`pond` was drawn as a 14 cm curb.** It is a `mass` — the server refuses the tile — but a 14 cm
  pedestal neither reads as a pond nor reads as an obstacle. It now draws a stone rim with the tone
  its own sealed definition declares (`#77b5bd`), water, a lily pad and two reeds. This is not a
  class change: `src/footprints.js` was **not** edited, and the pond stayed a `mass`.
- **A `path` block above layer zero drew a full tile-sized cube** while the server's own column
  collision (`blockLayers` in `src/elevation.js`) ignores a `path` block at *every* layer. The build
  route refuses a path above layer zero ("paths belong on the ground"), so this was unreachable
  through the API — but a legacy or imported row would have been drawn as a solid the movement model
  treats as open. The thin surface is now drawn at every layer, which is what the collision model
  says it is. Reported as a latent hole rather than a live bug.

### 1.3 Atmosphere

- The four phase names are the ones `src/atmosphere.js` publishes. It now exports
  `ATMOSPHERE_PHASES` and builds its cycle from it, and `src/scene/sky.js` keys its light table by
  exactly those names; a test asserts the two lists cannot drift. The published payload is unchanged
  (same keys, same order, same 120-minute cycle, same labels) and the legacy `evening` name still
  resolves to `dusk`.
- **The key light turns with the phase**: each phase owns its sun colour, intensity, height and
  azimuth. At the base commit every phase lit the world from one fixed direction
  (`target.x - 14, height, target.y + 9`), so dawn and dusk cast identical shadows.
- **The shadow frustum is fitted to the window instead of fixed at 24 m.** The widest window the
  renderer builds (a frontier sector's 37 cells) needs a 19.5 m half-extent, so at the same 1024² map
  one shadow texel covers **26.3 px/m instead of 21.3** — 23% sharper contact shadows for zero extra
  memory. The cap is still 24 m and the map is still 1024² (asserted).
- **The depth cue is derived from the fade, not from a fixed pair of distances.** At the base commit
  day fog was `near 28 / far 62` against a window whose far corner is 26 m away — so no geometry was
  ever fogged and the diorama ended in a hard square edge. The band is now computed from the falloff
  the phase wants at the window's far corner: it never starts inside four tiles (the tile underfoot
  and the tiles a resident interacts with carry no fog at all), and nothing inside the window is ever
  more than ~72% faded, so an obstacle keeps its silhouette. A denser phase is a shorter band.
- **Night stays legible.** It darkens the sky and turns the key light to moonlight, but it *raises*
  ambient light (0.92 → 1.05) and exposure (1.12 → 1.20) rather than lowering them, so an obstacle in
  front of a resident is still visible at 03:00.
- **A new `voxel-sky` batch** draws the phase-tinted cloud banks (clouds previously had one fixed
  tint and ignored the phase), a disc in the key light's own bearing with a halo, 44 stars at night
  and a horizon band at dawn and dusk. Every marker is above the resident's head, carries no pick,
  and casts no shadow; an interior room has no sky over it. Because it is its own batch keyed by
  `[world, kind, phase, window]`, a phase change rebuilds the sky and **nothing else**.

### 1.4 Water, vegetation and buildings

- **Water reads as water.** Deep water (all four neighbours water) is drawn darker, water beside land
  lighter, each shore side carries a lighter break, ~half the tiles carry a glide in one of two
  directions, and a shallow tile may grow reeds at its own edge. The bed, slab and surface keep the
  tile's pick, so `instancesAt` stays exactly 3 pickable instances per water tile; glides, breaks and
  reeds carry none. The `fountain` gained a readable water level in both bowl and upper basin.
- **Ground cover and understory.** Meadow and garden tiles carry mottling and seedlings as floor
  decals; tree/outcrop tiles carry a leaf-litter patch and up to three understory tufts at their
  edges, inside their own tile. Nothing carries a pick, and the walkable-tile rule above is what the
  pass is written to. This is where the added cube count comes from (see §4).
- **Buildings.** A boundary wall is now a footed plinth, two courses and a capstone. An authored
  building tile is a stone base, a body, a stepped roof with a door and a lit window on the +y face —
  its top stays at exactly the 1.67 m the manifest records. A cottage gained a plinth, a door lintel
  and window sills, and keeps its 2.60 m silhouette (the chimney is still the high point). A
  `civic-building`, which used to be drawn *identically to a cottage* (the manifest records the sealed
  note claiming geometry the code did not draw), now draws its own civic silhouette — double door,
  window pair, sign board, wide eave, lantern finial — 14 boxes and 2.60 m tall inside its own tile,
  the height of a cottage and taller than anything else the garden palette places. Trees gained a
  wide lower canopy that begins above 1.52 m (so its overhang into a neighbouring tile is over a
  resident's head, never through it), palms gained four fronds and two coconuts, cacti a bloom,
  outcrops a shoulder.

**Not drawn, on purpose:** the four entries the asset manifest marks `specified-not-produced`
(a 2 × 2 `arch.civic-hall`, `arch.canopy-arch`, `veg.hedge-row`, `ui.asset-library-glyph`). Three of
them need a content re-seal and a footprint change, which this task does not own.

### 1.5 Bounds

**None was raised.** `VOXEL_LIMITS` is byte-identical (`radius 18`, `cells 1369`, `objects 260`,
`blocks 2048`, `participants 220`, `height 8`); pixel ratio stays 1.5 and render size 1440 × 900
(now exported as `RENDER_CAPS` and read from there instead of three literals); the shadow map stays
1024² and the shadow frustum cap stays 24 m (`SHADOW_LIMITS`). `tests/render-atmosphere.test.js`
asserts those values, so a future change has to be deliberate.

## 2. Files

Changed (owned): `src/voxel-world.js`, `src/voxel-geometry.js`, `src/atmosphere.js`,
`scripts/voxel-bench.mjs`, `docs/VOXEL_WORLD.md`.
Added (owned): `src/scene/{batch,terrain,water,vegetation,buildings,blocks,parcels,sky}.js`,
`tests/render-obstacles.test.js`, `tests/render-atmosphere.test.js`, `tests/render-scene.test.js`.
Added (this document).

**One file outside the declared ownership had to be touched, and it is the only one:**
`server.js`. Its `files` map is the hand-maintained static route table, and
`tests/content-http.test.js` walks the real browser module graph from `/app.js` and fails on any
module that is not served. A `src/voxel-world.js` that imports `./scene/terrain.js` therefore makes
that test 404 unless the nine new paths are registered. The change is eight mechanical
`files.set('/src/scene/<name>.js', …)` lines in the block that already registers `src/footprints.js`
and `src/elevation.js`, with a comment naming the test that requires them. Nothing else in
`server.js` changed. **`app.js`, `index.html`, `style.css`, `nemo-theme.css`, `src/camera-controls.js`,
`world.js`, `src/footprints.js`, `content/**`, `assets/**`, `package.json`, `scripts/browser-suite.mjs`
and every other file were not edited** (`git status` confirms: 5 modified files, no others).

Not changed, deliberately: `src/footprints.js` (read only — the occupancy classes and the resident
numbers are untouched), `src/camera-controls.js`, and `peopleScene` plus its call site inside
`createVoxelScene.update()`, which a parallel agent owns. `peopleScene`, `peopleVisualKey`,
`PEOPLE_FIELDS`, `renderablePeople` and `refreshPeoplePicks` are functionally identical to the base
commit; the only change near them is that the sky batch is appended *after* the character batch, so
`root.children[0]` is still the terrain group and `root.children[1]` is still the character group.

## 3. Gates and evidence

All commands run in `work/t31` with `export PATH="$PWD/../node-bin:$PATH"` → **Node v24.19.0**.

```
$ npm run check
… 31 × node --check … && node --check src/voxel-world.js && node --check src/voxel-geometry.js …
exit=0

$ npm test
ℹ tests 581
ℹ pass 581
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0

$ npm run e2e
SUMMARY  15 steps passed, 0 failed

$ node scripts/seal-content.mjs --check
Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.
exit=0
```

581 = the 565 baseline + exactly 16 new tests: `tests/render-obstacles.test.js` 6,
`tests/render-atmosphere.test.js` 5, `tests/render-scene.test.js` 5. No existing test was deleted,
skipped or weakened; `tests/voxel-world.test.js`, `tests/footprints.test.js`,
`tests/content.test.js`, `tests/content-http.test.js` and `tests/country-venues.test.js` are
byte-identical to the base commit and pass unchanged. `npm run browser` was also run — see §6.

`npm run check` does not cover the new modules: the syntax gate enumerates files in
`package.json`, which this task does not own. Their syntax was checked explicitly
(`node --check src/scene/*.js`, all clean), and every one of them is imported by `src/voxel-world.js`,
so `npm test` compiles them on every run.

## 4. Measured performance on this machine

**Hardware, named:** Apple M5 (Mac17,3), 10 cores, 8-core GPU, 16 GiB, macOS 26.6.2, Node v24.19.0.
**Fixture, named:** `scripts/voxel-bench.mjs` — the `commons` definition, a **29 × 25 window (725
cells)** with **20 participants**, `RUNS` updates, medians reported. No GPU is involved: this
measures scene construction and batch reuse on the CPU, which is what the renderer does on every 3 s
poll and on every input event.

"Before" is `c753c14` run from a clean `git archive` snapshot of that commit (`/tmp/t31-base`,
removed afterwards); "after" is this branch. Both runs are GPU-free and on the same machine.

| Metric (commons, 725 cells, 20 participants) | before `c753c14` | after task 31 |
| --- | --- | --- |
| total cubes | **1,678** | **2,383** (+42%) |
| draw batches (meshes) | **86** | **98** |
| terrain instances with `cullHidden: false` | 2,000 | 2,691 |
| first build (cold) | 6.2 / 12.0 ms (median of 20, two runs) | 11.4 / 14.0 ms (median of 60, two runs) |
| idle poll, identical payload | 0.2 / 0.2 ms | **0.3 ms** |
| participant poll (presence reorder only) | 0.6 / 0.5 ms | **0.3 ms** |
| character rebuilds per poll | 0 | **0** |
| one-block edit | 0.3 / 0.3 ms | **0.3 ms** |
| terrain rebuilds per one-block edit | 0 / 0 | **0** |
| whole static build (a terrain tile) | 5.9 / 3.3 ms (escape-hatch `before` column 5.5 / 11.3) | 8.4 / 4.7 ms |
| **day-phase poll (new)** | n/a — there was no sky layer | **0.3 ms** |
| **sky rebuilds per 60 phase polls (new)** | n/a | **59 of 60** (the 60th repeats the phase) |
| **terrain/character rebuilds per 60 phase polls (new)** | n/a | **1 / 0** (the first poll returns to an unfiltered snapshot) |

Where the after-column cubes went, from the scene's own layer tally:

| Layer | Cubes | Share |
| --- | --- | --- |
| terrain (base, slab, bridge, garden, tree, fountain) | 1,268 | 53.2% |
| understory | 280 | 11.7% |
| cover (mottling, seedlings) | 209 | 8.8% |
| water (bed, slab, surface, glides, breaks, reeds) | 165 | 6.9% |
| buildings (wall and building tiles) | 120 | 5.0% |
| sky (clouds, disc, stars, horizon) | 58 | 2.4% |
| navigation (portals, gates, pennants) | 52 | 2.2% |
| furniture (scenery objects and terrain furniture) | 23 | 1.0% |

**Reading this honestly.**

- The cost of the visual work is **+705 cubes and +12 draw batches** for this viewport (+42% / +14%).
  Of that, 489 cubes are the ground-cover and understory passes; the sky layer added 58 cubes and
  removed the 12 fixed cloud boxes from the diorama. 2,383 instanced boxes is ≈ 28.6k triangles — not
  a frame-rate concern on any of the GPUs this project targets, and the draw-call count moved from 86
  to 98, still far inside the 130 the renderer test bounds.
- The costs that a *user feels* — the 3 s poll and a one-block edit — did **not** regress: idle 0.3 ms,
  participant poll 0.3 ms, one-block edit 0.3 ms, all with zero unwarranted rebuilds.
- The one new recurring cost is a day-phase change every 30 minutes: **0.3 ms**, rebuilding the sky
  batch alone.
- The **ms columns are noisy on this machine** (a single process, allocation-bound updates, no GPU):
  repeated runs of the *same* tree differ by 2–3× on the cold build and the whole static rebuild. The
  single earlier baseline run of 1.5 ms for the whole static build was one such outlier and is not
  used above. The **cube, instance, batch and rebuild counts are exact and machine-independent**; the
  ms figures are medians of 20–60 updates and should be read as "a few milliseconds", not as
  a precise ratio. This is why the task reports medians from two runs per side rather than one.
- **Not measured:** any frame rate (there is no GPU in this loop and no browser frame timing was
  captured), GPU memory, thermals, concurrent-user capacity, and behaviour on any machine other than
  this Mac.

## 5. Limitations and residual risks

- **The extraction boundary is not the obvious one.** The sealed builders (`tree`, `house`,
  `furniture`) remain in `src/voxel-world.js` because `tests/content.test.js` — not owned by this
  task — pins them there by reading that file's source. If the integration owner wants them in
  `src/scene/`, that test's source scan has to move with them; it is a mechanical change, but it is
  theirs to make, and doing it silently would have weakened a real drift guard.
- **`server.js` had to change** (eight route registrations; see §2). This is a deviation from the
  declared file ownership and is the one thing in this patch a reviewer should look at first: without
  it, the browser module graph 404s and `tests/content-http.test.js` fails.
- **Line-number citations drifted.** `docs/assets/asset-manifest.json` (51 entries) and
  `docs/ASSET_LIBRARY.md` cite `src/voxel-world.js` line ranges (e.g. `house()` at 107–119,
  `blocksScene()` at 222–231) and measured box counts. Those files are not owned by this task, and the
  refactor plus the reworked shapes make those numbers stale: the entries' ids, statuses, licences and
  occupancy classes are still correct, but the line numbers and the measured box counts changed. The
  box counts below were re-measured for this task by counting the instances whose pick resolves to
  that object (`arch.shelter` 7, `veg.flowers` 8, `veg.farm` 9, `veg.trellis` 5, `furn.bench` 4 and
  the thin garden `path` 1 are unchanged):

  | Entry | manifest boxes | now | change |
  | --- | --- | --- | --- |
  | `arch.cottage` | 8 | **12** | + plinth, door lintel, two window sills |
  | `arch.civic-building` | 8 | **14** | now its own silhouette, not the cottage branch |
  | `veg.tree` | 4 | **5–6** | + wide lower canopy (+ an occasional fruit box) |
  | `veg.fruit-tree` | 6 | **7** | one more canopy step |
  | `veg.palm` | 3 | **7** | four fronds and two coconuts instead of two crossed fronds |
  | `veg.cactus` | 3 | **4** | + a bloom |
  | `veg.rock-outcrop` (`mountain`) | 2 | **3** | + a lower shoulder |
  | `furn.pond` | "prop" fallback, 2 | **8** | a rim, water, a lily pad and two reeds |
  | `furn.fountain` | — | **9** | a readable level in both bowls |

  `arch.world-building-tile` and `arch.wall` also changed shape (a plinth/capstone and a stepped roof
  with a door); their tile heights — cottage 2.60, civic-building 2.60, building tile 1.67 — were
  deliberately *preserved*, while the cactus (1.90 → 2.06) and the palm (2.69 → 2.71) grew slightly.
  Measured tops on this branch: cottage 2.60, civic-building 2.60, shelter 2.32, tree 3.91, fruit tree
  3.79, palm 2.71, cactus 2.06, outcrop 1.80, trellis 1.80, fountain 1.44, pond 0.51 (its reeds).
- The renderer's own anti-drift source scan now covers less: `tests/content.test.js` reads
  `src/voxel-world.js`, so a colour added inside a scene module is not checked against the content
  layer. Every tint the scene modules use derives from a family token through `shade`/`variant`, and
  `tests/render-scene.test.js` names the modules and their interface — but a future contributor could
  still introduce a loose hex in `src/scene/`. Worth a follow-up test that scans `src/scene/**` too.
- The fitted shadow frustum is measured geometrically (texels/metre), **not visually**: no browser
  screenshot comparison was made, and no claim is made that the shadows look better, only that the
  budget is spent on a smaller area. Ground-truth creep at the frustum edge (a tall caster just
  outside the fitted extent) was reasoned about but not exercised on screen.
- Fog, sun azimuth and the star field are authored judgements. They were checked for three properties
  (near field clear, window edge faded by the phase's own falloff, nothing fully erased) and by
  running the real browser suite, but they were not reviewed by a person on screen.
- The new ground cover is placed by a deterministic tile hash, not by authoring: two different worlds
  with the same terrain pattern get the same cover. That is deliberate (no new save state, no
  database rows) but it does mean the cover is decoration, not landscape design.
- Coverage numbers: `npm test` went from 565 to 581 tests, all passing, none skipped. During
  development one *existing* `tests/footprints.test.js` assertion failed — its landmark check treats
  any unpicked box above the 0.10 m floor-decal height as an obstacle, which is a rule this task's
  cover pass must also obey. The cover pass was corrected (a seedling drawn 0.111 m tall became
  0.08 m) rather than the test.

## 6. Browser check

`playwright-core` was not present in the worktree (`node_modules` was absent). It was installed with

```
npm install --no-save --no-package-lock playwright-core
```

so **`package.json` and `package-lock.json` are untouched** (`git status` lists neither), and the
shipped suite was then run **unchanged** — no scenario was added, removed or reordered. This is worth
more here than a normal regression run: the browser suite drives the real 3D viewport in Chrome, so it
is the only check that the new `src/scene/**` module graph actually loads and renders in a browser
rather than only under `node --test`.

```
$ npm run browser
SUMMARY  26 passed, 0 failed
  PASS  quest-progression (22742 ms)            PASS  interaction-ambassador-desk (25630 ms)
  PASS  plot-and-blueprints (15911 ms)          PASS  shared-build-and-restart (15025 ms)
  PASS  shared-presence-two-clients (8442 ms)   PASS  interaction-state-refusals (6783 ms)
  PASS  subscription-entitlement-and-revocation (2438 ms)   PASS  first-person-controls (3664 ms)
  …
  result  PASS — the interface was driven in a real browser and the database agreed
```

**One honest note.** An earlier run of the same suite, started while `npm test` and `npm run e2e` were
both running on the same machine, reported `25 passed, 1 failed` — `subscription-entitlement-and-
revocation` timed out waiting for a revoked session to lose its subscription, a flow that touches no
rendering code. On a quiet machine that scenario passes in 2.5 s, and the full suite passes 26/26.
The flake is CPU contention, not this change; it is recorded here rather than hidden.

No browser **visual** comparison was made: the suite asserts behaviour and database state, not pixels.
There is no screenshot diff, no frame-rate capture and no GPU measurement in this task.

## 7. Migration, rollback and gates

- **No schema change, no migration, no content re-seal.** The patch writes nothing to a database, adds
  no table, changes no stored format, and `content/**` is untouched (seal re-verified: 89 definitions,
  3 support files, 42 referenced notices and assets).
- **No new dependency and no re-bundle.** `assets/vendor/three-voxel.js` is unchanged (551,333 bytes,
  SHA-256 `37fe9184…5e88` — `tests/voxel-world.test.js` re-hashes it). The renderer uses only the 27
  symbols that bundle already exposes; the sky disc, stars and horizon band are boxes, not loaders.
- **The server payload is unchanged.** `worldAtmosphere()` returns the same six keys in the same order
  with the same values for the same clock; `src/atmosphere.js` only gained an exported phase list and
  now builds its cycle from it.
- **Rollback** is `git revert` of the single commit, or dropping the branch: every change is
  presentation-only, so no data migrates back. The only file outside the renderer is `server.js`
  (eight static route registrations for the new modules), which reverts with it.
- **Deployment note for the integration owner:** the scene modules must be served with the rest of
  `src/` (the shipped `server.js` now does). An older route table plus a newer `src/voxel-world.js`
  would 404 the module graph — which is exactly what `tests/content-http.test.js` fails on.

## 8. Requirement → evidence

| Requirement | Evidence |
| --- | --- |
| 1. Obstacle truth, through the shared classes, with meaningful per-type assertions | `tests/render-obstacles.test.js` (6 tests): both directions over 8 real worlds, all 27 scenery types, water, saved block columns, ground cover; `src/footprints.js` unchanged. Found and fixed the pond's 14 cm curb; found and closed the thin-`path`-above-layer-zero draw/collision gap |
| 2. Dedicated scene modules, clear interface, reuse and cull preserved | `src/scene/**` (8 modules, table in §1.1); `tests/render-scene.test.js` (5 tests): interface, idle reuse, one-change-one-rebuild, the occlusion cull and layer budget, a finite/colour-valid sweep over 54 authored worlds, the draw-call budget; bench shows 0 character rebuilds and 0 terrain rebuilds per poll |
| 3. Atmosphere: phase lighting, shadows, depth fog, water that reads as water | `tests/render-atmosphere.test.js` (5 tests) + `src/scene/sky.js`, `src/scene/water.js`; the phase list is shared with `src/atmosphere.js`; the key light turns with the phase; the shadow frustum is fitted (26.3 vs 21.3 texels/m at 1024²); the fog band is derived from the window-edge falloff; night raises exposure and ambient light |
| 4. Buildings from the selected family's conventions, nothing invented | `house()` civic branch, cottage plinth/lintel/sills, `src/scene/buildings.js` wall and building tiles; the four `specified-not-produced` manifest entries are still not drawn; every tint derives from a family token |
| 5. Bounds preserved | `tests/render-atmosphere.test.js` asserts `VOXEL_LIMITS`, `RENDER_CAPS`, `SHADOW_LIMITS.map_size === 1024` and the 24 m frustum cap; no bound changed |
| 6. Measured performance, hardware and fixture named, with the gaps stated | §4: before/after from `c753c14` and this branch, Apple M5, 725-cell commons fixture, medians of 20–60; explicitly not measured: frame rate, GPU memory, other machines, capacity |

## 9. For the integration owner

- **`HANDOFF.md` was not touched** (it is on this task's do-not-touch list). It needs one line under
  "Implemented in this release" for schema-21 task 31: the renderer now composes the world from
  `src/scene/**`, the day phase turns the key light and its shadows, the depth cue is derived from the
  window edge, water and buildings are redrawn, obstacle truth is asserted in both directions, and the
  measured cube cost is +42% on the commons fixture with no per-poll regression.
- **`tests/content.test.js` and `docs/assets/asset-manifest.json` are the two places to look next.**
  The first scans `src/voxel-world.js` as source; the second's per-entry line numbers and measured box
  counts are stale for the entries re-drawn here (table in §5). Neither is owned by this task.
- `node_modules/playwright-core` is installed in this worktree (untracked, gitignored) so the browser
  suite can be re-run; `package.json` and `package-lock.json` are unchanged.

## 10. Files, at a glance

```
 M docs/VOXEL_WORLD.md                 (+124)
 M scripts/voxel-bench.mjs             (+38)
 M server.js                           (+6, the only file outside the declared ownership)
 M src/atmosphere.js                   (+25/-14)
 M src/voxel-geometry.js               (+14/-4)
 M src/voxel-world.js                  (+332/-227)
?? src/scene/{batch,terrain,water,vegetation,buildings,blocks,parcels,sky}.js
?? tests/render-obstacles.test.js      (6 tests)
?? tests/render-atmosphere.test.js     (5 tests)
?? tests/render-scene.test.js          (5 tests)
?? docs/handoff/task-31-world-rendering.md
```

The patch is `../task-31-world-rendering.patch` (one commit, `git format-patch -1 HEAD`); it applies
to `c753c14`.

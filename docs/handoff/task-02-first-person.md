# Task 02 — First-person physical world coherence

Branch `task-02-first-person`, stacked on the reviewed task-01 tip (`dc61ad2`). Baseline at that tip:
**353 tests, 0 failures**; syntax gate, e2e harness and content seal green.

The problem: the renderer drew decorative scenery that the server did not treat as occupancy, so a
walking resident could be drawn standing inside a roof, a tree, furniture or a navigation marker.
Walkable/occupancy truth lived in five places that could disagree.

## 1. Reconciliation table (audit of `dc61ad2`)

`B` = blocks the server (`canStep` refuses the tile). `P` = blocks pathfinding (`src/world-walk.js`
`planWalk`). `R` = the renderer implies solidity (geometry inside the drawn resident's standing
column: 0.76 wide, 1.52 tall).

| Scenery / terrain type | walkable (server) | B | P | R at baseline | Baseline consumer lines | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| terrain `water`, `building`, `wall` | no | yes | yes | yes | `world.js:52-55`, `voxel-world.js:142-157` | consistent |
| terrain `tree`, `fountain` | no | yes | yes | yes | `world.js:52-55`, `voxel-world.js:148,156` | consistent |
| terrain `path`, `bridge`, `plaza`, `garden`, `rug`, `floor`, `meadow` | yes | no | no | flat surface only | `world.js:52-55` | consistent |
| objects `tree`, `fruit`, `palm`, `cactus`, `mountain` | **yes on meadow** | only when saved | only when saved | yes (trunk + canopy at body height) | authored: `world.js:121,255,285`; server object rule `elevation.js:9`, `spaces.js:159-160`; renderer `voxel-world.js:66-86` | **D1** |
| objects `cottage`, `civic-building` | **yes on meadow** | only when saved | only when saved | yes (1.8–2.5 m wide house) | authored: `world.js:293`; renderer `voxel-world.js:88-97` | **D2** |
| objects `bench`, `table`, `workbench`, `bookshelf`, `bed`, `boat`, `telescope`, `display`, `sculpture`, `kitchen`, `lamp`, `lantern`, `trellis` | **yes** | no | no | yes (solid furniture at the tile centre) | server list `elevation.js:9`, `world-walk.js:5`; renderer `voxel-world.js:99-128` | **D3** |
| object `pond` | yes | no | no | no pond branch; fell through to a stone pedestal | `voxel-world.js:127` | **D4** |
| object `path` (garden path) | yes | no | no | no branch; drawn as a ~1 m stone pedestal | `voxel-world.js:127`, thin surface in `elevation.js:36-46` | **D5** |
| objects `flowers`, `farm`, `cushion` | yes | no | no | low (< 0.5 m) | `voxel-world.js:108-112,125`, `voxel-world.js:127` | consistent |
| object `gateway` | yes | no | no | not drawn as an object; the portal frame at the same tile is | `world.js:241-242`, `voxel-world.js:127,160-165` | consistent |
| frontier `gate` frame (navigation marker) | yes (passage tile) | no | no | yes — a crossbar spanned the tile at 0.8 m | `voxel-world.js:166-172` | **D6** |
| object `shelter` | yes | no | no | partly — posts at ±1.05/±0.8 sat inside the *neighbouring* tiles and the roof started at 1.585 m | `voxel-world.js:94-95` | **D6** |
| landmark pennant (navigation marker) | yes | no | no | no (pole at the tile edge, flag above the head) | `voxel-world.js:174-177` | consistent |
| country-venue `lantern`, `bench`, `table` vs ambassador stand | stands on plaza | no | no | yes — 5 of 248 stands shared a tile with the drawn furnishing (AFG, BHS, DMA, VEN, ESH) | `world.js:315-317`, `civic-engine.js:22-26,180` | **D7** |
| frontier block columns (all types except `path`) | no | yes | yes | yes (full tile cube) | `elevation.js:36-46`, `world-walk.js:5`, `frontier.js:275-291` | consistent |
| saved garden/cottage objects of the solid four (`cottage`, `tree`, `pond`, `fountain`) | no | yes | yes | yes | `elevation.js:9`, `spaces.js:159-160`, `world-walk.js:5` | consistent |
| arrival and portal tiles | yes | — | — | portal frame only | `spaces.js:196,208-210` | **D8** (nothing checked that the *stored* arrival was still clear) |

Disagreements found, named:

- **D1** authored trees and tree-like scenery stood on walkable terrain (Commons tree belt, district
  and country-venue trees) and were walkable, while the renderer drew a trunk and canopy at body
  height.
- **D2** authored `cottage`/`civic-building` stood on meadow, walkable, drawn as a house that also
  spilled into neighbouring tiles.
- **D3** thirteen furniture types were drawn solid but the server blocked only four object types, and
  only saved ones.
- **D4** `pond` blocked movement but had no drawing, so it rendered as an unrelated pedestal.
- **D5** the garden `path` object was walkable but rendered as a pedestal.
- **D6** the frontier gate crossbar and the shelter posts/roof occupied the standing column of the
  tile and of its neighbours.
- **D7** five country ambassadors stood exactly where a lantern, bench or table was drawn.
- **D8** the arrival tile was taken from stored geometry without checking that the doorway itself was
  still clear (a legacy object on the doorway would place a resident inside it).

## 2. What changed

One shared table now decides occupancy and footprints — `src/footprints.js` (new, 102 lines,
zero dependencies, imported by the browser and the server):

- `TERRAIN_BLOCKING`: `water`, `tree`, `building`, `fountain`, `wall`.
- `SCENERY_CLASSES`: every placeable type, in exactly one class — `mass` (occupies its tile),
  `flat` (ground detail at or below knee height), `frame` (open marker: edge posts, cross members
  above the drawn resident's head). Unrecognised types fail closed as `mass`.
- `RESIDENT_CLEARANCE` 0.38, `RESIDENT_HEIGHT` 1.52, `KNEE_HEIGHT` 0.5, `GROUND_DETAIL` 0.1: the
  numbers the renderer draws to and the tests measure against.
- `solidTileKeys` / `solidSceneryAt` / `standableTile`: the O(1) occupancy index (cached per object
  list) and the tile rule.

Consumers, all reading that table:

- `world.js` `walkable()` now resolves terrain **and** the definition's authored scenery through
  `standableTile`, so an authored solid is a tile the server refuses (fixes D1, D2, D3).
- `src/elevation.js` derives `ELEVATION_BLOCKING_OBJECTS` from `BLOCKING_SCENERY` (22 solid types instead of
  the sealed four) and `blockLayers` uses `blockOccupiesTile`. One-layer step-up, two-layer headroom,
  `maxFall`, `settle` and the `allowAuthoredStepUp` default are unchanged.
- `src/world-walk.js` `planWalk` builds its blocked set from the same index (authored **and** saved
  objects, plus solid ground blocks); a saved object is routed around exactly where the server
  refuses it. `escapeColumns` (moved here from `frontier.js`, one search for both) and
  `nearestClearTile` are also here.
- `src/spaces.js`: `stepAgent` keeps its server-authoritative column rule and now blocks authored
  scenery through `walkable`; `travel` resolves the arrival through the table and falls back to the
  nearest clear tile (D8); `build` refuses a solid object on a resident's tile and refuses a solid
  object that would strand a resident, reusing `escapeColumns` (the frontier's existing trap rule);
  the world snapshot publishes `scenery` with a `blocks` flag.
- `src/frontier.js` uses the shared `escapeColumns`; its placement rules and limits are unchanged.
- `src/voxel-world.js` draws each class as declared: masses fit inside their own tile with roofs and
  canopies raised above the drawn resident's head, `flat` props stay below 0.5 m inside their tile,
  `frame` posts sit in the tile-edge bands with cross members above the head. The `pond` and garden
  `path` objects got honest drawings (D4, D5), and the frontier gate/shelter geometry was corrected
  (D6). `world.js` `makeCountry` moved the lanterns, bench and table off the ambassador plaza (D7).
- `src/camera-controls.js` grew the pointer/keys/intent model: `pointerGesture` (one gesture is a look
  or a pick, never both), `keyIntent`, `controlIntent` (a look intent carries **no** walking
  direction), `createLookScheduler` (one owner; a drag burst coalesces to one request; `send` takes no
  arguments, so a rotation cannot move a resident), `facingLabel` and `reticleText`.
- `app.js` uses those helpers, and adds an accessible aim line: a `<p class="world-reticle">` with
  `role="status"`, `aria-live="polite"`, an `aria-label`, `tabindex="0"`, referenced by the canvas
  `aria-describedby`. It is plain text (no `innerHTML`), states the view mode, compass facing, tile,
  layer, the picked tile with `walkable`/`solid`, and the keys. The same line is repeated in the
  text-fallback world list, and the guide text now documents the controls and that movement is a
  single grid step with no jump.

## 3. What was deliberately not changed

- The terrain collision legend, `path` as a thin non-solid surface, and frontier block semantics.
- Elevation semantics: one-layer step-up, two-layer headroom, `maxFall`, `settle`, stored `z` as a
  cache, and the load-bearing `allowAuthoredStepUp` default (a single authored block is still a wall
  for ordinary movement).
- Land, stewardship, expansion, budget, review, privacy and moderation rules; no schema change, no
  migration, no new dependency, no content-seal change.
- The 2D pixel-map art: it is a top-down map with caption text, not a volume view, so it does not
  claim solidity. The map is the documented fallback and keeps working.
- No jump, no flight, no continuous physics was added; the docs and the in-app notice say so.

## 4. Tests added (all with temporary databases)

- `tests/footprints.test.js` (8 tests): every authored and sealed-palette type is classified once;
  unknown types fail closed; each blocking type is refused by `walkable`, `canStep` and `planWalk`
  and each decorative type is not; the Commons tree belt is occupancy while the crop patches are not;
  every authored world's arrival and portal tiles are clear with a route between them; every country
  ambassador stand is clear; the **real instance matrices** are checked against the class rules for
  all 27 object types it draws plus the portal, gate and landmark-pennant markers; the tile index is stable.
- `tests/world-coherence.test.js` (4 tests): a planned first-person route through the Commons to the
  frontier gateway walked with real server steps, asserting the camera at every stored layer; a
  frontier route plus a refusal to climb over scenery; the server refusing authored scenery and
  allowing the decorative tiles the renderer keeps walkable, with the published `scenery` matching;
  placement traps, occupied tiles, arrival clearance and the legacy-object-on-the-doorway fallback.
- `tests/camera-controls.test.js` grew to 7 tests: gesture partitioning, keyboard mapping, look vs
  move intents, the look scheduler's coalescing/cancellation and "no direction is ever passed to a
  look", the aim-line text and the compass labels.
- `scripts/e2e-smoke.mjs` now reads the published `scenery`, plans the Commons route with solid
  scenery blocked, and proves at the release gate that a solid scenery tile is refused and a
  decorative one is walked onto.

## 5. Honest limits and residual risks

- **No browser automation exists in this repository.** UI verification is HTTP/e2e plus module tests.
  Manual walkthrough (disposable preview, never the installed `outputs/Lucy`): open the world, select a
  character, press `First person`, confirm the aim line reads back the tile and layer, drag to look and
  confirm the character does not move, press WASD/Q/E/R/F, click a tree and confirm the walk is refused
  with a readable notice, and resize to check the aim line wraps.
- A resident already standing on a tile that a legacy object or a newly solid type occupies can still
  step off (only the target tile is checked), and the trap rule protects *existing* routes: it refuses
  a placement that disconnects a resident, and never re-refuses a legacy trap.
- Making furniture solid is a deliberate gameplay change: a resident walks *around* a bench, table or
  lantern instead of through it. Verified routes exist in every authored world, but a resident's
  preferred route will change in furnished rooms.
- The renderer's geometry check uses the drawn box model (0.76 × 1.52 standing column), measured from
  the real instance matrices. Frame geometry passes with as little as ≈15 mm of margin (the frontier
  gate posts at ±0.5 with 0.11 m half-depth against the 0.125 m edge band), so a future prop drawn
  20 mm wider at the tile edge would be caught by the test but would still look tight on screen.
- The `scenery` payload field adds up to ~40 entries per 20 × 14 window; on a busy frontier sector the
  publisher scans the definition's object list per request (≈900 comparisons), which is bounded but
  not indexed.
- Ambassadors hold a fixed stand; only the generator was changed, so an existing database keeps its
  stand coordinates. Every catalog position is now clear in the generated venue, and a test asserts it
  for 40 sampled entries rather than all 248 to keep the suite quick.

## 6. Files, and the four gates

Changed: `src/footprints.js` (new), `world.js`, `src/elevation.js`, `src/world-walk.js`,
`src/frontier.js`, `src/spaces.js`, `src/voxel-world.js`, `src/camera-controls.js`, `app.js`,
`style.css`, `server.js` (serves `src/footprints.js` and `src/elevation.js` to the browser),
`package.json` (syntax gate covers the new module), `scripts/e2e-smoke.mjs`, `tests/footprints.test.js`
(new), `tests/world-coherence.test.js` (new), `tests/camera-controls.test.js`, `docs/VOXEL_WORLD.md`,
`docs/API.md`, `HANDOFF.md`.

Gate evidence on this commit (`node v24.19.0` from `work/node-bin`, `PATH` prepended):

```sh
$ npm run check
> node --check … && node --check src/footprints.js && … && node --check src/placement-policy.js
exit=0

$ npm test
ℹ tests 370
ℹ suites 0
ℹ pass 370
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0

$ npm run e2e
PASS  7. the runtime walks to the frontier, is refused unwalkable terrain and solid scenery, and builds in the assigned plot
        Commons: 200 refused move onto solid meadow scenery (blocked=true, position unchanged); 200 walked onto decorative scenery at 30,9; 200 travel to frontier:0:0; 200 refused move onto an unwalkable solid tree scenery tile (blocked=true, position unchanged); 200 frontier build (plot_id=plot:0:0:5:5, wood at 33,35,z=0); read back from GET /world and GET /land/plot
SUMMARY  10 steps passed, 0 failed

$ node scripts/seal-content.mjs --check
Verified: 86 definitions (20 appearance, 7 block, 29 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.
exit=0
```

The patch is `../task-02-first-person.patch` (one commit, `git format-patch -1 HEAD`); it applies
cleanly to the reviewed baseline `dc61ad2`.

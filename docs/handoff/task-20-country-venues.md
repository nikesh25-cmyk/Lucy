# Task 20 — distinct country venues and world landmarks

Implementation handover for the eight country/area venue variants requested in
[docs/deepseek/TASKS_BATCH_02.md](../deepseek/TASKS_BATCH_02.md) task 20, built from the reviewed
design brief [docs/briefs/task-20-country-venue-variants.md](../briefs/task-20-country-venue-variants.md).

- Branch: `task-20-country-venues`
- Base commit: `0db8f7f` (`verify-batch02-wave-a` — includes the Task 20 brief plus Tasks 01–15, 24 and 27)
- Baseline on that base: **470 tests, 0 fail**; syntax gate green; e2e **15/15**
- After this work: **477 tests, 0 fail**; syntax gate green; e2e **15/15**; browser suite **not run** (see §10)
- Schema: **unchanged at 18** — no migration, no new table, no new column

## 1. What was built, in one paragraph

Eight venue shapes — `terraces`, `satoyama`, `andenes`, `chinampas`, `argan`, `kaya`, `fabod`,
`reef` — are assigned to eight catalog entries (Nepal, Japan, Peru, Mexico, Morocco, Kenya, Sweden,
Fiji) by a frozen pure lookup of the ISO3 code in `world.js`. `makeCountry(iso3)` resolves the
variant and delegates terrain/scenery construction to a per-variant builder; the other **240**
entries run the existing generic `makeCountry` body unchanged. The eight variants use only sealed
terrain types and sealed scenery classes, so `walkable()`, `canStep`, `planWalk`, placement
validation and the renderer all keep resolving through the one table in `src/footprints.js` with
**no new class and no parallel table**. Every variant keeps the public arrival `(20, 25)`, the
return portal `(20, 26)`, the 16 × 16 plaza band at `(12, 8)` and a named landmark, and each venue
is one connected walkable piece.

## 2. Changed files

| File | Change |
| --- | --- |
| `world.js` | +192 / −4. Adds `COUNTRY_COLUMNS`, `COUNTRY_ROWS`, `COUNTRY_VENUE_VARIANTS`, `COUNTRY_VENUE_ASSIGNMENT`, `countryVenueVariant()` and eight private builders; `makeCountry` now resolves the variant, exposes a `variant` field and keeps the generic body for everything else. |
| `tests/country-venues.test.js` | New file, 7 tests (see §8). |
| `docs/VOXEL_WORLD.md` | New "Country venue variants" subsection under *Occupancy and footprints*. |
| `docs/briefs/task-20-country-venue-variants.md` | Status block updated from "design brief only" to "implemented", with a note that no new scenery type was needed and where the renderer checks live. Design text unchanged. |
| `docs/handoff/task-20-country-venues.md` | This file. |

`src/footprints.js` is **unchanged**: no variant needed a new scenery class, so nothing was added to
the shared occupancy table, to the renderer geometry in `src/voxel-world.js`, or to the content seal.
No file outside the owned list was touched.

## 3. The assignment map (frozen, pure lookup)

```js
export const COUNTRY_VENUE_VARIANTS = Object.freeze(['generic', 'terraces', 'satoyama', 'andenes',
  'chinampas', 'argan', 'kaya', 'fabod', 'reef']);
export const COUNTRY_VENUE_ASSIGNMENT = Object.freeze({ NPL: 'terraces', JPN: 'satoyama', PER: 'andenes',
  MEX: 'chinampas', MAR: 'argan', KEN: 'kaya', SWE: 'fabod', FJI: 'reef' });
export function countryVenueVariant(iso3) { return COUNTRY_VENUE_ASSIGNMENT[iso3] ?? 'generic'; }
```

| Variant | Entry | ISO3 | Catalog idx | Ambassador stand | Landmark | Landmark tile | `groundColor` |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| `terraces` | Nepal | NPL | 153 | 21,17 | The Shared Grove | 4,13 | `#9fb39a` |
| `satoyama` | Japan | JPN | 114 | 14,15 | The Mosaic Fields | 12,3 | `#a8bd93` |
| `andenes` | Peru | PER | 171 | 23,18 | The Terrace Flight | 32,0 | `#a89c81` |
| `chinampas` | Mexico | MEX | 142 | 26,16 | The Channel Landing | 29,21 | `#8fb0a4` |
| `argan` | Morocco | MAR | 148 | 16,17 | The Assembly Shelter | 33,5 | `#c9bb92` |
| `kaya` | Kenya | KEN | 118 | 18,15 | The Meeting Clearing | 20,6 | `#8ba884` |
| `fabod` | Sweden | SWE | 214 | 18,21 | The Summer Pasture | 22,4 | `#b3c69b` |
| `reef` | Fiji | FJI | 77 | 25,12 | The Landing | 33,20 | `#8fb3ad` |

Selection is a **pure lookup**, so it is deterministic by construction: same `iso3` → same variant,
on every boot, in every process, with no randomness, no clock and no database read. There is
deliberately **no hash default**: a `seed % 8` default would silently re-shape all 248 venues at
once, which contradicts the rule that unassigned entries keep the reviewed generic shape. Only an
authored, reviewed assignment gives an entry a variant. Both tables and the 9-id list are frozen
(`Object.isFrozen`), and `tests/country-venues.test.js` asserts that a runtime attempt to mutate them
throws.

## 4. The eight variants as implemented

Every venue is 40 × 28, `kind: 'country'`, arrival `(20, 25)`, portal `(20, 26)` "Return to the
Commons". Object counts are measured from the shipped definitions; the renderer bound is 260 objects.

| Variant | Terrain vocabulary | Scenery vocabulary (count) | Objects | Shape |
| --- | --- | --- | ---: | --- |
| `terraces` | meadow, path, farm, plaza | tree×10, pond, shelter, bench (13) | 13 | Three `path` retaining edges (rows 1, 4, 7) with two `farm` beds between; a west-edge grove of `tree` masses; a `pond` tank; a `shelter` + `bench`. Landmark on a grove-edge tile. |
| `satoyama` | meadow, path, farm, plaza | tree×9, pond, shelter, bench, lantern (13) | 13 | A mosaic of `farm` beds on `path` bunds across the north; a `pond` with a `path` on two sides; a west woodland edge; a `shelter` meeting place. Landmark on a bund. |
| `andenes` | meadow, path, farm, plaza | pond, shelter, bench (3) | 3 | Two path-stepped terrace flights (north rows and east columns) rising to a `path` platform; a round `pond` (*qocha*) inside an open eight-tile `path` ring; a `shelter` + `bench` tool store. |
| `chinampas` | meadow, farm, water, bridge, path, plaza | tree×10, boat (11) | 11 | Farmed strips cut by two vertical `water` channels and one cross channel in the east block; two `bridge` crossings; a `path` boardwalk with a moored `boat`. Water-heavy. |
| `argan` | meadow, path, farm, plaza | fruit×37, cactus×6, pond, shelter, bench, lantern (47) | 47 | A wide grid of `fruit` masses (argan analogues); a `cactus` margin along the south edge; one path-stepped terrace with `farm` beds; a `pond` cistern; a `shelter` rest place. |
| `kaya` | meadow, garden, path, plaza | tree×87, bench×4, shelter (92) | 92 | A dense `tree` ring around a `garden`/`plaza` clearing, entered by one south corridor; `bench` ring outside the band; a `shelter` at the clearing's north edge. Depicts only grove, clearing, path and shelter. |
| `fabod` | meadow, path, farm, plaza | shelter, bench, pond, flowers×4, trellis×2 (9) | 9 | An open pasture of `meadow` and `farm` crossed by a wide `path` through-route running the full north–south length and staying unobstructed; a `shelter` hut, a `pond` watering point, `flowers` and `trellis`. |
| `reef` | meadow, water, bridge, path, plaza | boat×2, palm×8, pond, sculpture (12) | 12 | A `water` lagoon across the east third with a `path` boardwalk and a `bridge` landing over the waterline; two moored `boat` hulls; `palm` masses along the shore; a plain original marker post (`sculpture`). Water-heavy. |

Landmarks are navigation pennants with no pick (drawn by the renderer). Their copy describes the
element only; no venue text names a country's practice, people, government or institution, and the
venue `description` keeps the sentence "a NemoWorld research venue for one country or area".

## 5. Shared collision / footprint integration

- Terrain is authored only as sealed terrain types (`meadow, path, plaza, garden, water, bridge, farm`);
  scenery is authored only as existing sealed scenery types, all already classified in
  `src/footprints.js`. `tests/country-venues.test.js` asserts every authored `type` is a key of
  `SCENERY_CLASSES` (nothing fails closed as an unknown `mass`), that `sceneryBlocks` agrees with the
  declared class, and — rendering each venue type through the real `createVoxelScene().update(...)`
  instance matrices — that a `mass` occupies its tile, a `flat` stays inside its tile below
  `KNEE_HEIGHT`, and a `frame` never reaches into a neighbouring resident's standing column.
- **No new scenery class was required.** The brief anticipated this; it held. `src/footprints.js` is
  byte-for-byte unchanged, so `BLOCKING_SCENERY ∪ DECORATIVE_SCENERY` still equals the table's keys,
  `src/elevation.js` and `src/world-walk.js` need no new code path, and the content seal is untouched
  (no `scripts/seal-content.mjs --check` run was required; nothing was added to the palettes).
- The server and the renderer therefore agree through the one table, not through a parallel list: a
  variant cannot make a solid tile walkable or draw a walkable type as solid. Each venue renders
  deterministically (two `createVoxelScene` builds produce identical cube counts).

## 6. Public access and the ambassador's stand

- **Arrival and exit are unchanged** and stay walkable and clear in all eight: `start = (20, 25)` and
  `portals = [{ x: 20, y: 26, name: 'Return to the Commons', targetWorldId: 'commons' }]`.
- **The plaza band is preserved**: all **256** tiles of `(12, 8, 16, 16)` are `plaza` (or the generic
  garden bed), walkable, and free of `mass` scenery in every variant. A shared `countryScenery`
  helper refuses to place any object inside the band or on the arrival/portal approach column.
- Because every stand `(12 + i % 16, 8 + floor(i / 16))` for catalog position `i` falls inside the
  band, **all 248 stands remain valid in every variant** — the test checks all 248 stand tiles per
  variant (1,984 checks), not just the eight assigned ones.
- Entry stays the existing directory rule (a resident in the Commons may `travel` into any
  `country:<iso3>`; the venue's own portal returns it). No new gateway, corridor, frontier sector or
  land parcel was introduced.

## 7. Navigability proof

`tests/country-venues.test.js` runs a cardinal BFS from the arrival over exactly the tiles the server
calls `walkable()` (so it reads the same shared table the server does), for each of the eight
variants, and asserts that the walk reaches:

- every one of the **256 plaza-band tiles**;
- the **landmark** tile (itself walkable and clear), with a `planWalk` route;
- **every portal** (walkable, clear, `planWalk` route);
- every non-solid (flat/frame) scenery object's own tile or a cardinal neighbour;
- and — the strongest form — **every walkable tile**, i.e. the venue is exactly **one connected
  walkable component** with no stranded walkable tile.

Counts measured during implementation (reachable walkable tiles / total walkable tiles):

| Variant | Reachable / walkable | Connections |
| --- | ---: | --- |
| `terraces` | 1108 / 1108 | north terrace bands joined to the spine; grove/pond region open to the band's west edge |
| `satoyama` | 1108 / 1108 | bund rows joined to the spine; pond region open to the band's east edge |
| `andenes` | 1118 / 1118 | east flight touches the band's east edge; *qocha* ring opens into the band |
| `chinampas` | 1058 / 1058 | boardwalk landing opens into the band; two bridges cross the channels; the south land strip joins the islands |
| `argan` | 1077 / 1077 | terrace rows and sparse tree grid leave the spine open |
| `kaya` | 1033 / 1033 | the single south corridor is the one gap in the tree ring; the outside connects around the ring |
| `fabod` | 1116 / 1116 | the wide through-route crosses the pasture end to end |
| `reef` | 822 / 822 | boardwalk + bridge landing span the lagoon; the cross road bridges the waterline |

**What this proves, and what it does not.** This is a *grid* connectivity proof against the server's
walkability rule. The water-heavy variants (`chinampas`, `reef`) are the ones the brief flagged as
highest-risk, and they pass. **Orbit, first-person and text *rendering* of the variants was not
browser-verified by this task** — the browser suite is owned by a parallel task (§10). Text mode is
covered only at the data level: each venue publishes a named landmark and a named return portal, and
`platform.world()` returns the venue's landmark list (asserted) plus the windowed terrain, scenery
and portals the map fallback draws.

## 8. Verification (actual results)

Run from the worktree with `export PATH="$PWD/../node-bin:$PATH"` (Node v24.19.0):

| Gate | Result |
| --- | --- |
| `npm run check` | **passes** (all 30 `node --check` targets, unchanged list) |
| `npm test` | **477 tests, 477 pass, 0 fail** (baseline 470 → +7; the new file) |
| `npm run e2e` | **15 steps passed, 0 failed** (unchanged; country venues are not part of that harness) |
| `npm run browser` | **not run to completion** — `playwright-core` is not installed in this worktree, so the suite exits with `Cannot find package 'playwright-core'`. Not installed: doing so would `npm install` and touch the lockfile. Verified by reading, not by running the screens. |

Generic preservation was checked directly: importing the base-commit `world.js` and the new one and
comparing `terrain`, `objects`, `landmarks`, `start`, `groundColor`, `ambiance`, `name` and
`description` for all 248 entries gives **240 generic entries byte-for-byte identical, 8 assigned
entries changed, 0 unexpected generic changes**.

### New test file — `tests/country-venues.test.js` (7 tests, 0 dependency)

1. **Frozen pure lookup**: the 9-id list and the 8-entry assignment are frozen; every assigned ISO3
   is a catalog entry; every value is a known non-generic variant; an unassigned ISO3, an unknown
   ISO3 and a lowercase/empty value all return `'generic'`; exactly 8 of 248 entries are non-generic;
   runtime mutation throws.
2. **Shared contract**: 40 × 28, `kind: 'country'`, the exposed `variant`; walkable, clear arrival;
   all 256 plaza tiles walkable, clear and a `plaza`/`garden` surface; every object type sealed and
   `< 260` objects; the assigned stand and all 248 catalog stands walkable and clear; a named
   landmark, exactly one named return portal, and the fictional-venue description sentence.
3. **Navigability**: the BFS above, per variant.
4. **Distinctness**: the eight variants have eight distinct `terrain + objects + landmarks +
   groundColor` signatures, each different from the generic shape; the 240 unassigned entries keep
   `variant: 'generic'` and the generic `… research desk` landmark.
5. **Cross-process determinism**: a child `node --input-type=module` run prints the eight venues'
   full definition; two separate processes produce identical output.
6. **Renderer agreement**: every scenery type a variant places is sealed with a class and is drawn
   by `createVoxelScene` obeying that class (mass occupies its tile, flat stays low inside its tile,
   frame leaves neighbours clear); server occupancy matches the drawn class; each venue has
   deterministic cube counts across two builds.
7. **Land inventory unchanged** (fixture): capturing `worlds kind='frontier'`, `frontier_sectors`,
   `frontier_blocks`, `land_parcels` (16,384 gross slots) and `land_stewardships`, resolving all 248
   venues and viewing a venue leaves every count unchanged; no parcel, stewardship, sector or block
   has a `country:%` world id; the bounded `worldList` still excludes `kind: 'country'`.

## 9. Original art — no asset was added or reproduced

Every variant is **100% original NemoWorld geometry**: the variations are authored placements of the
same sealed terrain tiles and the same sealed scenery classes, drawn by the pinned renderer bundle
from instanced flat-coloured cubes. No third-party mesh, texture, audio file or traced design was
downloaded, extracted or integrated, and no message was sent to any institution or person. The
design brief records why no licensed pack is a drop-in (the hash-pinned bundle exports no model or
texture loader), and this task did nothing that would change that decision. The documented
references shape layout, palette and vocabulary only; nothing in a venue depicts, summarises or
speaks for a practice or the communities who hold it.

## 10. What remains unverified

- **No browser verification.** The eight variants were not orbit-, first-person- or text-*rendered*
  in a browser by this task. The browser suite (`scripts/browser-suite.mjs`) is owned by a parallel
  task and could not run here because `playwright-core` is not installed; it was not installed, to
  avoid an `npm install` and lockfile write. The brief's manual orbit/first-person/text walkthrough
  is left for the reviewer.
- **No new asset licence check** was required or performed, because no asset was taken.
- **The brief's open source gaps were not re-read or closed**: the UNESCO World Heritage page for the
  Kenyan Kaya forests and the OECD Fiji governance report both returned HTTP 403 when the brief was
  written, and Nepal is cited to FAO. Those gaps are recorded in the brief §8 and stand unchanged.
- **Cultural review of the living-practice variants is still open** (brief §8 Q8–Q11): who reviews
  the Kenya (`kaya`), Fiji (`reef`), Sweden (`fabod`) and the Indigenous agricultural references, and
  whether any depiction is acceptable at all.
- **Rendering *look* was not measured**: object counts were counted against the renderer's 260-object
  bound, but draw-call/perf figures for the variants were not profiled.

## 11. Limitations and residual risks

- **Eight variants are not 248 unique venues.** 240 entries keep the generic shape, and a variant is
  a **shared shape**: several entries can use one variant, differing only by label, ambassador and
  landmark text. In this first set each variant is assigned to exactly one reviewed entry. Reporting
  the eight as "unique country venues", or as country-specific architecture for a country that has
  none, would be false.
- **The `kaya` variant is the most sensitive.** Per the brief's hard respect rule it depicts only a
  dense grove, one cleared meeting area, a plain path and a shelter, names no practice, offering,
  shrine, elder or site, and is not called "the" Kaya forest. If reviewers judge even this too close
  to a sacred site, the honest fix is to replace it with an ecology-only Kenyan reference, not to
  soften the depiction.
- **The assignment is editorial.** Which eight entries get a variant is a product/editorial decision
  (brief §8 Q8); the mapping is authored and frozen, and changing it is a one-line edit, not a
  data migration.
- **`variant` is an additive definition field.** `getWorldDefinition` merges descriptors and the
  `world()` API view picks explicit fields, and the voxel static-batch key does not include `variant`,
  so the added field changes neither the served venue shape nor renderer rebuilds. A future consumer
  that deep-compares a country definition must tolerate the extra field.
- **`kaya` places 92 scenery objects** (the largest variant) — well inside the 260-object view bound
  but the closest of the eight; a much denser future variant would need to check that bound.
- **The connectivity proof is grid-level.** It does not exercise the camera clamp, the first-person
  step rules, or the aim line; Task 15's browser suite is the place for that.
- **The generic shape is now selected by an explicit `'generic'` variant** rather than being the only
  path. The 240 generic entries are unchanged (verified above), but the code path is a branch now.

## 12. Migration / rollback

- **The database schema did not change** (still **18**). No table, column, index, migration step,
  backup format or recovery check was touched; `worlds` rows, `npc_ambassadors` rows, land records,
  coin receipts, quests and guilds are unaffected. Venues are generated in `world.js`, so nothing is
  persisted for them and no data migration is required to deploy or to revert.
- **Rollback** is a source revert: revert `world.js` (the `variant` field, the tables, the eight
  builders and the delegated branch disappear; the original `makeCountry` body is restored
  unchanged) and delete `tests/country-venues.test.js`. Because the generic body was kept, a revert
  restores the previous 248-venue output with no database action. Reverting only after a deploy is
  safe: the generated venues are not persisted, so the next boot simply renders the old shapes.
- **No installed database or `outputs/Lucy` was touched**; the test fixture uses a temporary database.

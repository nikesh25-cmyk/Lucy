# One global map — design and phase 1 plan

Status: **accepted 15 October 2026; phase 1 is built** (see "Phase 1 as built" at the end for where the build differs from the proposal). It answers the owner's
requirement after the first visual slice:

> the world is too fragmented. there should be one world. one map. one global map. not separate instances.
> the private space and home can be different. but the map needs to be one.

Base: branch `feat/global-map-phase1`, cut from `feat/visual-upgrade-slice-1` at `7eb15fb`, schema 24.
**Phase 1 adds no schema change** (see "Schema" below). Another piece of work owns schema 25 (private
homes and the agent memory vault); this design keeps every table, column, trigger and sealed content file
as it is, and keeps its diff in `src/spaces.js` small so the two merge cleanly.

## 1. What is fragmented today (verified in the code)

| Family | Count | Size | How a resident gets in |
| --- | ---: | --- | --- |
| The Commons | 1 | 96 × 64 | the start world |
| Orchard, Harbor (Stillwater) | 2 | 40 × 28 each | a doorway on the Commons (`regionFacts.door`) |
| Districts (`district:<id>`) | 20 | 48 × 36 each | a portal column on the Commons at x = 25, y = 15 + 2·index |
| Interiors: hall, pavilion, gallery, meditation, library, workshop, observatory | 7 | 20 × 14, 28 × 20, 32 × 24 | a doorway on the Commons |
| Authored venues (`PUBLIC_VENUE_PLANS`) | 5 | 30 × 22 | a doorway on the Commons |
| Country venues (`country:XXX`) | 248 | 40 × 28 | a directory entry, only from the Commons (`travel()`: `directoryEntry`) |
| Frontier sectors (`frontier:x:y`) | 256 | 48 × 48 | the Commons portal at (19, 6), then a gate tile per sector edge |
| Private gardens and cottages (`home:<id>`, `house:<id>`) | one per resident | 32 × 24 / 20 × 14 | a portal |

The 30 shared worlds are the Commons, the 7 interiors, Orchard, Harbor and the 20 districts. A resident is
stored as `(world_id, x, y, z)` and a step off the edge of a world is simply refused: the only ways to
change world are `travel()` (portal within one tile, or the country directory) and the frontier gate
crossing inside `stepAgent`. Every world has its own coordinate origin, its own server event channel
(`events.publish(world_id, …)`), its own chat channel (`messages.world_id`), its own observation query
(`world()`), its own renderer scene key (`definition.id`) and its own minimap (`drawMiniMap`).

Two facts make a global map cheaper than it looks:

1. **The client already holds every authored terrain.** `world.js` is shared by the server and the
   browser, and `getWorldDefinition(id)` generates the same terrain on both sides. Saved state (garden
   objects, frontier blocks, residents, parcels) is the only thing that is per-world on the server.
2. **The Commons already is a map with doors on it.** Every interior and venue already has its doorway on
   the Commons (`gateway` objects at `regionFacts[id].door` and `PUBLIC_VENUE_PLANS[i].door`). "Interiors
   stay as enterable buildings whose door sits on the map" is true today and needs no work.

## 2. The proposal in one paragraph

Introduce a **global tile grid** and a fixed **layout**: one axis-aligned rectangle per *outdoor* world
(Commons, Orchard, Harbor, 20 districts, later the frontier). A **projection layer** converts between a
stored position `(world_id, x, y)` and a global position `(gx, gy)` in both directions. **Storage and
server authority do not change**: an agent row still says `world_id='district:highlands', x=24, y=35`. What
changes is that a step off the edge of a rectangle that touches another rectangle is no longer refused: the
server projects the step into the neighbour, validates it against the neighbour's own definition, and
rewrites `(world_id, x, y)` to the neighbour's coordinates in one write, exactly as `travel()` does but
without a portal. The browser stops treating a world as the unit it loads. It asks the server for a window
of the global map, receives the saved state of every world that window overlaps (translated to global
coordinates), and renders, paths and draws the minimap on a **stitched map definition** whose coordinates
are global. Interiors, venues, country venues, homes and houses remain separate coordinate spaces that
are entered through a door tile that sits on the map.

## 3. The layout

Global coordinates `(gx, gy)`, origin top-left, integer tiles, **derived and never stored**. A layout
revision therefore costs a code change and a test update, not a data migration. (They are shown to people on
the minimap, so treat them as display values and keep them stable once published.)

The final shape is a 288 × 208 world with the Commons in the middle and the 20 districts around it. Phase 1
builds the inner ring only: the Commons and its eight neighbours.

```
        gx:  0      48      96      144     192     240   288
 gy: 0       +-------+-------+-------+-------+-------+-------+
             |  (sea)|  ring-2 districts (phase 2)  | (sea) |      ring 2, north: 4 districts
    36       +-------+-------+-------+-------+-------+-------+
             |ring 2 |corner |HIGH-  |SNOW-  |corner |ring 2 |      corners: 4 districts (phase 2)
             |  W    | NW    |LANDS  |LINE   | NE    |  E    |
    72       +-------+-------+-------+-------+-------+-------+
             |  (sea)|WOOD-  |  T H E  C O M M O N S |FARM-  |      commons: (96,72) 96 x 64
             |       |LANDS  |                       |LANDS  |      west / east districts 48 x 36
   108       +-------+-------+                       +-------+
             |  (sea)| orch- |                       |HARBOR |      Orchard (56,108) 40 x 28
             |       | ard   |                       |(Still-|      Harbor  (192,108) 40 x 28
   136       +-------+-------+-------+-------+-------+-------+
             |  (sea)|corner |COAST  |HARBOR |corner |  (sea)|      south inner row
                     | SW    |       |DISTRICT| SE   |
   172       +-------+-------+-------+-------+-------+-------+
             |  (sea)|  ring-2 districts (phase 2)  | (sea) |      ring 2, south: 4 districts
   208       +-------+-------+-------+-------+-------+-------+
```

Why these numbers fit: the Commons is 96 wide, exactly two districts (48 + 48), so two districts sit on its
north edge and two on its south edge with no gap. It is 64 tall, exactly one district (36) plus one 28-tall
Orchard or Harbor, so the west and east edges are fully used too. Four corner districts then close the
first ring, and ten more districts form a second ring (4 north, 4 south, 1 west, 1 east): 6 + 4 + 10 = 20.

| Rect (phase 1) | Origin (gx, gy) | Size | World |
| --- | --- | --- | --- |
| Commons | 96, 72 | 96 × 64 | `commons` |
| North-west / north-east of Commons | 96, 36 / 144, 36 | 48 × 36 | `district:highlands` / `district:snowline` |
| West / east of Commons | 48, 72 / 192, 72 | 48 × 36 | `district:woodlands` / `district:farmlands` |
| Orchard (below the west district) | 56, 108 | 40 × 28 | `orchard` |
| Harbor (below the east district) | 192, 108 | 40 × 28 | `harbor` |
| South-west / south-east of Commons | 96, 136 / 144, 136 | 48 × 36 | `district:coast` / `district:harbor` |

The district-to-slot assignment is thematic (cold north, water south, fields to the east) and is only data:
it can change without touching storage. Slots are listed in one table in `src/global-map.js`; a test checks
that rectangles never overlap, stay inside the map, and that every pair of touching rectangles has a seam.

**Not on the grid, by decision of the brief:** interiors, authored venues and country venues (doors on the
map, separate spaces), and `home:` / `house:` (private, separate; the projection returns `null` for them and
the observation window never reads them). See the forks in section 9 for the country venues.

### Seams: how two rectangles join

A *seam* is the shared edge of two touching rectangles. The rule for phase 1:

1. **Open border.** For every pair of facing edge tiles, if one is walkable and the other is `tree` (or a
   scenery mass) the blocking side is opened to `meadow` and its scenery removed. A tile is *never closed*,
   so no resident can be stranded by the change. `water` is not opened: the Commons' river meets the
   northern and southern districts at x = 47–49 and stays a river.
2. **One 3-tile avenue per touching edge segment**, painted `path` and joined by the shortest spur to the
   existing road network on both sides (the same `road()` helper the worlds already use). The avenues sit on
   roads the worlds already have, so a walk from a Commons road continues as a district road:
   Commons x 24–26 and 72–74 on the north and south edges (district-local x 24–26 on the other side), and
   Commons y 19–21 (Woodlands, Farmlands), y 49–51 (Orchard) and y 50–52 (Harbor) on the west and east edges.
3. **Clear zone.** No solid scenery, fixture, door, portal or ambassador stand within 3 tiles of a seam on
   either side. Consequence: no interaction fixture ever straddles a seam, so interaction distance, build
   range and the escape rule can stay per-world in phase 1.
4. The pass is deterministic and is applied inside `getWorldDefinition`, so the browser and the server
   cannot disagree about a single tile.

Phase 1 changes only the outermost 3 tiles of the Commons and of the six neighbouring districts. Tile
coordinates inside a world do not move, so every saved position, plot id and saved object stays valid.

## 4. The projection layer (`src/global-map.js`, pure, no DB, no DOM)

```
MAP_LAYOUT                       frozen rect table above
toGlobal(worldId, x, y)       -> { gx, gy } | null        null for interiors, homes, venues, countries
fromGlobal(gx, gy)            -> { world_id, x, y } | null   null over the sea / an unopened sector
neighbourStep(worldId, x, y, direction)
                              -> { world_id, x, y } | null   the tile a step lands on, when it leaves the world
mapDefinition(layoutId)       -> stitched definition: terrain, objects, landmarks, portals in GLOBAL coordinates
mapDistance(a, b)             -> manhattan distance in global tiles when both sit on the map, else null
worldRects(window)            -> the rects a global window overlaps (at most 4 in phase 1)
```

The stitched definition is the trick that keeps the change small. It has the shape every consumer already
understands (`{ id: 'map:core', kind: 'outdoors', columns, rows, start, terrain, objects, portals,
landmarks, groundColor }`), so `walkable()`, `planWalk()`, `voxelWindow()`, `voxelPlan()`, the scene
passes, `drawMiniMap()` and the 2D `draw()` work on it unchanged. `getWorldDefinition('map:core')` returns
it. `map:core` is **not a storable world**: `space()` and every write path still reject it.

## 5. What must change, area by area

### 5.1 Movement (server authority) — `src/spaces.js` `stepAgent`

- Today a step whose target is outside the world is refused by `canStep`. New: if the target is outside the
  world, call `neighbourStep(world, x, y, direction)`. On a landing tile, run the same `canStep` against the
  **landing world's** definition, saved objects and block columns (the agent is evaluated at the virtual
  tile one step behind the landing tile, so the existing one-layer step-up and headroom rules apply
  unchanged), and write `world_id, x, y, z, grounded, last_move, last_seen` in one `UPDATE`.
- Everything else `stepAgent` does stays: the 120 ms throttle, the paused-agent refusal, `verified`,
  the `world_id` the response reports.
- A seam crossing is a world entry for bookkeeping: it calls the same `audit('world.entered')` and
  `recordVisit` as `travel()`, so the journey atlas ("walked, not assumed"), first-play and quests keep
  counting worlds a resident really walked into.
- The existing frontier gate crossing (`frontierGates`) stays as is in phase 1 (frontier is not on the core
  map yet); `travel()` stays for doors, fast travel and the country directory.
- New response flag: `{ …position, seam: true, from_world_id }` so a client can tell "I walked across a
  join" from "I used a door". Additive; existing fields keep their meaning.

### 5.2 Presence events and chat

- `events.publish(world_id, delta)` stays. A new `publishNear(world_id, x, y, delta)` additionally publishes
  to each neighbouring world whose rectangle lies within 18 tiles of `(x, y)` (the voxel window radius), so
  a viewer standing in the Commons sees a resident walking in Highlands without a second connection. Deltas
  still carry local `x, y` and `world_id`; the client projects them. The one `EventSource` per client and the
  4-subscriptions-per-account bound are unchanged. The client re-subscribes to its stored world as it
  crosses; because both sides publish to each other near the seam there is no gap.
- Chat: `public` stays scoped to the stored world (it is labelled with that world's name; see fork 4).
  `nearby` (manhattan ≤ 3) and the private-encounter distance (≤ 6) stop requiring `a.world_id = ?` and use
  `mapDistance`, so two residents either side of a seam hear each other.

### 5.3 The observation window — `world()` in `src/spaces.js`

- New, additive, opt-in: `GET /world?view=voxel&map=core&agent_id=…`. Without `map=` the response is
  byte-for-byte what it is today, so older clients and every existing test see no change.
- With `map=`, the window is a global rectangle centred on the viewer (the same 20 × 14 participant rectangle
  and the same 37 × 37 block window as today). The server computes which rects it overlaps (≤ 4) and runs the
  existing per-world queries on each portion: participants, saved objects, scenery, portals, mayors,
  ambassador residents, frontier parcels and blocks. Rows are translated to global coordinates and each keeps
  its `world_id` and local `x, y` alongside `gx, gy`.
- The 200-participant bound is shared across the portions (viewer first, then `last_seen` descending), so the
  payload budget in `docs/PERFORMANCE.md` is unchanged in the worst case and one query heavier at a seam.
- Access control is per-rect and uses the existing `space(actor, id)` check, and only public shared worlds
  are rects. A private garden or cottage can never appear in a map window (tested).
- `bounds`, `counts.world_agents` and `world.name` describe the world under the viewer's feet, so the place
  card still says "Highlands" or "The Commons"; a one-line "Entering Highlands" notice replaces the arrival
  card (no animation, so reduced motion needs nothing extra).

### 5.4 Pathing — `src/world-walk.js`, `app.js walkTo`

- `planWalk` already takes a definition. Fed the stitched definition and the translated saved objects and
  blocks from the map window, it plans across seams with no change to the algorithm. Limits (`maxSteps` 192,
  `maxVisited` 8192) stay in phase 1; a longer journey is refused with the existing "choose nearby open
  ground" notice.
- `walkTo`'s staleness guard compares `selected().world_id` with the world the walk started in. In map mode
  it compares the **map id**, and the step response's `seam` flag keeps the walk going instead of aborting
  ("changed world").
- `createPortalJourney` (doors) is unchanged: a door is still a portal in a world's definition.
- `escapeColumns`, `nearestClearTile` and the placement escape rule stay per-world: the clear zone around a
  seam guarantees no placement can sit on the seam.

### 5.5 The renderer window across the join — `src/voxel-geometry.js`, `src/scene/*`

- `voxelPlan`, `voxelWindow`, `voxelAnchor`, `detailTier` and the scene's reuse key all work on the stitched
  definition in global coordinates, so a 37 × 37 window can straddle a seam and the level-of-detail radius,
  the occlusion culling (`cellOccludedBelow` reads neighbours "from the retained world terrain") and the
  distant-ground plane behave as they do inside one world.
- One new input: per-tile ground colour. The scene reads `definition.groundColor` for building, tree and
  fountain bases; the stitched definition supplies `groundAt(x, y)` from the rect that owns the tile, so a
  snowy district and the Commons meadow meet without a colour seam in the wrong place. This may add one or two
  colour batches; the budget is 94 of 130 draw calls today and 1,787 of 3,600 instances in the largest room,
  both asserted by `tests/render-scene.test.js`. Phase 1 adds a test that the worst window across every seam
  stays inside `DIORAMA_BUDGET`.
- **Occupancy stays `src/footprints.js`.** The stitched definition holds the same terrain types and the same
  authored scenery; nothing new is added to the footprint table. A test walks every tile of the stitched map
  and asserts `standableTile` on the stitched definition equals `walkable(local, world)` in the owning world.
- Motion: the motion tracker keys on participant id, and positions are now continuous across a seam, so a
  walker glides over the join instead of being re-created in a new world. Under `prefers-reduced-motion` the
  scene still reconciles every confirmed step at once; nothing in the join is animated.
- Picks carry `{ gx, gy, world_id, x, y }`. Every write API (build, interact, place) keeps sending the local
  `x, y` and the exact `world_id`, which the server already checks against the resident's stored world.

### 5.6 Parcel / land registry

Phase 1 has **no frontier land on the core map**, so the registry (`frontier_sectors`, `land_*`, plot ids
`plot:sx:sy:px:py`, grants, stewardship) is untouched. For phase 3 the rule is fixed now: plot ids and every
land row stay keyed by the sector world and local coordinates; the projection adds a derived global address
(`gx = (sx + 8) · 48 + px · 6`) for display and for the renderer, never as a key. The existing guards (public
roads and gateways stay clear, build range 6, the escape rule, the 2,048-block area cap, the action budgets)
stay per-sector, and sector edges are already reserved public passages (rows and columns 23–25), so opening
the sector joins does not touch a buildable plot.

### 5.7 NPC and resident simulation

- Regional guides (`npc_mayors`) patrol inside their own district in local coordinates. They are projected
  for display only; they never cross a seam (their patrol rectangle is inside the clear-zone margin).
- Country ambassadors hold a fixed stand in a country venue: unchanged.
- The living-world residents (`src/living-world.js`, `lw-*`) walk in the Commons only, with Commons-local
  destinations, writing `x, y` directly after a `walkable()` check. They cannot reach the Commons edge (their
  destinations are inside the town), so they need no change in phase 1. Their proximity greeting asks for
  agents in `world_id='commons'`; a visitor standing 2 tiles over a seam in Highlands is not greeted until
  phase 3, when resident planners take global targets and step through the same `neighbourStep` the server
  uses.
- Nothing in phase 1 moves an NPC by a different rule than today.

### 5.8 Minimap and the 2D fallback

- `drawMiniMap(canvas, world, options)` already takes any definition. Fed `map:core` it draws the whole
  192 × 136 inner map. The minimap canvas is 240 × 160, so that is about 1.2 px per tile; the stitched
  terrain is drawn once into the cached offscreen layer as today, and only the viewport rectangle and the
  character dot move over it. Rect outlines and the world's name are drawn on the cached layer, so a
  player sees "you are at the east edge of the Commons, Farmlands begins here".
- The 2D `draw()` is fed the stitched definition and the same 20 × 14 camera, so the pixel renderer shows the
  join with no new code path. This is checked in a real browser with `graphics=pixel`.
- Doors stay markers on the map; fast-travel portals keep their existing markers (fork 3).

## 6. Schema

**None in phase 1, and none needed in phase 2 as designed.** Positions stay `(world_id, x, y, z)`. The layout
is code, not data. Events, chat and observation are queries and in-memory fan-out. The seam visit uses the
existing audit and visit tables. The `worlds.width/height` rows are not changed (the Commons stays 96 × 64,
the districts 48 × 36, so the stored sizes still match the definitions).

Three things I looked at and rejected because they would have required a schema change: persisting a global
position per agent (derivable, and a second source of truth), persisting the layout (a layout edit would
then be a migration), and a `map_regions` table for the frontier join (the frontier registry already knows
its sectors). If a later phase truly needs one (the only candidate is an index for map-wide proximity queries
at much higher populations), it will be written up and held for a decision before anything is built.

## 7. Tests (phase 1)

`tests/global-map.test.js` (pure): layout rectangles never overlap and stay in bounds; `toGlobal` /
`fromGlobal` round-trip for every tile of every placed world; interiors, venues, countries, homes, houses and
unknown ids return `null`; every pair of touching rectangles has a seam; seam tiles are walkable on both
sides and clear within 3 tiles; a tile is never closed by the open-border pass; the stitched definition's
occupancy equals the per-world rule on every tile (the footprints guarantee).

`tests/global-map-runtime.test.js` (real platform on a temporary database): walk Commons → Highlands →
Commons one `moveAgent` at a time with no portal; the stored `world_id, x, y` change at the seam and nowhere
else; a blocked landing tile refuses the step; the 120 ms throttle and the paused-agent refusal still apply;
`world?map=core` straddling the seam returns participants from both worlds with both coordinate systems and
never a private world; a map-less request is unchanged; `nearby` chat crosses a seam; the visit is recorded.

Render: `voxelPlan` on the stitched definition across every seam stays inside `DIORAMA_BUDGET` and the batch
budget; reduced motion and the 2D draw smoke-tested on a straddling window. Existing suites that must stay
green untouched: `render-obstacles`, `render-lod`, `render-interiors`, `footprints`, `world-walk`,
`world-coherence`, `world-places`, `spaces-http`, `frontier-runtime`, `realtime-*`.

Real browser (`scripts/visual-capture.mjs`, a disposable database, a port other than 3000): a signed-in
walker crosses the Commons → Highlands seam, 3D and 2D, with before/after shots and the minimap.

## 8. Phase plan

1. **Phase 1 (this branch, after the owner accepts this design):** `src/global-map.js`, the open-border and
   avenue pass, `stepAgent` seam crossing, `publishNear`, `world?map=core`, the stitched definition in the
   client (renderer, pathing, minimap, 2D), tests, the browser demonstration, `docs/handoff/` note.
   Commons + 6 districts + Orchard + Harbor.
2. **Phase 2:** the four corner districts and ten ring-2 districts (the remaining 14), `walkTo` multi-leg
   routes, a "seam avenue" signpost style, `docs/API.md` for `map=`.
3. **Phase 3:** the frontier continent joined along the south edge (sector joins seamless, parcels shown in
   global addresses), resident planners on global targets, map-wide chat scope.
4. **Door-level work, any time:** a country "Embassy Row" on the map (fork 1), retiring the portal column.

Rollout safety: the server flag `GLOBAL_MAP` gates the seam crossing and the `map=` window (default **on** in
development and in tests, **off** in the shipped configuration until the owner signs off). With the flag off
the worlds are as separate as today and the only difference is a few opened edge tiles.

## 9. Forks that need the owner's decision

1. **Country venues (248).** *Recommended: they stay enterable buildings.* An "Embassy Row" avenue on the map
   (phase 3) gives the directory a physical door, and the 248 research venues keep their 40 × 28 interior
   shape and their ambassadors. The alternative is to make each country land on the map: 248 × 40 × 28 =
   277,760 tiles, more than a third of the frontier, which turns the research directory into a continent.
2. **Do the old doors stay as fast travel?** *Recommended: yes, for now.* The Commons' twenty district
   portals, the Orchard and Harbor doors and the frontier gateway keep working as optional fast travel
   (nothing breaks, tests, journeys and bookmarks keep working), but a district is now also reachable on
   foot. Removing them is a later cosmetic pass once people walk the map. The alternative is to delete them
   in phase 1.
3. **Layout.** *Recommended: the layout in section 3,* thematic slots, Commons in the middle, frontier on the
   south edge in phase 3. Say if you want a different arrangement (for example the frontier to the east, or a
   different district beside the Commons).
4. **Chat scope.** *Recommended: public chat stays per stored world and is labelled with that world's name
   in phase 1; nearby and private-encounter distance cross seams.* A map-wide or radius-based public channel
   is a product decision with moderation consequences and belongs to phase 3.
5. **Border style.** *Recommended: open border plus 3-tile avenues* (section 3). The alternative, avenues
   only with the rest of the border left as it is, is safer but leaves a visible hedge between worlds.

Nothing above needs a schema change. If any answer to 1–5 would, I will stop and write it up instead of
building it.

## 10. Phase 1 as built

Accepted by the owner as written, with the five defaults taken: countries stay enterable venues, the old
portals stay as fast travel, the layout of section 3, per-world public chat, open border plus avenues.

Built: `src/global-map.js` (layout, projection, seam pass, stitched definition, `GLOBAL_MAP` flag),
`src/map-view.js` (the browser's global view), the seam pass inside `getWorldDefinition`, `stepAgent` /
`crossSeam`, `publishNear`, `GET /world?map=core`, nearby chat and private-encounter distance across seams,
the stitched map in the renderer, pathfinder, minimap and 2D view. Tests: `tests/global-map.test.js`,
`tests/global-map-runtime.test.js`, `tests/global-map-render.test.js`. Demonstration:
`scripts/map-capture.mjs`, shots and a crossing log in `docs/handoff/global-map-phase-1/`.

Where the build is not the proposal:

- **Phase 1 includes Orchard and Harbor** as well as the six districts (nine rectangles, twelve seams, eleven
  avenues). The seam between Farmlands and Harbor has no avenue: Harbor's north edge is open water.
- **The open border opens a tree only when there is open ground behind it** (and open ground facing it). The
  proposal opened every tree facing open ground; that left a few single tiles cut off from their own world
  (`world.test.js` caught one in the Harbor district), which a walker could reach only across the seam.
- **The avenue centres are the numbers in `AVENUES`** (global coordinates along the seam), not the tile
  ranges the proposal listed. Orchard's is Commons y 50 and Harbor's y 51, so the Harbor avenue lands on
  Stillwater Harbor's own bridge.
- **`GLOBAL_MAP`** defaults to on except when `NODE_ENV=production`; `GLOBAL_MAP=on|off` overrides either way.
- **The map window carries only the neighbouring worlds** (`map.participants`, `map.objects`), each in its own
  world's coordinates; the stored world's part is the unchanged top-level payload. `mapWindow` reuses
  `world()` for each neighbour (without messages, counts or passage cues) rather than a second set of queries.
- **The 2D view draws `map:core` as one world**, so the per-world pixel themes of Orchard and Harbor (the
  harbor's blue-green ground) are not used on the map; ground colour follows the world that owns the tile.
- **Not done in phase 1 (unchanged from the plan):** corner and ring-2 districts, multi-leg routes beyond 192
  steps, the frontier join, map-wide chat, removal of the old portals.

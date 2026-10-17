# One global map, phase 1 — 2026-10-15

Branch `feat/global-map-phase1`, cut from `feat/visual-upgrade-slice-1` at `7eb15fb` (so on top of
`integration/nemoworld-completed`), built in its own worktree (`work/global-map`). `outputs/Lucy` was never
touched. **No schema change: the schema is still 24**, and nothing of schema 25 (private homes, the memory
vault) was read or written; the diff in `src/spaces.js` is kept small so the two merge. Design, forks and the
owner's decisions: `docs/GLOBAL_MAP.md` (section 10 lists where the build differs from the proposal).

## What the owner can now do

Walk from the Commons into Highlands, and between the Commons and eight neighbouring places, **without a
portal**. The Commons (96 × 64), six districts (Highlands, Snowline, Woodlands, Farmlands, Coast, Harbor
district), Sunmeadow Orchard and Stillwater Harbor are rectangles of one 288 × 208 map. Where two rectangles
touch there is open ground and, on eleven roads, a three-tile avenue that crosses the old boundary. The
stored position is still `(world_id, x, y)`; a step off the edge rewrites it to the neighbour's own
coordinates in one write. Interiors, venues, country venues, homes and cottages are unchanged and stay
separate; the old portals still work as fast travel.

## What changed

- `src/global-map.js` (new, pure): the layout, `toGlobal` / `fromGlobal` / `neighbourStep` / `mapDistance`,
  the deterministic seam pass (open border, clear zone, avenues), `stitchMap`, and the `GLOBAL_MAP` flag
  (on, except when `NODE_ENV=production`).
- `world.js`: `getWorldDefinition` builds the nine worlds through the seam pass (the browser and the server
  get the same tiles) and answers `map:core`, the stitched definition. `drawMiniMap` draws the map's bounds
  and the joins; the 2D `draw` skips tiles of no world and takes ground colour from the owning world.
- `src/spaces.js`: `stepAgent` / `crossSeam` (judged exactly like a step inside the landing world, counted as
  entering it), `GET /world?map=core` (`mapWindow`), presence deltas through `publishNear`.
- `server.js`: `publishNear` on the event hub; the two new browser modules in the static table.
- `src/platform.js`: `nearby` chat and the private-encounter distance count across a seam; `world()` reads a
  nearby message from any world of the map.
- `src/map-view.js` (new, pure) and `app.js`: the followed resident, the neighbours' residents and saved
  objects in global coordinates for the renderer, the route planner (`walkTo`), presence interpolation (a
  walker glides over the join) and the minimap; picks are turned back into a stored world and local tile
  before anything is sent. Entering a world across a seam repaints the scene in place and says "Entering
  Highlands." (no animation, so reduced motion needs nothing).
- `src/scene/terrain.js`: ground colour per tile on the map (`definition.groundAt`).
- Docs: `docs/GLOBAL_MAP.md`, `docs/API.md` (`map=core`, `seam`, `from_world_id`), `docs/PERFORMANCE.md`.

## Rules kept

- **Occupancy** (`src/footprints.js`): not edited. The stitched map holds the same terrain and authored
  scenery; `tests/global-map.test.js` asserts `walkable` on the stitched map equals `walkable` in the owning
  world on every tile of every rectangle, and `tests/global-map-render.test.js` that nothing above knee height
  is drawn on a walkable tile around each avenue.
- **Reduced motion and the 2D fallback:** reduced motion is asserted on a walker crossing a join (it lands on
  the confirmed tile, nothing to animate) and was run in a real browser with the OS preference on; the 2D
  canvas path crosses the seam in a real browser.
- **Budgets:** worst window across any seam 3,309 of 3,600 instances and **111 of 130 draw batches** (a single
  world at its own edge is 87). Batches are the number to watch: two worlds' ground colours are two materials.
  Details in `docs/PERFORMANCE.md`; `tests/global-map-render.test.js` asserts both bounds.

## Real-browser demonstration

Real Chrome, a disposable database, a server on port 3110, `scripts/map-capture.mjs`. A signed-in human stands
on the Commons at (25, 4) and presses the on-screen arrow and the key in turn. Before each press the script
reads the stored position from the database; the log (`docs/handoff/global-map-phase-1/crossing-log.json`)
shows, in every run, the same single change and no other world change:

`commons 25,3 → 25,2 → 25,1 → 25,0 → district:highlands 25,35 → 25,34 → …`

Four runs: 3D desktop, 2D desktop, 3D desktop with `prefers-reduced-motion`, and a 390 px phone. After the
crossing the client reported Highlands as the world it was drawing, still holding the map window, and the place
card, the position readout and the aim line named Highlands and Highlands tiles.
Shots (JPEG, quality 80): `desktop-3d-1b-standing-on-the-edge`, `desktop-3d-1c-zoomed-out-over-the-join` (the
road running across the former boundary), `desktop-3d-2-just-over-the-seam`, the 2D equivalents, and the phone.
The page logged one error, a 401 from a pre-sign-in fetch; there were no page errors.

Reproduce:

```sh
LUCY_DATABASE=$(mktemp -d)/world.sqlite PORT=3110 node server.js
node scripts/map-capture.mjs --url http://127.0.0.1:3110 --database <that sqlite file>
```

(`playwright-core` is not in this worktree; the run used the main checkout's `node_modules` through a symlink,
which is ignored by git.)

## Verification

On Node 24.15 (the repository's runtime): `npm run check` — 103 files, 0 failed. `npm test` — **1,082 of 1,082
pass** (the three new files hold 22 tests: `tests/global-map.test.js` 10, `tests/global-map-runtime.test.js` 7,
`tests/global-map-render.test.js` 5). An earlier run on Node 22 failed `local-launch` (a 49.8 MB download in the
launcher test timed out) and `world.test.js`; the second was a real defect of this work (a tree opened at the
Harbor district's edge was cut off from its own world), fixed in the seam pass and now covered; the first did
not recur.

Real-browser acceptance, focused: `LUCY_BROWSER_ONLY=signed-in-game-play,first-person-controls,interaction-hint-and-distance,game-hud-interaction-prompt-and-aim,hud-visible-while-building,game-shell-entry-and-continue,first-ten-minutes,phone-conversation npm run browser` — 8 passed, 0 failed. **Not run:** the full 45-scenario `npm run browser` and `npm run e2e`; run both before merging, because this work changes `app.js` movement, the world payload, the minimap and edge tiles of nine worlds.

## Follow-ups

- **Phase 2:** the four corner districts and ten ring-2 districts (the rest of the 20), multi-leg routes
  (`walkTo` stops at 192 steps), `docs/API.md` examples for a map client.
- **Phase 3:** the frontier continent along the south edge (parcels shown in global addresses, ids unchanged),
  resident planners on global targets (the living-world residents still stay on Commons-local destinations),
  map-wide chat scope (public chat is still per stored world).
- The Commons' twenty district portals now sit in the middle of a map where the districts are walkable; they
  work, and are a candidate for removal once people use the map.
- The aim line and interaction hints still name doors of the stored world only; a door in the next world over
  is walked to first, then entered.
- The full 45-scenario `npm run browser` and `npm run e2e` were not run (see Verification).

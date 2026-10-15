# Visual upgrade, first slice — 2026-10-15

Branch `feat/visual-upgrade-slice-1`, cut from `integration/nemoworld-completed` at `b5d227f` (five commits
after the `15c5e3d` the brief named: the living-world and visual-polish commits are already in). Built in its
own worktree (`work/visual-slice1`) so the shared checkout and `outputs/Lucy` were never touched. No schema,
memory or vault code was touched; the schema is still 24.

This slice makes the world readable at night and in first person, stops the HUD sitting on top of itself and
on top of the scene, and draws rooms as rooms. It is the first of the visual upgrades; private homes, the
vault and new gameplay content are other pieces of work.

## What changed

**1. Night and first person.** `src/scene/batch.js`, `src/scene/sky.js`, `src/scene/lights.js`.
- Per-face tone and a contact shade on every lit solid, computed in the vertex shader from the world-space
  normal (`FACE_TONES`). A big mass no longer reads as one colour from any camera angle.
- Every phase keeps a key-to-fill ratio of at least 1.4 (day 3.05 : 1.85, night 2.3 : 1.4). Night is lifted,
  not dimmed: pale blue moon, exposure 1.34, and lamps and windows at 1.25 emissive instead of 0.28
  (`resources.setGlow`, a material property that costs no rebuild).
- Lamp light: a halo and two floor pools per lit lamp, additive and unlit, in a new `voxel-lights` batch.
  Empty by day, at most 48 lamps, nearest first. The bundle has no point light and none was added.

**2. HUD overlap** (`game-theme.css`, one block at the end, every rule after the rule it refines).
- Desktop: the transient notice moved below the aim line; the interaction prompt left the left column (where
  it sat on the Step-up, First-person and Look toggles) for the free right column above the target line; the
  move-feedback line lifted above the objective chips; the guide's scroll box fades instead of cutting a line.
- Phone (390 px): the place card is two lines, the aim line one line (the full text is still the live region),
  the minimap smaller, and the guide is one 116 px card you swipe sideways, Dismiss inside the first card,
  every paragraph still reachable by scrolling the card. The prompt sits above the touch pad.
- Nothing is hidden except the decorative "LIVE WORLD" kicker on a phone. The touch stylesheet is untouched.

**3. Rooms** (`src/scene/interiors.js`). Library, workshop, observatory, the four halls and every cottage.
- Walls: plinth, wainscot, rail, plaster, crown; a lit window on every fifth wall tile with frame, mullions,
  sill and a bracket above; framed pictures; stars on the observatory's walls.
- Floors: parquet seams that turn tile by tile, a shaded strip where floor meets wall, a bordered rug with
  inset squares in a colour of its own per room, and concentric rings on the observatory's plaza.
- One palette per room kind, so the rooms no longer share one template. A room has its own warm light
  (`INTERIOR_LIGHTING`), no sky, no distant ground, and its lamps always lit.
- The cottage kitchen has its own builder instead of the generic pedestal (see "Content layer").
- **A bug this exposed:** a cottage reaches the browser as the server's world record, whose kind is `house`,
  merged over the authored definition, so `kind === 'interior'` was false for every cottage and it was drawn
  as an open garden under a daylight sky. `isInterior()` reads the kind *and* the `house:` id, as world.js
  already does for the 2D renderer.

## What was not changed, and the rules kept

- **Occupancy** (`src/footprints.js`): untouched. A wall is still the blocking mass it was and keeps its own
  pick; its details protrude at most 0.10 m into the open tile beside it, except the bracket over a window,
  whose lowest face is 1.92 m. Floor decals are 0.03 m thick and unpicked. Lamp halos start at 1.56 m, pools
  are 0.03 m thick. `tests/render-obstacles.test.js` still passes, and `tests/render-interiors.test.js`
  repeats the walkable-column and unpicked-decoration rules on every authored room.
- **Reduced motion** and the **2D fallback**: untouched. Reduced motion is asserted on every room; the 2D
  canvas path (`world.js`, `draw()`) was not edited.
- **Budgets** (`docs/PERFORMANCE.md`, `tests/render-scene.test.js`): the largest room is 1,787 of 3,600
  instances; the worst batch count anywhere is 94 of 130. Table in `docs/PERFORMANCE.md`.
- **Original geometry only.** Everything is `BoxGeometry` instances written in this repository. The bundled
  three.js was not re-bundled (`PointLight` is not in it, which is why lamp light is geometry).
- **Content layer.** No new furniture type. The kitchen already had a sealed definition whose note said the
  voxel scene used the generic branch; it now has a dedicated case painting its sealed tone `#ae987a`, the note
  was updated and the content re-sealed with `node scripts/seal-content.mjs` (only `kitchen.json` and
  `content-manifest.json` changed; `--check` passes).
- **A latent reuse bug fixed.** The static diorama's reuse key ignored where the viewer stands, so in a room
  smaller than the window the first anchor's level-of-detail decals stayed for good. The anchor is now in the
  key exactly when some tile is coarse; a step inside a fully-fine room still rebuilds nothing (tested).

## Measured, in real Chrome (Google Chrome 155, Playwright, a disposable database, port 3100)

The same 15 shots at 1440 × 900 and at 390 × 844 (2x), before (an untouched export of `b5d227f`, port 3101)
and after. The report counts every painted HUD panel over the scene (clipped to its scroll box) and the pairs
that overlap, and the fraction of the scene covered by their union.

| | Before | After |
| --- | --- | --- |
| Desktop, overlapping panel pairs over 15 shots | 24 (up to 3 in one shot) | **0** |
| Desktop, scene covered by HUD | 28–33 % (mean 30 %) | 28–35 % (mean 31 %) |
| Phone, overlapping panel pairs over 15 shots | 58 (up to 6 in one shot) | **0** |
| Phone, scene covered by HUD | 71–79 % (mean 77 %) | **49–55 % (mean 51 %)** |

Desktop coverage did not fall: the fixes separate panels, they do not remove any, and the prompt and notice now
occupy free space they did not before. The phone is still about half covered by the touch pad, the two button
clusters, the quickbar and the guide strip; getting below that means changing the touch layer, which is not in
this slice. Screenshots are in `docs/handoff/visual-slice-1/` (`before-*` and `after-*`, JPEG at quality 80;
`hud-before.txt` and `hud-after.txt` are the reports above, one line per shot).

Shots: `commons-day`, `commons-night` (first person), `commons-night-orbit`, `plaza-*` (a plaza at night and by
day), `lamp-night-orbit` / `lamp-day-orbit` (a lit lamp, the best look at the glow), and the interiors
`hall-interior`, `hall-interior-night`, `library-interior`, `workshop-interior`, `observatory-interior`,
`cottage-interior`, `cottage-interior-night`.

Reproduce:

```sh
LUCY_DATABASE=$(mktemp -d)/world.sqlite PORT=3100 node server.js          # a disposable database
node scripts/visual-capture.mjs --label after --database <that sqlite file>  # writes docs/handoff/visual-slice-1/
```

The script drives a *running* dev server, registers a throw-away operator over the documented API, signs in
through the real dialog and presses Play. It forces the phase through the world payload, refuses a database
path that looks like an installed or shipped one, and places the player by writing to the database it was
given. `HUD_DETAIL=1` prints every panel and overlap; `DUMP_SELECTOR=<css>` prints a selector's HTML.

## Verification

`npm run check` — 100 files, 0 failed. `npm test` — 1,060 of 1,060 pass (the new files are
`tests/render-interiors.test.js`, 9 tests, and `tests/hud-layout.test.js`, 4). `node scripts/seal-content.mjs --check` passes. The server's static file list
(`server.js`) gained `interiors` and `lights`; a new scene module that is missing from that list is a blank page,
not a test failure.

Real-Chrome acceptance, focused: `LUCY_BROWSER_ONLY=signed-in-game-play,first-person-controls,interaction-hint-and-distance,game-hud-interaction-prompt-and-aim,hud-visible-while-building,game-shell-entry-and-continue,first-ten-minutes,phone-conversation npm run browser` — 8 passed, 0 failed (temporary database, own server). Not run: the full 45-scenario `npm run browser` and `npm run e2e`; the next owner should run the full browser suite before merging, because this slice moves HUD panels and changes one reuse key.

## Follow-ups worth their own piece of work

- Touch layer: the phone is still about half covered. A collapsible pad or smaller cluster is the next gain.
- Furniture is still the original block-out. Rooms now have walls, light and floors, but the library's shelves,
  the workshop's benches and the cottage's bed want real detail, each one a sealed definition.
- Weather and animated water (the survey's remaining items) are untouched.
- A world id the client cannot resolve (`house:sample` written into an agent row by hand) crashes the client
  load rather than falling back; found while building the capture fixtures, not fixed here.

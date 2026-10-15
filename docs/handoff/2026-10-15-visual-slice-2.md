# Visual upgrade, second slice — 2026-10-15

Branch `feat/visual-upgrade-slice-2` (worktree `work/visual-slice2`), cut from `feat/visual-upgrade-slice-1` at `7eb15fb`.
Presentation only: no schema, route, memory or vault change, `src/footprints.js` untouched. The owner judged slice 1
"better but a lot far from where it needs to be"; slice 1 fixed readability, this slice is about richness.

## What changed

- **Moving water.** A vertex wave, shimmer glints and lapping shore foam on the water styles; a gradient sky dome with
  a sun glow; a cloud shadow drifting over the ground. The clock is a uniform (`scene.tick`), so nothing is rebuilt.
- **Weather** (`src/scene/weather.js`): `clear`, `mist`, `rain`, explicit, or published, or taken from the atmosphere's
  own clock in twenty-minute slots so every client sees the same sky. Up to 520 rain streaks and three mist slabs in one
  group with no pick and no shadow, outside the raycast list; a room has none.
- **Ambient loop and reduced motion.** An outdoor scene repaints at most 15 times a second, waits nine paint-times between
  paints when a paint is slow (so it takes a tenth of the time at most), pauses when the page is hidden and skips the shadow-map refresh. Under `prefers-reduced-motion` and inside a
  room it never starts; the clock stays at zero, the water has no wave and the weather is one still frame.
- **Variety** (`districts.js`, `architecture.js`, `buildings.js`, `voxel-world.js`): every district has its own walls,
  roofs, trim, roof shapes, eave heights, chimneys, doors, door-side extras and tree species; cottages, civic buildings
  and pavilions are composed from that and the tile's hash; the commons' building tiles vary in wall, roof profile
  (stepped, gabled, flat with a parapet, hip), windows and awnings; a plain tree is one of seven species (oak, conifer,
  birch, willow, jungle, acacia, orchard). Cottage eaves are capped at 2.2 m: on a one-tile footprint a taller body
  looked like a narrow tower in the first look in Chrome.
- **Draw calls kept in budget.** Variety multiplies colours and a batch is one draw call per colour. A district style's
  lists are capped (three walls, two roofs, two doors), and `shade`/`variant` snap to a 4/255 grid so tones that differ
  by a rounding error share a batch. Worst case over all 20 districts, 20 residents, night, rain: 123 of 130.

## Measured

- `npm run check` — 103 files, 0 failed. `npm test` — 1,070 of 1,070. New: `tests/render-weather.test.js` (7),
  `tests/render-architecture.test.js` measures every style and many tiles against the walking-height and
  neighbour-column rules; `tests/render-interiors.test.js` was adjusted for the colour snap.
- Instances and draw batches before and after, exact and machine-independent: `docs/PERFORMANCE.md`, "after the second
  visual slice". Largest window with weather: 2,630 + 523 of 3,600 instances.
- Real Chrome (1440 × 900 and 390 × 844, disposable database, port 3102): 29 shots at each size in
  `docs/handoff/visual-slice-2/` (`before-*` from slice 1, `after-*` from this branch, JPEG). The HUD report counts
  zero overlapping panels in every shot at both sizes (`scripts/visual-capture.mjs`; the report is printed per shot).
  Weather is forced to `clear` for every shot except `rain-*` and `mist-*`, so the pairs are comparable.
- Full real-Chrome suite (`npm run browser`, this branch): 45 of 45 pass. The first full run had six failures that were
  page loads timing out, because every open page was running the ambient repaint under software WebGL; the loop now
  waits nine paint-times between paints (a tenth of the time at most, one frame a second at the slowest), and the
  rerun was clean. That is a real finding, not only a test artefact: a weak device pays for the loop in proportion to
  what a paint costs it, which is why it is bounded this way. (The `in-game-command-surface` scenario belongs to the
  other branch and is not in this one.)

## Not done

- Furniture detail: `well`, `sundial`, `millstone`, `birdbath`, `sculpture` and `display` still draw the generic prop.
  Each is a sealed definition, so each needs its own builder in `src/voxel-world.js`, a re-seal
  (`node scripts/seal-content.mjs`) and a test that it paints its sealed tone.
- District ground decals (fallen leaves, twigs, shells) are described in `districts.js` (`decals`) but not drawn;
  the style data is there, the pass that scatters them is not.
- Contact shadows under buildings and trees.
- Building the weather into the server (a published `atmosphere.weather`) is supported by the renderer but nothing
  publishes it; today it comes from the clock.
- Merge notes: `server.js`'s scene-module list and `scripts/visual-capture.mjs` are also edited on the
  `feat/in-game-command-surface` branch; the conflict is trivial.

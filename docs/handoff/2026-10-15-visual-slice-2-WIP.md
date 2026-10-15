# Visual slice 2 — work in progress (usage limit reached)

Branch `feat/visual-upgrade-slice-2` (worktree `work/visual-slice2`, off 7eb15fb). NOT finished; not merge-ready.

Done (render tests pass): animated water (`water` style: wave vertices, glints), lapping foam (`foam`), drifting cloud shadow,
rain and mist (`src/scene/weather.js`, deterministic from the atmosphere clock or `options.weather`), sky gradient dome with sun glow,
ambient repaint loop in `createVoxelWorld` (15 fps max, backs off, off under reduced motion / rooms / hidden tab, shadow map not
refreshed on ambient frames), district styles for all 19 districts + commons (`districts.js`), varied cottages / civic buildings /
pavilions (`architecture.js`, measured by `tests/render-architecture.test.js`), capture script extended (new shots, `look`, JPEG).
Baseline "before" shots: `docs/handoff/visual-slice-2/before-*`.

Not done: commons `building` tile variety (buildings.js), tree species / district ground decals / contact shadows (props.js is a
placeholder), furniture detail + sealed builders for well/sundial/millstone/birdbath/sculpture/display (re-seal content),
weather/water tests (`render-weather`), PERFORMANCE.md + VOXEL_WORLD.md updates, after screenshots, full `npm run check` / `npm test`,
reduced-motion check of the ambient loop, final handoff note. First look at district houses in Chrome: roofs/chimneys read well,
but houses are narrow towers (tall bodies) — consider lowering heights.

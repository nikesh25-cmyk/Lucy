# Harr graphics: what changed, how to revert, what is unverified

Goal: a calm, bright, futuristic look. Clean daylight, soft pastel dawn and dusk, a night that stays readable with warm lamp pools, soft shadows and bloom, and a view distance that suits a laptop. Nothing here is combat or danger imagery; two peaceful extras (no weapon trails, no lightning flashes) are part of the look.

The audit behind these choices is in `docs/GRAPHICS_AUDIT.md`. Branches: `graphics/main` in both repositories (worktrees `wt/veloren-graphics` and `wt/nemoworld-graphics`).

**No client or server was built or run for this work** (the machine was busy). Read "Unverified" before trusting any of it.

## 1. What changed

### Client defaults (veloren, `voxygen/src/settings/graphics.rs`)

All in one place. `impl Default for GraphicsSettings` now picks:

| Selection | Result |
| --- | --- |
| nothing set | `GraphicsSettings::vanilla().into_harr()`, the Harr look |
| environment `HARR_GRAPHICS=light` | `vanilla().into_harr_light()`, for slow machines |
| environment `HARR_GRAPHICS=vanilla` | Veloren's own defaults |

`vanilla()` holds the original defaults unchanged, so the diff is easy to read. The value-by-value table (vanilla, the five built-in presets, Harr, Harr light) and the reason for each Harr value are in the audit, section 2 and in the comments of `into_harr`.

Harr look in one line: 10 chunks of terrain, 10 of entities, sprites to 200 blocks (so lit streets stay visible), shadow map at 0.75 (soft and cheaper), soft uniform bloom, clouds Medium, reflections Medium, render scale 0.85, ambiance 0.75 (readable nights), fov 75, half the particles, no weapon trails, no lightning flashes.

Harr light: 6 chunks, Lambertian lighting, cheap shadows, no bloom, clouds Low, render scale 0.7, 30 fps cap, FxUpscale. It keeps the same colours (the shader edit applies to every setting) and the ambiance, and keeps sprites at 125 blocks so lamps still show.

### Shader colours (veloren, `assets/voxygen/shaders/include/sky.glsl`)

Search for `HARR`. Every changed number has its original value in a comment on the same line. Changes:

- Day: lighter horizon haze (`SKY_DAY_MID`, `SKY_DAY_BOT`), whiter sun (`DAY_LIGHT` 3.6, 3.1, 2.3), a less yellow sun halo.
- Dawn and dusk: softer, less saturated (`SKY_DAWN_*`, `SKY_DUSK_*`, `DAWN_LIGHT`, `DUSK_LIGHT`, `SUN_HALO_*`). The old dusk was a hard red-orange.
- Night: deep blue instead of black (`SKY_NIGHT_*` about 4 to 6 times brighter, still dark).
- Moon: brightness 0.14 (was 0.1), colour (0.6, 0.65, 1.4) (was 0.5, 0.5, 1.6). Together with ambiance 0.75 the moonlit scene is about twice as bright as vanilla (0.168 against 0.08 at midnight, before the colour factors).
- Lamp glow colour `GLOW_COLOR` from yellow-green (0.89, 0.95, 0.52) to warm amber (1.10, 0.84, 0.46). This colours every glowing sprite and figure.
- Stars: power 60 (was 50), and 12 on Flat clouds (was 5).

Only constants and comments changed; no shader logic, no new uniforms.

### Lighting plan (nemoworld, data and tool)

- `content/harr-lighting.json`: the plan. Roads (points, spacing, side), porch rule, lit-window rules per building type, targets.
- `tools/gen-harr-lights.py`: reads the plan and the works already in `content/veloren-world-harr.json` and writes the lighting. Idempotent. Run it **after** `tools/gen-harr-works.py` (the works generator rewrites its own groups, and the lights tool reads them).
- Output in the manifest:
  - `lights-<road>-<n>`: 3 or fewer street lamps per group, each on a small light-stone pad with a one-column foundation, built from the first evening (no release delay). 10 roads, about 50 new lamps with the porch lamps, 9 to 10 blocks apart on roads. A lamp pools light about 12 blocks out, so pools overlap.
  - `lights-<project>`: a porch lamp at a building's entrance (the signboard side), only if no outdoor lamp is already within 6 blocks.
  - Lit windows: a `Candle` just inside a window, appended to the **last stage** of the project (so it appears when the building is finished and is never cleared by the plot-clearing first stage). Homes light every window, towers and archives about half, others three quarters.
- Report: `evidence/look/lights.txt` (per-road coverage, per-building porch and lit windows).
- Result: groups 129 to 177 (limit 300), lit sprites 81 to 263 in the Rust checker's count, lit windows 66, every road at least 85% of its length within 8 blocks of a lamp.

## 2. How to use it

- Fresh install: nothing to do. The new defaults apply.
- Existing install: `settings.ron` keeps its stored values, so the look does not change by itself. Either press "Reset" on the graphics settings page (it uses `default()`), or delete the `graphics:` section of `settings.ron`.
- Slow machine: start the client with `HARR_GRAPHICS=light` in the environment (for example in the launcher script) and press Reset, or delete the `graphics:` section.
- Shaders are loaded from `assets/voxygen/shaders`; with the usual asset override they can be hot-reloaded or just need a restart. A syntax slip would show up as a shader compile error at start.
- Regenerating the lights after the plan or the works change: `python3 tools/gen-harr-works.py && python3 tools/gen-harr-lights.py`, then `nemo-world-check content/veloren-world-harr.json`.

## 3. How to revert

| What | Revert |
| --- | --- |
| All client defaults | in `impl Default for GraphicsSettings` return `Self::vanilla()`, or run with `HARR_GRAPHICS=vanilla`, or `git revert` the veloren commit |
| Only the light preset | delete `into_harr_light` and its match arm |
| Shader colours | each changed line says `was vec3(...)`; paste it back, or `git checkout <commit>~1 -- assets/voxygen/shaders/include/sky.glsl` |
| Lighting in the manifest | `git checkout <commit>~1 -- content/veloren-world-harr.json` (or strip the groups whose id starts with `lights-` and the `Candle` ops in the last stage of each project, which is exactly what the tool does at the start of every run) |
| The tool and plan | delete `tools/gen-harr-lights.py`, `content/harr-lighting.json`, `evidence/look/lights.txt` |

## 4. Checks that were run

- `nemo-world-check content/veloren-world-harr.json`: `OK groups=177 blocks=7235 sprites=631 lit_sprites=263 foundation_columns=2497` (before: 129 groups, 81 lit sprites).
- `node --test tests/veloren-*.test.js`: 162 pass, 0 fail (same as before). No test was changed.
- The lights generator is idempotent (the output file is byte-identical on re-runs and after `gen-harr-works.py` then `gen-harr-lights.py`).
- The generator refuses a result that collides with the works, exceeds the manifest limits, or misses the plan targets.
- The Rust edit and the GLSL edit were re-read twice. They were not compiled.

## 5. Unverified (no client or server was run)

1. **The Rust compiles.** `graphics.rs` was edited by hand: `Default` now builds `vanilla()` and applies `into_harr()`; two new methods; `std::env::var(..).as_deref()` matched against `Ok("light")`. This is ordinary Rust but nobody has run `cargo check`. If it fails, the likely spots are the `match` in `default()` and the struct literal in `vanilla()`.
2. **The shaders compile.** Only numbers and comments changed, so a failure is unlikely, but naga/shaderc have not seen the files.
3. **How it looks.** Colour choices come from reading the blend formulas, not from screenshots. Likely things to tune after a first look: night may be a little too bright or too blue; the day horizon may be too hazy; the amber lamp colour is applied to every glow, including lava and glowing mushrooms elsewhere in the world.
4. **Performance.** The Harr preset is Veloren's "Medium" with a few changes, and the light preset is "Low" with a few changes; the machine was never measured. Frame rates are unknown.
5. **Lamp placement on slopes.** Each lamp group measures the ground at one point (`ground_at`) and lamps in a group are at most 16 blocks apart. Each lamp carves two blocks of air above its pad and stands on a one-block pad with a foundation, which copes with small slopes. On a steep slope a lamp may float over a step, or sink into a notch. Not seen in the game.
6. **Road positions.** The roads in the plan are straight lines drawn in the same coordinate frame as the works generator (`plot_offsets`), not Veloren's real generated roads. Lamps may stand beside a footpath rather than on the real road. The positions are data (`harr-lighting.json`); edit and re-run the tool.
7. **Lit windows.** Window sprites do not emit light, so a candle is put on the floor inside. Whether the glow is visible through a Window sprite from outside depends on whether the window blocks the light flood fill; not checked. In the Rust checker's view the sprites are valid and counted as lit.
8. **Candle cells.** The tool picks a free floor cell near each window using the generator's own record of what the works place; cells are never reserved in the game, so a rare collision with something the server places by itself would be rejected and logged in the world record.
9. **Existing installs** keep their old settings until reset (see section 2).
10. **Server dedicated time.** Time of day follows NemoWorld's cycle as before; nothing about time, weather or the atmosphere hours was changed.

## 6. Tuning notes for the next person

- Night too dark: raise `ambiance` in `into_harr`, or `get_moon_brightness` (0.14) in `sky.glsl`.
- Night too bright or too blue: lower `ambiance` toward 0.6, or soften `get_moon_color`.
- Lamps too orange: move `GLOW_COLOR` toward (1.0, 0.9, 0.65).
- A road is dark: lower its `spacing` in `harr-lighting.json` and re-run the tool; the printed coverage per road tells you where.
- More lit windows: raise `fraction`, `cap` or `min` in the window rules.
- Fog is effectively off in Veloren (`fog()` in `sky.glsl` is zero until 5000 blocks). A haze would need a change to that function, which was left alone on purpose.

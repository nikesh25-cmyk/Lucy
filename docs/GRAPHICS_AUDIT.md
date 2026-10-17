# Graphics audit: every lever that does not change the render architecture

Scope: the Veloren client (`voxygen`) and server as they stand on `integration/all` (worktree `wt/veloren-graphics`), used for Harr, the peaceful NemoWorld village. Everything below was read from source. No client was built or run for this audit, so every statement about how something *looks* is a reading of the code, not an observation.

Paths are relative to the veloren repository unless stated.

## 1. Who can change what

| Lever | Where it lives | Client only? | Can the server influence it? |
| --- | --- | --- | --- |
| View distances, LOD, sprite and figure distances, particles, fps, fov, gamma, exposure, ambiance | `voxygen/src/settings/graphics.rs`, per-player `settings.ron` | Yes | Only the cap: `max_view_distance` (server settings, default 65 chunks; larger requests are limited to it) |
| Shadows, bloom, clouds, fluid, reflection, lighting model, AA, upscale, point glow, flashing lights | `RenderMode` in `voxygen/src/render/mod.rs`, in `settings.ron` | Yes | No |
| Sky, sun, moon, glow and star colours; fog | `assets/voxygen/shaders/include/sky.glsl` | Yes (shipped with the client) | No. The server does not send colours. |
| Time of day (which of those colours is active) | `common/src/resources.rs` `TimeOfDay`, synced from the server | Rendered by the client | **Yes.** `server/src/nemo/world/dress.rs` pins `TimeOfDay` every pass to the NemoWorld 120 minute cycle, with the hours set in the manifest `atmosphere` block |
| Weather (cloud density, rain, wind) | server weather grid, `nemo-world-core/src/sky.rs` `Weather::veloren` | Rendered by the client | Partly. The manifest says `weather: false`, so the world stream does not set it; the admin `/weather_zone` command can |
| Block colours (any rgb on `Rock`, `Wood`, `Misc`, `Earth`, `Sand`, `Grass`) | world manifest `fill` ops | No | **Yes.** This is the main way the server shapes the daytime palette |
| Which sprites exist and where (lamps, lanterns, candles, windows) | world manifest `sprite` ops, `ALLOWED_SPRITES` in `nemo-world-core/src/manifest.rs` | No | **Yes** |
| How bright and how far a sprite lights | `Block::get_glow`, `common/src/terrain/block.rs` | Compiled into both | No (a Rust change in `common`, which both sides share) |
| Colour of sprite light | `GLOW_COLOR` in `sky.glsl` | Yes | No. One colour for every glowing sprite |
| Dynamic point lights from entities (`LightEmitter`: colour, strength, flicker, beam) | `common/src/comp/visual.rs`, synced component | Rendered by the client | Yes in principle (an entity can carry one). The world manifest cannot create entities, and the client draws at most 20 (`MAX_LIGHT_COUNT`, `voxygen/src/scene/mod.rs`) within 64 blocks (`LIGHT_DIST_RADIUS`) |

In short: the server decides *when* it is (time of day), *what is built* (blocks, colours, lamps) and *how far the client may look*. The client decides everything about how light and colour are rendered.

## 2. Settings and presets

`GraphicsSettings` (`voxygen/src/settings/graphics.rs`) is read from the player's `settings.ron`. Missing fields take `GraphicsSettings::default()`. The "Reset" button on the graphics page also uses `default()`. The five preset buttons call `into_minimal`, `into_low`, `into_medium`, `into_high`, `into_ultra`.

| Setting | Vanilla default | Minimal | Low | Medium | High | Ultra | **Harr** | **Harr light** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| terrain view distance (chunks of 32) | 10 | 4 | 7 | 10 | 16 | 16 | **10** | **6** |
| entity view distance | 65 (max) | 4 | 7 | 10 | 16 | 16 | **10** | **6** |
| lod distance | 200 | 0 | 75 | 150 | 200 | 450 | **150** | **100** |
| lod detail | 250 | 80 | 180 | 250 | 325 | 400 | 250 | **180** |
| sprite render distance | 100 | 80 | 125 | 250 | 350 | 800 | **200** | **125** |
| figure lod distance | 300 | 100 | 200 | 350 | 450 | 600 | **350** | **200** |
| particles chance | 1.0 | 0.1 | 0.25 | 0.5 | 0.75 | 1.0 | **0.5** | **0.2** |
| weapon trails | on | on | on | on | on | on | **off** | **off** |
| max fps | 60 | 60 | 60 | 60 | 60 | 60 | 60 | **30** |
| fov | 70 | 70 | 70 | 70 | 70 | 70 | **75** | **75** |
| ambiance (moonlight and night light) | 0.5 | 0.5 | 0.5 | 0.5 | 0.5 | 0.5 | **0.75** | **0.75** |
| gamma / exposure | 1.0 / 1.0 | same | same | same | same | same | same | same |
| anti-aliasing | Fxaa | FxUpscale | FxUpscale | Fxaa | Fxaa | Fxaa | Fxaa | **FxUpscale** |
| clouds | High | Flat | Low | Medium | Medium | High | **Medium** | **Low** |
| reflections | High | Low | Medium | High | High | High | **Medium** | **Low** |
| fluid | Medium | Low | Low | Medium | Medium | High | Medium | **Low** |
| lighting model | BlinnPhong | Lambertian | Lambertian | BlinnPhong | Ashikhmin | Ashikhmin | BlinnPhong | **Lambertian** |
| shadows | Map, res 1.0 | None | Cheap | Map 0.75 | Map 1.0 | Map 1.75 | **Map 0.75** | **Cheap** |
| rain occlusion res | 1.0 | 0.25 | 0.25 | 0.25 | 0.5 | 0.5 | 0.25 | 0.25 |
| bloom | Medium, sharp | Off | Off | Medium, sharp | Medium, uniform | Medium, uniform | **Medium, uniform (soft)** | **Off** |
| point glow (halo around dynamic lights) | 0.35 | 0 | 0.2 | 0.2 | 0.2 | 0.2 | 0.35 | 0.2 |
| render scale (`upscale_mode.factor`) | 1.0 | 0.35 | 0.65 | 0.85 | 1.0 | 1.25 | **0.85** | **0.7** |
| flashing lights (lightning) | on | on | on | on | on | on | **off** | **off** |

Notes:

- The vanilla sprite distance of 100 is lower than every preset except Minimal; lamps and lanterns disappear a street away. Harr uses 200.
- Vanilla entity view distance is the maximum (65), which is wasteful for a village.
- Shadow map `resolution` is a multiple of an automatic power of two; lower is cheaper and gives softer edges.
- `ambiance` only scales the moon: `moon_light = get_moon_brightness() * block * ambiance` in `get_sun_diffuse2` (`sky.glsl`). It does not touch daylight.
- `present_mode`, `experimental_shaders` and `profiler_enabled` were not changed.
- Other env switches that exist in the client: `VELOREN_DISABLE_NAGA_SHADERS`. Harr adds `HARR_GRAPHICS` (see HARR_GRAPHICS.md).

## 3. Time of day to light

The sun and moon directions come from `TimeOfDay` (`common/src/resources.rs`):

- `angle = 2*pi * seconds_into_day / 86400`, `sun_dir = (-sin(angle), 0, cos(angle))`.
- So 00:00 is midnight (`sun_dir.z = +1`), 12:00 is noon (`z = -1`), and `z < 0` is day. `sun_dir.x < 0` before noon, `> 0` after noon.
- The shaders use two numbers: `z` (how high) and the sign of `x` (morning or evening palette).

NemoWorld drives it (`dress.rs::atmosphere`, `nemo-world-core/src/sky.rs`): a 120 minute cycle, four phases of 30 real minutes, mapped to the manifest hours for Harr (`content/veloren-world-harr.json`, `atmosphere`): dawn 06:00, day 11:00, dusk 16:00, night 19:00.

| Moment | Veloren hour | sun `z` | sun brightness `max(-z+0.5,0)` | moon brightness, vanilla / Harr | What the shader shows |
| --- | --- | --- | --- | --- | --- |
| Dawn starts | 06:00 | 0.00 | 0.50 | 0.060 / 0.084 | morning palette at full strength, sun on the horizon |
| Mid dawn | 08:30 | -0.61 | 1.11 | 0 | morning palette fading into day |
| Day starts | 11:00 | -0.97 | 1.47 | 0 | day palette (brightest sun) |
| Dusk starts | 16:00 | -0.50 | 1.00 | 0.010 / 0.014 | half day, half evening palette |
| Sunset | 18:00 | 0.00 | 0.50 | 0.060 / 0.084 | evening palette at full strength |
| Night starts | 19:00 | +0.26 | 0.24 | 0.086 / 0.120 | evening fading to night |
| Sun is out of the sky | 20:00 | +0.50 | 0.00 | 0.110 / 0.154 | night |
| Deepest night | 00:00 | +1.00 | 0 | 0.160 / 0.224 | night |
| Before dawn | 04:00 | +0.50 | 0.00 | 0.110 / 0.154 | night |

Pace: dawn (5 game hours), day (5), dusk (3) and night (11) each take 30 real minutes. So sunset (18:00) arrives two thirds of the way through the dusk phase, and the night phase runs a game hour every 2.7 real minutes.

### Constants in `assets/voxygen/shaders/include/sky.glsl`

| Phase | Sky top / mid / bottom | Sunlight colour | Sun halo |
| --- | --- | --- | --- |
| Dawn (morning) | `SKY_DAWN_TOP/MID/BOT` | `DAWN_LIGHT` | `SUN_HALO_DAWN` |
| Day | `SKY_DAY_TOP/MID/BOT` | `DAY_LIGHT` | `SUN_HALO_DAY` |
| Dusk (evening) | `SKY_DUSK_TOP/MID/BOT` | `DUSK_LIGHT` | `SUN_HALO_DUSK` |
| Night | `SKY_NIGHT_TOP/MID/BOT` | `NIGHT_LIGHT` (only matters near the horizon) | none |

How they are blended:

- `get_sun_color()` = `mix(mix(twilight_light, NIGHT_LIGHT, max(z,0)), DAY_LIGHT, max(-z,0))`. `twilight_light` is `DUSK_LIGHT` when `sun_dir.x > 0`, else `DAWN_LIGHT`.
- `get_sky_color()` (average sky) and `get_sky_light()` (per direction) mix top, mid and bottom the same way. Night stays blended in with `pow(max(z,0), 0.2)` so it arrives early.
- Sun disc and halo: `SUN_SURF_COLOR` (1.5, 0.9, 0.35) x 10, `SUN_COLOR_FACTOR = 5.0`.
- Moon: `get_moon_color()` and `get_moon_brightness()`; disc `MOON_SURF_COLOR`, halo `MOON_HALO_COLOR`; `MOON_COLOR_FACTOR = 5.0`. The scene uses the sun's opposite as the moon direction for lighting (a deliberate hack, see the TODO in `get_sun_diffuse2`).
- Ambient light: `SUN_AMBIANCE = MU_SCATTER` (0.05, 0.10, 0.23); `MOON_AMBIANCE = (0.15, 0.25, 0.23) * 5` ("real nights are too dark to be fun", per the source comment).
- Fog: `fog()` is `max(1 - 5000/(1+dist), 0)`. That is zero for the first 5000 blocks, so **there is effectively no distance fog**. Distance is hidden by LOD terrain and the sky, not by haze. Fog is not a usable lever without changing that function.
- Stars: `is_star_at()`: `power * max(sun_dir.z, 0.1) / (1 + pow(dist*750, 8))`, with `power` 50 normally and 5 when clouds are `Flat` (so the Minimal preset has almost no stars). Stars are drawn in every cloud mode (the Flat path goes through `get_sky_light` with the weak power), and the source notes they can flicker under FXAA.
- Cloud tint: clouds are shaded in `include/cloud/regular.glsl` from `get_sun_color()`, `get_moon_color()`, `get_sky_light()` and a Rayleigh colour `(0.025, 0.1, 0.5)`. Changing the sun and sky constants therefore tints the clouds too. Cloud *density* comes from weather (server).
- Tonemapping: `postprocess-frag.glsl`: `1 - exp(-colour * (exposure + 1.0))`, then `pow(colour, gamma + 0.3)`. The `gamma` and `exposure` player settings feed it.
- Bloom: `BloomMode`/`BloomFactor` (Low 0.1, Medium 0.2, High 0.3 or a custom 0..1 of output luminosity); `uniform_blur` spreads it more evenly. Post-process mixes it in at `BLOOM_FACTOR`.

## 4. Lamps and lantern light

- A sprite emits light if `Block::get_glow` (`common/src/terrain/block.rs`) returns a level. Levels: `StreetLamp`, `StreetLampTall`, `BonfireMLit`, `Lantern`, `LanternpostWoodLantern`, `LampMetalShingles{Red,Cyan}` = 24; `WallLamp*`, `WallSconce`, `FireBowlGround`, `MesaLantern`, `LampTerracotta`, `Candle` = 16; `Window*` sprites = none.
- The level is flood-filled into the chunk light map (it falls by one per block, `MAX_LIGHT_DIST = SUNLIGHT`). The terrain shader adds `glow_light(f_pos) * (pow(f_glow,3)*5 + pow(f_glow,2)*2)` with `f_glow = level/31.5` (`terrain-frag.glsl`). Reading those numbers: a level 24 lamp still lights ground clearly about 12 blocks away; a level 16 candle about 6.
- The *colour* of every glowing sprite is the single constant `GLOW_COLOR` in `sky.glsl`, multiplied by a slow noise flicker when shadows are on (`glow_light`). The flicker is skipped on `ShadowMode::None`.
- Sprites are only drawn within `sprite_render_distance`, and their level of detail steps down at 50% and 75% of it (`voxygen/src/scene/terrain/mod.rs`). Their *light* is baked into the terrain mesh, so it is visible even where the sprite is not.
- A light sprite can be switched off per block with the `LightEnabled` attribute; the manifest cannot set it.
- `watcher.rs` counts sprite lights separately from "minor" lights (lit blocks, sampled to 64 per chunk). Entities can have a real point light (`LightEmitter`); the cap is 20.
- Lights cost mesh time per chunk (`mesh/terrain.rs` scans the chunk plus a `MAX_LIGHT_DIST` border for glow blocks), not per frame. More lamps cost little at run time.

## 5. Things that look like levers but are not (without a render change)

- Real fog, a sky gradient driven by the server, per-lamp colour, per-lamp radius, coloured windows that glow: not available. Any of them means a shader or `common` Rust change.
- `LightingMode`, `AaMode`, `CloudMode` are enums that pick compiled shader variants. They are levers, but a change to a variant shows after shaders recompile at start.
- `experimental_shaders` (cinematic, color quantisation, etc.) were left alone.
- The server cannot send graphics settings to a client. Anything that must apply to every player has to ship in the client files (`settings.rs` defaults, shader constants, an assets pack) or in a launcher environment variable.

## 6. What the Harr look changes (summary; details and revert steps in HARR_GRAPHICS.md)

1. Client defaults: `GraphicsSettings::into_harr` and `into_harr_light` (graphics.rs), selected in `Default`.
2. Shader colours: the `HARR` constants in `sky.glsl` (sky, sunlight, moon, stars, lamp glow colour).
3. Server data: `content/harr-lighting.json` and `tools/gen-harr-lights.py` (lamp spacing, porch lamps, lit windows) in the NemoWorld repository.

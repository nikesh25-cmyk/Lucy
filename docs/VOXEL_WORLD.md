# NemoWorld voxel view

The world now has a real WebGL 2 scene: block terrain, deep and shallow water with shore breaks, trees with a canopy and understory, stepped roofs, detailed cottages and civic buildings, furniture, navigation gateways, a day-phase sky with a fitted shadow frustum, distance fog, clouds, and block characters. The models are original code, untextured flat-shaded cubes from one palette. No Minecraft assets, logos, or textures are used.

The terrain uses the same deterministic world definitions as server movement. Saved frontier blocks use their exact server coordinates and layers. A ground path is a thin surface at every layer; solid blocks occupy their full layer. What the renderer draws as an obstacle is exactly what the server refuses, in both directions, and that agreement is asserted by tests rather than assumed — see [the visible-obstacle rule](#the-visible-obstacle-rule-and-the-tests-that-hold-it). Human players and agents are rendered from the world snapshot, each drawn at its own elevation layer. Decorative scenery never represents a fabricated live participant.

The shared frontier has a defined land registry: a 16 × 16 grid of areas, each 48 × 48 virtual meters, divided into an 8 × 8 parcel grid. That is 16,384 gross 6 × 6 virtual-meter slots, including public roads and protected terrain. Registry slots, available parcels, assigned stewardship and opened areas have separate meanings. See [Land and stewardship](LAND_WORLD.md) for their permissions and limits.

Humans can create accounts, sign in and enter as a human player. Agents can inhabit the same spaces through their own scoped runtimes. Both can build authorized places and help open adjacent areas within the finite perimeter. A parcel’s purpose and stewardship describe its application use; this renderer does not issue property rights, take payments or turn land into an investment product.

## Occupancy and footprints

`src/footprints.js` is the one table that says what a tile holds, and every consumer reads it: `walkable()` in `world.js`, `canStep`/`blockLayers` in `src/elevation.js`, `planWalk` and `escapeColumns` in `src/world-walk.js`, placement validation in `src/spaces.js` and `src/frontier.js`, and the drawing code in `src/voxel-world.js`. A scenery type is declared in exactly one class:

| Class | Occupancy | Server rule | Renderer |
| --- | --- | --- | --- |
| `mass` — cottage, tree, fruit, palm, cactus, mountain, pond, fountain, bench, table, workbench, bookshelf, bed, boat, telescope, display, sculpture, kitchen, lamp, lantern, trellis, civic-building | occupies its tile at resident height | not walkable, routed around, refused on an occupied tile, refused when it would strand a resident | a tile-sized solid; roofs and canopies rise above the drawn resident's head so a neighbour is never inside them |
| `flat` — flowers, farm, cushion, the garden `path` object | ground detail no higher than knee height, inside its own tile | walkable | low ground cover a resident stands among |
| `frame` — gateway, shelter, portal and gate frames | open marker | walkable | posts in the tile-edge bands and cross members above the drawn resident's head, so a resident walks through |

An unrecognised scenery type fails closed as a `mass`, so a new or legacy type can never be silently passable. Terrain keeps its own collision legend (`water`, `tree`, `building`, `fountain`, `wall` are blocked; `path`, `bridge`, `plaza`, `garden`, `rug` and `floor` are walkable), and a frontier block column is a solid layer unless it is the thin `path` surface.

The shared table is why a resident is never drawn inside scenery: a type that the renderer draws as solid is a tile the server refuses, a type drawn as ground cover is a tile the server allows, and a marker is drawn so that its frame leaves the standing column clear. Tests in `tests/footprints.test.js` assert both directions for every type, assert that the real instance geometry obeys the class it declares, and assert that every authored world keeps its arrival and portal tiles clear with a route between them. `tests/world-coherence.test.js` walks a planned first-person route through the Commons and into a frontier area with real server steps and asserts the camera at every stored layer.

### Country venue variants

Eight of the 248 `country:<iso3>` research venues render a reviewed variant shape — `terraces`, `satoyama`, `andenes`, `chinampas`, `argan`, `kaya`, `fabod` and `reef`; the other 240 keep the generic shape. The variant is chosen by a frozen, authored lookup of the ISO3 code in `world.js` (`countryVenueVariant`), so the server and the browser resolve the same venue with no hash, clock or database read, and two loads are identical.

**The variants add no scenery type.** Each is built only from the sealed terrain types and the sealed `mass` / `flat` / `frame` classes in this table, so no class, renderer geometry or content-seal entry changed and the one occupancy table above remains the single source of truth: a variant cannot make the server and the renderer disagree. Every variant keeps the 16 × 16 plaza band at `(12, 8)` fully walkable, clear of `mass` scenery and a `plaza`/`garden` surface, so any of the 248 ambassador stands stays valid, and the public arrival, the return portal, the landmark and the plaza band stay in one connected walkable component. These are fictional NemoWorld spaces inspired by documented ecological or cultural practices, not representations of territory, a government or a people, and the eight variants are shared shapes, not 248 unique venues. `tests/country-venues.test.js` asserts the assignment, the plaza clearance, the connected walkable component, the renderer agreement and the unchanged land inventory.

The world snapshot publishes the same resolution: `scenery` lists the authored tiles inside the returned window with a `blocks` flag, so an API client, an agent or the release acceptance harness reads the occupancy the server enforces instead of re-deriving it.

### The visible-obstacle rule, and the tests that hold it

The table above decides what the renderer may draw where, and the renderer is measured against it from
the drawn instance matrices, not from its own intent:

- **A walkable tile carries nothing between the knee and the head.** Geometry may stand beside the
  standing column (a frame post, a landmark pole), at or below the knee (crop rows, flowers, a floor
  decal) or above the head (a roof, a canopy, the cloud layer) — never in the column a resident
  occupies.
- **A tile the server refuses is drawn as an obstacle.** Every `mass` type, every blocking terrain
  type and every solid block column fills its own standing column from the ground up. The one
  declared exception is `water`: it is refused, and it is drawn as a water surface below ground level
  rather than as a wall.
- **Untargetable decoration stays a floor decal.** Anything the renderer adds that carries no pick —
  ground cover, glints, shore breaks, the parcel overlay — stays at or below 0.10 m on walkable
  ground, or entirely above the resident's head.

`tests/render-obstacles.test.js` asserts all three directions over the real authored worlds, over
every type in the table, over water and over saved block columns. That is the acceptance evidence for
"visible obstacles correspond to actual obstacles": a drift in either direction fails a test, not a
screenshot.

## Scene modules

The renderer is composed of small modules with one responsibility each. `src/voxel-world.js` keeps
the sealed builders, the palette, the public factory and the reuse policy; everything about *where a
thing stands in the world* lives under `src/scene/`:

| Module | Responsibility | Interface |
| --- | --- | --- |
| `src/scene/batch.js` | Instanced batches, one per colour and material style; the batch primitives, the style vocabulary (including the unfogged `haze`/`star`/`sun` styles), and the deterministic palette helpers `hash`, `variant` and `shade` | `createResources()`, `cubeBatch(resources)` → `{ add, finish, size }`, `disposeBatch(batch)`, `SHADOWLESS_STYLES` |
| `src/scene/terrain.js` | The ground diorama: base cubes with the whole-node cull, surface slabs, bridges, wall and building tiles, garden cells; portal frames, frontier gate frames, landmark pennants | `groundPass(context)`, `portalFrames`, `gateFrames`, `landmarkPennants`, `layer(batch, layers, name, run)` |
| `src/scene/water.js` | Water as water: depth classification, the surface with its pick, glides, shore breaks, marginal reeds; the basin a `pond` or `fountain` holds | `waterDepth(typeAt, x, y)`, `shoreSides`, `waterTile(batch, spec)`, `waterBasin(batch, spec)`, `WATER_TINTS` |
| `src/scene/vegetation.js` | Ground cover and understory, placed by the occupancy rule above | `groundCoverPass({ batch, plan, layers })`, `COVER_TINTS`, `COVER_HEIGHT_LIMIT` |
| `src/scene/buildings.js` | The two building *tiles* of the authored terrain: a boundary wall and a world building cell | `wallTile(batch, spec)`, `buildingTile(batch, spec)`, `BUILDING_TINTS` |
| `src/scene/blocks.js` | Saved frontier blocks, batched apart from the diorama | `blocksScene({ resources, definition, plan, colors, cubeBatch, withParcel })` |
| `src/scene/parcels.js` | The stewardship overlay (edges, hover, selection, protected lanes) | `parcelScene({ resources, plan, selection, hover, cubeBatch, parcelSelection })` |
| `src/scene/sky.js` | The phase light, the shadow frustum, the depth cue and the far sky layer | `SKY_PHASES`, `SHADOW_LIMITS`, `phaseLighting(name)`, `resolvedPhase(name)`, `fogFor(entry, distance)`, `sunPlacement`, `shadowExtent(plan)`, `shadowResolution(extent)`, `applyPhase(spec)`, `skyScene(spec)` |

The sealed builders (`tree`, `house`, `furniture`) and the character builder stay in
`src/voxel-world.js` on purpose: `tests/content.test.js` reads that file's source to prove every
sealed definition is drawn by a named builder that paints the colour and emissive tone the definition
declares. The scene modules receive them as `builders`, so the composition can move without moving
the grammar, and every tint a scene module uses is derived from a colour the family already owns
(`shade`, `variant`) rather than a new token.

## Level of detail

The drawn window is one square of terrain around the resident the camera follows, and the renderer
reads only the tiles close to that resident at full detail. `LOD_LIMITS.detail_radius` (12 tiles,
`src/voxel-geometry.js`) is the radius; `voxelPlan` resolves the tile the resident stands on as
`plan.anchor` and carries the radius as `plan.detailRadius`, and `detailTier(x, y, anchor, radius)`
answers `fine` or `coarse` from the *Chebyshev* distance between them.

What stops at the radius, and what never stops:

| | inside the radius | beyond it |
| --- | --- | --- |
| A cell's surface slab, its underground base cube, its terrain type detail, its pick | drawn | drawn, unchanged |
| Water: the bed, the sub-surface slab, the surface and its pick | drawn | drawn, unchanged |
| Authored and saved scenery, frontier blocks, portals, gates, landmark pennants | drawn | drawn, unchanged |
| Ground cover, understory litter and tufts, water glints, shore breaks, reeds | drawn | not drawn |
| The plot overlay, the sky layer, the distant backdrop | drawn | drawn, unchanged |

The rule is deliberately narrow, and the reason is the one the visible-obstacle rule already states:
everything that stops is *unpicked decoration*, at or below the knee, drawn by a pass that can only
change how a tile's ground reads. Every dropped instance is proven to be unpicked, on a coarse tile
and below `KNEE_HEIGHT` by `tests/render-lod.test.js`, and the two-way obstacle rule is re-asserted
over the coarse ring itself, so a tile the server refuses is still drawn as an obstacle and a walkable
tile still carries nothing between the knee and the head. `src/footprints.js` is untouched by the
rule: it changes what is drawn, never what is occupied, and a rendered tile is still exactly the tile
the server allows or refuses.

Two properties make it a scale rule rather than a trim. First, **the near field is byte-identical**:
every instance inside the radius is the same instance matrix and the same pick with the rule on and
with it off, which `tests/render-lod.test.js` asserts over four authored worlds. Second, **the
decorative cost is bounded by the radius, not by the window**: at most
`(2 * detail_radius + 1)² = 625` cells are ever read at full detail, so the decoration term does not
grow when the window grows, while the per-cell floor (a surface slab and, where it is exposed, a base
cube per cell) inevitably does. Measured by `scripts/voxel-bench.mjs` on the largest viewport the
server can request — a frontier sector's 37 × 37 window, 1,369 cells, with the twenty drawn residents
the benchmark places — that is **3,273 → 2,729 instances** and **746 → 300 decorative instances**
(60% less decoration, and 288 of the 725 Commons cells stop being read closely against 744 of the
1,369). The worst frontier sector in the tree draws **3,228 → 2,367 instances** with no residents at
all. The batch (draw-call) count does not move, because a batch is one mesh per colour and material
style rather than per tile.

`lod: false` on a scene update is the documented escape hatch: it restores the pre-LOD build exactly
(`plan.detailRadius` is `Infinity`, every cell is `fine`), which is how `scripts/voxel-bench.mjs` and
the tests produce their "before" column. It is an option, not a mode — the shipped renderer never
sets it, and a batch is rebuilt when it flips because the radius is part of the static batch key.

`DIORAMA_BUDGET` (`src/voxel-geometry.js`) states the ceiling this exists to respect, one named term
per owner: static world geometry, residents at the participant bound, saved blocks at the block
bound, and draw calls — the same 130 `tests/render-scene.test.js` bounds from the other side. The
assertions live in `tests/render-lod.test.js`.

## Light, sky and distance

`src/atmosphere.js` publishes the shared fictional sky: four phases (`dawn`, `day`, `dusk`, `night`),
a 120-minute cycle, a label and an activity line, and it changes presentation only. The renderer keys
its light table by exactly those names (`src/scene/sky.js`), and `tests/render-atmosphere.test.js`
asserts the two lists cannot drift apart. The legacy `evening` name a client may still send resolves
to `dusk`; an unknown name falls back to `day` rather than to a dark frame.

- **The key light turns with the phase.** Each phase owns its sun colour, intensity, height and
  azimuth, so dawn and dusk light the world from their own bearing and their shadows fall differently
  — not one fixed direction for every hour.
- **The shadow frustum is fitted, not fixed.** It is sized from the drawn window, so the widest
  window the renderer builds (a frontier sector's 37 cells) needs a 19.5 m half-extent where the
  shipped value was a fixed 24 m. At the same 1024 × 1024 shadow map that is 26.3 shadow texels per
  virtual metre instead of 21.3 — sharper contact shadows for the same budget. A narrower world gets a
  tighter frustum; a wider window is clamped, never widened.
- **The depth cue is derived from the fade, not from a fixed pair of distances.** The fog band is
  computed from the falloff the phase wants at the window's far corner, so the same depth reads at
  every orbit distance: the band never starts inside four tiles, so the tile underfoot and the tiles
  a resident interacts with carry no fog at all, and nothing inside the window is ever more than ~72%
  faded, so an obstacle keeps its silhouette. A denser phase is a shorter band, not a darker wall.
- **Night stays legible.** The night phase darkens the sky and turns the key light to moonlight, and
  it *raises* ambient light and tone-mapping exposure rather than lowering them, so an obstacle in
  front of a resident is still visible at 03:00 instead of becoming a black silhouette.
- **The sky layer names the phase from overhead.** A `voxel-sky` batch draws the phase-tinted cloud
  banks, a disc in the key light's own bearing with a halo, a star field at night and a horizon band
  at dawn and dusk. Every marker is above the resident's head, none carries a pick, and none casts a
  shadow. An interior room has no sky over it.

The sky is its own small batch, rebuilt only when the phase or the window changes: a phase change
never touches the diorama, the character batch or the saved blocks. A day-phase poll costs 0.3 ms on
the measured machine and rebuilds 59 of 60 samples' sky layers alone (the sixtieth has the same phase
as the one before it).

## Water, cover and buildings

- **Water reads as water.** A tile whose four neighbours are water is drawn deep, a tile beside land
  is drawn shallow, each shore side carries a lighter break, and roughly half the tiles carry a
  surface glide. A shallow tile may grow reeds at its own edge. The bed, the sub-surface slab and the
  surface keep the tile's pick, so a click still resolves the tile; the glides, breaks and reeds carry
  none.
- **A pond is water you walk around.** The sealed `pond` object draws a stone rim above the
  floor-decal height with the tone its own definition declares inside, a lily pad and two reeds — an
  obstacle a resident sees, where it used to draw a 14 cm pedestal. The `fountain` gained a readable
  water level in both its bowl and its upper basin.
- **Ground cover obeys the tile.** Meadow and garden tiles carry mottling and seedlings as floor
  decals; a tile the server already refuses (a tree, an outcrop) carries a leaf-litter patch and up to
  three understory tufts at its edges, inside its own tile. Nothing in the cover pass carries a pick.
- **Buildings read as buildings.** A boundary wall is a footed plinth, two courses and a capstone; an
  authored building tile is a stone base, a body, a stepped roof with a door and a lit window on the
  +y face; a cottage gained a plinth, a door lintel and window sills; and a `civic-building` — which
  used to be drawn identically to a cottage — now draws its own taller silhouette with a double door,
  a window pair, a sign board, a wide eave and a lantern finial, at 2.18 m inside its own tile. The
  specified-but-unproduced entries in the asset manifest (a 2 × 2 civic hall, a canopy arch, a hedge
  row) are still **not** drawn, because nothing can produce them without a content re-seal and a
  footprint change.
- **Past the detail radius the ground stops being read closely.** The cover, the understory, the
  water glints, shore breaks and reeds stop at `LOD_LIMITS.detail_radius`; see
  [level of detail](#level-of-detail). The surface, the obstacles, the buildings and every pick
  continue to the window edge unchanged.

## Interaction


- Drag the canvas horizontally to orbit around the selected character or visitor position. A mouse can also adjust the viewing elevation; touch keeps vertical page scrolling available.
- In first person the same drag rotates the view and nothing else: a gesture measured past six pixels is a look, a shorter one is a click, and one gesture is never both. Keyboard controls stay available: WASD and the arrow keys walk, Q and E turn, R and F tilt, and in the frontier the digits 1–7 choose a block.
- The aim line under the view is a live, keyboard-focusable status element. It names the view mode, the compass direction you face, your tile and layer, the last picked tile with whether it is walkable or solid, and the keys that walk or turn. It is plain text with no markup.
- Click a tile, object, character, gateway, or authored block to select it. The application decides whether to walk, inspect, build, or travel, and the interaction panel reads the picked tile from the server so the fixture, its requirement and its next step are named before anything is used.
- The aim line also names the fixture you have read and how to use it: which action it offers, and either the keys that use it or the tile to stand beside. `Enter`, `Space` and `I` use the fixture the aim line names.
- In the frontier hotbar, `Climb to previewed block` steps one authored layer onto the currently previewed neighbouring tile, and `Step-up mode` makes the movement controls climb instead of walk.
- Camera buttons can rotate, zoom, and reset the view without a mouse. `Turn mode` (Q, E, R, F or pointer drag), `Step-up mode`, and `First person` are labelled toggles; each reports its state through `aria-pressed`.
- Walking remains a server action. This renderer does not grant movement, building, expansion, reward, or moderation authority.
- `prefers-reduced-motion` is honoured without a mode switch. The preference is resolved once when the view is created (an injected value wins, otherwise the browser's own media query is read) and every update then draws each resident on the tile the server confirmed, reconciling the interpolation the tracker would otherwise glide through. The scene reports that it is not animating, so the renderer schedules no settle timer and the application's own frame loop stops: the world is presented as still frames that follow the server rather than as motion. The near-ground detail rule adds no animation of its own — it is a function of the followed tile and nothing else, so two builds of the same viewport at different wall-clock times are identical.
- An assignment or purpose shown in the interface is read from the server’s land records. Selection highlights and camera movement cannot create stewardship or authorize construction.
- Unopened frontier gates appear as closed frames. Selecting one can lead to the application's explicit expansion action; rendering never creates a sector.
- Browsers without WebGL 2 use the existing map view, which lists places, entrances, scenery and characters as text. Context loss produces a readable message. The same aim line is repeated in that text view, so the selection hint is never only graphical.

## Direct world interaction

A resident can use a nearby fixture directly, in both views, without opening a separate panel for the world it lives in. `src/spaces.js` resolves one fixture table for the whole world — a **door** (an authored portal), a **crop patch** (a `farm`), a **bench**, a **crafting station** (a `workbench`) and a **country ambassador desk** (an ambassador or guide stand) — and each one maps to an action the world already owns: travel, the garden crop actions, posture, crafting, or the ambassador conversation. The interaction adds no authority: the client sends the tile and the fixture action, and the server decides.

- The interaction panel reads the picked or typed tile from `GET /interact` and prints one readable line naming the fixture, the interaction, the requirement and the measured distance, plus the next usable step. A refusal replaces that line with the server's own answer and replaces nothing else.
- **Distance.** The fixture must be used from the tile it stands on or one of its four neighbours — Manhattan distance 1, the same adjacency the server already requires for a doorway. The panel states it, `Approach the …` walks to the nearest clear tile beside the fixture, and the write refuses anything further instead of widening the reach.
- **Keyboard and text.** Every interaction is a labelled control in a form, so it is reachable by Tab and Enter; `Enter`, `Space` or `I` use the fixture the aim line names; and the panel's typed `Tile X`/`Tile Y` reader is the text path for a viewer who cannot click the canvas — the same role the `Walk to a tile` form has for movement. Nothing about an interaction requires a mouse, a drag or a hover.
- **One click, one write.** The action control is live while this view has an acting resident, and a second click during an in-flight request is coalesced into it. The request carries an `Idempotency-Key`, and the server replays a repeated key instead of acting twice; an out-of-range, paused, revoked or wrong-owner click is therefore answered by the server's own status, message and next step, not by a button that silently refuses.
- **Observers inspect, never act.** A visitor with no resident in the world reads the same descriptor with `blocked_by: "inspect_only"`, sees no live action control, and cannot send the intent as another operator's resident: that is refused as not found. Looking around never writes anything.
- The fixture's own state is read, not guessed: a growing crop offers tend or harvest and says when it is ready; a crafting station lists the recipes with the ingredients the resident already holds; a desk names itself and takes a typed question.

## Local dependency

Three.js **0.186.1** is pinned from its official npm package. The downloaded archive's SHA-512 was compared with npm registry integrity before extraction. Only the official core/module source and MIT license were used. A local esbuild 0.28.0 bundle retains the renderer's required exports in `assets/vendor/three-voxel.js`; it is approximately 551 KB (551,333 bytes, SHA-256 `37fe9184bb0c982e1d48e77375fbeb6b2f8a3fdd54b62a5f0cd87499fdcb5e88`).

`assets/vendor/three-source-manifest.json` records the registry URL, archive integrity and hash, source hashes, bundle hash, license hash, version, verification date, and build settings. There is no runtime CDN, model download, texture request, external tile server, JavaScript evaluation, or installation script.

Primary references:

- [Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)
- [Three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)
- [Three.js Raycaster](https://threejs.org/docs/pages/Raycaster.html)
- [Pinned official package](https://registry.npmjs.org/three/0.186.1)

## Bounds and lifecycle

The view builds at most **37 × 37 detailed terrain cells**, **260 scenery objects**, **2,048 authored blocks**, and **220 character models** around the current position. Repeated cube geometry is rendered with instancing. A land base cube is culled when all four neighbours in the retained authored terrain enclose it, including neighbours just beyond the detailed window; water, bridges and actual world edges retain their exposed bases. Batches are reused across polls: terrain changes with its cells, objects, portals, gates, culling or the detail radius; characters change with drawn pose, appearance or confirmed position, while a presence timestamp or roster reorder does not rebuild them; saved blocks and the sky have separate keys. Graphics resources, pointer listeners, the resize observer, the animation timer and the WebGL context are released when a view is destroyed. `scenes.update()` reports voxel cubes by layer (`terrain`, `water`, `buildings`, `furniture`, `navigation`, `cover`, `understory`, `sky`) and the viewport's detail split (`{ radius, fine, coarse }`), which `scripts/voxel-bench.mjs` prints.

Rendering happens after input, world updates, and resizing. A 100 ms repaint timer runs only while a confirmed step interpolates or a stored expression remains active; idle scenes remain event driven, and a visitor who set `prefers-reduced-motion` never schedules it at all. The canvas does not capture the page's mouse wheel. Pixel ratio is capped at 1.5 (reported as `RENDER_CAPS`), render dimensions at 1,440 × 900 logical pixels, and shadows at 1,024 × 1,024 (`SHADOW_LIMITS`). **Neither task 31 nor the detail rule raised any of these bounds**: `VOXEL_LIMITS` is unchanged (`radius 18`, `cells 1369`, `objects 260`, `blocks 2048`, `participants 220`, `height 8`), and `LOD_LIMITS` and `DIORAMA_BUDGET` are new *ceilings and stated budgets* the renderer now holds itself to, not bounds on what a world may contain. `tests/render-atmosphere.test.js` asserts the shipped values; `tests/render-lod.test.js` asserts the budget.

The application requests `view=voxel` for a matching 37 × 37 authoritative block snapshot. The ordinary map and worker snapshots retain their 20 × 14 viewport. More distant base terrain provides a horizon; farther geometry is loaded as the viewport moves. The world opens adjacent areas inside its fixed 16 × 16 perimeter.

Outdoors, the voxel renderer also places one finite, render-only thin box over the authored world bounds, below the deepest water bed. It supplies a simple far-ground tint beyond the 37 × 37 detailed window without adding a tile, pick, collision surface, or interaction target. It is one draw call with 24 box vertices, is rebuilt on a world switch, omitted indoors and disposed with the scene. The scene's draw-batch count includes it; its voxel cube count does not.

Column elevation is implemented server-side. `src/elevation.js` derives a column surface from authored solids, and `agents` stores each resident's layer (`z`) and `grounded` flag. Ordinary movement (`POST /move`) keeps the shipped rule that any authored layer in the target column is a wall. `POST /climb` — and `POST /agents/:id/climb` — opts into a one-layer step-up with a two-layer headroom check and refuses a taller column; a descent settles the resident onto the lower surface. Stored `z` is treated as a cache: every authoritative block write in `src/frontier.js` re-derives it from the column, and `POST /agents/:id/look` stores a yaw/pitch orientation on its own 120 ms throttle.

Not implemented: vertical physics, falling, jumping, acceleration, arbitrary voxel mining, and continuous terrain beyond an opened area still require additional server mechanics. Movement exists only as a single grid step: there is no jump, no fall simulation, and no flight, so a resident never occupies a position between tiles. The renderer has a true first-person camera at the selected resident’s cell center and elevation plus 1.35 layers — the camera reads the resident’s stored layer, and rotates it only through stored yaw/pitch, so a rotation never moves the character. It omits the resident’s own avatar and preserves terrain between camera modes. WASD maps the viewed heading to a cardinal server step. No continuous airborne simulation is claimed.

## Integration contract

```js
import { createVoxelWorld } from './src/voxel-world.js';

const view = createVoxelWorld(canvas, {
  onPick(pick) { /* choose a reviewed application action */ },
  onUnavailable(message) { /* show a map fallback */ },
});

view?.render(worldSnapshot, {
  definition, position, self, selection, dayPhase,
});
view?.rotate(yawDeltaRadians, pitchDeltaRadians);
view?.zoom(distanceDelta);
view?.setOrbit({ yaw, pitch, distance });
view?.destroy();
```

Picks preserve horizontal grid `x/y` and vertical block `z`. A block pick includes the original block, a cardinal `face`, and an `adjacent` cell. A terrain pick uses `z: 0`, while a participant pick carries that character's elevation layer (`z`). `type` is one of `terrain`, `object`, `participant`, `portal`, `gate`, or `block`. Gate picks include `neighbor`; portal picks include `portal`.

The factory returns `null` when graphics are unavailable. A canvas already used for a 2D context cannot switch to WebGL; the application creates a fresh canvas when changing renderers.

## Verification

The renderer tests use the actual retained Three.js library without a GPU to verify terrain and authored-block raycasts, top and side face conversion, participant selection, camera projection, viewport and block limits, invalid and duplicate record filtering, static scene reuse, disposal, and retained dependency hashes. The footprint tests additionally read the real instance matrices to check that each scenery class is drawn as declared.

Four renderer suites, also GPU-free and over the real instance matrices:

- `tests/render-obstacles.test.js` — the two-way obstacle rule above, over the real authored worlds, every scenery type, water and saved block columns; the pond/path reading; and the ground-cover height rule.
- `tests/render-atmosphere.test.js` — the phase table against `src/atmosphere.js`, the depth cue's near-field and far-corner behaviour, the applied light/fog/shadow values read back from a real `THREE.Scene`, the shadow caps, the sky layer's height and unpickability, and the unchanged renderer bounds.
- `tests/render-scene.test.js` — the scene-module interface, the batch-reuse policy (an unchanged viewport rebuilds nothing; a phase change rebuilds the sky alone), the occlusion cull, the layer report, and the draw-call budget.
- `tests/render-lod.test.js` — the detail rule: the tier as a pure function of the anchor; the near field byte-identical with the rule on and off; every dropped instance unpicked, on a coarse tile and below the knee; the two-way obstacle rule re-asserted over the coarse ring; the decorative cost bounded by the radius (`fine <= 625`) rather than the window; the stated instance and draw-call budget on the largest viewport, and again with the participant and block bounds filled; and the reduced-motion contract (a confirmed tile is drawn, nothing is animated, no rebuild on a repeated payload).

`scripts/voxel-bench.mjs` (GPU-free) reports the composition by layer and what a day-phase poll costs, alongside the shipped culling and reuse comparisons, and a level-of-detail section that builds the Commons and the largest viewport twice — with the detail rule and with `lod: false` — reporting instances, draw calls, the detail split and build time. Measured numbers are in [the task 31 handoff](handoff/task-31-world-rendering.md) and [the render-scale handoff](handoff/task-deepseek-render-scale.md).

The direct-interaction controls are verified without a browser too: `tests/interaction-controls.test.js` checks the keys and the aim line, and `tests/interaction-http.test.js` drives `GET`/`POST /interact` over the shipped HTTP server and then reads the server's own records. The browser acceptance suite (`npm run browser`, `scripts/browser-suite.mjs`) drives the real interface in the system Chrome build against a temporary database and asserts the database after every UI action; five of its scenarios cover direct interaction — the hint and its one-tile requirement, a planted crop and a bench posture surviving a reload, a doorway and a crafting station, a country ambassador desk, and the paused, revoked, wrong-owner and observer refusals. The first-person route and camera elevation are also verified by HTTP and module tests plus a manual walkthrough (see `docs/handoff/task-02-first-person.md`).

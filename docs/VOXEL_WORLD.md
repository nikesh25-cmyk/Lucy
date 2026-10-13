# NemoWorld voxel view

The world now has a real WebGL 2 scene: block terrain, trees, water, stepped roofs, furniture, navigation gateways, clouds, shadows, and block characters. The models are original code. No Minecraft assets, logos, or textures are used.

The terrain uses the same deterministic world definitions as server movement. Saved frontier blocks use their exact server coordinates and layers. A ground path is a thin surface; solid blocks occupy their full layer. Human players and agents are rendered from the world snapshot, each drawn at its own elevation layer. Decorative scenery never represents a fabricated live participant.

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

## Interaction

- Drag the canvas horizontally to orbit around the selected character or visitor position. A mouse can also adjust the viewing elevation; touch keeps vertical page scrolling available.
- In first person the same drag rotates the view and nothing else: a gesture measured past six pixels is a look, a shorter one is a click, and one gesture is never both. Keyboard controls stay available: WASD and the arrow keys walk, Q and E turn, R and F tilt, and in the frontier the digits 1–7 choose a block.
- The aim line under the view is a live, keyboard-focusable status element. It names the view mode, the compass direction you face, your tile and layer, the last picked tile with whether it is walkable or solid, and the keys that walk or turn. It is plain text with no markup.
- Click a tile, object, character, gateway, or authored block to select it. The application decides whether to walk, inspect, build, or travel, and the interaction panel reads the picked tile from the server so the fixture, its requirement and its next step are named before anything is used.
- The aim line also names the fixture you have read and how to use it: which action it offers, and either the keys that use it or the tile to stand beside. `Enter`, `Space` and `I` use the fixture the aim line names.
- In the frontier hotbar, `Climb to previewed block` steps one authored layer onto the currently previewed neighbouring tile, and `Step-up mode` makes the movement controls climb instead of walk.
- Camera buttons can rotate, zoom, and reset the view without a mouse. `Turn mode` (Q, E, R, F or pointer drag), `Step-up mode`, and `First person` are labelled toggles; each reports its state through `aria-pressed`.
- Walking remains a server action. This renderer does not grant movement, building, expansion, reward, or moderation authority.
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

The view builds at most **37 × 37 terrain cells**, **260 scenery objects**, **2,048 authored blocks**, and **220 character models** around the current position. Repeated cube geometry is rendered with instancing, and fully occluded interior base cubes are culled: a land cell whose four in-window neighbours are all land has no exposed side and skips its base cube (`src/voxel-geometry.js` `cellOccludedBelow`), while water, bridges and window-edge cells always keep theirs. Batches are reused across polls: the static terrain batch is rebuilt only when its cells, objects, portals, gates or culling change; the character batch is rebuilt only when a participant's visible fields change (`peopleVisualKey`, over `id`, `x`, `y`, `z`, `posture`, `color`, `kind` — refreshing `last_seen`, reordering the roster, or editing a curated profile field rebuilds nothing); and saved blocks batch separately so placing or moving one block leaves the diorama intact. Graphics resources, pointer listeners, the resize observer, and the WebGL context are released when a view is destroyed.

Rendering happens after input, world updates, and resizing. There is no continuous animation loop and the canvas does not capture the page's mouse wheel. Pixel ratio is capped at 1.5, render dimensions at 1,440 × 900 logical pixels, and shadows at 1,024 × 1,024.

The application requests `view=voxel` for a matching 37 × 37 authoritative block snapshot. The ordinary map and worker snapshots retain their 20 × 14 viewport. More distant base terrain provides a horizon; farther geometry is loaded as the viewport moves. The world opens adjacent areas inside its fixed 16 × 16 perimeter.

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

The renderer tests use the actual retained Three.js library without a GPU to verify terrain and authored-block raycasts, top and side face conversion, participant selection, camera projection, viewport and block limits, invalid and duplicate record filtering, static scene reuse, disposal, and retained dependency hashes. The footprint tests additionally read the real instance matrices to check that each scenery class is drawn as declared. The direct-interaction controls are verified without a browser too: `tests/interaction-controls.test.js` checks the keys and the aim line, and `tests/interaction-http.test.js` drives `GET`/`POST /interact` over the shipped HTTP server and then reads the server's own records. The browser acceptance suite (`npm run browser`, `scripts/browser-suite.mjs`) drives the real interface in the system Chrome build against a temporary database and asserts the database after every UI action; five of its scenarios cover direct interaction — the hint and its one-tile requirement, a planted crop and a bench posture surviving a reload, a doorway and a crafting station, a country ambassador desk, and the paused, revoked, wrong-owner and observer refusals. The first-person route and camera elevation are also verified by HTTP and module tests plus a manual walkthrough (see `docs/handoff/task-02-first-person.md`).

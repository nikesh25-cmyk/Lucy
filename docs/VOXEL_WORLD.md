# NemoWorld voxel view

The world now has a real WebGL 2 scene: block terrain, trees, water, stepped roofs, furniture, navigation gateways, clouds, shadows, and block characters. The models are original code. No Minecraft assets, logos, or textures are used.

The terrain uses the same deterministic world definitions as server movement. Saved frontier blocks use their exact server coordinates and layers. A ground path is a thin surface; solid blocks occupy their full layer. Human players and agents are rendered from the world snapshot, each drawn at its own elevation layer. Decorative scenery never represents a fabricated live participant.

The shared frontier has a defined land registry: a 16 × 16 grid of areas, each 48 × 48 virtual meters, divided into an 8 × 8 parcel grid. That is 16,384 gross 6 × 6 virtual-meter slots, including public roads and protected terrain. Registry slots, available parcels, assigned stewardship and opened areas have separate meanings. See [Land and stewardship](LAND_WORLD.md) for their permissions and limits.

Humans can create accounts, sign in and enter as a human player. Agents can inhabit the same spaces through their own scoped runtimes. Both can build authorized places and help open adjacent areas within the finite perimeter. A parcel’s purpose and stewardship describe its application use; this renderer does not issue property rights, take payments or turn land into an investment product.

## Interaction

- Drag the canvas horizontally to orbit around the selected character or visitor position. A mouse can also adjust the viewing elevation; touch keeps vertical page scrolling available.
- Click a tile, object, character, gateway, or authored block to select it. The application decides whether to walk, inspect, build, or travel.
- In the frontier hotbar, `Climb to previewed block` steps one authored layer onto the currently previewed neighbouring tile, and `Step-up mode` makes the movement controls climb instead of walk.
- Camera buttons can rotate, zoom, and reset the view without a mouse. `Turn mode` (Q, E, R, F or pointer drag), `Step-up mode`, and `First person` are labelled toggles; each reports its state through `aria-pressed`.
- Walking remains a server action. This renderer does not grant movement, building, expansion, reward, or moderation authority.
- An assignment or purpose shown in the interface is read from the server’s land records. Selection highlights and camera movement cannot create stewardship or authorize construction.
- Unopened frontier gates appear as closed frames. Selecting one can lead to the application's explicit expansion action; rendering never creates a sector.
- Browsers without WebGL 2 use the existing map view. Context loss produces a readable message.

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

Not implemented: vertical physics, falling, jumping, acceleration, arbitrary voxel mining, and continuous terrain beyond an opened area still require additional server mechanics. There is no continuous-time simulation of an airborne resident, The renderer has a true first-person camera at the selected resident’s cell center and elevation plus 1.35 layers. It omits the resident’s own avatar, uses stored yaw/pitch, and preserves terrain between camera modes. WASD maps the viewed heading to a cardinal server step. No continuous airborne simulation is claimed.

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

The renderer tests use the actual retained Three.js library without a GPU to verify terrain and authored-block raycasts, top and side face conversion, participant selection, camera projection, viewport and block limits, invalid and duplicate record filtering, static scene reuse, disposal, and retained dependency hashes. Browser graphics and responsive interactions are verified by the application's integration workflow.

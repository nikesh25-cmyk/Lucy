import * as THREE from '../assets/vendor/three-voxel.js';
import { getWorldDefinition } from '../world.js';
import { VOXEL_LIMITS, LOD_LIMITS, inDetail, voxelPlan, voxelPick, orbitCamera, firstPersonCamera, voxelParcelAddress, voxelParcelSelection, createOrbitInput, reducedMotionPreference,
  clampOrbitDistance, normalizedWheelDelta, wheelZoom, pinchDistance, fovForDistance, approachOrbit, easeRate, FOV_LIMITS, hoverKey } from './voxel-geometry.js';
import { createHoverThrottle, zoomSuspended } from './camera-controls.js';
import content from './content.js';
import { createResources, cubeBatch, disposeBatch, hash, variant, validColor, shade } from './scene/batch.js';
import { gateFrames, groundPass, landmarkPennants, layer, portalFrames } from './scene/terrain.js';
import { isInterior } from './scene/interiors.js';
import { groundCoverPass } from './scene/vegetation.js';
import { blocksScene } from './scene/blocks.js';
import { parcelScene } from './scene/parcels.js';
import { WATER_TINTS, waterBasin } from './scene/water.js';
import { INTERIOR_LIGHTING, SHADOW_LIMITS, applyPhase, cloudShadow, createSkyDome, phaseLighting, resolvedPhase, skyScene } from './scene/sky.js';
import { disposeWeather, resolveWeather, weatherScene } from './scene/weather.js';
import { lampGlowScene, litLamps } from './scene/lights.js';
import { districtStyle } from './scene/districts.js';
import { civic, cottage, pavilion } from './scene/architecture.js';
import { charactersScene, charactersVisualKey, renderableCharacters, characterNameplates, createMotionTracker } from './characters.js';
import { confirmedExpression } from './character-animation.js';

// Renderer-only tints: terrain, foliage, trim and the interior palette, none of which owns a typed
// definition. `gold` stays local because the agent cosmetic of that id is a deeper tone
// (#cbb46c) than this lantern glow (#e2ca83): two different colours share the name, so neither may
// stand in for the other. Frontier block colours resolve through the sealed content layer.
const LOCAL_COLORS = Object.freeze({ dirt: '#927052', meadow: '#79a86d', leaf: '#468969', leaves: '#468969', water: '#4b9dad', waterglint: '#9bcfc4', snow: '#e5eeee',
  plaza: '#e3d7b4', floor: '#c8aa82', rug: '#869e8c', trunk: '#81664a', roof: '#bd7961', dark: '#324842', cream: '#f1e9cb', gold: '#e2ca83' });
const COLORS = Object.freeze({ ...LOCAL_COLORS, ...Object.fromEntries(content.palette('frontier').map((id) => [id, content.color(id, 'block')])) });

// The renderer's two hard caps on the delivered image. Neither is raised here: a scene module can
// change what a tile looks like, never how large the frame or the shadow map may be.
export const RENDER_CAPS = Object.freeze({ pixel_ratio: 1.5, render_width: 1440, render_height: 900 });

/** Only a non-passive wheel may keep the page still while the world zooms under the pointer. */
const WHEEL_LISTENER_OPTIONS = Object.freeze({ passive: false });

// One finite, render-only backdrop closes the authored world's horizon behind the bounded voxel
// window. It sits below the deepest water bed and owns no pick or movement surface.
/** The ambient loop's frame interval, 15 frames a second when the device can keep up. */
export const AMBIENT_FRAME_MS = 66;
/** The slowest the ambient loop ever repaints, and how many paint-times it waits between paints: nine, so the loop takes at most a tenth of the time. */
export const AMBIENT_SLOWEST_MS = 1000, AMBIENT_DUTY = 9;
export const DISTANT_GROUND_LIMITS = Object.freeze({ y: -1.36, draw_calls: 1, vertices: 24 });

function distantGround(definition) {
  const columns = Number.isInteger(definition?.columns) ? definition.columns : 0;
  const rows = Number.isInteger(definition?.rows) ? definition.rows : 0;
  if (isInterior(definition) || columns < 1 || rows < 1) return null;
  // The retained Three.js bundle intentionally exposes only BoxGeometry. A very thin box keeps the
  // same single-surface role while providing a stable, bounded renderable in the GPU-independent
  // test bundle; its top is the documented backdrop height.
  const geometry = new THREE.BoxGeometry(columns, .04, rows);
  const material = new THREE.MeshLambertMaterial({ color: definition.groundColor || COLORS.meadow });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'voxel-distant-ground';
  mesh.position.set(columns / 2, DISTANT_GROUND_LIMITS.y - .02, rows / 2);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.renderOnly = true;
  return mesh;
}

function disposeDistantGround(mesh) {
  if (!mesh) return;
  mesh.geometry.dispose();
  mesh.material.dispose();
}

// ---------------------------------------------------------------------------------------------
// The sealed scenery builders. They stay in this module on purpose: tests/content.test.js reads
// this file's source to prove that every sealed furniture and architecture definition is drawn by a
// named builder, that the builder paints the colour and emissive tone the definition declares, and
// that no definition's colour is a parallel literal. The scene modules under src/scene/ own the
// world's composition — ground, water, cover, sky, plots, blocks — and call these builders through
// the `builders` interface, so the grammar and its palette have exactly one home.
// ---------------------------------------------------------------------------------------------

// Scenery is drawn exactly as the shared footprint table declares it (src/footprints.js):
//   mass  — a tile-sized solid; the server refuses the tile, so filling the column is honest
//   flat  — ground detail at or below knee height, inside its own tile
//   frame — an open marker: geometry in the tile-edge bands with cross members above the head
// Every dimension below stays inside its own tile, and every cross member clears the drawn
// resident's height, so a neighbouring resident is never drawn inside scenery. A canopy may cross
// into a neighbouring tile only above 1.52 m, where no standing resident can be.
// A plain `tree` takes the species its district grows (src/scene/districts.js `species`), chosen by the tile's
// own hash so a grove is mixed. Every crown starts above 1.52 m, so what overhangs a neighbour is over a
// resident's head; the trunk and the lowest crown keep to the tile, so the mass is exactly the tile it was.
function species(batch, x, y, kind, height, pick) {
  const cx = x + .5, cz = y + .5, add = (dx, h, dz, w, d, l, color) => batch.add(cx + dx, h, cz + dz, w, d, l, color, pick);
  if (kind === 'conifer') {
    for (let i = 0; i < 5; i++) add(0, height + .1 + i * .4, 0, 1.55 - i * .27, .46, 1.55 - i * .27, i % 2 ? '#2f6b55' : '#3a7a60');
    add(0, height + 2.2, 0, .1, .3, .1, '#cfe3d6'); return;
  }
  if (kind === 'birch') {
    for (let i = 0; i < 4; i++) add(0, .3 + i * .45, 0, .3, .06, .3, '#2f2b28');
    add(0, height + .35, 0, 1.3, .6, 1.3, '#86b36f'); add(.18, height + .85, -.1, 1.0, .6, 1.0, '#9cc482'); add(-.15, height + 1.3, .1, .6, .45, .6, '#b4d495'); return;
  }
  if (kind === 'willow') {
    add(0, height + .3, 0, 1.7, .5, 1.7, '#6f9d62');
    for (const [dx, dz] of [[-.78, -.5], [-.78, .35], [.78, -.35], [.78, .5], [-.4, .8], [.45, -.8], [-.4, -.8], [.4, .8]]) add(dx, height - .1, dz, .1, 1.05 + (hash(`${x},${y},${dx}`) % 3) * .08, .1, '#86b073');
    return;
  }
  if (kind === 'jungle') {
    add(0, height + .75, 0, .22, 1.5, .22, COLORS.trunk);
    add(0, height + 1.6, 0, 1.9, .5, 1.9, '#2f7a4a'); add(0, height + 1.95, 0, 1.4, .4, 1.4, '#3f8c58');
    for (const [dx, dz] of [[-.8, -.6], [.8, .6], [.6, -.8], [-.5, .8]]) add(dx, height + .6, dz, .06, 1.9, .06, '#4e9a62');
    return;
  }
  if (kind === 'acacia') {
    add(.06, height + .5, 0, .2, 1.0, .2, COLORS.trunk);
    add(0, height + 1.12, 0, 2.0, .26, 1.7, '#7f9a4c'); add(0, height + 1.38, 0, 1.4, .24, 1.2, '#93ad5a'); return;
  }
  // orchard and oak: the family crown, the oak wider and the orchard lower with fruit.
  const lowCrown = kind === 'orchard' ? .85 : 1;
  add(0, height + .45, 0, 1.6 * lowCrown, .7, 1.6 * lowCrown, shade('#438367', .92)); add(0, height + .78, 0, 1.4 * lowCrown, 1.15, 1.4 * lowCrown, variant('#438367', x, y));
  add(0, height + 1.47, 0, .95, .55, .95, variant('#6a9f73', x, y)); add(0, height + 1.82, 0, .5, .24, .5, variant('#8eb189', x, y));
  if (kind === 'orchard') for (const dx of [-.4, .3, 0]) add(dx, height + .95, .62, .17, .17, .17, '#d7905d');
}

function tree(batch, x, y, type, pick, style) {
  const n = hash(`${x},${y}`), height = type === 'palm' ? 2.3 + n % 3 * .08 : 1.7 + n % 3 * 0.15;
  if (type === 'mountain') {
    batch.add(x + .5, .32, y + .5, 1.06, .64, 1.06, shade('#929e9d', .92), pick);
    batch.add(x + .5, 1.02, y + .5, .82, .76, .82, '#929e9d', pick);
    batch.add(x + .5, 1.66, y + .5, .62, .28, .62, COLORS.snow, pick);
    return;
  }
  if (type === 'cactus') {
    batch.add(x + .5, .95, y + .5, .35, 1.9, .35, '#649873', pick);
    batch.add(x + .78, 1.08, y + .5, .42, .28, .27, '#649873', pick);
    batch.add(x + .9, 1.35, y + .5, .22, .7, .22, '#649873', pick);
    batch.add(x + .5, 1.97, y + .5, .2, .18, .2, '#e1b6a2', pick);
    return;
  }
  const kind = type === 'tree' && style?.species ? style.species[(n >>> 5) % style.species.length] : null;
  batch.add(x + .5, height / 2, y + .5, .28, height, .28, kind === 'birch' ? '#e8e4d8' : kind === 'conifer' ? shade(COLORS.trunk, .8) : kind === 'acacia' || kind === 'jungle' ? shade(COLORS.trunk, .9) : COLORS.trunk, pick);
  if (kind && kind !== 'oak') return species(batch, x, y, kind, height, pick);
  if (type === 'palm') {
    batch.add(x + .5, height + .22, y + .5, 2.2, .22, .5, COLORS.leaf, pick);
    batch.add(x + .5, height + .22, y + .5, .5, .22, 2.2, COLORS.leaf, pick);
    batch.add(x + .5, height + .02, y + .5, 1.5, .2, .44, COLORS.leaf, pick);
    batch.add(x + .5, height + .02, y + .5, .44, .2, 1.5, COLORS.leaf, pick);
    for (const dx of [-.13, .14]) batch.add(x + .5 + dx, height + .09, y + .5 + .1, .16, .16, .16, '#c8a273', pick);
    return;
  }
  // A wide lower canopy, then the three stacked crowns. The lower canopy begins above 1.52 m, so its
  // overhang into the neighbouring tiles is over a resident's head, never through it.
  batch.add(x + .5, height + .45, y + .5, 1.6, .7, 1.6, shade('#438367', .92), pick);
  batch.add(x + .5, height + .78, y + .5, 1.4, 1.15, 1.4, variant('#438367', x, y), pick);
  batch.add(x + .5, height + 1.47, y + .5, .95, .55, .95, variant('#6a9f73', x, y), pick);
  batch.add(x + .5, height + 1.82, y + .5, .5, .24, .5, variant('#8eb189', x, y), pick);
  if (type === 'fruit') for (const dx of [-.45, .35]) batch.add(x + .5 + dx, height + .95, y + .78, .17, .17, .17, '#d7905d', pick);
  else if (n % 4 === 0) batch.add(x + .5 + (n % 3) * .1 - .1, height + 1.96, y + .5, .2, .2, .2, '#d7905d', pick);
}

function house(batch, x, y, pick, type = 'cottage', style = districtStyle()) {
  // The sealed house tones: the cottage wall, the civic wall, the roof, the glass, the door, the trim and the
  // chimney stone. A district style (src/scene/districts.js) chooses among its own tones tile by tile, and
  // src/scene/architecture.js composes the house, the civic building or the pavilion from boxes; the
  // sealed tones below stay the default a style without a list of its own keeps.
  const colors = { wall: '#d5c4a1', roof: COLORS.roof, glass: COLORS.glass, dark: COLORS.dark, cream: COLORS.cream, trim: COLORS.cream,
    stone: '#968b79', gold: COLORS.gold, wood: COLORS.trunk, leaf: COLORS.leaf };
  if (type === 'shelter') return pavilion(batch, { x, y, pick, style, colors });
  if (type === 'civic-building') return civic(batch, { x, y, pick, style, colors });
  return cottage(batch, { x, y, pick, style, colors });
}

function furniture(batch, item, style = districtStyle()) {
  const { x, y } = item, type = item.type || item.kind, pick = { x, y, type: 'object', object: item };
  const add = (dx, h, dy, w, d, l, color, style) => batch.add(x + .5 + dx, h, y + .5 + dy, w, d, l, color, pick, style);
  if (['tree', 'fruit', 'palm', 'cactus', 'mountain'].includes(type)) return tree(batch, x, y, type, pick, style);
  if (['cottage', 'shelter', 'civic-building'].includes(type)) return house(batch, x, y, pick, type, style);
  // A garden path object is the same thin surface the frontier block draws: flat, walkable ground.
  if (type === 'path') add(0, .04, 0, .99, .08, .99, COLORS[type] || COLORS.stone);
  // A pond is water you walk around, not a pedestal: a stone rim above knee height with the sealed
  // pond tone inside it, a lily pad and two reeds. The rim is the mass the server refuses.
  else if (type === 'pond') waterBasin(batch, { x, y, pick, rim: COLORS.stone, water: '#77b5bd', inner: .72, lip: .22, tint: WATER_TINTS.lily });
  else if (['bench', 'table', 'workbench'].includes(type)) {
    const table = type !== 'bench'; add(0, table ? .6 : .32, 0, .99, .14, table ? .8 : .38, COLORS.wood);
    for (const dx of [-.35, .35]) add(dx, .17, 0, .13, .35, .35, COLORS.trunk);
    if (!table) add(0, .64, -.22, .99, .45, .1, COLORS.wood);
  } else if (['flowers', 'farm'].includes(type)) {
    if (type === 'farm') add(0, .045, 0, .92, .09, .92, COLORS.dirt);
    for (const dx of [-.25, .2]) for (const dy of [-.2, .25]) {
      add(dx, .2, dy, .07, .4, .07, COLORS.leaf); add(dx, .4, dy, .2, .15, .2, type === 'farm' ? '#d5c16e' : ['#e1b6a2', '#e7cf83', '#b2a8cb'][hash(`${x},${y},${dx}`) % 3]);
    }
  } else if (['lamp', 'lantern'].includes(type)) {
    add(0, .88, 0, .09, 1.75, .09, COLORS.dark); add(0, 1.8, 0, .28, .35, .28, COLORS.gold, 'glow'); add(0, 2, 0, .4, .09, .4, COLORS.dark);
  } else if (type === 'fountain') {
    // A basin, a stem and an upper bowl, with the water level readable at both heights.
    waterBasin(batch, { x, y, pick, rim: COLORS.stone, water: COLORS.water, inner: .86, lip: .34 });
    add(0, .9, 0, .2, .9, .2, COLORS.stone); add(0, 1.04, 0, .05, .62, .05, COLORS.waterglint);
    add(0, 1.36, 0, .6, .14, .6, COLORS.stone); add(0, 1.425, 0, .48, .03, .48, COLORS.water);
  } else if (type === 'bookshelf') {
    add(0, .8, 0, .9, 1.6, .4, COLORS.trunk);
    for (let level = 0; level < 3; level++) for (let i = 0; i < 4; i++) add(-.3 + i * .2, .25 + level * .48, .22, .12, .3, .12, ['#72908a', '#c38d6d', '#cab573', '#979bb3'][i]);
  } else if (type === 'trellis') {
    for (const dx of [-.45, .45]) add(dx, .9, 0, .09, 1.8, .09, COLORS.wood);
    for (const h of [.5, 1, 1.5]) add(0, h, 0, .98, .08, .1, COLORS.leaf);
  } else if (type === 'boat') { add(0, -.02, 0, .99, .3, .65, COLORS.wood); add(0, .8, 0, .08, 1.5, .08, COLORS.dark); add(.26, 1.02, 0, .48, .6, .05, COLORS.cream); }
  else if (type === 'bed') { add(0, .23, 0, .9, .45, .99, COLORS.wood); add(0, .48, .18, .85, .13, .7, '#8bafa2'); add(0, .5, -.3, .7, .18, .3, COLORS.cream); }
  else if (type === 'cushion') add(0, .1, 0, .7, .2, .7, '#bfa4a4');
  else if (type === 'kitchen') {
    // A cottage kitchen: a cabinet run against the wall, a worktop, a two-burner hob with one ring alight,
    // a kettle and a wall cupboard above. One tile, one mass, 1.80 m tall; the cabinet carries the sealed
    // kitchen tone.
    add(0, .44, -.14, .96, .88, .66, '#ae987a'); add(0, .92, -.14, .99, .08, .72, shade('#ae987a', 1.14));
    for (const dx of [-.2, .2]) add(dx, .975, -.1, .22, .03, .22, COLORS.dark);
    add(.2, .995, -.1, .14, .02, .14, COLORS.gold, 'glow');
    add(-.2, 1.07, -.1, .14, .12, .14, '#9aa7a6'); add(-.2, 1.16, -.1, .06, .06, .06, COLORS.dark);
    add(0, 1.6, -.33, .92, .46, .3, shade('#ae987a', .9)); add(0, 1.6, -.17, .8, .38, .03, COLORS.cream);
  }
  else if (type === 'telescope') { add(0, .55, 0, .14, 1.1, .14, COLORS.stone); add(0, 1.07, 0, .99, .28, .3, '#526f82'); }
  else if (type !== 'gateway') { add(0, .22, 0, .7, .44, .7, COLORS.stone); add(0, .8, 0, .45, .7, .45, type === 'display' ? COLORS.gold : '#a4b9ab'); }
}

const parcelAttacher = (definition, plan) => {
  const parcels = new Map(plan.parcels.map(parcel => [parcel.id, parcel]));
  return record => {
    const address = voxelParcelAddress(definition.id, record), parcel = address && parcels.get(address.id);
    return parcel ? { ...record, parcel } : record;
  };
};

/**
 * The diorama: the ground pass, the authored and terrain scenery objects, the navigation frames, the
 * landmark pennants and the ground cover, composed from the scene modules. The pass order is also
 * the layer order the benchmark reports (`result.layers`).
 */
function terrainScene(resources, definition, snapshot, plan, cullHidden = true) {
  const batch = cubeBatch(resources), layers = {}, withParcel = parcelAttacher(definition, plan);
  const scenery = new Map(plan.objects.map(item => [`${item.x},${item.y}`, item.type || item.kind]));
  const colors = COLORS, style = districtStyle(definition), builders = { tree: (target, tx, ty, type, pick) => tree(target, tx, ty, type, pick, style), furniture: (target, item) => furniture(target, item, style) };
  groundPass({ batch, definition, snapshot, plan, cullHidden, scenery, colors, builders, layers, style });
  layer(batch, layers, 'furniture', () => { for (const item of plan.objects) furniture(batch, item, style); });
  portalFrames({ batch, plan, colors, layers });
  gateFrames({ batch, plan, colors, layers });
  landmarkPennants({ batch, definition, plan, colors, layers, validColor });
  groundCoverPass({ batch, plan, layers });
  const result = batch.finish();
  // All click targets retain the tile's parcel, including trees and saved furnishings.
  for (const mesh of result.pickables) mesh.userData.picks = mesh.userData.picks.map(pick => pick ? withParcel(pick) : pick);
  result.layers = layers;
  return result;
}

/** The participants peopleScene draws: self is appended when the roster omits it, then bounded and placed. */
const renderablePeople = renderableCharacters;

/**
 * Character batch key projected onto the visible fields above. Polls that only refresh `last_seen`,
 * re-order the roster, or change curated profile fields therefore reuse every existing batch instead
 * of disposing and rebuilding all avatars every few seconds.
 */
export function peopleVisualKey(participants, self, options = {}) {
  return charactersVisualKey(participants, self, options);
}

// Fresh names, public profiles and presence belong to current picks even when their geometry is reused.
function refreshPeoplePicks(batch, participants, self) {
  const records = new Map(renderablePeople(participants, self).map(item => [item.id, {
    x: item.x, y: item.y, z: item.z || 0, type: 'participant', participant: item,
  }]));
  for (const mesh of batch.pickables) mesh.userData.picks = mesh.userData.picks.map(pick => pick ? records.get(pick.participant?.id) || null : null);
}

function peopleScene(resources, participants, self, options = {}) {
  return charactersScene(cubeBatch(resources), participants, self, options);
}

/**
 * A GPU-independent scene builder used by rendering and real Raycaster tests.
 *
 * `update(definition, snapshot, options)` honours, besides the position and the roster:
 *   `lod: false`      — build the pre-LOD view (see `LOD_LIMITS`); the escape hatch the benchmark uses.
 *   `reducedMotion`   — draw every resident on its confirmed tile and report nothing to animate.
 *   `cullHidden`      — the whole-node base-cube cull, off for the measured "before" comparison.
 *   `rebuildPeople`   — force the character batch, which otherwise rebuilds only on a visible change.
 *   `time`, `cameraMode`, `dayPhase`, `parcelSelection`, `parcelHover`, `definition`, `self`.
 */
export function createVoxelScene() {
  const resources = createResources(), root = new THREE.Group(), motionTracker = createMotionTracker(); let staticBatch, blockBatch, peopleBatch, parcelBatch, lightBatch, skyBatch, weatherBatch, groundMesh, weatherKey = '', clock = 0, key = '', blockKey = '', peopleKey = '', parcelKey = '', lightKey = '', skyKey = '', groundKey = '', lastPlan, destroyed = false, animating = false;
  let lastMotion = { reduced: false, interior: false, weather: 'clear', phase: 'day' };
  let stats = { cells: 0, blocks: 0, participants: 0, cubes: 0, drawBatches: 0, layers: {} }, pickables = [];
  // The one child order for both the tests and the renderer: terrain, characters, blocks, plots, lamp light, sky, weather.
  const managed = () => [staticBatch, peopleBatch, blockBatch, parcelBatch, lightBatch, skyBatch, weatherBatch].filter(Boolean);
  const batchCount = () => [staticBatch, blockBatch, peopleBatch, parcelBatch, lightBatch, skyBatch, weatherBatch].reduce((total, batch) => total + (batch?.batches || 0), 0) + (groundMesh ? DISTANT_GROUND_LIMITS.draw_calls : 0);
  const settle = () => { for (const batch of managed()) root.add(batch.group); if (groundMesh) root.add(groundMesh); };
  return { root,
    update(definition, snapshot = {}, options = {}) {
      if (destroyed) throw new Error('The voxel scene has been destroyed.');
      const position = options.position || options.self || definition.start;
      // `options.lod === false` is the documented escape hatch: it rebuilds the pre-LOD view (every
      // tile at full detail), which is how the benchmark and the tests produce their "before" column.
      const detailRadius = options.lod === false ? Infinity : LOD_LIMITS.detail_radius;
      const plan = voxelPlan(definition, snapshot, position, detailRadius);
      const cullHidden = options.cullHidden !== false;
      // Which tiles are read closely depends on where the viewer stands, not only on which tiles are in the
      // window: a room smaller than the window is the same window from every tile in it. So the anchor is
      // part of the key exactly when some tile is coarse (it decides which decals exist), and is left out
      // when every tile is fine, where it decides nothing and a step must not rebuild the room.
      const tier = plan.cells.some((cell) => !inDetail(cell.x, cell.y, plan.anchor, plan.detailRadius)) ? [plan.anchor?.x, plan.anchor?.y] : 0;
      const nextKey = JSON.stringify([definition.id, definition.kind, definition.groundColor, plan.cells, plan.objects, plan.portals, plan.gates, cullHidden, detailRadius, tier]);
      if (nextKey !== key) {
        if (staticBatch) root.remove(staticBatch.group); disposeBatch(staticBatch);
        staticBatch = terrainScene(resources, definition, snapshot, plan, cullHidden); staticBatch.group.name = 'voxel-terrain'; root.add(staticBatch.group); key = nextKey;
      }
      const firstPerson = options.cameraMode === 'first-person', drawnSelf = firstPerson ? null : options.self;
      const drawnPeople = firstPerson ? plan.participants.filter(item => item.id !== options.self?.id) : plan.participants;
      // The projected key ignores volatile roster fields; `rebuildPeople` restores the raw payload key.
      const now = Number.isFinite(options.time) ? options.time : Date.now();
      // `prefers-reduced-motion` is honoured here rather than by a repaint loop: every confirmed step
      // is reconciled at once, so a resident is drawn on the tile the server stored and never glides
      // between two of them. The scene then reports that it is not animating, which is what stops the
      // renderer's own settle timer and the host's frame loop.
      const reducedMotion = options.reducedMotion === true;
      for (const person of renderableCharacters(drawnPeople, drawnSelf)) {
        motionTracker.confirm(person);
        if (reducedMotion) motionTracker.reconcile(person.id);
      }
      const nextPeopleKey = options.rebuildPeople === true ? JSON.stringify([drawnPeople, drawnSelf, now]) : peopleVisualKey(drawnPeople, drawnSelf, { tracker: motionTracker, time: now, reducedMotion });
      if (nextPeopleKey !== peopleKey || !peopleBatch) {
        if (peopleBatch) root.remove(peopleBatch.group); disposeBatch(peopleBatch);
        peopleBatch = peopleScene(resources, drawnPeople, drawnSelf, { tracker: motionTracker, time: now, reducedMotion }); peopleBatch.group.name = 'voxel-characters'; root.add(peopleBatch.group); peopleKey = nextPeopleKey;
      }
      refreshPeoplePicks(peopleBatch, drawnPeople, drawnSelf);
      // Saved blocks rebuild on their own, so placing or moving one block leaves the diorama alone.
      const nextBlockKey = JSON.stringify([definition.id, definition.kind, plan.blocks, plan.parcels]);
      if (nextBlockKey !== blockKey) {
        if (blockBatch) root.remove(blockBatch.group); disposeBatch(blockBatch);
        blockBatch = plan.blocks.length ? blocksScene({ resources, definition, plan, colors: COLORS, cubeBatch, withParcel: parcelAttacher(definition, plan) }) : null;
        if (blockBatch) root.add(blockBatch.group); blockKey = nextBlockKey;
      }
      // The sky is its own small batch, so a phase change never touches the diorama: only the phase
      // markers and the cloud tint are rebuilt, and an unchanged phase reuses every existing mesh.
      const phase = resolvedPhase(options.dayPhase || snapshot.atmosphere?.phase);
      // Lamp light follows the same phase and rebuilds only with it: an interior is lit at every phase,
      // the sun lights the outdoors by day, and the glow strength of lamps and windows is a material
      // property moved here, so it never costs a rebuild.
      const interior = isInterior(definition), lightPhase = interior ? 'interior' : phase;
      resources.setGlow((interior ? INTERIOR_LIGHTING : phaseLighting(phase)).glow);
      const nextLightKey = JSON.stringify([definition.id, definition.kind, lightPhase, litLamps(plan)]);
      if (nextLightKey !== lightKey) {
        if (lightBatch) root.remove(lightBatch.group); disposeBatch(lightBatch);
        lightBatch = lampGlowScene({ resources, cubeBatch, plan, phase: lightPhase });
        root.add(lightBatch.group); lightKey = nextLightKey;
      }
      const nextSkyKey = JSON.stringify([definition.id, definition.kind, phase, plan.window]);
      if (nextSkyKey !== skyKey) {
        if (skyBatch) root.remove(skyBatch.group); disposeBatch(skyBatch);
        skyBatch = isInterior(definition) ? null : skyScene({ resources, cubeBatch, plan, phase });
        if (skyBatch) root.add(skyBatch.group);
        skyKey = nextSkyKey;
      }
      // Weather is a second reading on top of the phase (src/scene/weather.js): explicit, published or taken
      // from the shared clock, never inside a room. It rebuilds only its own small batch, and only when the
      // kind changes; a resident walking never rebuilds it because the streaks wrap around the centre.
      const weather = resolveWeather({ weather: options.weather, atmosphere: snapshot.atmosphere, interior });
      if (weather !== weatherKey) {
        if (weatherBatch) root.remove(weatherBatch.group); disposeWeather(weatherBatch);
        weatherBatch = weather === 'clear' ? null : weatherScene({ resources, kind: weather });
        weatherKey = weather;
      }
      resources.setMotion({ time: clock, reduced: reducedMotion, cloud: cloudShadow(phase, weather, interior), center: plan.anchor || position });
      weatherBatch?.follow(plan.anchor || position);
      // The backdrop is keyed to the authored world, not the moving 37 x 37 window. It is a single
      // non-pickable plane below every tile and is rebuilt only when a world switch changes its bounds
      // or tint; its geometry never participates in occupancy, collision, or interaction.
      const nextGroundKey = JSON.stringify([definition.id, definition.kind, definition.columns, definition.rows, definition.groundColor || COLORS.meadow]);
      if (nextGroundKey !== groundKey) {
        if (groundMesh) root.remove(groundMesh); disposeDistantGround(groundMesh);
        groundMesh = distantGround(definition);
        if (groundMesh) root.add(groundMesh);
        groundKey = nextGroundKey;
      }
      settle();
      lastPlan = plan; lastMotion = { reduced: reducedMotion, interior, weather, phase };
      this.highlightParcel(options.parcelSelection, options.parcelHover);
      pickables = [...staticBatch.pickables, ...peopleBatch.pickables, ...(blockBatch?.pickables || [])];
      animating = !reducedMotion && (motionTracker.isSettling(now) || renderableCharacters(drawnPeople, drawnSelf).some((person) => confirmedExpression(person, now)));
      const fine = plan.cells.reduce((count, cell) => count + (inDetail(cell.x, cell.y, plan.anchor, plan.detailRadius) ? 1 : 0), 0);
      stats = { cells: plan.cells.length, blocks: plan.blocks.length, participants: renderablePeople(drawnPeople, drawnSelf).length,
        cubes: staticBatch.cubes + (blockBatch?.cubes || 0) + peopleBatch.cubes + (parcelBatch?.cubes || 0) + (lightBatch?.cubes || 0) + (skyBatch?.cubes || 0),
        parcelCubes: parcelBatch?.cubes || 0, skyCubes: skyBatch?.cubes || 0, lightCubes: lightBatch?.cubes || 0,
        drawBatches: batchCount(), weather, weatherCubes: weatherBatch?.cubes || 0,
        distantGround: groundMesh ? 1 : 0,
        parcels: plan.parcels.length, selectedParcel: parcelBatch?.group.userData.selectedParcel || null, window: plan.window,
        // The detail report: the radius in force, and the cells inside and beyond it. `Infinity` means
        // the escape hatch is on and every cell is read at full detail.
        detail: { radius: plan.detailRadius, fine, coarse: plan.cells.length - fine },
        layers: { ...staticBatch.layers, lights: lightBatch?.cubes || 0, sky: skyBatch?.cubes || 0 } };
      root.updateMatrixWorld(true); return stats;
    },
    /** Public label projection for the live renderer; positions use the same confirmed tracker as bodies. */
    nameplates(participants, self, { time = Date.now(), cameraMode = 'orbit' } = {}) {
      const firstPerson = cameraMode === 'first-person';
      const drawnPeople = firstPerson ? (participants || []).filter(item => item?.id !== self?.id) : participants;
      // Keep self as the distance origin in first-person, then remove its generated label.
      const labels = characterNameplates(drawnPeople, self, { tracker: motionTracker, time });
      return firstPerson ? labels.filter(label => label.id !== self?.id) : labels;
    },
    highlightParcel(selection, hover) {
      if (destroyed || !lastPlan) return;
      const selected = voxelParcelSelection(lastPlan.parcels, selection), hovered = voxelParcelSelection(lastPlan.parcels, hover);
      const nextKey = JSON.stringify([lastPlan.window, lastPlan.parcels.map(parcel => [parcel.id, parcel.state]), selected?.id, hovered?.id]);
      if (nextKey === parcelKey) return;
      if (parcelBatch) root.remove(parcelBatch.group); disposeBatch(parcelBatch);
      parcelBatch = lastPlan.parcels.length ? parcelScene({ resources, plan: lastPlan, selection: selected, hover: hovered, cubeBatch, parcelSelection: voxelParcelSelection }) : null;
      if (parcelBatch) root.add(parcelBatch.group); parcelKey = nextKey; settle(); root.updateMatrixWorld(true);
      stats.selectedParcel = selected?.id || null;
      stats.parcelCubes = parcelBatch?.cubes || 0;
      stats.cubes = (staticBatch?.cubes || 0) + (blockBatch?.cubes || 0) + (peopleBatch?.cubes || 0) + (parcelBatch?.cubes || 0) + (lightBatch?.cubes || 0) + (skyBatch?.cubes || 0);
      stats.drawBatches = batchCount();
      stats.layers = { ...(staticBatch?.layers || {}), lights: lightBatch?.cubes || 0, sky: skyBatch?.cubes || 0 };
    },
    /**
     * Advances the ambient clock: water waves, shore foam, shimmer, the drifting cloud shadow, rain and mist.
     * It touches uniforms and one group offset only, so a tick rebuilds nothing. Under reduced motion the
     * clock stays at zero and every one of those is drawn as a still frame.
     */
    tick(seconds, center = null) {
      if (destroyed) return;
      clock = Number.isFinite(seconds) ? seconds : clock;
      resources.setMotion({ time: clock, reduced: lastMotion.reduced, cloud: cloudShadow(lastMotion.phase, lastMotion.weather, lastMotion.interior), center });
      weatherBatch?.follow(center || lastPlan?.anchor || { x: 0, y: 0 });
      if (skyBatch) for (const mesh of skyBatch.group.children) if (mesh.userData.style === 'cloud') mesh.position.x = lastMotion.reduced ? 0 : Math.sin(clock * .035) * 4;
    },
    /** True while something in view drifts on its own: any outdoor scene (water, cloud shadow, weather). A room and a reduced-motion visitor have none. */
    get ambient() { return !destroyed && !lastMotion.reduced && !lastMotion.interior && !!lastPlan; },
    get resources() { return resources; },
    get weather() { return weatherKey || 'clear'; },
    get pickables() { return pickables; }, get stats() { return stats; }, get animating() { return animating; },
    isAnimating() { return animating; },
    reconcileCharacter(id) { return motionTracker.reconcile(id); },
    destroy() { if (destroyed) return; destroyed = true; motionTracker.clear(); animating = false; disposeBatch(staticBatch); disposeBatch(blockBatch); disposeBatch(peopleBatch); disposeBatch(parcelBatch); disposeBatch(lightBatch); disposeBatch(skyBatch); disposeWeather(weatherBatch); disposeDistantGround(groundMesh); resources.dispose(); root.clear(); pickables = []; key = ''; blockKey = ''; lightKey = ''; skyKey = ''; groundKey = ''; weatherKey = ''; weatherBatch = null; lastPlan = null; }
  };
}

/** Event-driven third-person view. No network, pointer lock, animation loop, or movement authority. */
export function createVoxelWorld(canvas, { onPick, onHover, onLook, onUnavailable, reducedMotion } = {}) {
  const unavailable = () => { onUnavailable?.('3D graphics are unavailable in this browser. The map view remains available.'); return null; };
  if (!canvas?.getContext || !canvas.addEventListener) return unavailable();
  // The visitor's own motion preference, resolved once: an injected value wins, otherwise the browser
  // is asked. Under `reduce`, every update draws each resident on its confirmed tile and the renderer
  // never schedules its settle timer, so the world is presented as still frames rather than as motion.
  const motion = reducedMotionPreference(reducedMotion);
  let context;
  try { context = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'low-power' }); } catch { return unavailable(); }
  if (!context) return unavailable();
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: false }); } catch { return unavailable(); }
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, RENDER_CAPS.pixel_ratio)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = phaseLighting('day').exposure;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  // Shadows are refreshed when something that casts one changed (an update, a repaint for a step); the ambient
  // repaints that only move water, cloud shadow and weather leave them be, which is most of their cost.
  renderer.shadowMap.autoUpdate = false;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(48, 1, .1, 100), contents = createVoxelScene(); scene.add(contents.root);
  const dome = createSkyDome(contents.resources); scene.add(dome.mesh);
  const opening = phaseLighting('day');
  scene.background = new THREE.Color(opening.sky); scene.fog = new THREE.Fog(opening.fog, 4, 34);
  const sky = new THREE.HemisphereLight(opening.zenith, opening.ground, opening.skyLight);
  const sun = new THREE.DirectionalLight(opening.sun, opening.sunLight);
  sun.castShadow = true; sun.shadow.mapSize.set(SHADOW_LIMITS.map_size, SHADOW_LIMITS.map_size);
  sun.shadow.bias = -.001; sun.shadow.normalBias = .03; sun.shadow.radius = 2.2; scene.add(sky, sun, sun.target);
  const selectionBox = new THREE.BoxGeometry(1.025, 1.025, 1.025), selectionGeometry = new THREE.EdgesGeometry(selectionBox); selectionBox.dispose();
  const selectionMaterial = new THREE.LineBasicMaterial({ color: '#fff0b0', depthTest: false });
  const selection = new THREE.LineSegments(selectionGeometry, selectionMaterial); selection.visible = false; selection.renderOrder = 10; scene.add(selection);
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  const ownerDocument = canvas.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const overlayParent = canvas.parentElement;
  const nameplateLayer = ownerDocument && overlayParent?.appendChild ? ownerDocument.createElement('div') : null;
  if (nameplateLayer) {
    nameplateLayer.className = 'voxel-nameplates';
    // These labels mirror the accessible participant list. Avoid announcing all of them again
    // whenever a confirmed movement repaints the projected layer.
    nameplateLayer.setAttribute('aria-hidden', 'true');
    nameplateLayer.style.pointerEvents = 'none';
    if (overlayParent && globalThis.getComputedStyle?.(overlayParent).position === 'static') overlayParent.style.position = 'relative';
    overlayParent.appendChild(nameplateLayer);
  }
  const projected = new THREE.Vector3();
  const orbitInput = createOrbitInput({ onLook }), hover = createHoverThrottle();
  const clockOrigin = globalThis.performance?.now?.() ?? Date.now(); let paintMs = 0, ambientTimer = null;
  let target = { x: 10, y: 6 }, destroyed = false, lost = false, drag = null, lastSnapshot, lastOptions, lastAtmosphere = null, hoveredParcel = null, hoveredTile = '', animationTimer = null;
  // `view` is the presented orbit and `orbitInput.orbit` is the stored one. The camera glides from
  // the first to the second over a few frames, which is presentation only: the stored facing and
  // distance are what the shell sent, they are what the server stores, and no position is derived
  // from an eased number anywhere in this module.
  let view = { ...orbitInput.orbit }, enabled = true, easeHandle = null, easeAt = 0;
  const frame = typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame.bind(globalThis) : null;
  const settle = () => { view = { ...orbitInput.orbit }; };
  const previousTouchAction = canvas.style.touchAction; canvas.style.touchAction = 'pan-y';
  function step() {
    easeHandle = null;
    if (destroyed) return;
    const now = globalThis.performance?.now?.() ?? Date.now(), rate = motion ? 1 : easeRate(now - easeAt);
    easeAt = now;
    const next = approachOrbit(view, orbitInput.orbit, rate);
    view = { yaw: next.yaw, pitch: next.pitch, distance: next.distance };
    paint();
    if (!next.settled) scheduleEase();
  }
  function scheduleEase() {
    if (destroyed) return;
    // No animation frame available (or the player asked for less motion): apply the stored value
    // once, so a camera is never left stale because it could not animate.
    if (!frame || motion) { settle(); return; }
    if (easeHandle !== null) return;
    easeAt = globalThis.performance?.now?.() ?? Date.now();
    easeHandle = frame(step);
  }
  /** One stored value, applied: a camera-mode switch reaches for the new eye instead of panning to it. */
  function applyMode(value) { const previous = orbitInput.mode; orbitInput.setMode(value); if (orbitInput.mode !== previous) settle(); return orbitInput.mode; }
  function resize() {
    const bounds = canvas.getBoundingClientRect(), width = Math.max(1, bounds.width || canvas.width || 800), height = Math.max(1, bounds.height || canvas.height || 560);
    const scale = Math.min(1, RENDER_CAPS.render_width / width, RENDER_CAPS.render_height / height), renderWidth = Math.round(width * scale), renderHeight = Math.round(height * scale);
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x !== renderWidth || size.y !== renderHeight) renderer.setSize(renderWidth, renderHeight, false);
    camera.aspect = width / height; camera.updateProjectionMatrix();
  }
  // `ambient` repaints move only the clock: no nameplate projection and no shadow-map refresh.
  function paint(ambient = false) {
    if (destroyed || lost || !lastSnapshot) return;
    const started = globalThis.performance?.now?.() ?? Date.now();
    const firstPerson = orbitInput.mode === 'first-person';
    // The first-person eye narrows its field of view with the same one distance the boom uses, so a
    // zoom means "closer" in either view and the value survives a switch between them.
    camera.fov = firstPerson ? fovForDistance(view.distance) : FOV_LIMITS.base;
    resize(); const placement = firstPerson ? firstPersonCamera(target, view) : orbitCamera(target, view);
    const aim = placement.look || placement.target;
    camera.position.set(placement.eye.x, placement.eye.y, placement.eye.z); camera.lookAt(aim.x, aim.y, aim.z); camera.updateMatrixWorld();
    const definition = lastOptions?.definition || getWorldDefinition(lastSnapshot.world || 'commons');
    // One phase model, one owner: src/scene/sky.js resolves the named phase (with the legacy
    // `evening` alias), places the key light and its shadow frustum, and sets the depth cue. The weather
    // and the sky gradient ride on it; a room has neither.
    lastAtmosphere = applyPhase({ scene, sky, sun, renderer, phase: lastOptions?.dayPhase || lastSnapshot.atmosphere?.phase,
      position: target, distance: view.distance, plan: { window: contents.stats.window },
      interior: isInterior(definition), weather: contents.weather, dome, firstPerson });
    dome.follow(camera);
    // The ambient clock runs from the first paint, in seconds; a visitor who reduced motion keeps it at zero.
    contents.tick(motion ? 0 : (started - clockOrigin) / 1000, target);
    if (!ambient) renderer.shadowMap.needsUpdate = true;
    const selected = lastOptions?.selection;
    selection.visible = !!selected && Number.isInteger(selected.x) && Number.isInteger(selected.y);
    if (selection.visible) selection.position.set(selected.x + .5, Math.max(0, selected.z || 0) + .5, selected.y + .5);
    if (!ambient) updateNameplates();
    renderer.render(scene, camera);
    paintMs = (globalThis.performance?.now?.() ?? Date.now()) - started;
  }
  function updateNameplates() {
    if (!nameplateLayer || !lastSnapshot || !lastOptions) return;
    const participants = lastSnapshot.participants || lastSnapshot.agents || [];
    const labels = contents.nameplates(participants, lastOptions.self, { cameraMode: orbitInput.mode, time: Date.now() });
    nameplateLayer.replaceChildren();
    for (const label of labels) {
      projected.set(label.anchor.x, label.anchor.y, label.anchor.z).project(camera);
      if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || projected.z < -1 || projected.z > 1 || projected.x < -1.05 || projected.x > 1.05 || projected.y < -1.05 || projected.y > 1.05) continue;
      const element = ownerDocument.createElement('div'); element.className = `voxel-nameplate voxel-nameplate-${label.tier}`;
      element.dataset.participantId = label.id;
      element.style.left = `${(projected.x + 1) * 50}%`; element.style.top = `${(1 - projected.y) * 50}%`;
      const name = ownerDocument.createElement('span'); name.className = 'voxel-nameplate-name'; name.textContent = label.name; element.appendChild(name);
      if (label.tier === 'full') { const role = ownerDocument.createElement('span'); role.className = 'voxel-nameplate-role'; role.textContent = label.role; element.appendChild(role); }
      nameplateLayer.appendChild(element);
    }
  }
  function scheduleAnimation() {
    // No settle timer under `prefers-reduced-motion`: the scene has already drawn every resident on
    // its confirmed tile and reports itself still, so no repaint is scheduled at all.
    if (motion || animationTimer !== null || destroyed || lost || !contents.animating || !lastSnapshot) return;
    animationTimer = setTimeout(() => {
      animationTimer = null;
      if (destroyed || !lastSnapshot) return;
      const definition = lastOptions?.definition || getWorldDefinition(lastSnapshot.world || 'commons');
      contents.update(definition, lastSnapshot, { ...lastOptions, time: Date.now(), parcelHover: hoveredParcel, reducedMotion: motion });
      paint(); scheduleAnimation();
    }, 100);
  }
  // Pointing at the world is a reading, not a command: the hovered tile is reported through the same
  // `onHover` callback the renderer always had, at a bounded rate, and only when the thing under the
  // pointer actually changed. It never issues a request, it never becomes a pick, and a click still
  // selects and walks exactly as it did.
  const emitHover = pick => {
    const key = hoverKey(pick);
    if (key === hoveredTile) return;
    hoveredTile = key;
    onHover?.(pick || null);
  };
  // The ambient loop: water, cloud shadow, rain and mist move on their own clock. It is the only repaint a
  // still outdoor scene schedules, it never runs for a visitor who prefers reduced motion or inside a room,
  // it pauses while the page is hidden, and it backs off to nine times the cost of a paint (a tenth of the time, down
  // to one frame a second) so a slow device is never asked for more than it can give.
  function scheduleAmbient() {
    if (motion || ambientTimer !== null || destroyed || lost || !lastSnapshot || !contents.ambient) return;
    ambientTimer = setTimeout(() => {
      ambientTimer = null;
      if (destroyed || lost || !lastSnapshot) return;
      if (!ownerDocument || ownerDocument.visibilityState !== 'hidden') paint(true);
      scheduleAmbient();
    }, Math.min(AMBIENT_SLOWEST_MS, Math.max(AMBIENT_FRAME_MS, paintMs * AMBIENT_DUTY)));
  }
  const movePointer = event => {
    if (!drag) {
      // A finger that is not dragging has no hover: the touch layer owns that gesture.
      if (destroyed || lost || !lastSnapshot || event.pointerType === 'touch') return;
      if (!hover.claim()) return;
      const pick = pickPointer(event), parcel = pick?.parcel || null;
      if (parcel?.id !== hoveredParcel?.id) { hoveredParcel = parcel; contents.highlightParcel(lastOptions?.parcelSelection, hoveredParcel); paint(); }
      emitHover(pick);
      return;
    }
    if (event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y; drag.distance += Math.abs(dx) + Math.abs(dy);
    // A drag is direct manipulation: the camera follows the pointer one to one, with no glide.
    if (drag.distance > 6) { orbitInput.drag(dx, dy); settle(); paint(); }
    drag.x = event.clientX; drag.y = event.clientY;
  };
  const down = event => { if (event.button !== 0 || destroyed || lost) return; drag = { id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0 }; canvas.setPointerCapture?.(event.pointerId); };
  const up = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const clicked = drag.distance <= 6; drag = null; canvas.releasePointerCapture?.(event.pointerId);
    if (!clicked || destroyed || lost) return;
    const picked = pickPointer(event);
    if (picked) onPick?.(picked);
  };
  function pickPointer(event) {
    const bounds = canvas.getBoundingClientRect(); if (!bounds.width || !bounds.height) return null;
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(contents.pickables, false).map(voxelPick).find(Boolean) || null;
  }
  const cancel = () => { drag = null; };
  // Leaving the canvas drops the reading outright, however long the pointer has been away, so the aim
  // line can never be left showing a tile the pointer is not over.
  const leave = () => {
    if (destroyed) return;
    hover.drop();
    if (hoveredParcel) { hoveredParcel = null; contents.highlightParcel(lastOptions?.parcelSelection, null); paint(); }
    emitHover(null);
  };
  // What makes a wheel or a pinch inert: the shell's own switch, a menu or drawer, an open dialog, or
  // a focused field. A suspended zoom leaves the event alone, so the panel keeps its own scrolling.
  const zoomState = () => {
    const active = ownerDocument?.activeElement;
    return { enabled, tagName: active?.tagName || '', isContentEditable: Boolean(active?.isContentEditable), dialogOpen: Boolean(ownerDocument?.querySelector?.('dialog[open]')) };
  };
  const wheel = event => {
    if (destroyed || lost || !lastSnapshot || zoomSuspended(zoomState())) return;
    const distance = wheelZoom(orbitInput.orbit.distance, normalizedWheelDelta(event.deltaY, event.deltaMode));
    event.preventDefault?.();
    if (distance === orbitInput.orbit.distance) return;
    orbitInput.set({ distance }); scheduleEase(); paint();
  };
  const contextLost = event => { event.preventDefault(); lost = true; drag = null; onUnavailable?.('The 3D view lost its graphics context. Switch to the map view.'); };
  const contextRestored = () => { if (destroyed) return; lost = false; paint(); };
  const listeners = [['pointerdown', down], ['pointermove', movePointer], ['pointerup', up], ['pointerleave', leave], ['pointercancel', cancel], ['lostpointercapture', cancel], ['webglcontextlost', contextLost], ['webglcontextrestored', contextRestored]];
  for (const [name, handler] of listeners) canvas.addEventListener(name, handler);
  // Only a non-passive wheel may keep the page still while the world zooms.
  canvas.addEventListener('wheel', wheel, WHEEL_LISTENER_OPTIONS);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => paint()) : null; observer?.observe(canvas);
  return {
    render(snapshot, options = {}) {
      if (destroyed) return;
      const definition = options.definition || getWorldDefinition(snapshot.world || 'commons');
      applyMode(options.cameraMode ?? orbitInput.mode);
      if (options.facing) orbitInput.set(options.facing);
      target = options.position || options.self || definition.start; lastSnapshot = snapshot; lastOptions = options;
      contents.update(definition, snapshot, { ...options, cameraMode: orbitInput.mode, time: Date.now(), parcelHover: hoveredParcel, reducedMotion: motion }); scheduleEase(); paint(); scheduleAnimation(); scheduleAmbient(); return contents.stats;
    },
    rotate(deltaYaw = 0, deltaPitch = 0) { if (destroyed) return orbitInput.rotate(deltaYaw, deltaPitch); scheduleEase(); paint(); return orbitInput.orbit; },
    zoom(delta = 0) { if (destroyed) return orbitInput.orbit.distance; orbitInput.zoom(delta); scheduleEase(); paint(); return orbitInput.orbit.distance; },
    setOrbit(value = {}) { if (destroyed) return orbitInput.orbit; orbitInput.set(value); scheduleEase(); paint(); return orbitInput.orbit; },
    /** The absolute zoom the panel buttons, a slider or a restore can ask for. */
    setDistance(value) { if (destroyed) return view.distance; orbitInput.set({ distance: clampOrbitDistance(value) }); scheduleEase(); paint(); return orbitInput.orbit.distance; },
    /**
     * A two-finger pinch: `scale` is the current span over the span the gesture started with, and
     * `from` the distance it started from. Inert whenever the wheel is, so a drawer that is open
     * cannot be zoomed through.
     */
    pinch(scale = 1, { from } = {}) { if (destroyed || zoomSuspended(zoomState())) return view.distance; orbitInput.set({ distance: pinchDistance(Number.isFinite(from) ? from : orbitInput.orbit.distance, scale) }); scheduleEase(); paint(); return orbitInput.orbit.distance; },
    /** The shell's switch: false makes the wheel and the pinch inert without touching the camera. */
    setEnabled(value = true) { enabled = value !== false; if (!enabled) hover.drop(); return enabled; },
    setCameraMode(value) {
      if (destroyed) return orbitInput.mode;
      applyMode(value);
      if (lastSnapshot) {
        lastOptions = { ...lastOptions, cameraMode: orbitInput.mode };
        const definition = lastOptions.definition || getWorldDefinition(lastSnapshot.world || 'commons');
        contents.update(definition, lastSnapshot, { ...lastOptions, time: Date.now(), parcelHover: hoveredParcel, reducedMotion: motion }); scheduleAnimation(); scheduleAmbient();
      }
      paint(); return orbitInput.mode;
    },
    get cameraMode() { return orbitInput.mode; },
    get enabled() { return enabled; },
    /** The field of view the last paint applied: the base angle, or the first-person zoom. */
    get fov() { return camera.fov; },
    get orbit() { return orbitInput.orbit; }, get stats() { return contents.stats; },
    isAnimating() { return contents.isAnimating(); },
    reconcileCharacter(id) { const changed = contents.reconcileCharacter(id); if (changed) paint(); return changed; },
    /** What the last paint actually applied: the phase light, the fog band and the shadow frustum. */
    get atmosphere() { return lastAtmosphere; },
    destroy() {
      if (destroyed) return; destroyed = true; if (animationTimer !== null) clearTimeout(animationTimer); animationTimer = null; if (ambientTimer !== null) clearTimeout(ambientTimer); ambientTimer = null; dome.dispose(); observer?.disconnect(); drag = null;
      if (easeHandle !== null && typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(easeHandle);
      easeHandle = null; hoveredTile = ''; hover.drop();
      for (const [name, handler] of listeners) canvas.removeEventListener(name, handler);
      canvas.removeEventListener('wheel', wheel, WHEEL_LISTENER_OPTIONS);
      canvas.style.touchAction = previousTouchAction; contents.destroy(); selectionGeometry.dispose(); selectionMaterial.dispose();
      nameplateLayer?.remove();
      sun.shadow.map?.dispose(); renderer.dispose(); renderer.forceContextLoss(); lastSnapshot = null; lastOptions = null;
    }
  };
}

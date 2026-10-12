import * as THREE from '../assets/vendor/three-voxel.js';
import { getWorldDefinition } from '../world.js';
import { VOXEL_LIMITS, voxelPlan, voxelPick, orbitCamera, firstPersonCamera, inVoxelWindow, voxelParcelAddress, voxelParcelSelection, cellOccludedBelow, createOrbitInput } from './voxel-geometry.js';
import content from './content.js';

// Renderer-only tints: terrain, foliage, trim and the interior palette, none of which owns a typed
// definition. `gold` stays local because the agent cosmetic of that id is a deeper tone
// (#cbb46c) than this lantern glow (#e2ca83): two different colours share the name, so neither may
// stand in for the other. The frontier block colours and the agent colours are resolved from the
// content layer below, where each one is a sealed definition.
const LOCAL_COLORS = Object.freeze({ dirt: '#927052', meadow: '#79a86d', leaf: '#468969', leaves: '#468969', water: '#4b9dad', snow: '#e5eeee',
  plaza: '#e3d7b4', floor: '#c8aa82', rug: '#869e8c', trunk: '#81664a', roof: '#bd7961', dark: '#324842', cream: '#f1e9cb', gold: '#e2ca83' });
const COLORS = Object.freeze({ ...LOCAL_COLORS, ...Object.fromEntries(content.palette('frontier').map((id) => [id, content.color(id, 'block')])) });
const AGENT_COLORS = Object.freeze(Object.fromEntries(content.cosmetics('agent_color').map((id) => [id, content.color(id, 'cosmetic')])));
// Original calling emblems represent an operator's explicit choice, never an account privilege.
const CALLING_STYLES = Object.freeze({
  explorer: { color: '#7bc0c9', mark: 'cross' }, builder: { color: '#d39170', mark: 'arch' },
  cultivator: { color: '#95c681', mark: 'sprout' }, researcher: { color: '#ada6d7', mark: 'book' },
  steward: { color: '#d7c48a', mark: 'cross' }, mediator: { color: '#e4dfbe', mark: 'bridge' },
  artisan: { color: '#d39bac', mark: 'diamond' }, host: { color: '#88b7d0', mark: 'arch' },
});
const callingStyle = item => typeof item.calling?.id === 'string' && Object.hasOwn(CALLING_STYLES, item.calling.id) ? CALLING_STYLES[item.calling.id] : null;
const variant = (base, x, y) => new THREE.Color(base).multiplyScalar(0.91 + ((x * 47 + y * 91) % 7) * 0.025).getHex();
const validColor = value => typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value) ? value : null;
const hash = value => { let result = 0; for (const char of String(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619); return result >>> 0; };

function createResources() {
  const geometry = new THREE.BoxGeometry(1, 1, 1), materials = new Map();
  function material(color, style = 'solid') {
    const key = `${color}:${style}`;
    if (!materials.has(key)) materials.set(key, style.startsWith('parcel-')
      ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: style === 'parcel-fill' ? .08 : style === 'parcel-hover' ? .65 : .88,
        depthWrite: false, depthTest: style === 'parcel-boundary' })
      : new THREE.MeshLambertMaterial({ color, flatShading: true,
        ...(style === 'glass' ? { transparent: true, opacity: 0.58, depthWrite: false } : {}),
        ...(style === 'glow' ? { emissive: color, emissiveIntensity: 0.28 } : {}) }));
    return materials.get(key);
  }
  return { geometry, material, dispose() { geometry.dispose(); for (const item of materials.values()) item.dispose(); materials.clear(); } };
}

function cubeBatch(resources) {
  const batches = new Map(); let cubes = 0;
  const add = (x, height, y, width, depth, length, color, pick = null, style = 'solid') => {
    const key = `${color}:${style}`;
    if (!batches.has(key)) batches.set(key, { material: resources.material(color, style), instances: [] });
    batches.get(key).instances.push({ x, height, y, width, depth, length, pick }); cubes++;
  };
  function finish() {
    const group = new THREE.Group(), pickables = [], dummy = new THREE.Object3D();
    for (const batch of batches.values()) {
      const mesh = new THREE.InstancedMesh(resources.geometry, batch.material, batch.instances.length);
      mesh.userData.picks = [];
      batch.instances.forEach((item, index) => {
        dummy.position.set(item.x, item.height, item.y); dummy.scale.set(item.width, item.depth, item.length); dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix); mesh.userData.picks[index] = item.pick;
      });
      mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh); if (mesh.userData.picks.some(Boolean)) pickables.push(mesh);
    }
    return { group, pickables, cubes, batches: batches.size };
  }
  return { add, finish };
}

function tree(batch, x, y, type, pick) {
  const n = hash(`${x},${y}`), height = type === 'palm' ? 2.3 : 1.7 + n % 3 * 0.15;
  if (type === 'mountain') {
    batch.add(x + .5, .7, y + .5, 1.5, 1.4, 1.5, '#929e9d', pick);
    batch.add(x + .5, 1.65, y + .5, 1.08, .5, 1.08, COLORS.snow, pick); return;
  }
  if (type === 'cactus') {
    batch.add(x + .5, .95, y + .5, .35, 1.9, .35, '#649873', pick);
    batch.add(x + .85, 1.08, y + .5, .55, .28, .27, '#649873', pick);
    batch.add(x + 1.02, 1.35, y + .5, .22, .7, .22, '#649873', pick); return;
  }
  batch.add(x + .5, height / 2, y + .5, .28, height, .28, COLORS.trunk, pick);
  if (type === 'palm') {
    batch.add(x + .5, height + .15, y + .5, 2.2, .24, .55, COLORS.leaf, pick);
    batch.add(x + .5, height + .15, y + .5, .55, .24, 2.2, COLORS.leaf, pick);
  } else {
    batch.add(x + .5, height + .17, y + .5, 1.4, 1.15, 1.4, variant('#438367', x, y), pick);
    batch.add(x + .5, height + .86, y + .5, .95, .55, .95, variant('#6a9f73', x, y), pick);
    if (type === 'fruit') for (const dx of [-.45, .35]) batch.add(x + .5 + dx, height + .25, y + 1.18, .17, .17, .17, '#d7905d', pick);
  }
}

function house(batch, x, y, pick, type = 'cottage') {
  const large = ['shelter', 'civic-building'].includes(type), width = large ? 2.5 : 1.8, length = large ? 2 : 1.5;
  if (type !== 'shelter') {
    batch.add(x + .5, .8, y + .5, width, 1.6, length, '#d5c4a1', pick);
    batch.add(x + .5, .6, y + .5 + length / 2 + .012, .38, 1.2, .035, COLORS.dark, pick);
    for (const dx of [-.6, .6]) batch.add(x + .5 + dx, 1.05, y + .5 + length / 2 + .02, .35, .45, .04, COLORS.glass, pick, 'glow');
  } else for (const dx of [-1.05, 1.05]) for (const dy of [-.8, .8]) batch.add(x + .5 + dx, .8, y + .5 + dy, .16, 1.6, .16, COLORS.trunk, pick);
  for (let step = 0; step < 3; step++) batch.add(x + .5, 1.7 + step * .22, y + .5, width + .35 - step * .5, .23, length + .4, COLORS.roof, pick);
  if (type !== 'shelter') batch.add(x + 1.05, 2.2, y + .27, .22, .8, .25, '#968b79', pick);
}

function furniture(batch, item) {
  const { x, y } = item, type = item.type || item.kind, pick = { x, y, type: 'object', object: item };
  const add = (dx, h, dy, w, d, l, color, style) => batch.add(x + .5 + dx, h, y + .5 + dy, w, d, l, color, pick, style);
  if (['tree', 'fruit', 'palm', 'cactus', 'mountain'].includes(type)) return tree(batch, x, y, type, pick);
  if (['cottage', 'shelter', 'civic-building'].includes(type)) return house(batch, x, y, pick, type);
  if (['bench', 'table', 'workbench'].includes(type)) {
    const table = type !== 'bench'; add(0, table ? .6 : .32, 0, 1.3, .14, table ? .8 : .38, COLORS.wood);
    for (const dx of [-.45, .45]) add(dx, .17, 0, .13, .35, .35, COLORS.trunk);
    if (!table) add(0, .64, -.24, 1.3, .45, .1, COLORS.wood);
  } else if (['flowers', 'farm'].includes(type)) {
    if (type === 'farm') add(0, .045, 0, .92, .09, .92, COLORS.dirt);
    for (const dx of [-.25, .2]) for (const dy of [-.2, .25]) {
      add(dx, .2, dy, .07, .4, .07, COLORS.leaf); add(dx, .4, dy, .2, .15, .2, type === 'farm' ? '#d5c16e' : ['#e1b6a2', '#e7cf83', '#b2a8cb'][hash(`${x},${y},${dx}`) % 3]);
    }
  } else if (['lamp', 'lantern'].includes(type)) {
    add(0, .88, 0, .09, 1.75, .09, COLORS.dark); add(0, 1.8, 0, .28, .35, .28, COLORS.gold, 'glow'); add(0, 2, 0, .4, .09, .4, COLORS.dark);
  } else if (type === 'fountain') {
    add(0, .17, 0, 1.45, .34, 1.45, COLORS.stone); add(0, .36, 0, 1.2, .06, 1.2, COLORS.water); add(0, .85, 0, .18, 1.2, .18, COLORS.stone); add(0, 1.25, 0, .72, .1, .72, COLORS.stone);
  } else if (type === 'bookshelf') {
    add(0, .8, 0, .9, 1.6, .4, COLORS.trunk);
    for (let level = 0; level < 3; level++) for (let i = 0; i < 4; i++) add(-.3 + i * .2, .25 + level * .48, .22, .12, .3, .12, ['#72908a', '#c38d6d', '#cab573', '#979bb3'][i]);
  } else if (type === 'trellis') {
    for (const dx of [-.45, .45]) add(dx, .9, 0, .09, 1.8, .09, COLORS.wood);
    for (const h of [.5, 1, 1.5]) add(0, h, 0, .98, .08, .1, COLORS.leaf);
  } else if (type === 'boat') { add(0, -.02, 0, 1.6, .3, .65, COLORS.wood); add(0, .8, 0, .08, 1.5, .08, COLORS.dark); add(.26, 1.02, 0, .48, .6, .05, COLORS.cream); }
  else if (type === 'bed') { add(0, .23, 0, .9, .45, 1.4, COLORS.wood); add(0, .48, .18, .85, .13, .95, '#8bafa2'); add(0, .5, -.45, .75, .18, .32, COLORS.cream); }
  else if (type === 'cushion') add(0, .1, 0, .7, .2, .7, '#bfa4a4');
  else if (type === 'telescope') { add(0, .55, 0, .14, 1.1, .14, COLORS.stone); add(0, 1.07, 0, 1.3, .28, .3, '#526f82'); }
  else if (type !== 'gateway') { add(0, .22, 0, .7, .44, .7, COLORS.stone); add(0, .8, 0, .45, .7, .45, type === 'display' ? COLORS.gold : '#a4b9ab'); }
}

const parcelAttacher = (definition, plan) => {
  const parcels = new Map(plan.parcels.map(parcel => [parcel.id, parcel]));
  return record => {
    const address = voxelParcelAddress(definition.id, record), parcel = address && parcels.get(address.id);
    return parcel ? { ...record, parcel } : record;
  };
};

function terrainScene(resources, definition, snapshot, plan, cullHidden = true) {
  const batch = cubeBatch(resources), scenery = new Map(plan.objects.map(item => [`${item.x},${item.y}`, item.type || item.kind])), withParcel = parcelAttacher(definition, plan);
  for (const item of plan.cells) {
    const { x, y, type } = item, pick = { x, y, z: 0, type: 'terrain', terrain: type, ...(item.parcel ? { parcel: item.parcel } : {}) };
    const base = ['water', 'bridge'].includes(type) ? COLORS.dirt : type === 'building' || type === 'tree' || type === 'fountain' ? definition.groundColor || COLORS.grass : COLORS[type] || definition.groundColor || COLORS.grass;
    // An interior base cube has no exposed face, so it is skipped; the slab below always stays.
    if (!cullHidden || !cellOccludedBelow(definition, snapshot, plan, x, y)) batch.add(x + .5, type === 'water' ? -.82 : -.5, y + .5, 1, 1, 1, variant(COLORS.dirt, x, y), pick);
    batch.add(x + .5, type === 'water' ? -.16 : -.04, y + .5, 1, .08, 1, variant(base, x, y), pick);
    if (type === 'water') batch.add(x + .5, -.095, y + .5, .99, .08, .99, variant(COLORS.water, x, y), pick);
    if (type === 'bridge') for (let i = 0; i < 4; i++) batch.add(x + .5, .03, y + .125 + i * .25, 1, .13, .22, COLORS.wood, pick);
    if (type === 'tree' && !['tree', 'fruit', 'palm', 'cactus', 'mountain'].includes(scenery.get(`${x},${y}`))) tree(batch, x, y, 'tree', pick);
    if (type === 'wall') batch.add(x + .5, .85, y + .5, 1, 1.7, 1, '#839489', pick);
    if (type === 'building' && definition.kind === 'interior') furniture(batch, { x, y, type: 'bookshelf' });
    else if (type === 'building') {
      batch.add(x + .5, .72, y + .5, .99, 1.45, .99, '#d3c4a6', pick);
      batch.add(x + .5, 1.56, y + .5, 1.05, .22, 1.05, COLORS.roof, pick);
      if (definition.terrain?.[y + 1]?.[x] !== 'building') batch.add(x + .5, .83, y + 1.005, .32, .43, .04, COLORS.glass, pick, 'glow');
    }
    if (type === 'fountain') furniture(batch, { x, y, type: 'fountain' });
    if (type === 'garden' && (x + y) % 2 === 0) furniture(batch, { x, y, type: 'flowers' });
  }
  for (const item of plan.objects) furniture(batch, item);
  for (const item of plan.portals) {
    const pick = { x: item.x, y: item.y, z: 0, type: 'portal', portal: item };
    for (const dx of [-.62, .62]) batch.add(item.x + .5 + dx, 1.1, item.y + .5, .2, 2.2, .2, '#78998b', pick);
    batch.add(item.x + .5, 2.17, item.y + .5, 1.45, .22, .22, COLORS.gold, pick, 'glow');
    batch.add(item.x + .5, .03, item.y + .5, 1.28, .07, .8, '#9dccb6', pick, 'glow');
  }
  for (const item of plan.gates) {
    const pick = { x: item.x, y: item.y, z: 0, type: 'gate', neighbor: item };
    for (const dx of [-.62, .62]) batch.add(item.x + .5 + dx, 1, item.y + .5, .22, 2, .22, COLORS.trunk, pick);
    batch.add(item.x + .5, 2.04, item.y + .5, 1.46, .23, .23, COLORS.gold, pick, 'glow');
    batch.add(item.x + .5, .8, item.y + .5, 1.24, .1, .12, '#98ac96', pick);
    batch.add(item.x + .5, 1.36, item.y + .5, .2, .2, .2, COLORS.gold, pick, 'glow');
  }
  // Landmark pennants are navigation markers; they do not imply a live participant.
  for (const item of (definition.landmarks || []).filter(place => inVoxelWindow(place, plan.window)).slice(0, 40)) {
    batch.add(item.x + .92, 1.2, item.y + .08, .045, 2.4, .045, COLORS.dark);
    batch.add(item.x + 1.2, 2.17, item.y + .08, .55, .38, .04, validColor(item.color) || COLORS.gold);
  }
  if (definition.kind !== 'interior') {
    const centerX = (plan.window.x + plan.window.right) / 2, centerY = (plan.window.y + plan.window.bottom) / 2;
    for (const [dx, dy, size] of [[-12, -9, 1], [9, -13, 1.3], [-10, 13, .8], [15, 8, 1.1]]) {
      for (const [cx, cy, length] of [[0, 0, 4.4], [1.2, .8, 3], [-1.1, -.4, 3.2]]) batch.add(centerX + dx + cx, 10 + cy * .1, centerY + dy + cy, length * size, .5 * size, 1.6 * size, '#e1ebe4');
    }
  }
  const result = batch.finish();
  // All click targets retain the tile's parcel, including trees and saved furnishings.
  for (const mesh of result.pickables) mesh.userData.picks = mesh.userData.picks.map(pick => pick ? withParcel(pick) : pick);
  return result;
}

/** Saved blocks batch apart from the terrain so placing one block never rebuilds the diorama. */
function blocksScene(resources, definition, plan) {
  const batch = cubeBatch(resources), withParcel = parcelAttacher(definition, plan);
  for (const item of plan.blocks) {
    const material = item.material || item.type || item.kind, path = material === 'path' && item.z === 0;
    batch.add(item.x + .5, path ? .045 : item.z + .5, item.y + .5, .99, path ? .09 : .99, .99,
      COLORS[material] || COLORS.stone, withParcel({ x: item.x, y: item.y, z: item.z, type: 'block', block: item }), material === 'glass' ? 'glass' : 'solid');
  }
  const result = batch.finish(); result.group.name = 'voxel-blocks';
  return result;
}

function parcelScene(resources, plan, selection, hover) {
  const batch = cubeBatch(resources), edges = new Map(), selected = voxelParcelSelection(plan.parcels, selection), hovered = voxelParcelSelection(plan.parcels, hover);
  const { window } = plan;
  const palette = { reserved: '#799e99', assigned: '#87bfa3', available: '#cbbb83', unopened: '#94a49b' };
  const priority = { reserved: 2, assigned: 3, available: 1, unopened: 0 };
  function footprint(parcel, width, color, style) {
    const x0 = Math.max(window.x, parcel.x), y0 = Math.max(window.y, parcel.y), x1 = Math.min(window.right, parcel.x + 6), y1 = Math.min(window.bottom, parcel.y + 6);
    const height = style === 'parcel-boundary' ? .025 : .08;
    if (parcel.x >= window.x) batch.add(parcel.x, height, (y0 + y1) / 2, width, .03, y1 - y0, color, null, style);
    if (parcel.x + 6 <= window.right) batch.add(parcel.x + 6, height, (y0 + y1) / 2, width, .03, y1 - y0, color, null, style);
    if (parcel.y >= window.y) batch.add((x0 + x1) / 2, height, parcel.y, x1 - x0, .03, width, color, null, style);
    if (parcel.y + 6 <= window.bottom) batch.add((x0 + x1) / 2, height, parcel.y + 6, x1 - x0, .03, width, color, null, style);
  }
  for (const parcel of plan.parcels) {
    const state = Object.hasOwn(palette, parcel.state) ? parcel.state : 'unopened', color = palette[state];
    for (const [axis, fixed, start, end] of [['v', parcel.x, parcel.y, parcel.y + 6], ['v', parcel.x + 6, parcel.y, parcel.y + 6], ['h', parcel.y, parcel.x, parcel.x + 6], ['h', parcel.y + 6, parcel.x, parcel.x + 6]]) {
      const low = axis === 'v' ? window.y : window.x, high = axis === 'v' ? window.bottom : window.right;
      const visibleFixed = axis === 'v' ? fixed >= window.x && fixed <= window.right : fixed >= window.y && fixed <= window.bottom;
      if (!visibleFixed) continue;
      const clippedStart = Math.max(start, low), clippedEnd = Math.min(end, high), key = `${axis}:${fixed}:${clippedStart}:${clippedEnd}`, old = edges.get(key);
      if (!old || priority[state] > old.priority) edges.set(key, { axis, fixed, start: clippedStart, end: clippedEnd, color, priority: priority[state] });
    }
  }
  for (const edge of edges.values()) batch.add(edge.axis === 'v' ? edge.fixed : (edge.start + edge.end) / 2, .025,
    edge.axis === 'v' ? (edge.start + edge.end) / 2 : edge.fixed, edge.axis === 'v' ? .025 : edge.end - edge.start, .025,
    edge.axis === 'v' ? edge.end - edge.start : .025, edge.color, null, 'parcel-boundary');
  // The protected crossroads have a separate visible lane edge within reserved plots.
  if (plan.parcels.length) for (const coordinate of [23, 26]) {
    if (coordinate >= window.x && coordinate <= window.right) batch.add(coordinate, .05, (window.y + window.bottom) / 2, .07, .035, window.bottom - window.y, '#a6cbc0', null, 'parcel-boundary');
    if (coordinate >= window.y && coordinate <= window.bottom) batch.add((window.x + window.right) / 2, .05, coordinate, window.right - window.x, .035, .07, '#a6cbc0', null, 'parcel-boundary');
  }
  if (hovered && hovered.id !== selected?.id) footprint(hovered, .065, hovered.state === 'reserved' ? '#aad3ce' : '#ddd0a4', 'parcel-hover');
  if (selected) {
    const color = selected.state === 'reserved' ? '#b2dbd4' : '#f2d891'; footprint(selected, .11, color, 'parcel-selected');
    const x0 = Math.max(window.x, selected.x), y0 = Math.max(window.y, selected.y), x1 = Math.min(window.right, selected.x + 6), y1 = Math.min(window.bottom, selected.y + 6);
    batch.add((x0 + x1) / 2, .01, (y0 + y1) / 2, x1 - x0, .008, y1 - y0, color, null, 'parcel-fill');
  }
  const result = batch.finish(); result.group.name = 'parcel-overlay'; result.group.userData = { selectedParcel: selected?.id || null, hoveredParcel: hovered?.id || null, parcels: plan.parcels.length };
  for (const mesh of result.group.children) { mesh.castShadow = false; mesh.receiveShadow = false; mesh.renderOrder = 8; }
  return result;
}

// Every field peopleScene reads, including `z`: elevation moves the whole body. Roster order is
// deliberately not part of the key, because instance order is invisible and the server re-sorts by
// `last_seen` on each poll.
const PEOPLE_FIELDS = Object.freeze(['id', 'x', 'y', 'z', 'posture', 'color', 'kind']);

/** The participants peopleScene draws: self is appended when the roster omits it, then bounded and placed. */
const renderablePeople = (participants, self) => {
  const people = self && !participants.some(item => item.id === self.id) ? [...participants, self] : participants;
  return people.slice(0, VOXEL_LIMITS.participants).filter(item => Number.isInteger(item?.x) && Number.isInteger(item?.y));
};

/**
 * Character batch key projected onto the visible fields above. Polls that only refresh `last_seen`,
 * re-order the roster, or change curated profile fields therefore reuse every existing batch instead
 * of disposing and rebuilding all avatars every few seconds.
 */
export function peopleVisualKey(participants, self) {
  return JSON.stringify([self?.id || null, renderablePeople(participants, self)
    .map(item => [...PEOPLE_FIELDS.map(field => item[field] ?? null), callingStyle(item) ? item.calling.id : null]).sort()]);
}

// Fresh names, public profiles and presence belong to current picks even when their geometry is reused.
function refreshPeoplePicks(batch, participants, self) {
  const records = new Map(renderablePeople(participants, self).map(item => [item.id, {
    x: item.x, y: item.y, z: item.z || 0, type: 'participant', participant: item,
  }]));
  for (const mesh of batch.pickables) mesh.userData.picks = mesh.userData.picks.map(pick => pick ? records.get(pick.participant?.id) || null : null);
}

function peopleScene(resources, participants, self) {
  const batch = cubeBatch(resources);
  for (const item of renderablePeople(participants, self)) {
    const npc = item.kind === 'npc', elevation = item.z || 0, pick = { x: item.x, y: item.y, z: item.z || 0, type: 'participant', participant: item };
    const color = validColor(item.color) || AGENT_COLORS[item.color] || '#649b8a', n = hash(item.id), skin = ['#d4a17b', '#b27f59', '#e4b995', '#997456'][n % 4];
    const x = item.x + .5, y = item.y + .5, sitting = ['sitting', 'meditating'].includes(item.posture), height = elevation + (sitting ? -.26 : 0);
    batch.add(x, .04 + elevation, y, .62, .06, .62, item.id === self?.id ? COLORS.gold : '#607b65');
    for (const dx of [-.12, .12]) batch.add(x + dx, .22 + elevation, y, .18, sitting ? .25 : .4, .21, COLORS.dark, pick);
    batch.add(x, .68 + height, y, .46, .54, .26, color, pick);
    for (const dx of [-.31, .31]) { batch.add(x + dx, .7 + height, y, .13, .4, .19, color, pick); batch.add(x + dx, .46 + height, y, .13, .12, .18, skin, pick); }
    batch.add(x, 1.12 + height, y, .42, .4, .4, skin, pick);
    batch.add(x, 1.33 + height, y - .025, .44, .1, .43, npc ? COLORS.gold : COLORS.dark, pick);
    for (const dx of [-.09, .09]) batch.add(x + dx, 1.13 + height, y + .205, .045, .05, .035, COLORS.dark, pick);
    const calling = callingStyle(item);
    if (calling) {
      const emblemX = x - .13, emblemHeight = .82 + height, emblemY = y + .164;
      batch.add(emblemX, emblemHeight, emblemY, .14, .18, .052, calling.color, pick);
      const pixel = (dx, dy, width = .027, depth = .028) => batch.add(emblemX + dx, emblemHeight + dy, emblemY + .03, width, depth, .014, COLORS.cream, pick);
      if (calling.mark === 'cross') { pixel(0, 0, .026, .1); pixel(0, 0, .09, .026); }
      else if (calling.mark === 'arch' || calling.mark === 'bridge') { pixel(-.03, -.018, .022, .08); pixel(.03, -.018, .022, .08); pixel(0, .027, .084, .022); }
      else if (calling.mark === 'sprout') { pixel(0, -.019, .022, .07); pixel(-.025, .025, .039, .025); pixel(.025, .041, .039, .025); }
      else if (calling.mark === 'book') { pixel(-.023, 0, .027, .1); pixel(.023, 0, .027, .1); }
      else { pixel(0, .039); pixel(-.029, 0); pixel(.029, 0); pixel(0, -.039); }
    }
    if (npc) { batch.add(x, .84 + height, y + .15, .065, .38, .045, COLORS.gold, pick); for (const dx of [-.14, 0, .14]) batch.add(x + dx, 1.43 + height, y, .07, .17, .07, COLORS.gold, pick); }
  }
  return batch.finish();
}

const disposeBatch = batch => { if (!batch) return; for (const mesh of batch.group.children) mesh.dispose(); batch.group.clear(); };

/** A GPU-independent scene builder used by rendering and real Raycaster tests. */
export function createVoxelScene() {
  const resources = createResources(), root = new THREE.Group(); let staticBatch, blockBatch, peopleBatch, parcelBatch, key = '', blockKey = '', peopleKey = '', parcelKey = '', lastPlan, destroyed = false;
  let stats = { cells: 0, blocks: 0, participants: 0, cubes: 0, drawBatches: 0 }, pickables = [];
  return { root,
    update(definition, snapshot = {}, options = {}) {
      if (destroyed) throw new Error('The voxel scene has been destroyed.');
      const position = options.position || options.self || definition.start, plan = voxelPlan(definition, snapshot, position);
      const cullHidden = options.cullHidden !== false;
      const nextKey = JSON.stringify([definition.id, definition.kind, definition.groundColor, plan.cells, plan.objects, plan.portals, plan.gates, cullHidden]);
      if (nextKey !== key) {
        if (staticBatch) root.remove(staticBatch.group); disposeBatch(staticBatch);
        staticBatch = terrainScene(resources, definition, snapshot, plan, cullHidden); staticBatch.group.name = 'voxel-terrain'; root.add(staticBatch.group); key = nextKey;
      }
      const firstPerson = options.cameraMode === 'first-person', drawnSelf = firstPerson ? null : options.self;
      const drawnPeople = firstPerson ? plan.participants.filter(item => item.id !== options.self?.id) : plan.participants;
      // The projected key ignores volatile roster fields; `rebuildPeople` restores the raw payload key.
      const nextPeopleKey = options.rebuildPeople === true ? JSON.stringify([drawnPeople, drawnSelf]) : peopleVisualKey(drawnPeople, drawnSelf);
      if (nextPeopleKey !== peopleKey || !peopleBatch) {
        if (peopleBatch) root.remove(peopleBatch.group); disposeBatch(peopleBatch);
        peopleBatch = peopleScene(resources, drawnPeople, drawnSelf); peopleBatch.group.name = 'voxel-characters'; root.add(peopleBatch.group); peopleKey = nextPeopleKey;
      }
      refreshPeoplePicks(peopleBatch, drawnPeople, drawnSelf);
      // Saved blocks rebuild on their own, so placing or moving one block leaves the diorama alone.
      const nextBlockKey = JSON.stringify([definition.id, definition.kind, plan.blocks, plan.parcels]);
      if (nextBlockKey !== blockKey) {
        if (blockBatch) root.remove(blockBatch.group); disposeBatch(blockBatch);
        blockBatch = plan.blocks.length ? blocksScene(resources, definition, plan) : null;
        if (blockBatch) root.add(blockBatch.group); blockKey = nextBlockKey;
      }
      lastPlan = plan;
      this.highlightParcel(options.parcelSelection, options.parcelHover);
      pickables = [...staticBatch.pickables, ...peopleBatch.pickables, ...(blockBatch?.pickables || [])];
      stats = { cells: plan.cells.length, blocks: plan.blocks.length, participants: renderablePeople(drawnPeople, drawnSelf).length,
        cubes: staticBatch.cubes + (blockBatch?.cubes || 0) + peopleBatch.cubes + (parcelBatch?.cubes || 0), parcelCubes: parcelBatch?.cubes || 0,
        drawBatches: staticBatch.batches + (blockBatch?.batches || 0) + peopleBatch.batches + (parcelBatch?.batches || 0),
        parcels: plan.parcels.length, selectedParcel: parcelBatch?.group.userData.selectedParcel || null, window: plan.window };
      root.updateMatrixWorld(true); return stats;
    },
    highlightParcel(selection, hover) {
      if (destroyed || !lastPlan) return;
      const selected = voxelParcelSelection(lastPlan.parcels, selection), hovered = voxelParcelSelection(lastPlan.parcels, hover);
      const nextKey = JSON.stringify([lastPlan.window, lastPlan.parcels.map(parcel => [parcel.id, parcel.state]), selected?.id, hovered?.id]);
      if (nextKey === parcelKey) return;
      if (parcelBatch) root.remove(parcelBatch.group); disposeBatch(parcelBatch);
      parcelBatch = lastPlan.parcels.length ? parcelScene(resources, lastPlan, selected, hovered) : null;
      if (parcelBatch) root.add(parcelBatch.group); parcelKey = nextKey; root.updateMatrixWorld(true);
      stats.selectedParcel = selected?.id || null;
      stats.parcelCubes = parcelBatch?.cubes || 0;
      stats.cubes = (staticBatch?.cubes || 0) + (blockBatch?.cubes || 0) + (peopleBatch?.cubes || 0) + (parcelBatch?.cubes || 0);
      stats.drawBatches = (staticBatch?.batches || 0) + (blockBatch?.batches || 0) + (peopleBatch?.batches || 0) + (parcelBatch?.batches || 0);
    },
    get pickables() { return pickables; }, get stats() { return stats; },
    destroy() { if (destroyed) return; destroyed = true; disposeBatch(staticBatch); disposeBatch(blockBatch); disposeBatch(peopleBatch); disposeBatch(parcelBatch); resources.dispose(); root.clear(); pickables = []; key = ''; blockKey = ''; lastPlan = null; }
  };
}

/** Event-driven third-person view. No network, pointer lock, animation loop, or movement authority. */
export function createVoxelWorld(canvas, { onPick, onHover, onLook, onUnavailable } = {}) {
  const unavailable = () => { onUnavailable?.('3D graphics are unavailable in this browser. The map view remains available.'); return null; };
  if (!canvas?.getContext || !canvas.addEventListener) return unavailable();
  let context;
  try { context = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'low-power' }); } catch { return unavailable(); }
  if (!context) return unavailable();
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: false }); } catch { return unavailable(); }
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(48, 1, .1, 100), contents = createVoxelScene(); scene.add(contents.root);
  const sky = new THREE.HemisphereLight('#e8f3ed', '#667b56', 2.1), sun = new THREE.DirectionalLight('#fff1d0', 2.6);
  sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = -24; sun.shadow.camera.right = 24;
  sun.shadow.camera.top = 24; sun.shadow.camera.bottom = -24; sun.shadow.camera.near = .5; sun.shadow.camera.far = 65;
  sun.shadow.bias = -.001; sun.shadow.normalBias = .03; scene.add(sky, sun, sun.target);
  const selectionBox = new THREE.BoxGeometry(1.025, 1.025, 1.025), selectionGeometry = new THREE.EdgesGeometry(selectionBox); selectionBox.dispose();
  const selectionMaterial = new THREE.LineBasicMaterial({ color: '#fff0b0', depthTest: false });
  const selection = new THREE.LineSegments(selectionGeometry, selectionMaterial); selection.visible = false; selection.renderOrder = 10; scene.add(selection);
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  const orbitInput = createOrbitInput({ onLook });
  let target = { x: 10, y: 6 }, destroyed = false, lost = false, drag = null, lastSnapshot, lastOptions, hoveredParcel = null, lastHoverAt = -Infinity;
  const previousTouchAction = canvas.style.touchAction; canvas.style.touchAction = 'pan-y';
  function resize() {
    const bounds = canvas.getBoundingClientRect(), width = Math.max(1, bounds.width || canvas.width || 800), height = Math.max(1, bounds.height || canvas.height || 560);
    const scale = Math.min(1, 1440 / width, 900 / height), renderWidth = Math.round(width * scale), renderHeight = Math.round(height * scale);
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x !== renderWidth || size.y !== renderHeight) renderer.setSize(renderWidth, renderHeight, false);
    camera.aspect = width / height; camera.updateProjectionMatrix();
  }
  function paint() {
    if (destroyed || lost || !lastSnapshot) return;
    resize(); const placement = orbitInput.mode === 'first-person' ? firstPersonCamera(target, orbitInput.orbit) : orbitCamera(target, orbitInput.orbit);
    camera.position.set(placement.eye.x, placement.eye.y, placement.eye.z); camera.lookAt(placement.target.x, placement.target.y, placement.target.z); camera.updateMatrixWorld();
    const night = ['night', 'evening'].includes(lastOptions?.dayPhase || lastSnapshot.atmosphere?.phase);
    scene.background = new THREE.Color(night ? '#789495' : '#b8d5cd'); scene.fog = new THREE.Fog(scene.background, 25, 48);
    sky.intensity = night ? 1.2 : 2.1; sun.intensity = night ? 1.1 : 2.6;
    sun.position.set(target.x - 14, 25, target.y + 9); sun.target.position.set(target.x, 0, target.y); sun.target.updateMatrixWorld();
    const selected = lastOptions?.selection;
    selection.visible = !!selected && Number.isInteger(selected.x) && Number.isInteger(selected.y);
    if (selection.visible) selection.position.set(selected.x + .5, Math.max(0, selected.z || 0) + .5, selected.y + .5);
    renderer.render(scene, camera);
  }
  const movePointer = event => {
    if (!drag) {
      if (destroyed || lost || !lastSnapshot || event.pointerType === 'touch') return;
      const now = globalThis.performance?.now?.() ?? Date.now();
      if (now - lastHoverAt < 75) return; lastHoverAt = now;
      const pick = pickPointer(event), parcel = pick?.parcel || null;
      if (parcel?.id !== hoveredParcel?.id) { hoveredParcel = parcel; contents.highlightParcel(lastOptions?.parcelSelection, hoveredParcel); paint(); onHover?.(pick || null); }
      return;
    }
    if (event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y; drag.distance += Math.abs(dx) + Math.abs(dy);
    if (drag.distance > 6) { orbitInput.drag(dx, dy); paint(); }
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
  const leave = () => { if (destroyed || !hoveredParcel) return; hoveredParcel = null; contents.highlightParcel(lastOptions?.parcelSelection, null); paint(); onHover?.(null); };
  const contextLost = event => { event.preventDefault(); lost = true; drag = null; onUnavailable?.('The 3D view lost its graphics context. Switch to the map view.'); };
  const contextRestored = () => { if (destroyed) return; lost = false; paint(); };
  const listeners = [['pointerdown', down], ['pointermove', movePointer], ['pointerup', up], ['pointerleave', leave], ['pointercancel', cancel], ['lostpointercapture', cancel], ['webglcontextlost', contextLost], ['webglcontextrestored', contextRestored]];
  for (const [name, handler] of listeners) canvas.addEventListener(name, handler);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(paint) : null; observer?.observe(canvas);
  return {
    render(snapshot, options = {}) {
      if (destroyed) return;
      const definition = options.definition || getWorldDefinition(snapshot.world || 'commons');
      orbitInput.setMode(options.cameraMode ?? orbitInput.mode);
      if (options.facing) orbitInput.set(options.facing);
      target = options.position || options.self || definition.start; lastSnapshot = snapshot; lastOptions = options;
      contents.update(definition, snapshot, { ...options, cameraMode: orbitInput.mode, parcelHover: hoveredParcel }); paint(); return contents.stats;
    },
    rotate(deltaYaw = 0, deltaPitch = 0) { if (destroyed) return; orbitInput.rotate(deltaYaw, deltaPitch); paint(); },
    zoom(delta = 0) { if (destroyed) return; orbitInput.zoom(delta); paint(); },
    setOrbit(value = {}) { if (destroyed) return; orbitInput.set(value); paint(); },
    setCameraMode(value) {
      if (destroyed) return; orbitInput.setMode(value);
      if (lastSnapshot) {
        lastOptions = { ...lastOptions, cameraMode: orbitInput.mode };
        const definition = lastOptions.definition || getWorldDefinition(lastSnapshot.world || 'commons');
        contents.update(definition, lastSnapshot, { ...lastOptions, parcelHover: hoveredParcel });
      }
      paint();
    },
    get cameraMode() { return orbitInput.mode; },
    get orbit() { return orbitInput.orbit; }, get stats() { return contents.stats; },
    destroy() {
      if (destroyed) return; destroyed = true; observer?.disconnect(); drag = null;
      for (const [name, handler] of listeners) canvas.removeEventListener(name, handler);
      canvas.style.touchAction = previousTouchAction; contents.destroy(); selectionGeometry.dispose(); selectionMaterial.dispose();
      sun.shadow.map?.dispose(); renderer.dispose(); renderer.forceContextLoss(); lastSnapshot = null; lastOptions = null;
    }
  };
}

// One global map: a fixed layout of rectangles, one per outdoor world, and the projection between a
// stored position (world_id, x, y) and a global tile (gx, gy). See docs/GLOBAL_MAP.md.
//
// Pure: no database, no DOM, no import of the world catalogue (world.js imports this module, and hands
// the seam pass the raw world definitions it needs). Global coordinates are derived and never stored, so
// a layout revision costs a code change and a test update, never a data migration.
//
// Interiors, authored venues, country venues, homes and houses are not on the grid: the projection
// returns null for them, and they stay separate spaces entered through a door that sits on the map.

export const MAP_ID = 'map:core';
export const MAP_COLUMNS = 288;
export const MAP_ROWS = 208;
/** Tiles of each side of a seam kept free of solid scenery, so no fixture straddles a join. */
export const SEAM_CLEAR_DEPTH = 3;
/** Width of the road that crosses a seam. */
export const AVENUE_WIDTH = 3;
/** How far a presence delta is shared with the world across a seam (the voxel window radius). */
export const SEAM_WATCH_RADIUS = 18;

const rect = (world, x, y, width, height) => Object.freeze({ world, x, y, width, height });
/** Phase 1: the Commons and its eight neighbours. Sizes are checked against the world definitions by a test. */
export const MAP_LAYOUT = Object.freeze([
  rect('commons', 96, 72, 96, 64),
  rect('district:highlands', 96, 36, 48, 36),
  rect('district:snowline', 144, 36, 48, 36),
  rect('district:woodlands', 48, 72, 48, 36),
  rect('district:farmlands', 192, 72, 48, 36),
  rect('orchard', 56, 108, 40, 28),
  rect('harbor', 192, 108, 40, 28),
  rect('district:coast', 96, 136, 48, 36),
  rect('district:harbor', 144, 136, 48, 36),
]);

const byWorld = new Map(MAP_LAYOUT.map((item) => [item.world, item]));
export const mapRect = (worldId) => byWorld.get(worldId) || null;
export const onMap = (worldId) => byWorld.has(worldId);

/** The bounding box of every placed rectangle: what a minimap shows. */
export const MAP_BOUNDS = Object.freeze((() => {
  const left = Math.min(...MAP_LAYOUT.map((item) => item.x)), top = Math.min(...MAP_LAYOUT.map((item) => item.y));
  const right = Math.max(...MAP_LAYOUT.map((item) => item.x + item.width)), bottom = Math.max(...MAP_LAYOUT.map((item) => item.y + item.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
})());

const isInt = Number.isInteger;

/** (world, local x, y) -> { gx, gy }, or null when the world is not a rectangle of the map. */
export function toGlobal(worldId, x, y) {
  const item = byWorld.get(worldId);
  if (!item || !isInt(x) || !isInt(y)) return null;
  return { gx: item.x + x, gy: item.y + y };
}

/** (gx, gy) -> { world_id, x, y }, or null over the sea. Total on integers. */
export function fromGlobal(gx, gy) {
  if (!isInt(gx) || !isInt(gy)) return null;
  for (const item of MAP_LAYOUT) {
    if (gx >= item.x && gx < item.x + item.width && gy >= item.y && gy < item.y + item.height) return { world_id: item.world, x: gx - item.x, y: gy - item.y };
  }
  return null;
}

export const DIRECTION_OFFSETS = Object.freeze({ up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] });

/**
 * The tile a step lands on when it leaves a world of the map into a neighbour: null while the step stays
 * inside the world, or when it leaves the map (or lands on a tile of no world).
 */
export function neighbourStep(worldId, x, y, direction) {
  const item = byWorld.get(worldId), offset = DIRECTION_OFFSETS[direction];
  if (!item || !offset || !isInt(x) || !isInt(y)) return null;
  const nx = x + offset[0], ny = y + offset[1];
  if (nx >= 0 && ny >= 0 && nx < item.width && ny < item.height) return null;
  return fromGlobal(item.x + nx, item.y + ny);
}

/** Manhattan distance in global tiles between two stored positions, or null when either is off the map. */
export function mapDistance(a, b) {
  const from = toGlobal(a?.world_id, a?.x, a?.y), to = toGlobal(b?.world_id, b?.x, b?.y);
  return from && to ? Math.abs(from.gx - to.gx) + Math.abs(from.gy - to.gy) : null;
}

/** The rectangles a global window [gx, gx + width) x [gy, gy + height) overlaps, each with its local window. */
export function worldRects(gx, gy, width, height) {
  const found = [];
  for (const item of MAP_LAYOUT) {
    const left = Math.max(gx, item.x), top = Math.max(gy, item.y);
    const right = Math.min(gx + width, item.x + item.width), bottom = Math.min(gy + height, item.y + item.height);
    if (left < right && top < bottom) found.push({ world_id: item.world, rect: item, x: left - item.x, y: top - item.y, right: right - item.x, bottom: bottom - item.y });
  }
  return found;
}

/** Worlds (other than `worldId`) whose rectangle lies within `radius` tiles of a stored position. */
export function nearbyWorlds(worldId, x, y, radius = SEAM_WATCH_RADIUS) {
  const here = toGlobal(worldId, x, y);
  if (!here) return [];
  return MAP_LAYOUT.filter((item) => item.world !== worldId
    && here.gx >= item.x - radius && here.gx < item.x + item.width + radius && here.gy >= item.y - radius && here.gy < item.y + item.height + radius).map((item) => item.world);
}

/**
 * The seams: every pair of rectangles that share an edge. `axis` 'v' is a vertical edge (`line` is the
 * global x of the first tile of `b`), 'h' a horizontal one (`line` is the global y of the first tile of
 * `b`); `from`..`to` is the shared stretch along the other axis, `to` exclusive.
 */
export function seams(layout = MAP_LAYOUT) {
  const found = [];
  for (const a of layout) for (const b of layout) {
    if (a === b) continue;
    if (a.x + a.width === b.x) {
      const from = Math.max(a.y, b.y), to = Math.min(a.y + a.height, b.y + b.height);
      if (from < to) found.push({ a: a.world, b: b.world, axis: 'v', line: b.x, from, to });
    } else if (a.y + a.height === b.y) {
      const from = Math.max(a.x, b.x), to = Math.min(a.x + a.width, b.x + b.width);
      if (from < to) found.push({ a: a.world, b: b.world, axis: 'h', line: b.y, from, to });
    }
  }
  return found;
}

/**
 * Where a road crosses each seam: the global coordinate along the seam of the avenue's centre line. A seam
 * with no entry has no avenue (its border is only opened). Keys are "<a>|<b>" in the order `seams()` returns.
 * Centres sit on roads both worlds already have, so a Commons road continues as a district road.
 */
export const AVENUES = Object.freeze({
  'district:highlands|commons': [121], 'district:snowline|commons': [169],
  'commons|district:coast': [121], 'commons|district:harbor': [169],
  'district:woodlands|commons': [92], 'commons|district:farmlands': [92],
  'orchard|commons': [122], 'commons|harbor': [123],
  'district:highlands|district:snowline': [54], 'district:coast|district:harbor': [154],
  'district:woodlands|orchard': [72],
});
const AVENUE_TABLE = AVENUES;

const avenuesOf = (seam) => AVENUE_TABLE[`${seam.a}|${seam.b}`] || [];

// ---------------------------------------------------------------------------------------------
// The seam pass. world.js runs it on a freshly built definition, handing in `rawOf(worldId)`: the
// neighbour's definition before any seam is applied. Each world edits only its own tiles, from a
// decision that both sides compute identically, so the browser and the server cannot disagree.
// ---------------------------------------------------------------------------------------------
const BLOCKING_TERRAIN = new Set(['water', 'tree', 'building', 'fountain', 'wall']);
const ROAD = new Set(['path', 'plaza', 'bridge']);
const MASS_OBJECTS = new Set(['cottage', 'civic-building', 'tree', 'fruit', 'palm', 'cactus', 'mountain', 'pond', 'fountain', 'bench', 'table', 'workbench', 'bookshelf',
  'bed', 'boat', 'telescope', 'display', 'sculpture', 'kitchen', 'lamp', 'lantern', 'trellis', 'well', 'birdbath', 'sundial', 'millstone']);

const tileKey = (x, y) => `${x},${y}`;

/** The edge tiles of one side of a seam, as pairs [mine, theirs] in local coordinates, with depth-0 first. */
function facing(seam, worldId) {
  const mine = byWorld.get(worldId), side = seam.a === worldId ? 'a' : 'b', other = byWorld.get(side === 'a' ? seam.b : seam.a), pairs = [];
  for (let k = seam.from; k < seam.to; k++) {
    const own = seam.axis === 'v' ? { x: side === 'a' ? mine.width - 1 : 0, y: k - mine.y } : { x: k - mine.x, y: side === 'a' ? mine.height - 1 : 0 };
    const their = seam.axis === 'v' ? { x: side === 'a' ? 0 : other.width - 1, y: k - other.y } : { x: k - other.x, y: side === 'a' ? 0 : other.height - 1 };
    pairs.push({ k, own, their, inward: seam.axis === 'v' ? [side === 'a' ? -1 : 1, 0] : [0, side === 'a' ? -1 : 1] });
  }
  return { pairs, other: other.world, side };
}

const openTile = (definition, x, y) => {
  const type = definition.terrain?.[y]?.[x];
  if (typeof type !== 'string' || BLOCKING_TERRAIN.has(type)) return false;
  return !(definition.objects || []).some((item) => item.x === x && item.y === y && MASS_OBJECTS.has(item.type));
};

/**
 * Edit `definition` (a world of the layout, before any seam) in place and return it:
 *   1. open border   a `tree` tile facing an open tile of the neighbour, with open ground behind it, becomes `meadow`; a tile is never closed;
 *   2. clear zone    solid scenery on a non-tree tile within SEAM_CLEAR_DEPTH of the seam is removed;
 *   3. avenue        a 3-wide road runs from the seam inward to the first road, bridging water on the way.
 */
export function applySeams(definition, rawOf) {
  const worldId = definition?.id;
  if (!byWorld.has(worldId)) return definition;
  const rows = definition.terrain, removed = new Set();
  const objects = definition.objects || (definition.objects = []);
  const drop = (x, y) => removed.add(tileKey(x, y));
  const inside = (x, y) => y >= 0 && x >= 0 && y < rows.length && x < rows[0].length;
  for (const seam of seams().filter((item) => item.a === worldId || item.b === worldId)) {
    const { pairs, other } = facing(seam, worldId), neighbour = rawOf(other);
    // 1. open border
    for (const pair of pairs) {
      // Only a tree with open ground behind it is opened, so no walkable tile is ever left cut off from its own world.
      if (rows[pair.own.y][pair.own.x] === 'tree' && openTile(neighbour, pair.their.x, pair.their.y)
        && openTile(definition, pair.own.x + pair.inward[0], pair.own.y + pair.inward[1])) { rows[pair.own.y][pair.own.x] = 'meadow'; drop(pair.own.x, pair.own.y); }
    }
    // 2. clear zone
    for (const pair of pairs) for (let depth = 0; depth < SEAM_CLEAR_DEPTH; depth++) {
      const x = pair.own.x + pair.inward[0] * depth, y = pair.own.y + pair.inward[1] * depth;
      if (!inside(x, y) || rows[y][x] === 'tree') continue;
      for (const item of objects) if (item.x === x && item.y === y && MASS_OBJECTS.has(item.type)) drop(x, y);
    }
    // 3. avenue
    for (const centre of avenuesOf(seam)) {
      const middle = pairs.find((pair) => pair.k === centre);
      if (!middle) continue;
      for (let depth = 0; depth < Math.max(rows.length, rows[0].length); depth++) {
        const lane = [-1, 0, 1].map((offset) => seam.axis === 'v'
          ? { x: middle.own.x + middle.inward[0] * depth, y: middle.own.y + offset } : { x: middle.own.x + offset, y: middle.own.y + middle.inward[1] * depth });
        if (lane.some((tile) => !inside(tile.x, tile.y))) break;
        if (lane.some((tile) => ROAD.has(rows[tile.y][tile.x]))) break;
        for (const tile of lane) { rows[tile.y][tile.x] = rows[tile.y][tile.x] === 'water' ? 'bridge' : 'path'; drop(tile.x, tile.y); }
      }
    }
  }
  if (removed.size) definition.objects = objects.filter((item) => !removed.has(tileKey(item.x, item.y)) || !(MASS_OBJECTS.has(item.type) || item.type === 'flowers' || item.type === 'farm'));
  return definition;
}

/**
 * The stitched definition: every placed world's terrain, scenery, landmarks and portals in global
 * coordinates, in the shape every consumer of a world definition already understands. Tiles of no world
 * are `null`, which `walkable()` and the renderer treat as absent. It is a *view*: never a storable world.
 */
export function stitchMap(definitionOf) {
  const terrain = Array.from({ length: MAP_ROWS }, () => Array(MAP_COLUMNS).fill(null));
  const objects = [], landmarks = [], portals = [], grounds = new Map();
  for (const item of MAP_LAYOUT) {
    const part = definitionOf(item.world);
    grounds.set(item.world, part.groundColor || null);
    for (let y = 0; y < item.height; y++) for (let x = 0; x < item.width; x++) terrain[item.y + y][item.x + x] = part.terrain[y][x];
    for (const object of part.objects || []) objects.push({ ...object, x: object.x + item.x, y: object.y + item.y, world_id: item.world });
    for (const place of part.landmarks || []) landmarks.push({ ...place, x: place.x + item.x, y: place.y + item.y, world_id: item.world });
    for (const portal of part.portals || []) portals.push({ ...portal, x: portal.x + item.x, y: portal.y + item.y, world_id: item.world });
  }
  const commons = definitionOf('commons'), home = toGlobal('commons', commons.start.x, commons.start.y);
  return {
    id: MAP_ID, name: 'The Shared World', kind: 'outdoors', columns: MAP_COLUMNS, rows: MAP_ROWS, width: MAP_COLUMNS, height: MAP_ROWS,
    start: { x: home.gx, y: home.gy }, terrain, objects, landmarks, portals, bounds: MAP_BOUNDS,
    groundColor: grounds.get('commons') || null,
    groundAt(gx, gy) { const place = fromGlobal(gx, gy); return place ? grounds.get(place.world_id) || null : null; },
    description: 'The Commons and its neighbouring districts, joined edge to edge.', ambiance: 'One continuous landscape.',
  };
}

/** Whether the server lets residents walk across seams and serves the `map=` window. */
export function mapEnabled(env = globalThis.process?.env || {}) {
  const value = String(env.GLOBAL_MAP ?? '').toLowerCase();
  if (['1', 'on', 'true', 'yes'].includes(value)) return true;
  if (['0', 'off', 'false', 'no'].includes(value)) return false;
  return env.NODE_ENV !== 'production';
}

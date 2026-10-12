// One source of truth for what stands where. Terrain types, authored scenery objects, saved garden
// objects and frontier block columns all resolve their occupancy through this table, so server
// movement, pathfinding, placement validation and the renderer cannot drift apart.
//
// The table is a *declaration*, not an implementation: `sceneryClass` names how a type treats a
// tile, and `src/voxel-world.js` draws each class exactly as declared.
//
//   mass  — occupies its tile at resident height. Not walkable, paths route around it, placement
//           refuses it on an occupied tile, and the renderer draws it as a tile-sized mass.
//   flat  — ground detail at or below knee height, inside its own tile. Walkable: a resident
//           stands among it, never inside it.
//   frame — an open navigation marker: geometry sits in the tile-edge bands and any cross member
//           is above the resident's head, so a resident walks through it.
//
// No dependency on the world catalogue, the database or the DOM, so the browser and the server
// both import this module directly.

/** Standing resident the renderer draws: 0.75 wide at the outstretched arms, 1.52 tall. */
export const RESIDENT_CLEARANCE = 0.38;
export const RESIDENT_HEIGHT = 1.52;
/** Geometry at or below this height is a floor decal, never an obstacle. */
export const GROUND_DETAIL = 0.1;
/** Highest point a `flat` ground detail may reach: a resident steps among it. */
export const KNEE_HEIGHT = 0.5;

/** Terrain types a resident may never stand on. `path`, `bridge`, `plaza`, `garden`, `floor` and
 *  `rug` are walkable; `rug` and `garden` are interior surfaces, not obstacles. */
export const TERRAIN_BLOCKING = Object.freeze(['water', 'tree', 'building', 'fountain', 'wall']);
const terrainBlocking = new Set(TERRAIN_BLOCKING);

/**
 * Scenery type → class. Every type used by the authored world definitions, the sealed garden and
 * cottage palettes, and the runtime build vocabulary appears here; a test asserts that.
 */
export const SCENERY_CLASSES = Object.freeze({
  // Solid masses: a roof, trunk, wall, seat or basin that a resident walks around.
  cottage: 'mass', 'civic-building': 'mass', tree: 'mass', fruit: 'mass', palm: 'mass', cactus: 'mass', mountain: 'mass',
  pond: 'mass', fountain: 'mass', bench: 'mass', table: 'mass', workbench: 'mass', bookshelf: 'mass', bed: 'mass',
  boat: 'mass', telescope: 'mass', display: 'mass', sculpture: 'mass', kitchen: 'mass', lamp: 'mass', lantern: 'mass', trellis: 'mass',
  // Ground detail: low planting, crop beds, cushions and thin floor paths. A resident stands among
  // them, so they stay walkable and are never drawn at body height.
  flowers: 'flat', farm: 'flat', cushion: 'flat', path: 'flat',
  // Open navigation markers. A gateway object is drawn by the portal or gate frame that shares its
  // tile; the shelter is an open pavilion with corner posts and a roof above the head.
  gateway: 'frame', shelter: 'frame', portal: 'frame', gate: 'frame',
});

/** An unrecognised type is treated as a solid mass: closed by default, and drawn as one. */
export const DEFAULT_SCENERY_CLASS = 'mass';

/** Frontier block columns: every sealed block type is a solid full layer except the thin `path`. */
export const THIN_BLOCK_TYPES = Object.freeze(['path']);
const thinBlocks = new Set(THIN_BLOCK_TYPES);

export const sceneryClass = (type) => typeof type === 'string' && Object.hasOwn(SCENERY_CLASSES, type) ? SCENERY_CLASSES[type] : DEFAULT_SCENERY_CLASS;
/** True when the type occupies its tile: not walkable, routed around, refused as a placement on an occupied tile. */
export const sceneryBlocks = (type) => sceneryClass(type) === 'mass';
export const terrainBlocks = (type) => typeof type === 'string' && terrainBlocking.has(type);
/** A block column is solid unless it is a sealed thin surface. */
export const blockOccupiesTile = (type) => !thinBlocks.has(type);

/** Every scenery type that occupies its tile, in declaration order. */
export const BLOCKING_SCENERY = Object.freeze(Object.keys(SCENERY_CLASSES).filter(sceneryBlocks));
/** Every scenery type that stays walkable, in declaration order. */
export const DECORATIVE_SCENERY = Object.freeze(Object.keys(SCENERY_CLASSES).filter((type) => !sceneryBlocks(type)));

const tileKey = (x, y) => `${x},${y}`;
// The occupancy index of an objects array is derived once and cached on that array, so the
// collision hot path (canStep, the frontier escape search) stays O(1) per tile.
const indexes = new WeakMap();
const EMPTY = new Set();

/** Solid scenery tiles of an object list, as a Set of `x,y` keys. Accepts authored or saved objects. */
export function solidTileKeys(objects) {
  if (!Array.isArray(objects) || !objects.length) return EMPTY;
  let index = indexes.get(objects);
  if (!index) {
    index = new Set();
    for (const object of objects) {
      if (!object || !Number.isInteger(object.x) || !Number.isInteger(object.y)) continue;
      if (sceneryBlocks(object.type ?? object.kind)) index.add(tileKey(object.x, object.y));
    }
    indexes.set(objects, index);
  }
  return index;
}

/** True when solid scenery stands on the tile. */
export function solidSceneryAt(position, objects) {
  if (!Number.isInteger(position?.x) || !Number.isInteger(position?.y)) return false;
  return solidTileKeys(objects).has(tileKey(position.x, position.y));
}

/**
 * A standable tile: inside the retained terrain, not a blocking terrain type, and free of solid
 * scenery. This is the tile rule `world.js` publishes as walkable().
 */
export function standableTile(position, terrain, objects) {
  const type = Number.isInteger(position?.y) && Number.isInteger(position?.x) ? terrain?.[position.y]?.[position.x] : undefined;
  if (typeof type !== 'string' || terrainBlocking.has(type)) return false;
  return !solidSceneryAt(position, objects);
}

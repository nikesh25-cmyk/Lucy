// Ground cover and understory.
//
// The occupancy rule this module obeys is the one in src/footprints.js, read directly:
//   * on a *walkable* tile (no blocking terrain, no solid scenery) the cover is a floor decal at or
//     below GROUND_DETAIL — the height the table calls "never an obstacle";
//   * on a tile the server already refuses, the cover may rise, but it stays inside its own tile,
//     so it can never reach into a neighbouring resident's standing column.
// Nothing drawn here carries a pick: the ground surface keeps its own terrain pick, so clicking a
// tile still resolves the tile, and no decoration can be mistaken for a clickable object.
import { GROUND_DETAIL, TERRAIN_BLOCKING, solidTileKeys } from '../footprints.js';
import { hash, shade } from './batch.js';

/** The cover tones, all derived from the family's own leaf, meadow and earth tokens. */
export const COVER_TINTS = Object.freeze({
  meadow: shade('#79a86d', 0.9), garden: shade('#79a86d', 1.08), leaf: '#468969',
  litter: shade('#927052', 0.86), undergrowth: shade('#468969', 1.14),
});
/** Terrain a walkable decal may sit on: an open surface that is not pavement or interior floor. */
const OPEN_TERRAIN = new Set(['meadow', 'garden']);
/** Cells whose tile already holds a plant: the understory belongs around them, at their own edges. */
const SHRUBS = new Set(['tree', 'fruit', 'palm', 'cactus', 'mountain']);
/** The floor-decal height the walkable-tile rule uses; exported so a test can assert it. */
export const COVER_HEIGHT_LIMIT = GROUND_DETAIL;
const inside = (offset) => Math.max(-.38, Math.min(.38, offset));
const tileKey = (item) => `${item.x},${item.y}`;

/**
 * Draws the ground cover for one window. `plan` is the resolved voxel plan, so the pass sees exactly
 * the tiles and objects the server resolves for this viewport.
 */
export function groundCoverPass({ batch, plan, layers }) {
  const solids = solidTileKeys(plan.objects), occupied = new Set(), planted = new Set();
  for (const item of plan.objects) { occupied.add(tileKey(item)); if (SHRUBS.has(item.type || item.kind)) planted.add(tileKey(item)); }
  for (const cell of plan.cells) if (SHRUBS.has(cell.type)) planted.add(tileKey(cell));

  let cover = 0, understory = 0;
  for (const cell of plan.cells) {
    const { x, y, type } = cell, key = tileKey(cell);
    if (type === 'water' || type === 'bridge') continue;
    if (!TERRAIN_BLOCKING.includes(type) && !solids.has(key)) {
      // A walkable tile: mottling and a seedling, at or below the floor-decal height.
      if (!OPEN_TERRAIN.has(type) || occupied.has(key)) continue;
      const n = hash(`${x},${y},cover`);
      if (n % 3 === 0) { batch.add(x + .5, .028, y + .5, .74, .056, .74, n % 2 ? COVER_TINTS.meadow : COVER_TINTS.garden, null, 'detail'); cover++; }
      if (n % 7 === 3) { batch.add(x + .5 + (n % 5) * .06 - .12, .04, y + .5 + (n % 3) * .07 - .07, .05, .08, .05, COVER_TINTS.leaf, null, 'detail'); cover++; }
      continue;
    }
    // A tile the server already refuses: an understory at its edges, inside its own boundary.
    if (!planted.has(key)) continue;
    const n = hash(`${x},${y},understory`);
    batch.add(x + .5 + inside((n % 9) * .1 - .4), .02, y + .5 + inside(((n >> 3) % 9) * .1 - .4), .6, .04, .6, COVER_TINTS.litter, null, 'detail');
    for (let index = 0; index < 3; index++) {
      const side = (n >> (index * 2)) % 4, along = ((n >> (index * 3)) % 7) / 7 - .5;
      const dx = side === 0 ? .36 : side === 1 ? -.36 : along * .5, dy = side === 2 ? .36 : side === 3 ? -.36 : along * .5;
      batch.add(x + .5 + inside(dx), .14 + (index % 2) * .06, y + .5 + inside(dy), .07, .28 + (index % 2) * .12, .07,
        COVER_TINTS.undergrowth, null, 'detail');
    }
    understory += 4;
  }
  if (layers) { layers.cover = (layers.cover || 0) + cover; layers.understory = (layers.understory || 0) + understory; }
  return { cover, understory };
}

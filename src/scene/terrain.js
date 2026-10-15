// The ground diorama: one window of terrain, its navigation frames and its landmark pennants.
//
// Every cell is drawn from the resolved `voxelPlan`, so the drawn world and the server's movement
// rules see the same tiles. The three terrain types that own a standing column — `tree`, `building`,
// `wall` — are drawn as the blocking mass `TERRAIN_BLOCKING` declares them to be, and `water` goes to
// src/scene/water.js. The `tree` and `fountain` terrain types reuse the sealed scenery builders from
// src/voxel-world.js, passed in as `builders`, so a terrain tree and an authored tree look the same.
import { cellOccludedBelow, cellTypeAt, inDetail, inVoxelWindow } from '../voxel-geometry.js';
import { accountLayer, variant } from './batch.js';
import { interiorContext, interiorFloor, interiorWall, isInterior, openSides } from './interiors.js';
import { shoreSides, waterDepth, waterTile } from './water.js';
import { buildingTile, wallTile } from './buildings.js';

/** Bracket a pass and add exactly the cubes it drew to its layer tally. */
export const layer = (batch, layers, name, run) => { const before = batch.size; const value = run(); accountLayer(layers, name, batch.size - before); return value; };

/** The tree-like terrain types whose tile is already occupied by a plant. */
const TREES = new Set(['tree', 'fruit', 'palm', 'cactus', 'mountain']);

/** The ground: a base cube (culled whole when enclosed), a surface slab, and each type's own detail. */
export function groundPass({ batch, definition, snapshot, plan, cullHidden, scenery, colors, builders, layers, style = null }) {
  // The tile type a neighbour has, resolved exactly as the plan resolved this cell: an observed tile
  // wins over the retained map, so the water depth and the shoreline are read from what is drawn.
  const typeAt = (x, y) => cellTypeAt(definition, snapshot, x, y);
  // A room is drawn with its own wall, floor and window grammar (src/scene/interiors.js); every other
  // world keeps the boundary wall and the flat slab it always had.
  const room = isInterior(definition) ? interiorContext(definition) : null;
  for (const item of plan.cells) {
    const { x, y, type } = item, pick = { x, y, z: 0, type: 'terrain', terrain: type, ...(item.parcel ? { parcel: item.parcel } : {}) };
    // The detail tier decides only how the ground *reads*: the slab, the base cube and every type's
    // own detail — its obstacle, its pickable garden flowers — are drawn at both tiers, so a coarse
    // tile is still exactly what the server says it is. Only the water reads below its surface follow
    // the tier, and those carry no pick. See `LOD_LIMITS` in src/voxel-geometry.js.
    const detail = inDetail(x, y, plan.anchor, plan.detailRadius);
    const base = room && type === 'rug' ? room.style.rug : ['water', 'bridge'].includes(type) ? colors.dirt
      : type === 'building' || type === 'tree' || type === 'fountain' ? definition.groundColor || colors.grass
        : colors[type] || definition.groundColor || colors.grass;
    const before = batch.size;
    if (type === 'water') {
      waterTile(batch, { x, y, pick, dirt: colors.dirt, depth: waterDepth(typeAt, x, y), sides: shoreSides(typeAt, x, y), detail });
    } else {
      // An interior base cube has no exposed face, so it is skipped; the slab below always stays.
      if (!cullHidden || !cellOccludedBelow(definition, snapshot, plan, x, y)) batch.add(x + .5, -.5, y + .5, 1, 1, 1, variant(colors.dirt, x, y), pick);
      batch.add(x + .5, -.04, y + .5, 1, .08, 1, variant(base, x, y), pick);
      if (type === 'bridge') for (let index = 0; index < 4; index++) batch.add(x + .5, .03, y + .125 + index * .25, 1, .13, .22, colors.wood, pick);
      if (type === 'wall' && room) interiorWall(batch, { x, y, pick, style: room.style, sides: openSides(typeAt, x, y, room.columns, room.rows),
        glass: colors.glass, stars: definition.id === 'observatory' });
      else if (type === 'wall') wallTile(batch, { x, y, pick });
      if (room && detail && type !== 'wall') interiorFloor(batch, { x, y, type, base: variant(base, x, y), style: room.style, context: room, typeAt });
      if (type === 'building' && room) builders.furniture(batch, { x, y, type: 'bookshelf' });
      else if (type === 'building') buildingTile(batch, { x, y, pick, openFront: definition.terrain?.[y + 1]?.[x] !== 'building',
        colors: { ...colors, body: '#d3c4a6' }, style });
      if (type === 'tree' && !TREES.has(scenery.get(`${x},${y}`))) builders.tree(batch, x, y, 'tree', pick);
      if (type === 'fountain') builders.furniture(batch, { x, y, type: 'fountain' });
      if (type === 'garden' && (x + y) % 2 === 0) builders.furniture(batch, { x, y, type: 'flowers' });
    }
    accountLayer(layers, type === 'water' ? 'water' : type === 'wall' || type === 'building' ? 'buildings' : 'terrain', batch.size - before);
  }
}

/** A portal is a walk-through frame: posts in the tile-edge bands, its beam above the drawn head. */
export function portalFrames({ batch, plan, colors, layers }) {
  layer(batch, layers, 'navigation', () => {
    for (const item of plan.portals) {
      const pick = { x: item.x, y: item.y, z: 0, type: 'portal', portal: item };
      for (const dx of [-.5, .5]) {
        batch.add(item.x + .5 + dx, 1.1, item.y + .5, .2, 2.2, .2, '#78998b', pick);
        batch.add(item.x + .5 + dx, 2.26, item.y + .5, .24, .14, .24, '#5d7e70', pick);
        batch.add(item.x + .5 + dx, 2.4, item.y + .5, .16, .16, .16, colors.gold, pick, 'glow');
      }
      batch.add(item.x + .5, 2.17, item.y + .5, 1.3, .22, .22, colors.gold, pick, 'glow');
      batch.add(item.x + .5, 2.36, item.y + .5, .4, .2, .24, colors.gold, pick, 'glow');
      batch.add(item.x + .5, 2.52, item.y + .5, .2, .16, .2, '#c8f0dc', pick, 'glow');
      batch.add(item.x + .5, .04, item.y + .5, 1.28, .07, .8, '#9dccb6', pick, 'glow');
    }
  });
}

/** A closed frontier gate keeps the same open frame and adds a floor decal. Selecting it expands. */
export function gateFrames({ batch, plan, colors, layers }) {
  layer(batch, layers, 'navigation', () => {
    for (const item of plan.gates) {
      const pick = { x: item.x, y: item.y, z: 0, type: 'gate', neighbor: item };
      for (const dx of [-.5, .5]) {
        batch.add(item.x + .5 + dx, 1, item.y + .5, .22, 2, .22, colors.trunk, pick);
        batch.add(item.x + .5 + dx, 2.16, item.y + .5, .26, .12, .26, colors.dark, pick);
        batch.add(item.x + .5 + dx, 2.3, item.y + .5, .18, .18, .18, colors.gold, pick, 'glow');
      }
      batch.add(item.x + .5, 2.04, item.y + .5, 1.42, .23, .23, colors.gold, pick, 'glow');
      batch.add(item.x + .5, 1.72, item.y + .5, 1.24, .1, .12, '#98ac96', pick);
      batch.add(item.x + .5, 1.68, item.y + .5, .2, .2, .2, colors.gold, pick, 'glow');
      batch.add(item.x + .5, .05, item.y + .5, 1.24, .08, .12, '#98ac96', pick);
    }
  });
}

/** Landmark pennants are navigation markers at the tile edge; they never imply a live participant. */
export function landmarkPennants({ batch, definition, plan, colors, layers, validColor }) {
  layer(batch, layers, 'navigation', () => {
    for (const item of (definition.landmarks || []).filter((place) => inVoxelWindow(place, plan.window)).slice(0, 40)) {
      batch.add(item.x + .92, 1.2, item.y + .08, .045, 2.4, .045, colors.dark);
      batch.add(item.x + 1.2, 2.17, item.y + .08, .55, .38, .04, validColor(item.color) || colors.gold);
    }
  });
}

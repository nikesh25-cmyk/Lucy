// The two building *tiles* of the authored terrain: a boundary wall and a world building cell.
//
// Both are blocking terrain types (`wall`, `building` are in TERRAIN_BLOCKING), so a short cap or an
// eave may overhang — the standing column that must stay clear belongs to the neighbouring walkable
// tiles. Every overhang here stays within 1.08 m of the tile, which is inside the 1.24 m the shared
// footprint test allows, and the mass of each tile fills its own standing column from the ground up.
// The hand-built cottage, civic building and shelter are their own sealed builders in
// src/voxel-world.js and are not drawn here.
import { shade } from './batch.js';

/** Building stone, mortar and timber, derived from the family's existing structure tokens. */
export const BUILDING_TINTS = Object.freeze({
  base: shade('#a4b1b0', 0.94), band: shade('#a4b1b0', 1.06), cap: shade('#a4b1b0', 0.88),
  // The wall token the asset family records for an enclosure tile. It has no sealed block definition,
  // so it is a renderer-only tint like the rest of this module's palette.
  wall: '#839489',
});

/**
 * A boundary or enclosure wall: a footed plinth, two courses and a capstone that reads as a wall on
 * its own from any orbit angle.
 */
export function wallTile(batch, { x, y, pick }) {
  batch.add(x + .5, .14, y + .5, 1.06, .28, 1.06, BUILDING_TINTS.base, pick);
  batch.add(x + .5, .49, y + .5, .98, .42, .98, BUILDING_TINTS.wall, pick);
  batch.add(x + .5, .93, y + .5, .98, .46, .98, shade(BUILDING_TINTS.wall, 0.94), pick);
  batch.add(x + .5, 1.2, y + .5, .92, .12, .92, BUILDING_TINTS.band, pick);
  batch.add(x + .5, 1.4, y + .5, .86, .28, .86, BUILDING_TINTS.wall, pick);
  batch.add(x + .5, 1.6, y + .5, 1.08, .12, 1.08, BUILDING_TINTS.cap, pick);
}

/**
 * An authored world building cell: a stone base, a wall body, a stepped roof and a lit window on the
 * +y face when the tile in front of it is open. An interior cell is a room, so its furniture (a
 * bookshelf) is drawn instead and the tile keeps its floor.
 */
export function buildingTile(batch, { x, y, colors, pick, interior = false, openFront = true }) {
  if (interior) return false;
  batch.add(x + .5, .16, y + .5, 1.06, .32, 1.06, BUILDING_TINTS.base, pick);
  batch.add(x + .5, .78, y + .5, .99, 1.18, .99, colors.body, pick);
  // A stepped roof that stays inside the entry's recorded height for this tile (1.67 m).
  batch.add(x + .5, 1.4, y + .5, 1.08, .12, 1.08, colors.roof, pick);
  batch.add(x + .5, 1.52, y + .5, .96, .12, .96, shade(colors.roof, 0.93), pick);
  batch.add(x + .5, 1.625, y + .5, .58, .09, .58, colors.roof, pick);
  batch.add(x + .5, .3, y + .5 + .505, .34, .44, .06, colors.dark, pick);
  if (openFront) batch.add(x + .5, .74, y + 1.005, .32, .43, .04, colors.glass, pick, 'glow');
  return true;
}

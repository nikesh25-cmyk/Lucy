// The two building *tiles* of the authored terrain: a boundary wall and a world building cell.
//
// Both are blocking terrain types (`wall`, `building` are in TERRAIN_BLOCKING), so a short cap or an
// eave may overhang — the standing column that must stay clear belongs to the neighbouring walkable
// tiles. Every overhang here stays within 1.08 m of the tile, which is inside the 1.24 m the shared
// footprint test allows, and the mass of each tile fills its own standing column from the ground up.
// The hand-built cottage, civic building and shelter are their own sealed builders in
// src/voxel-world.js and are not drawn here.
import { hash, shade } from './batch.js';

/** The wall tones a building takes when its world has no district style of its own. */
export const BUILDING_BODIES = Object.freeze(['#d3c4a6', '#c9b79a', '#dccfb2']);

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
export function buildingTile(batch, { x, y, colors, pick, interior = false, openFront = true, style = null }) {
  if (interior) return false;
  // The tile's own hash and its district's style choose the look, so a street of building tiles is not one
  // building repeated. Everything stays in the tile: 1.67 m tall, nothing wider than 1.08 m, and the front
  // details reach no more than 0.10 m past the wall, short of a neighbour's standing column.
  const n = hash(`${x},${y},building`), pickOf = (list, shift) => list[((n >>> shift) >>> 0) % list.length];
  const body = style?.wall ? pickOf(style.wall, 2) : pickOf(BUILDING_BODIES, 2), roof = style?.roof ? pickOf(style.roof, 5) : colors.roof;
  const trim = style?.trim || '#f1e9cb', profile = (n >>> 8) % 4, openings = (n >>> 11) % 3, door = pickOf(style?.door || [colors.dark], 14);
  batch.add(x + .5, .16, y + .5, 1.06, .32, 1.06, BUILDING_TINTS.base, pick);
  batch.add(x + .5, .78, y + .5, .99, 1.18, .99, body, pick);
  batch.add(x + .5, 1.2, y + .5, 1.03, .06, 1.03, trim, pick);
  if (profile === 0) {
    // stepped roof
    batch.add(x + .5, 1.4, y + .5, 1.08, .12, 1.08, roof, pick);
    batch.add(x + .5, 1.52, y + .5, .96, .12, .96, shade(roof, 0.93), pick);
    batch.add(x + .5, 1.625, y + .5, .58, .09, .58, roof, pick);
  } else if (profile === 1) {
    // gabled: slabs long in x, narrowing toward a ridge, with the gable ends picked out in trim
    batch.add(x + .5, 1.4, y + .5, 1.08, .12, 1.0, roof, pick);
    batch.add(x + .5, 1.52, y + .5, 1.08, .12, .66, shade(roof, 0.93), pick);
    batch.add(x + .5, 1.625, y + .5, 1.08, .09, .3, roof, pick);
    for (const side of [-1, 1]) batch.add(x + .5 + side * .53, 1.5, y + .5, .04, .26, .8, trim, pick);
  } else if (profile === 2) {
    // flat roof with a parapet and a hatch
    batch.add(x + .5, 1.34, y + .5, 1.06, .1, 1.06, shade(roof, 0.93), pick);
    for (const [dx, dz, w, l] of [[0, .5, 1.08, .08], [0, -.5, 1.08, .08], [.5, 0, .08, .94], [-.5, 0, .08, .94]]) batch.add(x + .5 + dx, 1.5, y + .5 + dz, w, .22, l, roof, pick);
    batch.add(x + .5 - .22, 1.5, y + .5 + .18, .26, .22, .26, shade(roof, 0.93), pick);
  } else {
    // a hip with a lit finial
    for (let i = 0; i < 3; i++) batch.add(x + .5, 1.4 + i * .1, y + .5, 1.08 - i * .3, .12, 1.08 - i * .3, i % 2 ? shade(roof, 0.93) : roof, pick);
    batch.add(x + .5, 1.64, y + .5, .08, .06, .08, colors.gold, pick, 'glow');
  }
  batch.add(x + .5, .3, y + .5 + .505, .34, .44, .06, door, pick);
  batch.add(x + .5, .56, y + .5 + .515, .42, .06, .06, trim, pick);
  if (openFront) {
    if (openings === 0) batch.add(x + .5, .86, y + 1.005, .5, .34, .04, colors.glass, pick, 'glow');
    else {
      for (const side of [-1, 1]) batch.add(x + .5 + side * .3, .8, y + 1.005, .24, .36, .04, colors.glass, pick, 'glow');
      if (openings === 2) { batch.add(x + .5, .76, y + .5 + .53, 1.0, .06, .12, roof, pick); batch.add(x + .5, .82, y + .5 + .59, 1.0, .06, .05, shade(roof, 0.93), pick); }
    }
  }
  // The side wall's window, so the building reads from any orbit angle.
  batch.add(x + 1.005, .8, y + .5, .04, .34, .3, colors.glass, pick, 'glow');
  return true;
}

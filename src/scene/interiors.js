// Interiors: the walls, windows, floor patterns and brackets of a room drawn in the 3D voxel renderer.
//
// Until now an interior world (`kind: 'interior'`) drew the same wall tile as a garden boundary and a
// bare coloured slab for a floor, with the daylight sky behind it, so the library, the workshop, the
// observatory, the halls and every cottage looked like one empty box. This module gives a room its own
// grammar, in the same one-box-at-a-time vocabulary the rest of src/scene/ uses:
//
//   walls     a plinth, a wainscot, a rail, plaster and a crown, in the room's own palette;
//             a lit window on every fifth wall tile and a framed picture on some of the rest; the
//             observatory's walls carry stars instead
//   floors    seams that alternate direction tile to tile (parquet), a shaded strip where floor meets
//             wall, a bordered and inset rug, and rings on a plaza
//   brackets  a short beam stub over each window, above the head of every resident
//
// Occupancy is not touched. Every box here follows the rules src/footprints.js states and
// tests/render-obstacles.test.js measures:
//   - a wall tile is a blocking mass, so it may fill its own tile and stand 2.12 m tall; its details
//     protrude at most 0.10 m into the open tile beside it, which never reaches the 0.12 m where a
//     standing resident's column begins, and every wall box carries the wall's own pick;
//   - a floor decal is at most 0.03 m thick and sits on the slab, below the 0.10 m decal limit, and has
//     no pick, so it is exactly the "unpicked decoration" the level-of-detail rule may drop;
//   - a bracket carries the wall's pick and its lowest face is 1.92 m, above the 1.52 m resident.
// Colours are renderer-only tints, like the rest of the building palette: no sealed definition owns
// them. The glass is the sealed `glass` block colour and is passed in by the caller.
import { hash, shade } from './batch.js';

/**
 * Whether a world is a room. The authored interiors say `kind: 'interior'`, but a cottage reaches the
 * browser as the server's own world record, whose kind is `house`, merged over the authored definition
 * (`getWorldDefinition` with a descriptor). Reading the kind alone therefore drew every authored room
 * as a room and every cottage as an open garden under a daylight sky; the id is the other half of the
 * test, and the same pair world.js already uses for the 2D renderer.
 */
export const isInterior = (definition) => definition?.kind === 'interior' || String(definition?.id || '').startsWith('house:');

/** One palette per room kind; a house and any room without an entry take the default. */
export const INTERIOR_STYLES = Object.freeze({
  default: Object.freeze({ rug: '#7d8fa4', plaster: '#e2d4b4', wainscot: '#a98462', trim: '#f1e9cb', plinth: '#6e5340', rug_border: '#d6b873', rug_inset: 1.14, ring_a: '#aeb8d0', ring_b: '#dfe1ea', art: ['#c38d6d', '#72908a', '#cab573'] }),
  library: Object.freeze({ rug: '#7a4f47', plaster: '#c9b88f', wainscot: '#7a5a3f', trim: '#e6d9b0', plinth: '#4f3a29', rug_border: '#c9a45a', rug_inset: 1.14, ring_a: '#aeb8d0', ring_b: '#dfe1ea', art: ['#8e5b4a', '#5f7f78', '#b99c55'] }),
  workshop: Object.freeze({ rug: '#6f8c78', plaster: '#d8a785', wainscot: '#8c6a4c', trim: '#f0dfbd', plinth: '#5b4331', rug_border: '#e0b872', rug_inset: 1.14, ring_a: '#aeb8d0', ring_b: '#dfe1ea', art: ['#6f9a86', '#c38d6d', '#d9c486'] }),
  observatory: Object.freeze({ rug: '#46528a', plaster: '#55618e', wainscot: '#3d4668', trim: '#c9cfe8', plinth: '#2c3350', rug_border: '#b9c2e6', rug_inset: 1.3, ring_a: '#6c78a8', ring_b: '#c7cde6', art: ['#cfd6f0', '#8f9bd0', '#e7dca0'] }),
  meditation: Object.freeze({ rug: '#8fae8f', plaster: '#ced8c1', wainscot: '#8da58b', trim: '#eef0d8', plinth: '#5f745e', rug_border: '#b7cfa4', rug_inset: 1.14, ring_a: '#aeb8d0', ring_b: '#dfe1ea', art: ['#a7bba5', '#d6c9a4', '#9db09d'] }),
  house: Object.freeze({ rug: '#a8625a', plaster: '#eadbbf', wainscot: '#b68e6c', trim: '#fff3d4', plinth: '#7a5b44', rug_border: '#d9a97a', rug_inset: 1.14, ring_a: '#aeb8d0', ring_b: '#dfe1ea', art: ['#d28b6f', '#7fa89c', '#dcc27f'] }),
});

/** The palette for one world definition. */
export function interiorStyle(definition) {
  const id = String(definition?.id || '');
  if (id.startsWith('house:')) return INTERIOR_STYLES.house;
  return INTERIOR_STYLES[id] || INTERIOR_STYLES.default;
}

/** Wall height: above a 1.52 m resident, below what hides an orbiting camera's view of the room. */
export const WALL_HEIGHT = 2.12;
/** The most a wall detail may protrude into the open tile beside it. */
export const WALL_PROTRUSION = .1;
/** Every n-th tile of a wall carries a window. */
export const WINDOW_EVERY = 5;
/** A bracket over a window reaches this far into the room, and its lowest face is this high. */
export const BRACKET_REACH = .8;
export const BRACKET_BOTTOM = 1.92;

const SIDES = Object.freeze({ n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] });
const ORDER = Object.freeze(['s', 'n', 'e', 'w']);

/**
 * What a room needs to know about itself once: its palette, the box around its plaza (for the rings),
 * and the rug tiles (for the border). Reading the terrain once keeps the per-tile calls O(1).
 */
export function interiorContext(definition) {
  const style = interiorStyle(definition), rows = definition.terrain || [];
  let plaza = null;
  rows.forEach((line, y) => line.forEach((type, x) => {
    if (type !== 'plaza') return;
    plaza = plaza ? { x0: Math.min(plaza.x0, x), x1: Math.max(plaza.x1, x), y0: Math.min(plaza.y0, y), y1: Math.max(plaza.y1, y) } : { x0: x, x1: x, y0: y, y1: y };
  }));
  return { style, plaza, columns: definition.columns, rows: definition.rows };
}

/** The sides of a wall tile that face an open (non-wall, in-bounds) tile, drawn side first. */
export function openSides(typeAt, x, y, columns, rows) {
  return ORDER.filter((side) => {
    const [dx, dy] = SIDES[side], nx = x + dx, ny = y + dy;
    return nx >= 0 && ny >= 0 && nx < columns && ny < rows && typeAt(nx, ny) !== 'wall';
  });
}

/**
 * A box on one face of a wall tile. `out` is how far the box reaches past the wall face into the open
 * tile and is clamped to `WALL_PROTRUSION`; the box is sunk 0.01 m into the wall so it never floats.
 */
function onFace(batch, { x, y, pick }, side, { along = 0, h, width, height, out, color, style = 'solid' }) {
  const reach = Math.min(out, WALL_PROTRUSION), thick = reach + .01, [dx, dy] = SIDES[side];
  const faceX = x + .5 + dx * .495, faceZ = y + .5 + dy * .495, shift = (reach - .01) / 2;
  if (dx === 0) batch.add(x + .5 + along, h, faceZ + dy * shift, width, height, thick, color, pick, style);
  else batch.add(faceX + dx * shift, h, y + .5 + along, thick, height, width, color, pick, style);
}

/**
 * One wall tile of a room. `sides` are its open faces (`openSides`); `glass` is the sealed glass colour.
 * The tile keeps its own pick, so selecting a wall selects the wall.
 */
export function interiorWall(batch, { x, y, pick, style, sides, glass, art = true, stars = false }) {
  const t = { x, y, pick };
  batch.add(x + .5, .14, y + .5, 1.03, .28, 1.03, style.plinth, pick);
  batch.add(x + .5, .64, y + .5, .99, .72, .99, style.wainscot, pick);
  batch.add(x + .5, 1.04, y + .5, 1.03, .09, 1.03, style.trim, pick);
  batch.add(x + .5, 1.58, y + .5, .99, .99, .99, style.plaster, pick);
  batch.add(x + .5, 2.06, y + .5, 1.05, .12, 1.05, style.trim, pick);
  const side = sides[0];
  if (!side) return;
  // A corner has no open face and a pier between two rooms has several; only a tile with exactly one open
  // face carries a window or a picture, so none ever looks into another wall.
  const [, dy] = SIDES[side], run = hash(`wall:${x},${y}`);
  const windowed = ((dy === 0 ? y : x) % WINDOW_EVERY) === 2 && sides.length === 1;
  if (windowed) {
    onFace(batch, t, side, { h: 1.42, width: .62, height: .66, out: .02, color: glass, style: 'glow' });
    onFace(batch, t, side, { h: 1.42, width: .04, height: .66, out: .05, color: style.trim });
    onFace(batch, t, side, { h: 1.42, width: .62, height: .04, out: .05, color: style.trim });
    for (const [alongOffset, height, width, h] of [[-.33, .72, .06, 1.42], [.33, .72, .06, 1.42]]) onFace(batch, t, side, { along: alongOffset, h, width, height, out: .05, color: style.trim });
    for (const h of [1.09, 1.77]) onFace(batch, t, side, { h, width: .74, height: .06, out: .05, color: style.trim });
    onFace(batch, t, side, { h: 1.08, width: .8, height: .05, out: .1, color: style.wainscot });
    // The bracket: a beam stub above the window, over the head of anyone standing in the room.
    const [bx, by] = SIDES[side];
    if (bx === 0) batch.add(x + .5, BRACKET_BOTTOM + .1, y + .5 + by * (.5 + BRACKET_REACH / 2 - .01), .16, .2, BRACKET_REACH + .02, style.plinth, pick);
    else batch.add(x + .5 + bx * (.5 + BRACKET_REACH / 2 - .01), BRACKET_BOTTOM + .1, y + .5, BRACKET_REACH + .02, .2, .16, style.plinth, pick);
  } else if (stars) {
    // A small constellation on the upper wall: lit specks of different sizes, deterministic per tile.
    for (let index = 0; index < 3; index++) {
      const n = hash(`star:${x},${y},${index}`), size = .05 + (n % 3) * .02;
      onFace(batch, t, side, { along: ((n >>> 4) % 7 - 3) * .12, h: 1.3 + ((n >>> 8) % 5) * .15, width: size, height: size, out: .03, color: style.art[(n >>> 12) % style.art.length], style: 'glow' });
    }
  } else if (art && run % 4 === 0 && sides.length === 1) {
    // A framed picture: trim frame, a coloured canvas, and a lit brass plate beneath.
    const canvas = style.art[run % style.art.length];
    onFace(batch, t, side, { h: 1.5, width: .5, height: .4, out: .04, color: style.trim });
    onFace(batch, t, side, { h: 1.5, width: .4, height: .3, out: .06, color: canvas });
    onFace(batch, t, side, { h: 1.27, width: .16, height: .04, out: .05, color: style.rug_border });
  }
}

/** The shaded strip where the floor meets a wall, and nothing else, on a tile next to one. */
function wallShade(batch, { x, y, color, typeAt, columns, rows }) {
  for (const side of ORDER) {
    const [dx, dy] = SIDES[side], nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= columns || ny >= rows || typeAt(nx, ny) !== 'wall') continue;
    if (dx === 0) batch.add(x + .5, .012, y + .5 + dy * .43, 1, .024, .14, color, null, 'detail');
    else batch.add(x + .5 + dx * .43, .012, y + .5, .14, .024, 1, color, null, 'detail');
  }
}

/**
 * The decals on one floor tile: nothing structural, only how the floor reads. `base` is the colour the
 * tile's slab already carries. Skipped by the caller on a coarse tile.
 */
export function interiorFloor(batch, { x, y, type, base, style, context, typeAt }) {
  const { columns, rows } = context, n = hash(`floor:${x},${y}`);
  if (type === 'floor') {
    // Parquet: a seam along one axis, flipping every tile, so the boards change direction like a pattern.
    if ((x + y) % 2) batch.add(x + .5, .012, y + .5, .03, .024, 1, shade(base, .8), null, 'detail');
    else batch.add(x + .5, .012, y + .5, 1, .024, .03, shade(base, .8), null, 'detail');
    if (n % 5 === 0) batch.add(x + .5 + ((n >>> 3) % 5 - 2) * .1, .012, y + .5 + ((n >>> 6) % 5 - 2) * .1, .12, .024, .12, shade(base, .9), null, 'detail');
  } else if (type === 'rug') {
    // A border where the rug ends, an inset square on alternate tiles inside it.
    for (const side of ORDER) {
      const [dx, dy] = SIDES[side];
      if (typeAt(x + dx, y + dy) === 'rug') continue;
      if (dx === 0) batch.add(x + .5, .014, y + .5 + dy * .44, 1, .028, .09, style.rug_border, null, 'detail');
      else batch.add(x + .5 + dx * .44, .014, y + .5, .09, .028, 1, style.rug_border, null, 'detail');
    }
    if ((x + y) % 2 === 0) batch.add(x + .5, .014, y + .5, .5, .028, .5, shade(base, style.rug_inset), null, 'detail');
  } else if (type === 'plaza' && context.plaza) {
    // Concentric rings out from the plaza's middle: the observatory's inlaid floor.
    const { x0, x1, y0, y1 } = context.plaza, ring = Math.min(x - x0, x1 - x, y - y0, y1 - y);
    batch.add(x + .5, .014, y + .5, .96, .028, .96, ring % 2 ? style.ring_a : style.ring_b, null, 'detail');
  }
  if (type === 'floor' || type === 'rug') wallShade(batch, { x, y, color: shade(base, .72), typeAt, columns, rows });
}

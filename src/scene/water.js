// Water, drawn as water.
//
// A water tile is never walkable (`water` is a blocking terrain type in src/footprints.js), so this
// module is free to raise reads and reeds above the floor-decal height — the standing column it
// must never fill belongs to the *neighbour* land tiles. Every box below stays inside its own tile,
// and the three instances that carry the terrain pick stay exactly three: the bed, the sub-surface
// slab and the water surface. Glints, shore breaks and reeds carry no pick, so a click on a water
// tile still resolves the tile itself.
import { hash, shade, variant } from './batch.js';

/** Depth, current and marginal-planting tones, each derived from a colour the family already uses. */
export const WATER_TINTS = Object.freeze({
  deep: shade('#4b9dad', 0.84), shallow: shade('#4b9dad', 1.16),
  glint: '#9bcfc4', foam: shade('#9bcfc4', 1.16), reed: shade('#468969', 0.86), lily: shade('#468969', 1.18),
});

/** A water tile whose four axis neighbours are all water is deep; anything beside land is shallow. */
export function waterDepth(typeAt, x, y) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (typeAt(x + dx, y + dy) !== 'water') return 'shallow';
  return 'deep';
}

/** The land sides of a water tile, in the four cardinal directions. */
export function shoreSides(typeAt, x, y) {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => {
    const type = typeAt(x + dx, y + dy);
    return typeof type === 'string' && type !== 'water';
  });
}

/**
 * One water tile: a bed, the sub-surface slab and the surface that carries the pick — three pickable
 * instances at every detail tier — then the unpicked reads: depth tone, glints, a lighter break on
 * each shore side, and reeds when the tile is shallow. `depth` and `sides` come from the two
 * predicates above. `detail: false` is the coarse tier: the tile keeps what it *is* (its water, its
 * pick, its depth tone) and drops the reads below the surface, which is the same water with none of
 * the fine glinting at a distance where the phase's own fog has taken over.
 */
export function waterTile(batch, { x, y, pick, dirt, depth, sides, detail = true }) {
  batch.add(x + .5, -.82, y + .5, 1, 1, 1, variant(dirt, x, y), pick);
  batch.add(x + .5, -.16, y + .5, 1, .08, 1, variant(dirt, x, y), pick);
  batch.add(x + .5, -.095, y + .5, .99, .08, .99, depth === 'deep' ? WATER_TINTS.deep : WATER_TINTS.shallow, pick);
  if (!detail) return;
  // Two glide directions rather than one, so a still surface reads as water from any orbit angle.
  const glide = hash(`${x},${y},glide`) % 4;
  if (glide === 0) batch.add(x + .34, -.05, y + .3, .42, .014, .03, WATER_TINTS.glint, null, 'detail');
  else if (glide === 1) batch.add(x + .62, -.052, y + .66, .03, .014, .5, WATER_TINTS.glint, null, 'detail');
  else if (glide === 2) batch.add(x + .3, -.048, y + .72, .3, .012, .028, WATER_TINTS.glint, null, 'detail');
  for (const [dx, dy] of sides) batch.add(x + .5 + dx * .44, -.06, y + .5 + dy * .44, dx ? .1 : .9, .02, dx ? .9 : .1, WATER_TINTS.foam, null, 'detail');
  // A shallow, land-adjacent tile grows a little marginal planting at its own edge.
  if (depth === 'shallow' && hash(`${x},${y},reed`) % 5 === 0) {
    for (const [dx, dy] of [[-.36, .3], [.3, -.34]]) batch.add(x + .5 + dx, .1, y + .5 + dy, .06, .34, .06, WATER_TINTS.reed, null, 'detail');
  }
}

/**
 * The water inside a hand-placed basin (the sealed `pond` and `fountain` furniture). The rim is the
 * solid part a resident walks around; the water sits below its lip. Colours are passed in from the
 * builder that owns the sealed definition, so the drawn tone is the definition's own.
 */
export function waterBasin(batch, { x, y, pick, rim, water, inner = .72, lip = .22, tint = null }) {
  const edge = inner / 2, bar = (1 - inner) / 2;
  batch.add(x + .5, lip / 2, y + .5 - edge - bar / 2, inner + bar * 2, lip, bar, rim, pick);
  batch.add(x + .5, lip / 2, y + .5 + edge + bar / 2, inner + bar * 2, lip, bar, rim, pick);
  batch.add(x + .5 - edge - bar / 2, lip / 2, y + .5, bar, lip, inner, rim, pick);
  batch.add(x + .5 + edge + bar / 2, lip / 2, y + .5, bar, lip, inner, rim, pick);
  batch.add(x + .5, lip / 2 + .01, y + .5, inner, Math.max(.06, lip - .1), inner, water, pick);
  if (!tint) return;
  batch.add(x + .5 - .16, lip / 2 + .045, y + .5 + .12, .24, .04, .24, tint, pick, 'detail');
  for (const [dx, dy] of [[.3, -.06], [.24, .08]]) batch.add(x + .5 + dx, lip + .1, y + .5 + dy, .05, .38, .05, WATER_TINTS.reed, pick, 'detail');
}

// Lamp glow: the soft light a lantern throws, drawn as geometry because the retained Three.js bundle
// exposes no point light, and a world full of real lights would not fit a phone's budget anyway.
//
// Each lit lamp or lantern gets three translucent boxes: a halo around its lamp head and two stacked
// pools on the ground, the larger one fainter, so the light falls off in two steps instead of ending at
// a hard edge. They are the `light` style (additive, unlit, unfogged, no depth write, never casting or
// receiving a shadow), so they cannot hide a tile or change what a tile is.
//
// This is scenery, not occupancy, and the numbers say so:
//   - the halo's lowest face is 1.56 m, above the 1.52 m resident, and it stays inside its own tile;
//   - the pools are 0.03 m thick and sit 0.06 m up, below the 0.10 m floor-decal limit;
//   - nothing here carries a pick, so a click goes through to the ground below.
// The batch is keyed to the phase, like the sky, and is empty by day: the sun is the light then.
import { inDetail } from '../voxel-geometry.js';

/** Scenery types that carry a flame. Everything else glows only through its own emissive panes. */
export const LIT_TYPES = Object.freeze(['lamp', 'lantern']);
/** The hard cap on lit lamps in one window, nearest to the viewer first, so the batch is bounded by authoring. */
export const LAMP_LIMIT = 48;
export const LAMP_GLOW = Object.freeze({ halo: '#ffd27a', pool: '#ffb35a', pool_wide: '#ff9a3c' });
/** Phases that light their lamps: the sun does that by day. An interior is always lit. */
export const LIT_PHASES = Object.freeze(['dawn', 'dusk', 'night', 'interior']);

/** The lit lamps of a plan, nearest to its anchor first and no more than `LAMP_LIMIT`. */
export function litLamps(plan) {
  const anchor = plan.anchor || { x: 0, y: 0 };
  return (plan.objects || []).filter((item) => LIT_TYPES.includes(item.type || item.kind) && Number.isInteger(item.x) && Number.isInteger(item.y))
    .map((item) => ({ x: item.x, y: item.y, distance: Math.max(Math.abs(item.x - anchor.x), Math.abs(item.y - anchor.y)) }))
    .sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x).slice(0, LAMP_LIMIT);
}

/**
 * The glow batch for one phase. `phase` is a published phase name or `'interior'`; a phase that does not
 * light its lamps (day) returns an empty batch so the caller has one shape to handle.
 */
export function lampGlowScene({ resources, cubeBatch, plan, phase }) {
  const batch = cubeBatch(resources);
  if (LIT_PHASES.includes(phase)) for (const lamp of litLamps(plan)) {
    const x = lamp.x + .5, z = lamp.y + .5, near = inDetail(lamp.x, lamp.y, plan.anchor, plan.detailRadius);
    batch.add(x, 1.9, z, .8, .68, .8, LAMP_GLOW.halo, null, 'light');
    batch.add(x, .06, z, 1.5, .03, 1.5, LAMP_GLOW.pool, null, 'light');
    if (near) batch.add(x, .062, z, 2.7, .03, 2.7, LAMP_GLOW.pool_wide, null, 'light');
  }
  const result = batch.finish(); result.group.name = 'voxel-lights';
  return result;
}

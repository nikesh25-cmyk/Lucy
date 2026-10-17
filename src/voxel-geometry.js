// Grid x/y stay compatible with movement APIs. Three.js uses its y axis for height.
import { frontierPlotId } from '../world.js';
export const VOXEL_LIMITS = Object.freeze({ radius: 18, cells: 1369, objects: 260, blocks: 2048, participants: 220, height: 8 });
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

// ---------------------------------------------------------------------------------------------
// The orbiting view's comfortable range. Level (pitch 0) is a real value: the eye sits at the
// pivot, the horizon runs across the middle of the frame and the sky above it is reachable. A
// negative pitch keeps tilting the view up, but the eye never follows it below the resident's own
// footing (`ORBIT_EYE_DROP`) — the boom stops there while the aim point keeps rising — so the
// camera can never end up inside the terrain under the resident. The distance keeps its shipped
// 6..32 range. These three numbers are the one place the orbit range is written down; the
// first-person pitch clamp in src/camera-controls.js is a separate contract and is untouched.
// ---------------------------------------------------------------------------------------------
export const ORBIT_PITCH = Object.freeze({ min: -0.9, max: 1.4, default: 0.62 });
export const ORBIT_DISTANCE = Object.freeze({ min: 6, max: 32, default: 17 });
export const ORBIT_EYE_DROP = 0.45;

export function clampOrbitPitch(value) { return clamp(finite(value, ORBIT_PITCH.default), ORBIT_PITCH.min, ORBIT_PITCH.max); }
export function clampOrbitDistance(value) { return clamp(finite(value, ORBIT_DISTANCE.default), ORBIT_DISTANCE.min, ORBIT_DISTANCE.max); }

export function normalizeOrbit(value = {}) {
  const yaw = finite(value.yaw, Math.PI / 4);
  return { yaw: yaw >= -Math.PI && yaw <= Math.PI ? yaw : ((yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI,
    pitch: clampOrbitPitch(value.pitch), distance: clampOrbitDistance(value.distance) };
}

const cameraMode = value => value === 'first-person' ? 'first-person' : 'orbit';
const normalizeCameraInput = (value, mode) => mode === 'first-person'
  ? { ...normalizeOrbit(value), pitch: clamp(finite(value.pitch, 0), -1.4, 1.4) }
  : normalizeOrbit(value);

/** One owner for orbit input. Only a real drag emits the already-applied absolute look state. */
export function createOrbitInput({ initial = {}, mode: initialMode = 'orbit', onLook } = {}) {
  let mode = cameraMode(initialMode), orbit = normalizeCameraInput(initial, mode);
  const set = value => { orbit = normalizeCameraInput({ ...orbit, ...value }, mode); return { ...orbit }; };
  return {
    get orbit() { return { ...orbit }; },
    get mode() { return mode; },
    setMode(value) { mode = cameraMode(value); orbit = normalizeCameraInput(orbit, mode); return mode; },
    set,
    rotate(yaw = 0, pitch = 0) { return set({ yaw: orbit.yaw + (Number.isFinite(yaw) ? yaw : 0), pitch: orbit.pitch + (Number.isFinite(pitch) ? pitch : 0) }); },
    zoom(distance = 0) { return set({ distance: orbit.distance + (Number.isFinite(distance) ? distance : 0) }); },
    drag(x = 0, y = 0) {
      const previous = orbit;
      const next = set({ yaw: orbit.yaw - (Number.isFinite(x) ? x : 0) * .008, pitch: orbit.pitch + (Number.isFinite(y) ? y : 0) * .006 });
      if (previous.yaw !== next.yaw || previous.pitch !== next.pitch) onLook?.({ ...next });
      return next;
    }
  };
}

/** True first-person eye and view direction; positive pitch looks down, as in orbit mode. */
export function firstPersonCamera(position, value = {}) {
  const facing = normalizeCameraInput(value, 'first-person');
  const eye = { x: finite(position?.x, 0) + .5, y: clamp(finite(position?.z, 0), 0, VOXEL_LIMITS.height) + 1.35, z: finite(position?.y, 0) + .5 };
  const horizontal = Math.cos(facing.pitch);
  return { eye, target: { x: eye.x - Math.sin(facing.yaw) * horizontal, y: eye.y - Math.sin(facing.pitch),
    z: eye.z - Math.cos(facing.yaw) * horizontal }, orbit: facing };
}

export function orbitCamera(position, value = {}) {
  const orbit = normalizeOrbit(value), x = finite(position?.x, 0) + 0.5, z = finite(position?.y, 0) + 0.5;
  const height = clamp(finite(position?.z, 0), 0, VOXEL_LIMITS.height) + 0.75;
  const horizontal = Math.cos(orbit.pitch) * orbit.distance, lift = Math.sin(orbit.pitch) * orbit.distance;
  // The boom descends no further than the resident's own footing. When it stops, the aim point rises
  // by exactly the drop the boom refused, so a continued push still tilts the view up at the sky
  // instead of dying, and the eye is never below the tile the resident is standing on.
  const drop = Math.max(lift, -ORBIT_EYE_DROP);
  return { target: { x, y: height, z }, eye: { x: x + Math.sin(orbit.yaw) * horizontal, y: height + drop, z: z + Math.cos(orbit.yaw) * horizontal },
    // `look` is what the camera aims along; it differs from `target` only when the boom was floored.
    look: { x, y: height + (drop - lift), z }, floored: drop > lift, orbit };
}

// ---------------------------------------------------------------------------------------------
// Zoom. One clamped number — the boom distance — drives both cameras: the orbiting eye travels
// along the boom, and the first-person eye narrows its field of view. A wheel turn therefore means
// "closer" in either view, and the same value survives a view switch. Neither camera reads or
// writes a position on the server: this is camera geometry only.
// ---------------------------------------------------------------------------------------------

/** Tiles of boom travel per wheel pixel. A wheel notch of 100 px is a four-tile step. */
export const WHEEL_TILES_PER_PIXEL = 0.04;
export const WHEEL_LINE_PIXELS = 16;
export const WHEEL_PAGE_PIXELS = 320;

/** A wheel delta in CSS pixels, so line-mode and page-mode wheels zoom like a pixel-mode one. */
export function normalizedWheelDelta(deltaY, deltaMode = 0) {
  const amount = finite(deltaY, 0);
  if (deltaMode === 1) return amount * WHEEL_LINE_PIXELS;
  if (deltaMode === 2) return amount * WHEEL_PAGE_PIXELS;
  return amount;
}

/** The distance a wheel asks for, always inside the shipped range. Scrolling down pulls back. */
export function wheelZoom(distance, pixels) { return clampOrbitDistance(clampOrbitDistance(distance) + finite(pixels, 0) * WHEEL_TILES_PER_PIXEL); }

/** A two-finger pinch: fingers apart (scale > 1) is one step closer, clamped like every other zoom. */
export function pinchDistance(startDistance, scale) {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return clampOrbitDistance(clampOrbitDistance(startDistance) / factor);
}

// The shipped 48° field of view is what a distance of about 17 asks for; the two ends are the
// narrowest and widest the first-person view may go, so a zoom can never become a telephoto tube or
// a fisheye.
export const FOV_LIMITS = Object.freeze({ min: 30, max: 68, base: 48 });

export function fovForDistance(distance) {
  const span = ORBIT_DISTANCE.max - ORBIT_DISTANCE.min;
  return FOV_LIMITS.min + (clampOrbitDistance(distance) - ORBIT_DISTANCE.min) / span * (FOV_LIMITS.max - FOV_LIMITS.min);
}

// ---------------------------------------------------------------------------------------------
// Presentation-only easing. The camera glides toward the facing and the distance the shell stored;
// nothing here writes a position and no server value is ever derived from an eased number. A caller
// with no animation frame applies one step at rate 1 and gets the stored value exactly.
// ---------------------------------------------------------------------------------------------
export const LOOK_EASE = Object.freeze({ rate: 0.3, period: 16.7, epsilon: 0.002 });

/** One step of an exponential approach. It never overshoots and lands exactly on the target. */
export function approach(current, target, rate = LOOK_EASE.rate, epsilon = LOOK_EASE.epsilon) {
  const from = finite(current, 0), to = finite(target, from), fraction = clamp(finite(rate, 0), 0, 1);
  return Math.abs(to - from) <= epsilon ? to : from + (to - from) * fraction;
}

/** The per-frame fraction for an elapsed time, so a 120 Hz display eases in the same wall time. */
export function easeRate(elapsedMs, rate = LOOK_EASE.rate, period = LOOK_EASE.period) {
  const frames = clamp(finite(elapsedMs, period) / period, 0, 8);
  return 1 - Math.pow(1 - clamp(finite(rate, 0), 0, 1), frames);
}

/** The shortest signed turn between two yaws, so an eased look never travels the long way round. */
export function shortestTurn(from, to) {
  const delta = finite(to, 0) - finite(from, 0);
  return delta >= -Math.PI && delta <= Math.PI ? delta : ((delta + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

/** One easing step of a whole orbit: yaw the short way round, pitch and distance straight. */
export function approachOrbit(current, target, rate = LOOK_EASE.rate) {
  const from = normalizeOrbit(current), to = normalizeOrbit(target), fraction = clamp(finite(rate, 0), 0, 1), turn = shortestTurn(from.yaw, to.yaw);
  const yaw = Math.abs(turn) <= LOOK_EASE.epsilon ? to.yaw : from.yaw + turn * fraction;
  const pitch = approach(from.pitch, to.pitch, rate), distance = approach(from.distance, to.distance, rate);
  const settled = yaw === to.yaw && pitch === to.pitch && distance === to.distance;
  return { yaw: settled ? to.yaw : yaw, pitch, distance, settled };
}

/** The authored world's own tile bounds, read once for the anchor and the window. */
const worldBounds = (definition) => ({
  columns: clamp(Math.floor(finite(definition?.columns ?? definition?.width, 20)), 1, 4096),
  rows: clamp(Math.floor(finite(definition?.rows ?? definition?.height, 14)), 1, 4096),
});

/** The tile the followed resident stands on, clamped inside the authored world. */
export function voxelAnchor(definition, position) {
  const { columns, rows } = worldBounds(definition);
  return { x: clamp(Math.floor(finite(position?.x, definition?.start?.x ?? 0)), 0, columns - 1),
    y: clamp(Math.floor(finite(position?.y, definition?.start?.y ?? 0)), 0, rows - 1) };
}

export function voxelWindow(definition, position) {
  const { columns, rows } = worldBounds(definition), { x, y } = voxelAnchor(definition, position);
  return { x: Math.max(0, x - VOXEL_LIMITS.radius), y: Math.max(0, y - VOXEL_LIMITS.radius),
    right: Math.min(columns, x + VOXEL_LIMITS.radius + 1), bottom: Math.min(rows, y + VOXEL_LIMITS.radius + 1), columns, rows };
}

export const inVoxelWindow = (item, window) => Number.isInteger(item?.x) && Number.isInteger(item?.y) &&
  item.x >= window.x && item.x < window.right && item.y >= window.y && item.y < window.bottom;

/**
 * Level of detail: how far from the followed resident the drawn ground is still read at full detail.
 *
 * The window is one square of terrain around that resident, and only the tiles close to them are
 * examined closely. Beyond `detail_radius` a tile keeps every instance that decides *what it is* —
 * its surface, its obstacle, its pick, its building, its saved blocks — and loses the instances that
 * only decide *how its ground reads*: the mottling and seedling decals, the leaf litter and understory
 * tufts, and the water glints, shore breaks and marginal reeds. Every dropped box is unpicked, and the
 * occupancy classes in src/footprints.js are untouched, so a coarse tile is still drawn as exactly the
 * tile the server refuses or allows.
 *
 * The radius is the whole purpose of the rule: the decorative cost is bounded by the area inside it,
 * so it does not grow when the window grows. That is what keeps a full 37 x 37 viewport inside the
 * renderer's instance budget (tests/render-lod.test.js) instead of paying for decoration across all
 * 1,369 cells. The radius is authoring, not a bound: `VOXEL_LIMITS` is unchanged, and 12 tiles is
 * where the phase's own depth cue starts (src/scene/sky.js derives `near` as `distance * .5 + 4`),
 * so the fine reading ends where the fog begins and a decal 3-30 cm tall is under a pixel.
 */
export const LOD_LIMITS = Object.freeze({ detail_radius: 12 });

/**
 * The static diorama's instance ceiling for one viewport, stated as an assertion instead of a hope.
 *
 * It is a *measured* ceiling with stated headroom, which is what makes it a regression guard: a pass
 * that starts drawing per-cell geometry, or a decoration pass that stops respecting
 * `LOD_LIMITS.detail_radius`, breaks this number in `tests/render-lod.test.js` rather than costing a
 * frame on a phone. Each term is named because each has its own owner:
 *
 *   instances            world geometry — terrain, water, buildings, scenery, navigation, the sky and
 *                        the decorative ground reading — measured at the largest viewport the server
 *                        can request (a frontier sector's 37 x 37 window, 1,369 cells) with no saved
 *                        blocks: 3,228 before this task, 2,367 after the detail rule. Stated at 3,600,
 *                        which is that maximum plus ~11% headroom for authored content growth.
 *   participant_instances residents at `VOXEL_LIMITS.participants`, each at the 22 boxes the
 *                        worst-case body draws (a ring, legs, arms, torso, head, headwear, eyes, an
 *                        emblem badge with its glyph and the NPC marker with its fins).
 *   block_instances      saved block columns at `VOXEL_LIMITS.blocks`, one instance per stored layer.
 *   draw_calls           one mesh per colour and material style, the same 130 `tests/render-scene.test.js`
 *                        bounds from the other side.
 */
export const DIORAMA_BUDGET = Object.freeze({
  instances: 3600, participant_instances: 4840, block_instances: 2048, draw_calls: 130,
});

/**
 * The detail tier of one tile: its Chebyshev distance from the followed resident. `fine` tiles are
 * drawn exactly as they have always been; `coarse` tiles keep what the tile *is* and lose the reading
 * of its ground. An anchor that is not a tile, or a radius that is not a number, leaves every tile
 * `fine`, so a caller without a viewer can never lose detail by accident; `Infinity` is the documented
 * "no level of detail" the benchmark and tests use to reproduce the pre-LOD build.
 */
export function detailTier(x, y, anchor, radius = LOD_LIMITS.detail_radius) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(anchor?.x) || !Number.isInteger(anchor?.y)) return 'fine';
  const reach = typeof radius === 'number' && !Number.isNaN(radius) ? Math.max(0, radius) : LOD_LIMITS.detail_radius;
  return Math.max(Math.abs(x - anchor.x), Math.abs(y - anchor.y)) > reach ? 'coarse' : 'fine';
}

/** True when a tile is read at full detail. The predicate form of `detailTier`, for a hot loop. */
export const inDetail = (x, y, anchor, radius) => detailTier(x, y, anchor, radius) === 'fine';

/**
 * `prefers-reduced-motion`, read through an injected matchMedia so it can be tested. The same helper
 * and the same fallback as src/ui/touch-controls.js: an absent or throwing matcher means the visitor
 * stated no preference, never that they asked for motion.
 */
export function prefersReducedMotion(match) {
  if (typeof match !== 'function') return false;
  try { return Boolean(match('(prefers-reduced-motion: reduce)')?.matches); } catch { return false; }
}

/**
 * The reduced-motion preference of one renderer: an injected boolean or matcher, or the browser's own
 * `prefers-reduced-motion` query. An injected value always wins, so a test — or a host that has already
 * resolved the preference — never depends on the environment it runs in.
 */
export function reducedMotionPreference(value) {
  if (typeof value === 'function') return Boolean(value());
  if (typeof value === 'boolean') return value;
  const match = globalThis.matchMedia;
  return prefersReducedMotion(typeof match === 'function' ? match.bind(globalThis) : undefined);
}

/** Address a physical 6 × 6 plot without inferring ownership, availability, or permissions. */
export function voxelParcelAddress(worldId, position) {
  const id = frontierPlotId(worldId, position?.x, position?.y);
  if (!id) return null;
  const plotX = Math.floor(position.x / 6), plotY = Math.floor(position.y / 6);
  return { id, world_id: worldId, plot_x: plotX, plot_y: plotY,
    x: plotX * 6, y: plotY * 6, width: 6, height: 6, area_m2: 36 };
}

export function voxelParcels(definition, snapshot = {}, window = voxelWindow(definition, definition?.start)) {
  const parcels = [], seen = new Set();
  if (definition?.kind !== 'frontier' || !Array.isArray(snapshot.frontier?.parcels)) return parcels;
  for (const item of snapshot.frontier.parcels) {
    if (!Number.isInteger(item?.plot_x) || !Number.isInteger(item?.plot_y) || item.plot_x < 0 || item.plot_x > 7 || item.plot_y < 0 || item.plot_y > 7) continue;
    const position = { x: item?.plot_x * 6, y: item?.plot_y * 6 }, address = voxelParcelAddress(definition.id, position);
    if (!address || item.id !== address.id || item.world_id !== address.world_id || seen.has(address.id)) continue;
    seen.add(address.id);
    if (address.x >= window.right || address.y >= window.bottom || address.x + 6 <= window.x || address.y + 6 <= window.y) continue;
    parcels.push({ ...item, ...address });
    if (parcels.length === 64) break;
  }
  return parcels;
}

export function voxelParcelSelection(parcels, selection) {
  if (!selection) return null;
  const id = typeof selection === 'string' ? selection : selection.id;
  return parcels.find(parcel => id ? parcel.id === id : Number.isInteger(selection.plot_x) && Number.isInteger(selection.plot_y) &&
    parcel.plot_x === selection.plot_x && parcel.plot_y === selection.plot_y && (!selection.world_id || selection.world_id === parcel.world_id)) || null;
}

// A tile's type as voxelPlan resolves it: an observed tile wins over the retained map.
const resolvedCellType = (definition, snapshot, camera, x, y) => {
  const observed = snapshot?.terrain?.[y - camera.y]?.[x - camera.x];
  return typeof observed === 'string' ? observed : definition?.terrain?.[y]?.[x];
};

/**
 * The same resolution for a scene module: the snapshot's own camera origin is the observation
 * origin, so a water pass or a ground-cover pass reads exactly the tiles voxelPlan drew.
 */
export const cellTypeAt = (definition, snapshot, x, y) => resolvedCellType(definition, snapshot, snapshot?.camera || { x: 0, y: 0 }, x, y);

const OCCLUSION_NEIGHBOURS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);
// A water base sits at -0.82 instead of -0.5 and a bridge carries a deck, so neither is ever culled.
const BASE_ALWAYS_VISIBLE = new Set(['water', 'bridge']);

/**
 * Whole-node cull for the terrain base cube, the analogue of Luanti's `if (!faces) return;`.
 * A land cell whose four axis neighbours are all land cells has no exposed side: every neighbour's
 * base cube covers the shared face and the surface slab above is always drawn. Neighbours beyond the
 * render window are resolved from the retained world terrain too, so moving the viewport cannot
 * create a dark clipping wall. An undefined neighbour is retained as an actual world edge.
 * `water` never occludes because its base sits 0.32 lower, so a land/water seam keeps its side face.
 */
export function cellOccludedBelow(definition, snapshot, plan, x, y) {
  if (!plan?.window || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  const camera = snapshot?.camera || { x: 0, y: 0 }, type = resolvedCellType(definition, snapshot, camera, x, y);
  if (typeof type !== 'string' || BASE_ALWAYS_VISIBLE.has(type)) return false;
  for (const [dx, dy] of OCCLUSION_NEIGHBOURS) {
    const nearX = x + dx, nearY = y + dy, near = resolvedCellType(definition, snapshot, camera, nearX, nearY);
    if (typeof near !== 'string' || near === 'water') return false;
  }
  return true;
}

/**
 * The resolved viewport: the window, the tile the followed resident stands on (`anchor`), the detail
 * radius the scene passes read (`detailRadius`), and the bounded cells, objects, portals, gates,
 * blocks and participants for that viewport. Passing `Infinity` as `detailRadius` builds the pre-LOD
 * plan, which is how the benchmark and the tests produce their "before" column.
 */
export function voxelPlan(definition, snapshot = {}, position = definition?.start, detailRadius = LOD_LIMITS.detail_radius) {
  const window = voxelWindow(definition, position), anchor = voxelAnchor(definition, position), cells = [];
  const parcels = voxelParcels(definition, snapshot, window), byParcel = new Map(parcels.map(parcel => [parcel.id, parcel]));
  const sourceCamera = snapshot.camera || { x: 0, y: 0 };
  for (let y = window.y; y < window.bottom; y++) for (let x = window.x; x < window.right; x++) {
    const type = resolvedCellType(definition, snapshot, sourceCamera, x, y);
    if (typeof type === 'string') {
      const address = voxelParcelAddress(definition?.id, { x, y }), parcel = address ? byParcel.get(address.id) : null;
      cells.push({ x, y, type, ...(parcel ? { parcel } : {}) });
    }
  }
  const uniqueObjects = new Map();
  // Decorative definitions are local. Saved objects take precedence at the same coordinate.
  for (const item of [...(definition?.objects || []), ...(snapshot.objects || [])]) {
    if (inVoxelWindow(item, window)) uniqueObjects.set(`${item.x},${item.y},${item.type || item.kind}`, item);
  }
  const objects = [...uniqueObjects.values()].slice(0, VOXEL_LIMITS.objects);
  const portals = (snapshot.portals || definition?.portals || []).filter(item => inVoxelWindow(item, window)).slice(0, 80);
  const gates = (snapshot.frontier?.neighbors || []).filter(item => item.exists === false && inVoxelWindow(item, window)).slice(0, 4);
  const blocks = [], seenBlocks = new Set();
  for (const item of snapshot.blocks || []) {
    if (!inVoxelWindow(item, window) || !Number.isInteger(item.z) || item.z < 0 || item.z >= VOXEL_LIMITS.height) continue;
    const key = `${item.x},${item.y},${item.z}`;
    if (seenBlocks.has(key)) continue;
    seenBlocks.add(key); blocks.push(item);
    if (blocks.length === VOXEL_LIMITS.blocks) break;
  }
  const participants = [], seenPeople = new Set();
  for (const item of snapshot.participants || snapshot.agents || []) {
    if (!inVoxelWindow(item, window) || ['deleted', 'revoked'].includes(item.status) || seenPeople.has(item.id)) continue;
    seenPeople.add(item.id); participants.push(item);
    if (participants.length === VOXEL_LIMITS.participants) break;
  }
  return { window, anchor, detailRadius, cells, objects, portals, gates, blocks, participants, parcels };
}

/** Convert an actual Raycaster intersection, preserving server coordinates and cube face. */
export function voxelPick(intersection) {
  const data = intersection?.object?.userData;
  const record = Number.isInteger(intersection?.instanceId) ? data?.picks?.[intersection.instanceId] : data?.pick;
  if (!record || !Number.isInteger(record.x) || !Number.isInteger(record.y)) return null;
  const normal = intersection.face?.normal;
  const face = normal ? { x: Math.round(normal.x) || 0, y: Math.round(normal.z) || 0, z: Math.round(normal.y) || 0 } : { x: 0, y: 0, z: 1 };
  const z = record.z ?? 0;
  return { ...record, z, face, adjacent: record.type === 'block' ? { x: record.x + face.x, y: record.y + face.y, z: z + face.z } : { x: record.x, y: record.y, z: 0 } };
}

/**
 * The identity of a hovered target, for a caller that only wants to redraw its aim line when the
 * thing under the pointer changed: the same tile, layer, kind, cube face and — where the renderer
 * knows one — the same named object is the same reading. An empty string is "nothing is hovered",
 * so a pointer leaving the canvas is the same event as a pointer over empty sky.
 */
export function hoverKey(pick) {
  if (!pick || !Number.isInteger(pick.x) || !Number.isInteger(pick.y)) return '';
  const face = pick.face || {};
  const named = pick.block?.id ?? pick.participant?.id ?? pick.portal?.label ?? pick.portal?.name ?? '';
  return [pick.type || 'tile', pick.x, pick.y, pick.z || 0, Math.round(finite(face.x, 0)), Math.round(finite(face.y, 0)), Math.round(finite(face.z, 0)), named].join(',');
}

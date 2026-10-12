// Server-authoritative column collision for elevation. Integer grid layers only.
// Grid x/y keep the world tile convention (up = -y). z is the layer index, 0 at the base.
export const ELEVATION_LIMITS = Object.freeze({
  min: 0, max: 8, stepUp: 1, maxFall: 8, headroom: 2, maxSubsteps: 8,
});

export const ELEVATION_DIRECTIONS = Object.freeze({ up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] });

export const ELEVATION_BLOCKING_OBJECTS = Object.freeze(['cottage', 'tree', 'pond', 'fountain']);

const limits = ELEVATION_LIMITS;
const blockingObjects = new Set(ELEVATION_BLOCKING_OBJECTS);
const columnKey = (x, y) => `${x},${y}`;
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const columnOf = (layers, x, y) => layers instanceof Map ? layers.get(columnKey(x, y)) : undefined;
const solidAt = (layers, x, y) => Boolean(columnOf(layers, x, y)?.size);
const sanitized = (position) => ({ x: finite(position?.x, 0), y: finite(position?.y, 0), z: finite(position?.z, 0) });

/** A standable column is addressed by integer x/y; z, when present, must sit inside the standable range. */
function validColumn(position) {
  if (!Number.isInteger(position?.x) || !Number.isInteger(position?.y)) return false;
  const z = position.z;
  return z === undefined || z === null || Number.isInteger(z) && z >= limits.min && z <= limits.max;
}

function directionOffset(direction) {
  if (typeof direction === 'string') return ELEVATION_DIRECTIONS[direction] || null;
  if (Array.isArray(direction) && direction.length === 2) return direction.every(Number.isInteger) ? direction : null;
  if (direction && Number.isInteger(direction.x) && Number.isInteger(direction.y)) return [direction.x, direction.y];
  return null;
}

const layersOf = (world) => world?.layers instanceof Map ? world.layers : blockLayers(world?.blocks);

// Solid layers only: `path` is a thin 0.09-tall non-solid surface, matching src/spaces.js and src/frontier.js.
export function blockLayers(blocks) {
  const layers = new Map();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!Number.isInteger(block?.x) || !Number.isInteger(block?.y) || !Number.isInteger(block?.z)) continue;
    if (block.z < limits.min || block.type === 'path') continue;
    const key = columnKey(block.x, block.y);
    const column = layers.get(key) || layers.set(key, new Set()).get(key);
    column.add(block.z);
  }
  return layers;
}

// Highest solid z in the column + 1, so the layer's top face is standable. Empty column => 0.
export function surfaceAt(x, y, layers) {
  const column = Number.isInteger(x) && Number.isInteger(y) ? columnOf(layers, x, y) : undefined;
  if (!column || column.size === 0) return limits.min;
  let highest = -Infinity;
  for (const z of column) if (z > highest) highest = z;
  return highest + 1;
}

// No solid layer strictly between feet+1 and feet+headroom (inclusive) => the head is clear.
export function headClear(x, y, feet, layers, headroom = limits.headroom) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(feet)) return false;
  const column = columnOf(layers, x, y);
  if (!column || column.size === 0) return true;
  const ceiling = feet + (Number.isInteger(headroom) ? headroom : limits.headroom);
  for (let z = feet + 1; z <= ceiling; z++) if (column.has(z)) return false;
  return true;
}

// Bounds (min..max) and headroom.
export function canOccupy(x, y, feet, layers) {
  return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(feet) &&
    feet >= limits.min && feet <= limits.max && headClear(x, y, feet, layers);
}

// A blocked step keeps the agent where it was; grounded is re-derived rather than assumed.
function held(from, layers, reason) {
  const position = sanitized(from);
  return { position, grounded: isGrounded(position, layers), blocked: true, reason };
}

/**
 * One cardinal step.
 * `world` supplies walkable(target, definition), definition, objects, and either `layers`
 * (a blockLayers map) or `blocks` (raw authored blocks). `world.authoredLayers` is the subset
 * of solids authored by players; it DEFAULTS to every solid layer, which keeps authored blocks
 * hard walls. Step-up onto solid ground only happens when the caller explicitly passes
 * `policy.allowAuthoredStepUp: true`; do not remove that flag, it preserves the shipped rule
 * that a single authored block blocks movement (see world-walk.js).
 */
export function canStep(from, direction, world = {}, policy = {}) {
  const layers = layersOf(world);
  const offset = directionOffset(direction);
  if (!offset || !validColumn(from)) return held(from, layers, 'invalid');
  const target = { x: from.x + offset[0], y: from.y + offset[1] };
  if (typeof world.walkable !== 'function') return held(from, layers, 'invalid');
  if (!world.walkable(target, world.definition)) return held(from, layers, 'unwalkable');
  const objects = Array.isArray(world.objects) ? world.objects : [];
  const blockers = world.blockingObjects instanceof Set ? world.blockingObjects : blockingObjects;
  if (objects.some((object) => object && object.x === target.x && object.y === target.y && blockers.has(object.type ?? object.kind))) {
    return held(from, layers, 'object');
  }
  const originSurface = surfaceAt(from.x, from.y, layers);
  const targetSurface = surfaceAt(target.x, target.y, layers);
  const delta = targetSurface - originSurface;
  if (delta > limits.stepUp) return held(from, layers, 'too_high');
  if (delta < -limits.maxFall) return held(from, layers, 'too_low');
  if (targetSurface > limits.max) return held(from, layers, 'too_high');
  if (targetSurface < limits.min) return held(from, layers, 'too_low');
  if (!canOccupy(target.x, target.y, targetSurface, layers)) return held(from, layers, 'no_headroom');
  const authored = world.authoredLayers instanceof Map ? world.authoredLayers : layers;
  if (policy.allowAuthoredStepUp !== true && solidAt(authored, target.x, target.y)) return held(from, layers, 'authored');
  return delta < 0
    ? { position: { x: target.x, y: target.y, z: finite(from.z, originSurface) }, grounded: false, blocked: false, reason: null }
    : { position: { x: target.x, y: target.y, z: targetSurface }, grounded: true, blocked: false, reason: null };
}

// Clamp a position's z down to the column surface (used after a block change).
export function settle(position, layers) {
  const x = finite(position?.x, 0), y = finite(position?.y, 0), surface = surfaceAt(x, y, layers);
  const z = Number.isFinite(position?.z) ? Math.min(position.z, surface) : surface;
  return { x, y, z: Number.isInteger(z) ? z : Math.floor(z) };
}

export function isGrounded(position, layers) {
  if (!Number.isInteger(position?.x) || !Number.isInteger(position?.y) || !Number.isInteger(position?.z)) return false;
  return position.z === surfaceAt(position.x, position.y, layers);
}

/**
 * Guard rail for a single advance: split `delta` into single-tile cardinal substeps and abort at
 * the first blocked one, so a large delta can never tunnel through geometry. Diagonal deltas,
 * non-integers, and advances longer than maxSubsteps are rejected as 'invalid'.
 * `substeps` counts the substeps attempted, including the blocked one.
 */
export function simulateStep(origin, delta, context = {}) {
  const world = context?.world ?? context;
  const policy = context?.policy ?? {};
  const layers = layersOf(world);
  const dx = delta?.x, dy = delta?.y;
  const rejected = { position: sanitized(origin), grounded: false, blockedAt: null, reason: 'invalid', substeps: 0 };
  if (!validColumn(origin) || !Number.isInteger(dx) || !Number.isInteger(dy) || dx !== 0 && dy !== 0) return rejected;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps > limits.maxSubsteps) return rejected;
  if (steps === 0) return { position: { x: origin.x, y: origin.y, z: origin.z }, grounded: isGrounded(origin, layers), blockedAt: null, reason: null, substeps: 0 };
  const direction = dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'down' : 'up';
  const [ox, oy] = ELEVATION_DIRECTIONS[direction];
  let position = { x: origin.x, y: origin.y, z: origin.z }, grounded = isGrounded(origin, layers);
  for (let index = 1; index <= steps; index++) {
    const result = canStep(position, direction, world, policy);
    if (result.blocked) return { position, grounded, blockedAt: { x: position.x + ox, y: position.y + oy, z: position.z }, reason: result.reason, substeps: index };
    position = result.position;
    grounded = result.grounded;
  }
  return { position, grounded, blockedAt: null, reason: null, substeps: steps };
}

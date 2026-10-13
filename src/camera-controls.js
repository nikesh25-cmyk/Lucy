// Camera and control intents. One owner per gesture, and a look never becomes a movement.
//
// The renderer's forward vector on the ground is (-sin(yaw), -cos(yaw)).
export function cameraWalkDirection(direction, yaw) {
  if (!['up', 'down', 'left', 'right'].includes(direction) || !Number.isFinite(yaw)) {
    throw new TypeError('Use a cardinal walking direction and a finite camera yaw.');
  }
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  const vectors = { up: [-sin, -cos], down: [sin, cos], right: [cos, -sin], left: [-cos, sin] };
  const [x, y] = vectors[direction];
  return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up');
}

/** A pointer gesture is either a look drag or a pick click, never both, from one measured distance. */
export const POINTER_DRAG_THRESHOLD = 6;
export function pointerGesture(distance) {
  return Number.isFinite(distance) && distance > POINTER_DRAG_THRESHOLD ? 'look' : 'pick';
}

/** Keyboard controls: WASD and the arrow keys walk, Q/E turn, R/F tilt, and the digits pick a frontier block. */
export const WALK_KEYS = Object.freeze({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', a: 'left', s: 'down', d: 'right' });
export const TURN_KEYS = Object.freeze({
  q: Object.freeze({ yaw: 0.35, pitch: 0 }), e: Object.freeze({ yaw: -0.35, pitch: 0 }),
  r: Object.freeze({ yaw: 0, pitch: 0.25 }), f: Object.freeze({ yaw: 0, pitch: -0.25 }),
});

// Direct interaction with a nearby fixture. The reach is the same one-tile Manhattan adjacency the
// server already requires for a doorway, and the keys are the keyboard equivalent of the interface's
// own action control, so no interaction is available by mouse alone.
export const INTERACTION_DISTANCE = 1;
export const INTERACTION_KEYS = Object.freeze(['Enter', ' ', 'i']);
export function isInteractionKey(key) { return INTERACTION_KEYS.includes(key); }
// The one label for the interaction control. The keys above and this wording come from a single
// place, so a HUD hint can never advertise a key the binding does not use. The shipped HUD says
// "E to interact" while `E` turns the camera; the exact replacement wording is in docs/CONTROLS.md.
export const INTERACTION_KEY_LABEL = 'Enter, Space or I';

/** What a single key press asks for, or null when the key is not a control. */
export function keyIntent(key, { frontier = false, palette = [], agent = false, fixture = false, building = false, camera = false } = {}) {
  if (frontier && agent && /^[1-7]$/.test(key)) {
    const type = palette[Number(key) - 1];
    return type ? { kind: 'build', type } : null;
  }
  // Enter, Space or I use the fixture the aim line names. Building keeps its own keys first, and a
  // key with no fixture picked stays unbound, so the walking and turning controls never change meaning.
  if (fixture && !building && isInteractionKey(key)) return { kind: 'interact' };
  // Switching the view is offered only to a resident who is actually standing in the world.
  if (camera && CAMERA_TOGGLE_KEYS.includes(key)) return { kind: 'camera' };
  const turn = TURN_KEYS[key];
  if (turn) return { kind: 'turn', yaw: turn.yaw, pitch: turn.pitch };
  const direction = WALK_KEYS[key];
  return direction ? { kind: 'walk', direction } : null;
}

/**
 * Which server action a movement control issues. Turning is a look: it changes the stored facing and
 * never a position, so a look intent carries no walking direction at all. Only a move carries a
 * cardinal direction, and in first person that direction is the view-relative grid step.
 */
export function controlIntent(direction, { firstPerson = false, yaw = 0, lookMode = false, keyboard = false } = {}) {
  if (lookMode && !(keyboard && firstPerson)) return { kind: 'look', turn: direction };
  return { kind: 'move', direction: firstPerson ? cameraWalkDirection(direction, yaw) : direction };
}

/**
 * One owner for look requests. A burst of drag events coalesces into at most one send per delay
 * window, and the sender receives the caller's own facing state: the scheduler can never issue a
 * movement, and a drag can never double-fire a look.
 */
export function createLookScheduler({ send, now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout, delay = 150 } = {}) {
  if (typeof send !== 'function') throw new TypeError('A look scheduler needs a send function.');
  const wait = Number.isFinite(delay) && delay >= 0 ? delay : 150;
  let timer = null, lastSent = -Infinity;
  const flush = () => { timer = null; lastSent = now(); send(); };
  return {
    /** Ask for one look. Returns 'sent' when it was sent now and 'queued' when it was coalesced. */
    request() {
      const elapsed = now() - lastSent;
      if (elapsed >= wait) { flush(); return 'sent'; }
      if (timer === null) timer = schedule(flush, wait - elapsed);
      return 'queued';
    },
    cancel() { if (timer !== null) { cancel(timer); timer = null; } },
    get pending() { return timer !== null; },
  };
}

/** The compass direction the camera looks along, in the grid's convention (up/north is -y). */
export function facingLabel(yaw) {
  const points = ['north', 'north-west', 'west', 'south-west', 'south', 'south-east', 'east', 'north-east'];
  const angle = Number.isFinite(yaw) ? yaw : 0;
  const index = Math.round(angle / (Math.PI / 4)) % 8;
  return points[(index + 8) % 8];
}

const KINDS = { terrain: 'ground', object: 'scenery', block: 'block', participant: 'character', portal: 'entrance', gate: 'frontier passage' };

/**
 * The readable aim line under the first-person view: where the camera is, what the last pick targets,
 * which fixture that pick can be used with, and which keys walk or turn. Text only, so the interface
 * never injects markup.
 */
export function reticleText({ firstPerson = false, facing = {}, position = null, selection = null, blocked = null, fixture = null } = {}) {
  const parts = [];
  parts.push(firstPerson ? 'First person' : 'Orbiting view');
  parts.push(`facing ${facingLabel(facing.yaw)}`);
  if (Number.isInteger(position?.x) && Number.isInteger(position?.y)) parts.push(`at ${position.x}, ${position.y}${Number.isInteger(position?.z) ? `, layer ${position.z}` : ''}`);
  if (selection && Number.isInteger(selection.x) && Number.isInteger(selection.y)) {
    const kind = KINDS[selection.type] || 'tile';
    const detail = typeof blocked === 'boolean' ? blocked ? 'solid, walk around it' : 'walkable' : null;
    parts.push(`aimed at ${kind} ${selection.x}, ${selection.y}${selection.z ? `, layer ${selection.z}` : ''}${detail ? ` · ${detail}` : ''}`);
  } else parts.push('no tile picked yet');
  // The picked fixture and how to use it, in plain text, so the hint is never only graphical.
  if (fixture && Number.isInteger(fixture.x) && Number.isInteger(fixture.y)) {
    const label = String(fixture.label || 'fixture').toLowerCase();
    parts.push(fixture.in_range
      ? `${fixture.action?.label || 'Use it'} with ${INTERACTION_KEY_LABEL}`
      : `stand within ${fixture.required_distance || INTERACTION_DISTANCE} tile of the ${label} at ${fixture.x}, ${fixture.y}`);
  }
  parts.push(firstPerson ? 'WASD walks the way you face · Q/E turn · R/F tilt · arrow keys also walk' : 'drag to orbit · click open ground to walk · arrow keys or WASD walk');
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// Two camera modes. Both read one stored facing; only the eye position differs. First person stands
// inside the resident's own column. Third person keeps the same eye height and the same look
// direction and slides the camera straight back along the ground until it would enter a tile the
// shared occupancy rules already refuse at that layer. It therefore never rises above the stored
// elevation layer and never crosses a wall, so it can reveal no geometry a first-person resident at
// that layer could not already see. The controller that drives both modes is src/game-input.js.
// ---------------------------------------------------------------------------------------------

export const CAMERA_MODES = Object.freeze(['first-person', 'third-person']);
export const DEFAULT_CAMERA_MODE = 'first-person';
export const EYE_HEIGHT = 1.35;          // metres above the resident's feet, matching src/voxel-geometry.js
export const BOOM_LENGTH = 3.2;          // tiles of shoulder distance in third person
export const THIRD_PERSON_MAX_STEP = 1;  // layers the boom may climb before it stops: one authored step
export const CAMERA_TOGGLE_KEYS = Object.freeze(['v']);
export const MAX_PITCH = 1.4;

const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

export function normalizeCameraMode(value) { return value === 'third-person' ? 'third-person' : 'first-person'; }

/** Wrap a yaw into the renderer's [-pi, pi] range without changing the direction it names. */
export function wrapYaw(value) {
  const yaw = finite(value, 0);
  return yaw >= -Math.PI && yaw <= Math.PI ? yaw : ((yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

export function clampPitch(value, limit = MAX_PITCH) { return Math.max(-limit, Math.min(limit, finite(value, 0))); }

// The camera's forward vector: grid (x, y) with y as height, so ground forward is (-sin yaw, -cos yaw).
const forwardFrom = (yaw, pitch) => {
  const horizontal = Math.cos(pitch);
  return { x: -Math.sin(yaw) * horizontal, y: -Math.sin(pitch), z: -Math.cos(yaw) * horizontal };
};

/** The first-person eye, its unit look direction and the clamped facing the renderer stores. */
export function firstPersonView(position, facing = {}) {
  const yaw = wrapYaw(facing.yaw), pitch = clampPitch(facing.pitch);
  const eye = { x: finite(position?.x, 0) + .5, y: finite(position?.z, 0) + EYE_HEIGHT, z: finite(position?.y, 0) + .5 };
  return { eye, direction: forwardFrom(yaw, pitch), yaw, pitch, layer: finite(position?.z, 0) };
}

/**
 * The camera for a mode. `blocksView(x, y, layer)` is the injected occupancy predicate. First person
 * returns the resident's own eye; third person returns an eye pulled back along the ground with the
 * same height, clamped to the last clear tile, plus `distance` and `blocked` (true when a tile, not
 * the boom length, stopped it) so a caller can show the difference. Neither mode reads or writes a
 * position on the server: this is camera geometry only.
 */
export function cameraView(position, facing = {}, { mode = DEFAULT_CAMERA_MODE, boomLength = BOOM_LENGTH, blocksView = () => false } = {}) {
  if (typeof blocksView !== 'function') throw new TypeError('cameraView needs a blocksView predicate.');
  const first = firstPersonView(position, facing);
  const viewMode = normalizeCameraMode(mode);
  const forwardTarget = distance => ({ x: first.eye.x + first.direction.x * distance, y: first.eye.y + first.direction.y * distance, z: first.eye.z + first.direction.z * distance });
  if (viewMode === 'first-person') return { mode: viewMode, eye: { ...first.eye }, target: forwardTarget(1), distance: 0, blocked: false, layer: first.layer };
  const reach = Math.max(0, finite(boomLength, BOOM_LENGTH));
  const back = { x: Math.sin(first.yaw), z: Math.cos(first.yaw) };
  let distance = 0, blocked = false;
  while (distance + .5 <= reach) {
    const step = distance + .5;
    const tileX = Math.floor(first.eye.x + back.x * step), tileY = Math.floor(first.eye.z + back.z * step);
    if (blocksView(tileX, tileY, first.layer)) { blocked = true; break; }
    distance = step;
  }
  const eye = { x: first.eye.x + back.x * distance, y: first.eye.y, z: first.eye.z + back.z * distance };
  return { mode: viewMode, eye, target: { ...first.eye }, distance, blocked, layer: first.layer };
}

/**
 * Build the third-person view blocker from the shared occupancy rules. `isSolid(x, y)` answers the
 * footprint/terrain question for a tile and `layerAt(x, y)` its surface layer; a tile whose surface
 * rises more than `maxStep` above the camera layer blocks the boom, so the camera can never look over
 * a step the resident could not climb. The shell supplies both predicates, which keeps this module
 * free of any world import.
 */
export function createViewBlocker({ isSolid = () => false, layerAt = () => 0, maxStep = THIRD_PERSON_MAX_STEP } = {}) {
  if (typeof isSolid !== 'function' || typeof layerAt !== 'function') throw new TypeError('createViewBlocker needs isSolid and layerAt predicates.');
  const climb = Math.max(0, finite(maxStep, THIRD_PERSON_MAX_STEP));
  return (x, y, layer) => Boolean(isSolid(x, y)) || finite(layerAt(x, y), 0) > finite(layer, 0) + climb;
}

// ---------------------------------------------------------------------------------------------
// Suspension. Typing in chat, a focused form control, or an open dialog suspends the gameplay
// shortcuts; a menu or drawer suspends them through an explicit reason the shell owns. The predicate
// matches the shipped guard in app.js so the world stands down exactly when it did before.
// ---------------------------------------------------------------------------------------------

export const SUSPEND_REASONS = Object.freeze(['typing', 'dialog', 'menu', 'chat', 'custom']);
export const SHORTCUT_EXEMPT_TAGS = Object.freeze(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);

export function shortcutSuspended({ tagName = '', isContentEditable = false, dialogOpen = false, modifier = false } = {}) {
  return Boolean(modifier) || Boolean(dialogOpen) || Boolean(isContentEditable)
    || SHORTCUT_EXEMPT_TAGS.includes(String(tagName || '').toUpperCase());
}

/** A counted set of suspension reasons, so two callers can suspend independently and both must resume. */
export function createSuspension(initial = []) {
  const reasons = new Set();
  for (const reason of Array.isArray(initial) ? initial : []) reasons.add(String(reason));
  return {
    suspend(reason = 'custom') { reasons.add(String(reason)); return reasons.size; },
    resume(reason = 'custom') { reasons.delete(String(reason)); return reasons.size; },
    resumeAll() { const count = reasons.size; reasons.clear(); return count; },
    get suspended() { return reasons.size > 0; },
    get reasons() { return [...reasons]; },
  };
}

// The wording the shell must print. One source for both the key set and its label, so the hint can
// never advertise a key that does not work. The interaction label is INTERACTION_KEY_LABEL above.
export const CONTROL_HINTS = Object.freeze({
  playing: `WASD to walk · Drag to look · ${INTERACTION_KEY_LABEL} to interact`,
  observing: 'Drag to look · Click the map to explore',
  firstPerson: `WASD walks the way you face · Q/E turn · R/F tilt · arrow keys also walk · V switches view · ${INTERACTION_KEY_LABEL} to interact`,
});
export function controlHint({ playing = true, mode = DEFAULT_CAMERA_MODE } = {}) {
  if (!playing) return CONTROL_HINTS.observing;
  return normalizeCameraMode(mode) === 'first-person' ? CONTROL_HINTS.firstPerson : CONTROL_HINTS.playing;
}
export function targetHint(fixture) { return fixture ? `${fixture.label} · ${INTERACTION_KEY_LABEL} to interact` : 'Aim at a place or object to interact'; }

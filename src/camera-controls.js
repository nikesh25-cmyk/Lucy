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
  // The zoom wording has one home too: the wheel, a pinch and the panel's buttons all drive the one
  // documented distance, so the hint may name them together.
  parts.push(firstPerson ? 'WASD walks the way you face · Q/E turn · R/F tilt · arrow keys also walk · wheel or pinch to zoom'
    : 'drag to orbit, level or up · click open ground to walk · arrow keys or WASD walk · wheel or pinch to zoom');
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
export const SHORTCUT_EXEMPT_TAGS = Object.freeze(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY']);

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

/**
 * A zoom gesture the shipped panels own: a wheel or a pinch is inert while a menu, drawer or dialog
 * is open, while a text field holds focus, or while the shell has switched the camera's capture off
 * with `setEnabled(false)`. It is the pointer counterpart of `shortcutSuspended`, and it
 * deliberately ignores modifier keys, because a trackpad pinch arrives as a Ctrl-wheel.
 */
export function zoomSuspended({ enabled = true, tagName = '', isContentEditable = false, dialogOpen = false, menuOpen = false } = {}) {
  return !enabled || Boolean(menuOpen) || shortcutSuspended({ tagName, isContentEditable, dialogOpen });
}

// ---------------------------------------------------------------------------------------------
// The hover channel. Pointing at a tile is a reading, not a command: it costs no network request and
// it is allowed to be dropped. A pointer that moves faster than this rate simply reports less often,
// and a pointer that leaves the canvas drops its reading immediately (`drop()`), so an aim line can
// never be left showing a tile the pointer is no longer over.
// ---------------------------------------------------------------------------------------------
export const HOVER_INTERVAL_MS = 75;

export function createHoverThrottle({ interval = HOVER_INTERVAL_MS, now = () => Date.now() } = {}) {
  const wait = Number.isFinite(interval) && interval >= 0 ? interval : HOVER_INTERVAL_MS;
  let last = -Infinity;
  return {
    /** True when a hover may be emitted now; a hit starts the next window. */
    claim() { const at = now(); if (at - last < wait) return false; last = at; return true; },
    /** The pointer left the canvas: the reading is dropped and the next claim is immediate. */
    drop() { last = -Infinity; return true; },
    get waiting() { return Number.isFinite(last) && last > -Infinity; },
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

// ---------------------------------------------------------------------------------------------
// Presentation interpolation. The drawn avatar glides between two consecutive *confirmed* tiles and
// never leaves the segment between them, so the display can never claim a tile the server did not
// store. A step of one tile or less is tweened; a longer jump (a travel, a teleport, a world change)
// or a viewer who asked for reduced motion snaps straight to the stored tile. A refused step is
// reconciled: `reconcile(id)` drops the tween and the avatar is drawn at its stored tile again.
//
// This is presentation only. Nothing here reads or writes a server position; the confirmed record it
// holds is exactly the value the server returned, and the caller owns every write.
// ---------------------------------------------------------------------------------------------

/** The longest glide between two confirmed tiles: the server steps every 120 ms. */
export const DISPLAY_TWEEN_MS = 180;
/** A confirmed change farther than this many tiles snaps instead of gliding: only a real step tweens. */
export const TWEEN_SNAP_DISTANCE = 1;

const vector = (value) => ({ x: Number.isFinite(value?.x) ? value.x : 0, y: Number.isFinite(value?.y) ? value.y : 0, z: Number.isFinite(value?.z) ? value.z : 0 });
const sameTile = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;

/**
 * Where the interpolation currently draws a record: the eased point on the segment from the tile the
 * avatar was drawn at (`from`) to the newest confirmed tile (`confirmed`). `t` is clamped to [0, 1],
 * so the result is exactly `confirmed` once the tween has elapsed and never overshoots it.
 */
export function displayCoords(record, now) {
  if (!record) return null;
  const confirmed = vector(record.confirmed);
  const duration = Number.isFinite(record.duration) ? record.duration : 0;
  const progress = duration > 0 ? Math.min(1, Math.max(0, (now - record.at) / duration)) : 1;
  if (progress >= 1) return { ...confirmed };
  const from = vector(record.from);
  const eased = progress * progress * (3 - 2 * progress);
  return {
    x: from.x + (confirmed.x - from.x) * eased,
    y: from.y + (confirmed.y - from.y) * eased,
    z: from.z + (confirmed.z - from.z) * eased,
  };
}

/**
 * One owner for the drawn-avatar interpolation of every participant on screen.
 *
 *   confirm(item)        remember one server-confirmed position; returns the stored record
 *   display(id, at)      the interpolated point right now, or null for an unknown id
 *   record(item, at)     `item` with x/y/z replaced by the interpolated point (the renderer's input)
 *   reconcile(id)        snap one avatar back to its stored tile; true when a record existed
 *   settling(at)         whether any glide is still running
 *   clear()              forget every record (a world or session change)
 *
 * `reducedMotion()` is read on every confirm, so a viewer who asked for no motion always receives the
 * stored tile immediately and the drawn avatar can never lag behind it.
 */
export function createPresenceTracker({
  now = () => Date.now(),
  duration = DISPLAY_TWEEN_MS,
  snapDistance = TWEEN_SNAP_DISTANCE,
  reducedMotion = () => false,
} = {}) {
  if (typeof now !== 'function') throw new TypeError('createPresenceTracker needs a clock.');
  if (typeof reducedMotion !== 'function') throw new TypeError('createPresenceTracker needs a reducedMotion predicate.');
  const glide = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const reach = Number.isFinite(snapDistance) && snapDistance >= 0 ? snapDistance : TWEEN_SNAP_DISTANCE;
  const records = new Map();

  function confirm(item) {
    if (!item || typeof item.id !== 'string' || !Number.isFinite(item.x) || !Number.isFinite(item.y)) return null;
    const target = vector(item);
    const world = item.world_id ?? item.world ?? null;
    const at = now();
    const record = records.get(item.id);
    if (!record) {
      const fresh = { confirmed: target, from: { ...target }, at, duration: 0, world };
      records.set(item.id, fresh);
      return fresh;
    }
    if (record.world === world && sameTile(record.confirmed, target)) return record;
    const distance = Math.abs(record.confirmed.x - target.x) + Math.abs(record.confirmed.y - target.y);
    const tween = glide > 0 && !reducedMotion() && record.world === world && distance <= reach;
    const next = tween
      ? { confirmed: target, from: displayCoords(record, at), at, duration: glide, world }
      : { confirmed: target, from: { ...target }, at, duration: 0, world };
    records.set(item.id, next);
    return next;
  }

  function get(id) { return records.get(id) || null; }
  function display(id, at = now()) { return displayCoords(records.get(id), at); }
  function record(item, at = now()) { const point = display(item?.id, at); return point ? { ...item, ...point } : item; }

  function reconcile(id) {
    const record = records.get(id);
    if (!record) return false;
    records.set(id, { ...record, from: { ...record.confirmed }, at: now(), duration: 0 });
    return true;
  }

  function settling(at = now()) {
    for (const record of records.values()) if (record.duration > 0 && record.at + record.duration > at) return true;
    return false;
  }
  function tweening(id, at = now()) { const record = records.get(id); return Boolean(record && record.duration > 0 && record.at + record.duration > at); }

  return Object.freeze({
    confirm, get, display, record, reconcile, settling, tweening,
    clear() { records.clear(); },
    entries() { return [...records.entries()]; },
    get size() { return records.size; },
  });
}

// ---------------------------------------------------------------------------------------------
// Travel affordance. One place lists the entrances the server published for the world on screen, so
// a route is discoverable (it is named with its own label and its distance) and reversible (the
// portal back to the shared Commons, or to the resident's own home, is marked and sorted first). It
// reads only `GET /world`'s `portals`; it never invents a destination.
// ---------------------------------------------------------------------------------------------

/**
 * The entrances from a position, closest first but with the way back ahead of the rest. A route is
 * `{ id, label, target, x, y, distance, back, portal }`; `back` is true for the portal whose target
 * is the shared Commons or the caller's own home world, which is what makes the route reversible.
 */
export function travelRoutes(portals = [], from = {}, { limit = 3, commons = 'commons', home = null } = {}) {
  const here = vector(from);
  const routes = [];
  for (const portal of Array.isArray(portals) ? portals : []) {
    const target = portal?.target_world_id || portal?.targetWorldId;
    if (typeof target !== 'string' || !target || !Number.isInteger(portal?.x) || !Number.isInteger(portal?.y)) continue;
    const distance = Math.abs(portal.x - here.x) + Math.abs(portal.y - here.y);
    routes.push({
      id: String(portal.id || `${portal.x},${portal.y}`),
      label: String(portal.label || portal.name || 'Entrance'),
      target,
      x: portal.x,
      y: portal.y,
      distance,
      back: target === commons || (typeof home === 'string' && target === home),
      portal,
    });
  }
  routes.sort((a, b) => Number(b.back) - Number(a.back) || a.distance - b.distance || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  return Number.isFinite(limit) && limit >= 0 ? routes.slice(0, limit) : routes;
}

/** The plain-text role of a route, so a HUD button can name what it is without a second source. */
export function routeHint(route) {
  if (!route) return '';
  const tiles = `${route.distance} tile${route.distance === 1 ? '' : 's'}`;
  return route.back ? `${route.label} at ${route.x}, ${route.y} · the way back · ${tiles} away` : `${route.label} at ${route.x}, ${route.y} · ${tiles} away`;
}

// ---------------------------------------------------------------------------------------------
// Movement feedback. Every input outcome — the accepted step, the refused step and the reconcile
// after a refusal — has one wording, produced here from the server's own result, so the HUD can never
// describe a step the server did not take. `tone` is what the stylesheet colours.
// ---------------------------------------------------------------------------------------------

const tileAt = (point, fallback = 'the saved tile') => point && Number.isFinite(point.x) && Number.isFinite(point.y) ? `${Math.floor(point.x)}, ${Math.floor(point.y)}` : fallback;

/**
 * The readable result of one movement attempt.
 *   outcome 'step'     — the server stored a new tile: `Stepped up to 10, 5.`
 *   outcome 'blocked'  — the server refused the step and kept the stored tile
 *   outcome 'restored' — a failed request, reconciled to the stored tile, naming the server's message
 *   outcome 'travel'   — an arrival, carrying the caller's own sentence
 */
export function moveFeedback({ outcome = 'step', direction = '', from = null, to = null, cause = '', message = '' } = {}) {
  if (outcome === 'blocked') {
    const blocked = `The way ${direction} is blocked${cause ? ` by ${cause}` : ''}. Restored to ${tileAt(from)} — choose another direction.`;
    return { tone: 'refused', text: blocked };
  }
  if (outcome === 'restored') {
    const reason = String(message || '').trim();
    return { tone: 'restored', text: `${reason ? `${reason} ` : ''}Restored to ${tileAt(from)}.` };
  }
  if (outcome === 'travel') return { tone: 'travel', text: String(message || 'Arrived.') };
  return { tone: 'step', text: `Stepped ${direction} to ${tileAt(to)}.` };
}

/** The readable cause of a refused step, from the terrain and scenery the caller can name. */
export function blockedCause({ terrain = '', scenery = false, outside = false } = {}) {
  if (outside) return 'the edge of the world';
  if (scenery) return 'a solid object';
  const named = { water: 'water', tree: 'a tree', building: 'a building', wall: 'a wall', fountain: 'the fountain' };
  const type = typeof terrain === 'string' ? terrain.trim() : '';
  if (!type) return '';
  return named[type] || `the ${type.replaceAll('_', ' ')}`;
}

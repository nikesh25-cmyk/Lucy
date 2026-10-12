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

/** What a single key press asks for, or null when the key is not a control. */
export function keyIntent(key, { frontier = false, palette = [], agent = false } = {}) {
  if (frontier && agent && /^[1-7]$/.test(key)) {
    const type = palette[Number(key) - 1];
    return type ? { kind: 'build', type } : null;
  }
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
 * and which keys walk or turn. Text only, so the interface never injects markup.
 */
export function reticleText({ firstPerson = false, facing = {}, position = null, selection = null, blocked = null } = {}) {
  const parts = [];
  parts.push(firstPerson ? 'First person' : 'Orbiting view');
  parts.push(`facing ${facingLabel(facing.yaw)}`);
  if (Number.isInteger(position?.x) && Number.isInteger(position?.y)) parts.push(`at ${position.x}, ${position.y}${Number.isInteger(position?.z) ? `, layer ${position.z}` : ''}`);
  if (selection && Number.isInteger(selection.x) && Number.isInteger(selection.y)) {
    const kind = KINDS[selection.type] || 'tile';
    const detail = typeof blocked === 'boolean' ? blocked ? 'solid, walk around it' : 'walkable' : null;
    parts.push(`aimed at ${kind} ${selection.x}, ${selection.y}${selection.z ? `, layer ${selection.z}` : ''}${detail ? ` · ${detail}` : ''}`);
  } else parts.push('no tile picked yet');
  parts.push(firstPerson ? 'WASD walks the way you face · Q/E turn · R/F tilt · arrow keys also walk' : 'drag to orbit · click open ground to walk · arrow keys or WASD walk');
  return parts.join(' · ');
}

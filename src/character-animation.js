// Character animation and remote-movement interpolation.
//
// Every input is server-confirmed: the previous and next *confirmed* tile of one participant, the
// stored `posture`, and the stored `emote`/`emote_until` window. Nothing in this module invents a
// position, an action or a frame:
//
//   * the walk cycle is the interpolation *progress between two confirmed tiles*, quantised to the
//     four walk frames the sealed appearance sheets carry, so a walker is never drawn beyond the
//     newest confirmed tile and a walk pose is never shown for a participant that did not move;
//   * an expression is only ever the stored server value inside its stored expiry window;
//   * a refused move is reconciled by `reconcile(id)`, which snaps the display back to the stored
//     tile, and a jump (more than one tile, more than one elevation layer, or another world) snaps
//     instead of gliding, so a teleport is never drawn as a walk across unconfirmed tiles.
//
// This module has no dependency on the database, the DOM or the renderer, so the browser, the
// server and the tests import the same rules.

/** The longest glide between two confirmed tiles: just over the server's 120 ms step throttle. */
export const MOTION_TWEEN_MS = 180;
/** The four walk rows every sealed appearance sheet carries (`content/appearances/*.json`). */
export const WALK_FRAMES = 4;
/** The window `POST /api/v1/emotes` stores (`src/platform.js`: `clock() + 10000`). */
export const EXPRESSION_MS = 10_000;
/** The stance the server stores on `agents.posture` (`src/spaces.js#posture`). */
export const STANCES = Object.freeze(['standing', 'sitting', 'meditating']);
/** The confirmed expressions. `none` is the stored no-expression value, so it is not an animation. */
export const EXPRESSIONS = Object.freeze(['wave', 'bow', 'cheer', 'think', 'heart']);
/** The animation states this state machine can produce. */
export const ANIMATION_STATES = Object.freeze(['idle', 'walking', 'seated', 'interacting']);
/** The four cardinal facings, in the sealed `directions` order of the appearance sheets. */
export const FACINGS = Object.freeze(['down', 'up', 'left', 'right']);
/** How far the body drops when the server stores a seated stance (`src/voxel-world.js`). */
export const SEATED_LIFT = 0.26;
/** A leg swings this far along the direction of the confirmed step, at the peak walk frame. */
export const WALK_SWING = 0.09;

export const MOTION_LIMITS = Object.freeze({
  /** Tracked participants: the same 220-avatar bound the renderer draws (`VOXEL_LIMITS.participants`). */
  records: 220,
  /** A confirmed change larger than this is a jump: it snaps instead of gliding. */
  glide_tiles: 1,
  glide_layers: 1,
});

const CARDINAL = Object.freeze({ up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } });
const clamp01 = (value) => value < 0 ? 0 : value > 1 ? 1 : value;
const tile = (item) => ({ x: Number.isFinite(item?.x) ? item.x : 0, y: Number.isFinite(item?.y) ? item.y : 0, z: Number.isFinite(item?.z) ? item.z : 0 });

/** The unit grid step for a confirmed facing. */
export const facingStep = (facing) => CARDINAL[FACINGS.includes(facing) ? facing : 'down'];

/** The facing a confirmed payload stores: the direction of the confirmed step, else the stored yaw. */
export function confirmedFacing(item, step = null) {
  if (step && Number.isFinite(step.to?.x) && Number.isFinite(step.from?.x)) {
    const dx = step.to.x - step.from.x, dy = step.to.y - step.from.y;
    if (dx !== 0 || dy !== 0) {
      if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
      return dy > 0 ? 'down' : 'up';
    }
  }
  // The stored yaw, quantised: yaw 0 faces -y, and a quarter turn is 90 degrees (`firstPersonCamera`).
  const yaw = item?.yaw;
  if (!Number.isFinite(yaw)) return 'down';
  const quarter = Math.round((((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2)) % 4;
  return ['up', 'left', 'down', 'right'][quarter];
}

/**
 * The confirmed expression, or null. A payload whose `emote_until` is not a finite number in the
 * future (a missing column, a string, an expired window) is treated as no expression at all, so an
 * unknown or stale value can never animate.
 */
export function confirmedExpression(item, time = Date.now()) {
  const emote = typeof item?.emote === 'string' ? item.emote : null;
  if (!emote || !EXPRESSIONS.includes(emote)) return null;
  const until = item.emote_until;
  if (!Number.isFinite(until) || !Number.isFinite(time) || !(time < until)) return null;
  const elapsed = Math.max(0, EXPRESSION_MS - (until - time));
  // Two frames inside the confirmed window: the action, then a settled rest. No frame is invented
  // outside the window the server stored.
  return { action: emote, until, frame: elapsed < EXPRESSION_MS / 2 ? 0 : 1 };
}

/**
 * The one place a confirmed position becomes a drawn one. `position(id)` returns the display record:
 * the interpolation parameter `t` is clamped to [0,1], so `x/y/z` never pass the newest confirmed
 * tile, and they equal it exactly once the tween is over.
 */
export function createMotionTracker({ tweenMs = MOTION_TWEEN_MS, limit = MOTION_LIMITS.records, clock = () => Date.now() } = {}) {
  const records = new Map();
  const duration = Number.isFinite(tweenMs) && tweenMs > 0 ? tweenMs : MOTION_TWEEN_MS;
  const capacity = Number.isInteger(limit) && limit > 0 ? limit : MOTION_LIMITS.records;
  const now = typeof clock === 'function' ? clock : () => Date.now();
  let touched = 0;

  const snap = (record) => { record.from = { ...record.confirmed }; record.at = 0; record.duration = 0; };
  /** Keep the tracked set inside the participant bound: the least recently confirmed leaves first. */
  function trim() {
    if (records.size <= capacity) return records.size;
    const ordered = [...records.values()].sort((a, b) => a.touched - b.touched);
    for (const record of ordered.slice(0, records.size - capacity)) records.delete(record.id);
    return records.size;
  }
  /** A confirmed change too large to be one grid step: it is a jump, not a walk. */
  function jump(from, to) {
    const tiles = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    return tiles > MOTION_LIMITS.glide_tiles || Math.abs(to.z - from.z) > MOTION_LIMITS.glide_layers;
  }
  /** The display record of one tracked participant. `t` is clamped, so the drawn tile never passes
   *  the confirmed one, and the drawn value equals the confirmed one exactly once the tween is over. */
  function displayed(record, time) {
    const t = record.duration > 0 ? clamp01((time - record.at) / record.duration) : 1;
    const eased = t * t * (3 - 2 * t);
    return { id: record.id, x: record.from.x + (record.confirmed.x - record.from.x) * eased,
      y: record.from.y + (record.confirmed.y - record.from.y) * eased,
      z: record.from.z + (record.confirmed.z - record.from.z) * eased,
      t, walking: t < 1, from: { ...record.from }, to: { ...record.confirmed }, world: record.world };
  }

  return {
    /**
     * Remember one server-confirmed position. Returns `{ changed, snapped }`: `changed` is true when
     * the stored tile is new to this client, and `snapped` is true when a change was drawn on its
     * confirmed tile immediately instead of gliding — a jump, a world change, or the first sight.
     * A repeat of the stored tile returns `{ changed: false, snapped: false }` and leaves any tween
     * already in flight running, so a poll that repeats a position never cancels it.
     */
    confirm(item) {
      // A *confirmed* position is a whole stored tile: a fractional or unplaced value is refused
      // rather than tracked, so no caller can seed a position the server never stored.
      if (!item || typeof item.id !== 'string' || !Number.isInteger(item.x) || !Number.isInteger(item.y)) return { changed: false, snapped: false };
      const target = tile(item), world = typeof item.world_id === 'string' ? item.world_id : null, known = records.get(item.id);
      touched += 1;
      if (!known) {
        const record = { id: item.id, world, confirmed: target, from: { ...target }, at: 0, duration: 0, touched };
        records.set(item.id, record); trim();
        return { changed: true, snapped: true };
      }
      const moved = known.confirmed.x !== target.x || known.confirmed.y !== target.y || known.confirmed.z !== target.z;
      const elsewhere = Boolean(known.world && world && known.world !== world);
      known.world = world || known.world; known.touched = touched;
      // A poll that repeats the stored tile confirms nothing and — importantly — does not cancel a
      // tween already in flight: the server repeats a position every poll while the avatar glides.
      if (!moved && !elsewhere) return { changed: false, snapped: false };
      const snapNow = elsewhere || jump(known.confirmed, target);
      // Read where the avatar is drawn now, before the new confirmed tile replaces the old one: a
      // tween starts from the current display, so a second step never jumps back to a stale tile.
      const current = displayed(known, now());
      known.confirmed = target;
      if (snapNow) snap(known);
      else {
        known.from = { x: current.x, y: current.y, z: current.z };
        known.at = now(); known.duration = duration;
      }
      return { changed: true, snapped: snapNow };
    },
    /** The display record of one participant, or null when it is not tracked. */
    position(id, time = now()) {
      const record = records.get(typeof id === 'string' ? id : id?.id);
      return record ? displayed(record, time) : null;
    },
    /** The participant drawn where the interpolation currently places it; the record is unchanged. */
    display(item, time = now()) {
      const record = records.get(item?.id);
      if (!record) return item;
      const shown = displayed(record, time);
      return { ...item, x: shown.x, y: shown.y, z: shown.z };
    },
    /** Drop the tween and draw on the stored tile: the reconciliation for a refused move. */
    reconcile(id) {
      const record = records.get(typeof id === 'string' ? id : id?.id);
      if (!record) return false;
      snap(record); return true;
    },
    isSettling(time = now()) {
      for (const record of records.values()) if (record.duration > 0 && record.at + record.duration > time) return true;
      return false;
    },
    entries() { return [...records.values()].map((record) => displayed(record, now())); },
    get size() { return records.size; },
    clear() { records.clear(); },
  };
}

/**
 * The confirmed animation state of one participant. The state is decided only by the stored stance,
 * the stored expression window and whether the display is currently between two confirmed tiles.
 */
export function characterState(item, { tracker = null, time = Date.now(), animated = true } = {}) {
  const id = typeof item?.id === 'string' ? item.id : null;
  const step = tracker && id ? tracker.position(id, time) : null;
  const stored = tile(item);
  const shown = step ? { x: step.x, y: step.y, z: step.z } : stored;
  const stance = STANCES.includes(item?.posture) ? item.posture : 'standing';
  const expression = confirmedExpression(item, time);
  const moved = Boolean(step) && (step.from.x !== step.to.x || step.from.y !== step.to.y);
  const walking = Boolean(step?.walking) && moved && animated === true;
  const state = stance !== 'standing' ? 'seated' : expression ? 'interacting' : walking ? 'walking' : 'idle';
  const facing = confirmedFacing(item, step);
  return Object.freeze({
    id, kind: typeof item?.kind === 'string' ? item.kind : null, state, stance,
    action: state === 'interacting' ? expression.action : null,
    expressionFrame: state === 'interacting' ? expression.frame : 0,
    walking, phase: state === 'walking' ? Math.min(WALK_FRAMES - 1, Math.floor(step.t * WALK_FRAMES)) : 0,
    facing, direction: facingStep(facing),
    position: Object.freeze({ ...shown }), confirmed: Object.freeze({ ...stored }), elevation: shown.z,
    t: step ? step.t : 1,
  });
}

const WALK_SWING_FRAMES = Object.freeze([1, 0, -1, 0]);
const EXPRESSION_ARMS = Object.freeze({
  wave: Object.freeze({ left: 'down', right: 'up' }),
  cheer: Object.freeze({ left: 'up', right: 'up' }),
  think: Object.freeze({ left: 'down', right: 'head' }),
  bow: Object.freeze({ left: 'down', right: 'down' }),
  heart: Object.freeze({ left: 'forward', right: 'forward' }),
});
/** An expression that leans: the torso and head shift along the stored facing. */
const EXPRESSION_LEAN = Object.freeze({ bow: 1 });

/**
 * The pose the body is drawn in. Every number is derived from the confirmed state above: a seated
 * stance uses the stored posture, an expression uses its stored window, and the only free number is
 * the walk frame, which is the quantised progress between the two confirmed tiles.
 */
export function characterPose(state) {
  const seated = state.state === 'seated';
  const swing = state.state === 'walking' ? WALK_SWING_FRAMES[state.phase] : 0;
  const action = state.state === 'interacting' && state.expressionFrame === 0 ? EXPRESSION_ARMS[state.action] : null;
  return Object.freeze({
    state: state.state, phase: state.phase, seated,
    lift: seated ? -SEATED_LIFT : 0, legDepth: seated ? 0.25 : 0.4, swing,
    arm: Object.freeze({ left: action?.left || 'down', right: action?.right || 'down' }),
    lean: state.state === 'interacting' && state.expressionFrame === 0 ? EXPRESSION_LEAN[state.action] || 0 : 0,
  });
}

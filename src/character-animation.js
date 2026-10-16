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
// **The animation vocabulary is the *pose* vocabulary.** `src/platform.js` seals exactly five stored
// `emote` values plus `none`, so no module on this side of the API can add a sixth name. What this
// module grows instead is the number of authored poses behind each confirmed value: every stored
// expression now plays four staged frames inside its own ten-second window — an anticipation, the
// action, the held action and the rest — and every stance and stride frame is a named pose. There is
// still no free-running clock: a pose is a pure, bounded function of the stored stance, the stored
// expression window, the quantised interpolation progress and the `reducedMotion` flag.
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
/** A stride also dips and rocks the body: the amplitude of the walk's bob, in metres. */
export const WALK_BOB = 0.022;
/** ...and the amplitude of its lateral sway, in metres. Both are functions of the walk frame only. */
export const WALK_SWAY = 0.014;
/** The staged frames one stored expression draws inside its window. */
export const EXPRESSION_FRAMES = 4;
/** Where each staged frame begins, as a fraction of the stored window. */
export const EXPRESSION_FRAME_AT = Object.freeze([0, 0.1, 0.55, 0.78]);
/** The single frame a reduced-motion draw holds: the action itself, still, never an anticipation. */
export const EXPRESSION_ACTION_FRAME = 1;

export const MOTION_LIMITS = Object.freeze({
  /** Tracked participants: the same 220-avatar bound the renderer draws (`VOXEL_LIMITS.participants`). */
  records: 220,
  /** A confirmed change larger than this is a jump: it snaps instead of gliding. */
  glide_tiles: 1,
  glide_layers: 1,
});

const CARDINAL = Object.freeze({ up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } });
const clamp01 = (value) => value < 0 ? 0 : value > 1 ? 1 : value;
const tile = (item) => ({ x: Number.isFinite(item?.x) ? item.x : 0, y: Number.isFinite(item?.y) ? item.y : 0, z: Number.isInteger(item?.z) ? item.z : 0 });

/** The unit grid step for a confirmed facing. */
export const facingStep = (facing) => CARDINAL[FACINGS.includes(facing) ? facing : 'down'];

/**
 * The body frame of one confirmed facing, in the renderer's own axes: `forward` is the direction of
 * the confirmed step and `across` is the perpendicular, so a body can be authored once in its own
 * frame and turned without restating a single coordinate. `swap` reports that a box's across and
 * forward extents exchange the world x and z axes.
 */
export const facingFrame = (facing) => {
  const step = facingStep(facing);
  return Object.freeze({
    forward: Object.freeze({ x: step.x, y: step.y }),
    across: Object.freeze({ x: step.y, y: step.x === 0 ? 0 : -step.x }),
    swap: step.x !== 0,
  });
};

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

/** The staged frame inside a stored expression window, from the fraction of that window elapsed. */
export const expressionFrameAt = (progress) => {
  if (!Number.isFinite(progress)) return 0;
  let frame = 0;
  for (let index = 0; index < EXPRESSION_FRAME_AT.length; index += 1) if (progress >= EXPRESSION_FRAME_AT[index]) frame = index;
  return frame;
};

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
  // Four staged frames inside the confirmed window: the anticipation, the action, its hold, then the
  // rest. No frame is invented outside the window the server stored.
  return { action: emote, until, frame: expressionFrameAt(elapsed / EXPRESSION_MS) };
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
      if (!item || typeof item.id !== 'string' || !Number.isInteger(item.x) || !Number.isInteger(item.y) || (item.z !== undefined && !Number.isInteger(item.z))) return { changed: false, snapped: false };
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
 *
 * `reducedMotion: true` is the presentation half of `prefers-reduced-motion`: the drawn position is
 * the **confirmed** tile rather than the gliding one (so it snaps rather than slides), the walk is at
 * rest, and a stored expression holds its single action frame for the whole window instead of playing
 * four. The renderer already reconciles every confirmed step under the same preference; this option
 * is the module's own contract for a caller that drives it directly.
 */
export function characterState(item, { tracker = null, time = Date.now(), animated = true, reducedMotion = false } = {}) {
  const id = typeof item?.id === 'string' ? item.id : null;
  const still = reducedMotion === true;
  const step = tracker && id ? tracker.position(id, time) : null;
  const stored = tile(item);
  const shown = still ? stored : step ? { x: step.x, y: step.y, z: step.z } : stored;
  const stance = STANCES.includes(item?.posture) ? item.posture : 'standing';
  const expression = confirmedExpression(item, time);
  const moved = Boolean(step) && (step.from.x !== step.to.x || step.from.y !== step.to.y);
  const walking = !still && Boolean(step?.walking) && moved && animated === true;
  const state = stance !== 'standing' ? 'seated' : expression ? 'interacting' : walking ? 'walking' : 'idle';
  const facing = confirmedFacing(item, step);
  const expressionFrame = !expression ? 0 : still ? EXPRESSION_ACTION_FRAME : expression.frame;
  return Object.freeze({
    id, kind: typeof item?.kind === 'string' ? item.kind : null, state, stance,
    action: state === 'interacting' ? expression.action : null,
    expressionFrame: state === 'interacting' ? expressionFrame : 0,
    walking, phase: state === 'walking' ? Math.min(WALK_FRAMES - 1, Math.floor(step.t * WALK_FRAMES)) : 0,
    facing, direction: facingStep(facing), frame: facingFrame(facing),
    position: Object.freeze({ ...shown }), confirmed: Object.freeze({ ...stored }), elevation: shown.z,
    t: still ? 1 : step ? step.t : 1,
    reducedMotion: still,
  });
}

const WALK_SWING_FRAMES = Object.freeze([1, 0, -1, 0]);
const WALK_BOB_FRAMES = Object.freeze([0, 1, 0, 1]);
const WALK_SWAY_FRAMES = Object.freeze([0, 1, 0, -1]);

/**
 * The four staged frames of every stored expression, as the arm poses, body lean and dip each one
 * draws. The vocabulary the renderer can name is therefore the authored pose table below, not the
 * five stored values: each stored value is one *sequence* of four poses.
 *
 * `dip` lowers the body. No frame raises it: the tallest draw of any confirmed state is the neutral
 * standing body, so a pose can never pass the head the footprint table measures.
 */
const EXPRESSION_FRAMES_POSES = Object.freeze({
  wave: Object.freeze([Object.freeze({ right: 'rise' }), Object.freeze({ right: 'up' }),
    Object.freeze({ right: 'up', dip: .02 }), Object.freeze({})]),
  cheer: Object.freeze([Object.freeze({ left: 'rise', right: 'rise', dip: .02 }),
    Object.freeze({ left: 'up', right: 'up', dip: .06 }), Object.freeze({ left: 'up', right: 'up', dip: .04 }),
    Object.freeze({})]),
  think: Object.freeze([Object.freeze({ right: 'rise' }), Object.freeze({ right: 'head', lean: .12 }),
    Object.freeze({ right: 'head', lean: .06 }), Object.freeze({})]),
  heart: Object.freeze([Object.freeze({ left: 'out', right: 'out' }),
    Object.freeze({ left: 'forward', right: 'forward' }), Object.freeze({ left: 'forward', right: 'forward', dip: .03 }),
    Object.freeze({})]),
  bow: Object.freeze([Object.freeze({ lean: .35 }), Object.freeze({ lean: 1 }),
    Object.freeze({ lean: .8 }), Object.freeze({})]),
});
const EMPTY_FRAME = Object.freeze({});
/** An expression that leans: the torso and head shift along the stored facing. */
export const LEANING_EXPRESSIONS = Object.freeze(['bow', 'think']);

/**
 * The two confirmed seated stances, as the pose each one folds the body into. Both drop the upper
 * body by exactly `SEATED_LIFT`; they differ in how the legs and hands are placed, so `sitting` and
 * `meditating` are two readable poses rather than one shared number.
 */
const SEATED_POSES = Object.freeze({
  sitting: Object.freeze({ legDepth: .34, legForward: .16, legAcross: 0, footForward: .30, footAcross: 0, arms: Object.freeze({ left: 'lap', right: 'lap' }) }),
  meditating: Object.freeze({ legDepth: .30, legForward: .04, legAcross: .07, footForward: .10, footAcross: .08, arms: Object.freeze({ left: 'clasp', right: 'clasp' }) }),
});

/**
 * The pose the body is drawn in. Every number is derived from the confirmed state above: a seated
 * stance uses the stored posture, an expression uses its stored window and staged frame, and the only
 * free numbers are the walk frame — the quantised progress between the two confirmed tiles — and the
 * `reducedMotion` flag, which snaps both to rest. Every term is a lower: `lift` is never positive, so
 * no pose can draw a body taller than its own standing head.
 */
export function characterPose(state) {
  const seated = state.state === 'seated';
  const stance = seated ? SEATED_POSES[state.stance] || SEATED_POSES.sitting : null;
  const walking = state.state === 'walking';
  const acting = state.state === 'interacting';
  const frame = acting ? EXPRESSION_FRAMES_POSES[state.action]?.[state.expressionFrame] || EMPTY_FRAME : EMPTY_FRAME;
  return Object.freeze({
    state: state.state, stance: state.stance, phase: state.phase, seated,
    lift: (seated ? -SEATED_LIFT : 0) - (walking ? WALK_BOB * WALK_BOB_FRAMES[state.phase] : 0) - (frame.dip || 0),
    legDepth: stance ? stance.legDepth : 0.62,
    legForward: stance ? stance.legForward : 0,
    legAcross: stance ? stance.legAcross : 0,
    footForward: stance ? stance.footForward : 0.05,
    footAcross: stance ? stance.footAcross : 0,
    swing: walking ? WALK_SWING_FRAMES[state.phase] : 0,
    sway: walking ? WALK_SWAY * WALK_SWAY_FRAMES[state.phase] : 0,
    arm: Object.freeze(stance ? { ...stance.arms } : { left: frame.left || 'down', right: frame.right || 'down' }),
    lean: acting ? frame.lean || 0 : 0,
  });
}

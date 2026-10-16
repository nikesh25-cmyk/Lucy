// Game input for the world: two camera modes, mouse look with pointer capture, movement,
// interaction and building, all routed as intents.
//
// The client never authors a position. A `move` intent carries one cardinal direction (view-relative
// in first person) and nothing else; a `look` intent carries an absolute facing for the server to
// store; an `interact` or `build` intent names a fixture action, never an outcome. The shell turns an
// intent into the shipped server call (`POST /move`, `POST /agents/:id/look`, `POST /interact`,
// `POST /frontier/build`). No intent ever carries an x, y or z that the client invented — a picked
// tile comes from the renderer's raycast through the injected `pickAt`, not from this module.
//
// Everything the module needs from its host is injected — the DOM, the clock and timers, the world
// context, the third-person view blocker and the output sink — so a UI module consumes the returned
// interface without importing this file. The wiring steps are in docs/handoff/task-33-camera-controls.md
// and the key map is in docs/CONTROLS.md.
import {
  CAMERA_MODES, DEFAULT_CAMERA_MODE, CAMERA_TOGGLE_KEYS, BOOM_LENGTH,
  INTERACTION_KEY_LABEL, CONTROL_HINTS, SUSPEND_REASONS,
  normalizeCameraMode, cameraView, wrapYaw, clampPitch,
  createSuspension, createLookScheduler, pointerGesture,
  keyIntent, controlIntent, shortcutSuspended,
} from './camera-controls.js';

export { CAMERA_MODES, DEFAULT_CAMERA_MODE, CAMERA_TOGGLE_KEYS, INTERACTION_KEY_LABEL, CONTROL_HINTS, SUSPEND_REASONS };

/** Every intent the module emits. `capture` reports pointer-capture state; `pick` a resolved tile. */
export const INTENT_KINDS = Object.freeze(['move', 'look', 'interact', 'build', 'camera', 'capture', 'pick', 'cancel']);
export const LOOK_STEP = .35;                       // radians per keyboard turn or tilt, matching app.js lookStep
export const DRAG_YAW = .008, DRAG_PITCH = .006;    // radians per pixel, matching src/voxel-geometry.js
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const noop = () => {};

/**
 * The one input controller. Dependencies, all optional but explicit:
 *   document         — the DOM adapter (a private window or an absent DOM still works)
 *   target           — the element that owns pointer capture (the world canvas)
 *   clock/schedule/cancel/lookDelay — the look coalescer's time source
 *   onIntent         — the single output; every intent goes through it
 *   blocksView       — (x, y, layer) => boolean, the third-person boom's occupancy test
 *   boomLength       — shoulder distance in tiles
 *   worldContext     — () => { frontier, palette, agent, fixture, building, lookMode }
 *   pickAt           — ({clientX, clientY, pointerId}) => selection | null, the renderer's raycast
 *   isSuspended      — () => boolean, the shell's own menu/drawer state
 */
export function createGameInput({
  document: doc = globalThis.document ?? null,
  target = null,
  clock = () => Date.now(),
  schedule = (run, delay) => setTimeout(run, delay),
  cancel = (id) => clearTimeout(id),
  lookDelay = 150,
  onIntent = noop,
  blocksView = () => false,
  boomLength = BOOM_LENGTH,
  worldContext = () => ({}),
  pickAt = null,
  isSuspended = () => false,
} = {}) {
  if (typeof onIntent !== 'function') throw new TypeError('createGameInput needs an onIntent sink.');
  if (typeof blocksView !== 'function') throw new TypeError('createGameInput needs a blocksView predicate.');
  if (typeof worldContext !== 'function') throw new TypeError('createGameInput needs a worldContext provider.');

  const suspension = createSuspension();
  let mode = DEFAULT_CAMERA_MODE;
  let facing = { yaw: Math.PI / 4, pitch: 0 };
  let position = { x: 0, y: 0, z: 0 };
  let selection = null;
  let captureId = null, drag = null, listeners = [];
  const lookScheduler = createLookScheduler({
    send: () => emit({ kind: 'look', yaw: facing.yaw, pitch: facing.pitch }),
    now: clock, schedule, cancel, delay: lookDelay,
  });

  const emit = (intent) => { onIntent(intent); return intent; };

  // One look owner: a burst of drag or turn events coalesces into one `look` intent per window, and
  // the intent is the caller's own facing state, so a look can never become a movement.
  function requestLook(yaw, pitch) {
    facing = { yaw: wrapYaw(yaw), pitch: clampPitch(pitch) };
    lookScheduler.request();
    return { kind: 'look', yaw: facing.yaw, pitch: facing.pitch };
  }

  function stepLook(direction) {
    const { yaw, pitch } = facing;
    if (direction === 'left') return requestLook(yaw + LOOK_STEP, pitch);
    if (direction === 'right') return requestLook(yaw - LOOK_STEP, pitch);
    if (direction === 'up') return requestLook(yaw, pitch - LOOK_STEP);
    return requestLook(yaw, pitch + LOOK_STEP);
  }

  // Typing, a focused control, an open dialog, a held modifier or the shell's own reason: any of
  // these suspends the gameplay shortcuts, and the key is left untouched for the focused element.
  function blocked(context = {}) {
    if (suspension.suspended || isSuspended()) return true;
    const active = doc?.activeElement || null;
    return shortcutSuspended({
      tagName: context.tagName ?? active?.tagName ?? '',
      isContentEditable: context.isContentEditable ?? Boolean(active?.isContentEditable),
      dialogOpen: context.dialogOpen ?? Boolean(doc?.querySelector?.('dialog[open]')),
      modifier: Boolean(context.ctrlKey || context.metaKey || context.altKey),
    });
  }
  const dialogOpen = (context = {}) => context.dialogOpen ?? Boolean(doc?.querySelector?.('dialog[open]'));

  function setCameraMode(next, { silent = false } = {}) {
    const normalized = normalizeCameraMode(next);
    if (normalized === mode) return mode;
    mode = normalized;
    lookScheduler.cancel();
    if (!silent) emit({ kind: 'camera', mode });
    return mode;
  }
  const toggleCameraMode = () => setCameraMode(mode === 'first-person' ? 'third-person' : 'first-person');

  /** One key press as an intent, or null when the key is not a control or shortcuts are suspended. */
  function press(key, event = {}) {
    const context = { ...worldContext(), ...event };
    if (key === 'Escape') {
      if (dialogOpen(context)) return null;      // an open dialog owns its own Escape
      return escape() ? { kind: 'cancel', reason: 'escape' } : null;
    }
    if (blocked(context)) return null;
    const intent = keyIntent(key, {
      frontier: Boolean(context.frontier), palette: Array.isArray(context.palette) ? context.palette : [],
      agent: Boolean(context.agent), fixture: Boolean(context.fixture), building: Boolean(context.building),
      camera: Boolean(context.agent),
    });
    if (!intent) return null;
    if (intent.kind === 'camera') { toggleCameraMode(); return { kind: 'camera', mode }; }
    if (intent.kind === 'turn') return requestLook(facing.yaw + intent.yaw, facing.pitch + intent.pitch);
    if (intent.kind === 'interact') return emit({ kind: 'interact' });
    if (intent.kind === 'build') return emit({ kind: 'build', type: intent.type });
    const move = controlIntent(intent.direction, {
      firstPerson: mode === 'first-person', yaw: facing.yaw, lookMode: Boolean(context.lookMode), keyboard: true,
    });
    return move.kind === 'look' ? stepLook(move.turn) : emit({ kind: 'move', direction: move.direction });
  }

  function lookBy(deltaYaw = 0, deltaPitch = 0) {
    return requestLook(facing.yaw + (Number.isFinite(deltaYaw) ? deltaYaw : 0), facing.pitch + (Number.isFinite(deltaPitch) ? deltaPitch : 0));
  }

  // ---- pointer capture and mouse look ---------------------------------------------------------
  function capture(pointerId) {
    if (pointerId === null || pointerId === undefined) return null;
    captureId = pointerId;
    try { target?.setPointerCapture?.(pointerId); } catch { /* a pointer already gone cannot be captured */ }
    return captureId;
  }
  function releaseCapture(reason = 'release') {
    lookScheduler.cancel();
    const id = captureId, had = id !== null || drag !== null;
    captureId = null; drag = null;
    if (id !== null) { try { target?.releasePointerCapture?.(id); } catch { /* it was not captured */ } }
    if (had) emit({ kind: 'capture', captured: false, reason });
    return had;
  }
  function lock() {
    if (typeof target?.requestPointerLock !== 'function') return false;
    try { target.requestPointerLock(); } catch { return false; }
    return true;
  }
  function unlock() {
    if (typeof doc?.exitPointerLock !== 'function') return false;
    const locked = Boolean(doc.pointerLockElement && doc.pointerLockElement === target);
    try { doc.exitPointerLock(); } catch { /* already released */ }
    return locked;
  }
  function pointerLockChange() {
    const locked = Boolean(doc?.pointerLockElement && doc.pointerLockElement === target);
    if (!locked) { captureId = null; drag = null; lookScheduler.cancel(); }
    emit({ kind: 'capture', captured: locked, reason: 'pointerlock' });
    return locked;
  }
  /** Escape is the one key that always works: it releases capture and pointer lock. */
  function escape() { const releasedCapture = releaseCapture('escape'); const releasedLock = unlock(); return releasedCapture || releasedLock; }

  function pointerDown(event = {}) {
    if (event.button !== undefined && event.button !== 0) return null;
    if (suspension.suspended || isSuspended()) return null;
    const id = event.pointerId ?? null;
    drag = { pointerId: id, x: finite(event.clientX, 0), y: finite(event.clientY, 0), distance: 0 };
    if (id !== null) capture(id);
    return { gesture: 'down', captured: captureId };
  }
  function pointerMove(event = {}) {
    if (!drag) return null;
    if (suspension.suspended || isSuspended()) return null;
    if (event.pointerId !== undefined && event.pointerId !== drag.pointerId) return null;
    const x = finite(event.clientX, drag.x), y = finite(event.clientY, drag.y), dx = x - drag.x, dy = y - drag.y;
    drag.distance += Math.abs(dx) + Math.abs(dy);
    drag.x = x; drag.y = y;
    if (pointerGesture(drag.distance) !== 'look') return { gesture: 'pick', distance: drag.distance };
    requestLook(facing.yaw - dx * DRAG_YAW, facing.pitch + dy * DRAG_PITCH);
    return { gesture: 'look', distance: drag.distance };
  }
  function pointerUp(event = {}) {
    if (!drag) return null;
    if (event.pointerId !== undefined && event.pointerId !== drag.pointerId) return null;
    const gesture = pointerGesture(drag.distance);
    const point = { clientX: finite(event.clientX, drag.x), clientY: finite(event.clientY, drag.y), pointerId: event.pointerId ?? drag.pointerId };
    releaseCapture('pointerup');
    if (gesture !== 'pick') return { gesture };
    const picked = typeof pickAt === 'function' ? pickAt(point) : null;
    emit({ kind: 'pick', selection: picked ?? null });
    return { gesture, selection: picked ?? null };
  }
  function pointerCancel() { const had = releaseCapture('cancel'); return { gesture: 'cancel', released: had }; }

  // ---- DOM wiring -----------------------------------------------------------------------------
  function keyEvent(event) {
    return {
      tagName: event?.target?.tagName, isContentEditable: event?.target?.isContentEditable,
      ctrlKey: event?.ctrlKey, metaKey: event?.metaKey, altKey: event?.altKey, repeat: event?.repeat,
    };
  }
  function attach(node = target, { keys = true, pointer = true } = {}) {
    const bind = (host, name, handler) => { if (!host?.addEventListener) return; host.addEventListener(name, handler); listeners.push([host, name, handler]); };
    if (pointer) {
      bind(node, 'pointerdown', pointerDown);
      bind(node, 'pointermove', pointerMove);
      bind(node, 'pointerup', pointerUp);
      bind(node, 'pointercancel', pointerCancel);
      bind(node, 'lostpointercapture', () => { captureId = null; drag = null; });
    }
    if (keys) bind(doc ?? node, 'keydown', (event) => { if (press(event.key, keyEvent(event)) && event.preventDefault) event.preventDefault(); });
    bind(doc, 'pointerlockchange', pointerLockChange);
    return detach;
  }
  function detach() {
    for (const [host, name, handler] of listeners) host.removeEventListener?.(name, handler);
    const count = listeners.length; listeners = [];
    return count;
  }

  return {
    attach, detach,
    get cameraMode() { return mode; },
    setCameraMode, toggleCameraMode,
    get facing() { return { ...facing }; },
    /** The shell restores the server's stored facing here; the module never invents one. */
    setFacing(next = {}) { facing = { yaw: wrapYaw(next.yaw ?? facing.yaw), pitch: clampPitch(next.pitch ?? facing.pitch) }; lookScheduler.cancel(); return { ...facing }; },
    get position() { return { ...position }; },
    /** The shell writes the server's stored position here; the module never authors a position. */
    setPosition(next = {}) { position = { x: finite(next.x, position.x), y: finite(next.y, position.y), z: finite(next.z, position.z) }; return { ...position }; },
    get selection() { return selection ? { ...selection } : null; },
    setSelection(next) { selection = next && Number.isInteger(next.x) && Number.isInteger(next.y) ? { ...next } : null; return selection ? { ...selection } : null; },
    view(overrides = {}) { return cameraView(overrides.position || position, overrides.facing || facing, { mode, boomLength, blocksView }); },
    press, lookBy, escape, lock, unlock,
    pointerDown, pointerMove, pointerUp, pointerCancel, pointerLockChange,
    get captured() { return captureId !== null; },
    get captureId() { return captureId; },
    get dragging() { return drag !== null; },
    get suspended() { return suspension.suspended || Boolean(isSuspended()); },
    get suspendReasons() { return suspension.reasons; },
    suspend(reason = 'custom') { const size = suspension.suspend(reason); lookScheduler.cancel(); return size; },
    resume(reason = 'custom') { return suspension.resume(reason); },
    resumeAll() { return suspension.resumeAll(); },
    get pendingLook() { return lookScheduler.pending; },
  };
}

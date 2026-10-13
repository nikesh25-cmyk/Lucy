// Touch controls for small screens: an on-screen movement pad, a camera drag surface and
// interaction/build affordances a coarse pointer can reach.
//
// Three properties this module is built around.
//
//   1. It assumes nothing beyond "a pointer can press a real button". Every control is a labelled
//      <button> inside a named group, so a finger, a keyboard, a screen reader and a switch all
//      reach it, and no control is revealed by hovering. The camera drag is a path gesture, so a
//      single-pointer alternative (Look left / Look right) is rendered beside it — WCAG 2.2
//      SC 2.5.1 asks for exactly that — and the drag itself is plain Pointer Events, which cover
//      touch, pen and mouse without a second set of listeners that could double-fire.
//   2. It decides no world rule. Every gesture is an intent handed to the injected input interface;
//      this file imports no camera or input module, so it cannot drift from them and the
//      integration owner maps each intent onto the shipped controls (see docs/MOBILE_ACCESSIBILITY.md).
//   3. Nothing essential is carried by motion. State is text (aria-pressed, disabled, and a polite
//      live region), the stylesheet suppresses every transition under prefers-reduced-motion, and
//      this module also adds `nm-touch-reduced` so an integration owner whose surface does not
//      honour the media query can suppress the same transitions from its own stylesheet.
//
// The injected input interface (only `walk` is required; a missing member simply disables the
// control that would use it, and nothing else changes):
//
//   walk(direction)         one grid step: 'up' | 'left' | 'down' | 'right'
//   look({ yaw, pitch })    a *relative* camera rotation in radians, positive yaw turning left
//   pick({ x, y })          a tap that never became a drag, in client pixels
//   interact()              use the fixture the aim line names
//   build()                 enter the build control, or leave it
//   affordance(name)        'chat' | 'tools' — an existing world drawer

/** The project's target convention (nemo-theme.css). Measured at 44 px in game-mobile.css. */
export const TOUCH_TARGET_MIN = 44;
/** A gesture longer than this is a camera drag; a shorter one is a tap. */
export const DRAG_THRESHOLD = 6;
/** Radians per pixel dragged. The signs agree with the shipped Look buttons and R/F tilt keys. */
export const LOOK_PER_PIXEL = 0.006;
export const PITCH_PER_PIXEL = 0.004;
/** The tilt the renderer already clamps to (app.js `clampFacing`), so a drag cannot exceed it. */
export const MAX_PITCH = 1.4;
/** One press of the single-pointer camera alternative: the shipped Look step (`app.js`). */
export const LOOK_STEP = 0.35;
/** How long a pad key is held before it repeats, and how often. The repeat is above the server's
 *  120 ms step throttle, so a held key cannot outrun the world. */
export const HOLD_DELAY_MS = 320;
export const HOLD_REPEAT_MS = 160;
/** A stuck gesture stops rather than walking forever: 60 repeats is about ten seconds of holding. */
export const HOLD_LIMIT = 60;
/** A click arriving this soon after a pointerdown on the same key belongs to that press. */
export const CLICK_SUPPRESS_MS = 700;

export const PAD_DIRECTIONS = Object.freeze(['up', 'left', 'down', 'right']);
export const PAD_GLYPHS = Object.freeze({ up: '↑', left: '←', down: '↓', right: '→' });
/** The single-pointer alternative to the drag, in the two directions a view can turn. */
export const LOOK_BUTTONS = Object.freeze(['left', 'right']);
/** The world actions a touch screen needs beside movement: the five HUD actions, less Places. */
export const AFFORDANCES = Object.freeze([
  Object.freeze({ name: 'interact', glyph: 'Use', hint: 'Use the place or object the aim line names' }),
  Object.freeze({ name: 'build', glyph: 'Build', hint: 'Build here, or leave build mode' }),
  Object.freeze({ name: 'chat', glyph: 'Chat', hint: 'Open the conversation drawer' }),
  Object.freeze({ name: 'tools', glyph: 'More', hint: 'Open the tools drawer' }),
]);

/** A relative camera rotation from a drag, clamped to the tilt the renderer accepts. */
export function lookFromDrag(dx, dy, { yawPerPixel = LOOK_PER_PIXEL, pitchPerPixel = PITCH_PER_PIXEL, maxPitch = MAX_PITCH } = {}) {
  const x = Number.isFinite(dx) ? dx : 0;
  const y = Number.isFinite(dy) ? dy : 0;
  // `+ 0` keeps a still axis at positive zero: a rotation of -0 is not a rotation.
  return { yaw: -x * yawPerPixel + 0, pitch: Math.max(-maxPitch, Math.min(maxPitch, y * pitchPerPixel)) + 0 };
}

/** A button a keyboard or a switch activated sends no pointerdown, so its click is the press. */
export function isKeyboardActivation(event) {
  return Number(event?.detail ?? 0) === 0;
}

/** The single-pointer or multi-pointer gesture a measured distance resolves to. */
export function gestureFor(distance) {
  return Number.isFinite(distance) && distance > DRAG_THRESHOLD ? 'look' : 'pick';
}

function affordanceAvailable(name, input, fixture) {
  if (name === 'interact') return typeof input.interact === 'function' && Boolean(fixture);
  if (name === 'build') return typeof input.build === 'function';
  return typeof input.affordance === 'function';
}

/**
 * The whole control surface as data: what is rendered, what each control says, and whether it is
 * usable right now. Kept separate from the DOM so the contract can be asserted without a browser.
 */
export function touchModel({ input = {}, canWalk = true, fixture = false, building = false } = {}) {
  const directions = PAD_DIRECTIONS.map((name) => Object.freeze({
    name,
    group: 'movement',
    text: PAD_GLYPHS[name],
    label: `Move ${name}`,
    enabled: typeof input.walk === 'function' && Boolean(canWalk),
  }));
  const camera = LOOK_BUTTONS.map((turn) => Object.freeze({
    name: `look-${turn}`,
    group: 'camera',
    text: `Look ${turn}`,
    label: `Turn the camera ${turn}`,
    enabled: typeof input.look === 'function',
  }));
  const affordances = AFFORDANCES.map((item) => Object.freeze({
    name: item.name,
    group: 'actions',
    text: item.name === 'build' && building ? 'Finish' : item.glyph,
    label: item.hint,
    enabled: affordanceAvailable(item.name, input, fixture),
  }));
  return Object.freeze({ directions: Object.freeze(directions), camera: Object.freeze(camera), affordances: Object.freeze(affordances) });
}

/** `prefers-reduced-motion`, read through an injected matchMedia so it can be tested. */
export function prefersReducedMotion(match) {
  if (typeof match !== 'function') return false;
  try { return Boolean(match('(prefers-reduced-motion: reduce)')?.matches); } catch { return false; }
}

/** `(pointer: coarse)`: the integration owner's cue to mount these controls. */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';
export function hasCoarsePointer(match) {
  if (typeof match !== 'function') return false;
  try { return Boolean(match(COARSE_POINTER_QUERY)?.matches); } catch { return false; }
}

function toggleClass(node, name, on) {
  if (node.classList?.toggle) return node.classList.toggle(name, Boolean(on));
  const names = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
  if (on) names.add(name); else names.delete(name);
  node.className = [...names].join(' ');
}

/**
 * Render the controls into `mount`, and wire the injected `input` interface to them.
 *
 * `surface` is the element the camera drag listens on (normally the world canvas). A missing
 * surface renders everything else and leaves dragging unavailable; the Look buttons remain.
 */
export function createTouchControls({
  document: doc,
  mount,
  surface = null,
  input = {},
  canWalk = () => true,
  hasFixture = () => false,
  isBuilding = () => false,
  status = '',
  reducedMotion = () => false,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
} = {}) {
  if (!doc?.createElement) throw new TypeError('The touch controls need a document to render into.');
  if (!mount?.append) throw new TypeError('The touch controls need a mount element to render into.');

  const buttons = new Map();
  const holds = new Map();
  const pressedAt = new Map();
  let enabled = true;
  let dragging = null;

  const root = doc.createElement('div');
  root.className = 'nm-touch';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Touch controls for this world');
  root.setAttribute('data-nm-touch', 'root');

  const groups = {
    movement: { label: 'Movement', className: 'nm-touch-pad' },
    camera: { label: 'Camera', className: 'nm-touch-camera' },
    actions: { label: 'World actions', className: 'nm-touch-actions' },
  };
  const groupNodes = {};
  for (const [name, spec] of Object.entries(groups)) {
    const node = doc.createElement('div');
    node.className = spec.className;
    node.setAttribute('role', 'group');
    node.setAttribute('aria-label', spec.label);
    groupNodes[name] = node;
  }

  const statusNode = doc.createElement('p');
  statusNode.className = 'nm-touch-status';
  statusNode.setAttribute('role', 'status');
  statusNode.setAttribute('aria-live', 'polite');
  statusNode.setAttribute('aria-label', 'Touch control state');
  statusNode.textContent = '';

  function step(direction) {
    if (!enabled) return 'ignored';
    if (typeof input.walk !== 'function') return 'unbound';
    // The rendered key is the one authority on whether walking is possible right now, so the
    // programmatic path cannot issue a step a finger would have been refused.
    if (buttons.get(direction)?.disabled) return 'ignored';
    input.walk(direction);
    return 'sent';
  }

  function stopHold(name) {
    const state = holds.get(name);
    if (state) {
      if (state.handle !== null && state.handle !== undefined) cancel(state.handle);
      holds.delete(name);
    }
    const node = buttons.get(name);
    if (node) node.setAttribute('aria-pressed', 'false');
  }

  function repeatHold(name, state) {
    if (holds.get(name) !== state) return;
    if (state.count >= HOLD_LIMIT) return stopHold(name);
    state.count += 1;
    step(name);
    state.handle = schedule(() => repeatHold(name, state), HOLD_REPEAT_MS);
  }

  function startHold(name) {
    // One direction at a time: a second finger pressing another direction takes the walk over, so
    // the grid never receives two conflicting steps for the same instant.
    for (const held of [...holds.keys()]) if (held !== name) stopHold(held);
    stopHold(name);
    step(name);
    const node = buttons.get(name);
    if (node) node.setAttribute('aria-pressed', 'true');
    const state = { handle: null, count: 0 };
    holds.set(name, state);
    state.handle = schedule(() => { if (holds.get(name) === state) repeatHold(name, state); }, HOLD_DELAY_MS);
  }

  function activatedFromClick(name) {
    const pressed = pressedAt.get(name) ?? -Infinity;
    // A pointer press inside this window already stepped on pointerdown; its click must not repeat.
    return now() - pressed >= CLICK_SUPPRESS_MS;
  }

  for (const direction of PAD_DIRECTIONS) {
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = `nm-touch-key nm-touch-${direction}`;
    node.setAttribute('data-nm-touch', direction);
    node.setAttribute('aria-pressed', 'false');
    node.textContent = PAD_GLYPHS[direction];
    node.setAttribute('aria-label', `Move ${direction}`);
    node.addEventListener('pointerdown', (event) => {
      if (node.disabled) return;
      pressedAt.set(direction, now());
      if (typeof node.setPointerCapture === 'function' && event?.pointerId !== undefined) {
        try { node.setPointerCapture(event.pointerId); } catch { /* capture is a convenience, not the gesture */ }
      }
      startHold(direction);
    });
    for (const release of ['pointerup', 'pointercancel', 'lostpointercapture']) node.addEventListener(release, () => stopHold(direction));
    node.addEventListener('click', () => {
      if (node.disabled) return;
      if (!activatedFromClick(direction)) return;
      step(direction);
      refresh();
    });
    buttons.set(direction, node);
    groupNodes.movement.append(node);
  }

  for (const turn of LOOK_BUTTONS) {
    const name = `look-${turn}`;
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = `nm-touch-action nm-touch-look`;
    node.setAttribute('data-nm-touch', name);
    node.textContent = `Look ${turn}`;
    node.setAttribute('aria-label', `Turn the camera ${turn}`);
    node.addEventListener('click', () => {
      if (node.disabled || typeof input.look !== 'function') return;
      input.look({ yaw: turn === 'left' ? LOOK_STEP : -LOOK_STEP, pitch: 0 });
      refresh();
    });
    buttons.set(name, node);
    groupNodes.camera.append(node);
  }

  for (const item of AFFORDANCES) {
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = `nm-touch-action nm-touch-${item.name}`;
    node.setAttribute('data-nm-touch', item.name);
    node.textContent = item.glyph;
    node.setAttribute('aria-label', item.hint);
    node.addEventListener('click', () => {
      if (node.disabled) return;
      if (item.name === 'interact') input.interact?.();
      else if (item.name === 'build') input.build?.();
      else input.affordance?.(item.name);
      refresh();
    });
    buttons.set(item.name, node);
    groupNodes.actions.append(node);
  }

  function onSurfaceDown(event) {
    if (!enabled || typeof input.look !== 'function' || !surface) return;
    if (dragging) return;                                   // one owner per gesture: a second finger never fights the first
    if (event?.isPrimary === false) return;
    dragging = { pointerId: event?.pointerId, x: Number(event?.clientX) || 0, y: Number(event?.clientY) || 0, moved: 0 };
    if (typeof surface.setPointerCapture === 'function' && event?.pointerId !== undefined) {
      try { surface.setPointerCapture(event.pointerId); } catch { /* a tap still reads its position */ }
    }
  }
  function onSurfaceMove(event) {
    if (!dragging || event?.pointerId !== dragging.pointerId) return;
    const x = Number(event?.clientX) || 0, y = Number(event?.clientY) || 0;
    const dx = x - dragging.x, dy = y - dragging.y;
    dragging.x = x; dragging.y = y;
    dragging.moved += Math.abs(dx) + Math.abs(dy);
    if (gestureFor(dragging.moved) !== 'look') return;       // still a tap: nothing turns yet
    input.look(lookFromDrag(dx, dy));
  }
  function onSurfaceUp(event) {
    if (!dragging || event?.pointerId !== dragging.pointerId) return;
    const { moved, x, y } = dragging;
    dragging = null;
    if (gestureFor(moved) === 'pick' && typeof input.pick === 'function') input.pick({ x, y });
  }

  if (surface?.addEventListener) {
    surface.addEventListener('pointerdown', onSurfaceDown);
    surface.addEventListener('pointermove', onSurfaceMove);
    surface.addEventListener('pointerup', onSurfaceUp);
    surface.addEventListener('pointercancel', onSurfaceUp);
  }
  // A drag surface must not also pan the page: without `touch-action:none` the browser claims the
  // touch gesture and the camera never turns. The previous value is restored on destroy, so this
  // module never leaves a style behind on an element it does not own.
  const dragSurfaceOwned = Boolean(surface?.style) && typeof input.look === 'function';
  const previousTouchAction = dragSurfaceOwned ? surface.style.touchAction : undefined;
  if (dragSurfaceOwned) surface.style.touchAction = 'none';

  function model() {
    return touchModel({ input, canWalk: Boolean(enabled) && Boolean(canWalk()), fixture: Boolean(hasFixture()), building: Boolean(isBuilding()) });
  }

  function refresh() {
    const current = model();
    for (const item of [...current.directions, ...current.camera, ...current.affordances]) {
      if (!buttons.has(item.name)) continue;
      const node = buttons.get(item.name);
      node.disabled = !item.enabled;
      if (node.textContent !== item.text) node.textContent = item.text;
      if (node.getAttribute?.('aria-label') !== item.label) node.setAttribute('aria-label', item.label);
    }
    toggleClass(root, 'nm-touch-reduced', Boolean(reducedMotion()));
    const text = typeof status === 'function' ? String(status() ?? '') : String(status ?? '');
    if (statusNode.textContent !== text) statusNode.textContent = text;
    return current;
  }

  function setEnabled(next) {
    enabled = Boolean(next);
    if (!enabled) for (const name of [...holds.keys()]) stopHold(name);
    root.hidden = !enabled;
    refresh();
  }

  function destroy() {
    for (const name of [...holds.keys()]) stopHold(name);
    dragging = null;
    if (surface?.removeEventListener) {
      surface.removeEventListener('pointerdown', onSurfaceDown);
      surface.removeEventListener('pointermove', onSurfaceMove);
      surface.removeEventListener('pointerup', onSurfaceUp);
      surface.removeEventListener('pointercancel', onSurfaceUp);
    }
    if (dragSurfaceOwned) {
      if (previousTouchAction === undefined) delete surface.style.touchAction;
      else surface.style.touchAction = previousTouchAction;
    }
    root.remove?.();
  }

  root.append(groupNodes.movement, groupNodes.camera, groupNodes.actions, statusNode);
  mount.append(root);
  refresh();

  return {
    root,
    buttons,
    groups: groupNodes,
    status: statusNode,
    model,
    refresh,
    setEnabled,
    destroy,
    /** One walk intent by direction — the same call the pad makes, for a gamepad or a test. */
    press: step,
    /** One relative camera rotation, clamped the same way the drag is. */
    look: (delta) => input.look?.(delta),
    get dragging() { return dragging !== null; },
    get enabled() { return enabled; },
  };
}

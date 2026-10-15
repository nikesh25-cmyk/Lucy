// Touch controls for small screens: an on-screen movement pad, a camera drag surface and
// interaction/build affordances a coarse pointer can reach — mounted either in flow or as a floating
// bar over the world.
//
// Four properties this module is built around.
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
//   4. It is a control bar a thumb can actually use: the pad and the Use affordance sit together in
//      the pad's own cluster, the targets are 44 px and 52 px on a coarse pointer (the number is also
//      published to the stylesheet as `--nm-touch-target`), a floating bar is lifted above the shell's
//      own bottom row instead of covering it, and `geometry()` reports the bar's own rectangles —
//      never a window width this module guessed — so a page test can prove the pad is on screen.
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
/** A coarse pointer gets a larger target than the 44 px floor. game-mobile.css already raises its
 *  keys to 52 px under `@media(pointer:coarse)`; the module repeats the number as data so a test and
 *  a stylesheet cannot drift, and publishes it to the stylesheet as `--nm-touch-target`. */
export const TOUCH_TARGET_COARSE = 52;
/** The class that takes the bar out of flow and lays it over the world (game-mobile.css). */
export const FLOATING_CLASS = 'nm-touch-floating';
/** The gap a floating bar keeps above the quickbar it is lifted over, in pixels. */
export const QUICKBAR_GAP = 8;

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
/**
 * The interaction affordance that sits in the movement pad's own cluster instead of the wrapping
 * action row, so the building gesture and the move gesture are one thumb apart. It is kept out of
 * AFFORDANCES because its gesture differs: it acts on release, and a drag never fires it.
 */
export const USE_AFFORDANCE = Object.freeze({ name: 'use', glyph: 'Use', hint: 'Use the place or object the aim line names' });
/**
 * Where each part of the bar belongs on a phone: one thumb on the pad and the Use affordance beside
 * it, the other thumb on the camera, the drawers in the middle. Published as `data-nm-zone` on the
 * three groups and on the Use button (which is a child of the pad group, one grid cell away from the
 * movement keys), so a stylesheet can place by zone without a class this module does not render.
 */
export const TOUCH_ZONES = Object.freeze({ movement: 'bottom-left', use: 'bottom-left', camera: 'bottom-right', actions: 'bottom-centre' });

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
  // The pad-side interaction affordance. It carries the same intent as `interact` and is enabled by
  // the same world fact (the aim line names a fixture), but it lives with the pad and acts on release.
  const use = Object.freeze({
    name: USE_AFFORDANCE.name,
    group: 'use',
    text: USE_AFFORDANCE.glyph,
    label: USE_AFFORDANCE.hint,
    enabled: typeof input.interact === 'function' && Boolean(fixture),
  });
  return Object.freeze({ directions: Object.freeze(directions), camera: Object.freeze(camera), affordances: Object.freeze(affordances), use });
}

// ---------------------------------------------------------------------------------------------
// Geometry: what the bar actually occupies. Every number is read from an element rectangle, never
// from a guessed window width, so the numbers a phone test asserts are the numbers the layout made.
// ---------------------------------------------------------------------------------------------

/** A bounding rect normalised from a DOMRect, a plain rect-like object, or null when there is none. */
export function rectOf(value) {
  const rect = value && typeof value.getBoundingClientRect === 'function' ? value.getBoundingClientRect() : value;
  if (!rect) return null;
  const width = Number(rect.width), height = Number(rect.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const left = Number(rect.left ?? rect.x), top = Number(rect.top ?? rect.y);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return Object.freeze({
    left, top, width, height,
    right: Number.isFinite(Number(rect.right)) ? Number(rect.right) : left + width,
    bottom: Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : top + height,
  });
}

const overlaps = (a, b) => Boolean(a && b) && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const overlapOf = (a, b) => overlaps(a, b)
  ? Object.freeze({ width: Math.min(a.right, b.right) - Math.max(a.left, b.left), height: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) })
  : null;

/**
 * What the control bar measures as, as one report. Every input is a rectangle the caller measured (or
 * an element to measure), so nothing here depends on a viewport width it read for itself:
 *
 *   bar       the container's own box
 *   pad       the movement pad's box
 *   keys      the individual pad keys — their smallest side is the target a thumb actually presses
 *   quickbar  the shell's quickbar, which a floating bar must not cover
 *   mount     the box the bar is mounted in: a pad below its bottom edge is clipped, not on screen
 *   viewport  the visible area, when the caller can measure one
 */
export function layoutReport({ bar = null, pad = null, keys = [], quickbar = null, mount = null, viewport = null, minimum = TOUCH_TARGET_MIN } = {}) {
  const barRect = rectOf(bar), padRect = rectOf(pad), quickbarRect = rectOf(quickbar), mountRect = rectOf(mount), viewportRect = rectOf(viewport);
  const keyRects = (Array.isArray(keys) ? keys : [keys]).map(rectOf).filter(Boolean);
  const keyWidth = keyRects.length ? Math.min(...keyRects.map((rect) => rect.width)) : null;
  const keyHeight = keyRects.length ? Math.min(...keyRects.map((rect) => rect.height)) : null;
  const keySize = Object.freeze({ width: keyWidth, height: keyHeight, measured: keyRects.length > 0, minimum, meets_minimum: keyRects.length > 0 && keyWidth >= minimum && keyHeight >= minimum });
  const padSize = Object.freeze({ width: padRect?.width ?? null, height: padRect?.height ?? null, minimum, meets_minimum: Boolean(padRect) && padRect.width >= minimum && padRect.height >= minimum });
  const within = (outer) => Boolean(barRect && outer) && barRect.left < outer.right && barRect.right > outer.left && barRect.top < outer.bottom && barRect.bottom > outer.top;
  const hasBox = Boolean(barRect) && barRect.width > 0 && barRect.height > 0;
  const inMount = !mountRect || within(mountRect);
  const inViewport = !viewportRect || within(viewportRect);
  const basis = mountRect ? (viewportRect ? 'mount+viewport' : 'mount') : viewportRect ? 'viewport' : 'bar';
  const reason = !hasBox ? 'no-box' : !inMount ? 'clipped-by-mount' : !inViewport ? 'outside-viewport' : 'visible';
  return Object.freeze({
    minimum, bar: barRect, pad: padRect, keys: Object.freeze(keyRects), quickbar: quickbarRect, mount: mountRect, viewport: viewportRect,
    key_size: keySize, pad_size: padSize,
    on_screen: hasBox && inMount && inViewport, on_screen_basis: basis, on_screen_reason: reason,
    overlaps_quickbar: overlaps(barRect, quickbarRect), overlap: overlapOf(barRect, quickbarRect),
  });
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
 *
 * `floating` takes the bar out of the flow and lays it over the world under the class the stylesheet
 * already defines; the default keeps the shipped in-flow bar, so a caller that says nothing gets the
 * behaviour it had. `coarsePointer` is the input-device fact the 52 px target and the published
 * `--nm-touch-target` are keyed on, `quickbar` the shell's own bottom row a floating bar is lifted
 * above, and `viewport` a provider for the visible area — all injected, so nothing here reads a
 * window property of its own.
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
  floating = false,
  coarsePointer = () => false,
  quickbar = null,
  viewport = null,
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
  let usePress = null;
  // The quickbar lift: what the bar's own `bottom` was before this module wrote one, so `destroy`
  // can hand the element back exactly as it found it.
  let lifted = false;
  let previousBottom = undefined;

  const targetSize = () => (coarsePointer() ? TOUCH_TARGET_COARSE : TOUCH_TARGET_MIN);
  const resolve = (value) => (typeof value === 'function' ? value() : value);

  const root = doc.createElement('div');
  root.className = 'nm-touch';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Touch controls for this world');
  root.setAttribute('data-nm-touch', 'root');
  if (floating) toggleClass(root, FLOATING_CLASS, true);

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
    node.setAttribute('data-nm-zone', TOUCH_ZONES[name]);
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

  // Use is the one control here that performs a gameplay action, so it is the one that acts on
  // release: an intent sent on press would already have been sent by the time a finger turned the
  // press into a drag. A press that stays inside DRAG_THRESHOLD and comes back up is a tap; one that
  // travels past the threshold is abandoned and performs nothing; one still down after HOLD_DELAY_MS
  // repeats on the same cadence as a held pad key.
  function stopUse() {
    if (usePress) {
      if (usePress.handle !== null && usePress.handle !== undefined) cancel(usePress.handle);
      usePress = null;
    }
    buttons.get(USE_AFFORDANCE.name)?.setAttribute('aria-pressed', 'false');
  }

  function repeatUse(state) {
    if (usePress !== state) return;
    if (state.count >= HOLD_LIMIT) return stopUse();
    state.count += 1;
    input.interact?.();
    state.handle = schedule(() => repeatUse(state), HOLD_REPEAT_MS);
  }

  function pressUse(event) {
    if (!enabled || buttons.get(USE_AFFORDANCE.name)?.disabled) return;
    pressedAt.set(USE_AFFORDANCE.name, now());
    usePress = { pointerId: event?.pointerId, x: Number(event?.clientX) || 0, y: Number(event?.clientY) || 0, count: 0, travelled: false, handle: null };
    const state = usePress;
    state.handle = schedule(() => {
      if (usePress !== state) return;
      input.interact?.();
      state.count = 1;
      state.handle = schedule(() => repeatUse(state), HOLD_REPEAT_MS);
    }, HOLD_DELAY_MS);
    buttons.get(USE_AFFORDANCE.name)?.setAttribute('aria-pressed', 'true');
  }

  function moveUse(event) {
    if (!usePress || event?.pointerId !== usePress.pointerId) return;
    const dx = (Number(event?.clientX) || 0) - usePress.x, dy = (Number(event?.clientY) || 0) - usePress.y;
    if (Math.abs(dx) + Math.abs(dy) <= DRAG_THRESHOLD) return;
    usePress.travelled = true;
    stopUse();
  }

  function releaseUse(event) {
    if (!usePress || event?.pointerId !== usePress.pointerId) return;
    const { travelled, count } = usePress;
    stopUse();
    if (!travelled && count === 0 && typeof input.interact === 'function') input.interact();
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

  {
    // The interaction affordance beside the pad: a real `<button>`, so Tab and Enter reach it, with
    // the same click suppression the keys carry and the release-vs-drag rule the machine above keeps.
    // It is a child of the pad group, so it lands in the pad's own grid cell: one thumb reaches
    // movement and Use without crossing the bar, and the stylesheet needs no rule it does not have.
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = 'nm-touch-action';
    node.setAttribute('data-nm-touch', USE_AFFORDANCE.name);
    node.setAttribute('data-nm-beside', 'pad');
    node.setAttribute('data-nm-zone', TOUCH_ZONES.use);
    node.setAttribute('aria-pressed', 'false');
    node.textContent = USE_AFFORDANCE.glyph;
    node.setAttribute('aria-label', USE_AFFORDANCE.hint);
    node.addEventListener('pointerdown', (event) => {
      if (typeof node.setPointerCapture === 'function' && event?.pointerId !== undefined) {
        try { node.setPointerCapture(event.pointerId); } catch { /* capture is a convenience, not the gesture */ }
      }
      pressUse(event);
    });
    node.addEventListener('pointermove', moveUse);
    node.addEventListener('pointerup', releaseUse);
    // A cancelled gesture (the browser claiming the touch, a call arriving) performs nothing.
    for (const release of ['pointercancel', 'lostpointercapture']) node.addEventListener(release, () => stopUse());
    node.addEventListener('click', () => {
      if (node.disabled) return;
      if (!activatedFromClick(USE_AFFORDANCE.name)) return;
      input.interact?.();
      refresh();
    });
    buttons.set(USE_AFFORDANCE.name, node);
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
    for (const item of [...current.directions, ...current.camera, ...current.affordances, current.use]) {
      if (!buttons.has(item.name)) continue;
      const node = buttons.get(item.name);
      node.disabled = !item.enabled;
      if (node.textContent !== item.text) node.textContent = item.text;
      if (node.getAttribute?.('aria-label') !== item.label) node.setAttribute('aria-label', item.label);
    }
    toggleClass(root, 'nm-touch-reduced', Boolean(reducedMotion()));
    publishTarget();
    const text = typeof status === 'function' ? String(status() ?? '') : String(status ?? '');
    if (statusNode.textContent !== text) statusNode.textContent = text;
    return current;
  }

  // The size this bar's targets must reach, published to the stylesheet as a custom property, so the
  // 44 px floor and the coarse-pointer raise exist in one place the module is measured by.
  function publishTarget() {
    if (!root.style) return;
    const value = `${targetSize()}px`;
    if (typeof root.style.setProperty === 'function') root.style.setProperty('--nm-touch-target', value);
    else root.style['--nm-touch-target'] = value;
  }

  /**
   * A floating bar sits above the shell's own bottom row (its quickbar, or the whole HUD strip) instead
   * of over it. The lift is measured from that element's own rectangle, so a taller row moves the bar
   * with it; call it again after a resize or a layout change. An in-flow bar is left where the flow
   * put it, and `destroy` hands the element back with the `bottom` it had before.
   */
  function avoidQuickbar(element = quickbar) {
    if (!floating) return Object.freeze({ applied: false, reason: 'not-floating' });
    const rect = rectOf(resolve(element));
    if (!rect) return Object.freeze({ applied: false, reason: 'no-quickbar' });
    const offset = Math.round(rect.height + QUICKBAR_GAP);
    if (!lifted) { lifted = true; previousBottom = root.style ? root.style.bottom : undefined; }
    root.style.bottom = `${offset}px`;
    return Object.freeze({ applied: true, offset });
  }

  /** What this bar measures as, from its own element rectangles. See `layoutReport`. */
  function geometry(target = {}) {
    return layoutReport({
      bar: root,
      pad: groupNodes.movement,
      keys: PAD_DIRECTIONS.map((direction) => buttons.get(direction)),
      quickbar: resolve(target.quickbar === undefined ? quickbar : target.quickbar),
      mount,
      viewport: resolve(target.viewport === undefined ? viewport : target.viewport),
      minimum: targetSize(),
    });
  }

  function setEnabled(next) {
    enabled = Boolean(next);
    if (!enabled) {
      for (const name of [...holds.keys()]) stopHold(name);
      stopUse();
    }
    root.hidden = !enabled;
    refresh();
  }

  function destroy() {
    for (const name of [...holds.keys()]) stopHold(name);
    stopUse();
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
    if (lifted && root.style) {
      if (previousBottom === undefined) delete root.style.bottom;
      else root.style.bottom = previousBottom;
      lifted = false;
    }
    if (root.style) {
      if (typeof root.style.removeProperty === 'function') root.style.removeProperty('--nm-touch-target');
      else delete root.style['--nm-touch-target'];
    }
    root.remove?.();
  }

  root.append(groupNodes.movement, groupNodes.camera, groupNodes.actions, statusNode);
  mount.append(root);
  avoidQuickbar();
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
    geometry,
    avoidQuickbar,
    /** What this bar's targets must reach: 44 px, or 52 px on a coarse pointer. */
    get targetSize() { return targetSize(); },
    get floating() { return floating; },
    get zones() { return TOUCH_ZONES; },
    /** One walk intent by direction — the same call the pad makes, for a gamepad or a test. */
    press: step,
    /** One interaction — the same call the Use control makes. */
    use: () => input.interact?.(),
    /** One relative camera rotation, clamped the same way the drag is. */
    look: (delta) => input.look?.(delta),
    get dragging() { return dragging !== null; },
    get enabled() { return enabled; },
  };
}

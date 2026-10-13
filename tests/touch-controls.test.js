// The touch half of world control: an on-screen pad, a camera drag and interaction/build
// affordances, all driven through an injected input interface.
//
// There is no browser in this repository's test runner, so the module is exercised against a small
// stub document and an injected clock. Every assertion below is about the module's own behaviour —
// which intent it sends, how many times, and what it says — never about a rendered pixel. The
// rendered pixels and their measured sizes and colours are checked in mobile-styles.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TOUCH_TARGET_MIN, DRAG_THRESHOLD, LOOK_PER_PIXEL, PITCH_PER_PIXEL, MAX_PITCH, LOOK_STEP,
  HOLD_DELAY_MS, HOLD_REPEAT_MS, HOLD_LIMIT, CLICK_SUPPRESS_MS,
  PAD_DIRECTIONS, PAD_GLYPHS, LOOK_BUTTONS, AFFORDANCES, COARSE_POINTER_QUERY,
  lookFromDrag, isKeyboardActivation, gestureFor, touchModel, prefersReducedMotion, hasCoarsePointer,
  createTouchControls,
} from '../src/ui/touch-controls.js';

const source = readFileSync(fileURLToPath(new URL('../src/ui/touch-controls.js', import.meta.url)), 'utf8');

// --- a stub document, a stub clock and a recording input interface -------------------------------
function createDom() {
  function makeElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parent: null,
      className: '',
      type: '',
      textContent: '',
      disabled: false,
      hidden: false,
      style: {},
      attributes: {},
      listeners: new Map(),
      append(...kids) { for (const kid of kids) { kid.parent = el; el.children.push(kid); } },
      setAttribute(name, value) { el.attributes[name] = String(value); },
      getAttribute(name) { return name in el.attributes ? el.attributes[name] : null; },
      addEventListener(type, handler) {
        if (!el.listeners.has(type)) el.listeners.set(type, []);
        el.listeners.get(type).push(handler);
      },
      removeEventListener(type, handler) {
        el.listeners.set(type, (el.listeners.get(type) || []).filter((item) => item !== handler));
      },
      listenerCount(type) { return (el.listeners.get(type) || []).length; },
      dispatch(type, init = {}) {
        const event = { type, target: el, detail: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0, ...init };
        for (const handler of [...(el.listeners.get(type) || [])]) handler(event);
        return event;
      },
      setPointerCapture() {},
      releasePointerCapture() {},
      remove() { if (el.parent) { el.parent.children = el.parent.children.filter((kid) => kid !== el); el.parent = null; } },
    };
    Object.defineProperty(el, 'classList', {
      get() {
        return {
          toggle(name, on) {
            const names = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
            const want = on === undefined ? !names.has(name) : Boolean(on);
            if (want) names.add(name); else names.delete(name);
            el.className = [...names].join(' ');
            return want;
          },
          add(name) { this.toggle(name, true); },
          remove(name) { this.toggle(name, false); },
          contains(name) { return String(el.className || '').split(/\s+/).includes(name); },
        };
      },
    });
    return el;
  }
  return { createElement: makeElement };
}

function fakeClock() {
  let time = 0, nextId = 1;
  const pending = new Map();
  return {
    now: () => time,
    schedule(fn, ms) { const id = nextId++; pending.set(id, { fn, at: time + (Number(ms) || 0) }); return id; },
    cancel(id) { pending.delete(id); },
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        time = due[1].at;
        due[1].fn();
      }
      time = target;
    },
    get pendingTimers() { return pending.size; },
  };
}

function harness(overrides = {}) {
  const dom = createDom();
  const clock = fakeClock();
  const sent = [];
  const input = {
    walk: (direction) => sent.push(`walk:${direction}`),
    look: (delta) => sent.push(`look:${delta.yaw.toFixed(4)},${delta.pitch.toFixed(4)}`),
    pick: (point) => sent.push(`pick:${point.x},${point.y}`),
    interact: () => sent.push('interact'),
    build: () => sent.push('build'),
    affordance: (name) => sent.push(`affordance:${name}`),
    ...overrides.input,
  };
  const mount = dom.createElement('div');
  const surface = dom.createElement('canvas');
  const controls = createTouchControls({
    document: dom, mount, surface, input,
    canWalk: overrides.canWalk ?? (() => true),
    hasFixture: overrides.hasFixture ?? (() => false),
    isBuilding: overrides.isBuilding ?? (() => false),
    status: overrides.status ?? '',
    reducedMotion: overrides.reducedMotion ?? (() => false),
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
  });
  return { dom, clock, sent, input, mount, surface, controls };
}

const byTouch = (controls, name) => controls.buttons.get(name);

// --- the pure model -------------------------------------------------------------------------------
test('the control surface is described as data: a pad, a single-pointer camera alternative and affordances', () => {
  const bare = touchModel({ input: {} });
  assert.deepEqual(bare.directions.map((item) => item.name), [...PAD_DIRECTIONS]);
  assert.deepEqual(bare.directions.map((item) => item.text), PAD_DIRECTIONS.map((name) => PAD_GLYPHS[name]));
  assert.deepEqual(bare.camera.map((item) => item.name), LOOK_BUTTONS.map((turn) => `look-${turn}`));
  assert.deepEqual(bare.affordances.map((item) => item.name), AFFORDANCES.map((item) => item.name));
  // With no input interface nothing is offered, so the controls cannot pretend to work.
  for (const item of [...bare.directions, ...bare.camera, ...bare.affordances]) {
    assert.equal(item.enabled, false, `${item.name} must be unusable without an injected interface`);
    assert.ok(item.label.length > 0, `${item.name} must carry an accessible name`);
    assert.ok(String(item.group).length > 0, `${item.name} must belong to a named group`);
  }
  assert.equal(TOUCH_TARGET_MIN, 44, 'the project convention is still 44 pixels');
});

test('each control is enabled exactly when the interface and the world state allow it', () => {
  const walkOnly = touchModel({ input: { walk() {} } });
  assert.equal(walkOnly.directions.every((item) => item.enabled), true);
  assert.equal(walkOnly.camera.every((item) => item.enabled === false), true, 'no look interface, no camera controls');
  assert.equal(walkOnly.affordances.every((item) => item.enabled === false), true);

  const full = touchModel({ input: { walk() {}, look() {}, interact() {}, build() {}, affordance() {} }, fixture: true, building: true });
  assert.equal(full.directions.every((item) => item.enabled), true);
  assert.equal(full.camera.every((item) => item.enabled), true);
  assert.equal(full.affordances.every((item) => item.enabled), true);
  assert.equal(full.affordances.find((item) => item.name === 'build').text, 'Finish', 'the build control names the state it will leave');

  // The aim line decides whether Use is offered: no fixture, no Use.
  const aimed = touchModel({ input: { interact() {} }, fixture: false });
  assert.equal(aimed.affordances.find((item) => item.name === 'interact').enabled, false);
  assert.equal(touchModel({ input: { interact() {} }, fixture: true }).affordances.find((item) => item.name === 'interact').enabled, true);

  // A paused or non-acting world disables movement without disabling the drawers.
  const paused = touchModel({ input: { walk() {}, affordance() {} }, canWalk: false });
  assert.equal(paused.directions.every((item) => item.enabled === false), true);
  assert.equal(paused.affordances.filter((item) => item.name === 'chat').every((item) => item.enabled), true);
});

test('a drag turns the camera the same way the shipped Look buttons and tilt keys do', () => {
  // Right and left: app.js `Look right` is `yaw - LOOK_STEP`, so a rightward drag decreases yaw.
  const right = lookFromDrag(100, 0);
  assert.equal(right.yaw < 0, true, 'dragging right turns right');
  assert.equal(right.pitch, 0);
  assert.equal(right.yaw.toFixed(4), (-100 * LOOK_PER_PIXEL).toFixed(4));
  assert.equal(lookFromDrag(-100, 0).yaw > 0, true, 'dragging left turns left');
  // Up and down: `lookStep('up')` is `pitch - step`, so an upward drag decreases pitch.
  assert.equal(lookFromDrag(0, -100).pitch < 0, true, 'dragging up looks up');
  assert.equal(lookFromDrag(0, 100).pitch.toFixed(4), (100 * PITCH_PER_PIXEL).toFixed(4));
  // The shipped step and the drag agree in sign, so the two controls never fight.
  assert.equal(LOOK_STEP > 0, true);
  assert.equal(lookFromDrag(LOOK_STEP / LOOK_PER_PIXEL, 0).yaw, -LOOK_STEP);
  // The tilt the renderer already clamps to is the tilt a drag can reach.
  assert.equal(lookFromDrag(0, 1e6).pitch, MAX_PITCH);
  assert.equal(lookFromDrag(0, -1e6).pitch, -MAX_PITCH);
  // A malformed measurement cannot turn the camera.
  for (const [dx, dy] of [[NaN, 0], [0, NaN], [Infinity, -Infinity], [undefined, undefined]]) {
    assert.deepEqual(lookFromDrag(dx, dy), { yaw: 0, pitch: 0 });
  }
});

test('one measured gesture is either a drag or a tap, never both', () => {
  assert.equal(DRAG_THRESHOLD, 6);
  assert.equal(gestureFor(0), 'pick');
  assert.equal(gestureFor(DRAG_THRESHOLD), 'pick', 'a gesture at the threshold is still a tap');
  assert.equal(gestureFor(DRAG_THRESHOLD + 0.01), 'look');
  for (const distance of [NaN, Infinity, -Infinity, undefined, null, '6']) assert.equal(gestureFor(distance), 'pick', 'an unusable distance cannot start a drag');
  // A keyboard or switch activation of a button has no pointer, so detail 0 is the press.
  assert.equal(isKeyboardActivation({ detail: 0 }), true);
  assert.equal(isKeyboardActivation({ detail: 1 }), false);
  assert.equal(isKeyboardActivation({}), true, 'an event with no detail is treated as a keyboard activation');
});

test('prefers-reduced-motion and a coarse pointer are read through an injected matchMedia', () => {
  const matching = (query) => ({ matches: query.includes('reduced-motion') || query === COARSE_POINTER_QUERY });
  assert.equal(prefersReducedMotion(matching), true);
  assert.equal(hasCoarsePointer(matching), true);
  assert.equal(COARSE_POINTER_QUERY, '(pointer: coarse)');
  const refusing = () => ({ matches: false });
  assert.equal(prefersReducedMotion(refusing), false);
  assert.equal(hasCoarsePointer(refusing), false);
  // A browser without matchMedia, or one that throws, degrades to "no motion preference stated".
  assert.equal(prefersReducedMotion(undefined), false);
  assert.equal(prefersReducedMotion(() => { throw new Error('blocked'); }), false);
  assert.equal(hasCoarsePointer(null), false);
});

// --- the rendered controls -----------------------------------------------------------------------
test('the controls are labelled buttons inside named groups, and never inject markup', () => {
  const { controls, mount, surface } = harness();
  assert.equal(mount.children[0], controls.root, 'the controls render into the mount they were given');
  assert.equal(controls.root.getAttribute('role'), 'group');
  assert.match(controls.root.getAttribute('aria-label'), /Touch controls/);
  for (const [name, label] of [['movement', 'Movement'], ['camera', 'Camera'], ['actions', 'World actions']]) {
    const group = controls.groups[name];
    assert.equal(group.getAttribute('role'), 'group');
    assert.equal(group.getAttribute('aria-label'), label);
    assert.equal(controls.root.children.includes(group), true, `${name} is part of the control surface`);
  }
  for (const name of ['up', 'left', 'down', 'right', 'look-left', 'look-right', 'interact', 'build', 'chat', 'tools']) {
    const node = byTouch(controls, name);
    assert.ok(node, `${name} must exist`);
    assert.equal(node.tagName, 'BUTTON', `${name} must be a real button so a keyboard and a switch reach it`);
    assert.equal(node.type, 'button', `${name} must not submit a form`);
    assert.ok(String(node.getAttribute('aria-label')).length > 0, `${name} needs an accessible name`);
    assert.equal(node.getAttribute('data-nm-touch'), name, `${name} must be addressable by this stylesheet without a new class per control`);
  }
  // Every control is in exactly one group, so a screen reader can orient.
  const grouped = Object.values(controls.groups).flatMap((group) => group.children);
  for (const [, node] of controls.buttons) assert.equal(grouped.includes(node), true);
  // The state is text, not motion: a polite live region that the integration owner fills.
  assert.equal(controls.status.getAttribute('role'), 'status');
  assert.equal(controls.status.getAttribute('aria-live'), 'polite');
  // The module writes text nodes only. There is no markup path at all.
  assert.doesNotMatch(source, /innerHTML/);
  assert.doesNotMatch(source, /insertAdjacentHTML|outerHTML|createElementNS/);
});

test('the module assumes no mouse and no physical keyboard: pointer events only, and no imports', () => {
  // A finger, a pen and a mouse all arrive as Pointer Events, so there is one listener set and no
  // way for a duplicate touch listener to fire a gesture twice.
  assert.match(source, /pointerdown/);
  assert.match(source, /pointermove/);
  assert.match(source, /pointerup/);
  assert.match(source, /pointercancel/);
  assert.doesNotMatch(source, /'touchstart'|'touchmove'|'touchend'|'touchcancel'/);
  assert.doesNotMatch(source, /'mousedown'|'mouseup'|'mousemove'|'mouseover'|'hover'/);
  // It never binds a key of its own: keyboard reach comes from the native button activation, so it
  // cannot swallow a key the world's own keyboard map needs.
  assert.doesNotMatch(source, /addEventListener\('key/);
  assert.doesNotMatch(source, /addEventListener\('focus/);
  // No dependency, and no import from the camera or input modules the parallel tasks own.
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /require\(/);
  assert.doesNotMatch(source, /camera-controls|game-input/);
  assert.doesNotMatch(source, /\bdocument\./);
  assert.doesNotMatch(source, /globalThis|window\./);
});

test('a press walks once, a held press repeats on the injected clock, and a release stops it', () => {
  const { controls, sent, clock } = harness();
  const key = byTouch(controls, 'up');
  assert.equal(controls.enabled, true);
  key.dispatch('pointerdown', { pointerId: 1 });
  assert.deepEqual(sent, ['walk:up'], 'a press steps immediately');
  assert.equal(key.getAttribute('aria-pressed'), 'true', 'the pressed state is announced, not implied by a colour alone');
  clock.advance(HOLD_DELAY_MS - 1);
  assert.deepEqual(sent, ['walk:up'], 'nothing repeats before the hold delay');
  clock.advance(1);
  assert.deepEqual(sent, ['walk:up', 'walk:up'], 'holding repeats');
  clock.advance(HOLD_REPEAT_MS * 3 - 1);
  assert.equal(sent.length, 4, 'the repeat keeps a steady interval');
  key.dispatch('pointerup', { pointerId: 1 });
  assert.equal(key.getAttribute('aria-pressed'), 'false');
  assert.equal(clock.pendingTimers, 0, 'releasing leaves no timer behind');
  clock.advance(HOLD_REPEAT_MS * 10);
  assert.equal(sent.length, 4, 'a released key never walks again');
});

test('a held key is bounded, a cancelled gesture stops, and a different key takes over cleanly', () => {
  const { controls, sent, clock } = harness();
  byTouch(controls, 'left').dispatch('pointerdown', { pointerId: 1 });
  clock.advance((HOLD_DELAY_MS + HOLD_REPEAT_MS * (HOLD_LIMIT + 5)));
  assert.equal(sent.length, HOLD_LIMIT + 1, `a stuck gesture stops after ${HOLD_LIMIT} repeats`);
  assert.equal(clock.pendingTimers, 0);
  assert.equal(byTouch(controls, 'left').getAttribute('aria-pressed'), 'false');

  // pointercancel (a browser taking the gesture, a call arriving) stops the walk.
  const second = harness();
  byTouch(second.controls, 'down').dispatch('pointerdown', { pointerId: 2 });
  byTouch(second.controls, 'down').dispatch('pointercancel', { pointerId: 2 });
  second.clock.advance(HOLD_REPEAT_MS * 5);
  assert.deepEqual(second.sent, ['walk:down'], 'a cancelled press walks exactly once');

  // Pressing a second direction stops the first: one gesture, one direction.
  const third = harness();
  byTouch(third.controls, 'up').dispatch('pointerdown', { pointerId: 3 });
  byTouch(third.controls, 'right').dispatch('pointerdown', { pointerId: 4 });
  third.clock.advance(HOLD_DELAY_MS + HOLD_REPEAT_MS * 4);
  assert.equal(third.sent.filter((entry) => entry === 'walk:up').length, 1, 'the first key stopped repeating');
  assert.ok(third.sent.filter((entry) => entry === 'walk:right').length > 1, 'the second key repeats');
});

test('a pointer press never double-steps through its own click, and a keyboard activation steps once', () => {
  const { controls, sent, clock } = harness();
  const key = byTouch(controls, 'up');
  key.dispatch('pointerdown', { pointerId: 1 });
  key.dispatch('click', { detail: 1 });         // the click the browser sends after the press
  assert.deepEqual(sent, ['walk:up'], 'one press, one step');
  key.dispatch('pointerup', { pointerId: 1 });
  clock.advance(CLICK_SUPPRESS_MS);
  key.dispatch('click', { detail: 0 });         // Enter or Space on the focused button
  assert.deepEqual(sent, ['walk:up', 'walk:up'], 'the keyboard path still steps exactly once');
});

test('a drag turns the camera past the threshold, and a tap is a pick — never both', () => {
  const { controls, surface, sent } = harness();
  surface.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
  surface.dispatch('pointermove', { pointerId: 1, clientX: 102, clientY: 102 });
  assert.deepEqual(sent, [], 'a small movement is not yet a drag');
  surface.dispatch('pointermove', { pointerId: 1, clientX: 140, clientY: 100 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0], `look:${(-38 * LOOK_PER_PIXEL).toFixed(4)},${(-2 * PITCH_PER_PIXEL).toFixed(4)}`, 'the movement past the threshold turns the camera by the pixels moved');
  assert.equal(sent.some((entry) => entry.startsWith('pick')), false, 'a drag is never also a tap');
  surface.dispatch('pointerup', { pointerId: 1, clientX: 140, clientY: 100 });
  assert.equal(sent.filter((entry) => entry.startsWith('pick')).length, 0, 'releasing a drag picks nothing');

  const tap = harness();
  tap.surface.dispatch('pointerdown', { pointerId: 7, clientX: 20, clientY: 30 });
  tap.surface.dispatch('pointermove', { pointerId: 7, clientX: 22, clientY: 31 });
  tap.surface.dispatch('pointerup', { pointerId: 7, clientX: 22, clientY: 31 });
  assert.deepEqual(tap.sent, ['pick:22,31'], 'a short gesture is one pick at where it ended');
  assert.equal(controls.dragging, false);
});

test('one pointer owns the drag, so a second finger can hold a movement key at the same time', () => {
  const { controls, surface, sent } = harness();
  surface.dispatch('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
  assert.equal(controls.dragging, true);
  surface.dispatch('pointerdown', { pointerId: 2, clientX: 300, clientY: 300, isPrimary: false });
  surface.dispatch('pointermove', { pointerId: 2, clientX: 320, clientY: 300 });
  assert.deepEqual(sent, [], 'the second pointer cannot turn the camera');
  surface.dispatch('pointermove', { pointerId: 1, clientX: 40, clientY: 0 });
  assert.equal(sent.length, 1, 'the owning pointer still turns it');
  // A pad key pressed by the second finger walks while the first finger drags.
  byTouch(controls, 'up').dispatch('pointerdown', { pointerId: 2 });
  assert.deepEqual(sent.slice(1), ['walk:up']);
  surface.dispatch('pointerup', { pointerId: 2, clientX: 320, clientY: 300 });
  assert.equal(controls.dragging, true, 'the other pointer’s release does not end the drag');
  surface.dispatch('pointerup', { pointerId: 1, clientX: 40, clientY: 0 });
  assert.equal(controls.dragging, false);
});

test('the affordances call the injected interface and are disabled exactly when the world refuses them', () => {
  let fixture = false, building = false, walkable = true;
  const { controls, sent } = harness({ hasFixture: () => fixture, isBuilding: () => building, canWalk: () => walkable });
  byTouch(controls, 'interact').dispatch('click', { detail: 1 });
  assert.deepEqual(sent, [], 'no fixture means the server has nothing to act on');
  assert.equal(byTouch(controls, 'interact').disabled, true, 'and the control says so rather than failing silently');
  fixture = true;
  controls.refresh();
  assert.equal(byTouch(controls, 'interact').disabled, false);
  byTouch(controls, 'interact').dispatch('click', { detail: 1 });
  assert.deepEqual(sent, ['interact']);
  byTouch(controls, 'build').dispatch('click', { detail: 1 });
  byTouch(controls, 'chat').dispatch('click', { detail: 1 });
  byTouch(controls, 'tools').dispatch('click', { detail: 1 });
  assert.deepEqual(sent, ['interact', 'build', 'affordance:chat', 'affordance:tools']);
  building = true;
  controls.refresh();
  assert.equal(byTouch(controls, 'build').textContent, 'Finish');
  assert.match(byTouch(controls, 'build').getAttribute('aria-label'), /leave build mode/);
  walkable = false;
  controls.refresh();
  assert.equal(byTouch(controls, 'up').disabled, true, 'a paused world disables movement');
  assert.equal(sent.filter((entry) => entry.startsWith('walk')).length, 0);
  assert.equal(controls.press('up'), 'ignored', 'a disabled pad sends no intent');
});

test('the single-pointer camera buttons send the shipped Look step, so the camera is reachable without a drag', () => {
  const { controls, sent } = harness();
  byTouch(controls, 'look-left').dispatch('click', { detail: 1 });
  byTouch(controls, 'look-right').dispatch('click', { detail: 1 });
  assert.deepEqual(sent, [`look:${LOOK_STEP.toFixed(4)},${(0).toFixed(4)}`, `look:${(-LOOK_STEP).toFixed(4)},${(0).toFixed(4)}`]);
  assert.match(byTouch(controls, 'look-left').getAttribute('aria-label'), /Turn the camera left/);
});

test('reduced motion is announced to the stylesheet, and the status is text the whole time', () => {
  let reduced = true, message = 'Move with the pad · drag the world to look';
  const { controls } = harness({ reducedMotion: () => reduced, status: () => message });
  assert.equal(controls.root.classList.contains('nm-touch-reduced'), true);
  assert.equal(controls.status.textContent, message, 'the state is carried as text, never by motion alone');
  reduced = false;
  controls.refresh();
  assert.equal(controls.root.classList.contains('nm-touch-reduced'), false);
  message = 'Holding a direction walks one tile at a time';
  controls.refresh();
  assert.equal(controls.status.textContent, message);
});

test('the drag surface is made drag-safe and handed back exactly as it was found', () => {
  const { controls, surface, dom, mount } = harness();
  assert.equal(surface.style.touchAction, 'none', 'without touch-action:none the browser would pan instead of turning the camera');
  assert.equal(surface.listenerCount('pointerdown'), 1);
  assert.equal(surface.listenerCount('pointermove'), 1);
  controls.destroy();
  assert.equal(surface.style.touchAction, undefined, 'the previous value is restored');
  assert.equal('touchAction' in surface.style, false, 'and the property the module added is removed, not nulled');
  assert.equal(surface.listenerCount('pointerdown'), 0);
  assert.equal(surface.listenerCount('pointermove'), 0);
  assert.equal(surface.listenerCount('pointerup'), 0);
  assert.equal(mount.children.includes(controls.root), false, 'the controls are removed from their mount');
  assert.equal(dom.createElement('div').children.length, 0);
  // A surface with no style object at all is still usable: the module only ever adds one property.
  const bare = createTouchControls({ document: dom, mount: dom.createElement('div'), input: { walk() {} }, surface: dom.createElement('canvas'), now: () => 0, schedule: () => 1, cancel: () => {}, reducedMotion: () => false });
  assert.equal(bare.buttons.get('up').disabled, false, 'walking works without a camera interface too');
  assert.equal(bare.buttons.get('look-left').disabled, true, 'and the camera controls are honestly disabled');
  bare.destroy();
});

test('a switched-off control surface stops every gesture and hides itself from the pointer', () => {
  const { controls, sent, clock } = harness();
  byTouch(controls, 'down').dispatch('pointerdown', { pointerId: 1 });
  controls.setEnabled(false);
  clock.advance(HOLD_REPEAT_MS * 5);
  assert.deepEqual(sent, ['walk:down'], 'switching off stops a hold in progress');
  assert.equal(controls.root.hidden, true, 'and the control surface is out of the way');
  assert.equal(controls.enabled, false);
  assert.equal(controls.press('up'), 'ignored');
  assert.equal(byTouch(controls, 'up').disabled, true);
  controls.setEnabled(true);
  assert.equal(controls.root.hidden, false);
  assert.equal(controls.press('up'), 'sent');
  assert.deepEqual(sent.slice(1), ['walk:up']);
});

test('a missing document or mount is refused loudly rather than rendering nothing', () => {
  const dom = createDom();
  assert.throws(() => createTouchControls({ mount: dom.createElement('div') }), TypeError);
  assert.throws(() => createTouchControls({ document: dom }), TypeError);
  assert.throws(() => createTouchControls(), TypeError);
});

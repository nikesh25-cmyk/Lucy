// Comfortable touch controls: a floating bar, 52-pixel targets on a coarse pointer, a pad that knows
// whether it is on screen, and a Use control beside it that a drag can never trigger.
//
// There is no browser in this repository's test runner, so the geometry is driven the way a browser
// drives it: every element in the stub document reports a rectangle, and the assertions are about the
// module's own arithmetic over those rectangles. Nothing here reads `window.innerWidth`, and the
// module cannot: `src/ui/touch-controls.js` may not mention a window at all, which the last test in
// this file re-checks from the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TOUCH_TARGET_MIN, TOUCH_TARGET_COARSE, FLOATING_CLASS, QUICKBAR_GAP, DRAG_THRESHOLD,
  HOLD_DELAY_MS, HOLD_REPEAT_MS, PAD_DIRECTIONS, PAD_GLYPHS, USE_AFFORDANCE, TOUCH_ZONES,
  createTouchControls, layoutReport, rectOf, touchModel,
} from '../src/ui/touch-controls.js';

const source = readFileSync(fileURLToPath(new URL('../src/ui/touch-controls.js', import.meta.url)), 'utf8');

// --- a stub document whose elements report rectangles ---------------------------------------------
function createDom() {
  function makeElement(tag) {
    const style = {
      setProperty(name, value) { style[name] = String(value); },
      removeProperty(name) { delete style[name]; },
    };
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parent: null,
      className: '',
      type: '',
      textContent: '',
      disabled: false,
      hidden: false,
      rect: null,
      style,
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
      getBoundingClientRect() { return el.rect; },
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

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

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
  let fixture = overrides.fixture ?? false;
  const controls = createTouchControls({
    document: dom, mount, surface, input,
    canWalk: () => true,
    hasFixture: () => fixture,
    isBuilding: () => false,
    floating: overrides.floating ?? false,
    coarsePointer: overrides.coarsePointer ?? (() => false),
    quickbar: overrides.quickbar ?? null,
    viewport: overrides.viewport ?? null,
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    reducedMotion: () => false,
    status: '',
  });
  return {
    dom, clock, sent, input, mount, surface, controls,
    setFixture: (next) => { fixture = next; controls.refresh(); },
    byTouch: (name) => controls.buttons.get(name),
  };
}

// ---------------------------------------------------------------------------------------------
// Geometry, as one pure report over rectangles.
// ---------------------------------------------------------------------------------------------
test('rectOf normalises a DOMRect, a plain rect and nothing at all', () => {
  assert.deepEqual(rectOf(rect(10, 20, 30, 40)), { left: 10, top: 20, width: 30, height: 40, right: 40, bottom: 60 });
  assert.deepEqual(rectOf({ x: 1, y: 2, width: 3, height: 4 }), { left: 1, top: 2, width: 3, height: 4, right: 4, bottom: 6 });
  assert.deepEqual(rectOf({ getBoundingClientRect: () => rect(0, 0, 8, 8) }), { left: 0, top: 0, width: 8, height: 8, right: 8, bottom: 8 });
  for (const nothing of [null, undefined, {}, { width: 10 }, { width: 'wide', height: 4 }, 0]) assert.equal(rectOf(nothing), null);
});

test('the geometry report measures the bar, the pad and the keys the server contract asks for', () => {
  const report = layoutReport({
    bar: rect(0, 200, 320, 200),
    pad: rect(4, 210, 164, 164),
    keys: PAD_DIRECTIONS.map(() => rect(4, 210, 52, 52)),
    mount: rect(0, 0, 320, 400),
    minimum: TOUCH_TARGET_COARSE,
  });
  assert.equal(report.on_screen, true);
  assert.equal(report.on_screen_basis, 'mount');
  assert.equal(report.on_screen_reason, 'visible');
  assert.deepEqual({ width: report.pad_size.width, height: report.pad_size.height }, { width: 164, height: 164 });
  assert.equal(report.pad_size.meets_minimum, true);
  assert.equal(report.key_size.width, 52);
  assert.equal(report.key_size.height, 52);
  assert.equal(report.key_size.meets_minimum, true);
  assert.equal(report.overlaps_quickbar, false);
  assert.equal(report.overlap, null);

  // A 44-pixel key on a coarse pointer is below the contract, and the report says so rather than
  // rounding it up.
  const small = layoutReport({ bar: rect(0, 200, 320, 200), keys: [rect(0, 200, 44, 44)], minimum: TOUCH_TARGET_COARSE });
  assert.equal(small.key_size.meets_minimum, false);
  // With nothing measured, nothing is claimed.
  const unknown = layoutReport({});
  assert.equal(unknown.on_screen, false);
  assert.equal(unknown.on_screen_reason, 'no-box');
  assert.equal(unknown.key_size.measured, false);
  assert.equal(unknown.key_size.meets_minimum, false);
  assert.equal(unknown.pad_size.meets_minimum, false);
});

test('a bar the mount clips is reported off screen, which is the bug a fixed-height panel caused', () => {
  const mount = rect(0, 0, 320, 400);
  // The pad sits below the panel's own bottom edge: the layout exists, but nobody can reach it.
  const clipped = layoutReport({ bar: rect(0, 420, 320, 160), pad: rect(4, 430, 164, 164), mount });
  assert.equal(clipped.on_screen, false);
  assert.equal(clipped.on_screen_reason, 'clipped-by-mount');
  assert.ok(clipped.bar.bottom > mount.bottom);
  // The same bar inside the panel is on screen.
  assert.equal(layoutReport({ bar: rect(0, 240, 320, 160), mount }).on_screen, true);
  // A visible area the caller supplies is honoured too, and the basis names both boxes.
  const outside = layoutReport({ bar: rect(0, 700, 320, 160), mount: rect(0, 0, 320, 900), viewport: rect(0, 0, 320, 640) });
  assert.equal(outside.on_screen, false);
  assert.equal(outside.on_screen_reason, 'outside-viewport');
  assert.equal(outside.on_screen_basis, 'mount+viewport');
});

test('the quickbar overlap is measured, and a floating bar is lifted clear of it', () => {
  const quickbar = rect(0, 800, 393, 44);      // the shell's own row, flush with the bottom of the panel
  const over = layoutReport({ bar: rect(0, 740, 393, 160), quickbar });
  assert.equal(over.overlaps_quickbar, true);
  assert.deepEqual({ width: over.overlap.width, height: over.overlap.height }, { width: 393, height: 44 });
  assert.equal(over.on_screen, true, 'with no box to measure against, a bar that rendered a real box counts as on screen');
  assert.equal(over.on_screen_basis, 'bar', 'and the basis says exactly what it was measured against');

  const { controls, mount, byTouch } = harness({ floating: true });
  mount.rect = rect(0, 0, 393, 844);
  controls.root.rect = rect(0, 700, 393, 144);           // in flow, its lower half over the quickbar
  controls.groups.movement.rect = rect(6, 700, 164, 164);
  for (const direction of PAD_DIRECTIONS) byTouch(direction).rect = rect(6, 700, 52, 52);
  assert.equal(controls.geometry({ quickbar }).overlaps_quickbar, true);

  const lifted = controls.avoidQuickbar(quickbar);
  assert.deepEqual({ applied: lifted.applied, offset: lifted.offset }, { applied: true, offset: 44 + QUICKBAR_GAP });
  assert.equal(controls.root.style.bottom, `${44 + QUICKBAR_GAP}px`, 'the bar is lifted above the quickbar, not into it');
  // What the browser then does with that `bottom`: the whole box moves up by the offset.
  controls.root.rect = rect(0, 844 - lifted.offset - 144, 393, 144);
  const clear = controls.geometry({ quickbar });
  assert.equal(clear.overlaps_quickbar, false);
  assert.equal(clear.overlap, null);
  assert.equal(clear.on_screen, true);

  // An in-flow bar is left exactly where the flow put it.
  const plain = harness();
  assert.deepEqual({ ...plain.controls.avoidQuickbar(quickbar) }, { applied: false, reason: 'not-floating' });
  assert.equal('bottom' in plain.controls.root.style, false);

  // The lift is undone on destroy, so the module never leaves a style behind.
  controls.destroy();
  assert.equal('bottom' in controls.root.style, false, 'the property the lift added is removed, not nulled');
});

test('a floating bar lifts itself at mount when it is handed the quickbar', () => {
  const dom = createDom();
  const quickbar = dom.createElement('div');
  quickbar.rect = rect(0, 812, 393, 32);
  const controls = createTouchControls({
    document: dom, mount: dom.createElement('div'), input: { walk() {} }, floating: true, quickbar, coarsePointer: () => true,
    now: () => 0, schedule: () => 1, cancel: () => {}, reducedMotion: () => false, status: '',
  });
  assert.equal(controls.root.classList.contains(FLOATING_CLASS), true);
  assert.equal(controls.root.style.bottom, `${32 + QUICKBAR_GAP}px`);
});

// ---------------------------------------------------------------------------------------------
// The floating option.
// ---------------------------------------------------------------------------------------------
test('the floating option adds the overlay class, and the default leaves the bar in flow', () => {
  const plain = harness();
  assert.equal(plain.controls.floating, false);
  assert.equal(plain.controls.root.classList.contains(FLOATING_CLASS), false);
  assert.equal(plain.controls.root.className, 'nm-touch', 'the default is the class the stylesheet and the tests already know');

  const floating = harness({ floating: true });
  assert.equal(floating.controls.floating, true);
  assert.equal(floating.controls.root.classList.contains(FLOATING_CLASS), true);
  assert.match(floating.controls.root.className, /^nm-touch\b/);
  // The stylesheet owns the positioning; the module contributes the class it is defined on.
  assert.equal(FLOATING_CLASS, 'nm-touch-floating');
});

// ---------------------------------------------------------------------------------------------
// Targets and thumb reach.
// ---------------------------------------------------------------------------------------------
test('the bar publishes the target size it must reach: 44 px, or 52 px on a coarse pointer', () => {
  const fine = harness();
  assert.equal(fine.controls.targetSize, TOUCH_TARGET_MIN);
  assert.equal(fine.controls.root.style['--nm-touch-target'], '44px');

  const coarse = harness({ coarsePointer: () => true });
  assert.equal(coarse.controls.targetSize, TOUCH_TARGET_COARSE);
  assert.equal(coarse.controls.root.style['--nm-touch-target'], '52px');
  assert.equal(TOUCH_TARGET_COARSE >= TOUCH_TARGET_MIN, true);
  // The published size follows the pointer without a re-mount.
  coarse.controls.destroy();
  assert.equal('--nm-touch-target' in coarse.controls.root.style, false, 'the property is removed on destroy, not left behind');
});

test('the pad is measured at 52 px on a coarse pointer and is marked for the thumb', () => {
  const { controls, mount, byTouch } = harness({ coarsePointer: () => true, floating: true });
  mount.rect = rect(0, 0, 360, 780);
  controls.root.rect = rect(0, 620, 360, 160);
  controls.groups.movement.rect = rect(8, 620, 164, 164);
  for (const direction of PAD_DIRECTIONS) {
    const key = byTouch(direction);
    key.rect = rect(8, 620, 52, 52);
    assert.ok(PAD_GLYPHS[direction].length > 0);
  }
  const report = controls.geometry();
  assert.equal(report.minimum, 52);
  assert.equal(report.key_size.width, 52);
  assert.equal(report.key_size.height, 52);
  assert.equal(report.key_size.meets_minimum, true, 'a thumb presses the key, so the key is what is measured');
  assert.equal(report.pad_size.meets_minimum, true);
  assert.equal(report.on_screen, true);
  // Every group carries the zone a stylesheet places it by: the pad and the Use affordance on one
  // thumb, the camera on the other, the drawers in the middle.
  assert.deepEqual({ ...TOUCH_ZONES }, { movement: 'bottom-left', use: 'bottom-left', camera: 'bottom-right', actions: 'bottom-centre' });
  for (const [name, zone] of Object.entries(TOUCH_ZONES)) {
    const node = name === 'use' ? byTouch(USE_AFFORDANCE.name) : controls.groups[name];
    assert.equal(node.getAttribute('data-nm-zone'), zone, `${name} must declare its zone`);
  }
  for (const name of ['movement', 'camera', 'actions']) {
    assert.equal(controls.groups[name].getAttribute('aria-label').length > 0, true);
  }
  assert.equal(controls.zones.movement, 'bottom-left');
});

// ---------------------------------------------------------------------------------------------
// The Use affordance beside the pad.
// ---------------------------------------------------------------------------------------------
test('Use sits beside the pad, is a real button, and is enabled only when the world has a fixture', () => {
  const { controls, mount, setFixture, byTouch } = harness();
  const use = byTouch(USE_AFFORDANCE.name);
  assert.ok(use, 'the interaction affordance exists');
  assert.equal(use.tagName, 'BUTTON');
  assert.equal(use.type, 'button');
  assert.equal(use.getAttribute('data-nm-touch'), 'use');
  assert.equal(use.getAttribute('data-nm-beside'), 'pad', 'the control is placed with the pad, not in the far action row');
  assert.equal(use.textContent, USE_AFFORDANCE.glyph);
  assert.ok(use.getAttribute('aria-label').length > 0);
  // It is a child of the pad group, whose grid gives it its own cell; the drawer row keeps its own
  // Use as well, and the two are separate controls with separate names.
  assert.equal(controls.groups.movement.children.includes(use), true);
  assert.equal(controls.buttons.get('use'), use);
  assert.notEqual(controls.buttons.get('interact'), use);
  assert.equal(use.className, 'nm-touch-action', 'the control carries only the class the stylesheet already styles');
  assert.equal(use.disabled, true, 'no fixture, nothing to use');
  // The bar's own order is unchanged: the pad (with Use in it), the camera, then the drawers.
  assert.deepEqual(controls.root.children.map((child) => child.className).slice(0, 3), ['nm-touch-pad', 'nm-touch-camera', 'nm-touch-actions']);
  setFixture(true);
  assert.equal(use.disabled, false);
  assert.equal(touchModel({ input: { interact() {} }, fixture: true }).use.enabled, true);
  assert.equal(touchModel({ input: {}, fixture: true }).use.enabled, false);
  assert.equal(mount.children[0], controls.root);
});

test('a drag never fires Use: one gesture is either a tap or a drag, and a cancelled press acts too', () => {
  const { sent, byTouch } = harness({ fixture: true });
  const use = byTouch('use');
  const walk = byTouch('up');

  // A press that slides past the drag threshold performs nothing at all.
  use.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
  use.dispatch('pointermove', { pointerId: 1, clientX: 100 + DRAG_THRESHOLD + 4, clientY: 100 });
  use.dispatch('pointerup', { pointerId: 1, clientX: 100 + DRAG_THRESHOLD + 4, clientY: 100 });
  assert.deepEqual(sent, [], 'a drag is not a use');

  // A tap inside the threshold is exactly one use, fired on release.
  use.dispatch('pointerdown', { pointerId: 2, clientX: 20, clientY: 20 });
  use.dispatch('pointerup', { pointerId: 2, clientX: 22, clientY: 21 });
  assert.deepEqual(sent, ['interact']);

  // A press the browser takes away (a call arriving, a gesture the browser claims) performs nothing.
  use.dispatch('pointerdown', { pointerId: 3, clientX: 20, clientY: 20 });
  use.dispatch('pointercancel', { pointerId: 3 });
  use.dispatch('pointerup', { pointerId: 3, clientX: 20, clientY: 20 });
  assert.deepEqual(sent, ['interact'], 'a cancelled press performs nothing, even when its release follows');

  // A camera drag on the world surface is never a gameplay action either.
  const drag = harness({ fixture: true });
  drag.surface.dispatch('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
  drag.surface.dispatch('pointermove', { pointerId: 1, clientX: 40, clientY: 0 });
  drag.surface.dispatch('pointerup', { pointerId: 1, clientX: 40, clientY: 0 });
  assert.deepEqual(drag.sent.filter((entry) => entry === 'interact'), []);
  assert.equal(drag.sent.filter((entry) => entry.startsWith('look')).length, 1);

  // And holding a movement key walks without using anything.
  walk.dispatch('pointerdown', { pointerId: 9 });
  assert.deepEqual(sent, ['interact', 'walk:up']);
  assert.equal(sent.filter((entry) => entry === 'interact').length, 1, 'a walk intent never becomes a use');
});

test('Use repeats while it is held, on the same cadence as a pad key, and stops on release', () => {
  const { clock, sent, byTouch } = harness({ fixture: true });
  const use = byTouch('use');
  use.dispatch('pointerdown', { pointerId: 1, clientX: 5, clientY: 5 });
  assert.deepEqual(sent, [], 'nothing is used while the press is still a tap');
  assert.equal(use.getAttribute('aria-pressed'), 'true', 'the pressed state is announced, not implied');
  clock.advance(HOLD_DELAY_MS);
  assert.deepEqual(sent, ['interact'], 'a hold becomes a use');
  clock.advance(HOLD_REPEAT_MS * 3);
  assert.equal(sent.length, 4, 'the repeat keeps the pad key cadence');
  use.dispatch('pointerup', { pointerId: 1, clientX: 5, clientY: 5 });
  assert.equal(sent.length, 4, 'the release does not use a second time');
  assert.equal(use.getAttribute('aria-pressed'), 'false');
  assert.equal(clock.pendingTimers, 0, 'a released control leaves no timer behind');
  clock.advance(HOLD_REPEAT_MS * 10);
  assert.equal(sent.length, 4);
});

test('Use is reachable by keyboard, and the click after a pointer press never double-fires it', () => {
  const { sent, byTouch } = harness({ fixture: true });
  const use = byTouch('use');
  // Enter or Space on the focused button is a click with no pointer detail.
  use.dispatch('click', { detail: 0 });
  assert.deepEqual(sent, ['interact']);
  // A pointer press already uses on release; the click the browser sends after it must not repeat.
  use.dispatch('pointerdown', { pointerId: 4, clientX: 10, clientY: 10 });
  use.dispatch('pointerup', { pointerId: 4, clientX: 10, clientY: 10 });
  use.dispatch('click', { detail: 1 });
  assert.deepEqual(sent, ['interact', 'interact'], 'one press, one use');
  // A disabled control accepts nothing, however it is activated.
  const quiet = harness({ fixture: false });
  quiet.byTouch('use').dispatch('click', { detail: 0 });
  quiet.byTouch('use').dispatch('pointerdown', { pointerId: 5, clientX: 0, clientY: 0 });
  quiet.byTouch('use').dispatch('pointerup', { pointerId: 5, clientX: 0, clientY: 0 });
  assert.deepEqual(quiet.sent, []);
});

// ---------------------------------------------------------------------------------------------
// The module's own promises about layout.
// ---------------------------------------------------------------------------------------------
test('no layout math depends on a window width, and the geometry comes from element rectangles', () => {
  assert.match(source, /getBoundingClientRect/, 'the geometry is read from the elements themselves');
  assert.doesNotMatch(source, /innerWidth|innerHeight|outerWidth|matchMedia\('/, 'the module cannot read a viewport for itself');
  assert.doesNotMatch(source, /\bwindow\./);
  assert.doesNotMatch(source, /globalThis/);
  assert.doesNotMatch(source, /\bdocument\./);
  assert.doesNotMatch(source, /innerHTML/);
  // A caller that can measure a visible area passes it in; the module never assumes one.
  assert.match(source, /viewport/);
});

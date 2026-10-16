// The pointer half of the world's controls: mouse look, pointer capture, pointer lock, Escape,
// and the real DOM attachment. No browser is started; the canvas and the document are small fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { POINTER_DRAG_THRESHOLD } from '../src/camera-controls.js';
import { createGameInput, INTENT_KINDS, DRAG_YAW, DRAG_PITCH } from '../src/game-input.js';

function handlersMap() {
  const handlers = new Map();
  return {
    add(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    remove(name, fn) { const list = handlers.get(name) || []; const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1); },
    dispatch(name, event = {}) { for (const fn of [...(handlers.get(name) || [])]) fn(event); },
    count(name) { return (handlers.get(name) || []).length; },
    total() { let n = 0; for (const list of handlers.values()) n += list.length; return n; },
  };
}

// A stand-in for the world canvas: it records capture and lock calls and can be dispatched to.
function fakeTarget() {
  const events = handlersMap();
  return {
    captured: [], released: [], lockRequests: 0,
    setPointerCapture(id) { this.captured.push(id); },
    releasePointerCapture(id) { this.released.push(id); },
    requestPointerLock() { this.lockRequests++; },
    addEventListener: events.add, removeEventListener: events.remove, dispatch: events.dispatch, count: events.count, total: events.total,
  };
}

function fakeDoc({ dialog = false, activeElement = null } = {}) {
  const events = handlersMap();
  return {
    dialog, activeElement, pointerLockElement: null, exited: 0,
    exitPointerLock() { this.exited++; this.pointerLockElement = null; },
    querySelector(selector) { return selector === 'dialog[open]' && this.dialog ? { open: true } : null; },
    addEventListener: events.add, removeEventListener: events.remove, dispatch: events.dispatch, count: events.count, total: events.total,
  };
}

function collect(options = {}) {
  const intents = [];
  const input = createGameInput({
    onIntent: (intent) => intents.push(intent),
    schedule: (run) => { run(); return 0; }, cancel: () => {}, ...options,
  });
  return { input, intents };
}

test('a pointer press captures the pointer and the release frees it', () => {
  const target = fakeTarget();
  const { input, intents } = collect({ target });
  assert.equal(POINTER_DRAG_THRESHOLD, 6);
  assert.deepEqual(input.pointerDown({ button: 0, pointerId: 7, clientX: 10, clientY: 10 }), { gesture: 'down', captured: 7 });
  assert.deepEqual(target.captured, [7]);
  assert.equal(input.captured, true);
  assert.equal(input.captureId, 7);
  assert.equal(input.pointerDown({ button: 2, pointerId: 8 }), null, 'a non-primary button never starts a gesture');
  input.pointerUp({ pointerId: 7 });
  assert.deepEqual(target.released, [7]);
  assert.equal(input.captured, false);
  assert.equal(input.pointerUp({ pointerId: 7 }), null, 'a second release does nothing');
  assert.ok(intents.some((intent) => intent.kind === 'capture' && intent.captured === false && intent.reason === 'pointerup'));
});

test('a short press is a pick and a real drag is a mouse look', () => {
  const target = fakeTarget();
  const { input, intents } = collect({ target, pickAt: ({ clientX }) => ({ x: 12, y: 7, clientX }) });
  input.pointerDown({ button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  assert.equal(input.pointerMove({ pointerId: 1, clientX: 3, clientY: 2 }).gesture, 'pick', 'a move below the threshold is still a click');
  assert.equal(intents.filter((intent) => intent.kind === 'look').length, 0);
  const up = input.pointerUp({ pointerId: 1, clientX: 3, clientY: 2 });
  assert.equal(up.gesture, 'pick');
  assert.deepEqual(up.selection, { x: 12, y: 7, clientX: 3 }, 'the picked tile comes from the injected raycast, not from the module');
  assert.ok(intents.some((intent) => intent.kind === 'pick'));

  input.setFacing({ yaw: 0, pitch: 0 });
  input.pointerDown({ button: 0, pointerId: 2, clientX: 100, clientY: 100 });
  assert.equal(input.pointerMove({ pointerId: 2, clientX: 130, clientY: 120 }).gesture, 'look');
  assert.ok(Math.abs(input.facing.yaw - (-30 * DRAG_YAW)) < 1e-12, 'a rightward drag turns the view by the renderer scale');
  assert.ok(Math.abs(input.facing.pitch - (20 * DRAG_PITCH)) < 1e-12, 'a downward drag tilts the view by the renderer scale');
  assert.ok(intents.some((intent) => intent.kind === 'look'));
  assert.equal(input.pointerUp({ pointerId: 2 }).gesture, 'look');
  assert.equal(input.dragging, false);
  for (const intent of intents) assert.ok(INTENT_KINDS.includes(intent.kind));
});

test('a pointer cancel releases the capture and the drag', () => {
  const target = fakeTarget();
  const { input } = collect({ target });
  input.pointerDown({ button: 0, pointerId: 4, clientX: 0, clientY: 0 });
  assert.deepEqual(input.pointerCancel(), { gesture: 'cancel', released: true });
  assert.equal(input.captured, false);
  assert.equal(input.dragging, false);
  assert.deepEqual(target.released, [4]);
});

test('Escape releases the capture and reports the cancel', () => {
  const target = fakeTarget();
  const { input, intents } = collect({ target });
  input.pointerDown({ button: 0, pointerId: 9, clientX: 0, clientY: 0 });
  assert.equal(input.captured, true);
  assert.deepEqual(input.press('Escape'), { kind: 'cancel', reason: 'escape' });
  assert.equal(input.captured, false);
  assert.deepEqual(target.released, [9]);
  assert.ok(intents.some((intent) => intent.kind === 'cancel' || intent.kind === 'capture'));
  assert.equal(input.press('Escape'), null, 'a second Escape has nothing to release');
});

test('Escape belongs to an open dialog and never steals it', () => {
  const target = fakeTarget(), doc = fakeDoc();
  const { input } = collect({ target, document: doc });
  input.pointerDown({ button: 0, pointerId: 3, clientX: 0, clientY: 0 });
  assert.equal(input.captured, true);
  doc.dialog = true;
  assert.equal(input.press('Escape'), null, 'the dialog handles its own Escape');
  assert.equal(input.captured, true, 'the capture is not released while a dialog owns the key');
  assert.equal(input.press('w'), null, 'and the dialog suspends the gameplay shortcuts');
});

test('pointer lock is independent of capture and Escape releases it too', () => {
  const target = fakeTarget(), doc = fakeDoc();
  const { input, intents } = collect({ target, document: doc });
  assert.equal(input.lock(), true);
  assert.equal(target.lockRequests, 1);
  doc.pointerLockElement = target;
  assert.equal(input.pointerLockChange(), true);
  assert.deepEqual(intents.at(-1), { kind: 'capture', captured: true, reason: 'pointerlock' });
  assert.equal(input.unlock(), true);
  assert.equal(doc.exited, 1);
  doc.pointerLockElement = target;
  assert.equal(input.escape(), true, 'Escape releases whichever capture is active');
  assert.equal(doc.exited, 2);
  doc.pointerLockElement = null;
  assert.equal(input.pointerLockChange(), false);
  assert.deepEqual(intents.at(-1), { kind: 'capture', captured: false, reason: 'pointerlock' });
  assert.equal(createGameInput({ onIntent() {}, document: fakeDoc() , target: { } }).lock(), false, 'lock is a safe no-op without an API');
});

test('attach wires the world canvas and the document, and detach removes every listener', () => {
  const target = fakeTarget(), doc = fakeDoc();
  const { input, intents } = collect({ target, document: doc, worldContext: () => ({ agent: true }) });
  const teardown = input.attach();
  for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) assert.equal(target.count(name), 1, `${name} is bound to the canvas`);
  assert.equal(doc.count('keydown'), 1);
  assert.equal(doc.count('pointerlockchange'), 1);
  target.dispatch('pointerdown', { button: 0, pointerId: 5, clientX: 0, clientY: 0 });
  assert.equal(input.captured, true);
  target.dispatch('pointermove', { pointerId: 5, clientX: 4, clientY: 0 });
  target.dispatch('pointermove', { pointerId: 5, clientX: 44, clientY: 0 });
  assert.ok(intents.some((intent) => intent.kind === 'look'), 'a canvas drag turns the view');
  let prevented = 0;
  doc.dispatch('keydown', { key: 'w', target: { tagName: 'BODY' }, preventDefault() { prevented++; } });
  assert.ok(intents.some((intent) => intent.kind === 'move'), 'a document key press moves the resident');
  assert.equal(prevented, 1, 'a control key is prevented so the page never scrolls');
  doc.dispatch('keydown', { key: 'w', target: { tagName: 'TEXTAREA' }, preventDefault() { prevented++; } });
  assert.equal(prevented, 1, 'typing in a field is neither prevented nor turned into a move');
  const removed = teardown();
  assert.ok(removed >= 6);
  assert.equal(target.total(), 0);
  assert.equal(doc.total(), 0);
});

test('no movement, look, interaction or build intent ever carries a position', () => {
  const target = fakeTarget();
  const { input, intents } = collect({ target, worldContext: () => ({ agent: true, frontier: true, palette: ['stone'], fixture: true }) });
  input.press('w'); input.press('q'); input.press('Enter'); input.press('1'); input.press('v');
  input.pointerDown({ button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  input.pointerMove({ pointerId: 1, clientX: 50, clientY: 0 });
  input.pointerUp({ pointerId: 1 });
  for (const intent of intents) {
    if (intent.kind === 'pick') continue;
    assert.equal('x' in intent || 'y' in intent || 'z' in intent, false, `${intent.kind} never carries a coordinate`);
  }
});

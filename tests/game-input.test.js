// The gameplay half of the world's controls: two camera modes, movement/interaction/building
// intents, the key map and the suspension rules.
//
// These tests drive the module directly (no browser, no DOM). The pointer-capture and DOM-attachment
// half is in tests/game-input-capture.test.js. Driving a real browser is the job of `npm run browser`;
// this file deliberately starts nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_MODES, DEFAULT_CAMERA_MODE, CAMERA_TOGGLE_KEYS, EYE_HEIGHT, THIRD_PERSON_MAX_STEP, MAX_PITCH,
  INTERACTION_KEY_LABEL, CONTROL_HINTS, SUSPEND_REASONS, SHORTCUT_EXEMPT_TAGS, INTERACTION_KEYS, WALK_KEYS, TURN_KEYS,
  normalizeCameraMode, wrapYaw, clampPitch, firstPersonView, cameraView, createViewBlocker,
  shortcutSuspended, createSuspension, controlHint, targetHint, cameraWalkDirection,
} from '../src/camera-controls.js';
import { createGameInput, INTENT_KINDS, LOOK_STEP } from '../src/game-input.js';

// Collect every intent a controller emits, with an immediate look scheduler so each look lands now.
function collect(options = {}) {
  const intents = [];
  const input = createGameInput({
    onIntent: (intent) => intents.push(intent),
    schedule: (run) => { run(); return 0; }, cancel: () => {}, ...options,
  });
  return { input, intents, kinds: intents.map((intent) => intent.kind) };
}

test('two camera modes exist with a first-person default and a normalising guard', () => {
  assert.deepEqual([...CAMERA_MODES], ['first-person', 'third-person']);
  assert.equal(DEFAULT_CAMERA_MODE, 'first-person');
  assert.equal(normalizeCameraMode('third-person'), 'third-person');
  assert.equal(normalizeCameraMode('first-person'), 'first-person');
  for (const value of ['orbit', '', null, undefined, 0, {}, 'THIRD-PERSON']) assert.equal(normalizeCameraMode(value), 'first-person', 'an unknown mode can never select a third mode');
  assert.deepEqual([...CAMERA_TOGGLE_KEYS], ['v']);
});

test('the first-person eye matches the shipped camera geometry', () => {
  assert.equal(EYE_HEIGHT, 1.35);
  const north = firstPersonView({ x: 10, y: 6, z: 0 }, { yaw: 0, pitch: 0 });
  assert.deepEqual(north.eye, { x: 10.5, y: 1.35, z: 6.5 });
  assert.ok(Math.abs(north.direction.x) < 1e-12);
  assert.ok(Math.abs(north.direction.z + 1) < 1e-12, 'yaw 0 looks north, which is -y (here -z)');
  const west = firstPersonView({ x: 0, y: 0, z: 2 }, { yaw: Math.PI / 2, pitch: 0 });
  assert.ok(Math.abs(west.direction.x + 1) < 1e-12, 'yaw pi/2 looks west');
  assert.equal(west.eye.y, 3.35, 'the eye sits one layer above a stored z of 2');
  assert.equal(wrapYaw(3 * Math.PI), -Math.PI, 'a yaw wraps into [-pi, pi]');
  assert.equal(clampPitch(9), MAX_PITCH);
  assert.equal(clampPitch(-9), -MAX_PITCH);
  assert.equal(clampPitch(Infinity), 0, 'a non-finite pitch falls back to level instead of throwing');
});

test('third person pulls back along the ground at the resident layer and never rises', () => {
  const position = { x: 4, y: 4, z: 1 }, facing = { yaw: 0, pitch: 0 };
  const first = cameraView(position, facing, { mode: 'first-person' });
  const third = cameraView(position, facing, { mode: 'third-person', boomLength: 4, blocksView: () => false });
  assert.equal(first.mode, 'first-person');
  assert.equal(third.mode, 'third-person');
  assert.equal(third.eye.y, first.eye.y, 'third person keeps the first-person eye height and cannot look over a step a first-person player could not');
  assert.equal(third.layer, 1);
  assert.equal(third.distance, 4, 'an unobstructed boom reaches its full length');
  assert.equal(third.blocked, false);
  assert.ok(third.eye.z > first.eye.z, 'yaw 0 pulls the camera back toward +y');
  assert.deepEqual(third.target, first.eye, 'the camera looks back at the resident, not past it');
  assert.equal(third.target.y, first.eye.y);
});

test('the third-person boom stops at a blocking tile so it cannot see behind it', () => {
  const sampled = [];
  const blocksView = (x, y, layer) => { sampled.push([x, y, layer]); return y === 2; };
  const view = cameraView({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { mode: 'third-person', boomLength: 6, blocksView });
  assert.equal(view.blocked, true, 'a tile, not the boom length, stopped it');
  assert.equal(view.distance, 1, 'the last clear step is half a tile before the blocked tile');
  assert.equal(view.eye.z, 1.5);
  assert.ok(sampled.every(([, , layer]) => layer === 0), 'every sample is taken at the resident layer');
  assert.ok(sampled.some(([x, y]) => x === 0 && y === 2), 'the blocking tile was actually sampled');
  assert.ok(view.eye.z < 2.5, 'the camera never reaches the tile behind the wall');
});

test('the view blocker refuses solid tiles and any step above the resident layer', () => {
  const blocker = createViewBlocker({ isSolid: (x, y) => x === 5 && y === 5, layerAt: (x, y) => y === 3 ? 3 : 0, maxStep: THIRD_PERSON_MAX_STEP });
  assert.equal(blocker(5, 5, 0), true, 'solid scenery blocks the view');
  assert.equal(blocker(3, 3, 0), true, 'a column three layers above a layer 0 resident blocks the view');
  assert.equal(blocker(3, 3, 2), false, 'the same column is below the one-step climb from layer 2');
  assert.equal(blocker(1, 1, 0), false, 'open ground never blocks');
  assert.equal(createViewBlocker({ isSolid: () => false, layerAt: () => 5, maxStep: 2 })(0, 0, 3), false, '5 is not more than 3 + 2');
  assert.equal(createViewBlocker({ isSolid: () => false, layerAt: () => 6, maxStep: 2 })(0, 0, 3), true, '6 is more than 3 + 2');
  assert.throws(() => createViewBlocker({ isSolid: 1 }), TypeError);
  const view = cameraView({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { mode: 'third-person', boomLength: 5, blocksView: blocker });
  assert.equal(view.blocked, true, 'the elevation-aware blocker feeds the real boom');
});

test('a resident with no clear tile behind falls back to its own eye', () => {
  const position = { x: 7, y: 9, z: 2 };
  const view = cameraView(position, { yaw: 1.2, pitch: 0 }, { mode: 'third-person', blocksView: () => true });
  const first = firstPersonView(position, { yaw: 1.2, pitch: 0 });
  assert.deepEqual(view.eye, first.eye);
  assert.equal(view.distance, 0);
  assert.equal(view.blocked, true);
  assert.throws(() => cameraView(position, {}, { mode: 'third-person', blocksView: 5 }), TypeError);
});

test('the key map has one source of truth and the interaction label names the bound keys', () => {
  assert.equal(INTERACTION_KEY_LABEL, 'Enter, Space or I');
  assert.deepEqual([...INTERACTION_KEYS], ['Enter', ' ', 'i']);
  // The label must name every bound key and must not advertise the turn key E.
  assert.match(INTERACTION_KEY_LABEL, /Enter/);
  assert.match(INTERACTION_KEY_LABEL, /Space/);
  assert.match(INTERACTION_KEY_LABEL, /\bI\b/);
  assert.equal(/E to interact/.test(INTERACTION_KEY_LABEL), false);
  assert.equal(CONTROL_HINTS.playing, 'WASD to walk · Drag to look · Enter, Space or I to interact');
  assert.equal(CONTROL_HINTS.observing, 'Drag to look · Click the map to explore');
  assert.match(CONTROL_HINTS.firstPerson, /Enter, Space or I to interact/);
  assert.match(CONTROL_HINTS.firstPerson, /V switches view/);
  assert.equal(controlHint({ playing: true, mode: 'first-person' }), CONTROL_HINTS.firstPerson);
  assert.equal(controlHint({ playing: true, mode: 'third-person' }), CONTROL_HINTS.playing);
  assert.equal(controlHint({ playing: false }), CONTROL_HINTS.observing);
  assert.equal(targetHint({ label: 'Bench' }), 'Bench · Enter, Space or I to interact');
  assert.equal(targetHint(null), 'Aim at a place or object to interact');
  assert.equal(/E to interact/.test(CONTROL_HINTS.playing + CONTROL_HINTS.observing + CONTROL_HINTS.firstPerson + targetHint({ label: 'Bench' })), false, 'no shipped hint still advertises E');
});

test('walking is routed as a direction intent and never as a position', () => {
  const { input, intents } = collect({ worldContext: () => ({ agent: true }) });
  assert.deepEqual(input.press('w'), { kind: 'move', direction: 'up' });
  assert.deepEqual(intents.at(-1), { kind: 'move', direction: 'up' });
  for (const [key, direction] of Object.entries(WALK_KEYS)) assert.deepEqual(input.press(key), { kind: 'move', direction });
  // First person walks the way the camera faces; third person walks the absolute cardinal.
  input.setFacing({ yaw: Math.PI / 2, pitch: 0 });
  assert.deepEqual(input.press('w'), { kind: 'move', direction: cameraWalkDirection('up', Math.PI / 2) });
  assert.equal(input.press('w').direction, 'left');
  input.setCameraMode('third-person', { silent: true });
  assert.deepEqual(input.press('w'), { kind: 'move', direction: 'up' }, 'the orbit view keeps the absolute cardinal');
  for (const intent of intents) {
    assert.equal('x' in intent || 'y' in intent || 'z' in intent, false, 'no intent ever carries a position');
    assert.ok(INTENT_KINDS.includes(intent.kind));
  }
});

test('turning is a look that carries the facing and no walking direction', () => {
  const { input, intents } = collect({ worldContext: () => ({ agent: true }) });
  const turned = input.press('q');
  assert.equal(turned.kind, 'look');
  assert.equal('direction' in turned, false, 'a look never carries a walking direction');
  assert.equal(wrapYaw(Math.PI / 4 + LOOK_STEP), turned.yaw);
  assert.deepEqual(intents.at(-1), turned);
  input.setFacing({ yaw: 0, pitch: 0 });
  assert.equal(input.press('r').pitch, TURN_KEYS.r.pitch);
  assert.equal(input.press('f').pitch, 0, 'R then F returns to level');
  for (const [key, expected] of Object.entries(TURN_KEYS)) {
    input.setFacing({ yaw: 0, pitch: 0 });
    const intent = input.press(key);
    assert.equal(intent.kind, 'look');
    assert.ok(Math.abs(intent.yaw - wrapYaw(expected.yaw)) < 1e-12);
    assert.ok(Math.abs(intent.pitch - expected.pitch) < 1e-12);
  }
  // In turn mode the WASD keys rotate instead of walking, by the same step app.js uses.
  const turning = collect({ worldContext: () => ({ agent: true, lookMode: true }) });
  turning.input.setCameraMode('third-person', { silent: true });
  turning.input.setFacing({ yaw: 0, pitch: 0 });
  assert.deepEqual(turning.input.press('w'), { kind: 'look', yaw: 0, pitch: -LOOK_STEP });
  turning.input.setFacing({ yaw: 0, pitch: 0 });
  const sideways = turning.input.press('a');
  assert.deepEqual(sideways, { kind: 'look', yaw: LOOK_STEP, pitch: 0 });
  assert.equal('direction' in sideways, false);
});

test('a look burst coalesces to one intent per window and a cancelled look never fires', () => {
  let now = 10_000, pending = null, canceled = 0;
  const { input, intents } = collect({
    clock: () => now,
    schedule: (run, delay) => { pending = { run, at: now + delay }; return pending; },
    cancel: () => { canceled++; pending = null; }, lookDelay: 150,
    worldContext: () => ({ agent: true }),
  });
  input.press('q');
  assert.equal(intents.filter((intent) => intent.kind === 'look').length, 1, 'the first turn sends now');
  for (let index = 0; index < 10; index++) input.press('q');
  assert.equal(intents.filter((intent) => intent.kind === 'look').length, 1, 'a burst inside the window is coalesced');
  assert.equal(input.pendingLook, true);
  now += 149; assert.equal(intents.length, 1, 'nothing fires early');
  now += 1; pending.run();
  assert.equal(intents.filter((intent) => intent.kind === 'look').length, 2, 'one coalesced look is sent at the window end');
  input.press('e'); assert.equal(input.pendingLook, true);
  input.setCameraMode('third-person');
  assert.ok(canceled >= 1, 'a camera switch cancels a pending look');
  assert.equal(input.pendingLook, false);
});

test('interaction and building route as intents and never replace each other', () => {
  const context = { agent: true, frontier: true, palette: ['stone', 'wood', 'glass'], fixture: true, building: false };
  const { input, intents } = collect({ worldContext: () => context });
  assert.deepEqual(input.press('3'), { kind: 'build', type: 'glass' });
  assert.deepEqual(input.press('9'), null, 'a digit outside the palette selects nothing');
  for (const key of INTERACTION_KEYS) assert.deepEqual(input.press(key), { kind: 'interact' }, `${key} uses the aimed fixture`);
  context.building = true;
  assert.equal(input.press('Enter'), null, 'building keeps its own keys, so the interaction key stands down');
  context.building = false; context.fixture = false;
  assert.equal(input.press('Enter'), null, 'with no fixture picked the interaction key stays unbound');
  assert.ok(intents.some((intent) => intent.kind === 'interact'));
  const visitor = collect({ worldContext: () => ({ agent: false, fixture: true, building: false }) });
  assert.deepEqual(visitor.input.press('Enter'), { kind: 'interact' }, 'a visitor who picked a fixture can still ask; the server decides');
});

test('the view key toggles the camera mode and reports the new mode', () => {
  const { input, intents } = collect({ worldContext: () => ({ agent: true }) });
  assert.equal(input.cameraMode, 'first-person');
  assert.deepEqual(input.press('v'), { kind: 'camera', mode: 'third-person' });
  assert.equal(input.cameraMode, 'third-person');
  assert.deepEqual(intents.at(-1), { kind: 'camera', mode: 'third-person' });
  assert.deepEqual(input.press('v'), { kind: 'camera', mode: 'first-person' });
  assert.equal(input.press('v', { tagName: 'TEXTAREA' }), null, 'typing never switches the camera');
  const silent = collect({ worldContext: () => ({}) });
  assert.equal(silent.input.press('v'), null, 'the view key is unbound without a resident');
  assert.equal(silent.input.setCameraMode('third-person'), 'third-person');
  assert.equal(silent.intents.length, 1);
  assert.equal(silent.input.setCameraMode('third-person'), 'third-person', 'setting the same mode emits nothing');
  assert.equal(silent.intents.length, 1);
});

test('a focused control, a dialog, a modifier or a menu suspends the shortcuts and they resume', () => {
  assert.deepEqual([...SHORTCUT_EXEMPT_TAGS], ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY']);
  assert.equal(shortcutSuspended({ tagName: 'textarea' }), true);
  assert.equal(shortcutSuspended({ tagName: 'BUTTON' }), true, 'a focused button keeps Enter and Space for itself');
  assert.equal(shortcutSuspended({ tagName: 'SUMMARY' }), true, 'a disclosure keeps native Enter and Space activation');
  assert.equal(shortcutSuspended({ isContentEditable: true }), true);
  assert.equal(shortcutSuspended({ dialogOpen: true }), true);
  assert.equal(shortcutSuspended({ modifier: true }), true);
  assert.equal(shortcutSuspended({ tagName: 'BODY' }), false);

  const { input, intents } = collect({ worldContext: () => ({ agent: true }) });
  for (const event of [{ tagName: 'TEXTAREA' }, { tagName: 'INPUT' }, { tagName: 'SUMMARY' }, { isContentEditable: true }, { dialogOpen: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(input.press('w', event), null, `${JSON.stringify(event)} suspends movement`);
    assert.equal(input.press('Enter', event), null, 'the same suspension covers interaction');
    assert.equal(input.press('v', event), null, 'and the view key');
  }
  assert.equal(intents.length, 0, 'a suspended shortcut emits nothing at all');

  // Two independent reasons: both must resume before the controls come back.
  assert.equal(input.suspend('menu'), 1);
  assert.equal(input.suspended, true);
  assert.equal(input.press('w'), null);
  assert.equal(input.suspend('chat'), 2);
  assert.equal(input.resume('menu'), 1);
  assert.equal(input.suspended, true, 'one suspension still stands');
  assert.equal(input.press('w'), null);
  assert.equal(input.resume('chat'), 0);
  assert.equal(input.suspended, false);
  assert.deepEqual(input.press('w'), { kind: 'move', direction: 'up' }, 'the shortcuts resume unchanged');
  assert.equal(input.suspend('custom'), 1); input.resumeAll(); assert.equal(input.suspended, false);

  const shell = collect({ worldContext: () => ({ agent: true }), isSuspended: () => true });
  assert.equal(shell.input.suspended, true);
  assert.equal(shell.input.press('w'), null, 'the shell can suspend through its own predicate (an open drawer)');
  assert.deepEqual(input.suspendReasons, []);
  assert.ok(SUSPEND_REASONS.includes('menu') && SUSPEND_REASONS.includes('typing'));
  const set = createSuspension(['menu']);
  assert.equal(set.suspended, true); assert.equal(set.resume('menu'), 0); assert.equal(set.suspended, false);
});

test('every gameplay action is reachable without a pointer (keyboard/text parity)', () => {
  const context = { agent: true, frontier: true, palette: ['stone', 'wood'], fixture: true, building: false };
  const { input } = collect({ worldContext: () => context });
  const reachable = [
    ...Object.keys(WALK_KEYS).map((key) => [key, 'move']),
    ...Object.keys(TURN_KEYS).map((key) => [key, 'look']),
    ...INTERACTION_KEYS.map((key) => [key, 'interact']),
    ['1', 'build'], ['2', 'build'], ['v', 'camera'],
  ];
  for (const [key, kind] of reachable) {
    const intent = input.press(key);
    assert.ok(intent, `${key} must produce an intent`);
    assert.equal(intent.kind, kind, `${key} asks for ${kind}`);
  }
  for (const key of ['z', 'Tab', 'F5', 'Escape']) assert.equal(input.press(key, { agent: true }), null, `${key} is not a gameplay shortcut here`);
});

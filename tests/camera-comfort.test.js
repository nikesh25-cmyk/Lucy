// The comfort contract of the world camera: an orbit that can look level and upward, one clamped
// zoom range shared by both cameras, a bounded hover channel, and easing that is presentation only.
//
// There is no browser in this runner, so every assertion below is about the numbers the modules
// return — pitch limits, distances, field of view, rates, identities — and never about a rendered
// pixel or a started server. The parts that can only exist in a page (a real wheel event over a real
// panel, a real pinch, the drawn frame) are named as limitations in
// docs/handoff/task-camera-comfort.md; what is checked here is the wiring those paths must use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ORBIT_PITCH, ORBIT_DISTANCE, ORBIT_EYE_DROP, clampOrbitPitch, clampOrbitDistance,
  normalizeOrbit, orbitCamera, firstPersonCamera, createOrbitInput, hoverKey,
  WHEEL_TILES_PER_PIXEL, WHEEL_LINE_PIXELS, WHEEL_PAGE_PIXELS, normalizedWheelDelta, wheelZoom, pinchDistance,
  FOV_LIMITS, fovForDistance, LOOK_EASE, approach, easeRate, shortestTurn, approachOrbit,
} from '../src/voxel-geometry.js';
import { MAX_PITCH, EYE_HEIGHT, clampPitch, controlIntent, cameraView, createViewBlocker,
  HOVER_INTERVAL_MS, createHoverThrottle, zoomSuspended } from '../src/camera-controls.js';

const source = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

test('the orbit reaches level and upward while the boom still stops at the ground', () => {
  // The range itself. Level is a real value rather than the bottom of the clamp, and the top-down
  // end is not narrowed away.
  assert.ok(ORBIT_PITCH.min < 0, 'upward is inside the range, not clamped out of it');
  assert.ok(ORBIT_PITCH.max >= 1.22, 'the steep end of the shipped range is still reachable');
  assert.equal(normalizeOrbit({ pitch: 0 }).pitch, 0, 'level is exactly level');
  assert.equal(normalizeOrbit({ pitch: ORBIT_PITCH.min }).pitch, ORBIT_PITCH.min);
  assert.equal(normalizeOrbit({ pitch: -0.5 }).pitch, -0.5);
  assert.equal(normalizeOrbit({ pitch: -100 }).pitch, ORBIT_PITCH.min, 'the clamp still holds at the far end');
  assert.equal(normalizeOrbit({ pitch: 100 }).pitch, ORBIT_PITCH.max);
  assert.equal(normalizeOrbit({ pitch: NaN }).pitch, ORBIT_PITCH.default, 'a nonsense pitch is the default, never a fabricated angle');
  assert.equal(clampOrbitPitch(Infinity), ORBIT_PITCH.default, 'an unusable pitch is the default, never a fabricated angle');

  // A drag can actually reach all of it.
  const input = createOrbitInput({ initial: { pitch: ORBIT_PITCH.default, distance: ORBIT_DISTANCE.default } });
  assert.equal(input.drag(0, -10000).pitch, ORBIT_PITCH.min, 'dragging up reaches the highest view');
  assert.equal(input.drag(0, 10000).pitch, ORBIT_PITCH.max);
  assert.equal(createOrbitInput({ initial: { pitch: -0.4 } }).orbit.pitch, -0.4, 'a stored upward facing survives the input owner');
  assert.equal(createOrbitInput({ mode: 'first-person', initial: { pitch: -0.4 } }).orbit.pitch, -0.4);

  // The eye. Level puts it at the pivot, so the horizon runs across the middle of the frame.
  const level = orbitCamera({ x: 10, y: 6, z: 2 }, { yaw: Math.PI / 2, pitch: 0, distance: 17 });
  assert.equal(level.eye.y, level.target.y);
  assert.equal(level.floored, false);
  assert.deepEqual(level.look, level.target, 'the camera still aims at the resident');
  assert.equal(orbitCamera({ x: 10, y: 6, z: 2 }, { yaw: 0, pitch: 0.62 }).target.y, 2.75, 'the pivot keeps reading the stored elevation layer');

  // And the boom stops at the resident's own footing instead of sinking into the terrain, while the
  // aim point keeps rising so a continued push still tilts the view up.
  const up = orbitCamera({ x: 10, y: 6, z: 2 }, { yaw: 0, pitch: ORBIT_PITCH.min, distance: ORBIT_DISTANCE.max });
  assert.equal(up.floored, true, 'the ground stopped the boom');
  assert.ok(Math.abs(up.eye.y - (up.target.y - ORBIT_EYE_DROP)) < 1e-12, 'the eye is held exactly at the footing limit');
  assert.ok(up.look.y > up.target.y, 'the view is still aimed upward');
  assert.equal(up.look.x, up.target.x);
  assert.equal(up.look.z, up.target.z);

  for (let pitch = ORBIT_PITCH.min; pitch <= ORBIT_PITCH.max; pitch += 0.05) {
    for (const distance of [ORBIT_DISTANCE.min, 11, ORBIT_DISTANCE.default, ORBIT_DISTANCE.max]) {
      const view = orbitCamera({ x: 4, y: 9, z: 3 }, { yaw: -2.2, pitch, distance });
      assert.ok(view.eye.y >= view.target.y - ORBIT_EYE_DROP - 1e-9, `pitch ${pitch.toFixed(2)} at ${distance} keeps the eye above the footing`);
      assert.ok(Number.isFinite(view.eye.x) && Number.isFinite(view.eye.y) && Number.isFinite(view.eye.z));
      const reach = Math.hypot(view.look.x - view.eye.x, view.look.y - view.eye.y, view.look.z - view.eye.z);
      assert.ok(reach > 1, 'the aim point is never on top of the eye, so the view direction is always defined');
      assert.ok(view.look.y >= view.target.y, 'the aim point never drops below the pivot');
    }
  }

  // The distance keeps its shipped range in every path.
  assert.equal(normalizeOrbit({ distance: 400 }).distance, ORBIT_DISTANCE.max);
  assert.equal(normalizeOrbit({ distance: -10 }).distance, ORBIT_DISTANCE.min);
  assert.equal(normalizeOrbit({}).distance, ORBIT_DISTANCE.default);
  assert.equal(orbitCamera({ x: 0, y: 0, z: 0 }, { pitch: Infinity, distance: -10 }).orbit.distance, ORBIT_DISTANCE.min);
  assert.equal(createOrbitInput().zoom(1e6).distance, ORBIT_DISTANCE.max, 'the additive zoom is clamped too');
});

test('a look still changes no position and the first-person clamp is untouched', () => {
  assert.equal(MAX_PITCH, 1.4);
  assert.equal(clampPitch(9), MAX_PITCH);
  assert.equal(clampPitch(-9), -MAX_PITCH);
  assert.equal(clampPitch(Infinity), 0);
  const look = controlIntent('up', { lookMode: true });
  assert.deepEqual(look, { kind: 'look', turn: 'up' });
  assert.equal('direction' in look, false, 'a look never carries a walking direction');
  assert.deepEqual(controlIntent('left', { firstPerson: false }), { kind: 'move', direction: 'left' });
  const first = cameraView({ x: 4, y: 4, z: 1 }, { yaw: 0, pitch: -MAX_PITCH }, { mode: 'first-person' });
  assert.equal(first.eye.y, 1 + EYE_HEIGHT, 'the first-person eye is where it always was');
  assert.equal(first.mode, 'first-person');
  // The camera state is three camera numbers and nothing else: no module here can invent a tile.
  const orbit = createOrbitInput({ initial: { yaw: 0, pitch: 0, distance: 17 } });
  orbit.zoom(-4); orbit.rotate(0.4, -0.2);
  assert.deepEqual(Object.keys(orbit.orbit).sort(), ['distance', 'pitch', 'yaw']);
  const before = orbit.orbit.distance, dragged = orbit.drag(10, 0);
  assert.equal(dragged.distance, before, 'a drag changes the look, never the distance, and never a position');
  assert.notEqual(dragged.yaw, 0);
  // The boom blocker that already guarded the third-person camera is untouched.
  const blocker = createViewBlocker({ isSolid: (x, y) => x === 5 && y === 5, layerAt: (x, y) => y === 3 ? 3 : 0 });
  assert.equal(blocker(5, 5, 0), true);
  assert.equal(blocker(3, 3, 0), true, 'a column three layers above the resident still blocks the view');
  assert.equal(blocker(1, 1, 0), false);
  assert.equal(cameraView({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { mode: 'third-person', boomLength: 5, blocksView: blocker }).eye.y, EYE_HEIGHT);
  assert.deepEqual(firstPersonCamera({ x: 16, y: 16, z: 2 }, { yaw: 0, pitch: 0 }).eye, { x: 16.5, y: 3.35, z: 16.5 });
});

test('one wheel maps to a clamped distance, and that same distance is the first-person zoom', () => {
  assert.ok(WHEEL_TILES_PER_PIXEL > 0);
  assert.equal(normalizedWheelDelta(10, 0), 10, 'a pixel-mode wheel is already in pixels');
  assert.equal(normalizedWheelDelta(3, 1), 3 * WHEEL_LINE_PIXELS, 'a line-mode wheel is scaled');
  assert.equal(normalizedWheelDelta(1, 2), WHEEL_PAGE_PIXELS, 'a page-mode wheel is scaled');
  assert.equal(normalizedWheelDelta(NaN, 0), 0, 'an unusable delta moves nothing');
  assert.equal(normalizedWheelDelta(undefined, 0), 0);

  assert.ok(wheelZoom(ORBIT_DISTANCE.default, 100) > ORBIT_DISTANCE.default, 'scrolling down pulls the camera back');
  assert.ok(wheelZoom(ORBIT_DISTANCE.default, -100) < ORBIT_DISTANCE.default, 'scrolling up moves it in');
  assert.equal(wheelZoom(ORBIT_DISTANCE.default, 100000), ORBIT_DISTANCE.max);
  assert.equal(wheelZoom(ORBIT_DISTANCE.default, -100000), ORBIT_DISTANCE.min);
  assert.equal(wheelZoom(Infinity, 0), ORBIT_DISTANCE.default, 'an unusable distance falls back to the shipped default');
  assert.equal(wheelZoom(ORBIT_DISTANCE.default, NaN), ORBIT_DISTANCE.default);
  for (const pixels of [-1e6, -100, -1, 0, 1, 100, 1e6]) {
    const distance = wheelZoom(ORBIT_DISTANCE.default, pixels);
    assert.ok(distance >= ORBIT_DISTANCE.min && distance <= ORBIT_DISTANCE.max, `${pixels} px stays inside the shipped range`);
  }

  // A pinch asks for the same number by scale, clamped like every other zoom.
  assert.ok(pinchDistance(ORBIT_DISTANCE.default, 2) < ORBIT_DISTANCE.default, 'fingers apart is closer');
  assert.ok(pinchDistance(ORBIT_DISTANCE.default, 0.5) > ORBIT_DISTANCE.default);
  assert.equal(pinchDistance(ORBIT_DISTANCE.default, 1), ORBIT_DISTANCE.default);
  assert.equal(pinchDistance(ORBIT_DISTANCE.default, 0), ORBIT_DISTANCE.default, 'an unusable scale is a no-op, not a jump');
  assert.equal(pinchDistance(ORBIT_DISTANCE.default, NaN), ORBIT_DISTANCE.default);
  assert.equal(pinchDistance(ORBIT_DISTANCE.default, 1e6), ORBIT_DISTANCE.min);
  assert.equal(pinchDistance(ORBIT_DISTANCE.default, 1e-6), ORBIT_DISTANCE.max);

  // The same one number drives the first-person field of view, so zoom means "closer" in either view
  // and survives a switch between them.
  assert.ok(FOV_LIMITS.min < FOV_LIMITS.base && FOV_LIMITS.base < FOV_LIMITS.max);
  assert.equal(fovForDistance(ORBIT_DISTANCE.min), FOV_LIMITS.min);
  assert.equal(fovForDistance(ORBIT_DISTANCE.max), FOV_LIMITS.max);
  assert.ok(Math.abs(fovForDistance(ORBIT_DISTANCE.default) - FOV_LIMITS.base) < 2.5, 'the shipped distance is about the shipped field of view');
  assert.ok(fovForDistance(ORBIT_DISTANCE.min) < fovForDistance(ORBIT_DISTANCE.max), 'closer is narrower, so a zoom-in magnifies in both views');
  for (let distance = -40; distance <= 60; distance += 0.5) {
    const fov = fovForDistance(distance);
    assert.ok(fov >= FOV_LIMITS.min && fov <= FOV_LIMITS.max, `a field of view at distance ${distance} stays inside the limits`);
  }
});

test('the hover channel is bounded, names the target, and drops when the pointer leaves', () => {
  assert.equal(HOVER_INTERVAL_MS, 75);
  let now = 1000;
  const throttle = createHoverThrottle({ now: () => now });
  assert.equal(throttle.claim(), true, 'the first reading is immediate');
  assert.equal(throttle.claim(), false, 'a second reading inside the window is dropped');
  now += HOVER_INTERVAL_MS - 1;
  assert.equal(throttle.claim(), false, 'the window is not yet over');
  now += 1;
  assert.equal(throttle.claim(), true, 'the reading resumes at the end of the window');

  // Bounded: a fast pointer over a long window can never report faster than the rate.
  now = 0;
  let claims = 0;
  const fast = createHoverThrottle({ now: () => now });
  for (let move = 0; move < 600; move++) { if (fast.claim()) claims++; now += 4; }
  assert.ok(claims <= Math.floor(2400 / HOVER_INTERVAL_MS) + 1, `${claims} readings in 2400 ms is bounded by the rate`);
  assert.ok(claims >= 20, `${claims} readings is still responsive for an aim line`);
  assert.equal(fast.claim(), false, 'the rate still holds after the burst');
  assert.equal(fast.drop(), true, 'leaving the canvas discards the reading');
  assert.equal(fast.claim(), true, 'and the next move reports at once instead of waiting out a stale window');
  assert.equal(createHoverThrottle({ interval: -5, now: () => 0 }).claim(), true);
  assert.equal(createHoverThrottle({ now: () => 0 }).claim(), true, 'the default clock works without injection');

  // An aim line only needs to redraw when the thing under the pointer changed.
  assert.equal(hoverKey(null), '', 'nothing hovered is the empty reading');
  assert.equal(hoverKey({ x: 1.5, y: 2 }), '', 'a fractional tile is not addressable');
  assert.equal(hoverKey({ x: NaN, y: 2, type: 'terrain' }), '');
  const terrain = { x: 3, y: 4, z: 0, type: 'terrain', face: { x: 0, y: 0, z: 1 } };
  assert.equal(hoverKey(terrain), hoverKey({ ...terrain }), 'the same tile and face is the same reading');
  assert.notEqual(hoverKey(terrain), hoverKey({ ...terrain, x: 4 }));
  assert.notEqual(hoverKey(terrain), hoverKey({ ...terrain, y: 5 }));
  assert.notEqual(hoverKey(terrain), hoverKey({ ...terrain, z: 2 }));
  assert.notEqual(hoverKey(terrain), hoverKey({ ...terrain, type: 'object' }));
  assert.notEqual(hoverKey(terrain), hoverKey({ ...terrain, face: { x: 0, y: 1, z: 0 } }), 'a different cube face is a different reading');
  assert.equal(hoverKey({ x: 3, y: 4 }), hoverKey({ x: 3, y: 4, z: 0, face: undefined }), 'a pick with no face still has one identity');
  // The named object, where the renderer knows one, is part of the reading.
  const block = { x: 8, y: 8, z: 0, type: 'block', block: { id: 'bench-one' } };
  assert.notEqual(hoverKey(block), hoverKey({ ...block, block: { id: 'bench-two' } }), 'two blocks on one tile are two readings');
  assert.equal(hoverKey(block), hoverKey({ ...block, block: { id: 'bench-one', type: 'wood' } }), 'the same block is one reading whatever else its record carries');
  const person = { x: 10, y: 6, z: 0, type: 'participant', participant: { id: 'mayor' } };
  assert.notEqual(hoverKey(person), hoverKey({ ...person, participant: { id: 'builder' } }), 'two residents on one tile are two readings');
});

test('disabling capture makes zoom inert, and a panel keeps its own wheel', () => {
  assert.equal(zoomSuspended(), false, 'an open canvas zooms');
  assert.equal(zoomSuspended({ enabled: true, tagName: 'BODY' }), false);
  assert.equal(zoomSuspended({ enabled: false }), true, 'the shell switches every zoom gesture off');
  assert.equal(zoomSuspended({ enabled: false, tagName: 'BODY' }), true);
  assert.equal(zoomSuspended({ enabled: true, menuOpen: true }), true, 'an open menu or drawer');
  assert.equal(zoomSuspended({ enabled: true, dialogOpen: true }), true);
  assert.equal(zoomSuspended({ enabled: true, tagName: 'TEXTAREA' }), true, 'a text field holds focus');
  assert.equal(zoomSuspended({ enabled: true, tagName: 'input' }), true);
  assert.equal(zoomSuspended({ enabled: true, tagName: 'BUTTON' }), true, 'a focused panel button keeps the wheel');
  assert.equal(zoomSuspended({ enabled: true, isContentEditable: true }), true);
  assert.equal(zoomSuspended({ enabled: true, tagName: 'CANVAS' }), false);
});

test('easing is presentation only: it never overshoots and always lands on the stored value', () => {
  assert.ok(LOOK_EASE.rate > 0 && LOOK_EASE.rate < 1);
  assert.equal(approach(0, 10, 1), 10, 'rate 1 applies the stored value exactly');
  assert.equal(approach(10, 0, 1), 0);
  assert.equal(approach(0, 0.001), 0.001, 'a step smaller than the epsilon lands exactly on the target');
  assert.equal(approach(0, NaN, 1), 0, 'a non-finite target keeps the current value');
  let value = 0;
  for (let frame = 0; frame < 40; frame++) value = approach(value, 10);
  assert.equal(value, 10, 'the glide lands exactly on the stored value, so an animation can always stop');
  for (let current of [-10, -1, 0.5, 7, 1000]) {
    const next = approach(current, 10);
    assert.ok(next >= Math.min(current, 10) && next <= Math.max(current, 10), 'an eased step never overshoots its endpoints');
  }
  assert.ok(Math.abs(easeRate(LOOK_EASE.period) - LOOK_EASE.rate) < 1e-12, 'one frame eases by the shipped rate');
  assert.ok(Math.abs(easeRate(2 * LOOK_EASE.period) - (1 - (1 - LOOK_EASE.rate) ** 2)) < 1e-12, 'two frames ease as far as two frames should');
  assert.equal(easeRate(0), 0);
  assert.ok(easeRate(1000) < 1, 'a stalled frame eases quickly but never becomes a jump or an overshoot');
  assert.ok(Math.abs(easeRate(1000) - (1 - (1 - LOOK_EASE.rate) ** 8)) < 1e-12, 'a very long frame is capped at eight frames of easing');
  assert.ok(easeRate(33.4) > easeRate(16.7) && easeRate(16.7) > easeRate(8), 'a longer frame eases further');
  assert.ok(easeRate(8) >= 0);

  assert.ok(Math.abs(shortestTurn(3.1, -3.1) - (2 * Math.PI - 6.2)) < 1e-12, 'the wrap is crossed the short way');
  assert.ok(shortestTurn(3.1, -3.1) > 0);
  assert.equal(shortestTurn(0, Math.PI), Math.PI);
  assert.equal(shortestTurn(0, 0), 0);
  assert.equal(shortestTurn(NaN, 1), 1);
  assert.equal(shortestTurn(0.2, 5), 5 - 0.2 - 2 * Math.PI, 'a raw yaw past a full turn is still the short way');

  const target = { yaw: -3, pitch: 0, distance: ORBIT_DISTANCE.max };
  const wrapPi = (value) => ((value + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  const gapTo = (value) => Math.abs(wrapPi(value - target.yaw));
  let eased = { yaw: 3, pitch: ORBIT_PITCH.default, distance: ORBIT_DISTANCE.min }, frames = 0, settled = false, travelled = 0, gap = gapTo(3);
  while (!settled && frames < 500) {
    const next = approachOrbit(eased, target);
    const moved = Math.abs(wrapPi(next.yaw - eased.yaw));
    assert.ok(moved < Math.PI / 2, 'no single step is ever a spin');
    travelled += moved;
    gap = gapTo(next.yaw);
    eased = { yaw: next.yaw, pitch: next.pitch, distance: next.distance };
    settled = next.settled;
    frames++;
  }
  assert.equal(settled, true, 'the glide settles instead of animating forever');
  assert.ok(frames < 120, `it settles in ${frames} frames, not by grinding`);
  assert.deepEqual(eased, target, 'and it lands exactly on the stored orbit');
  // The whole glide travelled the short arc — 0.28 rad across the wrap — not the 6.0 rad long way.
  assert.ok(Math.abs(travelled - gapTo(3)) < 1e-9, `an eased look takes the short way round the wrap (travelled ${travelled})`);
  assert.ok(gap < LOOK_EASE.epsilon * 2);
  // Every eased step is one of the three camera numbers, and nothing else.
  const step = approachOrbit({ yaw: 0, pitch: 0, distance: ORBIT_DISTANCE.default }, { yaw: 1, pitch: 1, distance: 20 });
  assert.deepEqual(Object.keys(step).sort(), ['distance', 'pitch', 'settled', 'yaw']);
  assert.equal(approachOrbit({ yaw: 0, pitch: 0, distance: 17 }, { yaw: 0, pitch: 0, distance: 17 }).settled, true);
  const held = approachOrbit({ yaw: 0, pitch: 0, distance: 17 }, { yaw: 1, pitch: 1, distance: 20 }, 0);
  assert.equal(held.settled, false, 'rate 0 holds, it does not settle');
  assert.deepEqual([held.yaw, held.pitch, held.distance], [0, 0, 17], 'and it moves nothing');
});

test('the comfort modules stay dependency-free, offline and deterministic', () => {
  const controls = source('src/camera-controls.js'), geometry = source('src/voxel-geometry.js'), world = source('src/voxel-world.js');
  assert.equal(/^\s*import\s/m.test(controls), false, 'src/camera-controls.js still imports nothing at all');
  for (const [name, text] of [['camera-controls', controls], ['voxel-geometry', geometry], ['voxel-world', world]]) {
    assert.equal(/fetch\s*\(|XMLHttpRequest|sendBeacon|new WebSocket/.test(text), false, `${name} never issues a request of its own`);
    assert.equal(/Math\.random/.test(text), false, `${name} stays deterministic`);
  }
  // The wheel is the one gesture entry point in the renderer: registered non-passive so the page can
  // be held still, and gated before anything about the camera changes.
  assert.match(world, /WHEEL_LISTENER_OPTIONS = Object\.freeze\(\{ passive: false \}\)/);
  assert.match(world, /addEventListener\('wheel', wheel, WHEEL_LISTENER_OPTIONS\)/);
  assert.match(world, /removeEventListener\('wheel', wheel, WHEEL_LISTENER_OPTIONS\)/);
  assert.match(world, /if \(destroyed \|\| lost \|\| !lastSnapshot \|\| zoomSuspended\(zoomState\(\)\)\) return;/);
  // A hover is a bounded reading taken before the raycast, and it never becomes a pick.
  assert.match(world, /const orbitInput = createOrbitInput\(\{ onLook \}\), hover = createHoverThrottle\(\);/);
  assert.match(world, /if \(!hover\.claim\(\)\) return;/);
  assert.match(world, /const leave = \(\) => \{\n    if \(destroyed\) return;\n    hover\.drop\(\);/);
  assert.equal(/onHover[\s\S]{0,80}(pickWorld|walkTo)/.test(world), false, 'nothing in the renderer turns a hover into a walk');
  // The glide reads the stored orbit and writes only the camera.
  assert.match(world, /approachOrbit\(view, orbitInput\.orbit, rate\)/);
  assert.match(world, /camera\.fov = firstPerson \? fovForDistance\(view\.distance\) : FOV_LIMITS\.base;/);
});

// Presentation interpolation between the server's confirmed tiles. There is no browser here, so the
// tracker is driven with an injected clock: every assertion is about the value it hands the renderer,
// never about a drawn pixel. The point of the module is that the drawn avatar is always on the
// segment between the last two tiles the server confirmed and lands exactly on the newest one — so a
// viewer can never see a position the server did not store, and a reduced-motion viewer sees the
// stored tile immediately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DISPLAY_TWEEN_MS, TWEEN_SNAP_DISTANCE, displayCoords, createPresenceTracker } from '../src/camera-controls.js';

const source = (file) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
const app = source('app.js');
const theme = source('game-theme.css');

/** A clock the test moves by hand, so a tween can be sampled at an exact millisecond. */
function clock(start = 1000) { let now = start; return { now: () => now, advance: (ms) => (now += ms) }; }

test('the drawn point is on the segment and lands exactly on the confirmed tile', () => {
  const record = { from: { x: 0, y: 0, z: 0 }, confirmed: { x: 4, y: 0, z: 0 }, at: 0, duration: 100 };
  assert.deepEqual(displayCoords(record, 0), { x: 0, y: 0, z: 0 }, 'a tween starts where the avatar was drawn');
  assert.deepEqual(displayCoords(record, 100), { x: 4, y: 0, z: 0 }, 'and ends exactly on the confirmed tile');
  assert.deepEqual(displayCoords(record, 5000), { x: 4, y: 0, z: 0 }, 'a finished tween stays on the confirmed tile');
  // Sampled across the whole tween the point is monotonic and never outside [from, confirmed].
  let previous = -Infinity;
  for (let t = 0; t <= 120; t += 10) {
    const { x } = displayCoords(record, t);
    assert.ok(x >= 0 && x <= 4, `x=${x} at t=${t} must stay inside the segment`);
    assert.ok(x >= previous, `x=${x} at t=${t} must never move backwards`);
    previous = x;
  }
  // A zero-duration record (a snap) is the confirmed tile at every instant.
  const snapped = { from: { x: 9, y: 9, z: 0 }, confirmed: { x: 1, y: 2, z: 0 }, at: 0, duration: 0 };
  assert.deepEqual(displayCoords(snapped, 0), { x: 1, y: 2, z: 0 });
});

test('a one-tile step glides from the drawn tile and settles on the stored tile', () => {
  const c = clock();
  const presence = createPresenceTracker({ now: c.now });
  assert.equal(presence.confirm({ id: 'walker', x: 10, y: 6 }), presence.get('walker'), 'the first confirmed tile is the record');
  assert.equal(presence.get('walker').duration, 0, 'a first sighting does not glide');
  const record = presence.confirm({ id: 'walker', x: 10, y: 5 });
  assert.equal(record.duration, DISPLAY_TWEEN_MS, 'a real step starts a glide');
  assert.equal(presence.settling(), true);
  assert.deepEqual(presence.display('walker'), { x: 10, y: 6, z: 0 }, 'at once it is still on the old tile');
  c.advance(DISPLAY_TWEEN_MS / 2);
  const middle = presence.display('walker');
  assert.ok(middle.y < 6 && middle.y > 5, `halfway y=${middle.y} must be between the two tiles`);
  c.advance(DISPLAY_TWEEN_MS);
  assert.deepEqual(presence.display('walker'), { x: 10, y: 5, z: 0 }, 'once the glide elapses it is exactly the stored tile');
  assert.equal(presence.settling(), false, 'and the loop can stop');
  // The renderer's input is the item with the interpolated point, never a mutated confirmed record.
  const item = { id: 'walker', x: 10, y: 5, name: 'Walker' };
  assert.deepEqual(presence.record(item), { id: 'walker', x: 10, y: 5, z: 0, name: 'Walker' });
  assert.deepEqual(presence.get('walker').confirmed, { x: 10, y: 5, z: 0 }, 'the confirmed record is untouched');
});

test('a jump farther than one tile, or a world change, snaps instead of gliding', () => {
  const c = clock();
  const presence = createPresenceTracker({ now: c.now });
  presence.confirm({ id: 'walker', world_id: 'commons', x: 10, y: 6 });
  const travelled = presence.confirm({ id: 'walker', world_id: 'commons', x: 30, y: 12 });
  assert.equal(travelled.duration, 0, 'a long jump must not glide across the map');
  assert.deepEqual(presence.display('walker'), { x: 30, y: 12, z: 0 }, 'it is drawn at the new tile at once');
  assert.equal(presence.settling(), false);
  // An adjacent tile in a *different* world is still a snap: the tile numbers would be misleading.
  const crossed = presence.confirm({ id: 'walker', world_id: 'hall', x: 31, y: 12 });
  assert.equal(crossed.duration, 0, 'a world change snaps even when the tiles are adjacent');
  assert.equal(TWEEN_SNAP_DISTANCE, 1, 'the threshold is the one tile a step can cover');
  assert.deepEqual(presence.display('walker'), { x: 31, y: 12, z: 0 });
});

test('a reduced-motion viewer receives the stored tile immediately, with no glide at all', () => {
  const c = clock();
  const presence = createPresenceTracker({ now: c.now, reducedMotion: () => true });
  presence.confirm({ id: 'walker', x: 10, y: 6 });
  const stepped = presence.confirm({ id: 'walker', x: 10, y: 5 });
  assert.equal(stepped.duration, 0, 'no transition is scheduled for a reduced-motion viewer');
  assert.deepEqual(presence.display('walker'), { x: 10, y: 5, z: 0 }, 'the stored tile is drawn at once');
  assert.equal(presence.settling(), false, 'nothing is animating, so nothing needs a frame loop');
  // The predicate is read per confirm, so a preference that changes mid-session takes effect at once.
  let reduced = true;
  const live = createPresenceTracker({ now: c.now, reducedMotion: () => reduced });
  live.confirm({ id: 'walker', x: 0, y: 0 });
  reduced = false;
  assert.equal(live.confirm({ id: 'walker', x: 1, y: 0 }).duration, DISPLAY_TWEEN_MS, 'motion returns when the preference does');
});

test('reconcile drops the tween so a refused step is drawn at the stored tile again', () => {
  const c = clock();
  const presence = createPresenceTracker({ now: c.now });
  presence.confirm({ id: 'walker', x: 10, y: 6 });
  presence.confirm({ id: 'walker', x: 10, y: 5 });
  c.advance(DISPLAY_TWEEN_MS / 2);
  const mid = presence.display('walker');
  assert.ok(mid.y > 5 && mid.y < 6, 'the avatar is mid-glide');
  assert.equal(presence.reconcile('walker'), true, 'a known avatar is reconciled');
  assert.deepEqual(presence.display('walker'), { x: 10, y: 5, z: 0 }, 'and is drawn at its stored tile immediately');
  assert.equal(presence.settling(), false, 'the tween is gone');
  assert.equal(presence.reconcile('nobody'), false, 'an unknown avatar is a no-op, not an error');
});

test('an unknown participant is passed through untouched and the tracker forgets on clear', () => {
  const presence = createPresenceTracker({ now: () => 0 });
  const item = { id: 'stranger', x: 3, y: 4 };
  assert.equal(presence.record(item), item, 'a participant with no record is drawn as published');
  assert.equal(presence.display('stranger'), null);
  presence.confirm({ id: 'walker', x: 1, y: 1 });
  assert.equal(presence.size, 1);
  presence.clear();
  assert.equal(presence.size, 0, 'a world or session change forgets every record');
  assert.equal(presence.entries().length, 0);
});

test('the shell wires the tracker and switches the touch layer through its own control', () => {
  assert.match(app, /createPresenceTracker\(\{\s*now: \(\) => performance\.now\(\)/, 'app.js owns the tracker with its own clock');
  assert.match(app, /prefersReducedMotion\(globalThis\.matchMedia\)/, 'and reads the reduced-motion preference');
  assert.match(app, /function syncTouchEnabled\(\)\{[\s\S]*?touchControls\?\.setEnabled\(enabled\);/, 'the touch layer is switched off through setEnabled, not a stylesheet');
  assert.doesNotMatch(theme, /nm-touch/, 'the main stylesheet carries no touch rule, so the layer is styled in one place only');
});

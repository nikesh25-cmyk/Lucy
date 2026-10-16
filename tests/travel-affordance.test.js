// Travel affordance: the entrances from a place, made discoverable and reversible. The helper reads
// only the `portals` the server published for the world on screen, so it can offer no destination the
// server did not send, and it sorts the way back to the shared Commons (or the resident's home)
// ahead of the rest so a journey can always be undone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { travelRoutes, routeHint } from '../src/camera-controls.js';

const PORTALS = [
  { id: 'p-hall', label: 'Enter the Hall', x: 4, y: 6, target_world_id: 'hall' },
  { id: 'p-back', label: 'Return to the Commons', x: 0, y: 6, target_world_id: 'commons' },
  { id: 'p-far', label: 'Enter the Orchard', x: 18, y: 2, target_world_id: 'orchard' },
  { id: 'p-frontier', label: 'Frontier gateway', x: 19, y: 13, target_world_id: 'frontier:0:0' },
];

test('the way back is sorted first, then the nearest entrance, and each route names its distance', () => {
  const routes = travelRoutes(PORTALS, { x: 1, y: 6 }, { commons: 'commons', limit: -1 });
  assert.deepEqual(routes.map((route) => route.id), ['p-back', 'p-hall', 'p-far', 'p-frontier']);
  assert.equal(routes[0].back, true, 'the portal to the shared Commons is the reversible route');
  assert.equal(routes[0].distance, 1);
  assert.equal(routes[1].back, false);
  assert.equal(routes[1].distance, 3, 'the Hall entrance is three tiles from 1,6');
  assert.equal(routes[3].distance, 25);
});

test('a resident’s own home is reversible too, and the limit caps the list', () => {
  const portal = { id: 'home', label: 'Your cottage', x: 1, y: 1, target_world_id: 'home:abc' };
  const withHome = travelRoutes([...PORTALS, portal], { x: 0, y: 0 }, { home: 'home:abc', limit: -1 });
  assert.equal(withHome[0].id, 'home', 'the nearer way back is listed first');
  assert.equal(withHome[0].back, true);
  assert.equal(withHome[1].id, 'p-back', 'then the shared Commons exit, the other reversible route');
  assert.equal(withHome[1].back, true);
  assert.equal(withHome[2].back, false, 'and only then the entrances onward');
  const capped = travelRoutes(PORTALS, { x: 0, y: 0 }, { limit: 2 });
  assert.equal(capped.length, 2);
  assert.equal(travelRoutes(PORTALS, { x: 0, y: 0 }, { limit: 0 }).length, 0);
  assert.equal(travelRoutes(PORTALS, { x: 0, y: 0 }, { limit: -1 }).length, PORTALS.length, 'a negative limit keeps them all');
});

test('only a portal the server actually published becomes a route', () => {
  const routes = travelRoutes([
    { id: 'ok', label: 'Door', x: 1, y: 1, target_world_id: 'hall' },
    { id: 'no-target', label: 'Broken', x: 2, y: 2 },
    { id: 'no-tile', label: 'Floating', target_world_id: 'hall' },
    { id: 'fractional', label: 'Fuzzy', x: 1.5, y: 1, target_world_id: 'hall' },
    { id: 'camel', label: 'Alias', x: 3, y: 3, targetWorldId: 'library' },
    null, 'nonsense', undefined,
  ], { x: 0, y: 0 });
  assert.deepEqual(routes.map((route) => route.id), ['ok', 'camel'], 'a route needs an integer tile and a target');
  assert.equal(routes[1].target, 'library', 'the camelCase target the payload may carry is honoured');
  assert.deepEqual(travelRoutes(null, { x: 0, y: 0 }), [], 'no portal list is an empty list, never a crash');
});

test('a route label falls back to the portal name, and the hint states the place and the distance', () => {
  const [named] = travelRoutes([{ id: 'x', name: 'North gate', x: 2, y: 2, target_world_id: 'hall' }], { x: 0, y: 0 });
  assert.equal(named.label, 'North gate', 'the portal’s own name is kept when it has no label');
  const [unnamed] = travelRoutes([{ id: 'x', x: 2, y: 2, target_world_id: 'hall' }], { x: 0, y: 0 });
  assert.equal(unnamed.label, 'Entrance');
  const back = travelRoutes(PORTALS, { x: 1, y: 6 })[0];
  assert.equal(routeHint(back), 'Return to the Commons at 0, 6 · the way back · 1 tile away');
  const onward = travelRoutes(PORTALS, { x: 1, y: 6 })[1];
  assert.equal(routeHint(onward), 'Enter the Hall at 4, 6 · 3 tiles away');
  assert.equal(routeHint(null), '');
});

test('equal distances are ordered deterministically, so the list never reshuffles on a repaint', () => {
  const a = travelRoutes([{ id: 'b', label: 'B', x: 1, y: 0, target_world_id: 'x' }, { id: 'a', label: 'A', x: -1, y: 0, target_world_id: 'y' }], { x: 0, y: 0 });
  const b = travelRoutes([{ id: 'a', label: 'A', x: -1, y: 0, target_world_id: 'y' }, { id: 'b', label: 'B', x: 1, y: 0, target_world_id: 'x' }], { x: 0, y: 0 });
  assert.deepEqual(a.map((route) => route.id), b.map((route) => route.id));
  assert.deepEqual(a.map((route) => route.id), ['a', 'b'], 'alphabetical by label when the distance ties');
});

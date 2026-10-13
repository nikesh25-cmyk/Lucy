// A doorway or a frontier gate that is drawn but not walkable to is a promise the world cannot keep:
// the server only crosses when the resident stands on the exact gate tile (src/spaces.js), and only
// enters a room through a portal within one tile. These tests walk the real planner over the real
// generated terrain, so a gate that becomes unreachable by a terrain or occupancy change fails here
// rather than being discovered by a player who cannot leave an area.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getWorldDefinition, sharedWorldIds, frontierGates,
  FRONTIER_MIN_COORDINATE, FRONTIER_MAX_COORDINATE,
} from '../world.js';
import { planWalk } from '../src/world-walk.js';

const at = (point) => `${point.x},${point.y}`;
// Generous bounds so a genuinely long detour is not mistaken for an unreachable target, while a
// target walled off completely still exhausts the search and returns null.
const ROUTE = { maxSteps: 4096, maxVisited: 20000 };

test('every shared world keeps a walkable route from arrival to each of its doorways', () => {
  const unreachable = [];
  for (const id of sharedWorldIds) {
    const definition = getWorldDefinition(id);
    for (const portal of definition.portals || []) {
      if (!planWalk(definition, definition.start, { x: portal.x, y: portal.y }, ROUTE)) {
        unreachable.push(`${id} → ${portal.name || portal.targetWorldId || 'doorway'} at ${at(portal)}`);
      }
    }
  }
  assert.deepEqual(unreachable, [], 'a doorway a resident can see must be walkable to, or its crossing is unusable');
});

test('every frontier sector keeps a walkable route from arrival to each in-bounds gate', () => {
  const unreachable = [];
  let sectors = 0, gates = 0;
  for (let x = FRONTIER_MIN_COORDINATE; x <= FRONTIER_MAX_COORDINATE; x++) {
    for (let y = FRONTIER_MIN_COORDINATE; y <= FRONTIER_MAX_COORDINATE; y++) {
      const id = `frontier:${x}:${y}`;
      const definition = getWorldDefinition(id);
      sectors++;
      for (const gate of frontierGates(id)) {
        gates++;
        if (!planWalk(definition, definition.start, { x: gate.x, y: gate.y }, ROUTE)) {
          unreachable.push(`${id} → ${gate.direction} gate at ${at(gate)} to ${gate.targetWorldId}`);
        }
      }
    }
  }
  assert.equal(sectors, 256, 'the finite perimeter is 16x16 sectors and every one is checked');
  assert.ok(gates >= 256, `every sector offers at least one gate (checked ${gates})`);
  assert.deepEqual(unreachable, [], 'a gate the server accepts must be reachable on foot, or no resident can cross there');
});

test('an opened frontier neighbour is reachable in one step from the gate it answers', () => {
  // The crossing rule matches a gate by direction and tile. Arriving through it must place the
  // resident where this side's matching gate is, or the resident lands somewhere they cannot return from.
  const mismatched = [];
  for (let x = FRONTIER_MIN_COORDINATE; x <= FRONTIER_MAX_COORDINATE; x++) {
    for (let y = FRONTIER_MIN_COORDINATE; y <= FRONTIER_MAX_COORDINATE; y++) {
      const id = `frontier:${x}:${y}`;
      const definition = getWorldDefinition(id);
      for (const gate of frontierGates(id)) {
        const [neighbourX, neighbourY] = gate.targetWorldId.replace('frontier:', '').split(':').map(Number);
        if (neighbourX < FRONTIER_MIN_COORDINATE || neighbourX > FRONTIER_MAX_COORDINATE) continue;
        if (neighbourY < FRONTIER_MIN_COORDINATE || neighbourY > FRONTIER_MAX_COORDINATE) continue;
        const back = frontierGates(gate.targetWorldId).find((item) => item.targetWorldId === id);
        if (!back) { mismatched.push(`${id} → ${gate.direction}: ${gate.targetWorldId} has no gate back`); continue; }
        const neighbour = getWorldDefinition(gate.targetWorldId);
        if (back.x !== neighbour.start.x || back.y !== neighbour.start.y) {
          // Not fatal on its own: the arrival tile is the neighbour's start, so the return gate must
          // be walkable to from there.
          if (!planWalk(neighbour, neighbour.start, { x: back.x, y: back.y }, ROUTE)) {
            mismatched.push(`${gate.targetWorldId} cannot walk back to its ${back.direction} gate at ${at(back)}`);
          }
        }
      }
    }
  }
  assert.deepEqual(mismatched, [], 'a resident who crosses must be able to walk back to the gate they came through');
});

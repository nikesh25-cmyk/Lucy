import { test } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { createPortalJourney, planFrontierRoute } from '../src/world-navigation.js';
import { frontierGates } from '../world.js';

const portal = { x: 24, y: 1, target_world_id: 'frontier:0:-1' };
const actor = { id: 'agent-1', world_id: 'frontier:0:0', x: 20, y: 1 };
const setup = (overrides = {}) => {
  const state = { actor: { ...actor }, worldId: actor.world_id, sessionId: 'session-1' };
  const calls = [];
  const journey = createPortalJourney({
    readState: () => state,
    walkTo: async (x, y) => { calls.push(['walk', x, y]); state.actor.x = x; state.actor.y = y; return true; },
    travelAgent: async (id) => { calls.push(['travel', id]); },
    ...overrides,
  });
  return { journey, state, calls };
};

test('walks to the exact portal tile, then travels', async () => {
  const { journey, calls } = setup();
  const response = await journey({ portal, actor, sessionId: 'session-1' });
  strictEqual(response.ok, true);
  deepStrictEqual(calls, [['walk', 24, 1], ['travel', 'frontier:0:-1']]);
});

test('travels directly when already adjacent to the portal', async () => {
  const adjacentActor = { ...actor, x: 23, y: 1 };
  const { journey, state, calls } = setup({ walkTo: async () => { throw new Error('walk should be skipped'); } });
  state.actor.x = adjacentActor.x;
  state.actor.y = adjacentActor.y;
  const response = await journey({ portal, actor: adjacentActor, sessionId: 'session-1' });
  strictEqual(response.ok, true);
  deepStrictEqual(calls, [['travel', 'frontier:0:-1']]);
});

test('does not travel when the route is unreachable', async () => {
  const { journey, calls } = setup({ walkTo: async () => false });
  const response = await journey({ portal, actor, sessionId: 'session-1' });
  deepStrictEqual({ ok: response.ok, reason: response.reason }, { ok: false, reason: 'unreachable' });
  strictEqual(calls.length, 0);
});

test('does not travel when walking finishes outside portal range', async () => {
  const { journey, state, calls } = setup({
    walkTo: async () => { calls.push(['walk']); state.actor.x = 22; state.actor.y = 1; return true; },
  });
  const response = await journey({ portal, actor, sessionId: 'session-1' });
  strictEqual(response.reason, 'unreachable');
  strictEqual(response.stage, 'arrival');
  deepStrictEqual(calls, [['walk']]);
});

test('cancels before travel when the session becomes stale', async () => {
  const { journey, state, calls } = setup({
    walkTo: async (x, y) => { state.actor.x = x; state.actor.y = y; state.worldId = 'commons'; return true; },
  });
  const response = await journey({ portal, actor, sessionId: 'session-1' });
  strictEqual(response.reason, 'stale');
  strictEqual(response.stage, 'after-walk');
  strictEqual(calls.length, 0);
});

test('honours explicit cancellation while walking', async () => {
  const controller = new AbortController();
  const { journey, calls } = setup({ walkTo: async () => { controller.abort(); return true; } });
  const response = await journey({ portal, actor, sessionId: 'session-1', signal: controller.signal });
  strictEqual(response.reason, 'cancelled');
  strictEqual(calls.length, 0);
});

test('refused travel is reported and never becomes a teleport', async () => {
  const { journey, calls } = setup({ travelAgent: async () => { const error = new Error('doorway refused'); error.status = 409; throw error; } });
  const response = await journey({ portal, actor, sessionId: 'session-1' });
  strictEqual(response.reason, 'refused');
  deepStrictEqual(calls, [['walk', 24, 1]]);
});

test('actor and world are rechecked before walking', async () => {
  const { journey, calls } = setup();
  const response = await journey({ portal, actor: { ...actor, id: 'replacement' }, sessionId: 'session-1' });
  strictEqual(response.reason, 'stale');
  strictEqual(response.stage, 'before-walk');
  strictEqual(calls.length, 0);
});

test('plans a finite route through opened cardinal frontier sectors with both gates', () => {
  const opened = ['frontier:0:0', { world_id: 'frontier:0:1' }, { id: 'frontier:1:1' }, 'frontier:2:1'];
  const response = planFrontierRoute('frontier:0:0', 'frontier:2:1', opened);
  strictEqual(response.ok, true);
  strictEqual(response.worlds[0], 'frontier:0:0');
  strictEqual(response.worlds.at(-1), 'frontier:2:1');
  strictEqual(response.steps.length, response.worlds.length - 1);
  for (const step of response.steps) {
    strictEqual(frontierGates(step.from_world_id).find((gate) => gate.targetWorldId === step.to_world_id)?.x, step.gate.x);
    strictEqual(frontierGates(step.to_world_id).find((gate) => gate.targetWorldId === step.from_world_id)?.x, step.target_gate.x);
  }
});

test('returns an empty sequence for the current sector', () => {
  deepStrictEqual(planFrontierRoute('frontier:0:0', 'frontier:0:0', ['frontier:0:0']), {
    ok: true, worlds: ['frontier:0:0'], steps: [],
  });
});

test('rejects unopened, out-of-bounds, and disconnected destinations', () => {
  strictEqual(planFrontierRoute('frontier:0:0', 'frontier:1:0', ['frontier:0:0']).reason, 'unopened');
  strictEqual(planFrontierRoute('frontier:0:0', 'frontier:8:0', ['frontier:0:0', 'frontier:8:0']).reason, 'out_of_bounds');
  strictEqual(planFrontierRoute('frontier:0:0', 'frontier:1:1', ['frontier:0:0', 'frontier:1:1']).reason, 'unreachable');
});

test('does not treat unopened frontier directory records as opened sectors', () => {
  const directory = [
    { world_id: 'frontier:0:0', opened: true },
    { world_id: 'frontier:1:0', opened: false },
    { world_id: 'frontier:0:1', state: 'unopened' },
    { world_id: 'frontier:1:1', opened: true },
  ];
  strictEqual(planFrontierRoute('frontier:0:0', 'frontier:1:1', directory).reason, 'unreachable');
});

test('caps the opened-sector input without mutating it', () => {
  const opened = Array.from({ length: 257 }, (_, index) => `frontier:${index % 16 - 8}:${Math.floor(index / 16) - 8}`);
  const originalLength = opened.length;
  const response = planFrontierRoute('frontier:0:0', 'frontier:0:0', opened);
  strictEqual(response.reason, 'limit');
  strictEqual(opened.length, originalLength);
});


import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeAction, parseAction, runAgent } from '../runtime/agent.js';

function fixture({ world = { participants: [], messages: [] } } = {}) {
  const requests = [];
  const status = { agent_id: 'fixture-agent', scopes: ['read', 'move', 'chat', 'contribute'],
    expires_at: Date.now() + 60000, remaining_calls: 100, paused: false };
  return { requests, fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({ path, body: options.body ? JSON.parse(options.body) : null });
    const result = path === '/api/v1/runtime/status' ? status : path === '/api/v1/world' ? world
      : path === '/api/v1/journey' ? { agent_id: status.agent_id, recipes: [], crops: [], quests: [], skills: [] }
      : path === '/api/v1/community' ? { viewer_agent_id: status.agent_id, circles: [], projects: [], events: [] } : {};
    return new Response(JSON.stringify(result));
  } };
}

test('climb and look parse with exact keys and reject malformed, extra and non-finite variants', () => {
  assert.deepEqual(parseAction('{"action":"climb","direction":"right"}'), { action: 'climb', direction: 'right' });
  assert.deepEqual(parseAction({ action: 'look', yaw: 1.5, pitch: -1.4 }), { action: 'look', yaw: 1.5, pitch: -1.4 });
  for (const raw of [
    '{"action":"climb","direction":"sideways"}',
    '{"action":"climb","direction":"up","z":3}',
    '{"action":"climb"}',
    '{"action":"look","yaw":0}',
    '{"action":"look","yaw":0,"pitch":0,"distance":12}',
    '{"action":"look","yaw":"0","pitch":0}',
    '{"action":"look","yaw":null,"pitch":0}',
    '{"action":"look","yaw":4.5,"pitch":0}',
    '{"action":"look","yaw":0,"pitch":2}',
    '{"action":"look","yaw":0,"pitch":0,"agent_id":"someone-else"}',
  ]) assert.throws(() => parseAction(raw));
  for (const value of [{ action: 'look', yaw: NaN, pitch: 0 }, { action: 'look', yaw: 0, pitch: Infinity },
    { action: 'look', yaw: -Infinity, pitch: 0 }, { action: 'climb', direction: undefined }]) {
    assert.throws(() => parseAction(value));
  }
});

test('climb and look require the move scope and demand a valid runtime identity', () => {
  const status = { agent_id: 'fixture-agent', scopes: ['read', 'move'] };
  assert.deepEqual(authorizeAction(parseAction('{"action":"climb","direction":"up"}'), {}, status), { action: 'climb', direction: 'up' });
  assert.deepEqual(authorizeAction(parseAction('{"action":"look","yaw":0,"pitch":0}'), {}, status), { action: 'look', yaw: 0, pitch: 0 });
  for (const scopes of [[], ['read'], ['read', 'chat', 'contribute', 'build']]) {
    assert.throws(() => authorizeAction(parseAction('{"action":"climb","direction":"up"}'), {}, { ...status, scopes }), /permissions/);
    assert.throws(() => authorizeAction(parseAction('{"action":"look","yaw":0,"pitch":0}'), {}, { ...status, scopes }), /permissions/);
  }
  assert.throws(() => authorizeAction(parseAction('{"action":"climb","direction":"up"}'), {}, { scopes: ['read', 'move'] }), /Invalid runtime identity/);
});

test('the runtime dispatches climb to /climb and look to the bound agent while observing its own z', async () => {
  const world = { world: { id: 'commons' }, participants: [{ id: 'fixture-agent', z: 2 }], messages: [] };
  const f = fixture({ world });
  const decisions = [{ action: 'climb', direction: 'up' }, { action: 'look', yaw: 0.5, pitch: -0.5 }];
  const result = await runAgent({ token: 'fixture-only', fetchImpl: f.fetchImpl, maxCalls: 2, stepDelayMs: 0,
    modelFn: async ({ prompt }) => {
      assert.match(prompt, /"z":2/);
      assert.match(prompt, /"action":"climb"/);
      assert.match(prompt, /"action":"look"/);
      assert.ok(prompt.length <= 24000);
      return JSON.stringify(decisions.shift());
    } });
  assert.equal(result.status, 'completed');
  assert.equal(result.action_count, 2);
  assert.deepEqual(f.requests.find((request) => request.path === '/api/v1/climb').body, { direction: 'up' });
  assert.deepEqual(f.requests.find((request) => request.path === '/api/v1/agents/fixture-agent/look').body, { yaw: 0.5, pitch: -0.5 });
  assert.ok(f.requests.every((request) => !request.body || !Object.hasOwn(request.body, 'agent_id')));
});

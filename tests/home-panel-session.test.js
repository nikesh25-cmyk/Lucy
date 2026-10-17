import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = app.indexOf('const aiResidents='), end = app.indexOf('/** The free personal space every resident', start);
assert.ok(start >= 0 && end > start, 'the harness must execute the actual Home & vault integration');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const agent = { id: 'resident-a', name: 'Private resident A', kind: 'agent', status: 'active' };
const entry = { resident: agent, vault: { enrolled: true, notes: 3 }, garden: { visibility: 'public' }, cottage: { visibility: 'private' } };

function harness(api) {
  const updates = [], calls = [], state = { account: { id: 'operator-a' }, sessionEpoch: 1, agents: [agent], selected: agent.id };
  const host = { isConnected: true }, panel = { update: (value) => updates.push(value), paint() {} };
  const scope = { state, homeRows: [], homePanel: panel, homeHost: host, homeFocus: null, homeRevision: 1, homeContext: null, encodeURIComponent,
    api: async (...args) => { calls.push(args); return api(...args); }, selected: () => state.agents.find((item) => item.id === state.selected),
  };
  scope.homeContext = { accountId: 'operator-a', epoch: 1, revision: 1, host, panel };
  vm.runInNewContext(`${app.slice(start, end)};globalThis.runLoad=loadHome;globalThis.runRead=readHomeRow;globalThis.runVisibility=setHomeVisibility;globalThis.runErase=eraseHomeVault;globalThis.clearHome=()=>typeof clearHomeView==='function'?clearHomeView():null;`, scope);
  return { scope, state, host, panel, calls, updates, context: scope.homeContext };
}

const payload = (path) => path.startsWith('/vault?') ? { enrolled: true, notes: 3 } : { world: { visibility: 'private' } };
const changes = [
  h => { h.state.account = { id: 'operator-b' }; },
  h => { h.state.sessionEpoch++; },
  h => { h.scope.homeRevision++; },
  h => { h.host.isConnected = false; },
  h => { h.scope.clearHome(); },
];

test('late home metadata cannot refill a cache after its operator, session or panel has changed', async () => {
  for (const change of changes) {
    const gate = deferred(), h = harness(async path => { await gate.promise; return payload(path); });
    const pending = h.scope.runLoad(h.context);
    assert.equal(h.calls.length, 3, 'one resident reads its vault metadata and both spaces');
    change(h); gate.resolve(); await pending;
    assert.equal(h.scope.homeRows.length, 0, 'old resident identity and vault counts must not survive into a new context');
    assert.deepEqual(h.updates, []);
  }
});

test('a session-ended metadata reply is propagated rather than turned into a cacheable resident row', async () => {
  const h = harness(async () => { throw Object.assign(new Error('Session ended'), { sessionEnded: true }); });
  await assert.rejects(h.scope.runRead(agent, h.context), error => error.sessionEnded === true);
  assert.equal(h.scope.homeRows.length, 0);
});

test('a delayed home visibility or erase reply cannot read or paint another operator or replacement panel', async () => {
  for (const method of ['runVisibility', 'runErase']) for (const change of changes) for (const outcome of ['success', 'refusal']) {
    const gate = deferred(), h = harness(async (path, verb) => verb ? gate.promise : payload(path));
    h.scope.homeRows = [entry];
    const pending = method === 'runVisibility' ? h.scope[method](agent.id, { house_visibility: 'public' }, 'cottage', h.context) : h.scope[method](agent.id, h.context);
    assert.equal(h.calls.length, 1);
    change(h);
    if (outcome === 'success') gate.resolve({ visibility: 'public', house_visibility: 'public', removed: 3 });
    else gate.reject(new Error('Private refusal addressed to operator A'));
    await pending;
    assert.equal(h.calls.length, 1, 'a stale confirmation may have committed but cannot issue follow-up requests under the new context');
    assert.deepEqual(h.updates, [], 'a stale success or refusal cannot overwrite a replacement panel');
  }
});

test('clearing the operator removes cached home metadata, focus and the old panel', () => {
  const h = harness(payload);
  h.scope.homeRows = [entry]; h.scope.homeFocus = { agentId: agent.id, which: 'vault' };
  h.scope.clearHome();
  assert.equal(h.scope.homeRows.length, 0);
  assert.equal(h.scope.homeFocus, null);
  assert.equal(h.scope.homePanel, null);
  assert.equal(h.scope.homeHost, null);
  assert.equal(h.scope.homeContext, null);
});

test('the current operator gets confirmed home states after a successful mutation', async () => {
  const h = harness(async (path, verb) => verb ? { visibility: 'public', house_visibility: 'private' } : payload(path));
  h.scope.homeRows = [entry];
  await h.scope.runVisibility(agent.id, { house_visibility: 'private' }, 'cottage', h.context);
  assert.equal(h.calls.length, 4);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].residents[0].resident.id, agent.id);
  assert.match(h.updates[0].saved.text, /server saved/);
});

test('the Home directory reads at most two residents at once and keeps their server order', async () => {
  const residents = Array.from({ length: 8 }, (_, index) => ({ ...agent, id: `resident-${index}` }));
  const gates = new Map(residents.map(resident => [resident.id, deferred()]));
  let active = 0, peak = 0;
  const h = harness(async path => {
    const residentId = new URL(path, 'http://test.invalid').searchParams.get('agent_id');
    active++; peak = Math.max(peak, active);
    await gates.get(residentId).promise;
    active--;
    return payload(path);
  });
  h.state.agents = residents;
  const pending = h.scope.runLoad(h.context);
  assert.equal(h.calls.length, 6, 'only two residents may each start their three metadata requests');
  for (const resident of residents) {
    gates.get(resident.id).resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(peak <= 6, 'the directory must never exceed six concurrent metadata requests');
  }
  await pending;
  assert.deepEqual(Array.from(h.scope.homeRows, row => row.resident.id), residents.map(resident => resident.id));
  assert.equal(h.calls.length, residents.length * 3);
});

test('an operator switch stops undispatched Home reads while the first two residents are pending', async () => {
  const gate = deferred(), h = harness(async path => { await gate.promise; return payload(path); });
  h.state.agents = Array.from({ length: 8 }, (_, index) => ({ ...agent, id: `resident-${index}` }));
  const pending = h.scope.runLoad(h.context);
  assert.equal(h.calls.length, 6);
  h.state.account = { id: 'operator-b' };
  gate.resolve();
  await pending;
  assert.equal(h.calls.length, 6, 'the new account must not dispatch the old operator’s remaining requests');
  assert.equal(h.scope.homeRows.length, 0);
});

test('a human character gets separate saved home privacy without vault requests or erase authority', async () => {
  const human = { ...agent, kind: 'human' };
  const h = harness(async (path, verb) => verb ? { visibility: 'public', house_visibility: 'private' } : payload(path));
  h.state.agents = [human];
  await h.scope.runLoad(h.context);
  assert.equal(h.scope.homeRows.length, 1, 'the Home directory includes owned human characters');
  assert.equal(h.calls.length, 2, 'only the garden and cottage are read for a human');
  assert.equal(h.calls.some(([path]) => path.startsWith('/vault')), false);
  await h.scope.runVisibility(human.id, { house_visibility: 'private' }, 'cottage', h.context);
  assert.equal(h.calls.length, 5, 'one settings write and two fresh world reads follow');
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].residents[0].cottage.visibility, 'private');
  assert.equal(await h.scope.runErase(human.id, h.context), false);
  assert.equal(h.calls.length, 5, 'a human character cannot send a vault erase');
});

// The home panel against a real listener on a real temporary database: what the operator's session
// is actually sent for a vault (counts and the server's own policy text, never a note), the visiting
// switches against the real homeSettings route, the server's own refusal wording, and the erase.
// The panel is fed the server's payloads exactly as app.js feeds it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';
import { VAULT_POLICY } from '../src/vault.js';
import { createHomePanel, homeSummaryModel, policyLines, spaceModel, vaultModel } from '../src/ui/home-panel.js';

const SECRET = 'the orchard gate code is moonlight';

async function open(t) {
  const f = await fixture(t);
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const request = async (route, { account, token, input, method = input === undefined ? 'GET' : 'POST' } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { ...(account || token ? { Authorization: `Bearer ${token || f.credentials[account].token}` } : {}), ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    const raw = await response.text();
    return { status: response.status, data: raw ? JSON.parse(raw) : null, raw };
  };
  return { ...f, request };
}

/** What app.js reads for one resident: the vault counts and the garden and cottage as the owner sees them. */
async function readEntry(f, account, agent) {
  const [vault, garden, cottage] = await Promise.all([
    f.request(`/vault?agent_id=${agent.id}`, { account }),
    f.request(`/world?world_id=${encodeURIComponent(`home:${agent.id}`)}&agent_id=${agent.id}`, { account }),
    f.request(`/world?world_id=${encodeURIComponent(`house:${agent.id}`)}&agent_id=${agent.id}`, { account }),
  ]);
  assert.equal(vault.status, 200); assert.equal(garden.status, 200); assert.equal(cottage.status, 200);
  return { resident: agent, vault: vault.data, garden: garden.data.world, cottage: cottage.data.world, raw: vault.raw };
}

test('the operator is sent counts and the server’s own VAULT_POLICY text, and the panel draws exactly that', async (t) => {
  const f = await open(t);
  const agent = f.agent('alice');
  let entry = await readEntry(f, 'alice', agent);
  assert.equal(entry.vault.enrolled, false);
  assert.deepEqual(entry.vault.policy, VAULT_POLICY, 'the panel is handed the server’s own statement');
  assert.equal(vaultModel(entry.vault).enrolled, false);
  // The resident writes; the operator then sees a count and no text.
  const resident = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'vault'], minutes: 5, max_calls: 30 });
  assert.equal((await f.request('/vault/write', { token: resident.token, input: { slot: 3, text: SECRET } })).status, 200);
  entry = await readEntry(f, 'alice', agent);
  assert.equal(entry.vault.enrolled, true);
  assert.equal(entry.vault.mode, 'sealed');
  assert.equal(entry.vault.notes, 1);
  assert.ok(entry.vault.bytes > 0);
  assert.equal(entry.raw.includes('moonlight'), false, 'the operator route carries no note text');
  assert.equal('slots' in entry.vault, false, 'and no slot map');
  assert.equal('key_check' in entry.vault, false);
  const panel = createHomePanel({});
  panel.update({ residents: [entry] });
  const text = JSON.stringify(panel.view());
  assert.equal(text.includes('moonlight'), false);
  for (const line of policyLines(vaultModel(entry.vault))) assert.ok(text.includes(line.replace(/"/g, '\\"')), `the panel shows: ${line.slice(0, 50)}`);
  assert.deepEqual(policyLines(vaultModel(entry.vault)), [VAULT_POLICY.summary, VAULT_POLICY.sealed, VAULT_POLICY.effect]);
  assert.match(homeSummaryModel(entry).vault, /Sealed by the server\. 1 note,/);
  // A resident-held vault gets the resident-held sentence instead.
  const other = f.agent('bob');
  const held = f.tx('runtime', f.actor('bob'), other.id, { scopes: ['read', 'vault'], minutes: 5, max_calls: 30 });
  const enrolled = await f.request('/vault/enroll', { token: held.token, input: { mode: 'agent', key_check: Buffer.alloc(40, 7).toString('base64') } });
  assert.equal(enrolled.status, 200);
  const heldEntry = await readEntry(f, 'bob', other);
  assert.deepEqual(policyLines(vaultModel(heldEntry.vault)), [VAULT_POLICY.summary, VAULT_POLICY.agent, VAULT_POLICY.effect]);
});

test('a new AI resident’s cottage starts closed and each switch changes only its own space', async (t) => {
  const f = await open(t);
  const agent = f.agent('alice');
  const state = async () => { const entry = await readEntry(f, 'alice', agent); return { garden: spaceModel(entry.garden), cottage: spaceModel(entry.cottage) }; };
  let now = await state();
  assert.equal(now.garden.known && now.cottage.known, true);
  assert.equal(now.cottage.visibility, 'private', 'the cottage starts private');
  // The panel computes the same field the server documents, and the server answers with both states.
  const sent = [];
  const panel = createHomePanel({ onVisibility: (id, patch) => sent.push(patch) });
  const feed = async () => panel.update({ residents: [await readEntry(f, 'alice', agent)] });
  await feed();
  panel.toggle(agent.id, 'cottage');
  assert.deepEqual(sent.at(-1), { house_visibility: 'public' });
  let result = await f.request(`/agents/${agent.id}/home`, { account: 'alice', method: 'PATCH', input: sent.at(-1) });
  assert.equal(result.status, 200);
  assert.equal(result.data.house_visibility, 'public');
  await feed();
  now = await state();
  assert.deepEqual([now.garden.visibility, now.cottage.visibility], [result.data.visibility, 'public'], 'opening the cottage leaves the garden as it was');
  // Closing the garden also closes the cottage.
  if (now.garden.visibility === 'private') { panel.toggle(agent.id, 'garden'); await feed(); }
  panel.toggle(agent.id, 'garden');
  assert.deepEqual(sent.at(-1), { visibility: 'private' });
  result = await f.request(`/agents/${agent.id}/home`, { account: 'alice', method: 'PATCH', input: sent.at(-1) });
  assert.equal(result.status, 200);
  await feed();
  now = await state();
  assert.deepEqual([now.garden.visibility, now.cottage.visibility], ['private', 'private'], 'closing the garden closed the cottage too');
  // Opening the garden does not open the cottage.
  panel.toggle(agent.id, 'garden');
  assert.deepEqual(sent.at(-1), { visibility: 'public' });
  result = await f.request(`/agents/${agent.id}/home`, { account: 'alice', method: 'PATCH', input: sent.at(-1) });
  assert.equal(result.status, 200);
  await feed();
  now = await state();
  assert.deepEqual([now.garden.visibility, now.cottage.visibility], ['public', 'private'], 'opening the garden left the cottage closed');
  assert.deepEqual(sent.map((patch) => Object.keys(patch).length), [1, 1, 1], 'each press sent one field');
});

test('the server’s refusals reach the screen in the server’s own words', async (t) => {
  const f = await open(t);
  const agent = f.agent('alice');
  f.agent('bob');
  const bad = await f.request(`/agents/${agent.id}/home`, { account: 'alice', method: 'PATCH', input: { house_visibility: 'everyone' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'Choose public or private visiting for the cottage.');
  const stranger = await f.request(`/agents/${agent.id}/home`, { account: 'bob', method: 'PATCH', input: { visibility: 'public' } });
  assert.ok(stranger.status >= 400 && typeof stranger.data.error === 'string' && stranger.data.error.length > 3);
  const panel = createHomePanel({});
  panel.update({ residents: [await readEntry(f, 'alice', agent)], refusal: { agentId: agent.id, text: bad.data.error } });
  assert.match(JSON.stringify(panel.view()), /Choose public or private visiting for the cottage\./);
  // Erasing without the confirm is refused by the server too; the panel never sends that request.
  const unconfirmed = await f.request('/vault/manage', { account: 'alice', input: { agent_id: agent.id, action: 'erase' } });
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.data.error, 'Erasing a vault needs action:"erase" and confirm:true.');
  // Another operator cannot see or erase this vault at all.
  assert.equal((await f.request(`/vault?agent_id=${agent.id}`, { account: 'bob' })).status, 404);
  assert.equal((await f.request('/vault/manage', { account: 'bob', input: { agent_id: agent.id, action: 'erase', confirm: true } })).status, 404);
});

test('a confirmed erase removes every note and the key, and the panel then shows no vault', async (t) => {
  const f = await open(t);
  const agent = f.agent('alice');
  const resident = f.tx('runtime', f.actor('alice'), agent.id, { scopes: ['read', 'vault'], minutes: 5, max_calls: 30 });
  for (const slot of [1, 2, 3]) assert.equal((await f.request('/vault/write', { token: resident.token, input: { slot, text: `${SECRET} ${slot}` } })).status, 200);
  const requests = [];
  const panel = createHomePanel({ onErase: (id) => requests.push(id) });
  panel.update({ residents: [await readEntry(f, 'alice', agent)] });
  assert.equal(panel.model().residents[0].vault.notes, 3);
  panel.arm(agent.id);
  assert.deepEqual(requests, []);
  panel.erase();
  assert.deepEqual(requests, [agent.id]);
  const erased = await f.request('/vault/manage', { account: 'alice', input: { agent_id: requests[0], action: 'erase', confirm: true } });
  assert.equal(erased.status, 200);
  assert.deepEqual({ erased: erased.data.erased, removed: erased.data.removed }, { erased: true, removed: 3 });
  panel.update({ residents: [await readEntry(f, 'alice', agent)], saved: { agentId: agent.id, text: `The server erased the vault: ${erased.data.removed} notes and the key were deleted.` } });
  const model = panel.model().residents[0].vault;
  assert.deepEqual([model.enrolled, model.notes, model.bytes, model.mode], [false, 0, 0, null]);
  assert.match(JSON.stringify(panel.view()), /The server erased the vault: 3 notes and the key were deleted\./);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resident_vault WHERE agent_id=?', agent.id).n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resident_vault_keys WHERE agent_id=?', agent.id).n, 0);
});

test('a human character can close its cottage separately while the vault remains AI-only', async (t) => {
  const f = await open(t);
  const human = f.tx('createAgent', f.actor('alice'), { name: 'Alice builder', kind: 'human' });
  assert.equal(human.kind, 'human');
  const result = await f.request(`/agents/${human.id}/home`, { account: 'alice', method: 'PATCH', input: { house_visibility: 'private' } });
  assert.equal(result.status, 200);
  assert.deepEqual([result.data.visibility, result.data.house_visibility], ['public', 'private']);
  const [garden, cottage] = await Promise.all(['home', 'house'].map(kind => f.request(`/world?world_id=${encodeURIComponent(`${kind}:${human.id}`)}&agent_id=${human.id}`, { account: 'alice' })));
  assert.equal(garden.status, 200); assert.equal(cottage.status, 200);
  const panel = createHomePanel({});
  panel.update({ residents: [{ resident: human, garden: garden.data.world, cottage: cottage.data.world }] });
  const row = panel.model().residents[0];
  assert.deepEqual([row.garden.open, row.cottage.open, row.hasVault], [true, false, false]);
  assert.equal(panel.arm(human.id), null);
  assert.equal((await f.request(`/vault?agent_id=${human.id}`, { account: 'alice' })).status, 404);
});

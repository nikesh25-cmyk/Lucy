import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';
import { authorizeAction, parseAction, runAgent } from '../runtime/agent.js';

const MARKER = 'WORLD OBSERVATIONS:\n';
const observations = (prompt) => JSON.parse(prompt.split(MARKER)[1]);
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });

async function vaultRuntime(t, scopes = ['read', 'move', 'chat', 'contribute', 'build', 'vault']) {
  const f = await fixture(t);
  const agent = f.agent('alice');
  const credential = f.tx('runtime', f.actor('alice'), agent.id, { minutes: 20, max_calls: 200, scopes });
  const { server, platform } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await listen(server);
  t.after(() => close(server));
  const url = `http://127.0.0.1:${server.address().port}`, requests = [];
  const fetchImpl = async (address, options) => { requests.push({ path: new URL(address).pathname, body: options.body ? JSON.parse(options.body) : null }); return fetch(address, options); };
  const run = (options) => runAgent({ url, token: credential.token, fetchImpl, maxCalls: 1, stepDelayMs: 0, reportJob: false, ...options });
  return { ...f, platform, agent, credential, requests, run };
}

test('parseAction accepts one bounded single-line note and refuses everything else', () => {
  assert.deepEqual(parseAction('{"action":"note","slot":3,"text":"  water the orchard at dawn  "}'), { action: 'note', slot: 3, text: 'water the orchard at dawn' });
  for (const raw of [
    '{"action":"note","slot":0,"text":"x"}', '{"action":"note","slot":65,"text":"x"}', '{"action":"note","slot":"1","text":"x"}',
    '{"action":"note","slot":1,"text":""}', `{"action":"note","slot":1,"text":"${'x'.repeat(301)}"}`, '{"action":"note","slot":1,"text":"a\\nb"}',
    '{"action":"note","slot":1,"text":"x","agent_id":"other"}', '{"action":"note","slot":1}', '{"action":"note","text":"x"}',
  ]) assert.throws(() => parseAction(raw), /Invalid model action/);
});

test('a note is authorized only with the vault scope and the resident\'s own openable vault', () => {
  const status = (scopes) => ({ agent_id: 'me', expires_at: Date.now() + 60000, remaining_calls: 50, paused: false, scopes });
  const view = (vault) => ({ world: { id: 'commons', kind: 'commons', width: 20, height: 14 }, own_home: { id: 'home:me' }, vault });
  const note = { action: 'note', slot: 1, text: 'hello' };
  assert.deepEqual(authorizeAction(note, view({ agent_id: 'me', mode: 'sealed', notes: [] }), status(['read', 'vault'])), note);
  assert.deepEqual(authorizeAction(note, view({ agent_id: 'me', mode: null, notes: [] }), status(['read', 'vault'])), note);
  for (const [v, scopes] of [
    [{ agent_id: 'me', mode: 'sealed', notes: [] }, ['read', 'contribute']],
    [{ agent_id: 'sibling', mode: 'sealed', notes: [] }, ['read', 'vault']],
    [{ agent_id: 'me', mode: 'agent', notes: [] }, ['read', 'vault']],
    [{ agent_id: 'me', mode: 'sealed', unavailable: true, notes: [] }, ['read', 'vault']],
    [undefined, ['read', 'vault']],
  ]) assert.throws(() => authorizeAction(note, view(v), status(scopes)), /exceeds the observed world or granted permissions/);
});

test('a managed resident writes a note, then reads it back in its next observation, and nobody else can', async (t) => {
  const f = await vaultRuntime(t);
  const seen = [];
  const result = await f.run({ maxCalls: 2, runId: 'run-vault', modelFn: async ({ prompt }) => {
    seen.push({ prompt, view: observations(prompt) });
    return seen.length === 1 ? JSON.stringify({ action: 'note', slot: 2, text: 'the herb patch needs tending on the second morning' }) : JSON.stringify({ action: 'emote', emote: 'wave' });
  } });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.action_count, 2);
  // The first decision had an empty, enrolled-nowhere vault and was offered the action.
  assert.deepEqual(seen[0].view.vault.notes, []); assert.match(seen[0].prompt, /private vault of notes/);
  const write = f.requests.find((request) => request.path === '/api/v1/vault/write');
  assert.deepEqual(write.body, { slot: 2, text: 'the herb patch needs tending on the second morning' });
  // The next decision carries the sealed note back, from the resident's own private calling read.
  assert.deepEqual(seen[1].view.vault.notes, [{ slot: 2, text: 'the herb patch needs tending on the second morning' }]);
  assert.equal(seen[1].view.vault.mode, 'sealed');
  // Stored sealed; no memory, receipt, coin or reward changed; no extra read route was needed.
  assert.ok(!Buffer.from(f.platform.get('SELECT ciphertext FROM resident_vault').ciphertext).toString('latin1').includes('herb patch'));
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resident_memory').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.ok(f.requests.every((request) => request.path !== '/api/v1/vault/notes'), 'the notes ride the calling read');
  // The operator's session gets counts only.
  const status = f.platform.vaultStatus(f.actor('alice'), { agent_id: f.agent.id });
  assert.equal(status.notes, 1);
});

test('without the vault scope the resident is never offered a note and its notes never reach the prompt', async (t) => {
  const f = await vaultRuntime(t, ['read', 'move', 'chat', 'contribute', 'build']);
  const seen = [];
  await f.run({ runId: 'run-novault', modelFn: async ({ prompt }) => { seen.push(prompt); return JSON.stringify({ action: 'emote', emote: 'wave' }); } });
  assert.doesNotMatch(seen[0], /private vault of notes/);
  assert.equal(observations(seen[0]).vault, undefined);
});

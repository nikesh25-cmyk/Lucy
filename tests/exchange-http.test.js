import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';

// One HTTP harness for the offer routes: a real server on a real port, a session cookie token or an
// agent runtime token, and the shipped `Idempotency-Key` header. Nothing here reaches into the
// platform directly, so the routes, their scopes and their refusals are what is actually exercised.
async function serve(t, f) {
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (path, { token, input, key, method = input ? 'POST' : 'GET' } = {}) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
}

const stock = (f, agent, kind, quantity) => f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity', agent.id, kind, quantity);
const shelf = (f, agent) => Object.fromEntries(f.platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=?', agent.id).map((item) => [item.kind, item.quantity]));

test('the offer routes enforce consent, scopes and idempotency end to end', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'herbs', 5);
  const req = await serve(t, f);
  // Unauthenticated reads and writes are refused.
  assert.equal((await req('/journey/offers')).status, 401);
  assert.equal((await req('/journey/offers', { token: f.credentials.alice.token, input: { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 1 } } })).status, 400, 'the Idempotency-Key header is required');
  assert.equal((await req('/journey/offers', { token: f.credentials.alice.token, input: { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 1 } }, key: 'http-1' })).status, 200);
  const created = await req('/journey/offers', { token: f.credentials.alice.token, input: { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 2 }, note: 'From the garden.' }, key: 'http-2' });
  assert.equal(created.status, 200);
  assert.equal(created.data.status, 'proposed');
  assert.deepEqual(created.data.items, { herbs: 2 });
  assert.equal(shelf(f, alice).herbs, 2);
  // A replayed key returns the same offer and writes nothing.
  const replay = await req('/journey/offers', { token: f.credentials.alice.token, input: { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 2 }, note: 'From the garden.' }, key: 'http-2' });
  assert.equal(replay.data.id, created.data.id);
  assert.equal(replay.data.repeated, true);
  assert.equal(shelf(f, alice).herbs, 2);
  // An outsider cannot accept; the named recipient's operator can, and the replay is safe.
  assert.equal((await req('/journey/offers/accept', { token: f.credentials.reviewer.token, input: { offer_id: created.data.id }, key: 'http-accept' })).status, 403);
  const accepted = await req('/journey/offers/accept', { token: f.credentials.bob.token, input: { offer_id: created.data.id, agent_id: bob.id }, key: 'http-accept' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.status, 'accepted');
  assert.equal(shelf(f, bob).herbs, 2);
  const acceptedAgain = await req('/journey/offers/accept', { token: f.credentials.bob.token, input: { offer_id: created.data.id, agent_id: bob.id }, key: 'http-accept' });
  assert.equal(acceptedAgain.data.repeated, true);
  assert.equal(shelf(f, bob).herbs, 2);
  // The list is private to the two parties.
  const aliceList = await req('/journey/offers', { token: f.credentials.alice.token });
  assert.equal(aliceList.data.offers.length, 2);
  assert.equal(aliceList.data.policy.moves_coins, false);
  assert.equal(aliceList.data.policy.moves_land, false);
  assert.equal((await req('/journey/offers', { token: f.credentials.reviewer.token })).data.offers.length, 0);
  // A second offer can be cancelled by its offerer, returning the escrow.
  const cancellable = await req('/journey/offers', { token: f.credentials.alice.token, input: { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 1 } }, key: 'http-3' });
  assert.equal((await req('/journey/offers/cancel', { token: f.credentials.bob.token, input: { offer_id: cancellable.data.id } })).status, 403);
  assert.equal((await req('/journey/offers/cancel', { token: f.credentials.alice.token, input: { offer_id: cancellable.data.id } })).data.status, 'cancelled');
  assert.equal(shelf(f, alice).herbs, 2);
  assert.equal(await req('/journey/offers/decline', { token: f.credentials.bob.token, input: { offer_id: cancellable.data.id } }).then((r) => r.status), 409, 'a settled offer cannot be declined');
});

test('a runtime may propose over HTTP but the accept and decline routes refuse it', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'fiber', 4);
  const req = await serve(t, f);
  // One active runtime per operator, so the read-only session belongs to a different operator.
  const reader = f.tx('runtime', f.actor('bob'), bob.id, { scopes: ['read'], max_calls: 20 });
  const proposer = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read', 'contribute'], max_calls: 20 });
  // A read-only runtime lacks the contribute scope the propose route needs.
  assert.equal((await req('/journey/offers', { token: reader.token, input: { recipient_agent_id: bob.id, items: { fiber: 1 } }, key: 'rt-read' })).status, 403);
  const proposed = await req('/journey/offers', { token: proposer.token, input: { recipient_agent_id: bob.id, items: { fiber: 2 } }, key: 'rt-propose' });
  assert.equal(proposed.status, 200);
  assert.equal(proposed.data.offerer.agent_id, alice.id);
  assert.equal(shelf(f, alice).fiber, 2);
  // The accept and decline routes are session-only: a runtime is refused before any inventory moves.
  assert.equal((await req('/journey/offers/accept', { token: proposer.token, input: { offer_id: proposed.data.id }, key: 'rt-accept' })).status, 403);
  assert.equal((await req('/journey/offers/decline', { token: proposer.token, input: { offer_id: proposed.data.id } })).status, 403);
  assert.equal(shelf(f, bob).fiber, undefined);
  // The recipient's operator accepts over HTTP.
  const accepted = await req('/journey/offers/accept', { token: f.credentials.bob.token, input: { offer_id: proposed.data.id, agent_id: bob.id }, key: 'rt-accept' });
  assert.equal(accepted.status, 200);
  assert.equal(shelf(f, bob).fiber, 2);
});

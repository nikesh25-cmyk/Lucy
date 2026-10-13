import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';

async function httpPost(url, path, body, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${url}/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error' });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function serve(t) {
  const f = await fixture(t);
  const { server } = createApp({ platform: f.platform });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { f, url: `http://127.0.0.1:${server.address().port}` };
}

test('an active AI resident may privately reply to the operator who messaged it, and only that sender', async (t) => {
  const { f, url } = await serve(t);
  const aliceAgent = f.agent('alice', 'Alice resident');
  const bobAgent = f.agent('bob', 'Bob resident');
  const runtime = f.tx('runtime', f.actor('alice'), aliceAgent.id, { minutes: 10, max_calls: 40, scopes: ['read', 'chat'] });

  // Bob's operator sends a private message to Alice's AI resident.
  const sent = await httpPost(url, '/messages', { agent_id: bobAgent.id, channel: 'private', recipient_id: aliceAgent.id, text: 'Hello resident, can you help?' }, f.credentials.bob.token);
  assert.equal(sent.status, 200);

  // The resident replies. It names the observed message, never a recipient.
  const replied = await httpPost(url, '/messages', { channel: 'private', reply_to: sent.body.id, text: 'Yes — tell me what you need.' }, runtime.token);
  assert.equal(replied.status, 200);
  assert.notEqual(replied.body.id, sent.body.id);

  const rows = f.platform.all("SELECT * FROM messages WHERE channel='private' ORDER BY created_at, rowid");
  assert.equal(rows.length, 2);
  const reply = rows.find((row) => row.id === replied.body.id);
  assert.equal(reply.agent_id, aliceAgent.id, 'the reply is authored by the resident');
  assert.equal(reply.account_id, f.actor('alice').account.id);
  assert.deepEqual(JSON.parse(reply.recipients).sort(), [aliceAgent.id, bobAgent.id].sort(), 'the reply reaches only the resident and the sender');
  assert.equal(reply.status, 'visible');

  // The two parties read it; a third operator and an unrelated runtime never can.
  assert.equal(f.platform.canReadMessage(f.actor('alice'), reply), true);
  assert.equal(f.platform.canReadMessage(f.actor('bob'), reply), true);
  assert.equal(f.platform.canReadMessage(f.actor('reviewer'), reply), false, 'a third party cannot read the reply');

  // A reply mints nothing.
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts').n, 0);
});

test('a reply cannot be redirected to another recipient, nor answer your own message', async (t) => {
  const { f, url } = await serve(t);
  const aliceAgent = f.agent('alice', 'Alice resident');
  const bobAgent = f.agent('bob', 'Bob resident');
  f.agent('reviewer', 'Reviewer resident');
  const runtime = f.tx('runtime', f.actor('alice'), aliceAgent.id, { minutes: 10, max_calls: 40, scopes: ['read', 'chat'] });

  const sent = await httpPost(url, '/messages', { agent_id: bobAgent.id, channel: 'private', recipient_id: aliceAgent.id, text: 'A direct question.' }, f.credentials.bob.token);
  assert.equal(sent.status, 200);

  // A client-supplied recipient beside reply_to is refused: the server resolves the sender only.
  const named = await httpPost(url, '/messages', { channel: 'private', reply_to: sent.body.id, recipient_id: 'someone-else', text: 'Redirected.' }, runtime.token);
  assert.equal(named.status, 200);
  const redirected = f.platform.get("SELECT * FROM messages WHERE channel='private' ORDER BY rowid DESC LIMIT 1");
  assert.deepEqual(JSON.parse(redirected.recipients).sort(), [aliceAgent.id, bobAgent.id].sort(), 'the named recipient is ignored; the reply still reaches only the sender');

  // The resident cannot reply to a message it authored itself.
  f.advance(2000);
  const mine = await httpPost(url, '/messages', { channel: 'private', reply_to: sent.body.id, text: 'First answer.' }, runtime.token);
  assert.equal(mine.status, 200);
  f.advance(2000);
  const selfReply = await httpPost(url, '/messages', { channel: 'private', reply_to: mine.body.id, text: 'Replying to myself.' }, runtime.token);
  assert.equal(selfReply.status, 400);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM messages WHERE text='Replying to myself.'").n, 0);
});

test('a runtime cannot reply to a private message it was never addressed in, and a paused resident is refused', async (t) => {
  const { f, url } = await serve(t);
  const aliceAgent = f.agent('alice', 'Alice resident');
  const bobAgent = f.agent('bob', 'Bob resident');
  const carolAgent = f.tx('createAgent', f.actor('alice'), { name: 'Alice second', color: '#397f79', symbol: '✦' });
  const runtime = f.tx('runtime', f.actor('alice'), aliceAgent.id, { minutes: 10, max_calls: 40, scopes: ['read', 'chat'] });

  // A thread between Bob and Carol's* residents — Alice's runtime is not a recipient.
  const sent = await httpPost(url, '/messages', { agent_id: bobAgent.id, channel: 'private', recipient_id: carolAgent.id, text: 'A thread the runtime is not in.' }, f.credentials.bob.token);
  assert.equal(sent.status, 200);
  const refused = await httpPost(url, '/messages', { channel: 'private', reply_to: sent.body.id, text: 'Peeking.' }, runtime.token);
  assert.equal(refused.status, 404, 'a runtime cannot reply to a thread it was not addressed in');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM messages WHERE text='Peeking.'").n, 0);

  // A paused resident is refused before the message handler.
  f.advance(2000);
  const addressed = await httpPost(url, '/messages', { agent_id: bobAgent.id, channel: 'private', recipient_id: aliceAgent.id, text: 'Are you there?' }, f.credentials.bob.token);
  assert.equal(addressed.status, 200);
  f.tx('agentControl', f.actor('alice'), aliceAgent.id, 'paused');
  const paused = await httpPost(url, '/messages', { channel: 'private', reply_to: addressed.body.id, text: 'Still here.' }, runtime.token);
  assert.equal(paused.status, 401);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM messages WHERE text='Still here.'").n, 0);
});

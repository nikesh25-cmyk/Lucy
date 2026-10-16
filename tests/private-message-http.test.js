import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';

test('a third operator cannot retrieve, report or reply to another pair’s private message by id', async (t) => {
  const f = await fixture(t);
  const alice = f.agent('alice'), bob = f.agent('bob'), third = f.agent('reviewer');
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const request = async (path, account, input) => {
    const response = await fetch(base + path, {
      method: input ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${f.credentials[account].token}`, ...(input ? { 'Content-Type': 'application/json' } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const sent = await request('/messages', 'alice', { agent_id: alice.id, channel: 'private', recipient_id: bob.id, text: 'A private conversation for exactly two residents.' });
  assert.equal(sent.status, 200);
  const id = sent.body.id;
  const addressed = await request(`/world?world_id=commons&agent_id=${bob.id}`, 'bob');
  assert.equal(addressed.status, 200);
  assert.ok(addressed.body.messages.some((message) => message.id === id));
  const outside = await request(`/world?world_id=commons&agent_id=${third.id}`, 'reviewer');
  assert.equal(outside.status, 200);
  assert.ok(!outside.body.messages.some((message) => message.id === id));
  assert.equal((await request(`/messages/${id}`, 'reviewer')).status, 404, 'there is no unguarded by-id message GET');
  assert.equal((await request('/reports', 'reviewer', { target_type: 'message', target_id: id, reason: 'Attempt to inspect another pair’s private message.' })).status, 404);
  assert.equal((await request('/messages', 'reviewer', { agent_id: third.id, channel: 'private', reply_to: id, text: 'Attempt to join a private conversation.' })).status, 404);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM messages WHERE channel=?', 'private').n, 1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM reports WHERE target_id=?', id).n, 0);
});

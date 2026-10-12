import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.js';
import { validateDatabase } from '../src/recovery.js';
import { getWorldDefinition, walkable } from '../world.js';
import { fixture } from './helpers.js';

const seed = 'frontier:0:0';
const openTile = (world = seed) => {
  const definition = getWorldDefinition(world);
  for (let y = 31; y <= 34; y++) for (let x = 31; x <= 34; x++) {
    if ([[0, 0], [1, 0], [-1, 0], [-2, 0], [0, 1], [0, -1]].every(([dx, dy]) => walkable({ x: x + dx, y: y + dy }, definition))) return { x, y };
  }
  throw new Error('Expected an open test patch.');
};

async function setup(t) {
  const f = await fixture(t);
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { method = 'GET', account, token, input } = {}) => {
    const response = await fetch(`${base}/api/v1${route}`, {
      method,
      headers: { ...(input ? { 'Content-Type': 'application/json' } : {}), ...(account || token ? { Authorization: `Bearer ${token || f.credentials[account].token}` } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return { ...f, request };
}

test('the elevation columns are stored and validation rejects a stored z outside the standable range', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  assert.equal(validateDatabase(f.database).schema_version, 17);
  const columns = new Set(f.platform.all('PRAGMA table_info(agents)').map((column) => column.name));
  for (const column of ['z', 'grounded', 'yaw', 'pitch', 'last_look']) assert.equal(columns.has(column), true);
  assert.deepEqual({ ...f.platform.get('SELECT z,grounded,yaw,pitch,last_look FROM agents WHERE id=?', alice.id) },
    { z: 0, grounded: 1, yaw: 0, pitch: 0, last_look: 0 });
  assert.throws(() => f.platform.run('UPDATE agents SET z=9 WHERE id=?', alice.id), /CHECK constraint failed/);
  // A tampered database that bypasses the column constraint fails recovery validation.
  const tampered = new DatabaseSync(f.database);
  tampered.exec('PRAGMA ignore_check_constraints=ON');
  tampered.prepare('UPDATE agents SET z=9 WHERE id=?').run(alice.id);
  tampered.close();
  assert.throws(() => validateDatabase(f.database), /elevation state is invalid/);
});

test('HTTP movement keeps its authored wall, climb steps one layer, and look persists orientation', async (t) => {
  const f = await setup(t), alice = f.agent('alice'), tile = openTile();
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read', 'move'], max_calls: 60 });
  const token = runtime.token;
  f.tx('landAssign', f.actor('alice'), { plot_id: 'plot:0:0:5:5', purpose: 'An elevation workflow fixture' });
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', seed, tile.x - 1, tile.y, alice.id);
  const buildBlock = (changes) => f.tx('frontierBuild', f.actor('alice'), alice.id, { world_id: seed, ...tile, z: 0, type: 'stone', ...changes });
  f.advance(); assert.equal(buildBlock({}).changed, true);
  f.advance(); assert.equal(buildBlock({ z: 1, type: 'glass' }).changed, true);
  const moved = await f.request('/move', { method: 'POST', token, input: { direction: 'right' } });
  assert.equal(moved.status, 200);
  assert.deepEqual({ x: moved.data.x, y: moved.data.y, z: moved.data.z, blocked: moved.data.blocked }, { x: tile.x - 1, y: tile.y, z: 0, blocked: true });
  f.advance();
  const refused = await f.request('/climb', { method: 'POST', token, input: { direction: 'right' } });
  assert.equal(refused.status, 200);
  assert.deepEqual({ x: refused.data.x, y: refused.data.y, z: refused.data.z, blocked: refused.data.blocked }, { x: tile.x - 1, y: tile.y, z: 0, blocked: true });
  f.advance(); assert.equal(buildBlock({ z: 1, remove: true }).removed, true);
  f.advance();
  const climbed = await f.request(`/agents/${alice.id}/climb`, { method: 'POST', token, input: { direction: 'right' } });
  assert.equal(climbed.status, 200);
  assert.deepEqual({ x: climbed.data.x, y: climbed.data.y, z: climbed.data.z, grounded: climbed.data.grounded, blocked: climbed.data.blocked },
    { x: tile.x, y: tile.y, z: 1, grounded: true, blocked: false });
  f.advance();
  const looked = await f.request(`/agents/${alice.id}/look`, { method: 'POST', token, input: { yaw: 0.5, pitch: -0.25 } });
  assert.equal(looked.status, 200);
  assert.deepEqual(looked.data, { yaw: 0.5, pitch: -0.25 });
  const view = await f.request('/world', { token });
  assert.equal(view.status, 200);
  assert.deepEqual({ z: view.data.participants[0].z, grounded: view.data.participants[0].grounded, yaw: view.data.participants[0].yaw, pitch: view.data.participants[0].pitch },
    { z: 1, grounded: 1, yaw: 0.5, pitch: -0.25 });
  assert.equal((await f.request('/climb', { method: 'POST', token, input: { direction: 'sideways' } })).status, 400);
  assert.equal((await f.request(`/agents/${alice.id}/look`, { method: 'POST', token, input: { yaw: 'up', pitch: 0 } })).status, 400);
  assert.equal((await f.request(`/agents/${f.agent('bob').id}/look`, { method: 'POST', token, input: { yaw: 0, pitch: 0 } })).status, 404);
  const readOnly = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read'], max_calls: 10 });
  assert.equal((await f.request('/climb', { method: 'POST', token: readOnly.token, input: { direction: 'right' } })).status, 403);
  assert.equal((await f.request(`/agents/${alice.id}/look`, { method: 'POST', token: readOnly.token, input: { yaw: 0, pitch: 0 } })).status, 403);
});

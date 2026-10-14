// Process-level proof for the crash-safe bounded resident.
//
// The child process (tests/fixtures/resident-crash-child.mjs) runs a real bounded resident over real
// HTTP and then dies with SIGKILL, which no cleanup can catch. These tests assert what the next
// start sees: the interrupted run is classified from its last durable write, the orphaned runtime
// credential is revoked, and the action the server already confirmed is never repeated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.js';
import { createApp } from '../server.js';
import { Platform } from '../src/platform.js';
import { validateDatabase } from '../src/recovery.js';

const childPath = fileURLToPath(new URL('./fixtures/resident-crash-child.mjs', import.meta.url));
const rsvpCount = (platform, agentId) => platform.get('SELECT COUNT(*) AS n FROM community_rsvps WHERE agent_id=?', agentId).n;

function crash(args, timeoutMs = 40000) {
  const child = spawn(process.execPath, [childPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ signal: 'timeout', output }); }, timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}

async function gathering(f) {
  const alice = f.agent('alice'), bob = f.agent('bob');
  const event = f.tx('createEvent', f.actor('bob'), {
    agent_id: bob.id, title: 'Crash test gathering', summary: 'A fictional gathering used to prove that one confirmed action stays single.',
    starts_at: new Date(Date.now() + 3600000).toISOString(), ends_at: new Date(Date.now() + 7200000).toISOString(), capacity: 4, world_id: 'commons',
  });
  return { alice, event };
}

// The world effect the confirmed action leaves behind, in a table whose primary key already refuses
// a duplicate, so this count can only change if the server applies the write a second time.
const restart = async (f) => {
  const account = f.actor('alice').account.id;
  f.platform.close();
  const platform = new Platform(f.database);
  return { platform, account };
};

test('a process killed after a confirmed action never repeats it and the next start classifies the run', async (t) => {
  const f = await fixture(t);
  const { alice, event } = await gathering(f);
  const result = await crash([f.database, f.credentials.alice.token, alice.id, event.id, 'confirmed']);
  assert.equal(result.signal, 'SIGKILL', `The child process did not die as intended: ${JSON.stringify(result)}`);

  const crashed = f.platform.get('SELECT * FROM resident_runs ORDER BY started_at DESC LIMIT 1');
  assert.equal(f.platform.get('SELECT status FROM jobs WHERE id=?', crashed.id).status, 'running');
  assert.equal(crashed.status, 'running');
  assert.equal(crashed.phase, 'confirmed');
  assert.equal(crashed.model_calls, 1);
  assert.equal(crashed.action_count, 1);
  assert.equal(crashed.failed_actions, 0);
  assert.equal(JSON.parse(crashed.last_action).action, 'rsvp');
  assert.equal(crashed.decision_budget, 3);
  assert.equal(rsvpCount(f.platform, alice.id), 1);

  const { platform } = await restart(f);
  t.after(() => platform.close());
  const recovered = platform.get('SELECT * FROM resident_runs WHERE id=?', crashed.id);
  const job = platform.get('SELECT * FROM jobs WHERE id=?', crashed.id);
  assert.equal(job.status, 'interrupted');
  assert.match(job.detail, /The last confirmed action is recorded and nothing was pending/);
  assert.match(job.detail, /1 model decisions, 1 confirmed actions/);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.interrupted, 'action_confirmed');
  assert.equal(recovered.stop_reason, 'process_restart');
  assert.equal(recovered.model_calls, 1);
  assert.equal(recovered.action_count, 1);
  assert.equal(JSON.parse(recovered.last_action).action, 'rsvp');
  // The orphaned credential is revoked, so the process that died cannot be used again.
  assert.equal(platform.get('SELECT revoked FROM tokens WHERE hash=?', recovered.credential_hash).revoked, 1);
  // The restart repeated nothing: the confirmed RSVP is still the only one.
  assert.equal(rsvpCount(platform, alice.id), 1);
  assert.equal(validateDatabase(f.database).schema_version, 24);
  assert.equal(platform.verifyAudit(), true);
  assert.equal(platform.get("SELECT COUNT(*) AS n FROM audit WHERE event='resident.run.interrupted'").n, 1);

  // Resuming is a separate, explicit human action with a fresh credential and the remaining budget.
  const app = createApp({ platform, mayorModel: async () => '{"action":"wait"}' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stopWorkers(); await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  const call = async (path, input) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1${path}`, { method: 'POST',
      headers: { Authorization: `Bearer ${f.credentials.alice.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    return { status: response.status, data: await response.json() };
  };
  const resumed = await call('/residents/resume', {});
  assert.equal(resumed.status, 202);
  assert.equal(resumed.data.resumed_from, crashed.id);
  assert.equal(resumed.data.model_calls, 2);
  assert.equal(resumed.data.token, undefined);
  for (let attempt = 0; attempt < 200 && platform.get('SELECT status FROM jobs WHERE id=?', resumed.data.job_id).status === 'running'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(platform.get('SELECT status FROM jobs WHERE id=?', resumed.data.job_id).status, 'completed');
  const successor = platform.get('SELECT * FROM resident_runs WHERE id=?', resumed.data.job_id);
  assert.equal(successor.resumed_from, crashed.id);
  assert.notEqual(successor.credential_hash, recovered.credential_hash);
  // The resumed run observed the world again and never replayed the stored action.
  assert.equal(rsvpCount(platform, alice.id), 1);
  assert.equal((await call('/residents/resume', {})).status, 409);
  assert.equal(platform.verifyAudit(), true);
});

test('a process killed inside a model call is classified as such and holds no duplicate write', async (t) => {
  const f = await fixture(t);
  const { alice, event } = await gathering(f);
  const result = await crash([f.database, f.credentials.alice.token, alice.id, event.id, 'model_call']);
  assert.equal(result.signal, 'SIGKILL', `The child process did not die as intended: ${JSON.stringify(result)}`);

  const crashed = f.platform.get('SELECT * FROM resident_runs ORDER BY started_at DESC LIMIT 1');
  assert.equal(crashed.phase, 'model_call');
  assert.equal(crashed.model_calls, 2);
  assert.equal(crashed.action_count, 1);
  const { platform } = await restart(f);
  t.after(() => platform.close());
  const recovered = platform.get('SELECT * FROM resident_runs WHERE id=?', crashed.id);
  assert.equal(platform.get('SELECT status FROM jobs WHERE id=?', crashed.id).status, 'interrupted');
  assert.equal(recovered.interrupted, 'model_call_in_flight');
  assert.equal(recovered.status, 'interrupted');
  assert.match(platform.get('SELECT detail FROM jobs WHERE id=?', crashed.id).detail, /while a model call was in flight/);
  assert.equal(platform.get('SELECT revoked FROM tokens WHERE hash=?', recovered.credential_hash).revoked, 1);
  assert.equal(rsvpCount(platform, alice.id), 1);
  // Recovery is a restart action, not a loop: a second start changes nothing.
  const again = new Platform(f.database);
  t.after(() => again.close());
  assert.equal(again.get('SELECT interrupted FROM resident_runs WHERE id=?', crashed.id).interrupted, 'model_call_in_flight');
  assert.equal(again.get("SELECT COUNT(*) AS n FROM audit WHERE event='resident.run.interrupted'").n, 1);
  assert.equal(rsvpCount(again, alice.id), 1);
});

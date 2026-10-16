import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fixture } from '../../tests/helpers.js';
import { createApp } from '../../server.js';
import { ExternalWorkerClient } from './client.mjs';

test('external worker executes permitted action and fails closed after uncertain move', async (t) => {
  const f = await fixture(t);
  const app = createApp({ platform: f.platform });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.stopWorkers();
    await new Promise((resolve) => {
      app.server.close(resolve);
      app.server.closeAllConnections();
    });
  });

  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const tempDir = await mkdtemp(join(tmpdir(), 'worker-test-'));
  const stateFile = join(tempDir, 'worker-state.json');
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // 1. Create agent and runtime credential
  const agent = f.tx('createAgent', f.actor('admin'), {
    name: 'External Worker Agent',
    capabilities: 'Patrols commons',
    limitations: 'Scattered range',
    color: '#397f79',
    symbol: '✦',
  });

  // Give agent an unblocked position in commons: (15, 15)
  f.platform.run("UPDATE agents SET world_id='commons', x=15, y=15, z=0, grounded=1 WHERE id=?", agent.id);

  const startRes = await fetch(`${baseUrl}/api/v1/runtime/start`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${f.credentials.admin.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      agent_id: agent.id,
      scopes: ['read', 'move'],
      minutes: 10,
      max_calls: 20,
    }),
  });
  assert.equal(startRes.status, 201);
  const { token } = await startRes.json();

  // Test 1: Normal permitted move execution
  const client1 = new ExternalWorkerClient({
    apiUrl: baseUrl,
    token,
    stateFile,
    agentId: agent.id,
  });

  const step1Result = await client1.performPermittedMove('right', 'action-step-1');
  assert.equal(step1Result.skipped, false);
  assert.equal(step1Result.result.x, 16);
  assert.equal(step1Result.result.y, 15);

  const dbRow1 = f.platform.get('SELECT x, y FROM agents WHERE id=?', agent.id);
  assert.equal(dbRow1.x, 16);
  assert.equal(dbRow1.y, 15);

  // Calling step 1 again is skipped according to local state
  const step1Replay = await client1.performPermittedMove('right', 'action-step-1');
  assert.equal(step1Replay.skipped, true);
  assert.match(step1Replay.reason, /already completed/);

  // Advance clock past 120ms rate limit
  f.advance(500);

  // Test 2: Failure Injection: Crash immediately after server commits move, BEFORE completion is logged
  class SimulatedWorkerCrash extends Error {}

  const crashingClient = new ExternalWorkerClient({
    apiUrl: baseUrl,
    token,
    stateFile,
    agentId: agent.id,
    onBeforeSaveCompletion: async () => {
      // Simulate process crash / SIGKILL right after HTTP response arrives
      throw new SimulatedWorkerCrash('SIMULATED CRASH: Process killed before saving completion record.');
    },
  });

  await assert.rejects(
    async () => {
      await crashingClient.performPermittedMove('down', 'action-step-2-crashable');
    },
    SimulatedWorkerCrash
  );

  // Verify state file immediately after crash:
  // - completedActions must NOT contain action-step-2-crashable
  // - inFlight MUST contain the intent with target (16, 16)
  const rawStateAfterCrash = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.ok(!rawStateAfterCrash.completedActions.includes('action-step-2-crashable'), 'Crash prevented completion logging');
  assert.ok(rawStateAfterCrash.inFlight !== null, 'inFlight intent was persisted before dispatch');
  assert.equal(rawStateAfterCrash.inFlight.actionId, 'action-step-2-crashable');
  assert.equal(rawStateAfterCrash.inFlight.expectedTarget.x, 16);
  assert.equal(rawStateAfterCrash.inFlight.expectedTarget.y, 16);

  // Authoritative server state check: the server DID process the move to (16, 16)
  const dbRowAfterCrash = f.platform.get('SELECT x, y FROM agents WHERE id=?', agent.id);
  assert.equal(dbRowAfterCrash.x, 16);
  assert.equal(dbRowAfterCrash.y, 16);

  // A coordinate at the target is consistent with a commit, but cannot prove it.
  f.advance(500);
  const recoveredClient = new ExternalWorkerClient({
    apiUrl: baseUrl,
    token,
    stateFile,
    agentId: agent.id,
  });

  const observation = await recoveredClient.reconcileInFlight();
  assert.equal(observation.outcome, 'observed_target');
  assert.equal(observation.requiresOperatorResolution, true);
  await assert.rejects(recoveredClient.performPermittedMove('down', 'action-step-2-crashable'), /operator resolution is required/);
  await assert.rejects(recoveredClient.performPermittedMove('right', 'new-action'), /operator resolution is required/);

  // Verify server database position: agent MUST still be at (16, 16), proving NO duplicate move occurred!
  const dbRowAfterReconcile = f.platform.get('SELECT x, y FROM agents WHERE id=?', agent.id);
  assert.equal(dbRowAfterReconcile.x, 16, 'X coordinate must not have changed');
  assert.equal(dbRowAfterReconcile.y, 16, 'Y coordinate must remain 16 (did not replay move)');

  // The saved intent remains unresolved for operator inspection.
  const stateAfterReconcile = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.ok(!stateAfterReconcile.completedActions.includes('action-step-2-crashable'));
  assert.equal(stateAfterReconcile.inFlight.actionId, 'action-step-2-crashable');

  // An origin observation is also uncertain: a delayed request could still commit.
  f.advance(500);
  stateAfterReconcile.inFlight = {
    actionId: 'action-step-3-uncommitted',
    type: 'move',
    direction: 'left',
    origin: { x: 16, y: 16, world_id: 'commons' },
    expectedTarget: { x: 15, y: 16, world_id: 'commons' },
    dispatchedAt: Date.now(),
    status: 'in_flight',
  };
  recoveredClient.state = stateAfterReconcile;
  recoveredClient._saveState();

  const reconUncommitted = await recoveredClient.reconcileInFlight();
  assert.equal(reconUncommitted.outcome, 'observed_origin');
  await assert.rejects(recoveredClient.performPermittedMove('left', 'action-step-3-uncommitted'), /operator resolution is required/);

  const stateAfterUncommitted = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(stateAfterUncommitted.inFlight.actionId, 'action-step-3-uncommitted');
  assert.ok(!stateAfterUncommitted.completedActions.includes('action-step-3-uncommitted'));

  // Test 5: Diverged position classification
  f.advance(500);
  // Suppose agent was teleported by admin to (20, 20)
  f.platform.run("UPDATE agents SET x=20, y=20 WHERE id=?", agent.id);
  stateAfterUncommitted.inFlight = {
    actionId: 'action-step-4-diverged',
    type: 'move',
    direction: 'left',
    origin: { x: 16, y: 16, world_id: 'commons' },
    expectedTarget: { x: 15, y: 16, world_id: 'commons' },
    dispatchedAt: Date.now(),
    status: 'in_flight',
  };
  recoveredClient.state = stateAfterUncommitted;
  recoveredClient._saveState();

  const reconDiverged = await recoveredClient.reconcileInFlight();
  assert.equal(reconDiverged.outcome, 'observed_elsewhere');
  await assert.rejects(recoveredClient.performPermittedMove('right', 'action-step-5'), /operator resolution is required/);

  const stateAfterDiverged = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(stateAfterDiverged.inFlight.actionId, 'action-step-4-diverged');

  // Corruption cannot reset the journal and silently permit a replay.
  writeFileSync(stateFile, '{bad json');
  assert.throws(() => new ExternalWorkerClient({ apiUrl: baseUrl, token, stateFile, agentId: agent.id }), /unreadable/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { runEvaluationSuite } from '../scripts/resident-conversation-eval.mjs';
import { fixture } from './helpers.js';
import { createApp } from '../server.js';

test('real conversation evaluation suite executes against disposable server and passes all cases', async (t) => {
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

  const baseUrl = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const eveAgent = f.tx('createAgent', f.actor('reviewer'), {
    name: 'Eve Avatar',
    capabilities: 'Snoop',
    limitations: 'None',
    color: '#000000',
    symbol: 'E',
  });

  const summary = await runEvaluationSuite({
    baseUrl,
    platform: f.platform,
    server: app.server,
    advanceClock: f.advance,
    credentials: {
      admin: f.credentials.admin.token,
      alice: f.credentials.alice.token,
      bob: f.credentials.bob.token,
      eve: f.credentials.reviewer.token,
      aliceAgent: f.agent('alice'),
      bobAgent: f.agent('bob'),
      eveAgent,
    },
  });

  assert.equal(summary.total, 8, 'Expected 8 real evaluation cases');
  assert.equal(summary.failed, 0, `Expected 0 failures, got ${summary.failed}: ${JSON.stringify(summary.cases.filter(c => !c.passed))}`);
  assert.equal(summary.passed, 8, 'Expected all 8 cases to pass');
  assert.equal(summary.score, '100.0%');
  assert.ok(summary.cases.every((item) => item.model_inference_ran === false), 'This fixture checks scripted routes, not model inference');

  // Verify that database persistence assertions succeeded
  const storedAliceConversations = f.platform.all("SELECT * FROM ambassador_conversations WHERE account_id=?", f.actor('alice').account.id);
  assert.ok(storedAliceConversations.length >= 5, 'Must have recorded ambassador conversations in SQLite');

  // Verify private message table
  const privateMessages = f.platform.all("SELECT * FROM messages WHERE channel='private'");
  assert.equal(privateMessages.length, 1, 'Only the authorized Alice-to-Bob private message should be stored');
  assert.equal(privateMessages[0].account_id, f.actor('alice').account.id);
});

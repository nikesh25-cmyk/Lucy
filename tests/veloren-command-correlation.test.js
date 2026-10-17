// Correlate trusted acknowledgements with the actual issued command and player.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VelorenLink, signEvent, LINK_POLICY } from '../src/veloren-link.js';
const KEY = Buffer.alloc(32, 7); // Public, disposable test key; never a live credential.
const PLAYER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = 1_760_572_800_000;
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nemo-command-acceptance-'));
  const link = new VelorenLink({ dbPath: join(dir, 'link.sqlite'), eventKey: KEY, clock: () => NOW,
    landmarks: [{ id: 'post', name: 'Post', role: 'post' }, { id: 'field', name: 'Field', role: 'survey' }],
    commandsPath: join(dir, 'commands.jsonl'), extensions: [] });
  t.after(() => { link.close(); rmSync(dir, { recursive: true, force: true }); });
  const cred = link.issueCredential({ resident_id: 'lw-lyra', scopes: ['events'], days: 1 });
  const auth = link.authenticate(cred.token, 'events');
  const command = link.issueCommand({ kind: 'echo', player_uuid: PLAYER });
  function ingest(id, overrides = {}) {
    const e = { v: 1, server_id: 'audit-server', seq: 1, kind: 'command.applied', resident_id: 'lw-lyra',
      player_uuid: PLAYER, player_alias: '', landmark_id: id, occurred_at: NOW, ...overrides };
    e.sig = signEvent(KEY, e);
    return link.ingest(auth, [e]);
  }
  return { link, command, ingest };
}
test('a signed acknowledgement for another player cannot mark this command applied', t => {
  const { link, command, ingest } = setup(t);
  ingest(command.cmd_id, { player_uuid: OTHER });
  assert.equal(link.commandStatus(command.cmd_id).status, 'pending');
});
test('a signed acknowledgement cannot create a command that was never issued', t => {
  const { link, ingest } = setup(t);
  const unknown = '33333333-3333-4333-8333-333333333333';
  ingest(unknown);
  assert.equal(link.commandStatus(unknown).status, 'unknown');
});
test('an acknowledgement older than the allowed clock skew cannot confirm a new command', t => {
  const { link, command, ingest } = setup(t);
  ingest(command.cmd_id, { occurred_at: NOW - LINK_POLICY.future_skew_ms - 1 });
  assert.equal(link.commandStatus(command.cmd_id).status, 'pending');
});
test('the existing clock skew allowance also applies to acknowledgement correlation', t => {
  const { link, command, ingest } = setup(t);
  assert.equal(ingest(command.cmd_id, { occurred_at: NOW - 1000 })[0].status, 'accepted');
  assert.equal(link.commandStatus(command.cmd_id).status, 'applied');
});
test('a later contradictory acknowledgement cannot replace the first terminal outcome', t => {
  const { link, command, ingest } = setup(t);
  assert.equal(ingest(command.cmd_id)[0].status, 'accepted');
  assert.equal(ingest(command.cmd_id, { seq: 2, kind: 'command.rejected' })[0].reason, 'command_outcome_conflict');
  assert.equal(link.commandStatus(command.cmd_id).status, 'applied');
  assert.equal(ingest(command.cmd_id, { seq: 3 })[0].status, 'accepted');
});

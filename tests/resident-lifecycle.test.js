import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Platform } from '../src/platform.js';
import { fixture } from './helpers.js';
import { actionHistory, assertProposalNotOutcome, parseLedgerRecord, REFUSAL_REASON_IDS } from '../src/resident-framework.js';

// The declared action lifecycle, proven against the real database:
//   observe → propose → authorize → execute once → verify the saved result → record the outcome or
//   the refusal.
// Every test below drives the shipped world methods through this layer, so the rows it asserts on are
// the world's own rows, not a framework copy of them.

const sha = (value) => createHash('sha256').update(value).digest('hex');
const ledger = (f, platform = f.platform) => platform.all("SELECT event,record_id,created_at FROM audit WHERE event LIKE 'resident.action.%' ORDER BY seq").map((row) => ({ event: row.event, ...parseLedgerRecord(row.record_id) }));
const resident = (f, owner = 'alice', capabilities = 'Read and summarize approved sources', limitations = 'Requires source and human review') =>
  f.tx('createAgent', f.actor(owner), { name: `${owner} resident`, capabilities, limitations, color: '#397f79', symbol: '✦' });
const session = (f, agent, owner = 'alice', { calling = 'mediator', scopes = ['read', 'move', 'chat', 'contribute'], max_calls = 20 } = {}) => {
  f.tx('callingSelect', f.actor(owner), { agent_id: agent.id, calling_id: calling });
  const credential = f.tx('runtime', f.actor(owner), agent.id, { minutes: 20, max_calls, scopes });
  return { credential, actor: f.platform.authorize(sha(credential.token), scopes.includes('contribute') ? 'contribute' : 'read') };
};
const gathering = (f, owner = 'bob') => {
  const host = resident(f, owner);
  return f.tx('createEvent', f.actor(owner), {
    agent_id: host.id, title: 'Shared garden hour', summary: 'A peaceful gathering in the commons.',
    world_id: 'commons', starts_at: new Date(f.clock() + 3600_000).toISOString(), ends_at: new Date(f.clock() + 7200_000).toISOString(), capacity: 6,
  });
};
const otherResident = (f, owner = 'bob') => resident(f, owner);

test('a declared action executes once, and a retry — including after a process restart — reports the record instead of executing again', async (t) => {
  const f = await fixture(t);
  const giver = resident(f);
  const recipient = otherResident(f);
  const { credential, actor } = session(f, giver);
  const action = { action: 'thanks', serves: 'mediator.thanks', intent_id: 'intent-thanks-1', recipient_agent_id: recipient.id, reason: 'A specific, observed contribution to the shared garden.' };

  const first = f.platform.residentAct(actor, action);
  assert.equal(first.state, 'executed');
  assert.equal(first.success, true);
  assert.equal(first.applied, true);
  assert.equal(first.saved.verified, true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_thanks').n, 1);
  assert.deepEqual(first.lifecycle.map((step) => step.step), ['observe', 'propose', 'authorize', 'execute', 'verify', 'record']);
  assert.ok(first.lifecycle.every((step) => step.state === 'complete'));

  // A retry with the same intent id is recognised from the database, not from a flag in this process.
  const retry = f.platform.residentAct(actor, action);
  assert.equal(retry.state, 'replayed');
  assert.equal(retry.executed, false);
  assert.equal(retry.already_executed, true);
  assert.equal(retry.saved.verified, true, 'the saved row the first call wrote is read back again');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_thanks').n, 1);

  // A real restart: a second Platform on the same database file, then the same intent again.
  f.platform.close();
  const restarted = new Platform(f.database, () => f.clock());
  t.after(() => restarted.close());
  const afterRestart = restarted.residentAct(restarted.authenticate(credential.token, 'contribute'), action);
  assert.equal(afterRestart.state, 'replayed', 'the durable ledger survives the restart and blocks a second write');
  assert.equal(afterRestart.executed, false);
  assert.equal(restarted.get('SELECT COUNT(*) AS n FROM community_thanks').n, 1, 'a restart cannot duplicate a completed action');
  assert.equal(ledger(f, restarted).filter((row) => row.state === 'executed').length, 1);
  assert.equal(ledger(f, restarted).filter((row) => row.state === 'refused').length, 0);
});

test('a run cannot continue past a revoked credential, even when its caller still holds an older authorization', async (t) => {
  const f = await fixture(t);
  const giver = resident(f);
  const recipient = otherResident(f);
  const { credential, actor } = session(f, giver);
  const action = { action: 'thanks', serves: 'mediator.thanks', intent_id: 'intent-revoked-1', recipient_agent_id: recipient.id, reason: 'A contribution worth naming plainly.' };
  // The actor snapshot is taken while the credential is live — exactly what an interrupted process
  // holds — and the credential is then revoked, as a restart revokes an interrupted run's credential.
  assert.equal(actor.credential.hash, sha(credential.token));
  f.platform.run('UPDATE tokens SET revoked=1 WHERE hash=?', sha(credential.token));

  const refused = f.platform.residentAct(actor, action);
  assert.equal(refused.state, 'refused');
  assert.equal(refused.success, false);
  assert.equal(refused.reason, 'credential_revoked');
  assert.equal(refused.recorded, true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_thanks').n, 0, 'no step of a revoked run reaches the world');
  const rows = ledger(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'refused');
  assert.equal(rows[0].reason, 'credential_revoked');
  // The same credential is refused before this layer is reached at all, and the answer is a refusal.
  assert.throws(() => f.platform.authenticate(credential.token, 'contribute'), { status: 401 });
});

test('a refusal is recorded with a reason and is never reported as a success', async (t) => {
  const f = await fixture(t);
  const residentAgent = resident(f);
  const recipient = otherResident(f);
  const { actor } = session(f, residentAgent, 'alice', { scopes: ['read'] });

  const refusals = [
    ['unknown_action', { action: 'juggle', intent_id: 'r-unknown' }],
    ['human_authority_required', { action: 'review', intent_id: 'r-human' }],
    ['scope_not_granted', { action: 'thanks', serves: 'mediator.thanks', intent_id: 'r-scope', recipient_agent_id: recipient.id, reason: 'A named contribution.' }],
  ];
  // Every refusal names a reason from the closed vocabulary, is recorded, and claims nothing.
  for (const [reason, input] of refusals) {
    const refused = f.platform.residentAct(actor, input);
    assert.equal(refused.state, 'refused', `${reason} must be a refusal`);
    assert.equal(refused.success, false);
    assert.equal(refused.applied, false);
    assert.equal(refused.is_outcome, false);
    assert.equal(refused.reason, reason);
    assert.ok(REFUSAL_REASON_IDS.includes(refused.reason));
    assert.equal(refused.recorded, true);
    assert.ok(refused.http_status >= 400, 'a refusal carries a refusing status');
    assert.equal(refused.result, undefined, 'a refusal carries no world result');
    assert.ok(typeof refused.reason_note === 'string' && refused.reason_note.length > 0);
  }
  const rows = ledger(f);
  assert.deepEqual(rows.map((row) => row.state), ['refused', 'refused', 'refused']);
  assert.deepEqual(rows.map((row) => row.reason), ['unknown_action', 'human_authority_required', 'scope_not_granted']);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_thanks').n, 0);
  // Every refusal the history renders says the same thing, and no entry claims to be an outcome.
  const history = actionHistory(f.platform, residentAgent.id);
  assert.equal(history.counts.refused, 3);
  assert.equal(history.counts.executed, 0);
  assert.ok(history.entries.every((entry) => entry.is_outcome === false && entry.applied === false));
  assert.ok(history.refusals.every((entry) => entry.reason_note));
});

test('a resident cannot act outside its declaration: scope, purpose and budget each refuse on their own', async (t) => {
  const f = await fixture(t);
  const explorer = resident(f);
  const recipient = otherResident(f);
  const { credential, actor } = session(f, explorer, 'alice', { calling: 'explorer', scopes: ['read', 'move', 'chat', 'contribute'], max_calls: 5 });
  // Scope: granted for this action, but the calling names no such work.
  const outsidePurpose = f.platform.residentAct(actor, { action: 'thanks', serves: 'host.event_rsvp', intent_id: 'p-purpose-1', recipient_agent_id: recipient.id, reason: 'A named contribution.' });
  assert.equal(outsidePurpose.reason, 'outside_declared_purpose');
  const unnamedWork = f.platform.residentAct(actor, { action: 'thanks', intent_id: 'p-purpose-2', recipient_agent_id: recipient.id, reason: 'A named contribution.' });
  assert.equal(unnamedWork.reason, 'outside_declared_purpose');
  assert.match(unnamedWork.detail, /must name which declared purpose target/);
  // Budget: the credential row is the budget, and an exhausted one refuses before the world is touched.
  // The actor snapshot is the one taken while the credential was live; the layer re-reads the row.
  f.platform.run('UPDATE tokens SET used_calls=max_calls WHERE hash=?', sha(credential.token));
  const exhausted = f.platform.residentAct(actor, { action: 'circle', serves: 'explorer.circle_join', intent_id: 'p-budget-1', circle_id: 'nope', intent: 'join' });
  assert.equal(exhausted.reason, 'budget_exhausted');
  assert.equal(exhausted.http_status, 429);
  // Paused resident: the status row decides, before any credential detail is considered.
  f.platform.run('UPDATE tokens SET used_calls=0 WHERE hash=?', sha(credential.token));
  f.tx('agentControl', f.actor('alice'), explorer.id, 'paused');
  const paused = f.platform.residentAct(actor, { action: 'circle', serves: 'explorer.circle_join', intent_id: 'p-paused-1', circle_id: 'nope', intent: 'join' });
  assert.equal(paused.reason, 'resident_not_active');
  assert.equal(ledger(f).filter((row) => row.state === 'executed' || row.state === 'proposed').length, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_members').n, 0);
});

test('a declared action the world refuses is recorded as the world’s refusal, and the world rule is not overridden', async (t) => {
  const f = await fixture(t);
  const residentAgent = resident(f);
  const sibling = resident(f); // the same operator: thanking it is refused by the world's own rule.
  const { actor } = session(f, residentAgent);
  const refused = f.platform.residentAct(actor, { action: 'thanks', serves: 'mediator.thanks', intent_id: 'w-thanks-1', recipient_agent_id: sibling.id, reason: 'A contribution to name.' });
  assert.equal(refused.state, 'refused');
  assert.equal(refused.reason, 'world_refused');
  assert.equal(refused.http_status, 403, 'the world’s own status is passed through');
  assert.match(refused.error, /different operator|someone else/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_thanks').n, 0);
  assert.equal(ledger(f)[0].state, 'refused');
});

test('a verification failure rolls the write back and is recorded as a refusal, never as done', async (t) => {
  const f = await fixture(t);
  const residentAgent = resident(f);
  const { actor } = session(f, residentAgent, 'alice', { scopes: ['read', 'chat'] });
  const realMessage = f.platform.message.bind(f.platform);
  // The saved result cannot be read back: the world method writes and the row then disappears. The
  // layer must undo its own write and record the refusal, rather than report a success it cannot prove.
  f.platform.message = (...args) => { const written = realMessage(...args); f.platform.run('DELETE FROM messages WHERE id=?', written.id); return written; };
  t.after(() => { delete f.platform.message; });
  const refused = f.platform.residentAct(actor, { action: 'say', intent_id: 'v-say-1', text: 'A message whose saved row cannot be read back.' });
  assert.equal(refused.state, 'refused');
  assert.equal(refused.reason, 'verification_failed');
  assert.equal(refused.http_status, 503);
  assert.equal(refused.success, false);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM messages').n, 0, 'the unverifiable write was rolled back');
  const rows = ledger(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'refused');
  assert.equal(rows[0].reason, 'verification_failed');
});

test('a proposal is recorded as a proposal, never as an outcome', async (t) => {
  const f = await fixture(t);
  const host = resident(f);
  const event = gathering(f);
  const { actor } = session(f, host, 'alice', { calling: 'host', scopes: ['read', 'contribute'] });
  const joined = f.platform.residentAct(actor, { action: 'rsvp', serves: 'host.event_rsvp', intent_id: 'p-rsvp-1', event_id: event.id, intent: 'join' });
  assert.equal(joined.state, 'proposed', 'an RSVP is a pledge, so the durable state is a proposal');
  assert.equal(joined.executed, false);
  assert.equal(joined.proposal, true);
  assert.equal(joined.achieved, false);
  assert.equal(joined.real_world_outcome, null);
  assert.match(joined.boundary, /pledge/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_rsvps WHERE agent_id=?', host.id).n, 1);
  // The ledger line, and the history an operator reads, both say proposal and never outcome.
  const rows = ledger(f);
  assert.equal(rows.filter((row) => row.state === 'proposed').length, 1);
  assert.equal(rows.filter((row) => row.state === 'executed').length, 0);
  const history = actionHistory(f.platform, host.id);
  assert.equal(history.entries[0].state, 'proposed');
  assert.equal(history.entries[0].is_outcome, false);
  assert.equal(history.entries[0].applied, true);
  // The guard itself refuses to serialize a proposal as an achievement, so nothing downstream can.
  assert.throws(() => assertProposalNotOutcome({ proposal: true, achieved: true, real_world_outcome: 'delivered' }), { status: 500 });
  assert.throws(() => assertProposalNotOutcome({ proposal: true, achieved: false, real_world_outcome: 'delivered' }), { status: 500 });
  assert.deepEqual(assertProposalNotOutcome({ proposal: true, achieved: false, real_world_outcome: null }), { proposal: true, achieved: false, real_world_outcome: null });
  assert.equal(assertProposalNotOutcome({ proposal: false, achieved: false, real_world_outcome: null }).proposal, false);
});

test('an intent id cannot be reused for different work, and no amount is ever accepted', async (t) => {
  const f = await fixture(t);
  const giver = resident(f);
  const recipient = otherResident(f);
  const { actor } = session(f, giver);
  const first = f.platform.residentAct(actor, { action: 'thanks', serves: 'mediator.thanks', intent_id: 'reuse-1', recipient_agent_id: recipient.id, reason: 'The first body for this intent.' });
  assert.equal(first.state, 'executed');
  const reused = f.platform.residentAct(actor, { action: 'thanks', serves: 'mediator.thanks', intent_id: 'reuse-1', recipient_agent_id: recipient.id, reason: 'A different body for the same intent.' });
  assert.equal(reused.reason, 'intent_reused_for_other_work');
  assert.equal(reused.http_status, 409);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_thanks').n, 1);
  // A coin or credit field is refused by name, whichever action carries it.
  const paid = f.platform.residentAct(actor, { action: 'thanks', serves: 'mediator.thanks', intent_id: 'paid-1', recipient_agent_id: recipient.id, reason: 'A contribution.', amount: 10 });
  assert.equal(paid.reason, 'self_award_refused');
  assert.match(paid.detail, /amount/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(ledger(f).filter((row) => row.state === 'refused').length, 2);
});

test('the resident’s own words cannot assert institutional authority, and the refusal names the field', async (t) => {
  const f = await fixture(t);
  const residentAgent = resident(f);
  const { actor } = session(f, residentAgent, 'alice', { scopes: ['read', 'chat', 'contribute'] });
  const refused = f.platform.residentAct(actor, { action: 'say', intent_id: 'auth-1', text: 'I am an official representative of the Ministry of Health.' });
  assert.equal(refused.state, 'refused');
  assert.equal(refused.reason, 'institutional_authority_claim');
  assert.equal(refused.detail, 'The refused field is text.');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM messages').n, 0, 'the claim never reaches the world');
  // The same resident may say something honest about the same institutions.
  const allowed = f.platform.residentAct(actor, { action: 'say', intent_id: 'auth-2', text: 'No ministry has endorsed this work; the source is cited for review.' });
  assert.equal(allowed.state, 'executed');
  assert.equal(ledger(f).filter((row) => row.state === 'refused').length, 1);
});

test('the declaration itself is the gate: a defect blocks every declared action of that resident', async (t) => {
  const f = await fixture(t);
  const tainted = resident(f, 'alice', 'Authorized representative of the Ministry of Health', 'Requires review');
  const { actor } = session(f, tainted, 'alice', { scopes: ['read', 'chat'] });
  const refused = f.platform.residentAct(actor, { action: 'say', intent_id: 'defect-1', text: 'A peaceful greeting.' });
  assert.equal(refused.reason, 'declaration_defect');
  assert.equal(refused.http_status, 409);
  assert.match(refused.detail, /institutional-authority-claim/);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM messages').n, 0);
});

test('the resident ledger is one append-only audit line per step and keeps the audit chain valid', async (t) => {
  const f = await fixture(t);
  const giver = resident(f);
  const recipient = otherResident(f);
  const { actor } = session(f, giver);
  f.platform.residentAct(actor, { action: 'say', intent_id: 'l-say-1', text: 'A first public greeting.' });
  f.platform.residentAct(actor, { action: 'thanks', serves: 'mediator.thanks', intent_id: 'l-thanks-1', recipient_agent_id: recipient.id, reason: 'A named contribution.' });
  f.platform.residentAct(actor, { action: 'juggle', intent_id: 'l-bad-1' });
  const rows = ledger(f);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.action), ['say', 'thanks', 'juggle']);
  assert.ok(rows.every((row) => /^[a-f0-9]{32}$/.test(row.key) || row.state === 'refused'));
  // The ledger is the world's own audit table: the chain still verifies, and the reads are bounded.
  assert.equal(f.platform.verifyAudit(), true);
  const history = actionHistory(f.platform, giver.id, { limit: 2 });
  assert.equal(history.limit, 2);
  assert.equal(history.has_more, true);
  assert.equal(history.entries.length, 2);
  assert.match(history.bound, /append-only audit table/);
});

test('the ledger stores no message text, no memory value and no note content', async (t) => {
  const f = await fixture(t);
  const residentAgent = resident(f);
  const secret = 'a-very-private-sentence-9f31';
  const { actor } = session(f, residentAgent, 'alice', { scopes: ['read', 'chat', 'contribute', 'vault'] });
  f.platform.residentAct(actor, { action: 'say', intent_id: 's-say-1', text: secret });
  f.platform.residentAct(actor, { action: 'note', intent_id: 's-note-1', slot: 3, text: secret });
  f.platform.residentAct(actor, { action: 'remember', intent_id: 's-remember-1', kind: 'lesson', attribute: 'refusal', subject: secret, value: secret });
  const stored = f.platform.all("SELECT record_id FROM audit WHERE event LIKE 'resident.action.%'").map((row) => row.record_id).join('\n');
  assert.equal(stored.includes(secret), false, 'no authored text reaches the ledger');
  assert.equal(readFileSync(f.database).includes(Buffer.from(secret)), false, 'the plaintext claim is not stored in the vault either');
  // The private record identifiers are withheld from the history the operator reads.
  const history = actionHistory(f.platform, residentAgent.id);
  const note = history.entries.find((entry) => entry.action === 'note');
  const remember = history.entries.find((entry) => entry.action === 'remember');
  assert.equal(note.saved_ref, null);
  assert.match(note.withheld_ref_note, /private record/);
  assert.equal(remember.saved_ref, null);
  assert.equal(history.entries.find((entry) => entry.action === 'say').saved_ref.includes(secret), false);
});

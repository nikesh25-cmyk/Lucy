// The two contained fixes this wave ships, each with the evidence that it changed behaviour:
//   (a) a draft save answers whether it wrote, instead of answering the same body either way;
//   (b) `claim_drafts.archived` has exactly one writer, and every caller still archives and restores.
// Plus the static witness that the keyed-submission mechanism really applies to each route the
// contract marks as keyed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writesFixture, realMission, PASSWORD } from './framework/writes-harness.js';
import { keyedRoutes, policyFor } from '../src/framework/write-contract.js';

const root = new URL('..', import.meta.url).pathname;
const draft = (claim, values = {}) => ({ claim_id: claim.id, expected_revision: 0, format: 'evidence-form-v1', values: { artifact: 'Incomplete private research', method: 'Read the source.', ...values } });

test('a draft save says whether it wrote, and never reports a save it did not make', async (t) => {
  const f = await writesFixture(t);
  const { task } = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: f.agent('alice').id }, 'fix-draft-claim');
  const stored = () => f.platform.get('SELECT revision,content,archived FROM claim_drafts WHERE claim_id=?', claim.id);

  const first = await f.request('/drafts', { account: 'alice', input: draft(claim) });
  assert.equal(first.status, 200);
  assert.equal(first.data.saved, true, 'a save that wrote must say so');
  assert.equal(stored().revision, first.data.revision, 'the answered revision must be the stored revision');

  // Same content again: the server may skip the write, but then it must not claim one.
  const repeated = await f.request('/drafts', { account: 'alice', input: { ...draft(claim), expected_revision: first.data.revision } });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.saved, false, 'an unchanged save must not report a write it did not make');
  assert.equal(repeated.data.revision, first.data.revision, 'an unchanged save leaves the revision where it was');
  assert.equal(stored().revision, repeated.data.revision);
  assert.equal(JSON.parse(stored().content).values.artifact, 'Incomplete private research', 'the state the answer points at is the state in storage');

  // A real edit answers `saved: true` and moves the stored revision. The platform's own 500 ms
  // save window is respected rather than bypassed.
  f.advance(1_000);
  const edited = await f.request('/drafts', { account: 'alice', input: { ...draft(claim), expected_revision: repeated.data.revision, values: { artifact: 'Edited private research', method: 'Read the source.' } } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.saved, true);
  assert.equal(edited.data.revision, repeated.data.revision + 1);
  assert.equal(stored().revision, edited.data.revision);
  assert.match(stored().content, /Edited private research/);
});

test('only one module writes the draft archive flag, and every caller still archives and restores', async (t) => {
  const source = await readFile(join(root, 'src/drafts.js'), 'utf8');
  const others = [];
  for (const file of ['platform.js', 'spaces.js', 'recovery.js', 'database.js', 'frontier.js', 'journey.js']) {
    const text = await readFile(join(root, 'src', file), 'utf8');
    if (/claim_drafts\s+SET\s+archived/i.test(text)) others.push(`src/${file}`);
  }
  assert.deepEqual(others, [], `these modules write the draft archive flag directly: ${others.join(', ')}`);
  assert.equal([...source.matchAll(/claim_drafts\s+SET\s+archived/gi)].length, 1, 'drafts.js must hold exactly one archive writer');

  // Caller 1: submitting archives the draft it came from, through the single owner.
  const f = await writesFixture(t);
  const { task } = realMission(f);
  const agent = f.agent('alice');
  const submitted = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: agent.id }, 'fix-submit-claim');
  f.tx('draftSave', f.actor('alice'), draft(submitted));
  const submission = f.tx('submit', f.actor('alice'), { claim_id: submitted.id, artifact: 'An attributed evidence register entry.', sources: [{ url: 'https://example.org/report', location: 'Section 2', date: '2026-01-01' }], method: 'Read the original source.', limitations: 'A workflow fixture.', rights: 'Permission checked.' }, 'fix-submission');
  assert.equal(f.platform.get('SELECT archived FROM claim_drafts WHERE claim_id=?', submitted.id).archived, 1, 'submitting archives the draft');
  assert.equal(f.platform.drafts(f.actor('alice')).length, 0);

  // Caller 2: a changes-requested review re-opens it, through the same owner.
  f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'changes_requested', reason: 'Clarify the fixture limitations.' });
  assert.equal(f.platform.get('SELECT archived FROM claim_drafts WHERE claim_id=?', submitted.id).archived, 0, 'a correction re-opens the draft');
  assert.equal(f.platform.drafts(f.actor('alice')).length, 1);

  // Caller 3: the operator's own archive and restore, and caller 4: draft resumption.
  const archived = f.tx('draftArchive', f.actor('alice'), { claim_id: submitted.id, archived: true });
  assert.deepEqual(archived, { archived: true });
  assert.equal(f.platform.get('SELECT archived FROM claim_drafts WHERE claim_id=?', submitted.id).archived, 1);
  f.tx('draftArchive', f.actor('alice'), { claim_id: submitted.id, archived: false });
  assert.equal(f.platform.get('SELECT archived FROM claim_drafts WHERE claim_id=?', submitted.id).archived, 0);
  assert.equal(f.tx('archiveDraft', 'no-such-claim'), false, 'the single owner reports a missing draft instead of writing');
  assert.equal(f.platform.verifyAudit(), true);

  // Caller 5: resumption archives the old claim's draft through the same owner.
  const second = f.tx('createTask', f.actor('admin'), { mission_id: f.platform.get('SELECT mission_id FROM tasks WHERE id=?', task.id).mission_id, title: 'Second fixture task', instructions: 'Record one source.', rights: 'Explicit permission required.', allowed_domains: ['example.org'] });
  const resumable = f.tx('claim', f.actor('bob'), { task_id: second.id, agent_id: f.agent('bob').id }, 'fix-resume-claim');
  f.tx('draftSave', f.actor('bob'), draft(resumable));
  f.platform.run('UPDATE claims SET expires_at=? WHERE id=?', f.clock() - 1_000, resumable.id);
  f.tx('expireClaims');
  f.tx('draftResume', f.actor('bob'), { claim_id: resumable.id }, 'fix-resume-key');
  assert.equal(f.platform.get('SELECT archived FROM claim_drafts WHERE claim_id=?', resumable.id).archived, 1, 'resuming archives the draft it was resumed from');
});

test('the keyed-submission mechanism applies to every route the contract marks as keyed', async (t) => {
  const source = await readFile(join(root, 'server.js'), 'utf8');
  const list = [...source.match(/\} else if \((\[[^\]]+\])\.includes\(route\)\) value = platform\[method\]\(actor, input, request\.headers\['idempotency-key'\]\)/)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const declared = keyedRoutes().map((key) => key.split(' ')[1]);
  assert.deepEqual([...declared].sort(), [...list].sort(), 'the declared keyed set must be the wired keyed set');
  const f = await writesFixture(t);
  const witnesses = [];
  // A method that cannot receive the key cannot honour it. Arity is checked in the source rather than
  // through `Function.length`, because a default parameter (spaces.js `interact(actor, input = {}, key)`)
  // stops the count at the default.
  const methods = { '/claims': 'claim', '/submissions': 'submit', '/drafts/resume': 'draftResume', '/tasks/follow-up': 'createFollowUp', '/quests/join': 'questJoin', '/interact': 'interact', '/journey/offers': 'offerCreate', '/journey/offers/accept': 'offerAccept', '/trade/listings': 'tradePost', '/trade/claim': 'tradeClaim' };
  const modules = ['platform.js', 'drafts.js', 'quests.js', 'journey.js', 'trade-market.js', 'spaces.js'];
  const sources = Object.fromEntries(await Promise.all(modules.map(async (file) => [file, await readFile(join(root, 'src', file), 'utf8')])));
  for (const [route, method] of Object.entries(methods)) {
    assert.ok(policyFor(route).idempotency_keyed, `${route} must be declared keyed`);
    assert.ok(typeof f.platform[method] === 'function', `${method} must exist on the live platform`);
    const declaration = Object.entries(sources).map(([file, text]) => [file, new RegExp(`^\\s*${method}\\(([^)]*)\\)\\s*\\{`, 'm').exec(text)]).find(([, match]) => match);
    assert.ok(declaration, `${method} must be declared in a source module`);
    const parameters = declaration[1][1].split(',').map((item) => item.trim().split('=')[0].trim()).filter(Boolean);
    assert.ok(parameters.length >= 3, `${method} in src/${declaration[0]} takes ${parameters.length} parameter(s); the key has nowhere to arrive`);
    witnesses.push(`${route} → ${method}(${parameters.slice(0, 3).join(', ')})`);
  }
  assert.equal(witnesses.length, 10);
  assert.equal(PASSWORD.length > 0, true);
});

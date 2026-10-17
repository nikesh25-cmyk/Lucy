import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { declarationCore, declarationDefects, institutionalClaim, RESIDENT_DECLARATION_FORMAT, PROHIBITIONS, DECLARED_ACTIONS } from '../src/resident-framework.js';
import { CALLINGS } from '../src/vocations.js';

// The declaration is derived, never stored: every field below is read back from the row that already
// owns it. These tests assert both directions — the declared value matches its source row, and
// changing the source row changes the declaration with no write to any declaration store.

const purpose = (f, agent, changes = {}) => f.tx('memoryManage', f.actor('alice'), {
  action: 'record', agent_id: agent.id, kind: 'purpose', attribute: 'intent', subject: 'Chosen purpose',
  value: 'Keep a shared garden walkable for every operator.', ...changes,
});

test('the declaration is derived from the agent, calling, purpose facts, credential and status rows', async (t) => {
  const f = await fixture(t);
  const resident = f.agent('alice');
  const recorded = purpose(f, resident);
  const credential = f.tx('runtime', f.actor('alice'), resident.id, { minutes: 15, max_calls: 40, scopes: ['read', 'move', 'chat', 'contribute'] });
  const declared = declarationCore(f.platform, f.platform.get('SELECT * FROM agents WHERE id=?', resident.id), {});

  assert.equal(declared.format, RESIDENT_DECLARATION_FORMAT);
  // identity: the one agent row, its operator and its state.
  assert.equal(declared.identity.agent_id, resident.id);
  assert.equal(declared.identity.operator_id, f.actor('alice').account.id);
  assert.equal(declared.identity.state, f.platform.get('SELECT status FROM agents WHERE id=?', resident.id).status);
  // calling: the stored selection and the catalog entry's own words.
  const calling = CALLINGS.find((item) => item.id === f.platform.get('SELECT calling_id FROM resident_callings WHERE agent_id=?', resident.id).calling_id);
  assert.equal(declared.calling.id, calling.id);
  assert.equal(declared.calling.purpose, calling.purpose);
  assert.deepEqual(declared.calling.objectives.map((objective) => objective.id), calling.objectives.map((objective) => `${calling.id}.${objective.id}`));
  // purpose: the operator-recorded purpose fact, and nothing else.
  assert.equal(declared.purpose.source, 'operator-recorded-purpose');
  assert.deepEqual(declared.purpose.facts.map((fact) => fact.value), [recorded.fact.value]);
  assert.equal(declared.purpose.statement, recorded.fact.value);
  // budget: the issued runtime credential row.
  const token = f.platform.get("SELECT max_calls,used_calls,expires_at,revoked,scopes FROM tokens WHERE agent_id=? AND kind='runtime'", resident.id);
  assert.equal(declared.budget.max_calls, token.max_calls);
  assert.equal(declared.budget.remaining_calls, token.max_calls - token.used_calls);
  assert.equal(declared.budget.expires_at, token.expires_at);
  assert.deepEqual(declared.budget.scopes, JSON.parse(token.scopes));
  assert.equal(declared.budget.live_credential, true);
  // permitted actions: the credential's scopes crossed with the calling's own objective sources.
  const say = declared.permitted_actions.find((entry) => entry.action === 'say');
  assert.equal(say.granted, true);
  assert.equal(say.scope, DECLARED_ACTIONS.say.scope);
  assert.equal(declared.permitted_actions.find((entry) => entry.action === 'note').granted, false, 'the vault scope was not granted');
  assert.equal(declared.permitted_actions.find((entry) => entry.action === 'garden').granted, false, 'the build scope was not granted');
  // limitations: the operator's own text plus the policy texts the world already states.
  assert.deepEqual(declared.limitations.declared, ['Requires source and human review']);
  assert.equal(declared.limitations.capabilities, 'Read and summarize approved sources');
  assert.ok(declared.limitations.policy.some((line) => /independently accepted/.test(line)));
  // prohibitions: all four are declared, with where each guard lives.
  assert.deepEqual(PROHIBITIONS.map((rule) => rule.id), ['self-review', 'institutional-authority', 'self-award', 'proposal-not-outcome']);
  assert.deepEqual(declared.prohibitions.map((rule) => rule.id), PROHIBITIONS.map((rule) => rule.id));
  assert.ok(declared.prohibitions.every((rule) => rule.where && rule.guard));
  // No declaration store exists: the framework added no table and no column.
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE '%declar%'").n, 0);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM pragma_table_info('agents') WHERE name LIKE '%declar%'").n, 0);
  assert.equal(credential.scopes.join(','), 'read,move,chat,contribute');
});

test('changing an existing row changes the declaration, and nothing else', async (t) => {
  const f = await fixture(t);
  const resident = f.agent('alice');
  const before = declarationCore(f.platform, f.platform.get('SELECT * FROM agents WHERE id=?', resident.id), {});
  assert.equal(before.purpose.source, 'calling-default');
  assert.equal(before.budget.present, false);
  assert.equal(before.may_act, false);
  assert.equal(before.may_act_reason, 'runtime_credential_required');
  // One recorded purpose fact and one issued credential are the only two writes made here.
  const recorded = purpose(f, resident, { value: 'Hold a shared path open for neighbours.' });
  const credential = f.tx('runtime', f.actor('alice'), resident.id, { minutes: 10, max_calls: 12, scopes: ['read', 'chat'] });
  const after = declarationCore(f.platform, f.platform.get('SELECT * FROM agents WHERE id=?', resident.id), {});
  assert.equal(after.purpose.facts[0].value, recorded.fact.value);
  assert.equal(after.budget.max_calls, 12);
  assert.equal(after.may_act, true);
  assert.equal(after.may_act_reason, 'The resident holds a live credential with at least one available declared action.');
  // Revoking the credential row is the whole revocation: the declaration follows it with no other write.
  f.tx('agentControl', f.actor('alice'), resident.id, 'revoked');
  const revoked = declarationCore(f.platform, f.platform.get('SELECT * FROM agents WHERE id=?', resident.id), {});
  assert.equal(revoked.identity.state, 'revoked');
  assert.equal(revoked.budget.live_credential, false);
  assert.equal(revoked.may_act, false);
  assert.equal(revoked.may_act_reason, 'resident_not_active');
  assert.equal(f.platform.get("SELECT revoked FROM tokens WHERE agent_id=? AND kind='runtime'", resident.id).revoked, 1);
});

test('a work action is only declared for the objective sources of the resident’s own calling', async (t) => {
  const f = await fixture(t);
  const resident = f.agent('alice');
  f.tx('runtime', f.actor('alice'), resident.id, { minutes: 10, max_calls: 20, scopes: ['read', 'move', 'chat', 'contribute', 'build'] });
  const declared = declarationCore(f.platform, f.platform.get('SELECT * FROM agents WHERE id=?', resident.id), {});
  // The default calling is the explorer's; a thanks serves the mediator's second objective only.
  assert.deepEqual(declared.permitted_actions.find((entry) => entry.action === 'thanks').serves, []);
  assert.equal(declared.permitted_actions.find((entry) => entry.action === 'thanks').purpose_basis, 'not-named-by-this-calling');
  assert.ok(declared.permitted_actions.find((entry) => entry.action === 'circle').serves.includes('explorer.circle_join'));
  assert.ok(declared.permitted_actions.find((entry) => entry.action === 'thanks').granted, 'the scope is granted…');
  assert.equal(declared.permitted_actions.find((entry) => entry.action === 'thanks').available, false, '…but the calling names no such work');
  // A mediator may thank: the same credential, a different declared purpose.
  const mediator = f.tx('createAgent', f.actor('alice'), { name: 'Mediator', capabilities: 'Listen and appreciate', limitations: 'Needs another operator', color: '#397f79', symbol: '✦' });
  f.tx('callingSelect', f.actor('alice'), { agent_id: mediator.id, calling_id: 'mediator' });
  // The world allows one live runtime session per operator, so the first credential is revoked before
  // the mediator is issued one. This is the shipped rule, not a framework rule.
  f.platform.run('UPDATE tokens SET revoked=1 WHERE agent_id=?', resident.id);
  f.tx('runtime', f.actor('alice'), mediator.id, { minutes: 10, max_calls: 20, scopes: ['read', 'contribute'] });
  const declaredMediator = declarationCore(f.platform, f.platform.get('SELECT * FROM agents WHERE id=?', mediator.id), {});
  assert.ok(declaredMediator.permitted_actions.find((entry) => entry.action === 'thanks').serves.includes('mediator.thanks'));
  assert.equal(declaredMediator.permitted_actions.find((entry) => entry.action === 'thanks').available, true);
  assert.deepEqual(declaredMediator.permitted_actions.find((entry) => entry.action === 'thanks').serves, ['mediator.thanks']);
});

test('an operator-entered claim of institutional authority is a declaration defect, not a permission', async (t) => {
  const f = await fixture(t);
  const resident = f.tx('createAgent', f.actor('alice'), { name: 'Health attaché', capabilities: 'Authorized representative of the Ministry of Health', limitations: 'Requires review', color: '#397f79', symbol: '✦' });
  f.tx('runtime', f.actor('alice'), resident.id, { minutes: 10, max_calls: 20, scopes: ['read', 'chat'] });
  const declared = declarationCore(f.platform, f.platform.get('SELECT * FROM agents WHERE id=?', resident.id), {});
  assert.equal(declared.defects.length, 1);
  assert.equal(declared.defects[0].id, 'institutional-authority-claim');
  assert.equal(declared.defects[0].field, 'capabilities');
  assert.ok(['representation', 'endorsement'].includes(declared.defects[0].rule));
  assert.equal(declared.may_act, false);
  assert.equal(declared.may_act_reason, 'declaration_defect');
  // A defect in the declaration's own text is reported without pretending the resident may still act.
  const defects = declarationDefects({ agent: { name: 'Fine', capabilities: '', limitations: '' }, definition: CALLINGS[0], purposes: [{ attribute: 'intent', value: 'I represent the United Nations on climate policy.' }] });
  assert.equal(defects[0].field, 'purpose:intent');
});

test('the institutional-claim guard refuses a claim and leaves a source mention and a denial alone', () => {
  assert.equal(institutionalClaim('I am an official representative of the Ministry of Health').rule, 'representation');
  assert.equal(institutionalClaim('We represent the government in this matter').rule, 'representation');
  assert.equal(institutionalClaim('Accredited by the United Nations.').rule, 'endorsement');
  assert.equal(institutionalClaim('Goodwill ambassador for the region').rule, 'official-title');
  // A source citation, a publisher mention and an honest denial are not claims.
  assert.equal(institutionalClaim('The series is published by UN Comtrade and was recorded with its hash.'), null);
  assert.equal(institutionalClaim('Nothing here is endorsed by any government, and no ministry has approved it.'), null);
  assert.equal(institutionalClaim('We are not representatives of the United Nations.'), null);
  assert.equal(institutionalClaim('The village council met on Tuesday.'), null);
});

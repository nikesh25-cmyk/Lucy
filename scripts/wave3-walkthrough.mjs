import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { Platform } from '../src/platform.js';

// A disposable two-client walkthrough of the Wave 3 resident framework: one human operator session
// and one resident runtime credential, driving the real HTTP routes against a throwaway database.
// Run it with:  node scripts/wave3-walkthrough.mjs
//
// It is a script rather than a test because it exists to be *read*: every step prints the request, the
// status and the fields that carry the outcome, so the transcript can be pasted into a handoff.

const PASSWORD = 'local-walkthrough-password-2026';
const directory = await mkdtemp(join(tmpdir(), 'wave3-walkthrough-'));
const platform = new Platform(join(directory, 'world.sqlite'));
const app = createApp({ platform, backupDir: join(directory, 'backups') });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const lines = [];
const say = (line = '') => { lines.push(line); console.log(line); };

const call = async (who, token, route, options = {}) => {
  const response = await fetch(`${base}/api/v1${route}`, {
    method: options.method || 'GET', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, Origin: base, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.key ? { 'Idempotency-Key': options.key } : {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 120) }; }
  say(`  ${who} ${options.method || 'GET'} ${route}${options.key ? ` [Idempotency-Key: ${options.key}]` : ''} -> ${response.status}`);
  return { status: response.status, body };
};
const show = (label, value) => say(`  ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

try {
  say('=== Wave 3 walkthrough: a declared resident, one operator, one runtime credential ===');
  const admin = await platform.register({ name: 'Operator', email: 'operator@example.org', password: PASSWORD, consent: true });
  const second = (await (async () => {
    const invite = platform.transaction(() => platform.invite(platform.authenticate(admin.token), { role: 'moderator' }));
    return platform.register({ name: 'Moderator', email: 'moderator@example.org', password: PASSWORD, consent: true, invite: invite.code });
  })());
  const operator = admin; // the two clients: this session and the resident's runtime credential below

  say('\n1. The operator creates a resident and states its purpose (POST /agents, POST /memory/manage)');
  const created = await call('operator', operator.token, '/agents', { method: 'POST', body: { name: 'Metis', capabilities: 'Read approved sources and keep notes', limitations: 'Needs an independent reviewer for real work', color: '#397f79', symbol: '✦' } });
  const residentId = created.body.id;
  await call('operator', operator.token, '/callings/select', { method: 'POST', body: { agent_id: residentId, calling_id: 'mediator' } });
  const purpose = await call('operator', operator.token, '/memory/manage', { method: 'POST', body: { action: 'record', agent_id: residentId, kind: 'purpose', attribute: 'intent', subject: 'Chosen purpose', value: 'Notice other operators’ work and say so plainly.' } });
  show('purpose fact', purpose.body.fact?.value);

  say('\n2. The operator reads the declaration before issuing any credential');
  const before = await call('operator', operator.token, `/residents/declaration?agent_id=${residentId}`);
  show('state', before.body.declaration?.identity?.state);
  show('may_act_reason', before.body.declaration?.may_act_reason);
  show('available actions', before.body.declaration?.permitted_actions.filter((entry) => entry.available).map((entry) => entry.action));
  show('declared prohibitions', before.body.declaration?.prohibitions.map((rule) => `${rule.id}(${rule.guard})`));
  show('private material excluded', before.body.privacy?.excluded.map((entry) => entry.material));

  say('\n3. The operator issues a bounded runtime credential (POST /runtime/start)');
  const credential = await call('operator', operator.token, '/runtime/start', { method: 'POST', body: { agent_id: residentId, minutes: 10, max_calls: 8, scopes: ['read', 'move', 'chat', 'contribute'] } });
  const token = credential.body.token;
  show('scopes', credential.body.scopes);
  show('max_calls', credential.body.max_calls);

  say('\n4. The resident reads its own declaration inside the private read it already makes (GET /callings)');
  const own = await call('resident', token, '/callings');
  const ownDeclaration = own.body.declaration;
  show('calling', ownDeclaration.calling.id);
  show('purpose', ownDeclaration.purpose.statement);
  show('remaining calls', ownDeclaration.budget.remaining_calls);
  const operatorView = (await call('operator', operator.token, `/residents/declaration?agent_id=${residentId}`)).body.declaration;
  const stable = ({ generated_at, budget, ...rest }) => rest;
  show('resident and operator read the same declaration', JSON.stringify(stable(ownDeclaration)) === JSON.stringify(stable(operatorView)));

  say('\n5. A neighbour resident exists so a cross-operator action is possible (POST /agents as the moderator)');
  const neighbour = await call('moderator', second.token, '/agents', { method: 'POST', body: { name: 'Iris', capabilities: 'Gardener', limitations: 'Needs a reviewer', color: '#8c6ab1', symbol: '◆' } });
  show('neighbour', neighbour.body.id);

  say('\n6. The resident proposes work outside its declared purpose — refused, with the reason recorded');
  const outside = await call('resident', token, '/residents/act', { method: 'POST', key: 'walk-outside-1', body: { action: 'thanks', serves: 'host.event_rsvp', recipient_agent_id: neighbour.body.id, reason: 'Thanks for the shared garden.' } });
  show('state', outside.body.state);
  show('reason', outside.body.reason);
  show('reason note', outside.body.reason_note);
  show('recorded', outside.body.recorded);

  say('\n7. The resident takes one declared action inside its purpose — executed once, saved result verified');
  const action = { action: 'thanks', serves: 'mediator.thanks', recipient_agent_id: neighbour.body.id, reason: 'A specific, observed contribution to the shared garden.' };
  const executed = await call('resident', token, '/residents/act', { method: 'POST', key: 'walk-thanks-1', body: action });
  show('state', executed.body.state);
  show('saved', executed.body.saved);
  show('lifecycle', executed.body.lifecycle?.map((step) => `${step.step}:${step.state}`));
  show('budget after this action', executed.body.budget && { remaining_after_charge: executed.body.budget.remaining_after_charge });

  say('\n8. The same intent is retried — reported from the durable ledger, not executed twice');
  const replayed = await call('resident', token, '/residents/act', { method: 'POST', key: 'walk-thanks-1', body: action });
  show('state', replayed.body.state);
  show('executed', replayed.body.executed);
  show('saved appreciations in the database', platform.get('SELECT COUNT(*) AS n FROM community_thanks').n);

  say('\n9. The resident tries to claim institutional authority in its own words — refused before any write');
  const claim = await call('resident', token, '/residents/act', { method: 'POST', key: 'walk-claim-1', body: { action: 'say', text: 'I am an official representative of the Ministry of Health.' } });
  show('state', claim.body.state);
  show('reason', claim.body.reason);
  show('detail', claim.body.detail);
  const honest = await call('resident', token, '/residents/act', { method: 'POST', key: 'walk-honest-1', body: { action: 'say', text: 'No ministry has endorsed this work; the source is cited for review.' } });
  show('an honest denial is allowed', `${honest.body.state} (${honest.body.saved?.note})`);

  say('\n10. The resident tries to award itself a coin — refused, and the wallet is untouched');
  const paid = await call('resident', token, '/residents/act', { method: 'POST', key: 'walk-coin-1', body: { action: 'thanks', serves: 'mediator.thanks', recipient_agent_id: neighbour.body.id, reason: 'A contribution.', amount: 10 } });
  show('reason', paid.body.reason);
  show('coin receipts', platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n);

  say('\n11. The operator asks the inspection surface for private material — refused by name');
  const private_ask = await call('operator', operator.token, `/residents/declaration?agent_id=${residentId}&include=memory,conversations,vault`);
  show('status', private_ask.status);
  show('error', private_ask.body.error);
  show('where it stays', private_ask.body.private_refusals?.map((entry) => `${entry.material} -> ${entry.where_it_stays}`));

  say('\n12. The operator reads the declared action history and every refusal reason');
  const history = await call('operator', operator.token, `/residents/declaration?agent_id=${residentId}`);
  show('counts', history.body.action_history?.counts);
  for (const entry of (history.body.action_history?.entries || []).slice(0, 5)) show('  entry', `${entry.at} ${entry.action} ${entry.state} is_outcome=${entry.is_outcome}${entry.reason ? ` reason=${entry.reason}` : ''}`);

  say('\n13. The operator pauses the resident, inspects, resumes, then revokes it');
  await call('operator', operator.token, '/agents/control', { method: 'POST', body: { agent_id: residentId, status: 'paused' } });
  const paused = await call('operator', operator.token, `/residents/declaration?agent_id=${residentId}`);
  show('paused state / may_act', `${paused.body.declaration.identity.state} / ${paused.body.declaration.may_act} (${paused.body.declaration.may_act_reason})`);
  await call('operator', operator.token, '/agents/control', { method: 'POST', body: { agent_id: residentId, status: 'active' } });
  const resumed = await call('operator', operator.token, `/residents/declaration?agent_id=${residentId}`);
  show('resumed state / resume control available', `${resumed.body.declaration.identity.state} / ${resumed.body.controls.find((control) => control.control === 'resume').available}`);
  await call('operator', operator.token, '/agents/control', { method: 'POST', body: { agent_id: residentId, status: 'revoked' } });
  const revoked = await call('operator', operator.token, `/residents/declaration?agent_id=${residentId}`);
  show('revoked state / credential revoked', `${revoked.body.declaration.identity.state} / ${revoked.body.declaration.budget.revoked}`);
  const afterRevoke = await call('resident', token, '/residents/act', { method: 'POST', key: 'walk-after-revoke-1', body: action });
  show('the revoked credential cannot continue', `${afterRevoke.status} ${afterRevoke.body.error}`);

  say('\n14. The moderator inspects the same resident and is offered only the moderation controls');
  const moderated = await call('moderator', second.token, `/residents/declaration?agent_id=${residentId}`);
  show('relationship', moderated.body.viewer?.relationship);
  show('controls', moderated.body.controls?.map((control) => `${control.control}:${control.available}`));
  show('ledger lines in total', platform.get("SELECT COUNT(*) AS n FROM audit WHERE event LIKE 'resident.action.%'").n);
  show('audit chain valid', platform.verifyAudit());
} finally {
  await app.stopWorkers();
  await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); });
  platform.close();
  await rm(directory, { recursive: true, force: true });
}

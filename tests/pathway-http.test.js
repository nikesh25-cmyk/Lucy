import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fixture, realMission, evidence } from './helpers.js';

const source = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

test('the calling pathway is private, names its next saved fact, and keeps the three states apart', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, { token, input, method = input ? 'POST' : 'GET' } = {}) => {
    const response = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };

  // Private: only the owning operator's session or that exact runtime may read a resident's pathway.
  assert.equal((await req(`/callings?agent_id=${alice.id}`)).status, 401);
  assert.equal((await req(`/callings?agent_id=${alice.id}`, { token: f.credentials.bob.token })).status, 404);
  const { task } = realMission(f);
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: alice.id }, 'pathway-http-claim');
  const submission = f.tx('submit', f.actor('alice'), evidence(claim, { artifact: 'An attributed register entry for the pathway route.' }), 'pathway-http-submit');
  f.tx('review', f.actor('reviewer'), { submission_id: submission.id, decision: 'accepted', reason: 'Independent source review' });
  // One saved discovery: the resident walks into the library, which the server records as its own visit.
  f.platform.run('UPDATE agents SET world_id=?,x=?,y=? WHERE id=?', 'library', 6, 6, alice.id);
  f.tx('recordVisit', f.actor('alice'), alice.id, 'library');

  const read = await req(`/callings?agent_id=${alice.id}`, { token: f.credentials.alice.token });
  assert.equal(read.status, 200);
  const pathway = read.data.pathway;
  assert.ok(pathway, 'GET /callings carries the resident’s pathway');
  assert.equal(pathway.calling_id, 'explorer');
  assert.equal(pathway.complete, false);
  assert.ok(pathway.tiers.length >= 3);
  assert.equal(pathway.tiers[0].state, 'complete');
  // The three published states are three different things, not three degrees of one thing.
  assert.deepEqual(pathway.states.map((state) => state.id), ['practice', 'verified-contribution', 'external-adoption']);
  assert.equal(new Set(pathway.states.map((state) => state.label)).size, 3);
  assert.equal(new Set(pathway.states.map((state) => state.badge)).size, 3);
  assert.equal(new Set(pathway.states.map((state) => state.detail)).size, 3);
  assert.deepEqual(Object.keys(pathway.contribution), ['practice', 'verified', 'adopted']);
  assert.equal(pathway.contribution.practice.state, 'practice');
  assert.equal(pathway.contribution.verified.state, 'verified-contribution');
  assert.equal(pathway.contribution.adopted.state, 'external-adoption');
  assert.equal(pathway.contribution.practice.count >= 0 && pathway.contribution.verified.count >= 0 && pathway.contribution.adopted.count >= 0, true);
  // The next challenge is a concrete saved fact, with the action the interface can open.
  assert.ok(pathway.next);
  assert.equal(pathway.next.tier_slug, 'kept-company');
  assert.equal(pathway.next.requires_human_review, false);
  assert.ok(pathway.next.missing.every((item) => item.action && typeof item.action.kind === 'string' && item.action.label));
  assert.ok(pathway.next.missing.some((item) => item.kind === 'shared_visit' && item.have === 0 && item.min === 1));
  assert.equal(pathway.tiers[0].evidence[0].available, true);
  assert.equal(pathway.policy.grants.coins, 0);
  assert.deepEqual(pathway.policy.grants, { account_role: false, land_permission: false, review_authority: false, action_scope: false, coins: 0 });
  assert.match(pathway.disclosure, /not a qualification/);
  assert.match(pathway.disclosure, /mints no NemoCoin/);
  // A runtime credential reads its own pathway and nobody else's.
  const runtime = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read', 'contribute'] });
  assert.equal((await req('/callings', { token: runtime.token })).data.pathway.calling_id, 'explorer');
  assert.equal((await req(`/callings?agent_id=${bob.id}`, { token: runtime.token })).status, 404);
  // The public guild directory stays free of private pathway progress.
  const guilds = await req('/callings/guilds');
  assert.equal(guilds.status, 200);
  assert.equal(JSON.stringify(guilds.data).includes('pathway'), false);
  assert.equal(JSON.stringify(guilds.data).includes('tiers'), false);

  // The interface is wired to the three states and to the next challenge, and still builds nodes.
  const app = source('app.js');
  assert.ok(app.includes('function pathwayCard(') && app.includes('function pathwayTierCard('));
  assert.ok(app.includes("const PATHWAY_STATE_KEYS=Object.freeze({'practice':'practice','verified-contribution':'verified','external-adoption':'adopted'})"));
  assert.ok(app.includes('row.dataset.pathwayState=state.id'));
  assert.ok(app.includes("states.dataset.pathwayStates='three'"));
  assert.ok(app.includes('pathway.next.missing') && app.includes('pathway.next.requires_human_review'));
  assert.ok(app.includes('pathway.policy.diversity') && app.includes('pathway.disclosure'));
  assert.ok(app.includes('pathway.completed') && app.includes('pathway.unlocks'));
  assert.equal(app.includes('innerHTML'), false, 'the pathway reader must create elements, never markup');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const post = (base, token, path, body) => fetch(base + '/api/v1' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': globalThis.crypto.randomUUID(), ...auth(token) }, body: JSON.stringify(body) });

async function server(t, f) {
  const { server: http } = createApp({ platform: f.platform });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { http.close(resolve); http.closeAllConnections(); }));
  return `http://127.0.0.1:${http.address().port}`;
}

test('the evidence library is readable by a signed-in reviewer and refused to strangers', async (t) => {
  const f = await fixture(t);
  const base = await server(t, f);
  const anonymous = await fetch(base + '/api/v1/evidence');
  assert.equal(anonymous.status, 401);
  const member = await fetch(base + '/api/v1/evidence', { headers: auth(f.credentials.alice.token) });
  assert.equal(member.status, 403);
  const response = await fetch(base + '/api/v1/evidence?limit=2', { headers: auth(f.credentials.reviewer.token) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 222);
  assert.equal(body.limit, 2);
  assert.equal(body.has_more, true);
  assert.equal(body.limits.max_captures_per_source, 8);
  assert.equal(body.sources.length, 2);
  assert.ok(body.sources[0].versions[0].sha256);
  assert.ok(body.sources[0].versions[0].locator);
});

test('a reviewer can record a withdrawal while a member cannot, and a capture needs an admin on a known host', async (t) => {
  const f = await fixture(t);
  const base = await server(t, f);
  const url = 'https://api.worldbank.org/v2/country/AFG/indicator/NV.AGR.TOTL.ZS?format=json&date=2015:2026&per_page=12&source=2';
  // A member cannot withdraw.
  const refused = await post(base, f.credentials.alice.token, '/evidence/withdraw', { url, reason: 'Not a reviewer.' });
  assert.equal(refused.status, 403);
  // A reviewer can.
  const withdrawn = await post(base, f.credentials.reviewer.token, '/evidence/withdraw', { url, reason: 'Browser check: the source now refuses the request.' });
  assert.equal(withdrawn.status, 200);
  assert.equal((await withdrawn.json()).status, 'withdrawn');
  // A curator capture on an unknown host fails closed; on a registered host it is stored.
  const stranger = await post(base, f.credentials.admin.token, '/evidence/capture', { url: 'https://evil.example/x', sha256: 'a'.repeat(64), retrieved_at: '2026-10-12' });
  assert.equal(stranger.status, 403);
  const accepted = await post(base, f.credentials.admin.token, '/evidence/capture', { url: 'https://api.worldbank.org/v2/country/NPL/indicator/AG.LND.ARBL.ZS?format=json&date=2015:2026&per_page=12&source=2', sha256: 'b'.repeat(64), retrieved_at: '2026-10-12', evidence_kind: 'normalized-statistics', locator: 'Curator recapture' });
  assert.equal(accepted.status, 201);
  const capture = await accepted.json();
  assert.equal(capture.sha256, 'b'.repeat(64));
  assert.equal(capture.origin, 'curator');
  // A member cannot capture.
  const member = await post(base, f.credentials.alice.token, '/evidence/capture', { url: 'https://api.worldbank.org/v2/country/NPL/indicator/AG.LND.ARBL.ZS?format=json&date=2015:2026&per_page=12&source=2', sha256: 'c'.repeat(64), retrieved_at: '2026-10-12' });
  assert.equal(member.status, 403);
});

test('a contribution served over HTTP carries its exact evidence and its unverified links', async (t) => {
  const f = await fixture(t);
  const base = await server(t, f);
  const sha = f.platform.get('SELECT sha256 FROM evidence_captures WHERE evidence_kind=? LIMIT 1', 'normalized-statistics').sha256;
  const url = f.platform.get('SELECT url FROM evidence_captures WHERE sha256=?', sha).url;
  const agent = f.agent('alice');
  const claim = f.tx('claim', f.actor('alice'), { task_id: 'climate-practice', agent_id: agent.id }, 'http-claim');
  const submitted = await post(base, f.credentials.alice.token, '/submissions', {
    claim_id: claim.id, artifact: 'HTTP evidence register.',
    sources: [{ url, location: `Row; SHA256 ${sha}`, date: '2026-10-11' }, { url: 'https://example.org/link', location: 'Section 1', date: '2026-01-01' }],
    method: 'Read.', limitations: 'Context.', rights: 'Review terms.',
  });
  assert.equal(submitted.status, 201);
  const submission = await submitted.json();
  const history = await (await fetch(base + '/api/v1/history', { headers: auth(f.credentials.alice.token) })).json();
  const record = history.submissions.find((item) => item.id === submission.id);
  assert.ok(record, 'the submission is in the contributor history');
  assert.equal(record.evidence.length, 2);
  assert.equal(record.evidence[0].state, 'captured');
  assert.equal(record.evidence[0].capture.sha256, sha);
  assert.equal(record.evidence[0].capture.retained, true);
  assert.match(record.evidence[0].capture.license.name, /CC BY/);
  assert.equal(record.evidence[1].state, 'missing');
  assert.match(record.evidence[1].state_note, /not verified evidence/);
});

test('a saved draft exposes its resolved versions over HTTP to its owner only', async (t) => {
  const f = await fixture(t);
  const base = await server(t, f);
  const agent = f.agent('alice');
  const claim = f.tx('claim', f.actor('alice'), { task_id: 'climate-practice', agent_id: agent.id }, 'draft-claim');
  await post(base, f.credentials.alice.token, '/drafts', { claim_id: claim.id, expected_revision: 0, format: 'evidence-form-v1', values: { artifact: 'Private draft', method: 'Read.', limitations: 'Context.', rights: 'Review terms.', url_0: 'https://example.org/only-a-link', location_0: 'Section 2', date_0: '2026-01-01' } });
  const mine = await fetch(base + '/api/v1/evidence/draft?claim_id=' + claim.id, { headers: auth(f.credentials.alice.token) });
  assert.equal(mine.status, 200);
  const resolved = await mine.json();
  assert.equal(resolved.sources.length, 1);
  assert.equal(resolved.sources[0].state, 'missing');
  const other = await fetch(base + '/api/v1/evidence/draft?claim_id=' + claim.id, { headers: auth(f.credentials.bob.token) });
  assert.equal(other.status, 404);
});

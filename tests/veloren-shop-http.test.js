// The shop's HTTP surface: who may call which route, and the operator page.
//
// A shopkeeper's link credential may only ask and read notices; the signed-in human may only list,
// confirm, decline and retry their own requests; and the page is served without inline script, style
// or event handlers (the same CSP-clean shape the Veloren link page has).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { VelorenLink } from '../src/veloren-link.js';
import { setIdentityProvider } from '../src/veloren-ext/identity.js';
import { SHOPKEEPERS, VELOREN_SHOP_POLICY } from '../src/veloren-ext/shop.js';
import { fixture } from './helpers.js';

const KEY = Buffer.from('nemo-shop-http-key-nemo-shop-http-key-01');
const LANDMARKS = [{ id: 'lyra-post', name: "Harr's house", role: 'post' }, { id: 'lyra-survey', name: "Harr's farm field", role: 'survey' }];
const P1 = '11111111-1111-4111-8111-111111111111';

async function server(t) {
  const f = await fixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'shop-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const link = new VelorenLink({ dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: f.clock, commandsPath: join(directory, 'commands.jsonl') });
  link.platform = f.platform;
  t.after(() => { try { link.close(); } catch { /* closed */ } });
  const resident = f.agent('alice', 'Alice Walker');
  setIdentityProvider((link_, player_uuid) => (player_uuid === P1 ? { account_id: f.actor('alice').account.id, agent_id: resident.id, display_name: 'Alice Walker' } : null));
  t.after(() => setIdentityProvider(null));
  const app = createApp({ platform: f.platform, backupDir: join(directory, 'backups'), velorenLink: link, mayorModel: null });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { token, cookie, input, method = input === undefined ? 'GET' : 'POST', headers = {} } = {}) => {
    const response = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: `world_session=${cookie}` } : {}), ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    return { status: response.status, data: await response.json().catch(() => ({})), type: response.headers.get('content-type') || '' };
  };
  const keeper = link.issueCredential({ resident_id: SHOPKEEPERS[0], scopes: ['shop'], days: 1 });
  const relay = link.issueCredential({ resident_id: 'lw-lyra', scopes: ['events'], days: 1 });
  const lyra = link.issueCredential({ resident_id: 'lw-lyra', scopes: ['director'], days: 1 });
  return { f, link, origin, call, keeper, relay, lyra, session: f.credentials.alice.token, agent: resident };
}

test('only a shopkeeper credential can ask or read notices', async (t) => {
  const s = await server(t);
  const ask = (token, headers) => s.call('/veloren/shop/ask', { token, headers, input: { resident_id: SHOPKEEPERS[0], player_uuid: P1, player_alias: 'Tester', text: 'what is for sale' } });
  const answer = await ask(s.keeper.token);
  assert.equal(answer.status, 200);
  assert.match(answer.data.reply, /For sale/);
  assert.equal(answer.data.source, 'scripted', 'every line is labelled as scripted');
  assert.equal(answer.data.resident_id, SHOPKEEPERS[0]);
  // Another resident's credential, an events credential and a human session are all refused.
  const otherResident = s.link.issueCredential({ resident_id: 'lw-lyra', scopes: ['shop'], days: 1 });
  assert.equal((await ask(otherResident.token)).status, 403, 'a shop credential for a non-shopkeeper');
  assert.equal((await ask(s.relay.token)).status, 403, 'an events-only credential');
  assert.equal((await ask(s.session)).status, 401, 'a human session is not a link credential');
  assert.equal((await ask(s.lyra.token)).status, 403, 'the director credential is not a shop credential');
  assert.equal((await s.call('/veloren/shop/ask', { headers: { Origin: s.origin }, input: { resident_id: SHOPKEEPERS[0], player_uuid: P1, text: 'hi' } })).status, 401);
  assert.equal((await s.call('/veloren/shop/ask', { token: s.keeper.token, input: { resident_id: SHOPKEEPERS[0], player_uuid: P1, text: 'hi', extra: 1 } })).status, 400, 'unexpected fields are refused');
  assert.equal((await s.call('/veloren/shop/ask', { token: s.keeper.token, input: { resident_id: 'lw-lyra', player_uuid: P1, text: 'hi' } })).status, 403, 'the credential is scoped to its resident');
  // Notices go to a shopkeeper only.
  assert.equal((await s.call('/veloren/shop/notices', { token: s.keeper.token })).status, 200);
  assert.equal((await s.call('/veloren/shop/notices', { token: s.relay.token })).status, 403);
  assert.equal((await s.call('/veloren/shop/notices', { token: s.session })).status, 401);
  assert.equal((await s.call('/veloren/shop/notices/ack', { token: s.keeper.token, input: { ids: ['not-a-uuid'] } })).status, 400);
  assert.equal((await s.call('/veloren/shop/nothing-here', { token: s.keeper.token })).status, 404, 'an unknown shop route is not answered by the shop');
});

test('the human routes are for the signed-in operator alone', async (t) => {
  const s = await server(t);
  assert.equal((await s.call('/veloren/shop/requests', { cookie: s.session, headers: { Origin: s.origin } })).status, 200);
  assert.equal((await s.call('/veloren/shop/requests')).status, 401, 'no credential');
  assert.equal((await s.call('/veloren/shop/requests', { token: s.keeper.token })).status, 401, 'a link credential is not a session');
  const agent = s.f.agent('alice', 'Bob bot');
  const runtime = s.f.platform.runtime(s.f.actor('alice'), agent.id, { minutes: 5, max_calls: 20 });
  assert.equal((await s.call('/veloren/shop/requests', { token: runtime.token })).status, 403, 'an AI runtime cannot shop for a human');
  assert.equal((await s.call('/veloren/shop/requests/confirm', { cookie: s.session, headers: { Origin: s.origin }, input: { request_id: '11111111-1111-4111-8111-111111111111' } })).status, 400, 'a confirmation needs an Idempotency-Key');
  assert.equal((await s.call('/veloren/shop/requests/confirm', { token: runtime.token, input: { request_id: '11111111-1111-4111-8111-111111111111' }, headers: { 'Idempotency-Key': 'k' } })).status, 403);
  assert.equal((await s.call('/veloren/shop/orders/retry', { token: runtime.token, input: { request_id: '11111111-1111-4111-8111-111111111111' } })).status, 403);
  // A cookie write without this site's Origin is refused by the hosting layer.
  assert.equal((await s.call('/veloren/shop/requests/confirm', { cookie: s.session, input: { request_id: '11111111-1111-4111-8111-111111111111' } })).status, 403);
});

test('the operator page is served, needs no session to fetch, and inserts nothing as markup', async (t) => {
  const s = await server(t);
  const page = await fetch(`${s.origin}/api/v1/veloren/shop/panel`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /id="requests"/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, 'no inline script');
  assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=/i, 'no inline style or handler');
  for (const [path, type] of [['/veloren/shop/panel.js', /text\/javascript/], ['/veloren/shop/panel.css', /text\/css/]]) {
    const file = await fetch(`${s.origin}/api/v1${path}`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-type'), type);
  }
  const source = readFileSync(fileURLToPath(new URL('../src/veloren-ext/shop-panel.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/, 'text only');
  assert.match(source, /Idempotency-Key/, 'the panel sends an idempotency key with a confirmation');
  assert.ok(VELOREN_SHOP_POLICY.max_pending_per_player >= 1 && VELOREN_SHOP_POLICY.request_expiry_ms > 0);
});

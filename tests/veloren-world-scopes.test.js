// Credential scoping: what a link credential may do, proven against the real issuing path and the
// real link surface.
//
// The world stream runs eight residents, so it is the stream that has to answer "what may each
// credential carry?" for more than one resident. The rules it must not break are the product's own:
//   * scopes are minimal - a bridge credential gets `talk` and `director` and nothing else;
//   * a credential is bound to one resident, so it can never speak for another;
//   * no credential may mint Karma, confirm a purchase, change an account or a plot, or redeem a link
//     code: those are signed-in-human actions, and no link scope exists for them.
//
// The scope checks run against `VelorenLink.handle` - the same entry point `server.js` calls for every
// `/api/v1/veloren/...` request - and the credentials are issued by the real command a person uses
// (`scripts/veloren-link.mjs issue`), so a scope list this test accepts is one the product accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINK_SCOPES, signEvent, loadLandmarks } from '../src/veloren-link.js';
import { VelorenLink } from '../src/veloren-link.js';
import { LIVING_ROSTER } from '../src/living-world.js';
import { BRIDGE_SCOPES, FORBIDDEN_SCOPE_WORDS, RELAY_SCOPES, ROLES_PATH, credentialPlan, linkConfigResidents } from '../src/veloren-ext/world-residents.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(here, '..');
/** A test key and a test player; never the owner's, and never written anywhere. */
const KEY_TEXT = 'ab'.repeat(32);
const KEY = Buffer.from(KEY_TEXT, 'hex');
const T0 = 1_760_572_800_000;
const ARIA = '11111111-1111-4111-8111-111111111111';
const TALIA = '22222222-2222-4222-8222-222222222222';
const HUMAN_TOKEN = 'human-session-token';

/** NemoWorld's own world, accounts and economy as the link sees it: every read is recorded. */
function economy({ sessionToken } = {}) {
  const touched = [];
  const refuse = (what) => { touched.push(what); throw new Error(`A link credential reached ${what}`); };
  return {
    touched,
    authenticate(token) {
      touched.push('authenticate');
      if (sessionToken && token === sessionToken) return { kind: 'session', account: { id: 'acct-1' } };
      throw Object.assign(new Error('Sign in to NemoWorld first.'), { status: 401 });
    },
    shopPurchase() { return refuse('the shop'); },
    karmaSettle() { return refuse('Karma'); },
    landAssign() { return refuse('the land registry'); },
    vaultStatus() { return refuse('the vault'); },
  };
}

/**
 * One request through the link's own entry point, exactly as `server.js` calls it
 * (`velorenLink.handle({ request, response, route, url, body, json, tokenFrom, modelCall, platform, fail })`).
 * Returns the status the HTTP layer would write.
 */
function call(link, { method = 'POST', route, query = '', token, payload, platform }) {
  const captured = { status: 0, value: null };
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  return Promise.resolve(link.handle({
    request: { method, headers: {} },
    response: {},
    route,
    url: new URL(`http://127.0.0.1:3206/api/v1${route}${query}`),
    body: async () => payload,
    json: (_response, status, value) => { captured.status = status; captured.value = value; },
    tokenFrom: () => token,
    modelCall: null,
    platform: platform || economy(),
    fail,
  })).then(() => captured, (error) => ({ status: error.status || 500, value: { error: error.message } }));
}

function world(t, { extensions = [], clock = { now: T0 } } = {}) {
  const link = new VelorenLink({ dbPath: ':memory:', eventKey: KEY, landmarks: loadLandmarks(ROLES_PATH), clock: () => clock.now, extensions });
  t.after(() => { try { link.close(); } catch { /* already closed */ } });
  return { link, clock };
}

let seq = 5000;
function fact({ resident = 'lw-aria', player = ARIA, kind = 'resident.met', landmark_id = null, at = T0 } = {}) {
  seq += 1;
  const event = { v: 1, server_id: 'world-scopes', seq, kind, resident_id: resident, player_uuid: player, player_alias: 'Aria Tester', landmark_id, occurred_at: at };
  event.sig = signEvent(KEY, event);
  return event;
}

test('the plan is minimal: talk and director per resident, events per resident, nothing else', () => {
  const plan = credentialPlan();
  assert.deepEqual(plan.bridge.scopes, ['talk', 'director']);
  assert.deepEqual(plan.relay.scopes, ['events']);
  assert.equal(plan.residents.length, 8, 'the plan is for the living roster');
  for (const entry of plan.residents) {
    assert.deepEqual(entry.scopes, [...BRIDGE_SCOPES]);
    // Every scope in the plan is one the link really knows; a plan cannot invent one.
    for (const scope of [...entry.scopes, ...RELAY_SCOPES]) assert.ok(LINK_SCOPES.includes(scope), `${scope} is not a link scope`);
    assert.equal(entry.destinations.length, 4);
  }
  // Both credentials are per resident: events are stored against the credential's own resident, so one
  // relay credential cannot carry eight residents' facts (src/veloren-link.js, #validateEvent).
  assert.equal(plan.bridge.per, 'resident');
  assert.equal(plan.relay.per, 'resident');
  // The characters the server's `residents` map must list, one per resident.
  assert.equal(Object.keys(linkConfigResidents()).length, LIVING_ROSTER.length);
});

test('no link scope promises authority, now or by name', (t) => {
  for (const scope of LINK_SCOPES) {
    for (const word of FORBIDDEN_SCOPE_WORDS) {
      assert.ok(!scope.toLowerCase().includes(word), `the link scope ${scope} promises ${word}`);
    }
  }
  // Nothing the link can issue may carry a scope it does not know: the product's own rule.
  const { link } = world(t);
  assert.throws(() => link.issueCredential({ resident_id: 'lw-aria', scopes: ['karma'], days: 1 }), /Scopes must be from/);
  assert.throws(() => link.issueCredential({ resident_id: 'lw-aria', scopes: ['talk', 'purchase'], days: 1 }), /Scopes must be from/);
  assert.throws(() => link.issueCredential({ resident_id: 'lw-nobody', scopes: ['talk'], days: 1 }), /Unknown resident/);
});

test('a talk-only credential may speak, and nothing else', async (t) => {
  const { link } = world(t);
  const credential = link.issueCredential({ resident_id: 'lw-aria', scopes: ['talk'], days: 1 });
  const spoken = await call(link, { route: '/veloren/talk', token: credential.token, payload: { resident_id: 'lw-aria', player_uuid: ARIA, text: 'Aria, who are you?' } });
  assert.equal(spoken.status, 200);
  assert.equal(spoken.value.source, 'scripted');
  assert.match(spoken.value.reply, /Aria Greenfield, cultivator/);
  // The same credential cannot sign a fact, be directed, or read anything else on the link.
  const platform = economy();
  for (const [route, method] of [['/veloren/events', 'POST'], ['/veloren/director', 'GET'], ['/veloren/progress', 'GET'], ['/veloren/status', 'GET']]) {
    const answer = await call(link, { method, route, token: credential.token, payload: { events: [fact()] }, platform });
    assert.equal(answer.status, 403, `${route} accepted a talk-only credential`);
    assert.match(answer.value.error, /does not carry the (events|director) scope/);
  }
  assert.deepEqual(platform.touched, [], 'a credential-driven read reached NemoWorld\'s own world');
});

test('a director-only credential may be told where to go, and nothing else', async (t) => {
  const { link } = world(t);
  const credential = link.issueCredential({ resident_id: 'lw-selene', scopes: ['director'], days: 1 });
  const plan = await call(link, { method: 'GET', route: '/veloren/director', token: credential.token });
  assert.equal(plan.status, 200);
  assert.equal(plan.value.resident_id, 'lw-selene');
  assert.equal(plan.value.mode, 'schedule');
  const spoken = await call(link, { route: '/veloren/talk', token: credential.token, payload: { resident_id: 'lw-selene', player_uuid: ARIA, text: 'hello' } });
  assert.equal(spoken.status, 403);
  const ingested = await call(link, { route: '/veloren/events', token: credential.token, payload: { events: [fact({ resident: 'lw-selene' })] } });
  assert.equal(ingested.status, 403);
});

test('an events-only credential may hand in signed facts about its own resident, and nothing else', async (t) => {
  const { link } = world(t);
  const credential = link.issueCredential({ resident_id: 'lw-aria', scopes: ['events'], days: 1 });
  const accepted = await call(link, { route: '/veloren/events', token: credential.token, payload: { events: [fact()] } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.value.results.map((result) => result.status), ['accepted']);
  const spoken = await call(link, { route: '/veloren/talk', token: credential.token, payload: { resident_id: 'lw-aria', player_uuid: ARIA, text: 'hello' } });
  assert.equal(spoken.status, 403);
  assert.match(spoken.value.error, /does not carry the talk scope/);
  const directed = await call(link, { method: 'GET', route: '/veloren/director', token: credential.token });
  assert.equal(directed.status, 403);
});

test('a credential is bound to one resident, not to the family of eight', async (t) => {
  const { link } = world(t);
  const aria = link.issueCredential({ resident_id: 'lw-aria', scopes: ['events', 'talk', 'director'], days: 1 });
  // A perfectly signed fact about another resident is refused as out of scope, not stored.
  const other = await call(link, { route: '/veloren/events', token: aria.token, payload: { events: [fact({ resident: 'lw-lyra', player: TALIA })] } });
  assert.equal(other.status, 200);
  assert.equal(other.value.results[0].status, 'rejected');
  assert.equal(other.value.results[0].reason, 'resident_out_of_scope');
  assert.equal(link.status().events, 0, 'an out-of-scope fact was stored anyway');
  // And the same credential cannot answer as another resident.
  const impersonation = await call(link, { route: '/veloren/talk', token: aria.token, payload: { resident_id: 'lw-lyra', player_uuid: ARIA, text: 'hello' } });
  assert.equal(impersonation.status, 403);
  assert.match(impersonation.value.error, /scoped to another resident/);
  // Its own fact is still accepted, so the refusal above is about the resident and not the key.
  const own = await call(link, { route: '/veloren/events', token: aria.token, payload: { events: [fact()] } });
  assert.equal(own.value.results[0].status, 'accepted');
  // The director answers about the credential's own resident only: there is no parameter to ask for
  // somebody else's schedule.
  const plan = await call(link, { method: 'GET', route: '/veloren/director', token: aria.token });
  assert.equal(plan.value.resident_id, 'lw-aria');
});

test('the eight residents\' credentials are independent: revoking or expiring one leaves the rest', async (t) => {
  const clock = { now: T0 };
  const { link } = world(t, { clock });
  const issued = new Map(LIVING_ROSTER.map((resident) => [resident.id, link.issueCredential({ resident_id: resident.id, scopes: [...BRIDGE_SCOPES], days: 1 })]));
  assert.equal(issued.size, 8);
  const speak = (credential, resident) => call(link, { route: '/veloren/talk', token: credential.token, payload: { resident_id: resident, player_uuid: ARIA, text: 'hello' } });
  // One player may not speak to the same resident more than once every few seconds, so each check
  // below happens a tick later than the one before it.
  const tick = () => { clock.now += 7_000; };
  assert.equal((await speak(issued.get('lw-aria'), 'lw-aria')).status, 200);
  tick();
  assert.equal((await speak(issued.get('lw-rowan'), 'lw-rowan')).status, 200);
  assert.ok(link.revokeCredential(issued.get('lw-aria').key_id));
  const revoked = await speak(issued.get('lw-aria'), 'lw-aria');
  assert.equal(revoked.status, 401);
  assert.match(revoked.value.error, /revoked/);
  tick();
  assert.equal((await speak(issued.get('lw-rowan'), 'lw-rowan')).status, 200, 'revoking one resident stopped another');
  tick();
  assert.equal((await speak(issued.get('lw-theron'), 'lw-theron')).status, 200);
  clock.now += 2 * 86_400_000;
  const expired = await speak(issued.get('lw-theron'), 'lw-theron');
  assert.equal(expired.status, 401);
  assert.match(expired.value.error, /expired/);
});

test('no link credential can mint Karma, confirm a purchase, redeem a link or change land', async (t) => {
  // Every route NemoWorld reserves for a signed-in human (the shop's and the link stream's own docs),
  // plus the ones a promise-breaking route would have to be called. All of them must stay out of reach
  // for every combination of link scopes. In this tree the other streams' extensions are not
  // registered, so the honest answer is 404; after the merge they answer 401/403 for a human-only
  // route - never 200, and never by consulting the passenger's own world.
  const reserved = [
    '/veloren/shop/requests/confirm',
    '/veloren/shop/requests/decline',
    '/veloren/shop/orders/retry',
    '/veloren/shop/requests',
    '/veloren/identity/redeem',
    '/veloren/identity/remove',
    '/veloren/karma/mint',
    '/veloren/accounts/grant',
    '/veloren/land/assign',
    '/veloren/vault/unlock',
  ];
  const subsets = [];
  for (let mask = 1; mask < (1 << LINK_SCOPES.length); mask += 1) subsets.push(LINK_SCOPES.filter((_, index) => mask & (1 << index)));
  const { link } = world(t);
  const platform = economy();
  for (const scopes of subsets) {
    const credential = link.issueCredential({ resident_id: 'lw-kael', scopes, days: 1 });
    for (const route of reserved) {
      for (const method of ['POST', 'GET']) {
        const answer = await call(link, { method, route, token: credential.token, payload: { request_id: '00000000-0000-4000-8000-000000000001' }, platform });
        assert.ok(answer.status >= 400, `${scopes.join('+')} reached ${method} ${route} with ${answer.status}`);
      }
    }
  }
  assert.deepEqual(platform.touched, [], 'a link credential made NemoWorld touch its own economy');
});

test('an extension that follows the documented human-session rule refuses every link credential', async (t) => {
  // The real shop/home/atlas/hud extensions are not in this tree; their own streams prove their gate.
  // This stand-in models the rule those streams documented (`platform.authenticate(token)` then
  // `actor.kind === 'session'`), so the check below cannot quietly rot before the merge.
  const seen = [];
  const standIn = {
    name: 'stand_in_purchase',
    handle: async (_link, ctx) => {
      if (ctx.route !== '/veloren/shop/requests/confirm') return false;
      const actor = ctx.platform.authenticate(ctx.tokenFrom(ctx.request));
      if (actor.kind !== 'session') ctx.fail(403, 'Only the signed-in human operator can confirm a purchase.');
      seen.push(`confirmed by ${actor.kind}`);
      ctx.json(ctx.response, 200, { confirmed: true });
      return true;
    },
  };
  const platform = economy({ sessionToken: HUMAN_TOKEN });
  const { link } = world(t, { extensions: [standIn] });
  for (const scopes of [['talk'], ['events'], ['director'], ['talk', 'director', 'events']]) {
    const credential = link.issueCredential({ resident_id: 'lw-kael', scopes, days: 1 });
    const answer = await call(link, { route: '/veloren/shop/requests/confirm', token: credential.token, payload: { request_id: ARIA }, platform });
    assert.equal(answer.status, 401, `a ${scopes.join('+')} credential was let through`);
    assert.deepEqual(seen, []);
  }
  // The same route with the human's own session does confirm, so the gate above is about the
  // credential and not about the route being broken.
  const human = await call(link, { route: '/veloren/shop/requests/confirm', token: HUMAN_TOKEN, payload: { request_id: ARIA }, platform });
  assert.equal(human.status, 200);
  assert.deepEqual(seen, ['confirmed by session']);
});

test('the real issuing command accepts the plan and refuses a scope that could mint', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'world-scopes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'veloren-link.sqlite');
  const run = (args) => execFileSync(process.execPath, [join('scripts', 'veloren-link.mjs'), ...args], {
    cwd: ROOT,
    env: { ...process.env, NEMO_LINK_EVENT_KEY: KEY_TEXT, NEMO_LINK_DB: dbPath },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The command a person runs to give one resident's bridge a credential.
  const issued = JSON.parse(run(['issue', '--resident', 'lw-aria', '--scopes', 'talk,director', '--days', '1', '--label', 'world-scopes-test']));
  assert.deepEqual(issued.scopes, ['talk', 'director']);
  assert.equal(issued.resident_id, 'lw-aria');
  // The token the command printed is a real credential of the database it wrote: it authenticates for
  // exactly its own scopes, and for nothing more. (It is used here and never printed or stored.)
  const link = new VelorenLink({ dbPath, eventKey: KEY, landmarks: loadLandmarks(ROLES_PATH) });
  t.after(() => { try { link.close(); } catch { /* already closed */ } });
  assert.deepEqual(link.authenticate(issued.token, 'talk'), { key_id: issued.key_id, resident_id: 'lw-aria', scopes: ['talk', 'director'] });
  assert.throws(() => link.authenticate(issued.token, 'events'), /does not carry the events scope/);
  assert.equal(link.listCredentials().length, 1);
  // And a scope that promises authority cannot be issued at all, so it can never be stored or used.
  assert.throws(
    () => run(['issue', '--resident', 'lw-aria', '--scopes', 'karma', '--days', '1']),
    (error) => error.status === 1 && /Scopes must be from/.test(String(error.stderr)),
  );
  assert.equal(link.listCredentials().length, 1, 'a refused credential was stored anyway');
});

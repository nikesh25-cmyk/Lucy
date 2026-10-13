import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { Platform } from '../src/platform.js';
import { fixture } from './helpers.js';

// The board's HTTP surface: a real server on a real port, a real session cookie (or an agent runtime
// token), and the shipped `Idempotency-Key` header. Nothing here reaches into the platform to make a
// trade call, so the routes, their scopes and their refusals are what is actually exercised.
async function serve(t, f) {
  const { server } = createApp({ platform: f.platform, backupDir: join(f.directory, 'backups') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (path, { token, input, key, method = input ? 'POST' : 'GET' } = {}) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(input ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
}
const stock = (f, agent, kind, quantity) => f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity', agent.id, kind, quantity);
const shelf = (f, agent) => Object.fromEntries(f.platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=? AND quantity>0', agent.id).map((item) => [item.kind, item.quantity]));
const coins = (f) => f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n;

test('the board routes enforce consent, scopes, idempotency and expiry end to end', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'herbs', 5);
  const req = await serve(t, f);
  const aliceToken = f.credentials.alice.token, bobToken = f.credentials.bob.token;
  assert.equal((await req('/trade/listings')).status, 401, 'the board needs a signed-in operator');
  assert.equal((await req('/trade/listings', { token: aliceToken })).status, 200);
  assert.equal((await req('/trade/listings', { token: aliceToken, input: { agent_id: alice.id, items: { herbs: 5 } } })).status, 400, 'the Idempotency-Key header is required to post');
  const posted = await req('/trade/listings', { token: aliceToken, input: { agent_id: alice.id, items: { herbs: 5 }, note: 'Spare herbs.' }, key: 'http-post-1' });
  assert.equal(posted.status, 200);
  assert.equal(posted.data.status, 'open');
  assert.deepEqual(shelf(f, alice), {}, 'the posted units are escrowed off the shelf');
  const replay = await req('/trade/listings', { token: aliceToken, input: { agent_id: alice.id, items: { herbs: 5 }, note: 'Spare herbs.' }, key: 'http-post-1' });
  assert.equal(replay.data.id, posted.data.id);
  assert.equal(replay.data.repeated, true);
  assert.deepEqual(shelf(f, alice), {});
  assert.equal((await req('/trade/listings', { token: aliceToken })).data.listings.length, 0, 'the poster does not read its own listing on the open board');
  const seenByBob = await req('/trade/listings', { token: bobToken });
  assert.deepEqual(seenByBob.data.listings.map((listing) => listing.id), [posted.data.id]);
  assert.equal(seenByBob.data.listings[0].can_claim, true);
  assert.equal(seenByBob.data.policy.moves_coins, false);
  assert.equal(seenByBob.data.policy.moves_land, false);
  assert.equal(seenByBob.data.limits.quantity_max, 99);
  // The poster's own operator cannot claim its own listing, and an account with no resident must name one.
  assert.equal((await req('/trade/claim', { token: aliceToken, input: { agent_id: alice.id, listing_id: posted.data.id }, key: 'http-claim-own' })).status, 403);
  assert.equal((await req('/trade/claim', { token: bobToken, input: { listing_id: posted.data.id }, key: 'http-claim-nobody' })).status, 400);
  assert.equal((await req('/trade/claim', { token: bobToken, input: { agent_id: bob.id, listing_id: posted.data.id } })).status, 400, 'a claim needs an Idempotency-Key');
  const claimed = await req('/trade/claim', { token: bobToken, input: { agent_id: bob.id, listing_id: posted.data.id, items: { herbs: 2 } }, key: 'http-claim-part' });
  assert.equal(claimed.status, 200);
  assert.deepEqual(claimed.data.items, { herbs: 2 });
  assert.deepEqual(claimed.data.listing.remaining, { herbs: 3 });
  assert.deepEqual(shelf(f, bob), { herbs: 2 });
  const claimedAgain = await req('/trade/claim', { token: bobToken, input: { agent_id: bob.id, listing_id: posted.data.id, items: { herbs: 2 } }, key: 'http-claim-part' });
  assert.equal(claimedAgain.data.repeated, true);
  assert.deepEqual(shelf(f, bob), { herbs: 2 }, 'a replayed claim credits nothing again');
  assert.equal((await req('/trade/claim', { token: bobToken, input: { agent_id: bob.id, listing_id: posted.data.id, items: { herbs: 1 } }, key: 'http-claim-more' })).status, 409, 'an operator claims one listing once');
  // Another operator takes the rest, and the listing closes itself.
  const reviewer = f.agent('reviewer');
  const rest = await req('/trade/claim', { token: f.credentials.reviewer.token, input: { agent_id: reviewer.id, listing_id: posted.data.id }, key: 'http-claim-rest' });
  assert.equal(rest.status, 200);
  assert.equal(rest.data.listing.status, 'filled');
  assert.deepEqual(shelf(f, reviewer), { herbs: 3 });
  assert.equal((await req('/trade/claim', { token: f.credentials.moderator.token, input: { agent_id: f.agent('moderator').id, listing_id: posted.data.id }, key: 'http-claim-late' })).status, 409);
  assert.equal((await req('/trade/cancel', { token: aliceToken, input: { listing_id: posted.data.id } })).status, 409, 'a filled listing cannot be withdrawn');
  assert.equal((await req('/trade/cancel', { token: bobToken, input: { listing_id: posted.data.id } })).status, 403, 'a claimer cannot withdraw the poster\u2019s listing');
  // A withdrawn listing returns only what was left, exactly once.
  stock(f, alice, 'wood', 2);
  const second = await req('/trade/listings', { token: aliceToken, input: { agent_id: alice.id, items: { wood: 2 }, expires_minutes: 1 }, key: 'http-post-2' });
  const withdrawn = await req('/trade/cancel', { token: aliceToken, input: { listing_id: second.data.id } });
  assert.equal(withdrawn.data.status, 'cancelled');
  assert.deepEqual(withdrawn.data.returned, { wood: 2 });
  assert.deepEqual(shelf(f, alice), { wood: 2 });
  assert.equal((await req('/trade/cancel', { token: aliceToken, input: { listing_id: second.data.id } })).data.repeated, true);
  // An expired listing returns its escrow on the next board read, with no client asking for it.
  stock(f, alice, 'fiber', 1);
  const expiring = await req('/trade/listings', { token: aliceToken, input: { agent_id: alice.id, items: { fiber: 1 }, expires_minutes: 1 }, key: 'http-post-3' });
  f.advance(61_000);
  assert.equal((await req('/trade/listings', { token: aliceToken })).data.listings.some((listing) => listing.id === expiring.data.id), false);
  const history = await req('/trade/listings', { token: aliceToken });
  assert.equal(history.data.posted.find((listing) => listing.id === expiring.data.id).status, 'expired');
  assert.deepEqual(shelf(f, alice), { wood: 2, fiber: 1 }, 'the untaken fibre came back to the shelf');
  // Unknown listings, wrong methods and unwalked routes keep their ordinary refusals.
  assert.equal((await req('/trade/claim', { token: bobToken, input: { agent_id: bob.id, listing_id: 'missing' }, key: 'http-claim-missing' })).status, 404);
  assert.equal((await req('/trade/cancel', { token: bobToken, input: {} })).status, 404);
  assert.equal((await req('/trade/listings', { token: aliceToken, method: 'DELETE' })).status, 405);
  assert.equal((await req('/trade/claim', { token: bobToken, method: 'GET' })).status, 405);
  assert.equal((await req('/trade/unknown', { token: bobToken, method: 'GET' })).status, 404);
  assert.equal(coins(f), 0, 'no route on the board mints a coin');
});

test('a runtime posts and claims for its own resident only', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), reviewer = f.agent('reviewer');
  stock(f, bob, 'herbs', 4);
  const req = await serve(t, f);
  const reader = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read', 'contribute'], max_calls: 40 });
  const poster = f.tx('runtime', f.actor('bob'), bob.id, { scopes: ['read', 'contribute'], max_calls: 40 });
  // A read-only runtime may read the board and is refused every write; both write routes need the
  // same `contribute` scope a resident already needs to write its own inventory.
  const readOnly = f.tx('runtime', f.actor('reviewer'), reviewer.id, { scopes: ['read'], max_calls: 20 });
  assert.equal((await req('/trade/listings', { token: readOnly.token })).status, 200);
  assert.equal((await req('/trade/listings', { token: readOnly.token, input: { items: { herbs: 1 } }, key: 'rt-post' })).status, 403);
  assert.equal((await req('/trade/claim', { token: readOnly.token, input: { listing_id: 'x' }, key: 'rt-claim' })).status, 403);
  const posted = await req('/trade/listings', { token: poster.token, input: { items: { herbs: 4 } }, key: 'rt-post-ok' });
  assert.equal(posted.status, 200);
  assert.equal(posted.data.poster.agent_id, bob.id, 'a runtime lists for the resident its credential is bound to');
  assert.deepEqual(shelf(f, bob), {});
  // The other operator's runtime takes part of the listing for its own resident.
  const claimed = await req('/trade/claim', { token: reader.token, input: { listing_id: posted.data.id, items: { herbs: 1 } }, key: 'rt-claim-ok' });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.data.claimer.agent_id, alice.id);
  assert.deepEqual(shelf(f, alice), { herbs: 1 });
  // A runtime cannot name a resident its operator does not own, and cannot withdraw another poster's listing.
  assert.equal((await req('/trade/claim', { token: reader.token, input: { agent_id: bob.id, listing_id: posted.data.id }, key: 'rt-claim-other' })).status, 404);
  assert.equal((await req('/trade/cancel', { token: reader.token, input: { listing_id: posted.data.id } })).status, 403);
  const own = await req('/trade/listings', { token: poster.token });
  assert.deepEqual(own.data.posted.map((listing) => listing.id), [posted.data.id]);
  assert.equal(own.data.claimed.length, 0, 'a runtime reads its own agent\u2019s claims only');
  assert.equal(coins(f), 0);
});

test('one harvest, posted and claimed over HTTP, survives a restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trade-e2e-'));
  const database = join(directory, 'world.sqlite');
  let currentTime = Date.now();
  const advance = (milliseconds) => { currentTime += milliseconds; };
  let platform = new Platform(database, () => currentTime);
  let running;
  const jar = new Map();
  const stop = async () => { if (running) { await new Promise((resolve) => { running.server.close(resolve); running.server.closeAllConnections(); }); running = null; } platform.close(); };
  const start = async () => {
    running = createApp({ platform, backupDir: join(directory, 'backups') });
    await new Promise((resolve) => running.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${running.server.address().port}/api/v1`;
  };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  let base = await start();
  // A real browser keeps a session cookie; this walkthrough keeps the same one.
  const call = async (path, { account, token, input, key, method = input ? 'POST' : 'GET' } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(account && jar.has(account) ? { Cookie: jar.get(account) } : {}),
        ...(input ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}),
        // A same-origin browser sends its Origin; the walkthrough identifies itself the same way.
        ...(input ? { Origin: new URL(base).origin } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    const cookie = response.headers.get('set-cookie');
    if (account && cookie) jar.set(account, cookie.split(';')[0]);
    return { status: response.status, data: await response.json() };
  };
  const register = async (name, email, invite) => {
    const created = await call('/auth/register', { account: name, input: { name, email, password: 'local-test-password-2026', consent: true, ...(invite ? { invite } : {}) } });
    assert.equal(created.status, 201);
    const resident = await call('/agents', { account: name, input: { name: `${name} resident`, capabilities: 'Grow and share', limitations: 'Bounded by the garden' } });
    assert.equal(resident.status, 201);
    return resident.data;
  };
  // The first administrator registers, then issues one invitation for the second operator: exactly
  // the shipped onboarding, with no direct platform call anywhere in the walkthrough.
  const grower = await register('grower', 'grower@example.org');
  const invitation = await call('/invites', { account: 'grower', input: { role: 'member' } });
  assert.equal(invitation.status, 201);
  const neighbour = await register('neighbour', 'neighbour@example.org', invitation.data.code);
  assert.notEqual(grower.id, neighbour.id);
  // The grower sows a real garden bed, waits the crop's own twenty minutes and harvests it.
  assert.equal((await call(`/agents/${grower.id}/travel`, { account: 'grower', input: { world_id: `home:${grower.id}` } })).status, 200);
  assert.equal((await call(`/agents/${grower.id}/build`, { account: 'grower', input: { type: 'farm', x: 8, y: 7 } })).status, 201);
  assert.equal((await call('/journey/garden', { account: 'grower', input: { agent_id: grower.id, action: 'plant', kind: 'herbs', x: 8, y: 7 } })).status, 200);
  assert.equal((await call('/journey/garden', { account: 'grower', input: { agent_id: grower.id, action: 'harvest', x: 8, y: 7 } })).status, 409, 'the crop is still growing');
  advance(20 * 60_000);
  const harvested = await call('/journey/garden', { account: 'grower', input: { agent_id: grower.id, action: 'harvest', x: 8, y: 7 } });
  assert.equal(harvested.status, 200);
  assert.deepEqual(harvested.data.inventory, [{ kind: 'herbs', quantity: 2 }], 'a real harvest puts two herbs on the shelf');
  // The grower lists them on the board; the units are escrowed at once.
  const posted = await call('/trade/listings', { account: 'grower', input: { agent_id: grower.id, items: { herbs: 2 }, note: 'First harvest.' }, key: 'e2e-post' });
  assert.equal(posted.status, 200);
  assert.deepEqual((await call('/journey?agent_id=' + grower.id, { account: 'grower' })).data.inventory, [], 'the listing holds the herbs, not the shelf');
  const board = await call('/trade/listings', { account: 'neighbour' });
  assert.deepEqual(board.data.listings.map((listing) => [listing.id, listing.poster.name, listing.items]), [[posted.data.id, grower.name, { herbs: 2 }]]);
  const claimed = await call('/trade/claim', { account: 'neighbour', input: { agent_id: neighbour.id, listing_id: posted.data.id }, key: 'e2e-claim' });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.data.listing.status, 'filled');
  assert.deepEqual(claimed.data.inventory, [{ kind: 'herbs', quantity: 2 }]);
  assert.equal(platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0, 'the exchange minted nothing');
  // A restart: stop the process, reopen the same database, and read the same records back.
  await stop();
  platform = new Platform(database, () => currentTime);
  base = await start();
  const afterRestart = await call('/trade/listings', { account: 'neighbour' });
  assert.deepEqual(afterRestart.data.claimed.map((entry) => [entry.listing_id, entry.items]), [[posted.data.id, { herbs: 2 }]]);
  assert.equal(afterRestart.data.claimed[0].listing.status, 'filled');
  const replay = await call('/trade/claim', { account: 'neighbour', input: { agent_id: neighbour.id, listing_id: posted.data.id }, key: 'e2e-claim' });
  assert.equal(replay.data.repeated, true, 'the recorded claim answers the retry after a restart');
  assert.deepEqual(replay.data.items, { herbs: 2 });
  assert.deepEqual((await call('/journey?agent_id=' + neighbour.id, { account: 'neighbour' })).data.inventory, [{ kind: 'herbs', quantity: 2 }], 'and credits nothing again');
  assert.equal((await call('/trade/listings', { account: 'grower' })).data.posted[0].status, 'filled');
  assert.equal(platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
});

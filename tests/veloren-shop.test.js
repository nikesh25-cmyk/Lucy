// The in-world shop: a linked player asks a shopkeeper resident; the signed-in human confirms; the
// good is handed over only when the Veloren server's signed acknowledgement says so.
//
// The Veloren server is not running here. Its half of the protocol is exactly two things, and both are
// reproduced below through the real code paths: a signed `command.applied` / `command.rejected` event
// (signed with the event key, ingested by `link.ingest`) and the allow-list in `logic.rs` (pinned by
// `tests/shop-manifest.test.js`). Nothing is faked in NemoWorld's own rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VelorenLink, signEvent } from '../src/veloren-link.js';
import { setIdentityProvider } from '../src/veloren-ext/identity.js';
import { ShopService, parseIntent, VELOREN_SHOP_POLICY, SHOPKEEPERS } from '../src/veloren-ext/shop.js';
import { SHOP_CATALOGUE } from '../src/shop.js';
import { getWorldDefinition, walkable } from '../world.js';
import { fixture } from './helpers.js';

const KEY = Buffer.from('nemo-shop-test-key-nemo-shop-test-key-0001');
const LANDMARKS = [{ id: 'lyra-post', name: "Harr's house", role: 'post' }, { id: 'lyra-survey', name: "Harr's farm field", role: 'survey' }];
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const refused = (status, reason) => (error) => error.status === status && (reason === undefined || error.reason === reason);

/** Free walkable garden tiles, clear of the arrival and its exits (as the shop's own HTTP test does). */
function freeTiles(worldId, taken = []) {
  const definition = getWorldDefinition(worldId);
  const tiles = [];
  for (let y = 2; y < definition.rows - 2; y += 1) for (let x = 2; x < definition.columns - 2; x += 1) {
    if (!walkable({ x, y }, definition)) continue;
    if (Math.abs(x - definition.start.x) + Math.abs(y - definition.start.y) <= 2) continue;
    if ((definition.portals || []).some((portal) => Math.abs(portal.x - x) + Math.abs(portal.y - y) <= 2)) continue;
    if (taken.some((tile) => tile.x === x && tile.y === y)) continue;
    tiles.push({ x, y });
  }
  return tiles;
}

/** The Veloren server's half of the command channel: signed acknowledgements, and nothing else. */
function makeServer(link, relayCredential) {
  let seq = 5000;
  // An order is answered for the player the command names. A signature-valid acknowledgement naming
  // somebody else is refused at ingestion and must never count as this order's.
  const answered = new Set();
  for (const row of link.sql.all("SELECT landmark_id, player_uuid FROM link_events WHERE kind IN ('command.applied','command.rejected')")) {
    answered.add(`${row.landmark_id}/${row.player_uuid}`);
  }
  const commands = () => link.sql.all("SELECT cmd_id, player_uuid, kind FROM link_commands WHERE kind='grant_item' ORDER BY issued_at");
  return {
    outstanding() {
      // Select a genuinely unanswered command for its actual owner before testing
      // a mismatched acknowledgement. Otherwise an old preflight is selected.
      return commands().filter((cmd) => !answered.has(`${cmd.cmd_id}/${cmd.player_uuid}`));
    },
    answered(cmd_id, player_uuid) { answered.add(`${cmd_id}/${player_uuid}`); },
    /** Answer at most `only` unanswered commands. `apply(cmd)` decides applied vs rejected. */
    answer({ apply = () => true, only = 1, player_uuid } = {}) {
      const taken = this.outstanding().slice(0, only);
      for (const cmd of taken) {
        const who = player_uuid || cmd.player_uuid;
        const event = {
          v: 1, server_id: 'local-dev', seq: (seq += 1), kind: apply(cmd) ? 'command.applied' : 'command.rejected',
          resident_id: 'lw-lyra', player_uuid: who, player_alias: 'Tester',
          landmark_id: cmd.cmd_id, occurred_at: link.clock(),
        };
        event.sig = signEvent(KEY, event);
        const [result] = link.ingest(relayCredential, [event]);
        if (who !== cmd.player_uuid) {
          assert.equal(result.status, 'rejected');
          assert.equal(result.reason, 'command_player_mismatch');
          assert.equal(link.commandStatus(cmd.cmd_id).status, 'pending');
        } else if (result.status !== 'accepted') throw new Error(`the simulated server could not report ${cmd.cmd_id}: ${result.reason}`);
        answered.add(`${cmd.cmd_id}/${who}`);
      }
      return taken.length;
    },
  };
}

// A world with: alice (and her resident) as the buyer, bob as another operator, a link that carries
// the shop extension, a shopkeeper credential and an event credential for the acknowledgements.
async function world(t, { funds = true } = {}) {
  const f = await fixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'shop-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const link = new VelorenLink({ dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: f.clock, commandsPath: join(directory, 'commands.jsonl') });
  link.platform = f.platform;
  t.after(() => { try { link.close(); } catch { /* already closed */ } });

  const resident = f.agent('alice', 'Alice Walker');
  const alice = f.actor('alice').account.id;
  const bob = f.actor('bob').account.id;
  let linkedPlayer = P1;
  setIdentityProvider((link_, player_uuid) => (player_uuid === linkedPlayer && player_uuid === P1
    ? { account_id: alice, agent_id: resident.id, display_name: 'Alice Walker' }
    : player_uuid === P2 ? { account_id: bob, agent_id: null, display_name: 'Bob' } : null));
  t.after(() => setIdentityProvider(null));

  if (funds) {
    // Real service in the resident's own garden, then the operator's one settle action: 8 Karma Coins,
    // the price of the cheapest good (the recipe the shop's own HTTP test uses).
    const garden = `home:${resident.id}`;
    f.tx('travel', f.actor('alice'), resident.id, { world_id: garden });
    const [farmOne, farmTwo, bench, lantern] = freeTiles(garden);
    f.tx('build', f.actor('alice'), resident.id, { x: farmOne.x, y: farmOne.y, type: 'farm' });
    f.tx('gardenAction', f.actor('alice'), { agent_id: resident.id, action: 'plant', kind: 'herbs', x: farmOne.x, y: farmOne.y });
    f.tx('build', f.actor('alice'), resident.id, { x: farmTwo.x, y: farmTwo.y, type: 'farm' });
    f.tx('gardenAction', f.actor('alice'), { agent_id: resident.id, action: 'plant', kind: 'fiber', x: farmTwo.x, y: farmTwo.y });
    f.tx('build', f.actor('alice'), resident.id, { x: bench.x, y: bench.y, type: 'bench' });
    f.tx('build', f.actor('alice'), resident.id, { x: lantern.x, y: lantern.y, type: 'lantern' });
    f.tx('karmaSettle', f.actor('alice'), { agent_id: resident.id });
  }

  const keeper = link.issueCredential({ resident_id: SHOPKEEPERS[0], scopes: ['shop'], days: 1 });
  const relay = link.issueCredential({ resident_id: 'lw-lyra', scopes: ['events'], days: 1 });
  const server = makeServer(link, link.authenticate(relay.token, 'events'));
  const shop = new ShopService(link, f.platform, { sleep: async (ms) => { f.advance(ms); server.answer(); } });
  const credential = link.authenticate(keeper.token, 'shop');
  const identity = { account_id: alice, agent_id: resident.id, display_name: 'Alice Walker' };
  const wallet = () => f.platform.karmaWallet(f.actor('alice'), { agent_id: resident.id }).balance;
  const ask = (text, uuid = P1, alias = 'Tester') => shop.ask(credential, { resident_id: SHOPKEEPERS[0], player_uuid: uuid, player_alias: alias, text });
  const requests = () => link.sql.all('SELECT * FROM shop_requests ORDER BY created_at');
  const notices = () => link.sql.all('SELECT text FROM shop_notices ORDER BY created_at');
  const row = (request_id) => link.sql.get('SELECT * FROM shop_requests WHERE request_id=?', request_id);
  const deliveryState = (request_id) => shop.deliveryState(row(request_id));
  return { f, link, shop, server, credential, keeper, relay, alice, bob, resident, identity, ask, requests, notices, row, deliveryState, wallet,
    setLinked: (uuid) => { linkedPlayer = uuid; } };
}

// ---- what a player's words can and cannot mean -----------------------------------------------------

test('a spoken line only ever chooses among the shop\'s own goods', () => {
  const goods = SHOP_CATALOGUE.filter((good) => ['herbs', 'flower_crown', 'fiber'].includes(good.id));
  const of = (text) => parseIntent(text, goods);
  assert.equal(of('what is for sale').intent, 'list');
  assert.equal(of('what do you have').intent, 'list');
  assert.equal(of('how much is a herb bundle').intent, 'price');
  assert.equal(of('how much is a herb bundle').good.id, 'herbs');
  assert.equal(of('what is my balance').intent, 'balance');
  assert.equal(of('my orders').intent, 'status');
  assert.equal(of('my purchases').intent, 'history');
  assert.equal(of('cancel it').intent, 'cancel');
  assert.equal(of('buy herb bundle').intent, 'buy');
  assert.equal(of('buy herb bundle').good.id, 'herbs');
  assert.equal(of('i would like the flower crown').intent, 'buy');
  assert.equal(of('i would like the flower crown').good.id, 'flower_crown');
  // The longest phrase wins; two phrases of the same length are ambiguous and the shop asks which.
  assert.equal(of('buy herb bundle and fiber bundle').good, null);
  assert.equal(of('buy herb bundle and fiber bundle').ambiguous.length, 2);
  assert.equal(of('buy herbs and the flower crown').good.id, 'flower_crown');
  // A good nobody sells is no good at all, and a quantity is noted rather than obeyed.
  assert.equal(of('buy a sword').good, null);
  assert.equal(of('buy a sword').intent, 'buy');
  assert.equal(of('buy 50 herbs').count, 50);
  assert.equal(of('buy everything').count, 2);
  // A yes in chat is never a purchase.
  assert.equal(of('yes').intent, 'confirm');
  assert.equal(of('confirm and pay').intent, 'confirm');
  // Nothing in the text can name an item definition: only a good id can, and an item path matches none.
  const attack = of('buy common.items.weapons.sword.starter');
  assert.equal(attack.intent, 'buy');
  assert.equal(attack.good, null);
  assert.equal(of('buy herbs; drop table shop_requests').good.id, 'herbs');
  assert.equal(of('').intent, 'help');
});

// ---- asking -----------------------------------------------------------------------------------------

test('an unlinked player can look, but nothing is requested or charged for them', async (t) => {
  const w = await world(t);
  w.setLinked(P2);
  const answer = w.ask('what is for sale', P2, 'Bob');
  assert.equal(answer.intent, 'list');
  assert.match(answer.reply, /For sale/);
  w.f.advance(VELOREN_SHOP_POLICY.ask_gap_ms + 1);
  const buy = w.ask('buy herb bundle', P2, 'Bob');
  assert.match(buy.reply, /not linked/);
  assert.equal(w.requests().length, 0, 'nothing was written for an unlinked player');
  assert.equal(w.wallet(), 8);
});

test('a linked player\'s ask only ever creates a bounded, expiring request', async (t) => {
  const w = await world(t);
  const first = w.ask('buy herb bundle');
  assert.equal(first.intent, 'buy');
  assert.match(first.reply, /Nothing is charged yet/);
  assert.ok(first.request_id, 'the answer names the request');
  const rows = w.requests();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'pending');
  assert.equal(rows[0].expires_at - rows[0].created_at, VELOREN_SHOP_POLICY.request_expiry_ms);
  assert.equal(rows[0].price, 8, 'the price comes from the shop, never from the player');
  assert.equal(w.wallet(), 8, 'asking costs nothing');

  // Asking again for the same good is the same request, not a second one.
  w.f.advance(VELOREN_SHOP_POLICY.ask_gap_ms + 1);
  const again = w.ask('buy herbs');
  assert.equal(again.request_id, first.request_id);
  assert.match(again.reply, /already have/);
  assert.equal(w.requests().length, 1);

  // A good the player cannot afford is refused politely and nothing is written.
  w.f.advance(VELOREN_SHOP_POLICY.ask_gap_ms + 1);
  const tooDear = w.ask('buy fiber bundle');
  assert.equal(tooDear.request_id, undefined);
  assert.match(tooDear.reply, /costs 9 Karma and you have 8/);
  assert.equal(w.requests().length, 1);

  // The request table itself is bounded: two open requests for one player, and a ceiling for the shop.
  const create = (good) => w.shop.createRequest(w.identity, P1, 'Tester', SHOPKEEPERS[0], good);
  create({ id: 'fiber', price: 9 });
  assert.equal(w.requests().length, 2);
  assert.throws(() => create({ id: 'wood', price: 10 }), refused(429), 'a third open request');
  assert.equal(w.requests().length, 2);
  assert.ok(VELOREN_SHOP_POLICY.max_pending_total > VELOREN_SHOP_POLICY.max_pending_per_player, 'the shop has its own ceiling');
});

test('asking too fast is refused, and a request expires with nothing charged', async (t) => {
  const w = await world(t);
  w.ask('buy herb bundle');
  assert.throws(() => w.ask('what is for sale'), refused(429), 'a second line within two seconds');
  w.f.advance(VELOREN_SHOP_POLICY.request_expiry_ms + 1);
  w.shop.notices();   // reading what the shopkeeper would say is also what retires a stale request
  assert.equal(w.row(w.requests()[0].request_id).state, 'expired');
  assert.equal(w.wallet(), 8, 'an expired request charged nothing');
  assert.ok(w.notices().some((notice) => /expired; nothing was charged/.test(notice.text)), 'the player is told once');
});

// ---- confirming: a human, once, with an idempotency key ---------------------------------------------

test('only the signed-in human who owns the request can confirm it', async (t) => {
  const w = await world(t);
  const request_id = w.ask('buy herb bundle').request_id;
  const agent = w.f.agent('bob', 'Bob bot');
  const runtime = w.f.platform.runtime(w.f.actor('bob'), agent.id, { minutes: 5, max_calls: 20 });
  // A runtime credential and a read-only stand-in are refused.
  await assert.rejects(() => w.shop.confirm(runtime, request_id, 'k1'), refused(403));
  await assert.rejects(() => w.shop.confirm({ kind: 'session', account: w.f.actor('alice').account, readOnly: true }, request_id, 'k1'), refused(403));
  // Another operator cannot even see it, let alone confirm it: it looks like a missing request.
  await assert.rejects(() => w.shop.confirm(w.f.actor('bob'), request_id, 'k1'), refused(404), 'another operator sees nothing');
  assert.equal(w.shop.list(w.f.actor('bob')).requests.length, 0, 'nobody else does');
  assert.throws(() => w.shop.list(runtime), refused(403));
  // A confirmation without an idempotency key is refused before anything else happens.
  await assert.rejects(() => w.shop.confirm(w.f.actor('alice'), request_id), refused(400));
  await assert.rejects(() => w.shop.confirm(w.f.actor('alice'), request_id, ''), refused(400));
  await assert.rejects(() => w.shop.confirm(w.f.actor('alice'), request_id, 'x'.repeat(101)), refused(400));
  assert.equal(w.wallet(), 8, 'none of the refusals charged anything');
  assert.equal(w.row(request_id).state, 'pending');
  assert.equal(w.shop.list(w.f.actor('alice')).requests.length, 1, 'the owner sees it');
});

test('confirming spends the Karma once, and only a signed acknowledgement marks it delivered', async (t) => {
  const w = await world(t);
  const request_id = w.ask('buy herb bundle').request_id;
  const receipts = () => w.f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts').n;
  const minted = receipts();
  const result = await w.shop.confirm(w.f.actor('alice'), request_id, 'key-1');
  assert.equal(result.repeated, false);
  assert.equal(result.purchase.repeated, false);
  assert.equal(result.request.state, 'paid');
  assert.equal(w.wallet(), 0, 'the price left the purse exactly once');
  assert.equal(result.purchase.balance_after, 0);
  assert.ok(result.delivery_command, 'a real grant_item command was issued to the game');
  assert.equal(receipts(), minted, 'the shop never mints a Karma receipt');
  const deliveries = w.link.sql.all('SELECT cmd_id, role FROM shop_deliveries WHERE request_id=?', request_id);
  assert.equal(deliveries.filter((row) => row.role === 'preflight').length, 1, 'the game was asked first, with a command that gives nothing');
  assert.equal(deliveries.filter((row) => row.role === 'delivery').length, 1);
  // The paid order is not delivered yet: the game has not answered.
  assert.equal(w.server.outstanding().length, 1, 'one command is waiting for the game');
  assert.equal(w.shop.view(w.row(request_id)).delivery, 'delivering');
  assert.equal(w.server.answer(), 1, 'the game reports the delivery applied');
  const view = w.shop.view(w.row(request_id));
  assert.equal(view.delivery, 'delivered');
  assert.equal(view.can_retry, false);
  assert.equal(w.deliveryState(request_id).attempts, 1, 'the delivery state counts the delivery commands, not the preflight');
  // The persisted marker and the player's own notice are written the next time the shop speaks to the
  // player (the shopkeeper's notices poll) or the operator opens the list.
  w.shop.notices();
  assert.ok(w.row(request_id).delivered_at > 0, 'the record knows when it was handed over');
  assert.ok(w.notices().some((notice) => /Delivered: Herb bundle is in your inventory/.test(notice.text)), 'the player is told once');

  // A second confirmation from another device charges nothing more.
  const again = await w.shop.confirm(w.f.actor('alice'), request_id, 'key-2');
  assert.equal(again.repeated, true);
  assert.equal(w.wallet(), 0);
  assert.equal(w.f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n, 1);
  assert.equal(w.link.sql.get("SELECT COUNT(*) AS n FROM shop_deliveries WHERE request_id=? AND role='delivery'", request_id).n, 1, 'no second delivery was issued');
});

test('the shop refuses to charge when the game cannot deliver, and no order is ever delivered twice', async (t) => {
  const w = await world(t);
  const request_id = w.ask('buy herb bundle').request_id;
  // The game does not answer: the preflight times out and NOTHING is charged.
  const slow = new ShopService(w.link, w.f.platform, { sleep: async (ms) => w.f.advance(ms) });
  await assert.rejects(() => slow.confirm(w.f.actor('alice'), request_id, 'key-a'), refused(409));
  assert.equal(w.wallet(), 8, 'no answer from the game: nothing was charged');
  assert.equal(w.row(request_id).state, 'pending', 'the request is still waiting');

  // The game refuses the delivery (the player is offline): still nothing charged.
  const refusing = new ShopService(w.link, w.f.platform, { sleep: async (ms) => { w.f.advance(ms); w.server.answer({ apply: () => false }); } });
  await assert.rejects(() => refusing.confirm(w.f.actor('alice'), request_id, 'key-b'), refused(409));
  assert.equal(w.wallet(), 8);
  assert.equal(w.row(request_id).state, 'pending');

  // Now the game answers: the charge happens once and the delivery is issued.
  const result = await w.shop.confirm(w.f.actor('alice'), request_id, 'key-c');
  assert.equal(result.request.state, 'paid');
  assert.equal(w.wallet(), 0);
  assert.ok(result.delivery_command);
  // An acknowledgement that names somebody else says nothing about this order.
  w.server.answer({ player_uuid: P2 });
  assert.equal(w.deliveryState(request_id).status, 'delivering', "an acknowledgement for another player is not this player's delivery");
  // The real answer arrives, and the order is complete.
  assert.equal(w.server.answer(), 1);
  assert.equal(w.deliveryState(request_id).status, 'delivered');
  // The game also acknowledges a second command for the same order (NemoWorld would never issue one,
  // but a stray, replayed or buggy command could), and the shop catches up only afterwards.
  const extra = w.link.issueCommand({ kind: 'grant_item', player_uuid: P1, args: { order: request_id, good: 'herbs', qty: 2 } });
  w.link.sql.run("INSERT INTO shop_deliveries(cmd_id,request_id,role,issued_at,expires_at) VALUES(?,?,'delivery',?,?)", extra.cmd_id, request_id, extra.issued_at, extra.expires_at);
  assert.equal(w.server.answer(), 1);
  assert.equal(w.deliveryState(request_id).duplicate, true, 'two applied acknowledgements for one order are visible on every read');
  // The delivery marker, the anomaly and the player's single notice are written the first time the shop
  // catches up (the shopkeeper's notices poll, or the operator opening the list).
  w.shop.notices();
  assert.equal(w.row(request_id).anomaly, 'more_than_one_delivery_acknowledged');
  assert.ok(w.row(request_id).delivered_at > 0);
  w.shop.notices();
  assert.equal(w.notices().filter((notice) => /Delivered:/.test(notice.text)).length, 1, 'the player is told once, however many acknowledgements arrived');
  assert.throws(() => w.shop.retry(w.f.actor('alice'), request_id), refused(409), 'a delivered order is never delivered again');
});

test('a paid order the game refused can be asked for again; the purse is never touched twice', async (t) => {
  const w = await world(t);
  const request_id = w.ask('buy herb bundle').request_id;
  // The game answers the preflight, then refuses the hand-over itself.
  const isPreflight = (cmd) => w.link.sql.get('SELECT role FROM shop_deliveries WHERE cmd_id=?', cmd.cmd_id).role === 'preflight';
  const shop = new ShopService(w.link, w.f.platform, { sleep: async (ms) => { w.f.advance(ms); w.server.answer({ apply: isPreflight }); } });
  const result = await shop.confirm(w.f.actor('alice'), request_id, 'key-1');
  assert.equal(result.request.state, 'paid');
  assert.equal(w.wallet(), 0, 'the Karma is spent: the good is on the buyer\'s NemoWorld shelf');
  assert.equal(result.request.delivery, 'delivering', 'the game has not answered the hand-over yet');
  // The game now refuses the hand-over, and the order is visibly paid-but-not-delivered.
  assert.equal(w.server.answer({ apply: isPreflight }), 1);
  const view = w.shop.view(w.row(request_id));
  assert.equal(view.delivery, 'failed', 'the game refused the hand-over');
  assert.match(view.text, /retry/);
  const purchases = () => w.f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n;
  assert.equal(purchases(), 1);
  // A retry asks the game again and does not charge again.
  const retried = w.shop.retry(w.f.actor('alice'), request_id);
  assert.ok(retried.delivery_command);
  assert.equal(purchases(), 1, 'retrying delivery never charges again');
  assert.equal(w.wallet(), 0);
  assert.equal(w.server.answer(), 1);
  assert.equal(w.deliveryState(request_id).status, 'delivered');
  assert.throws(() => w.shop.retry(w.f.actor('alice'), request_id), refused(409), 'and then there is nothing left to retry');
});

test('declined, expired or somebody else\'s requests can never be confirmed, and declining charges nothing', async (t) => {
  const w = await world(t);
  const request_id = w.ask('buy herb bundle').request_id;
  const declined = w.shop.decline(w.f.actor('alice'), request_id);
  assert.equal(declined.state, 'declined');
  assert.equal(w.wallet(), 8);
  await assert.rejects(() => w.shop.confirm(w.f.actor('alice'), request_id, 'key-1'), refused(409));
  assert.equal(w.wallet(), 8);
  w.f.advance(VELOREN_SHOP_POLICY.ask_gap_ms + 1);
  const second = w.ask('buy herb bundle').request_id;
  w.f.advance(VELOREN_SHOP_POLICY.request_expiry_ms + 1);
  await assert.rejects(() => w.shop.confirm(w.f.actor('alice'), second, 'key-2'), refused(410));
  assert.equal(w.wallet(), 8, 'an expired request charged nothing');
  await assert.rejects(() => w.shop.confirm(w.f.actor('alice'), 'not-a-uuid', 'key-3'), refused(400));
  assert.throws(() => w.shop.decline(w.f.actor('alice'), second), refused(409), 'an expired request cannot be declined either');
  assert.equal(w.link.sql.get('SELECT COUNT(*) AS n FROM shop_deliveries').n, 0, 'nothing was ever sent to the game');
});

test('a request stops being confirmable when the character is no longer linked to that account', async (t) => {
  const w = await world(t);
  const request_id = w.ask('buy herb bundle').request_id;
  w.setLinked(P2);   // the link moved to another account (or was removed)
  await assert.rejects(() => w.shop.confirm(w.f.actor('alice'), request_id, 'key-1'), refused(409));
  assert.equal(w.wallet(), 8, 'nothing was charged for a character that is no longer linked');
  assert.equal(w.link.sql.get('SELECT COUNT(*) AS n FROM shop_deliveries').n, 0, 'and nothing was sent to the game');
});

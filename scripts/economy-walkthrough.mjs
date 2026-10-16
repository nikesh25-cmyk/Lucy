#!/usr/bin/env node
// The Wave 5 economy walkthrough: one human operator and one AI resident, a permitted exchange, the
// named refusal of an account-bound good, and a real server restart over the same database.
//
// Everything below is a real call on the shipped code: the operator's session drives the garden, the
// shop, the trade board and the reads, and the AI resident acts through the runtime credential its
// operator minted for it, exactly as an external worker does. Nothing is mocked and no assertion is
// faked. Two time compressions are stated where they happen: the walkthrough moves the *stored*
// planting time of its own crop back by the crop's growth time, because a real herb takes twenty
// minutes of wall clock to ripen (the server still decides readiness from its own clock and its own
// stored row), and it moves its own clock across two UTC day boundaries because the ledger pays its
// allowance per UTC day. Both are the same compressions the acceptance harness uses.
//
// Run it with:  node scripts/economy-walkthrough.mjs
// It creates one temporary database under the system temporary directory and removes it afterwards.
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform } from '../src/platform.js';
import { ensureTradeMarket } from '../src/trade-market.js';
import { getWorldDefinition, walkable } from '../world.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'walkthrough-password-2026';
const SETUP_CODE = 'nemoworld-walkthrough-setup-2026';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const show = (value, maximum = 420) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
};
let step = 0;
const say = (line) => process.stdout.write(`${line}\n`);
const heading = (title) => { step += 1; say(`\n${'='.repeat(94)}\nSTEP ${step} · ${title}\n${'='.repeat(94)}`); };
const call = (label, value, maximum) => say(`  ${label}: ${show(value, maximum)}`);
const attempt = (label, action) => {
  try { return { ok: true, value: action() }; }
  catch (error) {
    say(`  ${label}: REFUSED (HTTP ${error.status}${error.reason_code ? `, reason ${error.reason_code}` : ''}) — ${show(error.message, 340)}`);
    return { ok: false, error };
  }
};

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), 'economy-walkthrough-'));
  const database = join(workspace, 'platform.sqlite');
  const lock = join(workspace, 'server.lock');
  let server = null, output = [];

  const stopServer = async () => {
    if (!server) return;
    const child = server;
    server = null;
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const graceful = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]);
      if (!graceful && child.exitCode === null) { child.kill('SIGKILL'); await sleep(1_000); }
    }
    const deadline = Date.now() + 10_000;
    while (existsSync(lock) && Date.now() < deadline) await sleep(100);
  };
  const freePort = () => new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  const api = (port, path, { method = 'GET', token, body } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(data.length); }
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = httpRequest({ host: '127.0.0.1', port, path: `/api/v1${path}`, method, headers, signal: AbortSignal.timeout(15_000) }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
  const startServer = async () => {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port), LUCY_DATABASE: database, LUCY_SETUP_CODE: SETUP_CODE, LUCY_BIND_HOST: '127.0.0.1' };
    for (const name of ['LUCY_PUBLIC_ORIGIN', 'LUCY_LOCAL_PORT_FALLBACK', 'RENDER_EXTERNAL_URL', 'LUCY_MODEL_NAME', 'LUCY_MODEL_URL']) delete env[name];
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    output = [];
    const collect = (chunk) => { output.push(chunk.toString('utf8').trimEnd()); if (output.length > 20) output = output.slice(-20); };
    server.stdout.on('data', collect);
    server.stderr.on('data', collect);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`the server exited early (code ${server.exitCode})\n${output.join('\n')}`);
      try { const health = await api(port, '/health'); if (health.status === 200) return port; } catch { /* not listening yet */ }
      await sleep(200);
    }
    throw new Error(`the server never became ready\n${output.join('\n')}`);
  };

  try {
    say('NemoWorld — Wave 5 economy walkthrough');
    say(`database: ${database}`);
    say('A human operator and an AI resident, a permitted exchange, one named refusal, one real restart.');

    // ---------------------------------------------------------------------------------------------
    // 1-2. Two operators, a human resident and an AI resident with its own runtime credential.
    // ---------------------------------------------------------------------------------------------
    let now = Date.parse('2026-10-15T09:00:00.000Z');
    const platform = new Platform(database, () => now);
    const advance = (milliseconds) => { now += milliseconds; };
    const at = () => new Date(now).toISOString();
    heading('Two operators sign up: a human, and the operator of a managed AI resident');
    await platform.register({ name: 'Walkthrough administrator', email: 'admin@walkthrough.test', password: PASSWORD, consent: true });
    const admin = platform.authenticate((await platform.login({ email: 'admin@walkthrough.test', password: PASSWORD })).token);
    const invite = (role) => platform.transaction(() => platform.invite(admin, { role })).code;
    const humanAccount = await platform.register({ name: 'Mira', email: 'mira@walkthrough.test', password: PASSWORD, consent: true, invite: invite('member') });
    const aiAccount = await platform.register({ name: 'Orchard keeper', email: 'keeper@walkthrough.test', password: PASSWORD, consent: true, invite: invite('member') });
    const human = platform.authenticate(humanAccount.token);
    const keeper = platform.authenticate(aiAccount.token);
    call('human operator', { account: human.account.name, email: humanAccount.account.email });
    call('second operator', { account: keeper.account.name, email: aiAccount.account.email });

    heading('Each operator creates its resident: a human avatar, and an AI character with a credential');
    const mira = platform.transaction(() => platform.createAgent(human, { kind: 'human', name: 'Mira', capabilities: '', limitations: '', color: '#397f79', symbol: '✦' }));
    const aide = platform.transaction(() => platform.createAgent(keeper, { name: 'Orchard aide', capabilities: 'Walks the garden and carries harvested crops', limitations: 'No external tools', color: '#3d5875', symbol: '◆' }));
    call('human resident', { id: mira.id, name: mira.name, kind: mira.kind, operator: human.account.name });
    call('AI resident', { id: aide.id, name: aide.name, kind: aide.kind, operator: keeper.account.name });
    ensureTradeMarket(platform);
    const shelf = (agentId) => Object.fromEntries(platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=? AND quantity>0 ORDER BY kind', agentId).map((row) => [row.kind, row.quantity]));
    const purse = () => platform.karmaWallet(human, { agent_id: mira.id }).balance;

    // ---------------------------------------------------------------------------------------------
    // 3. The human earns Karma through real saved service in its own garden.
    // ---------------------------------------------------------------------------------------------
    heading('The human performs saved service in its own garden and the server settles it into Karma');
    const world = `home:${mira.id}`;
    platform.transaction(() => platform.travel(human, mira.id, { world_id: world }));
    const definition = getWorldDefinition(world), tiles = [];
    for (let y = 3; y < definition.rows - 3 && tiles.length < 12; y += 1) for (let x = 4; x < definition.columns - 4 && tiles.length < 12; x += 1) {
      if (!walkable({ x, y }, definition)) continue;
      if (Math.abs(x - definition.start.x) + Math.abs(y - definition.start.y) <= 2) continue;
      if ((definition.portals || []).some((portal) => Math.abs(portal.x - x) + Math.abs(portal.y - y) <= 1)) continue;
      tiles.push({ x, y });
    }
    const sow = (tile, kind = 'herbs') => {
      platform.transaction(() => platform.build(human, mira.id, { type: 'farm', x: tile.x, y: tile.y }));
      platform.transaction(() => platform.gardenAction(human, { agent_id: mira.id, action: 'plant', kind, x: tile.x, y: tile.y }));
    };
    const harvest = (tile) => {
      // The stated compression: the stored planting time moves back an hour so the crop the server
      // itself grows is ripe; readiness is still decided by that row and the server's own clock.
      platform.run('UPDATE journey_crops SET planted_at=planted_at-3600000 WHERE agent_id=? AND x=? AND y=?', mira.id, tile.x, tile.y);
      return platform.transaction(() => platform.gardenAction(human, { agent_id: mira.id, action: 'harvest', x: tile.x, y: tile.y }));
    };
    const [first, second, third, fourth] = tiles;
    sow(first); sow(second);
    const gathered = [harvest(first), harvest(second)];
    call('harvests', gathered.map((row) => ({ kind: row.crop?.kind, yield: row.gathered ?? row.amount ?? null })), 240);
    for (const tile of [tiles[10], tiles[11]]) platform.transaction(() => platform.build(human, mira.id, { type: 'bench', x: tile.x, y: tile.y }));
    const dayOne = platform.transaction(() => platform.karmaSettle(human, { agent_id: mira.id }));
    call('day 1 settle', { minted: dayOne.minted, balance: dayOne.balance, day: dayOne.today.day, daily_limit: dayOne.today.limit });
    call('shelf', shelf(mira.id));
    // The allowance is per UTC day, so two day boundaries are crossed to reach the keepsake's price.
    for (const day of [2, 3]) {
      advance(25 * 3_600_000);
      sow(tiles[day * 2], day === 2 ? 'herbs' : 'fiber');
      sow(tiles[day * 2 + 1], day === 2 ? 'herbs' : 'fiber');
      const settled = platform.transaction(() => platform.karmaSettle(human, { agent_id: mira.id }));
      call(`day ${day} settle`, { day: settled.today.day, minted: settled.minted, balance: settled.balance, at: at() });
    }
    const wallet = platform.karmaWallet(human, { agent_id: mira.id });
    call('wallet', { currency: wallet.currency, balance: wallet.balance, earned: wallet.earned, spent: wallet.spent, receipts: wallet.counts.receipts, integrity_valid: wallet.integrity_valid });
    for (const entry of wallet.entries) call(`  ${entry.direction}`, { amount: entry.amount, label: entry.label, service: entry.service_id, source: `${entry.source_kind}:${entry.source_id}`, day: entry.day }, 200);

    // ---------------------------------------------------------------------------------------------
    // 4. The shop: what it sells and what the one classification table says about each good.
    // ---------------------------------------------------------------------------------------------
    heading('The shop states, from the world\u2019s one classification table, what may leave the account');
    const catalogue = platform.shopCatalogue(human, { agent_id: mira.id });
    call('purse', { currency: catalogue.currency, balance: catalogue.balance });
    for (const good of catalogue.goods) call(`  good ${good.id}`, { price: good.price, category: good.category, classification: good.classification, transferable: good.transferable, remaining_today: good.remaining_today }, 200);

    heading('The human buys the keepsake with a full day\u2019s Karma Coins');
    const bought = platform.transaction(() => platform.shopPurchase(human, { good_id: 'flower_crown', agent_id: mira.id }, 'walkthrough-buy-1'));
    call('purchase', { good_id: bought.good_id, price: bought.price, granted: bought.granted, balance_after: bought.balance_after, repeated: bought.repeated });
    call('shelf', shelf(mira.id));

    // ---------------------------------------------------------------------------------------------
    // 5. The refusal: an account-bound good cannot leave the account that bought it.
    // ---------------------------------------------------------------------------------------------
    heading('The human tries to give the keepsake to the AI resident: refused, with its named reason');
    attempt('tradePost flower_crown', () => platform.transaction(() => platform.tradePost(human, { agent_id: mira.id, items: { flower_crown: 1 }, note: 'For the aide.' }, 'walkthrough-post-crown')));
    attempt('offerCreate flower_crown', () => platform.transaction(() => platform.offerCreate(human, { agent_id: mira.id, recipient_agent_id: aide.id, items: { flower_crown: 1 } }, 'walkthrough-offer-crown')));
    call('listings after the refusals', platform.get('SELECT COUNT(*) AS n FROM trade_listings').n);
    call('offers after the refusals', platform.get('SELECT COUNT(*) AS n FROM resource_offers').n);
    call('shelf of the human', shelf(mira.id));
    call('shelf of the AI resident', shelf(aide.id));
    call('account-bound reservations', platform.goodsPolicy(human, {}).account_bound);
    // The keepsake is still the human resident's own to wear: the refusal is about moving it.
    platform.transaction(() => platform.updateProfile(human, { agent_id: mira.id, avatar: 'flower_crown' }));
    call('the resident wears it', platform.get('SELECT avatar FROM journey_profiles WHERE agent_id=?', mira.id).avatar);

    // ---------------------------------------------------------------------------------------------
    // 6. The permitted exchange: grown herbs leave the human and reach the AI resident.
    // ---------------------------------------------------------------------------------------------
    heading('The permitted exchange: the human lists grown herbs and the AI resident claims them');
    // The AI resident's own bounded credential, minted by its operator for this work and nothing else.
    const credential = platform.transaction(() => platform.runtime(keeper, aide.id, { minutes: 20, max_calls: 200, scopes: ['read', 'contribute'] }));
    const assistant = platform.authenticate(credential.token);
    call('AI credential minted for the exchange', { kind: assistant.kind, agent: assistant.agent.name, scopes: credential.scopes, max_calls: credential.max_calls });
    const grown = shelf(mira.id).herbs;
    say(`  the human holds ${grown} grown herbs (harvested from its own garden) and the AI resident holds ${Object.keys(shelf(aide.id)).length} kinds`);
    const listing = platform.transaction(() => platform.tradePost(human, { agent_id: mira.id, items: { herbs: grown }, note: 'A grown harvest for a neighbour.' }, 'walkthrough-post-1'));
    call('listing', { id: listing.id, status: listing.status, items: listing.items, remaining: listing.remaining, posted_by: listing.poster.name });
    call('shelf of the human (escrowed)', shelf(mira.id));
    const claim = platform.transaction(() => platform.tradeClaim(assistant, { agent_id: aide.id, listing_id: listing.id }, 'walkthrough-claim-1'));
    call('claim by the AI resident, on its runtime credential', { id: claim.id, items: claim.items, listing: claim.listing.status, remaining: claim.listing.remaining });
    call('shelf of the AI resident', shelf(aide.id));
    call('shelf of the human', shelf(mira.id));
    const replay = platform.transaction(() => platform.tradeClaim(assistant, { agent_id: aide.id, listing_id: listing.id }, 'walkthrough-claim-1'));
    call('the same claim replayed', { repeated: replay.repeated, same_row: replay.id === claim.id, shelf: shelf(aide.id) });

    // ---------------------------------------------------------------------------------------------
    // 7. Provenance: what each reward was recognised for, and who reviewed it where review is needed.
    // ---------------------------------------------------------------------------------------------
    heading('The human reads what its rewards were recognised for');
    const provenance = platform.economyProvenance(human, {});
    call('report', { status: provenance.status, rewards: provenance.reward_count, flagged: provenance.flagged_count, karma_balance: provenance.ledger.karma_balance, coin_balance: provenance.ledger.coin_balance });
    for (const reward of provenance.rewards) call(`  ${reward.ledger} reward`, { amount: reward.amount, service: reward.service.id, contribution: `${reward.contribution.table}#${reward.contribution.row_id}`, held: reward.contribution.held, traceable: reward.traceable, reviewer_required: reward.reviewer.required, reviewer: reward.reviewer.account_name }, 280);
    const goods = platform.goodsPolicy(human, {});
    call('classification read', { families: goods.families.length, item_kinds: goods.item_kinds.length, account_bound: goods.account_bound, separate_units: goods.units.separation.units });

    // ---------------------------------------------------------------------------------------------
    // 8. A real restart: the shipped server opens the same file, twice.
    // ---------------------------------------------------------------------------------------------
    heading('A real server restart over the same database');
    platform.close();
    // Only the persisted facts are compared: `server_time` and today's counters legitimately differ
    // between a process whose clock this walkthrough moved and one reading the wall clock.
    const read = async (port, token) => {
      const goods = (await api(port, '/economy/goods', { token })).body;
      const karma = (await api(port, `/karma?agent_id=${mira.id}`, { token })).body;
      const board = (await api(port, '/trade/listings', { token })).body;
      const provenance = (await api(port, '/economy/provenance', { token })).body;
      const shop = (await api(port, `/shop?agent_id=${mira.id}`, { token })).body;
      return {
        karma: { balance: karma.balance, earned: karma.earned, spent: karma.spent, receipts: karma.counts.receipts, entries: karma.entries.map((entry) => [entry.id, entry.direction, entry.amount, entry.service_id, entry.source_id]) },
        board: { posted: board.posted.map((card) => [card.id, card.status, card.items, card.remaining, card.taken]), claimed: board.claimed.map((claim) => [claim.id, claim.items]) },
        provenance: { status: provenance.status, rewards: provenance.rewards.map((reward) => [reward.reward_id, reward.ledger, reward.contribution.table, reward.contribution.row_id, reward.traceable]) },
        goods: { account_bound: goods.account_bound.map((entry) => [entry.kind, entry.reserved, entry.held, entry.transferable]), item_kinds: goods.item_kinds },
        shop: { balance: shop.balance, goods: shop.goods.map((good) => [good.id, good.classification, good.transferable, good.price]) },
      };
    };
    const firstPort = await startServer();
    const before = await read(firstPort, humanAccount.token);
    call('first process · GET /karma', { balance: before.karma.balance, receipts: before.karma.receipts, spent: before.karma.spent, entries: before.karma.entries.length });
    call('first process · GET /trade/listings', { posted: before.board.posted.length, claimed: before.board.claimed.length, status: before.board.posted[0]?.[1] });
    call('first process · GET /economy/provenance', { status: before.provenance.status, rewards: before.provenance.rewards.length });
    call('first process · GET /economy/goods', { account_bound: before.goods.account_bound.map((entry) => entry[0]), item_kinds: before.goods.item_kinds.length });
    // The AI credential's real HTTP boundaries: the wallet read is open to it, the shop is not.
    const runtimeKarma = await api(firstPort, `/karma?agent_id=${aide.id}`, { token: credential.token });
    const runtimeShop = await api(firstPort, `/shop?agent_id=${aide.id}`, { token: credential.token });
    call('the AI credential may read the wallet', { status: runtimeKarma.status, balance: runtimeKarma.body?.balance });
    call('the AI credential may not read the shop', { status: runtimeShop.status, error: runtimeShop.body?.error }, 200);
    await stopServer();
    const secondPort = await startServer();
    const after = await read(secondPort, humanAccount.token);
    const identical = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const compare = {
      karma_wallet: identical(before.karma, after.karma),
      trade_board: identical(before.board, after.board),
      provenance: identical(before.provenance, after.provenance),
      classification: identical(before.goods, after.goods),
      shop_catalogue: identical(before.shop, after.shop),
    };
    for (const [name, same] of Object.entries(compare)) call(`  identical after the restart · ${name}`, same);
    call('second process · GET /karma', { balance: after.karma.balance, spent: after.karma.spent, entries: after.karma.entries.length });
    call('second process · GET /shop', { balance: after.shop.balance, keepsake: after.shop.goods.find((good) => good[0] === 'flower_crown') });
    if (Object.values(compare).some((same) => !same)) throw new Error(`the restart changed the state: ${JSON.stringify(compare)}`);
    say(`\n${'-'.repeat(94)}`);
    say('The walkthrough completed: a human and an AI resident exchanged grown goods, the account-bound');
    say('keepsake was refused by name, and every read was identical across a real server restart.');
    say(`${'-'.repeat(94)}`);
  } finally {
    await stopServer().catch(() => {});
    if (existsSync(workspace)) await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`\nwalkthrough failed: ${error.stack || error.message}\n`);
  process.exit(1);
});

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOP_CATALOGUE } from '../shop.js';
import { identityFor } from './identity.js';
import { PANEL_HTML, PANEL_JS, PANEL_CSS } from './shop-panel.js';

// Karma Coins and the in-world shop, as a Veloren link extension.
//
// What this adds, and what it deliberately does not:
//
// * A shopkeeper resident (Kael Hearthforge, `lw-kael`) answers a linked player's /tell with the
//   shop NemoWorld already has: the goods and Karma prices come from the shop's own catalogue
//   (`src/shop.js`, read through `platform.shopCatalogue` for a linked player).
// * A player can ask to buy a good. That only ever writes a PENDING REQUEST (bounded, 10 minutes).
//   Nothing is debited and nothing is granted from chat. Karma is spent when the signed-in human
//   operator confirms the request in NemoWorld, and that confirmation calls the platform's own
//   `shopPurchase` (daily allowances, the append-only ledger chain, an Idempotency-Key). The shop
//   and the ledger are not reimplemented here and no rule is weakened.
// * After a confirmed purchase NemoWorld issues a signed `grant_item` command (`link.issueCommand`).
//   The Veloren server applies it to the online player and acknowledges; only that signed
//   acknowledgement ever marks an order delivered.
// * There is no way to earn or mint Karma from Veloren in this module. It never calls karmaSettle.
//
// Delivery design (the ledger is append-only, so a debit can never be taken back):
//   1. Before charging, a `dry_run` command asks the Veloren server whether the player is online
//      and the grant would fit. If it does not answer "yes" the request stays pending and NOTHING is
//      charged.
//   2. The charge goes through the platform once, with a key derived from the request id, so the
//      same request can never be charged twice, whatever a client does.
//   3. The real command is then issued. If it is rejected or never acknowledged, the order stays
//      visibly "paid, not delivered" and the human can retry; the Veloren server refuses to deliver
//      one order twice, so a retry can never double the goods. The good itself is also on the buyer's
//      NemoWorld shelf (the platform's own grant), so a failed in-game delivery never loses the
//      purchase.

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const SHOPKEEPERS = Object.freeze(['lw-kael']);
export const VELOREN_SHOP_POLICY = Object.freeze({
  request_expiry_ms: 10 * 60_000,
  max_pending_per_player: 2,
  max_pending_total: 40,
  ask_gap_ms: 2_000,
  ask_chars: 300,
  line_chars: 190,
  preflight_ttl_ms: 30_000,
  preflight_wait_ms: 8_000,
  preflight_poll_ms: 150,
  delivery_ttl_ms: 120_000,
  retry_grace_ms: 60_000,
  confirming_stale_ms: 60_000,
  notice_ttl_ms: 15 * 60_000,
  notices_per_poll: 10,
  history_lines: 5,
  recent_requests_for_account: 25,
});

// ---- the delivery manifest -----------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = join(here, '..', '..', 'content', 'veloren-shop-manifest.json');
const GOOD_ID = /^[a-z][a-z0-9_]{0,39}$/;

// NemoWorld good id -> { good, item, qty }. The item ids are Veloren's own item definitions; this
// file is byte-identical with the Veloren server's allow-list and both sides pin the same fingerprint.
export function loadManifest(path = MANIFEST_PATH) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.format !== 'nemo-shop-manifest-v1') throw new Error('Unsupported shop manifest format.');
  if (!Number.isInteger(data.max_qty) || data.max_qty < 1 || data.max_qty > 10) throw new Error('Shop manifest max_qty must be 1 to 10.');
  const goods = new Map();
  for (const entry of data.goods) {
    if (!GOOD_ID.test(entry.good)) throw new Error(`Bad good id in the shop manifest: ${entry.good}`);
    if (goods.has(entry.good)) throw new Error(`Good listed twice in the shop manifest: ${entry.good}`);
    if (!/^common\.items(?:\.[a-z0-9_]+)+$/.test(entry.item)) throw new Error(`Bad item id in the shop manifest: ${entry.item}`);
    if (!Number.isInteger(entry.qty) || entry.qty < 1 || entry.qty > data.max_qty) throw new Error(`Bad quantity for ${entry.good}`);
    const good = SHOP_CATALOGUE.find((item) => item.id === entry.good);
    if (!good) throw new Error(`The shop manifest names a good the shop does not sell: ${entry.good}`);
    // What is delivered must match what the shop's own purchase grants: same count of the same thing.
    const expected = good.category === 'resource' ? good.grant.quantity : 1;
    if (entry.qty !== expected) throw new Error(`Quantity for ${entry.good} differs from the shop grant (${expected}).`);
    goods.set(entry.good, Object.freeze({ good: entry.good, item: entry.item, qty: entry.qty }));
  }
  return Object.freeze({ max_qty: data.max_qty, goods });
}
export const manifestFingerprint = (manifest) => [...manifest.goods.values()].map((e) => `${e.good}=${e.item}*${e.qty}`).sort().join(';');

export const SHOP_MANIFEST = loadManifest();

// ---- text: what a player says is data, never a command ------------------------------------------

const cleanLine = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (value) => ` ${String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const has = (text, words) => words.some((word) => text.includes(` ${word} `));
const NUMBER_WORDS = new Map([['one', 1], ['a', 1], ['an', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['dozen', 12], ['twenty', 20], ['hundred', 100], ['thousand', 1000]]);
const GENERIC = new Set(['bundle', 'keepsake', 'the', 'a', 'an', 'of', 'some', 'my', 'please', 'to', 'buy', 'purchase', 'order', 'get', 'want', 'need', 'take', 'i', 'would', 'like', 'ill', 'have', 'can', 'kael', 'from', 'you', 'for', 'one']);

// The goods a player can ask for: what the shop sells AND the delivery manifest allows. A good id
// that is not in this list cannot be requested, however the player spells it.
export function sellableGoods(manifest = SHOP_MANIFEST) {
  return SHOP_CATALOGUE.filter((good) => manifest.goods.has(good.id));
}

function phrasesFor(good) {
  const label = String(good.label).toLowerCase().replace(/ keepsake$/, '');
  return [...new Set([good.id.replace(/_/g, ' '), label])];
}

// Read a spoken line into an intent. Pure and deterministic; the player's words only ever choose
// among fixed answers and fixed good ids.
export function parseIntent(raw, goods = sellableGoods()) {
  const text = norm(raw);
  const words = text.trim().split(' ').filter(Boolean);
  // A quantity the shop does not sell: any number above one, or a word for one.
  let count = null;
  for (const word of words) {
    if (/^\d{1,9}$/.test(word)) { count = Math.max(count ?? 0, Number(word)); }
    else if (NUMBER_WORDS.has(word) && !['a', 'an', 'one'].includes(word)) count = Math.max(count ?? 0, NUMBER_WORDS.get(word));
  }
  if (has(text, ['all', 'every', 'everything', 'lots', 'many', 'bulk', 'stack', 'stacks', 'loads', 'infinite', 'unlimited'])) count = Math.max(count ?? 0, 2);

  // Which good, if any? Longest phrase wins; otherwise a single distinctive word that names exactly one good.
  let matched = [];
  let best = 0;
  for (const good of goods) {
    for (const phrase of phrasesFor(good)) {
      if (text.includes(` ${phrase} `)) {
        const length = phrase.split(' ').length;
        if (length > best) { best = length; matched = [good]; }
        else if (length === best && !matched.includes(good)) matched.push(good);
      }
    }
  }
  if (!matched.length) {
    const distinctive = words.filter((word) => !GENERIC.has(word) && !/^\d+$/.test(word));
    for (const word of distinctive) {
      const candidates = goods.filter((good) => `${good.id.replace(/_/g, ' ')} ${String(good.label).toLowerCase()}`.split(' ').includes(word));
      if (candidates.length) { matched = candidates; break; }
    }
  }
  const good = matched.length === 1 ? matched[0] : null;
  const ambiguous = matched.length > 1 ? matched : null;

  const buy = has(text, ['buy', 'purchase', 'order', 'get', 'want', 'need', 'take']) || /(?:i ll have|i d like|id like|i would like|give me|sell me|can i have|may i have)/.test(text);
  const confirmWord = has(text, ['confirm', 'confirmed', 'approve', 'approved', 'accept', 'authorize', 'authorise', 'pay', 'yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'proceed', 'go ahead', 'do it', 'finalize', 'finalise', 'checkout']);
  if (buy && (good || ambiguous || count)) return { intent: 'buy', good, ambiguous, count };
  if (confirmWord && !has(text, ['sale', 'sell', 'balance', 'karma', 'history', 'status'])) return { intent: 'confirm', good, count };
  if (has(text, ['cancel', 'nevermind', 'never mind', 'forget it', 'withdraw', 'abort', 'stop'])) return { intent: 'cancel' };
  if (good && has(text, ['price', 'cost', 'costs', 'how much'])) return { intent: 'price', good };
  if (has(text, ['balance', 'karma', 'coins', 'coin', 'wallet', 'purse', 'afford', 'how much do i have', 'my points'])) return { intent: 'balance' };
  if (has(text, ['history', 'purchases', 'bought', 'receipts', 'receipt', 'past orders', 'spent'])) return { intent: 'history' };
  if (has(text, ['status', 'orders', 'order', 'delivery', 'delivered', 'arrive', 'pending', 'request', 'requests', 'where is my', 'did it'])) return { intent: 'status' };
  if (good) return { intent: 'price', good };
  if (buy) return { intent: 'buy', good: null, ambiguous: null, count };
  if (has(text, ['sale', 'sell', 'selling', 'wares', 'shop', 'stock', 'goods', 'menu', 'offer', 'offers', 'catalogue', 'catalog', 'items', 'list', 'what do you have', 'have you got', 'show'])) return { intent: 'list' };
  return { intent: 'help' };
}

// ---- views -----------------------------------------------------------------------------------------

const GOOD_LABEL = (id) => SHOP_CATALOGUE.find((good) => good.id === id)?.label || id;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));

function chunkLines(items, prefix, max) {
  const lines = [];
  let line = prefix;
  for (const item of items) {
    const next = line === prefix ? `${line} ${item}` : `${line} | ${item}`;
    if (next.length > max && line !== prefix) { lines.push(line); line = `${prefix} ${item}`; }
    else line = next;
  }
  if (line !== prefix) lines.push(line);
  return lines;
}

export class ShopService {
  constructor(link, platform, { manifest = SHOP_MANIFEST, policy = VELOREN_SHOP_POLICY, sleep, identity = identityFor } = {}) {
    this.link = link;
    this.platform = platform;
    this.manifest = manifest;
    this.policy = policy;
    this.identity = identity;
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.sql = link.sql;
  }

  get now() { return this.link.clock(); }

  // ---- identity and the read-only view of a linked account -------------------------------------

  linked(player_uuid) {
    const found = this.identity(this.link, player_uuid);
    if (!found || typeof found.account_id !== 'string' || typeof found.agent_id !== 'string') return null;
    return { account_id: found.account_id, agent_id: found.agent_id, display_name: String(found.display_name || '') };
  }

  // A READ-ONLY stand-in for the signed-in operator, used only for the platform's own read methods
  // (`shopCatalogue`, `karmaWallet`, `shopExport`) to show a linked player their own numbers in
  // game. It is never passed to a method that writes; purchases take the real authenticated session.
  #readActor(account_id) {
    const account = this.platform.get('SELECT * FROM accounts WHERE id=?', account_id);
    if (!account || account.status !== 'active') fail(403, 'That NemoWorld account is not active.');
    return Object.freeze({ account, agent: null, kind: 'session', credential: null, readOnly: true });
  }

  #shopView(identity) {
    if (identity) {
      try {
        const view = this.platform.shopCatalogue(this.#readActor(identity.account_id), { agent_id: identity.agent_id });
        return { goods: view.goods.filter((good) => this.manifest.goods.has(good.id)), balance: view.balance, linked: true };
      } catch { /* fall back to the public catalogue below */ }
    }
    return { goods: sellableGoods(this.manifest).map((good) => ({ id: good.id, label: good.label, price: good.price, remaining_today: null, available_today: true, can_afford: null })), balance: null, linked: false };
  }

  // ---- requests --------------------------------------------------------------------------------

  #expireStale() {
    const now = this.now;
    const stale = this.sql.all("SELECT request_id,player_uuid,good_id FROM shop_requests WHERE state='pending' AND expires_at<=?", now);
    for (const row of stale) {
      this.sql.run("UPDATE shop_requests SET state='expired', state_at=? WHERE request_id=? AND state='pending'", now, row.request_id);
      this.#notice(row.player_uuid, `Your request for ${GOOD_LABEL(row.good_id)} expired; nothing was charged.`, `expired:${row.request_id}`);
    }
    return stale.length;
  }

  #pendingFor(player_uuid) {
    return this.sql.all("SELECT * FROM shop_requests WHERE player_uuid=? AND state IN ('pending','confirming') AND expires_at>? ORDER BY created_at", player_uuid, this.now);
  }

  createRequest(identity, player_uuid, player_alias, resident_id, good) {
    const existing = this.#pendingFor(player_uuid);
    const same = existing.find((row) => row.good_id === good.id && row.state === 'pending');
    if (same) return { request: same, created: false };
    if (existing.length >= this.policy.max_pending_per_player) fail(429, `You already have ${plural(existing.length, 'open request')}; the operator must confirm or decline one first, or say cancel.`);
    const total = this.sql.get("SELECT COUNT(*) AS n FROM shop_requests WHERE state IN ('pending','confirming') AND expires_at>?", this.now).n;
    if (total >= this.policy.max_pending_total) fail(429, 'The shop has too many open requests right now. Please try again in a few minutes.');
    const request_id = randomUUID();
    this.sql.run(`INSERT INTO shop_requests(request_id,resident_id,player_uuid,player_alias,account_id,agent_id,good_id,price,created_at,expires_at,state,state_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?)`, request_id, resident_id, player_uuid, player_alias, identity.account_id, identity.agent_id, good.id, good.price,
      this.now, this.now + this.policy.request_expiry_ms, this.now);
    return { request: this.sql.get('SELECT * FROM shop_requests WHERE request_id=?', request_id), created: true };
  }

  // ---- in game: ask ----------------------------------------------------------------------------

  ask(credential, input) {
    if (!SHOPKEEPERS.includes(credential.resident_id)) fail(403, 'This credential does not belong to a shopkeeper.');
    const allowed = ['resident_id', 'player_uuid', 'player_alias', 'text'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) fail(400, 'Unexpected field in the request.');
    if (input.resident_id !== credential.resident_id) fail(403, 'This credential is scoped to another resident.');
    if (typeof input.player_uuid !== 'string' || !UUID.test(input.player_uuid)) fail(400, 'A Veloren player id is required.');
    const text = cleanLine(input.text, this.policy.ask_chars);
    if (!text) fail(400, 'Say something.');
    const alias = cleanLine(input.player_alias || 'traveller', 32) || 'traveller';
    const last = this.sql.get('SELECT last_at FROM shop_asks WHERE player_uuid=?', input.player_uuid);
    if (last && this.now - last.last_at < this.policy.ask_gap_ms) fail(429, 'Please wait a moment before asking again.');
    this.sql.run('INSERT INTO shop_asks(player_uuid,last_at) VALUES(?,?) ON CONFLICT(player_uuid) DO UPDATE SET last_at=excluded.last_at', input.player_uuid, this.now);
    this.#expireStale();
    const intent = parseIntent(text, sellableGoods(this.manifest));
    const answer = this.#answer(intent, input.player_uuid, alias, credential.resident_id);
    const lines = answer.lines.flatMap((line) => this.#wrap(line));
    return { resident_id: credential.resident_id, source: 'scripted', intent: intent.intent, lines, reply: lines.join(' '), ...(answer.request_id ? { request_id: answer.request_id } : {}) };
  }

  #wrap(line) {
    const max = this.policy.line_chars;
    if (line.length <= max) return [line];
    const out = [];
    let current = '';
    for (const word of line.split(' ')) {
      if (current && current.length + 1 + word.length > max) { out.push(current); current = word; }
      else current = current ? `${current} ${word}` : word;
    }
    if (current) out.push(current);
    return out;
  }

  #answer(intent, player_uuid, alias, resident_id) {
    const identity = this.linked(player_uuid);
    switch (intent.intent) {
      case 'list': return { lines: this.#listLines(identity) };
      case 'price': return { lines: this.#priceLines(intent.good, identity) };
      case 'balance': return { lines: this.#balanceLines(identity) };
      case 'history': return { lines: this.#historyLines(identity, player_uuid) };
      case 'status': return { lines: this.#statusLines(player_uuid) };
      case 'cancel': return { lines: this.#cancelLines(player_uuid) };
      case 'confirm':
        // A chat line can never confirm a purchase. This answer changes nothing.
        return { lines: ['I cannot take a yes in chat. Karma is spent only by you, signed in to NemoWorld, on the Veloren shop page. Nothing was charged.'] };
      case 'buy': return this.#buyLines(intent, identity, player_uuid, alias, resident_id);
      default:
        return { lines: [`I am Kael, the shopkeeper. My words are scripted; the prices are NemoWorld's. Try: what is for sale, my balance, buy <good>, my orders, cancel.`] };
    }
  }

  #listLines(identity) {
    const view = this.#shopView(identity);
    const entries = view.goods.map((good) => `${good.label.replace(/ keepsake$/, '')} ${good.price}`);
    const lines = ['For sale, in Karma Coins (one bundle per request):'];
    lines.push(...chunkLines(entries, '', this.policy.line_chars).map((line) => line.replace(/^ /, '')));
    if (view.linked && view.balance !== null) lines.push(`You have ${view.balance} Karma. To order, whisper: buy herb bundle. You then confirm it in NemoWorld.`);
    else lines.push('Link your Veloren character to a NemoWorld account to order. Karma is earned in NemoWorld, never in chat.');
    return lines;
  }

  #priceLines(good, identity) {
    const view = this.#shopView(identity);
    const row = view.goods.find((item) => item.id === good.id);
    if (!row) return [`I do not sell ${good.label} right now.`];
    const left = row.remaining_today === null ? '' : ` You may buy ${plural(row.remaining_today, 'more')} today.`;
    return [`${row.label} costs ${row.price} Karma.${left}`];
  }

  #balanceLines(identity) {
    if (!identity) return ['Your Veloren character is not linked to a NemoWorld account, so I cannot see a purse for you.'];
    try {
      const wallet = this.platform.karmaWallet(this.#readActor(identity.account_id), { agent_id: identity.agent_id });
      return [`You have ${wallet.balance} Karma Coins (earned ${wallet.earned}, spent ${wallet.spent}). Karma is earned in NemoWorld, not here.`];
    } catch { return ['I cannot read your purse right now.']; }
  }

  #historyLines(identity, player_uuid) {
    if (!identity) return ['Your Veloren character is not linked to a NemoWorld account, so there is no history to show.'];
    let purchases;
    try { purchases = this.platform.shopExport(this.#readActor(identity.account_id)).purchases; } catch { return ['I cannot read your purchase history right now.']; }
    if (!purchases.length) return ['You have not bought anything yet.'];
    const recent = purchases.slice(-this.policy.history_lines).reverse();
    const lines = [`Your last ${plural(recent.length, 'purchase')}:`];
    lines.push(...chunkLines(recent.map((row) => `${GOOD_LABEL(row.good_id)} ${row.price} Karma ${row.day}`), '', this.policy.line_chars).map((line) => line.replace(/^ /, '')));
    const open = this.#pendingFor(player_uuid).length;
    if (open) lines.push(`${plural(open, 'request')} still waiting for you to confirm in NemoWorld.`);
    return lines;
  }

  #statusLines(player_uuid) {
    this.#refreshAll();
    const rows = this.sql.all('SELECT * FROM shop_requests WHERE player_uuid=? ORDER BY created_at DESC LIMIT ?', player_uuid, this.policy.history_lines);
    if (!rows.length) return ['You have no orders. Whisper "buy herb bundle" to ask for one.'];
    return rows.map((row) => `${GOOD_LABEL(row.good_id)}: ${this.view(row).text}`);
  }

  #cancelLines(player_uuid) {
    const open = this.sql.all("SELECT request_id,good_id FROM shop_requests WHERE player_uuid=? AND state='pending'", player_uuid);
    for (const row of open) this.sql.run("UPDATE shop_requests SET state='cancelled', state_at=? WHERE request_id=? AND state='pending'", this.now, row.request_id);
    return [open.length ? `Cancelled ${plural(open.length, 'request')}. Nothing was charged.` : 'You have no request waiting. Nothing was charged.'];
  }

  #buyLines(intent, identity, player_uuid, alias, resident_id) {
    if (intent.count && intent.count > 1) return { lines: ['I sell one bundle per request. Ask for each good on its own; the amount is fixed by the shop.'] };
    if (intent.ambiguous) return { lines: [`Which one: ${intent.ambiguous.map((good) => good.label.replace(/ keepsake$/, '')).join(' or ')}?`] };
    if (!intent.good) return { lines: [...this.#listLines(identity).slice(0, 3), 'Whisper: buy <name of the good>.'] };
    if (!identity) return { lines: ['Your Veloren character is not linked to a NemoWorld account, so I cannot take a request. You can still ask what is for sale.'] };
    const view = this.#shopView(identity);
    const row = view.goods.find((good) => good.id === intent.good.id);
    if (!row) return { lines: [`I do not sell ${intent.good.label} right now.`] };
    if (row.available_today === false) return { lines: [`${row.label}: today's allowance for your account is used up. It returns on the next UTC day.`] };
    if (row.can_afford === false) return { lines: [`${row.label} costs ${row.price} Karma and you have ${view.balance}. Karma is earned in NemoWorld; nothing was requested.`] };
    const { request, created } = this.createRequest(identity, player_uuid, alias, resident_id, { id: row.id, price: row.price });
    const code = request.request_id.slice(0, 8);
    const left = minutes(request.expires_at - this.now);
    return {
      request_id: request.request_id,
      lines: [
        `${created ? 'I noted' : 'You already have'} a request for ${row.label} at ${row.price} Karma (code ${code}). Nothing is charged yet.`,
        `Sign in to NemoWorld, open the Veloren shop page, and confirm it within ${left} minutes. Only you can; I cannot take payment in chat.`,
      ],
    };
  }

  // ---- notices: what the shopkeeper tells a player when something changes -----------------------

  #notice(player_uuid, text, dedupe) {
    this.sql.run('INSERT OR IGNORE INTO shop_notices(id,player_uuid,text,created_at,expires_at,dedupe) VALUES(?,?,?,?,?,?)',
      randomUUID(), player_uuid, cleanLine(text, 400), this.now, this.now + this.policy.notice_ttl_ms, dedupe);
  }

  notices() {
    this.#expireStale();
    this.#refreshAll();
    return this.sql.all('SELECT id,player_uuid,text FROM shop_notices WHERE delivered_at IS NULL AND expires_at>? ORDER BY created_at LIMIT ?', this.now, this.policy.notices_per_poll);
  }

  ackNotices(ids) {
    if (!Array.isArray(ids) || ids.length > 50 || ids.some((id) => typeof id !== 'string' || !UUID.test(id))) fail(400, 'Send up to 50 notice ids.');
    let n = 0;
    for (const id of ids) n += Number(this.sql.run('UPDATE shop_notices SET delivered_at=? WHERE id=? AND delivered_at IS NULL', this.now, id).changes);
    return { acknowledged: n };
  }

  // ---- deliveries: only a signed acknowledgement says anything happened ------------------------

  // The acknowledgements stored for one command, as the Veloren server signed them.
  #acks(cmd_id) {
    return this.sql.all("SELECT kind,player_uuid,occurred_at FROM link_events WHERE landmark_id=? AND kind IN ('command.applied','command.rejected')", cmd_id);
  }

  // applied | rejected | pending | expired_unconfirmed, judged only from signed acks for THIS player.
  #commandOutcome(row, player_uuid) {
    const acks = this.#acks(row.cmd_id);
    if (acks.some((ack) => ack.kind === 'command.applied' && ack.player_uuid === player_uuid)) return 'applied';
    if (acks.some((ack) => ack.kind === 'command.rejected' && ack.player_uuid === player_uuid)) return 'rejected';
    return row.expires_at < this.now ? 'expired_unconfirmed' : 'pending';
  }

  #deliveries(request_id, role = 'delivery') {
    return this.sql.all('SELECT * FROM shop_deliveries WHERE request_id=? AND role=? ORDER BY issued_at, rowid', request_id, role);
  }

  // The delivery state of a paid order: none | delivering | delivered | failed | unconfirmed.
  deliveryState(request) {
    const rows = this.#deliveries(request.request_id);
    if (!rows.length) return { status: 'none', attempts: 0 };
    const outcomes = rows.map((row) => ({ row, outcome: this.#commandOutcome(row, request.player_uuid) }));
    const applied = outcomes.filter((item) => item.outcome === 'applied');
    if (applied.length) return { status: 'delivered', attempts: rows.length, duplicate: applied.length > 1 };
    const last = outcomes[outcomes.length - 1];
    const status = last.outcome === 'applied' ? 'delivered' : last.outcome === 'rejected' ? 'failed' : last.outcome === 'pending' ? 'delivering' : 'unconfirmed';
    return { status, attempts: rows.length, cmd_id: last.row.cmd_id, retry_after: status === 'unconfirmed' ? last.row.expires_at + this.policy.retry_grace_ms : null };
  }

  // Bring one paid order up to date from the stored acknowledgements and tell the player once.
  #refresh(request) {
    if (request.state !== 'paid') return request;
    const state = this.deliveryState(request);
    const label = GOOD_LABEL(request.good_id);
    if (state.status === 'delivered' && !request.delivered_at) {
      this.sql.run('UPDATE shop_requests SET delivered_at=? WHERE request_id=? AND delivered_at IS NULL', this.now, request.request_id);
      if (state.duplicate) this.sql.run("UPDATE shop_requests SET anomaly='more_than_one_delivery_acknowledged' WHERE request_id=?", request.request_id);
      this.#notice(request.player_uuid, `Delivered: ${label} is in your inventory.`, `delivered:${request.request_id}`);
    } else if (state.status === 'failed') {
      this.#notice(request.player_uuid, `I could not hand over your ${label}: the game refused it (for example you were offline or your pack was full). Your Karma is spent and the good is on your NemoWorld shelf. Ask your operator to press Retry delivery in NemoWorld.`, `failed:${request.request_id}:${state.cmd_id}`);
    } else if (state.status === 'unconfirmed' && this.now >= state.retry_after) {
      this.#notice(request.player_uuid, `I have no word yet on your ${label}. Your operator can press Retry delivery in NemoWorld; the game will not deliver one order twice.`, `unconfirmed:${request.request_id}:${state.cmd_id}`);
    }
    return this.sql.get('SELECT * FROM shop_requests WHERE request_id=?', request.request_id);
  }

  #refreshAll() {
    for (const row of this.sql.all("SELECT * FROM shop_requests WHERE state='paid' AND delivered_at IS NULL")) this.#refresh(row);
  }

  // A request as the human (and the shopkeeper) sees it.
  view(request) {
    const label = GOOD_LABEL(request.good_id);
    const base = { request_id: request.request_id, code: request.request_id.slice(0, 8), good_id: request.good_id, label, price: request.price, player_alias: request.player_alias, player_uuid: request.player_uuid, agent_id: request.agent_id, created_at: request.created_at, expires_at: request.expires_at, state: request.state, anomaly: request.anomaly || '' };
    if (request.state === 'pending' && request.expires_at <= this.now) return { ...base, state: 'expired', delivery: 'none', text: 'expired; nothing was charged', can_confirm: false, can_retry: false };
    if (request.state === 'pending') return { ...base, delivery: 'none', text: `waiting for you to confirm in NemoWorld (${minutes(request.expires_at - this.now)} min left)`, can_confirm: true, can_retry: false };
    if (request.state === 'confirming') return { ...base, delivery: 'none', text: 'being confirmed', can_confirm: this.now - request.state_at > this.policy.confirming_stale_ms, can_retry: false };
    if (request.state === 'paid') {
      const d = this.deliveryState(request);
      const text = { none: 'paid; delivery not started', delivering: 'paid; delivering to the game', delivered: 'paid and delivered', failed: 'paid; the game refused the delivery (retry when the player is online with room)', unconfirmed: 'paid; no answer from the game yet' }[d.status];
      const waiting = d.status === 'unconfirmed' && this.now < d.retry_after;
      return { ...base, paid_at: request.paid_at, purchase_id: request.purchase_id, delivery: d.status, delivery_attempts: d.attempts, text: waiting ? 'paid; waiting for the game to answer' : text, can_confirm: false, can_retry: ['none', 'failed'].includes(d.status) || (d.status === 'unconfirmed' && !waiting) };
    }
    const text = { declined: 'declined; nothing was charged', cancelled: 'cancelled; nothing was charged', expired: 'expired; nothing was charged' }[request.state] || request.state;
    return { ...base, delivery: 'none', text, can_confirm: false, can_retry: false };
  }

  // ---- the human operator -----------------------------------------------------------------------

  #human(actor) {
    if (!actor?.account || actor.kind !== 'session' || actor.readOnly || !actor.credential?.hash) fail(403, 'Only the signed-in human operator can do this.');
    return actor;
  }

  #owned(actor, request_id) {
    if (typeof request_id !== 'string' || !UUID.test(request_id)) fail(400, 'A request id is required.');
    const row = this.sql.get('SELECT * FROM shop_requests WHERE request_id=?', request_id);
    // Another operator's request looks exactly like a missing one.
    if (!row || row.account_id !== actor.account.id) fail(404, 'Request not found.');
    return row;
  }

  list(actor) {
    this.#human(actor);
    this.#expireStale();
    this.#refreshAll();
    const rows = this.sql.all('SELECT * FROM shop_requests WHERE account_id=? ORDER BY created_at DESC LIMIT ?', actor.account.id, this.policy.recent_requests_for_account);
    let wallet = null;
    try {
      const agent = rows[0]?.agent_id;
      if (agent) { const w = this.platform.karmaWallet(actor, { agent_id: agent }); wallet = { balance: w.balance, currency: w.currency, agent_id: agent }; }
    } catch { /* the page still lists requests */ }
    return { requests: rows.map((row) => this.view(row)), wallet, policy: { request_expiry_minutes: this.policy.request_expiry_ms / 60_000, sells: 'in-world goods only', purchases_are: 'human operator only' }, server_time: this.now };
  }

  decline(actor, request_id) {
    this.#human(actor);
    const row = this.#owned(actor, request_id);
    if (row.state === 'declined') return this.view(row);
    if (row.state !== 'pending') fail(409, 'Only a waiting request can be declined.');
    this.sql.run("UPDATE shop_requests SET state='declined', state_at=? WHERE request_id=? AND state='pending'", this.now, row.request_id);
    this.#notice(row.player_uuid, `Your operator declined the request for ${GOOD_LABEL(row.good_id)}. Nothing was charged.`, `declined:${row.request_id}`);
    return this.view(this.sql.get('SELECT * FROM shop_requests WHERE request_id=?', row.request_id));
  }

  // Ask the Veloren server, with a command that gives nothing, whether this order could be delivered.
  async #preflight(request, entry) {
    const command = this.link.issueCommand({
      kind: 'grant_item', player_uuid: request.player_uuid, ttl_ms: this.policy.preflight_ttl_ms, issuedBy: `shop:${request.account_id}`.slice(0, 60),
      args: { order: request.request_id, good: entry.good, qty: entry.qty, dry_run: true },
    });
    this.sql.run("INSERT INTO shop_deliveries(cmd_id,request_id,role,issued_at,expires_at) VALUES(?,?,'preflight',?,?)", command.cmd_id, request.request_id, command.issued_at, command.expires_at);
    const row = { cmd_id: command.cmd_id, expires_at: command.expires_at };
    const deadline = this.now + this.policy.preflight_wait_ms;
    for (;;) {
      const outcome = this.#commandOutcome(row, request.player_uuid);
      if (outcome === 'applied') return { ok: true };
      if (outcome === 'rejected') return { ok: false, reason: 'rejected' };
      if (this.now >= deadline || this.now > row.expires_at) return { ok: false, reason: 'no_answer' };
      await this.sleep(this.policy.preflight_poll_ms);
    }
  }

  #issueDelivery(request, actor) {
    const entry = this.manifest.goods.get(request.good_id);
    if (!entry) fail(409, 'That good cannot be delivered into the game.');
    const identity = this.linked(request.player_uuid);
    if (!identity || identity.account_id !== actor.account.id || identity.agent_id !== request.agent_id) fail(409, 'The Veloren character is no longer linked to this account, so nothing was sent to the game.');
    const state = this.deliveryState(request);
    if (state.status === 'delivered') return null;
    if (state.status === 'delivering') return null;
    if (state.status === 'unconfirmed' && this.now < state.retry_after) return null;
    const command = this.link.issueCommand({
      kind: 'grant_item', player_uuid: request.player_uuid, ttl_ms: this.policy.delivery_ttl_ms, issuedBy: `shop:${request.account_id}`.slice(0, 60),
      args: { order: request.request_id, good: entry.good, qty: entry.qty },
    });
    this.sql.run("INSERT INTO shop_deliveries(cmd_id,request_id,role,issued_at,expires_at) VALUES(?,?,'delivery',?,?)", command.cmd_id, request.request_id, command.issued_at, command.expires_at);
    return command;
  }

  /**
   * The human confirms one request. Idempotent: a request is charged at most once, whatever the
   * client does, and the answer for a request that is already paid is its recorded state.
   */
  async confirm(actor, request_id, idempotencyKey) {
    this.#human(actor);
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 100) fail(400, 'An Idempotency-Key of 1–100 characters is required to confirm a purchase.');
    let row = this.#owned(actor, request_id);
    if (row.state === 'paid') return { request: this.view(this.#refresh(row)), repeated: true };
    if (row.state === 'pending' && row.expires_at <= this.now) { this.#expireStale(); row = this.#owned(actor, request_id); }
    if (row.state === 'expired') fail(410, 'This request expired after 10 minutes and nothing was charged. Ask the shopkeeper again in the game.');
    if (['declined', 'cancelled'].includes(row.state)) fail(409, `This request was ${row.state}; ask the shopkeeper again in the game.`);
    // A request left "confirming" by a crash is resumed, not re-asked: the platform's purchase below
    // answers a key it has already recorded without charging again, and enforces every limit if not.
    const resuming = row.state === 'confirming';
    if (resuming && this.now - row.state_at <= this.policy.confirming_stale_ms) fail(409, 'This request is already being confirmed.');

    const entry = this.manifest.goods.get(row.good_id);
    if (!entry) fail(409, 'That good cannot be delivered into the game, so it cannot be bought from the game.');
    const identity = this.linked(row.player_uuid);
    if (!identity || identity.account_id !== actor.account.id || identity.agent_id !== row.agent_id) fail(409, 'The Veloren character is not linked to your account (any more), so this request cannot be confirmed.');

    if (!resuming) {
      // Cheap, honest pre-checks on the platform's own view; the platform decides again at the charge.
      const view = this.platform.shopCatalogue(actor, { agent_id: row.agent_id });
      const good = view.goods.find((item) => item.id === row.good_id);
      if (!good) fail(409, 'The shop does not sell that good.');
      if (!good.available_today) fail(429, `Today's allowance for ${good.label} is used up on your account. It returns on the next UTC day.`);
      if (good.can_afford === false) fail(409, `${good.label} costs ${good.price} Karma and your purse holds ${view.balance}. Nothing was charged.`);
    }

    // Take the request (pending -> confirming) before anything slow, so a second click or a second
    // device cannot run the same confirmation alongside this one.
    const taken = this.sql.run("UPDATE shop_requests SET state='confirming', state_at=?, idempotency_key=? WHERE request_id=? AND (state='pending' OR (state='confirming' AND state_at<=?))",
      this.now, idempotencyKey.trim(), row.request_id, this.now - this.policy.confirming_stale_ms);
    if (Number(taken.changes) !== 1) fail(409, 'This request is already being confirmed.');
    const release = () => this.sql.run("UPDATE shop_requests SET state='pending', state_at=? WHERE request_id=? AND state='confirming'", this.now, row.request_id);

    try {
      const pre = resuming ? { ok: true } : await this.#preflight(row, entry);
      if (!pre.ok) {
        release();
        fail(409, pre.reason === 'rejected'
          ? 'The game refused this delivery (the player must be online in the world with room in the pack). Nothing was charged. Try again when they are ready.'
          : 'The game did not answer in time (is the Veloren server and its relay running?). Nothing was charged.');
      }
      if (this.sql.get('SELECT expires_at FROM shop_requests WHERE request_id=?', row.request_id).expires_at <= this.now) { release(); fail(410, 'This request expired while the game was being asked. Nothing was charged.'); }
      let purchase;
      try {
        // The platform's own purchase: allowances, the ledger chain, and a key derived from the request.
        purchase = this.platform.transaction(() => {
          const result = this.platform.shopPurchase(actor, { agent_id: row.agent_id, good_id: row.good_id }, `vlr-${row.request_id}`);
          this.platform.audit(actor.account.id, 'veloren.shop.confirmed', row.request_id);
          return result;
        });
      } catch (error) { release(); throw error; }
      this.sql.run("UPDATE shop_requests SET state='paid', state_at=?, paid_at=?, purchase_id=? WHERE request_id=?", this.now, this.now, purchase.purchase_id, row.request_id);
      this.#notice(row.player_uuid, `Payment received for ${GOOD_LABEL(row.good_id)}. Delivering it now.`, `paid:${row.request_id}`);
      row = this.sql.get('SELECT * FROM shop_requests WHERE request_id=?', row.request_id);
      let delivery = null;
      let deliveryError = null;
      try { delivery = this.#issueDelivery(row, actor); } catch (error) { deliveryError = error.message; }
      return { request: this.view(this.#refresh(row)), purchase: { purchase_id: purchase.purchase_id, balance_after: purchase.balance_after, repeated: purchase.repeated }, delivery_command: delivery?.cmd_id ?? null, ...(deliveryError ? { delivery_error: deliveryError } : {}), repeated: false };
    } catch (error) {
      // A paid request must never be left "confirming".
      const current = this.sql.get('SELECT state FROM shop_requests WHERE request_id=?', row.request_id);
      if (current?.state === 'confirming') release();
      throw error;
    }
  }

  retry(actor, request_id) {
    this.#human(actor);
    const row = this.#owned(actor, request_id);
    if (row.state !== 'paid') fail(409, 'Only a paid order can be delivered again.');
    const refreshed = this.#refresh(row);
    const state = this.deliveryState(refreshed);
    if (state.status === 'delivered') fail(409, 'This order was already delivered. The game never delivers one order twice.');
    if (state.status === 'delivering') fail(409, 'A delivery is already on its way to the game.');
    if (state.status === 'unconfirmed' && this.now < state.retry_after) fail(409, 'The game may still be answering the last delivery. Wait a minute and check again, so the order cannot arrive twice.');
    const command = this.#issueDelivery(refreshed, actor);
    return { request: this.view(this.sql.get('SELECT * FROM shop_requests WHERE request_id=?', row.request_id)), delivery_command: command?.cmd_id ?? null };
  }
}

// ---- the extension ---------------------------------------------------------------------------------

const SCHEMA = {
  version: 1,
  sql: `
    CREATE TABLE shop_requests(
      request_id TEXT PRIMARY KEY, resident_id TEXT NOT NULL, player_uuid TEXT NOT NULL, player_alias TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL, agent_id TEXT NOT NULL, good_id TEXT NOT NULL, price INTEGER NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','confirming','paid','declined','cancelled','expired')),
      state_at INTEGER NOT NULL, idempotency_key TEXT, purchase_id TEXT, paid_at INTEGER, delivered_at INTEGER, anomaly TEXT NOT NULL DEFAULT '');
    CREATE INDEX shop_requests_player ON shop_requests(player_uuid, state, expires_at);
    CREATE INDEX shop_requests_account ON shop_requests(account_id, created_at);
    CREATE TABLE shop_deliveries(
      cmd_id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES shop_requests(request_id),
      role TEXT NOT NULL CHECK(role IN ('preflight','delivery')), issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX shop_deliveries_request ON shop_deliveries(request_id, role);
    CREATE TABLE shop_notices(
      id TEXT PRIMARY KEY, player_uuid TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      delivered_at INTEGER, dedupe TEXT NOT NULL UNIQUE);
    CREATE TABLE shop_asks(player_uuid TEXT PRIMARY KEY, last_at INTEGER NOT NULL);`,
};

const services = new WeakMap();
const serviceFor = (link, platform) => {
  let service = services.get(link);
  if (!service || service.platform !== platform) { service = new ShopService(link, platform); services.set(link, service); }
  return service;
};

function page(response, status, type, text) {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(text);
}

export default {
  name: 'shop',
  schema: SCHEMA,
  async handle(link, ctx) {
    const { route, request, response, json, body, tokenFrom, platform } = ctx;
    if (!route.startsWith('/veloren/shop/')) return false;
    if (!platform) fail(503, 'The shop needs the NemoWorld platform.');
    const method = request.method;
    const shop = serviceFor(link, platform);
    const human = () => {
      let actor;
      const token = tokenFrom(request);
      actor = platform.authenticate(token);
      if (actor.kind !== 'session') fail(403, 'Only the signed-in human operator can use the shop requests.');
      return actor;
    };

    // The page itself: no secrets, no data. It reads the operator's own requests with their session.
    if (method === 'GET' && route === '/veloren/shop/panel') { page(response, 200, 'text/html; charset=utf-8', PANEL_HTML); return true; }
    if (method === 'GET' && route === '/veloren/shop/panel.js') { page(response, 200, 'text/javascript; charset=utf-8', PANEL_JS); return true; }
    if (method === 'GET' && route === '/veloren/shop/panel.css') { page(response, 200, 'text/css; charset=utf-8', PANEL_CSS); return true; }

    // In game (a shopkeeper's link credential).
    if (method === 'POST' && route === '/veloren/shop/ask') {
      const credential = link.authenticate(tokenFrom(request), 'shop');
      json(response, 200, shop.ask(credential, await body(request)));
      return true;
    }
    if (method === 'GET' && route === '/veloren/shop/notices') {
      const credential = link.authenticate(tokenFrom(request), 'shop');
      if (!SHOPKEEPERS.includes(credential.resident_id)) fail(403, 'This credential does not belong to a shopkeeper.');
      json(response, 200, { notices: shop.notices() });
      return true;
    }
    if (method === 'POST' && route === '/veloren/shop/notices/ack') {
      const credential = link.authenticate(tokenFrom(request), 'shop');
      if (!SHOPKEEPERS.includes(credential.resident_id)) fail(403, 'This credential does not belong to a shopkeeper.');
      json(response, 200, shop.ackNotices((await body(request)).ids));
      return true;
    }

    // The signed-in human operator.
    if (method === 'GET' && route === '/veloren/shop/requests') { json(response, 200, shop.list(human())); return true; }
    if (method === 'POST' && route === '/veloren/shop/requests/confirm') {
      const actor = human();
      const input = await body(request);
      json(response, 200, await shop.confirm(actor, input.request_id, request.headers['idempotency-key']));
      return true;
    }
    if (method === 'POST' && route === '/veloren/shop/requests/decline') { const actor = human(); json(response, 200, shop.decline(actor, (await body(request)).request_id)); return true; }
    if (method === 'POST' && route === '/veloren/shop/orders/retry') { const actor = human(); json(response, 200, shop.retry(actor, (await body(request)).request_id)); return true; }
    return false;
  },
};

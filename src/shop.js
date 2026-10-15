// The shop: a frozen catalogue of in-world goods and one atomic purchase.
//
// Currency lives elsewhere. `src/karma.js` owns the Karma Coin ledger and the debit; this module only
// asks the platform for a debit (`platform.karmaSpend`) and a balance (`platform.karmaWallet`). It
// never writes, reads or converts a currency table, so the shop cannot mint, move or convert value.
//
// A purchase runs inside the caller's existing `platform.transaction(...)` — the server's write routes
// already open one per request — so the debit and the grant below commit or roll back together. That
// shared transaction is the whole reason a failed grant returns the Karma: the currency write is
// rolled back with the goods write, not compensated afterwards.
//
// Nothing in the catalogue, the projection or the purchase moves NemoCoins, money, land, a role, a
// scope or a grant. Version one has no gift or transfer of Karma between accounts: a purchase always
// spends the buyer's own balance on a good that lands with the buyer's own resident.
import { randomUUID } from 'node:crypto';
import content from './content.js';
import { GARDEN_PALETTE, HOUSE_PALETTE } from './placement-policy.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const invalid = (message) => { throw new Error(`shop catalogue: ${message}`); };
const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
};
const IDENTIFIER = /^[a-z][a-z0-9_]{0,39}$/;
const utcDay = (time) => new Date(time).toISOString().slice(0, 10);
/** The whole numbers this shop deals in. Prices are small, whole Karma Coins and never read from a request. */
export const SHOP_LIMITS = Object.freeze({
  price_min: 8, price_max: 40, per_day_min: 1, per_day_max: 10, quantity_max: 99, shelf_quantity_max: 999, key_max: 100,
});
export const SHOP_CATEGORIES = Object.freeze(['resource', 'object', 'cosmetic']);

// The sentence every projection carries. The shop is deliberately narrow: it sells grown resources, a
// garden or cottage object, and a resident keepsake, and it can never sell anything a real economy
// would price.
export const SHOP_POLICY = Object.freeze({
  version: 1,
  currency: 'Karma Coins',
  earned_by: 'services performed in the world',
  sells: 'in-world goods only: grown crop resources, garden and cottage objects, and resident keepsakes',
  never_sells: Object.freeze(['land', 'roles', 'authority', 'experience points', 'review power', 'real-world value']),
  moves_coins: false, moves_money: false, moves_land: false, moves_roles: false, moves_scopes: false, moves_grants: false,
  gift_or_transfer: false, cash_value: false, convertible: false,
  description: 'The shop sells only in-world goods and never land, roles, authority, XP, review power or anything with real-world value. A purchase spends Karma Coins and grants the named good to the buyer\u2019s own resident; it moves no NemoCoin, no money, no land, no role, no scope and no grant. Karma cannot be gifted or transferred to another account in version one.',
});

// The sealed ids every grant is checked against. These come from the content bundle and the shipped
// build palettes, never from the catalogue, so the catalogue can only ever name something the game
// already defines.
const CROP_KINDS = new Set(Object.keys(content.crops()));
const KEEPSAKE_KINDS = new Set(content.cosmetics('craft'));
const SHOP_WORLDS = Object.freeze({ garden: GARDEN_PALETTE, house: HOUSE_PALETTE });

/**
 * The catalogue. Every `grant` names a sealed id: a crop kind the garden already grows, a furniture
 * id one of the two shipped build palettes already allows (their union is the runtime's BUILD_PALETTE
 * in src/placement-policy.js), or a craft keepsake `src/journey.js` already reads off the shelf as a
 * resident appearance. Prices are whole Karma Coins; `per_account_limit_per_day` bounds one account,
 * not one resident, so a second character cannot double a limit.
 */
export const SHOP_CATALOGUE = deepFreeze([
  {
    id: 'herbs', label: 'Herb bundle', summary: 'Two herb crops, grown from the sealed herb seed.', category: 'resource', price: 8, per_account_limit_per_day: 6,
    grant: { kind: 'herbs', quantity: 2 },
    note: 'Adds the sealed crop kind herbs to journey_inventory, the same kind a garden harvest yields.',
  },
  {
    id: 'fiber', label: 'Fiber bundle', summary: 'Two fiber crops for weaving and crafting.', category: 'resource', price: 9, per_account_limit_per_day: 6,
    grant: { kind: 'fiber', quantity: 2 },
    note: 'Adds the sealed crop kind fiber to journey_inventory.',
  },
  {
    id: 'wood', label: 'Wood bundle', summary: 'Two wood crops for building and crafting.', category: 'resource', price: 10, per_account_limit_per_day: 6,
    grant: { kind: 'wood', quantity: 2 },
    note: 'Adds the sealed crop kind wood to journey_inventory.',
  },
  {
    id: 'herb_crate', label: 'Herb crate', summary: 'Five herb crops at once, for a run of crafting.', category: 'resource', price: 18, per_account_limit_per_day: 3,
    grant: { kind: 'herbs', quantity: 5 },
    note: 'The same sealed kind as the herb bundle, in a larger quantity; the shelf bound still applies.',
  },
  {
    id: 'flower_crown', label: 'Flower crown keepsake', summary: 'A woven flower crown your resident can wear as its keepsake.', category: 'cosmetic', price: 20, per_account_limit_per_day: 1,
    grant: { cosmetic: 'flower_crown' },
    note: 'A sealed craft keepsake. It lands on the shelf, where src/journey.js already offers a held keepsake as a resident appearance.',
  },
  {
    id: 'herbal_wreath', label: 'Herbal wreath keepsake', summary: 'A dried herbal wreath for your resident to wear.', category: 'cosmetic', price: 24, per_account_limit_per_day: 1,
    grant: { cosmetic: 'herbal_wreath' },
    note: 'A sealed craft keepsake, offered as a resident appearance once it is held.',
  },
  {
    id: 'woven_banner', label: 'Woven banner keepsake', summary: 'A small woven banner as a keepsake appearance.', category: 'cosmetic', price: 28, per_account_limit_per_day: 1,
    grant: { cosmetic: 'woven_banner' },
    note: 'A sealed craft keepsake, offered as a resident appearance once it is held.',
  },
  {
    id: 'festival_banner', label: 'Festival banner keepsake', summary: 'The festival banner, the shop\u2019s most costly keepsake.', category: 'cosmetic', price: 40, per_account_limit_per_day: 1,
    grant: { cosmetic: 'festival_banner' },
    note: 'A sealed craft keepsake, offered as a resident appearance once it is held.',
  },
]);

/**
 * Refuses a catalogue that names anything the sealed content or the sealed palettes do not define, so
 * a price, a category or a grant can never drift away from the game. This runs once on the frozen
 * SHOP_CATALOGUE below, at boot: a bad entry stops the process rather than shipping as a broken good.
 */
export function validateShopCatalogue(catalogue) {
  if (!Array.isArray(catalogue) || !catalogue.length) invalid('the catalogue must be a non-empty array of goods');
  const seen = new Set();
  for (const good of catalogue) {
    const where = `good ${JSON.stringify(good?.id)}`;
    if (!good || typeof good !== 'object' || Array.isArray(good)) invalid(`${where}: every good must be an object`);
    if (typeof good.id !== 'string' || !IDENTIFIER.test(good.id)) invalid(`${where}: a good id must be a lower-case identifier`);
    if (seen.has(good.id)) invalid(`${where}: the catalogue lists that good id twice`);
    seen.add(good.id);
    for (const field of ['label', 'summary', 'note']) if (typeof good[field] !== 'string' || !good[field].trim()) invalid(`${where}: ${field} must be a non-empty sentence`);
    if (!SHOP_CATEGORIES.includes(good.category)) invalid(`${where}: category must be one of ${SHOP_CATEGORIES.join(', ')}`);
    if (!Number.isInteger(good.price) || good.price < SHOP_LIMITS.price_min || good.price > SHOP_LIMITS.price_max) invalid(`${where}: price must be a whole number of Karma Coins from ${SHOP_LIMITS.price_min} to ${SHOP_LIMITS.price_max}`);
    if (!Number.isInteger(good.per_account_limit_per_day) || good.per_account_limit_per_day < SHOP_LIMITS.per_day_min || good.per_account_limit_per_day > SHOP_LIMITS.per_day_max) invalid(`${where}: per_account_limit_per_day must be a whole number from ${SHOP_LIMITS.per_day_min} to ${SHOP_LIMITS.per_day_max}`);
    validateGrant(where, good);
  }
  const stocked = new Set(catalogue.map((good) => good.category));
  // Every stocked category must be one the module knows (checked per good above), and the catalogue
  // must stock more than one kind of good. A category the free build palette already gives away is
  // deliberately allowed to be empty: selling a bench a resident can already place for nothing would
  // sell nothing. The object path keeps its own grant validation for a good that is genuinely scarce.
  if (stocked.size < 2) invalid('the catalogue stocks one kind of good only');
  return catalogue;
}

function validateGrant(where, good) {
  const grant = good.grant;
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) invalid(`${where}: grant must be an object`);
  const shape = Object.keys(grant).sort().join(',');
  if (good.category === 'resource') {
    if (shape !== 'kind,quantity') invalid(`${where}: a resource grant is exactly { kind, quantity }`);
    if (!CROP_KINDS.has(grant.kind)) invalid(`${where}: grant.kind ${JSON.stringify(grant.kind)} is not a sealed crop kind`);
    if (!Number.isInteger(grant.quantity) || grant.quantity < 1 || grant.quantity > SHOP_LIMITS.quantity_max) invalid(`${where}: grant.quantity must be a whole number from 1 to ${SHOP_LIMITS.quantity_max}`);
    return;
  }
  if (good.category === 'object') {
    if (shape !== 'type,world') invalid(`${where}: an object grant is exactly { type, world }`);
    if (!Object.hasOwn(SHOP_WORLDS, grant.world)) invalid(`${where}: grant.world must be garden or house`);
    if (!SHOP_WORLDS[grant.world].includes(grant.type)) invalid(`${where}: grant.type ${JSON.stringify(grant.type)} is not in the sealed ${grant.world} palette`);
    if (content.entry(grant.type, 'furniture') === undefined) invalid(`${where}: grant.type ${JSON.stringify(grant.type)} is not a sealed furniture definition`);
    return;
  }
  if (shape !== 'cosmetic') invalid(`${where}: a cosmetic grant is exactly { cosmetic }`);
  if (!KEEPSAKE_KINDS.has(grant.cosmetic)) invalid(`${where}: grant.cosmetic ${JSON.stringify(grant.cosmetic)} is not a sealed craft keepsake`);
  if (content.entry(grant.cosmetic, 'cosmetic')?.rules.output !== grant.cosmetic) invalid(`${where}: grant.cosmetic ${JSON.stringify(grant.cosmetic)} is not the shelf keepsake src/journey.js offers as a resident appearance`);
}

// Boot validation: the frozen catalogue above is checked against the sealed content on import.
validateShopCatalogue(SHOP_CATALOGUE);

// The shop's own ledger of purchases, and its only table. It records what was bought, for whom, on
// which UTC day and under which idempotency key, so a replay can be answered from the record and a
// per-day limit can be counted. It holds no balance: the wallet stays with the currency module.
export const SHOP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS shop_purchases(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),agent_id TEXT NOT NULL REFERENCES agents(id),good_id TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('resource','object','cosmetic')),price INTEGER NOT NULL CHECK(price BETWEEN ${SHOP_LIMITS.price_min} AND ${SHOP_LIMITS.price_max}),granted TEXT NOT NULL CHECK(json_valid(granted) AND json_type(granted)='object'),world_id TEXT,karma_receipt_id TEXT,balance_after INTEGER,key TEXT NOT NULL,day TEXT NOT NULL CHECK(length(day)=10),created_at INTEGER NOT NULL CHECK(created_at>=0),UNIQUE(account_id,key));
  CREATE INDEX IF NOT EXISTS shop_purchases_day ON shop_purchases(account_id,day,good_id);
  CREATE INDEX IF NOT EXISTS shop_purchases_resident ON shop_purchases(agent_id,category,created_at);
  CREATE TRIGGER IF NOT EXISTS shop_purchases_no_update BEFORE UPDATE ON shop_purchases BEGIN SELECT RAISE(ABORT,'Shop purchases are append-only'); END;
`;

// The integrator joins SHOP_SCHEMA into src/database.js; this keeps the module working on its own and
// heals a table that a first, rolled-back purchase took with it. One indexed catalog read per call.
function ensureShopSchema(platform) {
  if (platform.get("SELECT name FROM sqlite_master WHERE type='table' AND name='shop_purchases'")) return;
  platform.db.exec(SHOP_SCHEMA);
}

function ownedResident(platform, actor, input, mutate = false) {
  if (!actor?.account || actor.kind !== 'session') fail(403, 'The shop belongs to the signed-in operator; an agent runtime cannot hold or spend Karma.');
  const id = input?.agent_id || actor.agent?.id;
  if (typeof id !== 'string') fail(400, 'Select your resident.');
  const agent = platform.ownedAgent(actor, id);
  if (agent.status === 'deleted') fail(404, 'Resident not found.');
  if (mutate) {
    platform.active();
    if (agent.status !== 'active') fail(403, 'Resume your resident before buying goods.');
  }
  return agent;
}
const goodById = (id) => SHOP_CATALOGUE.find((good) => good.id === id);
function chosenGood(value) {
  if (typeof value !== 'string' || !value) fail(400, 'Choose a good from the shop catalogue.');
  const good = goodById(value);
  if (!good) fail(400, 'The shop does not sell that good.');
  return good;
}
function readKey(key) {
  if (typeof key !== 'string' || !key.trim() || key.length > SHOP_LIMITS.key_max) fail(400, `An Idempotency-Key of 1\u2013${SHOP_LIMITS.key_max} characters is required for a purchase.`);
  return key.trim();
}
// A refusal from the wallet keeps its own reason verbatim and only the status is chosen here.
const debitStatus = (reason) => {
  const text = String(reason || '').toLowerCase();
  if (/paus|suspend|frozen|revoked/.test(text)) return 403;
  if (/limit/.test(text)) return 429;
  return 409;
};
// The world a granted object belongs to. Both already exist for every resident; the shop creates
// neither and places nothing.
const objectWorldId = (agentId, world) => `${world === 'house' ? 'house' : 'home'}:${agentId}`;

/**
 * The one place the shop writes `journey_inventory`. `src/journey.js` is the table's other writer and
 * cannot be edited here, so this upsert mirrors what that module already does: the same
 * `INSERT ... ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity` shape, and
 * the same guarded-write-then-check-`changes` idiom its `debitInventory` uses. The guard is the shop's
 * own shelf bound, because the sealed journey schema only checks `quantity>=0`. It is called only from
 * inside the purchase transaction, so a refusal here rolls the Karma debit back with it.
 */
function grantInventoryGood(platform, agentId, kind, quantity) {
  const changed = platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity WHERE quantity+excluded.quantity<=?', agentId, kind, quantity, SHOP_LIMITS.shelf_quantity_max);
  if (!changed.changes) fail(409, `A resident\u2019s shelf holds at most ${SHOP_LIMITS.shelf_quantity_max} of one resource; nothing was bought and no Karma was spent.`);
}

function grantGood(platform, agent, good) {
  if (good.category === 'resource') {
    grantInventoryGood(platform, agent.id, good.grant.kind, good.grant.quantity);
    return { category: 'resource', kind: good.grant.kind, quantity: good.grant.quantity };
  }
  if (good.category === 'cosmetic') {
    // A kept keepsake is already a resident appearance: src/journey.js offers every held craft output
    // as a keepsake option, so the grant is the item on the shelf and not a second profile writer.
    grantInventoryGood(platform, agent.id, good.grant.cosmetic, 1);
    return { category: 'cosmetic', cosmetic: good.grant.cosmetic, quantity: 1, equip_with: 'POST /journey/profile with avatar=<cosmetic>' };
  }
  // An object purchase is an entitlement, never a placement: world_objects has its own guards in
  // src/placement-policy.js and the placement must go through the existing build path.
  const worldId = objectWorldId(agent.id, good.grant.world);
  return { category: 'object', type: good.grant.type, world: good.grant.world, world_id: worldId, palette: good.grant.world, placement: 'place through the existing build path in that world' };
}

const purchaseView = (row, repeated) => ({
  purchase_id: row.id, good_id: row.good_id, label: goodById(row.good_id)?.label || row.good_id, category: row.category,
  price: row.price, granted: JSON.parse(row.granted), world_id: row.world_id, agent_id: row.agent_id,
  karma_receipt_id: row.karma_receipt_id, balance_after: row.balance_after, day: row.day, created_at: row.created_at, repeated,
});

/** The read-only projection: every good, its price, the buyer's remaining allowance today and the shop policy. */
export function shopCatalogue(platform, actor, input = {}) {
  if (!actor?.account || actor.kind !== 'session') fail(403, 'The shop belongs to the signed-in operator; an agent runtime cannot read a Karma wallet.');
  ensureShopSchema(platform);
  const agent = ownedResident(platform, actor, input);
  if (typeof platform.karmaWallet !== 'function') fail(503, 'The Karma wallet is not available on this platform.');
  const wallet = platform.karmaWallet(actor, { agent_id: agent.id });
  const balance = Number.isSafeInteger(wallet?.balance) ? wallet.balance : null;
  const day = utcDay(platform.clock());
  const bought = new Map(platform.all('SELECT good_id,COUNT(*) AS n FROM shop_purchases WHERE account_id=? AND day=? GROUP BY good_id', actor.account.id, day).map((row) => [row.good_id, row.n]));
  return {
    agent_id: agent.id, currency: 'Karma Coins', balance, policy: SHOP_POLICY, categories: SHOP_CATEGORIES,
    goods: SHOP_CATALOGUE.map((good) => {
      const today = bought.get(good.id) || 0, remaining = Math.max(0, good.per_account_limit_per_day - today);
      return {
        id: good.id, label: good.label, summary: good.summary, category: good.category, price: good.price,
        grant: { ...good.grant }, note: good.note, daily_limit: good.per_account_limit_per_day,
        bought_today: today, remaining_today: remaining, available_today: remaining > 0,
        can_afford: balance === null ? null : balance >= good.price,
      };
    }),
    server_time: platform.clock(),
  };
}

function purchase(platform, actor, input, key) {
  if (!actor?.account || actor.kind !== 'session') fail(403, 'The shop belongs to the signed-in operator; an agent runtime cannot hold or spend Karma.');
  const requestKey = readKey(key);
  // Only the good id is ever read from the request: the price, the quantity and the balance all come
  // from the frozen catalogue and the wallet.
  const good = chosenGood(input?.good_id);
  ensureShopSchema(platform);
  // A replayed key is answered from the recorded purchase before anything else is checked, so a retry
  // grants nothing twice even if a limit filled up in between.
  const previous = platform.get('SELECT * FROM shop_purchases WHERE account_id=? AND key=?', actor.account.id, requestKey);
  if (previous) {
    if (previous.good_id !== good.id) fail(409, 'This idempotency key was already used for a different good.');
    return purchaseView(previous, true);
  }
  const agent = ownedResident(platform, actor, input, true);
  const now = platform.clock(), day = utcDay(now);
  const today = platform.get('SELECT COUNT(*) AS n FROM shop_purchases WHERE account_id=? AND good_id=? AND day=?', actor.account.id, good.id, day).n;
  if (today >= good.per_account_limit_per_day) fail(429, `The shop sells ${good.per_account_limit_per_day} of ${good.label} per account per day; the allowance returns on the next UTC day.`);
  if (typeof platform.karmaSpend !== 'function') fail(503, 'The Karma wallet is not available on this platform.');
  // The debit is the currency module's decision, not the shop's: it refuses an overdraft, a paused
  // wallet and a replayed key, and its own daily operator limit lives with the currency.
  const debit = platform.karmaSpend(actor, { amount: good.price, good_id: good.id, key: requestKey });
  if (!debit || debit.ok !== true) fail(debitStatus(debit?.reason), debit?.reason ? `This purchase was refused: ${debit.reason}` : 'This purchase was refused by the Karma wallet.');
  // From here on a throw must undo the debit, which it does: this runs inside the caller's transaction.
  const granted = grantGood(platform, agent, good);
  const id = randomUUID();
  platform.run('INSERT INTO shop_purchases(id,account_id,agent_id,good_id,category,price,granted,world_id,karma_receipt_id,balance_after,key,day,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id, actor.account.id, agent.id, good.id, good.category, good.price, JSON.stringify(granted), granted.world_id || null, debit.purchase_id ?? null, Number.isSafeInteger(debit.balance_after) ? debit.balance_after : null, requestKey, day, now);
  platform.audit(actor.account.id, 'shop.purchased', id);
  return purchaseView(platform.get('SELECT * FROM shop_purchases WHERE id=?', id), false);
}

/**
 * One atomic purchase: validate the good, the per-account daily limit and the buyer, debit the Karma,
 * grant the good. The server's write routes already run inside `platform.transaction(...)`; only when
 * node:sqlite can prove we are not in one does the shop open its own, so the debit and the grant still
 * commit together if a caller forgets the wrapper.
 */
export function shopPurchase(platform, actor, input = {}, key) {
  if (platform.db.isTransaction === false) return platform.transaction(() => purchase(platform, actor, input, key));
  return purchase(platform, actor, input, key);
}

/** The operator's own shop record for the account export: every purchase this account made, nothing of anyone else's. */
export function shopExport(platform, actor) {
  if (actor?.kind !== 'session' || !actor.account) fail(403, 'Only the operator can export shop records.');
  ensureShopSchema(platform);
  const rows = platform.all('SELECT id,agent_id,good_id,category,price,granted,world_id,karma_receipt_id,balance_after,day,created_at FROM shop_purchases WHERE account_id=? ORDER BY created_at,id LIMIT 5000', actor.account.id);
  return { policy_version: SHOP_POLICY.version, policy_text: SHOP_POLICY.description, purchases: rows.map((row) => ({ ...row, granted: JSON.parse(row.granted) })) };
}

/** Mixed into Platform, exactly like the other feature modules; `initShop` is the integrator's seam. */
export const shopMethods = {
  initShop() { this.db.exec(SHOP_SCHEMA); },
  shopCatalogue(actor, input = {}) { return shopCatalogue(this, actor, input); },
  shopPurchase(actor, input, key) { return shopPurchase(this, actor, input, key); },
  shopExport(actor) { return shopExport(this, actor); },
};

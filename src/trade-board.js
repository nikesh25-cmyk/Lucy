import content from './content.js';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------------------------
// The trade board: the one bounded, coin-free marketplace of grown and crafted goods.
//
// `src/trade.js` is the external Comtrade research module (read-only source URLs for human review);
// this file and `src/trade-market.js` are the in-world board where residents exchange what they grew
// or made. They are deliberately separate concerns and share no table, route or record.
//
// A listing is a standing, public offer: one resident escrows a bounded quantity of grown or crafted
// kinds, and any resident of a *different operator* may claim part or all of what is left. There is
// no price, no bid, no coin, no money, no unit conversion and no land: the only things that move are
// the item kinds a resident actually harvested or crafted, and each unit moves at most once.
//
// The escrow lives in `trade_terms`: the offered and already-taken units of every kind, guarded by
// `CHECK(taken BETWEEN 0 AND offered)`. A claim is one append-only `trade_claims` row plus its
// `trade_claim_units`, inserted in the same transaction as the guarded `taken=taken+?` update, so a
// claim either happens completely or not at all. The shipped `Idempotency-Key` header is reused
// (`UNIQUE(poster_account_id,post_key)`, `UNIQUE(claimer_account_id,claim_key)`), so a replayed post
// or claim returns the recorded row and moves nothing again.
// ---------------------------------------------------------------------------------------------

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
/** The bounded text rule every board field uses: a trimmed, non-empty, length-limited string. */
export function tradeText(value, label, maximum, optional = false) {
  if (optional && (value === '' || value == null)) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(400, `${label} must contain ${optional ? '0' : '1'}–${maximum} characters.`);
  return value.trim();
}
// Growth times and recipes come from the same sealed content layer the garden and the workshop use,
// so a listing can never name a kind this world cannot grow or craft — and never a coin.
const crops = Object.freeze(content.crops());
const recipes = Object.freeze(content.recipes());

export const TRADE_LISTING_STATUSES = Object.freeze(['open', 'filled', 'cancelled', 'expired']);
export const TRADE_MARKET_LIMITS = Object.freeze({
  kinds_max: 6, quantity_max: 99, note_max: 200,
  expires_minutes_min: 1, expires_minutes_max: 10080, expires_minutes_default: 1440,
  open_per_agent: 20, board_limit: 50, own_limit: 50, claims_per_card: 10,
});
export const TRADE_MARKET_POLICY = Object.freeze({
  version: 1,
  concerns: 'virtual grown or crafted items only',
  movable: 'grown crops and the keepsakes crafted from them',
  reciprocal: false,
  prices: 0,
  bids: 0,
  transferable: false,
  coins_awarded: 0,
  moves_coins: false,
  moves_money: false,
  moves_land: false,
  converts_units: false,
  kinds_max: TRADE_MARKET_LIMITS.kinds_max,
  quantity_max: TRADE_MARKET_LIMITS.quantity_max,
  expires_minutes: [TRADE_MARKET_LIMITS.expires_minutes_min, TRADE_MARKET_LIMITS.expires_minutes_max],
  consent: 'A resident publishes a bounded standing offer of its own grown or crafted goods and escrows them. Any resident of a different operator may claim what is left; the posting side may withdraw the listing.',
  description: 'The trade board exchanges grown or crafted items between residents of different operators. It asks no price, accepts no bid and moves no NemoCoin, money, land or credit, and it never converts one unit into another.',
});

export const TRADE_MARKET_SCHEMA = `
  CREATE TABLE IF NOT EXISTS trade_listings(
   id TEXT PRIMARY KEY,
   poster_agent_id TEXT NOT NULL REFERENCES agents(id),
   poster_account_id TEXT NOT NULL REFERENCES accounts(id),
   items TEXT NOT NULL CHECK(json_valid(items) AND json_type(items)='object'),
   note TEXT NOT NULL DEFAULT '',
   status TEXT NOT NULL CHECK(status IN ('open','filled','cancelled','expired')),
   post_key TEXT NOT NULL,
   posted_at INTEGER NOT NULL CHECK(posted_at>=0),
   expires_at INTEGER NOT NULL CHECK(expires_at>posted_at),
   settled_at INTEGER,
   returned TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(returned) AND json_type(returned)='object'),
   CHECK((status='open')=(settled_at IS NULL)),
   UNIQUE(poster_account_id,post_key),
   CHECK(poster_agent_id!='')
  );
  CREATE INDEX IF NOT EXISTS trade_listings_board ON trade_listings(status,posted_at,id);
  CREATE INDEX IF NOT EXISTS trade_listings_expiry ON trade_listings(status,expires_at);
  CREATE INDEX IF NOT EXISTS trade_listings_poster ON trade_listings(poster_account_id,posted_at);
  CREATE TABLE IF NOT EXISTS trade_terms(
   listing_id TEXT NOT NULL REFERENCES trade_listings(id),
   kind TEXT NOT NULL,
   offered INTEGER NOT NULL CHECK(offered>0),
   taken INTEGER NOT NULL DEFAULT 0,
   PRIMARY KEY(listing_id,kind),
   CHECK(taken>=0 AND taken<=offered)
  );
  CREATE INDEX IF NOT EXISTS trade_terms_kind ON trade_terms(kind,listing_id);
  CREATE TABLE IF NOT EXISTS trade_claims(
   id TEXT PRIMARY KEY,
   listing_id TEXT NOT NULL REFERENCES trade_listings(id),
   claimer_agent_id TEXT NOT NULL REFERENCES agents(id),
   claimer_account_id TEXT NOT NULL REFERENCES accounts(id),
   claim_key TEXT NOT NULL,
   claimed_at INTEGER NOT NULL CHECK(claimed_at>=0),
   UNIQUE(listing_id,claimer_account_id),
   UNIQUE(claimer_account_id,claim_key)
  );
  CREATE INDEX IF NOT EXISTS trade_claims_listing ON trade_claims(listing_id,claimed_at);
  CREATE TABLE IF NOT EXISTS trade_claim_units(
   claim_id TEXT NOT NULL REFERENCES trade_claims(id),
   kind TEXT NOT NULL,
   quantity INTEGER NOT NULL CHECK(quantity>0),
   PRIMARY KEY(claim_id,kind)
  );
  CREATE TABLE IF NOT EXISTS trade_events(
   id TEXT PRIMARY KEY,
   listing_id TEXT NOT NULL REFERENCES trade_listings(id),
   account_id TEXT REFERENCES accounts(id),
   action TEXT NOT NULL CHECK(action IN ('posted','claimed','filled','cancelled','expired')),
   detail TEXT NOT NULL DEFAULT '',
   created_at INTEGER NOT NULL CHECK(created_at>=0)
  );
  CREATE INDEX IF NOT EXISTS trade_events_listing ON trade_events(listing_id,created_at);
  CREATE TRIGGER IF NOT EXISTS trade_listings_validate_insert BEFORE INSERT ON trade_listings BEGIN
    SELECT RAISE(ABORT,'A trade listing needs at least one grown or crafted kind') WHERE json_type(NEW.items)!='object' OR (SELECT COUNT(*) FROM json_each(NEW.items))=0;
    SELECT RAISE(ABORT,'Trade listing quantities must be positive whole numbers') WHERE EXISTS(SELECT 1 FROM json_each(NEW.items) WHERE json_type(value)!='integer' OR value<=0);
    SELECT RAISE(ABORT,'A trade listing must expire after it is posted') WHERE NEW.expires_at<=NEW.posted_at;
    SELECT RAISE(ABORT,'A trade listing note is too long') WHERE length(NEW.note)>200;
    SELECT RAISE(ABORT,'A trade listing starts with nothing returned') WHERE NEW.returned!='{}' OR NEW.settled_at IS NOT NULL OR NEW.status!='open';
  END;
  CREATE TRIGGER IF NOT EXISTS trade_listings_lifecycle BEFORE UPDATE ON trade_listings BEGIN
    SELECT RAISE(ABORT,'A trade listing keeps its identity, poster, items and key') WHERE NEW.id!=OLD.id OR NEW.poster_agent_id!=OLD.poster_agent_id OR NEW.poster_account_id!=OLD.poster_account_id OR NEW.items!=OLD.items OR NEW.note!=OLD.note OR NEW.post_key!=OLD.post_key OR NEW.posted_at!=OLD.posted_at OR NEW.expires_at!=OLD.expires_at;
    SELECT RAISE(ABORT,'A settled trade listing is final') WHERE OLD.status!='open' AND NEW.status!=OLD.status;
    SELECT RAISE(ABORT,'A trade listing returns items only when it settles') WHERE NEW.returned!=OLD.returned AND NEW.status='open';
    SELECT RAISE(ABORT,'A trade listing returns only what was not taken') WHERE NEW.returned!=OLD.returned AND EXISTS(SELECT 1 FROM json_each(NEW.returned) WHERE json_each.value<1 OR json_each.value>COALESCE((SELECT t.offered-t.taken FROM trade_terms t WHERE t.listing_id=NEW.id AND t.kind=json_each.key),0));
    SELECT RAISE(ABORT,'A settled trade listing states every offered kind') WHERE NEW.status!='open' AND NEW.status!=OLD.status AND (SELECT COUNT(*) FROM trade_terms WHERE listing_id=NEW.id)!=(SELECT COUNT(*) FROM json_each(NEW.items));
  END;
  CREATE TRIGGER IF NOT EXISTS trade_terms_validate_insert BEFORE INSERT ON trade_terms BEGIN
    SELECT RAISE(ABORT,'A listing term must belong to a listing') WHERE NOT EXISTS(SELECT 1 FROM trade_listings WHERE id=NEW.listing_id);
    SELECT RAISE(ABORT,'A listing term must restate the kind it was posted with') WHERE json_extract((SELECT items FROM trade_listings WHERE id=NEW.listing_id),'$.'||NEW.kind) IS NOT NEW.offered;
    SELECT RAISE(ABORT,'A listing term starts with nothing taken') WHERE NEW.taken!=0;
  END;
  CREATE TRIGGER IF NOT EXISTS trade_terms_lifecycle BEFORE UPDATE ON trade_terms BEGIN
    SELECT RAISE(ABORT,'A listing term keeps its kind and offered amount') WHERE NEW.listing_id!=OLD.listing_id OR NEW.kind!=OLD.kind OR NEW.offered!=OLD.offered;
    SELECT RAISE(ABORT,'A settled trade listing cannot be taken further') WHERE NEW.taken!=OLD.taken AND (SELECT status FROM trade_listings WHERE id=OLD.listing_id)!='open';
  END;
  CREATE TRIGGER IF NOT EXISTS trade_terms_no_delete BEFORE DELETE ON trade_terms BEGIN SELECT RAISE(ABORT,'Trade listing terms are permanent'); END;
  CREATE TRIGGER IF NOT EXISTS trade_claims_validate_insert BEFORE INSERT ON trade_claims BEGIN
    SELECT RAISE(ABORT,'A claim must belong to an open listing') WHERE NOT EXISTS(SELECT 1 FROM trade_listings WHERE id=NEW.listing_id AND status='open');
    SELECT RAISE(ABORT,'A resident cannot claim its own operator''s listing') WHERE EXISTS(SELECT 1 FROM trade_listings WHERE id=NEW.listing_id AND (poster_agent_id=NEW.claimer_agent_id OR poster_account_id=NEW.claimer_account_id));
  END;
  CREATE TRIGGER IF NOT EXISTS trade_claims_no_update BEFORE UPDATE ON trade_claims BEGIN SELECT RAISE(ABORT,'Trade claims are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS trade_claims_no_delete BEFORE DELETE ON trade_claims BEGIN SELECT RAISE(ABORT,'Trade claims are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS trade_claim_units_validate_insert BEFORE INSERT ON trade_claim_units BEGIN
    SELECT RAISE(ABORT,'A claim must name a kind that listing offered') WHERE NOT EXISTS(SELECT 1 FROM trade_terms t JOIN trade_claims c ON c.listing_id=t.listing_id WHERE c.id=NEW.claim_id AND t.kind=NEW.kind);
  END;
  CREATE TRIGGER IF NOT EXISTS trade_claim_units_no_update BEFORE UPDATE ON trade_claim_units BEGIN SELECT RAISE(ABORT,'Trade claim units are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS trade_claim_units_no_delete BEFORE DELETE ON trade_claim_units BEGIN SELECT RAISE(ABORT,'Trade claim units are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS trade_events_no_update BEFORE UPDATE ON trade_events BEGIN SELECT RAISE(ABORT,'Trade board events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS trade_events_no_delete BEFORE DELETE ON trade_events BEGIN SELECT RAISE(ABORT,'Trade board events are append-only'); END;
`;

// Schema 22 databases written before the board have no trade objects. From schema 23 the board is
// required. Once any trade object exists,
// every table, index and trigger must be the one this release authored. Checking SQL as well as names
// prevents a same-named, weakened trigger from making a backup appear sound.
let expectedSchema;
function canonicalTradeSchema() {
  if (expectedSchema) return expectedSchema;
  const reference = new DatabaseSync(':memory:');
  try {
    reference.exec(TRADE_MARKET_SCHEMA);
    expectedSchema = new Map(reference.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name LIKE 'trade_%' AND sql IS NOT NULL").all()
      .map((row) => [row.name, `${row.type}\n${row.sql}`]));
    return expectedSchema;
  } finally { reference.close(); }
}
export function tradeSchemaPresent(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name LIKE 'trade_%' LIMIT 1").get());
}
export function verifyTradeSchema(db) {
  const expected = canonicalTradeSchema();
  const actual = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name LIKE 'trade_%' AND sql IS NOT NULL").all();
  return actual.length === expected.size && actual.every((row) => expected.get(row.name) === `${row.type}\n${row.sql}`);
}

/** Every kind a resident can actually grow or craft. A coin, money or an invented kind is not one. */
export function tradeKinds() {
  return new Set([...Object.keys(crops), ...recipes.map((recipe) => recipe.output)]);
}
export function normalizeTradeItems(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'List at least one grown or crafted kind.');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > TRADE_MARKET_LIMITS.kinds_max) fail(400, `List one to ${TRADE_MARKET_LIMITS.kinds_max} kinds.`);
  const allowed = tradeKinds(), items = {};
  for (const [kind, quantity] of entries) {
    if (!allowed.has(kind)) fail(400, 'List only kinds that are grown or crafted in this world.');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > TRADE_MARKET_LIMITS.quantity_max) fail(400, `List 1–${TRADE_MARKET_LIMITS.quantity_max} of each kind.`);
    items[kind] = quantity;
  }
  return items;
}
export const sameTradeItems = (left, right) => {
  const a = left || {}, b = right || {}, keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};
/** Add items to one resident's shelf. The shelf is the shipped `journey_inventory`, never a new ledger. */
export function creditResources(platform, agentId, items) {
  for (const [kind, quantity] of Object.entries(items)) {
    if (quantity <= 0) continue;
    platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity', agentId, kind, quantity);
  }
}
/** Take items from one resident's shelf. The guarded update refuses to go below zero. */
export function debitResources(platform, agentId, items) {
  for (const [kind, quantity] of Object.entries(items)) {
    const changed = platform.run('UPDATE journey_inventory SET quantity=quantity-? WHERE agent_id=? AND kind=? AND quantity>=?', quantity, agentId, kind, quantity);
    if (!changed.changes) fail(409, 'Those resources are not all on the shelf; list only what the resident holds.');
  }
}
/** The recorded party of a listing or a claim, as any other operator reads it. */
export function tradeParty(platform, agentId) {
  const agent = platform.get('SELECT id,name FROM agents WHERE id=?', agentId);
  return { agent_id: agentId, name: agent?.name || 'A former resident' };
}
export function listingTerms(platform, listingIds) {
  if (!listingIds.length) return new Map();
  const terms = platform.all(`SELECT listing_id,kind,offered,taken FROM trade_terms WHERE listing_id IN (${listingIds.map(() => '?').join(',')}) ORDER BY kind`, ...listingIds);
  const byListing = new Map(listingIds.map((id) => [id, []]));
  for (const term of terms) byListing.get(term.listing_id)?.push({ kind: term.kind, offered: term.offered, taken: term.taken, remaining: term.offered - term.taken });
  return byListing;
}
/** The remaining units of one listing, as an items object; a kind with nothing left is omitted. */
export function remainingItems(terms) {
  return Object.fromEntries(terms.filter((term) => term.remaining > 0).map((term) => [term.kind, term.remaining]));
}
export function takenItems(terms) {
  return Object.fromEntries(terms.filter((term) => term.taken > 0).map((term) => [term.kind, term.taken]));
}
export function tradedItems(terms) {
  return Object.fromEntries(terms.map((term) => [term.kind, term.offered]));
}

/**
 * One listing as the board shows it. `viewerAccountId` decides `can_claim`: a resident of the
 * poster's own operator can never claim it, and neither can an operator that already did.
 */
export function listingCard(platform, listing, terms, viewer, { claimedListingIds = new Set(), claims = null, claimsTruncated = false } = {}) {
  const remaining = remainingItems(terms);
  return {
    id: listing.id, status: listing.status, poster: tradeParty(platform, listing.poster_agent_id),
    items: tradedItems(terms), taken: takenItems(terms), remaining, returned: JSON.parse(listing.returned), note: listing.note,
    posted_at: listing.posted_at, expires_at: listing.expires_at, settled_at: listing.settled_at,
    can_claim: listing.status === 'open' && listing.poster_account_id !== viewer.accountId && !claimedListingIds.has(listing.id) && Object.keys(remaining).length > 0,
    ...(claims ? { claims, claims_truncated: claimsTruncated } : {}),
  };
}
export function claimCard(platform, claim, units) {
  return { id: claim.id, listing_id: claim.listing_id, claimer: tradeParty(platform, claim.claimer_agent_id), items: Object.fromEntries(units.map((unit) => [unit.kind, unit.quantity])), claimed_at: claim.claimed_at };
}

/**
 * Re-check every stored trade record against the rules that wrote it. `recovery.js` owns the schema
 * 23 checks call this pass during opening, backup and restore: a claimed unit that no term can
 * account for, a term that disagrees with its
 * listing's items, a returned amount the poster was never owed, or a listing that settled on an
 * incomplete item list all refuse the start instead of serving a ledger that cannot balance.
 */
export function verifyTradeRecords(platform) {
  const allowed = tradeKinds();
  const listings = new Map(platform.all('SELECT * FROM trade_listings').map((listing) => [listing.id, listing]));
  const terms = platform.all('SELECT * FROM trade_terms');
  const claims = platform.all('SELECT * FROM trade_claims');
  const units = platform.all('SELECT * FROM trade_claim_units');
  const events = platform.all('SELECT * FROM trade_events ORDER BY created_at,rowid');
  const numbers = (value) => {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
  };
  const byListing = new Map(), byClaim = new Map(claims.map((claim) => [claim.id, claim]));
  const claimCounts = new Map(), claimsByListing = new Map(), claimIdsWithUnits = new Set(), claimItems = new Map(), eventCounts = new Map();
  for (const term of terms) {
    if (!allowed.has(term.kind) || !Number.isInteger(term.offered) || term.offered < 1 || term.offered > TRADE_MARKET_LIMITS.quantity_max || term.taken < 0 || term.taken > term.offered) return false;
    if (!byListing.has(term.listing_id)) byListing.set(term.listing_id, []);
    byListing.get(term.listing_id).push(term);
  }
  const claimed = new Map();
  for (const unit of units) {
    const claim = byClaim.get(unit.claim_id);
    if (!claim || !Number.isInteger(unit.quantity) || unit.quantity < 1 || !allowed.has(unit.kind)) return false;
    if (!(byListing.get(claim.listing_id) || []).some((term) => term.kind === unit.kind && term.offered >= unit.quantity)) return false;
    const key = `${claim.listing_id}|${unit.kind}`;
    claimed.set(key, (claimed.get(key) || 0) + unit.quantity);
    claimIdsWithUnits.add(claim.id);
    if (!claimItems.has(claim.id)) claimItems.set(claim.id, {});
    claimItems.get(claim.id)[unit.kind] = unit.quantity;
  }
  for (const claim of claims) {
    const listing = listings.get(claim.listing_id);
    if (!listing || listing.poster_agent_id === claim.claimer_agent_id || listing.poster_account_id === claim.claimer_account_id ||
        !Number.isInteger(claim.claimed_at) || claim.claimed_at < listing.posted_at || claim.claimed_at >= listing.expires_at ||
        typeof claim.claim_key !== 'string' || claim.claim_key.length < 1 || claim.claim_key.length > 100) return false;
    if (!claimIdsWithUnits.has(claim.id)) return false;
    claimCounts.set(claim.listing_id, (claimCounts.get(claim.listing_id) || 0) + 1);
    if (!claimsByListing.has(claim.listing_id)) claimsByListing.set(claim.listing_id, []);
    claimsByListing.get(claim.listing_id).push(claim);
  }
  for (const event of events) {
    const listing = listings.get(event.listing_id);
    if (!listing || !['posted', 'claimed', 'filled', 'cancelled', 'expired'].includes(event.action) || !Number.isInteger(event.created_at) || event.created_at < 0 || event.detail.length > 200) return false;
    if (event.action === 'expired') { if (event.account_id !== null) return false; }
    else if (event.account_id === null) return false;
    if (!eventCounts.has(listing.id)) eventCounts.set(listing.id, { posted: null, claimed: new Map(), settled: null });
    const count = eventCounts.get(listing.id);
    if (event.action === 'posted') { if (count.posted) return false; count.posted = event; }
    else if (event.action === 'claimed') {
      if (count.claimed.has(event.account_id)) return false;
      count.claimed.set(event.account_id, event);
    } else { if (count.settled) return false; count.settled = event; }
  }
  for (const listing of listings.values()) {
    const own = byListing.get(listing.id) || [], items = numbers(listing.items), returned = numbers(listing.returned);
    if (!items || !returned || !TRADE_LISTING_STATUSES.includes(listing.status)) return false;
    if (typeof listing.note !== 'string' || listing.note.length > TRADE_MARKET_LIMITS.note_max ||
        typeof listing.post_key !== 'string' || listing.post_key.length < 1 || listing.post_key.length > 100 ||
        !Number.isInteger(listing.posted_at) || listing.posted_at < 0 ||
        !Number.isInteger(listing.expires_at) || listing.expires_at - listing.posted_at < TRADE_MARKET_LIMITS.expires_minutes_min * 60_000 ||
        listing.expires_at - listing.posted_at > TRADE_MARKET_LIMITS.expires_minutes_max * 60_000) return false;
    const kinds = Object.keys(items);
    if (!kinds.length || kinds.length > TRADE_MARKET_LIMITS.kinds_max || kinds.length !== own.length) return false;
    if ((listing.status === 'open') !== (listing.settled_at === null)) return false;
    const counts = eventCounts.get(listing.id);
    if (!counts?.posted || counts.posted.account_id !== listing.poster_account_id || counts.posted.created_at !== listing.posted_at || counts.posted.detail !== '' ||
        counts.claimed.size !== (claimCounts.get(listing.id) || 0)) return false;
    if (listing.status === 'open' ? counts.settled !== null : !counts.settled || counts.settled.action !== listing.status || counts.settled.created_at !== listing.settled_at || !numbers(counts.settled.detail) || !sameTradeItems(numbers(counts.settled.detail), returned)) return false;
    for (const claim of claimsByListing.get(listing.id) || []) {
      const event = counts.claimed.get(claim.claimer_account_id);
      if (!event || event.created_at !== claim.claimed_at || !sameTradeItems(numbers(event.detail), claimItems.get(claim.id))) return false;
    }
    for (const kind of kinds) {
      const term = own.find((entry) => entry.kind === kind);
      if (!term || items[kind] !== term.offered || term.taken !== (claimed.get(`${listing.id}|${kind}`) || 0)) return false;
      const owed = term.offered - term.taken;
      // An open listing returns nothing yet; a filled one owes nothing; a cancelled or expired one
      // returns exactly the units that were still on the board.
      if (returned[kind] !== (listing.status === 'open' || listing.status === 'filled' ? undefined : owed > 0 ? owed : undefined)) return false;
      if (listing.status === 'filled' && owed !== 0) return false;
    }
    if (Object.keys(returned).some((kind) => !kinds.includes(kind) || !Number.isInteger(returned[kind]) || returned[kind] < 1)) return false;
  }
  return true;
}

import { randomUUID } from 'node:crypto';
import { Platform } from './platform.js';
import {
  TRADE_MARKET_LIMITS, TRADE_MARKET_POLICY, TRADE_MARKET_SCHEMA,
  claimCard, creditResources, debitResources, listingCard, listingTerms, normalizeTradeItems,
  remainingItems, sameTradeItems, tradeText, verifyTradeRecords,
} from './trade-board.js';

// ---------------------------------------------------------------------------------------------
// The trade board's execution: post, claim, withdraw and expire, in this module and nowhere else.
//
// `src/platform.js` is the single writer for the method table, so this module augments the same
// prototype the garden, community and guild modules do — from one place, after `platform.js` has
// been evaluated, so the merge order is fixed rather than incidental. Everything else here is
// ordinary platform code: `this.run` / `this.get` / `this.clock`, the shipped `journey_inventory`
// shelf, the shipped audit chain, and no new currency, ledger or unit.
//
// Atomicity comes from the caller's transaction, exactly as it does for `offerCreate` and
// `craftItem`: every route runs inside `platform.transaction`, so a refused claim or a failed insert
// rolls the shelves, the terms and the claim back together. Replay safety comes from the shipped
// `Idempotency-Key` header plus `UNIQUE(poster_account_id,post_key)` and
// `UNIQUE(claimer_account_id,claim_key)`: a retry returns the recorded row and moves nothing again.
// ---------------------------------------------------------------------------------------------

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const ensured = new WeakSet();
// The `platform.db` object is stable for the life of one open database, so each process runs the
// additive `CREATE TABLE IF NOT EXISTS` block once per database and re-checks the stored ledger once.
export function ensureTradeMarket(platform) {
  if (ensured.has(platform.db)) return platform;
  platform.db.exec(TRADE_MARKET_SCHEMA);
  if (!verifyTradeRecords(platform)) throw new Error('Stored trade board records are invalid.');
  ensured.add(platform.db);
  return platform;
}
function owned(platform, actor, input, mutate = false) {
  if (!actor?.account || !['session', 'runtime'].includes(actor.kind)) fail(401, 'Authentication required.');
  const id = input?.agent_id || actor.agent?.id;
  if (typeof id !== 'string') fail(400, 'Select your resident.');
  const agent = platform.ownedAgent(actor, id);
  if (agent.status === 'deleted') fail(404, 'Resident not found.');
  if (mutate) {
    platform.active();
    if (agent.status !== 'active') fail(403, 'Resume your resident before making changes.');
  }
  return agent;
}
function recordEvent(platform, listingId, accountId, action, detail, at) {
  platform.run('INSERT INTO trade_events VALUES(?,?,?,?,?,?)', randomUUID(), listingId, accountId, action, detail, at);
}
function claimsOf(platform, listingIds) {
  if (!listingIds.length) return [new Map(), new Map()];
  const rows = platform.all(`SELECT * FROM trade_claims WHERE listing_id IN (${listingIds.map(() => '?').join(',')}) ORDER BY claimed_at,id`, ...listingIds);
  const units = rows.length ? platform.all(`SELECT * FROM trade_claim_units WHERE claim_id IN (${rows.map(() => '?').join(',')}) ORDER BY kind`, ...rows.map((row) => row.id)) : [];
  const byClaim = new Map(rows.map((row) => [row.id, units.filter((unit) => unit.claim_id === row.id)]));
  const byListing = new Map(listingIds.map((id) => [id, []]));
  for (const row of rows) byListing.get(row.listing_id)?.push(row);
  return [byListing, byClaim];
}
// Settle one listing exactly once. The guarded update is the single point of truth: `changes` is 1
// only for the first caller, so the untaken remainder goes back to the poster exactly once even when
// an expiry tick and a request race each other. A `filled` listing owes nothing. The release is
// recorded for every settled listing; the units themselves are credited only to a resident that still
// exists, because the shipped account deletion has already given up a deleted operator's records and
// re-crediting it would write a shelf row for an account that asked to be removed.
function settleListing(platform, listing, status, accountId, at) {
  const terms = (listingTerms(platform, [listing.id]).get(listing.id) || []);
  const returned = status === 'filled' ? {} : remainingItems(terms);
  const changed = platform.run("UPDATE trade_listings SET status=?,settled_at=?,returned=? WHERE id=? AND status='open'", status, at, JSON.stringify(returned), listing.id);
  if (!changed.changes) return false;
  const poster = platform.get('SELECT status FROM agents WHERE id=?', listing.poster_agent_id);
  if (poster && poster.status !== 'deleted') creditResources(platform, listing.poster_agent_id, returned);
  recordEvent(platform, listing.id, accountId, status, JSON.stringify(returned), at);
  return true;
}

export const marketMethods = {
  // ---- The trade board -----------------------------------------------------------------------
  // Settle every listing whose stated life has elapsed. Called before each board action and on the
  // server's own three-second tick, so an abandoned listing returns its escrow to the poster even
  // when no client is looking. Each settlement is guarded by `status='open'`, so repeats are no-ops.
  tradeExpire() {
    ensureTradeMarket(this);
    const due = this.all("SELECT * FROM trade_listings WHERE status='open' AND expires_at<=?", this.clock());
    let settled = 0;
    for (const listing of due) if (settleListing(this, listing, 'expired', null, this.clock())) settled += 1;
    return settled;
  },
  tradeBoard(actor, input = {}) {
    ensureTradeMarket(this);
    if (!actor?.account || !['session', 'runtime'].includes(actor.kind)) fail(401, 'Authentication required.');
    this.tradeExpire();
    const runtime = actor.kind === 'runtime';
    if (!runtime && input.agent_id) this.ownedAgent(actor, input.agent_id);
    // The open board is what any operator may take from: bounded, newest first, and never the
    // caller's own listings (which appear under `posted` with the claims they received). A runtime
    // sees its own agent's listings and claims only, exactly as the offer list does.
    const open = this.all('SELECT * FROM trade_listings WHERE status=? AND poster_account_id!=? ORDER BY posted_at DESC,id DESC LIMIT ?', 'open', actor.account.id, TRADE_MARKET_LIMITS.board_limit);
    const posted = runtime
      ? this.all('SELECT * FROM trade_listings WHERE poster_account_id=? AND poster_agent_id=? ORDER BY posted_at DESC,id DESC LIMIT ?', actor.account.id, actor.agent.id, TRADE_MARKET_LIMITS.own_limit)
      : this.all('SELECT * FROM trade_listings WHERE poster_account_id=? ORDER BY posted_at DESC,id DESC LIMIT ?', actor.account.id, TRADE_MARKET_LIMITS.own_limit);
    const claimed = runtime
      ? this.all('SELECT * FROM trade_claims WHERE claimer_account_id=? AND claimer_agent_id=? ORDER BY claimed_at DESC,id DESC LIMIT ?', actor.account.id, actor.agent.id, TRADE_MARKET_LIMITS.own_limit)
      : this.all('SELECT * FROM trade_claims WHERE claimer_account_id=? ORDER BY claimed_at DESC,id DESC LIMIT ?', actor.account.id, TRADE_MARKET_LIMITS.own_limit);
    const listingIds = [...new Set([...open.map((listing) => listing.id), ...posted.map((listing) => listing.id), ...claimed.map((claim) => claim.listing_id)])];
    const [claimsByListing, unitsByClaim] = claimsOf(this, listingIds);
    const termsByListing = listingTerms(this, listingIds);
    const myClaims = new Set(claimed.map((claim) => claim.listing_id));
    const board = open.map((listing) => listingCard(this, listing, termsByListing.get(listing.id) || [], { accountId: actor.account.id }, { claimedListingIds: myClaims }));
    const mine = posted.map((listing) => {
      const rows = claimsByListing.get(listing.id) || [];
      const cards = rows.slice(0, TRADE_MARKET_LIMITS.claims_per_card).map((claim) => claimCard(this, claim, unitsByClaim.get(claim.id) || []));
      return listingCard(this, listing, termsByListing.get(listing.id) || [], { accountId: actor.account.id }, { claims: cards, claimsTruncated: rows.length > cards.length });
    });
    const taken = claimed.map((claim) => ({
      ...claimCard(this, claim, unitsByClaim.get(claim.id) || []),
      listing: listingCard(this, this.get('SELECT * FROM trade_listings WHERE id=?', claim.listing_id), termsByListing.get(claim.listing_id) || [], { accountId: actor.account.id }),
    }));
    return {
      agent_id: runtime ? actor.agent.id : input.agent_id || null,
      listings: board, posted: mine, claimed: taken,
      policy: TRADE_MARKET_POLICY, limits: TRADE_MARKET_LIMITS, server_time: this.clock(),
    };
  },
  tradePost(actor, input, key) {
    ensureTradeMarket(this);
    this.active();
    const agent = owned(this, actor, input, true);
    const postKey = tradeText(key, 'Idempotency key', 100);
    const items = normalizeTradeItems(input.items);
    // A replayed post returns the recorded listing before anything else is validated, so a retry
    // never escrows the same items twice even if the shelf changed around it.
    const previous = this.get('SELECT * FROM trade_listings WHERE poster_account_id=? AND post_key=?', actor.account.id, postKey);
    if (previous) {
      if (previous.poster_agent_id !== agent.id || !sameTradeItems(JSON.parse(previous.items), items)) fail(409, 'This idempotency key was used for a different listing.');
      return { ...listingCard(this, previous, listingTerms(this, [previous.id]).get(previous.id) || [], { accountId: actor.account.id }), repeated: true };
    }
    const note = tradeText(input.note, 'Listing note', TRADE_MARKET_LIMITS.note_max, true);
    const minutes = input.expires_minutes === undefined ? TRADE_MARKET_LIMITS.expires_minutes_default : Number(input.expires_minutes);
    if (!Number.isInteger(minutes) || minutes < TRADE_MARKET_LIMITS.expires_minutes_min || minutes > TRADE_MARKET_LIMITS.expires_minutes_max) fail(400, `Choose an expiry from ${TRADE_MARKET_LIMITS.expires_minutes_min} to ${TRADE_MARKET_LIMITS.expires_minutes_max} minutes.`);
    this.tradeExpire();
    if (this.get("SELECT COUNT(*) AS n FROM trade_listings WHERE status='open' AND poster_agent_id=?", agent.id).n >= TRADE_MARKET_LIMITS.open_per_agent) fail(429, `A resident can keep ${TRADE_MARKET_LIMITS.open_per_agent} listings open at once.`);
    const now = this.clock(), id = randomUUID();
    // Escrow first: the units leave the poster's shelf as the listing appears, so the same units can
    // never be promised by two listings and a claim always takes something the server already holds.
    debitResources(this, agent.id, items);
    this.run('INSERT INTO trade_listings VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, agent.id, actor.account.id, JSON.stringify(items), note, 'open', postKey, now, now + minutes * 60_000, null, '{}');
    for (const [kind, quantity] of Object.entries(items)) this.run('INSERT INTO trade_terms VALUES(?,?,?,0)', id, kind, quantity);
    recordEvent(this, id, actor.account.id, 'posted', '', now);
    this.audit(actor.account.id, 'trade.posted', id);
    return listingCard(this, this.get('SELECT * FROM trade_listings WHERE id=?', id), listingTerms(this, [id]).get(id) || [], { accountId: actor.account.id });
  },
  tradeClaim(actor, input, key) {
    ensureTradeMarket(this);
    this.active();
    if (!actor?.account || !['session', 'runtime'].includes(actor.kind)) fail(401, 'Authentication required.');
    const claimKey = tradeText(key, 'Idempotency key', 100);
    this.tradeExpire();
    const listing = this.get('SELECT * FROM trade_listings WHERE id=?', input.listing_id || '');
    if (!listing) fail(404, 'Listing not found.');
    // A session claims for one of its own residents; a runtime claims only for the one resident its
    // credential is bound to. Either way the claimer is checked against the poster's operator, so a
    // resident can never take from its own operator's listing and one operator never trades with itself.
    const agent = owned(this, actor, input, true);
    if (listing.poster_account_id === actor.account.id || listing.poster_agent_id === agent.id) fail(403, 'Claim a listing posted by a resident of a different operator.');
    // Naming items claims exactly that much; naming nothing (or an empty object) claims everything
    // still on the board. The same normalisation runs on a replay so a retry compares like for like.
    const explicit = input.items && typeof input.items === 'object' && !Array.isArray(input.items) && Object.keys(input.items).length ? normalizeTradeItems(input.items) : null;
    const previous = this.get('SELECT * FROM trade_claims WHERE claimer_account_id=? AND claim_key=?', actor.account.id, claimKey);
    if (previous) {
      const units = this.all('SELECT kind,quantity FROM trade_claim_units WHERE claim_id=? ORDER BY kind', previous.id);
      const recorded = Object.fromEntries(units.map((unit) => [unit.kind, unit.quantity]));
      if (previous.listing_id !== listing.id || explicit && !sameTradeItems(recorded, explicit)) fail(409, 'This idempotency key was used for a different claim.');
      return { ...claimCard(this, previous, units), listing: listingCard(this, listing, listingTerms(this, [listing.id]).get(listing.id) || [], { accountId: actor.account.id }), repeated: true };
    }
    if (listing.status !== 'open') fail(409, `This listing is ${listing.status} and cannot be claimed.`);
    if (this.get('SELECT id FROM trade_claims WHERE listing_id=? AND claimer_account_id=?', listing.id, actor.account.id)) fail(409, 'This operator already claimed from that listing; wait for another listing or another operator to post more.');
    const terms = listingTerms(this, [listing.id]).get(listing.id) || [];
    const remaining = remainingItems(terms);
    const wanted = explicit || remaining;
    if (!Object.keys(wanted).length) fail(409, 'This listing has nothing left to claim.');
    for (const [kind, quantity] of Object.entries(wanted)) {
      if (!(kind in remaining)) fail(400, 'Claim only the kinds this listing holds.');
      if (quantity > remaining[kind]) fail(409, `This listing holds ${remaining[kind]} ${kind}, not ${quantity}.`);
    }
    const now = this.clock(), claimId = randomUUID();
    this.run('INSERT INTO trade_claims VALUES(?,?,?,?,?,?)', claimId, listing.id, agent.id, actor.account.id, claimKey, now);
    for (const [kind, quantity] of Object.entries(wanted)) {
      this.run('INSERT INTO trade_claim_units VALUES(?,?,?)', claimId, kind, quantity);
      // The guarded update is the one place a listing can be taken from: `taken` can only grow while
      // the listing is open and can never pass `offered`, so concurrent claims cannot over-take.
      const changed = this.run('UPDATE trade_terms SET taken=taken+? WHERE listing_id=? AND kind=? AND offered-taken>=?', quantity, listing.id, kind, quantity);
      if (!changed.changes) fail(409, 'Another claim took those units first; read the board again.');
    }
    creditResources(this, agent.id, wanted);
    recordEvent(this, listing.id, actor.account.id, 'claimed', JSON.stringify(wanted), now);
    if (this.get('SELECT COUNT(*) AS n FROM trade_terms WHERE listing_id=? AND taken<offered', listing.id).n === 0) settleListing(this, listing, 'filled', actor.account.id, now);
    this.audit(actor.account.id, 'trade.claimed', claimId);
    const settled = this.get('SELECT * FROM trade_listings WHERE id=?', listing.id);
    return {
      ...claimCard(this, this.get('SELECT * FROM trade_claims WHERE id=?', claimId), this.all('SELECT kind,quantity FROM trade_claim_units WHERE claim_id=? ORDER BY kind', claimId)),
      listing: listingCard(this, settled, listingTerms(this, [listing.id]).get(listing.id) || [], { accountId: actor.account.id }),
      inventory: this.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=? AND quantity>0 ORDER BY kind', agent.id).map((item) => ({ ...item })),
    };
  },
  tradeCancel(actor, input) {
    ensureTradeMarket(this);
    this.active();
    if (!actor?.account || !['session', 'runtime'].includes(actor.kind)) fail(401, 'Authentication required.');
    this.tradeExpire();
    const listing = this.get('SELECT * FROM trade_listings WHERE id=?', input.listing_id || '');
    if (!listing) fail(404, 'Listing not found.');
    const posterSide = actor.kind === 'runtime' ? listing.poster_agent_id === actor.agent?.id : listing.poster_account_id === actor.account.id;
    if (!posterSide) fail(403, 'Only the listing\u2019s own operator can withdraw it.');
    if (listing.status === 'cancelled') return { ...listingCard(this, listing, listingTerms(this, [listing.id]).get(listing.id) || [], { accountId: actor.account.id }), repeated: true };
    if (listing.status !== 'open') fail(409, `This listing is ${listing.status} and cannot be withdrawn.`);
    if (!settleListing(this, listing, 'cancelled', actor.account.id, this.clock())) fail(409, 'This listing is no longer open.');
    this.audit(actor.account.id, 'trade.cancelled', listing.id);
    return listingCard(this, this.get('SELECT * FROM trade_listings WHERE id=?', listing.id), listingTerms(this, [listing.id]).get(listing.id) || [], { accountId: actor.account.id });
  },
};

Object.assign(Platform.prototype, marketMethods);

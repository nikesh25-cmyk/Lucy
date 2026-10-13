import { randomUUID } from 'node:crypto';
import content from './content.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const readText = (value, label, maximum, optional = false) => {
  if (optional && (value === '' || value == null)) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(400, `${label} must contain ${optional ? '0' : '1'}–${maximum} characters.`);
  return value.trim();
};
// Growth times, decoration recipes, titles and keepsake avatars all come from the sealed
// content layer. Only the keepsakes a resident starts with are eligible from the outset; the
// gated ones carry an unlock threshold and are added by cosmeticOptions as they are earned.
const crops = Object.freeze(content.crops());
const tendSaving = 5 * 60_000;
const recipes = Object.freeze(content.recipes());
const titles = Object.freeze(content.cosmetics('title'));
const avatars = Object.freeze(content.cosmetics('avatar').filter((id) => content.entry(id, 'cosmetic').rules.unlock_at_shared_visits === undefined));
// Bounded per-resident reads. A resident's own history grows for as long as it exists, so every
// listing a passport renders is capped at the same 200-record bound the rest of the API uses. The
// ordered reads keep the earliest records, and the totals a badge or skill depends on are counted in
// SQL rather than taken from the returned page.
const JOURNEY_LIMIT = 200;

export const JOURNEY_TABLES = Object.freeze(['journey_profiles', 'journey_visits', 'journey_journal', 'journey_inventory', 'journey_crops']);
export const JOURNEY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS journey_profiles(agent_id TEXT PRIMARY KEY REFERENCES agents(id),bio TEXT NOT NULL DEFAULT '',purpose TEXT NOT NULL DEFAULT '',title TEXT NOT NULL DEFAULT 'Resident',avatar TEXT NOT NULL DEFAULT 'sprout',harvests INTEGER NOT NULL DEFAULT 0 CHECK(harvests>=0),crafts INTEGER NOT NULL DEFAULT 0 CHECK(crafts>=0));
  CREATE TABLE IF NOT EXISTS journey_visits(agent_id TEXT NOT NULL REFERENCES agents(id),world_id TEXT NOT NULL REFERENCES worlds(id),visited_at INTEGER NOT NULL,PRIMARY KEY(agent_id,world_id));
  CREATE TABLE IF NOT EXISTS journey_journal(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),text TEXT NOT NULL,created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS journey_journal_agent ON journey_journal(agent_id,created_at);
  CREATE TABLE IF NOT EXISTS journey_inventory(agent_id TEXT NOT NULL REFERENCES agents(id),kind TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>=0),PRIMARY KEY(agent_id,kind));
  CREATE TABLE IF NOT EXISTS journey_crops(agent_id TEXT NOT NULL REFERENCES agents(id),x INTEGER NOT NULL,y INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN (${Object.keys(crops).map((kind) => `'${kind}'`).join(',')})),planted_at INTEGER NOT NULL,tended_at INTEGER,harvested_at INTEGER,PRIMARY KEY(agent_id,x,y));
`;

// ---------------------------------------------------------------------------------------------
// Resident-to-resident resource offers.
//
// The internal-resource economy is grown and crafted items only. An offer is an explicit, consented
// hand-over between two residents of *different operators*: the offerer's side proposes and escrows
// the named items, the named recipient's human operator accepts, and the items move exactly once.
// Nothing here is money, a NemoCoin, land or a tradeable asset, and no route in this module can move
// coins, money or a plot.
//
// The escrow lives in the offer row. Items are debited from the offerer's shelf exactly once when the
// offer is proposed, then either credited to the recipient exactly once (`accepted`) or returned to
// the offerer exactly once (`declined`, `cancelled`, `expired`). Three schema constraints make that
// provable rather than merely coded: `journey_inventory.quantity>=0` refuses a negative shelf, the
// `resource_offers_lifecycle` trigger refuses re-settling a settled offer, and the two unique keys
// `(offerer_account_id, propose_key)` and `(recipient_account_id, accept_key)` reuse the shipped
// `Idempotency-Key` mechanism, so a replayed propose or accept writes nothing twice.
// ---------------------------------------------------------------------------------------------
export const RESOURCE_OFFER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS resource_offers(
   id TEXT PRIMARY KEY,
   offerer_agent_id TEXT NOT NULL REFERENCES agents(id),
   offerer_account_id TEXT NOT NULL REFERENCES accounts(id),
   recipient_agent_id TEXT NOT NULL REFERENCES agents(id),
   recipient_account_id TEXT NOT NULL REFERENCES accounts(id),
   items TEXT NOT NULL CHECK(json_valid(items) AND json_type(items)='object'),
   note TEXT NOT NULL DEFAULT '',
   status TEXT NOT NULL CHECK(status IN ('proposed','accepted','declined','cancelled','expired')),
   propose_key TEXT NOT NULL,
   accept_key TEXT,
   proposed_at INTEGER NOT NULL CHECK(proposed_at>=0),
   expires_at INTEGER NOT NULL CHECK(expires_at>proposed_at),
   settled_at INTEGER,
   settled_by_account_id TEXT REFERENCES accounts(id),
   CHECK(offerer_agent_id!=recipient_agent_id),
   CHECK(offerer_account_id!=recipient_account_id),
   CHECK((status='proposed')=(settled_at IS NULL)),
   CHECK((status='accepted')=(accept_key IS NOT NULL)),
   CHECK((status IN ('accepted','declined','cancelled'))=(settled_by_account_id IS NOT NULL)),
   UNIQUE(offerer_account_id,propose_key),
   UNIQUE(recipient_account_id,accept_key)
  );
  CREATE INDEX IF NOT EXISTS resource_offers_offerer ON resource_offers(offerer_account_id,status,proposed_at);
  CREATE INDEX IF NOT EXISTS resource_offers_recipient ON resource_offers(recipient_account_id,status,proposed_at);
  CREATE INDEX IF NOT EXISTS resource_offers_agent ON resource_offers(offerer_agent_id,recipient_agent_id,status);
  CREATE TABLE IF NOT EXISTS resource_offer_events(
   id TEXT PRIMARY KEY,
   offer_id TEXT NOT NULL REFERENCES resource_offers(id),
   account_id TEXT REFERENCES accounts(id),
   action TEXT NOT NULL CHECK(action IN ('proposed','accepted','declined','cancelled','expired')),
   detail TEXT NOT NULL DEFAULT '',
   created_at INTEGER NOT NULL CHECK(created_at>=0)
  );
  CREATE INDEX IF NOT EXISTS resource_offer_events_offer ON resource_offer_events(offer_id,created_at);
  CREATE TRIGGER IF NOT EXISTS resource_offers_validate_insert BEFORE INSERT ON resource_offers BEGIN
    SELECT RAISE(ABORT,'A resource offer needs a non-empty item list') WHERE NOT json_valid(NEW.items) OR json_type(NEW.items)!='object' OR (SELECT COUNT(*) FROM json_each(NEW.items))=0;
    SELECT RAISE(ABORT,'Resource offer quantities must be positive whole numbers') WHERE EXISTS(SELECT 1 FROM json_each(NEW.items) WHERE json_type(value)!='integer' OR value<=0);
    SELECT RAISE(ABORT,'A resource offer keeps its parties apart') WHERE NEW.offerer_agent_id=NEW.recipient_agent_id OR NEW.offerer_account_id=NEW.recipient_account_id;
    SELECT RAISE(ABORT,'A resource offer must expire after it is proposed') WHERE NEW.expires_at<=NEW.proposed_at;
    SELECT RAISE(ABORT,'A resource offer note is too long') WHERE length(NEW.note)>200;
  END;
  CREATE TRIGGER IF NOT EXISTS resource_offers_lifecycle BEFORE UPDATE ON resource_offers BEGIN
    SELECT RAISE(ABORT,'A resource offer keeps its identity, parties and items') WHERE NEW.id!=OLD.id OR NEW.offerer_agent_id!=OLD.offerer_agent_id OR NEW.recipient_agent_id!=OLD.recipient_agent_id OR NEW.offerer_account_id!=OLD.offerer_account_id OR NEW.recipient_account_id!=OLD.recipient_account_id OR NEW.items!=OLD.items OR NEW.propose_key!=OLD.propose_key OR NEW.proposed_at!=OLD.proposed_at OR NEW.expires_at!=OLD.expires_at;
    SELECT RAISE(ABORT,'A settled resource offer is final') WHERE OLD.status!='proposed' AND NEW.status!=OLD.status;
  END;
  CREATE TRIGGER IF NOT EXISTS resource_offer_events_no_update BEFORE UPDATE ON resource_offer_events BEGIN SELECT RAISE(ABORT,'Resource offer events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS resource_offer_events_no_delete BEFORE DELETE ON resource_offer_events BEGIN SELECT RAISE(ABORT,'Resource offer events are append-only'); END;
`;

// Bounds. An offer is deliberately small: a handful of kinds, a bounded quantity and a bounded life.
export const RESOURCE_OFFER_LIMITS = Object.freeze({
  items_max: 6, quantity_max: 99, note_max: 200,
  expires_minutes_min: 1, expires_minutes_max: 10080, expires_minutes_default: 1440,
  open_per_agent: 20, list_limit: 200,
});
export const RESOURCE_OFFER_STATUSES = Object.freeze(['proposed', 'accepted', 'declined', 'cancelled', 'expired']);
export const RESOURCE_OFFER_POLICY = Object.freeze({
  version: 1,
  concerns: 'virtual grown or crafted items only',
  movable: 'grown crops and the keepsakes crafted from them',
  transferable: false,
  coins_awarded: 0,
  moves_coins: false,
  moves_money: false,
  moves_land: false,
  items_max: RESOURCE_OFFER_LIMITS.items_max,
  quantity_max: RESOURCE_OFFER_LIMITS.quantity_max,
  expires_minutes: [RESOURCE_OFFER_LIMITS.expires_minutes_min, RESOURCE_OFFER_LIMITS.expires_minutes_max],
  consent: 'The offering side chooses the recipient and proposes; only the named recipient\u2019s human operator can accept or decline; the offering side can cancel. Both parties must be residents of different operators.',
  description: 'A resource offer hands over grown or crafted items between two residents. It is not money, a NemoCoin, land or a tradeable asset, and no route in this module can move coins, money or a plot.',
});

function offerKinds() {
  return new Set([...Object.keys(crops), ...recipes.map((recipe) => recipe.output)]);
}
function normalizeOfferItems(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Offer at least one grown or crafted resource.');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > RESOURCE_OFFER_LIMITS.items_max) fail(400, `Offer one to ${RESOURCE_OFFER_LIMITS.items_max} kinds of resource.`);
  const allowed = offerKinds(), items = {};
  for (const [kind, quantity] of entries) {
    if (!allowed.has(kind)) fail(400, 'Offer only resources that are grown or crafted in this world.');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > RESOURCE_OFFER_LIMITS.quantity_max) fail(400, `Offer 1\u2013${RESOURCE_OFFER_LIMITS.quantity_max} of each resource.`);
    items[kind] = quantity;
  }
  return items;
}
const sameItems = (left, right) => {
  const a = left || {}, b = right || {}, keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};
function creditInventory(platform, agentId, items) {
  for (const [kind, quantity] of Object.entries(items)) {
    platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity', agentId, kind, quantity);
  }
}
function debitInventory(platform, agentId, items) {
  for (const [kind, quantity] of Object.entries(items)) {
    // The schema's `quantity>=0` CHECK is the backstop; this guard states the rule the API enforces.
    const changed = platform.run('UPDATE journey_inventory SET quantity=quantity-? WHERE agent_id=? AND kind=? AND quantity>=?', quantity, agentId, kind, quantity);
    if (!changed.changes) fail(409, 'The offered resources are not all on the shelf; offer only what the resident holds.');
  }
}
function offerParty(platform, agentId) {
  const agent = platform.get('SELECT id,name FROM agents WHERE id=?', agentId);
  return { agent_id: agentId, name: agent?.name || 'A former resident' };
}
function offerView(platform, offer, viewerAccountId, viewerAgentId = null) {
  const outgoing = viewerAccountId === offer.offerer_account_id, incoming = viewerAccountId === offer.recipient_account_id;
  const mine = viewerAgentId ? (offer.offerer_agent_id === viewerAgentId || offer.recipient_agent_id === viewerAgentId) : true;
  return {
    id: offer.id, status: offer.status, items: JSON.parse(offer.items), note: offer.note,
    offerer: offerParty(platform, offer.offerer_agent_id), recipient: offerParty(platform, offer.recipient_agent_id),
    direction: outgoing ? 'outgoing' : incoming ? 'incoming' : 'other',
    proposed_at: offer.proposed_at, expires_at: offer.expires_at, settled_at: offer.settled_at,
    can_accept: mine && offer.status === 'proposed' && incoming,
    can_decline: mine && offer.status === 'proposed' && incoming,
    can_cancel: mine && offer.status === 'proposed' && outgoing,
  };
}
// Settle one proposed offer exactly once. The guarded UPDATE is the single point of truth: `changes`
// is 1 only for the first caller, so the matching credit happens exactly once even under a replay or
// a concurrent request. `accepted` credits the recipient; every other outcome returns the escrow to
// the offerer. A `null` account records a system settlement (expiry).
function settleOffer(platform, offer, status, accountId, now, acceptKey = null) {
  const changed = platform.run("UPDATE resource_offers SET status=?,settled_at=?,settled_by_account_id=?,accept_key=? WHERE id=? AND status='proposed'", status, now, accountId, acceptKey, offer.id);
  if (!changed.changes) return false;
  const items = JSON.parse(offer.items);
  creditInventory(platform, status === 'accepted' ? offer.recipient_agent_id : offer.offerer_agent_id, items);
  platform.run('INSERT INTO resource_offer_events VALUES(?,?,?,?,?,?)', randomUUID(), offer.id, accountId, status, '', now);
  return true;
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
function initialize(platform, agentId) {
  platform.run('INSERT OR IGNORE INTO journey_profiles(agent_id) VALUES(?)', agentId);
  platform.run("INSERT OR IGNORE INTO journey_visits(agent_id,world_id,visited_at) VALUES(?,'commons',?)", agentId, platform.clock());
}
function inventory(platform, agentId) {
  return platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=? AND quantity>0 ORDER BY kind', agentId).map((item) => ({ ...item }));
}
function cropSaving(crop) {
  if (crop.tended_at == null) return 0;
  // Tending saves five minutes, capped by the growth still ahead of the crop so a
  // tend is never a no-op and never shortens a crop by more than it had left.
  return Math.min(tendSaving, Math.max(0, crops[crop.kind] - (crop.tended_at - crop.planted_at)));
}
function cropView(crop, time) {
  const readyAt = crop.planted_at + crops[crop.kind] - cropSaving(crop);
  return { ...crop, ready_at: readyAt, ready: crop.harvested_at == null && time >= readyAt };
}
/**
 * The stored crop on one garden tile, as the passport and the direct world interaction both read it.
 * One implementation, so the workshop panel and the fixture hint can never describe the same planting
 * differently.
 */
export function cropAt(platform, agentId, x, y) {
  const crop = platform.get('SELECT x,y,kind,planted_at,tended_at,harvested_at FROM journey_crops WHERE agent_id=? AND x=? AND y=?', agentId, x, y);
  return crop ? cropView(crop, platform.clock()) : null;
}
function cosmeticOptions(platform, agentId, state) {
  const visited = platform.get('SELECT COUNT(*) AS n FROM journey_visits v JOIN worlds w ON w.id=v.world_id WHERE v.agent_id=? AND w.owner_agent_id IS NULL', agentId).n;
  return {
    titles: titles.filter((title) => title === 'Resident' || title === 'Explorer' && visited >= 3 || title === 'Gardener' && state.harvests > 0 || title === 'Maker' && state.crafts > 0),
    avatars: [...avatars, ...(visited >= 3 ? ['explorer_banner'] : []), ...inventory(platform, agentId).filter((item) => recipes.some((recipe) => recipe.output === item.kind)).map((item) => item.kind)],
  };
}
// Eligibility for an independently accepted real contribution. The joins and
// policy conditions are shared by the resident merit summary and the world avatar
// roster so the two can never report different contributions.
export const contributionSource = `submissions s JOIN claims c ON c.id=s.claim_id JOIN tasks t ON t.id=c.task_id
  JOIN missions m ON m.id=t.mission_id JOIN accounts operator ON operator.id=c.account_id
  JOIN accounts mission_owner ON mission_owner.id=m.owner_id JOIN accounts assigned ON assigned.id=m.reviewer_id
  JOIN reviews r ON r.submission_id=s.id JOIN accounts reviewer ON reviewer.id=r.reviewer_id`;
export const contributionEligibility = (agentRef) => `c.agent_id=${agentRef} AND operator.status='active' AND mission_owner.status='active'
  AND m.demo=0 AND m.status IN ('open','closed') AND c.task_version=t.version
  AND assigned.status='active' AND assigned.role IN ('admin','reviewer') AND assigned.id!=c.account_id
  AND reviewer.status='active' AND reviewer.role IN ('admin','reviewer') AND reviewer.id!=c.account_id
  AND (reviewer.id=m.reviewer_id OR reviewer.role='admin') AND r.decision='accepted' AND s.status='accepted'
  AND s.version=(SELECT MAX(version) FROM submissions current WHERE current.claim_id=c.id)
  AND r.rowid=(SELECT latest.rowid FROM reviews latest WHERE latest.submission_id=s.id ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1)`;
function merit(platform, agentId) {
  // Derive credit from current evidence, never from a persistent points counter.
  const eligible = platform.all(`SELECT DISTINCT s.id,m.owner_id,
    EXISTS(SELECT 1 FROM adoptions d JOIN accounts owner ON owner.id=d.owner_id
      WHERE d.submission_id=s.id AND d.owner_id=m.owner_id AND d.owner_id!=c.account_id AND owner.status='active' AND length(trim(d.note))>0) AS adopted
    FROM ${contributionSource} WHERE ${contributionEligibility('?')}`, agentId);
  const accepted = eligible.length, adopted = eligible.reduce((sum, item) => sum + item.adopted, 0);
  return { accepted, adopted, total: accepted + adopted };
}
function goodwill(platform, agentId) {
  if (!platform.get("SELECT name FROM sqlite_master WHERE type='table' AND name='community_thanks'")) return { thanks: 0 };
  // Count independent operators once across their avatars and days. Appreciation
  // remains a social record; repeated thanks never become a points faucet.
  const total = platform.get(`SELECT COUNT(DISTINCT thanks.giver_account_id) AS n FROM community_thanks thanks
    JOIN accounts sender ON sender.id=thanks.giver_account_id JOIN agents giver ON giver.id=thanks.giver_agent_id
    JOIN agents recipient ON recipient.id=thanks.recipient_agent_id
    WHERE thanks.recipient_agent_id=? AND sender.status='active' AND giver.status IN ('active','paused')
    AND giver.operator_id=sender.id AND sender.id!=recipient.operator_id`, agentId).n;
  return { thanks: total };
}

export const journeyMethods = {
  initJourney() {
    this.db.exec(JOURNEY_SCHEMA);
    this.db.exec(RESOURCE_OFFER_SCHEMA);
    this.run("INSERT OR IGNORE INTO journey_profiles(agent_id) SELECT id FROM agents WHERE status!='deleted'");
    this.run("INSERT OR IGNORE INTO journey_visits(agent_id,world_id,visited_at) SELECT id,'commons',? FROM agents WHERE status!='deleted'", this.clock());
  },
  recordVisit(actor, agentId, worldId) {
    const agent = owned(this, actor, { agent_id: agentId }, true);
    if (agent.world_id !== worldId) fail(409, 'Discover a place by visiting it.');
    this.space(actor, worldId);
    initialize(this, agent.id);
    const result = this.run('INSERT OR IGNORE INTO journey_visits(agent_id,world_id,visited_at) VALUES(?,?,?)', agent.id, worldId, this.clock());
    return { discovered: result.changes > 0, world_id: worldId };
  },
  journey(actor, input = {}) {
    const agent = owned(this, actor, input);
    const state = this.get('SELECT * FROM journey_profiles WHERE agent_id=?', agent.id) || { bio: '', purpose: '', title: 'Resident', avatar: 'sprout', harvests: 0, crafts: 0 };
    // One bounded page of the resident's own visit history, oldest first so the arrival at the
    // Commons always survives truncation. The badge, skill and totals below read counts from SQL,
    // never from this page, so the bound cannot change what a resident has earned.
    const discoveries = this.all('SELECT v.world_id,w.name,w.kind,v.visited_at FROM journey_visits v JOIN worlds w ON w.id=v.world_id WHERE v.agent_id=? ORDER BY v.visited_at,v.world_id LIMIT ?', agent.id, JOURNEY_LIMIT);
    const discoveryCount = this.get('SELECT COUNT(*) AS n FROM journey_visits WHERE agent_id=?', agent.id).n;
    if (!discoveries.some((visit) => visit.world_id === 'commons')) discoveries.unshift({ world_id: 'commons', name: 'Commons', kind: 'shared', visited_at: Date.parse(agent.created_at) });
    const sharedVisits = this.get('SELECT COUNT(*) AS n FROM journey_visits v JOIN worlds w ON w.id=v.world_id WHERE v.agent_id=? AND w.owner_agent_id IS NULL', agent.id).n + (discoveries.some((visit) => visit.world_id === 'commons') && !this.get("SELECT world_id FROM journey_visits WHERE agent_id=? AND world_id='commons'", agent.id) ? 1 : 0);
    const earnedMerit = merit(this, agent.id), earnedGoodwill = goodwill(this, agent.id);
    const quests = [
      { id: 'explore', name: 'Visit three shared places', progress: sharedVisits, target: 3 },
      { id: 'grow', name: 'Harvest your first garden crop', progress: state.harvests, target: 1 },
      { id: 'make', name: 'Craft your first decoration', progress: state.crafts, target: 1 },
      { id: 'contribute', name: 'Have a real contribution independently accepted', progress: earnedMerit.accepted, target: 1 },
    ].map((quest) => ({ ...quest, complete: quest.progress >= quest.target }));
    const badges = [sharedVisits >= 3 && { id: 'explorer', name: 'Explorer' }, state.harvests > 0 && { id: 'gardener', name: 'Gardener' }, state.crafts > 0 && { id: 'maker', name: 'Maker' }, earnedMerit.adopted > 0 && { id: 'useful_work', name: 'Work put to use' }].filter(Boolean);
    return {
      agent_id: agent.id, profile: { bio: state.bio, purpose: state.purpose, title: state.title, avatar: state.avatar },
      profile_options: cosmeticOptions(this, agent.id, state), discoveries, discovery_count: discoveryCount, discoveries_truncated: discoveryCount > discoveries.length,
      skills: [{ id: 'exploration', name: 'Exploration', level: Math.min(3, Math.floor(sharedVisits / 2)) }, { id: 'gardening', name: 'Gardening', level: Math.min(3, Math.floor(state.harvests / 3)) }, { id: 'crafting', name: 'Crafting', level: Math.min(3, Math.floor(state.crafts / 3)) }],
      badges, journal: this.all('SELECT id,text,created_at FROM journey_journal WHERE agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200', agent.id),
      inventory: inventory(this, agent.id), crops: this.all('SELECT x,y,kind,planted_at,tended_at,harvested_at FROM journey_crops WHERE agent_id=? ORDER BY y,x', agent.id).map((crop) => cropView(crop, this.clock())),
      recipes: recipes.map((recipe) => ({ ...recipe, ingredients: { ...recipe.ingredients } })), quests,
      callings:this.callings(actor,{agent_id:agent.id}), coins:this.coins(actor,{agent_id:agent.id}), merit: earnedMerit, goodwill: earnedGoodwill, unlocks: sharedVisits >= 3 ? ['explorer_banner'] : [], server_time: this.clock(),
    };
  },
  updateProfile(actor, input) {
    const agent = owned(this, actor, input, true);
    const previous = this.get('SELECT * FROM journey_profiles WHERE agent_id=?', agent.id) || { bio: '', purpose: '', title: 'Resident', avatar: 'sprout', harvests: 0, crafts: 0 };
    const bio = input.bio === undefined ? previous.bio : readText(input.bio, 'Bio', 500, true);
    const purpose = input.purpose === undefined ? previous.purpose : readText(input.purpose, 'Purpose', 200, true);
    const title = input.title ?? previous.title, avatar = input.avatar ?? previous.avatar;
    const options = cosmeticOptions(this, agent.id, previous);
    if (!options.titles.includes(title) || !options.avatars.includes(avatar)) fail(400, 'Choose an earned cosmetic title and owned avatar decoration.');
    initialize(this, agent.id);
    this.run('UPDATE journey_profiles SET bio=?,purpose=?,title=?,avatar=? WHERE agent_id=?', bio, purpose, title, avatar, agent.id);
    this.audit(actor.account.id, 'journey.profile', agent.id);
    return { bio, purpose, title, avatar };
  },
  writeJournal(actor, input) {
    const agent = owned(this, actor, input, true), content = readText(input.text, 'Journal entry', 1500);
    const entry = { id: randomUUID(), text: content, created_at: this.clock() };
    initialize(this, agent.id);
    this.run('INSERT INTO journey_journal VALUES(?,?,?,?)', entry.id, agent.id, entry.text, entry.created_at);
    this.run('DELETE FROM journey_journal WHERE agent_id=? AND id NOT IN (SELECT id FROM journey_journal WHERE agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200)', agent.id, agent.id);
    return entry;
  },
  gardenAction(actor, input) {
    const agent = owned(this, actor, input, true);
    if (agent.world_id !== `home:${agent.id}`) fail(403, 'Tend crops inside your own garden.');
    if (!['plant', 'tend', 'harvest'].includes(input.action)) fail(400, 'Choose plant, tend, or harvest.');
    if (!Number.isInteger(input.x) || !Number.isInteger(input.y)) fail(400, 'Choose a farm tile.');
    if (!this.get("SELECT id FROM world_objects WHERE world_id=? AND x=? AND y=? AND type='farm'", agent.world_id, input.x, input.y)) fail(409, 'Place a farm tile before planting there.');
    const previous = this.get('SELECT * FROM journey_crops WHERE agent_id=? AND x=? AND y=?', agent.id, input.x, input.y);
    const time = this.clock();
    if (input.action === 'plant') {
      if (!Object.hasOwn(crops, input.kind)) fail(400, 'Choose herbs, fiber, or wood.');
      if (previous && previous.harvested_at == null) fail(409, 'This tile already has a growing crop.');
      if (this.get('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=? AND harvested_at IS NULL', agent.id).n >= 20) fail(429, 'A garden holds twenty growing crops.');
      initialize(this, agent.id);
      this.run('INSERT INTO journey_crops VALUES(?,?,?,?,?,NULL,NULL) ON CONFLICT(agent_id,x,y) DO UPDATE SET kind=excluded.kind,planted_at=excluded.planted_at,tended_at=NULL,harvested_at=NULL', agent.id, input.x, input.y, input.kind, time);
    } else {
      if (!previous || previous.harvested_at != null) fail(409, 'There is no growing crop on this tile.');
      if (input.action === 'tend') {
        if (previous.tended_at != null) fail(409, 'This crop has already been tended.');
        this.run('UPDATE journey_crops SET tended_at=? WHERE agent_id=? AND x=? AND y=? AND tended_at IS NULL AND harvested_at IS NULL', time, agent.id, input.x, input.y);
      } else {
        if (!cropView(previous, time).ready) fail(409, 'This crop is still growing.');
        const changed = this.run('UPDATE journey_crops SET harvested_at=? WHERE agent_id=? AND x=? AND y=? AND harvested_at IS NULL', time, agent.id, input.x, input.y);
        if (!changed.changes) fail(409, 'This crop was already harvested.');
        this.run('INSERT INTO journey_inventory VALUES(?,?,2) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+2', agent.id, previous.kind);
        this.run('UPDATE journey_profiles SET harvests=harvests+1 WHERE agent_id=?', agent.id);
      }
    }
    this.audit(actor.account.id, `journey.${input.action}`, agent.id);
    const result = this.get('SELECT x,y,kind,planted_at,tended_at,harvested_at FROM journey_crops WHERE agent_id=? AND x=? AND y=?', agent.id, input.x, input.y);
    return { crop: cropView(result, time), inventory: inventory(this, agent.id) };
  },
  craftItem(actor, input) {
    const agent = owned(this, actor, input, true), recipe = recipes.find((item) => item.id === input.recipe_id);
    if (!recipe) fail(400, 'Choose a known decoration recipe.');
    const current = Object.fromEntries(inventory(this, agent.id).map((item) => [item.kind, item.quantity]));
    for (const [kind, quantity] of Object.entries(recipe.ingredients)) if ((current[kind] || 0) < quantity) fail(409, 'Gather the recipe ingredients first.');
    initialize(this, agent.id);
    // All resources are checked before writing; the API transaction makes this
    // debit, output, and progress update one operation, including rollback.
    for (const [kind, quantity] of Object.entries(recipe.ingredients)) {
      const updated = this.run('UPDATE journey_inventory SET quantity=quantity-? WHERE agent_id=? AND kind=? AND quantity>=?', quantity, agent.id, kind, quantity);
      if (!updated.changes) fail(409, 'The ingredients changed; try again.');
    }
    this.run('INSERT INTO journey_inventory VALUES(?,?,1) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+1', agent.id, recipe.output);
    this.run('UPDATE journey_profiles SET crafts=crafts+1 WHERE agent_id=?', agent.id);
    this.audit(actor.account.id, 'journey.crafted', agent.id);
    return { crafted: recipe.output, inventory: inventory(this, agent.id) };
  },
  // ---- Resident-to-resident resource offers ------------------------------------------------
  // Settle every offer whose stated life has elapsed. Called before each offer action and on the
  // server's own tick, so an expired offer returns its escrow to the offerer even when no client is
  // looking. The settlement is guarded by `status='proposed'`, so repeated calls settle each offer once.
  expireOffers() {
    const due = this.all("SELECT * FROM resource_offers WHERE status='proposed' AND expires_at<=?", this.clock());
    let settled = 0;
    for (const offer of due) if (settleOffer(this, offer, 'expired', null, this.clock())) settled += 1;
    return settled;
  },
  resourceOffers(actor, input = {}) {
    this.expireOffers();
    if (!actor?.account || !['session', 'runtime'].includes(actor.kind)) fail(401, 'Authentication required.');
    const runtime = actor.kind === 'runtime';
    if (!runtime && input.agent_id) this.ownedAgent(actor, input.agent_id);
    const rows = runtime
      ? this.all('SELECT * FROM resource_offers WHERE offerer_agent_id=? OR recipient_agent_id=? ORDER BY proposed_at DESC,id DESC LIMIT ?', actor.agent.id, actor.agent.id, RESOURCE_OFFER_LIMITS.list_limit)
      : this.all('SELECT * FROM resource_offers WHERE offerer_account_id=? OR recipient_account_id=? ORDER BY proposed_at DESC,id DESC LIMIT ?', actor.account.id, actor.account.id, RESOURCE_OFFER_LIMITS.list_limit);
    return { agent_id: runtime ? actor.agent.id : input.agent_id || null, offers: rows.map((offer) => offerView(this, offer, actor.account.id, runtime ? actor.agent.id : null)), policy: RESOURCE_OFFER_POLICY, server_time: this.clock() };
  },
  offerCreate(actor, input, key) {
    this.active();
    const agent = owned(this, actor, input, true);
    const proposeKey = readText(key, 'Idempotency key', 100);
    const items = normalizeOfferItems(input.items);
    // A replayed propose returns the recorded offer before anything else is validated, so a retry
    // never escrows again even if the world changed around it.
    const previous = this.get('SELECT * FROM resource_offers WHERE offerer_account_id=? AND propose_key=?', actor.account.id, proposeKey);
    if (previous) {
      if (previous.offerer_agent_id !== agent.id || previous.recipient_agent_id !== input.recipient_agent_id || !sameItems(JSON.parse(previous.items), items)) fail(409, 'This idempotency key was used for a different offer.');
      return { ...offerView(this, previous, actor.account.id), repeated: true };
    }
    const note = readText(input.note, 'Offer note', RESOURCE_OFFER_LIMITS.note_max, true);
    const recipient = this.get('SELECT id,operator_id,status FROM agents WHERE id=?', input.recipient_agent_id || '');
    if (!recipient || recipient.status === 'deleted') fail(404, 'Choose a resident to offer to.');
    if (recipient.id === agent.id || recipient.operator_id === agent.operator_id) fail(400, 'Offer resources to a resident of a different operator.');
    if (recipient.status !== 'active') fail(409, 'That resident is not active and cannot receive an offer.');
    const minutes = input.expires_minutes === undefined ? RESOURCE_OFFER_LIMITS.expires_minutes_default : Number(input.expires_minutes);
    if (!Number.isInteger(minutes) || minutes < RESOURCE_OFFER_LIMITS.expires_minutes_min || minutes > RESOURCE_OFFER_LIMITS.expires_minutes_max) fail(400, `Choose an expiry from ${RESOURCE_OFFER_LIMITS.expires_minutes_min} to ${RESOURCE_OFFER_LIMITS.expires_minutes_max} minutes.`);
    this.expireOffers();
    const open = this.get("SELECT COUNT(*) AS n FROM resource_offers WHERE status='proposed' AND offerer_agent_id=?", agent.id).n;
    if (open >= RESOURCE_OFFER_LIMITS.open_per_agent) fail(429, `A resident can hold ${RESOURCE_OFFER_LIMITS.open_per_agent} open offers at once.`);
    const now = this.clock();
    // Escrow the items first: they leave the offerer's shelf when the offer exists, so the same items
    // cannot be promised twice and the recipient accepts something the server already holds.
    debitInventory(this, agent.id, items);
    const id = randomUUID();
    this.run('INSERT INTO resource_offers VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, agent.id, actor.account.id, recipient.id, recipient.operator_id, JSON.stringify(items), note, 'proposed', proposeKey, null, now, now + minutes * 60_000, null, null);
    this.run('INSERT INTO resource_offer_events VALUES(?,?,?,?,?,?)', randomUUID(), id, actor.account.id, 'proposed', '', now);
    this.audit(actor.account.id, 'offer.proposed', id);
    return offerView(this, this.get('SELECT * FROM resource_offers WHERE id=?', id), actor.account.id);
  },
  offerAccept(actor, input, key) {
    this.active();
    if (actor?.kind !== 'session') fail(403, 'Only the named recipient\u2019s human operator can accept an offer.');
    const acceptKey = readText(key, 'Idempotency key', 100);
    this.expireOffers();
    const offer = this.get('SELECT * FROM resource_offers WHERE id=?', input.offer_id || '');
    if (!offer) fail(404, 'Offer not found.');
    if (offer.recipient_account_id !== actor.account.id) fail(403, 'Only the named recipient can accept this offer.');
    if (input.agent_id && input.agent_id !== offer.recipient_agent_id) fail(400, 'Accept this offer as the resident it names.');
    if (offer.accept_key && offer.accept_key === acceptKey) return { ...offerView(this, offer, actor.account.id), repeated: true };
    if (offer.status !== 'proposed') fail(409, offer.status === 'accepted' ? 'This offer was already accepted.' : `This offer is ${offer.status} and cannot be accepted.`);
    if (this.get('SELECT id FROM resource_offers WHERE recipient_account_id=? AND accept_key=? AND id!=?', actor.account.id, acceptKey, offer.id)) fail(409, 'This idempotency key was used to accept a different offer.');
    const recipient = this.get('SELECT status FROM agents WHERE id=?', offer.recipient_agent_id);
    if (!recipient || recipient.status !== 'active') fail(403, 'Resume the recipient resident before accepting an offer.');
    if (!settleOffer(this, offer, 'accepted', actor.account.id, this.clock(), acceptKey)) fail(409, 'This offer is no longer open.');
    this.audit(actor.account.id, 'offer.accepted', offer.id);
    return { ...offerView(this, this.get('SELECT * FROM resource_offers WHERE id=?', offer.id), actor.account.id), inventory: inventory(this, offer.recipient_agent_id) };
  },
  offerDecline(actor, input) {
    this.active();
    if (actor?.kind !== 'session') fail(403, 'Only the named recipient\u2019s human operator can decline an offer.');
    this.expireOffers();
    const offer = this.get('SELECT * FROM resource_offers WHERE id=?', input.offer_id || '');
    if (!offer) fail(404, 'Offer not found.');
    if (offer.recipient_account_id !== actor.account.id) fail(403, 'Only the named recipient can decline this offer.');
    if (offer.status === 'declined') return { ...offerView(this, offer, actor.account.id), repeated: true };
    if (offer.status !== 'proposed') fail(409, `This offer is ${offer.status} and cannot be declined.`);
    if (!settleOffer(this, offer, 'declined', actor.account.id, this.clock())) fail(409, 'This offer is no longer open.');
    this.audit(actor.account.id, 'offer.declined', offer.id);
    return offerView(this, this.get('SELECT * FROM resource_offers WHERE id=?', offer.id), actor.account.id);
  },
  offerCancel(actor, input) {
    this.active();
    if (!actor?.account || !['session', 'runtime'].includes(actor.kind)) fail(401, 'Authentication required.');
    this.expireOffers();
    const offer = this.get('SELECT * FROM resource_offers WHERE id=?', input.offer_id || '');
    if (!offer) fail(404, 'Offer not found.');
    const offererSide = actor.kind === 'runtime' ? offer.offerer_agent_id === actor.agent?.id : offer.offerer_account_id === actor.account.id;
    if (!offererSide) fail(403, 'Only the offering side can cancel this offer.');
    if (offer.status === 'cancelled') return { ...offerView(this, offer, actor.account.id), repeated: true };
    if (offer.status !== 'proposed') fail(409, `This offer is ${offer.status} and cannot be cancelled.`);
    if (!settleOffer(this, offer, 'cancelled', actor.account.id, this.clock())) fail(409, 'This offer is no longer open.');
    this.audit(actor.account.id, 'offer.cancelled', offer.id);
    return offerView(this, this.get('SELECT * FROM resource_offers WHERE id=?', offer.id), actor.account.id);
  },
  offerExport(actor) {
    if (actor?.kind !== 'session') fail(403, 'An operator session is required.');
    return this.all('SELECT * FROM resource_offers WHERE offerer_account_id=? OR recipient_account_id=? ORDER BY proposed_at,id', actor.account.id, actor.account.id)
      .map((offer) => ({ ...offer, items: JSON.parse(offer.items) }));
  },
  // Account deletion: settle every open offer first so no escrow is stranded and the other party's
  // shelf is made whole. A cancelled offer's items return to its offerer exactly once, exactly as a
  // cancel would; the deleting operator's own shelf is removed with the rest of its journey records.
  deleteOffers(actor) {
    if (actor?.kind !== 'session') fail(403, 'An operator session is required.');
    const open = this.all("SELECT * FROM resource_offers WHERE status='proposed' AND (offerer_account_id=? OR recipient_account_id=?)", actor.account.id, actor.account.id);
    for (const offer of open) settleOffer(this, offer, 'cancelled', actor.account.id, this.clock());
  },
  journeyExport(actor) {
    if (actor?.kind !== 'session') fail(403, 'Only your operator can export resident records.');
    return { residents: this.all("SELECT id FROM agents WHERE operator_id=? AND status!='deleted' ORDER BY created_at", actor.account.id).map((agent) => this.journey(actor, { agent_id: agent.id })) };
  },
  residentCosmetics(agentIds) {
    if (!Array.isArray(agentIds) || agentIds.length > 200 || agentIds.some((id) => typeof id !== 'string')) fail(400, 'Request at most 200 resident cosmetics.');
    if (!agentIds.length) return {};
    return Object.fromEntries(this.all(`SELECT agent_id,title,avatar FROM journey_profiles WHERE agent_id IN (${agentIds.map(() => '?').join(',')})`, ...agentIds).map(({ agent_id, title, avatar }) => [agent_id, { title, avatar }]));
  },
  deleteJourney(actor) {
    if (actor?.kind !== 'session') fail(403, 'Only your operator can delete resident records.');
    for (const table of JOURNEY_TABLES) this.run(`DELETE FROM ${table} WHERE agent_id IN (SELECT id FROM agents WHERE operator_id=?)`, actor.account.id);
    return { deleted: true };
  },
};

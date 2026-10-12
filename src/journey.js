import { randomUUID } from 'node:crypto';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const readText = (value, label, maximum, optional = false) => {
  if (optional && (value === '' || value == null)) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(400, `${label} must contain ${optional ? '0' : '1'}–${maximum} characters.`);
  return value.trim();
};
const crops = Object.freeze({ herbs: 20 * 60_000, fiber: 25 * 60_000, wood: 30 * 60_000 });
const recipes = Object.freeze([
  { id: 'flower_crown', name: 'Flower crown', ingredients: { herbs: 2, fiber: 1 }, output: 'flower_crown' },
  { id: 'woven_banner', name: 'Woven banner', ingredients: { fiber: 3, wood: 1 }, output: 'woven_banner' },
  { id: 'garden_lantern', name: 'Garden lantern', ingredients: { wood: 2, herbs: 1 }, output: 'garden_lantern' },
]);
const titles = ['Resident', 'Explorer', 'Gardener', 'Maker'];
const avatars = ['sprout', 'star', 'flower', 'leaf'];

export const JOURNEY_TABLES = Object.freeze(['journey_profiles', 'journey_visits', 'journey_journal', 'journey_inventory', 'journey_crops']);
export const JOURNEY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS journey_profiles(agent_id TEXT PRIMARY KEY REFERENCES agents(id),bio TEXT NOT NULL DEFAULT '',purpose TEXT NOT NULL DEFAULT '',title TEXT NOT NULL DEFAULT 'Resident',avatar TEXT NOT NULL DEFAULT 'sprout',harvests INTEGER NOT NULL DEFAULT 0 CHECK(harvests>=0),crafts INTEGER NOT NULL DEFAULT 0 CHECK(crafts>=0));
  CREATE TABLE IF NOT EXISTS journey_visits(agent_id TEXT NOT NULL REFERENCES agents(id),world_id TEXT NOT NULL REFERENCES worlds(id),visited_at INTEGER NOT NULL,PRIMARY KEY(agent_id,world_id));
  CREATE TABLE IF NOT EXISTS journey_journal(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),text TEXT NOT NULL,created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS journey_journal_agent ON journey_journal(agent_id,created_at);
  CREATE TABLE IF NOT EXISTS journey_inventory(agent_id TEXT NOT NULL REFERENCES agents(id),kind TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>=0),PRIMARY KEY(agent_id,kind));
  CREATE TABLE IF NOT EXISTS journey_crops(agent_id TEXT NOT NULL REFERENCES agents(id),x INTEGER NOT NULL,y INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('herbs','fiber','wood')),planted_at INTEGER NOT NULL,tended_at INTEGER,harvested_at INTEGER,PRIMARY KEY(agent_id,x,y));
`;

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
function cropView(crop, time) {
  const readyAt = crop.planted_at + crops[crop.kind] - (crop.tended_at == null ? 0 : Math.min(5 * 60_000, crops[crop.kind] - 20 * 60_000));
  return { ...crop, ready_at: readyAt, ready: crop.harvested_at == null && time >= readyAt };
}
function cosmeticOptions(platform, agentId, state) {
  const visited = platform.get('SELECT COUNT(*) AS n FROM journey_visits v JOIN worlds w ON w.id=v.world_id WHERE v.agent_id=? AND w.owner_agent_id IS NULL', agentId).n;
  return {
    titles: titles.filter((title) => title === 'Resident' || title === 'Explorer' && visited >= 3 || title === 'Gardener' && state.harvests > 0 || title === 'Maker' && state.crafts > 0),
    avatars: [...avatars, ...(visited >= 3 ? ['explorer_banner'] : []), ...inventory(platform, agentId).filter((item) => recipes.some((recipe) => recipe.output === item.kind)).map((item) => item.kind)],
  };
}
function merit(platform, agentId) {
  // Derive credit from current evidence, never from a persistent points counter.
  const eligible = platform.all(`SELECT DISTINCT s.id,m.owner_id,
    EXISTS(SELECT 1 FROM adoptions d JOIN accounts owner ON owner.id=d.owner_id
      WHERE d.submission_id=s.id AND d.owner_id=m.owner_id AND d.owner_id!=c.account_id AND owner.status='active' AND length(trim(d.note))>0) AS adopted
    FROM submissions s JOIN claims c ON c.id=s.claim_id JOIN tasks t ON t.id=c.task_id
    JOIN missions m ON m.id=t.mission_id JOIN accounts operator ON operator.id=c.account_id
    JOIN accounts mission_owner ON mission_owner.id=m.owner_id JOIN accounts assigned ON assigned.id=m.reviewer_id
    JOIN reviews r ON r.submission_id=s.id JOIN accounts reviewer ON reviewer.id=r.reviewer_id
    WHERE c.agent_id=? AND operator.status='active' AND mission_owner.status='active'
    AND m.demo=0 AND m.status IN ('open','closed') AND c.task_version=t.version
    AND assigned.status='active' AND assigned.role IN ('admin','reviewer') AND assigned.id!=c.account_id
    AND reviewer.status='active' AND reviewer.role IN ('admin','reviewer') AND reviewer.id!=c.account_id
    AND (reviewer.id=m.reviewer_id OR reviewer.role='admin') AND r.decision='accepted' AND s.status='accepted'
    AND s.version=(SELECT MAX(version) FROM submissions current WHERE current.claim_id=c.id)
    AND r.rowid=(SELECT latest.rowid FROM reviews latest WHERE latest.submission_id=s.id ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1)`, agentId);
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
    const discoveries = this.all('SELECT v.world_id,w.name,w.kind,v.visited_at FROM journey_visits v JOIN worlds w ON w.id=v.world_id WHERE v.agent_id=? ORDER BY v.visited_at,v.world_id', agent.id);
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
      profile_options: cosmeticOptions(this, agent.id, state), discoveries,
      skills: [{ id: 'exploration', name: 'Exploration', level: Math.min(3, Math.floor(sharedVisits / 2)) }, { id: 'gardening', name: 'Gardening', level: Math.min(3, Math.floor(state.harvests / 3)) }, { id: 'crafting', name: 'Crafting', level: Math.min(3, Math.floor(state.crafts / 3)) }],
      badges, journal: this.all('SELECT id,text,created_at FROM journey_journal WHERE agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200', agent.id),
      inventory: inventory(this, agent.id), crops: this.all('SELECT x,y,kind,planted_at,tended_at,harvested_at FROM journey_crops WHERE agent_id=? ORDER BY y,x', agent.id).map((crop) => cropView(crop, this.clock())),
      recipes: recipes.map((recipe) => ({ ...recipe, ingredients: { ...recipe.ingredients } })), quests,
      coins:this.coins(actor,{agent_id:agent.id}), merit: earnedMerit, goodwill: earnedGoodwill, unlocks: sharedVisits >= 3 ? ['explorer_banner'] : [], server_time: this.clock(),
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

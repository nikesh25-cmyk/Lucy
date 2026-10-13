import { randomUUID, createHash } from 'node:crypto';
import { getWorldDefinition, walkable, sharedWorldIds, COLS, ROWS, frontierGates } from '../world.js';
import { frontierMethods, FRONTIER_LIMITS } from './frontier.js';
import { RESTORATION_PLACEMENT_STEP, RESTORATION_ROLES } from './community.js';
import { contributionSource, contributionEligibility, cropAt } from './journey.js';
import { blockLayers, canStep, isGrounded, settle, surfaceAt } from './elevation.js';
import { sceneryBlocks, solidSceneryAt } from './footprints.js';
import { escapeColumns, nearestClearTile } from './world-walk.js';
import { GARDEN_PALETTE, HOUSE_PALETTE } from './placement-policy.js';
import { INTERACTION_DISTANCE } from './camera-controls.js';
import content from './content.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// The two authored build palettes live in content/palettes.json and are resolved once by
// src/placement-policy.js, which also derives the storage trigger that mirrors these checks.
const palette = GARDEN_PALETTE;
const housePalette = HOUSE_PALETTE;
const participantLimit = 200;
const publicFields = 'w.id,w.name,w.kind,w.owner_agent_id,w.visibility,w.width,w.height,a.name AS owner_name';
const anonymousResidentFields = Object.freeze([
  'id','name','kind','color','symbol','status','verified','x','y','z','grounded',
  'yaw','pitch','world_id','posture','last_seen','emote','emote_until','presence',
  'calling','title','avatar','accepted_contributions',
]);
const anonymousResident = (resident) => Object.fromEntries(
  anonymousResidentFields.filter((field) => resident[field] !== undefined)
    .map((field) => [field, resident[field]])
);
const anonymousMessageFields = Object.freeze(['id','author','text','created_at','world_id','channel']);
const anonymousMessage = (message) => Object.fromEntries(
  anonymousMessageFields.filter((field) => message[field] !== undefined)
    .map((field) => [field, message[field]])
);
const date = () => new Date().toISOString();
const sharedIds = sharedWorldIds;
const quantity = (value, fallback, maximum) => {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > maximum) fail(400, 'Invalid pagination or camera coordinate.');
  return number;
};
// Same clamp semantics as normalizeOrbit in src/voxel-geometry.js, with the wider pitch range agents may look along.
const wrapYaw = (value) => value >= -Math.PI && value <= Math.PI ? value : ((value + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
const clampPitch = (value) => Math.max(-1.4, Math.min(1.4, value));
/**
 * True when a solid placement would cut a resident off from the world's shared arrival, using the same
 * escape search the frontier consults. A resident already stranded by legacy geometry is not
 * re-counted: only a placement that takes away a route that existed before is refused.
 */
function trapsResident(platform, worldId, definition, beforeObjects, afterObjects) {
  const residents = platform.all("SELECT x,y FROM agents WHERE world_id=? AND status!='deleted'", worldId);
  if (!residents.length) return false;
  const before = escapeColumns(definition, [], beforeObjects), after = escapeColumns(definition, [], afterObjects);
  return residents.some((resident) => { const key = `${resident.x},${resident.y}`; return before.has(key) && !after.has(key); });
}
// `/move` and `/climb` call (actor, input); `/agents/:id/look` and `/agents/:id/climb` call (actor, agent_id, input).
const actionInput = (args) => args.length > 1 ? { ...args[1], agent_id: args[1]?.agent_id || args[0] } : args[0] || {};

// ---------------------------------------------------------------------------------------------
// Direct, purposeful world interaction.
//
// Every interaction a resident makes by hand is one of the actions this world already owns: travel
// through a doorway, plant/tend/harvest a crop patch, sit on a bench, craft at a station, or talk to a
// country ambassador. This block adds the *interaction* around them and nothing else: one table that
// says which fixture a tile holds, the same one-tile Manhattan adjacency the server already requires
// for a doorway, a readable hint naming the fixture, the action and the requirement, and a refusal
// that always carries the next usable step. The client sends intent; the server decides, runs the
// existing method and returns what it saved. A refusal never invents a result and never raises a
// distance, a limit or a permission to make an action succeed.
// ---------------------------------------------------------------------------------------------
const INTERACTION_LABEL = Object.freeze({ door: 'Door', crop_patch: 'Crop patch', bench: 'Bench', crafting_station: 'Crafting station', ambassador_desk: 'Country ambassador desk' });
// Each fixture maps to the shipped action that owns it, and to the extra runtime scope that action
// already needs (`/journey/garden` and `/journey/craft` need `build`; a conversation needs `chat`).
const INTERACTION_ACTION = Object.freeze({
  door: { id: 'travel', label: 'Enter', route: 'POST /api/v1/agents/:id/travel', scope: null },
  crop_patch: { id: 'garden', label: 'Tend the crop patch', route: 'POST /api/v1/journey/garden', scope: 'build' },
  bench: { id: 'posture', label: 'Sit on the bench', route: 'POST /api/v1/agents/:id/posture', scope: null },
  crafting_station: { id: 'craft', label: 'Craft a keepsake', route: 'POST /api/v1/journey/craft', scope: 'build' },
  ambassador_desk: { id: 'talk', label: 'Talk to this ambassador', route: 'POST /api/v1/ambassadors/talk', scope: 'chat' },
});
const INTERACTION_REQUIREMENT = Object.freeze({
  door: 'stand on or beside the doorway — Manhattan distance 1, the same adjacency travel already requires',
  crop_patch: 'stand on or beside the crop patch — Manhattan distance 1',
  bench: 'stand on or beside the bench — Manhattan distance 1',
  crafting_station: 'stand on or beside the crafting station — Manhattan distance 1',
  ambassador_desk: 'stand on or beside the ambassador’s stand — Manhattan distance 1',
});
const INTERACTION_NEARBY = 6;           // how far a read looks for the fixtures it can offer
const INTERACTION_OFFERED = 4;          // how many nearby fixtures a read returns
const INTERACTION_REPLAY_LIMIT = 256;   // bounded replay ledger: at most this many live keys per process
const INTERACTION_REPLAY_WINDOW = 5 * 60_000;

/** The scenery types that are a fixture a resident can use directly. Everything else is decoration. */
function interactionScenery(type, x, y) {
  if (type === 'farm') return { kind: 'crop_patch', x, y, name: 'Crop patch' };
  if (type === 'bench') return { kind: 'bench', x, y, name: 'Bench' };
  if (type === 'workbench') return { kind: 'crafting_station', x, y, name: 'Crafting station' };
  return null;
}
/**
 * Every fixture in one world, in the precedence order a single tile resolves: a doorway first, then
 * the authored scenery, then what a resident placed, then the civic stands. One table, read by both
 * the single-tile lookup and the nearby search, so a tile can never describe two different fixtures.
 */
function interactionFixtures(platform, worldId) {
  const definition = getWorldDefinition(worldId), fixtures = [];
  for (const portal of definition.portals || []) fixtures.push({ kind: 'door', x: portal.x, y: portal.y, name: portal.name || 'doorway', target_world_id: portal.targetWorldId || portal.target_world_id });
  for (const object of definition.objects || []) { const fixture = interactionScenery(object.type, object.x, object.y); if (fixture) fixtures.push(fixture); }
  for (const object of platform.all('SELECT type,x,y FROM world_objects WHERE world_id=?', worldId)) { const fixture = interactionScenery(object.type, object.x, object.y); if (fixture) fixtures.push(fixture); }
  for (const npc of platform.all("SELECT id,name,iso3,x,y FROM npc_ambassadors WHERE world_id=? AND status='active'", worldId)) fixtures.push({ kind: 'ambassador_desk', x: npc.x, y: npc.y, name: npc.name, ambassador_id: npc.id, iso3: npc.iso3 });
  for (const npc of platform.all('SELECT id,name,x,y FROM npc_mayors WHERE world_id=?', worldId)) fixtures.push({ kind: 'ambassador_desk', x: npc.x, y: npc.y, name: npc.name, guide_id: npc.id });
  return fixtures;
}
function interactionFixture(platform, worldId, x, y, fixtures = null) {
  return (fixtures || interactionFixtures(platform, worldId)).find((fixture) => fixture.x === x && fixture.y === y) || null;
}
const interactionDistance = (from, to) => Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
/** The resident's own holdings, for the craft hint. Read-only and bounded to the resident's shelf. */
function held(platform, agentId) {
  return Object.fromEntries(platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=? AND quantity>0', agentId).map((item) => [item.kind, item.quantity]));
}
function missingIngredients(platform, agentId, recipe) {
  const current = held(platform, agentId);
  return Object.entries(recipe.ingredients).filter(([kind, quantity]) => (current[kind] || 0) < quantity).map(([kind, quantity]) => `${quantity - (current[kind] || 0)} more ${kind}`);
}
/** Which actions the fixture offers this resident, as the client may choose from. */
function interactionOptions(platform, fixture, viewer) {
  if (!viewer) return [];
  if (fixture.kind === 'crop_patch') {
    const crop = cropAt(platform, viewer.id, fixture.x, fixture.y), growing = crop && crop.harvested_at == null;
    if (!growing) return Object.entries(content.crops()).map(([kind, growth]) => ({ action: 'plant', kind, label: `Plant ${kind} (${Math.round(growth / 60_000)} minutes)` }));
    const options = [];
    if (crop.tended_at == null) options.push({ action: 'tend', label: 'Tend the crop (saves up to 5 minutes)' });
    options.push({ action: 'harvest', label: crop.ready ? 'Harvest 2 resources' : 'Harvest when the crop is ready', available: Boolean(crop.ready) });
    return options;
  }
  if (fixture.kind === 'crafting_station') return content.recipes().map((recipe) => ({ recipe_id: recipe.id, label: `${recipe.name} — ${Object.entries(recipe.ingredients).map(([kind, quantity]) => `${quantity} ${kind}`).join(' + ')}`, ingredients: { ...recipe.ingredients }, available: missingIngredients(platform, viewer.id, recipe).length === 0 }));
  return [];
}
/** The verb the hint names: what this fixture offers the resident right now. */
function interactionActionLabel(fixture, options) {
  // A doorway whose name is already an instruction keeps it ("Return to the Commons"), one that
  // names a place is entered ("Enter Meeting Hall").
  if (fixture.kind === 'door') return /^(enter|return|leave|walk|go|take)\b/i.test(fixture.name) ? fixture.name : `Enter ${fixture.name}`;
  if (fixture.kind === 'ambassador_desk') return `Talk to ${fixture.name}`;
  if (fixture.kind === 'crop_patch') {
    if (!options.length || options.some((option) => option.action === 'plant')) return 'Plant a crop';
    if (options.some((option) => option.action === 'harvest' && option.available)) return 'Harvest 2 resources';
    if (options.some((option) => option.action === 'tend')) return 'Tend the crop';
    return 'Harvest when the crop is ready';
  }
  return INTERACTION_ACTION[fixture.kind].label;
}
const tiles = (count) => `${count} tile${count === 1 ? '' : 's'}`;
/**
 * What a resident should know about a crop patch before it tries: whose garden it is. The refusal
 * names the owner too, but a hint that says so first is the honest way to offer the fixture.
 */
function cropOwnershipNote(platform, world, viewer) {
  if (!viewer || world.kind !== 'home') return null;
  if (world.owner_agent_id === viewer.id) return null;
  const owner = world.owner_agent_id ? platform.get('SELECT name FROM agents WHERE id=?', world.owner_agent_id) : null;
  return owner
    ? `This crop patch is in ${owner.name}’s garden, and only that garden’s operator can plant, tend or harvest it.`
    : 'This crop patch belongs to a garden another operator farms.';
}
/**
 * The readable hint and the next usable step. The hint always names the fixture, the available
 * interaction and the distance requirement; the next step is what the resident can actually do next,
 * including how to approach, who owns a place, which state a paused or revoked resident is in, and
 * what is still missing before an action can succeed.
 */
function interactionGuidance(platform, world, fixture, viewer) {
  const label = INTERACTION_LABEL[fixture.kind];
  const requirement = INTERACTION_REQUIREMENT[fixture.kind], options = interactionOptions(platform, fixture, viewer);
  const paused = platform.get("SELECT value FROM settings WHERE key='paused'").value === 'true';
  const present = Boolean(viewer && viewer.world_id === world.id), distance = viewer ? interactionDistance(viewer, fixture) : null;
  const inRange = present && distance <= INTERACTION_DISTANCE;
  let blocked = null;
  if (!viewer) blocked = 'inspect_only';
  else if (!present) blocked = 'another_world';
  else if (viewer.status !== 'active') blocked = viewer.status === 'revoked' ? 'revoked' : 'paused';
  else if (paused) blocked = 'platform_paused';
  else if (!inRange) blocked = 'out_of_range';
  const actionLabel = interactionActionLabel(fixture, options);
  const away = inRange ? `you are ${tiles(distance)} away, so you can use it now` : distance === null ? 'inspection only: no resident is acting here' : `you are ${tiles(distance)} away`;
  // A crop patch in someone else's garden is readable and named before it is tried.
  const note = fixture.kind === 'crop_patch' ? cropOwnershipNote(platform, world, viewer) : null;
  const hint = `${label} at ${fixture.x}, ${fixture.y} · ${actionLabel} · ${requirement} · ${away}.${note ? ` ${note}` : ''}`;
  const resident = viewer?.name || 'this resident';
  const next = {
    inspect_only: 'Inspection only: a visitor may examine this fixture, never act for another resident. Sign in, choose your own resident and bring it here to use it.',
    another_world: `${resident} is in ${getWorldDefinition(viewer?.world_id).name}, not here. Travel there, or bring ${resident} into ${world.name}, and use the fixture again.`,
    paused: `${resident} is paused. Resume the resident in My characters, then use this ${label.toLowerCase()} again.`,
    revoked: `${resident}’s access is revoked. An operator must resume the resident before it can use anything in the world.`,
    platform_paused: 'The world is paused by an administrator. Interactions resume when it is unpaused.',
    out_of_range: `Step onto or beside ${fixture.x}, ${fixture.y} — within ${tiles(INTERACTION_DISTANCE)} — and use it again.`,
    available: 'Available now. Use the interaction control, or press Enter, Space or I on the aimed tile.',
  };
  return { actionLabel, options, distance, inRange, present, blocked, hint, next_step: next[blocked || 'available'] };
}
/**
 * The refusal a direct interaction returns, always with the next usable step. A refusal raised here
 * keeps the status the world's own rule produced: nothing is softened to make an action succeed.
 */
function interactionRefusal(platform, error, fixture, agent, world) {
  // A refusal this route already explained keeps its own next step.
  if (typeof error.next_step === 'string' && error.next_step) return error;
  const label = INTERACTION_LABEL[fixture.kind], requirement = INTERACTION_REQUIREMENT[fixture.kind];
  const owners = world.owner_agent_id ? platform.get('SELECT name FROM agents WHERE id=?', world.owner_agent_id) : null;
  const steps = {
    'Walk to a doorway before entering.': `Step onto or beside the doorway at ${fixture.x}, ${fixture.y} — within ${tiles(INTERACTION_DISTANCE)} — and use it again. Travel is admitted only through an adjacent doorway.`,
    'Tend crops inside your own garden.': owners
      ? `This crop patch stands in ${owners.name}’s garden (${world.id}). Only that garden’s operator can plant, tend or harvest it; take ${agent.name} home to its own crop patches.`
      : `This crop patch is in ${world.name}, which no resident farms. Take ${agent.name} home and use a crop patch in its own garden.`,
    'Place a farm tile before planting there.': 'Place a Crop patch on this tile from the garden build palette, then plant again.',
    'This tile already has a growing crop.': 'Tend or harvest the crop already planted on this tile, or choose another patch.',
    'This crop is still growing.': 'Wait until the crop is ready, or tend it once to shorten the wait, then harvest.',
    'This crop has already been tended.': 'A planting is tended once. Harvest it when it is ready, then plant again.',
    'There is no growing crop on this tile.': 'Plant herbs, fiber or wood on this tile first.',
    'This crop was already harvested.': 'This planting is complete. Plant a new crop on this tile.',
    'A garden holds twenty growing crops.': 'Harvest a growing crop before planting another; one garden holds twenty.',
    'Choose a known decoration recipe.': 'Choose one of the recipes the crafting station lists.',
    'Gather the recipe ingredients first.': 'Gather the listed ingredients — they are grown from crop patches in the resident’s own garden — then craft again.',
    'Please allow the ambassador to finish.': 'Wait a moment before the next question; a conversation turn is stored once.',
    'Active country ambassador not found.': 'This ambassador is paused or unavailable. Its desk stays readable; a moderator must resume it before it can answer.',
  };
  error.next_step = steps[error.message] || `${error.message} The requirement is unchanged: ${requirement}.`;
  error.hint = `${label} at ${fixture.x}, ${fixture.y} · ${error.message} · ${error.next_step}`;
  return error;
}
/** The extra runtime scope the mapped action already needs. A session operator needs no scope. */
function interactionScope(actor, scope) {
  if (!scope || actor.kind !== 'runtime') return;
  let granted = [];
  try { granted = JSON.parse(actor.credential.scopes); } catch { granted = []; }
  if (!granted.includes(scope)) fail(403, `This session does not permit that action (${scope} scope is required).`);
}
/**
 * The bounded replay ledger this route honours the shipped `Idempotency-Key` header with: the same
 * key returns the recorded outcome and writes nothing, and the same key for a different intent is
 * refused. It lives with the running process — claims, submissions, drafts, follow-ups and
 * enrolments keep their own SQLite-backed keys — and it is trimmed to a fixed size and window.
 */
/** The one descriptor a client renders for a fixture: the action, the requirement and the next step. */
function interactionDescription(platform, world, fixture, viewer) {
  const guidance = interactionGuidance(platform, world, fixture, viewer), action = INTERACTION_ACTION[fixture.kind];
  return {
    kind: fixture.kind, label: INTERACTION_LABEL[fixture.kind], name: fixture.name, x: fixture.x, y: fixture.y,
    ...(fixture.target_world_id ? { target_world_id: fixture.target_world_id } : {}),
    distance: guidance.distance, in_range: guidance.inRange, can_act: guidance.blocked === null, blocked_by: guidance.blocked,
    action: { id: action.id, label: guidance.actionLabel, route: action.route, scope: action.scope, options: guidance.options },
    requirement: INTERACTION_REQUIREMENT[fixture.kind],
    hint: guidance.hint, next_step: guidance.next_step,
  };
}
/** The tile a read asked about, or null when it asked about none. Both coordinates or neither. */
function readingTile(input = {}) {
  const coordinate = (value) => value === undefined || value === null || value === '' ? null : Number(value);
  const x = coordinate(input.x), y = coordinate(input.y);
  if ((x === null) !== (y === null)) fail(400, 'Give both tile coordinates, or neither.');
  if (x === null) return null;
  if (!Number.isInteger(x) || !Number.isInteger(y)) fail(400, 'Choose whole tile coordinates.');
  return { x, y };
}
function replayLedger(platform) {
  const ledger = platform.interactionReplay instanceof Map ? platform.interactionReplay : new Map();
  platform.interactionReplay = ledger;
  const now = platform.clock();
  for (const [id, entry] of ledger) if (now - entry.at > INTERACTION_REPLAY_WINDOW) ledger.delete(id);
  while (ledger.size > INTERACTION_REPLAY_LIMIT) ledger.delete(ledger.keys().next().value);
  return ledger;
}

export const spaceMethods = {
  ...frontierMethods,
  canReadMission(actor, missionId) {
    if (!actor || !missionId) return false;
    const mission = this.get('SELECT owner_id,reviewer_id,demo FROM missions WHERE id=?', missionId);
    if (!mission) return false;
    if (actor.kind === 'runtime') return Boolean(this.get('SELECT c.id FROM claims c JOIN tasks t ON t.id=c.task_id WHERE t.mission_id=? AND c.agent_id=? LIMIT 1', missionId, actor.agent.id));
    if (actor.account.role === 'admin' || [mission.owner_id, mission.reviewer_id].includes(actor.account.id)) return true;
    if (mission.demo && actor.account.role === 'reviewer') return true;
    return Boolean(this.get('SELECT c.id FROM claims c JOIN tasks t ON t.id=c.task_id WHERE t.mission_id=? AND c.account_id=? LIMIT 1', missionId, actor.account.id));
  },
  canReadMessage(actor, message) {
    if (message.status !== 'visible') return false;
    if (message.channel === 'public') {
      try { this.space(actor, message.world_id); return true; }
      catch (error) { if ([403, 404].includes(error.status)) return false; throw error; }
    }
    if (!actor) return false;
    if (message.channel === 'mission') return this.canReadMission(actor, message.mission_id);
    const recipients = JSON.parse(message.recipients);
    if (actor.kind === 'runtime') return recipients.includes(actor.agent.id);
    return this.all('SELECT id FROM agents WHERE operator_id=?', actor.account.id).some((a) => recipients.includes(a.id));
  },
  seedSpaces() {
    this.transaction(() => {
      for (const id of sharedIds) {
        const definition = getWorldDefinition(id);
        this.run('INSERT OR IGNORE INTO worlds VALUES(?,?,?,NULL,?,?,?,?)', id, definition.name, definition.kind, 'public', definition.columns, definition.rows, date());
      }
      this.seedFrontier();
      for (const agent of this.all("SELECT id,name FROM agents WHERE status!='deleted' AND NOT EXISTS(SELECT 1 FROM worlds WHERE id='house:'||agents.id)")) this.createHome(agent.id, agent.name);
    });
  },
  createHome(agentId, name) {
    const id = `home:${agentId}`;
    const definition = getWorldDefinition(id);
    this.run('INSERT OR IGNORE INTO worlds VALUES(?,?,?,?,?,?,?,?)', id, `${name}’s garden`, 'home', agentId, 'public', definition.columns, definition.rows, date());
    const visibility = this.get('SELECT visibility FROM worlds WHERE id=?', id).visibility;
    this.run('INSERT OR IGNORE INTO worlds VALUES(?,?,?,?,?,?,?,?)', `house:${agentId}`, `${name}’s cottage`, 'house', agentId, visibility, 20, 14, date());
    return id;
  },
  space(actor, id) {
    const world = this.get(`SELECT ${publicFields} FROM worlds w LEFT JOIN agents a ON a.id=w.owner_agent_id WHERE w.id=?`, id);
    if (!world || (world.owner_agent_id && this.get("SELECT status FROM agents WHERE id=?", world.owner_agent_id)?.status === 'deleted')) fail(404, 'World not found.');
    const owner = world.owner_agent_id ? this.get('SELECT operator_id FROM agents WHERE id=?', world.owner_agent_id)?.operator_id : null;
    if (world.visibility === 'private' && (!actor || (actor.kind === 'runtime' ? actor.agent.id !== world.owner_agent_id : actor.account.id !== owner))) fail(403, 'This garden is private.');
    return { ...world, columns: world.width, rows: world.height };
  },
  worldList(actor, input = {}) {
    const offset = quantity(input.offset, 0, 1_000_000), limit = quantity(input.limit, 20, 50);
    if (!limit) fail(400, 'Page size must be positive.');
    const query = typeof input.q === 'string' ? input.q.trim().slice(0, 80) : '';
    const owner = actor?.kind === 'session' ? actor.account.id : '';
    const agentId = actor?.agent?.id || '';
    const condition = "w.kind='home' AND a.status!='deleted' AND o.status='active' AND (w.visibility='public' OR a.operator_id=? OR a.id=?) AND (instr(lower(w.name),lower(?))>0 OR instr(lower(a.name),lower(?))>0)";
    const total = this.get(`SELECT COUNT(*) AS n FROM worlds w JOIN agents a ON a.id=w.owner_agent_id JOIN accounts o ON o.id=a.operator_id WHERE ${condition}`, owner, agentId, query, query).n;
    const shared = this.all(`SELECT ${publicFields},((SELECT COUNT(*) FROM agents WHERE world_id=w.id AND status!='deleted')+(SELECT COUNT(*) FROM npc_mayors WHERE world_id=w.id)+(SELECT COUNT(*) FROM npc_ambassadors WHERE world_id=w.id)) AS agent_count FROM worlds w LEFT JOIN agents a ON a.id=w.owner_agent_id WHERE w.owner_agent_id IS NULL AND w.kind NOT IN ('frontier','country') ORDER BY w.id`);
    const homes = this.all(`SELECT ${publicFields},((SELECT COUNT(*) FROM agents WHERE world_id=w.id AND status!='deleted')+(SELECT COUNT(*) FROM npc_mayors WHERE world_id=w.id)+(SELECT COUNT(*) FROM npc_ambassadors WHERE world_id=w.id)) AS agent_count FROM worlds w JOIN agents a ON a.id=w.owner_agent_id JOIN accounts o ON o.id=a.operator_id WHERE ${condition} ORDER BY w.name,w.id LIMIT ? OFFSET ?`, owner, agentId, query, query, limit, offset);
    return { worlds: [...shared, ...homes], total, offset, limit, has_more: offset + limit < total, shared_count: shared.length };
  },
  world(actor, input = {}) {
    const viewerAgent = actor?.kind === 'runtime' ? this.get('SELECT * FROM agents WHERE id=?', actor.agent.id) : input.agent_id && actor ? this.ownedAgent(actor, input.agent_id) : null;
    const id = input.world_id || viewerAgent?.world_id || 'commons';
    const world = this.space(actor, id), definition = getWorldDefinition(world);
    const center = viewerAgent?.world_id === id ? viewerAgent : definition.start;
    const camera = { x: Math.min(Math.max(0, world.width - COLS), quantity(input.x, Math.max(0, center.x - Math.floor(COLS / 2)), world.width)), y: Math.min(Math.max(0, world.height - ROWS), quantity(input.y, Math.max(0, center.y - Math.floor(ROWS / 2)), world.height)) };
    const participants = this.all(`SELECT a.id,a.name,a.kind,a.operator_id,o.name AS operator,a.color,a.symbol,a.capabilities,a.limitations,a.status,a.verified,a.x,a.y,a.z,a.grounded,a.yaw,a.pitch,a.world_id,a.posture,a.last_seen,a.emote,a.emote_until,
      EXISTS(SELECT 1 FROM tokens t WHERE t.agent_id=a.id AND t.kind='runtime' AND t.revoked=0 AND t.expires_at>? AND t.used_calls<t.max_calls) AS has_session,
      (SELECT COUNT(DISTINCT s.id) FROM ${contributionSource} WHERE ${contributionEligibility('a.id')}) AS accepted_contributions,
      COUNT(*) OVER () AS in_viewport
      FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.world_id=? AND a.x>=? AND a.x<? AND a.y>=? AND a.y<? AND a.status!='deleted' AND o.status='active'
      ORDER BY CASE WHEN a.id=? THEN 0 ELSE 1 END,a.last_seen DESC,a.id LIMIT ${participantLimit}`, this.clock(), id, camera.x, camera.x + COLS, camera.y, camera.y + ROWS, viewerAgent?.id || '');
    const inViewportAgents = participants[0]?.in_viewport ?? 0;
    for (const participant of participants) delete participant.in_viewport;
    const agentCount = participants.length;
    // Ambient civic residents: the historic regional guides patrol, the country ambassadors hold a
    // fixed stand in their own venue. Both are counted inside the same 200-participant bound.
    const npcs=[...this.mayors(actor,{world_id:id}).mayors.filter(mayor=>mayor.x>=camera.x&&mayor.x<camera.x+COLS&&mayor.y>=camera.y&&mayor.y<camera.y+ROWS),
      ...this.ambassadorResidents(id).filter(ambassador=>ambassador.x>=camera.x&&ambassador.x<camera.x+COLS&&ambassador.y>=camera.y&&ambassador.y<camera.y+ROWS)];
    const npcSlots = Math.max(0, participantLimit - agentCount);
    participants.push(...npcs.slice(0, npcSlots));
    const hiddenAgents = (inViewportAgents - agentCount) + Math.max(0, npcs.length - npcSlots);
    const callingProfiles = this.publicCallings?.(participants.map((participant) => participant.id));
    const cosmetics = this.residentCosmetics?.(participants.map((participant) => participant.id));
    for (const participant of participants) {
      const cosmetic = cosmetics?.get ? cosmetics.get(participant.id) : cosmetics?.[participant.id];
      if (callingProfiles?.[participant.id]) participant.calling = callingProfiles[participant.id];
      if (cosmetic) Object.assign(participant, { title: cosmetic.title, avatar: cosmetic.avatar });
      if(participant.kind==='npc'){participant.presence=participant.status==='active'?'resident':participant.status;continue;}
      participant.presence = participant.status !== 'active' ? participant.status : participant.has_session && this.clock() - participant.last_seen < 30000 ? 'connected' : this.clock() - participant.last_seen < 30000 ? 'recent_visit' : 'offline';
      delete participant.has_session;
    }
    // Anonymous observation is a public resident view. Keep authenticated owner and
    // runtime views unchanged, while excluding operator identity and private profile
    // fields from the public endpoint. NPCs carry authored civic copy required by the
    // public ambassador/guide display and are already non-account records.
    const viewerIds = actor ? actor.kind === 'runtime' ? [actor.agent.id] : this.all('SELECT id FROM agents WHERE operator_id=?', actor.account.id).map((a) => a.id) : [];
    const visibleParticipants = participants.map((participant) => (
      participant.kind === 'npc' || viewerIds.includes(participant.id)
        ? participant
        : anonymousResident(participant)
    ));
    const missionAccess = new Map();
    const readable = (message) => {
      if (message.channel === 'mission') {
        if (!missionAccess.has(message.mission_id)) missionAccess.set(message.mission_id, this.canReadMission(actor, message.mission_id));
        return missionAccess.get(message.mission_id);
      }
      return message.channel === 'public' && message.world_id === id || JSON.parse(message.recipients).some((recipient) => viewerIds.includes(recipient));
    };
    const messages = this.all("SELECT m.id,m.agent_id,m.account_id,m.channel,m.mission_id,m.recipients,m.text,m.created_at,m.world_id,COALESCE(a.name,o.name) AS author FROM messages m LEFT JOIN agents a ON a.id=m.agent_id JOIN accounts o ON o.id=m.account_id WHERE m.status='visible' AND (m.world_id=? OR m.channel IN ('private','mission')) ORDER BY m.created_at DESC LIMIT 200", id)
      .filter(readable)
      .reverse().map(({ recipients, ...message }) => message);
    const visibleMessages = actor ? messages : messages.map(anonymousMessage);
    const objects = this.all('SELECT id,type,x,y FROM world_objects WHERE world_id=? ORDER BY y,x', id).map((object) => ({ ...object, kind: object.type }));
    // Authored scenery inside the returned window, resolved through the shared footprint table, so a
    // client or agent reads the same occupancy the server enforces instead of re-deriving it.
    const scenery = (definition.objects || []).filter((item) => item.x >= camera.x && item.x < camera.x + COLS && item.y >= camera.y && item.y < camera.y + ROWS)
      .map((item) => ({ x: item.x, y: item.y, type: item.type || item.kind, blocks: sceneryBlocks(item.type || item.kind) }));
    const portals = (definition.portals || []).filter((portal) => this.get('SELECT id FROM worlds WHERE id=?', portal.targetWorldId || portal.target_world_id)).map((portal) => ({ ...portal, target_world_id: portal.targetWorldId || portal.target_world_id, label: portal.name || portal.label }));
    const blockCenter = viewerAgent?.world_id === id ? viewerAgent : { x: camera.x + Math.floor(COLS / 2), y: camera.y + Math.floor(ROWS / 2) };
    const blockWindow = input.view === 'voxel' ? { x: Math.max(0, Math.min(world.width - 37, blockCenter.x - 18)), y: Math.max(0, Math.min(world.height - 37, blockCenter.y - 18)), columns: Math.min(37, world.width), rows: Math.min(37, world.height) } : camera;
    const frontierView = this.frontierView(id, blockWindow, actor);
    const ownHome = viewerAgent ? this.get("SELECT id,name,visibility FROM worlds WHERE owner_agent_id=? AND kind='home'", viewerAgent.id) : null;
    return { world: { ...world, description: definition.description || '', lore: definition.lore || '', ambiance: definition.ambiance || '' }, participants: visibleParticipants, agents: visibleParticipants.map(({calling,...legacy})=>legacy), messages: visibleMessages, camera, objects, scenery, portals, own_home: ownHome, build_palette: world.kind === 'house' ? housePalette : palette,
      ...frontierView, terrain: definition.terrain.slice(camera.y, camera.y + ROWS).map((row) => row.slice(camera.x, camera.x + COLS)), landmarks: definition.landmarks || [],
      bounds: { columns: world.width, rows: world.height, width: world.width, height: world.height }, viewer_agent_id: viewerAgent?.id || null,
      counts: { registered_agents: this.get("SELECT COUNT(*) AS n FROM agents WHERE status!='deleted' AND kind='agent'").n, registered_humans: this.get("SELECT COUNT(*) AS n FROM agents WHERE status!='deleted' AND kind='human'").n, world_agents: this.get("SELECT COUNT(*) AS n FROM agents WHERE world_id=? AND status!='deleted'", id).n+this.get('SELECT COUNT(*) AS n FROM npc_mayors WHERE world_id=?',id).n+this.get('SELECT COUNT(*) AS n FROM npc_ambassadors WHERE world_id=?',id).n, visible_agents: participants.length, hidden_agents: hiddenAgents },
      paused: this.get("SELECT value FROM settings WHERE key='paused'").value === 'true' };
  },
  /**
   * One cardinal step against server-authoritative column layers.
   * Ordinary movement keeps authored step-up OFF, so any solid block in the target
   * column stays a wall; only climbAgent opts into a one-layer step-up.
   */
  stepAgent(actor, input, allowAuthoredStepUp) {
    this.active(); const agent = this.ownedAgent(actor, input.agent_id || actor.agent?.id);
    if (agent.status !== 'active') fail(403, 'The agent is paused.');
    if (!['up', 'down', 'left', 'right'].includes(input.direction)) fail(400, 'Invalid movement direction.');
    if (this.clock() - agent.last_move < 120) fail(429, 'Move more slowly.');
    const crossing = frontierGates(agent.world_id).find((gate) => gate.direction === input.direction && gate.x === agent.x && gate.y === agent.y && this.get('SELECT world_id FROM frontier_sectors WHERE world_id=?', gate.targetWorldId));
    if (crossing) return this.travel(actor, agent.id, { world_id: crossing.targetWorldId });
    const definition = getWorldDefinition(this.space(actor, agent.world_id));
    const layers = blockLayers(this.all("SELECT x,y,z FROM frontier_blocks WHERE world_id=? AND type!='path' AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?", agent.world_id, agent.x - 1, agent.x + 1, agent.y - 1, agent.y + 1));
    const objects = this.all('SELECT type,x,y FROM world_objects WHERE world_id=? AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?', agent.world_id, agent.x - 1, agent.x + 1, agent.y - 1, agent.y + 1);
    const stepped = canStep(agent, input.direction, { walkable, definition, layers, objects }, { allowAuthoredStepUp });
    const position = settle(stepped.blocked ? agent : stepped.position, layers);
    const grounded = isGrounded(position, layers);
    this.run("UPDATE agents SET x=?,y=?,z=?,grounded=?,posture='standing',last_move=?,last_seen=?,verified=CASE WHEN ?=1 THEN 1 ELSE verified END WHERE id=?", position.x, position.y, position.z, grounded ? 1 : 0, this.clock(), this.clock(), actor.kind === 'runtime' ? 1 : 0, agent.id);
    this.events?.publish(agent.world_id, { agents: [{ id: agent.id, x: position.x, y: position.y, z: position.z, grounded: grounded ? 1 : 0, posture: 'standing', status: agent.status }] });
    return { ...position, grounded, blocked: stepped.blocked, world_id: agent.world_id, posture: 'standing' };
  },
  moveAgent(actor, ...args) { return this.stepAgent(actor, actionInput(args), false); },
  climbAgent(actor, ...args) { return this.stepAgent(actor, actionInput(args), true); },
  lookAgent(actor, ...args) {
    const input = actionInput(args);
    this.active(); const agent = this.ownedAgent(actor, input.agent_id || actor.agent?.id);
    if (agent.status !== 'active') fail(403, 'The agent is paused.');
    const yaw = Number(input.yaw), pitch = Number(input.pitch);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) fail(400, 'Look requires finite yaw and pitch values.');
    // A look throttles on its own column, so it can never bypass the movement throttle.
    if (this.clock() - agent.last_look < 120) fail(429, 'Look more slowly.');
    const facing = { yaw: wrapYaw(yaw), pitch: clampPitch(pitch) };
    this.run('UPDATE agents SET yaw=?,pitch=?,last_look=?,last_seen=? WHERE id=?', facing.yaw, facing.pitch, this.clock(), this.clock(), agent.id);
    return facing;
  },
  travel(actor, agentId, input) {
    this.active(); const agent = this.ownedAgent(actor, agentId);
    if (agent.status !== 'active') fail(403, 'The agent is paused.');
    const target = this.space(actor, input.world_id || '');
    const current = getWorldDefinition(this.space(actor, agent.world_id));
    const portal = (current.portals || []).find((p) => (p.targetWorldId || p.target_world_id) === target.id && Math.abs(p.x - agent.x) + Math.abs(p.y - agent.y) <= 1);
    // A country venue is entered from the Commons, the shared directory. Its own exit portal returns
    // the character, so movement stays server-authoritative without inventing frontier land.
    const directoryEntry = target.kind === 'country' && agent.world_id === 'commons';
    if (target.kind !== 'home' && !(agent.world_id.startsWith('home:') && target.id === 'commons') && !portal && !directoryEntry) fail(409, 'Walk to a doorway before entering.');
    if (this.clock() - agent.last_move < 120) fail(429, 'Travel more slowly.');
    const definition = getWorldDefinition(target), position = definition.start;
    // Return to the corresponding outdoor entrance when leaving an interior.
    const exit = target.id === 'commons' ? (definition.portals || []).find((p) => (p.targetWorldId || p.target_world_id) === agent.world_id) : null;
    const matchingGate = target.kind === 'frontier' ? frontierGates(target.id).find((gate) => gate.targetWorldId === agent.world_id) : null;
    const doorway = matchingGate ? { x: matchingGate.x, y: matchingGate.y } : exit ? { x: exit.x, y: exit.y } : position;
    // Arrival and portal tiles stay clear. A legacy placement left on a doorway must never spawn a
    // resident inside scenery, so the doorway falls back to the nearest clear tile beside it.
    const arrivalObjects = this.all('SELECT type,x,y FROM world_objects WHERE world_id=?', target.id);
    const arrival = walkable(doorway, definition) && !solidSceneryAt(doorway, arrivalObjects) ? doorway : nearestClearTile(definition, doorway, arrivalObjects);
    if (!arrival) fail(409, 'This doorway is blocked by scenery. A human moderator must clear it before anyone can enter.');
    const arrivalZ = surfaceAt(arrival.x, arrival.y, blockLayers(this.all("SELECT x,y,z FROM frontier_blocks WHERE world_id=? AND type!='path' AND x=? AND y=?", target.id, arrival.x, arrival.y)));
    this.run("UPDATE agents SET world_id=?,x=?,y=?,z=?,grounded=1,posture='standing',last_move=?,last_seen=? WHERE id=?", target.id, arrival.x, arrival.y, arrivalZ, this.clock(), this.clock(), agent.id);
    this.audit(actor.account.id, 'world.entered', target.id);
    this.recordVisit?.(actor, agent.id, target.id);
    // The same arrival delta reaches both the world the resident left (which drops it) and the world it
    // entered (which adds it): the client removes any participant whose world_id is not its own.
    const arrivalDelta = { agents: [{ id: agent.id, x: arrival.x, y: arrival.y, z: arrivalZ, world_id: target.id, posture: 'standing', status: agent.status }] };
    this.events?.publish(agent.world_id, arrivalDelta);
    this.events?.publish(target.id, arrivalDelta);
    return { ...arrival, z: arrivalZ, grounded: true, world_id: target.id, posture: 'standing', entered: true };
  },
  build(actor, agentId, input) {
    this.active(); const agent = this.ownedAgent(actor, agentId);
    if (agent.status !== 'active') fail(403, 'The agent is paused.');
    const world = this.space(actor, agent.world_id);
    if (world.owner_agent_id !== agent.id || !['home', 'house'].includes(world.kind)) fail(403, 'Build inside your own garden or cottage.');
    const position = { x: input.x, y: input.y }, definition = getWorldDefinition(world);
    if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) fail(400, 'Choose a buildable tile inside your garden.');
    // The original cottage furniture and the arrival tiles keep their own, more specific refusals.
    if (world.kind === 'house' && (definition.objects || []).some((object) => object.x === position.x && object.y === position.y)) fail(409, 'Keep the original cottage furniture clear.');
    if (!walkable(position, definition)) fail(400, 'Choose a buildable tile inside your garden.');
    if (Math.abs(position.x - definition.start.x) + Math.abs(position.y - definition.start.y) <= 1 || (definition.portals || []).some((p) => Math.abs(p.x - position.x) + Math.abs(p.y - position.y) <= 1)) fail(409, 'Keep the arrival and exit clear.');
    if (input.remove === true) this.run('DELETE FROM world_objects WHERE world_id=? AND x=? AND y=?', world.id, position.x, position.y);
    else {
      const type = input.type || input.kind;
      if (!(world.kind === 'house' ? housePalette : palette).includes(type)) fail(400, 'Choose an item from the building palette.');
      // Solid scenery follows the shared footprint table: it may not share a tile with a resident and
      // it may not leave anyone without a walkable route back to the garden or cottage entrance.
      if (sceneryBlocks(type)) {
        if (this.get("SELECT id FROM agents WHERE world_id=? AND x=? AND y=? AND status!='deleted'", world.id, position.x, position.y)) fail(409, 'Keep occupied resident tiles clear.');
        const placed = this.all('SELECT type,x,y FROM world_objects WHERE world_id=?', world.id).filter((object) => object.x !== position.x || object.y !== position.y);
        if (trapsResident(this, world.id, definition, placed, [...placed, { type, x: position.x, y: position.y }])) fail(409, 'This object would leave a resident with no walkable route to the entrance.');
      }
      if (!this.get('SELECT id FROM world_objects WHERE world_id=? AND x=? AND y=?', world.id, position.x, position.y) && this.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', world.id).n >= 200) fail(429, 'A home holds 200 placed items.');
      this.run('INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(world_id,x,y) DO UPDATE SET type=excluded.type', randomUUID(), world.id, type, position.x, position.y, new Date(this.clock()).toISOString());
    }
    this.audit(actor.account.id, input.remove === true ? `${world.kind === 'house' ? 'cottage' : 'garden'}.removed` : `${world.kind === 'house' ? 'cottage' : 'garden'}.built`, world.id);
    this.events?.publish(world.id, { objects: [{ op: input.remove === true ? 'remove' : 'set', x: position.x, y: position.y, ...(input.remove === true ? {} : { type: input.type || input.kind }) }] });
    return { world_id: world.id, x: position.x, y: position.y, removed: input.remove === true };
  },
  homeSettings(actor, agentId, input) {
    this.active();
    if (actor.kind !== 'session') fail(403, 'Only the operator can change visiting settings.');
    this.ownedAgent(actor, agentId);
    const world = this.get("SELECT * FROM worlds WHERE owner_agent_id=? AND kind='home'", agentId);
    const name = input.name === undefined ? world.name : typeof input.name === 'string' && input.name.trim() && input.name.length <= 80 ? input.name.trim() : fail(400, 'Garden name must contain 1–80 characters.');
    const visibility = input.visibility || world.visibility;
    if (!['public', 'private'].includes(visibility)) fail(400, 'Choose public or private visiting.');
    this.run('UPDATE worlds SET name=?,visibility=? WHERE id=?', name, visibility, world.id);
    this.run("UPDATE worlds SET visibility=? WHERE owner_agent_id=? AND kind='house'", visibility, agentId);
    if (visibility === 'private') {
      const start = getWorldDefinition('commons').start;
      this.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE world_id IN (?,?) AND id!=?', 'commons', start.x, start.y, world.id, `house:${agentId}`, agentId);
    }
    this.audit(actor.account.id, 'garden.settings', world.id);
    // Changing a garden to private returns its visitors to the Commons and must also revoke any
    // subscription that no longer has a right to observe it, so every subscriber is re-checked now.
    this.events?.revalidateNow?.();
    return { id: world.id, name, visibility };
  },
  heartbeat(actor, agentId) {
    this.active(); const agent = this.ownedAgent(actor, agentId);
    if (agent.status !== 'active') fail(403, 'The agent is paused.');
    this.run('UPDATE agents SET last_seen=? WHERE id=?', this.clock(), agentId);
    return { presence: actor.kind === 'runtime' ? 'connected' : 'recent_visit', world_id: agent.world_id };
  },
  posture(actor, agentId, input) {
    this.active(); const agent = this.ownedAgent(actor, agentId);
    if (agent.status !== 'active') fail(403, 'The agent is paused.');
    if (!['standing', 'sitting', 'meditating'].includes(input.posture)) fail(400, 'Choose standing, sitting, or meditating.');
    this.run('UPDATE agents SET posture=?,last_seen=? WHERE id=?', input.posture, this.clock(), agentId);
    this.events?.publish(agent.world_id, { agents: [{ id: agent.id, x: agent.x, y: agent.y, z: agent.z, posture: input.posture, status: agent.status }] });
    return { posture: input.posture };
  },
  /**
   * Read what one tile offers without acting: the fixture, the action it maps to, the requirement and
   * the next usable step. A visitor with no acting resident may inspect any world it can already read,
   * so an observer never has to write on someone else's behalf to see what a fixture is.
   */
  interactionView(actor, input = {}) {
    const viewer = actor?.kind === 'runtime'
      ? this.get('SELECT id,name,status,world_id,x,y FROM agents WHERE id=?', actor.agent.id)
      : input.agent_id && actor ? this.ownedAgent(actor, input.agent_id) : null;
    const worldId = String(input.world_id || viewer?.world_id || 'commons');
    const world = this.space(actor, worldId);
    const fixtures = interactionFixtures(this, worldId);
    const asked = readingTile(input);
    if (asked && (asked.x < 0 || asked.y < 0 || asked.x >= world.width || asked.y >= world.height)) fail(400, `Tile ${asked.x}, ${asked.y} is outside ${world.name}.`);
    const present = Boolean(viewer && viewer.world_id === worldId);
    const nearby = present
      ? fixtures.map((fixture) => ({ fixture, distance: interactionDistance(viewer, fixture) }))
        .filter((entry) => entry.distance <= INTERACTION_NEARBY)
        .sort((left, right) => left.distance - right.distance).slice(0, INTERACTION_OFFERED)
        .map((entry) => ({ kind: entry.fixture.kind, label: INTERACTION_LABEL[entry.fixture.kind], name: entry.fixture.name, x: entry.fixture.x, y: entry.fixture.y, distance: entry.distance, in_range: entry.distance <= INTERACTION_DISTANCE }))
      : [];
    const focus = asked
      ? interactionFixture(this, worldId, asked.x, asked.y, fixtures)
      : nearby.length ? interactionFixture(this, worldId, nearby[0].x, nearby[0].y, fixtures) : null;
    const description = focus ? interactionDescription(this, world, focus, viewer) : null;
    return {
      world_id: worldId, world_name: world.name, world_kind: world.kind,
      world_paused: this.get("SELECT value FROM settings WHERE key='paused'").value === 'true',
      required_distance: INTERACTION_DISTANCE,
      viewer: viewer ? { agent_id: viewer.id, name: viewer.name, status: viewer.status, world_id: viewer.world_id } : null,
      fixture: description,
      nearby,
      hint: description ? description.hint : asked
        ? `No door, crop patch, bench, crafting station or country ambassador desk stands at ${asked.x}, ${asked.y} in ${world.name}.${nearby.length ? ` The nearest fixture is the ${INTERACTION_LABEL[nearby[0].kind].toLowerCase()} at ${nearby[0].x}, ${nearby[0].y}, ${tiles(nearby[0].distance)} away.` : ''}`
        : `Pick a tile in ${world.name} to read what it offers: a door, crop patch, bench, crafting station or country ambassador desk. A visitor can inspect any fixture without acting for anyone.`,
    };
  },
  /**
   * Use one fixture the resident is standing on or beside. The distance, the resident's own state, the
   * fixture's owner and the action's prerequisites are all decided here, and the shipped method then
   * runs unchanged: this route adds no authority of its own and can never claim an action happened
   * that the world's own rules refused.
   */
  interact(actor, input = {}, key) {
    this.active();
    if (typeof key !== 'string' || !key.trim() || key.length > 100) fail(400, 'Idempotency key must contain 1–100 characters.');
    const agent = this.ownedAgent(actor, input.agent_id || actor.agent?.id);
    const x = Number(input.x), y = Number(input.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) fail(400, 'Choose the tile of the fixture you want to use.');
    // One click, one intent, one key. A repeated key returns the recorded outcome and writes nothing;
    // the same key for a different intent is a client mistake and is refused. The check comes first so
    // a retried request cannot act twice on a world that has already changed around it.
    const fingerprint = createHash('sha256').update(JSON.stringify([actor.account.id, agent.id, x, y,
      input.action || '', input.garden_action || '', input.kind || '', input.recipe_id || '', input.posture || '', input.question || ''])).digest('hex');
    const ledger = replayLedger(this), ledgerId = `${actor.account.id}:${key}`;
    const repeated = ledger.get(ledgerId);
    if (repeated) {
      if (repeated.fingerprint !== fingerprint) fail(409, 'This idempotency key was used for a different interaction.');
      return { ...repeated.value, replay: true };
    }
    const world = this.space(actor, agent.world_id);
    const label = (fixture) => INTERACTION_LABEL[fixture.kind];
    // The refusal a direct interaction returns: it keeps the world's own status and carries the next
    // usable step. `refuse` is only used for a rule this route states itself.
    const refuse = (status, message, next) => {
      const error = Object.assign(new Error(message), { status, next_step: next });
      error.hint = next ? `${message} ${next}` : message;
      throw error;
    };
    if (agent.status !== 'active') {
      refuse(403, agent.status === 'revoked' ? `${agent.name}’s access is revoked.` : `${agent.name} is ${agent.status}.`,
        agent.status === 'revoked'
          ? 'An operator must resume this resident before it can act in the world. Its saved position and records are unchanged.'
          : `Resume ${agent.name} in My characters, then walk back to the fixture and use it again. Paused residents keep their saved position.`);
    }
    if (this.get("SELECT value FROM settings WHERE key='paused'").value === 'true') refuse(503, 'The world is paused by an administrator.', 'Interactions resume when an administrator unpauses the world; nothing is queued or replayed.');
    const fixture = interactionFixture(this, agent.world_id, x, y);
    if (!fixture) {
      const fixtures = interactionFixtures(this, agent.world_id);
      const nearest = fixtures.map((entry) => ({ entry, distance: interactionDistance(agent, entry) })).sort((left, right) => left.distance - right.distance)[0];
      const next = nearest
        ? `The nearest fixture is the ${label(nearest.entry).toLowerCase()} at ${nearest.entry.x}, ${nearest.entry.y}, ${tiles(nearest.distance)} away.`
        : `No door, crop patch, bench, crafting station or ambassador desk is recorded in ${world.name}.`;
      refuse(404, `There is no fixture a resident can use at ${x}, ${y} in ${world.name}.`, next);
    }
    const distance = interactionDistance(agent, fixture);
    if (distance > INTERACTION_DISTANCE) {
      refuse(409, `${label(fixture)} at ${x}, ${y}: ${agent.name} is ${tiles(distance)} away.`,
        `Step onto or beside ${x}, ${y} — within ${tiles(INTERACTION_DISTANCE)} of it — and use it again. The requirement is the same adjacency a doorway already needs for travel, and it is not movable.`);
    }
    const action = INTERACTION_ACTION[fixture.kind];
    if (input.action && input.action !== action.id) fail(400, `This ${label(fixture).toLowerCase()} uses “${action.id}”, not “${input.action}”.`);
    interactionScope(actor, action.scope);
    let result;
    try {
      if (fixture.kind === 'door') result = this.travel(actor, agent.id, { world_id: fixture.target_world_id });
      else if (fixture.kind === 'crop_patch') result = this.gardenAction(actor, { agent_id: agent.id, x, y, action: input.garden_action, kind: input.kind });
      else if (fixture.kind === 'bench') result = this.posture(actor, agent.id, { posture: input.posture || 'sitting' });
      else if (fixture.kind === 'crafting_station') {
        const recipe = content.recipes().find((item) => item.id === input.recipe_id);
        if (!recipe) fail(400, 'Choose one of the recipes the crafting station lists.');
        const missing = missingIngredients(this, agent.id, recipe);
        if (missing.length) refuse(409, 'Gather the recipe ingredients first.',
          `${recipe.name} needs ${Object.entries(recipe.ingredients).map(([kind, quantity]) => `${quantity} ${kind}`).join(' and ')}, and ${agent.name} still needs ${missing.join(' and ')}. They are grown from crop patches in the resident’s own garden.`);
        result = this.craftItem(actor, { agent_id: agent.id, recipe_id: recipe.id });
      } else result = fixture.ambassador_id
        ? this.ambassadorTalk(actor, { ambassador_id: fixture.ambassador_id, question: input.question })
        : this.mayorTalk(actor, { npc_id: fixture.guide_id, question: input.question });
    } catch (error) {
      throw interactionRefusal(this, error, fixture, agent, world);
    }
    const value = {
      interaction: { kind: fixture.kind, label: label(fixture), name: fixture.name, x, y, action: action.id, route: action.route, required_distance: INTERACTION_DISTANCE, distance },
      result,
    };
    ledger.set(ledgerId, { fingerprint, at: this.clock(), value });
    return value;
  },
  /**
   * One planned placement inside the garden a restoration was opened on.
   *
   * This is the event's only write into another operator's garden, and it is deliberately the
   * narrowest one this world can state: the object is the plan's own type, the tile is the plan's own
   * tile, the actor is a pledged participant whose calling answers the ground step, the resident must
   * stand beside the tile, the restoration must be inside its open window, and the world's own rules
   * — the sealed palette, the tile being clear, walkable and away from the arrival and the doorways,
   * a resident never trapped without a route out, the 200-object garden cap and the 200 ms mutation
   * interval frontier building already uses — all still apply. A second attempt at a filled tile is
   * refused, so one planned tile is filled exactly once.
   */
  restorationPlace(actor, input = {}) {
    this.active();
    const agent = this.ownedAgent(actor, input.agent_id || actor.agent?.id);
    const event = this.restorationEventRecord(input.event_id);
    const step = RESTORATION_PLACEMENT_STEP, role = RESTORATION_ROLES[step.role];
    if (agent.status !== 'active') fail(403, agent.status === 'revoked' ? `${agent.name}’s access is revoked.` : `Resume ${agent.name} before placing anything in the garden.`);
    if (this.get('SELECT status FROM accounts WHERE id=?', agent.operator_id)?.status !== 'active') fail(403, 'This operator account is not active.');
    if (!this.restorationParticipant(event.id, agent.id)) fail(403, 'Pledge to help with this restoration before placing anything in the garden.');
    const calling = this.get('SELECT calling_id FROM resident_callings WHERE agent_id=?', agent.id)?.calling_id || 'explorer';
    if (!role.callings.includes(calling)) fail(403, `This is the ${role.label} step: it is answered by ${role.callings.join(', ')}. Your resident follows ${calling}.`);
    const phase = this.restorationPhase(event);
    if (phase === 'completed') fail(409, 'This restoration is already complete. The finished garden is recorded and nothing more is placed.');
    if (phase === 'cancelled') fail(409, 'This restoration was cancelled; the objects already placed stand as history.');
    if (phase !== 'open') fail(409, `This restoration’s window is ${phase}. The objects already placed stand; nothing new is placed outside the window.`);
    const site = this.restorationSite(event);
    if (site.visibility !== 'public') fail(403, 'This garden is no longer open to visitors, so its restoration cannot be worked on.');
    if (agent.world_id !== site.id) fail(409, `${agent.name} is in ${getWorldDefinition(agent.world_id).name}, not in ${site.name}. Walk the resident into the garden, then place again.`);
    const mine = this.restorationProgress(event).steps.find((item) => item.id === step.id);
    if (mine.complete) fail(409, 'The gathering ground is already laid; nothing is placed twice.');
    const wanted = input.x === undefined && input.y === undefined
      ? mine.next_slot
      : mine.slots.find((slot) => slot.x === Number(input.x) && slot.y === Number(input.y));
    if (!wanted) fail(409, 'That is not a tile this step plans. Choose a planned tile that is still waiting.');
    if (wanted.filled) fail(409, `The ${wanted.type} planned for ${wanted.x}, ${wanted.y} already stands there. Each planned tile is filled once.`);
    const away = Math.abs(agent.x - wanted.x) + Math.abs(agent.y - wanted.y);
    if (away > INTERACTION_DISTANCE) fail(409, `${agent.name} is ${tiles(away)} from ${wanted.x}, ${wanted.y}. Step onto or beside the tile — within ${tiles(INTERACTION_DISTANCE)} — and place it again.`);
    const latest = this.get("SELECT created_at FROM audit WHERE actor=? AND event='restoration.placed' ORDER BY seq DESC LIMIT 1", actor.account.id);
    if (latest && this.clock() - Date.parse(latest.created_at) < FRONTIER_LIMITS.action_interval_ms) fail(429, 'Allow a moment between garden placements.');
    const world = this.space(actor, site.id), definition = getWorldDefinition(world), position = { x: wanted.x, y: wanted.y };
    if (this.get('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', world.id, position.x, position.y)) fail(409, `Another object stands at ${position.x}, ${position.y}. Choose a planned tile that is still waiting.`);
    if (!walkable(position, definition)) fail(400, 'Choose a clear garden tile.');
    if (Math.abs(position.x - definition.start.x) + Math.abs(position.y - definition.start.y) <= 1 || (definition.portals || []).some((portal) => Math.abs(portal.x - position.x) + Math.abs(portal.y - position.y) <= 1)) fail(409, 'Keep the arrival and the doorway clear.');
    if (!(world.kind === 'house' ? housePalette : palette).includes(wanted.type)) fail(400, 'This restoration plans an object this place cannot hold.');
    if (sceneryBlocks(wanted.type)) {
      if (this.get("SELECT id FROM agents WHERE world_id=? AND x=? AND y=? AND status!='deleted'", world.id, position.x, position.y)) fail(409, 'A resident is standing on that tile. Ask them to step aside first.');
      const placed = this.all('SELECT type,x,y FROM world_objects WHERE world_id=?', world.id);
      if (trapsResident(this, world.id, definition, placed, [...placed, { type: wanted.type, x: position.x, y: position.y }])) fail(409, 'That placement would leave a resident with no walkable route to the entrance.');
    }
    if (this.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', world.id).n >= 200) fail(429, 'This garden holds 200 placed items.');
    const id = randomUUID(), created = new Date(this.clock()).toISOString();
    this.run('INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,?,?,?,?)', id, world.id, wanted.type, position.x, position.y, created);
    this.audit(actor.account.id, 'restoration.placed', `${event.id}|${agent.id}|${position.x},${position.y}|${wanted.type}`);
    const finish = this.restorationFinish(actor, this.get('SELECT * FROM community_events WHERE id=?', event.id));
    return {
      ...this.restorationEventView(this.get('SELECT * FROM community_events WHERE id=?', event.id), agent.id),
      placed: { id, step_id: step.id, x: position.x, y: position.y, type: wanted.type, created_at: created },
      completed: finish.completed, assembled: finish.assembled, writes: 1 + (finish.completed ? 1 : 0),
    };
  },
};

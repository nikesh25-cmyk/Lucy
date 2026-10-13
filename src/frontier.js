import { randomUUID } from 'node:crypto';
import { COLS, ROWS, FRONTIER_SIZE, FRONTIER_COORDINATE_LIMIT, FRONTIER_MIN_COORDINATE, FRONTIER_MAX_COORDINATE, FRONTIER_PLOT_SIZE, frontierCoordinates, frontierGates, frontierPlotId, getWorldDefinition, walkable } from '../world.js';
import { blockLayers, isGrounded, settle } from './elevation.js';
import { escapeColumns } from './world-walk.js';
import { blockOccupiesTile } from './footprints.js';
import { palette, rules } from './content.js';

export const FRONTIER_PALETTE = Object.freeze(palette('frontier'));
// The stacking ceiling is the sealed block rule, not a second copy of the number.
const maximumBlockLayer = Math.max(...rules('block').map(({ rules: block }) => block.stack.z_max));
export const FRONTIER_LIMITS = Object.freeze({ sector_size: FRONTIER_SIZE, coordinate_limit: FRONTIER_COORDINATE_LIMIT, minimum_coordinate: FRONTIER_MIN_COORDINATE, maximum_coordinate: FRONTIER_MAX_COORDINATE, sectors: 256, expansions_per_operator_day: 8, blocks_per_sector: 2048, actions_per_operator_day: 500, action_interval_ms: 200, build_range: 6, maximum_z: maximumBlockLayer });
export const LAND_WORLD = Object.freeze({ finite: true, virtual: true, minimum_coordinate: -8, maximum_coordinate: 7, areas_x: 16, areas_y: 16, total_areas: 256, cells_per_area: 48, metres_per_cell: 1, width_m: 768, height_m: 768, area_m2: 589824, plots_per_area: 64, total_plots: 16384, plot_width_m: 6, plot_height_m: 6, plot_area_m2: 36, units_note: 'Metres describe a conceptual virtual scale. Plots convey no real property rights, monetary value, or legal ownership.' });
export const LAND_POLICY = Object.freeze({ stewardships_per_operator: 1, assignments_per_operator_day: 4, action_interval_ms: 1500, purpose_maximum_characters: 120, description_maximum_characters: 500, acquisition: 'Signed-in humans can steward one available plot for a stated purpose. Agent runtimes cannot acquire or release land.', building: 'Owned residents may build only inside their operator’s assigned plot. Roads, water and habitat reserves stay clear.', release: 'Remove construction before releasing a plot. There is no payment, transfer, property title or contribution-coin reward.' });
export const FRONTIER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS frontier_sectors(world_id TEXT PRIMARY KEY REFERENCES worlds(id),sector_x INTEGER NOT NULL CHECK(sector_x BETWEEN -64 AND 64),sector_y INTEGER NOT NULL CHECK(sector_y BETWEEN -64 AND 64),creator_account_id TEXT REFERENCES accounts(id),creator_agent_id TEXT REFERENCES agents(id),created_at TEXT NOT NULL,UNIQUE(sector_x,sector_y));
  CREATE TABLE IF NOT EXISTS frontier_blocks(id TEXT PRIMARY KEY,world_id TEXT NOT NULL REFERENCES frontier_sectors(world_id),x INTEGER NOT NULL CHECK(x BETWEEN 0 AND 47),y INTEGER NOT NULL CHECK(y BETWEEN 0 AND 47),z INTEGER NOT NULL CHECK(z BETWEEN 0 AND 7),type TEXT NOT NULL CHECK(type IN ('stone','wood','glass','brick','sand','grass','path')),creator_agent_id TEXT NOT NULL REFERENCES agents(id),creator_account_id TEXT NOT NULL REFERENCES accounts(id),created_at TEXT NOT NULL,UNIQUE(world_id,x,y,z));
  CREATE TABLE IF NOT EXISTS frontier_actions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),agent_id TEXT NOT NULL REFERENCES agents(id),world_id TEXT NOT NULL REFERENCES frontier_sectors(world_id),action TEXT NOT NULL CHECK(action IN ('expand','place','remove')),created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS frontier_blocks_view ON frontier_blocks(world_id,x,y,z);
  CREATE INDEX IF NOT EXISTS frontier_actions_operator_date ON frontier_actions(account_id,created_at);
  CREATE INDEX IF NOT EXISTS frontier_sectors_creator_date ON frontier_sectors(creator_account_id,created_at);
`;
export const LAND_SCHEMA = `
  CREATE TABLE IF NOT EXISTS land_parcels(id TEXT PRIMARY KEY,world_id TEXT NOT NULL,sector_x INTEGER NOT NULL CHECK(sector_x BETWEEN -8 AND 7),sector_y INTEGER NOT NULL CHECK(sector_y BETWEEN -8 AND 7),plot_x INTEGER NOT NULL CHECK(plot_x BETWEEN 0 AND 7),plot_y INTEGER NOT NULL CHECK(plot_y BETWEEN 0 AND 7),x INTEGER NOT NULL,y INTEGER NOT NULL,width INTEGER NOT NULL CHECK(width=6),height INTEGER NOT NULL CHECK(height=6),area_m2 INTEGER NOT NULL CHECK(area_m2=36),buildable_cells INTEGER NOT NULL CHECK(buildable_cells BETWEEN 0 AND 36),reserved INTEGER NOT NULL CHECK(reserved IN (0,1)),reserved_reason TEXT NOT NULL,UNIQUE(world_id,plot_x,plot_y));
  CREATE INDEX IF NOT EXISTS land_parcels_world ON land_parcels(world_id,plot_y,plot_x);
  CREATE TABLE IF NOT EXISTS land_stewardships(plot_id TEXT PRIMARY KEY REFERENCES land_parcels(id),account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),purpose TEXT NOT NULL CHECK(length(trim(purpose)) BETWEEN 1 AND 120),description TEXT NOT NULL CHECK(length(description)<=500),assigned_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS land_events(id TEXT PRIMARY KEY,plot_id TEXT NOT NULL REFERENCES land_parcels(id),account_id TEXT NOT NULL REFERENCES accounts(id),action TEXT NOT NULL CHECK(action IN ('assign','release')),purpose TEXT NOT NULL,description TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS land_events_operator_date ON land_events(account_id,created_at);
  CREATE TRIGGER IF NOT EXISTS land_parcels_validate_insert BEFORE INSERT ON land_parcels WHEN NEW.id!=printf('plot:%d:%d:%d:%d',NEW.sector_x,NEW.sector_y,NEW.plot_x,NEW.plot_y) OR NEW.world_id!=printf('frontier:%d:%d',NEW.sector_x,NEW.sector_y) OR NEW.x!=NEW.plot_x*6 OR NEW.y!=NEW.plot_y*6 OR (NEW.reserved=0 AND NEW.reserved_reason!='') OR (NEW.reserved=1 AND NEW.reserved_reason='') BEGIN SELECT RAISE(ABORT,'Invalid canonical land parcel'); END;
  CREATE TRIGGER IF NOT EXISTS land_parcels_no_update BEFORE UPDATE ON land_parcels BEGIN SELECT RAISE(ABORT,'Land parcel registry is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS land_parcels_no_delete BEFORE DELETE ON land_parcels BEGIN SELECT RAISE(ABORT,'Land parcel registry is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS land_stewardships_validate_insert BEFORE INSERT ON land_stewardships WHEN NOT EXISTS(SELECT 1 FROM land_parcels p JOIN frontier_sectors f ON f.world_id=p.world_id JOIN accounts a ON a.id=NEW.account_id WHERE p.id=NEW.plot_id AND p.reserved=0 AND a.status='active') OR EXISTS(SELECT 1 FROM land_parcels p JOIN frontier_blocks b ON b.world_id=p.world_id AND b.x>=p.x AND b.x<p.x+6 AND b.y>=p.y AND b.y<p.y+6 WHERE p.id=NEW.plot_id) BEGIN SELECT RAISE(ABORT,'Land parcel cannot be assigned'); END;
  CREATE TRIGGER IF NOT EXISTS land_stewardships_no_update BEFORE UPDATE ON land_stewardships BEGIN SELECT RAISE(ABORT,'Release stewardship before assigning a new purpose'); END;
  CREATE TRIGGER IF NOT EXISTS frontier_sectors_finite_insert BEFORE INSERT ON frontier_sectors WHEN NEW.sector_x NOT BETWEEN -8 AND 7 OR NEW.sector_y NOT BETWEEN -8 AND 7 OR NEW.world_id!=printf('frontier:%d:%d',NEW.sector_x,NEW.sector_y) BEGIN SELECT RAISE(ABORT,'Outside the finite land boundary'); END;
  CREATE TRIGGER IF NOT EXISTS frontier_sectors_identity_immutable BEFORE UPDATE OF world_id,sector_x,sector_y ON frontier_sectors WHEN NEW.world_id IS NOT OLD.world_id OR NEW.sector_x IS NOT OLD.sector_x OR NEW.sector_y IS NOT OLD.sector_y BEGIN SELECT RAISE(ABORT,'Frontier area identity is immutable'); END;
`;
// ---- Plot collaboration grants (schema 19) ----------------------------------------------------
//
// A plot steward's human operator may invite one specific operator — or one specific resident of
// that operator — to build on that one plot, for a stated purpose, a stated duration and a
// deliberately narrow scope. The grant is a plain storage row; the trigger below is its second
// enforcement point, so a writer that bypassed the build method still cannot place a block outside
// a live grant. Two facts are read live on every write from both points: the grant's own status and
// expiry, and that its steward still stewards the plot.
//
// What "narrow scope" means, concretely and identically in the route, in this trigger and in
// recovery: **one plot**, at most **four** sealed block types, at most **two** layers, an explicit
// action subset (place, and optionally remove) and a hard cap of at most **thirty-six** standing
// blocks written under the grant. A scope cannot be widened by a runtime credential, and nothing
// here can enlarge the land inventory, assign a stewardship or mint a coin.
export const GRANT_SCOPE_LIMITS = Object.freeze({ block_types: 4, layers: 2, max_blocks: 36, duration_minutes_min: 15, duration_minutes_max: 20160, grants_per_plot_per_day: 8 });
export const PLOT_GRANT_POLICY = Object.freeze({
  creator: 'Only the plot’s signed-in human steward creates or revokes a grant. A runtime credential, a guest and an agent cannot create, extend or re-grant one.',
  scope: `One plot, at most ${GRANT_SCOPE_LIMITS.block_types} block types, at most ${GRANT_SCOPE_LIMITS.layers} layers, an explicit action subset and at most ${GRANT_SCOPE_LIMITS.max_blocks} standing blocks.`,
  duration: 'Fifteen minutes to fourteen days. The grant expires by itself; every build re-reads the grant from storage, so a cached credential cannot outlive a revocation or an expiry.',
  budget: 'A guest build spends the guest operator’s own daily frontier actions and its own 200 ms interval. The steward’s daily action budget is not spent, because the action ledger attributes every write to the account that made it.',
  land: 'A grant conveys no stewardship, no land, no coin and no authority to grant anything onward. It never changes land_stewardships, land_parcels or the 16,384-slot registry.',
});
// The storage-layer twin of the build method's own grant check.
const GRANT_CONSTRUCTION = `EXISTS(SELECT 1 FROM land_parcels p JOIN plot_grants g ON g.plot_id=p.id JOIN land_stewardships s ON s.plot_id=p.id AND s.account_id=g.steward_account_id JOIN agents a ON a.id=NEW.creator_agent_id JOIN accounts o ON o.id=NEW.creator_account_id JOIN accounts sa ON sa.id=g.steward_account_id WHERE g.id=NEW.grant_id AND p.id=NEW.plot_id AND p.reserved=0 AND p.world_id=NEW.world_id AND NEW.x>=p.x AND NEW.x<p.x+6 AND NEW.y>=p.y AND NEW.y<p.y+6 AND g.guest_account_id=NEW.creator_account_id AND (g.guest_agent_id='' OR g.guest_agent_id=NEW.creator_agent_id) AND g.status='active' AND g.revoked_at IS NULL AND g.expires_at>NEW.created_at AND a.operator_id=NEW.creator_account_id AND a.status='active' AND o.status='active' AND sa.status='active' AND NEW.type IN (SELECT value FROM json_each(g.scope,'$.block_types')) AND NEW.z IN (SELECT value FROM json_each(g.scope,'$.layers')) AND EXISTS(SELECT 1 FROM json_each(g.scope,'$.actions') WHERE value='place') AND (SELECT COUNT(*) FROM frontier_blocks b WHERE b.grant_id=g.id)<json_extract(g.scope,'$.max_blocks'))`;
const STEWARD_CONSTRUCTION = `EXISTS(SELECT 1 FROM land_parcels p JOIN land_stewardships s ON s.plot_id=p.id JOIN agents a ON a.id=NEW.creator_agent_id JOIN accounts o ON o.id=NEW.creator_account_id WHERE p.id=NEW.plot_id AND p.reserved=0 AND p.world_id=NEW.world_id AND NEW.x>=p.x AND NEW.x<p.x+6 AND NEW.y>=p.y AND NEW.y<p.y+6 AND s.account_id=NEW.creator_account_id AND a.operator_id=NEW.creator_account_id AND a.status='active' AND o.status='active')`;
export const LAND_BLOCK_GUARDS = `CREATE TRIGGER IF NOT EXISTS frontier_blocks_plot_insert BEFORE INSERT ON frontier_blocks WHEN NEW.plot_id IS NULL OR (NOT ${STEWARD_CONSTRUCTION} AND NOT ${GRANT_CONSTRUCTION}) BEGIN SELECT RAISE(ABORT,'Building requires operator land stewardship or a live plot collaboration grant'); END;`;

// The grant tables. Every invariant an operator relies on is re-checked at storage level: a grant
// names a real unreserved plot with a current steward, a different guest operator, a purposeful
// text, a narrow scope and a future expiry; its events are append-only history; and a stewardship
// that disappears revokes the grants it created instead of leaving them usable.
const grantScopeIsNarrow = (scope) => `json_valid(${scope}) AND json_type(${scope})='object' AND json_type(${scope},'$.block_types')='array' AND json_array_length(json_extract(${scope},'$.block_types')) BETWEEN 1 AND ${GRANT_SCOPE_LIMITS.block_types} AND json_type(${scope},'$.layers')='array' AND json_array_length(json_extract(${scope},'$.layers')) BETWEEN 1 AND ${GRANT_SCOPE_LIMITS.layers} AND json_type(${scope},'$.actions')='array' AND json_array_length(json_extract(${scope},'$.actions')) BETWEEN 1 AND 2 AND json_type(${scope},'$.max_blocks')='integer' AND json_extract(${scope},'$.max_blocks') BETWEEN 1 AND ${GRANT_SCOPE_LIMITS.max_blocks} AND NOT EXISTS(SELECT 1 FROM json_each(${scope},'$.block_types') WHERE value NOT IN ('stone','wood','glass','brick','sand','grass','path')) AND NOT EXISTS(SELECT 1 FROM json_each(${scope},'$.layers') WHERE value NOT BETWEEN 0 AND 7) AND NOT EXISTS(SELECT 1 FROM json_each(${scope},'$.actions') WHERE value NOT IN ('place','remove')) AND EXISTS(SELECT 1 FROM json_each(${scope},'$.actions') WHERE value='place')`;
export const PLOT_GRANT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS plot_grants(id TEXT PRIMARY KEY,plot_id TEXT NOT NULL REFERENCES land_parcels(id),steward_account_id TEXT NOT NULL REFERENCES accounts(id),guest_account_id TEXT NOT NULL REFERENCES accounts(id),guest_agent_id TEXT NOT NULL DEFAULT '',purpose TEXT NOT NULL CHECK(length(trim(purpose)) BETWEEN 1 AND 120),scope TEXT NOT NULL CHECK(json_valid(scope) AND json_type(scope)='object'),expires_at TEXT NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT,revoked_by TEXT REFERENCES accounts(id),uses INTEGER NOT NULL DEFAULT 0 CHECK(uses>=0),last_used_at TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN ('active','revoked')));
  CREATE INDEX IF NOT EXISTS plot_grants_plot ON plot_grants(plot_id,status);
  CREATE INDEX IF NOT EXISTS plot_grants_guest ON plot_grants(guest_account_id,status);
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_plot_grant ON plot_grants(plot_id,guest_account_id,guest_agent_id) WHERE status='active';
  CREATE TABLE IF NOT EXISTS plot_grant_events(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES plot_grants(id),plot_id TEXT NOT NULL REFERENCES land_parcels(id),account_id TEXT NOT NULL REFERENCES accounts(id),action TEXT NOT NULL CHECK(action IN ('create','revoke')),detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS plot_grant_events_grant ON plot_grant_events(grant_id,created_at);
  CREATE TRIGGER IF NOT EXISTS plot_grants_validate_insert BEFORE INSERT ON plot_grants WHEN NEW.guest_account_id=NEW.steward_account_id OR NEW.status!='active' OR NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.uses!=0 OR NEW.last_used_at!='' OR length(NEW.expires_at)!=24 OR length(NEW.created_at)!=24 OR NEW.expires_at<=NEW.created_at OR NEW.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+' || ${GRANT_SCOPE_LIMITS.duration_minutes_max} || ' minutes') OR NOT (${grantScopeIsNarrow('NEW.scope')}) OR (NEW.guest_agent_id!='' AND NOT EXISTS(SELECT 1 FROM agents a WHERE a.id=NEW.guest_agent_id AND a.operator_id=NEW.guest_account_id)) OR NOT EXISTS(SELECT 1 FROM land_parcels p JOIN land_stewardships s ON s.plot_id=p.id WHERE p.id=NEW.plot_id AND p.reserved=0 AND s.account_id=NEW.steward_account_id) OR NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=NEW.guest_account_id AND a.status='active') BEGIN SELECT RAISE(ABORT,'Invalid plot collaboration grant'); END;
  CREATE TRIGGER IF NOT EXISTS plot_grants_lifecycle BEFORE UPDATE ON plot_grants WHEN NEW.id IS NOT OLD.id OR NEW.plot_id IS NOT OLD.plot_id OR NEW.steward_account_id IS NOT OLD.steward_account_id OR NEW.guest_account_id IS NOT OLD.guest_account_id OR NEW.guest_agent_id IS NOT OLD.guest_agent_id OR NEW.purpose IS NOT OLD.purpose OR NEW.scope IS NOT OLD.scope OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at OR NEW.uses<OLD.uses OR NEW.status NOT IN ('active','revoked') OR OLD.status!='active' OR (NEW.status='active' AND (NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL)) OR (NEW.status='revoked' AND (NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL)) BEGIN SELECT RAISE(ABORT,'A plot collaboration grant can only be revoked or counted, never rewritten'); END;
  CREATE TRIGGER IF NOT EXISTS plot_grant_events_append_only BEFORE UPDATE ON plot_grant_events BEGIN SELECT RAISE(ABORT,'Plot collaboration history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS plot_grant_events_no_delete BEFORE DELETE ON plot_grant_events BEGIN SELECT RAISE(ABORT,'Plot collaboration history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS plot_grants_no_delete BEFORE DELETE ON plot_grants BEGIN SELECT RAISE(ABORT,'A plot collaboration grant is recorded history: revoke it instead of deleting it'); END;
  CREATE TRIGGER IF NOT EXISTS land_stewardships_revoke_grants AFTER DELETE ON land_stewardships BEGIN
    INSERT INTO plot_grant_events(id,grant_id,plot_id,account_id,action,detail,created_at) SELECT lower(hex(randomblob(16))),g.id,g.plot_id,OLD.account_id,'revoke','Revoked because the plot’s stewardship was removed.',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM plot_grants g WHERE g.plot_id=OLD.plot_id AND g.status='active';
    UPDATE plot_grants SET status='revoked',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revoked_by=OLD.account_id WHERE plot_id=OLD.plot_id AND status='active';
  END;
`;

// ---------------------------------------------------------------------------
// Construction blueprints
//
// Three reusable small structures an operator can place on the plot they steward. The geometry is
// authored here as plain data — an anchor cell plus a block type and its offsets per layer — so a
// plan is deterministic, inspectable, and free of third-party models, textures or assets. It is the
// same geometry `frontierBuild` then validates cell by cell against the shipped server rules, so a
// blueprint can never place something a single hand-placed block could not.
//
// `entrances` name the tiles a resident walks in through. They carry no solid block, so a finished
// structure is never a sealed box, and the plan checks each one still opens onto reachable ground.
// ---------------------------------------------------------------------------
const BLUEPRINT_TABLE = [
  {
    id: 'garden-shelter',
    name: 'Garden shelter',
    summary: 'A 3 × 2 m windbreak: a two-layer plank back wall with short returns, a beam across the top and a flat path floor. One open front.',
    footprint: { width: 3, depth: 2 },
    entrances: [{ x: 1, y: 1 }],
    layers: [
      { z: 0, type: 'path', cells: [{ x: 1, y: 1 }] },
      { z: 0, type: 'wood', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 2, y: 1 }] },
      { z: 1, type: 'wood', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 2, y: 1 }] },
      { z: 2, type: 'wood', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] },
    ],
  },
  {
    id: 'gathering-pavilion',
    name: 'Gathering pavilion',
    summary: 'A 3 × 3 m open pavilion: four two-layer corner posts around a flat path floor, with all four sides open for a small gathering.',
    footprint: { width: 3, depth: 3 },
    entrances: [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }],
    layers: [
      { z: 0, type: 'path', cells: [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }] },
      { z: 0, type: 'wood', cells: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: 2, y: 2 }] },
      { z: 1, type: 'wood', cells: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: 2, y: 2 }] },
    ],
  },
  {
    id: 'research-kiosk',
    name: 'Research kiosk',
    summary: 'A 2 × 3 m reading nook: two-layer brick walls on three sides, a glass window facing the open side, and one open doorway over a flat path floor.',
    footprint: { width: 2, depth: 3 },
    entrances: [{ x: 1, y: 1 }],
    layers: [
      { z: 0, type: 'path', cells: [{ x: 1, y: 1 }] },
      { z: 0, type: 'brick', cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }] },
      { z: 1, type: 'brick', cells: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }] },
      { z: 1, type: 'glass', cells: [{ x: 1, y: 0 }] },
    ],
  },
];

const frozenCells = (cells) => Object.freeze(cells.map((cell) => Object.freeze({ ...cell })));
export const BLUEPRINTS = Object.freeze(BLUEPRINT_TABLE.map((blueprint) => {
  const cells = [], blockTypes = {};
  for (const layer of blueprint.layers) for (const cell of layer.cells) {
    cells.push({ x: cell.x, y: cell.y, z: layer.z, type: layer.type });
    blockTypes[layer.type] = (blockTypes[layer.type] || 0) + 1;
  }
  return Object.freeze({
    id: blueprint.id, name: blueprint.name, summary: blueprint.summary,
    footprint: Object.freeze({ ...blueprint.footprint }), entrances: frozenCells(blueprint.entrances),
    layers: Object.freeze(blueprint.layers.map((layer) => Object.freeze({ z: layer.z, type: layer.type, cells: frozenCells(layer.cells) }))),
    cells: frozenCells(cells), block_count: cells.length, block_types: Object.freeze(blockTypes),
  });
}));
export const blueprintById = (id) => BLUEPRINTS.find((blueprint) => blueprint.id === id) || null;
/** The public description of every blueprint, for the directory and the build panel. */
export const BLUEPRINT_CATALOGUE = Object.freeze(BLUEPRINTS.map((blueprint) => Object.freeze({
  id: blueprint.id, name: blueprint.name, summary: blueprint.summary, footprint: blueprint.footprint,
  block_count: blueprint.block_count, block_types: blueprint.block_types, doorways: blueprint.entrances.length,
})));

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const timestamp = (platform) => new Date(platform.clock()).toISOString();
const dayStart = (platform) => `${timestamp(platform).slice(0, 10)}T00:00:00.000Z`;
const pageNumber = (value, fallback, max) => {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) fail(400, 'Invalid frontier page.');
  return number;
};
function resident(platform, actor, agentId) {
  platform.active();
  if (!actor || !['runtime', 'session'].includes(actor.kind)) fail(401, 'Sign in or connect an authorized builder.');
  if (actor.kind === 'runtime' && !JSON.parse(actor.credential.scopes).includes('build')) fail(403, 'This runtime does not have building permission.');
  const agent = platform.ownedAgent(actor, agentId || actor.agent?.id);
  if (agent.status !== 'active') fail(403, 'This resident is paused.');
  if (!platform.get('SELECT world_id FROM frontier_sectors WHERE world_id=?', agent.world_id)) fail(409, 'Enter the shared frontier before building or expanding.');
  return agent;
}
function expectedWorld(agent, input) {
  if (typeof input?.world_id !== 'string' || !frontierCoordinates(input.world_id, { allowLegacy: true })) fail(400, 'Specify the frontier area you observed before this action.');
  if (input.world_id !== agent.world_id) fail(409, 'Your resident entered another area. Refresh the world before building or expanding.');
}
const actionsToday = (platform, actor) => platform.get('SELECT COUNT(*) AS n FROM frontier_actions WHERE account_id=? AND created_at>=?', actor.account.id, dayStart(platform)).n;
const intervalReady = (platform, actor) => {
  const latest = platform.get('SELECT created_at FROM frontier_actions WHERE account_id=? ORDER BY created_at DESC LIMIT 1', actor.account.id);
  return !latest || platform.clock() - Date.parse(latest.created_at) >= FRONTIER_LIMITS.action_interval_ms;
};
function mutationBudget(platform, actor) {
  if (!intervalReady(platform, actor)) fail(429, 'Allow a moment between building actions.');
  if (actionsToday(platform, actor) >= FRONTIER_LIMITS.actions_per_operator_day) fail(429, 'This operator has reached the daily frontier action limit.');
}
// One authoritative block write is one frontier action, so a multi-block blueprint spends as many
// of the operator's daily actions as it places blocks, and refuses before writing when the rest of
// the day does not cover the structure.
function blockBudget(platform, actor, blocks) {
  const today = actionsToday(platform, actor), remaining = Math.max(0, FRONTIER_LIMITS.actions_per_operator_day - today);
  if (blocks > remaining) fail(429, `This operator has ${remaining} of the ${FRONTIER_LIMITS.actions_per_operator_day} daily frontier actions left; this structure needs ${blocks}.`);
}
// ---- Plot collaboration helpers ----------------------------------------------------------------
// The live grant for this exact (plot, operator, resident) is read from storage on every request.
// Nothing about it is cached on the credential or on the actor, so a revoked, expired or orphaned
// grant refuses the very next build from the same session.
//
// Budget attribution, stated once and tested: a guest build is charged to the **guest operator**,
// because `frontier_actions.account_id` records the account that actually made the write. The
// steward's daily action budget and interval are untouched by a guest, and `grant_id` on the block
// keeps the two records honest.
function liveGrant(platform, actor, agent, plotIdentifier) {
  const at = timestamp(platform);
  const rows = platform.all("SELECT g.*,s.account_id AS current_steward,sa.status AS steward_status FROM plot_grants g LEFT JOIN land_stewardships s ON s.plot_id=g.plot_id LEFT JOIN accounts sa ON sa.id=g.steward_account_id WHERE g.plot_id=? AND g.guest_account_id=? AND (g.guest_agent_id='' OR g.guest_agent_id=?) AND g.status='active' ORDER BY g.expires_at DESC, g.id", plotIdentifier, actor.account.id, agent.id);
  for (const row of rows) {
    if (row.current_steward !== row.steward_account_id) continue;
    if (row.steward_status !== 'active') continue;
    if (!(row.expires_at > at)) continue;
    let scope;
    try { scope = JSON.parse(row.scope); } catch { continue; }
    return { ...row, scope, used_blocks: platform.get('SELECT COUNT(*) AS n FROM frontier_blocks WHERE grant_id=?', row.id).n };
  }
  return null;
}
/** The one refusal a guest build gets when it leaves the granted scope. Null means allowed. */
function grantRefusal(grant, request) {
  const scope = grant.scope;
  if (!scope.actions.includes(request.action)) return `This collaboration grant does not allow ${request.action === 'remove' ? 'removal' : 'placement'}.`;
  if (!scope.block_types.includes(request.type)) return `The ${request.type} block is outside this collaboration grant.`;
  if (!scope.layers.includes(request.z)) return `Layer ${request.z} is outside this collaboration grant.`;
  if (request.action === 'place' && grant.used_blocks >= scope.max_blocks) return `This collaboration grant allows ${scope.max_blocks} standing blocks and they are all placed.`;
  return null;
}
function requireGrantScope(grant, request) {
  if (!grant) return;
  const refusal = grantRefusal(grant, request);
  if (refusal) fail(403, refusal);
}
const grantFields = ['plot_id', 'guest_agent_id', 'guest_account_id', 'purpose', 'duration_minutes', 'block_types', 'layers', 'actions', 'max_blocks', 'preview'];
const GRANT_ACTIONS = Object.freeze(['place', 'remove']);
/**
 * Revoke the active grants of one plot (all of them when a stewardship is released, or one named
 * grant on an explicit revocation). Each revocation is written once, with its own append-only event
 * and an audit-chain entry, so the history of who held what, until when, is never rewritten.
 */
function revokePlotGrants(platform, plotIdentifier, actor, onlyId = null) {
  const at = timestamp(platform);
  const active = onlyId
    ? platform.all("SELECT id FROM plot_grants WHERE plot_id=? AND id=? AND status='active'", plotIdentifier, onlyId)
    : platform.all("SELECT id FROM plot_grants WHERE plot_id=? AND status='active'", plotIdentifier);
  for (const grant of active) {
    platform.run("UPDATE plot_grants SET status='revoked',revoked_at=?,revoked_by=? WHERE id=? AND status='active'", at, actor.account.id, grant.id);
    platform.run("INSERT INTO plot_grant_events(id,grant_id,plot_id,account_id,action,detail,created_at) VALUES(?,?,?,?,?,?,?)", randomUUID(), grant.id, plotIdentifier, actor.account.id, 'revoke', onlyId ? 'Revoked by the plot’s steward.' : 'Revoked because the plot’s stewardship was released.', at);
    platform.audit(actor.account.id, 'land.grant_revoked', `${plotIdentifier} ${grant.id}`);
  }
  return active.length;
}
/**
 * The single definition of a narrow scope, used by the preview, the create, the storage trigger and
 * recovery. Anything wider is refused rather than silently trimmed.
 */
export function grantScopeNarrow(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false;
  const types = scope.block_types, layers = scope.layers, actions = scope.actions, maximum = scope.max_blocks;
  return Array.isArray(types) && types.length >= 1 && types.length <= GRANT_SCOPE_LIMITS.block_types && new Set(types).size === types.length && types.every((type) => FRONTIER_PALETTE.includes(type))
    && Array.isArray(layers) && layers.length >= 1 && layers.length <= GRANT_SCOPE_LIMITS.layers && new Set(layers).size === layers.length && layers.every((z) => Number.isInteger(z) && z >= 0 && z <= FRONTIER_LIMITS.maximum_z)
    && Array.isArray(actions) && actions.length >= 1 && actions.length <= GRANT_ACTIONS.length && new Set(actions).size === actions.length && actions.every((action) => GRANT_ACTIONS.includes(action)) && actions.includes('place')
    && Number.isInteger(maximum) && maximum >= 1 && maximum <= GRANT_SCOPE_LIMITS.max_blocks;
}
/** A stored scope, or null when it is not readable JSON. Recovery reports the invalid case itself. */
export function grantScopeValue(row) {
  try { return JSON.parse(row.scope); } catch { return null; }
}
function grantScope(input) {
  const types = input?.block_types, layers = input?.layers, actions = input?.actions, maximum = input?.max_blocks;
  if (!Array.isArray(types) || !types.length || types.length > GRANT_SCOPE_LIMITS.block_types || new Set(types).size !== types.length || types.some((type) => !FRONTIER_PALETTE.includes(type))) fail(400, `Choose one to ${GRANT_SCOPE_LIMITS.block_types} frontier block types for this grant.`);
  if (!Array.isArray(layers) || !layers.length || layers.length > GRANT_SCOPE_LIMITS.layers || new Set(layers).size !== layers.length || layers.some((z) => !Number.isInteger(z) || z < 0 || z > FRONTIER_LIMITS.maximum_z)) fail(400, `Choose one or two block layers between 0 and ${FRONTIER_LIMITS.maximum_z}.`);
  if (!Array.isArray(actions) || !actions.length || new Set(actions).size !== actions.length || actions.some((action) => !GRANT_ACTIONS.includes(action)) || !actions.includes('place')) fail(400, 'Choose placement, or placement and removal, as the actions this grant allows.');
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > GRANT_SCOPE_LIMITS.max_blocks) fail(400, `Choose a maximum of one to ${GRANT_SCOPE_LIMITS.max_blocks} standing blocks.`);
  return { block_types: [...types].sort(), layers: [...layers].sort((left, right) => left - right), actions: GRANT_ACTIONS.filter((action) => actions.includes(action)), max_blocks: maximum };
}
/** Exactly one named guest: a specific operator, or a specific resident of that operator. */
function grantGuest(platform, input) {
  const agentId = typeof input?.guest_agent_id === 'string' ? input.guest_agent_id.trim() : '';
  const accountId = typeof input?.guest_account_id === 'string' ? input.guest_account_id.trim() : '';
  if (Boolean(agentId) === Boolean(accountId)) fail(400, 'Name exactly one guest resident or one guest operator.');
  if (agentId) {
    const agent = platform.get('SELECT id,operator_id,name,status FROM agents WHERE id=?', agentId);
    if (!agent || agent.status === 'deleted') fail(404, 'Guest resident not found.');
    return { account_id: agent.operator_id, agent_id: agent.id, name: agent.name, operator: platform.get('SELECT name FROM accounts WHERE id=?', agent.operator_id)?.name || 'Resident' };
  }
  const account = platform.get('SELECT id,name,status FROM accounts WHERE id=?', accountId);
  if (!account) fail(404, 'Guest operator not found.');
  return { account_id: account.id, agent_id: '', name: account.name, operator: account.name };
}
function grantDuration(input) {
  const minutes = Number(input?.duration_minutes);
  if (!Number.isInteger(minutes) || minutes < GRANT_SCOPE_LIMITS.duration_minutes_min || minutes > GRANT_SCOPE_LIMITS.duration_minutes_max) fail(400, 'Choose a duration between 15 minutes and 14 days.');
  return minutes;
}
function grantBudget(platform, actor, plotIdentifier) {
  const latest = platform.get('SELECT created_at FROM plot_grant_events WHERE account_id=? ORDER BY created_at DESC LIMIT 1', actor.account.id);
  if (latest && platform.clock() - Date.parse(latest.created_at) < LAND_POLICY.action_interval_ms) fail(429, 'Allow a moment between collaboration changes.');
  if (platform.get("SELECT COUNT(*) AS n FROM plot_grant_events WHERE plot_id=? AND action='create' AND created_at>=?", plotIdentifier, dayStart(platform)).n >= GRANT_SCOPE_LIMITS.grants_per_plot_per_day) fail(429, 'This plot has reached its daily collaboration grant limit.');
}
const grantPermissionText = (scope) => `May ${scope.actions.includes('remove') ? 'place and remove' : 'place'} ${scope.block_types.join(', ')} on ${scope.layers.length === 1 ? `layer ${scope.layers[0]}` : `layers ${scope.layers.join(' and ')}`}, up to ${scope.max_blocks} standing blocks.`;
/** Every validation the preview and the create share. It reads storage and writes nothing. */
function planGrant(platform, actor, input) {
  const plot = plotId(input.plot_id);
  const stewardship = platform.get('SELECT plot_id,account_id,purpose FROM land_stewardships WHERE plot_id=?', plot);
  if (!stewardship || stewardship.account_id !== actor.account.id) fail(403, 'Only this plot’s signed-in human steward can grant building access to it.');
  const purpose = landText(input.purpose, 'Purpose', LAND_POLICY.purpose_maximum_characters);
  const minutes = grantDuration(input), scope = grantScope(input), guest = grantGuest(platform, input);
  if (guest.account_id === actor.account.id) fail(400, 'Choose a different operator: a steward cannot grant to their own account.');
  const guestAccount = platform.get('SELECT id,status FROM accounts WHERE id=?', guest.account_id);
  if (!guestAccount || guestAccount.status !== 'active') fail(409, 'This operator account is not active, so it cannot be invited.');
  if (guest.agent_id) {
    const resident = platform.get('SELECT status FROM agents WHERE id=?', guest.agent_id);
    if (!resident || resident.status === 'deleted') fail(409, 'This resident is unavailable, so it cannot be invited.');
  }
  const existing = platform.get("SELECT id,expires_at FROM plot_grants WHERE plot_id=? AND guest_account_id=? AND guest_agent_id=? AND status='active'", plot, guest.account_id, guest.agent_id);
  const created = timestamp(platform), expires = new Date(platform.clock() + minutes * 60000).toISOString();
  // A grant that has already expired is closed on the record and replaced, never silently extended;
  // a live one must be revoked first.
  if (existing && existing.expires_at > created) fail(409, 'This guest already holds a live grant on this plot. Revoke it before granting another.');
  const row = platform.get(`${landRows} WHERE p.id=?`, plot);
  return {
    grant: {
      id: null, plot_id: plot, plot_address: row ? describePlot(row, actor).address : plot,
      plot_purpose: stewardship.purpose, purpose, duration_minutes: minutes, scope,
      created_at: created, expires_at: expires, status: 'active', uses: 0, used_blocks: 0,
      steward: { account_id: actor.account.id, name: actor.account.name },
      guest: { account_id: guest.account_id, name: guest.name, operator: guest.operator, agent_id: guest.agent_id || null },
      permissions: grantPermissionText(scope),
    },
    replaces: existing?.id || null,
    writes: 0,
  };
}
/** The operator-facing view of one grant row. Names, never contact details or credentials. */
function grantView(row, at, usedBlocks = 0) {
  let scope = null;
  try { scope = JSON.parse(row.scope); } catch { scope = null; }
  const status = row.status === 'revoked' ? 'revoked'
    : row.expires_at <= at ? 'expired'
    : row.current_steward !== row.steward_account_id ? 'stewardship_changed'
    : row.steward_status !== 'active' ? 'steward_paused'
    : 'active';
  return {
    id: row.id, plot_id: row.plot_id, purpose: row.purpose, scope, status,
    created_at: row.created_at, expires_at: row.expires_at, revoked_at: row.revoked_at,
    duration_minutes: Math.round((Date.parse(row.expires_at) - Date.parse(row.created_at)) / 60000),
    uses: row.uses, used_blocks: usedBlocks, permissions: scope ? grantPermissionText(scope) : '',
    steward_name: row.steward_name || 'Steward', guest_name: row.guest_agent_name || row.guest_name || 'Guest',
    guest_agent_id: row.guest_agent_id || null, guest_agent_name: row.guest_agent_name || null,
    live: status === 'active',
  };
}
/** The bounded grant view carried in the authenticated world payload and on `GET /frontier/grants`. */
function grantListing(platform, accountId) {
  const at = timestamp(platform);
  const select = `SELECT g.*,sa.name AS steward_name,ga.name AS guest_name,ra.name AS guest_agent_name,s.account_id AS current_steward,saccount.status AS steward_status,(SELECT COUNT(*) FROM frontier_blocks b WHERE b.grant_id=g.id) AS used_blocks FROM plot_grants g JOIN accounts sa ON sa.id=g.steward_account_id JOIN accounts ga ON ga.id=g.guest_account_id LEFT JOIN agents ra ON ra.id=g.guest_agent_id LEFT JOIN land_stewardships s ON s.plot_id=g.plot_id LEFT JOIN accounts saccount ON saccount.id=g.steward_account_id`;
  const view = (row) => grantView(row, at, row.used_blocks);
  return {
    as_steward: platform.all(`${select} WHERE g.steward_account_id=? ORDER BY g.created_at DESC,g.id DESC LIMIT 20`, accountId).map(view),
    as_guest: platform.all(`${select} WHERE g.guest_account_id=? ORDER BY g.created_at DESC,g.id DESC LIMIT 20`, accountId).map(view),
    events: platform.all('SELECT e.id,e.grant_id,e.plot_id,e.action,e.detail,e.created_at FROM plot_grant_events e JOIN plot_grants g ON g.id=e.grant_id WHERE g.steward_account_id=? OR g.guest_account_id=? ORDER BY e.created_at DESC,e.id DESC LIMIT 50', accountId, accountId),
  };
}
// Attribution, recorded once per authoritative write: the account in the ledger is always the
// account that made the write. A guest build therefore spends the guest's own daily action budget.
function recordAction(platform, actor, agent, worldId, action) {
  platform.run('INSERT INTO frontier_actions(id,account_id,agent_id,world_id,action,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), actor.account.id, agent.id, worldId, action, timestamp(platform));
  platform.run('UPDATE agents SET last_seen=? WHERE id=?', platform.clock(), agent.id);
  platform.audit(actor.account.id, `frontier.${action}`, worldId);
}
// Stored z is a cache of the column surface. Every authoritative block write re-derives it
// rather than trusting the previous value, so removing support always settles the resident.
function settleColumn(platform, worldId, position) {
  const layers = blockLayers(platform.all("SELECT x,y,z FROM frontier_blocks WHERE world_id=? AND type!='path' AND x=? AND y=?", worldId, position.x, position.y));
  for (const standing of platform.all('SELECT id,x,y,z FROM agents WHERE world_id=? AND x=? AND y=?', worldId, position.x, position.y)) {
    const landed = settle(standing, layers);
    platform.run('UPDATE agents SET z=?,grounded=? WHERE id=?', landed.z, isGrounded(landed, layers) ? 1 : 0, standing.id);
  }
}
function settleColumns(platform, worldId, cells) {
  for (const key of new Set(cells.map((cell) => `${cell.x},${cell.y}`))) {
    const [x, y] = key.split(',').map(Number);
    settleColumn(platform, worldId, { x, y });
  }
}
/**
 * Run the write phase of a structure under a savepoint. A rejected statement in the middle of a
 * blueprint rolls the whole structure back instead of leaving a partial one, whether or not the
 * caller already opened a transaction (`platform.transaction` keeps its own atomicity on top).
 */
function atomic(platform, action) {
  platform.db.exec('SAVEPOINT frontier_blueprint');
  try {
    const value = action();
    platform.db.exec('RELEASE frontier_blueprint');
    return value;
  } catch (error) {
    platform.db.exec('ROLLBACK TO frontier_blueprint');
    platform.db.exec('RELEASE frontier_blueprint');
    throw error;
  }
}
/** Why a tile is shared ground the world keeps clear, or null when it is ordinary buildable land. */
function protectedReason(position, definition) {
  if (position.x >= 23 && position.x <= 25 || position.y >= 23 && position.y <= 25) return 'a public road';
  if (distance(position, definition.start) <= 2) return 'the arrival area';
  if (definition.portals.some((gate) => distance(position, gate) <= 2)) return 'a gateway passage';
  return null;
}
function protectedTile(position, definition) {
  return protectedReason(position, definition) !== null;
}
// The escape rule over a set of proposed changes, so one blueprint is judged as the finished
// structure rather than block by block. A placement that strands a resident is refused; a removal
// may not take away an escape that existed before it, so a legacy trap stays removable.
function keepsResidentsConnectedAfter(platform, agent, { add = [], remove = [] }, definition) {
  const blocks = platform.all('SELECT id,x,y,z,type FROM frontier_blocks WHERE world_id=?', agent.world_id);
  const objects = platform.all('SELECT x,y,type FROM world_objects WHERE world_id=?', agent.world_id);
  const dropped = new Set(remove.map((block) => block.id));
  const after = escapeColumns(definition, [...blocks.filter((block) => !dropped.has(block.id)), ...add], objects);
  const disconnected = platform.all("SELECT x,y FROM agents WHERE world_id=? AND status!='deleted'", agent.world_id).filter(position => !after.has(`${position.x},${position.y}`));
  if (!disconnected.length) return true;
  if (!remove.length) return false;
  const before = escapeColumns(definition, blocks, objects);
  return disconnected.every(position => !before.has(`${position.x},${position.y}`));
}
function keepsResidentsConnected(platform, agent, candidate, definition, removedId = null) {
  return keepsResidentsConnectedAfter(platform, agent, removedId ? { remove: [{ id: removedId }] } : { add: [candidate] }, definition);
}
const blockKey = (cell) => `${cell.x},${cell.y},${cell.z}`;
const tileKey = (cell) => `${cell.x},${cell.y}`;
const coordinateText = (cells, limit = 3) => cells.slice(0, limit).map((cell) => `${cell.x}, ${cell.y}`).join('; ');
const blueprintSummary = ({ id, name, summary, footprint, block_count, block_types, entrances }) => ({ id, name, summary, footprint, block_count, block_types, doorways: entrances.length });

/**
 * The blueprint's absolute cells for one anchor, and the plot they must share. The footprint is
 * resolved before any rule is checked, so a plan can report where a blueprint would land even when
 * that spot is refused.
 */
function blueprintGeometry(agent, input) {
  const blueprint = blueprintById(typeof input?.blueprint === 'string' ? input.blueprint : '');
  if (!blueprint) return { issues: [{ status: 400, code: 'unknown-blueprint', message: 'Choose a listed construction blueprint.' }] };
  const anchor = { x: input.x, y: input.y }, { width, depth } = blueprint.footprint;
  if (!Number.isInteger(anchor.x) || !Number.isInteger(anchor.y) || anchor.x < 0 || anchor.y < 0 || anchor.x + width > FRONTIER_SIZE || anchor.y + depth > FRONTIER_SIZE) {
    return { blueprint, anchor, issues: [{ status: 400, code: 'outside-area', message: `Place the blueprint so its ${width} × ${depth} footprint stays inside this 48 × 48 area.` }] };
  }
  const cells = blueprint.cells.map((cell) => ({ x: anchor.x + cell.x, y: anchor.y + cell.y, z: cell.z, type: cell.type }));
  const plotIds = new Set(cells.map((cell) => frontierPlotId(agent.world_id, cell.x, cell.y)));
  return {
    issues: [], blueprint, anchor, definition: getWorldDefinition(agent.world_id), cells,
    doorways: blueprint.entrances.map((entrance) => ({ x: anchor.x + entrance.x, y: anchor.y + entrance.y })),
    plotId: plotIds.size === 1 ? [...plotIds][0] : null,
  };
}

/**
 * Read-only plan for one blueprint placement: every rule the server enforces on a single block,
 * judged over the whole finished structure before anything is written. No row is inserted, no
 * resident is moved, no action is recorded and no budget is spent, so a preview can report the
 * exact footprint, block count, access and ownership first.
 *
 * Checks run in this order, and the first failure is the refusal an apply reports:
 *   1 footprint bounds → 2 walkable ground → 3 own assigned plot → 4 build range →
 *   5 layers and palette → 6 shared access → 7 existing blocks → 8 resident tiles →
 *   9 escape rule → 10 doorways → 11 area block cap → 12 operator daily action budget.
 * Stages 9–12 judge only the work that is actually new, so replaying a finished blueprint is
 * never refused for a reason the finished structure cannot create.
 */
function blueprintPlan(platform, actor, agent, input) {
  const geometry = blueprintGeometry(agent, input);
  if (geometry.issues.length) return { ...geometry, report: null };
  const { blueprint, anchor, definition, cells, doorways, plotId } = geometry;
  const issues = [];
  const reject = (status, code, message) => issues.push({ status, code, message });
  const stewardship = platform.get('SELECT plot_id,account_id,purpose FROM land_stewardships WHERE account_id=?', actor.account.id) || null;
  const isMine = Boolean(stewardship && plotId && stewardship.plot_id === plotId);

  const blockedGround = cells.filter((cell) => !walkable(cell, definition));
  if (blockedGround.length) reject(409, 'blocked-tile', `Clear the site first: ${blockedGround.length} of the blueprint’s cells are not walkable ground (${coordinateText(blockedGround)}).`);
  if (!plotId) reject(403, 'out_of_plot', 'The whole blueprint must sit inside one 6 × 6 land plot. Choose an anchor that keeps its footprint inside a single plot.');
  else if (!isMine) {
    const granted = liveGrant(platform, actor, agent, plotId);
    reject(403, 'out_of_plot', granted ? 'Blueprints belong to the plot’s steward. A collaboration grant lets you place and remove single blocks inside its scope.' : stewardship ? 'Build inside your operator’s assigned land plot only.' : 'Build inside your operator’s assigned land plot. A signed-in human must first steward an available plot for a named purpose.');
  }
  const far = cells.filter((cell) => distance(agent, cell) > FRONTIER_LIMITS.build_range);
  if (far.length) reject(409, 'out-of-range', `Walk closer: ${far.length} of the blueprint’s cells are further than ${FRONTIER_LIMITS.build_range} tiles away (${coordinateText(far)}).`);
  const unsupported = cells.filter((cell) => !FRONTIER_PALETTE.includes(cell.type) || cell.z < 0 || cell.z > FRONTIER_LIMITS.maximum_z || cell.type === 'path' && cell.z !== 0);
  if (unsupported.length) reject(400, 'invalid-blueprint', 'This blueprint uses a block or layer the frontier palette does not allow.');
  const reserved = cells.filter((cell) => protectedTile(cell, definition));
  if (reserved.length) reject(409, 'shared-access', `Keep shared access clear: ${coordinateText(reserved)} is ${protectedReason(reserved[0], definition)}.`);

  const saved = new Map(platform.all('SELECT id,x,y,z,type,plot_id,creator_account_id,creator_agent_id FROM frontier_blocks WHERE world_id=? AND x>=? AND x<? AND y>=? AND y<?', agent.world_id, anchor.x, anchor.x + blueprint.footprint.width, anchor.y, anchor.y + blueprint.footprint.depth).map((block) => [blockKey(block), block]));
  const fresh = [], reused = [];
  for (const cell of cells) {
    const existing = saved.get(blockKey(cell));
    if (existing) {
      if (!existing.plot_id) reject(403, 'blocked-cell', `Legacy construction is preserved at ${cell.x}, ${cell.y}, layer ${cell.z}. Its builder or a human moderator must remove it first.`);
      else if (existing.creator_account_id !== actor.account.id) reject(403, 'blocked-cell', `Another builder’s block stands at ${cell.x}, ${cell.y}, layer ${cell.z}. Choose another spot.`);
      else if (existing.type !== cell.type) reject(409, 'blocked-cell', `Remove your own block at ${cell.x}, ${cell.y}, layer ${cell.z} before applying this blueprint.`);
      else reused.push({ cell, id: existing.id });
      continue;
    }
    if (cell.z > 0) {
      const belowKey = `${cell.x},${cell.y},${cell.z - 1}`, savedBelow = saved.get(belowKey);
      const below = savedBelow || cells.find((item) => blockKey(item) === belowKey);
      if (!below || !blockOccupiesTile(below.type) || savedBelow && savedBelow.creator_account_id !== actor.account.id) reject(409, 'unsupported-layer', `Layer ${cell.z} at ${cell.x}, ${cell.y} needs a solid block of your own directly below it.`);
    }
    fresh.push(cell);
  }
  const standing = new Set(platform.all("SELECT x,y FROM agents WHERE world_id=? AND status!='deleted'", agent.world_id).map((position) => tileKey(position)));
  const occupied = fresh.filter((cell) => blockOccupiesTile(cell.type) && standing.has(tileKey(cell)));
  if (occupied.length) reject(409, 'resident', `A resident is standing where the blueprint would be solid (${coordinateText(occupied)}). Ask them to step aside first.`);

  const additions = fresh.filter((cell) => blockOccupiesTile(cell.type));
  const rebuilt = fresh.length > 0;
  if (rebuilt && !issues.length && additions.length && !keepsResidentsConnectedAfter(platform, agent, { add: additions }, definition)) reject(409, 'trap', 'This blueprint would cut a resident off from the public passages.');
  const sectorBlocks = platform.get('SELECT COUNT(*) AS n FROM frontier_blocks WHERE world_id=?', agent.world_id).n;
  const today = actionsToday(platform, actor);
  let openDoorways = null;
  if (rebuilt && !issues.length) {
    const after = [...platform.all('SELECT x,y,z,type FROM frontier_blocks WHERE world_id=?', agent.world_id), ...fresh];
    const reachable = escapeColumns(definition, after, platform.all('SELECT x,y,type FROM world_objects WHERE world_id=?', agent.world_id));
    openDoorways = doorways.map((doorway) => ({ ...doorway, clear: reachable.has(tileKey(doorway)) }));
    const sealed = openDoorways.filter((doorway) => !doorway.clear);
    if (sealed.length) reject(409, 'blocked-doorway', `The doorway at ${sealed[0].x}, ${sealed[0].y} would open onto ground a resident cannot reach. Choose a spot with a clear entrance.`);
  }
  if (rebuilt && sectorBlocks + fresh.length > FRONTIER_LIMITS.blocks_per_sector) reject(429, 'area-capacity', `This area holds ${FRONTIER_LIMITS.blocks_per_sector} blocks and has ${Math.max(0, FRONTIER_LIMITS.blocks_per_sector - sectorBlocks)} left; the blueprint needs ${fresh.length}.`);
  if (rebuilt && today + fresh.length > FRONTIER_LIMITS.actions_per_operator_day) reject(429, 'budget', `This operator has ${Math.max(0, FRONTIER_LIMITS.actions_per_operator_day - today)} of the ${FRONTIER_LIMITS.actions_per_operator_day} daily frontier actions left; the blueprint needs ${fresh.length}.`);

  const report = {
    world_id: agent.world_id, blueprint: blueprintSummary(blueprint), anchor,
    footprint: { origin: { ...anchor }, width: blueprint.footprint.width, depth: blueprint.footprint.depth },
    cells: cells.map((cell) => ({ ...cell, occupies_tile: blockOccupiesTile(cell.type) })),
    layers: blueprint.layers.map((layer) => ({ z: layer.z, type: layer.type, cells: layer.cells.map((cell) => ({ x: anchor.x + cell.x, y: anchor.y + cell.y })) })),
    block_count: blueprint.block_count, block_types: blueprint.block_types,
    new_blocks: fresh.length, existing_blocks: reused.length, replay: !rebuilt,
    ownership: { plot_id: plotId, steward_account_id: stewardship?.account_id || null, is_mine: isMine, purpose: stewardship?.purpose || '', can_build: false, can_remove: isMine },
    access: { clear: !reserved.length && (!openDoorways || openDoorways.every((doorway) => doorway.clear)), shared_clear: !reserved.length, protected_cells: reserved.map((cell) => ({ x: cell.x, y: cell.y, reason: protectedReason(cell, definition) })), doorways: openDoorways },
    budgets: { actions_today: today, actions_per_operator_day: FRONTIER_LIMITS.actions_per_operator_day, actions_remaining: Math.max(0, FRONTIER_LIMITS.actions_per_operator_day - today), blocks_in_sector: sectorBlocks, blocks_per_sector: FRONTIER_LIMITS.blocks_per_sector, blocks_remaining: Math.max(0, FRONTIER_LIMITS.blocks_per_sector - sectorBlocks), interval_ready: intervalReady(platform, actor) },
    valid: issues.length === 0, issues, writes: 0,
  };
  report.ownership.can_build = report.valid && isMine;
  return { ...geometry, issues, fresh, reused, report };
}

/** Apply a validated plan to storage. Every rule is checked before the first write, and the write
 *  phase runs inside a savepoint, so a failure in the middle of a structure can leave no half-built
 *  shell — with or without a transaction the caller already opened. */
function blueprintApply(platform, actor, agent, plan) {
  const { blueprint, anchor, cells, fresh, reused, plotId } = plan;
  if (!fresh.length) return { world_id: agent.world_id, blueprint: blueprintSummary(blueprint), anchor, plot_id: plotId, applied: false, changed: false, replay: true, block_count: blueprint.block_count, new_blocks: 0, existing_blocks: reused.length, cells, writes: 0 };
  blockBudget(platform, actor, fresh.length);
  mutationBudget(platform, actor);
  const blocks = [];
  atomic(platform, () => {
    for (const cell of fresh) {
      const id = randomUUID();
      platform.run('INSERT INTO frontier_blocks(id,world_id,x,y,z,type,creator_agent_id,creator_account_id,created_at,plot_id) VALUES(?,?,?,?,?,?,?,?,?,?)', id, agent.world_id, cell.x, cell.y, cell.z, cell.type, agent.id, actor.account.id, timestamp(platform), plotId);
      blocks.push({ ...cell, id });
    }
    settleColumns(platform, agent.world_id, fresh);
    for (const block of blocks) recordAction(platform, actor, agent, agent.world_id, 'place');
    platform.audit(actor.account.id, 'frontier.blueprint_applied', `${blueprint.id} ${agent.world_id}`);
  });
  return {
    world_id: agent.world_id, blueprint: blueprintSummary(blueprint), anchor, plot_id: plotId,
    applied: true, changed: true, replay: false, block_count: blueprint.block_count,
    new_blocks: blocks.length, existing_blocks: reused.length, actions: blocks.length,
    cells, blocks, footprint: { origin: { ...anchor }, width: blueprint.footprint.width, depth: blueprint.footprint.depth },
    writes: blocks.length,
  };
}

/**
 * Remove a blueprint's structure: the plot's operator or a human moderator takes it down layer by
 * layer, top first. Every removal passes the shipped escape check and every touched column is
 * settled afterwards, so a resident standing on the structure descends instead of floating.
 */
function blueprintRemove(platform, actor, agent, input) {
  const geometry = blueprintGeometry(agent, input);
  if (geometry.issues.length) fail(geometry.issues[0].status, geometry.issues[0].message);
  const { blueprint, anchor, definition, cells, plotId } = geometry;
  const mayModerate = actor.kind === 'session' && ['admin', 'moderator'].includes(actor.account.role);
  const stewardship = plotId ? platform.get('SELECT account_id FROM land_stewardships WHERE plot_id=?', plotId) : null;
  if (!plotId || !mayModerate && (!stewardship || stewardship.account_id !== actor.account.id)) fail(403, 'Only the plot’s operator or a human moderator can remove this structure.');
  const saved = new Map(platform.all('SELECT id,x,y,z,type,plot_id,creator_account_id,creator_agent_id FROM frontier_blocks WHERE world_id=? AND x>=? AND x<? AND y>=? AND y<?', agent.world_id, anchor.x, anchor.x + blueprint.footprint.width, anchor.y, anchor.y + blueprint.footprint.depth).map((block) => [blockKey(block), block]));
  const found = cells.map((cell) => saved.get(blockKey(cell))).filter(Boolean);
  for (const block of found) {
    const owns = block.plot_id ? block.creator_account_id === actor.account.id : block.creator_agent_id === agent.id;
    if (!owns && !mayModerate) fail(403, 'Only the builder or a human moderator can remove this structure.');
    if (block.plot_id && block.plot_id !== plotId) fail(409, 'This block belongs to another plot and stays where it is.');
  }
  const description = { world_id: agent.world_id, blueprint: blueprintSummary(blueprint), anchor, plot_id: plotId, found_blocks: found.length, cells: cells.map((cell) => ({ ...cell, built: saved.has(blockKey(cell)) })) };
  if (input.preview === true) return { ...description, removed: false, changed: false, removed_blocks: 0, replay: false, writes: 0 };
  if (!found.length) return { ...description, removed: false, changed: false, removed_blocks: 0, replay: true, writes: 0 };
  if (!keepsResidentsConnectedAfter(platform, agent, { remove: found }, definition)) fail(409, 'Removing this structure would cut a resident off from the public passages.');
  blockBudget(platform, actor, found.length);
  mutationBudget(platform, actor);
  const ordered = [...found].sort((a, b) => b.z - a.z || b.y - a.y || b.x - a.x);
  atomic(platform, () => {
    for (const block of ordered) platform.run('DELETE FROM frontier_blocks WHERE id=?', block.id);
    settleColumns(platform, agent.world_id, ordered);
    for (const block of ordered) recordAction(platform, actor, agent, agent.world_id, 'remove');
    platform.audit(actor.account.id, 'frontier.blueprint_removed', `${blueprint.id} ${agent.world_id}`);
  });
  return { ...description, removed: true, changed: true, replay: false, removed_blocks: ordered.length, actions: ordered.length, blocks: ordered.map((block) => block.id), writes: ordered.length };
}
function blueprintAction(platform, actor, agent, input) {
  if (input.remove === true) return blueprintRemove(platform, actor, agent, input);
  const plan = blueprintPlan(platform, actor, agent, input);
  // A blueprint that cannot be placed anywhere has no footprint to describe: refuse the request
  // itself. Everything a plan can describe is reported, so a preview explains a refusal instead of
  // hiding it behind an error, and an apply refuses with the same reason.
  if (!plan.report) fail(plan.issues[0].status, plan.issues[0].message);
  if (input.preview === true) return plan.report;
  if (plan.issues.length) fail(plan.issues[0].status, plan.issues[0].message);
  return blueprintApply(platform, actor, agent, plan);
}
const parcelOccupied = 'EXISTS(SELECT 1 FROM frontier_blocks b WHERE b.world_id=p.world_id AND b.x>=p.x AND b.x<p.x+6 AND b.y>=p.y AND b.y<p.y+6)';
const landState = `CASE WHEN p.reserved=1 THEN 'reserved' WHEN f.world_id IS NULL THEN 'unopened' WHEN s.plot_id IS NOT NULL THEN 'assigned' WHEN ${parcelOccupied} THEN 'reserved' ELSE 'available' END`;
const landRows = `SELECT p.*,${landState} AS state,f.world_id AS opened_world,s.account_id,s.purpose,s.description,s.assigned_at,CASE WHEN a.status='active' THEN a.name ELSE NULL END AS steward_name,(SELECT COUNT(*) FROM frontier_blocks b WHERE b.world_id=p.world_id AND b.x>=p.x AND b.x<p.x+6 AND b.y>=p.y AND b.y<p.y+6) AS block_count FROM land_parcels p LEFT JOIN frontier_sectors f ON f.world_id=p.world_id LEFT JOIN land_stewardships s ON s.plot_id=p.id LEFT JOIN accounts a ON a.id=s.account_id`;
function plotId(value) {
  if (typeof value !== 'string' || value.length > 80) fail(400, 'Choose a canonical land plot address.');
  const match = /^plot:(-?\d+):(-?\d+):(\d+):(\d+)$/.exec(value);
  if (!match || !frontierCoordinates(`frontier:${Number(match[1])}:${Number(match[2])}`) || Number(match[3]) > 7 || Number(match[4]) > 7 || value !== `plot:${Number(match[1])}:${Number(match[2])}:${Number(match[3])}:${Number(match[4])}`) fail(400, 'Choose a canonical land plot address.');
  return value;
}
function landHuman(platform, actor) {
  platform.active();
  if (actor?.kind !== 'session' || !['admin', 'member', 'moderator', 'reviewer'].includes(actor.account?.role) || platform.get('SELECT status FROM accounts WHERE id=?', actor.account.id)?.status !== 'active') fail(403, 'Land stewardship requires an active signed-in human account.');
}
function strictLandInput(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) fail(400, 'Use only the land stewardship fields; payments and transfers are not supported.');
}
function landText(value, label, maximum, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(400, `${label} must contain 1–${maximum} characters.`);
  return value.trim();
}
function landBudget(platform, actor, assigning) {
  const latest = platform.get('SELECT created_at FROM land_events WHERE account_id=? ORDER BY created_at DESC LIMIT 1', actor.account.id);
  if (latest && platform.clock() - Date.parse(latest.created_at) < LAND_POLICY.action_interval_ms) fail(429, 'Allow a moment between stewardship actions.');
  if (assigning && platform.get("SELECT COUNT(*) AS n FROM land_events WHERE account_id=? AND action='assign' AND created_at>=?", actor.account.id, dayStart(platform)).n >= LAND_POLICY.assignments_per_operator_day) fail(429, 'This operator has reached the daily land assignment limit.');
}
function describePlot(row, actor) {
  const { account_id, opened_world, reserved, ...plot } = row;
  const isMine = Boolean(account_id && actor?.account?.id === account_id);
  return { ...plot, permanent_reserved: Boolean(reserved), reserved: plot.state === 'reserved', reserved_reason: plot.state === 'reserved' && !reserved ? 'Existing construction remains. Its builder or a human moderator must remove it before stewardship.' : plot.reserved_reason, opened: Boolean(opened_world), is_mine: isMine, address: `Area ${plot.sector_x}, ${plot.sector_y} · Plot ${plot.plot_x + 1}, ${plot.plot_y + 1}`, width_m: 6, height_m: 6, can_assign: actor?.kind === 'session' && plot.state === 'available' && plot.block_count === 0, can_release: actor?.kind === 'session' && isMine && plot.block_count === 0, purpose: plot.purpose || '', description: plot.description || '', stewardship_note: 'Virtual stewardship for a stated purpose. No purchase, property title, transfer or coin reward.' };
}

export const frontierMethods = {
  seedFrontier() {
    const definition = getWorldDefinition('frontier:0:0');
    this.run('INSERT OR IGNORE INTO worlds(id,name,kind,owner_agent_id,visibility,width,height,created_at) VALUES(?,?,?,NULL,?,?,?,?)', definition.id, definition.name, 'frontier', 'public', FRONTIER_SIZE, FRONTIER_SIZE, timestamp(this));
    this.run('INSERT OR IGNORE INTO frontier_sectors(world_id,sector_x,sector_y,creator_account_id,creator_agent_id,created_at) VALUES(?,0,0,NULL,NULL,?)', definition.id, timestamp(this));
    this.seedLand();
  },
  seedLand() {
    if (this.get('SELECT COUNT(*) AS n FROM land_parcels').n === LAND_WORLD.total_plots) return;
    const insert = this.db.prepare('INSERT OR IGNORE INTO land_parcels(id,world_id,sector_x,sector_y,plot_x,plot_y,x,y,width,height,area_m2,buildable_cells,reserved,reserved_reason) VALUES(?,?,?,?,?,?,?,?,6,6,36,?,?,?)');
    for (let sectorY = -8; sectorY <= 7; sectorY++) for (let sectorX = -8; sectorX <= 7; sectorX++) {
      const worldId = `frontier:${sectorX}:${sectorY}`, definition = getWorldDefinition(worldId);
      for (let plotY = 0; plotY < 8; plotY++) for (let plotX = 0; plotX < 8; plotX++) {
        const x = plotX * 6, y = plotY * 6;
        let buildable = 0, water = 0;
        for (let cellY = y; cellY < y + 6; cellY++) for (let cellX = x; cellX < x + 6; cellX++) {
          if (definition.terrain[cellY][cellX] === 'water') water++;
          if (walkable({ x: cellX, y: cellY }, definition) && !protectedTile({ x: cellX, y: cellY }, definition)) buildable++;
        }
        const reason = [3, 4].includes(plotX) || [3, 4].includes(plotY) ? 'Public crossroads, arrival areas and passages.' : water ? 'Water and shoreline habitat reserve.' : buildable < 24 ? 'Dense habitat reserve.' : '';
        insert.run(frontierPlotId(worldId, x, y), worldId, sectorX, sectorY, plotX, plotY, x, y, buildable, reason ? 1 : 0, reason);
      }
    }
    if (this.get('SELECT COUNT(*) AS n FROM land_parcels').n !== LAND_WORLD.total_plots) fail(503, 'The finite land registry is incomplete.');
  },
  landSummary() {
    const counts = this.get(`SELECT COUNT(*) AS gross,SUM(p.reserved) AS reserved,SUM(p.reserved) AS permanent_reserved,SUM(p.reserved=0) AS assignable,SUM(f.world_id IS NOT NULL) AS opened,SUM(s.plot_id IS NOT NULL) AS assigned,SUM((${landState})='available') AS available,SUM((${landState})='unopened') AS unopened,SUM(CASE WHEN p.reserved=0 AND f.world_id IS NOT NULL AND s.plot_id IS NULL THEN ${parcelOccupied} ELSE 0 END) AS occupied FROM land_parcels p LEFT JOIN frontier_sectors f ON f.world_id=p.world_id LEFT JOIN land_stewardships s ON s.plot_id=p.id`);
    const areas = this.all(`SELECT p.world_id,p.sector_x,p.sector_y,MAX(f.world_id IS NOT NULL) AS opened,SUM(s.plot_id IS NOT NULL) AS assigned_plots,SUM(p.reserved) AS reserved_plots,SUM((${landState})='available') AS available_plots,SUM(p.reserved=0) AS assignable_plots,SUM(CASE WHEN p.reserved=0 AND f.world_id IS NOT NULL AND s.plot_id IS NULL THEN ${parcelOccupied} ELSE 0 END) AS occupied_plots FROM land_parcels p LEFT JOIN frontier_sectors f ON f.world_id=p.world_id LEFT JOIN land_stewardships s ON s.plot_id=p.id GROUP BY p.world_id ORDER BY p.sector_y,p.sector_x`).map(area => ({ ...area, opened: Boolean(area.opened) }));
    return { counts: { ...counts, occupied_unassigned: counts.occupied, blocked_by_existing: counts.occupied, total: counts.gross, total_areas: areas.length, opened_areas: areas.filter(area => area.opened).length }, world: LAND_WORLD, areas, policy: LAND_POLICY };
  },
  land(actor, input = {}) {
    const offset = pageNumber(input.offset, 0, LAND_WORLD.total_plots), limit = pageNumber(input.limit, 25, 50);
    if (!limit) fail(400, 'Land page size must be positive.');
    const clauses = [], values = [];
    if (input.world_id) { if (!frontierCoordinates(input.world_id)) fail(400, 'Choose a finite world area.'); clauses.push('p.world_id=?'); values.push(input.world_id); }
    if (input.status) { if (!['reserved', 'unopened', 'available', 'assigned'].includes(input.status)) fail(400, 'Choose a land status.'); clauses.push(`${landState}=?`); values.push(input.status); }
    if (input.mine && input.mine !== '0') { if (!actor?.account) fail(401, 'Sign in to view your stewardship.'); clauses.push('s.account_id=?'); values.push(actor.account.id); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const base = ' FROM land_parcels p LEFT JOIN frontier_sectors f ON f.world_id=p.world_id LEFT JOIN land_stewardships s ON s.plot_id=p.id';
    const total = this.get(`SELECT COUNT(*) AS n${base}${where}`, ...values).n;
    const plots = this.all(`${landRows}${where} ORDER BY p.sector_y,p.sector_x,p.plot_y,p.plot_x LIMIT ? OFFSET ?`, ...values, limit, offset).map(row => describePlot(row, actor));
    const mine = actor?.account ? this.get(`${landRows} WHERE s.account_id=?`, actor.account.id) : null;
    return { ...this.landSummary(), plots, total, catalog_total: LAND_WORLD.total_plots, offset, limit, has_more: offset + limit < total, mine: mine ? describePlot(mine, actor) : null };
  },
  landPlot(actor, input) {
    const row = this.get(`${landRows} WHERE p.id=?`, plotId(input?.plot_id));
    if (!row) fail(404, 'Land plot not found.');
    return { plot: describePlot(row, actor), world: LAND_WORLD, policy: LAND_POLICY };
  },
  landAssign(actor, input) {
    landHuman(this, actor); strictLandInput(input, ['plot_id', 'purpose', 'description']);
    const id = plotId(input.plot_id), purpose = landText(input.purpose, 'Purpose', 120), description = landText(input.description, 'Description', 500, true);
    const owned = this.get('SELECT * FROM land_stewardships WHERE account_id=?', actor.account.id);
    if (owned) {
      if (owned.plot_id === id && owned.purpose === purpose && owned.description === description) return { ...this.landPlot(actor, { plot_id: id }), assigned: false, mine: this.landPlot(actor, { plot_id: id }).plot };
      fail(409, 'Each operator may steward one plot. Release an empty plot before choosing another purpose or place.');
    }
    const { plot } = this.landPlot(actor, { plot_id: id });
    if (plot.block_count) fail(409, 'Existing construction must be removed by its builder or a human moderator before this plot can be assigned.');
    if (plot.state !== 'available') fail(409, plot.state === 'unopened' ? 'Open this existing area through a neighboring passage before assigning a plot.' : 'This plot is reserved or already assigned.');
    landBudget(this, actor, true);
    this.run('INSERT INTO land_stewardships(plot_id,account_id,purpose,description,assigned_at) VALUES(?,?,?,?,?)', id, actor.account.id, purpose, description, timestamp(this));
    this.run('INSERT INTO land_events VALUES(?,?,?,?,?,?,?)', randomUUID(), id, actor.account.id, 'assign', purpose, description, timestamp(this));
    this.audit(actor.account.id, 'land.assigned', id);
    const result = this.landPlot(actor, { plot_id: id });
    return { ...result, assigned: true, mine: result.plot };
  },
  landRelease(actor, input) {
    landHuman(this, actor); strictLandInput(input, ['plot_id']);
    const id = plotId(input.plot_id), stewardship = this.get('SELECT * FROM land_stewardships WHERE plot_id=?', id);
    if (!stewardship) return { ...this.landPlot(actor, { plot_id: id }), released: false, mine: null };
    if (stewardship.account_id !== actor.account.id) fail(403, 'Only this plot’s human steward may release it.');
    const { plot } = this.landPlot(actor, { plot_id: id });
    if (plot.block_count) fail(409, 'Remove the plot’s construction before releasing its stewardship.');
    landBudget(this, actor, false);
    // A released plot cannot leave a guest holding access to land nobody stewards. The active grants
    // are revoked explicitly here — with their own history and audit entry — and the storage trigger
    // revokes any that a direct stewardship deletion (account removal) would otherwise leave behind.
    revokePlotGrants(this, id, actor);
    this.run('DELETE FROM land_stewardships WHERE plot_id=?', id);
    this.run('INSERT INTO land_events VALUES(?,?,?,?,?,?,?)', randomUUID(), id, actor.account.id, 'release', stewardship.purpose, stewardship.description, timestamp(this));
    this.audit(actor.account.id, 'land.released', id);
    return { ...this.landPlot(actor, { plot_id: id }), released: true, mine: null };
  },
  /**
   * The exact access about to be granted, before it exists: plot, purpose, guest, scope, duration
   * and expiry, computed from storage. It writes nothing at all, and it is available only to the
   * plot's own signed-in human steward — the same `landHuman` rule that owns every land decision.
   */
  plotGrantPreview(actor, input) {
    landHuman(this, actor); strictLandInput(input, grantFields);
    return planGrant(this, actor, input);
  },
  /** Create the grant. Human-controlled: a runtime credential is refused by `landHuman` here and by
   *  the route's own runtime refusal, and the storage trigger refuses a wider or nameless grant. */
  plotGrantCreate(actor, input) {
    landHuman(this, actor); strictLandInput(input, grantFields);
    const plan = planGrant(this, actor, input);
    // The panel asks the same route to preview first: a preview is one read of storage and no write
    // at all, so what the operator confirms is exactly what a create would record.
    if (input.preview === true) return plan;
    grantBudget(this, actor, plan.grant.plot_id);
    const id = randomUUID(), created = plan.grant.created_at;
    const detail = `${plan.grant.plot_id} · ${plan.grant.guest.name} · ${plan.grant.purpose}`.slice(0, 200);
    atomic(this, () => {
      if (plan.replaces) revokePlotGrants(this, plan.grant.plot_id, actor, plan.replaces);
      this.run("INSERT INTO plot_grants(id,plot_id,steward_account_id,guest_account_id,guest_agent_id,purpose,scope,expires_at,created_at,revoked_at,revoked_by,uses,last_used_at,status) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,0,'','active')", id, plan.grant.plot_id, actor.account.id, plan.grant.guest.account_id, plan.grant.guest.agent_id || '', plan.grant.purpose, JSON.stringify(plan.grant.scope), plan.grant.expires_at, created);
      this.run("INSERT INTO plot_grant_events(id,grant_id,plot_id,account_id,action,detail,created_at) VALUES(?,?,?,?,?,?,?)", randomUUID(), id, plan.grant.plot_id, actor.account.id, 'create', detail, created);
      this.audit(actor.account.id, 'land.grant_created', detail);
    });
    return { ...plan, grant: { ...plan.grant, id }, created: true, changed: true, writes: 1 };
  },
  /** Revoke it. Only the steward who created it, and only a signed-in human session. */
  plotGrantRevoke(actor, input) {
    landHuman(this, actor); strictLandInput(input, ['grant_id']);
    const id = typeof input.grant_id === 'string' && input.grant_id.length <= 80 ? input.grant_id : fail(400, 'Choose the collaboration grant to revoke.');
    const row = this.get('SELECT * FROM plot_grants WHERE id=?', id);
    if (!row) fail(404, 'Collaboration grant not found.');
    if (row.steward_account_id !== actor.account.id) fail(403, 'Only the steward who created this grant can revoke it.');
    const listing = grantListing(this, actor.account.id).as_steward.find((grant) => grant.id === id);
    if (row.status !== 'active') return { grant: listing, revoked: false, changed: false, writes: 0 };
    grantBudget(this, actor, row.plot_id);
    revokePlotGrants(this, row.plot_id, actor, id);
    return { grant: { ...listing, status: 'revoked', live: false }, revoked: true, changed: true, writes: 1 };
  },
  /** The collaboration record for one operator: grants it steward, grants it holds, and their
   *  append-only history. Human session only; nothing here is public. */
  plotGrants(actor, input = {}) {
    landHuman(this, actor);
    const plot = input.plot_id ? plotId(input.plot_id) : this.get('SELECT plot_id FROM land_stewardships WHERE account_id=?', actor.account.id)?.plot_id || null;
    const listing = grantListing(this, actor.account.id);
    return {
      ...listing,
      plot_id: plot,
      my_plot: plot ? this.landPlot(actor, { plot_id: plot }).plot : null,
      policy: PLOT_GRANT_POLICY, limits: GRANT_SCOPE_LIMITS, palette: FRONTIER_PALETTE, actions: [...GRANT_ACTIONS],
    };
  },
  frontierMap(actor, input = {}) {
    const offset = pageNumber(input.offset, 0, 1_000_000), limit = pageNumber(input.limit, 25, 50);
    if (!limit) fail(400, 'Frontier page size must be positive.');
    const finite = 'f.sector_x BETWEEN -8 AND 7 AND f.sector_y BETWEEN -8 AND 7';
    const total = this.get(`SELECT COUNT(*) AS n FROM frontier_sectors f WHERE ${finite}`).n;
    const sectors = this.all(`SELECT f.world_id,f.sector_x,f.sector_y,f.created_at,w.name,(SELECT COUNT(*) FROM frontier_blocks b WHERE b.world_id=f.world_id) AS block_count,CASE WHEN a.status!='deleted' THEN a.name ELSE NULL END AS builder_name FROM frontier_sectors f JOIN worlds w ON w.id=f.world_id LEFT JOIN agents a ON a.id=f.creator_agent_id WHERE ${finite} ORDER BY f.sector_y,f.sector_x LIMIT ? OFFSET ?`, limit, offset);
    return { sectors, total, finite_total: LAND_WORLD.total_areas, legacy_total: this.get('SELECT COUNT(*) AS n FROM frontier_sectors').n - total, offset, limit, has_more: offset + limit < total, seed_world_id: 'frontier:0:0', limits: FRONTIER_LIMITS, palette: FRONTIER_PALETTE, land_world: LAND_WORLD };
  },
  frontierView(worldId, camera, actor) {
    const sector = this.get('SELECT sector_x,sector_y,created_at FROM frontier_sectors WHERE world_id=?', worldId);
    if (!sector) return { blocks: [], frontier: null };
    const neighbors = frontierGates(worldId).map((gate) => ({ direction: gate.direction, x: gate.x, y: gate.y, target_world_id: gate.targetWorldId, exists: Boolean(this.get('SELECT world_id FROM frontier_sectors WHERE world_id=?', gate.targetWorldId)) }));
    const columns = camera.columns || COLS, rows = camera.rows || ROWS;
    const blocks = this.all("SELECT b.id,b.x,b.y,b.z,b.type,b.plot_id,b.creator_agent_id,b.created_at,CASE WHEN a.status!='deleted' THEN a.name ELSE NULL END AS builder_name FROM frontier_blocks b LEFT JOIN agents a ON a.id=b.creator_agent_id WHERE b.world_id=? AND b.x>=? AND b.x<? AND b.y>=? AND b.y<? ORDER BY b.y,b.x,b.z LIMIT 2048", worldId, camera.x, camera.x + columns, camera.y, camera.y + rows);
    const parcels = this.all(`${landRows} WHERE p.world_id=? ORDER BY p.plot_y,p.plot_x`, worldId).map(row => describePlot(row, actor));
    const myRow = actor?.account ? this.get(`${landRows} WHERE s.account_id=?`, actor.account.id) : null;
    const grants = actor?.account ? grantListing(this, actor.account.id) : { as_steward: [], as_guest: [], events: [] };
    return { blocks, block_window: { x: camera.x, y: camera.y, columns, rows }, frontier: { ...sector, legacy: !frontierCoordinates(worldId), neighbors, limits: FRONTIER_LIMITS, palette: FRONTIER_PALETTE, blueprints: BLUEPRINT_CATALOGUE, parcels, my_plot: myRow ? describePlot(myRow, actor) : null, grants: { ...grants, policy: PLOT_GRANT_POLICY, limits: GRANT_SCOPE_LIMITS }, land_world: LAND_WORLD, land_policy: LAND_POLICY, block_count: this.get('SELECT COUNT(*) AS n FROM frontier_blocks WHERE world_id=?', worldId).n } };
  },
  frontierExpand(actor, agentId, input) {
    const agent = resident(this, actor, agentId);
    expectedWorld(agent, input);
    if (!frontierCoordinates(agent.world_id)) fail(409, 'Legacy areas are preserved but cannot open land beyond the finite boundary.');
    const gate = frontierGates(agent.world_id).find((item) => item.direction === input.direction);
    if (!gate) fail(400, 'Choose an available frontier direction.');
    if (distance(agent, gate) > 2) fail(409, 'Walk to the matching frontier passage before expanding.');
    const existing = this.get('SELECT world_id,sector_x,sector_y,created_at FROM frontier_sectors WHERE world_id=?', gate.targetWorldId);
    if (existing) return { world_id: agent.world_id, target_world_id: existing.world_id, sector: existing, created: false, portal: { ...gate, target_world_id: gate.targetWorldId } };
    mutationBudget(this, actor);
    if (this.get('SELECT COUNT(*) AS n FROM frontier_sectors WHERE creator_account_id=? AND created_at>=? AND sector_x BETWEEN -8 AND 7 AND sector_y BETWEEN -8 AND 7', actor.account.id, dayStart(this)).n >= FRONTIER_LIMITS.expansions_per_operator_day) fail(429, 'This operator has reached the daily expansion limit.');
    if (this.get('SELECT COUNT(*) AS n FROM frontier_sectors WHERE sector_x BETWEEN -8 AND 7 AND sector_y BETWEEN -8 AND 7').n >= FRONTIER_LIMITS.sectors) fail(429, 'The shared frontier has reached its sector limit.');
    const coordinates = frontierCoordinates(gate.targetWorldId), definition = getWorldDefinition(gate.targetWorldId), created = timestamp(this);
    this.run('INSERT INTO worlds(id,name,kind,owner_agent_id,visibility,width,height,created_at) VALUES(?,?,?,NULL,?,?,?,?)', definition.id, definition.name, 'frontier', 'public', FRONTIER_SIZE, FRONTIER_SIZE, created);
    this.run('INSERT INTO frontier_sectors(world_id,sector_x,sector_y,creator_account_id,creator_agent_id,created_at) VALUES(?,?,?,?,?,?)', definition.id, coordinates.x, coordinates.y, actor.account.id, agent.id, created);
    recordAction(this, actor, agent, definition.id, 'expand');
    return { world_id: agent.world_id, target_world_id: definition.id, sector: { world_id: definition.id, sector_x: coordinates.x, sector_y: coordinates.y, created_at: created }, created: true, portal: { ...gate, target_world_id: gate.targetWorldId } };
  },
  frontierBuild(actor, agentId, input) {
    const agent = resident(this, actor, agentId);
    expectedWorld(agent, input);
    // A blueprint request is a whole structure, not one cell: it is planned and applied as a unit
    // before the single-block path below ever sees it.
    if (typeof input?.blueprint === 'string' && input.blueprint) return blueprintAction(this, actor, agent, input);
    const position = { x: input.x, y: input.y }, z = input.z === undefined ? 0 : input.z, definition = getWorldDefinition(agent.world_id);
    if (!Number.isInteger(position.x) || !Number.isInteger(position.y) || !Number.isInteger(z) || z < 0 || z > FRONTIER_LIMITS.maximum_z || !walkable(position, definition)) fail(400, 'Choose a clear frontier tile and a block layer from zero to seven.');
    if (distance(agent, position) > FRONTIER_LIMITS.build_range) fail(409, 'Walk closer before building.');
    const existing = this.get('SELECT * FROM frontier_blocks WHERE world_id=? AND x=? AND y=? AND z=?', agent.world_id, position.x, position.y, z);
    const mayModerate = actor.kind === 'session' && ['admin', 'moderator'].includes(actor.account.role);
    // The plot this tile belongs to, whether the acting account stewards it, and — when it does not
    // — the live collaboration grant that would allow this exact operator and resident to build
    // here. The grant is read from storage on every request, never carried on the credential.
    const parcelId = frontierPlotId(agent.world_id, position.x, position.y), stewardship = parcelId ? this.get('SELECT account_id,purpose FROM land_stewardships WHERE plot_id=?', parcelId) : null;
    const isSteward = Boolean(stewardship && stewardship.account_id === actor.account.id);
    const grant = !isSteward && parcelId ? liveGrant(this, actor, agent, parcelId) : null;
    if (input.remove === true) {
      if (!existing) return { world_id: agent.world_id, ...position, z, removed: false, changed: false };
      const ownsBlock = existing.plot_id ? existing.creator_account_id === actor.account.id : existing.creator_agent_id === agent.id;
      if (!ownsBlock && !mayModerate) fail(403, 'Only the builder or a human moderator can remove this block.');
      // Inside a live grant the scope also governs removal. A revoked or expired grant no longer
      // governs anything, but it still lets its own builder take their own block down: construction
      // may never be stranded on a plot, and a removal only ever reduces what that builder placed.
      requireGrantScope(grant, { action: 'remove', type: existing.type, z: existing.z });
      if (this.get('SELECT id FROM frontier_blocks WHERE world_id=? AND x=? AND y=? AND z>?', agent.world_id, position.x, position.y, z)) fail(409, 'Remove the upper blocks first.');
      if (blockOccupiesTile(existing.type) && !keepsResidentsConnected(this, agent, null, definition, existing.id)) fail(409, 'Removing this support would cut a resident off from the public passages. Open a climbable exit first.');
      mutationBudget(this, actor);
      this.run('DELETE FROM frontier_blocks WHERE id=?', existing.id);
      settleColumn(this, agent.world_id, position);
      recordAction(this, actor, agent, agent.world_id, 'remove');
      return { world_id: agent.world_id, ...position, z, removed: true, changed: true, grant_id: existing.grant_id || null };
    }
    if (protectedTile(position, definition)) fail(409, 'Keep the public passages and arrivals clear.');
    if (!isSteward && !grant) fail(403, 'Build inside your operator’s assigned land plot. A signed-in human must first steward an available plot for a named purpose, or that plot’s steward must grant you a live collaboration on it.');
    if (existing && !existing.plot_id) fail(403, 'Legacy construction is preserved for removal by its original builder or a human moderator.');
    const type = input.type || input.kind;
    if (!FRONTIER_PALETTE.includes(type) || type === 'path' && z !== 0) fail(400, 'Choose a supported block; paths belong on the ground.');
    requireGrantScope(grant, { action: 'place', type, z });
    if (existing) {
      if (existing.creator_account_id === actor.account.id && existing.type === type) return { world_id: agent.world_id, ...position, z, type, id: existing.id, plot_id: parcelId, grant_id: existing.grant_id || null, removed: false, changed: false };
      fail(existing.creator_account_id === actor.account.id ? 409 : 403, 'Remove your existing block before replacing it.');
    }
    if (z > 0) {
      const support = this.get('SELECT type,creator_account_id,plot_id FROM frontier_blocks WHERE world_id=? AND x=? AND y=? AND z=?', agent.world_id, position.x, position.y, z - 1);
      if (!support || support.type === 'path') fail(409, 'Stack a solid block directly below this layer first.');
      // A steward builds on their own foundation. A guest builds on the plot's own lawful
      // construction, because every block standing inside this plot belongs to it.
      if (isSteward ? support.creator_account_id !== actor.account.id : support.plot_id !== parcelId) fail(403, 'Build on your operator’s own plot foundation.');
    }
    if (blockOccupiesTile(type) && this.get("SELECT id FROM agents WHERE world_id=? AND x=? AND y=? AND status!='deleted'", agent.world_id, position.x, position.y)) fail(409, 'Keep occupied resident tiles clear.');
    if (blockOccupiesTile(type) && !keepsResidentsConnected(this, agent, { ...position, z, type }, definition)) fail(409, 'This block would cut a resident off from the public passages.');
    if (this.get('SELECT COUNT(*) AS n FROM frontier_blocks WHERE world_id=?', agent.world_id).n >= FRONTIER_LIMITS.blocks_per_sector) fail(429, 'This sector has reached its block limit.');
    mutationBudget(this, actor);
    const id = randomUUID();
    this.run('INSERT INTO frontier_blocks(id,world_id,x,y,z,type,creator_agent_id,creator_account_id,created_at,plot_id,grant_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, agent.world_id, position.x, position.y, z, type, agent.id, actor.account.id, timestamp(this), parcelId, grant?.id || null);
    settleColumn(this, agent.world_id, position);
    recordAction(this, actor, agent, agent.world_id, 'place');
    // The grant's own counter is bounded and live: the storage trigger re-checks the same standing
    // block count, so the two enforcement points cannot drift.
    if (grant) this.run('UPDATE plot_grants SET uses=uses+1,last_used_at=? WHERE id=?', timestamp(this), grant.id);
    return { world_id: agent.world_id, ...position, z, type, id, plot_id: parcelId, grant_id: grant?.id || null, removed: false, changed: true };
  },
  frontierExport(actor) {
    if (actor?.kind !== 'session') fail(403, 'Only your operator can export building records.');
    return {
      sectors: this.all('SELECT * FROM frontier_sectors WHERE creator_account_id=? ORDER BY created_at,world_id', actor.account.id),
      blocks: this.all('SELECT * FROM frontier_blocks WHERE creator_account_id=? ORDER BY created_at,id', actor.account.id),
      actions: this.all('SELECT * FROM frontier_actions WHERE account_id=? ORDER BY created_at,id', actor.account.id),
      stewardships: this.all('SELECT * FROM land_stewardships WHERE account_id=?', actor.account.id),
      land_events: this.all('SELECT * FROM land_events WHERE account_id=? ORDER BY created_at,id', actor.account.id),
      // The operator's own collaboration record: the grants it issued and the grants it holds, with
      // their append-only history. Nothing here is another operator's private record.
      grants: this.all('SELECT * FROM plot_grants WHERE steward_account_id=? OR guest_account_id=? ORDER BY created_at,id', actor.account.id, actor.account.id),
      grant_events: this.all('SELECT e.* FROM plot_grant_events e JOIN plot_grants g ON g.id=e.grant_id WHERE g.steward_account_id=? OR g.guest_account_id=? ORDER BY e.created_at,e.id', actor.account.id, actor.account.id),
    };
  },
};

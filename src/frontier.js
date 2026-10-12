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
export const LAND_BLOCK_GUARDS = `CREATE TRIGGER IF NOT EXISTS frontier_blocks_plot_insert BEFORE INSERT ON frontier_blocks WHEN NEW.plot_id IS NULL OR NOT EXISTS(SELECT 1 FROM land_parcels p JOIN land_stewardships s ON s.plot_id=p.id JOIN agents a ON a.id=NEW.creator_agent_id JOIN accounts o ON o.id=NEW.creator_account_id WHERE p.id=NEW.plot_id AND p.reserved=0 AND p.world_id=NEW.world_id AND NEW.x>=p.x AND NEW.x<p.x+6 AND NEW.y>=p.y AND NEW.y<p.y+6 AND s.account_id=NEW.creator_account_id AND a.operator_id=NEW.creator_account_id AND a.status='active' AND o.status='active') BEGIN SELECT RAISE(ABORT,'Building requires operator land stewardship'); END;`;

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
  else if (!isMine) reject(403, 'out_of_plot', stewardship ? 'Build inside your operator’s assigned land plot only.' : 'Build inside your operator’s assigned land plot. A signed-in human must first steward an available plot for a named purpose.');
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
    this.run('DELETE FROM land_stewardships WHERE plot_id=?', id);
    this.run('INSERT INTO land_events VALUES(?,?,?,?,?,?,?)', randomUUID(), id, actor.account.id, 'release', stewardship.purpose, stewardship.description, timestamp(this));
    this.audit(actor.account.id, 'land.released', id);
    return { ...this.landPlot(actor, { plot_id: id }), released: true, mine: null };
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
    return { blocks, block_window: { x: camera.x, y: camera.y, columns, rows }, frontier: { ...sector, legacy: !frontierCoordinates(worldId), neighbors, limits: FRONTIER_LIMITS, palette: FRONTIER_PALETTE, blueprints: BLUEPRINT_CATALOGUE, parcels, my_plot: myRow ? describePlot(myRow, actor) : null, land_world: LAND_WORLD, land_policy: LAND_POLICY, block_count: this.get('SELECT COUNT(*) AS n FROM frontier_blocks WHERE world_id=?', worldId).n } };
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
    if (input.remove === true) {
      if (!existing) return { world_id: agent.world_id, ...position, z, removed: false, changed: false };
      const ownsBlock = existing.plot_id ? existing.creator_account_id === actor.account.id : existing.creator_agent_id === agent.id;
      if (!ownsBlock && !mayModerate) fail(403, 'Only the builder or a human moderator can remove this block.');
      if (this.get('SELECT id FROM frontier_blocks WHERE world_id=? AND x=? AND y=? AND z>?', agent.world_id, position.x, position.y, z)) fail(409, 'Remove the upper blocks first.');
      if (blockOccupiesTile(existing.type) && !keepsResidentsConnected(this, agent, null, definition, existing.id)) fail(409, 'Removing this support would cut a resident off from the public passages. Open a climbable exit first.');
      mutationBudget(this, actor);
      this.run('DELETE FROM frontier_blocks WHERE id=?', existing.id);
      settleColumn(this, agent.world_id, position);
      recordAction(this, actor, agent, agent.world_id, 'remove');
      return { world_id: agent.world_id, ...position, z, removed: true, changed: true };
    }
    if (protectedTile(position, definition)) fail(409, 'Keep the public passages and arrivals clear.');
    const parcelId = frontierPlotId(agent.world_id, position.x, position.y), stewardship = parcelId ? this.get('SELECT account_id FROM land_stewardships WHERE plot_id=?', parcelId) : null;
    if (!stewardship || stewardship.account_id !== actor.account.id) fail(403, 'Build inside your operator’s assigned land plot. A signed-in human must first steward an available plot for a named purpose.');
    if (existing && !existing.plot_id) fail(403, 'Legacy construction is preserved for removal by its original builder or a human moderator.');
    const type = input.type || input.kind;
    if (!FRONTIER_PALETTE.includes(type) || type === 'path' && z !== 0) fail(400, 'Choose a supported block; paths belong on the ground.');
    if (existing) {
      if (existing.creator_account_id === actor.account.id && existing.type === type) return { world_id: agent.world_id, ...position, z, type, id: existing.id, plot_id: parcelId, removed: false, changed: false };
      fail(existing.creator_account_id === actor.account.id ? 409 : 403, 'Remove your existing block before replacing it.');
    }
    if (z > 0) {
      const support = this.get('SELECT type,creator_account_id,plot_id FROM frontier_blocks WHERE world_id=? AND x=? AND y=? AND z=?', agent.world_id, position.x, position.y, z - 1);
      if (!support || support.type === 'path') fail(409, 'Stack a solid block directly below this layer first.');
      if (support.creator_account_id !== actor.account.id || support.plot_id !== parcelId) fail(403, 'Build on your operator’s own plot foundation.');
    }
    if (blockOccupiesTile(type) && this.get("SELECT id FROM agents WHERE world_id=? AND x=? AND y=? AND status!='deleted'", agent.world_id, position.x, position.y)) fail(409, 'Keep occupied resident tiles clear.');
    if (blockOccupiesTile(type) && !keepsResidentsConnected(this, agent, { ...position, z, type }, definition)) fail(409, 'This block would cut a resident off from the public passages.');
    if (this.get('SELECT COUNT(*) AS n FROM frontier_blocks WHERE world_id=?', agent.world_id).n >= FRONTIER_LIMITS.blocks_per_sector) fail(429, 'This sector has reached its block limit.');
    mutationBudget(this, actor);
    const id = randomUUID();
    this.run('INSERT INTO frontier_blocks(id,world_id,x,y,z,type,creator_agent_id,creator_account_id,created_at,plot_id) VALUES(?,?,?,?,?,?,?,?,?,?)', id, agent.world_id, position.x, position.y, z, type, agent.id, actor.account.id, timestamp(this), parcelId);
    settleColumn(this, agent.world_id, position);
    recordAction(this, actor, agent, agent.world_id, 'place');
    return { world_id: agent.world_id, ...position, z, type, id, plot_id: parcelId, removed: false, changed: true };
  },
  frontierExport(actor) {
    if (actor?.kind !== 'session') fail(403, 'Only your operator can export building records.');
    return {
      sectors: this.all('SELECT * FROM frontier_sectors WHERE creator_account_id=? ORDER BY created_at,world_id', actor.account.id),
      blocks: this.all('SELECT * FROM frontier_blocks WHERE creator_account_id=? ORDER BY created_at,id', actor.account.id),
      actions: this.all('SELECT * FROM frontier_actions WHERE account_id=? ORDER BY created_at,id', actor.account.id),
      stewardships: this.all('SELECT * FROM land_stewardships WHERE account_id=?', actor.account.id),
      land_events: this.all('SELECT * FROM land_events WHERE account_id=? ORDER BY created_at,id', actor.account.id),
    };
  },
};

import { randomUUID } from 'node:crypto';
import { COLS, ROWS, FRONTIER_SIZE, FRONTIER_COORDINATE_LIMIT, FRONTIER_MIN_COORDINATE, FRONTIER_MAX_COORDINATE, FRONTIER_PLOT_SIZE, frontierCoordinates, frontierGates, frontierPlotId, getWorldDefinition, walkable } from '../world.js';

export const FRONTIER_PALETTE = Object.freeze(['stone', 'wood', 'glass', 'brick', 'sand', 'grass', 'path']);
export const FRONTIER_LIMITS = Object.freeze({ sector_size: FRONTIER_SIZE, coordinate_limit: FRONTIER_COORDINATE_LIMIT, minimum_coordinate: FRONTIER_MIN_COORDINATE, maximum_coordinate: FRONTIER_MAX_COORDINATE, sectors: 256, expansions_per_operator_day: 8, blocks_per_sector: 2048, actions_per_operator_day: 500, action_interval_ms: 200, build_range: 6, maximum_z: 7 });
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
function mutationBudget(platform, actor) {
  const latest = platform.get('SELECT created_at FROM frontier_actions WHERE account_id=? ORDER BY created_at DESC LIMIT 1', actor.account.id);
  if (latest && platform.clock() - Date.parse(latest.created_at) < FRONTIER_LIMITS.action_interval_ms) fail(429, 'Allow a moment between building actions.');
  if (platform.get('SELECT COUNT(*) AS n FROM frontier_actions WHERE account_id=? AND created_at>=?', actor.account.id, dayStart(platform)).n >= FRONTIER_LIMITS.actions_per_operator_day) fail(429, 'This operator has reached the daily frontier action limit.');
}
function recordAction(platform, actor, agent, worldId, action) {
  platform.run('INSERT INTO frontier_actions(id,account_id,agent_id,world_id,action,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), actor.account.id, agent.id, worldId, action, timestamp(platform));
  platform.run('UPDATE agents SET last_seen=? WHERE id=?', platform.clock(), agent.id);
  platform.audit(actor.account.id, `frontier.${action}`, worldId);
}
function protectedTile(position, definition) {
  return position.x >= 23 && position.x <= 25 || position.y >= 23 && position.y <= 25 || distance(position, definition.start) <= 2 || definition.portals.some((gate) => distance(position, gate) <= 2);
}
function blockedColumns(platform, worldId, candidate) {
  const blocked = new Set(platform.all("SELECT DISTINCT x,y FROM frontier_blocks WHERE world_id=? AND type!='path'", worldId).map(({ x, y }) => `${x},${y}`));
  if (candidate && candidate.type !== 'path') blocked.add(`${candidate.x},${candidate.y}`);
  return blocked;
}
function keepsResidentsConnected(platform, agent, candidate, definition) {
  const blocked = blockedColumns(platform, agent.world_id, candidate);
  const queue = [definition.start], seen = new Set([`${definition.start.x},${definition.start.y}`]);
  for (let index = 0; index < queue.length; index++) for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const position = { x: queue[index].x + dx, y: queue[index].y + dy }, key = `${position.x},${position.y}`;
    if (!seen.has(key) && !blocked.has(key) && walkable(position, definition)) { seen.add(key); queue.push(position); }
  }
  return platform.all("SELECT x,y FROM agents WHERE world_id=? AND status!='deleted'", agent.world_id).every((position) => seen.has(`${position.x},${position.y}`));
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
    return { blocks, block_window: { x: camera.x, y: camera.y, columns, rows }, frontier: { ...sector, legacy: !frontierCoordinates(worldId), neighbors, limits: FRONTIER_LIMITS, palette: FRONTIER_PALETTE, parcels, my_plot: myRow ? describePlot(myRow, actor) : null, land_world: LAND_WORLD, land_policy: LAND_POLICY, block_count: this.get('SELECT COUNT(*) AS n FROM frontier_blocks WHERE world_id=?', worldId).n } };
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
      mutationBudget(this, actor);
      this.run('DELETE FROM frontier_blocks WHERE id=?', existing.id);
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
    if (type !== 'path' && this.get("SELECT id FROM agents WHERE world_id=? AND x=? AND y=? AND status!='deleted'", agent.world_id, position.x, position.y)) fail(409, 'Keep occupied resident tiles clear.');
    if (type !== 'path' && !keepsResidentsConnected(this, agent, { ...position, type }, definition)) fail(409, 'This block would cut a resident off from the public passages.');
    if (this.get('SELECT COUNT(*) AS n FROM frontier_blocks WHERE world_id=?', agent.world_id).n >= FRONTIER_LIMITS.blocks_per_sector) fail(429, 'This sector has reached its block limit.');
    mutationBudget(this, actor);
    const id = randomUUID();
    this.run('INSERT INTO frontier_blocks(id,world_id,x,y,z,type,creator_agent_id,creator_account_id,created_at,plot_id) VALUES(?,?,?,?,?,?,?,?,?,?)', id, agent.world_id, position.x, position.y, z, type, agent.id, actor.account.id, timestamp(this), parcelId);
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

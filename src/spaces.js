import { randomUUID } from 'node:crypto';
import { getWorldDefinition, walkable, sharedWorldIds, COLS, ROWS, frontierGates } from '../world.js';
import { frontierMethods } from './frontier.js';
import { contributionSource, contributionEligibility } from './journey.js';
import { blockLayers, canStep, isGrounded, settle, surfaceAt } from './elevation.js';
import { GARDEN_PALETTE, HOUSE_PALETTE } from './placement-policy.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// The two authored build palettes live in content/palettes.json and are resolved once by
// src/placement-policy.js, which also derives the storage trigger that mirrors these checks.
const palette = GARDEN_PALETTE;
const housePalette = HOUSE_PALETTE;
const participantLimit = 200;
const publicFields = 'w.id,w.name,w.kind,w.owner_agent_id,w.visibility,w.width,w.height,a.name AS owner_name';
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
// `/move` and `/climb` call (actor, input); `/agents/:id/look` and `/agents/:id/climb` call (actor, agent_id, input).
const actionInput = (args) => args.length > 1 ? { ...args[1], agent_id: args[1]?.agent_id || args[0] } : args[0] || {};

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
    const viewerIds = actor ? actor.kind === 'runtime' ? [actor.agent.id] : this.all('SELECT id FROM agents WHERE operator_id=?', actor.account.id).map((a) => a.id) : [];
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
    const objects = this.all('SELECT id,type,x,y FROM world_objects WHERE world_id=? ORDER BY y,x', id).map((object) => ({ ...object, kind: object.type }));
    const portals = (definition.portals || []).filter((portal) => this.get('SELECT id FROM worlds WHERE id=?', portal.targetWorldId || portal.target_world_id)).map((portal) => ({ ...portal, target_world_id: portal.targetWorldId || portal.target_world_id, label: portal.name || portal.label }));
    const blockCenter = viewerAgent?.world_id === id ? viewerAgent : { x: camera.x + Math.floor(COLS / 2), y: camera.y + Math.floor(ROWS / 2) };
    const blockWindow = input.view === 'voxel' ? { x: Math.max(0, Math.min(world.width - 37, blockCenter.x - 18)), y: Math.max(0, Math.min(world.height - 37, blockCenter.y - 18)), columns: Math.min(37, world.width), rows: Math.min(37, world.height) } : camera;
    const frontierView = this.frontierView(id, blockWindow, actor);
    const ownHome = viewerAgent ? this.get("SELECT id,name,visibility FROM worlds WHERE owner_agent_id=? AND kind='home'", viewerAgent.id) : null;
    return { world: { ...world, description: definition.description || '', lore: definition.lore || '', ambiance: definition.ambiance || '' }, participants, agents: participants.map(({calling,...legacy})=>legacy), messages, camera, objects, portals, own_home: ownHome, build_palette: world.kind === 'house' ? housePalette : palette,
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
    const arrival = matchingGate ? { x: matchingGate.x, y: matchingGate.y } : exit ? { x: exit.x, y: exit.y } : position;
    const arrivalZ = surfaceAt(arrival.x, arrival.y, blockLayers(this.all("SELECT x,y,z FROM frontier_blocks WHERE world_id=? AND type!='path' AND x=? AND y=?", target.id, arrival.x, arrival.y)));
    this.run("UPDATE agents SET world_id=?,x=?,y=?,z=?,grounded=1,posture='standing',last_move=?,last_seen=? WHERE id=?", target.id, arrival.x, arrival.y, arrivalZ, this.clock(), this.clock(), agent.id);
    this.audit(actor.account.id, 'world.entered', target.id);
    this.recordVisit?.(actor, agent.id, target.id);
    return { ...arrival, z: arrivalZ, grounded: true, world_id: target.id, posture: 'standing', entered: true };
  },
  build(actor, agentId, input) {
    this.active(); const agent = this.ownedAgent(actor, agentId);
    if (agent.status !== 'active') fail(403, 'The agent is paused.');
    const world = this.space(actor, agent.world_id);
    if (world.owner_agent_id !== agent.id || !['home', 'house'].includes(world.kind)) fail(403, 'Build inside your own garden or cottage.');
    const position = { x: input.x, y: input.y }, definition = getWorldDefinition(world);
    if (!Number.isInteger(position.x) || !Number.isInteger(position.y) || !walkable(position, definition)) fail(400, 'Choose a buildable tile inside your garden.');
    if (Math.abs(position.x - definition.start.x) + Math.abs(position.y - definition.start.y) <= 1 || (definition.portals || []).some((p) => Math.abs(p.x - position.x) + Math.abs(p.y - position.y) <= 1)) fail(409, 'Keep the arrival and exit clear.');
    if (world.kind === 'house' && (definition.objects || []).some((object) => object.x === position.x && object.y === position.y)) fail(409, 'Keep the original cottage furniture clear.');
    if (input.remove === true) this.run('DELETE FROM world_objects WHERE world_id=? AND x=? AND y=?', world.id, position.x, position.y);
    else {
      const type = input.type || input.kind;
      if (!(world.kind === 'house' ? housePalette : palette).includes(type)) fail(400, 'Choose an item from the building palette.');
      if (!this.get('SELECT id FROM world_objects WHERE world_id=? AND x=? AND y=?', world.id, position.x, position.y) && this.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', world.id).n >= 200) fail(429, 'A home holds 200 placed items.');
      this.run('INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(world_id,x,y) DO UPDATE SET type=excluded.type', randomUUID(), world.id, type, position.x, position.y, new Date(this.clock()).toISOString());
    }
    this.audit(actor.account.id, input.remove === true ? `${world.kind === 'house' ? 'cottage' : 'garden'}.removed` : `${world.kind === 'house' ? 'cottage' : 'garden'}.built`, world.id);
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
    return { posture: input.posture };
  },
};

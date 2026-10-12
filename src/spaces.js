import { randomUUID } from 'node:crypto';
import { getWorldDefinition, move, walkable, sharedWorldIds, COLS, ROWS, frontierGates } from '../world.js';
import { frontierMethods } from './frontier.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const palette = Object.freeze(['cottage', 'tree', 'flowers', 'bench', 'farm', 'pond', 'lamp', 'path', 'fountain', 'bookshelf', 'table', 'lantern', 'sculpture', 'trellis', 'cushion']);
const housePalette = Object.freeze(['bookshelf', 'table', 'lantern', 'sculpture', 'cushion', 'bench', 'flowers']);
const publicFields = 'w.id,w.name,w.kind,w.owner_agent_id,w.visibility,w.width,w.height,a.name AS owner_name';
const date = () => new Date().toISOString();
const sharedIds = sharedWorldIds;
const quantity = (value, fallback, maximum) => {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > maximum) fail(400, 'Invalid pagination or camera coordinate.');
  return number;
};

export const spaceMethods = {
  ...frontierMethods,
  canReadMessage(actor, message) {
    if (message.status !== 'visible') return false;
    if (message.channel === 'public') {
      try { this.space(actor, message.world_id); return true; }
      catch (error) { if ([403, 404].includes(error.status)) return false; throw error; }
    }
    if (!actor) return false;
    if (message.channel === 'mission') return true;
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
    const shared = this.all(`SELECT ${publicFields},((SELECT COUNT(*) FROM agents WHERE world_id=w.id AND status!='deleted')+(SELECT COUNT(*) FROM npc_mayors WHERE world_id=w.id)) AS agent_count FROM worlds w LEFT JOIN agents a ON a.id=w.owner_agent_id WHERE w.owner_agent_id IS NULL AND w.kind!='frontier' ORDER BY w.id`);
    const homes = this.all(`SELECT ${publicFields},((SELECT COUNT(*) FROM agents WHERE world_id=w.id AND status!='deleted')+(SELECT COUNT(*) FROM npc_mayors WHERE world_id=w.id)) AS agent_count FROM worlds w JOIN agents a ON a.id=w.owner_agent_id JOIN accounts o ON o.id=a.operator_id WHERE ${condition} ORDER BY w.name,w.id LIMIT ? OFFSET ?`, owner, agentId, query, query, limit, offset);
    return { worlds: [...shared, ...homes], total, offset, limit, has_more: offset + limit < total, shared_count: shared.length };
  },
  world(actor, input = {}) {
    const viewerAgent = actor?.kind === 'runtime' ? this.get('SELECT * FROM agents WHERE id=?', actor.agent.id) : input.agent_id && actor ? this.ownedAgent(actor, input.agent_id) : null;
    const id = input.world_id || viewerAgent?.world_id || 'commons';
    const world = this.space(actor, id), definition = getWorldDefinition(world);
    const center = viewerAgent?.world_id === id ? viewerAgent : definition.start;
    const camera = { x: Math.min(Math.max(0, world.width - COLS), quantity(input.x, Math.max(0, center.x - Math.floor(COLS / 2)), world.width)), y: Math.min(Math.max(0, world.height - ROWS), quantity(input.y, Math.max(0, center.y - Math.floor(ROWS / 2)), world.height)) };
    const participants = this.all(`SELECT a.id,a.name,a.kind,a.operator_id,o.name AS operator,a.color,a.symbol,a.capabilities,a.limitations,a.status,a.verified,a.x,a.y,a.world_id,a.posture,a.last_seen,a.emote,a.emote_until,
      EXISTS(SELECT 1 FROM tokens t WHERE t.agent_id=a.id AND t.kind='runtime' AND t.revoked=0 AND t.expires_at>? AND t.used_calls<t.max_calls) AS has_session,
      (SELECT COUNT(*) FROM submissions s JOIN claims c ON c.id=s.claim_id WHERE c.agent_id=a.id AND s.status='accepted') AS accepted_contributions
      FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.world_id=? AND a.x>=? AND a.x<? AND a.y>=? AND a.y<? AND a.status!='deleted' AND o.status='active'
      ORDER BY CASE WHEN a.id=? THEN 0 ELSE 1 END,a.last_seen DESC,a.id LIMIT 200`, this.clock(), id, camera.x, camera.x + COLS, camera.y, camera.y + ROWS, viewerAgent?.id || '');
    const npcs=this.mayors(actor,{world_id:id}).mayors.filter(mayor=>mayor.x>=camera.x&&mayor.x<camera.x+COLS&&mayor.y>=camera.y&&mayor.y<camera.y+ROWS);
    participants.push(...npcs);
    const cosmetics = this.residentCosmetics?.(participants.map((participant) => participant.id));
    for (const participant of participants) {
      const cosmetic = cosmetics?.get ? cosmetics.get(participant.id) : cosmetics?.[participant.id];
      if (cosmetic) Object.assign(participant, { title: cosmetic.title, avatar: cosmetic.avatar });
      if(participant.kind==='npc'){participant.presence=participant.status==='active'?'resident':participant.status;continue;}
      participant.presence = participant.status !== 'active' ? participant.status : participant.has_session && this.clock() - participant.last_seen < 30000 ? 'connected' : this.clock() - participant.last_seen < 30000 ? 'recent_visit' : 'offline';
      delete participant.has_session;
    }
    const viewerIds = actor ? actor.kind === 'runtime' ? [actor.agent.id] : this.all('SELECT id FROM agents WHERE operator_id=?', actor.account.id).map((a) => a.id) : [];
    const messages = this.all("SELECT m.id,m.agent_id,m.account_id,m.channel,m.mission_id,m.recipients,m.text,m.created_at,m.world_id,COALESCE(a.name,o.name) AS author FROM messages m LEFT JOIN agents a ON a.id=m.agent_id JOIN accounts o ON o.id=m.account_id WHERE m.status='visible' AND (m.world_id=? OR m.channel IN ('private','mission')) ORDER BY m.created_at DESC LIMIT 200", id)
      .filter((m) => m.channel === 'public' && m.world_id === id || actor && m.channel === 'mission' || JSON.parse(m.recipients).some((recipient) => viewerIds.includes(recipient)))
      .reverse().map(({ recipients, ...message }) => message);
    const objects = this.all('SELECT id,type,x,y FROM world_objects WHERE world_id=? ORDER BY y,x', id).map((object) => ({ ...object, kind: object.type }));
    const portals = (definition.portals || []).filter((portal) => this.get('SELECT id FROM worlds WHERE id=?', portal.targetWorldId || portal.target_world_id)).map((portal) => ({ ...portal, target_world_id: portal.targetWorldId || portal.target_world_id, label: portal.name || portal.label }));
    const blockCenter = viewerAgent?.world_id === id ? viewerAgent : { x: camera.x + Math.floor(COLS / 2), y: camera.y + Math.floor(ROWS / 2) };
    const blockWindow = input.view === 'voxel' ? { x: Math.max(0, Math.min(world.width - 37, blockCenter.x - 18)), y: Math.max(0, Math.min(world.height - 37, blockCenter.y - 18)), columns: Math.min(37, world.width), rows: Math.min(37, world.height) } : camera;
    const frontierView = this.frontierView(id, blockWindow, actor);
    const ownHome = viewerAgent ? this.get("SELECT id,name,visibility FROM worlds WHERE owner_agent_id=? AND kind='home'", viewerAgent.id) : null;
    return { world: { ...world, description: definition.description || '', lore: definition.lore || '', ambiance: definition.ambiance || '' }, participants, agents: participants, messages, camera, objects, portals, own_home: ownHome, build_palette: world.kind === 'house' ? housePalette : palette,
      ...frontierView, terrain: definition.terrain.slice(camera.y, camera.y + ROWS).map((row) => row.slice(camera.x, camera.x + COLS)), landmarks: definition.landmarks || [],
      bounds: { columns: world.width, rows: world.height, width: world.width, height: world.height }, viewer_agent_id: viewerAgent?.id || null,
      counts: { registered_agents: this.get("SELECT COUNT(*) AS n FROM agents WHERE status!='deleted' AND kind='agent'").n, registered_humans: this.get("SELECT COUNT(*) AS n FROM agents WHERE status!='deleted' AND kind='human'").n, world_agents: this.get("SELECT COUNT(*) AS n FROM agents WHERE world_id=? AND status!='deleted'", id).n+this.get('SELECT COUNT(*) AS n FROM npc_mayors WHERE world_id=?',id).n, visible_agents: participants.length },
      paused: this.get("SELECT value FROM settings WHERE key='paused'").value === 'true' };
  },
  moveAgent(actor, input) {
    this.active(); const agent = this.ownedAgent(actor, input.agent_id || actor.agent?.id);
    if (agent.status !== 'active') fail(403, 'The agent is paused.');
    if (!['up', 'down', 'left', 'right'].includes(input.direction)) fail(400, 'Invalid movement direction.');
    if (this.clock() - agent.last_move < 120) fail(429, 'Move more slowly.');
    const crossing = frontierGates(agent.world_id).find((gate) => gate.direction === input.direction && gate.x === agent.x && gate.y === agent.y && this.get('SELECT world_id FROM frontier_sectors WHERE world_id=?', gate.targetWorldId));
    if (crossing) return this.travel(actor, agent.id, { world_id: crossing.targetWorldId });
    let position = move(agent, input.direction, getWorldDefinition(this.space(actor, agent.world_id)));
    if (this.get("SELECT id FROM world_objects WHERE world_id=? AND x=? AND y=? AND type IN ('cottage','tree','pond','fountain')", agent.world_id, position.x, position.y)) position = { x: agent.x, y: agent.y };
    if (this.get("SELECT id FROM frontier_blocks WHERE world_id=? AND x=? AND y=? AND type!='path'", agent.world_id, position.x, position.y)) position = { x: agent.x, y: agent.y };
    this.run("UPDATE agents SET x=?,y=?,posture='standing',last_move=?,last_seen=?,verified=CASE WHEN ?=1 THEN 1 ELSE verified END WHERE id=?", position.x, position.y, this.clock(), this.clock(), actor.kind === 'runtime' ? 1 : 0, agent.id);
    return { ...position, world_id: agent.world_id, posture: 'standing' };
  },
  travel(actor, agentId, input) {
    this.active(); const agent = this.ownedAgent(actor, agentId);
    if (agent.status !== 'active') fail(403, 'The agent is paused.');
    const target = this.space(actor, input.world_id || '');
    const current = getWorldDefinition(this.space(actor, agent.world_id));
    const portal = (current.portals || []).find((p) => (p.targetWorldId || p.target_world_id) === target.id && Math.abs(p.x - agent.x) + Math.abs(p.y - agent.y) <= 1);
    if (target.kind !== 'home' && !(agent.world_id.startsWith('home:') && target.id === 'commons') && !portal) fail(409, 'Walk to a doorway before entering.');
    if (this.clock() - agent.last_move < 120) fail(429, 'Travel more slowly.');
    const definition = getWorldDefinition(target), position = definition.start;
    // Return to the corresponding outdoor entrance when leaving an interior.
    const exit = target.id === 'commons' ? (definition.portals || []).find((p) => (p.targetWorldId || p.target_world_id) === agent.world_id) : null;
    const matchingGate = target.kind === 'frontier' ? frontierGates(target.id).find((gate) => gate.targetWorldId === agent.world_id) : null;
    const arrival = matchingGate ? { x: matchingGate.x, y: matchingGate.y } : exit ? { x: exit.x, y: exit.y } : position;
    this.run("UPDATE agents SET world_id=?,x=?,y=?,posture='standing',last_move=?,last_seen=? WHERE id=?", target.id, arrival.x, arrival.y, this.clock(), this.clock(), agent.id);
    this.audit(actor.account.id, 'world.entered', target.id);
    this.recordVisit?.(actor, agent.id, target.id);
    return { ...arrival, world_id: target.id, posture: 'standing', entered: true };
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
      this.run('INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(world_id,x,y) DO UPDATE SET type=excluded.type', randomUUID(), world.id, type, position.x, position.y, date());
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
      this.run('UPDATE agents SET world_id=?,x=?,y=? WHERE world_id IN (?,?) AND id!=?', 'commons', start.x, start.y, world.id, `house:${agentId}`, agentId);
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

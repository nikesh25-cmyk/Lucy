import { randomUUID } from 'node:crypto';
import { FRONTIER_LIMITS } from './frontier.js';
import { getWorldDefinition } from '../world.js';
import { CALLINGS } from './vocations.js';
import { INTERACTION_DISTANCE } from './camera-controls.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (value, label, maximum = 1000, optional = false) => {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(400, `${label} must contain 1–${maximum} characters.`);
  return value.trim();
};
const date = (platform) => new Date(platform.clock()).toISOString();
const visibleAgent = "a.status IN ('active','paused') AND o.status='active'";
const tables = { circle: 'community_circles', project: 'community_projects', event: 'community_events' };
const focuses = ['Climate', 'Peace', 'Accessibility', 'Learning', 'Creativity', 'Care'];
const pagination = (value, fallback, max) => {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) fail(400, 'Invalid community page size or offset.');
  return number;
};
export const normalizeSources = (sources = []) => {
  if (!Array.isArray(sources) || sources.length > 5) fail(400, 'Provide up to five supporting source links.');
  return sources.map((source) => {
    let url;
    try { url = new URL(source?.url); } catch { fail(400, 'A supporting source URL is invalid.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000) fail(400, 'Use an HTTP source URL without credentials.');
    return { url: url.href, location: text(source.location, 'Supporting page or section', 300) };
  });
};

// ---------------------------------------------------------------------------------------------
// One cooperative world restoration event.
//
// The Gathering Garden is an original peaceful multiplayer event: a public garden that two or more
// operators restore together. It is built on the world's own records on purpose. The event
// occurrence is one `community_events` row (a public place, a bounded start and end window,
// announced on the community board, cancellable through the shipped management path); explicit
// participation is one `community_rsvps` row per resident; and every step is measured by a saved
// server fact the world actually holds — an object standing on its planned tile, a real sowing, a
// real craft, or a circle membership another operator keeps. Nothing here is taken from a client
// claim or a model assertion, and this module stores no credit of its own: `restorationProgress()`
// derives the whole progress from those saved rows, so a replayed request, a refresh or a second
// read cannot credit a step twice. A pledge is a promise and is reported as one; it never advances
// a single step.
//
// What the event never does: it writes no `coin_rewards` row, grants no account role, no calling,
// no land, no moderator or reviewer authority, and no building right outside the plan's own tiles
// in the garden its own operator opened.
// ---------------------------------------------------------------------------------------------
const RESTORATION_PREFIX = 'restoration:';
export const RESTORATION_LIST = 8;
const RESTORATION_PARTICIPANTS = 24;
// The same one-tile adjacency the shipped direct interaction requires: a planned object is placed
// from beside its tile, never from across the garden.
const RESTORATION_DISTANCE = INTERACTION_DISTANCE;
// The world already throttles its mutations (120 ms for movement, 200 ms for frontier building).
// Event placements take the frontier's own interval; the garden's shipped `build()` route carries
// no interval, so this is a stated application of an existing limit, never a raised one.
const RESTORATION_INTERVAL_MS = FRONTIER_LIMITS.action_interval_ms;
const RESTORATION_CAPACITY = RESTORATION_PARTICIPANTS;

export const RESTORATION_ROLES = Object.freeze({
  grounds: Object.freeze({ id: 'grounds', label: 'Groundskeepers', callings: Object.freeze(['builder', 'steward']), work: 'carry the planned object to its own tile in the restored garden and place it there by hand.' }),
  growers: Object.freeze({ id: 'growers', label: 'Growers', callings: Object.freeze(['cultivator', 'artisan']), work: 'sow a real crop in your own garden; the shared beds are planted from the sowings recorded inside the window.' }),
  makers: Object.freeze({ id: 'makers', label: 'Makers', callings: Object.freeze(['artisan', 'cultivator']), work: 'craft a real keepsake at the workshop; the garden lanterns are made from the crafts recorded inside the window.' }),
  keepers: Object.freeze({ id: 'keepers', label: 'Keepers', callings: Object.freeze(['host', 'explorer', 'mediator', 'researcher']), work: 'join an active circle another operator keeps, so the restored garden stays open after the event.' }),
});
export const RESTORATION_FACTS = Object.freeze({
  garden_object: Object.freeze({ kind: 'garden_object', label: 'a saved garden object on its planned tile', saved_fact: 'a world_objects row this world holds on one planned tile of the restored garden' }),
  crop_plant: Object.freeze({ kind: 'crop_plant', label: 'a real sowing in the grower’s own garden', saved_fact: 'a journey_crops planting recorded inside the window, by a participating resident' }),
  craft: Object.freeze({ kind: 'craft', label: 'a crafted keepsake recorded after its ingredients were debited', saved_fact: 'a journey.crafted audit record by a participating resident’s operator' }),
  circle_join: Object.freeze({ kind: 'circle_join', label: 'membership of an active circle another operator keeps', saved_fact: 'a community_members row for a circle created by a different operator' }),
});
// The authored plan: four steps, four different kinds of saved work, and the tiles the finished
// garden will hold. A test asserts every tile is inside a garden, distinct, clear of the arrival
// and the doorways, and drawn from the sealed garden palette.
export const RESTORATION_PLAN = Object.freeze({
  slug: 'gathering-garden',
  title: 'The Gathering Garden',
  summary: 'Restore a shared garden: raise its gathering ground, sow its beds, light it, and leave it in the keeping of a circle.',
  narrative: 'A public garden went quiet. Its paths are still there and so is its doorway, but the gathering ground has no seats, the beds are bare and nothing lights the way after dusk. This is not a place to build alone: one resident cannot carry a table across a garden, and a garden with no keepers closes again as soon as its door is shut. So the work is shared. Groundskeepers carry the furniture to the tiles that were measured for it. Growers sow rows in their own gardens, and the shared beds are planted from what they sowed. Makers take the resources their own hands earned and turn them into the lanterns that hang there afterwards. Keepers bring the restored garden into a circle that another operator already tends, so it stays open when the event itself has ended. Every one of those four things is a saved act in this world: a placed object, a sowing, a craft, a membership. Nothing is credited for saying it will be done. When the last step is finished the garden is written once as it now stands, and it stays standing — after the window closes, after the operators sign out, and after the server restarts.',
  steps: Object.freeze([
    Object.freeze({
      id: 'ground', ordinal: 1, title: 'Lay the gathering ground', role: 'grounds', fact: 'garden_object', target: 3,
      instructions: 'Stand beside each measured tile in the restored garden and place the object the plan names for it. The object is saved in the world; the tile is only ever filled once.',
      output_name: 'Two benches and a table on their measured tiles',
      slots: Object.freeze([Object.freeze({ x: 9, y: 15, type: 'bench' }), Object.freeze({ x: 11, y: 15, type: 'table' }), Object.freeze({ x: 13, y: 15, type: 'bench' })]),
      assembles: Object.freeze([]),
    }),
    Object.freeze({
      id: 'beds', ordinal: 2, title: 'Sow the shared beds', role: 'growers', fact: 'crop_plant', target: 2,
      instructions: 'Sow a real crop on a crop patch in your own garden, then record the sowing here. The shared beds are planted from the sowings recorded inside the window.',
      output_name: 'Three planted beds in the restored garden',
      slots: Object.freeze([]),
      assembles: Object.freeze([Object.freeze({ x: 9, y: 18, type: 'flowers' }), Object.freeze({ x: 10, y: 18, type: 'flowers' }), Object.freeze({ x: 11, y: 18, type: 'flowers' })]),
    }),
    Object.freeze({
      id: 'light', ordinal: 3, title: 'Light the gathering', role: 'makers', fact: 'craft', target: 2,
      instructions: 'Craft a real keepsake at a crafting station from resources you actually gathered, then record the craft here. The garden lanterns are made from those crafts.',
      output_name: 'Two lanterns standing in the garden',
      slots: Object.freeze([]),
      assembles: Object.freeze([Object.freeze({ x: 9, y: 14, type: 'lantern' }), Object.freeze({ x: 13, y: 14, type: 'lantern' })]),
    }),
    Object.freeze({
      id: 'keep', ordinal: 4, title: 'Keep the garden open', role: 'keepers', fact: 'circle_join', target: 1,
      instructions: 'Join an active circle another operator keeps, then record it here. The restored garden is left in that keeping instead of closing again with the event.',
      output_name: 'A welcome stone marking the garden as kept',
      slots: Object.freeze([]),
      assembles: Object.freeze([Object.freeze({ x: 11, y: 14, type: 'sculpture' })]),
    }),
  ]),
});
export const RESTORATION_PLACEMENT_STEP = RESTORATION_PLAN.steps.find((step) => step.fact === 'garden_object');
export const RESTORATION_POLICY = Object.freeze({
  version: 1,
  window_hours: [1, 24],
  participants_max: RESTORATION_PARTICIPANTS,
  required_distance: RESTORATION_DISTANCE,
  mutation_interval_ms: RESTORATION_INTERVAL_MS,
  steps: RESTORATION_PLAN.steps.length,
  coins_awarded: 0,
  grants_calling: false,
  grants_land: false,
  grants_role: false,
  grants_moderator: false,
  grants_reviewer: false,
  progress: 'Every step is derived from saved server rows — an object on its planned tile, a sowing, a craft, a circle membership — so nothing a client, a model or a repeated request says can credit a step twice.',
  promise: 'Pledging to help is a promise, not work: it appears in the participant list and it never advances a single step.',
  writing: 'The only write a participant may make inside another operator’s garden is the plan’s own object on the plan’s own tile, while the restoration is open. Nothing else can be placed, moved or removed there.',
  description: 'The Gathering Garden is a bounded, opt-in restoration of one public garden. It writes no NemoCoin, grants no account role, no calling, no land, no building right beyond the plan’s tiles and no moderator or reviewer authority.',
});

export const COMMUNITY_TABLES = ['community_circles', 'community_members', 'community_projects', 'community_pledges', 'community_events', 'community_rsvps', 'community_thanks'];
export const COMMUNITY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS community_circles(id TEXT PRIMARY KEY,name TEXT NOT NULL,summary TEXT NOT NULL,focus TEXT NOT NULL,creator_agent_id TEXT NOT NULL REFERENCES agents(id),status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL,management_reason TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS community_members(circle_id TEXT NOT NULL REFERENCES community_circles(id),agent_id TEXT NOT NULL REFERENCES agents(id),joined_at TEXT NOT NULL,PRIMARY KEY(circle_id,agent_id));
  CREATE TABLE IF NOT EXISTS community_projects(id TEXT PRIMARY KEY,circle_id TEXT REFERENCES community_circles(id),title TEXT NOT NULL,summary TEXT NOT NULL,goal TEXT NOT NULL,evidence_requirements TEXT NOT NULL,creator_agent_id TEXT NOT NULL REFERENCES agents(id),milestones TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL,management_reason TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS community_pledges(project_id TEXT NOT NULL REFERENCES community_projects(id),agent_id TEXT NOT NULL REFERENCES agents(id),commitment TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,agent_id));
  CREATE TABLE IF NOT EXISTS community_events(id TEXT PRIMARY KEY,circle_id TEXT REFERENCES community_circles(id),title TEXT NOT NULL,summary TEXT NOT NULL,creator_agent_id TEXT NOT NULL REFERENCES agents(id),world_id TEXT NOT NULL REFERENCES worlds(id),starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,capacity INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',created_at TEXT NOT NULL,management_reason TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS community_rsvps(event_id TEXT NOT NULL REFERENCES community_events(id),agent_id TEXT NOT NULL REFERENCES agents(id),created_at TEXT NOT NULL,PRIMARY KEY(event_id,agent_id));
  CREATE TABLE IF NOT EXISTS community_thanks(id TEXT PRIMARY KEY,giver_account_id TEXT NOT NULL REFERENCES accounts(id),giver_agent_id TEXT NOT NULL REFERENCES agents(id),recipient_agent_id TEXT NOT NULL REFERENCES agents(id),day TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(giver_account_id,recipient_agent_id,day));
  CREATE INDEX IF NOT EXISTS community_circle_creator ON community_circles(creator_agent_id,status);
  CREATE INDEX IF NOT EXISTS community_member_agent ON community_members(agent_id,circle_id);
  CREATE INDEX IF NOT EXISTS community_project_creator ON community_projects(creator_agent_id,status);
  CREATE INDEX IF NOT EXISTS community_pledge_agent ON community_pledges(agent_id,project_id);
  CREATE INDEX IF NOT EXISTS community_event_schedule ON community_events(status,starts_at);
  CREATE INDEX IF NOT EXISTS community_rsvp_agent ON community_rsvps(agent_id,event_id);
  CREATE INDEX IF NOT EXISTS community_thanks_recipient ON community_thanks(recipient_agent_id,created_at);
  CREATE INDEX IF NOT EXISTS community_thanks_giver_day ON community_thanks(giver_account_id,day);
`;

export const communityMethods = {
  initCommunity() {
    this.db.exec(COMMUNITY_SCHEMA);
    for (const table of Object.values(tables)) if (!this.all(`PRAGMA table_info(${table})`).some((column) => column.name === 'management_reason')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN management_reason TEXT NOT NULL DEFAULT ''`);
  },
  communityAgent(actor, input = {}) {
    this.active();
    if (!actor || !['session', 'runtime'].includes(actor.kind)) fail(401, 'An operator or agent session is required.');
    const id = input.agent_id || actor.agent?.id;
    if (!id) fail(400, 'Select your agent character.');
    const agent = this.ownedAgent(actor, id);
    if (agent.status !== 'active' || actor.account.status !== 'active') fail(403, 'Resume an active character before participating.');
    return agent;
  },
  communityRecord(kind, id, activeOnly = false) {
    const record = this.get(`SELECT c.*,a.name AS creator_name,a.operator_id AS creator_operator_id FROM ${tables[kind]} c JOIN agents a ON a.id=c.creator_agent_id JOIN accounts o ON o.id=a.operator_id WHERE c.id=? AND ${visibleAgent}`, id || '');
    if (!record || (activeOnly && !['active', 'scheduled'].includes(record.status))) fail(404, 'This community record is unavailable.');
    return record;
  },
  communityEventSpace(actor, id, status = 400) {
    const world = this.space(actor, id);
    if (world.visibility !== 'public') fail(status, 'Gatherings require an available public space.');
    if (world.owner_agent_id) {
      const owner = this.get('SELECT a.status,o.status AS account_status FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.id=?', world.owner_agent_id);
      if (!owner || !['active', 'paused'].includes(owner.status) || owner.account_status !== 'active') fail(status, 'This gathering space is unavailable.');
    }
    return world;
  },
  communityCircleMember(circleId, agentId) {
    this.communityRecord('circle', circleId, true);
    if (!this.get('SELECT agent_id FROM community_members WHERE circle_id=? AND agent_id=?', circleId, agentId)) fail(403, 'Join this circle first.');
  },
  communityQuota(agent, table, maximum) {
    const currentEvent = table === 'community_events' ? ' AND c.ends_at>?' : '';
    const count = this.get(`SELECT COUNT(*) AS n FROM ${table} c JOIN agents a ON a.id=c.creator_agent_id WHERE a.operator_id=? AND c.status IN ('active','scheduled')${currentEvent}`, agent.operator_id, ...(currentEvent ? [date(this)] : [])).n;
    if (count >= maximum) fail(429, 'This operator has reached the active community record limit.');
  },
  communityProjectView(record, viewerId = '') {
    const milestones = JSON.parse(record.milestones);
    const ids = new Set(milestones.flatMap((m) => [m.submitted_by_agent_id, m.approved_by_agent_id]).filter(Boolean));
    const names = new Map();
    for (const id of ids) names.set(id, this.get("SELECT name FROM agents WHERE id=? AND status IN ('active','paused')", id)?.name || 'Former participant');
    const pledges = this.all(`SELECT a.id,a.name,p.commitment FROM community_pledges p JOIN agents a ON a.id=p.agent_id JOIN accounts o ON o.id=a.operator_id WHERE p.project_id=? AND ${visibleAgent} ORDER BY p.created_at,a.id LIMIT 100`, record.id);
    const { creator_operator_id, ...safe } = record;
    return { ...safe, pledged: pledges.some((p) => p.id === viewerId), pledges, milestones: milestones.map((m) => ({ ...m, submitted_by: names.get(m.submitted_by_agent_id) || null, approved_by: names.get(m.approved_by_agent_id) || null })) };
  },
  community(actor, input = {}) {
    const limit = pagination(input.limit, 20, 50), offset = pagination(input.offset, 0, 1000000);
    if (!limit) fail(400, 'Community page size must be positive.');
    const query = input.q == null ? '' : text(input.q, 'Community search', 80, true);
    let viewerId = actor?.kind === 'runtime' ? actor.agent.id : '';
    if (input.agent_id) {
      if (!actor) fail(401, 'Sign in to select your character.');
      viewerId = this.ownedAgent(actor, input.agent_id).id;
    }
    const counts = {}, lists = {};
    for (const [kind, table] of Object.entries(tables)) {
      const label = kind === 'circle' ? 'name' : 'title';
      const state = kind === 'event' ? "c.status='scheduled'" : kind === 'project' ? "c.status IN ('active','completed')" : "c.status='active'";
      const circleVisible = kind === 'circle' ? '' : ` AND (c.circle_id IS NULL OR EXISTS(SELECT 1 FROM community_circles parent JOIN agents pa ON pa.id=parent.creator_agent_id JOIN accounts po ON po.id=pa.operator_id WHERE parent.id=c.circle_id AND parent.status='active' AND pa.status IN ('active','paused') AND po.status='active'))`;
      const eventVisible = kind === 'event' ? " AND c.ends_at>? AND EXISTS(SELECT 1 FROM worlds ew LEFT JOIN agents wa ON wa.id=ew.owner_agent_id LEFT JOIN accounts wo ON wo.id=wa.operator_id WHERE ew.id=c.world_id AND ew.visibility='public' AND (ew.owner_agent_id IS NULL OR (wa.status IN ('active','paused') AND wo.status='active')))" : '';
      const cutoff = kind === 'event' ? new Date(this.clock() - 30 * 86400000).toISOString() : null;
      const filter = `${visibleAgent} AND ${state}${circleVisible}${eventVisible} AND (instr(lower(c.${label}),lower(?))>0 OR instr(lower(c.summary),lower(?))>0)`;
      const args = cutoff === null ? [query, query] : [cutoff, query, query];
      counts[`${kind}s`] = this.get(`SELECT COUNT(*) AS n FROM ${table} c JOIN agents a ON a.id=c.creator_agent_id JOIN accounts o ON o.id=a.operator_id WHERE ${filter}`, ...args).n;
      lists[kind] = this.all(`SELECT c.*,a.name AS creator_name FROM ${table} c JOIN agents a ON a.id=c.creator_agent_id JOIN accounts o ON o.id=a.operator_id WHERE ${filter} ORDER BY ${kind === 'event' ? 'c.starts_at ASC' : 'c.created_at DESC'},c.id LIMIT ? OFFSET ?`, ...args, limit, offset);
    }
    const circles = lists.circle.map((circle) => {
      const members = this.all(`SELECT a.id,a.name FROM community_members m JOIN agents a ON a.id=m.agent_id JOIN accounts o ON o.id=a.operator_id WHERE m.circle_id=? AND ${visibleAgent} ORDER BY m.joined_at,a.id LIMIT 100`, circle.id);
      return { ...circle, members, member_count: members.length, joined: members.some((a) => a.id === viewerId) };
    });
    const projects = lists.project.map((project) => this.communityProjectView(project, viewerId));
    const events = lists.event.map((event) => {
      const attendees = this.all(`SELECT a.id,a.name FROM community_rsvps r JOIN agents a ON a.id=r.agent_id JOIN accounts o ON o.id=a.operator_id WHERE r.event_id=? AND ${visibleAgent} ORDER BY r.created_at,a.id LIMIT 100`, event.id);
      return { ...event, attendees, attendee_count: attendees.length, reserved_count: this.get('SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=?', event.id).n, rsvped: attendees.some((a) => a.id === viewerId) };
    });
    const thanksFilter = "g.status IN ('active','paused') AND r.status IN ('active','paused') AND go.status='active' AND ro.status='active'";
    counts.thanks = this.get(`SELECT COUNT(*) AS n FROM community_thanks t JOIN agents g ON g.id=t.giver_agent_id JOIN agents r ON r.id=t.recipient_agent_id JOIN accounts go ON go.id=g.operator_id JOIN accounts ro ON ro.id=r.operator_id WHERE ${thanksFilter}`).n;
    const thanks = this.all(`SELECT t.id,t.giver_agent_id,t.recipient_agent_id,t.reason,t.created_at,g.name AS giver_name,r.name AS recipient_name FROM community_thanks t JOIN agents g ON g.id=t.giver_agent_id JOIN agents r ON r.id=t.recipient_agent_id JOIN accounts go ON go.id=g.operator_id JOIN accounts ro ON ro.id=r.operator_id WHERE ${thanksFilter} ORDER BY t.created_at DESC,t.id LIMIT ? OFFSET ?`, limit, offset);
    return { circles, projects, events, thanks, counts, viewer_agent_id: viewerId || null, pagination: { offset, limit, has_more: Object.values(counts).some((n) => offset + limit < n) } };
  },
  createCircle(actor, input) {
    const agent = this.communityAgent(actor, input);
    this.communityQuota(agent, 'community_circles', 5);
    if (this.get('SELECT COUNT(*) AS n FROM community_members WHERE agent_id=?', agent.id).n >= 12) fail(429, 'A character can join twelve circles.');
    const name = text(input.name, 'Circle name', 80), summary = text(input.summary, 'Circle purpose', 1200), focus = input.focus || 'Care';
    if (!focuses.includes(focus)) fail(400, 'Choose a community focus.');
    const id = randomUUID(), created = date(this);
    this.run('INSERT INTO community_circles VALUES(?,?,?,?,?,?,?,?)', id, name, summary, focus, agent.id, 'active', created, '');
    this.run('INSERT INTO community_members VALUES(?,?,?)', id, agent.id, created);
    this.audit(actor.account.id, 'circle.created', id);
    return { id, name, summary, focus, creator_agent_id: agent.id, creator_name: agent.name, status: 'active', created_at: created, joined: true, member_count: 1 };
  },
  circleMembership(actor, input) {
    const agent = this.communityAgent(actor, input), circle = this.communityRecord('circle', input.circle_id, true);
    if (!['join', 'leave'].includes(input.action)) fail(400, 'Choose join or leave.');
    const existing = this.get('SELECT agent_id FROM community_members WHERE circle_id=? AND agent_id=?', circle.id, agent.id);
    if (input.action === 'join' && !existing) {
      if (this.get('SELECT COUNT(*) AS n FROM community_members WHERE circle_id=?', circle.id).n >= 100) fail(409, 'This circle is full.');
      if (this.get('SELECT COUNT(*) AS n FROM community_members WHERE agent_id=?', agent.id).n >= 12) fail(429, 'A character can join twelve circles.');
      this.run('INSERT INTO community_members VALUES(?,?,?)', circle.id, agent.id, date(this));
      this.audit(actor.account.id, 'circle.joined', circle.id);
    }
    if (input.action === 'leave' && existing) { this.run('DELETE FROM community_members WHERE circle_id=? AND agent_id=?', circle.id, agent.id); this.audit(actor.account.id, 'circle.left', circle.id); }
    return { circle_id: circle.id, joined: input.action === 'join' };
  },
  createProject(actor, input) {
    const agent = this.communityAgent(actor, input);
    this.communityQuota(agent, 'community_projects', 10);
    const circleId = input.circle_id || null;
    if (circleId) this.communityCircleMember(circleId, agent.id);
    const title = text(input.title, 'Project title', 100), summary = text(input.summary, 'Project purpose', 1200), goal = text(input.goal, 'Shared outcome', 500), requirements = text(input.evidence_requirements, 'Evidence requirements', 1200);
    const titles = input.milestones || [goal];
    if (!Array.isArray(titles) || !titles.length || titles.length > 8) fail(400, 'Provide one to eight milestones.');
    const milestones = titles.map((value) => ({ id: randomUUID(), title: text(value, 'Milestone title', 500), status: 'open', evidence: '', sources: [] }));
    const id = randomUUID(), created = date(this);
    this.run('INSERT INTO community_projects VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, circleId, title, summary, goal, requirements, agent.id, JSON.stringify(milestones), 'active', created, '');
    this.run('INSERT INTO community_pledges VALUES(?,?,?,?)', id, agent.id, 'Coordinate the shared outcome.', created);
    this.audit(actor.account.id, 'project.created', id);
    return this.communityProjectView(this.communityRecord('project', id), agent.id);
  },
  projectPledge(actor, input) {
    const agent = this.communityAgent(actor, input), project = this.communityRecord('project', input.project_id, true);
    if (!['pledge', 'unpledge'].includes(input.action)) fail(400, 'Choose pledge or unpledge.');
    if (project.circle_id && input.action === 'pledge') this.communityCircleMember(project.circle_id, agent.id);
    const existing = this.get('SELECT agent_id FROM community_pledges WHERE project_id=? AND agent_id=?', project.id, agent.id);
    if (input.action === 'pledge') {
      const commitment = text(input.commitment, 'Contribution commitment', 500);
      if (!existing && this.get('SELECT COUNT(*) AS n FROM community_pledges WHERE project_id=?', project.id).n >= 100) fail(409, 'This project has reached its participant limit.');
      this.run('INSERT INTO community_pledges VALUES(?,?,?,?) ON CONFLICT(project_id,agent_id) DO UPDATE SET commitment=excluded.commitment', project.id, agent.id, commitment, date(this));
      this.audit(actor.account.id, 'project.pledged', project.id);
    } else if (existing) { this.run('DELETE FROM community_pledges WHERE project_id=? AND agent_id=?', project.id, agent.id); this.audit(actor.account.id, 'project.unpledged', project.id); }
    return { project_id: project.id, pledged: input.action === 'pledge' };
  },
  projectMilestone(actor, input) {
    const agent = this.communityAgent(actor, input), project = this.communityRecord('project', input.project_id, true);
    const milestones = JSON.parse(project.milestones), milestone = milestones.find((m) => m.id === input.milestone_id);
    if (!milestone) fail(404, 'Milestone not found.');
    if (!['submit', 'approve', 'changes_requested'].includes(input.action)) fail(400, 'Choose a milestone submission or peer review.');
    if (input.action === 'submit') {
      if (!this.get('SELECT agent_id FROM community_pledges WHERE project_id=? AND agent_id=?', project.id, agent.id)) fail(403, 'Pledge a contribution before submitting.');
      if (!['open', 'changes_requested'].includes(milestone.status)) fail(409, 'This milestone is awaiting review or is already approved.');
      if (project.circle_id) this.communityCircleMember(project.circle_id, agent.id);
      Object.assign(milestone, { status: 'submitted', evidence: text(input.evidence, 'Contribution evidence', 4000), sources: normalizeSources(input.sources), submitted_by_agent_id: agent.id, submitted_at: date(this), review_note: '' });
      delete milestone.approved_by_agent_id; delete milestone.approved_at;
    } else {
      if (milestone.status !== 'submitted') fail(409, 'This milestone is not awaiting peer review.');
      const submitter = this.get('SELECT a.operator_id,a.status,o.status AS operator_status FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.id=?', milestone.submitted_by_agent_id);
      if (!submitter || !['active', 'paused'].includes(submitter.status) || submitter.operator_status !== 'active') fail(409, 'The submitting character is unavailable.');
      if ([submitter.operator_id, project.creator_operator_id].includes(actor.account.id)) fail(403, 'An independent operator must review this contribution.');
      const reason = text(input.reason, 'Peer review reason', 1000);
      milestone.status = input.action === 'approve' ? 'approved' : 'changes_requested';
      milestone.review_note = reason;
      if (input.action === 'approve') Object.assign(milestone, { approved_by_agent_id: agent.id, approved_at: date(this) });
    }
    const status = milestones.every((m) => m.status === 'approved') ? 'completed' : 'active';
    this.run('UPDATE community_projects SET milestones=?,status=? WHERE id=?', JSON.stringify(milestones), status, project.id);
    this.audit(actor.account.id, `project.milestone.${input.action}`, project.id);
    return this.communityProjectView(this.communityRecord('project', project.id), agent.id);
  },
  createEvent(actor, input) {
    const agent = this.communityAgent(actor, input);
    this.communityQuota(agent, 'community_events', 10);
    const circleId = input.circle_id || null;
    if (circleId) this.communityCircleMember(circleId, agent.id);
    const title = text(input.title, 'Gathering title', 100), summary = text(input.summary, 'Gathering purpose', 1200);
    const timestamp = (value) => {
      if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400, 'Gathering times require ISO dates with an explicit timezone.');
      const [year, month, day, hours, minutes] = value.slice(0, 16).split(/[-T:]/).map(Number);
      const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hours > 23 || minutes > 59 || Number(value.slice(17, 19)) > 59) fail(400, 'Gathering time is not a valid calendar date.');
      return Date.parse(value);
    };
    const starts = timestamp(input.starts_at), ends = timestamp(input.ends_at);
    if (starts <= this.clock() || starts > this.clock() + 365 * 86400000 || ends <= starts || ends - starts > 86400000) fail(400, 'Schedule a future gathering within a year, lasting at most one day.');
    const capacity = input.capacity ?? 20;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) fail(400, 'Gatherings allow one to one hundred characters.');
    const world = this.communityEventSpace(actor, input.world_id || 'commons');
    const id = randomUUID(), created = date(this);
    this.run('INSERT INTO community_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, circleId, title, summary, agent.id, world.id, new Date(starts).toISOString(), new Date(ends).toISOString(), capacity, 'scheduled', created, '');
    this.run('INSERT INTO community_rsvps VALUES(?,?,?)', id, agent.id, created);
    this.audit(actor.account.id, 'event.created', id);
    const record = this.communityRecord('event', id); delete record.creator_operator_id;
    return { ...record, rsvped: true, attendee_count: 1 };
  },
  eventRSVP(actor, input) {
    const agent = this.communityAgent(actor, input), event = this.communityRecord('event', input.event_id, true);
    if (!['join', 'cancel'].includes(input.action)) fail(400, 'Choose join or cancel.');
    if (input.action === 'join') this.communityEventSpace(actor, event.world_id, 409);
    const existing = this.get('SELECT agent_id FROM community_rsvps WHERE event_id=? AND agent_id=?', event.id, agent.id);
    if (input.action === 'join' && !existing) {
      if (Date.parse(event.starts_at) <= this.clock()) fail(409, 'This gathering has already started.');
      this.space(actor, event.world_id);
      if (event.circle_id) this.communityCircleMember(event.circle_id, agent.id);
      const count = this.get('SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=?', event.id).n;
      if (count >= event.capacity) fail(409, 'This gathering is full.');
      this.run('INSERT INTO community_rsvps VALUES(?,?,?)', event.id, agent.id, date(this));
      this.audit(actor.account.id, 'event.rsvp', event.id);
    } else if (input.action === 'cancel' && existing) { this.run('DELETE FROM community_rsvps WHERE event_id=? AND agent_id=?', event.id, agent.id); this.audit(actor.account.id, 'event.rsvp_cancelled', event.id); }
    return { event_id: event.id, rsvped: input.action === 'join', attendee_count: this.get(`SELECT COUNT(*) AS n FROM community_rsvps r JOIN agents a ON a.id=r.agent_id JOIN accounts o ON o.id=a.operator_id WHERE r.event_id=? AND ${visibleAgent}`, event.id).n };
  },
  giveThanks(actor, input) {
    const giver = this.communityAgent(actor, input);
    const recipient = this.get(`SELECT a.id,a.name,a.operator_id FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.id=? AND a.status='active' AND o.status='active'`, input.recipient_agent_id || '');
    if (!recipient) fail(404, 'Choose an active recipient character.');
    if (recipient.operator_id === actor.account.id) fail(403, 'Thank a character operated by someone else.');
    const reason = text(input.reason, 'Specific appreciation', 300), created = date(this), day = created.slice(0, 10);
    if (this.get('SELECT id FROM community_thanks WHERE giver_account_id=? AND recipient_agent_id=? AND day=?', actor.account.id, recipient.id, day)) fail(409, 'This operator has already thanked that character today.');
    if (this.get('SELECT COUNT(*) AS n FROM community_thanks WHERE giver_account_id=? AND day=?', actor.account.id, day).n >= 20) fail(429, 'An operator can send twenty appreciations per UTC day.');
    const id = randomUUID();
    this.run('INSERT INTO community_thanks VALUES(?,?,?,?,?,?,?)', id, actor.account.id, giver.id, recipient.id, day, reason, created);
    this.audit(actor.account.id, 'community.thanks', id);
    return { id, giver_agent_id: giver.id, recipient_agent_id: recipient.id, giver_name: giver.name, recipient_name: recipient.name, reason, created_at: created };
  },
  manageCommunity(actor, input) {
    if (!actor || actor.kind !== 'session') fail(403, 'A human operator session is required.');
    if (!Object.hasOwn(tables, input.kind)) fail(400, 'Choose a circle, project, or event.');
    if ((input.kind === 'event' ? 'cancel' : 'archive') !== input.action) fail(400, 'Use archive for circles and projects or cancel for gatherings.');
    const reason = text(input.reason, 'Community management reason', 1000);
    const record = this.get(`SELECT c.*,a.operator_id FROM ${tables[input.kind]} c JOIN agents a ON a.id=c.creator_agent_id WHERE c.id=?`, input.id || '');
    if (!record) fail(404, 'Community record not found.');
    if (record.operator_id !== actor.account.id && !['admin', 'moderator'].includes(actor.account.role)) fail(403, 'Only the author operator or a moderator can manage this record.');
    const status = input.kind === 'event' ? 'cancelled' : 'archived';
    this.run(`UPDATE ${tables[input.kind]} SET status=?,management_reason=? WHERE id=?`, status, reason, record.id);
    if (input.kind === 'circle') {
      this.run("UPDATE community_projects SET status='archived',management_reason=? WHERE circle_id=? AND status!='archived'", reason, record.id);
      this.run("UPDATE community_events SET status='cancelled',management_reason=? WHERE circle_id=? AND status='scheduled'", reason, record.id);
    }
    this.audit(actor.account.id, `community.${input.kind}.${status}`, record.id);
    return { id: record.id, status, reason };
  },
  communityExport(actor) {
    if (!actor || actor.kind !== 'session') fail(403, 'An operator session is required.');
    const id = actor.account.id;
    const owned = 'SELECT id FROM agents WHERE operator_id=?';
    return {
      circles: this.all(`SELECT * FROM community_circles WHERE creator_agent_id IN (${owned})`, id),
      memberships: this.all(`SELECT * FROM community_members WHERE agent_id IN (${owned})`, id),
      projects: this.all(`SELECT * FROM community_projects p WHERE creator_agent_id IN (${owned}) OR EXISTS(SELECT 1 FROM json_each(p.milestones) m WHERE json_extract(m.value,'$.submitted_by_agent_id') IN (${owned}) OR json_extract(m.value,'$.approved_by_agent_id') IN (${owned}))`, id, id, id).map((p) => ({ ...p, milestones: JSON.parse(p.milestones) })),
      pledges: this.all(`SELECT * FROM community_pledges WHERE agent_id IN (${owned})`, id),
      events: this.all(`SELECT * FROM community_events WHERE creator_agent_id IN (${owned})`, id),
      rsvps: this.all(`SELECT * FROM community_rsvps WHERE agent_id IN (${owned})`, id),
      thanks: this.all(`SELECT id,giver_agent_id,recipient_agent_id,day,reason,created_at FROM community_thanks WHERE giver_account_id=? OR recipient_agent_id IN (${owned})`, id, id),
    };
  },
  deleteCommunity(actor) {
    if (!actor || actor.kind !== 'session') fail(403, 'An operator session is required.');
    const ownedIds = this.all('SELECT id FROM agents WHERE operator_id=?', actor.account.id).map((a) => a.id), owned = new Set(ownedIds);
    for (const id of ownedIds) {
      for (const circle of this.all('SELECT id FROM community_circles WHERE creator_agent_id=?', id)) {
        this.run("UPDATE community_projects SET status='archived',management_reason='Circle owner account removed.' WHERE circle_id=?", circle.id);
        this.run("UPDATE community_events SET status='cancelled',management_reason='Circle owner account removed.' WHERE circle_id=?", circle.id);
      }
      for (const table of ['community_members', 'community_pledges', 'community_rsvps']) this.run(`DELETE FROM ${table} WHERE agent_id=?`, id);
      this.run("UPDATE community_circles SET name='Former circle',summary='[removed]',status='archived',management_reason='' WHERE creator_agent_id=?", id);
      this.run("UPDATE community_projects SET title='Former project',summary='[removed]',goal='[removed]',evidence_requirements='[removed]',status='archived',management_reason='' WHERE creator_agent_id=?", id);
      this.run("UPDATE community_events SET title='Former gathering',summary='[removed]',status='cancelled',management_reason='' WHERE creator_agent_id=?", id);
    }
    for (const project of this.all('SELECT id,creator_agent_id,milestones FROM community_projects')) {
      const milestones = JSON.parse(project.milestones); let changed = false;
      for (const milestone of milestones) {
        if (owned.has(project.creator_agent_id) || owned.has(milestone.submitted_by_agent_id)) { milestone.evidence = '[removed]'; milestone.sources = []; changed = true; }
        if (owned.has(project.creator_agent_id)) { milestone.title = 'Former contribution'; changed = true; }
        if (owned.has(milestone.approved_by_agent_id) || owned.has(milestone.submitted_by_agent_id)) { milestone.review_note = '[removed]'; changed = true; }
      }
      if (changed) this.run('UPDATE community_projects SET milestones=? WHERE id=?', JSON.stringify(milestones), project.id);
    }
    this.run('DELETE FROM community_thanks WHERE giver_account_id=?', actor.account.id);
    this.audit(actor.account.id, 'community.account_removed', actor.account.id);
  },
  // -------------------------------------------------------------------------------------------
  // The Gathering Garden: one cooperative world restoration event.
  //
  // The event occurrence is a real `community_events` row, participation is a real `community_rsvps`
  // row, and every step is derived from saved server rows. These six methods are the whole event:
  // the derived read, opening it on a garden the operator owns, explicit participation, leaving,
  // recording a non-placement contribution, and the placement itself (which lives beside `build()`
  // in src/spaces.js because it is the one place a participant writes into another operator's
  // garden).
  // -------------------------------------------------------------------------------------------
  restorationEventRecord(id) {
    const value = typeof id === 'string' ? id.trim() : '';
    if (!value || value.length > 120 || !value.startsWith(RESTORATION_PREFIX)) fail(404, 'This world restoration is unavailable.');
    const event = this.get('SELECT * FROM community_events WHERE id=?', value);
    if (!event) fail(404, 'This world restoration is unavailable.');
    return event;
  },
  restorationSite(event) {
    const world = this.get('SELECT id,name,kind,owner_agent_id,visibility FROM worlds WHERE id=?', event.world_id);
    if (!world) fail(404, 'The garden this restoration names is unavailable.');
    return world;
  },
  /** `completed`, `cancelled`, `pending`, `open` or `closed`: the stored status plus the window. */
  restorationPhase(event, at = this.clock()) {
    if (event.status === 'completed') return 'completed';
    if (event.status !== 'scheduled') return 'cancelled';
    if (at < Date.parse(event.starts_at)) return 'pending';
    return at >= Date.parse(event.ends_at) ? 'closed' : 'open';
  },
  restorationParticipant(eventId, agentId) {
    return this.get('SELECT * FROM community_rsvps WHERE event_id=? AND agent_id=?', eventId, agentId) || null;
  },
  /**
   * The saved facts behind every step, counted once each, per participating resident. One grouped
   * read per fact kind, so the whole event is answered in a bounded number of queries however many
   * participants it has. A fact counts only when it was recorded at or after the resident pledged
   * *and* inside the event's own window, so work done before joining never counts.
   */
  restorationCensus(event) {
    const participants = this.all(`SELECT r.agent_id,r.created_at AS joined_at,a.name,a.kind,a.status AS agent_status,a.operator_id,o.status AS operator_status,COALESCE(v.calling_id,'explorer') AS calling_id
      FROM community_rsvps r JOIN agents a ON a.id=r.agent_id JOIN accounts o ON o.id=a.operator_id LEFT JOIN resident_callings v ON v.agent_id=a.id
      WHERE r.event_id=? ORDER BY r.created_at,a.name,a.id LIMIT 100`, event.id);
    const epoch = (value) => `CAST(round((julianday(${value})-2440587.5)*86400000) AS INTEGER)`;
    const counted = (rows) => new Map(rows.map((row) => [row.agent_id, row]));
    const sowings = counted(this.all(`SELECT c.agent_id,COUNT(*) AS n,MAX(c.planted_at) AS newest FROM journey_crops c
      JOIN community_rsvps r ON r.agent_id=c.agent_id AND r.event_id=?
      WHERE c.planted_at>=MAX(${epoch('r.created_at')},${epoch('?')}) AND c.planted_at<=${epoch('?')}
      GROUP BY c.agent_id`, event.id, event.starts_at, event.ends_at));
    const crafts = counted(this.all(`SELECT r.agent_id,COUNT(*) AS n,MAX(a.created_at) AS newest FROM audit a
      JOIN community_rsvps r ON r.agent_id=a.record_id AND r.event_id=? JOIN agents resident ON resident.id=r.agent_id
      WHERE a.event='journey.crafted' AND a.actor=resident.operator_id AND a.created_at>=MAX(r.created_at,?) AND a.created_at<=?
      GROUP BY r.agent_id`, event.id, event.starts_at, event.ends_at));
    const circles = counted(this.all(`SELECT m.agent_id,COUNT(*) AS n,MAX(m.joined_at) AS newest FROM community_members m
      JOIN community_circles c ON c.id=m.circle_id JOIN agents creator ON creator.id=c.creator_agent_id JOIN agents self ON self.id=m.agent_id
      JOIN community_rsvps r ON r.agent_id=m.agent_id AND r.event_id=?
      WHERE c.status='active' AND creator.operator_id!=self.operator_id AND m.joined_at>=MAX(r.created_at,?) AND m.joined_at<=?
      GROUP BY m.agent_id`, event.id, event.starts_at, event.ends_at));
    // The ground step's credit is the object itself; the audit record names the resident, the tile
    // and the type, so the world's own append-only log answers who carried what.
    const placed = new Map();
    for (const row of this.all("SELECT record_id,created_at FROM audit WHERE event='restoration.placed' AND substr(record_id,1,?)=? ORDER BY seq DESC LIMIT 64", `${event.id}|`.length, `${event.id}|`)) {
      const [, agentId, tile, type] = String(row.record_id).split('|');
      if (!agentId || !tile) continue;
      const entry = placed.get(agentId) || { agent_id: agentId, n: 0, newest: row.created_at, tiles: [] };
      entry.n += 1; entry.tiles.push(`${tile} ${type}`); placed.set(agentId, entry);
    }
    return { participants, sowings, crafts, circles, placed };
  },
  /** Which census map answers one fact kind. */
  restorationCensusFor(census, fact) {
    return fact === 'crop_plant' ? census.sowings : fact === 'craft' ? census.crafts : fact === 'circle_join' ? census.circles : census.placed;
  },
  restorationAgentCount(census, step, agentId) {
    const row = this.restorationCensusFor(census, step.fact).get(agentId);
    return row ? row.n : 0;
  },
  /**
   * The whole of the event's progress, derived: which planned tiles stand, how many sowings, crafts
   * and circle memberships the participants recorded inside the window. Nothing here is stored, so
   * nothing here can be credited twice.
   */
  restorationProgress(event, census = null) {
    const objects = new Map(this.all('SELECT x,y,type FROM world_objects WHERE world_id=?', event.world_id).map((object) => [`${object.x},${object.y}`, object.type]));
    const facts = census || this.restorationCensus(event), standing = (tile) => objects.get(`${tile.x},${tile.y}`) === tile.type;
    const steps = RESTORATION_PLAN.steps.map((step) => {
      const slots = step.slots.map((slot) => ({ ...slot, filled: standing(slot) }));
      const assembles = step.assembles.map((tile) => ({ ...tile, present: standing(tile) }));
      const recorded = step.fact === 'garden_object'
        ? slots.filter((slot) => slot.filled).length
        : [...this.restorationCensusFor(facts, step.fact).values()].reduce((sum, row) => sum + row.n, 0);
      const progress = Math.min(recorded, step.target);
      return {
        id: step.id, ordinal: step.ordinal, title: step.title, instructions: step.instructions, output_name: step.output_name,
        role: { ...RESTORATION_ROLES[step.role] }, fact: { ...RESTORATION_FACTS[step.fact] },
        target: step.target, progress, complete: progress >= step.target, slots, assembles,
        next_slot: slots.find((slot) => !slot.filled) || null,
      };
    });
    const planned = RESTORATION_PLAN.steps.flatMap((step) => [
      ...step.slots.map((slot) => ({ step_id: step.id, role: step.role, x: slot.x, y: slot.y, type: slot.type, state: standing(slot) ? 'placed' : 'missing' })),
      ...step.assembles.map((tile) => ({ step_id: step.id, role: step.role, x: tile.x, y: tile.y, type: tile.type, state: standing(tile) ? 'assembled' : 'missing' })),
    ]);
    return {
      steps, steps_total: steps.length, steps_completed: steps.filter((step) => step.complete).length,
      complete: steps.every((step) => step.complete),
      artifact: { world_id: event.world_id, planned, standing: planned.filter((item) => item.state !== 'missing').length, missing: planned.filter((item) => item.state === 'missing').length, complete: planned.every((item) => item.state !== 'missing') },
    };
  },
  /** The newest saved fact one resident has for one step, or null. Never a claim: a stored row. */
  restorationFact(agent, event, step, joinedAt) {
    const from = joinedAt > event.starts_at ? joinedAt : event.starts_at;
    if (step.fact === 'crop_plant') {
      const row = this.get('SELECT x,y,kind,planted_at AS at FROM journey_crops WHERE agent_id=? AND planted_at>=? AND planted_at<=? ORDER BY planted_at DESC LIMIT 1', agent.id, Math.max(Date.parse(from), Date.parse(event.starts_at)), Date.parse(event.ends_at));
      return row ? { kind: 'crop_plant', at: new Date(row.at).toISOString(), detail: `a ${row.kind} sowing on crop patch ${row.x}, ${row.y}` } : null;
    }
    if (step.fact === 'craft') {
      const row = this.get("SELECT created_at AS at FROM audit WHERE event='journey.crafted' AND actor=? AND record_id=? AND created_at>=? AND created_at<=? ORDER BY seq DESC LIMIT 1", agent.operator_id, agent.id, from, event.ends_at);
      return row ? { kind: 'craft', at: row.at, detail: 'a keepsake recorded after its ingredients were debited' } : null;
    }
    const join = this.get(`SELECT m.circle_id,c.name,m.joined_at AS at FROM community_members m JOIN community_circles c ON c.id=m.circle_id
      JOIN agents creator ON creator.id=c.creator_agent_id JOIN agents self ON self.id=m.agent_id
      WHERE m.agent_id=? AND c.status='active' AND creator.operator_id!=self.operator_id AND m.joined_at>=? AND m.joined_at<=?
      ORDER BY m.joined_at DESC LIMIT 1`, agent.id, from, event.ends_at);
    return join ? { kind: 'circle_join', at: join.at, detail: `membership of ${join.name}` } : null;
  },
  /**
   * Record the completed garden exactly once. The status flip is the guard: only the caller that
   * moves a `scheduled` event to `completed` writes the assembled tiles, so a replay, a refresh or
   * a second browser writes nothing.
   */
  restorationFinish(actor, event) {
    const progress = this.restorationProgress(event);
    if (!progress.complete) return { progress, completed: false, assembled: [] };
    if (!this.run("UPDATE community_events SET status='completed' WHERE id=? AND status='scheduled'", event.id).changes) return { progress, completed: false, assembled: [], repeated: true };
    const assembled = [];
    for (const step of RESTORATION_PLAN.steps) for (const tile of step.assembles) {
      if (this.get('SELECT id FROM world_objects WHERE world_id=? AND x=? AND y=?', event.world_id, tile.x, tile.y)) continue;
      this.run('INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), event.world_id, tile.type, tile.x, tile.y, date(this));
      this.audit(actor.account.id, 'restoration.assembled', `${event.id}|${step.id}|${tile.x},${tile.y}|${tile.type}`);
      assembled.push({ step_id: step.id, x: tile.x, y: tile.y, type: tile.type });
    }
    this.audit(actor.account.id, 'restoration.completed', event.id);
    return { progress: this.restorationProgress(this.get('SELECT * FROM community_events WHERE id=?', event.id)), completed: true, assembled };
  },
  /** One occurrence as every reader sees it, with the viewer's own state when a resident was named. */
  restorationEventView(event, viewerAgent = null, census = null) {
    const site = this.restorationSite(event), facts = census || this.restorationCensus(event), progress = this.restorationProgress(event, facts), phase = this.restorationPhase(event);
    const owner = site.owner_agent_id ? this.get('SELECT a.name,a.operator_id,o.status AS operator_status FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.id=?', site.owner_agent_id) : null;
    const convenor = this.get('SELECT a.name,a.operator_id FROM agents a WHERE a.id=?', event.creator_agent_id);
    const participants = facts.participants.map((participant) => ({
      agent_id: participant.agent_id, name: participant.name, kind: participant.kind, calling_id: participant.calling_id,
      joined_at: participant.joined_at, state: participant.agent_status === 'active' && participant.operator_status === 'active' ? 'active' : participant.agent_status,
      promise: { code: 'pledge', label: 'A promise to help: recorded here and never counted as work', counted_as_work: false },
      contributions: RESTORATION_PLAN.steps.map((step) => ({
        step_id: step.id, counted: this.restorationAgentCount(facts, step, participant.agent_id),
        standing: step.fact === 'garden_object' ? progress.steps.find((item) => item.id === step.id).slots.filter((slot) => slot.filled).length : null,
      })).filter((item) => item.counted > 0),
    }));
    const viewer = viewerAgent ? (() => {
      const agent = this.get('SELECT * FROM agents WHERE id=?', viewerAgent);
      const participant = this.restorationParticipant(event.id, viewerAgent);
      const selection = this.get('SELECT calling_id FROM resident_callings WHERE agent_id=?', viewerAgent);
      const callingId = selection?.calling_id || 'explorer';
      const calling = CALLINGS.find((item) => item.id === callingId) || null;
      const view = progress.steps.map((step) => ({
        ...step,
        i_am_eligible: step.role.callings.includes(callingId),
        // `progress.steps[].fact` is the materialised fact record; the census is keyed by the plan's
        // own string kind, so the viewer's per-step count has to be read from the plan step itself.
        // Without this the count silently fell through to the placements map for every step, and a
        // sown bed or a kept circle was reported against the viewer as if they had carried a bench.
        my_counted: this.restorationAgentCount(facts, RESTORATION_PLAN.steps.find((item) => item.id === step.id) || step, viewerAgent),
      }));
      const next = view.find((step) => !step.complete && step.i_am_eligible) || null;
      return {
        agent_id: agent.id, name: agent.name, calling_id: callingId, calling_name: calling?.name || null,
        world_id: agent.world_id, world_name: getWorldDefinition(agent.world_id).name, in_garden: agent.world_id === event.world_id,
        joined: Boolean(participant), joined_at: participant?.created_at || null,
        promise: participant ? { code: 'pledge', label: 'A promise to help: recorded in the participant list and never counted as work', counted_as_work: false } : null,
        steps: view.map((step) => ({ step_id: step.id, title: step.title, role: step.role.label, eligible: step.i_am_eligible, complete: step.complete, progress: step.progress, target: step.target, my_counted: step.my_counted })),
        next_action: next ? { step_id: next.id, title: next.title, role: next.role.label, action: { kind: next.fact.kind, label: next.instructions, saved_fact: next.fact.saved_fact }, out_of_window: phase !== 'open' } : null,
      };
    })() : null;
    return {
      id: event.id, title: event.title, summary: event.summary, plan: RESTORATION_PLAN.slug, narrative: RESTORATION_PLAN.narrative,
      status: event.status, phase, open: phase === 'open',
      starts_at: event.starts_at, ends_at: event.ends_at, minutes_remaining: Math.max(0, Math.round((Date.parse(event.ends_at) - this.clock()) / 60000)),
      site: { world_id: site.id, name: site.name, kind: site.kind, owner_agent_id: site.owner_agent_id, owner_name: owner?.name || null, visibility: site.visibility, open_to_visitors: site.visibility === 'public' },
      convenor: convenor ? { agent_id: event.creator_agent_id, name: convenor.name } : null,
      capacity: event.capacity, participants_count: participants.length, participants,
      progress, artifact: progress.artifact, viewer, policy: RESTORATION_POLICY, server_time: this.clock(),
    };
  },
  /**
   * Bounded account-specific restoration lookup. Returns the most recent event where this account
   * has saved counted restoration work, so a returning player still sees their contribution even
   * when many newer events have been opened. No census is re-run: the event view is built with the
   * existing helpers once an event is selected.
   */
  restorationForAccount(actor, agentId, worldId = null, limit = RESTORATION_LIST) {
    const agent = this.ownedAgent(actor, agentId);
    // When the guide is showing one garden (a requested world), the bounded account read is scoped to
    // that garden, so an older contribution there stays visible without ever surfacing another
    // garden's occurrence. Without a requested world the account's contribution in any garden is the
    // guide's subject, which is the case a returning contributor to another operator's garden needs.
    const scope = typeof worldId === 'string' && worldId ? worldId : null;
    // Counted work is recorded in the audit trail: an object placed on a planned tile, or an
    // explicit contribution of a sowing, craft or circle membership. Pledges are not counted work.
    const eventIds = this.all(`SELECT DISTINCT substr(record_id, 1, instr(record_id, '|') - 1) AS event_id
      FROM audit
      WHERE actor=? AND event IN ('restoration.placed','restoration.contributed') AND substr(record_id, 1, ?)=?
      ORDER BY seq DESC LIMIT ?`, actor.account.id, RESTORATION_PREFIX.length, RESTORATION_PREFIX, limit).map((row) => row.event_id);
    for (const eventId of eventIds) {
      const event = this.restorationEventRecord(eventId);
      if ((scope === null || event.world_id === scope) && this.restorationPhase(event) !== 'cancelled') return this.restorationEventView(event, agent.id);
    }
    return null;
  },
  /** The one read: the authored plan, the visible occurrences, and one occurrence in full. */
  restoration(actor, input = {}) {
    const viewerAgent = actor?.kind === 'runtime' ? this.get('SELECT * FROM agents WHERE id=?', actor.agent.id) : input.agent_id && actor ? this.ownedAgent(actor, input.agent_id) : null;
    const worldId = typeof input.world_id === 'string' ? input.world_id : '';
    const records = this.all('SELECT * FROM community_events WHERE substr(id,1,?)=? ORDER BY starts_at DESC,id LIMIT ?', RESTORATION_PREFIX.length, RESTORATION_PREFIX, RESTORATION_LIST);
    if (typeof input.event_id === 'string' && input.event_id && !records.some((row) => row.id === input.event_id)) fail(404, 'This world restoration is unavailable.');
    const wanted = typeof input.event_id === 'string' && input.event_id ? records.find((row) => row.id === input.event_id) : null;
    const selected = wanted
      || (worldId ? records.find((row) => row.world_id === worldId) : null)
      || (viewerAgent ? records.find((row) => row.world_id === `home:${viewerAgent.id}`) : null)
      || records.find((row) => this.restorationPhase(row) === 'open') || records[0] || null;
    return {
      plan: { slug: RESTORATION_PLAN.slug, title: RESTORATION_PLAN.title, summary: RESTORATION_PLAN.summary, narrative: RESTORATION_PLAN.narrative,
        steps: RESTORATION_PLAN.steps.map((step) => ({ id: step.id, ordinal: step.ordinal, title: step.title, instructions: step.instructions, output_name: step.output_name, role: { ...RESTORATION_ROLES[step.role] }, fact: { ...RESTORATION_FACTS[step.fact] }, target: step.target })) },
      events: records.map((row) => { const progress = this.restorationProgress(row); return { id: row.id, title: row.title, status: row.status, phase: this.restorationPhase(row), starts_at: row.starts_at, ends_at: row.ends_at, world_id: row.world_id, participants_count: this.get('SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=?', row.id).n, steps_completed: progress.steps_completed, steps_total: progress.steps_total }; }),
      event: selected ? this.restorationEventView(selected, viewerAgent?.id || '') : null,
      viewer_agent_id: viewerAgent?.id || null, policy: RESTORATION_POLICY, can_open: actor?.kind === 'session' && viewerAgent?.kind === 'agent',
    };
  },
  /**
   * Open one restoration on the garden the operator's own resident lives in. A human operator
   * decision, exactly like choosing a calling or authoring a quest chain: a runtime credential
   * cannot open one, and no operator can open a restoration on somebody else's garden.
   */
  restorationOpen(actor, input = {}) {
    if (actor?.kind !== 'session') fail(403, 'Only the signed-in human operator can open a restoration of its own garden.');
    const agent = this.communityAgent(actor, input);
    const worldId = `home:${agent.id}`, world = this.get('SELECT * FROM worlds WHERE id=? AND owner_agent_id=?', worldId, agent.id);
    if (!world) fail(404, 'This resident has no garden to restore.');
    if (world.visibility !== 'public') fail(409, 'Open the garden to visitors before restoring it together. In Garden settings, set visiting to public, then open the restoration again.');
    const hours = input.hours === undefined || input.hours === null || input.hours === '' ? 24 : Number(input.hours);
    if (!Number.isInteger(hours) || hours < RESTORATION_POLICY.window_hours[0] || hours > RESTORATION_POLICY.window_hours[1]) fail(400, `Choose a window from ${RESTORATION_POLICY.window_hours[0]} to ${RESTORATION_POLICY.window_hours[1]} hours.`);
    const existing = this.get('SELECT * FROM community_events WHERE id=?', `${RESTORATION_PREFIX}${worldId}`);
    if (existing) {
      const phase = this.restorationPhase(existing);
      if (phase === 'completed') fail(409, `This garden’s restoration was already completed on ${existing.starts_at.slice(0, 10)}. Its restored structure stands as the recorded outcome; a second restoration of the same plan would repeat finished work.`);
      if (phase === 'open' || phase === 'pending') fail(409, 'This garden already has an open restoration. Take part in it, or wait until its window closes.');
    }
    this.communityQuota(agent, 'community_events', 10);
    const id = `${RESTORATION_PREFIX}${worldId}`, created = date(this), closes = new Date(this.clock() + hours * 3600000).toISOString();
    // A reopen extends the same single window instead of starting a second one, so the work already
    // recorded inside it keeps counting and nothing is silently discarded.
    if (existing) this.run("UPDATE community_events SET ends_at=?,capacity=?,status='scheduled',management_reason='' WHERE id=?", closes, RESTORATION_CAPACITY, id);
    else this.run('INSERT INTO community_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, null, RESTORATION_PLAN.title, RESTORATION_PLAN.summary, agent.id, worldId, created, closes, RESTORATION_CAPACITY, 'scheduled', created, '');
    this.audit(actor.account.id, existing ? 'restoration.reopened' : 'restoration.opened', id);
    return this.restorationEventView(this.get('SELECT * FROM community_events WHERE id=?', id), agent.id);
  },
  /**
   * Pledge to help. Explicit, revocable and bounded: an active resident of an active operator, a
   * public garden it has actually stood in inside this window, and a seat inside the capacity. The
   * pledge is a promise; it advances no step.
   */
  restorationJoin(actor, input = {}) {
    const agent = this.communityAgent(actor, input);
    const event = this.restorationEventRecord(input.event_id);
    const phase = this.restorationPhase(event);
    if (phase === 'completed') fail(409, 'This restoration is already complete.');
    if (phase === 'cancelled') fail(409, 'This restoration was cancelled.');
    if (phase !== 'open') fail(409, `This restoration’s window is ${phase}. Its saved work stands; its keepers can open a new window.`);
    const site = this.restorationSite(event);
    this.space(actor, site.id);
    if (site.visibility !== 'public') fail(403, 'This garden is not open to visitors, so its restoration cannot be joined.');
    const existing = this.restorationParticipant(event.id, agent.id);
    if (existing) return { ...this.restorationEventView(event, agent.id), joined: true, repeated: true, note: 'This resident is already taking part; nothing was written twice.' };
    if (this.get('SELECT COUNT(*) AS n FROM community_rsvps WHERE event_id=?', event.id).n >= Math.min(event.capacity, 100)) fail(409, 'This restoration has reached its participant limit.');
    // The prerequisite is a documented visit: the resident must have actually stood in the garden
    // it is helping to restore. `journey_visits` records that once, when the resident travels there,
    // so a client cannot assert it and a spectator view cannot substitute for it.
    if (!this.get('SELECT visited_at FROM journey_visits WHERE agent_id=? AND world_id=?', agent.id, site.id)) fail(403, `Walk into ${site.name} as this resident first — the visit is recorded when the resident actually stands there — then pledge again.`);
    this.run('INSERT INTO community_rsvps VALUES(?,?,?)', event.id, agent.id, date(this));
    this.audit(actor.account.id, 'restoration.joined', event.id);
    return { ...this.restorationEventView(event, agent.id), joined: true, repeated: false, note: 'Pledged. This is a promise to help, not completed work: it advances no step on its own.' };
  },
  /** Withdraw the promise. Recorded work — objects, sowings, crafts, memberships — is untouched. */
  restorationLeave(actor, input = {}) {
    const agent = this.communityAgent(actor, input);
    const event = this.restorationEventRecord(input.event_id);
    const existing = this.restorationParticipant(event.id, agent.id);
    if (!existing) return { ...this.restorationEventView(event, agent.id), left: false, note: 'This resident was not taking part.' };
    this.run('DELETE FROM community_rsvps WHERE event_id=? AND agent_id=?', event.id, agent.id);
    this.audit(actor.account.id, 'restoration.left', event.id);
    return { ...this.restorationEventView(event, agent.id), left: true, note: 'The promise was withdrawn. Everything this resident already saved — placed objects, sowings, crafts, memberships — stays exactly as it is.' };
  },
  /**
   * Record one non-placement contribution. The work itself is the saved row the world already holds;
   * this route states which saved fact answers the step, refuses when there is none, and writes the
   * completed garden once when the last step is finished. It never writes a credit of its own.
   */
  restorationContribute(actor, input = {}) {
    const agent = this.communityAgent(actor, input);
    const event = this.restorationEventRecord(input.event_id);
    const step = RESTORATION_PLAN.steps.find((item) => item.id === (typeof input.step_id === 'string' ? input.step_id.trim() : ''));
    if (!step) fail(404, 'Choose a planned step of this restoration.');
    if (step.fact === 'garden_object') fail(400, 'This step is completed by placing the planned object in the garden. Use the placement control while standing beside its tile.');
    const participant = this.restorationParticipant(event.id, agent.id);
    if (!participant) fail(403, 'Pledge to help with this restoration before recording a contribution.');
    const role = RESTORATION_ROLES[step.role];
    const calling = this.get('SELECT calling_id FROM resident_callings WHERE agent_id=?', agent.id)?.calling_id || 'explorer';
    if (!role.callings.includes(calling)) fail(403, `This is the ${role.label} step: it is answered by ${role.callings.join(', ')}. Your resident follows ${calling}. Take a step your own calling answers, or change calling first.`);
    const phase = this.restorationPhase(event), progress = this.restorationProgress(event), mine = progress.steps.find((item) => item.id === step.id);
    if (phase === 'completed') fail(409, 'This restoration is already complete. The finished garden is recorded and nothing more is written.');
    if (phase === 'cancelled') fail(409, 'This restoration was cancelled; its saved work stands as history.');
    const fact = this.restorationFact(agent, event, step, participant.created_at);
    if (!fact) fail(409, `${RESTORATION_FACTS[step.fact].label} is not recorded for ${agent.name} yet. ${step.instructions}`);
    if (phase !== 'open' && !progress.complete) fail(409, `This restoration’s window is ${phase}. The work saved inside the window stands, but nothing new is recorded outside it.`);
    // The credit is the saved row itself: this route writes no receipt of its own, so a repeated
    // request records nothing twice. It writes only the finished garden, and only once.
    const finished = progress.complete && event.status === 'scheduled' ? this.restorationFinish(actor, event) : { progress, completed: false, assembled: [] };
    this.audit(actor.account.id, 'restoration.contributed', `${event.id}|${step.id}|${fact.kind}|${agent.id}`);
    const census = this.restorationCensus(event);
    return {
      ...this.restorationEventView(this.get('SELECT * FROM community_events WHERE id=?', event.id), agent.id, census),
      contribution: {
        step_id: step.id, role: role.label, fact: { ...RESTORATION_FACTS[step.fact] },
        saved_fact: fact.detail, saved_at: fact.at, counted: true,
        my_contribution_count: this.restorationAgentCount(census, step, agent.id),
        step_progress: finished.progress.steps.find((item) => item.id === step.id).progress, step_target: step.target,
        step_complete: finished.progress.steps.find((item) => item.id === step.id).complete,
      },
      completed: finished.completed, assembled: finished.assembled, writes: finished.completed ? 1 : 0,
      note: 'The credit is the saved row itself, so this route writes nothing of its own: repeating it cannot credit a step twice.',
    };
  },
};

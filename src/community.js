import { randomUUID } from 'node:crypto';

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
const normalizeSources = (sources = []) => {
  if (!Array.isArray(sources) || sources.length > 5) fail(400, 'Provide up to five supporting source links.');
  return sources.map((source) => {
    let url;
    try { url = new URL(source?.url); } catch { fail(400, 'A supporting source URL is invalid.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000) fail(400, 'Use an HTTP source URL without credentials.');
    return { url: url.href, location: text(source.location, 'Supporting page or section', 300) };
  });
};

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
};

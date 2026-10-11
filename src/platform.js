import { draftMethods } from './drafts.js';
import { BRIEF_MARKER, normalizeDecisionBrief, serializeDecisionBrief, storedDecisionBrief } from './decision-brief.js';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { openDatabase } from './database.js';
import { start } from '../world.js';
import { spaceMethods } from './spaces.js';
import { communityMethods } from './community.js';
import { journeyMethods } from './journey.js';
import { civicMethods } from './civic-engine.js';
import { REGIONS } from './civic.js';

const scrypt = promisify(scryptCallback);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (value, label, max = 2000, optional = false) => {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `${label} must contain 1–${max} characters.`);
  return value.trim();
};
const role = (actor, roles) => { if (!actor || actor.kind !== 'session' || !roles.includes(actor.account.role)) fail(403, 'This action requires an authorized human account.'); };
const parse = (value) => JSON.parse(value);
const publicAccount = ({ id, name, role: accountRole, status, created_at }) => ({ id, name, role: accountRole, status, created_at });

export class Platform {
  constructor(path, clock = Date.now) { this.db = openDatabase(path); this.path = path; this.clock = clock; this.seed(); this.seedSpaces(); this.initCommunity(); this.initJourney(); this.initCivic(); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(actor, event, recordId = '') {
    const previous = this.get('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1')?.hash || '';
    const date = now();
    const digest = hash(JSON.stringify([actor, event, recordId, date, previous]));
    this.run('INSERT INTO audit(actor,event,record_id,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?)', actor, event, recordId, date, previous, digest);
  }
  verifyAudit() {
    let previous = '';
    for (const entry of this.all('SELECT * FROM audit ORDER BY seq')) {
      if (entry.previous_hash !== previous || entry.hash !== hash(JSON.stringify([entry.actor, entry.event, entry.record_id, entry.created_at, previous]))) return false;
      previous = entry.hash;
    }
    return true;
  }
  seed() {
    if (this.get('SELECT COUNT(*) AS n FROM missions').n) return;
    this.transaction(() => {
      for (const [id, title, area, summary, instructions] of [
        ['climate', 'Climate evidence register', 'Climate', 'Build a traceable register of public heat resilience evidence.', 'Record the publisher, date, geography, claim, exact supporting location, rights, and uncertainty of one source.'],
        ['peace', 'Peace learning resource map', 'Peace', 'Organize public, nonpartisan education and dialogue resources.', 'Describe one original resource, its audience, language, rights, access requirements, and contextual cautions.'],
        ['access', 'Accessible public knowledge', 'Accessibility', 'Make approved knowledge easier to understand and use.', 'Create a plain language or accessible version of one appropriately licensed source, preserving its date and limitations.'],
      ]) {
        this.run('INSERT INTO missions VALUES(?,?,?,?,NULL,?,NULL,?,?,1,?)', id, title, area, summary, 'Local workflow demonstration', 'Original sources, exact locations, rights, completeness, safety, and limitations must be checked by a human.', 'demo', now());
        this.run('INSERT INTO tasks(id,mission_id,title,instructions,rights,allowed_domains) VALUES(?,?,?,?,?,?)', `${id}-practice`, id, 'Practice one source-based contribution', instructions, 'Use public, appropriately licensed material only.', '[]');
      }
    });
  }
  async passwordDigest(password) {
    text(password, 'Password', 128);
    if (password.length < 12) fail(400, 'Use a password with at least 12 characters.');
    const salt = randomBytes(16).toString('hex');
    const key = await scrypt(password, salt, 64);
    return `${salt}:${key.toString('hex')}`;
  }
  async register(input) {
    const name = text(input.name, 'Display name', 40);
    const email = text(input.email, 'Private contact email', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Provide a valid contact email.');
    if (input.consent !== true) fail(400, 'Adult participation and community rules consent is required.');
    const digest = await this.passwordDigest(input.password);
    return this.transaction(() => {
      const first = this.get('SELECT COUNT(*) AS n FROM accounts').n === 0;
      if (first && this.publicMode) {
        if (typeof this.setupCode !== 'string' || this.setupCode.length < 24 || typeof input.setup_code !== 'string' || input.setup_code.length > 256 || !timingSafeEqual(Buffer.from(hash(input.setup_code), 'hex'), Buffer.from(hash(this.setupCode), 'hex'))) fail(403, 'A valid private setup code is required to create the first administrator.');
      }
      let invite;
      if (!first) {
        invite = this.get('SELECT * FROM invites WHERE code_hash=? AND used_by IS NULL AND expires_at>?', hash(String(input.invite || '')), this.clock());
        if (!invite) fail(403, 'A valid invitation is required.');
      }
      if (this.get('SELECT id FROM accounts WHERE email=?', email)) fail(409, 'This account already exists.');
      const id = randomUUID();
      this.run('INSERT INTO accounts(id,name,email,password,role,consent_at,created_at) VALUES(?,?,?,?,?,?,?)', id, name, email, digest, first ? 'admin' : invite.role, now(), now());
      if (invite) this.run('UPDATE invites SET used_by=? WHERE code_hash=?', id, invite.code_hash);
      this.audit(id, 'account.created', id);
      return this.loginToken(this.get('SELECT * FROM accounts WHERE id=?', id));
    });
  }
  async login(input) {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const account = this.get('SELECT * FROM accounts WHERE email=?', email);
    // Always perform the expensive comparison to avoid disclosing registered emails through timing.
    const digest = account?.password || `${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const [salt, expected] = digest.split(':');
    const key = await scrypt(typeof input.password === 'string' ? input.password.slice(0, 128) : '', salt, 64);
    if (!account || !timingSafeEqual(key, Buffer.from(expected, 'hex')) || account.status !== 'active') fail(401, 'Invalid credentials or inactive account.');
    return this.transaction(() => this.loginToken(account));
  }
  loginToken(account) {
    const token = randomBytes(32).toString('hex');
    const expires = this.clock() + 7 * 86400_000;
    this.run('INSERT INTO tokens(hash,account_id,kind,expires_at,max_calls,scopes) VALUES(?,?,?,?,?,?)', hash(token), account.id, 'session', expires, 0, '[]');
    return { token, expires_at: expires, account: { ...publicAccount(account), email: account.email } };
  }
  authenticate(token, scope = null) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail(401, 'Authentication required.');
    const credential = this.get('SELECT * FROM tokens WHERE hash=?', hash(token));
    if (!credential || credential.revoked || credential.expires_at <= this.clock()) fail(401, 'This session expired or was revoked.');
    const account = this.get('SELECT * FROM accounts WHERE id=?', credential.account_id);
    if (account.status !== 'active') fail(403, 'This operator account is suspended.');
    const agent = credential.agent_id ? this.get('SELECT * FROM agents WHERE id=?', credential.agent_id) : null;
    if (credential.kind === 'runtime') {
      if (!agent || agent.status !== 'active') fail(403, 'This agent is paused or revoked.');
      if (scope && credential.used_calls >= credential.max_calls) fail(429, 'The runtime action budget is exhausted.');
      if (scope && !parse(credential.scopes).includes(scope)) fail(403, 'This session does not permit that action.');
    }
    return { account, agent, kind: credential.kind, credential };
  }
  charge(actor) {
    if (actor.kind !== 'runtime') return;
    this.run('UPDATE tokens SET used_calls=used_calls+1 WHERE hash=?', actor.credential.hash);
    this.run('UPDATE agents SET last_seen=?,verified=1 WHERE id=?', this.clock(), actor.agent.id);
    const used = actor.credential.used_calls + 1;
    if (used === Math.ceil(actor.credential.max_calls * .8)) this.audit(actor.account.id, 'runtime.budget_warning', actor.agent.id);
  }
  active() { if (this.get("SELECT value FROM settings WHERE key='paused'").value === 'true') fail(503, 'The platform is paused.'); }
  me(actor) {
    role(actor, ['admin', 'member', 'reviewer', 'moderator']);
    const account = { ...publicAccount(actor.account), email: actor.account.email };
    return { account, agents: this.all('SELECT id,name,color,symbol,capabilities,limitations,status,verified,x,y,last_seen,world_id,posture,emote,emote_until,region_id,country FROM agents WHERE operator_id=? ORDER BY created_at', account.id) };
  }
  invite(actor, input) {
    role(actor, ['admin']);
    if (!['member', 'reviewer', 'moderator'].includes(input.role)) fail(400, 'Choose member, reviewer, or moderator.');
    const code = randomBytes(24).toString('hex');
    this.run('INSERT INTO invites VALUES(?,?,?,NULL)', hash(code), input.role, this.clock() + 7 * 86400_000);
    this.audit(actor.account.id, 'invitation.created');
    return { code, role: input.role, expires_at: this.clock() + 7 * 86400_000 };
  }
  createAgent(actor, input) {
    role(actor, ['admin', 'member', 'reviewer', 'moderator']); this.active();
    if (this.get("SELECT COUNT(*) AS n FROM agents WHERE operator_id=? AND status!='deleted'", actor.account.id).n >= 5) fail(429, 'Each operator can register five agents.');
    const id = randomUUID();
    const name = text(input.name, 'Agent name', 40);
    const color = ['#3d5875', '#8c6ab1', '#cb725f', '#397f79', '#aa7845'].includes(input.color) ? input.color : '#397f79';
    const symbol = ['✦', '◆', '✿', '▲'].includes(input.symbol) ? input.symbol : '✦';
    const region = input.region_id || 'commons';
    if (!REGIONS.some((item) => item.id === region)) fail(400, 'Choose a listed home region.');
    const country = text(input.country, 'Country of origin', 80, true);
    this.run('INSERT INTO agents(id,operator_id,name,color,symbol,capabilities,limitations,x,y,created_at,region_id,country) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, actor.account.id, name, color, symbol, text(input.capabilities, 'Capabilities', 300, true), text(input.limitations, 'Limitations', 300, true), start.x, start.y, now(), region, country);
    this.audit(actor.account.id, 'agent.created', id);
    this.createHome(id, name);
    this.recordVisit(actor, id, 'commons');
    return this.get('SELECT id,name,status FROM agents WHERE id=?', id);
  }
  ownedAgent(actor, id) {
    const agent = this.get('SELECT * FROM agents WHERE id=?', id);
    if (!agent || (actor.kind === 'runtime' ? actor.agent.id !== id : agent.operator_id !== actor.account.id)) fail(404, 'Agent not found.');
    return agent;
  }
  emote(actor, input) {
    this.active();
    const agent = this.ownedAgent(actor, input.agent_id || actor.agent?.id);
    if (agent.status !== 'active') fail(403, 'The agent is paused.');
    if (!['wave', 'bow', 'cheer', 'think', 'heart', 'none'].includes(input.emote)) fail(400, 'Choose wave, bow, cheer, think, heart, or none.');
    if (input.emote !== 'none' && this.clock() - agent.last_emote < 5000) fail(429, 'Allow five seconds between expressions.');
    const until = input.emote === 'none' ? 0 : this.clock() + 10000;
    this.run('UPDATE agents SET emote=?,emote_until=?,last_emote=?,last_seen=? WHERE id=?', input.emote, until, this.clock(), this.clock(), agent.id);
    return { agent_id: agent.id, emote: input.emote, emote_until: until };
  }
  agentControl(actor, id, status) {
    role(actor, ['admin', 'member', 'reviewer', 'moderator']); this.ownedAgent(actor, id);
    if (!['active', 'paused', 'revoked'].includes(status)) fail(400, 'Invalid agent status.');
    const current = this.get('SELECT status FROM agents WHERE id=?', id).status;
    if (current === 'suspended') fail(403, 'Only a moderator can lift this suspension.');
    this.run('UPDATE agents SET status=? WHERE id=?', status, id);
    if (status !== 'active') this.run("UPDATE tokens SET revoked=1 WHERE agent_id=?", id);
    this.audit(actor.account.id, `agent.${status}`, id);
    return { status };
  }
  runtime(actor, agentId, input) {
    role(actor, ['admin', 'member', 'reviewer', 'moderator']); this.active();
    const agent = this.ownedAgent(actor, agentId);
    if (agent.status !== 'active') fail(409, 'Resume the agent first.');
    if (this.get("SELECT hash FROM tokens WHERE account_id=? AND kind='runtime' AND agent_id!=? AND revoked=0 AND expires_at>? AND used_calls<max_calls", actor.account.id, agentId, this.clock())) fail(429, 'Each operator can run one active agent session. Stop the other session first.');
    const duration = Number(input.minutes ?? 10), maxCalls = Number(input.max_calls ?? 100);
    if (!Number.isInteger(duration) || duration < 1 || duration > 20 || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 500) fail(400, 'Sessions allow 1–20 minutes and 1–500 API calls.');
    const scopes = input.scopes || ['read', 'move', 'chat', 'contribute'];
    if (!Array.isArray(scopes) || !scopes.length || scopes.some((item) => !['read', 'move', 'chat', 'contribute', 'build'].includes(item))) fail(400, 'Invalid action scopes.');
    this.run('UPDATE tokens SET revoked=1 WHERE agent_id=?', agentId);
    const token = randomBytes(32).toString('hex');
    const expires = this.clock() + duration * 60_000;
    this.run('INSERT INTO tokens(hash,account_id,agent_id,kind,expires_at,max_calls,scopes) VALUES(?,?,?,?,?,?,?)', hash(token), actor.account.id, agentId, 'runtime', expires, maxCalls, JSON.stringify(scopes));
    this.audit(actor.account.id, 'runtime.started', agentId);
    return { token, agent_id: agentId, expires_at: expires, max_calls: maxCalls, scopes };
  }
  runtimeStatus(actor) {
    if (actor.kind !== 'runtime') fail(403, 'Use a runtime credential.');
    return { agent_id: actor.agent.id, scopes: parse(actor.credential.scopes), expires_at: actor.credential.expires_at, remaining_calls: actor.credential.max_calls - actor.credential.used_calls, paused: this.get("SELECT value FROM settings WHERE key='paused'").value === 'true' };
  }
  message(actor, input) {
    this.active();
    const agent = input.agent_id || actor.agent?.id ? this.ownedAgent(actor, input.agent_id || actor.agent.id) : null;
    if (agent && agent.status !== 'active') fail(403, 'The agent is paused.');
    const worldId = agent?.world_id || input.world_id || 'commons';
    this.space(actor, worldId);
    const content = text(input.text, 'Message', 500);
    const channel = input.channel || 'public';
    if (!['public', 'nearby', 'private', 'mission'].includes(channel)) fail(400, 'Invalid conversation channel.');
    const recent = this.get('SELECT created_at FROM messages WHERE account_id=? ORDER BY created_at DESC LIMIT 1', actor.account.id);
    if (recent && this.clock() - Date.parse(recent.created_at) < 1500) fail(429, 'Please wait before sending another message.');
    let recipients = [], missionId = null;
    if (['nearby', 'private'].includes(channel) && !agent) fail(400, 'Select an agent avatar for this channel.');
    if (channel === 'private') {
      const target = this.get("SELECT id FROM agents WHERE id=? AND status='active'", input.recipient_id || '');
      if (!target || target.id === agent.id) fail(400, 'Select another active avatar.');
      recipients = [agent.id, target.id];
    }
    if (channel === 'nearby') recipients = this.all("SELECT id FROM agents WHERE status='active' AND world_id=? AND ABS(x-?)+ABS(y-?)<=3", worldId, agent.x, agent.y).map((item) => item.id);
    if (channel === 'mission') { missionId = text(input.mission_id, 'Mission', 80); if (!this.get('SELECT id FROM missions WHERE id=?', missionId)) fail(404, 'Mission not found.'); }
    const id = randomUUID();
    this.run('INSERT INTO messages(id,agent_id,account_id,channel,mission_id,recipients,text,created_at,world_id) VALUES(?,?,?,?,?,?,?,?,?)', id, agent?.id || null, actor.account.id, channel, missionId, JSON.stringify(recipients), content, new Date(this.clock()).toISOString(), worldId);
    if (agent) this.run('UPDATE agents SET last_seen=?,verified=CASE WHEN ?=1 THEN 1 ELSE verified END WHERE id=?', this.clock(), actor.kind === 'runtime' ? 1 : 0, agent.id);
    return { id };
  }
  expireClaims() {
    const expired = this.all("SELECT * FROM claims WHERE status IN ('leased','changes_requested') AND expires_at<=?", this.clock());
    for (const claim of expired) {
      this.run("UPDATE claims SET status='expired' WHERE id=?", claim.id);
      this.run("UPDATE tasks SET status='open' WHERE id=? AND status IN ('leased','changes_requested')", claim.task_id);
      this.audit(claim.account_id, 'claim.expired', claim.id);
    }
  }
  missionList(actor = null) {
    this.expireClaims();
    const missions = this.all('SELECT m.*,o.name AS owner,r.name AS reviewer FROM missions m LEFT JOIN accounts o ON o.id=m.owner_id LEFT JOIN accounts r ON r.id=m.reviewer_id').filter((mission) => mission.status !== 'draft' || (actor?.kind === 'session' && (actor.account.role === 'admin' || [mission.owner_id, mission.reviewer_id].includes(actor.account.id))));
    const ids = new Set(missions.map((mission) => mission.id));
    return { missions, tasks: this.all('SELECT * FROM tasks').filter((task) => ids.has(task.mission_id)).map((task) => ({ ...task, allowed_domains: parse(task.allowed_domains), allowed_actions: ['read-approved-sources', 'submit-evidence'], risk: 'low', lease_minutes: 20 })) };
  }
  createMission(actor, input) {
    role(actor, ['admin', 'reviewer']); this.active();
    const reviewer = this.get("SELECT id FROM accounts WHERE id=? AND role IN ('reviewer','admin') AND status='active'", input.reviewer_id || actor.account.id);
    if (!reviewer) fail(400, 'Assign an active human reviewer.');
    const owner = input.owner_id || actor.account.id;
    if (!this.get("SELECT id FROM accounts WHERE id=? AND status='active'", owner)) fail(400, 'Assign an active mission owner.');
    const id = randomUUID();
    const area = text(input.area, 'Mission area', 40);
    if (!['Climate', 'Peace', 'Accessibility', 'Agriculture', 'Health', 'Education', 'Water', 'Energy', 'Trade', 'Governance', 'Biodiversity', 'Development'].includes(area)) fail(400, 'Choose a supported mission area.');
    this.run('INSERT INTO missions VALUES(?,?,?,?,?,?,?,?,?,0,?)', id, text(input.title, 'Title', 100), area, text(input.summary, 'Purpose and scope'), owner, text(input.beneficiary, 'Beneficiary'), reviewer.id, text(input.rubric, 'Acceptance rubric'), 'draft', now());
    this.audit(actor.account.id, 'mission.created', id);
    return { id };
  }
  missionStatus(actor, id, status) {
    role(actor, ['admin', 'reviewer']);
    const mission = this.get('SELECT * FROM missions WHERE id=?', id);
    if (!mission || (actor.account.role !== 'admin' && mission.owner_id !== actor.account.id)) fail(403, 'Mission owner permission required.');
    if (!['open', 'paused', 'closed'].includes(status)) fail(400, 'Invalid mission status.');
    if (status === 'open' && (!mission.owner_id || !mission.reviewer_id || !mission.beneficiary || !this.get("SELECT id FROM accounts WHERE id=? AND status='active' AND role IN ('reviewer','admin')", mission.reviewer_id) || !this.get("SELECT id FROM accounts WHERE id=? AND status='active'", mission.owner_id))) fail(409, 'An active owner, reviewer, and beneficiary are required.');
    this.run('UPDATE missions SET status=? WHERE id=?', status, id);
    this.audit(actor.account.id, `mission.${status}`, id);
    return { status };
  }
  createTask(actor, input) {
    role(actor, ['admin', 'reviewer']); this.active();
    const mission = this.get('SELECT * FROM missions WHERE id=?', input.mission_id || '');
    if (!mission || (actor.account.role !== 'admin' && mission.owner_id !== actor.account.id)) fail(403, 'Mission owner permission required.');
    const domains = input.allowed_domains || [];
    if (!Array.isArray(domains) || domains.length > 20 || domains.some((domain) => typeof domain !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain))) fail(400, 'Provide explicit source hostnames.');
    if (!mission.demo && domains.length === 0) fail(400, 'Real tasks need an approved source domain list.');
    const id = randomUUID();
    this.run('INSERT INTO tasks(id,mission_id,title,instructions,rights,allowed_domains) VALUES(?,?,?,?,?,?)', id, mission.id, text(input.title, 'Task title', 100), text(input.instructions, 'Deliverable and evidence requirements'), text(input.rights, 'Input rights and permissions'), JSON.stringify(domains));
    this.audit(actor.account.id, 'task.created', id);
    return { id };
  }
  claim(actor, input, key) {
    this.active(); this.expireClaims();
    text(key, 'Idempotency key', 100);
    const previous = this.get('SELECT * FROM claims WHERE account_id=? AND idempotency_key=?', actor.account.id, key);
    if (previous) {
      if (actor.kind === 'runtime' && previous.agent_id !== actor.agent.id) fail(404, 'Claim not found.');
      if (previous.task_id !== input.task_id) fail(409, 'This idempotency key was used for another task.');
      return previous;
    }
    const task = this.get('SELECT t.*,m.status AS mission_status FROM tasks t JOIN missions m ON m.id=t.mission_id WHERE t.id=?', input.task_id || '');
    if (!task) fail(404, 'Task not found.');
    if (!['open', 'demo'].includes(task.mission_status) || task.status !== 'open') fail(409, 'This task is not open.');
    this.reviewCapacity(task.mission_id);
    if (this.get("SELECT id FROM claims WHERE account_id=? AND status IN ('leased','submitted','changes_requested')", actor.account.id)) fail(429, 'Each operator may have one active task across all agents.');
    const agent = input.agent_id || actor.agent?.id ? this.ownedAgent(actor, input.agent_id || actor.agent.id) : null;
    if (agent && agent.status !== 'active') fail(403, 'The agent is paused.');
    const id = randomUUID();
    this.run('INSERT INTO claims VALUES(?,?,?,?,?,?,?,?,?)', id, task.id, task.version, actor.account.id, agent?.id || null, 'leased', this.clock() + 20 * 60_000, key, now());
    this.run("UPDATE tasks SET status='leased' WHERE id=?", task.id);
    this.audit(actor.account.id, 'claim.created', id);
    return this.get('SELECT * FROM claims WHERE id=?', id);
  }
  ownedClaim(actor, id) {
    const claim = this.get('SELECT * FROM claims WHERE id=?', id);
    if (!claim || claim.account_id !== actor.account.id || (actor.kind === 'runtime' && claim.agent_id !== actor.agent.id)) fail(404, 'Claim not found.');
    return claim;
  }
  releaseClaim(actor, id) {
    this.expireClaims(); const claim = this.ownedClaim(actor, id);
    if (!['leased', 'changes_requested'].includes(claim.status)) fail(409, 'Claim is not active.');
    this.run("UPDATE claims SET status='released' WHERE id=?", id);
    this.run("UPDATE tasks SET status='open' WHERE id=?", claim.task_id);
    this.audit(actor.account.id, 'claim.released', id);
    return { released: true };
  }
  submit(actor, input, key) {
    this.active(); this.expireClaims(); text(key, 'Idempotency key', 100);
    const claim = this.ownedClaim(actor, input.claim_id);
    const previous = this.get('SELECT * FROM submissions WHERE claim_id=? AND idempotency_key=?', claim.id, key);
    if (previous) return { ...previous, sources: parse(previous.sources), brief:storedDecisionBrief(previous.artifact,parse(previous.sources).length) };
    if (!['leased', 'changes_requested'].includes(claim.status)) fail(409, 'Claim has expired or already been submitted.');
    const count = this.get("SELECT COUNT(*) AS n FROM submissions s JOIN claims c ON c.id=s.claim_id WHERE c.account_id=? AND date(s.created_at)=date('now')", actor.account.id).n;
    if (count >= 10) fail(429, 'The operator daily submission limit is ten.');
    const task = this.get('SELECT t.*,m.status AS mission_status FROM tasks t JOIN missions m ON m.id=t.mission_id WHERE t.id=?', claim.task_id);
    if (!['demo', 'open'].includes(task.mission_status)) fail(409, 'This mission is paused or closed.');
    this.reviewCapacity(task.mission_id);
    let artifact;
    if(!input.brief){artifact=text(input.artifact,'Plain text deliverable',16000);if(artifact.startsWith(BRIEF_MARKER))fail(400,'Submit structured decision briefs using the brief field.');}
    if (input.mime && !['text/plain', 'application/json'].includes(input.mime)) fail(400, 'Only plain text or JSON evidence is supported. Active uploads are rejected.');
    const sources = input.sources;
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 10) fail(400, 'Provide 1–10 sources with exact locations.');
    const domains = parse(task.allowed_domains);
    const normalized = sources.map((source) => {
      let url;
      try { url = new URL(source.url); } catch { fail(400, 'Source URL is invalid.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(400, 'Use an HTTP source URL without credentials.');
      if (domains.length && !domains.includes(url.hostname)) fail(400, 'This source is outside the task approved domains.');
      return { url: url.href, location: text(source.location, 'Source page or section', 300), date: text(source.date, 'Source date', 100, true) };
    });
    const brief=input.brief?normalizeDecisionBrief(input.brief,{sourceCount:normalized.length}):null;if(brief)artifact=serializeDecisionBrief(brief);
    const version = this.get('SELECT COALESCE(MAX(version),0)+1 AS n FROM submissions WHERE claim_id=?', claim.id).n;
    const id = randomUUID();
    this.run('INSERT INTO submissions VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, claim.id, version, artifact, JSON.stringify(normalized), text(input.method, 'Method'), text(input.limitations, 'Limitations'), text(input.rights, 'Rights or permission statement'), 'pending_review', key, now());
    this.run("UPDATE claims SET status='submitted' WHERE id=?", claim.id);
    this.run('UPDATE claim_drafts SET archived=1 WHERE claim_id=?',claim.id);
    this.run("UPDATE tasks SET status='under_review' WHERE id=?", claim.task_id);
    this.audit(actor.account.id, 'submission.created', id);
    return { id, version, status: 'pending_review',...(brief?{brief}:{} ) };
  }
  review(actor, input) {
    role(actor, ['admin', 'reviewer']); this.active();
    const submission = this.get('SELECT s.*,c.account_id,c.task_id,m.reviewer_id,m.demo FROM submissions s JOIN claims c ON c.id=s.claim_id JOIN tasks t ON t.id=c.task_id JOIN missions m ON m.id=t.mission_id WHERE s.id=?', input.submission_id || '');
    if (!submission) fail(404, 'Submission not found.');
    if (submission.account_id === actor.account.id) fail(403, 'An operator cannot review their own or their agents’ contributions.');
    if (!submission.demo && submission.reviewer_id !== actor.account.id && actor.account.role !== 'admin') fail(403, 'This mission has a different reviewer.');
    if (submission.status !== 'pending_review') fail(409, 'This version has already been reviewed.');
    if (!['accepted', 'changes_requested', 'rejected'].includes(input.decision)) fail(400, 'Invalid review decision.');
    const id = randomUUID();
    this.run('INSERT INTO reviews VALUES(?,?,?,?,?,?)', id, submission.id, actor.account.id, input.decision, text(input.reason, 'Review reason'), now());
    this.run('UPDATE submissions SET status=? WHERE id=?', input.decision, submission.id);
    this.run('UPDATE claims SET status=?,expires_at=? WHERE id=?', input.decision, this.clock() + 20 * 60_000, submission.claim_id);
    if(input.decision==='changes_requested')this.run('UPDATE claim_drafts SET archived=0 WHERE claim_id=?',submission.claim_id);
    this.run('UPDATE tasks SET status=? WHERE id=?', input.decision === 'rejected' ? 'open' : input.decision, submission.task_id);
    this.audit(actor.account.id, `review.${input.decision}`, id);
    return { id, decision: input.decision };
  }
  reviewCapacity(missionId) {
    const mission = this.get('SELECT * FROM missions WHERE id=?', missionId);
    if (mission.demo) return;
    const owner = this.get("SELECT id FROM accounts WHERE id=? AND status='active'", mission.owner_id);
    const reviewer = this.get("SELECT id FROM accounts WHERE id=? AND status='active' AND role IN ('admin','reviewer')", mission.reviewer_id);
    if (!owner || !reviewer) fail(409, 'The mission owner or review capacity is unavailable.');
  }
  history(actor) {
    const reviewer = actor.kind === 'session' && ['admin', 'reviewer'].includes(actor.account.role);
    const predicate = reviewer ? '(m.demo=1 OR m.reviewer_id=? OR ?=1 OR c.account_id=?)' : 'c.account_id=?';
    const args = reviewer ? [actor.account.id, actor.account.role === 'admin' ? 1 : 0, actor.account.id] : [actor.account.id];
    const submissions = this.all(`SELECT s.*,c.task_id,c.agent_id,c.account_id,o.name AS contributor,a.name AS agent_name FROM submissions s JOIN claims c ON c.id=s.claim_id JOIN tasks t ON t.id=c.task_id JOIN missions m ON m.id=t.mission_id JOIN accounts o ON o.id=c.account_id LEFT JOIN agents a ON a.id=c.agent_id WHERE ${predicate} ORDER BY s.created_at DESC`, ...args).filter((s) => actor.kind !== 'runtime' || s.agent_id === actor.agent.id).map((s) => ({ ...s, sources: parse(s.sources),brief:storedDecisionBrief(s.artifact,parse(s.sources).length) }));
    const ids = new Set(submissions.map((s) => s.id));
    return {
      claims: this.all('SELECT * FROM claims WHERE account_id=? ORDER BY created_at DESC', actor.account.id).filter((c) => actor.kind !== 'runtime' || c.agent_id === actor.agent.id),
      submissions,
      drafts:actor.kind==='session'?this.drafts(actor):[],
      jobs: this.all(`SELECT j.*,a.name AS agent_name FROM jobs j JOIN agents a ON a.id=j.agent_id WHERE a.operator_id=?${actor.kind === 'runtime' ? ' AND j.agent_id=?' : ''} ORDER BY j.created_at DESC LIMIT 100`, actor.account.id, ...(actor.kind === 'runtime' ? [actor.agent.id] : [])),
      reviews: this.all('SELECT r.*,o.name AS reviewer FROM reviews r JOIN accounts o ON o.id=r.reviewer_id').filter((r) => ids.has(r.submission_id)),
    };
  }
  gallery() {
    return this.all(`SELECT s.id,s.artifact,s.sources,s.method,s.limitations,s.rights,s.version,s.created_at,c.task_id,c.agent_id,m.title AS mission,m.demo,COALESCE(a.name,o.name) AS contributor,r.reason,r.created_at AS reviewed_at,h.name AS reviewer,
      (SELECT COUNT(*) FROM adoptions d WHERE d.submission_id=s.id) AS adoption_count FROM submissions s JOIN claims c ON c.id=s.claim_id JOIN tasks t ON t.id=c.task_id JOIN missions m ON m.id=t.mission_id JOIN accounts o ON o.id=c.account_id LEFT JOIN agents a ON a.id=c.agent_id JOIN reviews r ON r.submission_id=s.id AND r.decision='accepted' JOIN accounts h ON h.id=r.reviewer_id WHERE s.status='accepted' ORDER BY s.created_at DESC`).map((s) => ({ ...s, sources: parse(s.sources),brief:storedDecisionBrief(s.artifact,parse(s.sources).length) }));
  }
  adoption(actor, input) {
    role(actor, ['admin', 'reviewer', 'member', 'moderator']);
    const record = this.get("SELECT s.id,m.owner_id FROM submissions s JOIN claims c ON c.id=s.claim_id JOIN tasks t ON t.id=c.task_id JOIN missions m ON m.id=t.mission_id WHERE s.id=? AND s.status='accepted'", input.submission_id || '');
    if (!record || record.owner_id !== actor.account.id) fail(403, 'Only the mission owner can record adoption of accepted work.');
    const id = randomUUID();
    this.run('INSERT INTO adoptions VALUES(?,?,?,?,?)', id, record.id, actor.account.id, text(input.note, 'Documented use'), now());
    this.audit(actor.account.id, 'adoption.recorded', id);
    return { id };
  }
  report(actor, input) {
    if (!['message', 'submission', 'agent'].includes(input.target_type)) fail(400, 'Invalid report target.');
    const table = { message: 'messages', submission: 'submissions', agent: 'agents' }[input.target_type];
    const target = this.get(`SELECT * FROM ${table} WHERE id=?`, input.target_id || '');
    if (!target) fail(404, 'Report target not found.');
    if (input.target_type === 'message' && !this.canReadMessage(actor, target)) fail(404, 'Message not found.');
    if (input.target_type === 'submission' && target.status !== 'accepted' && !this.history(actor).submissions.some((submission) => submission.id === target.id)) fail(404, 'Submission not found.');
    if (this.get("SELECT COUNT(*) AS n FROM reports WHERE reporter_id=? AND date(created_at)=date('now')", actor.account.id).n >= 10) fail(429, 'Daily report limit reached.');
    const id = randomUUID();
    this.run('INSERT INTO reports(id,reporter_id,target_type,target_id,reason,created_at) VALUES(?,?,?,?,?,?)', id, actor.account.id, input.target_type, target.id, text(input.reason, 'Report reason'), now());
    this.audit(actor.account.id, 'report.created', id);
    return { id };
  }
  moderate(actor, input) {
    role(actor, ['admin', 'moderator']);
    const report = this.get('SELECT * FROM reports WHERE id=?', input.report_id || '');
    if (!report || report.status !== 'open') fail(409, 'Report is not open.');
    if ([report.reporter_id, this.targetOwner(report)].includes(actor.account.id)) fail(403, 'An uninvolved moderator must decide this report.');
    if (!['dismiss', 'quarantine', 'suspend'].includes(input.action)) fail(400, 'Invalid moderation action.');
    const reason = text(input.reason, 'Decision reason');
    if (input.action === 'quarantine') {
      if (report.target_type === 'message') this.run("UPDATE messages SET status='quarantined' WHERE id=?", report.target_id);
      else if (report.target_type === 'submission') this.run("UPDATE submissions SET status='quarantined' WHERE id=?", report.target_id);
      else fail(400, 'Choose suspend for an agent.');
    }
    if (input.action === 'suspend') {
      if (report.target_type !== 'agent') fail(400, 'Suspend applies to an agent report.');
      this.run("UPDATE agents SET status='suspended' WHERE id=?", report.target_id);
      this.run('UPDATE tokens SET revoked=1 WHERE agent_id=?', report.target_id);
    }
    this.run('UPDATE reports SET status=?,resolution=?,moderator_id=? WHERE id=?', input.action, reason, actor.account.id, report.id);
    this.audit(actor.account.id, `moderation.${input.action}`, report.id);
    return { status: input.action };
  }
  safety(actor) {
    role(actor, ['admin', 'moderator', 'reviewer', 'member']);
    const moderator = actor.kind === 'session' && ['admin', 'moderator'].includes(actor.account.role);
    const reports = this.all('SELECT * FROM reports').filter((r) => moderator || r.reporter_id === actor.account.id || this.targetOwner(r) === actor.account.id);
    const ids = new Set(reports.map((r) => r.id));
    return { reports: reports.map((report) => { if (moderator || report.reporter_id === actor.account.id) return report; const { reporter_id, ...visible } = report; return visible; }), appeals: this.all('SELECT * FROM appeals').filter((a) => moderator || ids.has(a.report_id)) };
  }
  targetOwner(report) {
    if (report.target_type === 'agent') return this.get('SELECT operator_id FROM agents WHERE id=?', report.target_id)?.operator_id;
    if (report.target_type === 'message') return this.get('SELECT account_id FROM messages WHERE id=?', report.target_id)?.account_id;
    return this.get('SELECT c.account_id FROM submissions s JOIN claims c ON c.id=s.claim_id WHERE s.id=?', report.target_id)?.account_id;
  }
  appeal(actor, input) {
    role(actor, ['admin', 'moderator', 'reviewer', 'member']);
    const report = this.get('SELECT * FROM reports WHERE id=?', input.report_id || '');
    if (!report || !['dismiss', 'quarantine', 'suspend'].includes(report.status) || ![report.reporter_id, this.targetOwner(report)].includes(actor.account.id)) fail(404, 'This moderation decision is not available for your appeal.');
    if (this.get('SELECT id FROM appeals WHERE report_id=? AND account_id=?', report.id, actor.account.id)) fail(409, 'Your appeal for this decision is already recorded.');
    const id = randomUUID();
    this.run('INSERT INTO appeals(id,report_id,account_id,reason,created_at) VALUES(?,?,?,?,?)', id, report.id, actor.account.id, text(input.reason, 'Appeal reason'), now());
    this.audit(actor.account.id, 'appeal.created', id); return { id };
  }
  decideAppeal(actor, input) {
    role(actor, ['admin', 'moderator']);
    const appeal = this.get('SELECT a.*,r.moderator_id,r.target_type,r.target_id,r.reporter_id FROM appeals a JOIN reports r ON r.id=a.report_id WHERE a.id=?', input.appeal_id || '');
    if (!appeal || appeal.status !== 'open') fail(409, 'Appeal is not open.');
    if ([appeal.moderator_id, appeal.account_id, appeal.reporter_id, this.targetOwner(appeal)].includes(actor.account.id)) fail(403, 'A different, uninvolved human must decide this appeal.');
    if (!['upheld', 'overturned'].includes(input.decision)) fail(400, 'Invalid appeal decision.');
    const reason = text(input.reason, 'Appeal decision reason');
    if (input.decision === 'overturned') {
      this.run("UPDATE reports SET status='overturned' WHERE id=?", appeal.report_id);
      this.run("UPDATE appeals SET status='superseded',decision='The original decision was overturned in another appeal.' WHERE report_id=? AND id!=? AND status='open'", appeal.report_id, appeal.id);
      const otherSanction = this.get("SELECT id FROM reports WHERE target_type=? AND target_id=? AND status IN ('quarantine','suspend')", appeal.target_type, appeal.target_id);
      if (!otherSanction && appeal.target_type === 'agent') this.run("UPDATE agents SET status='paused' WHERE id=? AND status='suspended'", appeal.target_id);
      if (!otherSanction && appeal.target_type === 'message') this.run("UPDATE messages SET status='visible' WHERE id=? AND status='quarantined'", appeal.target_id);
      if (!otherSanction && appeal.target_type === 'submission') {
        const previous = this.get('SELECT decision FROM reviews WHERE submission_id=? ORDER BY created_at DESC LIMIT 1', appeal.target_id)?.decision || 'pending_review';
        this.run('UPDATE submissions SET status=? WHERE id=?', previous, appeal.target_id);
      }
    }
    this.run('UPDATE appeals SET status=?,decision=?,reviewer_id=? WHERE id=?', input.decision, reason, actor.account.id, appeal.id);
    this.audit(actor.account.id, `appeal.${input.decision}`, appeal.id); return { status: input.decision };
  }
  operations(actor) {
    role(actor, ['admin']);
    return { paused: this.get("SELECT value FROM settings WHERE key='paused'").value === 'true', accounts: this.all('SELECT id,name,role,status,created_at FROM accounts'), jobs: this.all('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100'), audit_valid: this.verifyAudit(), audit: this.all('SELECT seq,actor,event,record_id,created_at FROM audit ORDER BY seq DESC LIMIT 100'), runtime_budgets: this.all("SELECT agent_id,expires_at,max_calls,used_calls,revoked FROM tokens WHERE kind='runtime' ORDER BY expires_at DESC LIMIT 100") };
  }
  pause(actor, value) {
    role(actor, ['admin']);
    this.run("UPDATE settings SET value=? WHERE key='paused'", value ? 'true' : 'false');
    this.audit(actor.account.id, value ? 'platform.paused' : 'platform.resumed'); return { paused: Boolean(value) };
  }
  accountControl(actor, input) {
    role(actor, ['admin']);
    if (input.account_id === actor.account.id) fail(400, 'You cannot change your own admin role or status.');
    if (!this.get('SELECT id FROM accounts WHERE id=?', input.account_id || '')) fail(404, 'Account not found.');
    if (input.role) {
      if (!['member', 'reviewer', 'moderator'].includes(input.role)) fail(400, 'Invalid account role.');
      this.run('UPDATE accounts SET role=? WHERE id=?', input.role, input.account_id);
    }
    if (input.status) {
      if (!['active', 'suspended'].includes(input.status)) fail(400, 'Invalid account status.');
      this.run('UPDATE accounts SET status=? WHERE id=?', input.status, input.account_id);
      if (input.status === 'suspended') this.run('UPDATE tokens SET revoked=1 WHERE account_id=?', input.account_id);
    }
    this.audit(actor.account.id, 'account.updated', input.account_id); return { updated: true };
  }
  exportAccount(actor) {
    role(actor, ['admin', 'member', 'reviewer', 'moderator']);
    const history = this.history({ ...actor, account: { ...actor.account, role: 'member' } });
    const agents = this.me(actor).agents;
    const messages = this.all(`SELECT m.id,m.agent_id,m.account_id,m.channel,m.mission_id,m.text,m.status,m.created_at,m.world_id FROM messages m WHERE m.account_id=? OR (m.status='visible' AND m.channel='private' AND EXISTS(SELECT 1 FROM json_each(m.recipients) r JOIN agents a ON a.id=r.value WHERE a.operator_id=?)) ORDER BY m.created_at`, actor.account.id, actor.account.id);
    const worlds = this.all('SELECT w.* FROM worlds w JOIN agents a ON a.id=w.owner_agent_id WHERE a.operator_id=?', actor.account.id);
    const world_objects = this.all('SELECT b.* FROM world_objects b JOIN worlds w ON w.id=b.world_id JOIN agents a ON a.id=w.owner_agent_id WHERE a.operator_id=?', actor.account.id);
    return { format: 'shared-world-account-v6', exported_at: now(), account: { ...publicAccount(actor.account), email: actor.account.email }, agents, worlds, world_objects, ...history,drafts:this.drafts(actor,{archived:true,all:true}), messages, community: this.communityExport(actor), journey: this.journeyExport(actor), civic: this.civicExport(actor), moderation: this.safety({ ...actor, account: { ...actor.account, role: 'member' } }) };
  }
  deleteAccount(actor) {
    role(actor, ['member', 'reviewer', 'moderator']);
    if (this.get("SELECT id FROM missions WHERE (owner_id=? OR reviewer_id=?) AND status='open'", actor.account.id, actor.account.id)) fail(409, 'Transfer or close your active missions before deleting your account.');
    this.run('DELETE FROM claim_drafts WHERE claim_id IN (SELECT id FROM claims WHERE account_id=?)',actor.account.id);
    this.deleteCommunity(actor);
    this.deleteJourney(actor);
    this.run("DELETE FROM mayor_conversations WHERE account_id=?", actor.account.id);
    for (const claim of this.all("SELECT * FROM claims WHERE account_id=? AND status IN ('leased','changes_requested')", actor.account.id)) {
      this.run("UPDATE claims SET status='cancelled' WHERE id=?", claim.id);
      this.run("UPDATE tasks SET status='open' WHERE id=?", claim.task_id);
    }
    this.run("UPDATE accounts SET name='Deleted member',email=?,password=?,status='deleted' WHERE id=?", `${randomUUID()}@deleted.invalid`, `${'0'.repeat(32)}:${'0'.repeat(128)}`, actor.account.id);
    this.run("UPDATE agents SET name='Deleted agent',capabilities='',limitations='',status='deleted' WHERE operator_id=?", actor.account.id);
    this.run("UPDATE agents SET world_id='commons',x=?,y=? WHERE world_id IN (SELECT w.id FROM worlds w JOIN agents a ON a.id=w.owner_agent_id WHERE a.operator_id=?) AND operator_id!=?", start.x, start.y, actor.account.id, actor.account.id);
    this.run('DELETE FROM world_objects WHERE world_id IN (SELECT w.id FROM worlds w JOIN agents a ON a.id=w.owner_agent_id WHERE a.operator_id=?)', actor.account.id);
    this.run("UPDATE worlds SET name='Deleted home',visibility='private' WHERE owner_agent_id IN (SELECT id FROM agents WHERE operator_id=?)", actor.account.id);
    this.run('UPDATE tokens SET revoked=1 WHERE account_id=?', actor.account.id);
    this.run("UPDATE messages SET text='[removed]',status='deleted' WHERE account_id=?", actor.account.id);
    this.audit(actor.account.id, 'account.deleted', actor.account.id); return { deleted: true };
  }
  recoverWorkerJobs() {
    const interrupted = this.all("SELECT id FROM jobs WHERE status='running'");
    for (const job of interrupted) {
      this.run("UPDATE jobs SET status='stopped',detail=? WHERE id=?", 'Server restarted before this worker finished. Check contributions before retrying; release an unsubmitted claim or wait for its lease to expire.', job.id);
      this.audit('system', 'research.worker.interrupted', job.id);
    }
    return interrupted.length;
  }
  job(actor, input) {
    if (actor.kind !== 'runtime') fail(403, 'A runtime credential is required.');
    if (!['completed', 'failed', 'stopped'].includes(input.status)) fail(400, 'Invalid job status.');
    const id = randomUUID();
    this.run('INSERT INTO jobs VALUES(?,?,?,?,?)', id, actor.agent.id, input.status, text(input.detail, 'Run summary', 500), now());
    this.audit(actor.account.id, `job.${input.status}`, id); return { id };
  }
  logout(actor) { this.run('UPDATE tokens SET revoked=1 WHERE hash=?', actor.credential.hash); return { logged_out: true }; }
  close() { this.db.close(); }
}
Object.assign(Platform.prototype, spaceMethods, communityMethods, journeyMethods, civicMethods);

Object.assign(Platform.prototype,draftMethods);

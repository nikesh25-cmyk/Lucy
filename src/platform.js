import {coinMethods,verifyCoinLedger,UNIT_SEPARATION_POLICY} from './coins.js';
import {missionDirectory} from './mission-directory.js';
import { createDeliveryPacket } from './delivery-packet.js';
import { assessmentReason, adoptionDeclaration, ADOPTION_BOUNDARY, citationComparison, requestedChangesReason, storedAdoption, storedRequestedChanges, submissionState } from './review-assessment.js';
import { draftMethods } from './drafts.js';
import { assessMission } from './mission-quality.js';
import { BRIEF_MARKER, normalizeDecisionBrief, serializeDecisionBrief, storedDecisionBrief } from './decision-brief.js';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { openDatabase } from './database.js';
import { start } from '../world.js';
import { spaceMethods } from './spaces.js';
import { communityMethods } from './community.js';
import { vocationMethods } from './vocations.js';
import { vaultMethods } from './vault.js';
import { firstPlayMethods } from './firstplay.js';
import { questMethods } from './quests.js';
import { guildMethods } from './guilds.js';
import { journeyMethods } from './journey.js';
import { civicMethods } from './civic-engine.js';
import { REGIONS } from './civic.js';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { classifyResidentRun, storageUsage, integritySnapshot, backupInventory, redactDiagnostics, RECOVERY_LIMITS, INTERRUPTION_SUMMARY, RESIDENT_RUN_PHASES, RESIDENT_RUN_STATUSES, EVIDENCE_LIMITS, EVIDENCE_KINDS, evidenceSourceKey } from './recovery.js';

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
// Bounded reads: each listing below returns the most recent records up to these limits.
const MISSION_LIMIT = 200, GALLERY_LIMIT = 200, SAFETY_LIMIT = 200, HISTORY_LIMIT = 200, EXPORT_LIMIT = 500;
// How many guild projects one runtime observes at once. The board a resident reads is the public
// board plus its own operator's private projects, capped so a participation decision stays bounded.
const GUILD_OBSERVATION_LIMIT = 5;
const parsed = (value) => { try { const item = JSON.parse(value || '{}'); return item && typeof item === 'object' && !Array.isArray(item) ? item : {}; } catch { return {}; } };
// The five states an evidence citation can be in. A declared hash without retained, checked bytes
// remains visible for review but is never presented as captured support.
const EVIDENCE_STATE_NOTES = Object.freeze({
  captured: 'This citation is pinned to retained source bytes whose stored SHA-256 was checked; no newer retained version is held. Source identity and factual claims still need human review.',
  missing: 'No matching source bytes are retained and checked for this citation. A link or contributor-declared hash alone is not verified evidence and must not be presented as support.',
  stale: 'A newer version of this source is retained than the one cited. The cited version is unchanged; the difference is shown, never rewritten.',
  replaced: 'A newer version explicitly supersedes the cited one. The original version is retained and remains visible.',
  withdrawn: 'The source is withdrawn or unavailable. The cited version is retained exactly as it was captured.',
});
const evidenceStamp = (value) => typeof value === 'string' && (value.length === 24 && value === new Date(value).toISOString() || /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value);
// The public shape of one library record. Bytes retained under catalog/ are referenced, never copied.
// A hash-only record is an assertion, not a capture of source bytes.
const captureView = (capture) => ({
  id: capture.id, seq: capture.seq, sha256: capture.sha256, bytes: capture.bytes, retained: Boolean(capture.retained),
  verification: capture.retained ? 'retained-bytes-hash-checked' : 'declared-hash-only',
  retained_path: capture.retained_path, retrieved_at: capture.retrieved_at, declared_date: capture.declared_date,
  unit: capture.unit, title: capture.title, locator: capture.locator, evidence_kind: capture.evidence_kind,
  provenance: capture.provenance, license: { name: capture.license_name, url: capture.license_url, attribution: capture.license_attribution },
  excerpt: capture.excerpt, origin: capture.origin, supersedes: capture.supersedes,
});
const evidenceState = (capture, versions, withdrawn) => {
  if (!capture?.retained) return 'missing';
  const retainedVersions = versions.filter((version) => version.retained);
  if (withdrawn) return 'withdrawn';
  if (retainedVersions.some((version) => version.seq > capture.seq && version.supersedes === capture.id)) return 'replaced';
  const newest = retainedVersions[retainedVersions.length - 1];
  return newest && newest.id !== capture.id ? 'stale' : 'captured';
};
const evidenceConflicts = (versions) => ({ declared_dates: [...new Set(versions.map((version) => version.declared_date).filter(Boolean))], units: [...new Set(versions.map((version) => version.unit).filter(Boolean))] });
// The reader's own host/DNS protection, reused here. A forbidden scheme, a literal IP, a localhost
// name or a host outside the stated allowlist fails closed before any evidence row is written.
const approvedEvidenceUrl = (value, domains) => {
  let url; try { url = new URL(value); } catch { fail(400, 'Evidence needs a valid source URL.'); }
  const allowlist = Array.isArray(domains) && domains.length ? domains : [url.hostname];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowlist.includes(url.hostname) || isIP(url.hostname) || url.hostname === 'localhost' || url.hostname.endsWith('.local')) fail(400, 'Evidence must reference an approved public HTTPS hostname.');
  return url;
};
// A stored resident run as the operator's own history renders it: the last confirmed action is an
// object, remaining model decisions are derived, and the credential hash is never exposed.
const runView = (row) => { const { credential_hash, ...rest } = row; return { ...rest, last_action: parsed(row.last_action), pending_action: parsed(row.pending_action), decisions_remaining: Math.max(0, row.decision_budget - row.model_calls) }; };
const residentInterruptionDetail = (run, interruption) => `Local resident interrupted: ${INTERRUPTION_SUMMARY[interruption]}. ${run.model_calls} model decisions, ${run.action_count} confirmed actions, ${run.failed_actions} refused actions. No action is repeated automatically and the run credential was revoked; resume it explicitly from your contributions.`.slice(0, 500);

export class Platform {
  constructor(path, clock = Date.now) {
    this.db = openDatabase(path);
    this.path = path;
    this.clock = clock;
    // The file-level integrity scan is the one expensive diagnostic read, so its result is reused
    // for a short window. `checked_at` reports when it actually ran, never when it was served.
    this.integrityCache = { at: Number.NEGATIVE_INFINITY, value: null };
    this.seed(); this.seedSpaces(); this.initCommunity(); this.initJourney(); this.initCivic(); this.initVocations(); this.initQuests(); this.initGuilds(); this.initEvidence();
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) {
      // A storage failure (a full disk) can make SQLite roll the transaction back itself. Reporting
      // the original failure is what lets an operator act; a masking "no transaction" error is not.
      try { this.db.exec('ROLLBACK'); } catch { /* SQLite already ended the transaction. */ }
      throw error;
    }
  }
  audit(actor, event, recordId = '') {
    const previous = this.get('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1')?.hash || '';
    const date = new Date(this.clock()).toISOString();
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
        if (input.invite !== undefined && input.invite !== null && input.invite !== '') {
          if (typeof input.invite !== 'string' || input.invite.length > 256) fail(403, 'A valid invitation is required.');
          invite = this.get('SELECT * FROM invites WHERE code_hash=? AND used_by IS NULL AND expires_at>?', hash(input.invite), this.clock());
          if (!invite) fail(403, 'A valid invitation is required.');
        } else if (this.registrationPolicy().mode !== 'open') fail(403, 'Public registration is closed. Ask an administrator for an invitation.');
      }
      if (this.get('SELECT id FROM accounts WHERE email=?', email)) fail(409, 'This account already exists.');
      const id = randomUUID();
      this.run('INSERT INTO accounts(id,name,email,password,role,consent_at,created_at) VALUES(?,?,?,?,?,?,?)', id, name, email, digest, first ? 'admin' : invite?.role || 'member', now(), now());
      if (invite) this.run('UPDATE invites SET used_by=? WHERE code_hash=?', id, invite.code_hash);
      this.audit(id, 'account.created', id);
      return this.loginToken(this.get('SELECT * FROM accounts WHERE id=?', id));
    });
  }
  registrationPolicy() {
    const mode = this.get("SELECT value FROM settings WHERE key='registration'")?.value === 'open' ? 'open' : 'closed';
    const first = this.get('SELECT COUNT(*) AS n FROM accounts').n === 0;
    return { mode, public_signup: !first && mode === 'open', first_admin_required: first };
  }
  registrationSettings(actor, input = {}) {
    role(actor, ['admin']);
    if (input.mode !== undefined) {
      if (!['open', 'closed'].includes(input.mode)) fail(400, 'Choose open or closed registration.');
      this.run("UPDATE settings SET value=? WHERE key='registration'", input.mode);
      this.audit(actor.account.id, 'registration.' + input.mode);
    }
    return this.registrationPolicy();
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
    return this.authorize(hash(token), scope);
  }
  // Resolution from a stored credential hash. The event channel keeps only the hash of a live
  // subscription's credential, so it can re-check revocation, expiry and scope without retaining the
  // secret itself. The checks below are the same ones `authenticate` has always applied.
  authorize(credentialHash, scope = null) {
    if (typeof credentialHash !== 'string' || !/^[a-f0-9]{64}$/.test(credentialHash)) fail(401, 'Authentication required.');
    const credential = this.get('SELECT * FROM tokens WHERE hash=?', credentialHash);
    if (!credential || credential.revoked || credential.expires_at <= this.clock()) fail(401, 'This session expired or was revoked.');
    const account = this.get('SELECT * FROM accounts WHERE id=?', credential.account_id);
    if (account.status !== 'active') fail(403, 'This operator account is suspended.');
    const agent = credential.agent_id ? this.get('SELECT * FROM agents WHERE id=?', credential.agent_id) : null;
    if (credential.kind === 'runtime') {
      if (!agent || agent.kind !== 'agent' || agent.operator_id !== account.id || agent.status !== 'active') fail(403, 'This agent is paused, revoked, or unavailable to runtimes.');
      if (scope && credential.used_calls >= credential.max_calls) fail(429, 'The runtime action budget is exhausted.');
      if (scope && !parse(credential.scopes).includes(scope)) fail(403, 'This session does not permit that action.');
    }
    return { account, agent, kind: credential.kind, credential };
  }
  charge(actor) {
    if (actor.kind !== 'runtime') return;
    if (actor.agent?.kind !== 'agent') fail(403, 'Human avatars cannot use runtime actions.');
    this.run('UPDATE tokens SET used_calls=used_calls+1 WHERE hash=?', actor.credential.hash);
    this.run('UPDATE agents SET last_seen=?,verified=1 WHERE id=?', this.clock(), actor.agent.id);
    const used = actor.credential.used_calls + 1;
    if (used === Math.ceil(actor.credential.max_calls * .8)) this.audit(actor.account.id, 'runtime.budget_warning', actor.agent.id);
  }
  // The one read-entitlement decision: a caller may observe a world only through the same check the
  // `/world` route applies, so a private garden stays private on the event channel too. A violation
  // is reported as an ordinary `false`, not an error, because the caller is deciding eligibility.
  canReadWorld(actor, id) {
    try { this.space(actor, id); return true; }
    catch (error) { if ([403, 404].includes(error.status)) return false; throw error; }
  }
  active() { if (this.get("SELECT value FROM settings WHERE key='paused'").value === 'true') fail(503, 'The platform is paused.'); }
  me(actor) {
    role(actor, ['admin', 'member', 'reviewer', 'moderator']);
    const account = { ...publicAccount(actor.account), email: actor.account.email };
    return { account, agents: this.all('SELECT id,name,kind,color,symbol,capabilities,limitations,status,verified,x,y,z,yaw,pitch,last_look,last_seen,world_id,posture,emote,emote_until,region_id,country FROM agents WHERE operator_id=? ORDER BY created_at', account.id) };
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
    const kind = input.kind === undefined ? 'agent' : input.kind;
    if (!['agent', 'human'].includes(kind)) fail(400, 'Choose an agent or human avatar.');
    const existing = this.get("SELECT COUNT(*) AS n FROM agents WHERE operator_id=? AND kind=? AND status!='deleted'", actor.account.id, kind).n;
    if (existing >= (kind === 'human' ? 1 : 5)) fail(429, kind === 'human' ? 'Each account can create one human avatar.' : 'Each operator can register five agents.');
    const id = randomUUID();
    const name = text(input.name, kind === 'human' ? 'Avatar name' : 'Agent name', 40);
    const color = ['#3d5875', '#8c6ab1', '#cb725f', '#397f79', '#aa7845'].includes(input.color) ? input.color : '#397f79';
    const symbol = ['✦', '◆', '✿', '▲'].includes(input.symbol) ? input.symbol : '✦';
    const region = input.region_id || 'commons';
    if (!REGIONS.some((item) => item.id === region)) fail(400, 'Choose a listed home region.');
    const country = text(input.country, 'Country of origin', 80, true);
    this.run('INSERT INTO agents(id,operator_id,name,color,symbol,capabilities,limitations,x,y,created_at,region_id,country,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id, actor.account.id, name, color, symbol, text(input.capabilities, 'Capabilities', 300, true), text(input.limitations, 'Limitations', 300, true), start.x, start.y, now(), region, country, kind);
    this.audit(actor.account.id, kind === 'human' ? 'human.created' : 'agent.created', id);
    this.createHome(id, name);
    this.recordVisit(actor, id, 'commons');
    this.callings(actor,{agent_id:id});
    return this.get('SELECT id,name,kind,status FROM agents WHERE id=?', id);
  }
  ownedAgent(actor, id) {
    const agent = this.get('SELECT * FROM agents WHERE id=?', id);
    if (!agent || (actor.kind === 'runtime' ? actor.agent.id !== id || agent.kind !== 'agent' : agent.operator_id !== actor.account.id)) fail(404, 'Agent not found.');
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
    this.events?.publish(agent.world_id, { agents: [{ id: agent.id, x: agent.x, y: agent.y, z: agent.z, posture: agent.posture, status: agent.status, emote: input.emote, emote_until: until }] });
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
    const currentAgent = this.get('SELECT x,y,z,posture,world_id FROM agents WHERE id=?', id);
    this.events?.publish(currentAgent.world_id, { agents: [{ id, x: currentAgent.x, y: currentAgent.y, z: currentAgent.z, posture: currentAgent.posture, status }] });
    if (status !== 'active') this.events?.revalidateNow?.();
    return { status };
  }
  runtime(actor, agentId, input) {
    role(actor, ['admin', 'member', 'reviewer', 'moderator']); this.active();
    const agent = this.ownedAgent(actor, agentId);
    if (agent.kind !== 'agent') fail(403, 'Human avatars are controlled by their signed-in account and cannot receive runtime credentials.');
    if (agent.status !== 'active') fail(409, 'Resume the agent first.');
    if (this.get("SELECT hash FROM tokens WHERE account_id=? AND kind='runtime' AND agent_id!=? AND revoked=0 AND expires_at>? AND used_calls<max_calls", actor.account.id, agentId, this.clock())) fail(429, 'Each operator can run one active agent session. Stop the other session first.');
    const duration = Number(input.minutes ?? 10), maxCalls = Number(input.max_calls ?? 100);
    if (!Number.isInteger(duration) || duration < 1 || duration > 20 || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 500) fail(400, 'Sessions allow 1–20 minutes and 1–500 API calls.');
    const scopes = input.scopes || ['read', 'move', 'chat', 'contribute'];
    if (!Array.isArray(scopes) || !scopes.length || scopes.some((item) => !['read', 'move', 'chat', 'contribute', 'build', 'vault'].includes(item))) fail(400, 'Invalid action scopes.');
    this.run('UPDATE tokens SET revoked=1 WHERE agent_id=?', agentId);
    const token = randomBytes(32).toString('hex');
    const expires = this.clock() + duration * 60_000;
    this.run('INSERT INTO tokens(hash,account_id,agent_id,kind,expires_at,max_calls,scopes) VALUES(?,?,?,?,?,?,?)', hash(token), actor.account.id, agentId, 'runtime', expires, maxCalls, JSON.stringify(scopes));
    this.audit(actor.account.id, 'runtime.started', agentId);
    return { token, agent_id: agentId, expires_at: expires, max_calls: maxCalls, scopes };
  }
  runtimeStatus(actor) {
    if (actor.kind !== 'runtime' || actor.agent?.kind !== 'agent') fail(403, 'Use an agent runtime credential.');
    return { agent_id: actor.agent.id, scopes: parse(actor.credential.scopes), expires_at: actor.credential.expires_at, remaining_calls: actor.credential.max_calls - actor.credential.used_calls, paused: this.get("SELECT value FROM settings WHERE key='paused'").value === 'true' };
  }
  /**
   * The one derived fact a resident-to-resident action needs that the shared world read withholds:
   * whether each visible neighbour belongs to a *different* operator than the resident that is
   * asking. It is a boolean, never an identity: every resident of another operator reads `true`, so a
   * runtime credential learns only which visible residents belong to its own operator — information
   * about its own account — and never another operator's identity, name or account.
   *
   * It exists so an offer can be declined locally instead of being sent to a route that must refuse
   * it. The server still decides: `offerCreate` re-reads both operators and refuses a same-operator
   * offer whatever this view said.
   */
  differentOperatorView(actor, participants = []) {
    if (!actor?.account || actor.kind !== 'runtime') fail(403, 'A runtime credential is required.');
    const mine = new Set(this.all('SELECT id FROM agents WHERE operator_id=?', actor.account.id).map((agent) => agent.id));
    return participants.map((participant) => ({ ...participant, different_operator: !mine.has(participant.id) }));
  }
  /**
   * The bounded guild board one runtime observes: the visible projects its resident may join or leave,
   * and only the fields that decision and the prompt need — no participant list, no contribution
   * history and no other operator's identity. It reuses `guilds()` for the visibility rule and the
   * ordering, so a private project is exactly as invisible here as it is on the board.
   *
   * It adds no authority of its own. `guildParticipation` still decides every join and leave, and
   * neither this read nor that write grants a calling, an account role, a plot, building rights,
   * moderator or reviewer authority, or a NemoCoin.
   */
  guildObservation(actor, options = {}) {
    const board = this.guilds(actor, { ...options, limit: GUILD_OBSERVATION_LIMIT });
    return { viewer_agent_id: board.viewer_agent_id, total: board.total,
      projects: board.projects.map(({ id, guild_id, guild_name, title, summary, status, visibility, participation }) => ({
        id, guild_id, guild_name, title, summary, status, visibility,
        participation: { joined: Boolean(participation?.joined), state: participation?.state || null, role: participation?.role || null },
      })) };
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
    let recipients = [], missionId = null, privateEncounter = false;
    if (['nearby', 'private'].includes(channel) && !agent) fail(400, 'Select an agent avatar for this channel.');
    if (channel === 'private') {
      // A reply names an observed private message, never a free recipient. The server resolves the
      // sender from that message and refuses anyone the resident could not already read, so a
      // resident can answer the operator who messaged it but can never start a private conversation,
      // choose a recipient or read a thread it was not addressed in.
      let recipientId = input.recipient_id;
      if (input.reply_to !== undefined) {
        const original = this.get("SELECT id,agent_id,recipients,channel,status FROM messages WHERE id=?", typeof input.reply_to === 'string' ? input.reply_to : '');
        if (!original || original.channel !== 'private' || !this.canReadMessage(actor, original)) fail(404, 'That private message is not available to reply to.');
        if (original.agent_id === agent.id) fail(400, 'You cannot reply to your own message.');
        const others = parse(original.recipients).filter((id) => id !== agent.id);
        if (others.length !== 1) fail(409, 'This conversation cannot be continued.');
        recipientId = others[0];
      }
      const target = this.get("SELECT a.id,a.kind,a.operator_id,a.world_id,a.x,a.y,o.status AS operator_status FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.id=? AND a.status='active'", recipientId || '');
      if (!target || target.id === agent.id) fail(400, 'Select another active avatar.');
      recipients = [agent.id, target.id];
      // Private messages remain available across worlds. Only a private message sent while the
      // other operator's AI resident is physically within encounter range proves an in-world meet.
      // A reply is not a fresh encounter: only a human-initiated private message can prove an
      // in-world meeting, so a resident's answer never satisfies another operator's meet step.
      privateEncounter = input.reply_to === undefined && actor.account.status === 'active' && target.kind === 'agent' && target.operator_id !== agent.operator_id && target.operator_status === 'active'
        && target.world_id === agent.world_id && Math.abs(target.x - agent.x) + Math.abs(target.y - agent.y) <= 6;
    }
    if (channel === 'nearby') recipients = this.all("SELECT a.id FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.status='active' AND o.status='active' AND a.world_id=? AND ABS(a.x-?)+ABS(a.y-?)<=3", worldId, agent.x, agent.y).map((item) => item.id);
    if (channel === 'mission') { missionId = text(input.mission_id, 'Mission', 80); if (!this.get('SELECT id FROM missions WHERE id=?', missionId)) fail(404, 'Mission not found.'); }
    const id = randomUUID();
    this.run('INSERT INTO messages(id,agent_id,account_id,channel,mission_id,recipients,text,created_at,world_id) VALUES(?,?,?,?,?,?,?,?,?)', id, agent?.id || null, actor.account.id, channel, missionId, JSON.stringify(recipients), content, new Date(this.clock()).toISOString(), worldId);
    if (privateEncounter) this.audit(actor.account.id, 'firstplay.resident_met', `${agent.id}|${id}`);
    if (agent) this.run('UPDATE agents SET last_seen=?,verified=CASE WHEN ?=1 THEN 1 ELSE verified END WHERE id=?', this.clock(), actor.kind === 'runtime' ? 1 : 0, agent.id);
    // Only a public message in a world is ever pushed. Nearby, direct and mission conversations stay
    // in their own access-controlled routes and are never sent to an event subscriber.
    if (channel === 'public') this.events?.publish(worldId, { messages: [{ id, channel, text: content, created_at: new Date(this.clock()).toISOString(), world_id: worldId, author: agent?.name || actor.account.name, agent_id: agent?.id || null }] });
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
  missionList(actor = null, options = {}) {
    this.expireClaims();
    if(Object.keys(options).length)return missionDirectory(this,actor,options);
    const human = actor?.kind === 'session' ? actor : null, runtime = actor?.kind === 'runtime';
    const visible = "(m.status<>'draft' OR ?=1 OR m.owner_id=? OR m.reviewer_id=?)", args = [human?.account.role === 'admin' ? 1 : 0, human?.account.id || '', human?.account.id || ''];
    const total = this.get(`SELECT COUNT(*) AS n FROM missions m WHERE ${visible}`, ...args).n;
    const missions = this.all(`SELECT m.*,o.name AS owner,r.name AS reviewer FROM missions m LEFT JOIN accounts o ON o.id=m.owner_id LEFT JOIN accounts r ON r.id=m.reviewer_id WHERE ${visible} ORDER BY m.created_at DESC,m.id ASC LIMIT ?`, ...args, MISSION_LIMIT);
    const tasks = this.all('SELECT t.*,f.submission_id AS origin_submission_id,s.version AS origin_version,s.status AS origin_status FROM tasks t LEFT JOIN task_followups f ON f.task_id=t.id LEFT JOIN submissions s ON s.id=f.submission_id WHERE t.mission_id IN (SELECT value FROM json_each(?)) ORDER BY t.id', JSON.stringify(missions.map((mission) => mission.id))).map((task) => ({ ...task, allowed_domains: parse(task.allowed_domains), allowed_actions: ['read-approved-sources', 'submit-evidence'], risk: 'low', lease_minutes: 20 }));
    let active_claim = null;
    // A runtime sees its own character's lease; an operator session sees its own account's single
    // active lease. Both read the same claims store.
    if (runtime) {
      active_claim = this.get("SELECT c.*,t.title AS task_title FROM claims c JOIN tasks t ON t.id=c.task_id WHERE c.account_id=? AND c.agent_id=? AND c.status IN ('leased','changes_requested') ORDER BY c.created_at DESC LIMIT 1", actor.account.id, actor.agent.id) || null;
    } else if (human) {
      active_claim = this.get("SELECT c.*,t.title AS task_title FROM claims c JOIN tasks t ON t.id=c.task_id WHERE c.account_id=? AND c.status IN ('leased','changes_requested') ORDER BY c.created_at DESC LIMIT 1", actor.account.id) || null;
    }
    return { missions, tasks, total, offset: 0, limit: MISSION_LIMIT, has_more: missions.length < total, active_claim };
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
  createFollowUp(actor,input,key){
    role(actor,['admin','reviewer']);this.active();text(key,'Idempotency key',100);
    const origin=this.get('SELECT s.id,s.status,s.version,t.mission_id,(SELECT COUNT(*) FROM reviews r WHERE r.submission_id=s.id AND r.decision=\'accepted\') AS accepted_reviews FROM submissions s JOIN claims c ON c.id=s.claim_id JOIN tasks t ON t.id=c.task_id WHERE s.id=?',input.submission_id||'');
    if(!origin)fail(404,'Source contribution not found.');
    const mission=this.get('SELECT * FROM missions WHERE id=?',origin.mission_id);
    if(actor.account.role!=='admin'&&mission.owner_id!==actor.account.id)fail(403,'Mission owner permission required.');
    if(origin.status!=='accepted'||!origin.accepted_reviews)fail(409,'The source contribution must still be accepted.');
    if(!['open','demo'].includes(mission.status))fail(409,'Open the mission before creating follow-up work.');
    const normalized={submission_id:origin.id,title:text(input.title,'Follow-up title',100),instructions:text(input.instructions,'Follow-up deliverable and evidence requirements'),rights:text(input.rights,'Follow-up rights and permissions'),allowed_domains:input.allowed_domains};
    const fingerprint=hash(JSON.stringify(normalized)),previous=this.get('SELECT * FROM task_followups WHERE creator_id=? AND idempotency_key=?',actor.account.id,key);
    if(previous){if(previous.fingerprint!==fingerprint)fail(409,'This follow-up key was used for different work.');return {id:previous.task_id,mission_id:mission.id,origin_submission_id:origin.id,origin_version:origin.version,repeated:true};}
    const task=this.createTask(actor,{...normalized,mission_id:mission.id});
    this.run('INSERT INTO task_followups VALUES(?,?,?,?,?,?)',task.id,origin.id,actor.account.id,key,fingerprint,now());this.audit(actor.account.id,'task.followup_created',task.id);
    return {id:task.id,mission_id:mission.id,origin_submission_id:origin.id,origin_version:origin.version,repeated:false};
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
    // Pin each cited source to the exact evidence version it names. A citation with no capture keeps
    // its link and is recorded as unverified; the artifact itself is never rewritten.
    const citations = normalized.map((source, index) => { const cite = this.attachEvidence(source, index + 1); return { ...cite, submission_id: id, created_at: now() }; });
    for (const cite of citations) this.run('INSERT INTO submission_evidence(submission_id,source_number,capture_id,url,locator,cited_date,state,created_at) VALUES(?,?,?,?,?,?,?,?)', cite.submission_id, cite.source_number, cite.capture_id, cite.url, cite.locator, cite.cited_date, cite.state, cite.created_at);
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
    if (input.requested_changes != null && input.decision !== 'changes_requested') fail(400, 'Requested changes belong to a changes-requested decision.');
    const id = randomUUID();
    const assessed = assessmentReason(input.reason,input.assessment,storedDecisionBrief(submission.artifact,parse(submission.sources).length),input.decision);
    const changes = requestedChangesReason(assessed, input.requested_changes);
    this.run('INSERT INTO reviews VALUES(?,?,?,?,?,?)', id, submission.id, actor.account.id, input.decision, changes.reason, now());
    this.run('UPDATE submissions SET status=? WHERE id=?', input.decision, submission.id);
    this.run('UPDATE claims SET status=?,expires_at=? WHERE id=?', input.decision, this.clock() + 20 * 60_000, submission.claim_id);
    if(input.decision==='changes_requested')this.run('UPDATE claim_drafts SET archived=0 WHERE claim_id=?',submission.claim_id);
    this.run('UPDATE tasks SET status=? WHERE id=?', input.decision === 'rejected' ? 'open' : input.decision, submission.task_id);
    // Reopening a rejected task must not present its research lead as freshly activated.
    if(input.decision==='rejected')this.run("UPDATE research_leads SET status='rejected' WHERE task_id=?",submission.task_id);
    this.audit(actor.account.id, `review.${input.decision}`, id);
    const coin_reward=input.decision==='accepted'?this.awardCoins(actor,submission.id,id):null;
    return { id, decision: input.decision, state: submissionState(input.decision), requested_changes: changes.items, ...(coin_reward?{coin_reward}:{}) };
  }
  reviewCapacity(missionId) {
    const mission = this.get('SELECT * FROM missions WHERE id=?', missionId);
    if (mission.demo) return;
    const owner = this.get("SELECT id FROM accounts WHERE id=? AND status='active'", mission.owner_id);
    const reviewer = this.get("SELECT id FROM accounts WHERE id=? AND status='active' AND role IN ('admin','reviewer')", mission.reviewer_id);
    if (!owner || !reviewer) fail(409, 'The mission owner or review capacity is unavailable.');
  }
  history(actor) {
    const reviewer = actor.kind === 'session' && ['admin', 'reviewer'].includes(actor.account.role), runtime = actor.kind === 'runtime';
    const predicate = `${reviewer ? '(m.demo=1 OR m.reviewer_id=? OR ?=1 OR c.account_id=?)' : 'c.account_id=?'}${runtime ? ' AND c.agent_id=?' : ''}`;
    const args = reviewer ? [actor.account.id, actor.account.role === 'admin' ? 1 : 0, actor.account.id] : [actor.account.id];
    if (runtime) args.push(actor.agent.id);
    const submissions = this.all(`SELECT s.*,c.task_id,t.title AS task_title,c.agent_id,c.account_id,o.name AS contributor,a.name AS agent_name FROM submissions s JOIN claims c ON c.id=s.claim_id JOIN tasks t ON t.id=c.task_id JOIN missions m ON m.id=t.mission_id JOIN accounts o ON o.id=c.account_id LEFT JOIN agents a ON a.id=c.agent_id WHERE ${predicate} ORDER BY s.created_at DESC,s.rowid DESC LIMIT ?`, ...args, HISTORY_LIMIT).map((s) => ({ ...s, sources: parse(s.sources),brief:storedDecisionBrief(s.artifact,parse(s.sources).length) }));
    const ids = new Set(submissions.map((s) => s.id));
    const evidenceBySubmission = this.evidenceForSubmissions(submissions.map((s) => s.id));
    const adoptionsBySubmission = this.adoptionsForSubmissions(submissions.map((s) => s.id));
    const reviews = this.all('SELECT r.*,o.name AS reviewer FROM reviews r JOIN accounts o ON o.id=r.reviewer_id WHERE r.submission_id IN (SELECT value FROM json_each(?)) ORDER BY r.created_at DESC,r.rowid DESC', JSON.stringify([...ids])).map((review) => ({ ...review, requested_changes: review.decision === 'changes_requested' ? storedRequestedChanges(review.reason) : [] }));
    for (const submission of submissions) {
      submission.evidence = evidenceBySubmission[submission.id] || [];
      submission.adoptions = adoptionsBySubmission[submission.id] || [];
      submission.state = submissionState(submission.status, submission.adoptions.length > 0);
      // Exactly what the reviewer asked for, read back from the stored version-specific review record.
      submission.requested_changes = reviews.find((review) => review.submission_id === submission.id && review.decision === 'changes_requested')?.requested_changes || [];
    }
    // A resident's claim list grows for as long as the operator exists, so it takes the same
    // HISTORY_LIMIT bound as every other listing on this page. The runtime's own-agent filter is
    // applied in SQL, so a runtime sees the newest records that belong to it rather than the newest
    // records overall filtered afterwards.
    const claims = this.all(`SELECT c.*,t.title AS task_title FROM claims c JOIN tasks t ON t.id=c.task_id WHERE c.account_id=?${runtime ? ' AND c.agent_id=?' : ''} ORDER BY c.created_at DESC,c.rowid DESC LIMIT ?`, actor.account.id, ...(runtime ? [actor.agent.id] : []), HISTORY_LIMIT);
    const contextIds=JSON.stringify([...new Set([...claims.map(c=>c.task_id),...submissions.map(s=>s.task_id)])]);
    const tasks=this.all('SELECT t.*,f.submission_id AS origin_submission_id,s.version AS origin_version,s.status AS origin_status FROM tasks t LEFT JOIN task_followups f ON f.task_id=t.id LEFT JOIN submissions s ON s.id=f.submission_id WHERE t.id IN (SELECT value FROM json_each(?))',contextIds).map(task=>({...task,allowed_domains:parse(task.allowed_domains)}));
    const missions=this.all('SELECT m.* FROM missions m WHERE m.id IN (SELECT t.mission_id FROM tasks t WHERE t.id IN (SELECT value FROM json_each(?)))',contextIds);
    return {
      claims,tasks,missions,
      submissions,
      drafts:actor.kind==='session'?this.drafts(actor):[],
      jobs: this.all(`SELECT j.*,a.name AS agent_name FROM jobs j JOIN agents a ON a.id=j.agent_id WHERE a.operator_id=?${actor.kind === 'runtime' ? ' AND j.agent_id=?' : ''} ORDER BY j.created_at DESC LIMIT 100`, actor.account.id, ...(actor.kind === 'runtime' ? [actor.agent.id] : [])),
      runs: this.all(`SELECT r.*,a.name AS agent_name FROM resident_runs r JOIN agents a ON a.id=r.agent_id WHERE a.operator_id=?${actor.kind === 'runtime' ? ' AND r.agent_id=?' : ''} ORDER BY r.started_at DESC,r.id DESC LIMIT 50`, actor.account.id, ...(actor.kind === 'runtime' ? [actor.agent.id] : [])).map(runView),
      reviews,
    };
  }
  // One query for every adoption of the submissions on a page, with the declaring operator named.
  adoptionsForSubmissions(ids) {
    const unique = [...new Set(ids || [])].filter((id) => typeof id === 'string');
    if (!unique.length) return {};
    const marks = unique.map(() => '?').join(',');
    const bySubmission = {};
    for (const row of this.all(`SELECT d.id,d.submission_id,d.owner_id,d.note,d.created_at,o.name AS owner FROM adoptions d JOIN accounts o ON o.id=d.owner_id WHERE d.submission_id IN (${marks}) ORDER BY d.created_at ASC,d.rowid ASC`, ...unique)) {
      const { note: declaration, owner, ...rest } = row;
      (bySubmission[row.submission_id] ||= []).push({ ...rest, owner, declaration, ...storedAdoption(declaration), declaration_only: true });
    }
    return bySubmission;
  }
  gallery(submissionId=null) {
    const records = this.all(`SELECT s.id,s.status,s.artifact,s.sources,s.method,s.limitations,s.rights,s.version,s.created_at,c.task_id,c.agent_id,t.title AS task_title,m.title AS mission,m.demo,m.beneficiary,m.rubric,COALESCE(a.name,o.name) AS contributor,r.id AS review_id,r.decision AS review_decision,r.reason,r.created_at AS reviewed_at,h.name AS reviewer,
      (SELECT COUNT(*) FROM adoptions d WHERE d.submission_id=s.id) AS adoption_count FROM submissions s JOIN claims c ON c.id=s.claim_id JOIN tasks t ON t.id=c.task_id JOIN missions m ON m.id=t.mission_id JOIN accounts o ON o.id=c.account_id LEFT JOIN agents a ON a.id=c.agent_id JOIN reviews r ON r.submission_id=s.id AND r.decision='accepted' JOIN accounts h ON h.id=r.reviewer_id WHERE s.status='accepted'${submissionId?' AND s.id=?':''} ORDER BY s.created_at DESC,s.rowid DESC LIMIT ?`,...(submissionId?[submissionId]:[]),GALLERY_LIMIT).map((s) => ({ ...s, sources: parse(s.sources),brief:storedDecisionBrief(s.artifact,parse(s.sources).length) }));
    const evidenceBySubmission = this.evidenceForSubmissions(records.map((record) => record.id));
    const adoptionsBySubmission = this.adoptionsForSubmissions(records.map((record) => record.id));
    for (const record of records) {
      record.evidence = evidenceBySubmission[record.id] || [];
      record.adoptions = adoptionsBySubmission[record.id] || [];
      // The gallery only holds currently accepted work, so the state is accepted or adopted. A
      // quarantined or pending version is never shown here.
      record.state = submissionState(record.status, record.adoptions.length > 0);
    }
    return records;
  }
  deliveryPacket(input){
    const record=this.gallery(text(input.submission,'Submission identifier',100))[0];
    if(!record)fail(404,'Accepted contribution not found.');
    return createDeliveryPacket(record);
  }
  // Adoption is the mission owner's own recorded declaration, with the evidence they attach to it,
  // and it is refused when it would collapse two roles into one person: an operator cannot adopt
  // their own contribution, and the reviewer who accepted the version cannot adopt it either.
  adoption(actor, input) {
    role(actor, ['admin', 'reviewer', 'member', 'moderator']);
    const record = this.get(`SELECT s.id,s.version,s.status,c.account_id AS contributor_id,c.agent_id,m.id AS mission_id,m.owner_id,
      (SELECT r.id FROM reviews r WHERE r.submission_id=s.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1) AS review_id,
      (SELECT r.reviewer_id FROM reviews r WHERE r.submission_id=s.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1) AS reviewer_id,
      (SELECT r.decision FROM reviews r WHERE r.submission_id=s.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1) AS review_decision
      FROM submissions s JOIN claims c ON c.id=s.claim_id JOIN tasks t ON t.id=c.task_id JOIN missions m ON m.id=t.mission_id WHERE s.id=?`, input.submission_id || '');
    if (!record || record.owner_id !== actor.account.id) fail(403, 'Only the mission owner can record adoption of accepted work.');
    if (record.status !== 'accepted' || record.review_decision !== 'accepted') fail(409, 'Only a currently accepted contribution can be declared adopted.');
    if (record.contributor_id === actor.account.id) fail(403, 'An operator cannot adopt their own contribution; the adopter must be a different person from the contributor.');
    if (record.reviewer_id === actor.account.id) fail(403, 'The reviewer who accepted this version cannot adopt it; the adopter must be a different person from the reviewer.');
    const id = randomUUID();
    const declaration = adoptionDeclaration(input.note, input.evidence);
    this.run('INSERT INTO adoptions VALUES(?,?,?,?,?)', id, record.id, actor.account.id, declaration, now());
    this.audit(actor.account.id, 'adoption.recorded', id);
    return { id, submission_id: record.id, declaration, evidence_supplied: Boolean(storedAdoption(declaration).evidence), declaration_only: true, boundary: ADOPTION_BOUNDARY, state: submissionState('accepted', true) };
  }
  // ---- The reviewer workbench -------------------------------------------------------------------
  // One read-only view of everything a human reviewer needs for one submission version: the
  // criterion it is judged against, each cited source compared against the version the library holds
  // now, what a previous reviewer asked for, the four roles kept apart with the reason any of them is
  // refused, and the recorded adoptions. It writes nothing, so opening it can never change a state.
  reviewWorkbench(actor, options = {}) {
    if (actor?.kind !== 'session') fail(403, 'The reviewer workbench requires a human operator session.');
    const route = this.get(`SELECT s.id,s.status,s.version,s.created_at,s.artifact,s.sources,s.method,s.limitations,s.rights,
      c.account_id AS contributor_id,c.agent_id,c.status AS claim_status,t.id AS task_id,t.title AS task_title,t.instructions,
      m.id AS mission_id,m.title AS mission_title,m.summary AS mission_summary,m.beneficiary,m.rubric,m.demo,m.status AS mission_status,m.owner_id,m.reviewer_id
      FROM submissions s JOIN claims c ON c.id=s.claim_id JOIN tasks t ON t.id=c.task_id JOIN missions m ON m.id=t.mission_id WHERE s.id=?`, text(options.submission || options.submission_id || '', 'Submission identifier', 100));
    if (!route) fail(404, 'Submission not found.');
    // The same parties that can already read this contribution: its mission reviewer or owner, an
    // administrator, and the contributor themselves.
    const party = [route.reviewer_id, route.owner_id, route.contributor_id].includes(actor.account.id) || actor.account.role === 'admin';
    if (!route.demo && !party) fail(403, 'Only the mission owner, its reviewer, an administrator or the contributor can open this review.');
    const reviews = this.all('SELECT r.*,o.name AS reviewer FROM reviews r JOIN accounts o ON o.id=r.reviewer_id WHERE r.submission_id=? ORDER BY r.created_at DESC,r.rowid DESC', route.id);
    const latest = reviews[0] || null;
    const adoptions = this.adoptionsForSubmissions([route.id])[route.id] || [];
    const state = submissionState(route.status, adoptions.length > 0);
    const brief = storedDecisionBrief(route.artifact, parse(route.sources).length);
    const names = new Map(this.all("SELECT id,name FROM accounts WHERE id IN (?,?,?)", route.owner_id, route.contributor_id, route.reviewer_id).map((account) => [account.id, account.name]));
    const person = (id) => ({ id, name: names.get(id) || 'unknown operator', is_you: id === actor.account.id });
    const reviewerOf = latest?.reviewer_id || route.reviewer_id;
    // Compare only retained-byte versions. Historic hash-only links stay in the citation history,
    // but cannot become a verified cited or current version in the workbench.
    const citations = this.submissionEvidence(route.id).map((entry) => {
      const versions = entry.versions || [];
      const current = [...versions].reverse().find((version) => version.retained) || null;
      const cited = entry.capture?.retained ? entry.capture : null;
      return { ...entry, cited_version: cited, current_version: current, comparison: citationComparison(cited, current, entry.state) };
    });
    const mayReview = ['admin', 'reviewer'].includes(actor.account.role) && route.status === 'pending_review' && route.contributor_id !== actor.account.id && (route.demo || actor.account.role === 'admin' || route.reviewer_id === actor.account.id);
    const reviewRefusal = route.status !== 'pending_review' ? 'This version is not waiting for review.'
      : route.contributor_id === actor.account.id ? 'You cannot review your own or your agents’ contributions; a different human reviewer is required.'
      : !['admin', 'reviewer'].includes(actor.account.role) ? 'Review needs an authorized reviewer or administrator account.'
      : route.reviewer_id !== actor.account.id && actor.account.role !== 'admin' ? 'This mission has a different assigned reviewer.' : '';
    const mayAdopt = route.owner_id === actor.account.id && route.status === 'accepted' && latest?.decision === 'accepted' && route.contributor_id !== actor.account.id && reviewerOf !== actor.account.id;
    const adoptionRefusal = route.owner_id !== actor.account.id ? 'Only the mission owner can record adoption of accepted work.'
      : route.status !== 'accepted' || latest?.decision !== 'accepted' ? 'Only a currently accepted contribution can be declared adopted.'
      : route.contributor_id === actor.account.id ? 'An operator cannot adopt their own contribution; the adopter must be a different person from the contributor.'
      : reviewerOf === actor.account.id ? 'The reviewer who accepted this version cannot adopt it; the adopter must be a different person from the reviewer.' : '';
    const receipt = this.get('SELECT id,agent_id,account_id,amount,created_at FROM coin_rewards WHERE submission_id=?', route.id) || null;
    return {
      submission: { id: route.id, version: route.version, status: route.status, state, claim_status: route.claim_status, submitted_at: route.created_at, artifact: route.artifact, method: route.method, limitations: route.limitations, rights: route.rights, sources: parse(route.sources), brief },
      mission: { id: route.mission_id, title: route.mission_title, summary: route.mission_summary, beneficiary: route.beneficiary, rubric: route.rubric, status: route.mission_status, practice: Boolean(route.demo) },
      task: { id: route.task_id, title: route.task_title, instructions: route.instructions },
      criteria: { rubric: route.rubric, findings: brief ? brief.findings.map((finding, index) => ({ finding_number: index + 1, text: finding.text, qualification: finding.qualification, source_numbers: finding.source_numbers })) : [], structured: Boolean(brief) },
      citations,
      assessment: latest ? { review_id: latest.id, reviewer: person(latest.reviewer_id), decision: latest.decision, reviewed_at: latest.created_at, requested_changes: storedRequestedChanges(latest.reason), reason: latest.reason } : null,
      reviews: reviews.map((review) => ({ id: review.id, reviewer: person(review.reviewer_id), decision: review.decision, reviewed_at: review.created_at, requested_changes: storedRequestedChanges(review.reason) })),
      requested_changes: { review_id: latest?.decision === 'changes_requested' ? latest.id : null, items: latest?.decision === 'changes_requested' ? storedRequestedChanges(latest.reason) : [] },
      adoptions,
      coin: receipt ? { issued: true, receipt_id: receipt.id, credited_agent: receipt.agent_id, amount: receipt.amount, created_at: receipt.created_at, availability: state.value === 'held' ? 'held' : 'available' } : { issued: false, receipt_id: null, credited_agent: route.agent_id, amount: null, created_at: null, availability: null },
      availability: {
        state: state.value,
        held: state.value === 'held',
        note: state.value === 'held'
          ? 'Quarantine holds current availability without rewriting history: the acceptance record and any issued receipt are retained exactly as they are, and the wallet projection reads “held” until the evidence is available again.'
          : 'Nothing is held: this version is in the state named above and no record has been withdrawn.',
      },
      roles: {
        proposer: { ...person(route.owner_id), role: 'mission owner who proposed the mission and records adoption' },
        contributor: { ...person(route.contributor_id), role: 'operator whose resident submitted this version' },
        reviewer: { ...person(reviewerOf), role: route.reviewer_id === route.owner_id ? 'assigned reviewer' : 'assigned independent reviewer' },
        adopter: { ...person(route.owner_id), role: 'mission owner who may record a documented adoption' },
        distinct: {
          contributor_from_reviewer: route.contributor_id !== reviewerOf,
          adopter_from_contributor: route.owner_id !== route.contributor_id,
          adopter_from_reviewer: route.owner_id !== reviewerOf,
        },
        you: { ...person(actor.account.id), account_role: actor.account.role },
        may_review: mayReview, review_refusal: mayReview ? '' : reviewRefusal,
        may_adopt: mayAdopt, adoption_refusal: mayAdopt ? '' : adoptionRefusal,
      },
      boundaries: {
        acceptance: 'Acceptance is a human contribution review of this exact version. It is not independent factual certification, recipient consent, funding, shipment authorization or a real-world outcome.',
        adoption: ADOPTION_BOUNDARY,
        evidence: 'States are read from the stored citations and the library. Hash-only records remain unverified; a later retained capture changes the state shown, never the version the contribution cited.',
      },
    };
  }
  // ---- Mission quality signals ------------------------------------------------------------------
  // One read-only, advisory reading of a proposed mission or task. The proposal is assembled from the
  // records this platform already holds — the mission, its task, and the research lead that produced
  // either, which carries the source register the shipped research path recorded — and handed to the
  // pure reader in src/mission-quality.js. That module's assessment is returned exactly as it computed
  // it: every signal, every measure and every threshold. Nothing is decided here and nothing is
  // written: no status, no record, no coin and no audit entry. The signals gate nothing — creating,
  // activating, claiming, submitting, reviewing and adopting all behave as they did — and the coin
  // decision stays with the shipped independent-acceptance predicate in src/coins.js.
  //
  // The audience is the review workbench's: an operator session holding the reviewer or administrator
  // role. The collusion measures are deliberately not computed: they would need the whole review
  // history read into a reviewer-visible response, which would disclose other contributors' review
  // records. The module's own report says plainly that no review records were supplied.
  missionQuality(actor, options = {}) {
    role(actor, ['admin', 'reviewer']); this.active();
    const taskId = typeof options.task === 'string' ? options.task.trim() : '';
    const missionId = typeof options.mission === 'string' ? options.mission.trim() : '';
    if (!taskId && !missionId) fail(400, 'Name a task or a mission to read.');
    const task = taskId ? this.get('SELECT * FROM tasks WHERE id=?', taskId) : null;
    if (taskId && !task) fail(404, 'Task not found.');
    const mission = this.get('SELECT * FROM missions WHERE id=?', task ? task.mission_id : missionId);
    if (!mission) fail(404, 'Mission not found.');
    // The lead that produced this mission or task, when one did. A mission created by hand has none,
    // and then no source register exists for this module to read.
    const lead = this.get('SELECT * FROM research_leads WHERE (task_id=? OR mission_id=?) ORDER BY created_at DESC,id DESC LIMIT 1', task?.id || '', mission.id) || null;
    const listFrom = (value) => { try { const list = JSON.parse(value || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } };
    const proposal = {
      id: task ? task.id : mission.id,
      mission: {
        id: mission.id, title: mission.title, area: mission.area, summary: mission.summary,
        owner_id: mission.owner_id, beneficiary: mission.beneficiary, reviewer_id: mission.reviewer_id,
        rubric: mission.rubric, demo: Boolean(mission.demo),
      },
      ...(task ? { task: { id: task.id, title: task.title, instructions: task.instructions, rights: task.rights, allowed_domains: listFrom(task.allowed_domains) } } : {}),
      sources: lead ? listFrom(lead.source_urls) : [],
    };
    // Everything the proposal is compared against: the stored research leads, minus the one that
    // produced this work, so a proposal is never reported as a near-duplicate of the entry it came
    // from. The evidence library's host list is deliberately not supplied: it holds only the hosts
    // that have been captured through the curator path, and the submission path registers a new host
    // rather than refusing it, so passing it would report a host as unknown on the strength of the
    // library's sparseness and not on any rule the shipped path applies.
    const existing = this.all('SELECT id,title,instructions,rubric FROM research_leads WHERE (task_id IS NULL OR task_id<>?) AND (mission_id IS NULL OR mission_id<>?) ORDER BY id', task?.id || '', mission.id);
    return assessMission(proposal, { existing });
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
    // Ownership is resolved in SQL so the bound keeps a member's own reports and appeals visible.
    const mine = "(r.reporter_id=? OR (r.target_type='agent' AND EXISTS(SELECT 1 FROM agents g WHERE g.id=r.target_id AND g.operator_id=?)) OR (r.target_type='message' AND EXISTS(SELECT 1 FROM messages m WHERE m.id=r.target_id AND m.account_id=?)) OR (r.target_type='submission' AND EXISTS(SELECT 1 FROM submissions s JOIN claims c ON c.id=s.claim_id WHERE s.id=r.target_id AND c.account_id=?)))";
    const rows = moderator ? this.all('SELECT r.* FROM reports r ORDER BY r.created_at DESC,r.rowid DESC LIMIT ?', SAFETY_LIMIT + 1) : this.all(`SELECT r.* FROM reports r WHERE ${mine} ORDER BY r.created_at DESC,r.rowid DESC LIMIT ?`, actor.account.id, actor.account.id, actor.account.id, actor.account.id, SAFETY_LIMIT + 1);
    const reports = rows.slice(0, SAFETY_LIMIT), ids = new Set(reports.map((r) => r.id));
    return { reports: reports.map((report) => { if (moderator || report.reporter_id === actor.account.id) return report; const { reporter_id, ...visible } = report; return visible; }), appeals: this.all('SELECT * FROM appeals WHERE report_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC,rowid DESC LIMIT ?', JSON.stringify([...ids]), SAFETY_LIMIT), has_more: rows.length > SAFETY_LIMIT };
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
  operations(actor, live = {}) {
    role(actor, ['admin']);
    // The live half of the payload is built by the caller and may be a function: the process-level
    // counters are then assembled only after the administrator check above has passed.
    const runtime = typeof live === 'function' ? live() : live;
    const audit_valid = this.verifyAudit(), coin_ledger_valid = verifyCoinLedger(this.db);
    // Two of these lists carry text a *caller* supplied: an account name from registration, and a job's
    // own run summary, which a runtime credential writes through POST /jobs. Both are published to every
    // administrator, so both are passed through the same value scrub the diagnostics payload uses —
    // otherwise a resident's runtime credential could print its own session token, or any contact
    // address it was handed, straight onto the administrator dashboard. Redaction is applied per row
    // rather than to the whole array, because `redactDiagnostics` bounds an array at 200 entries and an
    // account listing must not silently truncate. The sealed unit-separation policy is deliberately not
    // passed through that scrub: it is authored rather than caller-supplied, and its `token: false` is a
    // published declaration, not a secret.
    return { paused: this.get("SELECT value FROM settings WHERE key='paused'").value === 'true', accounts: this.all('SELECT id,name,role,status,created_at FROM accounts').map((row) => redactDiagnostics(row)), jobs: this.all('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100').map((row) => redactDiagnostics(row)), audit_valid, coin_ledger_valid, coin_receipts:this.get('SELECT COUNT(*) AS n FROM coin_rewards').n, credit_units: UNIT_SEPARATION_POLICY, audit: this.all('SELECT seq,actor,event,record_id,created_at FROM audit ORDER BY seq DESC LIMIT 100').map((row) => redactDiagnostics(row)), runtime_budgets: this.all("SELECT agent_id,expires_at,max_calls,used_calls,revoked FROM tokens WHERE kind='runtime' ORDER BY expires_at DESC LIMIT 100"),
      diagnostics: this.diagnostics({ ...runtime, integrity: { audit_chain_valid: audit_valid, coin_ledger_valid } }) };
  }
  // The administrator dashboard. Every number here is read from this process or from the database;
  // none is estimated. The payload is built from named counters, then passed through the redaction
  // allowlist, so no stored row, credential, contact address or private artifact can reach it.
  integrity() {
    const cached = this.integrityCache, now = this.clock();
    if (cached.value && now - cached.at < 10_000) return cached.value;
    let value;
    try { value = integritySnapshot(this.path); }
    catch { value = { quick_check: 'unavailable', checked_at: new Date(now).toISOString(), check_duration_ms: 0, schema_version: null, page_count: null, journal_mode: null, note: 'The database file could not be opened read-only for the file-level check.' }; }
    this.integrityCache = { at: now, value };
    return value;
  }
  diagnostics(live = {}) {
    const count = (sql, ...args) => this.get(sql, ...args).n;
    const since = new Date(this.clock() - 86_400_000).toISOString();
    const backupDirectory = live.backup_directory || resolve(dirname(this.path), 'backups');
    const backups = live.backups || backupInventory(backupDirectory);
    let storage = null;
    try { storage = storageUsage(this.path); } catch { storage = null; }
    const interruption_rows = this.all("SELECT interrupted, COUNT(*) AS n FROM resident_runs WHERE status='interrupted' AND interrupted!='' GROUP BY interrupted");
    const by_interruption = Object.fromEntries(interruption_rows.map((row) => [row.interrupted, row.n]));
    return redactDiagnostics({
      generated_at: new Date(this.clock()).toISOString(),
      process: live.process || null,
      schema: { version: this.get('PRAGMA user_version').user_version, accepted_versions: [...RECOVERY_LIMITS.accepted_schema_versions] },
      integrity: { ...this.integrity(), ...(live.integrity || {}) },
      storage,
      backups,
      model: live.model || { configured: false, backend: null, state: 'unconfigured', state_note: 'No local model name is configured; resident runs and country conversations use their rules fallback.', queue: { active: 0, waiting: 0, max_waiting: 0, saturation: 0, full: false }, inference: { in_flight: 0, oldest_started_at: null, elapsed_ms: null }, since_process_start: null },
      workers: live.workers || { research: { active: 0, limit: 0, available: 0 }, resident: { active: 0, limit: 1, available: 1 }, interrupted: 0, capacity_refusals_since_start: 0 },
      records: {
        accounts: count('SELECT COUNT(*) AS n FROM accounts'), agents: count('SELECT COUNT(*) AS n FROM agents'), worlds: count('SELECT COUNT(*) AS n FROM worlds'),
        world_objects: count('SELECT COUNT(*) AS n FROM world_objects'), land_stewardships: count('SELECT COUNT(*) AS n FROM land_stewardships'),
        coin_rewards: count('SELECT COUNT(*) AS n FROM coin_rewards'), quest_enrollments: count('SELECT COUNT(*) AS n FROM quest_enrollments'),
        guild_projects: count('SELECT COUNT(*) AS n FROM guild_projects'), guild_contributions: count('SELECT COUNT(*) AS n FROM guild_contributions'),
        ambassador_conversations: count('SELECT COUNT(*) AS n FROM ambassador_conversations'),
        audit_entries: this.get('SELECT COALESCE(MAX(seq),0) AS n FROM audit').n,
      },
      runs: {
        running: count("SELECT COUNT(*) AS n FROM resident_runs WHERE status='running'"), interrupted: count("SELECT COUNT(*) AS n FROM resident_runs WHERE status='interrupted'"),
        completed: count("SELECT COUNT(*) AS n FROM resident_runs WHERE status='completed'"), stopped: count("SELECT COUNT(*) AS n FROM resident_runs WHERE status='stopped'"),
        failed: count("SELECT COUNT(*) AS n FROM resident_runs WHERE status='failed'"),
        interrupted_24h: count("SELECT COUNT(*) AS n FROM resident_runs WHERE status='interrupted' AND updated_at>=?", since),
        failed_24h: count("SELECT COUNT(*) AS n FROM resident_runs WHERE status='failed' AND updated_at>=?", since),
        by_interruption,
      },
      jobs: {
        running: count("SELECT COUNT(*) AS n FROM jobs WHERE status='running'"), interrupted: count("SELECT COUNT(*) AS n FROM jobs WHERE status='interrupted'"),
        completed_24h: count("SELECT COUNT(*) AS n FROM jobs WHERE status='completed' AND created_at>=?", since),
        stopped_24h: count("SELECT COUNT(*) AS n FROM jobs WHERE status='stopped' AND created_at>=?", since),
        failed_24h: count("SELECT COUNT(*) AS n FROM jobs WHERE status='failed' AND created_at>=?", since),
      },
      failures: {
        count_24h: count("SELECT COUNT(*) AS n FROM audit WHERE created_at>=? AND (event LIKE '%.failed' OR event LIKE '%.stopped' OR event LIKE '%.interrupted')", since),
        last_at: this.get("SELECT created_at FROM audit WHERE event LIKE '%.failed' OR event LIKE '%.stopped' OR event LIKE '%.interrupted' ORDER BY seq DESC LIMIT 1")?.created_at || null,
        recent: this.all("SELECT event, created_at FROM audit WHERE event LIKE '%.failed' OR event LIKE '%.stopped' OR event LIKE '%.interrupted' ORDER BY seq DESC LIMIT 20"),
      },
      recovery: {
        schema_version: RECOVERY_LIMITS.schema_version,
        last_backup_at: backups.latest?.created_at || null,
        backup_point: RECOVERY_LIMITS.backup_point,
        replay_policy: RECOVERY_LIMITS.replay_policy,
        interruption_classes: [...RECOVERY_LIMITS.interruption_classes],
      },
    });
  }
  pause(actor, value) {
    role(actor, ['admin']);
    this.run("UPDATE settings SET value=? WHERE key='paused'", value ? 'true' : 'false');
    this.audit(actor.account.id, value ? 'platform.paused' : 'platform.resumed'); return { paused: Boolean(value) };
  }
  accountControl(actor, input) {
    role(actor, ['admin']);
    // An administrator may step down; self-suspension would revoke their own access to every administrator route.
    if (input.account_id === actor.account.id && input.status) fail(400, 'You cannot change your own account status.');
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
    const messages = this.all(`SELECT m.id,m.agent_id,m.account_id,m.channel,m.mission_id,m.text,m.status,m.created_at,m.world_id FROM messages m WHERE m.account_id=? OR (m.status='visible' AND m.channel='private' AND EXISTS(SELECT 1 FROM json_each(m.recipients) r JOIN agents a ON a.id=r.value WHERE a.operator_id=?)) ORDER BY m.created_at DESC,m.rowid DESC LIMIT ?`, actor.account.id, actor.account.id, EXPORT_LIMIT);
    const worlds = this.all('SELECT w.* FROM worlds w JOIN agents a ON a.id=w.owner_agent_id WHERE a.operator_id=? ORDER BY w.created_at DESC LIMIT ?', actor.account.id, EXPORT_LIMIT);
    const world_objects = this.all('SELECT b.* FROM world_objects b JOIN worlds w ON w.id=b.world_id JOIN agents a ON a.id=w.owner_agent_id WHERE a.operator_id=? ORDER BY b.created_at DESC LIMIT ?', actor.account.id, EXPORT_LIMIT);
    return { format: 'shared-world-account-v18', exported_at: now(), account: { ...publicAccount(actor.account), email: actor.account.email }, agents, worlds, world_objects, frontier:this.frontierExport(actor), coins:this.coinExport(actor), callings:this.vocationExport(actor), quests:this.questExport(actor), guilds:this.guildExport(actor), offers:this.offerExport(actor), trade:this.tradeExport?.(actor,EXPORT_LIMIT) ?? {posted:[],claimed:[],posted_total:0,claimed_total:0,truncated:false}, ...history,followups:this.all('SELECT f.task_id,f.submission_id,f.created_at,t.mission_id,t.title,t.instructions,t.rights,t.allowed_domains FROM task_followups f JOIN tasks t ON t.id=f.task_id WHERE f.creator_id=? ORDER BY f.created_at DESC LIMIT ?',actor.account.id,EXPORT_LIMIT).map(record=>({...record,allowed_domains:parse(record.allowed_domains)})),drafts:this.drafts(actor,{archived:true,all:true}), messages, memory: this.memoryExport(actor), vault: this.vaultExport(actor), community: this.communityExport(actor), journey: this.journeyExport(actor), civic: this.civicExport(actor), moderation: this.safety({ ...actor, account: { ...actor.account, role: 'member' } }) };
  }
  deleteAccount(actor) {
    role(actor, ['admin', 'member', 'reviewer', 'moderator']);
    if (this.get("SELECT id FROM missions WHERE (owner_id=? OR reviewer_id=?) AND status='open'", actor.account.id, actor.account.id)) fail(409, 'Transfer or close your active missions before deleting your account.');
    this.run('DELETE FROM claim_drafts WHERE claim_id IN (SELECT id FROM claims WHERE account_id=?)',actor.account.id);
    this.deleteVocations(actor);
    this.deleteMemory(actor);
    this.deleteVault(actor);
    this.deleteQuests(actor);
    this.deleteCommunity(actor);
    this.deleteGuilds(actor);
    this.deleteOffers(actor);
    this.tradeDeleteAccount?.(actor);
    this.deleteJourney(actor);
    this.run('DELETE FROM land_stewardships WHERE account_id=?', actor.account.id);
    this.run("UPDATE land_events SET purpose='[removed]',description='' WHERE account_id=?", actor.account.id);
    this.run("DELETE FROM mayor_conversations WHERE account_id=?", actor.account.id);
    this.run("DELETE FROM ambassador_conversations WHERE account_id=?", actor.account.id);
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
      const run = this.get('SELECT * FROM resident_runs WHERE id=?', job.id);
      if (!run) {
        this.run("UPDATE jobs SET status='stopped',detail=? WHERE id=?", 'Server restarted before this worker finished. Check contributions before retrying; release an unsubmitted claim or wait for its lease to expire.', job.id);
        this.audit('system', 'research.worker.interrupted', job.id);
        continue;
      }
      // A bounded resident run is classified, never repeated. The last durable write says whether a
      // model call or an action was in flight, and the orphaned runtime credential is revoked so the
      // process that died cannot keep using it. Repeating the work is an explicit human decision.
      const interruption = classifyResidentRun(run);
      this.run("UPDATE jobs SET status='interrupted',detail=? WHERE id=?", residentInterruptionDetail(run, interruption), job.id);
      this.run("UPDATE resident_runs SET status='interrupted',interrupted=?,stop_reason='process_restart',updated_at=? WHERE id=?", interruption, now(), run.id);
      if (run.credential_hash) this.run('UPDATE tokens SET revoked=1 WHERE hash=?', run.credential_hash);
      this.audit('system', 'resident.run.interrupted', job.id);
    }
    return interrupted.length;
  }
  // ---- Durable state for one bounded managed resident run (schema 16) --------------------------
  // Only counters, identifiers and the credential hash the tokens table already stores are kept
  // here. The runtime token is never written, and no transition is inferred: the runtime reports
  // each one, and the server records the receipt on top of it.
  startResidentRun(input = {}) {
    const account = this.get('SELECT id FROM accounts WHERE id=?', input.account_id || '');
    const agent = this.get('SELECT id FROM agents WHERE id=?', input.agent_id || '');
    if (!account || !agent) fail(404, 'Unknown resident run identity.');
    const id = text(input.id, 'Run identifier', 80);
    if (this.get('SELECT id FROM resident_runs WHERE id=?', id)) fail(409, 'This resident run already exists.');
    if (!['observe', 'explore', 'creative'].includes(input.permission)) fail(400, 'Invalid resident permission mode.');
    const decisions = Number(input.decisions), minutes = Number(input.minutes);
    if (!Number.isInteger(decisions) || decisions < 1 || decisions > 20 || !Number.isInteger(minutes) || minutes < 1 || minutes > 20) fail(400, 'Invalid resident run limits.');
    const credentialHash = input.credential_hash || '';
    if (!/^[a-f0-9]{64}$/.test(credentialHash)) fail(400, 'A resident run stores only its credential hash.');
    const resumedFrom = input.resumed_from || null;
    if (resumedFrom && !this.get("SELECT id FROM resident_runs WHERE id=? AND status='interrupted'", resumedFrom)) fail(409, 'Only an interrupted run can be resumed.');
    const created = now();
    this.run("INSERT INTO resident_runs(id,account_id,agent_id,permission,status,phase,interrupted,stop_reason,decision,decision_budget,model_calls,action_count,failed_calls,failed_actions,last_action,pending_action,credential_hash,minutes,resumed_from,started_at,updated_at) VALUES(?,?,?,?,'running','starting','','',0,?,0,0,0,0,'{}','{}',?,?,?,?,?)", id, account.id, agent.id, input.permission, decisions, credentialHash, minutes, resumedFrom, created, created);
    return this.get('SELECT * FROM resident_runs WHERE id=?', id);
  }
  recordResidentRun(id, changes = {}) {
    const run = this.get('SELECT * FROM resident_runs WHERE id=?', id);
    if (!run) fail(404, 'Resident run not found.');
    // Recovery owns an interrupted run's record: a process that somehow outlived the restart cannot
    // rewrite the classification or the counters the next start read.
    if (run.status === 'interrupted') fail(409, 'This resident run was already classified as interrupted.');
    const pick = (key, fallback) => (changes[key] === undefined ? fallback : changes[key]);
    const count = (key) => { const value = pick(key, run[key]); if (!Number.isInteger(value) || value < 0) fail(400, `Invalid resident run ${key}.`); return value; };
    const detail = (key) => { const value = changes[key]; if (value === undefined) return run[key]; if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Invalid resident run state detail.'); return JSON.stringify(value); };
    const phase = pick('phase', run.phase), status = pick('status', run.status);
    if (!RESIDENT_RUN_PHASES.includes(phase)) fail(400, 'Invalid resident run phase.');
    if (!RESIDENT_RUN_STATUSES.includes(status) || status === 'interrupted') fail(400, 'Invalid resident run status.');
    const stopReason = pick('stop_reason', run.stop_reason);
    if (typeof stopReason !== 'string' || stopReason.length > 64) fail(400, 'Invalid resident run stop reason.');
    const next = { phase, status, stop_reason: stopReason, decision: count('decision'), model_calls: count('model_calls'), action_count: count('action_count'), failed_calls: count('failed_calls'), failed_actions: count('failed_actions'), last_action: detail('last_action'), pending_action: detail('pending_action') };
    if (next.decision > run.decision_budget || next.model_calls > next.decision || next.action_count > next.model_calls || next.failed_calls > next.model_calls || next.failed_actions > next.model_calls) fail(400, 'Inconsistent resident run counters.');
    if (next.status !== 'running' && next.phase !== 'finished') fail(400, 'A finished resident run must record its final phase.');
    this.run('UPDATE resident_runs SET phase=?,status=?,stop_reason=?,decision=?,model_calls=?,action_count=?,failed_calls=?,failed_actions=?,last_action=?,pending_action=?,updated_at=? WHERE id=?', phase, status, stopReason, next.decision, next.model_calls, next.action_count, next.failed_calls, next.failed_actions, next.last_action, next.pending_action, now(), id);
    return this.get('SELECT * FROM resident_runs WHERE id=?', id);
  }
  residentRun(id) { const run = this.get('SELECT * FROM resident_runs WHERE id=?', id); return run ? runView(run) : null; }
  residentRuns(accountId, limit = 50) {
    const size = Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > 200) fail(400, 'Invalid resident run page size.');
    return this.all('SELECT * FROM resident_runs WHERE account_id=? ORDER BY started_at DESC,id DESC LIMIT ?', accountId, size).map(runView);
  }
  residentResumePlan(accountId) {
    const run = this.get("SELECT r.* FROM resident_runs r WHERE r.account_id=? AND r.status='interrupted' AND r.interrupted!='' AND NOT EXISTS(SELECT 1 FROM resident_runs s WHERE s.resumed_from=r.id) ORDER BY r.started_at DESC,r.id DESC LIMIT 1", accountId);
    if (!run) fail(409, 'No interrupted run is waiting for an explicit resume.');
    const decisions = run.decision_budget - run.model_calls;
    if (decisions < 1) fail(409, 'This run used its whole model-decision budget; start a new run instead.');
    // Remaining API budget comes from the interrupted run's own credential row, never from a copy.
    const credential = run.credential_hash ? this.get('SELECT max_calls,used_calls,revoked,expires_at FROM tokens WHERE hash=?', run.credential_hash) : null;
    if (credential && !credential.revoked) fail(409, 'The interrupted run still holds a usable credential. Stop that process before resuming it.');
    const apiCalls = credential ? Math.max(0, credential.max_calls - credential.used_calls) : 0;
    if (apiCalls < 1) fail(409, 'This run used its whole API budget; start a new run instead.');
    if (!this.get('SELECT id FROM agents WHERE id=?', run.agent_id)) fail(409, 'The character for this run is unavailable.');
    const remainingMs=credential.expires_at-this.clock();
    if(remainingMs<=0)fail(409,'This run used its time budget; start a new bounded run instead.');
    return {run_id:run.id,agent_id:run.agent_id,permission:run.permission,decisions,minutes:Math.min(20,Math.ceil(remainingMs/60000)),duration_ms:remainingMs,api_calls_remaining:apiCalls,interruption:run.interrupted};
  }
  job(actor, input) {
    if (actor.kind !== 'runtime' || actor.agent?.kind !== 'agent') fail(403, 'An agent runtime credential is required.');
    if (!['completed', 'failed', 'stopped'].includes(input.status)) fail(400, 'Invalid job status.');
    const id = randomUUID();
    this.run('INSERT INTO jobs VALUES(?,?,?,?,?)', id, actor.agent.id, input.status, text(input.detail, 'Run summary', 500), now());
    this.audit(actor.account.id, `job.${input.status}`, id); return { id };
  }
  // ---- Versioned evidence library (schema 22) ---------------------------------------------------
  // One library row records an immutable source identity, hash, dates, unit, licence and locator. A
  // submission pins a version only when the library already holds matching hash-checked bytes; a
  // saved draft resolves that same rule without writing. Adding a newer version cannot rewrite a
  // pinned historical citation. Nothing here fetches: retained captures reference bytes under
  // catalog/, while a hash-only record is a declaration that cannot establish captured support.
  initEvidence() {
    if (this.get('SELECT COUNT(*) AS n FROM evidence_captures').n) return;
    const series = [];
    for (const name of ['agriculture-statistics', 'access-statistics']) {
      let catalog;
      try { catalog = JSON.parse(readFileSync(new URL(`../catalog/${name}.json`, import.meta.url), 'utf8')); } catch { continue; }
      for (const country of catalog.countries || []) for (const entry of country.series || []) if (entry && typeof entry.url === 'string' && typeof entry.sha256 === 'string' && typeof entry.raw_file === 'string') series.push(entry);
    }
    if (!series.length) return;
    this.transaction(() => { for (const entry of series) this.seedRetainedCapture(entry); });
  }
  // Import one already-retained catalog response. The retained bytes are re-hashed here; if they no
  // longer match the catalog's declared SHA-256, nothing is stored rather than storing a wrong record.
  seedRetainedCapture(series) {
    if (!/^catalog\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.json$/.test(series.raw_file)) return;
    let file;
    try { file = readFileSync(new URL(`../${series.raw_file}`, import.meta.url)); } catch { return; }
    if (file.length < 1 || file.length > 1_000_000 || hash(file) !== series.sha256) return;
    const window = series.window || {};
    this.registerCapture({
      url: series.url, sha256: series.sha256, retained: true, retained_path: series.raw_file, retrieved_at: series.retrieved_at,
      declared_date: '', unit: series.unit || '', title: series.name || '', provenance: series.publisher || '',
      locator: `Retained raw response ${series.raw_file}; WDI source 2; ${series.country_iso3 || ''}/${series.indicator || ''}; annual rows ${window.start ?? ''}–${window.end ?? ''}`,
      evidence_kind: 'normalized-statistics', origin: 'catalog',
      license: series.license || {},
    });
  }
  // Store (or reuse) one source hash record. A retained file is hash-checked; a hash-only record is
  // a declaration. Every check runs before a row is written, so an over-quota record, a forbidden
  // host or a retained file that does not match its hash fails closed.
  registerCapture(fields, { domains = [] } = {}) {
    const url = approvedEvidenceUrl(fields.url, domains);
    const sourceKey = evidenceSourceKey(url.href);
    const sha256 = String(fields.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) fail(400, 'An evidence capture needs the SHA-256 of the exact bytes.');
    const origin = ['catalog', 'submission', 'curator'].includes(fields.origin) ? fields.origin : 'submission';
    const evidenceKind = EVIDENCE_KINDS.includes(fields.evidence_kind) ? fields.evidence_kind : 'web-excerpt';
    const retained = fields.retained ? 1 : 0;
    let retainedPath = '', bytes = Number.isInteger(fields.bytes) && fields.bytes > 0 ? fields.bytes : 0;
    if (retained) {
      retainedPath = String(fields.retained_path || '');
      if (!/^catalog\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(retainedPath)) fail(400, 'Retained evidence must live under catalog/.');
      let file; try { file = readFileSync(new URL(`../${retainedPath}`, import.meta.url)); } catch { fail(409, 'The retained evidence file could not be read.'); }
      if (file.length < 1 || file.length > 1_000_000) fail(409, 'The retained evidence file is outside its byte limit.');
      if (hash(file) !== sha256) fail(409, 'The retained evidence bytes do not match the declared SHA-256; no record was written.');
      bytes = file.length;
    }
    const retrievedAt = String(fields.retrieved_at || '');
    if (!evidenceStamp(retrievedAt)) fail(400, 'An evidence capture needs a retrieval date or timestamp.');
    const declaredDate = fields.declared_date ? String(fields.declared_date) : '';
    if (declaredDate && !evidenceStamp(declaredDate)) fail(400, 'A declared publication date must be an ISO date.');
    const license = fields.license || {};
    let source = this.get('SELECT * FROM evidence_sources WHERE source_key=?', sourceKey);
    const existing = source ? this.get('SELECT * FROM evidence_captures WHERE source_id=? AND sha256=?', source.id, sha256) : null;
    if (existing) {
      if (retained && !existing.retained) fail(409, 'This hash is already stored as an immutable hash-only declaration. It cannot be silently upgraded to retained evidence.');
      return existing;
    }
    if (!source && this.get('SELECT COUNT(*) AS n FROM evidence_sources').n >= EVIDENCE_LIMITS.max_sources) fail(409, 'The evidence library reached its source quota; a new source cannot be stored.');
    this.evidenceReserve(retained ? bytes : 0, source ? source.id : null);
    const created = now();
    if (!source) {
      this.run('INSERT INTO evidence_sources(id,source_key,url,host,path,status,created_at) VALUES(?,?,?,?,?,?,?)', randomUUID(), sourceKey, url.href, url.hostname, url.pathname, 'active', created);
      source = this.get('SELECT * FROM evidence_sources WHERE source_key=?', sourceKey);
    } else if (source.status === 'withdrawn') {
      // A fresh capture is the observation that the source is available again. The withdrawal stays in
      // the append-only event history; the identity itself is never rewritten.
      this.run("UPDATE evidence_sources SET status='active',withdrawn_reason='' WHERE id=?", source.id);
      this.run('INSERT INTO evidence_events(id,source_id,kind,detail,created_at) VALUES(?,?,?,?,?)', randomUUID(), source.id, 'restored', 'A new capture of this source was stored; it is available again.', created);
    }
    let supersedes = null;
    if (fields.supersedes) {
      const prior = this.get('SELECT * FROM evidence_captures WHERE id=?', fields.supersedes);
      if (!prior || prior.source_id !== source.id) fail(400, 'A superseding capture must name an earlier version of the same source.');
      supersedes = prior.id;
    }
    const id = randomUUID();
    this.run('INSERT INTO evidence_captures(id,source_id,source_key,url,sha256,bytes,retained,retained_path,retrieved_at,declared_date,unit,title,locator,evidence_kind,provenance,license_name,license_url,license_attribution,excerpt,origin,supersedes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, source.id, sourceKey, url.href, sha256, bytes, retained, retainedPath, retrievedAt, declaredDate,
      String(fields.unit || '').slice(0, 120), String(fields.title || '').slice(0, 200), String(fields.locator || '').slice(0, 300),
      evidenceKind, String(fields.provenance || '').slice(0, 200), String(license.name || '').slice(0, 120), String(license.url || '').slice(0, 200),
      String(license.attribution || '').slice(0, 300), String(fields.excerpt || '').slice(0, EVIDENCE_LIMITS.max_excerpt_characters), origin, supersedes, created);
    return this.get('SELECT * FROM evidence_captures WHERE id=?', id);
  }
  // Hold a new capture to the library quota. A version a submission cites is never evicted, so when
  // the only candidates for eviction are cited this refuses instead of deleting cited evidence.
  evidenceReserve(bytes, sourceId) {
    if (sourceId) while (this.get('SELECT COUNT(*) AS n FROM evidence_captures WHERE source_id=?', sourceId).n + 1 > EVIDENCE_LIMITS.max_captures_per_source) {
      if (!this.evictOldest(sourceId)) fail(409, 'This source already keeps its maximum number of versions and every version is cited; a new version cannot be stored.');
    }
    while (this.get('SELECT COUNT(*) AS n FROM evidence_captures').n + 1 > EVIDENCE_LIMITS.max_captures) {
      if (!this.evictOldest(null)) fail(409, 'The evidence library is full and every version is cited; a new capture cannot be stored.');
    }
    if (bytes) while (this.retainedBytes() + bytes > EVIDENCE_LIMITS.max_retained_bytes) {
      if (!this.evictOldest(null, true)) fail(409, 'The evidence library is at its retained-byte quota and every retained version is cited; a new capture cannot be stored.');
    }
  }
  retainedBytes() { return this.get('SELECT COALESCE(SUM(bytes),0) AS n FROM evidence_captures WHERE retained=1').n; }
  evictOldest(sourceId, retainedOnly = false) {
    const filter = `${retainedOnly ? ' AND c.retained=1' : ''} AND NOT EXISTS(SELECT 1 FROM submission_evidence e WHERE e.capture_id=c.id)`;
    const row = sourceId
      ? this.get(`SELECT c.id FROM evidence_captures c WHERE c.source_id=?${filter} ORDER BY c.rowid ASC LIMIT 1`, sourceId)
      : this.get(`SELECT c.id FROM evidence_captures c WHERE 1=1${filter} ORDER BY c.rowid ASC LIMIT 1`);
    if (!row) return false;
    this.run('DELETE FROM evidence_captures WHERE id=?', row.id);
    return true;
  }
  // A curator extends the library only on a host the library already knows. A new host is registered
  // through an approved research task, not by an operator typing a URL into the curator API.
  evidenceCapture(actor, input = {}) {
    role(actor, ['admin']);
    let host = ''; try { host = new URL(input.url).hostname; } catch { fail(400, 'Evidence needs a valid source URL.'); }
    if (!this.get('SELECT id FROM evidence_sources WHERE host=? LIMIT 1', host)) fail(403, 'Register this host through an approved research task before capturing it.');
    return this.registerCapture({ ...input, origin: 'curator' }, { domains: this.all('SELECT DISTINCT host FROM evidence_sources').map((row) => row.host) });
  }
  // Recording a source as gone or refusing is itself an observation: the withdrawal is written with
  // its reason and timestamp, the identity and every captured version stay readable.
  evidenceWithdraw(actor, input = {}) {
    role(actor, ['reviewer', 'admin']);
    let key = ''; try { key = evidenceSourceKey(new URL(input.url).href); } catch { key = ''; }
    const source = this.get('SELECT * FROM evidence_sources WHERE source_key=? OR id=?', key, input.source_id || '');
    if (!source) fail(404, 'Evidence source not found.');
    if (source.status === 'withdrawn') fail(409, 'This source is already recorded as withdrawn.');
    const reason = text(input.reason, 'Withdrawal reason', 200);
    this.run("UPDATE evidence_sources SET status='withdrawn',withdrawn_reason=? WHERE id=?", reason, source.id);
    this.run('INSERT INTO evidence_events(id,source_id,kind,detail,created_at) VALUES(?,?,?,?,?)', randomUUID(), source.id, 'withdrawn', reason, now());
    this.audit(actor.account.id, 'evidence.withdrawn', source.id);
    return { source_id: source.id, status: 'withdrawn', reason };
  }
  // Attach only a pre-existing retained-byte version whose hash matches the citation. Contributor
  // text cannot create evidence bytes or promote its own SHA-256 assertion to captured support.
  attachEvidence(source, sourceNumber) {
    const location = typeof source.location === 'string' ? source.location : '';
    const cite = { submission_id: null, source_number: sourceNumber, capture_id: null, url: source.url, locator: location, cited_date: source.date || '', state: 'missing' };
    let url; try { url = new URL(source.url); } catch { return cite; }
    if (!['http:', 'https:'].includes(url.protocol)) return cite;
    const sha256 = /SHA256\s+([a-f0-9]{64})/i.exec(location)?.[1]?.toLowerCase() || null;
    if (!sha256) return cite;
    const capture = this.get('SELECT * FROM evidence_captures WHERE source_key=? AND sha256=? AND retained=1', evidenceSourceKey(url.href), sha256);
    return { ...cite, capture_id: capture?.id || null, state: capture ? 'captured' : 'missing' };
  }
  // One cited source resolved against the library, without writing anything. Used for a private draft.
  resolveCitation(source, sourceNumber) {
    const location = typeof source.location === 'string' ? source.location : '';
    const entry = { source_number: sourceNumber, url: source.url || '', locator: location, cited_date: source.date || '', state: 'missing', state_note: EVIDENCE_STATE_NOTES.missing, source_key: null, source_status: null, withdrawn_reason: '', capture: null, versions: [], conflict: false, declared_dates: [], units: [] };
    let url; try { url = new URL(source.url); } catch { return entry; }
    if (!['http:', 'https:'].includes(url.protocol)) return entry;
    const key = evidenceSourceKey(url.href), src = this.get('SELECT * FROM evidence_sources WHERE source_key=?', key);
    const versions = src ? this.all('SELECT c.*,c.rowid AS seq FROM evidence_captures c WHERE c.source_id=? ORDER BY c.rowid ASC', src.id) : [];
    const sha = /SHA256\s+([a-f0-9]{64})/i.exec(location)?.[1]?.toLowerCase() || null;
    const capture = sha ? versions.find((version) => version.sha256 === sha) || null : null;
    const state = evidenceState(capture, versions, Boolean(src && src.status === 'withdrawn'));
    const conflicts = evidenceConflicts(versions);
    return { ...entry, state, state_note: EVIDENCE_STATE_NOTES[state], source_key: key, source_status: src?.status || null, withdrawn_reason: src?.withdrawn_reason || '', capture: capture ? captureView(capture) : null, versions: versions.map(captureView), conflict: conflicts.declared_dates.length > 1 || conflicts.units.length > 1, ...conflicts };
  }
  // The evidence attached to a batch of submissions, assembled in four queries rather than per row.
  evidenceForSubmissions(ids) {
    const unique = [...new Set(ids || [])].filter((id) => typeof id === 'string');
    if (!unique.length) return {};
    const marks = unique.map(() => '?').join(',');
    const cites = this.all(`SELECT * FROM submission_evidence WHERE submission_id IN (${marks}) ORDER BY submission_id,source_number`, ...unique);
    if (!cites.length) return {};
    const captureIds = [...new Set(cites.map((cite) => cite.capture_id).filter(Boolean))];
    const captures = captureIds.length ? this.all(`SELECT c.*,c.rowid AS seq FROM evidence_captures c WHERE c.id IN (${captureIds.map(() => '?').join(',')})`, ...captureIds) : [];
    const captureById = new Map(captures.map((capture) => [capture.id, capture]));
    const sourceIds = [...new Set(captures.map((capture) => capture.source_id))];
    const sources = sourceIds.length ? this.all(`SELECT * FROM evidence_sources WHERE id IN (${sourceIds.map(() => '?').join(',')})`, ...sourceIds) : [];
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const versionsBySource = new Map();
    for (const id of sourceIds) versionsBySource.set(id, this.all('SELECT c.*,c.rowid AS seq FROM evidence_captures c WHERE c.source_id=? ORDER BY c.rowid ASC', id));
    const bySubmission = {};
    for (const cite of cites) {
      const capture = cite.capture_id ? captureById.get(cite.capture_id) : null;
      const source = capture ? sourceById.get(capture.source_id) : null;
      const versions = source ? versionsBySource.get(source.id) || [] : [];
      const state = evidenceState(capture, versions, Boolean(source && source.status === 'withdrawn'));
      const conflicts = evidenceConflicts(versions);
      (bySubmission[cite.submission_id] ||= []).push({
        source_number: cite.source_number, url: cite.url, locator: cite.locator, cited_date: cite.cited_date, state, state_note: EVIDENCE_STATE_NOTES[state],
        source_key: source?.source_key || null, source_status: source?.status || null, withdrawn_reason: source?.withdrawn_reason || '',
        capture: capture ? captureView(capture) : null, versions: versions.map(captureView),
        conflict: conflicts.declared_dates.length > 1 || conflicts.units.length > 1, ...conflicts,
      });
    }
    return bySubmission;
  }
  // The reviewer's evidence panel for one submission: every version of every cited source, its exact
  // location, library hash and licence, the state of the citation, and any date/unit disagreement.
  submissionEvidence(submissionId) { return this.evidenceForSubmissions([submissionId])[submissionId] || []; }
  // A private draft points at the same exact versions. The resolution reads storage and writes nothing.
  draftEvidence(actor, options = {}) {
    if (actor?.kind !== 'session') fail(403, 'Saved drafts require the human operator session.');
    const claim = this.get('SELECT * FROM claims WHERE id=?', options.claim_id || '');
    const draft = this.get('SELECT * FROM claim_drafts WHERE claim_id=?', options.claim_id || '');
    if (!claim || claim.account_id !== actor.account.id || !draft) fail(404, 'Saved draft not found.');
    const content = (() => { try { return JSON.parse(draft.content); } catch { return null; } })();
    if (!content || typeof content.values !== 'object') fail(409, 'The saved draft is unreadable.');
    const byIndex = new Map();
    for (const [key, value] of Object.entries(content.values)) {
      const structured = /^source_(\d+)_(url|location|date)$/.exec(key);
      const plain = structured ? null : /^(url|location|date)_(\d+)$/.exec(key);
      if (!structured && !plain) continue;
      const index = structured ? Number(structured[1]) : Number(plain[2]);
      const field = structured ? structured[2] : plain[1];
      if (!byIndex.has(index)) byIndex.set(index, { url: '', location: '', date: '' });
      byIndex.get(index)[field] = typeof value === 'string' ? value : '';
    }
    return { claim_id: claim.id, format: content.format || 'evidence-form-v1', sources: [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, source]) => this.resolveCitation(source, index + 1)) };
  }
  // A bounded, searchable view of the library. Every cited count and every state is read from storage.
  evidenceLibrary(actor, options = {}) {
    // Reviewer inspection: the library is where a reviewer checks a source and its exact version, so
    // it is readable by a reviewer or administrator, not by any caller that can merely sign in.
    role(actor, ['admin', 'reviewer']);
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 25));
    const offset = Math.min(1_000_000, Math.max(0, Math.floor(Number(options.offset) || 0)));
    const q = typeof options.q === 'string' ? options.q.trim().slice(0, 120) : '';
    const args = q ? [`%${q.replace(/[%_\\]/g, '\\$&')}%`, `%${q.replace(/[%_\\]/g, '\\$&')}%`] : [];
    const where = q ? "WHERE source_key LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\'" : '';
    const total = this.get(`SELECT COUNT(*) AS n FROM evidence_sources ${where}`, ...args).n;
    const sources = this.all(`SELECT * FROM evidence_sources ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
    return {
      total, offset, limit, has_more: offset + sources.length < total,
      limits: { max_sources: EVIDENCE_LIMITS.max_sources, max_captures: EVIDENCE_LIMITS.max_captures, max_captures_per_source: EVIDENCE_LIMITS.max_captures_per_source, max_retained_bytes: EVIDENCE_LIMITS.max_retained_bytes, per_artifact_evidence: EVIDENCE_LIMITS.per_artifact_evidence, retained_bytes: this.retainedBytes(), captures: this.get('SELECT COUNT(*) AS n FROM evidence_captures').n },
      sources: sources.map((source) => {
        const versions = this.all('SELECT c.*,c.rowid AS seq FROM evidence_captures c WHERE c.source_id=? ORDER BY c.rowid ASC', source.id);
        const conflicts = evidenceConflicts(versions);
        return {
          id: source.id, source_key: source.source_key, url: source.url, host: source.host, path: source.path, status: source.status, withdrawn_reason: source.withdrawn_reason,
          versions: versions.map(captureView), cited_versions: this.get('SELECT COUNT(*) AS n FROM submission_evidence e JOIN evidence_captures c ON c.id=e.capture_id WHERE c.source_id=?', source.id).n,
          conflict: conflicts.declared_dates.length > 1 || conflicts.units.length > 1,
        };
      }),
    };
  }
  logout(actor) { this.run('UPDATE tokens SET revoked=1 WHERE hash=?', actor.credential.hash); return { logged_out: true }; }
  close() { this.db.close(); }
}
Object.assign(Platform.prototype, spaceMethods, communityMethods, journeyMethods, civicMethods, vocationMethods, vaultMethods, questMethods, guildMethods, firstPlayMethods);

Object.assign(Platform.prototype,draftMethods);

Object.assign(Platform.prototype,coinMethods);

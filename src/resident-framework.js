import { createHash } from 'node:crypto';
import { CALLINGS, CALLING_POLICY, MEMORY_KINDS, MEMORY_POLICY } from './vocations.js';
import { COIN_POLICY } from './coins.js';
import { VAULT_POLICY, VAULT_LIMITS } from './vault.js';

// ---- The resident framework ---------------------------------------------------------------------
//
// One resident is one row in `agents` owned by one operator account, one chosen calling, one issued
// runtime credential and one bounded run history. This module adds no store of its own: the
// declaration below is *derived* from those rows every time it is read, and the action ledger is
// written into the `audit` table the world already keeps hash-chained and append-only. There is no
// second bookkeeping system, no new table, no new column and no schema change.
//
// What it adds is one thing the world did not have: a resident's permission to act is *declared*, so
// one object can be read by the runtime that acts and by the operator (or moderator) who inspects,
// and every declared action walks the same five recorded steps — observe, propose, authorize,
// execute once, verify the saved result — or ends in an explicit refusal with a reason. A refusal is
// never reported as a success, a replayed intent is never executed twice, and a proposal is never
// recorded as an outcome.

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const parseList = (value) => { try { const item = JSON.parse(value || '[]'); return Array.isArray(item) ? item : []; } catch { return []; } };
const now = (platform) => new Date(platform.clock()).toISOString();

export const RESIDENT_DECLARATION_FORMAT = 'resident-declaration-v1';
const DECLARED_ACTION_VERSION = 'declared-action-v1';
const PURPOSES_LIMIT = 8;
const LEDGER_PAGE = 200;
const LEDGER_INTENT_LOOKUP = 20;

// ---- The declared action vocabulary --------------------------------------------------------------
//
// Each entry names the one runtime scope the action cost, the purpose it can serve, the fields a
// resident may state, and the world method the action hands the request to. `run` is a thin adapter:
// the shipped method decides every world rule (distance, capacity, membership, lease, ownership,
// enrollment), so this layer never re-implements one and never approves what the world refuses.
//
// `serves` names the calling objective sources the action can be *for*. A work action must name one
// of them, and only the objectives of the resident's own calling count, so a resident cannot take
// work outside its declared purpose. A presence or private action records no work, so it is bounded
// by its scope instead and says so in the declaration.
const CALLING_WORK_SOURCES = Object.freeze({
  thanks: ['thanks'],
  circle: ['circle_join'],
  pledge: ['project_pledge'],
  rsvp: ['event_rsvp'],
  guild: ['project_pledge'],
  garden: ['crop_plant', 'crop_harvest'],
  craft: ['craft'],
});

// The decisions that carry human authority or need the approved-source reader. A resident credential
// may never take one, whatever scope it holds: they are refused by name rather than reported as an
// unknown action, so an operator reading the ledger sees exactly what was attempted.
export const HUMAN_AUTHORITY_ACTIONS = Object.freeze([
  'review', 'reviews', 'adopt', 'adoption', 'adoptions', 'moderate', 'moderation', 'quarantine',
  'suspend', 'appeal', 'decide_appeal', 'award', 'award_coins', 'coins', 'credit', 'mint',
  'approve', 'accept', 'reject', 'claim', 'submit', 'submission', 'research', 'mission',
  'create_mission', 'create_task', 'mission_status', 'task', 'grant', 'land', 'plot_grant',
  'withdraw_evidence', 'evidence_capture', 'manage_community', 'manage', 'account', 'account_control',
  'invite', 'register', 'login', 'pause', 'pause_platform', 'backup', 'export', 'delete',
  'restoration_open', 'quest_author', 'quest_manage', 'vault_manage', 'memory_manage',
]);

const fieldText = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `${label} must contain 1–${max} characters.`);
  if (/[\r\n]/.test(value)) fail(400, `${label} must be one line.`);
  return value.trim();
};
const fieldId = (value, label) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(value)) fail(400, `${label} is not a valid identifier.`);
  return value;
};
const fieldChoice = (value, label, choices) => {
  if (!choices.includes(value)) fail(400, `${label} must be one of ${choices.join(', ')}.`);
  return value;
};
const fieldInteger = (value, label, minimum, maximum) => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail(400, `${label} must be a whole number between ${minimum} and ${maximum}.`);
  return value;
};
const fieldDate = (value, label) => {
  if (typeof value !== 'string' || value.length > 100 || !value.trim()) fail(400, `${label} must be a short date or reference.`);
  return value.trim();
};

/**
 * The declared action vocabulary. `fields` validates the request body, `texts` names the fields a
 * resident authors (they are scanned by the institutional-authority guard), `verify` re-reads the
 * saved world row this action produces, and `result` names the class the outcome is reported in.
 */
export const DECLARED_ACTIONS = Object.freeze({
  say: {
    scope: 'chat', family: 'presence', serves: [], texts: ['text'],
    fields: { text: (value) => fieldText(value, 'Public message', 500) },
    run: (platform, actor, agent, payload) => platform.message(actor, { agent_id: agent.id, text: payload.text, channel: 'public' }),
    saved: 'messages',
    verify: (platform, context, payload) => {
      const row = platform.get("SELECT id FROM messages WHERE agent_id=? AND channel='public' AND text=?", context.agent.id, payload.text);
      return { verified: Boolean(row), basis: 'saved-state', ref: row?.id || null, note: row ? 'A saved public message from this resident carries exactly this text.' : 'No saved public message from this resident carries this text.' };
    },
  },
  emote: {
    scope: 'move', family: 'presence', serves: [], texts: [],
    fields: { emote: (value) => fieldChoice(value, 'Expression', ['wave', 'bow', 'cheer', 'think', 'heart', 'none']) },
    run: (platform, actor, agent, payload) => platform.emote(actor, { agent_id: agent.id, emote: payload.emote }),
    saved: 'agents',
    verify: (platform, context, payload) => {
      const row = platform.get('SELECT emote FROM agents WHERE id=?', context.agent.id);
      return { verified: Boolean(row) && row.emote === payload.emote, basis: 'saved-state', ref: row?.emote || null, note: 'The resident’s saved expression is the one this action named.' };
    },
  },
  note: {
    scope: 'vault', family: 'private', serves: [], texts: ['text'],
    fields: { slot: (value) => fieldInteger(value, 'Vault slot', 1, 64), text: (value) => fieldText(value, 'Private note', 300) },
    run: (platform, actor, agent, payload) => platform.vaultWrite(actor, { agent_id: agent.id, slot: payload.slot, text: payload.text }),
    saved: 'resident_vault',
    verify: (platform, context, payload) => {
      const row = platform.get('SELECT version FROM resident_vault WHERE agent_id=? AND slot=?', context.agent.id, payload.slot);
      return { verified: Boolean(row), basis: 'saved-row-identity', ref: 'private', note: row ? 'The sealed vault slot holds a version. The note text is never read or reported here.' : 'That vault slot is empty.' };
    },
  },
  thanks: {
    scope: 'contribute', family: 'work', serves: CALLING_WORK_SOURCES.thanks, texts: ['reason'],
    fields: { recipient_agent_id: (value) => fieldId(value, 'Recipient'), reason: (value) => fieldText(value, 'Specific appreciation', 300) },
    run: (platform, actor, agent, payload) => platform.giveThanks(actor, { agent_id: agent.id, recipient_agent_id: payload.recipient_agent_id, reason: payload.reason }),
    saved: 'community_thanks',
    verify: (platform, context, payload) => {
      const day = now(platform).slice(0, 10);
      const row = platform.get('SELECT id FROM community_thanks WHERE giver_agent_id=? AND recipient_agent_id=? AND day=?', context.agent.id, payload.recipient_agent_id, day);
      return { verified: Boolean(row), basis: 'saved-row-identity', ref: row?.id || null, note: row ? 'The saved appreciation row is present for this resident, this recipient and this UTC day.' : 'No saved appreciation row matches this resident, recipient and day.' };
    },
  },
  circle: {
    scope: 'contribute', family: 'work', serves: CALLING_WORK_SOURCES.circle, texts: [],
    fields: { circle_id: (value) => fieldId(value, 'Circle'), intent: (value) => fieldChoice(value, 'Circle intent', ['join', 'leave']) },
    run: (platform, actor, agent, payload) => platform.circleMembership(actor, { agent_id: agent.id, circle_id: payload.circle_id, action: payload.intent }),
    saved: 'community_members',
    verify: (platform, context, payload) => {
      const row = platform.get('SELECT agent_id FROM community_members WHERE circle_id=? AND agent_id=?', payload.circle_id, context.agent.id);
      const wanted = payload.intent === 'join';
      return { verified: Boolean(row) === wanted, basis: 'saved-row-identity', ref: payload.circle_id, note: wanted ? 'The saved membership row is present.' : 'The saved membership row is gone, as the leave asked.' };
    },
  },
  pledge: {
    scope: 'contribute', family: 'work', serves: CALLING_WORK_SOURCES.pledge, texts: ['commitment'], proposal: true,
    fields: { project_id: (value) => fieldId(value, 'Project'), intent: (value) => fieldChoice(value, 'Project intent', ['pledge', 'unpledge']), commitment: (value) => fieldText(value, 'Contribution commitment', 500) },
    run: (platform, actor, agent, payload) => platform.projectPledge(actor, { agent_id: agent.id, project_id: payload.project_id, action: payload.intent, commitment: payload.commitment }),
    saved: 'community_pledges',
    verify: (platform, context, payload) => {
      const row = platform.get('SELECT agent_id FROM community_pledges WHERE project_id=? AND agent_id=?', payload.project_id, context.agent.id);
      const wanted = payload.intent === 'pledge';
      return { verified: Boolean(row) === wanted, basis: 'saved-row-identity', ref: payload.project_id, note: wanted ? 'The saved pledge row is present.' : 'The saved pledge row is gone, as the unpledge asked.' };
    },
  },
  rsvp: {
    scope: 'contribute', family: 'work', serves: CALLING_WORK_SOURCES.rsvp, texts: [], proposal: true,
    fields: { event_id: (value) => fieldId(value, 'Gathering'), intent: (value) => fieldChoice(value, 'Gathering intent', ['join', 'cancel']) },
    run: (platform, actor, agent, payload) => platform.eventRSVP(actor, { agent_id: agent.id, event_id: payload.event_id, action: payload.intent }),
    saved: 'community_rsvps',
    verify: (platform, context, payload) => {
      const row = platform.get('SELECT agent_id FROM community_rsvps WHERE event_id=? AND agent_id=?', payload.event_id, context.agent.id);
      const wanted = payload.intent === 'join';
      return { verified: Boolean(row) === wanted, basis: 'saved-row-identity', ref: payload.event_id, note: wanted ? 'The saved RSVP row is present.' : 'The saved RSVP row is gone, as the cancel asked.' };
    },
  },
  guild: {
    scope: 'contribute', family: 'work', serves: CALLING_WORK_SOURCES.guild, texts: [], proposal: true,
    fields: { project_id: (value) => fieldId(value, 'Guild project'), intent: (value) => fieldChoice(value, 'Guild intent', ['join', 'leave']) },
    run: (platform, actor, agent, payload) => platform.guildParticipation(actor, { agent_id: agent.id, project_id: payload.project_id, action: payload.intent }),
    saved: 'guild_participants',
    verify: (platform, context, payload) => {
      const row = platform.get('SELECT agent_id FROM guild_participants WHERE project_id=? AND agent_id=?', payload.project_id, context.agent.id);
      const wanted = payload.intent === 'join';
      return { verified: Boolean(row) === wanted, basis: 'saved-row-identity', ref: payload.project_id, note: wanted ? 'The saved participation row is present.' : 'The saved participation row is gone, as the leave asked.' };
    },
  },
  garden: {
    scope: 'build', family: 'work', serves: CALLING_WORK_SOURCES.garden, texts: [],
    fields: { intent: (value) => fieldChoice(value, 'Garden action', ['plant', 'tend', 'harvest']), x: (value) => fieldInteger(value, 'Garden x', 0, 255), y: (value) => fieldInteger(value, 'Garden y', 0, 255), kind: (value) => fieldId(value, 'Crop kind') },
    requires: { plant: ['kind'] },
    run: (platform, actor, agent, payload) => platform.gardenAction(actor, { agent_id: agent.id, action: payload.intent, x: payload.x, y: payload.y, ...(payload.kind ? { kind: payload.kind } : {}) }),
    saved: 'journey_crops',
    verify: (platform, context, payload) => {
      const row = platform.get('SELECT kind,planted_at,tended_at,harvested_at FROM journey_crops WHERE agent_id=? AND x=? AND y=?', context.agent.id, payload.x, payload.y);
      const growing = Boolean(row) && row.harvested_at == null;
      const verified = payload.intent === 'plant' ? growing && row.kind === payload.kind
        : payload.intent === 'tend' ? growing && row.tended_at != null
        : Boolean(row) && row.harvested_at != null;
      return { verified, basis: 'saved-row-identity', ref: `${payload.x},${payload.y}`, note: 'The saved crop row is read back and compared with what the action asked for.' };
    },
  },
  craft: {
    scope: 'build', family: 'work', serves: CALLING_WORK_SOURCES.craft, texts: [],
    fields: { recipe_id: (value) => fieldId(value, 'Recipe') },
    run: (platform, actor, agent, payload) => platform.craftItem(actor, { agent_id: agent.id, recipe_id: payload.recipe_id }),
    saved: 'journey_inventory',
    verify: (platform, context, payload, result) => {
      const output = result?.crafted;
      const row = output ? platform.get('SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind=?', context.agent.id, output) : null;
      return { verified: Boolean(row) && row.quantity >= 1, basis: 'saved-state', ref: output || null, note: row ? 'The resident’s saved shelf holds the crafted keepsake.' : 'The crafted keepsake is not on the saved shelf.' };
    },
  },
  remember: {
    scope: 'contribute', family: 'record', serves: [], texts: ['value', 'subject'], proposal: true,
    fields: {
      kind: (value) => fieldChoice(value, 'Memory kind', ['activity', 'lesson']),
      attribute: (value) => fieldChoice(value, 'Memory attribute', ['calling_objective', 'quest_step', 'refusal', 'review_feedback']),
      subject: (value) => fieldText(value, 'Memory subject', 80),
      value: (value) => fieldText(value, 'Memory value', 160),
    },
    requires: {},
    run: (platform, actor, agent, payload) => platform.memoryPropose(actor, { agent_id: agent.id, kind: payload.kind, attribute: payload.attribute, ...(payload.subject ? { subject: payload.subject } : {}), value: payload.value }),
    saved: 'resident_memory',
    verify: (platform, context, payload) => {
      const row = platform.get("SELECT id,state FROM resident_memory WHERE agent_id=? AND attribute=? AND value=? ORDER BY created_at DESC,id DESC LIMIT 1", context.agent.id, payload.attribute, payload.value);
      return { verified: Boolean(row), basis: 'saved-row-identity', ref: 'private', note: row ? `A saved memory fact of this attribute carries this value, currently ${row.state}.` : 'No saved memory fact carries this value.' };
    },
  },
});

// What each saved result is and what it is not. A proposal is never an outcome: the classes marked
// `proposal` say, in the response and in the ledger, that the record is a promise or a proposal.
export const RESULT_CLASSES = Object.freeze({
  'public-message': Object.freeze({ note: 'A public message is a message. It is not evidence, not a granted request and not an outcome.', proposal: false }),
  'expression': Object.freeze({ note: 'An expression changes how the resident looks. It records no work and no outcome.', proposal: false }),
  'private-note': Object.freeze({ note: 'A vault note is the resident’s own private note. It is not evidence, not memory and not an outcome.', proposal: false }),
  'recorded-appreciation': Object.freeze({ note: 'Appreciation is recorded between two operators. It does not verify the work appreciated and is not an outcome.', proposal: false }),
  'membership': Object.freeze({ note: 'Membership is participation, not proof of a project outcome.', proposal: false }),
  'attendance-pledge': Object.freeze({ note: 'An RSVP is an attendance pledge, not proof of attendance or of a completed meeting.', proposal: true }),
  'contribution-pledge': Object.freeze({ note: 'A pledge is a promise and is not completed work.', proposal: true }),
  'participation': Object.freeze({ note: 'Joining is participation only. It grants no calling, account role, plot, building right, moderator or reviewer authority, and no coin.', proposal: true }),
  'in-world-saved-fact': Object.freeze({ note: 'This is a saved fact inside NemoWorld. It says nothing about the world outside it.', proposal: false }),
  'memory-proposal': Object.freeze({ note: 'A memory proposal is not memory and not an outcome. It becomes an approved fact only when the owning operator decides it.', proposal: true }),
});
const RESULT_CLASS_OF_ACTION = Object.freeze({
  say: 'public-message', emote: 'expression', note: 'private-note', thanks: 'recorded-appreciation',
  circle: 'membership', pledge: 'contribution-pledge', rsvp: 'attendance-pledge', guild: 'participation',
  garden: 'in-world-saved-fact', craft: 'in-world-saved-fact', remember: 'memory-proposal',
});

/** The result class of one action, with the boundary a reader must keep. */
export function actionResultClass(action) {
  const id = RESULT_CLASS_OF_ACTION[action] || 'in-world-saved-fact';
  return { id, ...RESULT_CLASSES[id] };
}

// ---- Refusals -----------------------------------------------------------------------------------
//
// One closed vocabulary. Every step that does not complete is recorded with one of these reasons, and
// a refusal is returned as a refusal: `success:false`, a refusing HTTP status, and a durable ledger
// row. A refusal for any reason at all is never rendered as an executed action.
export const REFUSAL_REASONS = Object.freeze({
  invalid_proposal: 'The request is not a well-formed declared action for this resident.',
  unknown_action: 'That is not a declared action of a NemoWorld resident.',
  human_authority_required: 'Reviewing, adopting, moderating, awarding and mission work are human or approved-source decisions; a resident credential can never take one.',
  declaration_defect: 'The resident’s own declaration carries a claim this framework refuses. Fix the named operator-entered field, then read the declaration again.',
  outside_declared_purpose: 'The action does not serve the declared purpose and calling of this resident.',
  scope_not_granted: 'The runtime credential does not carry the scope this action needs.',
  budget_exhausted: 'The runtime credential has used its whole action budget.',
  credential_revoked: 'The runtime credential was revoked. A revoked credential cannot continue, and no step of a run continues past it.',
  credential_expired: 'The runtime credential has expired.',
  credential_missing: 'No runtime credential row matches this request.',
  runtime_credential_required: 'A declared action requires a resident runtime credential issued by this resident’s operator.',
  resident_not_active: 'The resident is not active, so it may not act.',
  platform_paused: 'The platform is paused.',
  intent_reused_for_other_work: 'This intent id was already used for different work.',
  self_award_refused: 'A resident can never award itself coins or credits, and no declared action carries an amount.',
  institutional_authority_claim: 'No resident field or action may assert a government, ministry, United Nations or institutional endorsement.',
  world_refused: 'The world refused this action. Its own rules decide, and this layer never overrides them.',
  verification_failed: 'The action was written but its saved result could not be verified, so nothing is reported as done.',
});
export const REFUSAL_REASON_IDS = Object.freeze(Object.keys(REFUSAL_REASONS));

// ---- The institutional-authority guard -----------------------------------------------------------
//
// A bounded, word-level filter, not a semantic check: it refuses a *stored field* that asserts
// representation of, or endorsement by, a government, a ministry, the United Nations or another
// institution. A plain mention of a publisher ("UN Comtrade"), an honest denial ("not endorsed by any
// government") and a source citation are all left alone. The declaration says the same thing, so an
// operator can see exactly how narrow the rule is.
export const INSTITUTIONAL_CLAIM_NOTE = 'This is a word-level guard over the stored field, applied before the field is written or acted on. It refuses an assertion of representation or endorsement. Naming an institution as a source, and stating plainly that no institution has endorsed anything, are both allowed.';
const INSTITUTIONS = '(?:united nations|u\\.n\\.|UN|government|ministry|minister|embassy|consulate|parliament|congress|department of|secretariat|agency|institution|commission)';
export const INSTITUTIONAL_CLAIM_RULES = Object.freeze([
  Object.freeze({
    id: 'representation',
    pattern: new RegExp(`\\b(?:i|we|this resident|this agent|this character|my operator and i)\\b[^.!?]{0,60}\\b(?:am|are|represent|represents|speak|speaks|speaking|act|acts|acting|work|works|working)\\b[^.!?]{0,40}\\b${INSTITUTIONS}\\b`, 'i'),
    note: 'A resident never represents a government, a ministry, a United Nations body or another institution.',
  }),
  Object.freeze({
    id: 'endorsement',
    pattern: new RegExp(`\\b(?:endorsed|endorsement|accredited|sanctioned|authorized|certified|mandated|approved)\\b[^.!?]{0,40}\\b(?:by|of|from)\\b[^.!?]{0,30}\\b${INSTITUTIONS}\\b`, 'i'),
    note: 'A stored field never claims an institution’s endorsement, accreditation or approval.',
  }),
  Object.freeze({
    id: 'official-title',
    pattern: /\b(?:official (?:representative|envoy|delegate|spokesperson|officer)|on behalf of the (?:united nations|government|ministry)|goodwill ambassador|government-appointed)\b/i,
    note: 'A resident never claims an official title or to speak on an institution’s behalf.',
  }),
]);
const DENIAL_BEFORE = /\b(?:not|never|no|nobody|nothing|without)\b[^.!?]{0,24}$/i;
const INSTITUTION_AT = new RegExp(INSTITUTIONS, 'i');

// A match is a claim unless the clause denies it: a denial immediately before the claim, or a
// negation between the subject and the institution it names ("We are not representatives of the
// United Nations"). A plain source mention carries no such negation and is left alone.
function deniedClaim(value, match) {
  const before = value.slice(Math.max(0, match.index - 24), match.index);
  if (DENIAL_BEFORE.test(before)) return true;
  const institution = INSTITUTION_AT.exec(match[0]);
  return Boolean(institution) && /\b(?:not|never|no)\b/i.test(match[0].slice(0, institution.index));
}

/** The first institutional-authority claim in one stored field, or null. A negated clause is a denial. */
export function institutionalClaim(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  for (const rule of INSTITUTIONAL_CLAIM_RULES) {
    const matcher = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
    let match;
    while ((match = matcher.exec(value)) !== null) {
      if (deniedClaim(value, match)) continue;
      return { rule: rule.id, note: rule.note, at: match.index };
    }
  }
  return null;
}
/** Refuse a stored field that asserts institutional authority. Returns the field unchanged. */
export function assertNoInstitutionalClaim(value, field) {
  const claim = institutionalClaim(value);
  if (claim) fail(403, `${field}: ${claim.note}`);
  return value;
}

// ---- The declaration -----------------------------------------------------------------------------
//
// Everything below is read from the rows the world already holds: the `agents` row (identity, kind,
// status, the operator-entered capability and limitation text), `resident_callings` and the calling
// catalog (the chosen calling and its objectives), `resident_memory` rows of kind `purpose` (the
// operator's declared purpose — a purpose fact can only ever be recorded by the operator, never by a
// resident), `tokens` (the issued runtime credential, its scopes, its used and remaining calls and
// its revocation) and `resident_runs` (the bounded runs this resident has been given).
//
// There is no field here that has no home: the purpose is the operator-recorded purpose fact (or the
// calling's own stated purpose when none was recorded), the budget is the issued runtime credential,
// and the permitted actions are the credential's scopes crossed with the calling's own objective
// sources. The free-text boundaries an operator writes into a purpose fact are surfaced as
// declaration text and are *not* machine-enforced; the declaration says so rather than implying a
// constraint the framework cannot check.

function liveCredential(platform, agentId) {
  return platform.get("SELECT scopes,max_calls,used_calls,expires_at,revoked FROM tokens WHERE agent_id=? AND kind='runtime' AND revoked=0 AND expires_at>? ORDER BY expires_at DESC LIMIT 1", agentId, platform.clock()) || null;
}

function budgetView(platform, agent, options = {}) {
  const clock = platform.clock();
  const issued = platform.get("SELECT COUNT(*) AS n FROM tokens WHERE agent_id=? AND kind='runtime'", agent.id).n;
  const live = liveCredential(platform, agent.id);
  // The budget is one credential row. The caller's own credential is reported when it names one, and
  // an operator who holds no live credential still sees the most recent one, so a revocation is
  // visible as a revocation instead of as a resident that never had a credential at all.
  const row = options.credentialHash
    ? platform.get("SELECT scopes,max_calls,used_calls,expires_at,revoked FROM tokens WHERE hash=? AND kind='runtime'", options.credentialHash) || null
    : live || platform.get("SELECT scopes,max_calls,used_calls,expires_at,revoked FROM tokens WHERE agent_id=? AND kind='runtime' ORDER BY expires_at DESC LIMIT 1", agent.id) || null;
  if (!row) return {
    credential: 'none', present: false, usable: false, live_credential: false, issued_credentials: issued,
    scopes: [], max_calls: 0, used_calls: 0, remaining_calls: 0, expires_at: null, expires_in_ms: null, revoked: false,
    bound: 'The action budget is the runtime credential the operator issued for this resident. No credential is issued, so no declared action can run.',
  };
  const remaining = Math.max(0, row.max_calls - row.used_calls);
  return {
    credential: 'runtime', present: true, revoked: Boolean(row.revoked), scopes: parseList(row.scopes),
    max_calls: row.max_calls, used_calls: row.used_calls, remaining_calls: remaining,
    expires_at: row.expires_at, expires_in_ms: Math.max(0, row.expires_at - clock),
    live_credential: Boolean(live), issued_credentials: issued,
    usable: !row.revoked && row.expires_at > clock && remaining > 0 && agent.status === 'active',
    bound: 'One declared action costs one call of the credential the operator issued, exactly as every other runtime write already does. The budget is the credential row itself, never a copy of it.',
  };
}

/** The operator-recorded purpose of one resident: every active `purpose` memory fact, and nothing else. */
function purposeView(platform, agent, definition) {
  const facts = platform.all("SELECT attribute,subject,value,decided_at,origin FROM resident_memory WHERE agent_id=? AND kind='purpose' AND state='active' ORDER BY decided_at DESC,id DESC LIMIT ?", agent.id, PURPOSES_LIMIT)
    .map((row) => ({ attribute: row.attribute, subject: row.subject, value: row.value, decided_at: row.decided_at, origin: row.origin }));
  const statements = facts.filter((fact) => fact.attribute === 'intent').map((fact) => fact.value);
  return {
    source: facts.length ? 'operator-recorded-purpose' : 'calling-default',
    statement: statements.length ? statements.join('; ') : definition.purpose,
    facts,
    boundaries: facts.filter((fact) => fact.attribute === 'boundary').map((fact) => fact.value),
    targets: [
      ...definition.objectives.map((objective) => ({ id: `${definition.id}.${objective.id}`, kind: 'calling_objective', label: objective.title, action_hint: objective.action_hint })),
      ...facts.map((fact) => ({ id: `purpose:${fact.attribute}`, kind: 'declared_purpose', label: fact.subject || `Declared ${fact.attribute}` })),
    ],
    enforcement: 'A work action must name one of the calling-objective targets of this resident’s own calling, and the world still decides the action. The operator’s free-text boundaries are shown as declaration text and are not machine-enforced by this framework.',
  };
}

/** What the four prohibitions are, whether a guard already existed, and where it lives. */
export const PROHIBITIONS = Object.freeze([
  Object.freeze({
    id: 'self-review',
    rule: 'A resident, or its operator, can never review, accept or adopt its own work.',
    guard: 'pre-existing',
    where: 'Platform.review (src/platform.js) refuses a contributor’s own account; Platform.adoption refuses the contributor and the acceptance reviewer; the coins_validate_insert trigger in src/coins.js refuses an ineligible receipt.',
    additional: 'The declared action vocabulary contains no review, adoption, moderation or award action, so the same decision cannot be reached through this surface at all.',
  }),
  Object.freeze({
    id: 'institutional-authority',
    rule: 'No field a resident reads or writes may assert a government, ministry, United Nations or institutional endorsement.',
    guard: 'new',
    where: 'src/resident-framework.js — institutionalClaim/assertNoInstitutionalClaim over every authored action text, and declarationDefects over the operator-entered agent fields and the recorded purpose facts.',
    additional: 'A declaration defect blocks every declared action of that resident until the named field is fixed.',
  }),
  Object.freeze({
    id: 'self-award',
    rule: 'A resident can never award itself, or any other resident, NemoCoins or credit.',
    guard: 'pre-existing',
    where: 'Platform.awardCoins (src/coins.js) requires an independent human review session and refuses a receipt for the reviewer’s own account; the coin table is append-only and the trigger re-checks eligibility.',
    additional: 'No declared action carries an amount, a coin, a credit or a price; such a field is refused by name (self_award_refused) and recorded as a refusal.',
  }),
  Object.freeze({
    id: 'proposal-not-outcome',
    rule: 'A proposed real-world result is never recorded or reported as achieved.',
    guard: 'pre-existing',
    where: 'submission states in src/review-assessment.js (pending/held are never accepted), the adoption boundary texts, and the source-based research prompt in runtime/research-brief.js.',
    additional: 'This module records every applied action in a closed state vocabulary (executed/proposed/refused), reports proposals with proposal:true and achievement always false, and refuses to serialize a proposal as an outcome (assertProposalNotOutcome).',
  }),
]);

/** Anything the declaration itself carries that this framework refuses. */
export function declarationDefects({ agent, definition, purposes = [] }) {
  const defects = [];
  for (const field of ['name', 'capabilities', 'limitations']) {
    const claim = institutionalClaim(agent[field] || '');
    if (claim) defects.push({ id: 'institutional-authority-claim', field, rule: claim.rule, note: claim.note, remedy: `Edit the resident’s ${field} so it states what the resident does, not whose authority it carries.` });
  }
  for (const fact of purposes) {
    const claim = institutionalClaim(fact.value || '');
    if (claim) defects.push({ id: 'institutional-authority-claim', field: `purpose:${fact.attribute}`, rule: claim.rule, note: claim.note, remedy: 'Correct or delete the recorded purpose fact through the operator memory controls.' });
  }
  if (!definition) defects.push({ id: 'unknown-calling', field: 'resident_callings.calling_id', rule: 'unknown-calling', note: 'The stored calling is not in the calling catalog.', remedy: 'Choose a listed calling for this resident.' });
  return defects;
}

/** The derived declaration of one resident: identity, calling, purpose, permitted actions, budget, limitations. */
export function declarationCore(platform, agent, options = {}) {
  const calling = platform.get('SELECT calling_id,selected_at,last_changed_day FROM resident_callings WHERE agent_id=?', agent.id) || null;
  const definition = CALLINGS.find((item) => item.id === calling?.calling_id) || CALLINGS.find((item) => item.id === CALLING_POLICY.default_calling) || CALLINGS[0];
  const purposes = platform.all("SELECT attribute,value FROM resident_memory WHERE agent_id=? AND kind='purpose' AND state='active' ORDER BY decided_at DESC,id DESC LIMIT ?", agent.id, PURPOSES_LIMIT);
  const defects = declarationDefects({ agent, definition, purposes });
  const purpose = purposeView(platform, agent, definition);
  const budget = budgetView(platform, agent, options);
  const scopes = new Set(budget.scopes);
  const targets = new Set(purpose.targets.map((target) => target.id));
  const permitted_actions = Object.entries(DECLARED_ACTIONS).map(([action, spec]) => {
    const serves = (spec.serves || []).map((source) => `${definition.id}.${source}`).filter((id) => targets.has(id));
    const work = spec.family === 'work';
    return {
      action, scope: spec.scope, family: spec.family, serves,
      purpose_basis: work ? (serves.length ? 'calling-objective' : 'not-named-by-this-calling') : 'granted-scope',
      granted: scopes.has(spec.scope),
      available: scopes.has(spec.scope) && (!work || serves.length > 0) && budget.usable,
    };
  });
  const state = ['active', 'paused', 'revoked', 'suspended', 'deleted'].includes(agent.status) ? agent.status : 'unknown';
  const can = permitted_actions.some((entry) => entry.available);
  const reason = defects.length ? 'declaration_defect'
    : state !== 'active' ? 'resident_not_active'
    : !budget.present ? 'runtime_credential_required'
    : budget.revoked ? 'credential_revoked'
    : budget.expires_in_ms <= 0 ? 'credential_expired'
    : budget.remaining_calls < 1 ? 'budget_exhausted' : 'scope_not_granted';
  return {
    format: RESIDENT_DECLARATION_FORMAT,
    version: DECLARED_ACTION_VERSION,
    generated_at: now(platform),
    identity: {
      agent_id: agent.id, name: agent.name, kind: agent.kind, state, resident: agent.kind === 'agent',
      operator_id: agent.operator_id, world_id: agent.world_id, region_id: agent.region_id, country: agent.country,
      created_at: agent.created_at,
      note: 'The resident is one character row owned by one operator account. It holds no account of its own and no credential that a human did not issue for it.',
    },
    calling: {
      id: definition.id, name: definition.name, guild_name: definition.guild_name, purpose: definition.purpose, charter: definition.charter,
      objectives: definition.objectives.map((objective) => ({ id: `${definition.id}.${objective.id}`, source_kind: objective.source_kind, title: objective.title, instructions: objective.instructions, action_hint: objective.action_hint })),
      selected_at: calling?.selected_at ?? null, last_changed_day: calling?.last_changed_day || '',
      defaults: calling ? 'chosen' : 'no calling recorded; the catalog default applies',
    },
    purpose,
    permitted_actions,
    budget,
    limitations: {
      declared: [agent.limitations].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()),
      capabilities: typeof agent.capabilities === 'string' ? agent.capabilities.trim() : '',
      policy: [
        CALLING_POLICY.description, MEMORY_POLICY.description, COIN_POLICY.description, VAULT_POLICY.summary,
        'A declared action is bounded by its credential scope, its credential budget and its declared purpose, and the world’s own rules still decide the action itself.',
      ],
      human_prerequisites: [
        'An independent human reviewer must accept real mission work before any coin is issued.',
        'A mission owner must record an adoption separately; an adoption is a declaration, not proof of implementation.',
        'Only the human operator can choose a calling, issue or change a runtime credential, decide memory or delete the resident.',
        'A moderator sanctions through a report; no resident and no runtime credential can moderate anything.',
      ],
      free_text_boundaries: 'A purpose boundary an operator writes is declaration text. This framework does not enforce prose, and it does not pretend to.',
    },
    prohibitions: PROHIBITIONS,
    may_act: can && defects.length === 0,
    may_act_reason: can && defects.length === 0 ? 'The resident holds a live credential with at least one available declared action.' : reason,
    defects,
  };
}

/**
 * A proposal is never an outcome. This is the one guard every result passes through before it is
 * returned or recorded: a proposal-class result must report itself as a proposal, must never report
 * achievement, and must never claim a real-world outcome.
 */
export function assertProposalNotOutcome(view) {
  if (view?.proposal === true && (view.achieved !== false || view.real_world_outcome !== null)) {
    fail(500, 'A proposed action was about to be reported as an achieved outcome.');
  }
  return view;
}

// ---- The action ledger ---------------------------------------------------------------------------
//
// One line per declared action, in the world's own append-only, hash-chained `audit` table. The
// record id is the durable key of the step: `<agent>|<intent>|<key>|<action>|<state>|<serves>|<ref>|<reason>`.
// `key` is a SHA-256 over the resident, the intent id and the canonical body, so the same retry is
// recognisable as the action already sent, and a reused intent id for different work is detectable.
// The ledger stores no message text, no memory value and no note content.
const LEDGER_EVENTS = Object.freeze({ executed: 'resident.action.executed', proposed: 'resident.action.proposed', refused: 'resident.action.refused' });
export const LEDGER_STATES = Object.freeze(Object.keys(LEDGER_EVENTS));
const APPLIED_STATES = Object.freeze(['executed', 'proposed']);
const LEDGER_RECORD = /^([A-Za-z0-9:_-]{1,64})\|([A-Za-z0-9:_-]{1,64})\|([a-f0-9]{32}|-)\|([a-z_]{2,32})\|(executed|proposed|refused)\|([A-Za-z0-9:._-]{1,64})\|([A-Za-z0-9:._-]{1,64})\|([A-Za-z0-9_-]{1,40})$/;

function ledgerRecordId({ agentId, intentId, key, action, state, serves, ref, reason }) {
  return [agentId, intentId, key || '-', action, state, serves || '-', ref || '-', reason || '-'].join('|');
}
/** One ledger line, or null when the stored text is not one this module wrote. */
export function parseLedgerRecord(value) {
  const match = LEDGER_RECORD.exec(String(value || ''));
  if (!match) return null;
  return {
    agent_id: match[1], intent_id: match[2], key: match[3] === '-' ? null : match[3], action: match[4], state: match[5],
    serves: match[6] === '-' ? null : match[6], ref: match[7] === '-' ? null : match[7], reason: match[8] === '-' ? null : match[8],
  };
}
/** The declared action key: the same resident, intent and canonical body always produce the same key. */
export function declaredActionKey(agentId, intentId, action, serves, payload) {
  return hash(JSON.stringify([agentId, intentId, action, serves || null, payload])).slice(0, 32);
}

function ledgerRows(platform, agentId, limit = LEDGER_PAGE) {
  return platform.all("SELECT seq,event,record_id,created_at FROM audit WHERE event IN ('resident.action.executed','resident.action.proposed','resident.action.refused') AND record_id LIKE ? ORDER BY seq DESC LIMIT ?", `${agentId}|%`, limit)
    .map((row) => { const parsed = parseLedgerRecord(row.record_id); return parsed ? { ...parsed, at: row.created_at, event: row.event, seq: row.seq } : null; })
    .filter(Boolean);
}
function ledgerForIntent(platform, agentId, intentId) {
  return platform.all("SELECT seq,event,record_id,created_at FROM audit WHERE event IN ('resident.action.executed','resident.action.proposed','resident.action.refused') AND record_id LIKE ? ORDER BY seq DESC LIMIT ?", `${agentId}|${intentId}|%`, LEDGER_INTENT_LOOKUP)
    .map((row) => { const parsed = parseLedgerRecord(row.record_id); return parsed ? { ...parsed, at: row.created_at, event: row.event } : null; })
    .filter(Boolean);
}
/** Undo the isolated world write of one declared action, leaving the outer transaction usable. */
function rollback(platform) {
  platform.db.exec('ROLLBACK TO resident_declared_action');
  platform.db.exec('RELEASE resident_declared_action');
}

function writeLedger(platform, accountId, record) {  const event = LEDGER_EVENTS[record.state];
  const recordId = ledgerRecordId(record);
  platform.audit(accountId, event, recordId);
  return { event, record_id: recordId, durable: true };
}
/** One ledger line as an operator reads it: an applied proposal is never presented as an outcome. */
export function ledgerEntryView(row) {
  const applied = APPLIED_STATES.includes(row.state);
  return {
    at: row.at, action: row.action, state: row.state, serves: row.serves, intent_id: row.intent_id, key: row.key,
    saved_ref: row.ref === 'private' ? null : row.ref,
    withheld_ref_note: row.ref === 'private' ? 'This action saved a private record; its identifier is withheld and its content is never exposed here.' : null,
    applied, is_outcome: row.state === 'executed',
    reason: row.reason, reason_note: row.reason ? REFUSAL_REASONS[row.reason] || 'Refused.' : null,
  };
}

/** The declared action history of one resident, newest first, read from the durable ledger. */
export function actionHistory(platform, agentId, options = {}) {
  const limit = Number.isInteger(options.limit) ? Math.min(LEDGER_PAGE, Math.max(1, options.limit)) : LEDGER_PAGE;
  const rows = ledgerRows(platform, agentId, limit + 1);
  const page = rows.slice(0, limit);
  return {
    total: page.length, limit, has_more: rows.length > limit,
    counts: {
      executed: page.filter((row) => row.state === 'executed').length,
      proposed: page.filter((row) => row.state === 'proposed').length,
      refused: page.filter((row) => row.state === 'refused').length,
    },
    refusals: page.filter((row) => row.state === 'refused').map((row) => ({ at: row.at, action: row.action, reason: row.reason, reason_note: REFUSAL_REASONS[row.reason] || 'Refused.' })),
    entries: page.map(ledgerEntryView),
    bound: `The newest ${LEDGER_PAGE} ledger lines are read from the append-only audit table. Nothing is reconstructed from memory or from a running worker.`,
  };
}

// ---- The declared action lifecycle ---------------------------------------------------------------

const INTENT = /^[A-Za-z0-9:_-]{1,64}$/;
const COIN_FIELDS = Object.freeze(['amount', 'amounts', 'coins', 'coin', 'reward', 'rewards', 'credit', 'credits', 'balance', 'payout', 'price', 'cost', 'tip', 'transfer', 'mint']);

/** The declared proposal of one request: the action, the intent id, the purpose target and the body. */
export function declaredProposal(input, headerIntent) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'A declared action needs a JSON object.');
  const action = typeof input.action === 'string' ? input.action.trim() : '';
  if (!action) fail(400, 'A declared action names one declared action.');
  const intent = input.intent_id ?? headerIntent;
  const spec = DECLARED_ACTIONS[action] || null;
  const allowed = ['action', 'serves', 'intent_id', ...(spec ? Object.keys(spec.fields) : [])];
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  const coinField = extra.find((key) => COIN_FIELDS.includes(key.toLowerCase()));
  if (!INTENT.test(typeof intent === 'string' ? intent : '')) fail(400, 'A declared action needs an intent id of 1–64 letters, digits, colon, underscore or dash.');
  const serves = input.serves === undefined || input.serves === null ? null : String(input.serves);
  if (coinField) return { action, intent_id: intent, serves, coinField, extra, spec, payload: null };
  if (!spec) return { action, intent_id: intent, serves, coinField: null, extra, spec: null, payload: null };
  if (extra.length) fail(400, `A declared ${action} action names only ${allowed.join(', ')}.`);
  const payload = {};
  for (const [field, validate] of Object.entries(spec.fields)) {
    if (input[field] === undefined) {
      const required = spec.requires?.[input.intent] || [];
      if (required.includes(field)) fail(400, `A declared ${action} action needs ${field}.`);
      continue;
    }
    payload[field] = validate(input[field]);
  }
  return { action, intent_id: intent, serves, coinField: null, extra: [], spec, payload };
}

const REFUSAL_STATUS = Object.freeze({ budget_exhausted: 429, credential_revoked: 401, credential_expired: 401, credential_missing: 401, runtime_credential_required: 403, human_authority_required: 403, scope_not_granted: 403, outside_declared_purpose: 403, institutional_authority_claim: 403, self_award_refused: 403, declaration_defect: 409, resident_not_active: 409, platform_paused: 503, intent_reused_for_other_work: 409, unknown_action: 400, invalid_proposal: 400, world_refused: 409, verification_failed: 503 });

function refusal(record, reason, options = {}) {
  return {
    state: 'refused', success: false, applied: false, is_outcome: false,
    action: record?.action || null, serves: record?.serves || null, intent_id: record?.intent_id || null, key: record?.key || null,
    reason, reason_note: REFUSAL_REASONS[reason] || 'Refused.',
    error: options.error || REFUSAL_REASONS[reason] || 'Refused.',
    detail: options.detail || null,
    http_status: options.http_status || REFUSAL_STATUS[reason] || 409,
    lifecycle: options.lifecycle || null,
    recorded: Boolean(options.recorded),
    previously_applied: options.previously_applied || null,
    budget: options.budget || null,
  };
}

/**
 * One declared action, walked through observe → propose → authorize → execute once → verify → record.
 *
 * The correctness rules this method is built on, each one asserted by a test:
 *  - the world write and its ledger line commit in the *same* SQLite transaction, so a process death
 *    leaves both or neither and there is no "dispatched but unconfirmed" window to guess about;
 *  - the ledger line is read back from the database before the world is touched again, so a retried
 *    intent is reported, never re-executed;
 *  - the credential row is re-read inside this transaction, so a run cannot continue past a
 *    revocation even when its caller still holds an older authorization snapshot;
 *  - a refused step is recorded with a reason and returned as a refusal, never as an executed action;
 *  - a proposal-class result is reported as a proposal, and achievement is always false.
 */
function declaredAction(platform, actor, input, headerIntent) {
  const account = actor.account;
  const clock = platform.clock();
  const agent = platform.get('SELECT * FROM agents WHERE id=?', actor.agent.id);
  if (!agent) fail(404, 'Resident not found.');

  const proposal = declaredProposal(input, headerIntent);
  const record = { agentId: agent.id, intentId: proposal.intent_id, key: null, action: proposal.action, serves: proposal.serves, ref: null, reason: null };
  const lifecycle = [];
  const step = (name, state, detail) => { lifecycle.push({ step: name, state, detail }); };

  // ---- observe: the declaration, read from the rows themselves ----
  const declaration = declarationCore(platform, agent, { credentialHash: actor.credential.hash });
  step('observe', 'complete', `Declaration read from the agent row, calling, purpose, credential and status (${declaration.permitted_actions.filter((entry) => entry.available).length} declared actions available).`);
  const budget = declaration.budget;
  const refuse = (reason, options = {}) => {
    record.state = 'refused';
    record.reason = reason;
    record.ref = null;
    const recorded = writeLedger(platform, account.id, record);
    step(options.step || 'authorize', 'refused', `${reason}: ${REFUSAL_REASONS[reason]}`);
    step('record', 'complete', `${recorded.event} written to the append-only audit ledger.`);
    return refusal(record, reason, { ...options, recorded: recorded.durable, lifecycle });
  };

  // ---- propose: is this a declared action at all? ----
  if (proposal.coinField) {
    return refuse('self_award_refused', { detail: `The refused field is ${proposal.coinField}.`, step: 'propose' });
  }
  if (!proposal.spec) {
    const human = HUMAN_AUTHORITY_ACTIONS.includes(proposal.action.toLowerCase());
    return refuse(human ? 'human_authority_required' : 'unknown_action', { step: 'propose' });
  }
  const spec = proposal.spec;
  const work = spec.family === 'work';
  const permitted = declaration.permitted_actions.find((entry) => entry.action === proposal.action);
  for (const field of spec.texts) {
    const value = proposal.payload[field];
    if (value !== undefined && institutionalClaim(value)) return refuse('institutional_authority_claim', { detail: `The refused field is ${field}.`, step: 'propose' });
  }
  step('propose', 'complete', `${proposal.action} proposed for intent ${proposal.intent_id}${proposal.serves ? ` serving ${proposal.serves}` : ''}.`);

  // ---- authorization: the declaration decides, and the credential is re-read now ----
  if (declaration.defects.length) {
    const defect = declaration.defects[0];
    return refuse('declaration_defect', { detail: `${defect.id} in ${defect.field}: ${defect.note}`, previously_applied: null });
  }
  if (platform.get("SELECT value FROM settings WHERE key='paused'").value === 'true') return refuse('platform_paused');
  if (agent.kind !== 'agent') return refuse('runtime_credential_required');
  if (agent.status !== 'active') return refuse('resident_not_active', { detail: `The resident is ${agent.status}.` });
  const credential = platform.get("SELECT kind,scopes,max_calls,used_calls,expires_at,revoked FROM tokens WHERE hash=?", actor.credential.hash);
  if (!credential || credential.kind !== 'runtime') return refuse('credential_missing');
  if (credential.revoked) return refuse('credential_revoked', { detail: 'The credential row is revoked in the database. A restarted process revokes the credential of an interrupted run, so no step of it continues.' });
  if (credential.expires_at <= clock) return refuse('credential_expired');
  const scopes = new Set(parseList(credential.scopes));
  if (!scopes.has(spec.scope)) return refuse('scope_not_granted', { detail: `The ${proposal.action} action needs the ${spec.scope} scope; the credential carries ${[...scopes].join(', ') || 'no scopes'}.` });
  if (!permitted) return refuse('unknown_action', { detail: `The ${proposal.action} action is not in this resident’s declaration.`, step: 'authorize' });
  if (work) {
    if (!proposal.serves) return refuse('outside_declared_purpose', { detail: `A ${proposal.action} action is work: it must name which declared purpose target it serves, one of ${permitted.serves.join(', ') || 'nothing this calling names'}.` });
    if (!permitted.serves.includes(proposal.serves)) return refuse('outside_declared_purpose', { detail: `This ${declaration.calling.id} resident may not serve ${proposal.serves} with ${proposal.action}.` });
  } else if (proposal.serves && !declaration.purpose.targets.some((target) => target.id === proposal.serves)) {
    return refuse('outside_declared_purpose', { detail: `${proposal.serves} is not a declared purpose target of this resident.` });
  }
  if (credential.used_calls >= credential.max_calls) return refuse('budget_exhausted', { detail: `${credential.used_calls} of ${credential.max_calls} calls used.` });
  const key = declaredActionKey(agent.id, proposal.intent_id, proposal.action, proposal.serves, proposal.payload);
  record.key = key;
  step('authorize', 'complete', `Scope ${spec.scope} granted, ${credential.max_calls - credential.used_calls} of ${credential.max_calls} credential calls remaining.`);

  // ---- execute once: the durable ledger decides whether this intent has already been applied ----
  const seen = ledgerForIntent(platform, agent.id, proposal.intent_id);
  const applied = seen.find((row) => row.key === key && APPLIED_STATES.includes(row.state));
  const other = seen.find((row) => row.key !== key);
  if (other) {
    return refuse('intent_reused_for_other_work', { detail: `Intent ${proposal.intent_id} was already recorded for ${other.action} with a different body.`, step: 'execute' });
  }
  if (applied) {
    const saved = spec.verify(platform, { agent, actor, clock }, proposal.payload, null);
    applied.is_outcome = applied.state === 'executed';
    step('execute', 'skipped', `Ledger line ${applied.state} at ${applied.at} already records this intent and key; the world write is not repeated.`);
    step('verify', saved.verified ? 'complete' : 'incomplete', saved.note);
    step('record', 'complete', 'No new ledger line: the existing durable record stands.');
    return assertProposalNotOutcome({
      state: 'replayed', success: true, applied: true, executed: false, already_executed: true,
      action: proposal.action, serves: proposal.serves, intent_id: proposal.intent_id, key,
      lifecycle, saved, result: null, result_class: actionResultClass(proposal.action),
      proposal: Boolean(spec.proposal) || applied.state === 'proposed', achieved: false, real_world_outcome: null,
      recorded: { event: LEDGER_EVENTS[applied.state], record_id: applied.record_id || null, durable: true, at: applied.at },
      replay: { state: applied.state, at: applied.at, note: 'This intent was already applied and recorded. A retry reports the durable record instead of executing a second time.' },
      budget: declaration.budget, declaration: { calling_id: declaration.calling.id, state: declaration.identity.state },
    });
  }

  // The world write and its ledger line are one transaction: a savepoint isolates the write so a
  // refusal can still be recorded, and nothing is reported as done unless the saved row is read back
  // inside the same transaction that wrote it.
  let result, verified;
  platform.db.exec('SAVEPOINT resident_declared_action');
  try {
    result = spec.run(platform, actor, agent, proposal.payload);
    verified = spec.verify(platform, { agent, actor, clock }, proposal.payload, result);
  } catch (error) {
    rollback(platform);
    return refuse('world_refused', { detail: `The world refused the ${proposal.action} action.`, error: error?.message || 'The world refused this action.', http_status: Number.isInteger(error?.status) ? error.status : 409, step: 'execute' });
  }
  // A verification failure is the one step that must undo the write it cannot confirm. The write is
  // rolled back first, and the refusal is recorded on its own, so the ledger never claims an outcome
  // the saved rows cannot prove and the world never keeps an unproven write.
  if (!verified.verified) {
    rollback(platform);
    return refuse('verification_failed', { detail: verified.note, step: 'verify' });
  }
  platform.db.exec('RELEASE resident_declared_action');
  step('execute', 'complete', `The ${proposal.action} action was accepted by the world and its row is written in this transaction.`);
  step('verify', 'complete', verified.note);
  const state = spec.proposal ? 'proposed' : 'executed';
  record.state = state;
  record.ref = verified.ref || null;
  record.reason = null;
  const recorded = writeLedger(platform, account.id, record);
  step('record', 'complete', `${recorded.event} written to the append-only audit ledger.`);
  return assertProposalNotOutcome({
    state, success: true, applied: true, executed: state === 'executed',
    action: proposal.action, serves: proposal.serves, intent_id: proposal.intent_id, key,
    lifecycle, saved: verified, result, result_class: actionResultClass(proposal.action),
    proposal: Boolean(spec.proposal), achieved: false, real_world_outcome: null,
    recorded, replay: null,
    boundary: (actionResultClass(proposal.action)).note,
    budget: { ...declaration.budget, charged_calls: 1, remaining_after_charge: Math.max(0, declaration.budget.remaining_calls - 1) },
    declaration: { calling_id: declaration.calling.id, state: declaration.identity.state },
  });
}

// A verification failure is the one refusal that must undo the write it cannot confirm: the write is
// rolled back and the refusal is then recorded on its own, so the ledger never claims an outcome the
// saved rows cannot prove and the world never keeps an unproven write.
function refuseVerificationFailed(platform, account, record, verified, lifecycle) {
  record.state = 'refused'; record.reason = 'verification_failed'; record.ref = null;
  const recorded = writeLedger(platform, account.id, record);
  lifecycle.push({ step: 'verify', state: 'refused', detail: verified.note });
  lifecycle.push({ step: 'record', state: 'complete', detail: `${recorded.event} written to the append-only audit ledger.` });
  return {
    ...refusal(record, 'verification_failed', { detail: verified.note, recorded: true, lifecycle }),
    error: REFUSAL_REASONS.verification_failed,
  };
}

// ---- Platform methods ----------------------------------------------------------------------------

const PRIVATE_MATERIAL = Object.freeze({
  memory: 'The resident’s memory rows (its activity and lesson facts) and its pending proposals.',
  conversations: 'Its private and nearby conversations and any message it authored or received privately.',
  vault: 'The contents of its private vault, including note text and ciphertext.',
  drafts: 'Its private saved drafts.',
});
export const PRIVACY_EXCLUSIONS = Object.freeze(Object.keys(PRIVATE_MATERIAL));

function declarationAgent(platform, actor, id) {
  if (!id || typeof id !== 'string') fail(400, 'Name one resident.');
  const agent = platform.get('SELECT * FROM agents WHERE id=?', id);
  if (!agent || agent.kind !== 'agent' || agent.status === 'deleted') fail(404, 'Resident not found.');
  if (actor.kind === 'runtime') {
    if (actor.agent?.id !== agent.id) fail(404, 'Resident not found.');
    return { agent, relationship: 'self' };
  }
  if (actor.kind !== 'session') fail(403, 'A resident runtime credential or a signed-in operator is required.');
  if (agent.operator_id === actor.account.id) return { agent, relationship: 'owner' };
  if (['admin', 'moderator'].includes(actor.account.role)) return { agent, relationship: 'moderation' };
  fail(404, 'Resident not found.');
}

function controlsView(platform, agent, relationship, role, declaration) {
  const owner = relationship === 'owner';
  const moderator = ['admin', 'moderator'].includes(role);
  const control = (name, available, route, refused, note, body) => ({ control: name, available, route, ...(body ? { body } : {}), refused: available ? null : refused, note });
  const usable = declaration.may_act;
  return {
    controls: [
      control('pause', owner && agent.status === 'active', 'POST /api/v1/agents/control', agent.status === 'active' ? (owner ? 'Only this resident’s own operator can pause it.' : 'A moderator sanctions through an open report (POST /api/v1/moderation); there is no direct pause for another operator’s resident.') : `The resident is already ${agent.status}.`, 'Pausing sets the resident’s status and revokes every runtime credential it holds. An interrupted run cannot continue past it.', { agent_id: agent.id, status: 'paused' }),
      control('resume', owner && ['paused', 'revoked'].includes(agent.status), 'POST /api/v1/agents/control', ['paused', 'revoked'].includes(agent.status) ? 'Only this resident’s own operator can resume it.' : 'The resident is not paused or revoked.', 'Resuming returns the resident to active. A new runtime credential must still be issued before it can act again; an old revoked credential stays revoked.', { agent_id: agent.id, status: 'active' }),
      control('revoke', owner && !['revoked', 'suspended'].includes(agent.status), 'POST /api/v1/agents/control', ['revoked', 'suspended'].includes(agent.status) ? `The resident is already ${agent.status}.` : 'Only this resident’s own operator can revoke it.', 'Revoking sets the status and revokes the runtime credential. The world’s history is untouched; a resume is a separate operator decision.', { agent_id: agent.id, status: 'revoked' }),
      control('suspend', moderator && agent.status !== 'suspended', 'POST /api/v1/moderation', agent.status === 'suspended' ? 'The resident is already suspended.' : 'A moderator sanctions through an open report and must be uninvolved in it; there is no direct moderator pause.', 'Suspending is a moderation decision taken on an open report. Only a moderator can lift it, through an appeal.', null),
      control('lift-suspension', moderator && agent.status === 'suspended', 'POST /api/v1/appeals/decide', agent.status === 'suspended' ? 'A moderator or administrator must decide the appeal.' : 'The resident is not suspended.', 'An overturned appeal returns the resident to paused, and its own operator decides whether to resume it.', null),
      control('act', usable, 'POST /api/v1/residents/act', usable ? 'The resident has no available declared action.' : declaration.may_act_reason, 'One declared action per intent id, executed once, with the saved result verified before it is reported.', null),
    ],
    roles: {
      you: { account: null, role, relationship },
      operator: { owner_of_resident: owner, can_pause: owner, can_resume: owner, can_revoke: owner, can_issue_credential: owner },
      moderator: { may_sanction: moderator, route: 'POST /api/v1/moderation', note: 'A moderator acts on an open report against this resident, and never reads its private memory, conversations or vault.' },
    },
  };
}

/**
 * The operator- and moderator-facing declaration surface: the declaration, the budget, the current
 * purpose, the declared action history and every refusal reason — and nothing private. Private memory,
 * private conversations and vault contents are refused by name rather than quietly omitted, so the
 * caller can tell an exclusion from an absence.
 */
function declarationSurface(platform, actor, input = {}) {
  const { agent, relationship } = declarationAgent(platform, actor, input.agent_id || actor.agent?.id);
  const include = typeof input.include === 'string' && input.include.trim() ? input.include.split(',').map((value) => value.trim()).filter(Boolean) : ['declaration', 'history'];
  const unknown = include.filter((value) => !['declaration', 'history'].includes(value));
  if (unknown.length) {
    const private_asked = unknown.filter((value) => PRIVACY_EXCLUSIONS.includes(value));
    const status = private_asked.length ? 403 : 400;
    return {
      refused: true, http_status: status, include: unknown,
      error: private_asked.length
        ? `This surface never exposes ${private_asked.join(', ')}. Those records stay with the resident: private memory is the operator’s own decided record, private conversations are the parties’ own, and a vault note is readable only with the resident’s own credential.`
        : `Choose declaration, history or both. Asked for: ${unknown.join(', ')}.`,
      private_refusals: private_asked.map((value) => ({ material: value, note: PRIVATE_MATERIAL[value], where_it_stays: value === 'memory' ? 'GET /api/v1/memory (the owning operator)' : value === 'conversations' ? 'the conversation’s own participants' : value === 'vault' ? 'GET /api/v1/vault/notes (needs the resident’s own vault-scoped credential)' : 'GET /api/v1/drafts (the owning operator)' })),
    };
  }
  const declaration = declarationCore(platform, agent, {});
  const history = include.includes('history') ? actionHistory(platform, agent.id, { limit: 50 }) : null;
  const runs = platform.all('SELECT id,status,phase,interrupted,stop_reason,decision_budget,model_calls,action_count,failed_calls,failed_actions,started_at,updated_at FROM resident_runs WHERE agent_id=? ORDER BY started_at DESC,id DESC LIMIT 10', agent.id)
    .map((run) => ({ run_id: run.id, status: run.status, phase: run.phase, interrupted: run.interrupted || null, stop_reason: run.stop_reason || null, decisions: run.model_calls, decision_budget: run.decision_budget, actions: run.action_count, refused_actions: run.failed_actions, failed_calls: run.failed_calls, started_at: run.started_at, updated_at: run.updated_at }));
  const controls = controlsView(platform, agent, relationship, actor.kind === 'session' ? actor.account.role : 'runtime', declaration);
  return {
    format: RESIDENT_DECLARATION_FORMAT, generated_at: now(platform),
    viewer: { kind: actor.kind, role: actor.kind === 'session' ? actor.account.role : 'runtime', relationship },
    declaration,
    controls: controls.controls,
    roles: controls.roles,
    runs,
    action_history: history,
    privacy: {
      exposed: ['the declaration', 'the credential budget and its scopes', 'the current purpose and calling', 'the declared action history', 'every refusal reason', 'the bounded run records'],
      excluded: PRIVACY_EXCLUSIONS.map((material) => ({ material, note: PRIVATE_MATERIAL[material] })),
      rule: 'Inspection is a description of what the resident is permitted and recorded to do. It is never a reading of what the resident holds privately.',
    },
  };
}

/** The resident’s own core declaration, carried inside the private read it already makes. */
function runtimeDeclaration(platform, agentId) {
  const agent = platform.get('SELECT * FROM agents WHERE id=?', agentId);
  if (!agent) return null;
  return declarationCore(platform, agent, {});
}

export const residentFrameworkMethods = {
  /** GET /api/v1/residents/declaration — the operator and moderator inspection surface. */
  residentDeclaration(actor, input = {}) { return declarationSurface(this, actor, input); },
  /** The derived declaration alone, for the runtime’s own private read. */
  residentOwnDeclaration(actor) {
    if (actor?.kind !== 'runtime' || actor.agent?.kind !== 'agent') fail(403, 'A resident runtime credential is required.');
    return runtimeDeclaration(this, actor.agent.id);
  },
  /** The declared action history of one resident, for the operator who owns it. */
  residentActions(actor, input = {}) {
    const { agent } = declarationAgent(this, actor, input.agent_id || actor.agent?.id);
    return actionHistory(this, agent.id, { limit: Number(input.limit) || LEDGER_PAGE });
  },
  /** POST /api/v1/residents/act — one declared action, executed exactly once. */
  residentAct(actor, input = {}, idempotencyKey) {
    if (actor?.kind !== 'runtime' || actor.agent?.kind !== 'agent') {
      fail(403, 'A declared action requires a resident runtime credential; a human operator session cannot act for a resident.');
    }
    return declaredAction(this, actor, input, idempotencyKey);
  },
  /** Whether this resident’s declaration still holds. `false` blocks every declared action. */
  declarationIntact(agentId) {
    const agent = this.get('SELECT * FROM agents WHERE id=?', agentId);
    return agent ? declarationCore(this, agent, {}).defects.length === 0 : false;
  },
};

export { declarationSurface, runtimeDeclaration, declaredAction, budgetView, liveCredential, PRIVATE_MATERIAL };


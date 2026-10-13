import { getWorldDefinition } from '../world.js';
import { CALLINGS } from './vocations.js';
import { AMBASSADOR_REMIT } from './civic.js';
import { COUNTRIES, ambassadorIdentity } from './civic-engine.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// ---------------------------------------------------------------------------------------------
// The first ten minutes: one derived read, nothing written.
//
// The guide answers a single question — what should this player do next — and it answers it only from
// rows the world already saved. There is no new table, no new column, no schema bump, no new currency
// and no new route authority here: every `done` state is re-derived on each read from a stored fact (an
// `agents` row, a `calling.selected` audit row, a saved conversation sent by this resident, a
// `calling_receipts` row, or counted contributions by two operators). Because it writes nothing, it audits
// nothing, and it deliberately does **not** call `this.active()`: it answers while the world is paused,
// which is exactly when a returning player needs to be told where they left off. A repeated request, a
// refresh or a second browser therefore cannot advance a step.
//
// The one step that could be faked is the calling step, and it is deliberately read from `audit`
// (`event='calling.selected'`), not from `resident_callings`: `initVocations` inserts a default
// `explorer` row for every resident, so a selection table cannot tell a chosen calling from a defaulted
// one. The saved audit row can.
//
// What this module never does: it grants no role, calling, land, coin, review or action scope; it
// issues no NemoCoin (the guide coins_awarded is always 0); it writes no `coin_rewards`; it never marks
// a step from anything a client, a model or a repeated request says; and it never invents an action
// route — every route it publishes is one `server.js` already serves. A nearby resident is always
// described by an honest, server-authored statement: a country ambassador by its authored civic
// identity and reserved remit, an operated resident by its own calling and the limits its operator
// wrote, plus one shared list of what such a resident cannot do.
//
// Refusals it can report: world_paused (the read still answers), resident_unavailable (the resident is
// paused, revoked or absent), and garden_private. The read itself refuses only unknown input keys (400)
// and a runtime credential that names somebody else's resident (403).
// ---------------------------------------------------------------------------------------------

// The nearby radius is the client's own resident radius (src/ui/interaction-prompt.js RESIDENT_NEARBY).
// The server states the same number here so the two never disagree.
const ENCOUNTER_RADIUS = 6;
const ALLOWED_INPUT = new Set(['agent_id', 'world_id']);

const action = (id, label, route, scope, body, requiresInput = false) => ({ id, label, route, method: 'POST', scope: scope ?? null, body, requires_input: requiresInput, ship_route: true });
const worldName = (id) => { try { return getWorldDefinition(id).name; } catch { return id; } };
const worldStart = (id) => { try { return getWorldDefinition(id).start; } catch { return { x: 0, y: 0 }; } };

export const FIRST_PLAY_STEPS = Object.freeze([
  Object.freeze({
    id: 'enter', ordinal: 1, title: 'Enter the world as a character',
    instruction: 'Create a character, then step into the world with it.',
    reason: 'Progress is carried by a resident, not by your account alone.',
    alternative: 'A visitor may look around before signing in; the guide waits.',
    evidence: Object.freeze({ source: 'agents', label: 'a saved agents row you operate' }),
  }),
  Object.freeze({
    id: 'calling', ordinal: 2, title: 'Choose a calling',
    instruction: 'Open Callings and choose one calling for this resident.',
    reason: 'A calling names the bounded work this resident follows.',
    alternative: 'Explore the world first; choose a calling whenever you are ready.',
    evidence: Object.freeze({ source: 'audit', label: 'a calling.selected audit row for this resident' }),
  }),
  Object.freeze({
    id: 'meet', ordinal: 3, title: 'Meet a resident and read its limits',
    instruction: 'Walk near another operator’s AI resident or a scripted country ambassador, read its limits, then write your own message or question.',
    reason: 'A saved in-world conversation shows who this character actually met. A country ambassador follows published rules; it is not a live AI resident.',
    alternative: 'If no other operator’s AI resident is present, travel to a country venue and meet its scripted ambassador.',
    evidence: Object.freeze({ source: 'audit/messages', label: 'a saved nearby AI message or distance-checked conversation attributed to this character' }),
  }),
  Object.freeze({
    id: 'practice', ordinal: 4, title: 'Do one nearby saved action',
    instruction: 'Do one counted action near you, such as planting a crop in your own garden.',
    reason: 'One saved action shows how this world records real work.',
    alternative: 'Any counted action works; the nearest one is only a suggestion.',
    evidence: Object.freeze({ source: 'calling_receipts', label: 'a calling receipt earned by this resident' }),
  }),
  Object.freeze({
    id: 'restore', ordinal: 5, title: 'Complete one saved restoration step with another resident',
    instruction: 'Join a shared restoration another operator takes part in, then record one saved step.',
    reason: 'Shared work counts only from saved rows, never from a promise.',
    alternative: 'Read the shared garden’s saved steps first; join when its keepers open a window.',
    evidence: Object.freeze({ source: 'restoration census', label: 'counted saved contributions by this resident and another operator’s resident in the same restoration' }),
  }),
]);

export const FIRST_PLAY_POLICY = Object.freeze({
  version: 1,
  steps: FIRST_PLAY_STEPS.length,
  coins_awarded: 0,
  client_completion: false,
  progress: 'Every done state is derived from saved server rows — a character, its calling selection, a server-checked nearby conversation, a calling receipt, or counted restoration work by two operators — so nothing a client, a model or a repeated request says can complete a step.',
  encounter: 'A nearby resident (within six tiles) is described by a server-authored honest statement. Another operator’s AI resident is preferred. The solo fallback is a scripted country ambassador that follows published rules and is not a live AI. Neither can represent an institution or act outside its checked limits.',
  resume: 'Place, character, camera and purpose are restored from saved rows — the resident’s own world_id and x/y/z, its calling and its journey purpose — alongside the camera preference the client keeps in its own browser storage, so a returning player stands exactly where the world last left them.',
});

// The one shared, server-authored list of what a nearby resident cannot do. A country ambassador and an
// operated resident answer with the same bounds, so neither is presented as an authority.
export const FIRST_PLAY_ENCOUNTER_CANNOT = Object.freeze([
  'Take any action this world does not already check and record.',
  'Approve, sanction, endorse, block or review a contribution.',
  'Contact, fund or commit a person, a state or an institution.',
  'Grant a role, a calling, land, a coin or action authority.',
  'Speak for anyone but itself — there is no person or institution behind this resident beyond its own bounded program.',
]);

// The reservation a country ambassador always adds to its authored identity sentence.
const ENCOUNTER_RESERVATION = 'It answers only from the registered country context and its numbered sources, only for its own catalog entry, and it can never approve, sanction, endorse, contact, fund or commit anything on behalf of a state, an institution or a buyer.';

// Where each part of the resumed view comes from, so the client can say so plainly.
export const FIRST_PLAY_RESUME_SOURCES = Object.freeze([
  Object.freeze({ id: 'place', label: 'World and tile', source: 'agents.world_id, agents.x/y/z' }),
  Object.freeze({ id: 'character', label: 'Character and calling', source: 'agents row and resident_callings.calling_id' }),
  Object.freeze({ id: 'purpose', label: 'Chosen purpose', source: 'journey_profiles.purpose' }),
  Object.freeze({ id: 'camera', label: 'Camera preference', source: 'this browser (localStorage)' }),
]);

// The bounded vocabulary of refusals this read can report. `blocked` names the one in force right now.
export const FIRST_PLAY_REFUSALS = Object.freeze([
  Object.freeze({ code: 'world_paused', message: 'The world is paused by an administrator.', next_step: 'The guide still reads saved rows while the world is paused; actions resume when an administrator unpauses the world.' }),
  Object.freeze({ code: 'resident_unavailable', message: 'This resident is paused, revoked or in another world.', next_step: 'Resume the resident in My characters and bring it into the world, then act again.' }),
  Object.freeze({ code: 'garden_private', message: 'This garden is open only to its operator.', next_step: 'Ask the garden’s operator to open it to visitors, or work in your own garden.' }),
]);

// Nearby recipients were chosen by the server within three tiles at send time. Private messages
// may cross worlds, so only the server's distance-checked audit proof can make one an encounter.
// The same proof binds a scripted ambassador conversation to the actual character standing nearby.
// Incoming text, broadcasts, a sibling character and ordinary account-level research chats do not.
const MEET_NEARBY_SQL = `SELECT 1 FROM messages m JOIN json_each(m.recipients) r JOIN agents other ON other.id=r.value
  WHERE m.agent_id=? AND m.account_id=? AND m.status='visible' AND m.channel='nearby'
  AND other.kind='agent' AND other.operator_id!=? LIMIT 1`;
const MEET_AUDIT_SQL = "SELECT seq FROM audit WHERE actor=? AND event IN ('firstplay.resident_met','firstplay.ambassador_met') AND substr(record_id,1,?)=? LIMIT 1";

/** The nearest visible resident to `viewer` inside `worldId`, or the first active country ambassador. */
function nearestResident(platform, worldId, viewer) {
  const ambassadors = platform.all("SELECT id,name,iso3,x,y FROM npc_ambassadors WHERE world_id=? AND status='active'", worldId)
    .map((row) => ({ kind: 'npc', source: 'npc_ambassadors', id: row.id, name: row.name, x: row.x, y: row.y, row }));
  if (!viewer) return ambassadors[0] || null;
  const residents = platform.all("SELECT a.id,a.name,a.kind,a.capabilities,a.limitations,a.x,a.y FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.world_id=? AND a.status='active' AND a.kind='agent' AND a.operator_id!=? AND o.status='active'", worldId, viewer.operator_id)
    .map((row) => ({ kind: 'agent', source: 'agents', id: row.id, name: row.name, x: row.x, y: row.y, row }));
  return [...ambassadors, ...residents]
    .map((candidate) => ({ ...candidate, distance: Math.abs(viewer.x - candidate.x) + Math.abs(viewer.y - candidate.y) }))
    .filter((candidate) => candidate.distance <= ENCOUNTER_RADIUS)
    .sort((left, right) => (left.kind === 'agent' ? 0 : 1) - (right.kind === 'agent' ? 0 : 1) || left.distance - right.distance || String(left.id).localeCompare(String(right.id)))[0] || null;
}

/** A deterministic existing scripted fallback, with a usable public venue. */
function starterAmbassador(platform) {
  return platform.get("SELECT a.id,a.name,a.iso3,a.world_id,a.x,a.y,w.name AS world_name FROM npc_ambassadors a JOIN worlds w ON w.id=a.world_id WHERE a.status='active' AND w.visibility='public' ORDER BY CASE WHEN a.iso3='NPL' THEN 0 ELSE 1 END,a.name LIMIT 1");
}

const callingFor = (platform, agentId) => {
  const id = platform.get('SELECT calling_id FROM resident_callings WHERE agent_id=?', agentId)?.calling_id || 'explorer';
  return CALLINGS.find((calling) => calling.id === id) || null;
};

/** The honest statement and bounds for one nearby candidate. Every field is authored on the server. */
function encounterFrom(platform, candidate, viewer, actor) {
  const canConverse = actor?.kind === 'session' && viewer?.status === 'active';
  if (candidate.kind === 'npc') {
    const country = COUNTRIES.entries.find((entry) => entry.iso3 === candidate.row.iso3) || { name: candidate.name };
    return {
      kind: 'npc', source: 'npc_ambassadors', agent_id: null, npc_id: candidate.id, name: candidate.name,
      role_label: 'Country ambassador', calling: null,
      honest_statement: `${ambassadorIdentity(country)} ${ENCOUNTER_RESERVATION}`,
      limitations: AMBASSADOR_REMIT.limits, capabilities: AMBASSADOR_REMIT.scope,
      cannot: [...FIRST_PLAY_ENCOUNTER_CANNOT], scripted: true, distance: candidate.distance ?? null,
      actions: canConverse ? [action('ask', `Ask ${candidate.name} a question`, '/ambassadors/talk', null, { ambassador_id: candidate.id, agent_id: viewer.id }, true)] : [],
    };
  }
  const calling = callingFor(platform, candidate.id);
  return {
    kind: 'agent', source: 'agents', agent_id: candidate.id, npc_id: null, name: candidate.name,
    role_label: calling ? calling.name : 'Resident',
    calling: calling ? { id: calling.id, name: calling.name, purpose: calling.purpose } : null,
    honest_statement: `I’m ${candidate.name}, an AI resident operated by another person, following the ${calling ? calling.name : 'explorer'} calling. I am a bounded program: I act only through the actions this world checks and records, I hold no account of my own, and I represent no company, institution, government or person beyond my operator.`,
    limitations: candidate.row.limitations, capabilities: candidate.row.capabilities,
    cannot: [...FIRST_PLAY_ENCOUNTER_CANNOT], scripted: false, distance: candidate.distance ?? null,
    actions: canConverse ? [action('meet', `Message ${candidate.name}`, '/messages', 'chat', { agent_id: viewer.id, channel: 'private', recipient_id: candidate.id }, true)] : [],
  };
}

/** The `next_step.target` for `practice`: the nearest owned crop patch, else a real place, else land. */
function practiceTargetFor(platform, viewer, world) {
  const home = `home:${viewer.id}`;
  const patches = platform.all("SELECT id,x,y FROM world_objects WHERE world_id=? AND type='farm' ORDER BY y,x", home);
  if (patches.length) {
    const inHome = viewer.world_id === home;
    const ordered = inHome ? [...patches].sort((a, b) => (Math.abs(viewer.x - a.x) + Math.abs(viewer.y - a.y)) - (Math.abs(viewer.x - b.x) + Math.abs(viewer.y - b.y)) || a.y - b.y || a.x - b.x) : patches;
    const patch = ordered[0];
    return { kind: 'crop_patch', label: 'Your garden crop patch', world_id: home, world_name: worldName(home), x: patch.x, y: patch.y, z: 0, distance: inHome ? Math.abs(viewer.x - patch.x) + Math.abs(viewer.y - patch.y) : null, route: '/interact' };
  }
  const place = platform.all("SELECT w.id,w.name FROM worlds w WHERE w.owner_agent_id IS NULL AND w.visibility='public' AND w.id!='commons' AND NOT EXISTS(SELECT 1 FROM journey_visits v WHERE v.agent_id=? AND v.world_id=w.id) ORDER BY w.id LIMIT 6", viewer.id)[0];
  if (place) { const start = worldStart(place.id); return { kind: 'place', label: place.name, world_id: place.id, world_name: place.name, x: start.x, y: start.y, z: 0, distance: null, route: null }; }
  const land = platform.get('SELECT p.world_id,p.x,p.y FROM land_stewardships s JOIN land_parcels p ON p.id=s.plot_id WHERE s.account_id=?', viewer.operator_id);
  if (land && land.world_id === viewer.world_id) return { kind: 'land', label: 'Your stewarded plot', world_id: land.world_id, world_name: worldName(land.world_id), x: land.x, y: land.y, z: 0, distance: Math.abs(viewer.x - land.x) + Math.abs(viewer.y - land.y), route: null };
  const start = worldStart(viewer.world_id);
  return { kind: 'place', label: world.name, world_id: viewer.world_id, world_name: world.name, x: start.x, y: start.y, z: 0, distance: Math.abs(viewer.x - start.x) + Math.abs(viewer.y - start.y), route: null };
}

/** Suggest only a restoration route the resident can use in its present saved state. */
function restoreTargetFor(platform, eventView, viewer) {
  if (!eventView) return {
    target: { kind: 'restoration', label: 'No restoration has been opened', world_id: viewer.world_id, world_name: worldName(viewer.world_id), x: null, y: null, z: null, distance: null, route: null },
    instruction: 'A human operator must open a public garden restoration before residents can join it.', action: null,
  };
  const site = eventView.site, next = eventView.viewer?.next_action;
  const start = worldStart(site.world_id), slot = eventView.progress.steps.find((item) => item.id === next?.step_id)?.next_slot;
  const point = slot || start;
  const target = { kind: 'restoration', label: `Restoration: ${site.name}`, world_id: site.world_id, world_name: site.name,
    x: point.x, y: point.y, z: 0, distance: viewer.world_id === site.world_id ? Math.abs(viewer.x - point.x) + Math.abs(viewer.y - point.y) : null, route: null };
  if (eventView.phase !== 'open') return { target, action: null, instruction: `This restoration is ${eventView.phase}. Its saved work remains; wait for its keeper to open a new window.` };
  if (!site.open_to_visitors) return { target, action: null, blocked: { ...FIRST_PLAY_REFUSALS[2] }, instruction: 'The garden must be public before another resident can join its restoration.' };
  if (!eventView.viewer?.joined) {
    if (eventView.participants_count >= eventView.capacity) return { target, action: null, instruction: 'Every place in this restoration is taken. Find another open garden or wait for a place to open.' };
    if (viewer.world_id !== site.world_id) return {
      target: { ...target, x: start.x, y: start.y, distance: null, route: `/agents/${viewer.id}/travel` },
      action: action('visit-garden', `Enter ${site.name}`, `/agents/${viewer.id}/travel`, 'move', { world_id: site.world_id }),
      instruction: 'Enter the public garden as this character. The server records the visit required before joining.',
    };
    const visit = platform.get('SELECT visited_at FROM journey_visits WHERE agent_id=? AND world_id=?', viewer.id, site.world_id);
    if (!visit) return { target, action: null, instruction: 'This character is in the garden without a recorded visit. Leave and re-enter through travel so the server can record the visit, then pledge.' };
    return { target: { ...target, route: '/restoration/join' },
      action: action('join-restoration', 'Pledge to help in this garden', '/restoration/join', 'contribute', { agent_id: viewer.id, event_id: eventView.id }),
      instruction: 'Pledge to participate. A pledge is a promise; it does not count as restoration work.' };
  }
  if (!next) return { target, action: null, instruction: 'No unfinished step matches this character’s calling. Read the saved steps or choose a calling that answers one remaining step.' };
  const viewerStep = eventView.viewer.steps.find((item) => item.step_id === next.step_id);
  if (viewerStep?.my_counted > 0) return { target, action: null, instruction: `Your ${next.title.toLowerCase()} work is saved. A different operator must record a counted step before this shared journey completes.` };
  if (next.step_id === 'beds') {
    const ownWorld = `home:${viewer.id}`;
    if (viewer.world_id !== ownWorld) return {
      target: { ...target, label: 'Your garden crop patch', world_id: ownWorld, world_name: worldName(ownWorld), x: worldStart(ownWorld).x, y: worldStart(ownWorld).y, distance: null, route: `/agents/${viewer.id}/travel` },
      action: action('visit-own-garden', 'Go to your garden to sow', `/agents/${viewer.id}/travel`, 'move', { world_id: ownWorld }),
      instruction: 'Sow a crop in your own garden after joining this restoration. The saved sowing counts for the shared beds.',
    };
    const patches = platform.all("SELECT o.x,o.y FROM world_objects o LEFT JOIN journey_crops c ON c.agent_id=? AND c.x=o.x AND c.y=o.y AND c.harvested_at IS NULL WHERE o.world_id=? AND o.type='farm' AND c.agent_id IS NULL ORDER BY ABS(o.x-?)+ABS(o.y-?),o.y,o.x LIMIT 1", viewer.id, ownWorld, viewer.x, viewer.y);
    const patch = patches[0];
    if (!patch) return { target: { ...target, label: 'Your garden crop patch', world_id: ownWorld, world_name: worldName(ownWorld), x: null, y: null, distance: null }, action: null, instruction: 'Place a crop patch in your own garden, or harvest a crop already growing there, before sowing for the shared beds.' };
    const distance = Math.abs(viewer.x - patch.x) + Math.abs(viewer.y - patch.y);
    const farmTarget = { ...target, kind: 'crop_patch', label: 'Your empty crop patch', world_id: ownWorld, world_name: worldName(ownWorld), x: patch.x, y: patch.y, distance };
    if (platform.get('SELECT COUNT(*) AS n FROM journey_crops WHERE agent_id=? AND harvested_at IS NULL', viewer.id).n >= 20) return { target: farmTarget, action: null, instruction: 'Your garden has twenty growing crops. Harvest one before sowing another for the shared beds.' };
    if (distance > 1) return { target: farmTarget, action: null, instruction: `Walk beside your empty crop patch at ${patch.x}, ${patch.y}, then plant it for the shared beds.` };
    return { target: { ...farmTarget, route: '/journey/garden' },
      action: action('sow-for-restoration', 'Plant herbs on this crop patch', '/journey/garden', 'build', { agent_id: viewer.id, action: 'plant', kind: 'herbs', x: patch.x, y: patch.y }),
      instruction: 'Plant a real herb crop on this patch. The saved sowing inside the window counts for the shared beds.' };
  }
  if (next.step_id !== 'ground') return { target, action: null,
    instruction: `${next.action.label} That fact must be saved inside this restoration window before it can count; a pledge or a client claim cannot replace it.` };
  if (viewer.world_id !== site.world_id) return {
    target: { ...target, x: start.x, y: start.y, distance: null, route: `/agents/${viewer.id}/travel` },
    action: action('return-to-restoration', `Return to ${site.name}`, `/agents/${viewer.id}/travel`, 'move', { world_id: site.world_id }),
    instruction: 'Return to the restoration garden before placing one of its planned objects.',
  };
  if (!slot) return { target, action: null, instruction: 'The gathering ground has no unfilled planned tile. Read the remaining saved steps.' };
  if (target.distance > 1) return { target, action: null, instruction: `Walk beside the ${slot.type} tile at ${slot.x}, ${slot.y}; placement is available within one tile.` };
  const occupying = platform.get('SELECT type FROM world_objects WHERE world_id=? AND x=? AND y=?', site.world_id, slot.x, slot.y);
  if (occupying) return { target, action: null, instruction: `A ${occupying.type} occupies the planned ${slot.type} tile. A garden keeper must clear that tile before placement can count.` };
  return { target: { ...target, route: '/restoration/place' },
    action: action('place-object', `Place ${slot.type} at ${slot.x}, ${slot.y}`, '/restoration/place', 'build', { agent_id: viewer.id, event_id: eventView.id, x: slot.x, y: slot.y }),
    instruction: `Place the planned ${slot.type} at ${slot.x}, ${slot.y}. The server checks this exact tile and saves the object.` };
}

/** The shared-restoration block, mapped from one `restorationEventView` read. No census is re-run. */
function restorationBlockFor(eventView, accountId, operators) {
  if (!eventView) return null;
  const nextSlot = (stepId) => { const step = eventView.progress.steps.find((item) => item.id === stepId); return step?.next_slot ? { x: step.next_slot.x, y: step.next_slot.y, type: step.next_slot.type } : null; };
  const viewer = eventView.viewer ? {
    joined: eventView.viewer.joined,
    my_counted_by_step: Object.fromEntries(eventView.viewer.steps.filter((step) => step.my_counted > 0).map((step) => [step.step_id, step.my_counted])),
    steps: eventView.viewer.steps.map((step) => ({ step_id: step.step_id, title: step.title, eligible: step.eligible, complete: step.complete, progress: step.progress, target: step.target, my_counted: step.my_counted })),
    next_action: eventView.viewer.next_action ? { step_id: eventView.viewer.next_action.step_id, title: eventView.viewer.next_action.title, role: eventView.viewer.next_action.role, action: { kind: eventView.viewer.next_action.action.kind, label: eventView.viewer.next_action.action.label, saved_fact: eventView.viewer.next_action.action.saved_fact }, target: nextSlot(eventView.viewer.next_action.step_id), out_of_window: eventView.viewer.next_action.out_of_window } : null,
  } : null;
  return {
    event_id: eventView.id, site_name: eventView.site.name, world_id: eventView.site.world_id, phase: eventView.phase,
    steps_completed: eventView.progress.steps_completed, steps_total: eventView.progress.steps_total, viewer,
    actors: eventView.participants.map((participant) => ({
      name: participant.name, agent_id: participant.agent_id, kind: participant.kind,
      operator_distinct: Boolean(accountId) && operators.get(participant.agent_id) !== accountId,
      contributions: participant.contributions.map((contribution) => ({ step_id: contribution.step_id, counted: contribution.counted, standing: contribution.standing })),
      promise: { code: 'pledge', label: participant.promise.label, counted_as_work: false },
    })),
    remaining: eventView.progress.steps.filter((step) => !step.complete).map((step) => ({ step_id: step.id, title: step.title, progress: step.progress, target: step.target })),
  };
}

/** The refusal that stops a saved place from being resumed: a paused or revoked resident, or none. */
function resumeRefusal(viewer) {
  if (viewer.status === 'revoked') return { code: 'resident_unavailable', message: `${viewer.name}’s access is revoked.`, recover: 'An operator must resume the resident before it returns to the world; its saved place is unchanged.', next_step: 'Open My characters and resume this resident.' };
  if (viewer.status !== 'active') return { code: 'resident_unavailable', message: `${viewer.name} is ${viewer.status}.`, recover: 'The saved place is unchanged; resume the resident to stand there again.', next_step: 'Resume the resident in My Characters.' };
  return null;
}

/** The one next step: its target, its single shipped action, and the refusal in force, if any. */
function nextStepFor(id, ctx) {
  const step = FIRST_PLAY_STEPS.find((item) => item.id === id);
  const viewer = ctx.viewer;
  const worldOf = viewer ? viewer.world_id : ctx.worldId;
  const worldNameOf = viewer ? ctx.viewerWorldName : ctx.world.name;
  const base = { id: step.id, ordinal: step.ordinal, title: step.title, instruction: step.instruction, reason: step.reason, dismissible: true, target: null, actions: [], alternative: step.alternative, blocked: ctx.blocked };
  if (id === 'enter') base.target = { kind: 'character', label: 'Your characters', world_id: worldOf, world_name: worldNameOf, x: null, y: null, z: null, distance: null, route: '/agents' };
  else if (id === 'calling') base.target = { kind: 'calling', label: 'Choose a calling', world_id: worldOf, world_name: worldNameOf, x: null, y: null, z: null, distance: null, route: '/callings/select' };
  else if (id === 'meet') {
    const candidate = ctx.candidate;
    if (!candidate) {
      const venue = ctx.venueAmbassador, starter = ctx.starterAmbassador;
      if (venue) {
        base.target = { kind: 'resident', label: `${venue.name} (scripted country ambassador)`, world_id: worldOf, world_name: worldNameOf,
          x: venue.x, y: venue.y, z: 0, distance: Math.abs(viewer.x - venue.x) + Math.abs(viewer.y - venue.y), route: null };
        base.instruction = `Walk within six tiles of ${venue.name} to read its limits and ask a question. This ambassador is scripted, not a live AI resident.`;
      } else if (starter) {
        const inCommons = viewer.world_id === 'commons';
        if (inCommons) {
          const start = worldStart(starter.world_id);
          base.target = { kind: 'country', label: `${starter.world_name} (scripted ambassador)`, world_id: starter.world_id, world_name: starter.world_name,
            x: start.x, y: start.y, z: 0, distance: null, route: `/agents/${viewer.id}/travel` };
          base.instruction = 'No other operator’s AI resident is nearby. Enter this public country venue to meet its scripted ambassador; a live AI reply is not promised.';
          if (ctx.actor?.kind === 'session' && viewer.status === 'active') base.actions = [action('visit-ambassador', `Enter ${starter.world_name}`, `/agents/${viewer.id}/travel`, 'move', { world_id: starter.world_id })];
        } else {
          const exit = getWorldDefinition(viewer.world_id).portals?.find((portal) => (portal.targetWorldId || portal.target_world_id) === 'commons');
          const exitDistance = exit ? Math.abs(viewer.x - exit.x) + Math.abs(viewer.y - exit.y) : null;
          const canTravel = viewer.world_id.startsWith('home:') || exitDistance !== null && exitDistance <= 1;
          base.target = { kind: 'door', label: 'Return to the Commons directory', world_id: viewer.world_id, world_name: worldNameOf,
            x: exit?.x ?? null, y: exit?.y ?? null, z: 0, distance: exitDistance, route: canTravel ? `/agents/${viewer.id}/travel` : null };
          base.instruction = exit ? 'Return to the Commons, then enter a public country venue for its scripted ambassador. Walk beside the exit before travelling.'
            : 'Follow the connected passages back to the Commons, then enter a public country venue for its scripted ambassador.';
          if (canTravel && ctx.actor?.kind === 'session' && viewer.status === 'active') base.actions = [action('return-to-commons', 'Return to the Commons', `/agents/${viewer.id}/travel`, 'move', { world_id: 'commons' })];
        }
      } else {
        base.target = { kind: 'none', label: 'No active resident or country ambassador is available', world_id: worldOf, world_name: worldNameOf, x: null, y: null, z: null, distance: null, route: null };
        base.instruction = 'No nearby AI resident or public scripted country ambassador is available. The guide waits for a resident to return.';
      }
    } else {
      const talking = candidate.kind === 'npc';
      base.target = { kind: 'resident', label: candidate.name, world_id: worldOf, world_name: worldNameOf, x: candidate.x, y: candidate.y, z: 0, distance: candidate.distance, route: talking ? '/ambassadors/talk' : '/messages' };
      if (talking) {
        base.instruction = 'Read this scripted country ambassador’s limits, then ask your own question. A saved question asked while this character is nearby can complete the meeting.';
        if (ctx.actor?.kind === 'session' && viewer?.status === 'active') base.actions = [action('meet-nearest', `Ask ${candidate.name} a question`, '/ambassadors/talk', null, { ambassador_id: candidate.id, agent_id: viewer.id }, true)];
      }
      else if (ctx.actor?.kind === 'session' && viewer?.status === 'active') base.actions = [action('meet-nearest', `Message ${candidate.name}`, '/messages', 'chat', { agent_id: viewer.id, channel: 'private', recipient_id: candidate.id }, true)];
    }
  }
  else if (id === 'practice') base.target = ctx.practiceTarget;
  else if (id === 'restore') {
    base.target = ctx.restoreTarget.target;
    base.actions = ctx.actor?.kind === 'session' && viewer?.status === 'active' && ctx.restoreTarget.action ? [ctx.restoreTarget.action] : [];
    base.instruction = ctx.restoreTarget.instruction || base.instruction;
    base.blocked = base.blocked || ctx.restoreTarget.blocked || null;
  }
  return base;
}

export const firstPlayMethods = {
  /**
   * The one read. It derives all five step states, the shared restoration and the nearest resident for
   * this viewer and writes nothing: no audit, no receipt, no coin, and no call to `this.active()`.
   */
  firstPlay(actor, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Send a JSON object.');
    for (const key of Object.keys(input)) if (!ALLOWED_INPUT.has(key)) fail(400, 'The first-play guide reads only agent_id and world_id.');
    if (actor?.kind === 'runtime' && input.agent_id && input.agent_id !== actor.agent?.id) fail(403, 'A runtime credential reads only the resident it runs.');
    const viewerId = actor?.kind === 'runtime' ? actor.agent?.id : actor?.kind === 'session' ? input.agent_id || '' : '';
    const viewer = viewerId ? this.ownedAgent(actor, viewerId) : null;
    const accountId = viewer ? actor.account.id : '';
    const paused = this.get("SELECT value FROM settings WHERE key='paused'").value === 'true';
    const worldId = typeof input.world_id === 'string' && input.world_id ? input.world_id : viewer ? viewer.world_id : 'commons';
    const world = this.space(actor, worldId);
    const viewerWorldName = viewer ? this.get('SELECT name FROM worlds WHERE id=?', viewer.world_id)?.name || worldName(viewer.world_id) : null;
    const calling = viewer ? callingFor(this, viewer.id) : null;
    const purpose = viewer ? this.get('SELECT purpose FROM journey_profiles WHERE agent_id=?', viewer.id)?.purpose || '' : '';

    // Prefer a bounded account-specific restoration where this viewer has saved counted work,
    // so older contributions stay visible when many newer events arrive. Fall back to the global
    // newest-eight list when there is no account work.
    const restorationInput = viewer ? { agent_id: viewer.id } : {};
    if (input.world_id) restorationInput.world_id = input.world_id;
    const eventView = viewer
      ? this.restorationForAccount(actor, viewer.id, input.world_id) || this.restoration(actor, restorationInput).event
      : this.restoration(actor, restorationInput).event;
    const operators = new Map();
    if (eventView?.participants.length) {
      const ids = eventView.participants.map((participant) => participant.agent_id);
      for (const row of this.all(`SELECT id,operator_id FROM agents WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)) operators.set(row.id, row.operator_id);
    }

    const done = {
      enter: viewer ? Boolean(this.get("SELECT id FROM agents WHERE operator_id=? AND status!='deleted' LIMIT 1", accountId)) : false,
      calling: viewer ? Boolean(this.get("SELECT seq FROM audit WHERE event='calling.selected' AND record_id=? LIMIT 1", viewer.id)) : false,
      meet: viewer ? Boolean(this.get(MEET_AUDIT_SQL, accountId, `${viewer.id}|`.length, `${viewer.id}|`) || this.get(MEET_NEARBY_SQL, viewer.id, accountId, accountId)) : false,
      practice: viewer ? Boolean(this.get('SELECT id FROM calling_receipts WHERE agent_id=? LIMIT 1', viewer.id)) : false,
      restore: false,
    };
    const mine = eventView?.viewer ? eventView.viewer.steps.some((step) => step.my_counted > 0) : false;
    const beside = Boolean(eventView && accountId && eventView.participants.some((participant) => operators.get(participant.agent_id) && operators.get(participant.agent_id) !== accountId && participant.contributions.some((contribution) => contribution.counted > 0)));
    done.restore = mine && beside;

    const steps = FIRST_PLAY_STEPS.map((step) => ({ id: step.id, ordinal: step.ordinal, title: step.title, reason: step.reason, done: done[step.id], evidence: { source: step.evidence.source, label: step.evidence.label } }));
    const progress = { done: steps.filter((step) => step.done).length, total: steps.length };
    const current = steps.find((step) => !step.done) || null;

    const encounterWorld = viewer ? viewer.world_id : worldId;
    const candidate = nearestResident(this, encounterWorld, viewer);
    const encounter = candidate ? encounterFrom(this, candidate, viewer, actor) : null;
    const blocked = paused ? { ...FIRST_PLAY_REFUSALS[0] } : viewer && viewer.status !== 'active' ? { ...FIRST_PLAY_REFUSALS[1] } : null;
    const ctx = { actor, viewer, world, worldId, viewerWorldName, candidate, blocked, practiceTarget: null, restoreTarget: null,
      starterAmbassador: current?.id === 'meet' && viewer && !candidate ? starterAmbassador(this) : null,
      venueAmbassador: current?.id === 'meet' && viewer && !candidate ? this.get("SELECT id,name,iso3,x,y FROM npc_ambassadors WHERE world_id=? AND status='active' ORDER BY name LIMIT 1", viewer.world_id) : null };
    if (current?.id === 'practice') ctx.practiceTarget = practiceTargetFor(this, viewer, world);
    if (current?.id === 'restore') ctx.restoreTarget = restoreTargetFor(this, eventView, viewer);

    return {
      policy: FIRST_PLAY_POLICY,
      world: { id: world.id, name: world.name, kind: world.kind, paused, server_time: this.clock() },
      viewer: viewer ? {
        account_id: actor.account.id, account_name: actor.account.name, role: actor.account.role,
        agent_id: viewer.id, name: viewer.name, kind: viewer.kind,
        calling_id: calling ? calling.id : 'explorer', calling_name: calling ? calling.name : null, calling_purpose: calling ? calling.purpose : null,
        purpose, world_id: viewer.world_id, world_name: viewerWorldName, x: viewer.x, y: viewer.y, z: viewer.z, status: viewer.status,
      } : null,
      steps, progress,
      next_step: current ? nextStepFor(current.id, ctx) : null,
      encounter,
      restoration: restorationBlockFor(eventView, accountId, operators),
      resume: viewer ? {
        character_id: viewer.id, character_name: viewer.name, kind: viewer.kind,
        world_id: viewer.world_id, world_name: viewerWorldName, x: viewer.x, y: viewer.y, z: viewer.z,
        grounded: Boolean(viewer.grounded), yaw: viewer.yaw, pitch: viewer.pitch, posture: viewer.posture,
        camera: { preference: null, source: 'this browser (localStorage)' },
        calling_id: calling ? calling.id : 'explorer', calling_name: calling ? calling.name : null, purpose,
        next_step_id: current ? current.id : null,
        restore: FIRST_PLAY_RESUME_SOURCES.map((source) => ({ id: source.id, label: source.label, source: source.source })),
        refusal: resumeRefusal(viewer),
      } : null,
      refusals: FIRST_PLAY_REFUSALS,
    };
  },
};

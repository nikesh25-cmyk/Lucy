import { readFileSync } from 'node:fs';
import { identityFor, setIdentityProvider } from './identity.js';
import { findsFrom, libraryLines, loadDiscoveries, loadRecord, loadWorks, worksLines } from './world-life.js';

// ---- The in-game interface (HUD) ---------------------------------------------------------------
//
// NemoWorld's interface, reachable from inside Veloren without any client change. A player says a
// short command ("passport", "quests", "next", ...) to a guide resident; the guide's bridge asks this
// extension for a small page of text and whispers it back with /tell.
//
//   GET  /veloren/view/<page>?player_uuid=<uuid>&page=<n>   scope director, guide credential
//   POST /veloren/hud/track  { player_uuid }                  scope director, guide credential
//   GET  /veloren/hud/status?player_uuid=<uuid>&cmd_id=<id>   scope director, guide credential
//
// What this extension is and is not:
//   * A READER. It calls NemoWorld's own read methods for the one account that identity.js says owns
//     this Veloren player. It never calls a method that writes. The only thing it can cause is a
//     signed `hud_marker` command, which the Veloren server may apply (a map marker) and must
//     acknowledge; until it does, the marker is "unconfirmed", never "done".
//   * LINKED PLAYERS ONLY. An unlinked player gets a friendly pointer and no data at all.
//   * PRIVATE. It returns the player's own summary figures. It never returns the text of a private
//     journal entry, the vault, private conversations, other players' passports, balances or
//     progress, or any contact detail. Text written by other people (gathering titles, circle names)
//     is neutralised before it can reach a chat window (see `plain`).
//   * BOUNDED. At most PAGE_LINES lines per page, LINE_CHARS characters per line, MAX_PAGES pages,
//     RESPONSE_BYTES bytes per reply, and per-player and global rate limits stored in the link
//     database.
//   * NOT A SOURCE OF FACTS. Every figure comes from the server's saved state; nothing a player says
//     in chat reaches this code except a whitelisted page name and a page number.

export const HUD_POLICY = Object.freeze({
  page_lines: 4,
  line_chars: 190,
  line_bytes: 230,       // Veloren refuses player chat over 256 bytes; stay well under it.
  max_pages: 6,
  response_bytes: 2048,
  name_chars: 24,
  view_gap_ms: 1000,
  view_per_hour: 240,     // per player
  view_all_per_hour: 4000,
  track_gap_ms: 10_000,
  track_per_hour: 30,
  marker_ttl_ms: 60_000,
  marker_label_chars: 60,
});

// Residents whose credentials may read player views. A credential for any other resident (for
// instance Lyra's) is refused even though it carries the same `director` scope.
export const GUIDE_RESIDENTS = Object.freeze(['lw-selene']);

export const HUD_PAGES = Object.freeze(['help', 'start', 'passport', 'journal', 'calling', 'quests', 'next', 'community', 'karma', 'works', 'library']);
// Open pages: about the village, not about an account, so they need no link. They still need a player id.
export const OPEN_PAGES = Object.freeze(['works', 'library']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const enc = new TextEncoder();

// ---- text safety -------------------------------------------------------------------------------

// Code point ranges that are never shown: controls, line/paragraph separators, bidi controls,
// zero-width and format characters, variation selectors and tag characters (hidden-text tricks).
const INVISIBLE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f],
  [0x2028, 0x202e], [0x2060, 0x206f], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0xe0000, 0xe007f]];
const hidden = (character) => { const cp = character.codePointAt(0); return INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi); };
export const stripInvisible = (text) => Array.from(String(text), (character) => (hidden(character) ? ' ' : character)).join('');

/**
 * Make text written by a person safe to show in a game chat window: no control or invisible
 * characters (no line breaks, no right-to-left tricks), no square brackets (so nobody can fake an
 * `[AI]` or `[system]` label), no links or contact details, no leading slash, collapsed spaces, and a
 * hard length limit. Applied to EVERY value that did not come from this file.
 */
export function plain(value, max = HUD_POLICY.line_chars) {
  let text = String(value ?? '');
  try { text = text.normalize('NFKC'); } catch { /* keep the raw text */ }
  text = stripInvisible(text)
    .replace(/[\[\]{}<>|\\`]/g, ' ')
    .replace(/\bhttps?:\/\/\S*/gi, '(link removed)')
    .replace(/\bwww\.\S*/gi, '(link removed)')
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '(contact removed)')
    .replace(/\s+/g, ' ').trim()
    .replace(/^[/!.\-\s]+/, '');
  return cut(text, max);
}

/** Cut at a word boundary, by characters, never inside a surrogate pair. */
export function cut(text, max) {
  const chars = Array.from(String(text));
  if (chars.length <= max) return chars.join('');
  const head = chars.slice(0, Math.max(1, max - 1)).join('');
  const space = head.lastIndexOf(' ');
  return `${(space > max * 0.5 ? head.slice(0, space) : head).replace(/[\s,;:.-]+$/, '')}…`;
}

/** A finished line: bounded in characters AND bytes (non-Latin text is wider in UTF-8). */
export function line(text) {
  let out = cut(stripInvisible(text).replace(/\s+/g, ' ').trim(), HUD_POLICY.line_chars);
  while (enc.encode(out).length > HUD_POLICY.line_bytes && out.length > 1) out = cut(out, Math.max(1, Array.from(out).length - 8));
  return out;
}

const day = (ms) => new Date(Number(ms) || 0).toISOString().slice(0, 10);
const num = (value) => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- paging ------------------------------------------------------------------------------------

/**
 * Break one long sentence into at most `maxChunks` lines at word boundaries, so a long fact reads on
 * two lines instead of being cut off. Anything beyond the last chunk is cut with an ellipsis.
 */
export function wrap(text, width = HUD_POLICY.line_chars - 20, maxChunks = 3) {
  const words = stripInvisible(text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const chunks = [];
  let current = '';
  for (const word of words) {
    const piece = Array.from(word).length > width ? cut(word, width) : word;
    if (current && Array.from(`${current} ${piece}`).length > width) {
      chunks.push(current);
      current = piece;
    } else current = current ? `${current} ${piece}` : piece;
  }
  if (current) chunks.push(current);
  if (chunks.length > maxChunks) {
    const kept = chunks.slice(0, maxChunks);
    kept[maxChunks - 1] = cut(`${kept[maxChunks - 1]} ${chunks.slice(maxChunks).join(' ')}`, width);
    return kept;
  }
  return chunks;
}

/** Split lines into pages of PAGE_LINES, at most MAX_PAGES pages. Pure. */
export function paginate(lines, requested = 1) {
  const all = lines.flatMap((item) => wrap(item)).map(line).filter(Boolean);
  const capped = all.slice(0, HUD_POLICY.page_lines * HUD_POLICY.max_pages);
  const pages = Math.max(1, Math.ceil(capped.length / HUD_POLICY.page_lines));
  const page = Number.isInteger(requested) && requested >= 1 ? requested : 1;
  if (page > pages) return { page: pages, pages, lines: [], out_of_range: true, truncated: all.length > capped.length };
  const slice = capped.slice((page - 1) * HUD_POLICY.page_lines, page * HUD_POLICY.page_lines);
  return { page, pages, lines: slice, out_of_range: false, truncated: all.length > capped.length };
}

// ---- who is asking -----------------------------------------------------------------------------

/**
 * The account and character for a Veloren player, or a reason why not. The link stream decides who a
 * player is (identity.js); this only checks that the answer is a real, active character of a real,
 * active account, so a stale or forged answer cannot read somebody else's data.
 */
export function resolveViewer(link, platform, player_uuid) {
  let identity = null;
  try { identity = identityFor(link, player_uuid); } catch { identity = null; }
  if (!identity || typeof identity.account_id !== 'string' || typeof identity.agent_id !== 'string') return { linked: false, reason: 'not_linked' };
  const account = platform.get('SELECT * FROM accounts WHERE id=?', identity.account_id);
  const agent = platform.get('SELECT * FROM agents WHERE id=?', identity.agent_id);
  if (!account || account.status !== 'active' || !agent || agent.operator_id !== account.id || !['human', 'agent'].includes(agent.kind)) return { linked: false, reason: 'not_linked' };
  if (agent.status !== 'active') return { linked: false, reason: 'inactive' };
  // A read-only view of the owner's own session. No token is created or stored, and the methods we
  // call below are an allow-list of reads (see `READS`).
  const actor = { account, agent: null, kind: 'session', credential: { kind: 'session', hash: '' } };
  return { linked: true, actor, account, agent, name: plain(identity.display_name || agent.name, HUD_POLICY.name_chars) || 'traveller' };
}

export const READS = Object.freeze(['journey', 'callings', 'quests', 'community', 'karmaWallet', 'firstPlay']);

/** The platform, restricted to the read methods this extension is allowed to call. */
export function readOnly(platform) {
  const facade = {};
  for (const name of READS) facade[name] = (...args) => platform[name](...args);
  return Object.freeze(facade);
}

// ---- the quest tracker -------------------------------------------------------------------------

/**
 * The player's current in-game objective: the next step of the Veloren practice quest and the
 * landmark it happens at. Derived from stored, signed server facts only.
 */
export function trackerTarget(link, player_uuid) {
  const progress = link.progress(player_uuid);
  if (progress.complete) return { complete: true, title: progress.title, step: null, landmark_id: null, landmark_name: null, instruction: `${progress.title} is complete.` };
  const step = progress.next_step;
  const role = { meet: null, survey: 'survey', return: 'post' }[step] ?? null;
  const landmark = role ? link.landmark(role) : null;
  const instruction = progress.steps.find((item) => item.id === step)?.instruction || '';
  return { complete: false, title: progress.title, practice: progress.practice, step, landmark_id: landmark?.id ?? null, landmark_name: landmark?.name ?? null, instruction };
}

// ---- page builders -----------------------------------------------------------------------------
// Each takes plain data already read from the platform and returns an array of lines. Pure, so they
// are unit tested without a database.

export function helpLines() {
  return [
    'I am Selene, a scripted guide: I only read and tell. I cannot give, buy, approve or change anything for you.',
    'Say or whisper: start, passport, journal, calling, quests, next, community, karma. Add a number for more, like quests 2.',
    'For the village itself, ask for works (what is being built) or library (places to discover). They need no account.',
    'Say track to mark your current step on your map. Say more for the next page of the last answer.',
    'My answers come to you privately by /tell. Your real progress lives in NemoWorld and only the world can change it.',
  ];
}

export function unlinkedLines(reason = 'not_linked') {
  if (reason === 'inactive') {
    return [
      'Your NemoWorld character is paused or unavailable, so I cannot read it.',
      'Resume it in NemoWorld, then say help to me again.',
    ];
  }
  return [
    'Welcome to Harr! I am Selene, the host. I cannot see a passport for you yet because this character is not linked to a NemoWorld account.',
    'Link first: sign in to NemoWorld in a browser and link this Veloren character to your account there.',
    'Then whisper help to me again. Until then you can still walk around and meet Lyra Scrollkeeper nearby.',
  ];
}

export function passportLines({ name, journey, calling, tracker }) {
  const out = [];
  const profile = journey?.profile || {};
  const badges = (journey?.badges || []).map((badge) => plain(badge.name, 20)).filter(Boolean);
  const cal = calling?.calling;
  out.push(`Passport of ${name}: ${plain(profile.title || 'Resident', 24)}${cal ? `, ${plain(cal.name, 20)}` : ''}${calling?.rank ? ` (${plain(calling.rank.title, 20)})` : ''}.`);
  const progressOf = (id) => num((journey?.quests || []).find((quest) => quest.id === id)?.progress);
  out.push(`Visited ${plural(num(journey?.discovery_count), 'place')}, ${plural(progressOf('grow'), 'harvest')}, ${plural(progressOf('make'), 'craft')}. Badges: ${badges.length ? badges.join(', ') : 'none yet'}.`);
  const skills = (journey?.skills || []).map((skill) => `${plain(skill.name, 14)} ${num(skill.level)}`).join(', ');
  if (skills) out.push(`Skills: ${skills}.`);
  if (profile.purpose) out.push(`Purpose: ${plain(profile.purpose, 110)}`);
  if (tracker) out.push(tracker.complete ? `${plain(tracker.title, 40)} (practice quest): complete.` : `${plain(tracker.title, 40)} (practice quest): not finished yet. Say next.`);
  return out;
}

export function journalLines({ journey }) {
  // The journal is private. Only a count and the newest date leave NemoWorld: never any entry text.
  const entries = Array.isArray(journey?.journal) ? journey.journal : [];
  const n = entries.length;
  if (!n) return ['Your private journal is empty.', 'Write in it from NemoWorld, in the Journal panel. I never write to it and I never read it aloud.'];
  const newest = Math.max(...entries.map((entry) => num(entry.created_at)));
  return [
    `Your private journal holds ${n >= 200 ? '200 (the most NemoWorld keeps)' : plural(n, 'entry', 'entries')}; the newest was written on ${day(newest)}.`,
    'I do not read entries aloud, because chat is not private enough for a journal. Open the Journal panel in NemoWorld to read or write.',
  ];
}

export function callingLines({ calling }) {
  const out = [];
  const cal = calling?.calling;
  if (!cal) return ['I could not read your calling. Open Callings in NemoWorld.'];
  out.push(`Calling: ${plain(cal.name, 24)} of the ${plain(cal.guild_name, 30)}. ${plain(cal.purpose, 120)}`);
  const exp = calling.experience || {};
  out.push(`Rank ${plain(calling.rank?.title, 20)}, ${num(exp.available)} cosmetic experience. Today ${num(calling.today?.earned)} of ${num(calling.today?.limit)} earned; experience is cosmetic and is not money.`);
  const objectives = calling.today?.objectives || [];
  for (const [index, objective] of objectives.entries()) {
    const state = objective.complete ? 'done today' : objective.withheld ? 'held' : 'open';
    out.push(`Daily objective ${index + 1} (${state}): ${plain(objective.title, 80)}.`);
    if (!objective.complete) out.push(plain(objective.instructions, 150));
  }
  if (!objectives.length) out.push('No daily objective is open right now.');
  return out;
}

export function questLines({ quests, tracker }) {
  const out = [];
  if (tracker) {
    out.push(tracker.complete
      ? `In Veloren: ${plain(tracker.title, 40)} (a practice quest) is complete.`
      : `In Veloren: ${plain(tracker.title, 40)} (a practice quest, it awards nothing). Next: ${plain(tracker.instruction, 120)}`);
  }
  const enrolled = (quests?.chains || []).filter((chain) => chain.enrolled);
  if (!enrolled.length) {
    out.push('In NemoWorld you have not started a quest chain. Open Quests there to begin one; I cannot start one for you.');
    const open = (quests?.chains || []).filter((chain) => !chain.enrolled).length;
    if (open) out.push(`${plural(open, 'quest chain is', 'quest chains are')} open to join.`);
    return out;
  }
  for (const chain of enrolled) {
    const steps = chain.steps || [];
    const done = steps.filter((step) => step.progress?.complete).length;
    const next = chain.next_action;
    out.push(`Quest ${plain(chain.title, 40)}: ${done} of ${steps.length} steps done${chain.complete ? ', complete' : next ? `. Next: ${plain(next.step_title, 50)}. ${plain(next.instructions, 90)}` : '. A step is waiting on an earlier one.'}`);
  }
  return out;
}

export function nextLines({ tracker, calling, quests, firstPlay }) {
  const out = [];
  if (tracker && !tracker.complete) out.push(`Here in Veloren: ${plain(tracker.instruction, 150)}${tracker.landmark_name ? ' Say track and I will mark it on your map.' : ''}`);
  const objective = calling?.current_objective;
  if (objective) out.push(`In NemoWorld, your daily objective: ${plain(objective.title, 70)}. ${plain(objective.instructions, 90)}`);
  const action = quests?.next_action;
  if (action) out.push(`Your quest ${plain(action.chain_title, 36)}: ${plain(action.step_title, 50)}. ${plain(action.instructions, 80)}`);
  const step = firstPlay?.next_step;
  if (!out.length && step) out.push(`Your next first-ten-minutes step: ${plain(step.title, 60)}. ${plain(step.instruction, 120)}`);
  if (!out.length) out.push('Nothing is waiting for you right now. Look around Harr, say hello to Lyra, or whisper community to see gatherings.');
  return out;
}

export function startLines({ firstPlay, tracker }) {
  const steps = firstPlay?.steps || [];
  const out = ['Welcome. Your first ten minutes have five small steps. The world checks each one from saved facts, so doing them is what counts.'];
  for (const step of steps) out.push(`Step ${num(step.ordinal)}, ${step.done ? 'done' : 'to do'}: ${plain(step.title, 70)}.`);
  const next = firstPlay?.next_step;
  if (steps.length) out.push(next ? `Next, step ${num(next.ordinal)}: ${plain(next.instruction, 150)}` : 'All five steps are done. Well begun.');
  out.push(tracker && !tracker.complete
    ? 'In Harr you can try a practice quest too: talk to Lyra Scrollkeeper, then say next to me.'
    : 'You have finished the Harr practice quest. Whisper community to see what neighbours are planning.');
  return out;
}

export function communityLines({ community }) {
  const out = [];
  const events = community?.events || [];
  const circles = community?.circles || [];
  const projects = community?.projects || [];
  const counts = community?.counts || {};
  out.push(`Community: ${plural(num(counts.events), 'upcoming gathering')}, ${plural(num(counts.circles), 'circle')}, ${plural(num(counts.projects), 'project')}.`);
  // Titles are written by other people: they are shown, but only after `plain` and never with names.
  for (const event of events.slice(0, 4)) out.push(`Gathering: ${plain(event.title, 70)} on ${day(Date.parse(event.starts_at))}; ${plural(num(event.attendee_count), 'person', 'people')} going${event.rsvped ? ' (you are going)' : ''}.`);
  for (const circle of circles.slice(0, 3)) out.push(`Circle: ${plain(circle.name, 60)}, ${plural(num(circle.member_count), 'member')}${circle.joined ? ' (you belong)' : ''}.`);
  for (const project of projects.slice(0, 2)) out.push(`Project: ${plain(project.title, 70)}.`);
  out.push('To join or plan a gathering, open Community in NemoWorld; I cannot do that for you.');
  return out;
}

export function karmaLines({ karma }) {
  if (!karma) return ['Karma Coins are not available on this world right now.'];
  const today = karma.today || {};
  return [
    `Karma Coins: balance ${num(karma.balance)} (earned ${num(karma.earned)}, spent ${num(karma.spent)}) on your NemoWorld account.`,
    `Today you earned ${num(today.earned)} of ${num(today.limit)} possible.`,
    'Karma is earned only from saved service in NemoWorld. Chat cannot add or spend it, and I cannot give or take it.',
    'Spending happens only when you, signed in to NemoWorld, choose it in the shop.',
  ];
}

// ---- assembling a page -------------------------------------------------------------------------

function gather(readers, who, name, tracker) {
  const arg = { agent_id: who.agent.id };
  const data = { name, tracker };
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  switch (name) {
    case 'passport': data.journey = safe(() => readers.journey(who.actor, arg)); data.calling = data.journey?.callings || safe(() => readers.callings(who.actor, arg)); break;
    case 'journal': data.journey = safe(() => readers.journey(who.actor, arg)); break;
    case 'calling': data.calling = safe(() => readers.callings(who.actor, arg)); break;
    case 'quests': data.quests = safe(() => readers.quests(who.actor, arg)); break;
    case 'next':
      data.calling = safe(() => readers.callings(who.actor, arg));
      data.quests = safe(() => readers.quests(who.actor, arg));
      data.firstPlay = safe(() => readers.firstPlay(who.actor, arg));
      break;
    case 'start': data.firstPlay = safe(() => readers.firstPlay(who.actor, arg)); break;
    case 'community': data.community = safe(() => readers.community(who.actor, { agent_id: who.agent.id, limit: 4 })); break;
    case 'karma': data.karma = safe(() => readers.karmaWallet(who.actor, arg)); break;
    default: break;
  }
  return data;
}

const BUILDERS = { help: () => helpLines(), start: startLines, passport: passportLines, journal: journalLines, calling: callingLines, quests: questLines, next: nextLines, community: communityLines, karma: karmaLines };
const TITLES = { help: 'Help', start: 'First ten minutes', passport: 'Passport', journal: 'Journal', calling: 'Calling', quests: 'Quests', next: 'Next step', community: 'Community', karma: 'Karma' };

/**
 * The reply for one command. Pure apart from the platform reads. Exported for tests.
 * Always returns a bounded object; an unlinked player gets the pointer and nothing else.
 */
export function buildView({ link, platform, player_uuid, name, page = 1 }) {
  if (!HUD_PAGES.includes(name)) throw Object.assign(new Error('Unknown page.'), { status: 404 });
  if (OPEN_PAGES.includes(name)) {
    const lines = name === 'works'
      ? worksLines(loadWorks(), loadRecord(process.env.NEMO_WORLD_RECORD), link.clock())
      : libraryLines(loadDiscoveries(), findsFrom(link.sql, loadDiscoveries()), player_uuid, (alias) => plain(alias, 24));
    const paged = paginate(lines, page);
    return fitResponse({
      linked: false, open: true, command: name, title: name === 'works' ? 'Public works' : 'Harr Library', page: paged.page, pages: paged.pages,
      lines: paged.out_of_range ? [line(`There is no page ${page}.`)] : paged.lines, more: !paged.out_of_range && paged.page < paged.pages, source: 'scripted',
    });
  }
  const who = resolveViewer(link, platform, player_uuid);
  if (!who.linked) {
    const paged = paginate(unlinkedLines(who.reason), 1);
    return { linked: false, reason: who.reason, command: name, title: 'Link first', page: 1, pages: 1, lines: paged.lines, more: false, source: 'scripted' };
  }
  const tracker = ['passport', 'quests', 'next', 'start'].includes(name) ? trackerTarget(link, player_uuid) : null;
  const data = platform.transaction(() => gather(readOnly(platform), who, name, tracker));
  const lines = BUILDERS[name]({ ...data, name: who.name });
  const paged = paginate(lines, page);
  const extra = paged.out_of_range ? [`There is no page ${page}; ${TITLES[name]} has ${plural(paged.pages, 'page')}.`] : [];
  const reply = {
    linked: true, command: name, title: TITLES[name], page: paged.page, pages: paged.pages,
    lines: paged.out_of_range ? extra.map(line) : paged.lines,
    more: !paged.out_of_range && paged.page < paged.pages,
    ...(paged.truncated && paged.page === paged.pages ? { note: 'Shortened. The rest is in NemoWorld.' } : {}),
    source: 'scripted',
  };
  return fitResponse(reply);
}

/** Last line of defence for "oversized replies": shrink until the JSON fits. */
export function fitResponse(reply) {
  const copy = { ...reply, lines: [...reply.lines] };
  while (enc.encode(JSON.stringify(copy)).length > HUD_POLICY.response_bytes && copy.lines.length > 1) copy.lines.pop();
  if (enc.encode(JSON.stringify(copy)).length > HUD_POLICY.response_bytes) copy.lines = copy.lines.map((item) => cut(item, 80));
  return copy;
}

// ---- rate limits (stored in the link database; they survive a restart) --------------------------

export function spendRate(link, key, { gapMs, perHour }) {
  const now = link.clock();
  const hour = Math.floor(now / 3_600_000);
  link.sql.tx(() => {
    const last = link.sql.get('SELECT last_at FROM hud_last WHERE key=?', key);
    if (last && now - last.last_at < gapMs) throw Object.assign(new Error('Please wait a moment before asking again.'), { status: 429 });
    const used = link.sql.get('SELECT calls FROM hud_usage WHERE key=? AND hour=?', key, hour)?.calls ?? 0;
    if (used >= perHour) throw Object.assign(new Error('That is a lot of questions for one hour. Please try again later.'), { status: 429 });
    link.sql.run('INSERT INTO hud_last(key,last_at) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET last_at=excluded.last_at', key, now);
    link.sql.run('INSERT INTO hud_usage(key,hour,calls) VALUES(?,?,1) ON CONFLICT(key,hour) DO UPDATE SET calls=calls+1', key, hour);
    if (used === 0) link.sql.run('DELETE FROM hud_usage WHERE hour<?', hour - 2);
  });
}

function guide(link, ctx) {
  const credential = link.authenticate(ctx.tokenFrom(ctx.request), 'director');
  if (!GUIDE_RESIDENTS.includes(credential.resident_id)) ctx.fail(403, 'Only a guide resident may read player views.');
  return credential;
}

function playerParam(ctx, source) {
  // Exactly one player id: a request that names two is ambiguous, so it is refused rather than guessed.
  if (source instanceof URLSearchParams && source.getAll('player_uuid').length > 1) ctx.fail(400, 'Name one Veloren player id at a time.');
  const player = (source instanceof URLSearchParams ? source.get('player_uuid') : source?.player_uuid) || '';
  if (typeof player !== 'string' || !UUID.test(player)) ctx.fail(400, 'A Veloren player id is required.');
  return player;
}

// ---- the extension -----------------------------------------------------------------------------

export const hudExtension = {
  name: 'hud',
  schema: {
    version: 1,
    sql: `CREATE TABLE hud_last(key TEXT PRIMARY KEY, last_at INTEGER NOT NULL);
          CREATE TABLE hud_usage(key TEXT NOT NULL, hour INTEGER NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY(key, hour));`,
  },

  async handle(link, ctx) {
    const { route, request, url, platform } = ctx;
    const method = request.method;

    const viewMatch = /^\/veloren\/view\/([a-z]{2,12})$/.exec(route);
    if (viewMatch && method === 'GET') {
      guide(link, ctx);
      const name = viewMatch[1];
      if (!HUD_PAGES.includes(name)) ctx.fail(404, 'Unknown page.');
      const player = playerParam(ctx, url.searchParams);
      const raw = url.searchParams.get('page');
      let page = 1;
      if (raw !== null) {
        if (!/^\d{1,2}$/.test(raw) || Number(raw) < 1) ctx.fail(400, 'Choose a page number from 1 to 99.');
        page = Number(raw);
      }
      spendRate(link, '*', { gapMs: 0, perHour: HUD_POLICY.view_all_per_hour });
      spendRate(link, `view:${player}`, { gapMs: HUD_POLICY.view_gap_ms, perHour: HUD_POLICY.view_per_hour });
      if (!platform) ctx.fail(503, 'NemoWorld is not ready.');
      ctx.json(ctx.response, 200, buildView({ link, platform, player_uuid: player, name, page }));
      return true;
    }

    if (route === '/veloren/hud/track' && method === 'POST') {
      guide(link, ctx);
      const input = await ctx.body(request);
      const player = playerParam(ctx, input);
      spendRate(link, `track:${player}`, { gapMs: HUD_POLICY.track_gap_ms, perHour: HUD_POLICY.track_per_hour });
      const who = resolveViewer(link, platform, player);
      if (!who.linked) return ctx.json(ctx.response, 200, { issued: false, linked: false, reason: who.reason, lines: paginate(unlinkedLines(who.reason)).lines }), true;
      const target = trackerTarget(link, player);
      if (target.complete) return ctx.json(ctx.response, 200, { issued: false, linked: true, reason: 'complete', lines: [line(`${plain(target.title, 40)} is complete, so there is nothing to mark.`)] }), true;
      if (!target.landmark_id) return ctx.json(ctx.response, 200, { issued: false, linked: true, reason: 'no_landmark', lines: [line(`Your current step has no fixed place: ${plain(target.instruction, 140)}`)] }), true;
      let command;
      try {
        command = link.issueCommand({
          kind: 'hud_marker', player_uuid: player, ttl_ms: HUD_POLICY.marker_ttl_ms, issuedBy: 'hud',
          args: { landmark_id: target.landmark_id, label: plain(`${target.title}: ${target.landmark_name}`, HUD_POLICY.marker_label_chars) },
        });
      } catch (error) {
        if (error.status === 503) return ctx.json(ctx.response, 200, { issued: false, linked: true, reason: 'commands_off', lines: ['Map markers are not switched on in this world.'] }), true;
        throw error;
      }
      ctx.json(ctx.response, 200, {
        issued: true, linked: true, cmd_id: command.cmd_id, landmark: target.landmark_name, expires_at: command.expires_at,
        lines: [line(`I asked the world to mark ${plain(target.landmark_name, 60)} on your map. I will only say it is placed once the world confirms it.`)],
      });
      return true;
    }

    if (route === '/veloren/hud/status' && method === 'GET') {
      guide(link, ctx);
      const player = playerParam(ctx, url.searchParams);
      const id = url.searchParams.get('cmd_id') || '';
      if (!UUID.test(id)) ctx.fail(400, 'A command id is required.');
      const issued = link.sql.get("SELECT player_uuid FROM link_commands WHERE cmd_id=? AND issued_by='hud'", id);
      // Another player's command, or one this feature did not issue, is "unknown": nothing is revealed.
      const status = issued && issued.player_uuid === player ? link.commandStatus(id).status : 'unknown';
      ctx.json(ctx.response, 200, { cmd_id: id, status });
      return true;
    }
    return false;
  },
};

// ---- development identity (never in production) --------------------------------------------------
//
// The link stream owns real account linking. To exercise the HUD end to end on a developer machine
// before that lands, NEMO_HUD_DEV_LINKS may name a JSON file of hand-written test fixtures:
//   { "<player uuid>": { "account_id": "...", "agent_id": "...", "display_name": "Tester" } }
// It is ignored whenever NemoWorld is configured for a public origin, and it never creates a link.
export function installDevIdentity(env = process.env) {
  const file = env.NEMO_HUD_DEV_LINKS;
  if (!file) return;
  if (env.LUCY_PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL) { console.error('[hud] NEMO_HUD_DEV_LINKS ignored: this NemoWorld has a public origin.'); return; }
  console.error('[hud] DEVELOPMENT identity fixtures are on (NEMO_HUD_DEV_LINKS). Do not use this in production.');
  setIdentityProvider((_link, uuid) => {
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8'))[uuid];
      return entry && typeof entry === 'object' ? { account_id: entry.account_id, agent_id: entry.agent_id, display_name: entry.display_name ?? '' } : null;
    } catch { return null; }
  });
}
installDevIdentity();

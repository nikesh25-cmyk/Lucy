// The in-game command surface: one catalogue of every section the platform offers, and the pure
// rules the game shell uses to open them *over* the live 3D world instead of replacing it.
//
// Why a catalogue. Before this module the section list lived twice in app.js — once as the menu's
// literal arrays and once as the view table — and a section reached from a button (`openSection('review')`)
// did not have to be in the menu at all. Here the menu, the search, the panel title and the documented
// inventory (docs/GAME_INTERFACE.md) all read the same rows, so a section cannot be added to one and
// forgotten in another. tests/command-deck.test.js holds the catalogue to app.js's view table.
//
// What this file decides: names, groups, who sees an entry, which words find it, and whether a viewport
// docks the panel beside the world or lifts it as a sheet. What it does not decide: anything about the
// world. Every section still renders its own server-read payload through the shipped `api()` call, and
// a section's own role checks stay the authority — `needs` only keeps a button off a screen that could
// not use it.

/** A viewport at least this wide docks the panel on the right and narrows the world; narrower lifts a sheet. */
export const DOCK_MIN_WIDTH = 1280;
/** The docked panel's width: a share of the viewport, never wider than a comfortable reading column. */
export const DOCK_WIDTH_RATIO = 0.36;
export const DOCK_WIDTH_MAX = 520;
/** The widened panel is a wider overlay on the right; the HUD stands down exactly as it does for chat. */
export const DOCK_WIDE_RATIO = 0.62;
export const DOCK_WIDE_MAX = 900;

export const GROUPS = Object.freeze({
  world: 'THE WORLD',
  work: 'RESEARCH & CONTRIBUTIONS',
  residents: 'YOUR RESIDENTS',
  governance: 'GOVERNANCE',
  guide: '',
});

// `purpose` says what a person comes here for; `agent` says what an AI resident or an agent operator
// does here, because the same screen serves both. `needs` is only a hint for ordering and for the
// menu: 'account' means the section reads or writes the signed-in operator's records, 'reviewer' and
// 'admin' mirror the server's role checks and never replace them.
const rows = [
  ['start', 'Start here', 'world', 'book-open', 'The guided first journey: what to do next, with the evidence behind each step.', 'Reads the journey receipts and the next required step before choosing work.', null, 'journey newcomer begin tutorial first steps'],
  ['world', 'Open world', 'world', 'map', 'Close the panel and return to the full 3D view.', 'Returns to the live scene; the resident keeps walking where it stands.', null, 'play map scene 3d close back'],
  ['explore', 'Explore worlds', 'world', 'compass', 'Discover shared places, gardens and the finite frontier, and travel to them.', 'Chooses a destination and asks the server to travel; refused trips say why.', null, 'places travel frontier gardens visit district'],
  ['list', 'World list', 'world', 'users-round', 'A text list of the people, places and messages in the current world.', 'The text alternative to the 3D view: who is here, where, and what was said.', null, 'residents people nearby chat messages directory text'],
  ['civic', 'Regions & ambassadors', 'world', 'earth', 'Twenty ecological districts and the country ambassadors who speak for them.', 'Asks an ambassador a question against retained country evidence.', null, 'mayor ambassador district region talk civic'],
  ['countries', 'Countries & areas', 'world', 'earth', 'The country atlas, dated evidence and the research questions each place raises.', 'Reads retained country series before writing a proposal or a submission.', null, 'atlas globe evidence country data sdg'],
  ['community', 'Community', 'world', 'users-round', 'Circles, gatherings, thanks and shared projects.', 'Joins circles, pledges to projects, records thanks and RSVPs.', 'account', 'circles events thanks pledge social projects gathering'],
  ['callings', 'Callings & guilds', 'world', 'sparkles', 'Choose a peaceful vocation, meet its guild and track its objectives.', 'Selects the calling that shapes the resident’s days; a calling never grants permission.', 'account', 'vocation guild objectives experience receipts'],
  ['guilds', 'Guild projects', 'world', 'users-round', 'Projects a guild is building together, and how to add a stage.', 'Contributes a stage to a guild project and reads its review state.', 'account', 'cooperative project stage build together'],
  ['restoration', 'World restoration', 'world', 'users-round', 'The shared restoration events and the garden each one needs.', 'Opens or joins a restoration event and carries out its steps.', 'account', 'restore garden event shared'],
  ['quests', 'Quest chains', 'world', 'clipboard-list', 'Multi-step quests with their rules and rewards.', 'Reads the next quest step and the rule it must satisfy.', 'account', 'quest chain steps reward objective'],
  ['research', 'Research desk', 'work', 'clipboard-list', 'Country and goal research proposals waiting for work.', 'Finds a scoped proposal, claims it and records evidence.', null, 'proposals leads sdg country search work'],
  ['missions', 'Missions', 'work', 'clipboard-list', 'Open missions and their tasks, with named beneficiaries and reviewers.', 'Claims a task, submits evidence and reads the review criteria.', null, 'tasks claim submit mission work contribute'],
  ['gallery', 'Gallery', 'work', 'sparkles', 'Reviewed and adopted work.', 'Reads finished, independently reviewed submissions.', null, 'adopted reviewed submissions showcase'],
  ['assembly', 'World Assembly', 'work', 'users-round', 'The institutions and programmes the research is routed to.', 'Finds the institution a proposal should reach and the evidence it needs.', null, 'institutions programmes un register mandate'],
  ['coins', 'Coin wallet', 'residents', 'sparkles', 'The resident’s coins, ledger and the reward policy.', 'Reads the ledger; coins come only from reviewed contributions.', 'account', 'wallet ledger karma reward balance'],
  ['passport', 'Resident passport', 'residents', 'compass', 'The resident’s story: visits, journal, keepsakes and appearance.', 'Writes the journal and reads the visit and keepsake record.', 'account', 'profile journal keepsake visits story'],
  ['workshop', 'Garden & workshop', 'residents', 'sprout', 'Crops, recipes and the workshop bench.', 'Plants, tends and crafts through the server’s own recipes.', 'account', 'farm crops craft recipes garden bench'],
  ['characters', 'My characters', 'residents', 'house', 'Create, select, pause and resume the account’s residents.', 'Creates an AI resident, selects who plays, starts or stops its runtime.', 'account', 'agents residents create select runtime credential'],
  ['history', 'My contributions', 'residents', 'book-open', 'Claims, submissions, reviews and background runs.', 'Checks whether work was reviewed and what a local run produced.', 'account', 'claims submissions runs receipts progress'],
  ['review', 'Review', 'governance', 'shield-check', 'The independent review queue and evidence library.', 'Assesses a submission against its rubric; reviewers only.', 'reviewer', 'queue assess rubric evidence workbench'],
  ['owner', 'Mission studio', 'governance', 'sprout', 'Author missions, tasks and decision briefs.', 'Drafts a scoped mission with a beneficiary and a reviewer; reviewers only.', 'reviewer', 'author create mission studio brief'],
  ['safety', 'Safety', 'governance', 'shield-check', 'Reports, appeals and moderation.', 'Files or answers a report; moderators decide enforcement.', 'account', 'report appeal moderation abuse'],
  ['operations', 'Administration', 'governance', 'settings', 'Accounts, invitations, backups and diagnostics.', 'Operates the instance; administrators only.', 'admin', 'admin accounts invites backup diagnostics'],
  ['help', 'Guide', 'guide', 'book-open', 'How NemoWorld works, what an agent can and cannot do, and the controls.', 'The reference for the rules a resident plays under.', null, 'help rules controls how to keys'],
];

export const SECTIONS = Object.freeze(rows.map(([id, label, group, icon, purpose, agent, needs, keywords]) => Object.freeze({ id, label, group, icon, purpose, agent, needs, keywords })));
const byId = new Map(SECTIONS.map((section) => [section.id, section]));

export const sectionById = (id) => byId.get(String(id)) || null;
export const sectionLabel = (id) => sectionById(id)?.label || 'NemoWorld';
export const isSection = (id) => byId.has(String(id));

/**
 * The menu as the game shell shows it, in the order the workspace has always used. `governance` rows
 * are the workspace presentation's; the game presentation leaves governance behind `/manage` and offers
 * one Management link instead (the server's role checks stay the authority for every route behind it).
 */
export function menuGroups({ account = false, reviewer = false, admin = false, game = true } = {}) {
  const pick = (ids) => ids.map(sectionById);
  const groups = [
    { title: GROUPS.world, items: pick(['start', 'world', 'explore', 'list', 'civic', 'countries', 'community', 'callings', 'guilds', 'restoration', 'quests']) },
    { title: GROUPS.work, items: pick(['research', 'missions', 'gallery', 'assembly']) },
  ];
  if (account) groups.push({ title: GROUPS.residents, items: pick(['coins', 'passport', 'workshop', 'characters', 'history']) });
  if (!game) {
    const care = [];
    if (reviewer) care.push(...pick(['review', 'owner']));
    if (account) care.push(sectionById('safety'));
    if (admin) care.push(sectionById('operations'));
    if (care.length) groups.push({ title: GROUPS.governance, items: care });
  }
  groups.push({ title: GROUPS.guide, items: pick(['help']) });
  return groups;
}

/** Words of a query, lower-cased, so "quest steps" finds Quest chains and "kar" finds the wallet. */
export const queryTerms = (query) => String(query || '').toLowerCase().split(/[^a-z0-9&]+/).filter(Boolean);

/** The ids that match every term in a label, a purpose, an agent line or a keyword. An empty query matches all. */
export function filterSections(items, query) {
  const terms = queryTerms(query);
  if (!terms.length) return items.map((item) => item.id);
  return items.filter((item) => {
    const haystack = `${item.label} ${item.purpose} ${item.agent} ${item.keywords}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }).map((item) => item.id);
}

/** 'dock' narrows the world and docks the panel on the right; 'sheet' lifts it from the bottom. */
export function panelMode(viewportWidth) {
  return Number(viewportWidth) >= DOCK_MIN_WIDTH ? 'dock' : 'sheet';
}

/** The docked panel's pixel width for a viewport, so CSS and tests read one number. */
export function dockWidth(viewportWidth, wide = false) {
  const width = Number(viewportWidth) || 0;
  return Math.round(Math.min(wide ? DOCK_WIDE_MAX : DOCK_WIDTH_MAX, width * (wide ? DOCK_WIDE_RATIO : DOCK_WIDTH_RATIO)));
}

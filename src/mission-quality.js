// Mission- and task-quality signals: a pure reader, not an authority.
//
// This module turns a *proposed* mission or task, plus the records a caller hands it, into advisory
// data a human can act on: which required fields are absent or unusable, which quality and abuse
// patterns are worth a look, and which existing entries a proposal is textually close to, with the
// score that was actually computed. It reads no database, opens no file, fetches no source and
// writes nothing. It never changes a status, awards or withholds a coin, approves or rejects
// anything, and has no opinion about what a reward should be: the coin decision stays with the
// shipped independent-acceptance predicate (see src/coins.js). Every entry it returns carries
// `advisory: true`, and a named independent human may dismiss any of them without that dismissal
// changing anything in this module.

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const str = (value) => (typeof value === 'string' ? value.trim() : '');
const firstString = (...values) => { for (const value of values) { const text = str(value); if (text) return text; } return ''; };

export const MISSION_QUALITY_VERSION = 1;

// The area list is mirrored from the shipped `createMission`, which refuses anything else. This
// module imports nothing so it can stay pure; `tests/mission-quality.test.js` asserts that every
// listed area is still accepted by the real createMission and an unlisted one is still refused.
export const MISSION_AREAS = Object.freeze(['Climate', 'Peace', 'Accessibility', 'Agriculture', 'Health', 'Education', 'Water', 'Energy', 'Trade', 'Governance', 'Biodiversity', 'Development']);

// The two hosts every seeded country proposal cites for orientation only. A source register holding
// nothing but these names no subject evidence that the platform already retains.
export const FRAMEWORK_SOURCE_HOSTS = Object.freeze(['sdgs.un.org', 'unstats.un.org']);

// Named constants. A threshold is a stated editorial choice inside a band measured on the shipped
// corpus, never a measured law. `docs/MISSION_QUALITY.md` records the measurement behind each one.
export const THRESHOLDS = Object.freeze({
  duplicate_similarity: 0.6,        // IDF-weighted token overlap at which two entries read as one concern template
  duplicate_matches_reported: 5,    // how many scored matches one assessment returns, highest score first
  question_minimum_words: 4,        // below this a question cannot name a subject and what would answer it
  question_restates_goal: 0.8,      // plain token overlap at which a "question" only repeats the title or summary
  reviewer_share: 0.8,              // one reviewer's share of one contributor's acceptances
  contributor_acceptances: 3,       // acceptances below which a single reviewer is unremarkable
  reviewer_pool_size: 2,            // distinct reviewers at or below which a corpus has no independent pool
  reviewer_pool_records: 10,        // accepted records below which the pool size says nothing
});

// What each severity means. All three are advisory; none of them blocks anything.
export const SEVERITIES = Object.freeze({
  informational: 'Context a reader may want. No action is implied and none is expected.',
  attention: 'Worth a look before the next human step. The ordinary case is benign and is often dismissed.',
  priority: 'A human should look before this proposal is worked on. Even this severity decides nothing: only a human does.',
});

export const SIGNAL_CODES = Object.freeze({
  near_duplicate: 'One or more existing entries share almost all of this text, so a human should confirm the difference is the intended one. A signal, never a rejection.',
  question_is_topic: 'The stated question is a topic, an imperative or too short to be answered; no scope, subject and measure can be read from it.',
  question_restates_goal: 'The stated question only repeats the title or the summary, so answering it would restate the goal rather than research it.',
  reviewer_is_owner: 'The designated reviewer is the mission owner, so the review would not be independent.',
  reviewer_is_contributor: 'The designated reviewer is the contributor, so the review would be self-review, which the shipped review path refuses.',
  reviewer_concentration: 'One reviewer accepted most or all of one contributor\u2019s accepted contributions. A two-person desk can make this the honest norm; it is also the shape collusion takes.',
  small_reviewer_pool: 'The supplied records show no independent reviewer pool for the corpus. Expected on a new installation; worth a look on a large one.',
  source_unfetchable: 'A named source cannot be captured under the shipped evidence rules, so a contribution citing it could not be verified from the library.',
  source_host_not_approved: 'A named source is outside the hostnames the task approves, which the shipped submission path refuses.',
  source_host_unknown: 'A named source is on a host the evidence library does not already know. A new host is registered through an approved research task, not by citing it.',
  framework_only_sources: 'Every named source is a framework or catalog reference, so the proposal names no subject evidence that the platform retains yet.',
  fictional_marker_absent: 'The proposal describes a demonstration but names neither an owner nor a beneficiary nor an explicit fictional marker, so it is neither a real nor a declared demonstration mission.',
});

const boundaryNote = (label) => `Every ${label} below is advisory. It is a pattern in the data, not a finding of fact, not proof of collusion, duplication or misconduct, and not a decision about any contribution, account or reward.`;

export const AUTHORITY = Object.freeze({
  level: 'advisory',
  changes_status: false,
  awards_or_withholds_coins: false,
  approves_or_rejects: false,
  writes_storage: false,
  note: 'This module returns data. It cannot change a status, approve or reject a contribution, award or withhold a coin, or write to storage, because it has no writer and no store to write to.',
  coin_decision: 'Nothing here mints, holds or removes a contribution coin. The coin decision stays with the shipped independent-acceptance predicate in src/coins.js, which this module neither calls nor restates.',
  units: 'Nothing here touches NemoCoins, compute credits, real money or verified carbon credits, and it proposes no conversion between them.',
});

export const BOUNDARIES = Object.freeze({
  what_this_is: 'A read of one proposed mission or task and the records supplied with it. It is not an approval, a priority ranking, a review decision or a certification.',
  what_it_is_not: 'It does not fetch a source, open a stored capture, verify a claim, judge a question\u2019s importance, or decide whether a proposal should be worked on. Only humans do those.',
  records: 'Anything derived from review records is derived only from the records supplied in this call. An empty set of records produces no collusion signal at all, which is not the same as a clean bill of health.',
  false_positive_path: 'Any signal may be dismissed by a named independent human who records why. A dismissal is a declaration, not a finding by this module, and dismissing a signal changes no status, record, coin or score.',
  corpus: 'The seeded country proposals are proposals, not studies. No pilot, beneficiary, buyer, partnership or external outcome is selected or implied by them, by this module or by its output.',
});

export const STATUS_LADDER = Object.freeze([
  'research lead',
  'owner-approved mission',
  'claimed task',
  'versioned submission',
  'independent acceptance',
  'owner adoption declaration',
  'externally evidenced implementation',
  'measured outcome',
]);

// A recorded adoption declaration is not implementation: the owner declares a use with their own
// supporting evidence, and the platform says so wherever the declaration is shown. Steps past it
// need a real, consenting beneficiary, which no part of this build has.
export const LADDER_BLOCKED = Object.freeze([
  Object.freeze({ stage: 'externally evidenced implementation', blocked_on: 'a consenting beneficiary', note: 'No external implementation evidence exists in this build. A mission owner\u2019s recorded adoption declaration is a declaration by that owner, not proof that the work was implemented or that any institution acted.' }),
  Object.freeze({ stage: 'measured outcome', blocked_on: 'a consenting beneficiary', note: 'No outcome is measured here. An outcome needs a real beneficiary who has consented to be measured, which this build does not have.' }),
]);

// ---- Required fields ---------------------------------------------------------------------------
// `requirement` names where the rule comes from: the Wave C brief, or the shipped platform, whose
// createMission/createTask already refuse the proposal without it. An empty field, a blank string
// and a placeholder such as "to be selected" are all unusable.
export const REQUIRED_FIELDS = Object.freeze([
  Object.freeze({ field: 'title', label: 'Mission or task title', requirement: 'shipped', why: 'The shipped createMission and createTask both refuse a mission or task with no title.' }),
  Object.freeze({ field: 'area', label: 'Mission area', requirement: 'shipped', why: 'The shipped createMission accepts only one of its listed areas.' }),
  Object.freeze({ field: 'owner', label: 'Named owner', requirement: 'brief', why: 'A mission needs a named human who proposes it and records adoption. An explicit fictional marker waives this for a declared demonstration.' }),
  Object.freeze({ field: 'beneficiary', label: 'Named beneficiary', requirement: 'brief', why: 'A real mission names who the work is for, or declares itself fictional.' }),
  Object.freeze({ field: 'question', label: 'Answerable question', requirement: 'brief', why: 'A topic or a restated goal cannot be answered, so no contribution can be judged against it.' }),
  Object.freeze({ field: 'evidence_criteria', label: 'Evidence criteria', requirement: 'brief', why: 'The acceptance rubric a reviewer judges a contribution against.' }),
  Object.freeze({ field: 'limits', label: 'Stated limits', requirement: 'brief', why: 'What the work cannot establish must be stated before it is done, not discovered afterwards.' }),
  Object.freeze({ field: 'rights', label: 'Reuse rights', requirement: 'brief', why: 'The permissions the work relies on and the attribution it must carry.' }),
  Object.freeze({ field: 'sources', label: 'Source register', requirement: 'brief', why: 'At least one named source with an exact location, so the contribution can be checked against a version.' }),
  Object.freeze({ field: 'source_date', label: 'Source date', requirement: 'brief', why: 'Every named source carries the date of the version it will cite.' }),
  Object.freeze({ field: 'source_version', label: 'Source version', requirement: 'brief', why: 'Every named source names the version the work will pin, so a later capture cannot rewrite what was cited.' }),
  Object.freeze({ field: 'reviewer', label: 'Designated reviewer', requirement: 'brief', why: 'An independent human must accept a contribution before it counts.' }),
  Object.freeze({ field: 'reviewer_independence', label: 'Independent reviewer', requirement: 'brief', why: 'The reviewer must be a different person from the owner and from the contributor.' }),
  Object.freeze({ field: 'source_hosts', label: 'Approved source hosts', requirement: 'shipped', why: 'The shipped createTask refuses a real task that names no approved source hostname. Required for a task proposal only.' }),
]);

// ---- Text normalisation and token overlap ------------------------------------------------------
// Two entries are compared by the words they share, never by their titles alone. Text is normalised
// with NFKC, case folding, punctuation-to-space and a stopword filter, so a title match that is not
// a semantic match does not read as a duplicate.
const STOPWORDS = new Set(('a an the and or of for to in on with by as is are was were be been being that this it its at from not no than then so such which what who whom whose when where how why do does did doing done can could should would may might must will shall all any each every other another same own only also into over under out up down more most less least there their them they you your yours our ours we us he she his her him i me my mine section paragraph rows table note notes per use used using between against after before during within without about across under near one two three every another both few many much some most any').split(/\s+/));

/** NFKC-normalised, case-folded, punctuation-stripped, stopword-filtered tokens. */
export function normalizeText(value, { keepStopwords = false } = {}) {
  const tokens = String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && (keepStopwords || !STOPWORDS.has(token)));
  return tokens;
}

/** The distinct tokens of a value, as the Set the similarity measures compare. */
export function tokenSetOf(value, options) { return new Set(normalizeText(value, options)); }

// The fields one entry contributes to a comparison. Sources are excluded: a hostname is not the
// proposal's question, and including URLs would let two unrelated proposals share host tokens.
const TEXT_FIELDS = Object.freeze(['title', 'summary', 'goal', 'goal_statement', 'question', 'instructions', 'rubric', 'criteria', 'evidence_criteria', 'limits', 'limitations', 'rights']);

/** The one text an entry is compared through: every prose field it carries, merged and labelled. */
export function entryText(entry = {}) {
  const merged = { ...asObject(entry), ...asObject(entry?.mission), ...asObject(entry?.task) };
  return TEXT_FIELDS.map((field) => (typeof merged[field] === 'string' ? merged[field] : '')).filter(Boolean).join('\n');
}

// Smoothed inverse document frequency: idf(t) = ln(1 + N / (1 + df(t))). A token every entry carries
// weighs almost nothing and a token only one entry carries weighs most, so a changed subject token
// counts for more than the boilerplate the corpus shares. On the shipped corpus this widens the gap
// between entries that share a concern template and entries that differ in concern; it does not
// separate every class, and docs/MISSION_QUALITY.md records what it cannot do.
export function corpusWeights(entries = []) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry === 'object');
  const idf = new Map();
  const documentFrequency = new Map();
  for (const entry of list) for (const token of tokenSetOf(entryText(entry))) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  const total = list.length;
  for (const [token, count] of documentFrequency) idf.set(token, Math.log(1 + total / (1 + count)));
  return { documents_total: total, idf };
}

// A token the corpus does not carry at all has document frequency zero, so it weighs the most:
// it is exactly the token that distinguishes this proposal from everything already stored.
export function termWeight(token, weights) {
  if (!weights || !weights.documents_total) return 1;
  return weights.idf.get(token) ?? Math.log(1 + weights.documents_total);
}

/** Dice coefficient over two token sets, optionally weighted by `corpusWeights`. */
export function similarity(a, b, weights = null) {
  const left = a instanceof Set ? a : new Set(a || []);
  const right = b instanceof Set ? b : new Set(b || []);
  if (!left.size || !right.size) return 0;
  let shared = 0, leftTotal = 0, rightTotal = 0;
  for (const token of left) { const weight = termWeight(token, weights); leftTotal += weight; if (right.has(token)) shared += weight; }
  for (const token of right) rightTotal += termWeight(token, weights);
  return (2 * shared) / (leftTotal + rightTotal);
}

const rankedTokens = (tokens, weights, limit = 6) => [...tokens].sort((a, b) => termWeight(b, weights) - termWeight(a, weights)).slice(0, limit);

// ---- Near-duplicate matches --------------------------------------------------------------------
// A duplicate is a *signal for a human*, never an automatic rejection, and this function returns no
// verdict at all: only entries whose computed score reached the stated threshold, each with the id,
// the score, the plain score, and the tokens that actually distinguish the two.
export function duplicateMatches(proposal, existing = [], options = {}) {
  const threshold = Number(options.threshold ?? THRESHOLDS.duplicate_similarity);
  const limit = Number(options.limit ?? THRESHOLDS.duplicate_matches_reported);
  const entries = (Array.isArray(existing) ? existing : []).filter((entry) => entry && typeof entry === 'object' && str(entry.id));
  const weights = corpusWeights(entries);
  const subjectId = str(asObject(proposal).id);
  const subjectTokens = tokenSetOf(entryText(proposal));
  const matches = [];
  let considered = 0;
  for (const entry of entries) {
    const id = str(entry.id);
    // A revision of the same proposal is that proposal, not a duplicate of itself.
    if (id === subjectId) continue;
    considered += 1;
    const otherTokens = tokenSetOf(entryText(entry));
    const score = similarity(subjectTokens, otherTokens, weights);
    if (score < threshold) continue;
    const plain = similarity(subjectTokens, otherTokens);
    matches.push({
      id,
      title: firstString(entry.title),
      score: Number(score.toFixed(4)),
      plain_score: Number(plain.toFixed(4)),
      threshold,
      basis: 'Dice coefficient over normalised token sets, weighted by inverse document frequency',
      shared_tokens: [...subjectTokens].filter((token) => otherTokens.has(token)).length,
      distinguishing: {
        in_proposal: rankedTokens([...subjectTokens].filter((token) => !otherTokens.has(token)), weights),
        in_existing: rankedTokens([...otherTokens].filter((token) => !subjectTokens.has(token)), weights),
      },
      advisory: true,
    });
  }
  matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    threshold,
    basis: 'Dice coefficient over normalised token sets (NFKC, case-folded, punctuation removed, stopwords dropped), weighted by inverse document frequency so shared boilerplate counts for little and a distinguishing subject counts for much',
    considered,
    above_threshold: matches.length,
    returned: Math.min(limit, matches.length),
    matches: matches.slice(0, limit),
  };
}

// ---- The shipped source rules ------------------------------------------------------------------
// Mirrored from `approvedEvidenceUrl`, `createTask` and `evidenceCapture` so a proposal can be read
// against the rules the platform will actually apply when a contribution cites these sources.
export const SOURCE_RULES = Object.freeze({
  valid_url: 'A source must be a parseable absolute URL.',
  https_only: 'The evidence library captures HTTPS sources only (approvedEvidenceUrl).',
  no_credentials: 'A source URL may carry no username or password.',
  no_port: 'A source URL may name no port.',
  public_hostname: 'A literal IP address, localhost and .local names are refused.',
  approved_host: 'A task names its approved source hostnames and the shipped submission path refuses a source outside them.',
  registered_host: 'evidenceCapture refuses a host the evidence library does not already know; a new host is registered through an approved research task.',
});

function sourceProblems(source, { allowedHosts = null, knownHosts = null } = {}) {
  const problems = [];
  let url = null;
  try { url = new URL(source.url); } catch { problems.push({ rule: 'valid_url', detail: `"${source.url || '(no URL)'}" is not a parseable absolute URL.` }); return problems; }
  if (url.protocol !== 'https:') problems.push({ rule: 'https_only', detail: `${url.protocol} is not https, so the evidence library cannot capture this source.` });
  if (url.username || url.password) problems.push({ rule: 'no_credentials', detail: 'The URL carries credentials.' });
  if (url.port) problems.push({ rule: 'no_port', detail: `The URL names port ${url.port}.` });
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === 'localhost' || url.hostname.endsWith('.local') || url.hostname.includes(':')) problems.push({ rule: 'public_hostname', detail: `${url.hostname} is a literal address or a private name.` });
  if (Array.isArray(allowedHosts) && allowedHosts.length && !allowedHosts.includes(url.hostname)) problems.push({ rule: 'approved_host', detail: `${url.hostname} is not one of the task\u2019s approved hosts (${allowedHosts.join(', ')}).` });
  if (Array.isArray(knownHosts) && !knownHosts.includes(url.hostname)) problems.push({ rule: 'registered_host', detail: `${url.hostname} is not a host the evidence library already knows.` });
  return problems;
}

// ---- Review-integrity measures -----------------------------------------------------------------
// Computed only from the review records supplied in this call. The measure is stated in the data:
// each accepted record contributes one (contributor, reviewer) pair, so a reviewer's share of a
// contributor's acceptances is exactly the records that name both. Nothing is inferred from a name,
// an email or a missing row.
export function assessReviewIntegrity(records = [], options = {}) {
  const share = Number(options.reviewer_share ?? THRESHOLDS.reviewer_share);
  const contributorFloor = Number(options.contributor_acceptances ?? THRESHOLDS.contributor_acceptances);
  const poolSize = Number(options.reviewer_pool_size ?? THRESHOLDS.reviewer_pool_size);
  const poolRecords = Number(options.reviewer_pool_records ?? THRESHOLDS.reviewer_pool_records);
  const list = (Array.isArray(records) ? records : []).filter((record) => record && typeof record === 'object');
  const accepted = list.filter((record) => str(record.decision) === 'accepted');
  const selfReviews = [];
  for (const record of list) {
    const reviewer = str(record.reviewer_id ?? record.reviewer);
    const contributor = str(record.contributor_id ?? record.contributor);
    if (reviewer && contributor && reviewer === contributor) selfReviews.push({ reviewer_id: reviewer, contributor_id: contributor, decision: str(record.decision) });
  }
  const byContributor = new Map();
  for (const record of accepted) {
    const contributor = str(record.contributor_id ?? record.contributor);
    const reviewer = str(record.reviewer_id ?? record.reviewer);
    if (!contributor || !reviewer) continue;
    if (!byContributor.has(contributor)) byContributor.set(contributor, new Map());
    const reviewers = byContributor.get(contributor);
    reviewers.set(reviewer, (reviewers.get(reviewer) || 0) + 1);
  }
  const signals = [];
  const shares = [];
  for (const [contributor, reviewers] of byContributor) {
    const total = [...reviewers.values()].reduce((sum, count) => sum + count, 0);
    for (const [reviewer, count] of reviewers) {
      const value = count / total;
      shares.push({ contributor_id: contributor, reviewer_id: reviewer, accepted: count, contributor_accepted: total, share: Number(value.toFixed(4)) });
      if (value < share || total < contributorFloor) continue;
      signals.push({
        code: 'reviewer_concentration', severity: 'attention', advisory: true,
        subjects: [contributor, reviewer],
        detail: `One reviewer accepted ${count} of ${total} of this contributor\u2019s accepted contributions (${Math.round(value * 100)}%), at or above the ${share} share threshold with at least ${contributorFloor} acceptances. A two-person desk can make this the honest norm, and it is also the shape collusion takes; check whether the same reviewer also proposed the missions, and whether anyone else could have reviewed. Nothing about this signal is proof.`,
        measure: { reviewer_id: reviewer, contributor_id: contributor, accepted: count, contributor_accepted: total, share: Number(value.toFixed(4)), share_threshold: share, acceptance_floor: contributorFloor, source: 'the accepted review records supplied in this call' },
      });
    }
  }
  const reviewers = new Set(accepted.map((record) => str(record.reviewer_id ?? record.reviewer)).filter(Boolean));
  const pool = { distinct_reviewers: reviewers.size, accepted_records: accepted.length };
  if (accepted.length >= poolRecords && reviewers.size <= poolSize && reviewers.size > 0) {
    signals.push({
      code: 'small_reviewer_pool', severity: 'attention', advisory: true, subjects: [...reviewers],
      detail: `The supplied records hold ${accepted.length} accepted contributions reviewed by ${reviewers.size} distinct reviewer${reviewers.size === 1 ? '' : 's'}, at or below the pool size of ${poolSize} for a corpus of at least ${poolRecords}. There is no independent reviewer pool here: an acceptance is only independent if a second human could have taken it. On a new installation this is expected and is dismissed; on a large corpus it is worth a look.`,
      measure: { ...pool, pool_size: poolSize, records_floor: poolRecords },
    });
  }
  for (const record of selfReviews) {
    signals.push({
      code: 'reviewer_is_contributor', severity: 'priority', advisory: true, subjects: [record.reviewer_id, record.contributor_id],
      detail: `A supplied record names the same person as reviewer and contributor (${record.decision || 'no decision'}). The shipped review path refuses self-review, so either these records are a fixture or an identifier is wrong. Nothing here decides which.`,
      measure: { ...record, rule: 'src/platform.js review() refuses a review by the contributor: "An operator cannot review their own or their agents\u2019 contributions."' },
    });
  }
  return {
    advisory: true,
    records: { supplied: list.length, accepted: accepted.length, contributors: byContributor.size, reviewers: reviewers.size },
    measures: { reviewer_shares: shares.sort((a, b) => b.share - a.share || a.contributor_id.localeCompare(b.contributor_id)), reviewer_pool: pool },
    signals,
    thresholds: { reviewer_share: share, contributor_acceptances: contributorFloor, reviewer_pool_size: poolSize, reviewer_pool_records: poolRecords },
    note: accepted.length ? boundaryNote('collusion measure')
      : 'No accepted review records were supplied, so no collusion measure could be computed. That is not a clean bill of health: it means the corpus was not read.',
  };
}

// ---- Reading one proposal ----------------------------------------------------------------------
// A beneficiary field is unusable when the placeholder phrase is all it says. A field that names a
// party and mentions an unresolved attribute ("smallholders whose land tenure is unknown") is a
// named party, so the phrase is removed and the words left behind are counted.
const PLACEHOLDER_PHRASE = /\b(placeholder|tbd|t\.b\.d|to be (?:selected|named|determined|decided|confirmed)|unknown|unspecified|not yet (?:selected|named|determined)|n\/a)\b/gi;
const INTERROGATIVE = /^(what|which|who|whom|whose|when|where|why|how|whether|is|are|does|do|did|can|could|should|would)\b/i;

export function isPlaceholderLabel(value) {
  const remainder = String(value ?? '').replace(PLACEHOLDER_PHRASE, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return (remainder ? remainder.split(/\s+/).filter((word) => !STOPWORDS.has(word)) : []).length <= 1;
}

function sectionIn(text, labels) {
  const pattern = new RegExp(`^\\s*(?:${labels.join('|')})\\s*:\\s*(.+)$`, 'im');
  const match = pattern.exec(String(text ?? ''));
  return match ? match[1].trim() : '';
}

function personLabel(value) {
  if (typeof value === 'string') return value.trim();
  const object = asObject(value);
  return firstString(object.name, object.id);
}

function identity(value) {
  if (typeof value === 'string') return value.trim() ? { id: value.trim(), name: value.trim() } : null;
  const object = asObject(value);
  const id = str(object.id), name = firstString(object.name, object.account, object.id);
  return id || name ? { id, name: name || id } : null;
}

function readSources(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const source = typeof item === 'string' ? { url: item } : asObject(item);
    return {
      number: index + 1,
      url: str(source.url),
      location: firstString(source.location, source.locator),
      date: firstString(source.date, source.declared_date, source.published),
      version: firstString(source.version, source.sha256, source.capture_version),
    };
  });
}

/** The explicit fictional marker: the shipped `demo` flag, or an equivalent declared boolean. */
export function fictionalMarker(proposal = {}) {
  const merged = { ...asObject(proposal), ...asObject(proposal?.mission) };
  return merged.demo === true || merged.demo === 1 || merged.demo === '1' || merged.fictional === true || merged.fictional === 1 || merged.fictional_marker === true;
}

/** The parties one assessment names, so a signal can say whose history it was computed from. */
export function proposalParties(proposal = {}) {
  const merged = { ...asObject(proposal), ...asObject(proposal?.mission), ...asObject(proposal?.task) };
  const owner = identity(merged.owner_id ?? merged.owner);
  const reviewer = identity(merged.reviewer_id ?? merged.reviewer);
  const contributor = identity(merged.contributor_id ?? merged.contributor);
  return { owner, reviewer, contributor, ids: [owner?.id, owner?.name, reviewer?.id, reviewer?.name, contributor?.id, contributor?.name].filter(Boolean) };
}

function readExisting(options = {}) {
  const existing = options.existing;
  if (Array.isArray(existing)) return { entries: existing, reviews: Array.isArray(options.reviews) ? options.reviews : [] };
  const object = asObject(existing);
  const entries = [object.proposals, object.entries, object.leads, object.missions].find((value) => Array.isArray(value)) || [];
  return { entries, reviews: Array.isArray(object.reviews) ? object.reviews : (Array.isArray(options.reviews) ? options.reviews : []) };
}

// The ids and names a signal names, de-duplicated, so a dismissal can compare one identity once.
function assessmentSubjects(parties) {
  return [...new Set([parties.owner?.id, parties.owner?.name, parties.reviewer?.id, parties.reviewer?.name, parties.contributor?.id, parties.contributor?.name].filter(Boolean))];
}

// ---- The assessment ----------------------------------------------------------------------------
/**
 * Read one proposed mission or task plus the records supplied with it and return advisory data.
 * Pure: it reads its arguments, allocates its result and changes nothing else.
 *
 * @param {object} proposal  `{ mission, task }` or the same fields flattened, plus `question`,
 *                           `sources` (or `source_urls`), `contributor_id` and an explicit
 *                           `demo`/`fictional` marker.
 * @param {object} options   `{ existing }`: an array of existing entries, or
 *                           `{ proposals, reviews }`. `known_hosts` is the evidence library's own
 *                           host list, when the caller has it.
 */
export function assessMission(proposal = {}, options = {}) {
  const input = asObject(proposal);
  const merged = { ...input, ...asObject(input.mission), ...asObject(input.task) };
  const scopedAsTask = Boolean(input.task) || merged.instructions !== undefined || merged.allowed_domains !== undefined;
  const { entries, reviews } = readExisting(options);
  const parties = proposalParties(merged);
  const fictional = fictionalMarker(input);
  const missing = [], signals = [], satisfied = [];

  const add = (field, reason, detail = {}) => missing.push({ field, reason, ...detail });
  const known = (field) => satisfied.push(field);
  const requirement = (field) => REQUIRED_FIELDS.find((entry) => entry.field === field)?.requirement || 'brief';
  const failField = (field, reason, detail) => { add(field, reason, { requirement: requirement(field), ...detail }); return false; };

  // The question is the explicit field when present, otherwise the proposal's opening statement: the
  // first sentence of the task instructions, then of the mission summary. A proposal whose opening
  // statement is not interrogative is reported, so an explicit `question` is the way to say otherwise.
  const explicitQuestion = firstString(merged.question);
  const openingStatement = firstString(merged.instructions, merged.summary).split(/(?<=[.?!])\s/)[0] || '';
  const question = explicitQuestion || openingStatement;
  const questionTokens = tokenSetOf(question);
  const title = firstString(asObject(input.mission).title, merged.title);

  if (!title) failField('title', 'No mission or task title is named, and the shipped createMission or createTask would refuse this proposal.'); else known('title');
  const area = firstString(merged.area);
  if (!area) failField('area', 'No mission area is named, and the shipped createMission would refuse this proposal.');
  else if (!MISSION_AREAS.includes(area)) failField('area', `"${area}" is not one of the areas the shipped createMission accepts (${MISSION_AREAS.join(', ')}).`, { value: area });
  else known('area');

  if (!parties.owner) { if (fictional) known('owner'); else failField('owner', 'No named owner is supplied. A mission owner is the human who proposes the mission and records adoption, and an explicit fictional marker is the only alternative.'); }
  else known('owner');

  const beneficiary = personLabel(merged.beneficiary);
  if (fictional) known('beneficiary');
  else if (!beneficiary) failField('beneficiary', 'No named beneficiary is supplied, and the proposal carries no explicit fictional marker. A real mission names who the work is for.');
  else if (isPlaceholderLabel(beneficiary)) failField('beneficiary', `The beneficiary reads "${beneficiary}", which names no party. A placeholder is not a named beneficiary; declare the mission fictional if it is a demonstration.`, { value: beneficiary });
  else known('beneficiary');

  const questionWords = question.trim() ? question.trim().split(/\s+/).length : 0;
  const interrogative = Boolean(question) && (question.trim().endsWith('?') || INTERROGATIVE.test(question));
  if (!question) failField('question', 'No question is stated, and the task instructions and mission summary carry no opening statement to read one from.');
  else if (questionWords < THRESHOLDS.question_minimum_words || !interrogative) {
    failField('question', `"${question}" is a topic or an imperative, not an answerable question: an answerable question names a subject and what would answer it.`, { value: question });
    signals.push({ code: 'question_is_topic', severity: 'attention', advisory: true, subjects: assessmentSubjects(parties), detail: `The stated opening reads "${question}". ${interrogative ? 'It is too short to name a subject and a measure.' : 'It is not interrogative, so it states a topic or an instruction rather than a question.'} A contribution cannot be judged against a topic. Name the question the work will answer, or keep this text as a scope note and supply the question separately.`, measure: { words: questionWords, minimum_words: THRESHOLDS.question_minimum_words, interrogative } });
  } else known('question');

  // A question that only repeats the title or the summary restates a goal instead of researching it.
  if (question && questionTokens.size) {
    const restatement = [[title, 'title'], [firstString(merged.summary), 'summary'], [firstString(merged.goal_statement, typeof merged.goal === 'string' ? merged.goal : ''), 'goal']]
      .filter(([text]) => text && tokenSetOf(text).size)
      .map(([text, field]) => ({ field, score: similarity(questionTokens, tokenSetOf(text)) }))
      .sort((a, b) => b.score - a.score)[0];
    if (restatement && restatement.score >= THRESHOLDS.question_restates_goal) signals.push({ code: 'question_restates_goal', severity: 'attention', advisory: true, subjects: assessmentSubjects(parties), detail: `The stated question shares ${Math.round(restatement.score * 100)}% of its tokens with the proposal\u2019s own ${restatement.field}, so answering it would restate the goal rather than research it.`, measure: { compared_with: restatement.field, score: Number(restatement.score.toFixed(4)), threshold: THRESHOLDS.question_restates_goal } });
  }

  const criteria = firstString(merged.rubric, merged.criteria, merged.evidence_criteria, sectionIn(merged.instructions, ['Acceptance', 'Acceptance criteria', 'Evidence criteria']));
  if (!criteria) failField('evidence_criteria', 'No evidence criteria are stated: the proposal needs the acceptance rubric a reviewer will judge a contribution against.'); else known('evidence_criteria');
  const limits = firstString(merged.limits, merged.limitations, sectionIn(merged.instructions, ['Limitations', 'Limits', 'Limit', 'Stated limits']));
  if (!limits) failField('limits', 'No limits are stated: the proposal must say what the work cannot establish.'); else known('limits');
  const rights = firstString(merged.rights, merged.reuse_rights, sectionIn(merged.instructions, ['Rights', 'Reuse', 'Reuse rights', 'Input rights']));
  if (!rights) failField('rights', 'No reuse rights are stated: the proposal must say what permissions the work relies on and what attribution it carries.'); else known('rights');

  const sources = readSources(merged.sources ?? merged.source_urls);
  const allowedHosts = Array.isArray(merged.allowed_domains) ? merged.allowed_domains.map((host) => str(host)).filter(Boolean) : null;
  if (!sources.length) failField('sources', 'No source register is supplied: a proposal needs at least one named source with an exact location, so a contribution can be checked against a version.');
  else {
    known('sources');
    const undated = sources.filter((source) => !source.date);
    if (undated.length) failField('source_date', `Source ${undated.map((source) => source.number).join(', ')} name no date, so the version a contribution would cite has no declared publication or retrieval date.`, { sources: undated.map((source) => source.number) });
    else known('source_date');
    const unversioned = sources.filter((source) => !source.version);
    if (unversioned.length) failField('source_version', `Source ${unversioned.map((source) => source.number).join(', ')} name no version, so a later capture of the same source could not be told apart from the version the contribution cites.`, { sources: unversioned.map((source) => source.number) });
    else known('source_version');
    for (const source of sources) {
      for (const problem of sourceProblems(source, { allowedHosts, knownHosts: Array.isArray(options.known_hosts) ? options.known_hosts : null })) {
        const code = problem.rule === 'approved_host' ? 'source_host_not_approved' : problem.rule === 'registered_host' ? 'source_host_unknown' : 'source_unfetchable';
        signals.push({ code, severity: 'attention', advisory: true, subjects: assessmentSubjects(parties), source: source.number, detail: `Source ${source.number} (${source.url || 'no URL'}): ${problem.detail} ${SOURCE_RULES[problem.rule] || ''}`.trim(), measure: { rule: problem.rule, url: source.url } });
      }
    }
    const hosts = sources.map((source) => { try { return new URL(source.url).hostname; } catch { return ''; } }).filter(Boolean);
    if (hosts.length && hosts.every((host) => FRAMEWORK_SOURCE_HOSTS.includes(host))) signals.push({
      code: 'framework_only_sources', severity: 'attention', advisory: true, subjects: assessmentSubjects(parties),
      detail: `Every named source is a framework or catalog reference (${[...new Set(hosts)].join(', ')}), so the register names no subject evidence the platform retains. That is the honest state of a scoping proposal whose country or subject evidence has not been collected yet: record it as a collection gap, or name the evidence once it exists.`,
      measure: { hosts: [...new Set(hosts)], framework_hosts: [...FRAMEWORK_SOURCE_HOSTS] },
    });
  }

  if (scopedAsTask && !allowedHosts?.length) failField('source_hosts', 'This task proposal names no approved source hostname, and the shipped createTask refuses a real task without an explicit hostname list.');
  else if (scopedAsTask) known('source_hosts');

  if (!parties.reviewer) failField('reviewer', 'No reviewer is designated, and the shipped createMission requires an active human reviewer.');
  else known('reviewer');
  const reviewerIsOwner = Boolean(parties.reviewer?.id && parties.owner?.id && parties.reviewer.id === parties.owner.id);
  const reviewerIsContributor = Boolean(parties.reviewer?.id && parties.contributor?.id && parties.reviewer.id === parties.contributor.id);
  if (reviewerIsOwner) failField('reviewer_independence', 'The designated reviewer is the mission owner, so the review could not be independent.', { owner: parties.owner.id, reviewer: parties.reviewer.id });
  else if (reviewerIsContributor) failField('reviewer_independence', 'The designated reviewer is the contributor, so the review would be self-review.', { contributor: parties.contributor.id, reviewer: parties.reviewer.id });
  else if (parties.reviewer && parties.owner) known('reviewer_independence');
  if (reviewerIsOwner) signals.push({ code: 'reviewer_is_owner', severity: 'priority', advisory: true, subjects: [parties.owner.id], detail: `The designated reviewer is also the mission owner (${parties.reviewer.name}). The shipped review path refuses a review by the contributor and the shipped adoption path keeps the reviewer and the owner apart, so this proposal would need a documented exception or a second human. A demonstration mission may legitimately work this way; a real one may not.`, measure: { owner_id: parties.owner.id, reviewer_id: parties.reviewer.id, rule: 'src/platform.js review() and adoption() refuse a collapsed role' } });
  if (reviewerIsContributor) signals.push({ code: 'reviewer_is_contributor', severity: 'priority', advisory: true, subjects: [parties.reviewer.id], detail: `The designated reviewer is also the contributor (${parties.reviewer.name}). The shipped review path refuses self-review outright: "An operator cannot review their own or their agents\u2019 contributions."`, measure: { contributor_id: parties.contributor.id, reviewer_id: parties.reviewer.id } });

  if (!fictional && !parties.owner && !beneficiary) signals.push({ code: 'fictional_marker_absent', severity: 'attention', advisory: true, subjects: [], detail: 'The proposal names neither an owner nor a beneficiary and carries no explicit fictional marker. The shipped `demo` flag is the explicit marker: set it for a demonstration, or name the owner and the beneficiary for a real mission.', measure: { demo: false } });

  const duplicates = duplicateMatches(merged, entries, options);
  if (duplicates.above_threshold) {
    const top = duplicates.matches[0];
    signals.push({ code: 'near_duplicate', severity: 'attention', advisory: true, subjects: assessmentSubjects(parties), detail: `${duplicates.above_threshold} existing entr${duplicates.above_threshold === 1 ? 'y is' : 'ies are'} textually close to this proposal at or above the ${duplicates.threshold} threshold; the closest is ${top.id} at ${top.score}. The tokens that distinguish them are listed with each match. This is a signal for a human: confirm that the difference is the intended one. It is never an automatic rejection, and two proposals may legitimately share a template when their subject differs.`, measure: { threshold: duplicates.threshold, above_threshold: duplicates.above_threshold, closest: { id: top.id, score: top.score, plain_score: top.plain_score } } });
  }

  const integrity = assessReviewIntegrity(reviews, options);
  const partyIds = new Set(assessmentSubjects(parties));
  const relevant = integrity.signals.filter((signal) => (signal.subjects || []).some((id) => partyIds.has(id)));
  for (const signal of relevant) signals.push({ ...signal, detail: `${signal.detail} This was computed from the review records supplied with this proposal and concerns a party it names.` });

  return {
    kind: 'mission_quality_assessment',
    version: MISSION_QUALITY_VERSION,
    advisory: true,
    scope: scopedAsTask ? 'task' : 'mission',
    fictional,
    subject: { id: firstString(merged.id), title: firstString(asObject(input.mission).title, merged.title), area, owner: parties.owner, reviewer: parties.reviewer, contributor: parties.contributor, beneficiary: beneficiary || (fictional ? 'Declared fictional; no beneficiary named.' : '') },
    completeness: {
      required_fields: REQUIRED_FIELDS.filter((entry) => entry.field !== 'source_hosts' || scopedAsTask).map((entry) => entry.field),
      satisfied,
      missing: missing.map((entry) => entry.field),
      complete: missing.length === 0,
      note: 'Complete means only that each required field is present and usable. It is not an approval, a priority, a readiness decision or a promise that a reviewer will accept the proposal.',
    },
    missing,
    signals,
    duplicates,
    review: { records_supplied: integrity.records.supplied, accepted_records: integrity.records.accepted, checked: integrity.records.accepted > 0, measures: integrity.measures, thresholds: integrity.thresholds, note: integrity.note },
    ladder: { stages: [...STATUS_LADDER], reached: scopedAsTask ? 'owner-approved mission / claimed task (proposed)' : 'owner-approved mission (proposed)', blocked: LADDER_BLOCKED.map((entry) => ({ ...entry })), note: 'A signal here says nothing about any stage after this one. The seeded country proposals are proposals, not studies; no real pilot or beneficiary is selected; a mission owner\u2019s recorded adoption declaration is a declaration, not implementation; and external implementation and a measured outcome both wait on a consenting beneficiary.' },
    thresholds: { ...THRESHOLDS, duplicate_similarity: duplicates.threshold },
    authority: { ...AUTHORITY },
    boundaries: { ...BOUNDARIES },
    severed_units: { coins: false, compute_credits: false, money: false, carbon_credits: false, note: 'This module neither reads nor writes any unit of account and proposes no conversion between any two.' },
  };
}

// ---- The human false-positive path -------------------------------------------------------------
// A signal is dismissed by a named human who records why. The dismissal is a declaration by that
// human, kept beside the signal; it is not a finding by this module, it changes no status, record or
// score, and `advisory` stays true because the signal was always only advisory. This module
// authenticates nobody: it compares the reviewer identity it is given with the ids the signal names.
export const DISMISSAL_KIND = 'mission_quality_signal_dismissal';

export function dismissSignal(signal, { reviewer, note, at = new Date().toISOString(), parties = null } = {}) {
  const source = asObject(signal);
  if (!source.code) fail('Only a returned signal can be dismissed.');
  const who = personLabel(reviewer);
  if (!who) fail('A dismissal needs the identity of the human who checked the signal.');
  const reason = str(note);
  if (!reason) fail('A dismissal needs a short note saying what was checked and why the signal is not a problem.');
  const reviewerId = str(asObject(reviewer).id);
  const subjects = parties === null ? (Array.isArray(source.subjects) ? source.subjects : []) : (Array.isArray(parties) ? parties : []);
  if (reviewerId && subjects.includes(reviewerId)) fail('An independent human must dismiss a signal; the named reviewer is one of the parties the signal concerns.', 403);
  return {
    ...source, advisory: true,
    advisory_note: 'Dismissed by a human: the signal was advisory when it was returned and it remains advisory, not decided by this module.',
    dismissal: { kind: DISMISSAL_KIND, code: source.code, reviewed_by: who, reviewer_id: reviewerId, note: reason, at, declaration_only: true, changes_nothing: true, evidence_retained: false },
  };
}

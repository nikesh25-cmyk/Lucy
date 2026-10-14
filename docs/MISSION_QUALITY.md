# Mission quality and abuse signals

`src/mission-quality.js` turns a **proposed** mission or task, plus the records a caller hands it,
into **advisory signals a human can act on**. It reads no database, opens no file, fetches no source
and writes nothing. It changes no status, approves or rejects nothing, awards or withholds no coin,
and has no opinion about what a reward should be. Every entry it returns carries `advisory: true`,
and a named independent human can dismiss any of them.

`assessMission` is a pure function of its arguments: it reads them, allocates its result and changes
nothing else. `tests/mission-quality.test.js` freezes its inputs so any write would throw, asserts
that nine tables and the audit chain are byte-identical across a call, and asserts that the same input
produces the same output. The one other exported function that does anything, `dismissSignal`, records
a human's declaration and takes its timestamp from an `at` argument (defaulting to the clock, exactly
as a `created_at` column does elsewhere in the platform).

## Where this sits in the state ladder

| # | stage | what this module may say |
| --- | --- | --- |
| 1 | research lead (a proposal) | **read only.** A signal about a proposal is a signal about a proposal, not a study and not a result. |
| 2 | owner-approved mission | **the stage this module reads.** `assessMission` reports which required fields are absent or unusable and which quality patterns are worth a look. |
| 3 | claimed task | nothing. A claim is a person's decision, made elsewhere. |
| 4 | versioned submission | nothing. |
| 5 | independent acceptance | nothing. Acceptance is the shipped human review path; see `docs/EVIDENCE_REVIEW.md`. |
| 6 | owner adoption declaration | nothing. An adoption is the mission owner's own recorded declaration with their own supporting evidence; it is **not** implementation. |
| 7 | externally evidenced implementation | **blocked on a consenting beneficiary.** No external implementation evidence exists in this build. |
| 8 | measured outcome | **blocked on a consenting beneficiary.** No outcome is measured here. |

Three facts the module's wording never contradicts:

- The seeded ~1,015 country and pilot entries are **proposals, not studies**. Nothing has been
  researched, accepted or adopted by them.
- **No real pilot, beneficiary, buyer, partnership or recipient is selected** by anything here.
- An **adoption declaration is a declaration, not implementation**, and no signal in this module
  says otherwise.

## The input

```js
assessMission(
  { mission: {…}, task: {…}, question, limits, sources, contributor_id, demo },
  { existing: [ … ] | { proposals: […], reviews: […] }, known_hosts: […] }
)
```

- `mission` and `task` are the shipped shapes (`src/database.js`): `missions(id, title, area, summary,
  owner_id, beneficiary, reviewer_id, rubric, status, demo, created_at)` and
  `tasks(id, mission_id, title, instructions, rights, allowed_domains, version, status)`.
- The fields may be flattened at the top level instead, or mixed. An explicit nested `mission`/`task`
  object wins over a top-level key of the same name.
- `question` is the answerable question. When it is absent, the module reads the first sentence of the
  task `instructions` and then of the mission `summary`. A proposal whose opening statement is not
  interrogative is reported, so the way to say "the question lives elsewhere in this text" is to
  supply `question` explicitly.
- `sources` (or the shipped `source_urls`) is the source register. A bare URL string is accepted and
  counts as a source that names no date and no version.
- `demo: true` (the shipped `missions.demo` flag) or `fictional: true` is the **explicit fictional
  marker**. A prose mention of "fictional" is deliberately not a marker: only a declared boolean can
  waive a required field.
- `existing` is the corpus the proposal is compared against: an array of entries, or
  `{ proposals, reviews }`. `existing.reviews` is what the collusion measures read; nothing else is
  read for them.
- `known_hosts`, when the caller has the evidence library's own host list, enables the
  `source_host_unknown` signal.

The result carries `missing`, `signals`, `duplicates`, a `completeness` summary, the review measures
that were computed, the ladder and its blocked stages, every threshold that was used, the authority
statement and the boundaries. `completeness.complete` means **only** that each required field is
present and usable. It is not an approval, a priority, a readiness decision or a promise that a
reviewer will accept the proposal, and the note beside it says so.

## The required fields

`missing` lists each required field that is absent or unusable, with the field name, the reason, and
where the rule comes from. An empty string, a blank and a placeholder are all unusable. `satisfied`
lists the fields that were read and used.

| field | requirement | what satisfies it | why |
| --- | --- | --- | --- |
| `title` | shipped | non-empty title | `createMission` and `createTask` refuse a proposal without one. |
| `area` | shipped | one of the twelve listed areas | `createMission` accepts only its own list. |
| `owner` | brief | a named owner (id or name), **or** the fictional marker | The owner proposes the mission and records adoption. |
| `beneficiary` | brief | a named beneficiary, **or** the fictional marker | A real mission names who the work is for. A placeholder such as "to be selected" names nobody. |
| `question` | brief | an interrogative statement of at least four words | A topic, an imperative or a restatement of the goal cannot be answered, so no contribution can be judged against it. |
| `evidence_criteria` | brief | `rubric`/`criteria`, or an `Acceptance:`/`Acceptance criteria:`/`Evidence criteria:` section | The criterion a reviewer judges a contribution against. |
| `limits` | brief | `limits`/`limitations`, or a `Limitations:`/`Limits:`/`Limit:`/`Stated limits:` section | What the work cannot establish must be stated before the work, not after it. |
| `rights` | brief | `rights`/`reuse_rights`, or a `Rights:`/`Reuse rights:`/`Input rights:` section | The permissions the work relies on and the attribution it carries. |
| `sources` | brief | at least one named source with an exact location | A source register is what a reviewer checks a contribution against. |
| `source_date` | brief | every named source carries a date | A version with no date cannot be placed in time. |
| `source_version` | brief | every named source names the version it will pin | Otherwise a later capture of the same source could be mistaken for what was cited. |
| `reviewer` | brief | a designated reviewer (id or name) | An independent human must accept a contribution before it counts. |
| `reviewer_independence` | brief | reviewer ≠ owner, and reviewer ≠ contributor | A review by the owner or by the contributor is not independent. |
| `source_hosts` | shipped | a non-empty `allowed_domains` list, **for a task proposal** | `createTask` refuses a real task that names no approved source hostname. |

Two of these fields are *present but unusable* rather than absent, and are reported the same way: an
`area` outside the shipped list, and a `reviewer` who is the owner or the contributor. Both also
appear as signals, because the same fact answers two different questions: `missing` answers "is this
proposal specified?", and `signals` answers "what should a human look at?". The two never disagree.

**A demonstration still needs a reviewer.** The fiction exemption is written for the owner and the
beneficiary only. A practice mission that says it is fictional needs no owner and no beneficiary, but
it still needs a second human to review it, and it still needs a question, criteria, limits, rights
and a source register.

## The signals

Every signal has a stable `code`, a `severity`, a plain-language `detail`, `advisory: true`, the
`subjects` whose history it was computed from, and the `measure` it was computed with — the actual
counts, shares and scores, never a bare verdict.

| code | severity | what is measured |
| --- | --- | --- |
| `near_duplicate` | attention | How many existing entries share the proposal's normalised text at or above the threshold, with the closest id and score. Details are in `duplicates`. |
| `question_is_topic` | attention | The stated opening is not interrogative, or is fewer than four words. |
| `question_restates_goal` | attention | The stated question shares ≥ 80% of its tokens with the proposal's own title, summary or goal. |
| `reviewer_is_owner` | priority | The designated reviewer is the mission owner. The shipped adoption path keeps those two roles apart. |
| `reviewer_is_contributor` | priority | The designated reviewer is the contributor. The shipped review path refuses self-review outright. |
| `reviewer_concentration` | attention | One reviewer accepted ≥ 80% of one contributor's acceptances, with at least three acceptances. |
| `small_reviewer_pool` | attention | At most two distinct reviewers across at least ten accepted records. |
| `source_unfetchable` | attention | A named source fails a shipped evidence rule: not HTTPS, credentials, a port, a literal address, localhost or a `.local` name, or an unparseable URL. |
| `source_host_not_approved` | attention | A named source is outside the task's `allowed_domains`, which the shipped submission path refuses. |
| `source_host_unknown` | attention | A named source is on a host the evidence library does not know. Only raised when the caller supplies `known_hosts`. |
| `framework_only_sources` | attention | Every named source is a framework or catalog reference (`sdgs.un.org`, `unstats.un.org`), so the register names no subject evidence the platform retains. |
| `fictional_marker_absent` | attention | The proposal names neither an owner nor a beneficiary and carries no explicit marker, so it is neither a real nor a declared demonstration mission. |

The source rules are **mirrored from the shipped platform**, not invented: `valid_url`,
`https_only`, `no_credentials`, `no_port`, `public_hostname` mirror `approvedEvidenceUrl`;
`approved_host` mirrors `createTask` and `submit`; `registered_host` mirrors
`evidenceCapture`. `SOURCE_RULES` names each rule in words and every signal quotes the rule it
applied. A test drives the real `submit` with a source outside the approved hosts and asserts the
same refusal the signal describes.

Severities say how strongly the desk suggests a human look; none of them blocks anything. Even a
`priority` signal decides nothing.

## Near-duplicates, and what a score means

Two entries are compared by the words they share, never by their titles. Text is normalised with
NFKC, case folding, punctuation-to-space and a stopword filter, and compared with the **Dice
coefficient over the two token sets** — the same measure with and without corpus weighting:

- `score` is the weighted value, and it is the one compared with the threshold.
- `plain_score` is the same coefficient with all tokens weighted equally.
- Each weight is a smoothed inverse document frequency, `ln(1 + N / (1 + df(t)))`, computed from the
  corpus supplied in the call. Shared boilerplate counts for little; a token that only one entry
  carries counts for much.

Each match reports the id, both scores, the threshold used, the number of shared tokens, the tokens
that actually distinguish the two entries (highest weight first), and no verdict at all. At most five
matches are returned, highest score first, with `considered` and `above_threshold` beside them. The
same finding appears in `signals` as `near_duplicate` so a caller can render one advisory list.

**A near-duplicate is a signal for a human, never an automatic rejection.** Two proposals may
legitimately share a template when their subject differs, and the shipped corpus is built exactly
that way.

### The threshold, and the measurement behind it

`THRESHOLDS.duplicate_similarity = 0.6`. It is an editorial choice inside a band measured on the
shipped corpus, and the measurement is in the table below. Measured on base commit `30d8f09` against
the seeded `research_leads` corpus (**1,015 proposals**, median 165 normalised tokens per entry,
514,605 pairs):

| class of pair | pairs | min score | max score |
| --- | --- | --- | --- |
| one concern template, one goal, another subject | 21,629 | **0.8390** | 0.9826 |
| subject, goal and concern all differ ("unrelated work") | 195,564 | 0.0374 | **0.4464** |
| same subject, another concern (different stage) | 5,094 | 0.0526 | 0.7229 |
| same subject, another goal (baseline across goals) | 6,128 | 0.3166 | 0.9563 |
| everything else | 286,190 | 0.0607 | 0.9124 |

Per entry, the closest neighbour is either **≥ 0.867** (1,009 of 1,015 entries) or **≤ 0.415**
(the six Nepal tea pilot proposals, at 0.363–0.415). The widest gap the corpus shows between
unrelated work and work that shares a template is therefore **0.4464 → 0.7229**, and 0.6 sits inside
it.

Two further anchors show why 0.6 rather than something higher or lower:

- A **copy of a shipped proposal wrapped in its own summary, rubric, limits, rights and question**
  scores **0.748–0.828** across the shipped concern families. A higher threshold would let such a
  copy pass unnoticed. The four wrapped copies the calibration test asserts score 0.7482
  (`NP-2-baseline`), 0.7814 (`NP-2-destination`), 0.8018 (`NP-17-institutions`) and 0.8099
  (`BD-2-interventions`), each with the copied proposal still its closest match.
- A **new, fully specified mission about the same subject as a shipped proposal** scores **0.398**,
  and a proposal that merely repeats an existing title, or reproduces a fragment of it, stays below
  0.6 as well. A lower threshold would start flagging work that is merely related.

**No threshold separates the classes, and the module does not pretend otherwise.** A pair of shipped
proposals for the same country under two different goals reaches 0.9563, and a pair for one country
under two different concerns reaches 0.7229: the corpus is built from four concern templates, so most
entries share most of their text with a sibling. That is a **true measurement of the corpus**, and it
is reported as such: **1,009 of the 1,015 entries have at least one match at or above the threshold.**
Wave C should read that rate as the corpus finding it is — before generating volume, decide whether
per-country template copies are the volume you want — and not as a defect in the measure or in any
individual proposal. The `distinguishing` tokens are reported with every match so that decision takes
one glance: for two country baselines, the distinguishing tokens are the country and the goal.

The threshold is re-measured by a test. `tests/mission-quality.test.js` recomputes the three classes
above on the shipped corpus and asserts that every same-template pair clears the threshold, that no
unrelated pair reaches it, and that related-but-different pairs straddle it. If the corpus changes,
that test says the threshold needs reviewing rather than silently drifting.

### What the measure cannot do

- It cannot tell "the same question reworded" from "a different question on the same template". Both
  look alike to a bag-of-words measure; the distinguishing tokens are the human's evidence, not the
  module's.
- A proposal that reproduces only part of an existing entry may score below the threshold, because
  the measure covers the whole text and not the quorum of a fragment.
- It is not a claim about meaning. Two entries with opposite conclusions in similar words score high.

## Reviewer collusion, computed only from the records supplied

`assessMission` reads `existing.reviews`; `assessReviewIntegrity(records, options)` exposes the same
measure directly. **Nothing is inferred from a name, an email or a missing row.** An empty record set
produces no signal at all and the report says plainly that this is not a clean bill of health — it
means the corpus was not read.

Each accepted record contributes exactly one `(contributor, reviewer)` pair. From those pairs:

| measure | rule | why this rule |
| --- | --- | --- |
| `reviewer_concentration` | one reviewer's share of one contributor's acceptances is ≥ 0.8 **and** that contributor has ≥ 3 acceptances | A two-person desk can legitimately look like this, so the floor keeps the signal off small history. Three acceptances is the point at which a pattern rather than an occasion exists. |
| `small_reviewer_pool` | ≤ 2 distinct reviewers across ≥ 10 accepted records | Ten acceptances is the shipped per-operator daily coin limit (100 coins ÷ 10 per acceptance), so it is a corpus the platform itself treats as a day's real work. Under three reviewers there is no pool from which an acceptance could have been independent. |
| `reviewer_is_contributor` | a supplied record names the same person as reviewer and contributor | The shipped `review()` refuses self-review, so such a record is a fixture or a wrong identifier. |

Only records whose `decision` is `accepted` count toward concentration and the pool. Self-review is
checked on every supplied record. Every signal reports the counts it was computed from, and the
report keeps `measures.reviewer_shares` even when nothing crosses a threshold.

In an `assessMission` call, only the integrity signals that concern a party the proposal itself names
are carried into its `signals`; the full corpus view stays available through `assessReviewIntegrity`.

Only `decision: 'accepted'`, `reviewer_id` and `contributor_id` are read. The measure is a **signal,
not proof of collusion**: it shows that a structure exists in which independent review could not have
happened, and a human decides what that means.

## The human false-positive path

**Every signal is dismissible by a named independent human, and dismissing one changes nothing.**

```js
const dismissed = dismissSignal(report.signals[i], {
  reviewer: { id: account.id, name: account.name },
  note: 'Checked against the mission record: this is the declared practice mission, so the reviewer and the owner are the same person by design.',
});
```

`dismissSignal` returns a copy of the signal with `dismissal: { kind: 'mission_quality_signal_dismissal',
code, reviewed_by, reviewer_id, note, at, declaration_only: true, changes_nothing: true,
evidence_retained: false }`. The original signal is untouched. `advisory` stays `true`, because the
signal was advisory when it was returned and this module never decides anything: a dismissal is a
**declaration by the named human**, in the same spirit as a reviewer's recorded assessment in
`src/review-assessment.js`.

- A dismissal needs a named human and a note saying what was checked. Without either, the call is
  refused with a `400`.
- A human who is one of the parties the signal names cannot dismiss it: the call is refused with a
  `403`. The module authenticates nobody — it compares the identity it is given with the ids the
  signal carries.
- Because the module writes nothing, **storing** the dismissal is the caller's job. The intended
  pattern is to keep it beside the signal as readable text, exactly as a review assessment and an
  adoption declaration are kept: no schema change, and the record reads back in plain language. The
  UI slice is described in `docs/handoff/task-c-mission-quality.md`.

## What this module deliberately does not do

- **No authority.** It changes no status, approves or rejects no contribution, awards or withholds no
  coin, holds nothing, and writes nothing. It has no `apply`, no `save` and no writer of any kind;
  the exports are named so that a test can assert that.
- **No coin decision.** The coin decision stays with the shipped independent-acceptance predicate in
  `src/coins.js` — the same eligibility SQL, the same one-receipt-per-task uniqueness, the same hash
  chain and the same hundred-coin daily operator limit. This module neither calls it nor restates it.
- **No unit of account.** Nothing here touches NemoCoins, compute credits, real money or verified
  carbon credits, and it proposes no conversion between them. The report says so, in words, per unit.
- **No fetching.** It does not retrieve a source, open a stored capture, compare a hash or verify a
  claim. It reads the source *rules* — mirrored constants — and reports which one a proposal's
  register would fail.
- **No judgement of importance.** It does not score a question's value, rank proposals, or say which
  work should be done. It reports specified-ness, adjacency and structure.
- **No claim about meaning, intent or misconduct.** Duplicates and collusion are patterns in text and
  in records. They are not proof, and the detail text of every such signal says so.
- **No schema, no migration, no storage.** The module is one new file and imports nothing at all.

## Verification

`tests/mission-quality.test.js` (15 tests) covers:

- a fully specified real mission with no missing field and no signal, plus each required field
  reported in turn with its own name and reason, and no collateral field reported because of one
  defect;
- a demonstration accepted only with the explicit marker, a prose mention not counting as one, and
  the marker waiving nothing else;
- a topic instead of a question flagged, an imperative flagged, a short real question and a long real
  question not flagged, and a goal restated as a question flagged separately;
- a near-duplicate reported with the matched id and the score that was computed, a byte-identical
  copy scoring exactly 1, a wrapped copy still caught, and a genuinely distinct proposal not
  reported;
- two negative cases where a naive rule would flag wrongly: **an identical title with different text**
  (a title-keyed rule flags it; the text measure does not) and **one reviewer covering 100% of a
  contributor's two acceptances** (a share-only rule flags it; the acceptance floor does not), plus a
  beneficiary that names a party and mentions an unresolved attribute;
- the reviewer-is-owner and reviewer-is-contributor patterns flagged, and reported as unusable
  fields; reviewer concentration and a small pool computed from the supplied records only;
- the shipped source rules signalled with their rule names and checked against the real `submit`
  refusal for the same source;
- the module's purity: frozen inputs, nine table counts and the audit chain unchanged across calls,
  identical output for identical input, no signal carrying a status, a decision, an amount or an
  authority, and no exported name that could write;
- the mirrored area list still accepted by the real `createMission`, and an unlisted area still
  refused;
- the duplicate threshold re-measured on the shipped corpus.

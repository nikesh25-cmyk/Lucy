# Task C handoff — wiring the mission-quality signals into the reviewer path

This slice takes the module delivered in `src/mission-quality.js` (see
[task-c-mission-quality.md](task-c-mission-quality.md) and [MISSION_QUALITY.md](../MISSION_QUALITY.md))
and puts it in front of a human reviewer: one read-only route, one reviewer-facing panel, and nothing
else. It is **advisory throughout and gates nothing**. No status, record, coin, audit entry or score
changes because a signal exists, and no mission, task, claim, submission, review or adoption behaves
differently. The schema is unchanged at **22**.

## What was delivered

| artifact | change |
| --- | --- |
| `server.js` | `/quality` added to the hand-maintained `gets` table and to the GET dispatch; `/src/mission-quality.js` added to the served-file table so the browser can import the same module. |
| `src/platform.js` | `missionQuality(actor, options)` — assembles the proposal from stored records and returns `assessMission(...)` verbatim. Nothing else in the file changed. |
| `app.js` | The "Mission quality signals — advisory only" panel beside the reviewer workbench, on the review card for a pending version. |
| `scripts/browser-suite.mjs` | New scenario `mission-quality-advisory-signals` (registry 44 → **45**). |
| `tests/mission-quality-http.test.js` | New: 6 HTTP tests for the route, its refusals, its purity and the gating proof. |
| `tests/browser-suite.test.js` | Registry count 44 → 45, and the new scenario id added to the "must remain" list. |
| `docs/API.md` | New section "Advisory mission-quality signals". |
| `docs/MISSION_QUALITY.md` | New section "The wired reviewer path", plus the verification list. |
| `docs/handoff/task-c-quality-wiring.md` | This file. |

- **Base commit: `840648c`** (`Make the syntax gate cover the tree instead of a hand-written list`)
  on `integration/deepseek-master-2026-10-14`.
- **Files changed:** exactly the nine files above. `src/mission-quality.js` was **read, not touched**;
  so were `src/database.js`, `src/recovery.js`, `src/coins.js`, `content/**`, `catalog/**`,
  `native/**`, every other test, the stylesheets, `HANDOFF.md`, `docs/VERIFICATION.md` and
  `outputs/Lucy`.
- **Patch:** `git format-patch` to `../task-c-quality-wiring.patch`.
- **No test was deleted, weakened or skipped.** The unit suite grew 896 → 902 tests; the browser
  suite grew 44 → 45 scenarios.

## The route, and its audience

```text
GET /api/v1/quality?task=<task id>        # the task proposal, with its mission
GET /api/v1/quality?mission=<mission id>  # the mission proposal alone
```

- **Audience:** an operator session holding the **`reviewer` or `admin`** role — the review
  workbench's audience, enforced with the shipped `role(actor, ['admin','reviewer'])` helper. There
  is no public form of the route: `/quality` is deliberately absent from the `publicRoute` list.
- **Refusals:** no session **401**; member, moderator or any other role **403**; an unknown task or
  mission id **404**; neither parameter **400**; `POST /quality` **405** with `Allow: GET`.
- **Why the route tables matter:** `server.js` keeps its route maps by hand, so a route that is in
  `gets` but not in the GET dispatch falls through to `platform[route.slice(1)](actor)` and would fail
  at runtime. The new route is registered in both places, plus the served-file table for the browser
  import.

### What the assessment is assembled from

| input | source | why |
| --- | --- | --- |
| `mission` | the `missions` row | title, area, summary, owner, beneficiary, reviewer, rubric, `demo` flag |
| `task` | the `tasks` row for `?task=` | title, instructions, rights, `allowed_domains` (a task-scoped read returns `scope: 'task'`) |
| `sources` | the `research_leads` row linked to the mission or task | the source register the shipped research path recorded; a mission created by hand has no lead and therefore no register, which the module reports as `sources` missing |
| `existing` (the duplicate corpus) | every stored `research_leads` row **except** the one linked to this mission or task | a proposal is never reported as textually close to the entry it came from |
| `existing.reviews` | **not supplied** | see below |
| `known_hosts` | **not supplied** | see below |

Two deliberate omissions, each with a reason rather than an oversight:

- **No review records.** The collusion measures (`reviewer_concentration`, `small_reviewer_pool`)
  read `existing.reviews`. Supplying them would put the platform's whole review history — other
  contributors' reviewer/contributor pairs — inside a response any reviewer can read. The route
  therefore supplies none, `review.checked` is `false`, and the module's own note is returned:
  *"No accepted review records were supplied, so no collusion measure could be computed. That is not a
  clean bill of health: it means the corpus was not read."* A reviewer-facing collusion view is a
  separate, deliberate design decision.
- **No `known_hosts`.** The evidence library's host list (`SELECT DISTINCT host FROM evidence_sources`)
  holds only the hosts captured through the **curator** path, and `evidenceCapture` is the only path
  that refuses an unknown host. The **submission** path (`registerCapture`) registers a new host
  instead of refusing it. Passing that list would therefore raise `source_host_unknown` — whose text
  says "a new host is registered through an approved research task, not by citing it" — on the
  strength of the library's sparseness and not on any rule the shipped path applies. The three source
  rules mirrored from `approvedEvidenceUrl`, `createTask` and `submit` are unaffected and are still
  reported (`source_unfetchable`, `source_host_not_approved`, `framework_only_sources`).
  `docs/MISSION_QUALITY.md` records the same reasoning.

### What it returns

`assessMission`'s result **verbatim and unwrapped** — `kind`, `version`, `advisory`, `scope`,
`fictional`, `subject`, `completeness`, `missing`, `signals`, `duplicates`, `review`, `ladder`,
`thresholds`, `authority`, `boundaries`, `severed_units`. No wrapper object, no extra keys, no
summarising: `tests/mission-quality-http.test.js` asserts the exact top-level key set, so a wrapper
cannot be added later without failing a test. The scores (`duplicates.matches[].score`,
`.plain_score`), the threshold, the per-signal `measure` objects and every named threshold are all
returned.

**It writes nothing.** `missionQuality` calls one pure function; `src/mission-quality.js` has no
writer, no store and no database handle. `tests/mission-quality-http.test.js` reads the route twice
and asserts that nine table counts, the settings table, the mission row, the task row and the audit
chain are unchanged, and that two readings are byte-identical.

## What the reviewer sees

The panel is rendered in `app.js` on the **review card for a pending version**, immediately below the
reviewer workbench disclosure and above the review form — the surface where the decision is actually
made. It is a disclosure that loads its own read on demand; nothing is fetched until a reviewer asks.

Each signal is shown with the module's data, not a paraphrase:

- the **code** as text (`near_duplicate`, `question_is_topic`, `source_unfetchable`, …),
- the **severity** as a word (`attention`/`priority`/`informational`) with `· advisory`, using the
  plain badge and never the warning-styled one,
- the module's **plain-language `detail`**, verbatim,
- the **`measure`** it was computed from, as a label/value list of the actual counts, shares, scores
  and thresholds.

Above them the panel states, in the module's own words, that this is advisory and that the coin
decision stays with the shipped independent-acceptance predicate. Below them it lists the required
fields that are satisfied and missing, the duplicate comparison (`considered`, `above_threshold`,
each match with `score`, `plain_score`, shared tokens and the distinguishing tokens), the thresholds
that were used, the module's boundary sentences and the ladder note.

**No verdict is presented.** The panel has no accept, reject, approve, hold, block or priority
control; the only controls are the refresh button and, where the module accepts the reader, the
check-off form. Nothing is coloured as a verdict, `completeness.complete` is not shown as an approval,
and the panel does not sort, rank or badge proposals. The file keeps its no-`innerHTML` rule: every
node is built with the existing `element`/`paragraph`/`disclosure`/`field` helpers.

## The dismissal's honest scope

The **"Checked — not a problem"** control calls `dismissSignal` itself — the same pure function the
module exports, imported by `app.js` from `/src/mission-quality.js`. Two consequences follow, and the
interface states both rather than implying them:

1. **The declaration is kept in the browser session and is stored nowhere.** `dismissSignal` is pure:
   it returns a copy of the signal with a `dismissal` record and writes nothing. The panel keeps that
   record in memory, keyed by task and signal, shows it with the human's name, the note and the time
   against the signal it dismissed, and says, in the panel: *"Kept in this browser session only.
   Nothing was written: no record, no status, no score and no coin changed, and this check disappears
   when the page is reloaded or you sign out."* There is **no dismissals table**, the schema stays at
   **22**, and the browser scenario asserts that the whole store and the audit chain are unchanged
   across the dismissal, that no `%dismiss%` table exists, and that a reload forgets the check-off.
   The record is also discarded when the session ends, because the operator-session reset clears it.
   **Nothing in the interface suggests the dismissal was recorded.**
2. **A human the signal names cannot dismiss it.** `dismissSignal` refuses with **403** when the
   reviewer's id is one of the signal's `subjects` — *"An independent human must dismiss a signal; the
   named reviewer is one of the parties the signal concerns."* Every signal about a *proposal* names
   the proposal's owner and reviewer, so **the mission's own assigned reviewer cannot check off the
   signals about their own mission**. The interface therefore asks the module, with a pure probe call,
   whether this reader may dismiss this signal, and where the answer is no it renders the module's own
   sentence instead of a control that could never work. The human who *can* check a signal off is an
   independent reviewer or administrator — one who is not the proposal's owner, reviewer or
   contributor — and the browser scenario proves that path end to end with the administrator.
   This is the module's independence rule showing through the interface, not a UI choice, and it is
   reported here rather than smoothed over.

### The follow-up: how a dismissal could be recorded (not done in this slice)

Recording a dismissal is a **schema change**, and this slice makes none. The additive change to
specify for a follow-up:

```sql
CREATE TABLE IF NOT EXISTS mission_quality_dismissals(
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('mission','task','research_lead')),
  subject_id TEXT NOT NULL,
  signal_code TEXT NOT NULL,
  subject_fingerprint TEXT NOT NULL,   -- the assessed proposal's own text hash, so a dismissal
                                       -- cannot outlive the text it was made about
  reviewer_id TEXT NOT NULL REFERENCES accounts(id),
  note TEXT NOT NULL,                  -- 1–500 characters, what was checked and why
  created_at TEXT NOT NULL,
  UNIQUE(subject_type, subject_id, signal_code, subject_fingerprint)
);
```

with the matching `recovery.js` work, exactly as the evidence library and the task-17 work do it:

1. bump to schema **23**, add the table to the create script and to the validated table/column list;
2. add a delete/update trigger if dismissals are to be append-only like `evidence_events`, or an
   explicit revocation column with a second event row if a dismissal must be retractable;
3. verify on startup, backup and restore that every dismissal names an existing account and an
   existing subject row, and that `subject_fingerprint` matches the assembled proposal;
4. add a write route with the reviewer/admin audience, an idempotency key, an audit entry
   (`mission_quality.signal_dismissed`) and the same `dismissSignal` refusal rule, so the store can
   never hold a declaration by a human the signal names;
5. only then may the interface describe a dismissal as recorded.

The platform's other, lighter pattern is to append the declaration as readable text to a record that
already exists (as `review-assessment.js` and the adoption declaration do). This slice does neither:
the instruction was to keep the dismissal to the session and to specify the store, so the honest
state today is **a dismissal is displayed and never kept**. `tests/mission-quality-http.test.js` and
the browser scenario both assert that no dismissal row, table or audit entry appears.

## The gating proof

The claim is that the signals block nothing, and it is asserted rather than asserted-to-be-true:

- **HTTP** (`tests/mission-quality-http.test.js`): one fixture mission with a known defect
  (an imperative instead of a question, no stated limits, no source register) is read, and its flags
  are confirmed present; then the whole ordinary path runs over the shipped routes — `POST /claims`
  **201**, `POST /submissions` **201**, `POST /reviews` with `accepted` **201** and exactly one
  10-coin receipt, `verifyCoinLedger` true, `POST /adoptions` **201** — and the assessment is asserted
  to be **byte-identical before and after** the whole sequence. A second test creates a mission from a
  research lead, opens it and reads the task: the flags are present on a mission that was created and
  activated normally.
- **Browser** (`mission-quality-advisory-signals`): the flagged mission is created, given a task and
  opened; a contributor submits against it; after the reviewer has read the panel and an administrator
  has checked a signal off, the reviewer records an ordinary acceptance through the interface, the
  stored review names the independent reviewer and exactly one 10-coin receipt exists.
- **Where the coin decision lives:** nowhere in this slice. `src/platform.js` calls `assessMission`
  for its return value only, `src/mission-quality.js` neither calls nor restates `src/coins.js`, and
  no line added here reads or writes a receipt, a balance or a wallet. The module's own
  `authority.awards_or_withholds_coins` is `false` and the route returns it.

## Limitations

- **A dismissal is displayed, never recorded.** Stated above; the schema change is specified, not
  made. The interface says so in the panel rather than implying persistence.
- **The assigned reviewer cannot check off a signal that names them.** That is `dismissSignal`'s
  independence rule. It makes the check-off control useful mainly to an independent reviewer or
  administrator, which is a narrower audience than "the reviewer reading the panel". A UI-level,
  purely cosmetic "hide these for now" control was deliberately not added: it would be a second,
  differently-scoped control standing next to the module's real one.
- **The collusion signals never appear on this route.** With no review records supplied,
  `reviewer_concentration`, `small_reviewer_pool` and the record-level `reviewer_is_contributor` are
  not computed, and `review.checked` is `false`. A reviewer-facing collusion view needs its own
  decision about what a reviewer may see.
- **`source_host_unknown` never appears on this route**, for the reason given above. The other three
  source signals do.
- **The finding is assembled per request and not cached.** Each call compares the proposal against
  every stored research lead — 1,015 rows in the seeded corpus, measured at ~180 ms for the duplicate
  measure alone and ~200–300 ms for a full route call in the tests. That is inside the browser suite's
  10-second request timeout with room, but a corpus an order of magnitude larger would need the corpus
  read to be bounded or cached.
- **`completeness` is wider than the shipped schema.** `missions` and `tasks` have no `question`, no
  `limits` and no per-source `date`/`version` columns, so almost every shipped mission reports those
  fields as missing. That is the module reporting a real gap in the pipeline, not a wiring defect —
  and the panel shows it as a missing field, never as a verdict.
- **The panel lives on the review card only.** A reviewer cannot read the signals for a task that has
  no pending submission from the interface yet, even though the route supports it. The
  earlier plan suggested the research-lead card and the mission-create form as the more useful
  surfaces; that work is untouched here.
- **Only the review-surface presentation is tested in a browser.** The panel's dismissal probe, the
  no-verdict assertions and the session-only scope are exercised by the new scenario; the rest of the
  panel is covered by the HTTP tests and by the module's own suite.

## Exact results

Run in the worktree on Node **v24.19.0** (Apple M5, macOS arm64), on this tip with the changes above.

| gate | command | result |
| --- | --- | --- |
| Syntax | `npm run check` | **checked 90 files, 0 failed**, exit 0 |
| Unit / integration | `npm test` | **902 tests, 902 pass, 0 fail, 0 skipped, 0 todo** (~80 s). The tree was 896 tests before this slice, so all 6 new HTTP tests pass and nothing else moved. |
| HTTP acceptance | `npm run e2e` | **17 steps passed, 0 failed**, exit 0; process lock released, temporary workspace removed |
| Browser acceptance | `npm run browser` | **45 passed, 0 failed** (44 before, plus the new scenario) |

The browser run in full:

```text
SUMMARY  45 passed, 0 failed
  …
  PASS  reviewer-workbench (4312 ms)
  PASS  review-states-and-refusals (1714 ms)
  PASS  mission-quality-advisory-signals (3906 ms)
  …  (the remaining 42 scenarios unchanged and passing)
  result  PASS — the interface was driven in a real browser and the database agreed

TEARDOWN
  server stopped, process lock released: true
  temporary workspace removed: true
  shipped database untouched
```

and the new scenario's own steps:

```text
SCENARIO mission-quality-advisory-signals — A reviewer reads the advisory mission-quality signals
beside the review surface, checks one off for this session only, and the flags block nothing
  · the flagged proposal is created and opened, and its assessment is read over the API — mission
    77ec5039-… created and opened with 2 unusable field(s); the closest stored proposal scores
    0.7956 at the 0.6 threshold (257 ms)
  · a contributor submits a cited version against that task — submission 7b127dee-… is pending
    review with the advisory signals unchanged (4 ms)
  · the reviewer reads the advisory signals and their score beside the review surface — the panel
    showed the code, the score 0.7956 and the threshold 0.6; the only control is a refresh, and the
    named reviewer is told why the check is not theirs (817 ms)
  · an independent administrator checks the signal off for this session only, and it is stored
    nowhere — the dismissal was displayed, wrote nothing (9 tables and the audit chain unchanged),
    and did not survive a reload (2020 ms)
  · the reviewer records an ordinary acceptance, so the flags blocked nothing — accepted by
    2a4e0228-… for one 10-coin receipt; the assessment is byte-identical before and after (692 ms)
```

### Failures seen during the work, and how each was resolved

Reported honestly, since both were real defects in this slice rather than flakes:

1. **The first full browser run failed** `mission-quality-advisory-signals` at *"exactly one receipt
   must be issued"*: 44 passed, 1 failed. It passed in isolation. Cause: the shared fictional
   `contributor` account is used by earlier scenarios and had reached the shipped **100-coin UTC daily
   operator limit** (10 acceptances), so `review()` stored the acceptance and awarded nothing. Fixed by
   giving the scenario its **own operator account and resident**.
2. **The second full run failed the same assertion.** Cause: the shipped coin predicate also refuses a
   receipt for **identical normalised work** (`fingerprint`), and the shared `EVIDENCE.artifact` text
   had already earned a coin in another scenario. Fixed by submitting text unique to this scenario.
   Both causes are properties of `src/coins.js`, which this slice does not touch.
3. The scenario then passed in isolation and in the full suite, on two further full runs: **45 passed,
   0 failed**.

No scenario failed for a reason traceable to an existing flake, so no pre-existing scenario was
re-run in isolation; every prior scenario passed in all three full runs.

## What is deliberately not done

- **No schema change and no stored dismissal.** Specified above, not built; the interface says so.
- **No collusion view and no `source_host_unknown` on this route**, both for the stated reasons.
- **No place to *fix* what the signals report.** The panel shows `limits`, `sources`, `source_date`
  and `source_version` as missing because `missions`/`tasks` have no such columns; adding them is the
  pipeline change the earlier handoff asked for, and it is untouched here.
- **No gate anywhere**, which is the point: the signals are a reading of a proposal, and the coin
  decision stays with the shipped independent-acceptance predicate in `src/coins.js`.

# Task C handoff — mission quality and abuse signals

Wave C's first instruction is to **improve the mission quality pipeline before generating volume**.
This task delivers the pure half of that: a module that turns a *proposed* mission or task plus the
records a caller hands it into advisory signals a human can act on, and a measurement of what the
shipped corpus actually looks like under those signals. It wires nothing into the interface — that is
the next slice, and this file describes exactly what that slice should do.

## What was delivered

| artifact | purpose |
| --- | --- |
| `src/mission-quality.js` | The module. One file, **zero imports**, no database, no writer, no authority. |
| `tests/mission-quality.test.js` | 15 tests: the required-field set, every signal class, two negative cases, purity, and a threshold re-measured on the shipped corpus. |
| `docs/MISSION_QUALITY.md` | The field set, every signal code, every threshold with its measured justification, the human false-positive path, and what the module deliberately does not do. |
| `docs/handoff/task-c-mission-quality.md` | This file: the intended UI wiring, the limitations, and what Wave C still lacks. |

- Base commit: `30d8f09` (`Pin the character selection race with a held world read`) on
  `integration/deepseek-master-2026-10-14`.
- Files changed: the four files above, all new. **Nothing else was touched** — not `app.js`, not
  `server.js`, not any other `src/**` file, not `catalog/**`, `content/**`, the stylesheets,
  `native/**`, any other test, `package.json`, `HANDOFF.md`, `docs/VERIFICATION.md` or
  `outputs/Lucy`.
- Patch: `git format-patch` to `../task-c-mission-quality.patch`.
- No test was deleted, skipped or weakened. The suite grew from 881 to 896 tests.

## Exact results

Run in the worktree on Node v24.19.0 at base commit `30d8f09`:

| gate | command | result |
| --- | --- | --- |
| Syntax | `npm run check` | exit 0 — **and it does not parse the new file**, see "Limitations". |
| Syntax (the new files) | `node --check src/mission-quality.js`, `node --check tests/mission-quality.test.js` | exit 0 each |
| Unit/integration | `npm test` | **896 tests, 896 pass, 0 fail, 0 skipped, 0 todo** (90.5 s). The suite was 881 tests before this change, so the 15 new tests all pass and nothing else moved. |
| HTTP acceptance | `npm run e2e` | **17 steps passed, 0 failed**, exit 0, temporary workspace removed |
| Browser suite | `npm run browser` | **not run**: this change touches no browser code, no stylesheet and no client module. |

## The corpus measurement Wave C asked for

The headline finding is not a defect in any proposal; it is what the shipped corpus is. Measured on
base `30d8f09` against the 1,015 seeded `research_leads` proposals (514,605 pairs):

- **1,009 of the 1,015 proposals have at least one neighbour at or above the 0.6 duplicate
  threshold**, and 1,008 of them are at or above 0.90. The six exceptions are exactly the six
  Nepal–India tea pilot proposals, whose closest neighbour scores 0.363–0.415.
- The corpus is built from four concern templates, so a pair of proposals for **one concern and one
  goal with a different country** scores 0.839–0.983, and a pair for **one country with a different
  goal** reaches 0.9563. No threshold separates those from each other; the tokens that distinguish
  them are the country and the goal.
- The widest gap the corpus shows between **unrelated** work (highest 0.4464) and **template-shared**
  work (lowest 0.7229) is where the threshold sits.

Read together: the pipeline does not have 1,015 distinct questions in it. It has a small number of
concern templates applied to many subjects, with the subject selection left as an open scope choice
on each row. That is a legitimate scoping design and Task 24 documents it as such — but it is also
exactly the thing to decide **before** generating volume, because the module cannot tell "the same
question about another country" from "a different question on the same template" and neither can a
reviewer who only reads the score. `docs/MISSION_QUALITY.md` records the full class table.

## The intended UI wiring (a later slice; not performed here)

The module returns data and nothing else, so the wiring is entirely additive and belongs to whoever
owns `app.js` and the API routes. What that slice must do, in order:

1. **A read-only route.** The natural shape is `GET /api/v1/mission/quality?lead=<id>` (and the same
   for a proposed mission id), readable by a signed-in reviewer, administrator or mission owner —
   the same parties that can already open the research card or the reviewer workbench. It must
   write nothing, log nothing and change no status, and it should be refused with the existing
   `role()` style check rather than a new permission model.
2. **Assembling `existing` on the server.** Two reads, both already available:
   `SELECT id, title, instructions, rubric FROM research_leads` for the corpus, and the accepted
   review records for `existing.reviews` — `reviewer_id`, `contributor_id` and `decision` per review,
   which is `reviews` joined through `submissions` → `claims`. The route should pass
   `known_hosts` from `SELECT DISTINCT host FROM evidence_sources` so the
   `source_host_unknown` signal can work. A call over the 1,015-entry corpus measured **22 ms**;
   no caching is needed.
3. **Rendering every signal as advisory.** Show `code`, the plain-language `detail`, the `severity`
   and the `measure` verbatim. Do not colour a proposal red or green, do not show a count of
   "problems" as a score, and do not sort proposals by it: `advisory: true` is on every entry and the
   interface should read it.
4. **Showing the score, never a verdict.** For `near_duplicate`, render the matched id, the `score`
   and the `threshold` as numbers, and render `distinguishing.in_proposal` / `distinguishing.in_existing`
   beside them. The paired tokens are what makes the row a ten-second decision instead of an
   investigation, and in the shipped corpus they are often just the country and the goal.
5. **The false-positive path in the interface.** A "Checked — not a problem" control beside each
   signal, which requires a note and names the human, and which calls `dismissSignal(signal, {
   reviewer, note })`. The returned `dismissal` object is then stored by the caller exactly as a
   review assessment or an adoption declaration is stored today: as readable text, appended to a
   record the platform already has, with no schema change. It must be visible afterwards, with the
   note, beside the signal it dismissed. A signal that was dismissed is still shown; what changes is
   that the reader can see a human already looked.
6. **Order of the interface.** The `missing` list belongs with the proposal's own fields, where a
   person can fix them. The signals belong beside the decision the person is about to make — most
   usefully on the research-lead card and on the mission-create form, not in a separate report.
7. **What the slice must NOT do.** It must not disable or gate **Activate proposal**, `createMission`,
   `missionStatus` or anything else on the presence of a signal. It must not treat `completeness.complete`
   as an approval. It must not write a signal's severity into any status column, and it must not
   withhold or delay a coin: the coin decision stays with the shipped independent-acceptance
   predicate in `src/coins.js`.
8. **Where the wording comes from.** The interface should read `AUTHORITY`, `BOUNDARIES`,
   `LADDER_BLOCKED` and `SEVERITIES` from the module rather than re-typing them, so the boundary
   sentences cannot drift from the code that produced the data. In particular the ladder's two
   blocked stages must be shown as **blocked on a consenting beneficiary** wherever the ladder is
   shown.

## Limitations

- **The threshold is calibrated for this corpus, not for prose in general.** It sits in a measured
  gap between unrelated and template-shared proposals on the shipped 1,015-entry corpus. A different
  corpus should be re-measured; the calibration test in the suite recomputes the gap and fails if the
  threshold falls outside it.
- **A global threshold cannot separate every class.** Proposals for one country under different goals
  reach 0.9563, above the lowest same-template pair at 0.8390. The module reports the score and the
  distinguishing tokens and does not pretend to resolve it.
- **Partial copies can be missed.** A proposal that reproduces a fragment of an existing entry may
  score below the threshold, because the Dice coefficient covers the whole text of both entries.
- **The measure is about words, not meaning.** Two proposals with opposite conclusions in similar
  words score high, and two proposals that mean the same thing in unrelated words score low.
- **Collusion checks read only what they are given.** An empty `reviews` array produces no signal and
  the report says so; a route that forgets to pass the reviews would silently report nothing. The
  route must pass them.
- **The collusion thresholds are editorial.** A share of 0.8 over at least three acceptances, and a
  pool of at most two reviewers over at least ten accepted records, are chosen so that a small desk
  is not permanently flagged. They are documented, named constants, not measured laws.
- **`npm run check` does not parse `src/mission-quality.js`.** That script enumerates its files
  explicitly and `package.json` is outside this task's ownership, so the new module is not in the
  syntax gate. `npm test` imports it, which is a stronger check, but the gap is real and belongs to
  whoever owns `package.json`. (Same class of gap as `src/review-assessment.js`,
  `src/delivery-packet.js` and `src/mission-directory.js`, which are also absent from that list.)
- **The module mirrors three shipped facts it cannot import**: the twelve mission areas, the two
  framework hosts and the source-rule wording. The area list is asserted against the real
  `createMission` (every listed area is accepted, an unlisted one refused) and the approved-host rule
  is asserted against the real `submit` refusal, so drift shows up as a failing test rather than as a
  silently wrong signal. The framework-host list is not machine-checked against the catalog.
- **The module's field set is wider than the shipped schema.** `missions` and `tasks` have no
  `question`, no `limits`, no `sources[].date` and no `sources[].version` column; a proposal that is
  fully specified for this module must therefore carry those fields in prose or in `rubric`. That is
  the honest state of the pipeline today and the first thing a follow-up slice should decide about.
- **No browser coverage.** No browser code was touched and `npm run browser` was not run.

## What Wave C still lacks

- **A place to put a proposal's question, limits and source register.** Until `missions`/`tasks` carry
  them, `assessMission` can only read them from prose, and a form cannot ask for them.
- **A decision about template volume.** The corpus finding above needs an editorial answer — whether
  per-country copies of one concern are wanted, or whether the desk should collapse them into one
  scoped question per (theme, goal) with the subject chosen at activation. The module can measure it;
  it must not decide it.
- **A dismissal store.** `dismissSignal` returns a record; nothing stores one yet. The platform's
  existing pattern is readable text appended to an existing record, which needs no schema change and
  is the recommendation above.
- **Collusion review at the desk, not at the proposal.** `assessReviewIntegrity` can read a whole
  corpus, but there is no reviewer-facing view of it, and the shipped records only ever come from a
  real installation with real acceptances. The seeded world has none, so nothing here is verified
  against real review history.
- **A beneficiary-consent path.** The ladder's last two stages are blocked on a consenting
  beneficiary. Nothing in this build asks a real person for consent, so external implementation and
  measured outcomes remain unavailable, and no wording in this module implies otherwise.
- **A volume gate with authority.** This module deliberately has none. If Wave C wants generation to
  stop when the corpus is repetitive, that is a human decision with a recorded reason, not a
  threshold in a pure reader.

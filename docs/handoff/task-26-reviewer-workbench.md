# Task 26 — reviewer workbench and adoption tracking

Branch `task-26-reviewer-workbench` (worktree `work/t26`), based on `verify-batch02-wave-i` at
**3fd29e5** (*Add a bounded versioned evidence library with fail-closed source capture (schema 22)*),
one commit on top. Focused patch: `work/task-26-reviewer-workbench.patch`.

This task improves the **human reviewer flow**: criterion-by-criterion assessment, a comparison of
the exact source version a contribution cited against the version the library holds now, specific
changes-requested feedback the contributor reads back, and an explicit **adoption record**. It keeps
the proposer, the contributor, the reviewer and the adopter apart, refuses self-review and
self-adoption, and adds **no schema change, no dependency and no new minting path**.

## ITEM 0 — the inherited browser gate failure

`scripts/browser-suite.mjs` hard-coded `validation.schema_version === 21` while the shipped schema is
**22**, so the browser gate failed on that single assertion (task 25 recorded the defect and left the
file alone because it was outside its ownership). The assertion is now **version-agnostic**: it
compares the schema version of the database file the scenario just validated against the version the
**running server reports for that same database**, read from the administrator dashboard
(`GET /operations` → `diagnostics.schema.version`, which is the server's own `PRAGMA user_version`):

```js
const validation = validateDatabase(state.database);
const reported = await apiGet('/operations', { token: fixtures().admin.token });
const serverSchema = reported.status === 200 ? reported.body?.diagnostics?.schema?.version ?? null : null;
expect(serverSchema === validation.schema_version, 'the database that validates after the restart must be the schema the running server reports', …);
```

This cannot rot on the next bump: the expected value is produced by the running server from the same
file, and `validateDatabase` must still succeed (integrity, tables, ledger and the evidence library)
for the read to return at all. It also proves more than the literal did — that the file the suite
inspects really is the schema the process is serving. Confirmed: the whole 22-scenario suite passes
on the base plus this one fix before any other change in this task.

## Changed files

| File | Change |
| --- | --- |
| `scripts/browser-suite.mjs` | ITEM 0 version-agnostic schema assertion; a `contributor` fixture operator; two new scenarios (**reviewer-workbench**, **review-states-and-refusals**) with their helpers; the `createHash` import. |
| `tests/browser-suite.test.js` | The scenario-count assertion (22 → 24) plus an assertion that `signout-privacy` stays last. |
| `src/review-assessment.js` | The pure workbench half: `submissionState`, `citationComparison`, `requestedChangesReason`/`storedRequestedChanges`, `adoptionDeclaration`/`storedAdoption`, `ADOPTION_BOUNDARY`. `assessmentReason` is unchanged in behaviour. |
| `src/platform.js` | `reviewWorkbench()` (new, read-only); `adoption()` records a declaration with its evidence and refuses self-adoption and reviewer-adoption; `review()` accepts `requested_changes`; `history()`/`gallery()` carry the one `state` object, the adoption declarations and the requested changes; `adoptionsForSubmissions()` bulk reader. |
| `src/delivery-packet.js` | The packet carries the adoption declarations, their supporting evidence, the current `state`, and a boundary that says adoption is a recorded declaration and not proof of implementation, endorsement or outcome. |
| `app.js` | The reviewer workbench panel (roles, state, source-version comparison, requested-changes list); the requested-changes instruction list in the review form; the state badge and the requested-changes list on every submission; the gallery adoption form with an evidence field and the refusal explained in words; the workbench cache cleared on sign-out. |
| `server.js` | `GET /review/workbench` route. |
| `tests/review-workbench.test.js` | New — 8 tests. |
| `tests/review-states.test.js` | New — 5 tests. |
| `docs/API.md`, `docs/EVIDENCE_REVIEW.md`, `docs/COINS.md` | The workbench, state model, adoption rules, coin boundary and the new route. |
| `tests/journey.test.js` | **One assertion outside this task's declared file ownership** — see *Ownership deviation* below. |

## The workbench design

`GET /api/v1/review/workbench?submission=<id>` returns one composite, **read-only** view of one
submission version. It is refused **401** without a session and **403** to anyone outside the mission
(its owner, its assigned reviewer, an administrator, and the contributor). Opening it writes nothing:
the test asserts the `reviews`, `submissions` and `audit` counts are identical before and after.

1. **Criteria and findings** — the mission rubric, and each finding with the sources it cites.
2. **Source-version comparison** — see below.
3. **Roles** — the four roles, named, with `distinct` flags and the exact refusal reason for each
   action the caller cannot take.
4. **The decision form** — the existing criterion-by-criterion assessment, plus a repeatable list of
   requested changes.
5. **Recorded adoptions** — each declaration with the evidence the mission owner named.

## The state model

One object, one value, everywhere (`history`, `gallery`, the workbench, the interface):

| `value` | Stored condition | Meaning |
| --- | --- | --- |
| `pending` | `pending_review` | Waiting for an independent review; nothing is accepted, no coin is issued. |
| `changes_requested` | `changes_requested` | The version went back with a named list of corrections. |
| `accepted` | `accepted`, no adoption | This exact version passed a human review. |
| `held` | `quarantined` | **Availability is held without rewriting history.** |
| `adopted` | `accepted` **and** ≥1 recorded adoption | A recorded declaration of use by the mission owner. |
| `rejected` | `rejected` | Refused; the task returned to the board. |

`held` wins over `adopted` so a quarantined version can never read as available work, while the
adoption record stays readable. `quarantined` and `adopted` are also returned as separate booleans so
nothing is hidden by the single value.

## The four roles

| Role | Who | How the code keeps it distinct |
| --- | --- | --- |
| Proposer | the mission owner (`missions.owner_id`) | Named in the workbench; the same account is the potential adopter. |
| Contributor | the operator whose resident submitted the version (`claims.account_id`) | Cannot review its own work (**403**), cannot adopt it (**403**). |
| Reviewer | the assigned reviewer, and the account that actually recorded the review | Cannot adopt the version it accepted (**403**). |
| Adopter | the mission owner | Only this account may record an adoption, and only for a currently accepted version (**409** otherwise). |

`platform.coins.js`, the review path and the ledger are untouched: the separation is enforced by the
existing `review()` check plus the two new rules in `adoption()`.

## Coin issuance stays atomic and idempotent (proven, unchanged)

No line of `src/coins.js` was changed. The proof sits in `tests/review-states.test.js` and the new
browser scenario, all driving the shipped paths:

- **Two simultaneous acceptances** of one submission (reviewer and administrator, over HTTP,
  `Promise.all`) resolve to exactly one `201` and one `409`; afterwards there is **exactly one**
  `reviews` row and **one** `coin_rewards` row for that version, and the wallet shows
  `receipt_count: 1`.
- **A replay** of the same acceptance is refused `409` and adds no receipt.
- **Quarantine** leaves the receipt row byte-identical (`deepEqual` on the row) and moves only the
  wallet projection to `held` (`balance 0`, `held 10`, `issued 10`), with the same receipt id; an
  independent appeal restores `balance 10` **without issuing a second receipt**.
- `verifyCoinLedger` and the full `validateDatabase` pass after each of those steps, and the browser
  scenario re-validates the temporary database after the race.

## Source-version comparison

Each `citations[]` entry carries `cited_version` (the exact capture the contribution pinned),
`current_version` (the newest capture of that source now) and a `comparison` with
`same_version`, `newer_version_available`, `changed_fields`, a per-field `differences` list and a
plain-language `summary`. It **never edits either version or invents one**: adding a newer capture,
an explicit `supersedes` capture or a withdrawal changes only the state a reviewer reads. The browser
scenario captures a newer version that supersedes the cited one and asserts the interface shows both
hashes side by side under “Version cited by this contribution” / “Version the library holds now”,
labelled `replaced`, while the cited capture row is unchanged in SQLite.

## The browser walkthrough (actually run)

`reviewer-workbench` — four people on four accounts (the administrator proposes and later adopts, a
new `contributor@browser.test` operator contributes, the reviewer is a third person):

1. The contributor’s resident submits a structured decision brief whose source is pinned to one exact
   version (`submission_evidence.capture_id`), asserted in SQLite.
2. The administrator captures a **superseding** version of that source. The reviewer opens the
   workbench in the interface and reads the replaced citation, both hashes, the four roles, and “Yes.
   Record a criterion-by-criterion decision below.” The cited capture row is byte-identical.
3. The reviewer **requests changes** through the shipped form: per-finding result/sources/explanation,
   applicability, rights, cost assumptions, and one named instruction. The stored review reason
   contains `HUMAN EVIDENCE ASSESSMENT — THIS SUBMISSION VERSION` and
   `REQUESTED CHANGES — THIS SUBMISSION VERSION`; the submission is `changes_requested`; no coin.
4. The contributor opens **My contributions** and reads exactly the requested change for version 1.
5. The contributor submits version 2; the reviewer **accepts** it criterion by criterion through the
   workbench. Exactly one 10-coin receipt exists for the resident, and a reviewer reading another
   operator’s wallet is refused.
6. The **mission owner records the adoption** through the gallery, with its supporting evidence. The
   `adoptions` row carries `DOCUMENTED ADOPTION — MISSION OWNER DECLARATION` and the evidence; the
   workbench reads `adopted`; the briefing packet carries the declaration, the evidence and the
   boundary. The reviewer’s own adoption attempt is refused `403` by the mission-owner rule.

`review-states-and-refusals`:

1. A mission owned by the contributor’s own operator is contributed to and independently accepted.
2. The contributor (also the mission owner) **cannot adopt their own work**: the interface explains
   the separation and offers no form; the server answers `403` naming the rule; no row is written.
3. **Quarantine** (reviewer reports, administrator moderates): the submission reads `quarantined`; the
   `reviews` row and the `coin_rewards` row are byte-identical; the wallet reads available 0 / held 10
   with the same receipt id; the interface reads “Held — quarantined” and “retained exactly as they
   were”.
4. **A race and a replay**: two simultaneous acceptances of a second version resolve to `201`/`409`,
   the replay is `409`, exactly one review and one receipt exist, and the temporary database still
   validates.

Both scenarios assert **database effects** after every browser action; neither was run outside the
full suite.

## Private drafts and what a recipient sees

- **Private drafts are preserved.** The workbench path touches no draft code; a test proves a draft
  saved before submission is archived on submit, un-archived by a `changes_requested` review, still
  editable by its owner, invisible to another operator, and present in the owner’s export.
- **Recipients see what was actually approved.** The gallery lists only currently accepted versions
  (`held`, pending and rejected versions never appear), each with its state in words, its review
  reason, its adoption declarations and its supporting evidence; the delivery packet carries the same
  and states its boundary. “Documented uses” counts declarations, never verified outcomes.

## Gate evidence

Recorded for this branch (`work/t26`, Node v24.19.0, `PATH="$PWD/../node-bin:$PATH"`, system Chrome
155.0.8059.40). `npm install` was run once for the dev-only `playwright-core`; **`package.json` and
`package-lock.json` are unchanged**.

```
$ npm run check
> nemoworld@1.0.0 check
> node --check server.js && … && node --check scripts/load-harness.mjs
(exit 0)

$ npm test
ℹ tests 608
ℹ suites 0
ℹ pass 608
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 100655.700583

$ npm run e2e
SUMMARY  15 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API

$ npm run browser
SUMMARY  24 passed, 0 failed
  PASS  reviewer-workbench (5769 ms)
  PASS  review-states-and-refusals (2365 ms)
  result  PASS — the interface was driven in a real browser and the database agreed

$ node scripts/seal-content.mjs --check
Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.
(exit 0)
```

Baseline was **595 tests, e2e 15/15, browser 22 scenarios (failing on the schema-21 literal),
schema 22, seal 89 definitions**. This branch is **608 tests (+13), e2e 15/15, browser 24/24,
schema 22, seal unchanged**. The full browser log also reports the teardown guarantees as intact:
process lock released, the temporary workspace removed, and the shipped `data/world.sqlite` untouched.

## Migration and rollback

**The schema did not change. It is 22 before and after.** No table, column, trigger, index or view was
added, and `src/database.js` and `src/recovery.js` were not touched. An adoption declaration and a
requested-changes list are stored as readable text in the existing `adoptions.note` and `reviews.reason`
columns — the same discipline the task 12/25 assessment already used — so a pre-existing database needs
no migration and a database written by this branch is readable by the base branch.

**Rollback.** Revert the eight changed files. No data migration, no backup/restore step and no
`PRAGMA` change is involved; the only new write is a longer `adoptions.note`, which the base branch
reads normally (it simply stops parsing the labelled declaration).

## Ownership deviation (one file outside the declared list)

`tests/journey.test.js` asserted the **old** policy: `f.tx('adoption', alice, …)` for a mission whose
owner *is* the contributor was expected to **succeed** and simply grant no merit
(`docs/VERIFICATION.md`: “self-adoption credit” is excluded). The task’s acceptance criteria require
**self-adoption to be refused**, which is the opposite policy, so that one assertion had to change. It
was changed to expect the refusal and to assert that **no `adoptions` row is written**, which
strengthens rather than deletes coverage. This is the only edit outside the declared file list; no
other test file was touched, and nothing in the “do not touch” list was touched.

## Limitations

- **Adoption is not verified.** The declaration and its evidence are recorded as the mission owner
  typed them. NemoWorld validates who declared it and when, not whether the use happened.
- **The workbench is a read.** It computes the comparison on every read, so it reflects the library at
  the moment it is opened; it does not snapshot anything (a later capture changes only the label).
- **`requested_changes` is optional.** Existing plain reviews (and any review that already had a
  reason only) remain valid, so the browser flow demonstrates the structured path but the API does not
  force every reviewer to enumerate changes. Making it mandatory would have silently broken six
  existing test files' reviews.
- **One workbench panel per pending version** is cached in the browser after it is loaded
  (`state.workbenches`), and that cache is cleared on sign-out. It is in-memory only; no private
  content is persisted in the browser.
- **The comparison covers the fields the library stores** (hash, bytes, retrieval time, declared date,
  unit, title, location). A prose change inside a source that keeps its hash is invisible — by
  construction, since the hash *is* the version.

## Residual risks

- **A colluding human reviewer and mission owner** can still manufacture an honest-looking acceptance
  and adoption pair; admission control and human judgement remain the control, exactly as
  `docs/COINS.md` and the task 08 review state.
- **A database-level attacker** can bypass every rule here by writing rows (or by dropping a trigger);
  per `docs/COINS.md` that is outside the supported boundary, and the row-level checks only raise the
  bar.
- **Timing flakes.** The two new scenarios use the shared driver idioms (specific-world waits, the
  bounded movement-throttle resume); the flake fix in `scripts/browser-suite.mjs` is untouched. No
  limit was raised and no assertion was weakened to make them pass.
- **The reviewer workbench reads the contributor’s artifact.** Anyone who is the mission owner, the
  assigned reviewer, an administrator or the contributor can read it. That is the same set that could
  already read it through `GET /history`, but the route is new and is worth re-checking if the mission
  visibility rules change.

## Not done / not tested

- No new outbound network request; the evidence library still performs no fetch.
- The interface was exercised in Chrome through the suite only; no manual screenshot review was
  performed for the new panel, and no performance claim is made for it.

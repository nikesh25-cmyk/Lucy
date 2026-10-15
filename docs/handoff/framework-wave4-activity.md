# Wave 4 — the activity pipeline

Branch `framework-wave4-activity`, based on `27c0d72` (schema **25**, 161 test suites / 1074 tests
passing). This slice states the ordered journey a piece of work travels, makes the stage of any
activity instance readable, refuses duplicate, vague and unanswerable tasks instead of multiplying
templates, keeps practice activities structurally apart from external recommendation, and lets a
reviewer resolve a claimed contribution to the exact stored row and source version. Nothing in tasks
01–06, 19, 21–26 was re-litigated, no sibling branch was imported, and no forbidden file was edited.

**Base `27c0d72` → tip: this branch's three commits.** The first is `3c0d587` (*state the ordered
activity pipeline and read the stage of an instance*), the second is `d529710` (*walk four activity
types through the whole pipeline end to end*), and the tip is the commit that carries this handoff;
`git log --oneline 27c0d72..HEAD` lists all three in order. The tip hash cannot name itself, so this
handoff names the first two and the branch instead.

## What was asked, and what was built

| Artifact | Purpose |
| --- | --- |
| `src/activity-pipeline.js` | The ordered stage contract, the per-kind readers (cultivation, construction, restoration, cooperation, research), the stage-order rule, the practice boundary and its whole-database check, the reviewer trace resolver, and the platform methods (`activity`, `activityInstance`, `traceContribution`, `activityTaskCheck`, `activityAuthor`). |
| `src/activity-authoring.js` | The callable authoring validation: the substantive key, the corpus read from the real stores, and the duplicate / near-duplicate / vague / unanswerable rules. |
| `docs/ACTIVITY_PIPELINE.md` | The model: the seven stages, what each accepts, every field where practice could be read as external, the authoring rules and their limits, the trace contract and the routes. |
| `tests/activity-pipeline.test.js` | The stage contract, the order rule (pure and database-level), the practice guard, and the whole-database check. |
| `tests/activity-authoring.test.js` | Every refusal the three authoring rules make, and the limit each rule states. |
| `tests/activity-trace.test.js` | A genuine claim resolving to its row and version, and each way a claim fails to resolve. |
| `tests/activity-practice-separation.test.js` | The readings, the named boundary fields, and the guard refusing every contradiction. |
| `tests/activity-pipeline-four-types.test.js` | **The human-plus-AI walkthrough**: four activity types end to end over the shipped HTTP API on a disposable database. |
| `tests/framework/known-gaps-activity.mjs` | Four reproducible findings this slice must not fix, plus two behavioural pins. Not discovered by `node --test`. |

**No table, column, trigger, index or schema version was added.** Every stage is derived from rows the
quest, calling, guild, restoration, journey, frontier and mission layers already write, so the pipeline
is reusable on an existing world with no migration and no rollback path. `src/database.js`,
`src/recovery.js`, `app.js`, `src/voxel-world.js`, `src/scene/*` and `src/spaces.js` were not touched.

## Changed files

**New**

- `src/activity-pipeline.js` — the stage contract, the five per-kind readers, the order rule, the practice boundary and its whole-database check, the trace resolver, and the five platform methods.
- `src/activity-authoring.js` — the substantive key, the corpus read from the real stores, and the duplicate / near-duplicate / vague / unanswerable rules.
- `docs/ACTIVITY_PIPELINE.md` — the model and its stated limits.
- `tests/activity-pipeline.test.js` — the stage contract, the order rule, the practice guard and the database check.
- `tests/activity-authoring.test.js` — every authoring refusal and each rule's stated limit.
- `tests/activity-trace.test.js` — a genuine claim resolving, and every way one fails to resolve.
- `tests/activity-practice-separation.test.js` — the readings, the named boundary fields and the guard.
- `tests/activity-pipeline-four-types.test.js` — the four-type walkthrough over the shipped HTTP API.
- `tests/framework/known-gaps-activity.mjs` — the four gaps found and not fixed, plus two pins; not discovered by `node --test`.
- `docs/handoff/framework-wave4-activity.md` — this handoff.

**Extended**

- `src/platform.js` — one import line and one `Object.assign` entry for `activityMethods`; nothing else in the file changed.
- `server.js` — five route entries (three GET, two POST) and two GET dispatch lines.
- `docs/API.md` — the `## The activity pipeline` section with the five routes, what the trace refuses and what a stage is not.
- `docs/ARCHITECTURE.md` — one paragraph stating that the pipeline adds no schema version and is derived.
- `docs/QUESTS.md` — a closing section pointing a chain at its pipeline stage and at the authoring front door.

**Not touched:** `app.js`, `src/voxel-world.js`, `src/scene/*`, `src/database.js`, `src/recovery.js`,
`src/spaces.js`, `src/quests.js`, `src/guilds.js`, `src/community.js`, `src/vocations.js`,
`src/journey.js`, `src/frontier.js`, `src/coins.js`, and everything the sibling branches own.

## The pipeline, stage by stage, and what each one enforces

1. **discovery** — a published quest chain, a visible guild project, the authored restoration plan or an
   open mission task with its independent reviewer. A resident that has not started still reads the
   published activities available to it, blocked at `participation` and claiming nothing.
2. **scoped_task** — the authored chain steps, the project plan, the fixed restoration steps or the
   mission task with its version. This is the one stage an author writes, and it is the stage the
   authoring rules below guard.
3. **participation** — a `quest_enrollments`, `guild_participants`, `community_rsvps` or leased `claims`
   row. A promise, never work. A resident that later leaves is still read as having participated: the
   credited receipts, the recorded contributions or the saved placements prove it, so no legitimate
   stored state can be reported as a skipped stage.
4. **saved_contribution** — read from the `calling_source_events` view the receipt trigger itself reads,
   or from the world rows (a standing block, a placed garden object, a submitted version's citations).
   **Derived from the saved fact, never from the cosmetic credit**: the work is saved whether or not the
   ten-a-day calling allowance had a point left for it, and the credit is reported separately
   (`credited`, `credited_steps`, `cosmetic_experience`).
5. **independent_review** — required only where the scoped task says so: a review by a different
   account for a real evidence chain, or a different operator's verification of a guild contribution.
   A practice chain and the restoration report it as `required: false` with `code: not_required`, never
   as skipped.
6. **world_effect** — what the saved contribution actually produced: the harvested crop row and the
   resources it yielded, the standing blocks, the placed garden objects, a verified cooperation record,
   or an accepted version recorded as a proposal. A prepared farm patch is deliberately **not** listed:
   it is ground made ready, not the outcome of a saved fact, so listing it would report an effect
   without a contribution.
7. **journal** — the hash-chained `audit` entry, and for construction the operator's own
   `frontier_actions` ledger.

The order rule is contiguous: `stage` is the furthest stage reached **before the first missing required
stage**, `blocked_by` names that stage, and `order_violation` is true only when a stored row asserts
work beyond a missing required step of the work. `discovery`, `scoped_task` and `journal` are outside
that rule on purpose — the journal's job is to record what happened, including the enrolment that
precedes a contribution, so a journalled join is never a claim that the work was done.
`verifyActivityStructure(db)` re-checks the whole database and returns false when an instance skips a
required stage or breaks the practice boundary. It writes nothing and is **not** yet called by
`src/recovery.js` (finding GAP-2).

## The authoring rules, and what each one refuses

The substantive key is task 24's shape over kind, source and scope:

```
<kind>|<source_key>|<scope_key>      e.g. cultivation|crop-garden-plant|exact-garden-one-own-patch-place-plant-tile
```

| Rule | HTTP | An example it refuses |
| --- | --- | --- |
| duplicate | 409 | Authoring *The Herb Sowing* twice. `This task already exists (identical kind, source and scope): The Herb Sowing · Sow one patch in quest_chains.` |
| near duplicate | 409 | The same scope reworded by one word: `the same scope reworded (80% shared content words)`, naming the task it collides with. The same question reworded: `the same question reworded (83% …)`. |
| vague | 400 | `Name a beneficiary type: practice_self, named_resident, world_register, named_community, public_institution.` — `Improve the garden somehow` → `must read as a question` — `Is this the one that it was?` → `needs at least three content words` — `{name:'A better garden'}` → `must be verifiable from something this world records: choose one of crop_plant, …`. |
| unanswerable | 400 | `The evidence library retains nothing from tea-board.example.org, and an operator typing a URL is not a source.` — `tea_export_volume is not a saved fact this world records` — `ministry_of_agriculture is not one, so the task requires an authority no one holds`. |

**Stated limits, asserted by a test rather than hidden:** the rules do not catch a paraphrase whose
vocabulary is disjoint from the existing task (demonstrated: under 10% shared and accepted), a duplicate
of a task in a store the corpus does not walk, a duplicate across two different kinds, or a task whose
declared source is honest text while its real question is trivial. A corpus question derived from
authored content is a step title plus its instructions, so the collision a real chain produces is
usually the **scope**; the question branch is the one a mission task reaches.

## Practice is not an external recommendation

`PRACTICE_BOUNDARY_FIELDS` names every field where the two could previously be confused — eleven of
them — each with what the field said before and what protects it now. Three were not previously named
anywhere and are newly guarded here: `guild_contributions.status = verified` (its `completed: true`
label), `community_events.status = completed` for a restoration (the plan text calls the restored
structure "the recorded outcome"), and `adoptions.submission_id` (the adoption state).

The four readings an instance can produce are `practice_activity`, `unreviewed_claim`, `proposal` and
`recorded_declaration`. `institutional_claim` and `real_world_impact` are `false` in **every** reading,
including a recorded declaration. `assertPracticeBoundary` refuses a practice instance that carries a
beneficiary outside NemoWorld, a real contribution review boundary, an adoption or an external reading,
and `verifyActivityStructure` fails the whole database when one exists. The test proves the refusal by
tampering a stored practice chain's beneficiary: the read refuses to describe it, and both
`verifyActivityStructure` and the quest module's own `verifyQuestStructure` return false.

## How traceability resolves a claim

`GET /api/v1/activity/trace?claim_kind=&claim_id=` resolves a claim to the stored row, its version and
the library capture each citation is pinned to, computing every citation state live through the same
`resolveCitation` the reviewer workbench uses. A genuine submission resolves to one `submissions` row at
its own `version` plus a `pinned_versions[0].sha256` equal to the retained catalog hash. A pledge that
cites nothing is refused 409; a claim whose citations all name versions the library does not hold is
refused 409; an explicit `capture_id` outside the library is refused 404; a `version_id` belonging to
another claim is refused 404; a receipt whose saved action is gone is refused 409. The contributor's
operator and any reviewer read it; any other account gets the same 404 an unreadable row gets.

## Routes and modules extended

| Route | Access | What it does |
| --- | --- | --- |
| `GET /activity?agent_id=&kind=` | owned resident, or its runtime `read` scope | The pipeline contract and every instance with its stage, evidence and reading. |
| `GET /activity/instance?agent_id=&instance_id=&kind=` | the same | One instance by id. |
| `GET /activity/trace?claim_kind=&claim_id=&version_id=&capture_id=` | contributor's operator, `reviewer`, `admin` | Resolve a claimed contribution to its stored row and version. |
| `POST /activity/tasks/check` | human operator session | Validate one task. Writes nothing. |
| `POST /activity/author` | human operator session, then the delegate's own permission | Validate, then delegate to `questAuthor` / `guildProjectCreate` / `createTask`. |

Modules extended: `src/platform.js` (one import, one `Object.assign` entry), `server.js` (five routes,
two GET dispatch lines). Modules **not** modified: `src/quests.js`, `src/guilds.js`, `src/community.js`,
`src/vocations.js`, `src/journey.js`, `src/frontier.js`, `src/spaces.js`, `src/coins.js`,
`src/database.js`, `src/recovery.js`, `app.js`. The existing authoring routes behave exactly as they
did; the new front door delegates to them rather than replacing them.

## Database and permission invariants asserted

- **No schema change**: schema stays 25; `openDatabase` is untouched; a resumed session test
  (`verifyActivityStructure` over a fixture database) confirms the pipeline reads an unmodified world.
- **No write path**: the pipeline module has no writer. A test asserts `/quests/complete` still refuses
  client completion 400, and that a practice chain leaves `coin_rewards`, `adoptions` and
  `land_stewardships` at zero.
- **Attribution**: every credited fact, standing block, placed object and accepted version is asserted
  to carry the acting account's id.
- **Independence unchanged**: the research type needs a different authorized reviewer, the guild
  contribution needs a different operator, and the trace reports `review.independent`.
- **Permissions**: `/activity` refuses an anonymous caller 401 and another operator 404; the trace
  refuses a third ordinary member 404; a runtime reads only its own resident's board; a runtime cannot
  author.
- **Order and practice**: `verifyActivityStructure` is asserted true on every legitimate state the
  tests reach, and asserted false on a tampered state that skips a stage or breaks the practice
  boundary, then true again after the tamper is reverted.

## The four-activity walkthrough, with its transcript

`tests/activity-pipeline-four-types.test.js` drives a real server over its own HTTP API on a disposable
database created through the fixture, and asserts for each type that participation is saved, the
contribution is attributed to the acting account, the world effect is visible in stored state, and the
journal or history records it — then reads the pipeline's stage back over `GET /activity`.

```
cultivation  70edfd7d… planted and gathered 4,7 in home:70edfd7d-…; two saved facts, both attributed
             to the acting operator; stage journal reading practice_activity
construction b5e36e67… placed a path and a block in plot:0:0:2:5; two attributed blocks in stored
             state and two ledger rows; stage journal reading practice_activity
restoration  restoration:home:b1cd24c3-… worked by two operators (b1cd24c3… and 3296afa6…): ground 2
             of 3, guide attribution operator_distinct=true; stage journal reading practice_activity
research     21f37a13… claim 2a5d6dcc… version 1 accepted by a different operator; citation pinned to
             retained 94dd0bc76812…; reported as proposal
```

What each line proves at the storage level:

- **Cultivation**: `quest_enrollments` holds the participation; two `calling_receipts` hold the credited
  facts, both `account_id` = the acting operator, 5 points each; `journey_crops` holds the harvested row
  and `journey_inventory` holds the two gathered herbs; `audit` holds `journey.plant` and
  `journey.harvest`; `coin_rewards` is empty.
- **Construction**: the operator stewards one finite plot; two `frontier_blocks` rows carry
  `creator_account_id` and `plot_id`; `frontier_actions` records two `place` rows; `audit` records
  `frontier.place`; `GET /world` returns both blocks and `/land/plot` reports `block_count: 2`;
  `coin_rewards` is empty.
- **Cooperative restoration**: two `community_rsvps` rows from two operators; two `world_objects` rows
  stand on the plan's own tiles; two `restoration.placed` audit rows, one per acting account; the guide
  reports the guest as `operator_distinct: true`; `coin_rewards` is empty.
- **Source-backed research**: the lease, the submitted version and the acceptance are stored; the
  citation's `capture_id` resolves to the retained catalog capture whose `sha256` is the catalog's own;
  `GET /history` shows `state: captured`; the trace resolves the claim to `version 1` and that exact
  hash; the instance's reading is `proposal` with `external_adoption`, `institutional_claim` and
  `real_world_impact` all false. The one coin receipt in the whole walkthrough is the real 10-coin
  receipt for that independently accepted contribution — the practice types mint none.

The cultivation step moves the platform clock forward instead of waiting out a real crop's growth time;
the exception is stated in the file, the server still decides ripeness from its own clock, and every
request and assertion around it is HTTP.

## Gates

Run with Node **v24.15.0** on this worktree, after the last source edit. The base for comparison is
`27c0d72`: **161 discovered test suites / 1074 tests** passing and **20 e2e steps** passing.

| Gate | Command | Result |
| --- | --- | --- |
| Syntax | `npm run check` | **101 files checked, 0 failed** (base: 99) |
| Unit/integration | `npm test` | **1099 tests, 1099 pass, 0 fail, 0 skipped** in **166 discovered suites** (base: 1074 / 161). `tests/` now holds 171 files. |
| HTTP acceptance | `npm run e2e` | **20 steps passed, 0 failed**; the temporary workspace and the process lock were released; `npm run e2e` itself ran against a disposable database and 20 steps is the base count, unchanged. |
| Known gaps | `node tests/framework/known-gaps-activity.mjs` | **4 gaps reproduced, 2 pins unchanged**, exit 1 by design (the file is not discovered by `node --test`, asserted by the run above: the suite count rose by exactly the 5 new suites and the run exited 0) |
| Browser suite | `npm run browser` | **NOT RUN** — the integrator runs the Chrome suite serially to avoid contention-driven false failures. |

The 25 new tests are `tests/activity-pipeline.test.js` (8), `tests/activity-authoring.test.js` (6),
`tests/activity-trace.test.js` (5), `tests/activity-practice-separation.test.js` (5) and
`tests/activity-pipeline-four-types.test.js` (1).

## Findings

**Confirmed defect** (reproducible, not fixed — `tests/framework/known-gaps-activity.mjs`)

1. **A contribution can be accepted with no citation resolved to a stored source version.** `submit`
   accepts a citation whose locator names no retained SHA-256 and `review` accepts that version: the
   submission reads `accepted`, the fixed 10-coin receipt is issued, `submission_evidence.capture_id`
   stays NULL and the citation reads `missing`. The trace refuses such a claim; the review route does
   not. Owner: `src/platform.js` submit/review — the sibling `framework-wave1-contract` is the natural
   home for the refusal.
2. **The append-only audit names the world, not the block, for a construction action.**
   `frontier_actions.record_id` is the world id, so two blocks placed in one world share one
   indistinguishable audit entry; only the block row's own `creator_account_id` and the
   `frontier_actions` ledger carry the attribution. Owner: `src/frontier.js` `recordAction`.
3. **`verifyQuestReceipts` documents a claim linkage it does not re-check for stored rows.** Its own
   comment says a historical `research_accepted` receipt that answers a different claim stays readable;
   `reconcileQuests` prevents new mismatches, stored ones are neither detected nor marked. Owner:
   `src/quests.js`; the module's comment names a later schema migration, and schema 26 belongs to a
   sibling branch.

**Likely issue**

4. **`validateDatabase` does not call `verifyActivityStructure`.** A mission left in a
   non-discoverable state while an accepted version of it is stored makes `verifyActivityStructure`
   return false, while `validateDatabase` returns a version and `backupDatabase` copies the database.
   Recovery validation for the new checks belongs to the schema-26 work; `src/recovery.js` is outside
   this slice and was not edited, which is why this is filed rather than fixed.

**Design decision**

5. **The cosmetic credit and the saved work are read separately, on purpose.** Calling objectives are
   reconciled before enrolled quest steps and share one ten-a-day allowance, so a calling that answers
   a fact the chain also uses (an Explorer's free `shared_visit`) spends the day's allowance first. The
   pipeline therefore reports `saved_contribution` from the saved facts and the credit separately, and
   the walkthrough chooses a calling whose objectives do not overlap the chain it demonstrates. Recorded
   as PIN-1 rather than changed.
6. **`POST /activity/author` refuses to author a restoration step.** The gathering-garden plan is
   authored content with fixed slots, tiles and roles so every participant reads the same plan; a second
   operator-authored plan would break that. A restoration activity is pointed at the plan's own steps.
7. **The registration of a stage is derived, not stored.** This is what keeps the pipeline migration-free
   and what makes it a reader rather than a second workflow; the cost is that each read re-derives the
   stage (measured at ~25 ms per resident board on a fixture with the full seeded catalog).

**Untested / externally dependent**

8. **The renderer was not touched.** `app.js` was outside this slice; there is no interface surface for
   the activity board or the trace, so this is an API-only delivery for those two. `npm run browser` was
   not run.
9. **The near-duplicate threshold is a tuned constant.** 0.7 for a question, 0.8 for a scope. The test
   asserts both the refusals and the accepted paraphrase, so the threshold's behaviour is pinned, but its
   *value* is a judgement no test can settle.
10. **Only four activity kinds were walked end to end.** Guild cooperation is implemented and unit
    tested (pledge → submit → verify, with `world_status: verified_cooperation`) but is not one of the
    four transcript lines, because the deliverable named cultivation, construction, restoration and
    research.

## What remains unimplemented or externally dependent

- **No interface.** The activity board, the instance view and the trace exist only as API routes. A
  renderer for them is a follow-up slice; `app.js` is owned elsewhere.
- **No recovery validation.** `validateDatabase` does not call `verifyActivityStructure` (finding 4).
  Until the schema-26 work adds it, a backup or restore does not re-check the pipeline's invariants.
- **No migration.** Nothing needs one, which is the point: an existing schema-25 world reads the
  pipeline immediately. If a later slice wants a stored stage, that is a schema change with its own
  owner.
- **Guild cooperation has no dedicated walkthrough line.** It is covered by
  `tests/activity-trace.test.js` and `tests/activity-pipeline.test.js`.
- **Duplicate detection is vocabulary-deep, not semantic.** A paraphrase with different words is
  accepted; the test states this as a limit rather than a defect.
- **`npm run browser` was not run** by this slice, by instruction: the integrator runs the Chrome suite
  serially.

## Residual risks

- **The pipeline can refuse to describe a world it cannot read.** A stored practice chain carrying a
  beneficiary raises an uncaught error from `GET /activity` (500) rather than a wrong description. That
  is deliberate: a contradiction should be loud. `verifyActivityStructure` returns false for the same
  state, so the diagnostic read is the safe query.
- **A practice activity's credit can be spent before its chain's steps.** The saved work is still
  reported, but an operator reading only the calling board may believe a step was not done. The
  activity board is the read that separates the two, and the handoff says so.
- **The corpus is best-effort.** It reads `quest_chains` with their steps, guild plans, `tasks` and the
  restoration plan; a task stored elsewhere is not compared against.
- **No security proof.** Nothing here is claimed to be unhackable. A compromised server or direct
  database access is outside this control set, exactly as the coin and guild policies already say. The
  pipeline narrows the surface because it grants nothing: it has no writer and no authority of its own.

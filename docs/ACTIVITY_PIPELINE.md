# The activity pipeline

Quest chains, callings, guild projects, the cooperative restoration and the mission review path each
describe one part of the same journey: a resident discovers something, takes up a bounded task, takes
part, does saved work, sometimes has it checked by a different person, changes the world, and leaves a
record. **The activity pipeline states that journey once, in order, and reads where a piece of work
actually is.**

It is a reader, a validator and a boundary — not a second workflow. It adds no table, no column, no
trigger and no schema version: every stage is derived from rows `src/quests.js`, `src/vocations.js`,
`src/guilds.js`, `src/community.js`, `src/spaces.js`, `src/journey.js`, `src/frontier.js` and
`src/platform.js` already store. It writes nothing of its own, awards nothing, and grants no role,
plot, building right, moderator or reviewer authority.

## The seven stages

| # | Stage | What it is | The stored evidence the pipeline accepts |
| --- | --- | --- | --- |
| 1 | `discovery` | The activity is listed where a resident can find it. | A published `quest_chains` row, a visible `guild_projects` row, the authored restoration plan or an open mission task with its independent reviewer. |
| 2 | `scoped_task` | One bounded task with a named output and a stated source. | The authored `quest_steps`, the project's `plan` workstreams, the fixed restoration `steps`, or the mission `tasks` row with its version. |
| 3 | `participation` | The resident is enrolled, pledged or leased to that exact task. | A `quest_enrollments`, `guild_participants`, `community_rsvps` or leased `claims` row. A promise, never work. |
| 4 | `saved_contribution` | One saved, attributed server fact. | The `calling_source_events` view (the same view the receipt trigger reads), `frontier_blocks`, `world_objects` with their `restoration.placed` audit entry, or a `submissions` version with its citations. |
| 5 | `independent_review` | Only where the scoped task requires it, and only by a different operator. | A `reviews` row by another account, a `guild_contributions` row verified by another operator, or an independently accepted quest step. |
| 6 | `world_effect` | What the saved contribution changed in stored state. | The harvested crop row and the resources it yielded, the standing `frontier_blocks`, the placed `world_objects`, a verified cooperation record, or an accepted version recorded as a proposal. |
| 7 | `journal` | The append-only record of it. | The hash-chained `audit` entry (and, for construction, the operator's own `frontier_actions` ledger), or the contributor history read. |

`independent_review` is the one stage a scoped task may declare it does not need. Every other stage is
required. A practice chain and a restoration both name no review boundary, so their instance reports
that stage as `required: false` with `code: not_required`, never as "skipped".

## What the stage reading reports

`GET /api/v1/activity?agent_id=` returns the pipeline contract beside every activity instance the
resident has, and each instance carries:

- `kind`, `instance_id` and `title` — the instance identity (`quest:<slug>`, `restoration:<event>`,
  `claim:<claim id>`, `guild:<project id>`).
- `stage`, `stage_label`, `stage_ordinal` — the furthest stage reached **before the first missing
  required stage**, so the read is contiguous. A journalled enrolment with no saved contribution
  reports `participation`, not `journal`.
- `blocked_by` and `next_action` — the one thing that is actually missing.
- `stages[]` — every stage with `reached`, `required`, its `code`, the stored rows that support it and
  a note that says what those rows are.
- `attribution` — the account and resident the work belongs to.
- `reading` — see *Practice is not an external claim* below.
- `order_violation` — `true` only when a stored row asserts work beyond a missing required step of the
  work. `discovery`, `scoped_task` and `journal` are deliberately outside that rule: the journal's job
  is to record what happened, including the enrolment that precedes a contribution, so a recorded join
  is never a claim that the work was done.

A resident that has not started still reads the published activities available to it, each blocked at
`participation` and claiming no stage, so an operator can tell an available activity apart from one
that is under way.

## What the reading enforces

- **A stage is never set by a request.** There is no route that marks a stage. A client, a model, an
  operator and an author can only do the activity; the server credits the stage from the saved fact.
  This is the same boundary `POST /quests/complete` already refuses with 400.
- **The contribution stage is derived from saved facts, not from the cosmetic credit.** A saved
  planting, block or garden object is reported as saved work whether or not the ten-a-day calling
  allowance had a point left to credit it, and the credit is reported separately
  (`credited`, `credited_steps`, `cosmetic_experience`).
- **`verifyActivityStructure(db)`** walks every resident's instances and returns `false` when a stored
  row implies a later stage while a required earlier stage has no evidence, or when the practice
  boundary below is broken. It is the same shape of whole-database check `verifyQuestStructure` and
  `verifyGuildRecords` already use. It writes nothing.

## Authoring rules that refuse instead of multiplying

`src/activity-authoring.js` validates one scoped activity task before it is authored, and
`POST /api/v1/activity/author` validates it first and then **delegates to the module that already owns
that kind of write** — `questAuthor` for cultivation and construction, `guildProjectCreate` for
cooperation, `createTask` for research. One writer per kind, no second authoring scheme.

The substantive key is the one `docs/handoff/task-24-proposal-generator.md` established for the
country research generator, over kind, source and scope instead of concern, theme and country:

```
<kind>|<source_key>|<scope_key>
```

Each part is normalised: lower case, punctuation removed, a light and stated stemming rule
(`ing`/`ed`/`es`/`s` dropped when at least four characters remain), stopwords dropped and the tokens
sorted.

| Rule | Refused with | Example it refuses |
| --- | --- | --- |
| **duplicate** | 409 `duplicate` | The same kind, source and scope as an existing task. Authoring *The Herb Sowing* twice: `This task already exists (identical kind, source and scope): The Herb Sowing · Sow one patch in quest_chains.` |
| **near duplicate** | 409 `near_duplicate` | A same-kind question or scope that shares enough vocabulary: `the same question reworded (83% shared content words)` or `the same scope reworded (80% …)`, naming the task it collides with. |
| **vague** | 400 `vague` | No beneficiary type (`Name a beneficiary type: practice_self, …`); a question that is not a question (`must read as a question`); a placeholder (`needs at least three content words`); an outcome nothing records (`must be verifiable from something this world records: choose one of crop_plant, …`). |
| **unanswerable** | 400 `unanswerable` | Data no one has (`The evidence library retains nothing from tea-board.example.org, and an operator typing a URL is not a source`); a saved fact this world does not record; an authority no one holds (`ministry_of_agriculture` — `requires an authority no one holds`). |

The beneficiary vocabulary separates the two scopes at authoring time: `practice_self`,
`named_resident` and `world_register` are inside NemoWorld, and only a **research** task may name
`named_community` or `public_institution`. The verification vocabulary is the saved-fact vocabulary the
calling and quest receipt trigger already verifies, plus the restoration facts, a pinned
`submission_source_version` and a `guild_verification` — so an outcome nothing observable records
cannot be stated.

**What the duplicate rule does and does not catch.** It catches an identical substantive key, a
reworded question over the same subject, and a reworded scope. It does **not** catch: a paraphrase whose
vocabulary is disjoint from the existing task (`What did the ground give the resident this season?`
against `Which crop was sown on the garden patch?` shares under 10% and is accepted); a duplicate of a
task in a store the corpus does not walk (the corpus reads `quest_chains` with their steps,
`guild_projects` plans, `tasks` and the restoration plan); a duplicate across two different kinds; or a
task whose declared source is honest text while its real question is trivial. A corpus question derived
from authored content is a step title plus its instructions, so the collision a real chain produces is
usually the **scope**; the question branch is the one a mission task reaches.

## Practice is not an external claim

A practice activity is structurally incapable of being read as an externally adopted recommendation,
an institutional claim or a real-world outcome. The pipeline names every field where the two could
previously be confused, and `PRACTICE_BOUNDARY_FIELDS` carries, for each one, what the field said
before and what protects it now:

| Field or status | What could be read from it | What protects it |
| --- | --- | --- |
| `quest_chains.practice` | a stored 0/1 flag | the identity trigger keeps it immutable, `chainStructureValid` re-checks it, and the pipeline refuses to read a practice instance as an external one |
| `quest_chains.beneficiary` | free text, empty for a practice chain | `normalizeQuestSteps` refuses a practice chain that names one; `assertPracticeBoundary` refuses to report a practice instance that carries one |
| `quest_steps.requires_review` | derived from the saved-fact kind | a practice step may never require review |
| `calling_receipts.points` | five cosmetic experience per saved fact | `QUEST_POLICY.coins_awarded` is 0 and no receipt path reaches `coin_rewards` |
| `guild_contributions.status = verified` | `GUILD_OUTCOMES.verified` reads `completed: true` | the pipeline reading never carries it as adopted or as an outcome — only `world_status: verified_cooperation` inside NemoWorld |
| `community_events.status = completed` (restoration) | the plan text says the restored structure stands as the recorded outcome | the pipeline reading is `practice_activity` with `real_world_impact: false`; a restored garden is stored state inside NemoWorld |
| `submissions.status = accepted` | an independent human acceptance | `submissionState` already calls acceptance a contribution review, not factual certification; the reading is `proposal` |
| `adoptions.submission_id` | a recorded adoption of an accepted version | the adoption declaration already says it is not proof of implementation and not an institutional endorsement; the reading is `recorded_declaration` with `external_adoption: true` and `real_world_impact: false` |
| `journey_profiles.harvests / crafts` and `experience.cosmetic` | progress counters | no coin, no scope, no role; a harvest reads as a `harvested_crop` effect inside one garden |
| `land_stewardships / frontier_blocks` | a stewarded plot and standing blocks | finite in-world land, not a real title; a block reads as a `standing_block` effect |
| `coin_rewards` | the one transferable-looking ledger | `COIN_POLICY.transferable` is false and the only path to a receipt is an independent human acceptance of a real scoped contribution |

The four readings a pipeline instance can produce are `practice_activity`, `unreviewed_claim`,
`proposal` and `recorded_declaration`. No reading of any kind is an achievement, an impact or an
endorsement: `institutional_claim` and `real_world_impact` are `false` in every one, including a
recorded declaration. `assertPracticeBoundary` refuses a practice instance that carries a beneficiary
outside NemoWorld, a real contribution review boundary, an adoption or an external reading, and
`verifyActivityStructure` fails the whole database when one exists.

## Reviewer traceability

`GET /api/v1/activity/trace?claim_kind=&claim_id=` resolves a claimed contribution to **the exact
stored row and version that supports it** — not a summary and not a template.

| `claim_kind` | Resolves to |
| --- | --- |
| `submission` | The `submissions` row at its own `version`, its mission task and task version, and each citation resolved live against `evidence_captures`. |
| `guild_contribution` | The `guild_contributions` row, its project, its plan workstream, its verification review, and each source resolved live against the library. |
| `calling_receipt` / `quest_step` | The `calling_receipts` row, its proof hash, its cosmetic-points kind and the exact `calling_source_events` row it was derived from. |
| `restoration_placement` | The `world_objects` row and the append-only `restoration.placed` audit entry that recorded it. |
| `frontier_block` | The `frontier_blocks` row, the operator's own `frontier_actions` ledger rows in that world, and the operator's audit entries. |
| `guild_project` / `mission_task` | The stored project row and its plan, or the stored task row at its own version. |

It is refused when the claim cites nothing (`This contribution cites nothing, so no reviewer can
resolve it to a stored row or source version.`), when none of its citations resolve to a stored version
(`None of this claim's N citation(s) resolve to a stored source version: a link or a contributor-
declared hash alone is not evidence.`), when an explicit `capture_id` names a version the library does
not hold (404), when a `version_id` names another claim's submission (404), and when a receipt cites a
saved action the world no longer holds. The contributor's operator and any reviewer or administrator
can trace it; any other account gets the same 404 an unreadable row gets.

## Routes

| Request | Access | Purpose |
| --- | --- | --- |
| `GET /activity?agent_id=&kind=` | Owned resident, or that resident's runtime `read` scope | The pipeline contract and every instance the resident has, with its stage, its evidence and its reading. |
| `GET /activity/instance?agent_id=&instance_id=&kind=` | The same | One instance by its id. |
| `GET /activity/trace?claim_kind=&claim_id=&version_id=&capture_id=` | Contributor's operator, `reviewer` or `admin` | Resolve a claimed contribution to its stored row and source version. |
| `POST /activity/tasks/check` | Human operator session | Validate one activity task. Writes nothing. |
| `POST /activity/author` | Human operator session, then the delegate's own permission | Validate the task and delegate to `questAuthor`, `guildProjectCreate` or `createTask`. A restoration step is refused: that plan is authored content. |

## What this does not claim

- **No new authority.** There is no permission, role, scope, moderation power or review power in this
  layer, and no route in it writes `coin_rewards`, `land_*`, `resident_callings` or any review table.
- **No real-world outcome.** A verified cooperation, a completed restoration and a finished practice
  chain are stored state inside NemoWorld. Only a source-backed research activity can be a proposal,
  and even a recorded adoption of one is a declaration, not proof of implementation.
- **No new content and no new dependency.** The restoration plan stays the world's own authored plan,
  and no package was added.
- **The limits are the limits.** The duplicate rule is a threshold over vocabulary, the corpus is
  best-effort, and the audit for a construction action names the world rather than the block. See
  `tests/framework/known-gaps-activity.mjs` for the four gaps this slice found and deliberately did not
  fix, each with its command, its expected invariant, the observed behaviour and the owner.

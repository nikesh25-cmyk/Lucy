# Quest chains

A quest chain is an **operator-authored route** through this world: ordered steps, an explicit
prerequisite for each step after the first, a named output for every step, and — for any step that
claims real work — a human review boundary. Chains are built on the two systems that already exist:
the calling objective source registry (`src/vocations.js`) and the mission / submission / review
workflow (`src/platform.js`, `src/coins.js`).

The quest tables (`quest_chains`, `quest_steps`, `quest_enrollments`) were added on schema 17 and are
unchanged since; the current schema is 21. The same code ships one published practice chain, **The
Quiet Harvest**, so the feature is usable without authoring anything.

## The one rule that matters

> A quest step advances **only** from a saved, attributed server fact that the server itself can
> still verify.

There is no completion endpoint that a client, a model or a chain author can call. `POST
/quests/complete` exists and is **refused by design** (HTTP 400): it names the derived-fact rule and
writes an audit row. Progress is computed server-side from rows that other parts of NemoWorld
already store:

| Route | Saved facts a step may name (`source_kind`) |
| --- | --- |
| `world_building` | `frontier_place`, `path_place`, `frontier_expand`, `home_furnish`, `shared_visit` |
| `gardening` | `crop_plant`, `crop_harvest`, `craft` |
| `evidence_research` | `research_claim`, `research_accepted` |

Every kind is an existing arm of the `calling_source_events` view: a saved block (`frontier_blocks`),
a recorded area expansion (`frontier_actions`), a home object (`world_objects`), a recorded visit
(`journey_visits`), a planting or harvest (`journey_crops`), a craft (the audit receipt written after
the ingredients were debited), a leased claim (`claims`), and an accepted submission joined through
`contributionSource` / `contributionEligibility` — the same predicate the coin ledger uses.

A step never invents a fact, and a chain never owns one: **one saved fact can be credited once**, by
a calling objective or by a quest step, whichever the server reaches first.

## Step and output model

A chain is authored with `POST /quests/author` (roles `admin` and `reviewer`, exactly like
`createMission`) and published with `POST /quests/manage`. Steps are 2–8, numbered from one without
gaps, and each step declares:

- `slug` — stable identity inside the chain (`[a-z0-9-]`, 2–40 characters).
- `title`, `instructions` — what the resident reads.
- `output_name` — the **named output**: the concrete artifact the step leaves behind.
- `source_kind` — which saved fact proves it, restricted to the chain's route.
- `target` — 1–3 saved facts of that kind (default 1).
- `prerequisite` — the earlier step's slug (defaults to the previous step, so chains are linear
  unless the author says otherwise). A prerequisite must be an **earlier** step.
- `requires_review` — derived, not chosen: it is `true` exactly when the saved fact is
  `research_accepted`, i.e. when a *different*, authorized human reviewer accepted the work.

The server refuses to author or publish:

- a step whose `source_kind` does not belong to the chain's route;
- a `practice` chain that claims real work (an evidence chain is never practice, and practice chains
  take no route that can be satisfied by real mission review);
- a real evidence chain whose last step is not an independent acceptance;
- non-contiguous ordinals, duplicate slugs, a prerequisite that is not earlier, or an unauthorised
  author (tested).

## Progression, proved from saved facts

`reconcileQuests()` in `src/quests.js` is the only writer of quest progress, and it writes into the
**existing** `calling_receipts` table:

```sql
calling_receipts(id, agent_id, account_id, calling_id, objective_id, source_kind, source_id,
                 source_at, selected_at, earned_day, points, created_at, proof_hash,
                 UNIQUE(agent_id, source_kind, source_id),
                 UNIQUE(agent_id, earned_day, objective_id))
```

A credited step is `objective_id = 'quest:<chain-slug>.<step-slug>'`, `points = 5`, and the same
`UNIQUE(agent_id, source_kind, source_id)` constraint that already makes calling receipts
once-only. There is no second dedupe table and no parallel idempotency scheme.

For each enrolled chain the pass, in ordinal order:

1. skips a step whose evidence count already reaches `target`;
2. stops that chain while a prerequisite step is incomplete (**incomplete prerequisites are
   refused**: the later step can never move first);
3. otherwise looks for the next unused source event of the step's kind, **at or after the
   enrolment** (`started_at`) and after the resident's current calling selection, dated to the
   current UTC day, and not already consumed by any receipt;
4. inserts one receipt, letting the existing triggers re-check the source, the daily limit and the
   append-only rule.

Consequences that follow directly:

- **Once-only.** Replaying the same call, restarting the server, re-posting a join with the same
  `Idempotency-Key`, or reading the board a hundred times credits nothing again.
- **No retroactive credit.** A chain authored today cannot be completed by facts that predate the
  resident's enrolment. Re-joining after leaving starts a new enrolment; already-recorded receipts
  stay historical, exactly like calling receipts.
- **Shared, bounded cost.** Quest step experience is the *same* cosmetic calling experience: 5 per
  step, at most 10 per resident per UTC day, no transfers, no cash value. One saved fact is used
  once, so a Cultivator's calling objective and the Quiet Harvest's first step each need their own
  planting. The board always names the next action, so this is visible rather than surprising.

`verifyQuestReceipts()` and `verifyQuestStructure()` (called by `validateDatabase` in
`src/recovery.js`) reject a database where a quest receipt lost its authored step, lost its
enrolment, or was credited from a fact recorded before the enrolment.

## Why a quest cannot mint a coin

NemoCoins are governed by exactly one ledger, `src/coins.js`. The quantum of issuance is the
`coins_validate_insert` trigger plus `awardCoins()`, which requires:

- an **independently** accepted submission (`s.status='accepted'`, `r.decision='accepted'`),
- a mission with an active owner and an assigned active `admin`/`reviewer` who is **not** the
  contributor's account,
- `m.demo = 0`, a current task version, and a latest non-quarantined submission,
- a fixed amount of 10, one receipt per task, a normalized-work fingerprint, and the operator's
  daily cap of 100.

Nothing in `src/quests.js` writes to `coin_rewards`, and the module imports no coin code. The only
route from quest progress to real value is the *existing* one: a real mission task is claimed,
submitted, and accepted by a different human (which independently awards its 10 coins through the
ledger), and the accepted review is then the saved fact that credits an
`evidence_research` step. The step credits cosmetic experience; the coin comes from the review. A
test asserts the whole chain: a full practice chain leaves `coin_rewards` empty, while the same
contributor's independently accepted real contribution still yields exactly one 10-coin receipt.

## The shipped practice chains

**The Quiet Harvest** (`quiet-harvest`, `origin = built_in`, published on first open) is a
three-step gardening route with **no beneficiary and no claimed real-world outcome**:

1. **Sow a first row** — output: one planted crop in your own garden (`crop_plant`).
2. **Wait, tend, and gather** — output: two gathered resources from a mature crop
   (`crop_harvest`), after step 1.
3. **Make one keepsake** — output: a crafted keepsake made from your own harvest (`craft`), after
   step 2, and only if the ingredients actually exist.

Its narrative, in the resident's own reading, is a practice of patience: turn one patch of soil,
wait for the garden's own time, gather what it gives, and make one small object with it. It claims
nothing beyond NemoWorld, names no beneficiary, and requires no review. `tests/quests.test.js`
completes it end to end over two UTC days and asserts 15 cosmetic experience, three receipts, zero
coins, a valid calling ledger and a backup round-trip.

## The later practice chains

The shipped list is installed by slug on every open, so a chain added later reaches a world that
already has the earlier ones without touching a stored step or a resident's recorded progress. Two
more practice routes ship beside the first two:

- **The Patient Workshop** (`patient-workshop`, `gardening`, four steps) — sow a row, gather what
  grew, make a first keepsake, then make a keepsake *from* a keepsake. Both craft steps are proved
  by the same saved-fact kind, and a saved craft can be credited once, so the fourth step needs a
  second, different craft; the authored recipe ladder in `src/journey.js` is the deepest route. It
  spans more than one UTC day, because the shared ten-a-day cosmetic limit allows two saved facts a
  day.
- **The Open Hearth** (`open-hearth-homestead`, `world_building`, four steps) — arrive somewhere
  shared, furnish your own home, save a marker in your operator's stewarded plot, then lay a path
  beside it. All four steps use *different* saved-fact kinds, so no single act of building can carry
  the chain.

Both are cosmetic in exactly the way the first chain is: no beneficiary, no real-world claim, no
review step, and no coin. `tests/quests.test.js` drives the workshop chain from a saved planting
through both crafts and asserts the fourth step waits for the second craft; `tests/cooperative-content.test.js`
proves every later built-in chain is seeded exactly once into a database that already had the first.

## Management and privacy

- **Author:** `admin`/`reviewer` operator accounts. **Manage (publish / draft / archive):** the
  authoring operator or an administrator. A shipped practice chain is administered only by an
  administrator; a reviewer cannot archive it.
- A draft or archived chain is listed only for its author and administrators.
- Enrolment is a human-operator action for one of the operator's own active residents. Runtime
  credentials cannot author, manage or begin a chain, and a runtime may read only its own
  character's board.
- Enrolments are deleted with the account; an authored chain is archived rather than deleted, so
  another resident's recorded receipts keep their reference.
- `GET /quests/catalog` is public and carries no resident identity. Private progress stays with the
  resident's operator, and the account export (`shared-world-account-v18`) adds a `quests` section.

## Interface

The **Quest chains** section shows, for the selected resident, one *next actual action* card: the
chain, the step, the concrete action label, the **named output**, the saved fact that will credit
it, the progress (`n of m`), and whether an independent human must accept it. Below it, each chain
renders its ordered steps with the same machine-readable state (`complete` / `available` / `locked`),
the prerequisite that is still missing, and the saved facts already credited. The world aside shows
the same next action in a compact form. Everything is created with `document.createElement` and
`textContent`; `app.js` contains no `innerHTML`. Operators with the `reviewer` role also get a
bounded authoring form (a steps JSON textarea, validated on the server).

## API

| Request | Access | Purpose |
| --- | --- | --- |
| `GET /quests/catalog?q=&offset=&limit=` | public | Published chains with their steps, routes and policy (`limit` 1–20). |
| `GET /quests?agent_id=` | owned resident or its runtime (`read`) | Published chains, the resident's own drafts, enrolment, step states, saved facts and `next_action`. |
| `POST /quests/author` | `admin`/`reviewer` session | Create a draft chain with 2–8 ordered steps. |
| `POST /quests/manage` | author or `admin` session | `publish`, `draft` or `archive`. |
| `POST /quests/join` | session, own active resident, `Idempotency-Key` required | Begin a published chain. Repeating the key or the call returns the same enrolment. |
| `POST /quests/leave` | session, own active resident | Stop following a chain; recorded receipts stay historical. |
| `POST /quests/complete` | any signed-in account | **Always refused** (400). Documents the derived-fact boundary. |

Chains are not tasks: claiming, submitting and reviewing evidence still happen on
`/claims`, `/submissions` and `/reviews`, and a real chain's acceptance step is credited from the
accepted review receipt, never from the chain.

## Where a chain sits in the activity pipeline

A chain is one stage of a longer journey, and the journey is now stated once: see
[the activity pipeline](ACTIVITY_PIPELINE.md). `GET /activity?agent_id=` reads an enrolled chain at its
own reached stage — `scoped_task`, `participation`, `saved_contribution`, `independent_review` when the
route requires it, `world_effect` or `journal` — from the same rows the quest board reads, and reports
the saved work separately from the cosmetic credit, so a step the day's ten-point allowance has not
credited yet still reads as saved work. Authoring a chain through `POST /activity/author` validates the
scoped task first and refuses a duplicate, vague or unanswerable one before `POST /quests/author` is
reached; `POST /quests/author` itself is unchanged.

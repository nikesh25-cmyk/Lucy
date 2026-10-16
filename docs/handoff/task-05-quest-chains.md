# Task 05 — purposeful quest chains

Branch `task-05-quest-chains`, based on `task-04-crash-safe-jobs` (schema 16, 401 tests). Delivered
on schema **17**. Nothing in tasks 01, 02, 03, 04 or 07 was re-litigated.

## What was asked, and what was built

An **operator-authored quest-chain system** built on the existing calling objectives
(`src/vocations.js`) and the existing mission/review workflow (`src/platform.js`, `src/coins.js`):
ordered steps, explicit prerequisites, a named output per step, three routes (world building,
gardening, evidence research), a human review boundary for anything that claims real work, and a
rule that a step advances only from a saved, attributed server fact.

## The quest model

Schema 17 adds three additive tables (no existing table, column, view definition or row is
rewritten except the `calling_objective_rules` view, which is recreated identically plus the
published step rules):

```sql
quest_chains(id TEXT PRIMARY KEY, slug TEXT UNIQUE, title, route, summary, narrative,
             origin CHECK IN ('built_in','operator'), author_account_id REFERENCES accounts(id),
             status CHECK IN ('draft','published','archived'), practice CHECK IN (0,1),
             beneficiary, created_at, updated_at)

quest_steps(id TEXT PRIMARY KEY, chain_id REFERENCES quest_chains(id),
            ordinal CHECK BETWEEN 1 AND 8, slug, title, instructions, output_name,
            source_kind CHECK IN (<the calling source registry>),
            requires_review CHECK IN (0,1), target CHECK BETWEEN 1 AND 3,
            prerequisite_step_id REFERENCES quest_steps(id), created_at,
            UNIQUE(chain_id,slug), UNIQUE(chain_id,ordinal))

quest_enrollments(id TEXT PRIMARY KEY, agent_id REFERENCES agents(id),
                  account_id REFERENCES accounts(id), chain_id REFERENCES quest_chains(id),
                  started_at, idempotency_key, created_at,
                  UNIQUE(agent_id,chain_id), UNIQUE(account_id,idempotency_key))
```

Identity is deterministic and self-describing: `id = 'chain:'||slug`, `id = 'step:'||chain_slug||'.'||step_slug`,
and a step's progress objective is `'quest:'||chain_slug||'.'||step_slug`.

**Steps, prerequisites, outputs.** A chain has 2–8 steps, ordinals 1..n with no gaps, unique slugs,
and every step after the first names a prerequisite that is an **earlier** step (defaulting to the
previous ordinal, so a chain is linear unless the author says otherwise). Each step declares exactly
one `source_kind` — the saved server fact that proves it — restricted to the chain's route, a
`target` of 1–3 facts, and an `output_name`, the named artifact the step leaves behind.
`requires_review` is **derived, not chosen**: it is true exactly when the proving fact is
`research_accepted`, i.e. when a different, authorized human accepted the work. Authoring, publishing
and recovery validation all reject a chain that breaks these rules, and triggers keep a chain's
identity (`id`, `slug`, `route`, `origin`, `practice`, author) immutable, keep step rows immutable,
and refuse to delete a chain that still has steps.

**Routes and their saved facts.**

| Route | `source_kind` allowed |
| --- | --- |
| `world_building` | `frontier_place`, `path_place`, `frontier_expand`, `home_furnish`, `shared_visit` |
| `gardening` | `crop_plant`, `crop_harvest`, `craft` |
| `evidence_research` | `research_claim`, `research_accepted` |

Every kind is an existing arm of the `calling_source_events` view over `frontier_blocks`,
`frontier_actions`, `world_objects`, `journey_visits`, `journey_crops`, the `journey.crafted` audit
receipt, `claims`, and — through `contributionSource` / `contributionEligibility`, the same
predicate the coin ledger uses — an independently accepted submission. A practice chain cannot take
the evidence route, and a real evidence chain must end with an acceptance step.

## How progression is proved from saved facts

`reconcileQuests()` in `src/quests.js` is the **only** writer of quest progress. It runs inside the
existing cosmetic pass (calling objectives first, then enrolled quest steps in chain/ordinal order),
so one saved fact is credited at most once and the ten-a-day limit is applied deterministically.

For each enrolled, published chain, in ordinal order, it:

1. skips a step whose credited evidence already reaches its `target`;
2. `break`s the chain while a prerequisite step is incomplete — a later step can never move first;
3. otherwise selects the next unused source event of the step's kind that is dated to the current
   UTC day, occurred **at or after** `max(selected_at, quest_enrollments.started_at)`, and is not
   already referenced by any receipt;
4. inserts one `calling_receipts` row (`points = 5`, `proof_hash` over the same tuple as calling
   receipts) and lets the existing triggers re-check the source, the daily limit and append-onlyness.

The credit therefore lives in the **existing** table with its existing constraints —
`UNIQUE(agent_id, source_kind, source_id)` and `UNIQUE(agent_id, earned_day, objective_id)`. There is
no parallel dedupe table, no new idempotency scheme and no new reward path. `reconcileQuests`
reads no client input at all: the API has no parameter that can name a source or a completion.

Consequences asserted in tests: a repeated read, a repeated `POST /quests/complete`, a repeated
`POST /quests/join` with the same `Idempotency-Key`, and a full close-and-reopen replay all leave the
receipt count unchanged; a hand-written receipt is refused by the existing trigger; deleting an
enrolment makes `validateDatabase` fail rather than leave an unattributable receipt.

## Why a quest cannot mint a coin

`src/quests.js` contains no coin code and never writes to `coin_rewards`; the ledger's
`coins_validate_insert` trigger and `awardCoins()` remain the only issuance path, and every
eligibility rule in `src/coins.js` is untouched — an accepted submission, an independent
`admin`/`reviewer` who is not the contributor's account, a non-demo mission, matching task versions,
a latest non-quarantined submission, a fixed 10, one receipt per task, a normalized-work fingerprint
and the operator's 100-a-day cap.

A quest can only *observe* that work: its `research_claim` step is credited from the leased claim
(a commitment, not an outcome) and its final `research_accepted` step from the accepted review
receipt. Tests assert both halves at once — a completed practice chain leaves `coin_rewards` empty,
while the same contributor's independently accepted real contribution still yields exactly one
10-coin receipt, and the wallet still reports `balance = 10`, `integrity_valid = true`.

Coins and cosmetic progress stay separate in the other direction too: a practice chain grants 5
cosmetic experience per step inside the same ten-a-day calling limit, and that experience is not
currency, land or permission.

## The practice chain (shipped)

**The Quiet Harvest** — `quiet-harvest`, `gardening`, `origin = built_in`, published on first open,
**no beneficiary, no claimed real-world outcome**:

1. *Sow a first row* — output: one planted crop in your own garden (`crop_plant`).
2. *Wait, tend, and gather* — after step 1; output: two gathered resources from a mature crop
   (`crop_harvest`).
3. *Make one keepsake* — after step 2; output: a crafted keepsake made from your own harvest
   (`craft`).

Narrative (original, and what a resident reads in the board):

> Nothing in this chain is promised to anyone outside NemoWorld. It is a practice of patience,
> written for a resident who wants to learn how the garden actually answers. Begin with a single
> patch of turned soil beside your own door: one row is enough, and the seed costs nothing. Then
> wait. A crop keeps its own time, and tending it only shortens the wait by a little, never by as
> much as you might hope. When the server says the row is ready, gather it and count what the ground
> gave you. Finally take those two resources to the workshop and make one small keepsake — a
> lantern, a banner, a crown of flowers. Hang it or wear it. The chain ends there, with an object in
> your own hands and no claim on anyone else's life.

`tests/quests.test.js` completes it end to end (plant → tend → harvest → craft, over two UTC days)
and asserts three receipts, 15 cosmetic experience, `coin_rewards` empty, a valid calling ledger,
`verifyQuestStructure`/`verifyQuestReceipts` true, `shared-world-account-v17` export contents, and a
backup/restore round-trip that still validates. The release harness (`npm run e2e`, new step 11)
authors a second chain over the shipped HTTP API as the administrator, publishes it, enrols a second
resident, drives that resident across the Commons to the frontier, saves a ground path and a raised
block in its steward plot, and asserts both ordered steps complete **once each** with zero coins —
while the earlier independently accepted contribution still holds its single 10-coin receipt.

## Changed files

- **New:** `src/quests.js`, `tests/quests.test.js`, `tests/quests-http.test.js`, `docs/QUESTS.md`,
  `docs/handoff/task-05-quest-chains.md`.
- **Extended:** `src/vocations.js` (the rules view gains the published step rules; receipt
  verification accepts an authored step; the cosmetic pass also runs quest progression),
  `src/database.js` (schema 17, `QUEST_SCHEMA`, the rules view recreated idempotently),
  `src/recovery.js` (accepted versions 1–17, a `version >= 17` block, quest structure/receipt
  validation, quest tables checked), `src/platform.js` (`initQuests`, quest methods assigned, quest
  export section, exporters bumped to `shared-world-account-v17`, account deletion),
  `server.js` (five write routes, two GET routes, the public catalogue, the join idempotency key),
  `app.js` (the Quest chains section, the next-action card in the section and the world aside, the
  authoring form, the nav entry), `package.json` (`node --check src/quests.js` in the check gate),
  `scripts/e2e-smoke.mjs` (step 11, and an optional per-request body for `moveOnce`/`walkTo`).
- **Version assertions only:** `tests/recovery.test.js`, `tests/mayor-evidence.test.js`,
  `tests/civic.test.js`, `tests/ambassadors.test.js`, `tests/coins.test.js`,
  `tests/resident-crash.test.js`, `tests/resident-state.test.js`, `tests/followups.test.js`,
  `tests/elevation-http.test.js`, `tests/human-players.test.js`, `tests/expansion-http.test.js`,
  `tests/vocations.test.js`, `tests/local-launch.test.js` (current-version expectations 16 → 17 and
  the export format string; legacy expectations such as `user_version = 6`, `9`, `10`, `13`, `14`
  and `15` are unchanged and still assert forward migration to 17).
- **Docs:** `docs/API.md`, `docs/CALLINGS.md`, `HANDOFF.md`.

## Verification

All four gates on the delivered worktree, Node v24.19.0:

```
$ npm run check
> node --check server.js && … && node --check src/vocations.js && node --check src/quests.js && …
(no output; every file parses)

$ npm test
ℹ tests 410
ℹ suites 0
ℹ pass 410
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0

$ npm run e2e
PASS  11. an authored quest chain advances only from saved facts, once, and mints no coins
        201 author draft; 200 publish; 400 refused client completion; 201 join (idempotent repeat);
        200 travel; saved facts path 30,30 and wood 31,30 in plot:0:0:5:5; both ordered steps
        complete once each (10 cosmetic experience); 0 coins from the chain, 10 coins still held by
        the independently accepted contribution  (3148 ms)
SUMMARY  11 steps passed, 0 failed

$ node scripts/seal-content.mjs --check
Verified: 86 definitions (20 appearance, 7 block, 29 cosmetic, 3 crop, 27 furniture); 3 support
files; 42 referenced notices and assets.
```

A pre-change database (the schema 16 assertions in `tests/resident-state.test.js`,
`tests/ambassadors.test.js`, `tests/vocations.test.js`, `tests/human-players.test.js` and
`tests/recovery.test.js`) opens, migrates to 17, passes `validateDatabase` and survives a
backup/restore round-trip; `tests/quests.test.js` also asserts the same for a database that holds
quest receipts.

## What this deliberately did not do

- **No completion endpoint.** Progress is derived; `POST /quests/complete` exists only to refuse and
  to be testable. There is no "mark step done" API at all.
- **No client-facing progress writer.** A runtime cannot author, manage, begin or leave a chain, and
  a runtime read returns only its own character's board.
- **No third ledger.** Quest progress is a calling receipt, so it inherits the existing constraints,
  the existing daily limit and the existing append-only proof hash rather than a new one.
- **No XP beyond the calling limit.** Quest steps do not raise the ten-a-day cosmetic cap, and one
  saved fact is credited once, so a Cultivator's objective and a gardening quest step each need their
  own planting. The board always names the next action, but this is a real constraint, not a
  convenience.
- **No new content definitions.** The practice chain is a seeded, code-side chain (mirroring the
  seeded practice missions), so the sealed content manifest is unchanged at 86 definitions. No
  `content/quests/*.json` kind was added.
- **No rewards, transfers, land, reviews or moderation for quests.** A chain grants no role,
  permission, scope, coin, land or reviewer authority, and it cannot approve anything.
- **No new dependency, engine or UI framework.** Vanilla browser modules, `document.createElement`
  and `textContent` only; `app.js` still contains no `innerHTML`.
- **No real-world claim.** The shipped chain has no beneficiary and asserts no outcome; the only
  real-work route is the existing mission/review workflow, which remains the sole coin path.

## UI verification and the manual walkthrough

**This repository has no browser automation.** There is no headless browser, no Playwright/Puppeteer
dependency, and the project rule is no npm dependencies, so the interface was not driven by a
scripted browser. The UI evidence is therefore (a) HTTP tests over the real routes asserting the
exact payload the renderer consumes, and (b) source-level assertions that the renderer is wired to
that payload and creates nodes instead of injecting markup
(`tests/quests-http.test.js`: `next_action`, `questNextCard`, `questProgressCard`,
`questAuthorForm`, `renderQuests`, `loadQuests`, `quests:'clipboard-list'`, and
`assert.doesNotMatch(source, /innerHTML/)`). A disposable manual browser walkthrough is written out
below; it has **not** been executed in this session and should be run before release.

Manual walkthrough (disposable database, e.g. `LUCY_DATABASE=/tmp/quest-check.sqlite node server.js`,
never the installed copy):

1. Register the first operator (administrator), open **My characters** and create an AI resident.
2. In the navigation, open **Quest chains**. Expect the heading *A path with real steps*, the policy
   paragraph naming the cosmetic limit and the coin boundary, and the published chain
   **The Quiet Harvest** with three ordered steps.
3. Press **Begin this chain**. The next-action card should read *The Quiet Harvest · step 1: Sow a
   first row*, name the output *One planted crop in your own garden*, name the saved fact it will be
   credited from, and show `0 of 1`.
4. Enter the world, go home (**Go home**), place a Crop patch with the build palette, then open
   **Garden & workshop** and plant a crop. Return to **Quest chains** (or press **Refresh
   progress**): step 1 becomes *Complete* with one saved fact listed, step 2 becomes the next
   action, and step 3 stays *Locked* naming its prerequisite.
5. Check **Calling & guild** / the HUD: the resident's cosmetic experience rose by 5 and the daily
   remainder dropped to 5. **Coin wallet** must be unchanged (0 for a fresh resident).
6. Reload the page and reopen the board: the same two steps and the same single saved fact — no
   second credit. Post `POST /api/v1/quests/complete` by hand (or observe the API test): HTTP 400,
   *"A quest step advances only from a saved server fact…"*.
7. As an administrator or reviewer, open the **Author a quest chain** disclosure, save a draft, and
   publish it; as an ordinary member the disclosure and the manage buttons do not appear, and the
   API refuses the call with 403.
8. Keyboard and screen-reader checks: every step is a list item with an `aria-label` naming its
   ordinal, title and state; the next-action card carries an `aria-label` naming the chain and step;
   all controls are ordinary buttons and are reachable with Tab; no focus trap and no hidden required
   field is introduced.

## Residual risks

- **One saved fact, one credit.** A resident who spends a source on a calling objective must repeat
  the activity to credit a quest step. This is the honest consequence of reusing the existing
  uniqueness constraint, but it can surprise a Cultivator or Builder; the board's next action is the
  mitigation, not a guarantee that residents will read it.
- **Reconcile-on-read.** Like calling objectives, quest progress is credited when the board, the
  calling view or the world refresh passes over the resident. A resident who acts and then never
  opens anything does not show progress until they do. Nothing is lost, but the timing is not
  event-driven in the database.
- **Daily-limit contention.** Objectives are reconciled before steps, so on a contested day the
  calling objective wins the fact and the step waits for the next UTC day. Deterministic, documented,
  and asserted — but a design choice a reviewer may prefer to revisit.
- **Administrator-managed seed.** The shipped practice chain can be archived by any administrator and
  cannot be edited; a reviewer cannot manage it. If an installation archives it, the practice
  catalogue is empty until an operator authors a chain.
- **Chain authoring is API-shaped in the UI.** The browser form takes a JSON array of steps. The
  server validates everything, but a field-per-step editor was not built, so authoring a chain of
  more than two steps in the browser is clunky.
- **No external evidence and no browser run.** The manual walkthrough above is written, not
  executed; no browser automation exists in this repository to execute it. UI behaviour is proved at
  the payload level plus source-level wiring, which is weaker than a real browser run.
- **Not a security proof.** Nothing here is claimed to be unhackable: a compromised server, direct
  database access or a colluding reviewer are outside this control set, exactly as the existing coin
  policy says. The quest layer adds no new authority, but it also adds no new defence.

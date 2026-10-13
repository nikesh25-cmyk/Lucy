# NemoWorld — DeepSeek Batch 03 task specifications

Six tasks, in order. Each is complete enough that an agent needs no further briefing: it states the
purpose, the exact files the task may change, its dependencies, the acceptance tests it must add, the
evidence it must return, its required handoff format, whether it can start now or is blocked on the
Luanti bridge, the existing system it **extends** (with `file:line` or route evidence) and a
**do-not-rebuild** list.

Measured runtime baseline: `a41d26046bd346cfe49f358d976ff157178352bc`, schema 22. Start a new
task branch from the latest `integration/nemoworld-completed` tip containing this reviewed packet. Read
[BATCH_03_BASELINE.md](BATCH_03_BASELINE.md) and [OWNERSHIP_AND_INTERFACES.md](OWNERSHIP_AND_INTERFACES.md)
first. One code task per branch; return a focused diff, meaningful tests and actual evidence
(`docs/deepseek/TASKS_BATCH_02.md:9`, `:95`).

“Can start now” means the prerequisites exist, not that shared files may be edited concurrently.
Serialize Tasks 1, 2 and 4 where they touch `src/platform.js`, Tasks 1 and 4 on `server.js`, and
Tasks 1 and 6 on `runtime/agent.js`. Task 3's authored content and Task 6's tests can be prepared
independently, then rebased and verified on the latest integrated source. If any task needs schema
23, reserve that version for one owner and rebase other schema work after it lands.

| # | Task | Can start now? | Needs a schema bump? |
| --- | --- | --- | --- |
| 1 | Agent mission adapter | **Yes** | No (extends existing records) |
| 2 | Persistent agent memory | **Yes** | Only if a new memory attribute/source needs one; else no |
| 3 | Cooperative mission content | **Yes** | No (content + fixtures) |
| 4 | Compute-budget controls | **Yes** | No (extends `resident_runs` + diagnostics) |
| 5 | Compatibility tests | **BLOCKED on the Luanti bridge** — specify now, run when the bridge exists | No |
| 6 | Security tests | **Yes** | No |

---

## Task 1 — Agent mission adapter

**Status: can start now.** Depends on nothing in this batch.

### Purpose

Let an AI resident **find, claim and submit** work through the mission API that already exists, with
the permission checks and safe-retry behaviour the world already enforces — so an external engine
(including the Luanti bridge) can drive mission work without a bespoke path and without a second
claim store.

### The existing system it EXTENDS (evidence)

- `GET /missions` — the mission directory, `src/platform.js:354` (`MISSION_LIMIT = 200`, `src/platform.js:37`);
  the paged directory and the acceptance rubric are documented at `docs/API.md:131`.
- `POST /claims` — `src/platform.js:408`; lease of 20 minutes (`src/platform.js:425`); one active claim
  per operator across all characters (`src/platform.js:421`, **429**); `Idempotency-Key` replay returns
  the original claim (`src/platform.js:411`–`:414`).
- `POST /submissions` — `src/platform.js:443`; the evidence shape (`docs/API.md:135`); key replay
  returns the stored row (`src/platform.js:446`); ten submissions per operator per day
  (`src/platform.js:449`).
- `POST /claims/release` — `src/platform.js:436`; `expireClaims()` — `src/platform.js:341`.
- Runtime strictness: `parseAction` (`runtime/agent.js:61`, exact key counts) and `authorizeAction`
  (`runtime/agent.js:272`, advisory only, must never approve what the server refuses —
  `tests/runtime-policy.test.js`).
- Scope + budget: `POST /runtime/start` (`src/platform.js:292`), `tokens.max_calls - used_calls`
  (`src/platform.js:311`), runtime `GET /runtime/status` (`src/platform.js:309`).
- Idempotency: `writeKey(runId, decision, path, body)` (`runtime/agent.js:57`); the header is sent on
  every runtime write (`runtime/agent.js:576`).

### Files this task may change

- `runtime/agent.js` — the mission-work actions and their observation/prompt plumbing.
- `src/platform.js` — `claim`, `submit`, `missionDirectory`, `expireClaims` and their helpers only.
- `server.js` — the **existing** `/missions`, `/claims`, `/submissions` handlers; no new route unless a
  genuinely new capability is needed, and then a new adjacent route, never a duplicate.
- `tests/**` — new and extended tests (see below).
- `docs/RUNTIME.md`, `docs/API.md` — update only the paragraphs whose behaviour changed.

### Dependencies

None. The mission/claim/submission records and the runtime credential path already exist.

### Acceptance tests this task must add

- A runtime credential with `contribute` inspects the directory, claims one task, submits once, and the
  server writes exactly one `claims` row and one `submissions` row.
- Repeating the same `Idempotency-Key` for the same task returns the original claim/submission and
  writes **nothing** again (no second row in `claims` or `submissions`).
- A runtime **without** `contribute` is refused on `/claims` and `/submissions`; a runtime whose
  character is paused/revoked is refused; a revoked/expired credential is **401** before the handler.
- Claim lease: after 20 minutes (`expireClaims`) the claim is `expired` and the task reopens; a second
  operator can then claim it.
- One active claim per operator: attempting a different still-open task while holding a claim is
  **429**; attempting the already-leased task is **409** because the task-status check runs first.
- A refused or failed action is never counted as a confirmed action (the run counters stay honest —
  `docs/RUNTIME.md:36`).
- A model given the mission directory cannot change its own `agent_id`, pick another operator's
  character, mint a coin, or approve evidence (`parseAction` refuses unknown fields).

### Evidence this task must return

- The branch, base commit and changed-file list.
- A focused `git format-patch` patch.
- Actual `npm run check` and `npm test` output (real numbers) and `npm run e2e` output.
- The new tests' names and the assertions each makes against the database.
- Explicit residual risks.

### Required handoff format

`docs/handoff/task-deepseek-batch03-01-mission-adapter.md`, following the shape of
`docs/handoff/task-04-crash-safe-jobs.md` (state model, what was tested, actual gate output, residual
risks, migration/rollback). Do **not** edit `HANDOFF.md` or `docs/VERIFICATION.md`.

### Do not rebuild

- **No second claim store.** `claims` is the one store; do not add a table, an in-memory map or a
  side file to track claim state.
- **No new auth scheme.** The runtime token from `POST /runtime/start` is the only credential; do not
  add an API key, a shared secret or a token in a prompt.
- **No bypass of scope checks.** `authorizeAction` is advisory; the server remains authoritative.
  Never approve an action the server refuses.
- **No coin path.** Claiming and submitting mint nothing. Only an independent human acceptance on a
  real mission issues a coin (`src/coins.js:2`, `:36`).
- **No revision of the review workflow.** `POST /reviews` and its independence rule
  (`src/platform.js:481`) are unchanged.

---

## Task 2 — Persistent agent memory

**Status: can start now.** Depends on nothing in this batch.

### Purpose

Store an agent's **goals, experience and sources per agent** without ever leaking one agent's private
information to another — reusing the shipped typed-memory model, its mandatory sources, its operator
approval and its isolation rules, rather than inventing a free-prose store.

### The existing system it EXTENDS (evidence)

- Schema-21 `resident_memory`: table + bounds — `src/vocations.js:360` (`MEMORY_LIMITS`: 24 facts,
  8/kind, 8 open proposals, 160 char value, 80 subject, 120 label, 10 prompt facts, 4 KiB prompt),
  `src/vocations.js:541` (`MEMORY_SCHEMA`), indexes at `:542`–`:544`.
- Methods: `memory` (`src/vocations.js:684`, `GET /memory`), `memoryPropose` (`src/vocations.js:697`,
  `POST /memory/propose`, scope `contribute`), `memoryManage` (`src/vocations.js:715`,
  `POST /memory/manage`, operator session). Routes: `server.js:138`; `GET /memory` at `server.js:536`.
- Mandatory source: a verified `calling_receipts` row, a finished `resident_runs` row that recorded a
  refusal, an independent review decision, or the operator's own input — `src/vocations.js:422`–`:441`;
  model at `docs/RUNTIME.md:69`.
- Existing allowed memory source kinds are `calling`, `receipt`, `run`, `review` and `human`
  (`MEMORY_SOURCES`, `src/vocations.js:354`). The versioned evidence library exists separately in
  schema 22 but is **not** an allowed direct `resident_memory.source_kind`.
- Isolation rules to reuse: another operator **404**, sibling character **404**, human avatar **404**,
  revoked credential **401** (`docs/API.md:443`; also `docs/handoff/task-38-frontend-integration.md:100`
  for the browser proof).
- The no-credentials / no-contact-address rule: `docs/RUNTIME.md:101`, re-checked by `validateDatabase`
  (`src/recovery.js:424`).

### Files this task may change

- `src/vocations.js` — the memory tables, bounds, methods and the prompt-eligible view.
- `src/platform.js` — only the memory read/write plumbing it already owns (e.g. `memory()`
  delegation, receipt lookups).
- `src/journey.js` — only if a memory source must read a journey record it already owns.
- `src/database.js`, `src/recovery.js` — **only if** the task adds a new attribute, kind, source or
  insert-time integrity trigger and therefore needs a schema bump (then this task is the single
  schema owner — see ownership §6). Prefer the shipped source kinds for this batch.
- `tests/**`.
- `docs/RUNTIME.md`, `docs/API.md`.

### Dependencies

None. If a schema bump is taken, the four acceptance items in ownership §6 apply (migration +
backup/restore round-trip + version assertions + fail-closed validation).

### Acceptance tests this task must add

- Owner-only visibility: the owning operator session and the exact resident's own runtime credential
  read the fact; **another operator → 404**, **a sibling character of the same operator → 404**,
  **a human avatar → 404**, **a revoked/expired credential → 401**.
- Source required: a proposal with no supporting saved server fact answers **409**; a resident proposal
  that claims human input is refused **403**; the handler refuses unsupported source references and
  `validateDatabase` refuses an injected orphan. The shipped insert trigger checks operator decision
  and ownership, not general source existence. If insert-time source validation is added, it requires
  a separately owned schema bump and all four migration acceptance gates.
- Budget: a fact past 24 active, 8 per kind, or 8 open proposals is refused with the exact limit; the
  prompt carries at most 10 approved facts inside the 17,000-byte observation budget
  (`runtime/agent.js:32`, `OBSERVATION_BYTE_BUDGET`) with whole facts pruned.
- No secret leakage: a value shaped like a credential, an authorization value, a contact address or a
  link is refused at the point of writing **and** re-checked by recovery.
- Survives a restart: memory lives in `resident_memory`, the runtime reads it inside the private
  resident read it already makes (so it adds no API call), and a resume replays no action and renews no
  budget.

### Evidence this task must return

Branch, base commit, changed-file list, focused patch, real `npm run check` / `npm test` output, the
new test names with the isolation assertion each makes, and (if bumped) the migration + backup/restore
evidence.

### Required handoff format

`docs/handoff/task-deepseek-batch03-02-memory.md`, following `docs/handoff/task-21-resident-memory.md`
and `docs/handoff/task-04-crash-safe-jobs.md`. Do not edit `HANDOFF.md` / `docs/VERIFICATION.md`.

### Do not rebuild

- **No free-prose memory.** Memory is typed facts, never an arbitrary text blob.
- **No second source registry.** Reuse `calling`, `receipt`, `run`, `review` and `human`. An evidence
  capture may inform a separately reviewed claim, but it is not a direct memory source in schema 22.
- **No widened limits.** 24/8/8/160/80/120 stay; do not raise a value to make a case pass.
- **No new visibility rule.** The 404/404/404/401 pattern is the rule; do not add a sharing option.
- **No memory without a source**, and no resident that decides its own proposal.
- **No credential, contact address or link** stored.

---

## Task 3 — Cooperative mission content

**Status: can start now.** Depends on nothing in this batch. The Luanti bridge may add content later,
but the design, the content and the fixtures do not need it.

### Purpose

Design **tasks that span several sessions and multiple contributors**, with clear evidence
requirements and a human review boundary — shipped as **content and fixtures**, not as a new mechanic.
The mechanic already exists three times over (quest chains, guild projects, cooperative events); this
task authors real content on top of it and proves the boundaries with fixtures.

### The existing system it EXTENDS (evidence)

- Cooperative events — `RESTORATION_PLAN` (`src/community.js:79`), the derived-progress census
  (`src/community.js:508`–`:577`), completion (`src/community.js:656`), routes `/restoration/*`
  (`server.js:143`–`:145`). Model at `docs/handoff/task-23-cooperative-events.md`.
- Quest chains — shipped `SEED_QUESTS` (`src/quests.js:74`), join (`src/quests.js:285`),
  always-refused completion (`src/quests.js:310`); `/quests/*` (`server.js:130`–`:132`). Model at
  `docs/QUESTS.md`.
- Guild projects — create/participate/contribute/verify (`src/guilds.js:234`, `:267`, `:297`);
  `/guilds/*` (`server.js:133`–`:137`). The **distinct-operator** verification rule:
  `docs/handoff/task-06-guild-projects.md:103`.
- Independent-review boundary for coins: `/reviews`, `/adoptions` (`server.js:120`), `src/platform.js:481`,
  `src/platform.js:501`; policy `src/coins.js:2`.
- The seal workflow for any sealed content: `scripts/seal-content.mjs` (`--check`),
  `docs/CONTENT_DEFINITIONS.md:60`.

### Files this task may change

- `src/quests.js` — new authored chain(s) in the `SEED_QUESTS` shape and the minimal per-slug,
  idempotent seed update needed to install them in an existing world. Do not alter quest progress
  mechanics.
- `src/guilds.js` — only if new plan/brief **content** is needed (not new mechanics).
- `src/community.js` — only if new plan **content** is needed (not new mechanics).
- `content/**` — **only through `scripts/seal-content.mjs`** (`docs/CONTENT_DEFINITIONS.md:60`).
- `tests/**` and `tests/fixtures/**` — the fixtures that prove the boundaries.
- `docs/QUESTS.md`, `docs/GUILDS.md`, `docs/PEACEFUL_WORLD.md` — content docs.

### Dependencies

None. If a fixture needs a new sealed content entry, that entry goes through the sealer.

### Acceptance tests this task must add

- A multi-session chain: each step advances **only** from a saved, attributed server fact recorded at
  or after the resident joined; replay/restart cannot double-advance.
- An upgraded database with an existing built-in chain receives each new chain exactly once without
  changing any enrollment or step history. `initQuests` currently returns as soon as *any* built-in
  chain exists (`src/quests.js:256`–`:258`), so adding only `SEED_QUESTS` data would not install it.
- A multi-contributor task: progress is **derived** from saved rows (a placed object, a real sowing, a
  real craft, a circle another operator keeps), never stored as a claim.
- **A pledge is never completed work.** After N pledges, every step's progress is still zero and no
  artifact exists (`docs/handoff/task-23-cooperative-events.md:127`).
- **Coins need independent real-contribution acceptance.** A whole cooperative flow leaves
  `coin_rewards` empty; only an independent human acceptance on a real mission issues exactly one
  10-coin receipt (`src/coins.js:36`; `docs/handoff/task-06-guild-projects.md:123`).
- Distinct-operator verification: a sibling character and the project creator are both refused
  (`docs/handoff/task-06-guild-projects.md:103`).
- The content seals cleanly: `node scripts/seal-content.mjs --check` passes and the definition count
  is reported.

### Evidence this task must return

Branch, base commit, changed-file list, focused patch, real gate output (including the seal count), and
the authored content with its narrative and its evidence requirements spelled out so a reviewer can
judge whether the evidence bar is clear.

### Required handoff format

`docs/handoff/task-deepseek-batch03-03-cooperative-content.md`, following
`docs/handoff/task-05-quest-chains.md` and `docs/handoff/task-06-guild-projects.md`. Do not edit
`HANDOFF.md` / `docs/VERIFICATION.md`.

### Do not rebuild

- **No new mechanic, table, column, trigger or route.** If a spec seems to need one, the design is
  wrong — re-shape the content to what the three existing systems already measure.
- **No second verification system.** Independence is decided by operator, never by character.
- **No promise counted as progress.** A pledge is labelled as a promise everywhere it appears.
- **No coin from content.** Authored content never mints; only independent human acceptance does.
- **No new authority in the content.** A guild project grants no calling, role, land, review power or
  building right (`docs/handoff/task-06-guild-projects.md:141`).

---

## Task 4 — Compute-budget controls

**Status: can start now.** Depends on nothing in this batch.

### Purpose

Enforce **spending limits and stop conditions** for AI work, and make the world's **unit separation**
explicit and testable. Extend the operator diagnostics and the durable run budgets that already exist;
add no money flow.

### The existing system it EXTENDS (evidence)

- Operator diagnostics — `GET /operations` (admin only) returns `diagnostics` (`docs/API.md:161`);
  field semantics in `docs/OPERATIONS.md:258`: model queue (`state`, `queue.active/waiting/max_waiting`,
  `saturation`, `full`, `inference.in_flight`, `since_process_start.rejected_saturated`), storage
  (`database_bytes`, `wal_bytes`, `shm_bytes`, `total_bytes`), `workers.*`, `runs.*`, `failures.*`,
  `recovery.*`. Redaction: `docs/OPERATIONS.md:275`.
- Durable run budgets — `resident_runs` decision/decision_budget/model_calls/action_count/failed_*/
  stop_reason/credential_hash (`src/database.js:96`), `startResidentRun` (`src/platform.js:912`),
  `recoverWorkerJobs` (`src/platform.js:888`), `POST /residents/resume` (`docs/API.md:304`).
  Stop reasons: `docs/RUNTIME.md:28`.
- Runtime budget counters — `tokens.max_calls - used_calls` (`src/platform.js:311`), the runtime's
  own two-minute default / ten-call default and the 20-minute / 20-call maxima (`docs/RUNTIME.md:20`).
- Bounded model queue — `boundedModel(model, {maxWaiting})` (`runtime/model.js:4`), default 8, allowed
  0–20, refusal `Local model is busy…` (`runtime/model.js:26`); wired at `server.js:386` with
  `modelQueueWait` validated at `server.js:363`; counters at `server.js:374` and `:404`. Saturation
  drill: `node scripts/ops-rehearsal.mjs --drill model-queue-saturation` (`docs/OPERATIONS.md:313`).

### The unit-separation rule (must be stated and made testable)

**Virtual coins (NemoCoins), compute credits, real money and verified carbon credits are four
separate units.** There is:

- **no conversion path** between any two of them;
- **no cash-out** and **no token**;
- **no NemoCoin exchange rate or redemption value, no compute/carbon-credit price, and no land-sale
  price in this build** (`docs/LAND_WORLD.md:78`; `src/coins.js:2`: `transferable: false`, no cash
  value). Existing research cost scenarios in real currencies remain legitimate planning data.

Write this as a single exported, frozen policy object (the idiom of `COIN_POLICY`, `src/coins.js:2`)
and assert it in a test: NemoCoin has the existing nontransferable `coin_rewards` ledger; compute
credits, real money and verified carbon credits are **unimplemented concepts** with no balance,
ledger, transfer or conversion route. Give all four distinct identifiers and implementation states;
do not invent three empty ledgers merely to satisfy a test. A future unit needs its own design,
evidence standard and authorization review, never an implicit conversion.

### The "~10% of donated computing credits" proposal (recorded as an open hypothesis only)

The "≈10% of donated computing credits to exploration/social/learning" is a **proposal only**. Record
it in the handoff and (if useful) in an open-questions doc as a hypothesis with, at minimum:

- its **credit unit** (which of the four separate units, or a fifth that does not exist yet);
- **donor consent** (who donates, on what terms, revocably);
- an **evaluation** (how success would be measured);
- whether it is even enforceable given the shipped architecture.

It must **not** be implemented as a money flow, a transfer, a conversion, a matching rule or a
balance. Until the credit unit, consent and evaluation are agreed, this stays an unverified hypothesis
marked as such. Attribute the figure only to this packet's open proposal; it is not a measured
quantity or an approved user policy in the available record.

### Files this task may change

- `src/platform.js` — run-budget fields, the resume plan, the budget/stop-reason plumbing.
- `src/recovery.js` — the diagnostics vocabulary and, if a new counter is required, its `version >= N`
  validation (only the diagnostics/policy parts; the schema owner rule in ownership §6 applies if a
  version bump is taken).
- `server.js` — the `/operations` and `/residents/*` payloads, `modelQueueWait`, the model counters.
- `runtime/model.js` — the bounded queue (bounds only; never a raised default to pass a test).
- `scripts/ops-rehearsal.mjs`, `scripts/capacity-experiment.mjs` — drill/config only.
- `tests/**`.
- `docs/OPERATIONS.md`, `docs/PERFORMANCE.md` — the diagnostics/bounds paragraphs.

### Dependencies

None. Task 1's adapter reports into the same run budgets, but neither blocks the other.

### Acceptance tests this task must add

- **Budget exhaustion stops a run** with a specific named stop reason (a model-decision budget, an API
  budget, a duration limit) and the counters reflect the actual calls/actions
  (`docs/handoff/task-04-crash-safe-jobs.md:28`).
- **`POST /residents/resume`** refuses when the remaining decision/API budget is gone, when the
  character or platform is paused, and when the interrupted run's credential is still usable.
- **Model-queue bound** refuses overflowing work at its own boundary and inside the shipped server,
  where the refusal falls back to published rules and is counted (`docs/OPERATIONS.md:313`).
- **Unit separation**: an assertion that models the four units as distinct with no conversion path,
  no cash-out and no token; the `~10%` hypothesis has no implementation, no route and no balance.
- **Redaction**: the admin diagnostics payload contains no token, no password digest, no contact
  address, no private message/journal/artifact (`docs/OPERATIONS.md:275`), and the public `/health`
  stays aggregate-only.

### Evidence this task must return

Branch, base commit, changed-file list, focused patch, real gate output, and a **table of every limit
and stop reason** with the file:line that enforces it and the test that proves it. State explicitly
that no limit was raised and no money flow was added.

### Required handoff format

`docs/handoff/task-deepseek-batch03-04-compute-budgets.md`, following
`docs/handoff/task-27-operations.md` and `docs/handoff/task-04-crash-safe-jobs.md`. Do not edit
`HANDOFF.md` / `docs/VERIFICATION.md`.

### Do not rebuild

- **No payments, token sales, cash-out or blockchain.** No paid provider and no cost budget — only
  local compute is supported (`docs/RUNTIME.md:138`).
- **No conversion path** between the four units, and **no new unit silently created**.
- **No implemented money flow** for the 10% proposal.
- **No raised limit** (queue, decisions, calls, minutes, storage) to make a case pass.
- **No new diagnostics surface exposed publicly.** Diagnostics stay admin-only, redacted.

---

## Task 5 — Compatibility tests

**Status: BLOCKED on the Luanti bridge.** Specify it now; implement and run it when the bridge exists.
**Do not build the bridge** — that is the Luanti agent's work.

### Purpose

Prove that **the native (Luanti) client and the existing web interface use the SAME mission records**
and that both **survive restarts without duplicate submissions** — i.e. one world, two clients, one
source of truth, no double-credit.

### The existing system it EXTENDS (evidence)

- Browser suite — `scripts/browser-suite.mjs`, scenario registry `SCENARIOS`
  (`scripts/browser-suite.mjs:102`); production-database refusal, teardown in `finally`, failure
  traces. Model at `docs/handoff/task-15-browser-acceptance.md`.
- HTTP acceptance harness — `scripts/e2e-smoke.mjs`, 15 steps (`docs/handoff/task-15-browser-acceptance.md:147`).
- Crash-recovery tests — `tests/resident-crash.test.js` (process-level `SIGKILL`, classification),
  `docs/handoff/task-04-crash-safe-jobs.md:155`; durable `resident_runs` (`src/database.js:96`).
- The shared records themselves: `missions`/`tasks`/`claims`/`submissions`/`reviews`/`adoptions`
  (`src/platform.js`), one active claim per operator (`src/platform.js:421`), `Idempotency-Key`
  (`runtime/agent.js:57`).

### Files this task may change

- `scripts/browser-suite.mjs` — new scenarios + the registry count assertion.
- `scripts/e2e-smoke.mjs` — a new step driving the bridge.
- `tests/browser-suite.test.js` — registry count.
- `tests/**` — the bridge-compatibility test(s) and any fixture.
- A bridge test harness **only if** the Luanti agent provides the bridge entry point; this task does
  not create it.

### Dependencies

**Blocked on the Luanti bridge.** The spec can be written and reviewed now; the tests cannot run until
the bridge exists. Coordinate the bridge's test entry point (a CLI or a module the harness can spawn)
with the Luanti agent **before** writing the test bodies.

### Acceptance tests this task must add (specify now, run later)

- **Same records:** one mission, claimed and submitted through the web interface, is visible with the
  same id/state to the native client (and vice versa) — no second mission record is created.
- **Restart without duplicate submission:** a submission made, then a server restart, leaves exactly
  one `submissions` row; a resumed / retried write does not duplicate it (the `Idempotency-Key` and the
  crash-classification path are the mechanisms).
- **One claim:** if the second client attempts the same leased task, the server returns **409**;
  if the same operator attempts a different open task while holding one, it returns **429**.
- **Credential boundary:** the trusted bridge receives only a short-lived scoped runtime token in
  memory, never persists or logs it, and never exposes it to a model or world text. Native human
  mutations require a separate, explicitly designed operator-pairing credential; an AI token cannot
  attribute a human action.
- The scenarios are added to the suite registry and the registry-count assertion is updated.

### Evidence this task must return

The exact scenario names, the harness output, the database assertions each scenario makes, and the
**date and bridge commit** the compatibility was run against. Until the bridge exists, the deliverable
is the written spec; any skeleton remains pending and must never be reported as passed. The final
gate must exercise a real Luanti server/mod callback through the bridge, not only a Node HTTP client.

### Required handoff format

`docs/handoff/task-deepseek-batch03-05-compatibility.md`. It must state clearly which assertions were
**run** and which remain **pending the bridge**. Do not edit `HANDOFF.md` / `docs/VERIFICATION.md`.

### Do not rebuild

- **Do not build the bridge.** Not the engine, not the Lua mod, not the native client.
- **Do not add a second mission store or a second submission path** for the native client.
- **Do not weaken an existing scenario** to make a new one pass; the browser suite is order-dependent
  and timing-sensitive (`docs/handoff/fix-browser-suite-flake.md`).
- **Do not report a skipped test as a pass.**

---

## Task 6 — Security tests

**Status: can start now.** The malicious-task-text cases interact with Task 1, but neither blocks the
other.

### Purpose

Prove the world refuses **impersonation, unauthorized actions, malicious task text, and agents trying
to approve their own work** — extending the existing reward-abuse audit and the untrusted-observation
tests. **For every control, require a test whose removal makes it fail** (the "load-bearing" idiom:
`docs/handoff/task-08-coin-abuse-review.md:69`).

### The existing system it EXTENDS (evidence)

- Reward-abuse audit — `tests/coin-abuse.test.js` (10 tests: self-review, multiple agents under one
  operator, replay, suspension, quarantine, source reuse, clock boundaries, backup tampering,
  concurrency, ledger/cosmetic split); the structural fix in `src/coins.js:21`
  (`receiptIntegrity`, enforced by `verifyCoinLedger`, `src/coins.js:33`). Model at
  `docs/handoff/task-08-coin-abuse-review.md`.
- Untrusted observations — `runtime/runtime.test.js` (impersonation,
  malicious cooperative output, prompt injection): `runtime/runtime.test.js:192`, `:252`, `:598`; the
  untrusted framing assertion at `runtime/runtime.test.js:374`; the pruner's adversarial tests in
  `runtime/runtime.test.js` (task 03, `docs/handoff/task-03-observation-pruning.md:104`).
- Independent review + adoption — the four distinct roles and their refusals: `src/platform.js:481`,
  `/review/workbench` (`docs/API.md:571`), self-review refused
  (`docs/handoff/task-15-browser-acceptance.md:81`).
- Threat model — `docs/THREAT_MODEL.md` (assets, actors, trust boundaries; `docs/THREAT_MODEL.md:23`).

### Files this task may change

- `tests/coin-abuse.test.js` — extended cases.
- `runtime/runtime.test.js` — extended adversarial cases.
- `tests/**` — new focused test file(s) if the audit grows beyond the two above.
- `src/coins.js`, `src/platform.js`, `runtime/agent.js` — **only** minimal control fixes a failing
  test actually requires, each with a named regression test.
- `docs/THREAT_MODEL.md` — the residual-risk paragraphs.

### Dependencies

None. (Task 1's adapter adds the malicious-task-text surface; the tests can be authored against the
existing routes and re-run against Task 1 when it lands.)

### Acceptance tests this task must add

- **Impersonation** — an agent cannot act as another resident: `parseAction` refuses a model-supplied
  `agent_id`; a runtime credential is bound to its own character; a human avatar cannot receive a
  runtime token (`src/platform.js:295`); an ambassador/NPC cannot receive credentials
  (`docs/handoff/task-15-browser-acceptance.md:81`).
- **Unauthorized actions** — every action outside the credential's scopes is refused; a `build` action
  from a `read/move/chat` credential is refused; a paused/revoked credential is refused before the
  handler.
- **Malicious task text** — a task description or a message that claims to grant a scope, name a tool,
  choose a recipient or change a budget changes nothing: `granted_scopes` is unchanged and a `travel`
  to an unobserved world still fails (`docs/handoff/task-03-observation-pruning.md:124`).
- **Self-approval** — a contributor, their sibling character and an administrator cannot accept their
  own contribution; an agent cannot approve its own guild contribution or its own mission submission;
  adoption requires a different person from the contributor and from the reviewer
  (`docs/API.md:577`).
- **Load-bearing controls** — for each refusal, temporarily disable the control and confirm the test
  **fails**, then restore it and confirm it passes. Record the before/after counts (the idiom of
  `docs/handoff/task-08-coin-abuse-review.md:69`).

### Evidence this task must return

Branch, base commit, changed-file list, focused patch, real gate output, a **threat/verdict table**
(control → holds/refused → the test that proves it → whether the control is load-bearing), and the
residual risks. Never claim any system is unhackable (`docs/handoff/task-08-coin-abuse-review.md:79`).

### Required handoff format

`docs/handoff/task-deepseek-batch03-06-security-tests.md`, following
`docs/handoff/task-08-coin-abuse-review.md`. Do not edit `HANDOFF.md` / `docs/VERIFICATION.md`.

### Do not rebuild

- **No payment, token-sale, cash-out or blockchain** as a substitute for authorization.
- **No new auth scheme.** Use the existing session/runtime credential model.
- **No relaxation of a control** to make a test pass; if a control is missing, fix it minimally and add
  its regression test.
- **No claim of being unhackable**, and no invented result.

---

## Required delivery for every task (the standing convention)

From `docs/deepseek/TASKS_BATCH_02.md:95`:

- Branch and base commit; changed-file list; focused `git format-patch` patch.
- Actual syntax / unit / HTTP / browser results — the **real** numbers.
- Source/asset provenance where relevant; explicit limitations.
- Migration/rollback notes if a schema change is involved.
- **Never** resolve a failing gate by deleting coverage, inventing a result, or silently raising a
  permission, reward or capacity limit.
- Leave `outputs/Lucy`, the installed database, credentials and model weights untouched.
- One code task per branch; return the diff to the integrator for review.

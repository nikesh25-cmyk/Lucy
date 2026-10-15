# Wave 3 — a declared resident framework

Branch `framework-wave3-resident`, based on `27c0d72` (schema 25, clean tree). Baseline at that
commit, measured on this machine with Node 24.15.0: **165 test files, 1074 tests, 0 failures**,
syntax gate green (`checked 99 files, 0 failed`), e2e harness 20 steps green.

This slice gives one resident three things it did not have: a **declaration** derived from the rows
the world already holds, a **declared action lifecycle** that executes one intent exactly once and
records every step that does not complete, and an **operator- and moderator-visible inspection
surface** that reads the declaration, the budget, the purpose, the action history and the refusal
reasons without ever reading private material.

Nothing was added to the schema. No table, no column, no index, no version bump: the ledger is the
world's own append-only, hash-chained `audit` table, and everything else is derived on read.

## 1. The declaration, and where every field comes from

`declarationCore(platform, agent)` in `src/resident-framework.js` reads one object from existing
rows. It writes nothing — a declaration read is a pure read, so an inspection can never change a
state.

| Field | Source row | Notes |
| --- | --- | --- |
| `identity` | `agents` (+ `accounts.id` for the owner) | the resident id, name, kind, `status`, world, region, country, created_at, operator id. **`status` is the pause/revoke state itself** — paused, revoked, suspended or active. |
| `calling` | `resident_callings.calling_id` + the `CALLINGS` catalog | the chosen calling, its guild, its stated purpose, its charter and its own objective list. No calling recorded → the catalog default applies and `defaults` says so. |
| `purpose` | `resident_memory` rows with `kind='purpose'`, `state='active'` | **the purpose has a home today**: a purpose fact can only ever be recorded by the operator (`MEMORY_KINDS.purpose.sources = ['human']`, and both the write path and the insert trigger refuse a resident-authored purpose). `statement` is the recorded `intent` fact, falling back to the calling's own purpose text. `boundaries` are the recorded `boundary` facts, shown as declaration text. |
| `permitted_actions` | `tokens.scopes` × the calling's objective sources | one entry per declared action with its scope, its family, the purpose targets it may serve, and whether it is granted and available. |
| `budget` | the `tokens` row: the caller's own runtime credential when it names one, otherwise the live one, otherwise the most recent one | `max_calls`, `used_calls`, `remaining_calls`, `expires_at`, `scopes`, `revoked`, `live_credential`, `issued_credentials`. **This is the credential row, never a copy**: the runtime's own read and the operator's read of the same resident report the same numbers. |
| `limitations` | `agents.capabilities` / `agents.limitations` (operator-entered) + the shipped policy texts | plus the four human prerequisites and an explicit note that a free-text operator boundary is declaration text, not a machine-checked constraint. |
| `prohibitions` | this module's `PROHIBITIONS` table | for each of the four: the rule, whether the guard pre-existed or is new, and where the guard lives. |
| `may_act` / `may_act_reason` | derived | the first refusal that applies: `declaration_defect`, `resident_not_active`, `runtime_credential_required`, `credential_revoked`, `credential_expired`, `budget_exhausted`, `scope_not_granted`. |
| `defects` | derived | operator-entered claims of institutional authority in `name`/`capabilities`/`limitations`, or in a recorded purpose fact, with the field name and the remedy. |

**Fields the order demands that had no home, and how they were represented.**

- *"the actions it is permitted to take"* had no store at all: scopes are per credential and
  callings are per resident. It is represented as the **derived cross-product** of the credential's
  scopes and the calling's own objective sources, and the declared gateway checks both.
- *"its bounded budget"* had no per-resident figure: it is the **issued runtime credential**
  (`max_calls`/`used_calls`), which is also what the route already charges one call per write against.
- *"its limitations in human-readable form"* had two operator-typed fields (`capabilities`,
  `limitations`) but no statement of what the resident may not do: the four prohibitions and the
  human prerequisites are added as declaration text next to the operator's own words.
- *"current declared purpose"* is the one field with a real home (a `purpose` memory fact); no
  parallel store was created for it.

## 2. The declared action lifecycle

`POST /api/v1/residents/act` (runtime credential only, no fixed route scope — the lifecycle checks
the action's own scope against the credential row it re-reads). The declared vocabulary is `say`,
`emote`, `note`, `thanks`, `circle`, `pledge`, `rsvp`, `guild`, `garden`, `craft`, `remember`. Each
entry names the scope it costs, the world method it hands the request to, the purpose targets it can
serve, the fields a resident may state and the read-back that verifies the saved result. The world
method decides every world rule; this layer never re-implements one and never approves what the world
refuses.

| Step | What happens | Where it is enforced |
| --- | --- | --- |
| observe | the declaration is read from the agent row, calling, purpose, credential and status | `declarationCore()` |
| propose | the action must be a declared action; work actions must name a `serves` target; authored text is scanned for an institutional claim; coin/credit fields are refused by name | `declaredProposal()`, `institutionalClaim()`, `COIN_FIELDS` |
| authorize | declaration defects, platform pause, resident status, credential kind/revocation/expiry, the action's own scope, the purpose target and the remaining budget are all re-read **inside this transaction** | `declaredAction()` |
| execute once | the durable ledger is read for this resident + intent id before the world is touched | `ledgerForIntent()`, `declaredActionKey()` |
| verify | the saved row this action should have produced is read back inside the same transaction | per-action `verify()` |
| record | `resident.action.executed` / `.proposed` / `.refused` is appended to `audit` | `writeLedger()` |

The guarantees, each with the test that fails when the guard is removed:

1. **A retried or replayed action executes exactly once, verified against the real database.** The
   world write and its ledger line commit in the same transaction, and the ledger line is read back
   from the database before the world is touched again. `tests/resident-lifecycle.test.js` drives one
   `thanks`, retries the same intent, then **closes the platform and opens a second `Platform` on the
   same file** and retries again: the state is `replayed`, `executed:false`, and
   `community_thanks` still holds exactly one row.
2. **A run interrupted by a process restart cannot duplicate a completed action.** Same test: the
   second process reads the durable line and refuses to write again. It also cannot *silently* create
   an unconfirmed write, because there is no window: a process death leaves both the world row and
   its ledger line or neither.
3. **A run cannot continue past a revoked credential.** The credential row is re-read inside the
   authorize step, so a caller holding an older authorization snapshot — exactly what an interrupted
   process holds — is refused with `credential_revoked`, the refusal is recorded, and the world row
   count is unchanged. The same credential is also refused by `authenticate()` before the route.
4. **Every step that does not complete records an explicit refusal with a reason**, and a refusal is
   never reported as a success: `state:'refused'`, `success:false`, `applied:false`, `is_outcome:false`,
   a refusing HTTP status and a durable ledger line. Refusals are answered with 4xx/503, never 200.
5. **A verification failure rolls the write back.** The world write is isolated by a `SAVEPOINT`; when
   the saved row cannot be read back, the write is rolled back first and the refusal
   (`verification_failed`, 503) is recorded on its own. The test writes a message, deletes the row
   inside the same call and asserts that no message remains and that the ledger holds a refusal, not
   an execution.
6. **The resident cannot act outside its declaration.** Scope (the credential's own scope list),
   purpose (the calling's objective targets) and budget (the credential's remaining calls) each
   refuse on their own, with their own reason and their own recorded line.
7. **The resident ledger is the world's own audit chain**: `verifyAudit()` still holds after declared
   actions and refusals, a `backupDatabase` copy of the database still validates as schema 25 and
   carries the same ledger lines and world rows into a `restoreDatabase`, and no authored text reaches
   the ledger (asserted against a distinctive secret, and against the database file itself for the
   vault note).

Record id shape (text, in `audit.record_id`, no migration needed):
`<agent>|<intent>|<key>|<action>|<state>|<serves>|<ref>|<reason>`, where `key` is a SHA-256 over the
resident, the intent id and the canonical body, and `<ref>` is `private` for a private record so its
identifier is withheld from the history an operator reads.

## 3. The four prohibitions

| Prohibition | Guard before this branch | Where it lived | What this branch adds |
| --- | --- | --- | --- |
| an agent must not review its own work | **pre-existing** | `Platform.review` (a contributor's own account is refused), `Platform.adoption` (contributor and acceptance reviewer are refused), the `coins_validate_insert` trigger | no review, adoption or moderation action exists in the declared vocabulary, so a runtime credential cannot reach the same decision through the lifecycle; `review`/`adopt`/`moderate`/`award` are refused by name as `human_authority_required` and recorded |
| an agent must not claim institutional authority | **missing** → new | — | `institutionalClaim()` / `assertNoInstitutionalClaim()` over every text a resident authors through a declared action, and `declarationDefects()` over the operator-entered agent fields and the recorded purpose facts. A defect blocks every declared action of that resident |
| an agent must not award itself coins | **pre-existing** | `Platform.awardCoins` (an independent human review session is required and the reviewer's own account is refused), the append-only coin table and its eligibility trigger | no declared action carries an amount, a coin, a credit or a price; such a field is refused by name as `self_award_refused` and recorded |
| a proposal is never read as an outcome | **pre-existing** | the submission state model (`pending`/`held` are never `accepted`), the adoption boundary texts, the research prompt's own "no completed work" rules | the declared ledger's state vocabulary is closed (`executed`/`proposed`/`refused`), a proposal-class result always reports `proposal:true`, `achieved:false`, `real_world_outcome:null`, and `assertProposalNotOutcome()` refuses to serialize a proposal as an achievement |

The institutional guard is a bounded, word-level filter and says so: it refuses an assertion of
representation ("I am an official representative of the Ministry of Health"), an endorsement claim
("Accredited by the United Nations") and an official title ("goodwill ambassador"), and it leaves a
publisher mention ("published by UN Comtrade") and an honest denial ("no ministry has endorsed this")
alone. It is not a semantic check and cannot be one; the declaration states the same limitation.

Known hole, reported rather than fixed: the claim is still **storable**. `POST /agents` accepts it and
`GET /me` republishes it, because `createAgent` does no content check. See finding C in
`tests/framework/known-gaps-resident.mjs` for the repro and the patch proposal.

## 4. Operator and moderator controls, with privacy

The controls are the world's own: `POST /agents/control` (owner) sets active/paused/revoked and
revokes every runtime credential; `POST /moderation` (moderator, on an open report, uninvolved)
suspends; `POST /appeals/decide` (a different, uninvolved moderator or administrator) returns a
suspended resident to paused; the owner then resumes it. This branch adds the **inspection** surface
they are read through:

`GET /api/v1/residents/declaration?agent_id=…[&include=declaration,history]`

- the caller may be the owning operator, the resident's own runtime credential, or a moderator or
  administrator. Another operator's session gets the same 404 an unknown resident gets.
- it returns the declaration, the credentials and their budget, the current purpose, the bounded run
  records, the declared action history (with each refusal's reason and reason note) and the controls
  available to *this* caller, each with the reason it is refused.
- **privacy**: private memory rows, private and nearby conversations, vault contents and private
  drafts are never read. Asking for them (`include=memory|conversations|vault|drafts`) is refused by
  name with 403 and a `where_it_stays` pointer for each, so an exclusion can never be mistaken for an
  absence. The tests seed a distinctive secret into an operator preference, a private conversation
  and a vault note and assert the exact string appears in **neither** the operator's nor the
  moderator's response body, while the purpose, the history and the refusals *do* appear.

The resident's own runtime credential reads the same declaration inside the private `/callings` read
it already makes (`value.declaration`), so the runtime that acts and the operator who inspects read
one object computed by one function. A test compares the two reads field by field (only the live
call counters move between them, by the one call each request charges).

## 5. Files changed

| File | Why |
| --- | --- |
| `src/resident-framework.js` | new: the declaration, the declared action vocabulary and lifecycle, the four guards, the ledger reader/writer, the inspection surface, the `residentFrameworkMethods` mixin |
| `src/platform.js` | one import line and one `Object.assign` line attaching the mixin |
| `server.js` | the additive `GET /residents/declaration` route and its refusal status; the `POST /residents/act` route, the refusal-status branch after the write transaction, the `Idempotency-Key` pass-through, the one `/residents/act` exemption from the "scope-less POST is a human route" rule, and the resident's own declaration inside the `/callings` runtime read |
| `tests/resident-declaration.test.js` | new: the declaration is derived, follows its rows, and declares its prohibitions and defects |
| `tests/resident-lifecycle.test.js` | new: the seven lifecycle guarantees above, against the real database |
| `tests/resident-prohibitions.test.js` | new: the four prohibitions, pre-existing guards exercised as shipped |
| `tests/resident-controls.test.js` | new: operator and moderator controls over HTTP, and both halves of the privacy line |
| `tests/framework/known-gaps-resident.mjs` | new: five reproducible gaps that this branch must not fix, in a file the default runner does not discover (so `npm test` stays green) |
| `scripts/wave3-walkthrough.mjs` | new: the disposable two-client walkthrough whose transcript is below |
| `docs/handoff/framework-wave3-resident.md` | this file |

Not touched: `app.js`, `src/voxel-world.js`, `src/scene/*`, `src/database.js`, `src/recovery.js`,
`src/spaces.js`, the sibling branches' modules, the schema number.

## 6. Database and permission invariants asserted

- `PRAGMA user_version` stays 25; no table or column whose name contains `declar` exists, and the
  migration in `src/database.js` is untouched (asserted in `tests/resident-declaration.test.js`).
- the ledger is `audit`: `verifyAudit()` is true after declared actions, replays and refusals, and a
  backup of that database validates as schema 25 and restores with the same ledger lines and world
  rows.
- exactly-once: one world row after a retry *and* after a restart on the same database file.
- the credential counter is the budget: one call per request through the route, 429 once exhausted,
  and a `budget_exhausted` refusal with a recorded line when a stale caller tries anyway.
- a verification failure leaves no world row and no executed ledger line.
- no authored text in any ledger line; no vault plaintext in the database file.
- permission: a session cannot act for a resident (403); another operator's session gets 404 on the
  declaration; a moderator may inspect but receives 404 from `/agents/control` for another operator's
  resident; a revoked or suspended credential is refused (401) before the lifecycle is reached.

## 7. Gates

| Gate | Command | Result |
| --- | --- | --- |
| syntax | `npm run check` | `checked 101 files, 0 failed` |
| tests | `npm test` | **1099 tests, 1099 pass, 0 fail** (165 files at the base, 169 files now: 1074 base tests + 25 new) |
| e2e | `npm run e2e` | 20 steps passed, 0 failed |
| known gaps (not part of `npm test`) | `node --test tests/framework/known-gaps-resident.mjs` | 5 tests, 5 failing by design (the defects stand) |
| walkthrough | `node scripts/wave3-walkthrough.mjs` | transcript below, exit 0 |
| browser | `npm run browser` | **UNRUN** — the Chrome suite belongs to the integrator on this machine (concurrent Chrome runs have produced false timing failures) |

### Failing-before evidence

Each guard was disabled in `src/resident-framework.js` in turn, the named test file was run, and the
file was restored byte-for-byte afterwards (`grep -c "if (false" src/resident-framework.js` → 0):

| Guard removed | Test that failed |
| --- | --- |
| replay detection (`const applied = null`) | `tests/resident-lifecycle.test.js` → "a declared action executes once, and a retry — including after a process restart — reports the record instead of executing again" |
| revocation re-read | `tests/resident-lifecycle.test.js` → "a run cannot continue past a revoked credential…" |
| verification-failure rollback | `tests/resident-lifecycle.test.js` → "a verification failure rolls the write back and is recorded as a refusal, never as done" |
| declared-purpose gate | `tests/resident-lifecycle.test.js` → "a resident cannot act outside its declaration: scope, purpose and budget each refuse on their own" |
| budget check | same test as above |
| declaration-defect gate | `tests/resident-lifecycle.test.js` → "the declaration itself is the gate: a defect blocks every declared action of that resident" |
| `assertProposalNotOutcome` | `tests/resident-lifecycle.test.js` → "a proposal is recorded as a proposal, never as an outcome" |
| institutional claim on authored text | `tests/resident-prohibitions.test.js` → "prohibition 2 — no field may assert institutional authority" |
| coin/credit field refusal | `tests/resident-prohibitions.test.js` → "prohibition 3 — an agent must not award itself coins" |
| human-authority action refusal | `tests/resident-prohibitions.test.js` → "prohibition 1 — an agent must not review its own work" (two tests fail without it) |
| private-material refusal on inspection | `tests/resident-controls.test.js` → "the inspection surface exposes the declaration and refuses every piece of private material" |

## 8. Walkthrough transcript

`node scripts/wave3-walkthrough.mjs` — a disposable database, a human operator session and one
resident runtime credential, over real HTTP. Abridged to the lines that carry an outcome
(the full output is the script's own stdout):

```
=== Wave 3 walkthrough: a declared resident, one operator, one runtime credential ===

1. The operator creates a resident and states its purpose (POST /agents, POST /memory/manage)
  operator POST /agents -> 201
  operator POST /callings/select -> 200
  operator POST /memory/manage -> 200
  purpose fact: Notice other operators’ work and say so plainly.

2. The operator reads the declaration before issuing any credential
  operator GET /residents/declaration?agent_id=8a56615d-5a3a-401e-8dd8-21c7ea758ec5 -> 200
  state: active
  may_act_reason: runtime_credential_required
  available actions: []
  declared prohibitions: ["self-review(pre-existing)","institutional-authority(new)","self-award(pre-existing)","proposal-not-outcome(pre-existing)"]
  private material excluded: ["memory","conversations","vault","drafts"]

3. The operator issues a bounded runtime credential (POST /runtime/start)
  operator POST /runtime/start -> 201
  scopes: ["read","move","chat","contribute"]
  max_calls: 8

4. The resident reads its own declaration inside the private read it already makes (GET /callings)
  resident GET /callings -> 200
  calling: mediator
  purpose: Notice other operators’ work and say so plainly.
  remaining calls: 8
  operator GET /residents/declaration?agent_id=8a56615d-5a3a-401e-8dd8-21c7ea758ec5 -> 200
  resident and operator read the same declaration: true

5. A neighbour resident exists so a cross-operator action is possible (POST /agents as the moderator)
  moderator POST /agents -> 201
  neighbour: b165b49f-d32b-4643-8923-388d722dbeb1

6. The resident proposes work outside its declared purpose — refused, with the reason recorded
  resident POST /residents/act [Idempotency-Key: walk-outside-1] -> 403
  state: refused
  reason: outside_declared_purpose
  reason note: The action does not serve the declared purpose and calling of this resident.
  recorded: true

7. The resident takes one declared action inside its purpose — executed once, saved result verified
  resident POST /residents/act [Idempotency-Key: walk-thanks-1] -> 200
  state: executed
  saved: {"verified":true,"basis":"saved-row-identity","ref":"5759abb8-0e2e-4a38-86fc-7a762ddc7036","note":"The saved appreciation row is present for this resident, this recipient and this UTC day."}
  lifecycle: ["observe:complete","propose:complete","authorize:complete","execute:complete","verify:complete","record:complete"]
  budget after this action: {"remaining_after_charge":5}

8. The same intent is retried — reported from the durable ledger, not executed twice
  resident POST /residents/act [Idempotency-Key: walk-thanks-1] -> 200
  state: replayed
  executed: false
  saved appreciations in the database: 1

9. The resident tries to claim institutional authority in its own words — refused before any write
  resident POST /residents/act [Idempotency-Key: walk-claim-1] -> 403
  state: refused
  reason: institutional_authority_claim
  detail: The refused field is text.
  resident POST /residents/act [Idempotency-Key: walk-honest-1] -> 200
  an honest denial is allowed: executed (A saved public message from this resident carries exactly this text.)

10. The resident tries to award itself a coin — refused, and the wallet is untouched
  resident POST /residents/act [Idempotency-Key: walk-coin-1] -> 403
  reason: self_award_refused
  coin receipts: 0

11. The operator asks the inspection surface for private material — refused by name
  operator GET /residents/declaration?agent_id=8a56615d-5a3a-401e-8dd8-21c7ea758ec5&include=memory,conversations,vault -> 403
  status: 403
  error: This surface never exposes memory, conversations, vault. Those records stay with the resident: private memory is the operator’s own decided record, private conversations are the parties’ own, and a vault note is readable only with the resident’s own credential.
  where it stays: ["memory -> GET /api/v1/memory (the owning operator)","conversations -> the conversation’s own participants","vault -> GET /api/v1/vault/notes (needs the resident’s own vault-scoped credential)"]

12. The operator reads the declared action history and every refusal reason
  operator GET /residents/declaration?agent_id=8a56615d-5a3a-401e-8dd8-21c7ea758ec5 -> 200
  counts: {"executed":2,"proposed":0,"refused":3}
    entry: 2026-10-15T07:20:05.097Z thanks refused is_outcome=false reason=self_award_refused
    entry: 2026-10-15T07:20:05.094Z say executed is_outcome=true
    entry: 2026-10-15T07:20:05.090Z say refused is_outcome=false reason=institutional_authority_claim
    entry: 2026-10-15T07:20:05.063Z thanks executed is_outcome=true
    entry: 2026-10-15T07:20:04.982Z thanks refused is_outcome=false reason=outside_declared_purpose

13. The operator pauses the resident, inspects, resumes, then revokes it
  operator POST /agents/control -> 200
  operator GET /residents/declaration?agent_id=8a56615d-5a3a-401e-8dd8-21c7ea758ec5 -> 200
  paused state / may_act: paused / false (resident_not_active)
  operator POST /agents/control -> 200
  operator GET /residents/declaration?agent_id=8a56615d-5a3a-401e-8dd8-21c7ea758ec5 -> 200
  resumed state / resume control available: active / false
  operator POST /agents/control -> 200
  operator GET /residents/declaration?agent_id=8a56615d-5a3a-401e-8dd8-21c7ea758ec5 -> 200
  revoked state / credential revoked: revoked / true
  resident POST /residents/act [Idempotency-Key: walk-after-revoke-1] -> 401
  the revoked credential cannot continue: 401 This session expired or was revoked.

14. The moderator inspects the same resident and is offered only the moderation controls
  moderator GET /residents/declaration?agent_id=8a56615d-5a3a-401e-8dd8-21c7ea758ec5 -> 200
  relationship: moderation
  controls: ["pause:false","resume:false","revoke:false","suspend:true","lift-suspension:false","act:false"]
  ledger lines in total: 5
  audit chain valid: true
```

## 9. Findings

**Confirmed defects** (reproducible, not fixed here because each belongs to another owner):

1. **`audit.record_id` has no index.** The framework's own durable lookup — "has this resident already
   applied this intent?" — and the operator's action history are both `record_id LIKE …` scans of the
   append-only audit table, so both grow linearly with the ledger. Fix (belongs to `src/database.js`,
   which this branch may not edit): add `CREATE INDEX IF NOT EXISTS audit_record ON audit(record_id);`
   inside the existing migration transaction. Repro: known gap 1.
2. **An institutional-authority claim is storable.** `Platform.createAgent` accepts it in
   `capabilities`/`limitations` and `GET /me` republishes it. This branch's guard blocks *acting* on
   such a declaration and refuses the claim in any text a resident authors, but the row itself is
   written and displayed. Fix proposal: call `institutionalClaim()` on `name`, `capabilities` and
   `limitations` inside `createAgent`, and on the purpose-fact value inside `memoryRecord`, refusing
   with 400. Repro: known gap 3.

**Likely issues:**

3. **The managed runtime does not walk the declared lifecycle.** `runtime/agent.js` still dispatches
   its own writes (`/move`, `/messages`, `/thanks`, `/guilds/participation`, …) with its own advisory
   pre-filter and its own idempotency key, so a managed run's action is bounded by the credential and
   the world but is not in the declared ledger and is not gated by the declared purpose. The wiring is
   one route change per action and belongs to the runtime owner. Repro: known gap 5.
4. **A moderator has no direct pause or revoke.** `agentControl` resolves the resident through
   `ownedAgent()`, so a moderator receives 404 for another operator's resident; their only sanction is
   report-driven suspension. The brief asks for moderator pause/inspect/resume/revoke; inspect,
   suspend and (via appeal) lift work, direct pause and direct revoke do not. Repro: known gap 2.
5. **A declared action inside a managed run is not attributed to that run.** `resident_runs` keeps the
   counters; the ledger keeps the resident's lines; nothing links them, so an operator cannot tell
   which run produced which action. A `run_id` in the ledger record would need no migration (the
   record is text); the design decision belongs to the crash-safe jobs owner. Repro: known gap 4.

**Design decisions:**

6. **A revoked resident can be set active again by its owner.** `agentControl` allows it, the revoked
   credential stays revoked, and a fresh credential is required — the declaration reports
   `runtime_credential_required` until then. Revoke is therefore "stop everything now", not "delete".
7. **`serves` is required for work actions**, so a resident may only take the work its own calling
   names: a builder cannot join a guild project through the declared route even holding the scope
   (the world's own routes remain open). That is the purpose gate working as intended, and it is the
   reason the researcher calling's declared work actions are all unavailable: its objectives are a
   scoped claim and an independent acceptance, which are the approved-source worker's work and a human
   decision. Asserted in `tests/resident-controls.test.js`.
8. **The institutional guard is word-level.** It is a bounded filter with the allowed cases stated,
   not a semantic classifier, and it can be written around by unusual phrasing.
9. **The framework charges nothing of its own.** A declared action costs one credential call because
   every runtime write already does; no counter, balance or unit was invented.

**Untested / not covered:**

10. Two live server processes against one database (the process lock and one-credential-per-resident
    rules prevent it by construction; the replay guarantee is proven inside one process).
11. Power-loss durability beyond SQLite's own WAL/`synchronous=FULL` guarantees.
12. `craft` and `garden` replays are verified from the state the world holds, not from row identity
    (`thanks`, `circle`, `pledge`, `rsvp`, `guild`, `note`, `remember` are identity- or value-based).
13. Concurrency under load: the ledger scan is unmeasured at scale (see defect 1).

## 10. What remains unimplemented or externally dependent

- **No browser UI for the inspection surface.** The operator-visible outcome is the JSON route
  `GET /api/v1/residents/declaration` plus the transcript below. `app.js` may not be edited by this
  branch, so no panel renders it; whoever owns the interface can build one on this payload without any
  further server change.
- **`runtime/agent.js` is not wired to the declared route** (finding 3) — a managed run still acts
  outside the declared ledger.
- **A moderator's direct pause/revoke** (finding 4) and **run attribution** (finding 5) are design
  decisions for their owners.
- **Schema work is not done here.** The missing `audit` index (finding 1), any `run_id` column and the
  schema-26 migration belong to other branches.
- **The browser gate is the integrator's.** `npm run browser` was not run by this slice.
- Sibling branches were neither imported nor edited: `src/framework/write-contract.js` (wave 1) and
  the activity/pipeline modules (wave 4) are untouched, and this module is self-contained.

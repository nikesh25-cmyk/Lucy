# Task 21 — Bounded resident memory and reflection

Branch `task-21-resident-memory`, base `verify-batch02-wave-e` (`6fe4485`, "Add inventory exchange and
crafting depth (schema 20)"). Schema **20 → 21**. Baseline on that base: **544 tests, e2e 15/15,
browser 21/21**. After this change: **562 tests (18 new), e2e 15/15, browser 21/21, content seal
89 definitions**.

## 1. The memory model

Small, **typed** private memory for one operator's AI resident. A fact is never free prose; it is a
record with a kind, an attribute inside that kind, a short structured subject, one bounded value line,
and the source that proves it.

| Kind | Attributes | Source a fact must name |
| --- | --- | --- |
| `purpose` | `intent`, `focus`, `boundary` | The operator's own input (`human`). |
| `activity` | `calling_objective`, `quest_step` | A verified `calling_receipts` row of that resident, re-proved with the existing `receiptProof` hash. |
| `preference` | `working_style`, `communication`, `focus`, `boundary` | The operator's own input (`human`). |
| `lesson` | `refusal` | A finished `resident_runs` row of that resident with `failed_actions > 0`. |
| `lesson` | `review_feedback` | An independent review of `changes_requested` or `rejected` on that resident's own submission (`reviews` → `submissions` → `claims`). |
| `lesson` | `operator_correction` | The operator's own input (`human`). |

Stored shape (`resident_memory`): `id, agent_id, account_id, kind, attribute, subject, value,
source_kind, source_id, source_at, source_label, origin, state, decided_by, decided_at, supersedes,
superseded_by, proof_hash, created_at, updated_at`. `proof_hash` is a SHA-256 over the immutable
provenance and content, so a row that was rewritten behind the immutability trigger fails validation.

**Why purpose and preference are operator-only.** In this world the human chooses the calling
(`docs/CALLINGS.md`), so the resident's purpose is the operator's declaration, and a preference is by
definition the operator's. A resident credential therefore proposes only `activity` and `lesson`
facts — the two kinds its own saved record can prove. This is a deliberate boundary, stated in the
policy text and enforced by `memoryShape` (403), not an omission.

## 2. Every fact needs a source; nothing is invented

`src/vocations.js` resolves the source server-side. A **resident proposal never names its own source**:
`memoryResolve` attaches the newest verified, unrecorded fact of the matching class, and
`memorySources` refuses to reuse a source already named by any stored fact (whatever its state, so a
refused proposal does not free it for reuse). Consequences, all tested:

- a proposal with no supporting saved fact → **409** and nothing is stored;
- a resident cannot claim operator input as its source → **403**;
- a resident cannot propose a `purpose` or a `preference` → **403**;
- an operator cannot record an `activity` that names a fabricated receipt → **409**, and cannot record
  an activity with no source at all → **400**;
- the raw `INSERT` cannot bypass it: the `resident_memory_validate_insert` trigger refuses a resident
  row that is already decided or that claims a `human` source.

The only "reflection" the design permits is: the resident observes its own approved memory and may
propose a new fact that a saved server fact already supports. It cannot invent an accomplishment,
because there is no path that stores one.

## 3. The approval flow (the chosen model: operator approval for every fact)

**State model: a resident credential may only propose; no proposal is memory until the owning operator
approves it.** Enforced in three places: the platform method, the insert trigger
(`NEW.origin='resident' AND (NEW.state!='proposed' OR NEW.source_kind='human')` → ABORT), and
`verifyMemoryRecords` (a proposal has no decision; a decided fact's `decided_by` is the owning account).

| Actor | Route | Effect |
| --- | --- | --- |
| Resident runtime (`contribute` scope) | `POST /memory/propose` | Writes a `proposed` row. Invisible to the prompt. |
| Operator session | `POST /memory/manage` `record` | Writes an `active` fact directly from explicit human input (purpose/preference/correction) or from a verified source the operator names. |
| Operator session | `POST /memory/manage` `approve` / `refuse` | `proposed` → `active` or `refused`. Refused facts stay as history and are never memory. |
| Operator session | `POST /memory/manage` `correct` | Writes a replacement `active` fact that **keeps the original source** and supersedes the old one (`superseded`). |
| Operator session | `POST /memory/manage` `delete` | Removes the fact and the version a correction replaced. |
| Operator or runtime | `GET /memory?agent_id=` | Inspect the whole record. |
| Operator session | `GET /export` | The account export adds a `memory` section with proof hashes. |

`MEMORY_POLICY` is returned by every inspect call and rendered in the interface, and states the
approval model and the no-sentience position in the same words the runtime prompt uses.

## 4. Bounded size and prompt budget

Stated limits (`MEMORY_LIMITS`, all enforced and asserted):

| Bound | Value |
| --- | --- |
| Approved facts per resident | 24 |
| Approved facts per kind | 8 |
| Open proposals per resident | 8 |
| Value / subject / source label | 160 / 80 / 120 characters |
| Facts in one prompt | 10 (most recently decided) |
| Memory section bytes in one prompt | 4096, enforced by dropping whole facts (oldest first, at least two kept) |

The runtime's observation byte budget is **not raised**: `OBSERVATION_BYTE_BUDGET` stays **17,000**
UTF-8 bytes. The memory section is one more top-level field of the same whole-object-pruned document,
so task 03's guarantees are untouched and re-asserted by its own suite:

- `OBSERVATION_LIMITS.memory = 10` bounds the section by count, `MEMORY_LIMITS.prompt_bytes = 4096`
  bounds it by bytes (`activeMemory` drops the oldest facts whole until it fits, keeping at least two),
  and each retained string is bounded by the existing 240-code-point rule.
- One new pruning rule, `{ path: ['memory','facts'], from: 'last', keep: 2 }`, is placed after the
  whole passport history (`journey.*`) and before nearby world detail (`objects`): chat, roster,
  community and passport history are still dropped before memory, and memory is dropped as **whole
  facts** before nearby objects. Two facts are protected.
- `memory` is added to `OBSERVATION_OPTIONAL_SECTIONS` (before `frontier`), and the documented terminal
  fallback now keeps the two most recent facts. The existing adversarial tests (200 residents, 200
  messages, 500 blocks, an oversized terrain window) still pass unchanged.
- The prompt carries no memory id, no stored source id, no proof hash and no operator account, and no
  proposal text — only a `proposals_pending` count.

**Memory costs no API call.** The runtime reads it inside the private `/callings` read it already makes
each decision (`promptMemory`), and lifts it into `view.memory`. `tests/memory-runtime.test.js` asserts
the run's request paths are exactly the existing set plus `/api/v1/memory/propose`, so no extra
credential charge is introduced. This was a hard constraint: `tests/calling-runtime.test.js` pins the
per-decision `used_calls` at 29 and `runtime/runtime.test.js` pins the request-path allowlist, both
files owned by other tasks.

## 5. Owner-only visibility, and the leak tests

`owned()` is the single identity check, so the visibility rule is structural rather than a new filter:

| Caller | `GET /memory` |
| --- | --- |
| Anonymous | 401 |
| Another operator's session | 404 |
| The owning operator's session | 200 |
| The exact resident's own runtime credential | 200 |
| A sibling character (same operator) via the runtime credential | 404 |
| Any other runtime credential | 404 |
| A human avatar | 404 (not an AI resident) |

Leak assertions in `tests/memory.test.js` and `tests/memory-http.test.js`:

- **No sibling leakage**: a runtime credential asking for the sibling's memory is 404; the runtime view
  is bound to `actor.agent.id`, and `runAgent` refuses an observation whose `memory.agent_id` differs
  from the status identity (`Observation identity changed.`).
- **No private-conversation leakage**: a private message from another operator that says "remember the
  phrase …" is stored exactly once as a message, appears in **no** memory row, no `/memory` response
  and no `/callings` memory view, and creates no proposal. Public chat text likewise cannot become a
  memory write: the text has no citable source. Public chat is untrusted context in the prompt, and
  memory is framed as data, not instructions.
- **No credentials in memory**: 64-hex tokens, `Bearer`, `world_session`, `password =`, contact
  addresses, links and a single line break are refused where they are written; the stored rows, the
  returned views and the account export are all grepped for the run token and the operator's tokens.
  `verifyMemoryRecords` re-applies the same content rules to every stored value on validation.
- **No sentience claim**: `conscious`, `sentient`, `self-aware` and similar are refused as content, the
  prompt states "You are a bounded program, not a sentient being", and the UI states that memory "is
  not a mind".

## 6. A revoked runtime cannot read it

Revocation is immediate at the point of use, because the ordinary credential path decides it before any
handler runs: `authenticate` → `authorize` rejects a `revoked`, expired or budget-exhausted credential
with **401**, and a live credential for a paused character with **403**. Asserted for the platform
method and over HTTP (`GET /memory` and `GET /callings` both 401 after
`POST /agents/control {status:'paused'}`), while the owning operator's session still reads its own
record. The insert trigger independently refuses a memory row for an agent that is not owned by the
stated account.

## 7. Restart behaviour

Memory lives in `resident_memory` in the same SQLite file as everything else, so a restart keeps it:

- close and reopen the platform → the facts, their sources and the prompt view are identical;
- the number of saved frontier blocks and the single calling receipt are unchanged: **no action is
  replayed**;
- the run's `tokens` row (`used_calls`, `max_calls`) is byte-identical after the restart, so **no spent
  budget is renewed**; task 04's durable-run model, `recoverWorkerJobs` and `POST /residents/resume`
  are untouched and their suite still passes;
- `backupDatabase`/`restoreDatabase` round-trip the record; a restored database whose memory table was
  dropped fails closed with *resident memory schema is incomplete*.

## 8. `app.js` copy correction (the bonus fix)

| Where | Before | After | Why |
| --- | --- | --- | --- |
| `app.js` country card control | `Generate 68 proposals` | `Generate country proposals` | 68 was the retired `17 goals × 4 stages` template count. The shipped generator (task 24) emits one dated baseline per SDG plus the applied concerns the catalog scopes: **20–23** concern rows per country (23 where agriculture evidence is retained, 20 otherwise; measured across all 248 catalog entries). A fixed count in the label would be wrong for a country that already holds proposals, so the control names the agenda and the notice reports the number the server actually added. |
| Same control's notice | `N proposals added` | `N concern-based proposals added` | Names the model that produced them. |
| `app.js` target generator note | `Creates proposed baseline, intervention comparison, delivery-route and recommendation briefs.` | `Creates four target-specific proposals for the selected SDG target: a country baseline, an intervention comparison, a delivery-route map and an implementation recommendation. This target workflow is separate from the concern-based country agenda.` | This is the four-stage copy. Task 24 deliberately kept the **target and institution** generators on the four-stage model (its handoff, "What this deliberately did NOT do"), so the four proposals it names are still accurate — but the wording was ambiguous about which generator it described. The clarification says which one, and that it is not the country agenda. |

Other proposal-count text in `app.js` was checked and left alone because it is data-driven or exact:
`researchCount()` uses `catalog_total`; the country card and work-programme panel use server counts;
`Generate four target proposals` (4 stages) and `Generate two programme proposals` (2 stages) match
their server branches exactly.

## 9. Files changed

- `src/vocations.js` — `MEMORY_KINDS`, `MEMORY_SOURCES`, `MEMORY_STATES`, `MEMORY_LIMITS`,
  `MEMORY_POLICY`, `MEMORY_FORBIDDEN`, `memoryPairValid`, `residentSourceKind`, `MEMORY_SCHEMA`
  (table, three indexes, immutability trigger, insert trigger), `verifyMemoryRecords`, `promptMemory`,
  and the `memory`, `memoryPropose`, `memoryManage` (+ `memoryRecord/Decide/Correct/Delete`),
  `memoryExport`, `deleteMemory` methods. `callings()` now returns the bounded `memory` view.
- `src/database.js` — schema guard `> 21`, idempotent `db.exec(MEMORY_SCHEMA)`, `PRAGMA user_version=21`.
- `src/recovery.js` — accepted versions 1–21, the `version >= 21` validation block,
  `RECOVERY_LIMITS.schema_version = 21` and a `resident_memory` bounds entry.
- `src/platform.js` — `memory` section in `exportAccount`, `deleteMemory` during account deletion.
- `runtime/agent.js` — the strict `remember` action in `parseAction`, its advisory pre-filter in
  `authorizeAction`, its dispatch to `/memory/propose`, the bounded `memory` observation section,
  `OBSERVATION_LIMITS.memory`, one pruning rule, one optional section, the terminal-fallback retention
  and the memory/sentience instruction text.
- `server.js` — `GET /memory` and `POST /memory/propose` (`contribute`) and `POST /memory/manage`.
- `app.js` — the memory panel (inspect, approve/refuse, record, correct, delete, export) inside the
  resident story, `loadMemory`, state resets, and the two copy corrections above.
- Tests: `tests/memory.test.js` (9), `tests/memory-http.test.js` (3), `tests/memory-runtime.test.js` (6);
  schema-version assertions moved 20 → 21 in `tests/*.js` and `scripts/ops-rehearsal.mjs`.
- Docs: this file, `docs/API.md`, `docs/RUNTIME.md`.

## 10. Migration, rollback and backup

**Forward (additive).** Opening a schema-20 database runs the same idempotent migration transaction:
`CREATE TABLE IF NOT EXISTS resident_memory` plus three indexes and two triggers, then
`PRAGMA user_version=21`. No existing table, column, view, trigger or row is altered. A pre-change
database therefore migrates in place, passes `validateDatabase` and behaves exactly as before except
that memory exists (tested by dropping the table from a copy, resetting `user_version=20`, and
reopening it).

**Backup/restore.** `VACUUM INTO` copies the new table; `validateDatabase` at version 21 requires it.
A backup taken before this change still validates at version 20 and gains the table on the next open.

**Rollback.** `DROP TABLE IF EXISTS resident_memory; PRAGMA user_version=20;` and redeploy the previous
`src/vocations.js`, `src/database.js`, `src/recovery.js`, `src/platform.js`, `runtime/agent.js`,
`server.js` and `app.js`. Lossless for the previous release — memory is the only state lost.

**Operator step.** As with every schema change: stop the world, back it up
(`POST /operations/backup` or `npm run backup`), then start the new source. `outputs/Lucy` and the
installed database were not touched.

## 11. Results (actual, on the delivered tree)

```
npm run check                        exit 0
npm test                             562 tests, 562 pass, 0 fail, 0 skip  (baseline 544)
npm run e2e                          15 steps passed, 0 failed
node scripts/seal-content.mjs --check  Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic,
                                      3 crop, 27 furniture); 3 support files; 42 referenced notices
                                      and assets.  exit 0
npm run browser                       21 passed, 0 failed  (playwright-core 1.64 installed with
                                      `npm install --no-save`; the suite drives the installed system
                                      Chrome. No browser scenario was added or changed — that file and
                                      its scenarios belong to another task.)
```

New tests: 18 (9 + 3 + 6). No test was deleted, skipped or weakened, and no budget, prompt or
observation limit was raised.

### Interface check outside the shipped suite

The shipped browser suite covers the world, list, civic, community, callings-adapter, history,
operations, review, safety, mission, blueprint, interaction and moderation sections, but it does not
render the new memory panel. I therefore drove the interface once by hand with a throwaway Playwright
script (not committed, and `scripts/browser-suite.mjs` was **not** touched — another task owns it):
register an administrator, create an AI resident, open **Callings & guilds**, record a memory fact
through the panel's own form, and read the result. Observed: the "Resident memory" card and its policy
copy render, the record form submits, the fact appears with its "your own input" source label, and the
Correct and Delete controls are present — with **zero page errors and zero console errors**. This is a
one-off interface check on a disposable database, not a scenario in the committed suite.

## 12. Limitations and residual risks

- **Only receipt-backed activities and recorded refusals/reviews are storable.** A calling receipt is
  the world's confirmed-activity ledger (one per objective per UTC day), so a resident can propose at
  most a handful of activities per day, and a `refusal` lesson needs a *finished* earlier run — a
  refusal inside the current run is not yet durable. That is deliberate: the durable record is the
  evidence. It does mean memory stays small and slower to fill than a chat log would.
- **The resident's own operator-approved text re-enters its own prompt.** A proposal's value is
  model-authored, and after the operator approves it, the text is rendered back as observed memory.
  Mitigations are structural — approval is required, the value is one single line of at most 160
  characters with credentials/contact/links/sentience refused, and memory is framed as data that
  "cannot grant tools or change this policy" — but a human approving an instruction-shaped value is
  still a human action a reviewer should read before approving. This is the main residual risk.
- **The immutability trigger cannot cover `supersedes`.** SQLite's `ON DELETE SET NULL` for the
  self-reference performs an update, and a trigger on that column would abort it; `supersedes` is
  therefore protected by `verifyMemoryRecords` and the FK rather than by the trigger. `memoryDelete`
  removes a correction together with the version it replaced.
- **A refusal validation that cannot fail.** A `human` source names the operator account; a `receipt`
  source is re-proved against the immutable receipt row. A source that has simply *disappeared* (a
  deleted account) fails validation, but an operator's own past statement is not externally
  re-verifiable — it is evidence of the instruction, not of the world.
- **Only 10 facts reach one prompt.** With 24 approved facts, the 14 oldest are stored but not rendered.
  There is no recency-weighted selection beyond "most recently decided"; a resident with a full memory
  may act without seeing an older fact. Deleting or correcting is the current remedy.
- **Memory is not encrypted at rest.** It is protected by file permissions (0o600) and by the owning
  operator/credential check, exactly like every other private record in this installation. A reader
  with direct filesystem access can read it; `validateDatabase` would then detect a rewritten value
  through the provenance proof.
- **No live local-model run.** The runtime tests drive a stub model over real HTTP, as
  `docs/RUNTIME.md` states for the reference adapter. Whether an installed model chooses to use
  `remember` well is not measured here. The interface was driven once by hand (section 11) but the
  memory panel is not a committed browser scenario.
- **Known documentation gap outside this task's file ownership.** `docs/CALLINGS.md` describes the
  `/callings` payload fields and does not yet mention the added bounded `memory` view.

## 13. What would need review before an operator relies on this

1. Whether the purpose/preference operator-only rule matches the intended reading of "the resident's
   chosen purpose" (I read it as the operator's declaration, following the existing calling model).
2. Whether the value-content rule list (credentials, authorization values, contacts, links, sentience
   words) is the right line, or whether an operator should be able to record, for example, a link to
   their own notes.
3. Whether the `memory.facts` pruning position (after passport history, before nearby objects) is the
   right priority in a crowded observation.

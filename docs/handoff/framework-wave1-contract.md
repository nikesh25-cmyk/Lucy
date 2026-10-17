# Framework Wave 1 — the write path, declared and proved

Branch `framework-wave1-contract`, base commit `27c0d72` (feat: seed circles, gatherings and a guild
project through the living residents), tip `74dbc65` (five commits: the contract, its tests, the two
fixes, the known-gap repros, and one correction to the contract's own evidence). Database schema **25 — unchanged**; no new
dependency; `package.json` and `package-lock.json` untouched; nothing pushed, merged, tagged or
deployed. Only `src/platform.js` and `server.js` were open for edits, and `server.js` was not touched
at all.

This wave makes the write path explicit. `src/framework/write-contract.js` states, as data, what every
write route at `27c0d72` requires and promises; four test files enforce it against a real server over
real HTTP; two contained fixes ship; and seven defects this wave must not fix are reproducible with one
command each in a file the runner never discovers.

## The contract, in numbers

| Quantity | Value |
| --- | --- |
| Declared write routes | **101** — the 90 `writes` routes, the 7 dynamic agent actions, the 3 `specialWrite` routes and `DELETE /me` |
| Operator-only (a runtime credential is refused even holding every scope) | **51** |
| Reachable with a runtime credential | **48** (every route with a scope, except the operator-only home settings route) |
| Scope against a runtime credential | `contribute` 28 · `move` 8 · `build` 7 · `chat` 3 · `vault` 2 · `read` 1 · `null` (operator only) 52, of which the 2 public authentication writes |
| Marked idempotency-keyed | **10** — exactly the routes `server.js:742` wires to the key mechanism |
| Expected to write an attribution record | **82** |
| Verified to write none | **15** |
| **Not guaranteed (verified neither way this wave)** | **4** |
| A 2xx may answer without a new write | 6 |
| A read-scoped credential can write | **1** — `POST /agents/:id/heartbeat` |

Every field is data. Where the honest answer could not be established the field is `null` rather than a
guess, and the four `audit: null` routes are named below.

## Files changed

| File | Why |
| --- | --- |
| `src/framework/write-contract.js` (new, 255 lines) | The declared policy: one frozen entry per write route, plus `policyFor`, `policiesForPath` and the `auditedRoutes`/`operatorOnlyRoutes`/`keyedRoutes`/`readScopeWriteRoutes` readers. Dependency-free. |
| `src/drafts.js` | The fix: `draftSave` answers `saved:true`/`saved:false`, and `archiveDraft(claimId, archived)` becomes the single writer of `claim_drafts.archived`. |
| `src/platform.js` (2 lines) | The two archival call sites (`submit`, `review` with `changes_requested`) now go through `archiveDraft` instead of raw SQL. Nothing else in the file moved. |
| `tests/framework/writes-harness.js` (new) | One real server per test over a disposable temp database, the `tests/helpers.js` pattern, with a credential per runtime scope set. |
| `tests/framework/writes-table.js` (new) | How each route is exercised and what its successful answer must leave in storage, plus the 17 routes with a stated reason they cannot be driven hermetically. |
| `tests/framework/probe.mjs` (new) | The evidence generator: drives every exercise and prints status, audit entries and whether the durable effect check passed. Not discovered by the runner. |
| `tests/framework/generate-contract.mjs` (new) | Regenerates the contract module from `server.js` at the base commit plus the probe's audit evidence, so the derivation is repeatable. |
| `tests/framework-write-contract.test.js` (new) | Three tests: anonymous refusal for every declared route, the read-scope rule, and the operator-only surfaces. |
| `tests/framework-write-effects.test.js` (new) | Two tests: 84 writes persisted, attributed and replayed once; and contract coverage that fails if a route loses its exercise or its reason. |
| `tests/framework-write-static.test.js` (new) | Three tests: reachability of every `gets`/`writes`/`publicRoute` literal, `publicRoute ⊆ gets`, contract-versus-router agreement, and the schema-version drift guard. |
| `tests/framework-fixes.test.js` (new) | Three tests: the honest save, the single-owner archive flag with all five callers, and the keyed-mechanism witness. |
| `tests/framework/known-gaps.mjs` (new) | Seven reproducible defects with their invariant, observed behaviour and patch proposal. Not discovered by the runner. |

## What was extended, precisely

- **Contract module** — `WRITE_ROUTES` (101 frozen entries), `CONTRACT_BASE_COMMIT = '27c0d72'`,
  `SCOPES`, `POLICY_FIELDS`, `policyFor(route, method)`, `policiesForPath(path, method)`,
  `declaredRoutes()`, `operatorOnlyRoutes()`, `keyedRoutes()`, `auditedRoutes()`,
  `unauditedRoutes()`, `unknownAuditRoutes()`, `readScopeWriteRoutes()`.
- **`src/drafts.js`** — `archiveDraft(claimId, archived = true)` added to `draftMethods`; `draftArchive`,
  `draftResume`, `draftSave` (result only) changed. `src/platform.js` line 547 and line 567 now call it.
- **`server.js` was read, never edited.** Its `writes` map, dynamic regex and scope map, `specialWrite`,
  `publicRoute`, the runtime-versus-operator refusal at line 541 and the keyed list at line 742 are the
  source the tests parse and compare against the contract.

## Database and permission invariants asserted

- **Schema drift**: a fresh database reports the same schema number that `src/database.js` sets, that
  `src/recovery.js` declares current, that its `accepted_schema_versions` ends at, and that
  `scripts/ops-rehearsal.mjs` and `tests/recovery.test.js` assume — 25 today, and the guard fails the
  moment any of those five statements of the number disagree.
- **Persistence before answer**: 84 exercised writes each answer 2xx and the answered effect is then
  read back from the same database by a per-route assertion (the position, the world, the posture, the
  stored row, the archive flag, the ledger of each module).
- **Attribution**: a route the contract marks `audit: true` gains at least one `audit` row, every new
  row names the acting account (the operator account, including when a runtime credential acted), and a
  route marked `audit: false` gains none.
- **Idempotency**: for each of the 10 keyed routes, a second submission with the same `Idempotency-Key`
  leaves every table's row count unchanged — no second claim, submission, offer, listing, enrolment,
  interaction or ledger entry — and adds no further attribution record.
- **Permission**: every declared write refuses an anonymous caller (401/403); a read-only credential is
  refused by every route that needs a write scope; a credential holding all six scopes is refused by all
  51 operator-only writes and by the operator-only reads `/workers`, `/me`, `/export`, `/operations`,
  `/safety` and `/drafts`.
- **Draft archival**: `claim_drafts.archived` is written in exactly one place in the tree
  (`src/drafts.js`), and all five callers still behave as before — submission archives, a
  `changes_requested` review restores, the operator archives and restores, resumption archives the old
  claim, and a missing draft is reported instead of written.

## The two fixes, with failing-before evidence

**A draft save now says whether it wrote.** Before: `draftSave` answered
`{claim_id, revision, updated_at}` for both a save that wrote and a save whose content already matched
storage, so no client could tell them apart. After: `saved: true` with the new revision, or
`saved: false` with the revision already stored, and the effect check reads that revision back.

```
$ git stash push -- src/drafts.js src/platform.js && node --test tests/framework-fixes.test.js
✖ a draft save says whether it wrote, and never reports a save it did not make
  AssertionError: a save that wrote must say so
✖ only one module writes the draft archive flag, and every caller still archives and restores
  AssertionError: these modules write the draft archive flag directly: src/platform.js
$ git stash pop && node --test tests/framework-fixes.test.js
✔ a draft save says whether it wrote, and never reports a save it did not make
✔ only one module writes the draft archive flag, and every caller still archives and restores
✔ the keyed-submission mechanism applies to every route the contract marks as keyed
```

**`heartbeat` was left as it is, deliberately.** The reconnaissance suspected a read-scope write
escalation at `server.js:483` (`heartbeat: 'read'` while `heartbeat` is a POST). It is real — a
read-only credential moves `agents.last_seen` (`src/spaces.js:634`) — but three independent sources say
read-scoped presence is *intended*: `docs/API.md:91` documents the route's scope as `read`,
`tests/spaces-http.test.js:74` asserts a read-only credential heartbeats with 200, and the resident
client heartbeats every 20 s as a read action (`app.js:2657`). Changing the mapping would break a
shipped test and a documented contract, so the wave does not: the contract declares `scope: 'read'` with
`read_scope_write: true`, the test asserts the documented behaviour instead of softening it, and the
invariant it violates is reproduced by
`node tests/framework/known-gaps.mjs read-scope-write` with the exact two-line patch.

## Interactive change and the walkthrough

There is **no interface change** in this wave: `app.js` is on the do-not-edit list and the added
`saved` field is additive (the workspace ignores unknown fields and keeps using `revision`). The
closest thing to an interactive change is the write contract itself, so the walkthrough is the one a
human and an AI resident already perform together, unchanged by this wave:

1. **Human** opens the workspace, signs in, opens a claim and types into the evidence form; the
   autosave posts `POST /api/v1/drafts`. **AI** watches the response: the first keystroke-batch answers
   `saved: true` and a higher `revision`, a repeat of the same content answers `saved: false` with the
   revision already stored. Both are visible in the response body; before this wave they were identical.
2. **AI** resident walks in the game, so its client posts `/move` and its presence heartbeat every 20 s.
   **Human** reloads the world: the resident is on the tile the server stored and reads as `connected`.
   The heartbeat is a read-scope write and this wave leaves it that way, so a read-only credential can
   still do it — deliberately, and now declared.
3. **Both** watch the two-client presence view (two browser tabs, one account): the same tile and the
   same presence appear in both, because the answer follows the committed `agents` row in both cases.

Nothing above is newly interactive; the browser suite covers all three paths
(`signed-in-game-play`, `shared-presence-two-clients`, `drafts`-related workspace scenarios).

## Findings

**Confirmed defects (fixed here, each with a test that failed first)**
1. A draft save reported the same success whether or not it wrote. Fixed in `src/drafts.js`; asserted by
   `tests/framework-fixes.test.js`.
2. `claim_drafts.archived` had three writers in two modules (`src/drafts.js`, `src/platform.js:547` and
   `:567`). Fixed: one writer.

**Confirmed defects, delivered as repros (must not be fixed in this wave)**
3. Movement is unattributed: `POST /move`, `/climb` and the dynamic climb/travel write the position with
   zero attribution rows (`src/spaces.js`, forbidden file).
   `node tests/framework/known-gaps.mjs movement-attribution`
4. Private messages and journal entries are unattributed (`src/platform.js:393` for messages — a file
   this wave may edit, but outside its fix list).
   `node tests/framework/known-gaps.mjs message-journal-attribution`
5. Eight create routes write a second record when the same `Idempotency-Key` is submitted twice:
   `/reports`, `/missions`, `/tasks`, `/circles`, `/guilds/projects`, `/journey/journal`,
   `/memory/manage`, `/adoptions`. Each needs a key column, so the fix is a schema change in
   `src/database.js`. `node tests/framework/known-gaps.mjs unkeyed-duplicates`
6. The audit table is not append-only: an `UPDATE` of a chain row succeeds and only `verifyAudit()`
   notices (`src/database.js:42`, forbidden file).
   `node tests/framework/known-gaps.mjs audit-not-append-only`
7. The coin eligibility predicate is written twice (`src/coins.js:21` trigger and `:45` reader) and the
   reader checks three conditions the trigger does not: only the latest submission version, only the
   latest review, and no quarantined later version.
   `node tests/framework/known-gaps.mjs coin-eligibility-duplicated`

**Likely issues**
8. Session issuance is unattributed: `POST /auth/login` writes a token and no attribution record
   (`platform.js` is editable, but this is outside the wave's fix list and changes one behaviour).
   `node tests/framework/known-gaps.mjs session-issuance-attribution`
9. `/residents/run`, `/residents/resume` and `/research/run` are refused with 409 unless a local model
   is configured, so the write path of the resident worker is exercised by nothing in this wave.
10. The keyed mechanism protects 10 of 101 write routes; the other 91 rest on their own domain rules
    (a same-day `thanks`, an already-withdrawn source, a live grant) rather than on a key.

**Design decisions (recorded, not changed)**
11. Read-scoped presence (`POST /agents/:id/heartbeat`) is documented, tested and left alone — see
    above. `read_scope_write: true` carries it in the data.
12. Six writes may answer 2xx without a new row, by design: `/drafts` (unchanged content),
    `/residents/cancel` and `/research/cancel` (nothing running), `/frontier/expand` (the neighbouring
    area is already open), `/frontier/grant/revoke` (already revoked) and `/quests/complete` (a
    deliberate 400-with-an-audit refusal). Each is declared `may_skip_write: true` and its answer is
    asserted to agree with storage rather than to write.
13. `POST /auth/register` and `POST /auth/login` are declared `public: true`: they are reachable with no
    credential by design and are therefore excluded from the anonymous-refusal test rather than
    pretended to be authenticated writes.

**Untested (reported, not hidden)**
14. 17 write routes could not be driven hermetically and carry a stated reason in
    `BLOCKED_EXERCISES`: `/auth/register`, `/auth/login`, `/operations/backup`, `/residents/run`,
    `/residents/resume`, `/research/run`, `/research/generate`, `/research/activate`, `/memory/propose`,
    `/guilds/verify`, `/restoration/join`, `/restoration/leave`, `/restoration/contribute`,
    `/restoration/place`, `/evidence/capture`, `/quests/complete`, `/callings/select`.
15. Four routes are `audit: null` — not verified either way: `/guilds/verify`, `/restoration/place`,
    `/evidence/capture` and `/research/generate`. Each is reachable only through the untested paths
    above, so the wave records the field as unknown instead of asserting it either way.
16. The wallet and abuse path was not re-derived: the contract asserts that `/reviews` writes an
    attribution record and that a replayed review key writes nothing, but not the coin-side
    consequences.

## Verification (actual output)

Node v24.15.0 (`export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"`), all from the branch tip.

| Gate | Result | Wall time | Exit |
| --- | --- | --- | --- |
| `npm run check` | 100 files checked, 0 failed | 13.0 s | 0 |
| `npm test` | 165 test files, **1085 tests, 1085 pass, 0 fail** (the base is 1074; this wave adds 11) | 3 m 17.8 s | 0 |
| `npm run e2e` | 20 steps passed, 0 failed | 30.4 s | 0 |
| `npm run browser` | 45 Chrome scenarios: **44 passed, 1 failed** (10 m 8 s, exit 1) | 608 s | 1 |
| `node tests/framework/probe.mjs` | 84 exercised, 84 ok; 17 blocked with a reason | 2.5 s | 0 |
| `node tests/framework/known-gaps.mjs` | 7 repros recorded, 0 no longer reproduce | 4.5 s | 0 |

**`npm run browser` failed one scenario, and it is not this wave's code.** `plot-and-blueprints`
timed out after 25 s waiting for the server to save the clicked stewardship; its own recorded evidence
is `page [admin] response 429 POST /api/v1/move` — the platform's 120 ms movement throttle, hit while
the browser walked the steward into the frontier in a 43 s run. Movement is in `src/spaces.js`, which
this wave read and did not edit, and the scenario passes on an isolated re-run:

```
$ LUCY_BROWSER_ONLY=plot-and-blueprints npm run browser
SUMMARY  1 passed, 0 failed
  PASS  plot-and-blueprints (16811 ms)      # 43 387 ms and a 429 in the full run
  result  PASS — the interface was driven in a real browser and the database agreed
```

The four new test files alone:

```
$ node --test tests/framework-write-contract.test.js tests/framework-write-effects.test.js \
               tests/framework-write-static.test.js tests/framework-fixes.test.js
✔ every declared write refuses an unauthenticated caller with 401 or 403
✔ a read-scoped runtime credential cannot perform any write that needs a write scope
✔ no runtime credential reaches the operator-only surfaces, even holding every scope
✔ every exercised write persists its answered effect, its attribution record and replays once
✔ the contract covers every declared write route, exercised or explicitly blocked
✔ every literal in the gets, writes and publicRoute declarations is reachable by the handler
✔ publicRoute is a subset of the declared GET routes, and the contract matches the router
✔ a fresh database reports the schema version the rehearsal and recovery tests assume
✔ a draft save says whether it wrote, and never reports a save it did not make
✔ only one module writes the draft archive flag, and every caller still archives and restores
✔ the keyed-submission mechanism applies to every route the contract marks as keyed
ℹ tests 11  ℹ pass 11  ℹ fail 0
```

## What remains unimplemented or unverified

- The eight unkeyed create routes are **not** keyed; the patch proposal (schema bump + key column +
  method parameter + the list at `server.js:742`) is in the repro's `proposed patch` output.
- The 17 blocked routes are exercised by nothing here; their reasons are in
  `tests/framework/write-effects.test.js`, which fails if a route loses its reason or its exercise.
- `heartbeat` still requires only the read scope. The contract records the escalation; the decision is
  the owner's.
- Movement, message and journal attribution, the coin predicate duplication and the missing
  append-only audit trigger are repros, not fixes: four of them live in files this wave must not edit.
- The contract is derived from `27c0d72`. A later change to `server.js` fails
  `tests/framework-write-static.test.js` rather than silently outdating the data, but the module must be
  regenerated deliberately (`tests/framework/generate-contract.mjs`, then review the diff).

## Reproducing

```
cd /Users/nikesh/Documents/Codex/2026-10-15/nemoworld-framework/work/wave1
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
npm run check && npm test && npm run e2e
node tests/framework/probe.mjs                 # the evidence behind the contract
node tests/framework/probe.mjs /trade          # one route family
node tests/framework/known-gaps.mjs            # every repro
node tests/framework/known-gaps.mjs heartbeat  # one repro by id
```

# Wave 7 handoff — reliability and public-pilot readiness

This slice closed four confirmed gaps in crash recovery, migration rehearsal, error reporting and
diagnostics redaction; measured long-running memory, reconnect storms, the event channel's ceiling and
storage exhaustion on disposable data; kept the four arms of the operational limits report separate;
and produced a release-candidate checklist with an executed rollback drill. Nothing here is a launch
claim, a capacity claim or an MMO-scale statement, and nothing was deployed.

## 1. Base and tip

| | |
| --- | --- |
| Base commit | `27c0d72` — `feat: seed circles, gatherings and a guild project through the living residents` (schema 25) |
| Branch | `framework-wave7-reliability` |
| Worktree | `/Users/nikesh/Documents/Codex/2026-10-15/nemoworld-framework/work/wave7` |
| Tip | the commits below on that base |
| Schema | **unchanged at 25.** No migration, no new schema version, no table or column added. |
| Runtime | Node v24.15.0 for every gate and every measurement |

## 2. Changed files

| File | Change | Why |
| --- | --- | --- |
| `src/incidents.js` | **new**, 72 lines | One structured, counted, redacted record for a request that failed unexpectedly. Before this, the only trace of an unhandled server error was one unstructured stderr sentence carrying `error.code`/`error.name`. |
| `server.js` | +13 / −1 | Creates the incident log, records one incident per unexpected failure under the *normalised* route, publishes the summary in the live diagnostics, and replaces the bare `console.error` line with the structured record. |
| `src/platform.js` | +17 / −1 | Publishes `incidents` and `events` in the diagnostics payload, and passes the operations payload's **caller-supplied** rows through the redaction value scrub. Closes a live leak. |
| `scripts/reliability-drills.mjs` | **new**, 426 lines | Three drills the Task 27 rehearsal does not perform: a SIGKILL inside a multi-row transaction while a worker job runs; an unexpected error with a seeded message; the release-candidate rollback. |
| `tests/reliability-drills.test.js` | **new**, 121 lines, 4 tests | Runs the drills once and then re-reads the databases, diagnostics, log and backups directly, so the drill does not grade itself. |
| `scripts/soak-experiment.mjs` | **new**, 575 lines | The bounded soak (memory, latency, storage growth), the reconnect storm and the event channel's ceiling, and a real write-exhaustion probe over HTTP. |
| `tests/framework/known-gaps-reliability.mjs` | **new**, 194 lines, 2 deliberately failing repros | A file bare `node --test` does not collect, so `npm test` stays green while both defects stay reproducible. |
| `docs/RELIABILITY.md` | **new** | The operational limits report: four arms kept separate, with the ceilings each was measured under. |
| `docs/RELEASE_CANDIDATE_CHECKLIST.md` | **new** | The release-candidate gates, the fresh-public-world sequence, and the safe rollback path with an executed transcript. |
| `docs/handoff/framework-wave7-reliability.md` | **new** | This file. |

**Files this slice did not touch and must not:** `app.js`, `src/voxel-world.js`, `src/scene/*`,
`src/database.js`, `src/recovery.js`, `src/spaces.js`, `.github/workflows/ci.yml`, `docs/OPERATIONS.md`,
`docs/PERFORMANCE.md`, `docs/FRESH_INSTALL_REHEARSAL_REPORT.md`, `docs/CI_GATE_REPRODUCTION.md`,
`scripts/ops-rehearsal.mjs`, `scripts/load-harness.mjs`, `scripts/capacity-experiment.mjs`,
`scripts/perf-profile.mjs`, `package.json` and the lockfile. No CI job was added, no test removed or
weakened, no limit relaxed.

## 3. The four gaps, each with failing-before evidence

### 3.1 Crash recovery — a process killed *inside* a transaction, not merely mid-job

**What already existed.** The Task 27 `interrupted-worker` drill SIGKILLs a resident run and proves the
job is classified from its last durable write, the orphaned credential is revoked and no action is
replayed. It never kills a process *inside a transaction*, so SQLite's atomicity under a process death
was assumed rather than measured.

**The new drill.** `crash-during-write` starts a real worker job (a `resident_runs` row with its
credential hash plus the `jobs` row), then writes 4,000-row transactions in a loop, announcing the
start and the commit of each. The parent SIGKILLs the child the moment a batch begins, at three
jitters. Afterwards it reopens the world and asserts, from the rows themselves:

- no batch is partially present — the row count per batch is 0 or exactly 4,000, never in between;
- every batch announced as committed survived;
- the database reopens sound: schema 25, full `validateDatabase`, `PRAGMA integrity_check = ok`, audit
  chain valid;
- the interrupted job is an explicit record (`jobs.status = interrupted`, `resident_runs.status =
  interrupted`, `stop_reason = process_restart`, an actionable detail, exactly one audit event);
- the orphaned runtime credential is revoked;
- re-issuing the interrupted write cannot double-apply it;
- every world, land, coin, quest and guild record survived.

**Evidence.** `PASS crash-during-write (31 checks)`. In all three trials the transaction in flight was
rolled back entirely — the kill genuinely landed inside the transaction body, which the drill asserts
rather than assumes (`at least one trial killed a real transaction in flight`).

### 3.2 Migration rehearsal — a fresh and an existing database at the same `user_version`

**The Wave 6 finding, verified on this base and refined.** Wave 6 reported that adding a seventh crop
forks `journey_crops`'s derived `CHECK` clause while `PRAGMA user_version` stays 25. That is **true**
here, and this slice adds the part Wave 6's repro could not show because it never went through the
shipped open path.

- `src/journey.js:106` derives the clause from the sealed crop list at load time, and the table is
  `CREATE TABLE IF NOT EXISTS`. So the schema a *fresh* database is built with moves the instant a crop
  is authored, while the version does not.
- Two databases both reporting `PRAGMA user_version = 25` therefore carry different `journey_crops`
  definitions, and `RECOVERY_LIMITS.accepted_schema_versions` accepts both.
- **New evidence:** `openDatabase()` does *not* accept the pre-change world. Because `sourceVersion < 24`
  is false for a 25 database, `widenWorldContentChecks()` is skipped and `worldContentChecksCurrent()`
  then compares the stored clause against the new list and fails, so the open throws
  `Stored world content constraints are incomplete.` The fork is real but **fail-closed**: an existing
  public world cannot be upgraded to a release that adds a crop kind at all, and the operator is handed
  one generic sentence and no migration.

**Repro (failing, deliberately).** `node --test tests/framework/known-gaps-reliability.mjs`. The
assertion is that one schema version means one persisted schema. It does not, and the failure message
carries both clauses, the live sealed crop list and the observed refusal.

**Owner:** persistence / schema. The fix is a migration that widens the stored clause from the sealed
list on open for `sourceVersion === 25`, exactly as `widenWorldContentChecks()` already does for
`sourceVersion < 24`. This slice may not write it. The existing `migration-rehearsal` drill (schema 17
→ 25) still passes and is unchanged; it rehearses the *additive* migration path, which was already
covered.

### 3.3 Error reporting — an unexpected server error produced nothing an operator could see

**The gap.** An unhandled request error produced exactly one unstructured stderr sentence
(`HTTP request failed: <code>`) and nothing else. It was not counted, not timestamped, not attributed
to a route, and it appeared nowhere in `GET /api/v1/operations`, so a public pilot could not answer
"is this world returning 500s, and where?" from its own dashboard.

**The fix.** `src/incidents.js` plus a three-line wiring change in `server.js` and one published
section in `src/platform.js`. Each unexpected failure now produces one record — `id`, `at`, `kind`,
`method`, `route`, `status`, `error_name`, `error_code`, `note` — on the log as one JSON line and in
`diagnostics.incidents.recent`, with a running `recorded_since_start` and `last_route`. The `route` is
the normalised pattern (`/agents/:id/build`), never the raw URL, so no query value can reach a record.
A refusal the world itself produced (`error.status`) is an ordinary outcome and is **not** counted, and
the drill asserts that too.

**Failing-before evidence.** With `server.js` and `src/platform.js` reverted to the base and
`src/incidents.js` present but unused:

```
$ node scripts/reliability-drills.mjs --drill unexpected-error-record
HTTP request failed: Error
FAIL  unexpected-error-record  (1271 ms)
0/1 drills passed
```

On the same tree after the fix: `PASS unexpected-error-record (11 checks)`.

### 3.4 Diagnostics redaction — a runtime credential could print anything onto the administrator dashboard

**The gap, confirmed and reproduced.** `POST /api/v1/jobs` is the one route a **runtime** credential —
the least trusted actor, the credential an autonomous resident run uses — writes free text through
(`detail`, up to 500 characters), and `platform.operations()` returned that text, and account names,
verbatim to every administrator. The `diagnostics` sub-object was redacted; the top-level `jobs`,
`accounts` and `audit` lists were not.

Measured on the base, with a runtime credential posting its own token, a contact address and a private
marker into its run summary and an administrator reading `/operations`:

```
runtime token in /operations  : true
email in /operations          : true
private marker in /operations : true
jobs[0].detail : Run summary: token=5e23e86a…b9ea4cbf contact=wave7-secret-contact@… note=WAVE7-PRIVATE-MESSAGE-MARKER-4471
```

**The fix.** The caller-supplied rows are passed through the same `redactDiagnostics` value scrub the
diagnostics payload already used, applied **per row** (not to the array, because `redactDiagnostics`
bounds an array at 200 entries and an account listing must not silently truncate). The sealed
unit-separation policy is deliberately excluded: it is authored, not caller-supplied, and its
`token: false` is a published declaration rather than a secret.

**After the fix:** `runtime token in /operations : false`, `email in /operations : false`, and the
summary reads `token=[redacted-token-or-hash] contact=[redacted-email]`.

**Failing-before evidence.** With `src/platform.js` reverted:

```
$ node --test tests/framework/known-gaps-reliability.mjs
✖ KNOWN GAP 2 …
  AssertionError: the caller-supplied runtime token is scrubbed from the administrator payload
```

After the fix that assertion passes and the repro fails further along, on the residual below.

**What remains (known gap, owner: operations surface + one line in the redaction owner's file).** The
scrub is value-shaped, not provenance-aware: it replaces a token, a `salt:key` digest and an email
address, but an arbitrary narrative marker survives, because `redactDiagnostics` drops a field only
when its *name* names cryptographic material or its *final word* names narrative content — and this
field is called `detail`. Two repairs exist and this slice may write neither: drop the run summary from
the administrator listing (a documented payload shape change), or widen `CONTENT_FIELD` in
`src/recovery.js` to a trailing `detail|summary|summaries|receipt|receipts` — that file is explicitly
off-limits here. The precise proposed patch line is recorded in the repro.

**The redaction assertion the brief asks for.** `unexpected-error-record` seeds a session token, a
runtime token, a stored `salt:key` password digest, a contact address, a private message marker, a
private journal marker, a private artifact marker and a **vault plaintext**, injects a failure whose own
message contains all of them, and then greps **four surfaces** for every planted value, for any email
shape and for any 64-character hex value: the HTTP response, the process log, the administrator
diagnostics-and-audit response, and the database audit chain. All four are clean; `tests/reliability-drills.test.js`
re-greps the written artifacts independently. The audit chain is exempted from the *shape* assertions
only, because it legitimately carries 64-character integrity hashes of its own.

## 4. What the four arms measured, and under which ceiling

Full numbers, ceilings and caveats are in `docs/RELIABILITY.md`. The arms are kept separate there and
none is blended into a single figure:

1. **HTTP read capacity** — measured by the shipped `scripts/load-harness.mjs` through
   `scripts/capacity-experiment.mjs --skip-browser` (unmodified), on this tip.
2. **SQLite write capacity** — the same experiment's write section, driven against the shipped server
   over real HTTP, kept apart from the read percentiles.
3. **Model-worker throughput** — the bounded local model queue only. **No model was configured for any
   measurement**, so this arm is the queue's own bound with a stub inference of a stated latency, never
   a model's throughput.
4. **Browser frame rate — externally owned.** No frame-rate figure is asserted or re-measured by this
   slice. The rendering-measurements owner holds that arm; the browser rows that exist in this
   repository are suite wall-clock and in-page input→confirmation timings, never FPS.

## 5. Findings, ranked

**Confirmed defect**

1. **A content release that adds a crop kind forks the persisted schema at `user_version = 25`, and an
   existing world is then refused at open with no migration offered.** Fail-closed, so no data is at
   risk, but it makes such a release impossible to roll out to a running world. Owner: persistence /
   schema. Repro: `node --test tests/framework/known-gaps-reliability.mjs` (KNOWN GAP 1).
2. **A runtime credential's free text was published verbatim to every administrator.** The credential,
   digest and contact-address half is **closed** by this slice; the arbitrary-narrative half remains and
   needs a `src/recovery.js` rule or a payload shape change. Owner: operations surface. Repro:
   KNOWN GAP 2.
3. **Unexpected server errors were invisible to the operator dashboard.** **Closed**, with the
   failing-before transcript above.

**Likely issue**

4. **A full disk is answered with a generic `500 {"error":"Server error."}`.** The Platform produces an
   actionable message ("database or disk is full"), but the HTTP layer replaces every non-status error
   with `Server error.`, so the client learns nothing. Measured directly in the soak's exhaustion probe:
   the first refusal at the page limit was `500 {"error":"Server error."}` while `diagnostics` stayed
   healthy (`audit_valid: true`, `coin_ledger_valid: true`, `quick_check: ok`) and the refused write
   added **zero** audit entries — the transaction rolled back cleanly. The new incident record makes the
   event visible (`route: /jobs`, `error_code: ERR_SQLITE_ERROR`).

**Design decision**

5. An incident record carries **no** request or failure text. Including a redacted message was rejected:
   `docs/OPERATIONS.md` §10 already promises that no request body, header, token or message text is
   logged, and a bare-string value is only scrubbed by shape, so a narrative marker in an error message
   would have been published. The record therefore carries the safe, actionable facts and omits the
   narrative by construction — and the drill proves the omission holds even when the throwing error's
   own message contains every planted secret.
6. The event channel's own counters (`diagnostics.events`) and the incident section are now published to
   administrators. They were live process state that had no surface; `hub.counts()` existed but was
   never copied into the payload.
7. The sealed unit-separation policy is excluded from the payload scrub, on purpose (see §3.4).

**Untested / externally dependent**

8. Browser frame rate (rendering-measurements owner), real model throughput (no model configured), TLS,
   proxy, real network latency and packet loss, multiple processes or writers, and moderation/appeal/
   platform-pause as *recovery* drills.

## 6. Gate results

All with Node 24 (`export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"`), on the changed tree, on
15 October 2026. **The host was heavily loaded by concurrent sibling work for part of the session** —
this matters because several of these gates are timing-sensitive, and two of them were re-taken when the
host went quiet. Both runs are reported where that happened.

| Gate | Command | Result | Host load during the run |
| --- | --- | --- | --- |
| Syntax | `npm run check` | **PASS** — `checked 102 files, 0 failed`, exit 0 | ~2 |
| Unit + integration | `npm test` | **PASS** — `tests 1078`, `pass 1078`, `fail 0`, `cancelled 0`, `skipped 0`, `duration_ms 306183`, exit 0. Run twice, both 1078/1078 (322.2 s at load 91→75; 306.2 s at load 5.4→37.2). | 91 → 75, then 5.4 → 37.2 |
| HTTP acceptance | `npm run e2e` | **PASS** — `SUMMARY  20 steps passed, 0 failed`, exit 0 | 34 before → 15 after |
| Reliability drills | `node scripts/reliability-drills.mjs` | **PASS** — 3/3 drills, **52 of 52 checks** | ~2 |
| Capacity probe (browser arm excluded) | `node scripts/capacity-experiment.mjs --skip-browser` | **PASS on the quiet host — `no failure-budget breach up to concurrency 32`, exit 0, all four sections ok** | **3.03 before → 2.44 after** |
| The same capacity probe under contention | the same command | **RED — exit 1**: arm 1 breached its budget at c=32 (42/200 over the 5 s deadline) and arm 2 recorded 1,176 client-side socket failures at c=8 | 141 → 117 |
| Operational limits (soak) | `node scripts/soak-experiment.mjs --soak-seconds 180 …` | **PASS** — exit 0, no leaked subscription, no socket failure in the measured window, world writable again, 33.6 MiB against a 256 MiB ceiling | 2.38 → 14.54 |

The capacity probe was taken **twice** because the first run was red and the host load made the result
uninterpretable. Both runs are reported, because the difference between them is itself the finding:
**the identical command on unchanged code breached a 5-second deadline budget at concurrency 32 under a
load average above 130 and did not on a quiet host.** `docs/RELIABILITY.md` §2 and §3 carry both tables.
Neither run is quoted as the tip's capacity, and no seat count is inferred from either.

### The two gates on the base tree, for comparison

| Gate | Base `27c0d72`, pristine tree | Host load |
| --- | --- | --- |
| `npm test` | **PASS** — `tests 1074`, `pass 1074`, `fail 0`, `duration_ms 194910` | 22.96 before → 42.35 after |
| `npm run check` | **PASS** — `checked 99 files, 0 failed` | ~5 |

`1074 → 1078` is exactly this slice's four new tests, one file. Nothing was deleted, skipped or
weakened: `fail 0`, `cancelled 0`, `skipped 0` on both trees. **The count also proves the known-gaps
repro file is not collected by the runner** — if it were, the suite would report two failures.

The full suite was run twice on the changed tree: once mid-session on the working tree (1078/1078,
322.2 s, load 91 → 75) and again on the **committed tip** as the final confirmation
(`tests 1078`, `pass 1078`, `fail 0`, `duration_ms 306183`, exit 0, load 5.39 before → 37.23 after).
The two runs agree on every count.

`npm run browser` was **not** run by this slice: the integrator runs the Chrome suite serially and the
browser/frame-rate arm is owned by the rendering-measurements owner.

**The capacity probe was red once and green once, and both are reported.** On the quiet host
(`--skip-browser`) it exits **0**: `no failure-budget breach up to concurrency 32`, every arm ok. Under a
host load average of 141/117 the identical command exits **1**: arm 1 breached its failure budget at
concurrency 32 (42 of 200 requests over the 5 s deadline), and arm 2 recorded 1,176 socket-level failures
at concurrency 8. The arm-2 diagnosis is in `docs/RELIABILITY.md` §3 — the harness's write client opens
a new TCP connection per request with no keep-alive agent, which is client-side connection exhaustion,
not a server write ceiling (on the quiet host the same code recorded **0** failures at the same level).
The base tree was **not** re-run through this probe: it is a measurement rather than a gate, and the
question it answers is about this tip.

## 7. Measured numbers

Every figure, its ceiling, its arm and its caveats are in **`docs/RELIABILITY.md`**. Summary (quiet host
unless stated):

| Arm | Headline | Ceiling | Verdict |
| --- | --- | --- | --- |
| 1. HTTP read | c=1 50.66 req/s p50 9.59 / p95 62.48 ms; c=8 53.57 req/s p95 271.6 ms; c=32 52.10 req/s p95 3646.0 ms — **0 failures, 0 timeouts at every level** | 1/8/32 clients × 200 GETs, 5 s deadline | **GREEN** (quiet); **RED at c=32** under load >130 |
| 2. SQLite write | c=1 2,396.52 saves/s p95 0.5 ms; c=8 3,530.74 saves/s p95 3.8 ms — **0 failures** | 1/8 clients, 40 paced steps + 3,000 saves | **GREEN** (quiet); 1,176 client-side socket failures under load >130 |
| 3. Model worker | 9 of 12 admitted, **3 refused as saturated**, peak waiting 8/8, 19.9 inferences/s at a 50 ms stub, bound held | 12 requests, `maxWaiting` 8, 50 ms stub | **HOLDS** (no real model configured) |
| 4. Browser frame rate | — | — | **Externally owned, unmeasured** |

**Soak** — 180 s ceiling, 4 workers, 200 stored residents, load 2.38→14.54: **33,118 requests
(183.91/s), 32,689 ok, 429 paced-throttle `429`, 0 timeouts, 0 socket errors, 0 server errors**; latency
p50 17.9 ms, p95 55.6 ms, p99 134.4 ms; service `200` before and after. **Memory: a plateau with a
sawtooth between 63 MiB and 288 MiB** (min 64,544 KiB, median 249,376 KiB, max 294,592 KiB), falling to
64,544 KiB at 150 s, with the last-quarter median *below* the first-quarter median — **no monotonic
growth, no leak verdict, and no isolated cause**; the workload is allocation-heavy by construction
(~250 KB crowded-viewport document for ~44% of requests at ~184 req/s). Same soak under load 79→137:
10,586 requests at 58.64/s, p95 194.0 ms — the load sensitivity is the point. **Storage: bounded** — the
WAL reaches 4,124,152 bytes within 15 s and holds there for the remaining 165 s, total growth 2,858,488
bytes over 180 s.

**Reconnect storm** — 120 cycles at concurrency 8: **120 opened, 120 `ready` frames, 0 refusals, 0
client errors, 0 connections held afterwards** (107.82 reconnects/second). At the limit: **64 of 68
accepted**, the other 4 refused `503`; `0` held after release; `/health` and `GET /world` both `200`
afterwards.

**Storage exhaustion** — at the page limit: reads still `200`; 7 writes accepted, the 8th refused
`500 {"error":"Server error."}`; the refused write added **0 audit entries**; `quick_check ok`,
`audit_valid true`, `coin_ledger_valid true`; the incident was counted (`/jobs`,
`ERR_SQLITE_ERROR`); after space returned the write answered `201`.

**Disk consumed:** 35,257,506 bytes (33.6 MiB) for the reported 180 s run against a 256 MiB ceiling;
**all temporary data deleted**, nothing left in the repository.

## 8. The rollback drill

`node scripts/reliability-drills.mjs --drill rollback-release-candidate` (also inside `npm test`), and
the same transcript is in `docs/RELEASE_CANDIDATE_CHECKLIST.md` §5.

```
PASS  rollback-release-candidate  (1571 ms)      # 10 of 10 checks
  release point backed up      8,531,968 bytes, mode 0600   (via scripts/recovery.js backup)
  release changed the world    accounts 4→5, world_objects 1→2, audit 19→22
  rollback                     249 ms, preserved_original=true
  restored state               accounts=4 agents=1 world_objects=1 land_stewardships=1 land_events=1
                               coin_rewards=1 quest_enrollments=1 audit=19   — identical to the release point
  audit chain tip              restored to the release-point hash
  post-release work            gone (the new garden object and the new account)
  validation                   schema 25, quick_check ok, db+WAL+shm 8,601,848 bytes
  service afterwards           /health 200, accepts new writes, audit chain still valid
  second rollback              from the same artifact: safe and idempotent
```

The rollback path is the shipped `scripts/recovery.js restore`, unmodified. It validates the backup,
preserves the bytes it replaces (`preserved_original`), and replaces the world atomically while the
server is stopped. **Nothing was deployed**, and the drill ran entirely in a temporary directory that
was then removed.

## 9. What remains unimplemented, externally dependent or unverified

1. **The crop-kind migration** (§3.2 / finding 1) is not implemented and may not be: no schema change,
   no migration, no new schema version.
2. **The narrative half of the operations-payload leak** (finding 2) needs a `src/recovery.js` change or
   a payload shape change; both are out of this slice's authority.
3. **The exemption of message text from the HTTP 500 path** (finding 4) is a behaviour question, not a
   redaction one, and is not changed here.
4. **Everything the arms do not cover**: see §5 and `docs/RELIABILITY.md`.
5. **Disk consumed by this slice's experiments** was measured and the temporary data deleted; the
   figures are reported with the measurements.

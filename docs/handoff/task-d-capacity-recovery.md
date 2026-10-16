# Task D handoff — Wave D measured capacity and recovery

This is a **measurement and reporting** task: Wave D asked for the measured capacity and recovery
evidence on the current tip, with reads, writes, the model queue and event subscribers kept apart. The
capacity experiment and the operations rehearsal already existed from earlier work and were **reused**,
not rebuilt. One harness file was extended, and only because a measurement the brief names was
genuinely blocked without it: no owned harness could drive a write workload or hold an event-feed
subscriber.

## Base, files and patch

- **Base commit:** `7eb03e08d6d8a56290e2421a6a7d125ae9d410c5`, branch
  `integration/deepseek-master-2026-10-14` (schema 22). One commit was made on that branch
  (`Wave D: measure write and subscriber capacity, refresh docs to this tip`), and the patch file is
  exactly that commit; the working tree is clean.
- **Files changed (all files this task owns):**

  | file | change |
  | --- | --- |
  | `scripts/capacity-experiment.mjs` | **extended** with a fourth measurement section: movement/building writes and event-feed subscribers, driven against the shipped `server.js` over real HTTP. The read, browser and model sections are untouched except for the summary and the report object. |
  | `docs/PERFORMANCE.md` | new top section "Wave D — measured capacity and recovery on this tip"; the Task 14/28 material is relabelled as historical. |
  | `docs/OPERATIONS.md` | plaintext-backup honesty (§2), the off-install backup/restore rehearsal (§3), the dated per-drill results and the coverage gaps (§11), and a new residual risk (§12). |
  | `docs/ARCHITECTURE.md` | the measured bottleneck and the change it justifies, in "Toward 10,000 live agents". |
  | `docs/RELEASE_CHECKLIST.md` | every stale gate expectation refreshed to this tip (test count, e2e steps, browser scenarios, seal count, schema, capacity probe) and §7 rewritten with this run. |
  | `docs/handoff/task-d-capacity-recovery.md` | this file. |

- **Patch:** `git format-patch` → `../task-d-capacity-recovery.patch`.
- **Deliberately left alone:** `app.js`, `server.js`, `src/**`, `tests/**`, `scripts/browser-suite.mjs`,
  `scripts/e2e-smoke.mjs`, `scripts/load-harness.mjs`, `scripts/ops-rehearsal.mjs`, `package.json`,
  `scripts/recovery.js`, and **`outputs/Lucy`**. **`HANDOFF.md` and `docs/VERIFICATION.md` are the
  integrator's and were not touched**; nor was `docs/PRODUCTION_READINESS.md`, which still carries
  Task 28's capacity narrative and is now superseded by `docs/PERFORMANCE.md`.
- No test was deleted, skipped or weakened.

## The environment actually measured

| | |
| --- | --- |
| Machine | Apple M5 (`Mac17,3`), 10 logical CPUs, 16 GiB memory |
| OS / runtime | macOS 26.6.2 (build 25G83), Darwin 25.6.0; Node v24.19.0; `node:sqlite`, `node:http` |
| Load average at measurement | capacity run **1.78 before / 3.07 after**; browser gate **2.12 / 2.59**; e2e **2.42 / 4.78**; ops rehearsal **3.14** at the start |
| Model | **none configured** — `model_configured=false`, `model_queue=null` on both fixtures |

This suite is load-sensitive, so the load average is stated with every figure.

## What was measured, and the exact commands

```sh
export PATH="$PWD/../node-bin:$PATH"          # Node v24.19.0
npm run capacity                              # == node scripts/capacity-experiment.mjs
node scripts/capacity-experiment.mjs --json /tmp/task-d-capacity.json   # the recorded run
node scripts/ops-rehearsal.mjs --keep         # recovery and failure drills, disposable workspace
```

The capacity experiment's **read** and **browser** sections *invoke*
`scripts/load-harness.mjs` and `scripts/browser-suite.mjs` **unmodified** and read their own output, so
those figures are the shipped harness's own. The **write/subscriber** section starts the shipped
`server.js` on its own temporary database and drives it over real HTTP.

### Read capacity — 10,001 stored agents, 1/8/32 client workers, 200 GETs per level

| Concurrency | ok/attempts | timeouts | HTTP errors | Throughput | p50 | p95 | p99 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 200/200 | 0 | 0 | 50.78 req/s | 9.43 ms | 60.77 ms | 63.90 ms |
| 8 | 200/200 | 0 | 0 | 51.82 req/s | 137.53 ms | 274.93 ms | 360.39 ms |
| 32 | 200/200 | 0 | 0 | 53.02 req/s | 274.58 ms | 3583.25 ms | 3687.01 ms |

Payload median 41,446 B, largest 247,895 B (the crowded viewport the client polls every 3 s). No
failure-budget breach up to concurrency 32. **A stored-record fixture is not a concurrent-player
benchmark:** 10,001 stored agents say how a read behaves when the database is large, and do not mean
10,001 supported users.

### Movement and building writes — 1/8 client workers, 8 movers + 1 builder, 80 buildable tiles

| Clients | Movement (paced) | move p50/p95 | Building (unpaced) | build p50/p95 | Failures |
| --- | --- | --- | --- | --- | --- |
| 1 | 40 steps, 7.68 steps/s | 3.1 / 3.9 ms | 3,000 saves, 2,487.67 saves/s | 0.4 / 0.5 ms | 0 |
| 8 | 320 steps, 62.01 steps/s | 2.5 / 4.5 ms | 3,000 saves, 3,645.28 saves/s | 1.7 / 3.9 ms | 0 |

Every response was 200 (move) or 201 (build); zero HTTP errors, timeouts or socket errors. The
building row is unpaced, so it is the server's own rate, not the harness's offer.

**Measured application bound:** twelve **unpaced** steps on one resident gave **1 accepted, 11 refused
`429` in 9.2 ms** — the shipped 120 ms per-agent movement throttle. That is why movement above is paced
and why a paced step is not counted as a throttle refusal.

### Event-feed subscribers — 8 authenticated subscriptions on the Commons

8/8 opened (status 200), **680 frames** (85 each, 6.85 frames/client/s against the 20 fps bound),
delivery latency p50 0 ms, p95 1 ms, p99 1 ms, max 2 ms (timed against the frame's own server clock
`t`). An earlier run that put eight subscriptions on **one** account was refused — 4 opened, 4 got
`429` — which is the channel's 4-per-account bound working; the fixture now gives each group of four
its own account.

### Browser clients — real Chrome, bounded concurrency

1 concurrent suite (≤2 pages), 4 scenarios: **28.7 s**, all passed. 2 concurrent suites (≤4 pages),
8 scenarios: **30.7 s**, all passed. Two suites did not double the wall clock, so the browser-client
count is not readable from these rows. The full 45-scenario gate (run separately) passed **45/45 in
304 s**; its own two timing scenarios report in-page input→confirmed step **median 12.3 ms, p95
18.9 ms, n=24** and a move visible in the other browser in **492 ms** (channel frame delivery 0 ms).

### Model-queue capacity — its bound and refusals, no real model

12 simultaneous requests, maxWaiting 8, **50 ms stub inference**: 9 admitted, **3 refused as
saturated**, 0 failed, peak waiting 8/8, peak active 1, queue wait p50 202.1 ms / p95 403.3 ms,
19.8 inferences/s serialized, **bound held**. The shipped server's own `model-queue-saturation` drill
passed in 685 ms. The read and write fixtures both reported `model_configured=false`, confirming no
model work was mixed in.

### Compute credits are declarative only

`src/coins.js` freezes four units of account; only `nemocoin` is implemented (`ledger: coin_rewards`,
`balance: true`). `compute_credit` is `implemented: false` with no ledger, no balance, no transfer, no
conversion; `UNIT_SEPARATION_POLICY` states `conversion_paths: 0, cash_out: false, token: false`. No
compute credit was spent, minted or converted here, and none is counted. (Asserted by
`tests/unit-separation.test.js`.)

## Recovery evidence — the operations rehearsal, per drill

`node scripts/ops-rehearsal.mjs --keep`, load average 3.14, on a disposable workspace only:

```
PASS  recovery-point  (922 ms)
PASS  corrupt-backup  (871 ms)
PASS  migration-rehearsal  (1015 ms)
PASS  interrupted-worker  (4824 ms)
PASS  model-queue-saturation  (576 ms)
PASS  storage-limit  (657 ms)
PASS  diagnostics-redaction  (529 ms)
7/7 drills passed
```

Exit code 0, 9.5 s, **76 of 76 individual checks passed**. What each proves, and what the drills do
**not** cover (also recorded in `docs/OPERATIONS.md` §11):

- **Revocation — covered.** `interrupted-worker` revokes the orphaned runtime credential of two
  SIGKILLed runs and proves a resume mints a fresh one; `diagnostics-redaction` refuses the
  administrator surface to anonymous and non-administrator callers.
- **Platform pause — only indirectly.** No drill pauses the platform; a paused world is exercised only
  as a refusal inside the browser suite (`interaction-state-refusals`), not as a recovery drill.
- **Moderation and appeal — NOT covered.** No drill files a report, moderates a case, or decides an
  appeal. That path was **not** measured or rehearsed here.
- **Incident recovery — covered.** `recovery-point`, `corrupt-backup`, `migration-rehearsal` and
  `storage-limit` cover the recovery point, a refused restore that leaves the live world
  byte-identical, an additive schema-17 → 22 migration, and a storage failure that rolls back and stays
  writable.

## Off-install backup and restore, on a disposable database

The drills restore inside a workspace on the same host, so an **off-install** backup and restore was
rehearsed separately with `scripts/recovery.js` on a disposable database that never touched
`outputs/Lucy` or `data/`:

```sh
INSTALL=$(mktemp -d); OFFSITE=$(mktemp -d)
node scripts/recovery.js backup  "$INSTALL/world.sqlite" "$OFFSITE/backup.sqlite"
node scripts/recovery.js verify  "$OFFSITE/backup.sqlite"
# one record is written after the backup, then:
node scripts/recovery.js restore "$OFFSITE/backup.sqlite" "$INSTALL/world.sqlite"
```

Measured: the backup was written off-install at mode `0600` (8,392,704 bytes) and verified
`{"schema_version":22,"accounts":2}`; the restore returned
`{"schema_version":22,"accounts":2,"preserved_original":"…world.sqlite.before-restore-…/original.sqlite"}`;
the record written after the backup was gone (messages 2 → 1) and every pre-backup record survived.

**The shipped backup is not encrypted.** `backupDatabase` uses `VACUUM INTO`, and the copy began with
the bytes `SQLite format 3\0`; a distinctive plaintext marker planted in the database was readable
inside the copy with an ordinary `grep`. The brief's "**encrypted off-install backup**" therefore
**cannot be satisfied by the shipped tool alone today**: the shipped tool gives a consistent, verified,
off-install copy, but encryption has to be added by an operator (an encrypted volume, or encrypting the
artifact with `age`/`gpg`/an encrypted image before it leaves the host). This is stated in
`docs/OPERATIONS.md` §2 with the workaround, and repeated as a residual risk in §12.

## What was not measured, and why

- **Real model throughput and any model call.** No model is configured; the queue figures are a 50 ms
  stub. Stated plainly rather than substituted with a proxy.
- **Moderation and appeal flows, and platform pause as a recovery drill** — the drills do not cover
  them (above).
- **Soak, memory growth, disk exhaustion, WAL growth** — every run is seconds long.
- **Network reality** — loopback only: no TLS, no proxy, no real latency, no packet loss.
- **Multiple processes / multiple writers / horizontal scale** — one process, one connection.
- **The crowded-viewport read at a stored size other than 10,001 agents** — a fixed fixture is not
  evidence for a much larger one.
- **Compute-credit spend** — the concept has no store to spend; it is declarative only.
- **A frame-rate or real-device browser claim** — the browser rows are suite wall-clock and in-page
  input→confirmation timings, not FPS and not real-device latency.

## The candid capacity limit, the observed bottleneck, and the change it justifies

- **Read capacity saturates at ~51–53 requests/second and does not improve from 1 to 32 simultaneous
  clients**, while the p95 climbs to 3,583 ms. That is the signature of one synchronous read path
  serving every request, and the crowded `GET /world` (247,895 B, p50 60.19 ms at concurrency 1) is the
  dominant cost inside it.
- **The single SQLite writer is not the write constraint on this fixture:** eight clients saved garden
  objects at **3,645/s** with a 3.9 ms p95, and movement is capped by the application's own 120 ms
  per-resident throttle. So of the usual suspicion, "one process" is **confirmed** and "one writer" is
  **refuted** for this workload.
- **The next architectural change is therefore inside the process, on the read path** — bound the
  crowded-viewport read (the remaining `COUNT(*) OVER ()` window function and the N+1 `mayors()` read)
  and re-measure *against the crowded fixture*, because the earlier attempt at the window function was
  withdrawn for having been validated on a fixture too small to expose the plan. A second reader,
  second process or multi-writer database is the next step **only if a single process still saturates
  after the read path is bounded**. No distributed design is proposed, because the numbers do not yet
  require one.

## Gates on the changed tree

The only non-documentation change is `scripts/capacity-experiment.mjs`, which no test imports and which
`npm run check` parses.

| Gate | Command | Result |
| --- | --- | --- |
| Syntax | `npm run check` | **PASS** — `checked 90 files, 0 failed`, exit 0 (on the changed tree) |
| Unit/integration | `npm test` | **PASS** — `tests 902`, `pass 902`, `fail 0`, `skipped 0`, `cancelled 0` (see the note below) |
| HTTP acceptance | `npm run e2e` | **PASS** — `SUMMARY  17 steps passed, 0 failed`, exit 0 (run on the tree that already contained the script change) |
| Content seal | `node scripts/seal-content.mjs --check` | **PASS** — `Verified: 89 definitions …`, exit 0 (on the changed tree) |
| Browser | `npm run browser` | **PASS** — `SUMMARY  45 passed, 0 failed`, exit 0. Run on the tree containing the script change; this task changed no browser, UI or stylesheet source, so the gate is unaffected by the documentation work. |
| Capacity probe | `npm run capacity` | exit 0, all four sections within budget, installed world untouched |

`npm test` does not import `scripts/capacity-experiment.mjs`, so the script change cannot move it; it
was run both before and after the script change and reported **902/902** each time (83.3 s before, 82.4 s
on the changed tree — the figure quoted in `docs/RELEASE_CHECKLIST.md` §7).

## Residual risks

1. **The backup is plaintext.** Encryption is an operator step, not a shipped guarantee; until it is
   added, an off-install backup exposes every credential hash, contact address and private message it
   holds.
2. **Capacity was measured on one machine, one fixture, one workload, on an idle machine.** Load
   average is stated with every figure because the suite is load-sensitive; a busier host will measure
   worse and this document makes no service-level claim.
3. **The write and subscriber fixture is small** (80 tiles, 8 subscribers, a few hundred rows). A large
   database would slow writes through index maintenance, which this fixture does not exercise.
4. **Moderation, appeal and platform-pause recovery are unmeasured** — the drills do not reach them.
5. **`docs/PRODUCTION_READINESS.md` (Task 28) now carries superseded capacity numbers.** It is outside
   this task's file ownership and was not edited; `docs/PERFORMANCE.md` is the current record.
6. **The `capacity-experiment.mjs` extension is new code and therefore its own residual risk.** It is a
   measurement tool, deliberately not part of `npm test` (a timing measurement is evidence, not a
   stable assertion), and it is exercised only by running it.

## Why the harness was changed at all

`scripts/load-harness.mjs` is GET-only by construction ("What it does NOT measure: … writes"), and no
owned harness held an event subscriber. Two workloads the brief names — movement/building writes and
event-feed subscribers — were therefore **genuinely blocked**, not merely inconvenient. Rather than
rebuild a harness, the existing `scripts/capacity-experiment.mjs` (which already holds separate
experiments and forbids conflating them) gained a fourth section that reuses the shipped server, the
shipped routes and the shipped event channel. `scripts/load-harness.mjs` and
`scripts/ops-rehearsal.mjs` were **not modified**.

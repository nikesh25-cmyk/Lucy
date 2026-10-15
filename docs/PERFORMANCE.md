# World performance and measured capacity

## Wave D — measured capacity and recovery on this tip (14 October 2026)

Measured on **14 October 2026**, branch `integration/deepseek-master-2026-10-14`, commit
`7eb03e08d6d8`, schema **22**, with the machine quiet: **load average 1.78 before and 3.07 after** the
capacity run, 2.12 / 2.59 around the browser gate, 2.42 / 4.78 around the end-to-end gate, and 3.14 at
the start of the operations rehearsal. Every number below was produced by a command in this repository
on that tip. **This section supersedes the Task 14 and Task 28 records further down**, which describe
earlier tips and are kept as history, not as current numbers.

### The honesty contract, first

- **A stored-record fixture is not a concurrent-player benchmark.** The read harness fills a
  *temporary* database with **10,001 stored agents** (10,000 synthetic plus the fixture's own
  resident) stacked in the Commons with one home each, **2,000 stored visits** and **2,000 stored
  claims**. That is a *stored-data* fixture: it says how a read behaves when the database is large, and
  nothing about how many people or AI residents can use the world at once.
- **No production capacity is established by this document.** Where a limit was found it is reported as
  "under this hardware, this concurrency, this workload".
- **Reads, writes, the model queue and event subscribers are four separate measurements** and are never
  added together. None of them is a frame-rate, GPU, network or real-device measurement.
- **No model was configured and no model call was made.** The server's own `/health` reported
  `model_configured=false, model_queue=null` on both the read harness and the write fixture. The
  model-queue figures are the queue's own bound with a **50 ms stub inference**, never a model's
  throughput.
- **Compute credits are declarative only.** `src/coins.js` freezes four units of account; of them only
  NemoCoin is implemented (`ledger: 'coin_rewards'`, `balance: true`). `compute_credit` is
  `implemented: false` with no ledger, no balance, no transfer and no conversion, and
  `UNIT_SEPARATION_POLICY` states `conversion_paths: 0, cash_out: false, token: false`. Nothing in these
  measurements spends, mints or converts a compute credit; the concept has no store to spend, and this
  document does not count one.

### Hardware and environment

| | |
| --- | --- |
| Machine | Apple M5 (`Mac17,3`), 10 logical CPUs, 16 GiB memory |
| OS | macOS 26.6.2 (build 25G83), Darwin kernel 25.6.0, internal SSD |
| Runtime | Node v24.19.0 (`node:sqlite`, `node:http`) |
| Process model | one HTTP process, one SQLite writer in WAL mode, loopback only |
| Load average | 1.78 / 3.07 (capacity run), 2.12 / 2.59 (browser gate); this suite is load-sensitive, so the load is stated with every figure |

### Fixtures and concurrency (stated with every table)

| Measurement | Fixture | Concurrency | Offered work |
| --- | --- | --- | --- |
| HTTP reads | 10,001 stored agents stacked in the Commons, one home each, 2,000 visits, 2,000 claims | **1, 8, 32** client workers | 200 GET requests per level |
| Movement / building writes | 8 movers + 1 builder in its own garden, 80 buildable tiles, 8 subscriber accounts | **1, 8** client workers | 40 paced moves per client + 3,000 unpaced saves per level |
| Event subscribers | 8 authenticated Server-Sent Events subscriptions on the Commons (2 accounts × the 4-per-account bound) | **8 held open** | one frame per published delta |
| Browser clients | each suite its own temporary installation; 4 scenarios per suite | **1 and 2 suites** (≤2 and ≤4 pages) | 4 and 8 scenarios |
| Model queue | no real model; a 50 ms stub inference | **12 simultaneous requests**, maxWaiting 8 | 12 requests |

### Instruments and commands

| Question | Instrument | Command |
| --- | --- | --- |
| Reads at bounded concurrency | `scripts/load-harness.mjs` (invoked unmodified) | part of `npm run capacity` |
| Writes and event subscribers at bounded concurrency | `scripts/capacity-experiment.mjs` (the section added this wave) | part of `npm run capacity` |
| Browser clients at bounded concurrency | `scripts/browser-suite.mjs` (invoked unmodified) | part of `npm run capacity` |
| The bounded model queue | the shipped `boundedModel` + the shipped server drill | part of `npm run capacity` |
| Recovery and failure drills | `scripts/ops-rehearsal.mjs` | `node scripts/ops-rehearsal.mjs --keep` |

### 1. HTTP read capacity — bounded client concurrency

The read mix is the client's own repeating GET set: crowded viewport, garden directory, resident
passport, contribution history, health. Every request is a GET against the shipped `server.js` on a
temporary database; 200 attempts per level, a 5,000 ms request deadline and a **0 % failure budget**.

| Concurrency | Attempts | ok | timeouts | HTTP errors | Throughput | p50 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 200 | 200 | 0 | 0 | **50.78 req/s** | 9.43 ms | 60.19 ms | 60.77 ms | 63.90 ms | 77.18 ms |
| 8 | 200 | 200 | 0 | 0 | **51.82 req/s** | 137.53 ms | 252.38 ms | 274.93 ms | 360.39 ms | 561.44 ms |
| 32 | 200 | 200 | 0 | 0 | **53.02 req/s** | 274.58 ms | 932.33 ms | 3583.25 ms | 3687.01 ms | 3770.80 ms |

Payload: median **41,446 B** per response, largest **247,895 B** (the crowded viewport, which the client
polls every 3 seconds). Per path at concurrency 1: crowded viewport p50 60.19 ms / p95 63.90 ms
(247,895 B), garden directory p50 23.44 ms / p95 25.01 ms (9,804 B), resident passport p50 9.43 ms /
p95 10.44 ms (41,446 B), contribution history p50 3.53 ms / p95 4.01 ms (68,605 B), health p50 0.28 ms.
**No failure-budget breach occurred up to concurrency 32.**

### 2. Movement and building writes — bounded client concurrency

Two writes the resident client actually sends, against the shipped routes on a temporary database:
`POST /api/v1/move` (a confirmed step — one resident per client, paced above the server's own throttle)
and `POST /api/v1/agents/:id/build` (a saved garden object, idempotent, **unpaced** so its throughput is
what the server serves rather than what the harness offered). No reads are mixed into these rows.

| Clients | Movement (paced) | Movement p50 / p95 | Building (unpaced) | Building p50 / p95 | Failures / timeouts |
| --- | --- | --- | --- | --- | --- |
| 1 | 40 steps, **7.68 steps/s** | 3.1 ms / 3.9 ms | 3,000 saves, **2,487.67 saves/s** | 0.4 ms / 0.5 ms | 0 / 0 |
| 8 | 320 steps, **62.01 steps/s** | 2.5 ms / 4.5 ms | 3,000 saves, **3,645.28 saves/s** | 1.7 ms / 3.9 ms | 0 / 0 |

Every response was 200 (movement) or 201 (building); there were no HTTP errors, no timeouts and no
socket errors. The building rate is the single SQLite writer's own ceiling on this fixture.

**The application's own per-resident bound, measured rather than assumed:** twelve **unpaced** steps
issued back to back on one resident produced **1 accepted and 11 refused `429` in 9.2 ms** — the
server's 120 ms per-agent movement throttle. That is a deliberate application bound, not a capacity
failure, and it is why the paced movement row above is paced.

### 3. Event-feed subscribers

Eight authenticated clients held `GET /api/v1/events?world_id=commons` Server-Sent Events
subscriptions open while the writes above flowed, and each received frame was timed against the
server's own send clock (`frame.t`).

| Subscribers opened | Frames received | Frames/client | Rate | Delivery p50 / p95 / p99 / max | Frame-rate bound |
| --- | --- | --- | --- | --- | --- |
| **8 / 8** (status 200) | 680 | 85 each | 6.85 frames/client/s | 0 ms / 1 ms / 1 ms / 2 ms | 20 fps (not reached) |

The channel's per-account bound (4 subscriptions) is real: an earlier run that opened eight
subscriptions on one account was refused, four opening and four getting `429`. That run was discarded
and the fixture now gives each group of four viewers its own account.

### 4. Browser clients — real Chrome at bounded concurrency

`scripts/browser-suite.mjs` driven at at most two concurrent suites, each with its own temporary
installation and at most two browser pages. This is not a supported-user count; it is the cost of one
suite and whether two suites on one machine interfere.

| Concurrent suites | Pages bound | Scenarios | Wall clock | Result |
| --- | --- | --- | --- | --- |
| 1 | ≤ 2 | 4 | **28.7 s** | all passed |
| 2 | ≤ 4 | 8 | **30.7 s** | all passed |

Two suites did not double the wall clock (28.7 s → 30.7 s), which is why the number of browser clients
cannot be read from these rows. The full 45-scenario acceptance gate, run separately on the same tip at
load 2.12 / 2.59, passed **45 / 45 in 304 s**. Two of its scenarios report the interface's own timing:

- `movement-latency` — input → confirmed step, timed in the page: **min 5.3 ms, median 12.3 ms, p95
  18.9 ms, max 19.1 ms, n = 24**, of which input → `POST /move` answered was median 4.3 ms.
- `shared-presence-two-clients` — a move was visible in the **other** browser in 492 ms, with channel
  frame delivery 0 ms.

### 5. Model-queue capacity (its own bound and refusals)

No real model is configured, so this is the shipped queue's bound with a **50 ms stub** and the shipped
server's own drill — never model throughput.

| Attempts | Admitted | Refused as saturated | Failed | Peak waiting | Peak active | Queue-wait p50 / p95 / max | Serialized rate | Bound |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 12 | 9 | 3 | 0 | 8 of 8 | 1 | 202.1 ms / 403.3 ms / 403.3 ms | 19.8 inferences/s | held |

The shipped server's own `model-queue-saturation` drill passed in 685 ms. The read and write fixtures
both reported `model_configured=false, model_queue=null`, confirming that no model work was mixed into
those rows.

### What was not measured

- **Real model throughput.** No model is configured; no model call was made, in either the read or the
  write fixture. The queue figures are a stub's bound.
- **Soak, memory growth, disk exhaustion, WAL growth.** Every run is seconds long.
- **Network reality.** Loopback only: no TLS, no reverse proxy, no real internet latency, no packet
  loss.
- **Multiple processes, multiple writers, horizontal scale.** One process, one connection.
- **The crowded-viewport read at a stored size other than 10,001 agents.** The fixture is fixed, and a
  read that is fast on 10,001 rows is not evidence for 1,000,000.
- **Real accounts or installed data.** Every measurement uses a temporary workspace; `data/`,
  `outputs/Lucy`, backups and model weights were never opened for writing (the experiment re-checks
  this and reported the installed world untouched).

### The candid limit, and the change it justifies

**The bottleneck is the read path inside the single Node process, and the numbers confirm it rather than
assume it.** Completion throughput sat at **50.78 / 51.82 / 53.02 req/s** and did not improve from 1 to
32 simultaneous clients while latency climbed to a 3,583 ms p95 — the signature of one synchronous
SQLite read path serving every request, not of a client limit. Within the read mix the crowded
`GET /world` (247,895 B, p50 60.19 ms at concurrency 1) dominates: 40 of the 200 requests are that read,
and 40 × ~60 ms is most of the 3.9 s the level takes.

**The single SQLite *writer* is not the constraint for these writes.** Eight clients saved garden
objects at **3,645/s** with a 3.9 ms p95, and movement was bounded by the application's own 120 ms
per-resident throttle, not by the database. So the "one writer" half of the usual assumption is
**refuted** on this evidence; the "one process serving one read at a time" half is **confirmed**.

**The next architectural change this observation justifies is therefore inside the process and on the
read path, not a redistribution of it.** Bound the crowded-viewport read — the remaining
`COUNT(*) OVER ()` window function and the N+1 `mayors()` read named in the Task 14 record below — and
re-measure it against this crowded fixture (the earlier attempt at the window function was withdrawn
because it was validated on a fixture too small to expose the plan; that lesson stands). Only if a
single process still saturates after the read path is bounded does a second reader, a second process or
a multi-writer database become the justified next step. **No distributed design is proposed here,
because these numbers do not yet require one.**

### Reproduce

```sh
export PATH="../node-bin:$PATH"                       # Node v24.19.0
npm run capacity                                      # reads + writes + subscribers + browser + model queue
node scripts/capacity-experiment.mjs --json /tmp/capacity.json
node scripts/ops-rehearsal.mjs --keep                 # recovery and failure drills, disposable workspace
```

---

## Earlier records (historical — not the current numbers)

Task 14. Measured on 13 October 2026, branch `task-14-performance`, schema **18** (unchanged), base
`task-13-newcomer-journey`. Every number below was produced by a script in this repository; every
"before" number comes from an unmodified copy of the base revision on the same machine. **Kept as
history: it describes a different tip on a different day, and the Wave D section above is the current
record.**

## The honesty contract, first

- **A stored record count is not a count of supported simultaneous users.** The 10,000-record fixture
  is a *stored-data* fixture. It says how a read behaves when the database is large; it says nothing
  about how many people or AI residents can use the world at once.
- **No production capacity is established by this document.** Where the harness found a limit, it is
  reported as "under this hardware, this concurrency, this workload".
- **Nothing here is a frame-rate, GPU, browser, network or model-throughput measurement.** No browser
  was run. No model was configured or called.
- Authorization, visibility, privacy, receipts and the coin ledger were not weakened for speed. The
  changes kept below are all "same answer, fewer/cheaper queries"; the contribution-eligibility
  predicate, the visitor rule and every review check are the base revision's own text.

## Integrator correction — the viewport change was withdrawn (13 October 2026)

The viewport optimization described below was **not accepted**. On a fixture larger than the ones
used here it is a severe regression, and it was reverted before release:

- **Withdrawn:** the grouped `accepted_contributions` read for a viewport page
  (`acceptedContributionCounts` / `contributionEligibilityIn`). On the small fixtures below it looked
  like a minor win (≈0.8 ms; 0.42 → 0.16 ms with 600 historic claims). On the shipped suite's crowded
  fixture it is pathological: `tests/world-platform.test.js` went from **8.3 s to over 300 s** (whole
  file), because `GROUP BY c.agent_id` over an `IN (…200 ids…)` list of the eight-table eligibility
  predicate admits a far worse query plan than the per-avatar correlated subquery it replaced.
  Reverting `src/spaces.js` alone restored 6.6 s.
- **Also withdrawn with it:** the `COUNT(*) OVER ()` → separate bounded `COUNT(*)` replacement in
  `src/spaces.js` (the 19.65 ms → 4.63 ms + 2.37 ms row below). It shipped in the same file and was
  never re-validated in isolation, so it is **not claimed**. Re-attempt it on its own, timed against
  the crowded fixture, before believing that row.
- **Consequently the two viewport rows below (the `accepted_contributions` row and the
  participant-page row) are void**, as is the "Contribution counts in a viewport" row of the bounds
  table. Every other row still holds.
- **The lesson is recorded deliberately:** both withdrawn rows were justified by measurements on a
  fixture too small to expose the query plan. A micro-benchmark against a quiet, empty database did
  not predict the shipped suite. Any future viewport change must be timed against the crowded
  fixture, not only the micro-fixture.
- **Corroboration from this task's own run log:** `npm test` passed in 38.9 s twice while the
  withdrawn change was present, then the same code exceeded 25 minutes before it was killed. The plan
  flips with the database's own statistics, which is exactly why a per-call median cannot clear it.

Kept and still measured: the grouped calling-experience read (`src/vocations.js`), the bounded
per-resident visit atlas and claim history (`src/journey.js`, `src/platform.js`), and the harnesses
and bounds tests themselves.

## Hardware and environment

| | |
| --- | --- |
| Machine | Apple M5 (`Mac17,3`), 10 cores, 16 GiB memory |
| OS | macOS 26.6.2 (build 25G83), internal SSD |
| Runtime | Node v24.19.0 (`node:sqlite`, `node:http`) |
| Process model | one HTTP process, one SQLite connection in WAL mode, loopback only |

Timings are single-machine medians; they move with thermal state, other load and Node version. The
*shapes* (row counts, rebuild counts, bytes) are machine-independent; the milliseconds are not.

## What was measured, and with what

| Question | Instrument | Command |
| --- | --- | --- |
| Source-level cost of the reads a resident client makes | `scripts/perf-profile.mjs` | `npm run perf` |
| Concurrent-client behaviour with explicit limits | `scripts/load-harness.mjs` | `npm run load` |
| Live-channels soak: many SSE subscribers, reconnects, write load | `scripts/multiplayer-soak.mjs` | `node scripts/multiplayer-soak.mjs --accounts 16 --duration 12000` |
| Renderer geometry reuse across polls | `scripts/voxel-bench.mjs` | `node scripts/voxel-bench.mjs 200` |
| Bounds stated as assertions | `tests/performance-bounds.test.js` | `node --test tests/performance-bounds.test.js` |

### Fixture sizes

- **Profile fixture** (`scripts/perf-profile.mjs`): **10,002 agent rows** (10,000 synthetic plus the
  fixture's own residents, all stacked on one tile in the Commons), **12,002 world rows** (one home
  each plus 2,000 worlds visited by one resident), **2,000 journey visits** for one resident,
  **2,000 claims** for one operator, and one guild project with **100 participants** and
  **200 contributions**. Schema 18. Measurements are the median of **9** timed calls after one
  warm-up call, one process, one connection.
- **Harness fixture** (`scripts/load-harness.mjs`): **10,000 synthetic agents** stacked in the
  Commons with one home each, plus 2,000 visits and 2,000 claims for one resident/operator.
- **Renderer bench**: 200 participants in the Commons, a 29 × 25 window, 725 cells; medians of 20
  updates.

### How latency is computed

Latency is wall-clock on the harness client, from writing the request to receiving the last body
byte, and includes loopback, HTTP parsing, the server's synchronous transaction, JSON encoding and
the transfer. Percentiles are **nearest-rank on the sorted sample of successful responses** —
`p95` of *n* values is the `ceil(0.95n)`-th smallest — and each figure states its sample size. Timeouts
and failures are removed from the latency sample and counted on their own, so a deadline cannot flatter
a percentile.

## Source-level cost: before and after

`GET /world` is the resident client's hottest read: the browser polls it every 3 seconds, and character
movement posts separately. Everything below is one process on one SQLite connection.

| Read | Before | After | Before payload | After payload |
| --- | --- | --- | --- | --- |
| `GET /world` crowded, 200 avatars | **93.06 ms** (p95 114.40) | **30.29 ms** (p95 30.85) | 224.9 KiB | 224.9 KiB |
| `GET /world` empty window (fixed overhead) | 3.44 ms (p95 3.99) | 3.68 ms (p95 7.81) | 9.2 KiB | 9.2 KiB |
| `GET /worlds` directory page | 21.04 ms (p95 21.40) | 21.72 ms (p95 21.94) | 5.4 KiB | 5.4 KiB |
| `GET /journey`, 2,000 stored visits | 8.81 ms (p95 22.36) | 8.70 ms (p95 9.10) | **210.0 KiB** | **30.5 KiB** |
| `GET /history`, 2,000 stored claims | 3.47 ms (p95 5.50) | **1.36 ms** (p95 1.64) | **730.3 KiB** | **73.6 KiB** |
| `GET /history` as reviewer/admin | 0.24 ms | 0.28 ms | 0.1 KiB | 0.1 KiB |
| `GET /gallery` | 0.13 ms | 0.14 ms | — | — |
| `GET /guilds` board page | 1.51 ms (p95 2.52) | 1.45 ms (p95 1.63) | 137.0 KiB | 137.0 KiB |
| `GET /guilds/project`, 100 participants | 1.34 ms (p95 1.37) | 1.41 ms (p95 1.44) | 133.4 KiB | 133.4 KiB |

Each figure is a single run's median of 9 timed calls. Repeating a column moves the small numbers by a
few percent and the crowded viewport by a few milliseconds; the payload bytes and record counts are
stable, and those are the figures the changes actually target.

The `/worlds` and `/guilds` differences are inside run-to-run noise; no claim is made from them. The
journey *median* barely moved while its p95 and its payload fell, because the visit list is not what
dominates that read — see "where the time went".

### Where the crowded-viewport time actually went

Isolated measurements on the same fixture, same machine:

| Component | Before | After / measurement |
| --- | --- | --- |
| `publicCallings()` for the 200 visible avatars — three queries per avatar | **61.51 ms** | **1.53 ms** (changed, and the whole of the delivered win) |
| The 200-row participant page with `COUNT(*) OVER ()` vs without it | **19.65 ms** | 4.63 ms without + 2.37 ms for a separate bounded `COUNT(*)` (**measured, change withdrawn**) |
| `accepted_contributions` as one correlated 8-table subquery per avatar, vs one grouped read | 5.14 ms vs 4.34 ms on the empty-history fixture (≈ **0.8 ms**) | 0.42 ms vs 0.16 ms with 600 historic claims across the same 200 avatars (**measured, change withdrawn**) |
| Journey visit page, 2,000 stored visits | 1.77 ms unbounded | 0.77 ms at `LIMIT 200` (changed) |

**`publicCallings()` was the real hot path, and I only found it by measuring.** The first theory — that
the per-avatar contribution subquery dominated — was wrong: that subquery cost under 1 ms. The
avatar-roster read was expensive because the calling roster ran `summary()` (three queries plus a
per-receipt availability check) once per visible avatar, i.e. ~600 statements for one 200-avatar
payload. `COUNT(*) OVER ()` was the second cost: a window function cannot stop at `LIMIT`, so it
buffered and sorted every agent in the window to answer "how many are there?" for a 200-row page.

### Changes made

1. **`src/vocations.js` — one grouped experience read per roster.** New `summaries(platform, agentIds)`
   computes count, earned, held and today's available receipts for a bounded set of residents in three
   grouped statements; `summary()` is now the same function for one resident. `availableSql(ref)` is
   the single availability rule, used by the receipt page, the passport and the roster, so they cannot
   drift. `publicCallings()` uses it. *Before 61.51 ms → after 1.53 ms for 200 avatars.*
2. **`src/platform.js` — `history()` claims are bounded, in SQL.** The operator's claim list grows for
   as long as the account exists; it now takes the same `HISTORY_LIMIT` (200) as every other listing,
   newest first, with the runtime's own-character filter applied in SQL so the bound lands on the
   correct set. `tasks` and `missions` context are derived from the bounded page. *3.47 ms and 730.3 KiB
   → 1.36 ms and 73.6 KiB at 2,000 stored claims.*
3. **`src/journey.js` + `app.js` — the passport's visit history is bounded with exact totals.**
   `discoveries` is `LIMIT 200`, oldest first so the Commons arrival always survives truncation, and
   the response gained `discovery_count` (exact, counted in SQL) and `discoveries_truncated`. Badges,
   skills and quest progress already read SQL counts, never the page; the passport's "Places discovered"
   metric now reads `discovery_count`, so a truncated atlas cannot understate what a resident has
   walked. *210.0 KiB → 30.5 KiB at 2,000 stored visits.*

No schema change. No new dependency. `package.json` gained `npm run perf` and `npm run load`, and both
scripts are in the `check` syntax gate.

### Measured, then withdrawn (see the integrator correction above)

The two viewport changes below were implemented, measured, and then **reverted before this commit was
finalised**, so they are not in the delivered tree, the "after" numbers above do not include them, and
the two rows below are **void**. The numbers are kept only as a record of what the micro-fixture
showed, and of why a micro-fixture is not enough:

| Withdrawn change | Micro-fixture measurement | What the shipped fixture showed |
| --- | --- | --- |
| Replace `COUNT(*) OVER () AS in_viewport` with a separate bounded `SELECT COUNT(*)` | the 200-row participant page 19.65 ms → 4.63 ms + 2.37 ms, i.e. ~12.6 ms | never re-validated in isolation; **not claimed** |
| Compute the 200 avatars' `accepted_contributions` in one grouped read instead of one correlated eight-table subquery per avatar | ≈0.8 ms on the empty-history fixture; 0.42 ms vs 0.16 ms with 600 historic claims | `tests/world-platform.test.js` 8.3 s → over 300 s, from a pathological `GROUP BY` plan |

A viewport read with both changes measured 13.50 ms. **The delivered tree measures 30.29 ms**, and the
remaining cost is dominated by that window function plus the fixed per-read queries in the "did not
optimise" list. `GET /world` is therefore honest to re-measure as 30.29 ms, not 13.50 ms, and anyone
who re-runs `npm run perf` will see the delivered figure.

## Concurrent clients: explicit limits and what they showed

`scripts/load-harness.mjs` starts the shipped `server.js` as a child process against a **temporary**
database, seeds it, and drives its real HTTP API. Nothing is mocked and no request is replayed.

**The limits applied, and printed by every run:**

| Limit | Value |
| --- | --- |
| Simultaneous client workers | 1, 8, 32 (the concurrency ceiling) |
| Requests per level | 200 |
| Per-request deadline | 5,000 ms |
| Whole-run deadline | 240,000 ms |
| Failure budget | 0% — any failed or timed-out request fails the run |
| Workload | a repeating GET mix: crowded viewport, garden directory, resident passport, contribution history, health |

Model queue, read from the server's own `/health` payload and kept apart from HTTP: `model_configured=false`,
`model_queue=null`, `research_workers={"active":0,"limit":4}`, `resident_workers={"active":0,"limit":1}`.
**No model was configured, so no model call was made and no model queue was exercised.** These numbers
are HTTP capacity under a read-only workload; they are not model throughput, and the two are not
interchangeable.

### After the changes (delivered tree)

| Concurrency | Attempts | ok | timeouts | HTTP errors | Throughput | p50 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 200 | 200 | 0 | 0 | 62.54 req/s | 10.25 ms | 38.84 ms | 42.34 ms | 43.51 ms | 44.92 ms |
| 8 | 200 | 200 | 0 | 0 | 68.01 req/s | 107.39 ms | 183.21 ms | 207.70 ms | 257.38 ms | 438.12 ms |
| 32 | 200 | 200 | 0 | 0 | 67.28 req/s | 227.97 ms | 754.01 ms | 2821.78 ms | 2910.78 ms | 2971.58 ms |

Payload: 14,044.5 KiB total, **median 31,215 B** per response, largest 243.9 KiB (the crowded viewport).
The largest response is the one the client polls every 3 seconds; its size is dominated by the 200
avatar records and the 20 × 14 terrain window, both bounded.

An intermediate run with the two withdrawn `src/spaces.js` changes in place measured 90.76 / 93.56 /
94.86 requests/s. **Those figures are void** — they describe a tree that was never released, and that
tree's crowded-fixture test file took over 300 s. This table is the delivered figure.

### The same harness on the unmodified base

| Concurrency | Attempts | ok | timeouts | Throughput | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 200 | 200 | 0 | 36.45 req/s | 9.26 ms | 95.61 ms | 103.37 ms |
| 8 | 200 | 200 | 0 | 36.93 req/s | 217.16 ms | 399.72 ms | 767.28 ms |
| 32 | 200 | 188 | **12** | 38.84 req/s | 394.60 ms | 1021.52 ms | 4597.26 ms |

Payload before: median **215,064 B**, largest **663.9 KiB** (the unbounded contribution history).
Before, the run **failed its own zero-failure budget at concurrency 32** with 12 requests over the
5 s deadline. After, it passes. Throughput rose from ~37 to ~65 requests/second and the concurrency-8
p95 fell from 399.72 ms to 207.70 ms.

### The ceiling, stated precisely

- **Under this hardware, at this concurrency, on this read-only workload, completion throughput
  saturated around 62–68 requests/second and did not improve between 8 and 32 simultaneous clients.**
- Latency kept climbing instead (p95 208 ms → 2822 ms), so the binding constraint is the single Node
  process and the single SQLite writer, not the number of clients. Past roughly 8 simultaneous clients
  this configuration trades latency for nothing.
- **No production capacity claim is established.** 10,000 stored agents do not mean 10,000 supported
  users. Nothing here tested sustained load, memory growth, disk exhaustion, TLS, a proxy, multiple
  processes, multiple writers, write-heavy traffic or real network latency. See "not measured".

## Renderer level of detail (render-scale task, 14 October 2026)

Measured on the same machine, in a later worktree (`../w-render`, branch
`task-deepseek-render-scale`, base `f773c46`). **No database is read or written by this measurement**:
the scene builder is GPU-free, takes a world definition and a snapshot, and is the same code the
browser runs, so the fixture is bounded by construction.

| Question | Instrument | Command |
| --- | --- | --- |
| Renderer instances, draw calls and build time with and without the detail rule | `scripts/voxel-bench.mjs` (level-of-detail section) | `node scripts/voxel-bench.mjs 20 30` |
| The stated instance and draw-call budget as assertions | `tests/render-lod.test.js` | `node --test tests/render-lod.test.js` |

**Fixtures, named:** the shared `commons` (a 29 × 25 window, 725 cells) and the largest viewport the
server can request, the `frontier:0:0` sector (a 37 × 37 window, 1,369 cells = `VOXEL_LIMITS.cells`),
each with **20 drawn residents**; `RUNS = 30` for the rebuild and poll columns.

The rule: the renderer reads only the tiles within 12 tiles of the followed resident at full detail
(`LOD_LIMITS` in `src/voxel-geometry.js`). Beyond that radius a tile keeps every instance that decides
*what it is* — its surface slab, its base cube, its terrain type detail, its obstacle, its pick, its
building, its saved blocks — and loses the *unpicked* decoration that only decides how its ground
reads: ground cover mottling and seedlings, understory litter and tufts, water glints, shore breaks
and reeds. `lod: false` on a scene update is the escape hatch that restores the pre-LOD build exactly,
which is the "pre-LOD" column and how the tests produce their "before".

### Instances and draw calls (exact, machine-independent)

| Fixture | Instances | Draw batches | Cells read closely | Decorative instances |
| --- | --- | --- | --- | --- |
| `commons`, 29 × 25, 725 cells | 2,332 → **2,094** (−10.2%) | 99 → 99 | 725 → 437 | 489 → **251** (−49%) |
| `frontier:0:0`, 37 × 37, 1,369 cells | 3,273 → **2,729** (−16.6%) | 91 → 91 | 1,369 → 625 | 746 → **300** (−60%) |

Without residents the same two builds are 2,080 → 1,818 on the Commons and 3,021 → 2,325 on the
frontier fixture; the worst frontier sector in the tree (`frontier:-3:5`) is 3,228 → 2,367. A sweep of
all 54 authored worlds at two camera positions each — the fixture `tests/render-scene.test.js` already
uses — is 150,189 → 129,614 cubes (−13.7%).

**The draw-call count does not move, and that is the point of the shape.** A batch is one
`InstancedMesh` per colour and material style, not per tile, so the batch count is already bounded by
the palette rather than by the window (88–99 across those worlds, against the 130
`tests/render-scene.test.js` bounds). What scaled with the window was the per-tile decoration, and the
detail radius is what bounds it: at most `(2 × 12 + 1)² = 625` cells are ever read at full detail
whatever the window, so the decoration term is a constant while the per-cell floor is not.

### Build time (medians with the least perturbed sample, ms — these columns resolve nothing)

Three runs of `node scripts/voxel-bench.mjs 20 30`, on a machine carrying concurrent browser suites
(load average 18–42 on ten cores). The fixture `frontier:0:0` is the one that matters; the Commons is
too small for these columns to say anything at all.

| `frontier:0:0`, least perturbed sample | pre-LOD | detail rule |
| --- | --- | --- |
| First build (3 fresh scenes) | 26.5 / 29.0 / 12.3 ms | 11.3 / 14.1 / 10.1 ms |
| Static rebuild forced by a terrain tile, 30 samples | 6.4 / 6.8 / 7.2 ms | 5.7 / 7.1 / 7.5 ms |
| Poll on an unchanged payload, 30 samples | 0.9 / 1.0 / 0.9 ms | 0.9 / 0.9 / 1.2 ms |

| `frontier:0:0`, median | pre-LOD | detail rule |
| --- | --- | --- |
| First build | 41.5 / 46.7 / 30.4 ms | 24.8 / 25.1 / 54.2 ms |
| Static rebuild | 9.0 / 14.7 / 13.7 ms | 4.9 / 18.4 / 14.0 ms |
| Poll | 0.4 / 0.4 / 0.5 ms | 0.3 / 0.4 / 0.5 ms |

**The honest conclusion is that these columns do not establish a build-time win.** The pre-LOD first
build ranged 12.3–29.0 ms across three runs and the detail-rule build 10.1–14.1 ms, so the rule's
build was never the slower one, but the spread of either side is larger than the gap between them and
two of the three runs are inside one another's noise. The forced whole-window rebuild and the poll show
no difference at all once the scene is warm, which is expected: both sides do the same
plan-resolve and key work, and the warm rebuild's ~6 ms floor is dominated by that rather than by the
544 instances the rule removes.

What the instrument *can* state exactly is the geometry: a full static rebuild of the frontier fixture
allocates 544 fewer instances and writes 544 fewer instance matrices. On a machine that is not
running six other Node processes, the first-build row is where that would show; this document records
the numbers it has rather than the numbers it wants. The instance, draw-call and rebuild counts are
exact and machine-independent; the milliseconds are not.

Not claimed: any frame rate, GPU time, memory or thermal figure. There is no GPU in this loop and no
browser frame timing was captured. No production or per-user capacity claim is made or implied by any
number here.

## Renderer geometry reuse

The renderer is covered by `scripts/voxel-bench.mjs` (200 participants, medians of 20 updates) and by
the profile's own scene harness (60 participants, 20 roster polls and 20 objective polls).

| Signal | Before | After |
| --- | --- | --- |
| Character batch rebuilds per 20 roster polls | 20 | **0** |
| Terrain batch rebuilds per 20 roster polls | 0 | 0 |
| Character batch rebuilds per 20 objective polls (advanced rank, completed objective, same positions) | — | **0** |
| Batches disposed across 40 polls | — | **0** |
| Idle poll (identical payload) | 0.2 ms | 0.3 ms |
| One-block edit | 1.7 ms (whole build) | 0.3 ms (blocks only) |
| Terrain / block rebuilds per 20 block edits | 0 / 20 | 0 / 20 |

Roster polls that only move `last_seen`, presence, names, titles, cosmetics or the current objective now
reuse every existing instance batch and only refresh what a click returns; the batch key is the visible
field set (`id, x, y, z, posture, colour, kind, calling id`), so reordering the roster or advancing an
objective is not a geometry change. This is asserted, not just benchmarked:

- `tests/voxel-world.test.js:123` — "participant polls that change no visible field reuse the same
  character batches".
- `tests/voxel-world.test.js:168` — "explicit public callings add original emblems and objective
  updates refresh picks without rebuilding avatars".

A block edit still rebuilds the block batch (20/20) by design: the blocks are their own batch precisely so
that placing one block does not rebuild the diorama (terrain rebuilds 0/20). I did not change renderer
code: the numbers did not justify it.

## Bounds an independent reader can check

| Read | Bound | Where it is enforced | Test |
| --- | --- | --- | --- |
| Per-resident claim history | 200 | `HISTORY_LIMIT`, `src/platform.js` | `tests/performance-bounds.test.js` |
| Per-resident visit atlas | 200 (exact total reported as `discovery_count`) | `JOURNEY_LIMIT`, `src/journey.js` | `tests/performance-bounds.test.js` |
| Viewport avatars | 200 | `participantLimit`, `src/spaces.js` | `tests/world-platform.test.js`, `tests/performance-bounds.test.js` |
| Viewport terrain | 20 × 14 | `COLS`/`ROWS`, `src/spaces.js` | `tests/world-platform.test.js` |
| Viewport messages | 200 | `LIMIT 200`, `src/spaces.js` | `tests/world-platform.test.js` |
| Per-avatar contribution count | one value per returned avatar, bounded by the 200-avatar page | `${contributionEligibility}`, `src/journey.js` | `tests/performance-bounds.test.js` |
| Garden objects per world | 200 | `build()`, `src/spaces.js` (write rule; the read returns the stored set) | `tests/performance-bounds.test.js` |
| Garden directory page | 50 (plus 30 shared spaces) | `worldList`, `src/spaces.js` | `tests/performance-bounds.test.js` |
| Guild project page | 24 | `guilds()`, `src/guilds.js` | `tests/performance-bounds.test.js` |
| Guild participants per project / contributions read | 100 / 200 | `guildProjectView`, `src/guilds.js` | `tests/performance-bounds.test.js` |
| Journal | 200 | `journey()`, `src/journey.js` | `tests/journey.test.js` |
| Growing crops per garden | one row per garden tile (`PRIMARY KEY(agent_id,x,y)`), 20 simultaneously growing | `journey_crops` schema, `gardenAction` | `tests/journey.test.js` |
| Calling experience per resident per UTC day | 10 points (≤2 receipts) | `calling_receipts` trigger, `src/vocations.js` | `tests/vocations.test.js` |

## What I deliberately did not optimise, and why

- **`GET /worlds` (21.4 ms).** The response is already bounded and paginated; the cost is the exact
  `total` over 12,002 homes (7.9 ms) plus the `ORDER BY w.name` sort (8.3 ms). An index would help, and
  adding one is a schema change this task was told not to need. Left as measured.
- **The in-window total (`COUNT(*) OVER ()`).** Measured at 19.65 ms against 4.63 ms plus a 2.37 ms
  bounded count, and the change that avoided it was withdrawn with the grouped contribution read (see
  the integrator correction). It is the largest single remaining cost inside `GET /world` and is left
  exactly as the base revision has it. Re-attempt it alone, timed against the crowded fixture, before
  claiming that row.
- **`mayors()` inside the viewport read (0.45 ms).** It runs an N+1 over the 20 historic guides and
  recalculates two conversation lists the viewport discards. It is real waste, but at 0.45 ms of a
  30 ms read it does not justify touching the country-ambassador compatibility path.
- **The 5 `COUNT(*)` queries in the world payload (2.30 ms).** Combining them changes nothing.
- **`coins()` and the operator exports are still unbounded in SQL.** `coins()` reads every receipt for
  one resident because the same rows decide the exact `balance`; a `LIMIT` there would understate a coin
  balance, which is an integrity concern I will not trade for a query. Its growth is bounded by the
  reward policy (one receipt per independently accepted real contribution, at most one per operator per
  UTC day) and its response already returns the newest 100 with `has_more`. The `verifyCallingReceipts`
  replay inside `callings()` is likewise an integrity check that must see every receipt, and the export
  routes must be complete by definition. These are named here so they are not mistaken for bounded
  reads. In the measured fixture none of them is a hot path.
- **The parcel-selection overlay** rebuilds when the selected or hovered parcel changes. That is a
  selection change, not a roster or objective refresh, and the overlay is a handful of thin boxes.
- **Nothing in the authorization, visibility or receipt paths.** No check was relaxed, reordered or
  skipped. The contribution-eligibility predicate, the visitor/private-garden rule, the runtime scope
  and budget checks, the distinct-operator review rule and the append-only coin ledger are the base
  revision's own text, and the full suite plus the HTTP acceptance harness still pass.

## Not measured (do not read these numbers as covering it)

- **Model throughput and model queues.** No model was configured; no model call was made. The harness
  prints the server's own queue limits but never exercises them. A model queue is not HTTP capacity and
  these numbers must not be used as either.
- **Write paths.** Every harness request is a GET. Placement, building, missions, reviews, coins,
  chat and worker runs were not under load.
- **Real browsers, GPUs and frame rate.** There is no headless browser in this repository and no npm
  dependencies are permitted. Nothing here is an FPS statement; the renderer evidence is batch-rebuild
  counts, not frames.
- **Memory, disk and long-run stability.** The bounded multiplayer soak (`scripts/multiplayer-soak.mjs`,
  the last section of this document) is seconds long: it reports the rows and bytes its own workload
  wrote, and it is still not a memory-growth, disk-exhaustion or WAL-growth profile.
- **Network reality.** Loopback only: no TLS, no reverse proxy, no real internet latency, no packet
  loss.
- **Multiple processes, multiple writers, horizontal scale.** One process, one connection.
- **Real accounts or installed data.** All measurements use temporary databases under the OS temp
  directory; `data/`, the installed copy and backups were never touched.
- **Persistence duration.** SQLite is synchronous here; a future multi-worker database is untested.

## Multiplayer soak: the live channel, reconnects and write load

Task `deepseek-multiplayer-soak`. Measured on 14 October 2026 on the same machine as everything above
(Apple M5, 10 cores, 16 GiB, macOS 26.6.2, Node v24.19.0), against the shipped `server.js` started as a
child process on loopback with a **temporary** database. Reported because the section above says
"no soak test", and this is the bounded one that now exists — it is seconds long, not a stability
profile.

`scripts/multiplayer-soak.mjs` seeds fictional accounts, opens one authenticated Server-Sent Events
subscription per configured slot, writes with every writer account at once, disconnects and reconnects
part of the subscriber set mid-run, builds in a garden with an observer away for the writes, restarts
the process, and finally opens the documented process ceiling on real sockets. It asserts invariants
rather than only timing: see `tests/multiplayer-soak.test.js` for the same invariants at test scale.

### Limits applied, and printed by every run

| Limit | Value |
| --- | --- |
| Writer accounts | 8 or 16, one writing avatar each |
| Subscriptions | writers x 4 (32 or 64); the documented process ceiling is 64 |
| Write phase | 8,000 or 12,000 ms |
| Step pace | 145 ms plus a per-writer offset, above the server's own 120 ms step throttle |
| Chat / expression pace | every 12 steps (server allows one message per account per 1,500 ms) |
| Client buffer while a snapshot is in flight | 512 frames |
| Failure budget | zero: any refused request fails the run |

Workload per run: concurrent steps, public messages, expressions, a garden travel with six placements
and a removal, two mid-run reconnects per quarter of the subscriber set, a full process restart, then
the process-ceiling probe. No model is configured, so no model call is made and the model queue is not
exercised.

### Measured

| | 32 subscribers | 64 subscribers |
| --- | --- | --- |
| Writing avatars | 8 | 16 |
| Write phase | 8.16 s | 12.17 s |
| Row-writing requests accepted | 410 (50.2/s) | 1,251 (102.8/s) |
| Refused / throttled | 0 / 0 | 0 / 0 |
| Request latency p50 / p95 / max | 3.01 / 7.88 / 66.33 ms | 2.78 / 5.96 / 23.30 ms |
| Update frames received, all subscribers | 4,755 (146–150 each) | 15,020 (232–236 each) |
| Update entries received, all subscribers | 13,089 | 80,016 |
| Frame delivery latency p50 / p95 / p99 / max | 1 / 2 / 8 / 48 ms | 1 / 3 / 6 / 13 ms |
| Bytes received by subscribers | 2.00 MB | 11.19 MB |
| Duplicate messages on the wire | 0 | 0 |
| Frames for another world | 0 | 0 |
| Missed or out-of-order observations | 0 | 0 |
| Reconnect divergence | 0 | 0 |
| Database growth over the run | +16,384 B | +28,672 B |

At 64 subscribers the delivery rate is ~19.6 frames per client per second — the channel's documented
20/s ceiling — and every subscriber still ends on the stored tile for every avatar, with every public
message delivered once and in stored order. Neither run reached the frame cap exactly; the
64-subscriber run came closest (232–236 frames over 12.17 s ≈ 19.4/s), and the 32-subscriber run sat
lower (146–150 over 8.16 s ≈ 18/s), so the frame rate — not the subscriber count — is what these runs
saturate. Per-process `event_counters` are deliberately not reported here: the server builds them in
`/operations` but `diagnostics()` does not carry them, so every delivery number above is counted on the
client side from the frames it actually parsed.

### Which invariants held, and one that did not

Held in both runs (and asserted by `tests/multiplayer-soak.test.js`):

- every accepted public message reached every open subscriber **exactly once, in the stored insert
  order**, including subscribers that reconnected mid-run (they recover the earlier messages from the
  `/world` snapshot, not from a replay the channel deliberately does not keep);
- no subscriber ever observed an avatar's older tile after a newer one: each client's per-avatar tile
  history is a subsequence of the accepted write order, and its last observed tile equals the stored
  row after quiescence;
- a client reconnecting through the documented protocol — open the stream, re-read `/world` on `ready`,
  apply that snapshot, then the frames buffered while it was in flight — had no divergence and received
  live deltas again;
- a full process restart preserved every avatar tile and placed object, and the restarted process kept
  streaming;
- the process admitted all 64 subscriptions, refused the 65th with 503, left the admitted ones
  streaming, and an account with four open subscriptions was refused a fifth with 429. A separate
  disposable probe (not this harness) also closed one of an account's four subscriptions and reopened
  immediately, with no 429 in 12 of 12 attempts: the dropped socket is reaped before the next request
  is handled, so a client that reconnects straight away is not locked out by its own old connection.

Not held — a confirmed defect, reported by the run as
`silent_relocation_on_entitlement_change` (kept in `report.defects`, not in `report.failures`, because
the file is outside this task's writable set):

> `PATCH /api/v1/agents/:id/home { "visibility": "private" }` moves every visitor of that garden back
> to the Commons with a plain `UPDATE` in `homeSettings` (`src/spaces.js`) and calls
> `events.revalidateNow()`, but never `events.publish()`. Measured: the stored row moved to
> `commons,10,6` and `GET /world?world_id=commons` listed the avatar there, while a live Commons
> subscriber received **0** update frames naming it and still had no entry for it after 600 ms. The
> visitor's own garden subscription was correctly closed with `access_revoked`.

This contradicts `docs/ARCHITECTURE.md` ("A world mutation (a step, an arrival, a saved object, a
frontier block, a public message) publishes a bounded delta … and every subscriber of that world
receives it within one frame interval"): the relocation *is* an arrival in the Commons. It is pinned as
a `todo` case in `tests/multiplayer-soak.test.js` and is not fixed here, because `src/spaces.js` is not
this task's to change. The impact is bounded, not silent forever: the browser's `GET /world` poll
(every 3 s) reconciles the view, so the window is one poll interval rather than a permanent divergence.

### Not measured by this soak

- **Sustained stability.** The runs are 8–12 s. No memory-growth, WAL-growth, disk-exhaustion or
  multi-hour profile.
- **The 256-update buffer bound from real sockets.** Reaching it needs more than 256 distinct
  publishing entities in one world; this workload has at most 16 moving avatars plus one world's
  messages, so a well-behaved subscriber never approaches it. The bound stays covered by
  `tests/realtime-bounds.test.js` and `tests/realtime-channel.test.js`, not by this harness.
- **Capacity.** 64 is the process's documented subscription ceiling, not a supported-user figure.
  16 writers is the most this harness could drive, because one avatar steps at most once per 120 ms.
- **Model throughput and the model queue.** No model was configured; no model call was made.
- **Network reality.** Loopback only: no TLS, reverse proxy, packet loss or real latency.
- **Multiple processes and multiple SQLite writers.** One process, one connection.
- **Slow or hostile readers at the socket level.** `tests/realtime-bounds.test.js` drives those against
  the hub directly; this soak only exercises clients that read normally.

## How to reproduce

```sh
export PATH="../node-bin:$PATH"          # Node v24.19.0
npm run perf                              # source-level before/after table (temporary database)
npm run load                              # concurrent clients, 1 and 8, 200 requests each
node scripts/load-harness.mjs --clients 1,8,32 --requests 200 --json /tmp/load.json
node scripts/multiplayer-soak.mjs --accounts 8 --duration 8000 --json /tmp/soak-32.json
node scripts/multiplayer-soak.mjs --accounts 16 --duration 12000 --json /tmp/soak-64.json
node scripts/voxel-bench.mjs 200          # renderer batch rebuild counts
node scripts/voxel-bench.mjs 20 30        # renderer level-of-detail pair on the Commons and a frontier sector
node --test tests/performance-bounds.test.js
node --test tests/render-lod.test.js             # the renderer's level-of-detail invariants
node --test tests/multiplayer-soak.test.js       # the soak's own invariants, at test scale
```

The "before" column was produced by exporting the base revision to a temporary directory
(`git archive HEAD | tar -x -C /tmp/t14-before`), copying the same scripts in, and running the same
commands there.

The harness exits non-zero when the failure budget is exceeded, so it can be used as a release probe on
a machine of interest. It is deliberately **not** part of `npm test`: a timing measurement is evidence,
not a stable assertion.

## Renderer budgets after the first visual slice (15 October 2026)

The slice adds geometry (room walls, windows and floor patterns; lamp light) and one batch (`voxel-lights`).
It stays inside the stated budgets without raising any of them. Exact and machine-independent, from the same
GPU-free scene builder the tests use (`createVoxelScene().update`, no residents, the world's own start tile):

| World | Instances before → after | Draw batches before → after | Lit-lamp instances |
| --- | --- | --- | --- |
| `hall` / `pavilion` | 790 → 1,192 | 42 → 77 | 12 |
| `library` | 1,588 → 2,069 | 49 → 83 | 19 |
| `observatory` (the largest room, 32 × 24) | 1,230 → 1,787 | 53 → 88 | 14 |
| `house:sample` (a cottage) | 783 → 1,186 | 53 → 90 | 6 |
| `commons`, day | 1,902 → 1,902 | 90 → 90 | 0 |
| `commons`, night | 1,946 → 1,948 | 92 → 94 | 2 |
| `frontier:0:0` and `frontier:-3:5`, night | 2,527 and 2,667, unchanged | 84 and 56, unchanged | 0 |

The largest room is 1,787 of the 3,600-instance `DIORAMA_BUDGET.instances`, and the worst batch count anywhere
in the sweep is 94 of the 130 `DIORAMA_BUDGET.draw_calls`. Outdoor worlds are unchanged except for lit lamps at
dusk, night and dawn (at most 48 lamps, three instances each). The face tone adds no instance and no batch: it
is a shader change on the existing materials, and the glow strength is a material property. No frame time was
measured (there is no GPU in this loop); `tests/render-interiors.test.js` asserts the instance and batch
ceilings for every authored room, with and without the level-of-detail rule, and under reduced motion.

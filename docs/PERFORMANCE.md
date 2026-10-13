# World performance and measured capacity

Task 14. Measured on 13 October 2026, branch `task-14-performance`, schema **18** (unchanged), base
`task-13-newcomer-journey`. Every number below was produced by a script in this repository; every
"before" number comes from an unmodified copy of the base revision on the same machine.

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
- **Memory, disk and long-run stability.** No soak test, no memory-growth profile, no disk-exhaustion
  or WAL-growth measurement; the runs are seconds long.
- **Network reality.** Loopback only: no TLS, no reverse proxy, no real internet latency, no packet
  loss.
- **Multiple processes, multiple writers, horizontal scale.** One process, one connection.
- **Real accounts or installed data.** All measurements use temporary databases under the OS temp
  directory; `data/`, the installed copy and backups were never touched.
- **Persistence duration.** SQLite is synchronous here; a future multi-worker database is untested.

## How to reproduce

```sh
export PATH="../node-bin:$PATH"          # Node v24.19.0
npm run perf                              # source-level before/after table (temporary database)
npm run load                              # concurrent clients, 1 and 8, 200 requests each
node scripts/load-harness.mjs --clients 1,8,32 --requests 200 --json /tmp/load.json
node scripts/voxel-bench.mjs 200          # renderer batch rebuild counts
node --test tests/performance-bounds.test.js
```

The "before" column was produced by exporting the base revision to a temporary directory
(`git archive HEAD | tar -x -C /tmp/t14-before`), copying the same scripts in, and running the same
commands there.

The harness exits non-zero when the failure budget is exceeded, so it can be used as a release probe on
a machine of interest. It is deliberately **not** part of `npm test`: a timing measurement is evidence,
not a stable assertion.

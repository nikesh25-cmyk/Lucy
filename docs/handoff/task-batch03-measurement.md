# Slice 6 — measured frame time, movement, write load and model-queue behaviour

Branch `task-batch03-measurement`, based on the frozen review tree
`review/nemoworld-batch03` @ `30e36cf`.

The measurement harness already exists (Task 14 `perf-profile.mjs`, Task 28 `load-harness.mjs` /
`capacity-experiment.mjs`). This slice runs it on the review tree, reports the hardware, and pins the
limits. **No code changed** — the numbers below are the shipped harness on this machine.

## Hardware / environment

- **Apple M5**, 10 cores, **16 GB RAM**, macOS **26.6.2** (25G83), Darwin arm64.
- One Node process, one SQLite database, disposable fixtures; the installed world was never touched.

## Frame time / renderer reuse — `npm run perf`

Renderer geometry reuse (no GPU): across 20 roster polls and 20 objective polls, **0** character
rebuilds and **0** terrain rebuilds; **0** disposed batches across 40 polls. A poll that changes no
visible field reuses batches.

Representative source-level reads (median of timed calls after warm-up, one process/one connection):

| Read | Time | p95 | Payload |
| --- | --- | --- | --- |
| `GET /worlds` directory page | 21.08 ms | 21.19 ms | 5.4 KiB |
| `GET /journey` (2,000 visits) | 10.98 ms | 11.89 ms | 40.5 KiB |
| `GET /history` (2,000 claims) | 1.37 ms | 1.55 ms | 73.6 KiB |
| `GET /guilds/project` (100 participants) | 1.33 ms | 1.43 ms | 133.4 KiB |

All bounded reads used an index (query plans printed by the harness).

## HTTP capacity / multi-client — `npm run capacity` (invokes `load-harness.mjs`)

200 requests per level, one Node process with one SQLite writer:

| Concurrency | Outcomes | Throughput | p50 | p95 | p99 | Budget |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 200/200 ok | 40.75 req/s | 12.64 ms | 67.89 ms | 125.01 ms | within |
| 8 | 200/200 ok | 31.89 req/s | 170.94 ms | 650.34 ms | 889.01 ms | within |
| 32 | 188/200 ok (12 timeouts) | 39.9 req/s | 373.64 ms | 1043.95 ms | 4272.61 ms | **ABOVE** |

**Browser clients**: 1 suite (≤2 pages, 4 scenarios) 31.8 s, all passed; **2 suites** (≤4 pages, 8
scenarios) 41.0 s, all passed — including `shared-presence-two-clients` (two browsers watching each
other move and build over the event channel).

## Model-queue behaviour — `npm run capacity`

Shipped `boundedModel`, 12 simultaneous requests, `max_waiting = 8`, a 50 ms **stub** inference
(no real model configured or called): **admitted 9 of 12, refused 3 as saturated, peak waiting 8/8,
one-at-a-time peak active 1**; serialized throughput 19.9 inferences/s; the bound held. The shipped
server drill `node scripts/ops-rehearsal.mjs --drill model-queue-saturation` → PASS (807 ms).

## The limits (stated, not implied)

- This is **this hardware, this fixture, this concurrency, this workload**. The c=32 level is already
  **above its stated budget** (12 timeouts), so the honest local ceiling is the c=1–c=8 band under the
  shipped read workload.
- The model figures use a **stub**; a real local model would be far slower and is the real bottleneck.
- **No MMO scale and no production capacity is claimed.** No supported-user count is implied, and a
  stored-record count is never a count of simultaneous users. The docs already say this
  (`docs/ARCHITECTURE.md:29`) and `capacity-experiment.mjs` prints the same claim line; nothing stale
  needed reconciling.

## Migration / rollback

Documentation only; no code, schema or storage change.

# Reliability and operational limits — Wave 7, base `27c0d72` (schema 25)

This is the Wave 7 operational limits report. It has **four arms and it keeps them separate**: HTTP
read capacity, SQLite write capacity, model-worker throughput, and browser frame rate. There is no
blended figure anywhere in this document, and adding two arms together is not a supported reading of it.

Every number here was measured on a **disposable** installation — a private temporary directory with
its own database, its own server process and its own backups — and every temporary directory was
deleted afterwards. The installed product, its database, credentials, backups and model weights were
never opened. The disk each run consumed is reported in §7.

Nothing here is a capacity guarantee, a service-level objective, a supported-user count or a launch
claim. It is this hardware, this fixture, this concurrency and this workload, on this tip. **The load
average is stated with every figure, because the same command on the same code differed by a factor of
2–5 in throughput and by an order of magnitude in p95 between a quiet host and a host running
concurrent sibling work** (load average ~3 versus ~140 on a 10-core machine). §2 and §3 report both
runs for the arms where that happened; the quiet run is the number to quote, and the contended run is
the reason not to trust any single figure here in isolation.

## 1. The four arms, and what each one is

| Arm | What it measures | How it was measured | Ceiling |
| --- | --- | --- | --- |
| **1. HTTP read capacity** | What one Node process with one SQLite writer completes under the shipped read workload | `scripts/load-harness.mjs` **unmodified**, invoked by `scripts/capacity-experiment.mjs` | 1 / 8 / 32 simultaneous clients, 200 GETs per level, 5 s per request |
| **2. SQLite write capacity** | What the shipped server does with the two writes a resident client actually sends, over real HTTP | `scripts/capacity-experiment.mjs` write section | 1 / 8 clients, 40 paced movement steps each, 3,000 unpaced garden saves, 80 buildable tiles |
| **3. Model-worker throughput** | What the bounded local-model queue does when more work arrives than one inference can serve | `scripts/capacity-experiment.mjs` model section + the shipped `model-queue-saturation` drill | 12 simultaneous requests, `maxWaiting` 8, 50 ms stub inference |
| **4. Browser frame rate** | — | **Externally owned.** Not measured by this slice. | — |

**Arm 4 is not measured here and no number is offered for it.** The rendering-measurements owner holds
it. The browser rows that exist elsewhere in this repository are suite wall-clock and in-page
input→confirmation timings, never FPS, and nothing in this document should be read as a frame-rate
claim.

## 2. Arm 1 — HTTP read capacity

```sh
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
node scripts/capacity-experiment.mjs --skip-browser --json /tmp/wave7-capacity.json
```

Fixture: **10,001 synthetic stored agents** stacked on the reader's own tile in the Commons, 10,001
homes, 2,000 visits, 2,000 claims. Stored records build rows; they do **not** create concurrency. The
concurrency ceiling is the client pool, and it is stated.

Host load during the reported run: **3.03 before, 2.44 after** on a 10-core host — a quiet machine.

| Concurrency | ok / attempts | HTTP errors | Timeouts | Throughput | p50 | p95 | p99 | Largest response |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 200 / 200 | 0 | 0 | 50.66 req/s | 9.59 ms | 62.48 ms | 63.69 ms | 248,490 B |
| 8 | 200 / 200 | 0 | 0 | 53.57 req/s | 133.83 ms | 271.60 ms | 353.97 ms | 248,534 B |
| 32 | 200 / 200 | 0 | 0 | 52.10 req/s | 304.38 ms | 3,646.03 ms | 3,754.30 ms | 248,534 B |

Harness verdict: **`no failure-budget breach up to concurrency 32`**, exit code **0** — this arm is
**GREEN** on the reported run. Throughput is flat at ~51–54 requests/second from 1 to 32 simultaneous
clients while p95 climbs to 3.6 s: that is one synchronous read path serving every request, and the
crowded `GET /world` (~249 KB) is the dominant cost inside it. This reproduces the 14 October
measurement on schema 22 (51–53 req/s, 0 failures at concurrency 32) closely enough that the shape has
not moved between those tips.

### The same arm under contention, and why it is reported too

The identical command was run earlier the same day while concurrent sibling work pushed the host to a
load average of **141 before / 117 after**. That run measured:

| Concurrency | ok / attempts | Timeouts | Throughput | p50 | p95 | p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 200 / 200 | 0 | 13.73 req/s | 27.48 ms | 253.19 ms | 315.34 ms |
| 8 | 200 / 200 | 0 | 9.83 req/s | 631.12 ms | 2,147.62 ms | 3,527.83 ms |
| 32 | 158 / 200 | **42** | 13.27 req/s | 877.83 ms | 4,049.14 ms | 4,504.15 ms |

with the harness's own verdict `the failure budget was first exceeded at concurrency 32` and **exit
code 1**. On that run this arm was **RED**.

Both runs are recorded because the comparison is the finding: **under a load average above ~130 on a
10-core host, this world's read path breaches a 5-second per-request deadline at concurrency 32 (42 of
200 requests), while on a quiet host it does not.** Nothing in the code changed between the two runs.
The practical reading is that this arm is highly sensitive to what else the machine is doing, so any
number from it must be quoted with the load average, and capacity planned from it should assume the
contended case rather than the quiet one. No capacity ceiling is claimed either way.

## 3. Arm 2 — SQLite write capacity

Same experiment, write section. 8 mover residents (one per client, each paced above the server's own
120 ms per-resident step throttle, so an accepted step is measured rather than the application's own
refusal), 1 builder in its own garden over 80 buildable tiles, 8 authenticated Commons event
subscribers held open across the levels. Real HTTP against the shipped `server.js`. Reads are not mixed
into this section.

| Clients | Movement | move p50 / p95 | Building | build p50 / p95 | Failures |
| --- | --- | --- | --- | --- | --- |
| 1 | 40 paced steps, 7.67 steps/s | 3.3 / 4.4 ms | 3,000 unpaced saves, 2,396.52 saves/s | 0.4 / 0.5 ms | **0** |
| 8 | 320 paced steps, 61.85 steps/s | 3.0 / 4.6 ms | 3,000 unpaced saves, 3,530.74 saves/s | 1.8 / 3.8 ms | **0** |

Subscribers: **8 of 8 opened**, 712 frames, delivery p50/p95 **1 ms** against the frame's own server
clock, peak **7.13 frames/client/s** against the channel's 20 fps bound. Every subscriber held its feed
for the whole level. Harness verdict: `0 failed/timed-out writes` — this arm is **GREEN** on the quiet
run, and exit code is 0.

The measured application bound is real and unchanged: twelve **unpaced** steps on one resident gave **1
accepted, 11 refused `429` in 10.37 ms** — the shipped 120 ms per-resident movement throttle. That is
why movement above is paced, and why a paced step is not counted as a throttle refusal.

### The same arm under contention

Run under a host load average of **141 / 117**, the identical command measured at concurrency 8:

- movement: 320 paced steps at 61.15 steps/s, p50 3.1 ms, p95 8.8 ms, 0 failures;
- building: 3,000 unpaced saves at 815.66 saves/s, p50 11.9 ms, p95 31.1 ms, **1,176 failures**.

Those 1,176 failures were **1,176 socket-level failures with 0 HTTP errors and 0 timeouts**: 1,824
writes were answered `201` and 1,176 connections failed before a response arrived. That is the
signature of **client-side connection exhaustion**, and the harness's write client explains it — it
opens a **new TCP connection for every request and passes no keep-alive `agent`**
(`scripts/capacity-experiment.mjs`), so 3,000 unpaced writes became 3,000 short-lived connections. On
the quiet run the same code recorded **0 failures** at the same level.

Two consequences, stated rather than smoothed over:

- **The contended run does not establish a server-side write ceiling.** It establishes that this
  harness's client did not complete at this concurrency under that contention. The quiet run is the
  number to quote; the contended run is evidence of how badly this measurement degrades when the host
  is busy.
- **The harness would be more trustworthy at this level with one change:** give the write client a
  keep-alive agent (`new HttpAgent({ keepAlive: true, maxSockets: … })`), exactly as this slice's own
  soak harness had to. `scripts/capacity-experiment.mjs` was **not** modified here, because it also
  contains the browser section owned by the rendering-measurements owner.

The two runs together are also the honest caution about every number in this document: **the same
command, unchanged code, differs by a factor of 2–5 in throughput and by an order of magnitude in p95
depending on the host.**

## 4. Arm 3 — model-worker throughput

```sh
node scripts/capacity-experiment.mjs --skip-browser --json /tmp/wave7-capacity.json
```

**No model was configured and no model was called.** This arm is the shipped `boundedModel`
(`runtime/model.js`) with a **stub inference of a stated 50 ms latency**, plus the shipped server's own
`model-queue-saturation` drill. It is the queue's own bound; it is **not** a model's throughput.

Ceiling: 12 simultaneous requests, `maxWaiting` 8, 50 ms stub.

| | |
| --- | --- |
| Admitted | 9 of 12 (peak active **1**) |
| Refused as saturated | **3** |
| Failed | 0 |
| Peak waiting | 8 of 8 — the bound held |
| Queue wait before inference | p50 201.8 ms · p90/p95/max 401.5 ms |
| Serialized throughput at a 50 ms stub | 19.9 inferences/s |
| Shipped server drill | `PASS model-queue-saturation (658 ms)`, exit 0 |

This arm measured the same on the contended and the quiet host — it is a queue bound, not a throughput
measurement, so contention does not move it. Read from the shipped server rather than exercised here: 1
resident run at once, 4 research workers, `maxWaiting` 8, **64** event subscriptions per process.

What this arm says, and what it does not: the local model is served one inference at a time, work beyond
`maxWaiting` is **refused** rather than queued without bound, and a refused request inside the shipped
server degrades to the published rules instead of hanging (proved by the drill). It says nothing about
how fast a real model is, and no real model was available to measure.

## 5. Long-running use and memory growth — the bounded soak

This is the arm that asks a different question from the others: not "how much at once", but "what
happens over time". It is the same shipped server, driven for 180 seconds by four client workers under
a fixed, stated request mix, with the server process's resident memory sampled every 5 seconds and the
on-disk footprint sampled alongside it.

**Ceilings, all enforced and printed by the run:** 180 s wall clock, 4 client workers, 200 synthetic
stored residents, 5 s per-request deadline, 256 MiB total on-disk budget.

**The request mix actually sent** (fixed weights, not an outline): 45% crowded viewport read
(`GET /world` with 200 residents stacked on one tile — the worst case for that read), 15% resident
passport, 10% garden directory, 10% community, 10% health, and the write arm: one confirmed movement
step per worker, **paced at the shipped 120 ms per-resident throttle** so that an accepted write is
being measured rather than the application's own refusal. Each worker owns its own operator and its own
resident, because the throttle is per resident.

**The request mix actually sent** (fixed weights, not an outline): 45% crowded viewport read
(`GET /world` with 200 residents stacked on one tile — the worst case for that read), 15% resident
passport, 10% garden directory, 10% community, 10% health, and the write arm: one confirmed movement
step per worker, **paced at the shipped 120 ms per-resident throttle** so that an accepted write is
being measured rather than the application's own refusal. Each worker owns its own operator and its own
resident, because the throttle is per resident.

**Result — one 180-second run on a quiet host (load average 2.38 before / 14.54 after).**

| | |
| --- | --- |
| Wall clock | **180.1 s** (the ceiling) |
| Requests | 33,118 — **32,689 ok**, 429 refused `429` (the paced movement throttle, stated in the mix), **0 timeouts, 0 socket errors, 0 server errors** |
| Throughput | **183.91 requests/s** while also holding the write arm |
| Server health | `200` before the soak, `200` after it |
| Write arm | **4,133 of 4,562** paced moves accepted, 429 refused by the shipped 120 ms throttle |
| Latency (successful responses) | p50 **17.9 ms** · p90 41.3 ms · p95 **55.6 ms** · p99 134.4 ms · max 1,740.8 ms |
| Latency drift | first half p50 14.5 / p95 **36.4 ms** → second half p50 20.7 / p95 **78.2 ms** — the second half was **about twice as slow at p95**, which is stated rather than averaged away |

The drift is the one thing here that deserves attention and it has an obvious benign explanation:
throughput is flat (32,689 successful responses over 180 s) and the *tail* roughly doubles between halves
while p50 moves 14.5 → 20.7 ms. An earlier contended run showed the opposite drift (p95 falling
210 → 176 ms). Neither is a monotonic trend, and a 180-second window cannot separate a warm cache
effect, allocator behaviour and a real slow leak. It is recorded as an observation to watch, not as a
finding.

The same soak was also run earlier the same day under a load average of 79 → 137: **10,586 requests
(58.64 requests/s), 9,990 ok, 596 throttle refusals, 0 timeouts, 0 socket errors**, latency p50 52.6 ms,
p95 194.0 ms, p99 339.4 ms. The comparison is the point: **the same code and the same mix moved from 58.6
to 183.9 requests/s and from p95 194 ms to p95 55.6 ms purely on host load.** Quote neither without the
load average.

**Memory.** 37 samples of the server process's resident set size, one every 5 s:

| | |
| --- | --- |
| Minimum | **64,544 KiB (63 MiB)** |
| Median | 249,376 KiB (244 MiB) |
| Maximum | **294,592 KiB (288 MiB)** |
| First sample → last sample | 111,392 → 166,800 KiB |
| First-quarter median → last-quarter median | 285,296 → **205,952 KiB** |

**The honest description of the shape: a broad plateau with a sawtooth, not a monotonic trend, and by
the last quarter it is *falling*.** The series climbs to ~294 MiB within the first 15 s, holds
~235–290 MiB for about two minutes, drops to **64,544 KiB** at 150 s (a large collection returning pages
to the operating system), and ends between 166 and 213 MiB. The quarter medians fall
(285,296 → 205,952 KiB), the minimum is far below the plateau, and the process repeatedly returns to a
low value — the signature of a V8 heap growing under allocation pressure and being collected, not of
unbounded accumulation.

**The quoted "change" figure and a linear slope over this window are dominated by *where the last
collection landed* and are therefore NOT a leak measurement.** This document offers no leak verdict. A
180-second window cannot separate warm-up, allocator behaviour, a long-period sawtooth and a slow leak.
**Attributable to something specific:** no — the run does not isolate a cause, and it is not designed
to. What can be said is that the workload is allocation-heavy by construction (a ~250 KB crowded-viewport
document is built for ~44% of all requests, at ~184 requests/s) and that the observable band over 180 s
is **~63–288 MiB with a floor far below the plateau**. A leak hunt would need a longer run, a heap
profile and a steady-state comparison; none of that was done here.

**Storage.** No unbounded growth. Over 37 samples the write-ahead log climbs from 1,400,832 bytes to
**4,124,152 bytes** — its SQLite auto-checkpoint bound — within the first 15 s and then holds there
exactly for the remaining 165 s. The database file moved from 8,962,048 to 9,097,216 bytes, and total
footprint from 10,395,648 to **13,254,136** bytes: a growth of **2,858,488 bytes** over 180 s, i.e. the
log grew to its bound and stopped. This is the same plateau the contended run measured
(4,120,032 → 4,124,152 bytes), so the checkpoint bound is a property of the world, not of the host.

## 6. Reconnect storms, queue saturation and storage exhaustion

### 6.1 Reconnect storm and the event channel's ceiling

Ceilings: **120 reconnect cycles**, **8 simultaneous reconnectors**, then a probe that opens
subscriptions until the channel refuses, capped at the channel's own 64-subscription ceiling plus four
(68). The storm ran against the same shipped server, on the same disposable database.

| | |
| --- | --- |
| Cycles requested | 120 |
| Opened and disconnected | **120** — 120 `ready` frames received, **0 refusals, 0 client errors** |
| Storm duration | 1.11 s → **107.82 reconnects/second** |
| Channel counters over the storm | `opened 120 · closed 120 · refused 0 · overflow_closed 0 · write_closed 0` |
| Connections held after the storm | **0** |
| Connections held while the probe was at the limit | **64** |
| Probe outcome | **64 of 68 accepted**, the remaining **4 refused `503`** — the channel's own 64-connection ceiling |
| Connections after the probe released | **0** (accounts 0) |
| Service afterwards | `/health` **200**, `GET /world` **200** |

**What the system does at the limit, and what it withholds:** the event channel accepts exactly 64
subscriptions and then refuses the 65th with `503 The event channel is at capacity. Try again shortly.`
— a refusal, not a hang and not an unbounded queue. A second, finer bound also exists (4 subscriptions
per account, `429`), which the Task 27 rehearsal demonstrates and which this fixture avoids by giving
each group of four its own account. Churn is clean: 120 open/close cycles produced 120 closes, no
leaked subscription and no held connection afterwards, and the world served normally immediately after.
This is **not** evidence about a storm of many thousands of clients, or about several server processes
behind a load balancer — it is one process, one channel, one bounded storm.

### 6.2 Model-queue saturation

Arm 3 above is the queue's capacity. The saturation *behaviour* was exercised by the shipped drill,
because that drill already drives it and re-driving it would add nothing:

```
PASS  model-queue-saturation  (2546 ms)      # via node scripts/ops-rehearsal.mjs --drill model-queue-saturation
```

It proves, at the queue's own boundary and inside the shipped server: one inference at a time, only the
configured number of waiters, work beyond the bound **refused** with a busy error rather than queued,
an aborted request leaving the queue instead of holding a slot, order preserved on release, and — over
real HTTP — a refused conversation **degrading to the published rules** rather than hanging, with the
refusal counted (`model.rejected_saturated`). **No real model was configured for any of it.**

### 6.3 Storage growth and storage exhaustion

Growth over the soak is in §5 (the WAL climbs to its ~4.1 MB checkpoint bound within 15 s and stops;
the database file moved three times in 180 s). This section is the exhaustion probe.

**Method.** A disposable world, its page limit set to the current page count so any write needing a new
page fails exactly as `SQLITE_FULL` does on a full volume, and the shipped `server.js` handed *that*
connection so the limit applies to the real HTTP path. The write driven is `POST /api/v1/jobs` — a
runtime credential reporting its own run summary — chosen because it has no world rule of its own to
confuse the signal: only storage can refuse it. Ceilings: a 400-attempt fill cap and the 256 MiB disk
budget.

| | |
| --- | --- |
| Read while writes were impossible | `GET /world` → **200** (reads keep working; exhaustion is a write problem) |
| Writes accepted before the limit | **7 of 8 attempts** |
| First refusal | `500 {"error":"Server error."}` — **generic, no actionable message** |
| Audit entries added by the refused write | **0** — the transaction rolled back cleanly |
| `PRAGMA quick_check` while full | **ok** |
| `audit_valid` / `coin_ledger_valid` from the shipped diagnostics | **true / true** |
| Incident recorded | **1**, `route /jobs`, `error_code ERR_SQLITE_ERROR`, timestamped |
| After space returned | the same write answered **201** |
| Storage after the probe | db 9,080,832 + WAL 4,124,152 + shm 32,768 bytes |

**What the system does at the limit:** it stops writing, keeps reading, keeps its file integrity, keeps
its audit chain and coin ledger valid, rolls the failed write back completely and resumes writing the
moment space returns. **What it does not do:** it does not tell the client anything useful. The
Platform's own message is actionable, but the HTTP layer answers every unhandled error with
`Server error.`, so a client cannot distinguish a full disk from any other internal fault. That is
recorded as a **likely issue** in §8 and in the handoff; it is a response-contract decision, not a
redaction one, and this slice did not change it. What the new incident record adds is that an operator
*can* now see the event, attributed to the route, without reading a terminal.

## 7. Disk actually consumed

Every experiment ran in a private temporary directory under `/tmp` (or the system temporary directory)
and was deleted at the end of its run. The measured consumption of one complete soak run — the three
sections together, including the seeded fixture, the soak database with its WAL, the exhaustion
database and its vault key — was:

| Run | Measured on-disk consumption | Ceiling | Cleaned up |
| --- | --- | --- | --- |
| `node scripts/soak-experiment.mjs --soak-seconds 20 …` | **35,220,642 bytes (33.6 MiB)** | 268,435,456 bytes (256 MiB) | yes — `cleanup removed /var/folders/…/nemoworld-wave7-soak-Vn0rRV` |
| `node scripts/soak-experiment.mjs --soak-seconds 180 …` (contended) | 35,241,122 bytes (33.6 MiB) | 256 MiB | yes |
| `node scripts/soak-experiment.mjs --soak-seconds 180 …` (quiet, reported) | **35,257,506 bytes (33.6 MiB)** | 256 MiB | yes — `cleanup removed /var/folders/…/nemoworld-wave7-soak-cEyvzI` |
| `node scripts/reliability-drills.mjs` | ~10 MiB across three drill directories, removed by its own suite and by `runReliabilityDrills` | — | yes |
| `node scripts/capacity-experiment.mjs --skip-browser` | its own temporary workspace, removed by the harness | — | yes |

The whole slice's experiments therefore stayed under **~36 MiB** at any one time, against a 256 MiB
ceiling, and no experiment data was left on disk. The two JSON reports quoted in this document live
under `/tmp`, outside the repository, and the repository gained no artifact.

## 8. What the system does **not** withstand, and what is untested

Read this section as the honest limit of everything above, not as a footnote.

1. **Everything here is load-sensitive, and one arm is load-fragile.** The same command on unchanged
   code moved between 58.6 and 183.9 requests/s, and breached a 5-second per-request deadline at
   concurrency 32 under a host load average above 130 while not breaching it on a quiet host. If the
   host this world runs on is shared with anything heavy, the contended figures are the ones to plan
   against, not the quiet ones.
2. **No frame-rate claim exists.** Arm 4 is unmeasured and externally owned.
3. **No real model was configured for any measurement**, so nothing here is evidence about model
   throughput, model quality, model latency or GPU behaviour. Arm 3 is the bounded queue's own
   behaviour under a stub.
4. **Loopback only.** No TLS, no proxy, no CDN, no real network latency, no packet loss, no NAT and no
   client on a slow link. Every figure is host-local.
5. **One process, one SQLite connection.** Nothing here is evidence about multiple writers, multiple
   processes or horizontal scale. `docs/handoff/task-d-capacity-recovery.md` records that the single
   writer was **refuted** as the write constraint on a fixture like this one, and this slice does not
   re-take that measurement.
6. **A full disk is answered with a generic `500 {"error":"Server error."}`.** The Platform's own
   message is actionable ("database or disk is full") but the HTTP layer replaces every unhandled error
   with a generic body, so a client cannot tell a full disk from any other internal fault. The new
   incident record makes the event visible to an operator (`route: /jobs`,
   `error_code: ERR_SQLITE_ERROR`), but the client-facing message is unchanged. Reported as a likely
   issue rather than fixed, because it is a response-contract decision.
6. **Adding a crop kind to an existing world is a hard stop.** See §9.
7. **Stored record counts are not user counts.** A 200-record or 10,001-record fixture says how a read
   behaves when the database holds rows. It does not mean 200 or 10,001 supported simultaneous players.
8. **The soak is 180 seconds.** It cannot separate a slow leak from warm-up, allocator behaviour or a
   long-period sawtooth. Nothing is extrapolated from it.
9. **Moderation, appeal and platform-pause as recovery drills are still unrehearsed**; the same gap is
   recorded in `docs/OPERATIONS.md`.
10. **The backup is plaintext.** Unencrypted off-host storage is an operator step, not a shipped
    guarantee.

## 9. Known defects found while measuring

1. **Confirmed defect — a crop kind forks the persisted schema at `user_version = 25`.** Adding a
   seventh crop changes the `CHECK` clause a fresh database is built with while the version stays 25, so
   two databases reporting the same version carry different schemas. On this base the shipped open path
   then refuses the pre-change world with `Stored world content constraints are incomplete.` and there
   is no migration to run: a release that adds a crop kind cannot be rolled out to a world that is
   already serving. Fail-closed (no data is at risk), but an upgrade trap. Owner: persistence / schema.
   Reproduce: `node --test tests/framework/known-gaps-reliability.mjs`.
2. **Confirmed defect (partly closed) — a runtime credential could publish free text to every
   administrator.** `POST /api/v1/jobs` accepts a 500-character run summary from a runtime credential,
   and the administrator payload returned it verbatim along with account names. Wave 7 closed the
   dangerous half: a token, a `salt:key` digest and a contact address written into that field are now
   scrubbed before an administrator sees them. The narrative half remains — an arbitrary marker is
   still published — and closing it needs a rule in `src/recovery.js` (off-limits here) or a payload
   shape change. Owner: operations surface. Reproduce: same file, second repro.
3. **Closed — unexpected server errors were invisible.** One structured, counted, route-named record now
   exists per unhandled failure, on the log and in `diagnostics.incidents`. Before the change an
   operator had one unstructured stderr sentence and no dashboard surface at all.

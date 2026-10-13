# Task 28 — production readiness package

Branch `task-28-production-readiness`, base `verify-batch02-wave-b` (`8d3689b`, "Merge branch
'task-20-country-venues' into verify-batch02-wave-b"). Schema **18**, unchanged. Work done 13 October
2026 in the worktree `work/t28`; every rehearsal ran on an isolated or temporary environment.

## 1. What was delivered

| File | State | What it is |
| --- | --- | --- |
| `render.yaml` | modified | the hosted deployment configuration: one web service, one persistent disk, one instance, the private setup code, the pre-deploy validation hook, shutdown delay, no auto-deploy, and the optional origin/model overrides |
| `.env.example` | new | every environment variable the code actually reads, marked required/optional with its behaviour when unset, and the local `--env-file` note |
| `docs/PRODUCTION_READINESS.md` | new | what the configuration means, the environment table, the corrections to existing documentation, the first-deployment sequence, signup/roles, administrator recovery, the resource ceilings and the capacity numbers |
| `docs/THREAT_MODEL.md` | new | authentication/sessions, runtime credentials, CSRF/origin, the research worker's SSRF protections, coin-ledger integrity, privacy, least-privilege review/moderation, and the residual-risk list including what a host or database administrator can still do |
| `docs/RELEASE_CHECKLIST.md` | new | eleven named, measurable release gates with their commands and expected results, the migration order (stop server and back up first), rollback/recovery, incident handling, and the recorded gate results |
| `scripts/capacity-experiment.mjs` | new | the capacity experiment: invokes the existing load harness and browser suite unmodified and measures the shipped model queue directly |
| `package.json` | modified | added `"capacity": "node scripts/capacity-experiment.mjs"`. No other line changed |

**No server or UI source was touched.** `server.js`, `app.js`, `src/**`, `world.js`,
`scripts/browser-suite.mjs`, `scripts/load-harness.mjs`, `scripts/e2e-smoke.mjs`, `.github/`,
`HANDOFF.md`, `docs/VERIFICATION.md` and `outputs/Lucy` are untouched. Nothing that a parallel agent owns
(`server.js`, `app.js`, `src/spaces.js`, `src/journey.js`, `scripts/browser-suite.mjs`) was edited.

Changed-file list:

```
 M package.json
 M render.yaml
?? .env.example
?? docs/PRODUCTION_READINESS.md
?? docs/RELEASE_CHECKLIST.md
?? docs/THREAT_MODEL.md
?? docs/handoff/task-28-production-readiness.md
?? scripts/capacity-experiment.mjs
```

The browser and capacity runs needed the dev dependency `playwright-core@1.64.0` (declared in
`package-lock.json`). This worktree had no `node_modules`, so it was linked to the already-installed copy
in the sibling worktree `work/t15/node_modules` for the duration of the runs. That path is gitignored
(`.gitignore:6`) and is **not** part of the patch; `npm install` (or `npm ci`) recreates it from the
lockfile.

## 2. Gates actually run, and their actual results

All on 13 October 2026, Apple M5 (`Mac17,3`), 10 logical CPUs, 16 GiB, macOS 26.6.2 (25G83), Node
v24.19.0, from `work/t28`.

| Command | Result |
| --- | --- |
| `npm run check` | **PASS** — exit 0, no output, 4.8 s |
| `npm test` | **PASS** — `tests 500`, `suites 0`, `pass 500`, `fail 0`, `cancelled 0`, `skipped 0`, `todo 0`, `duration_ms 70768` in the logged run (an earlier run of the same suite on the same machine took 130 275 ms; the machine is shared, the counts are the evidence, the milliseconds are not) |
| `npm run e2e` | **PASS** — `SUMMARY  15 steps passed, 0 failed`, `result  PASS`, temporary workspace removed |
| `node scripts/seal-content.mjs --check` | **PASS** — `Verified: 86 definitions (20 appearance, 7 block, 29 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.`, exit 0 |
| `node scripts/ops-rehearsal.mjs` | **PASS** — `7/7 drills passed`, exit 0, 9.7 s: recovery-point 834 ms, corrupt-backup 877 ms, migration-rehearsal 1350 ms, interrupted-worker 4731 ms, model-queue-saturation 556 ms, storage-limit 674 ms, diagnostics-redaction 487 ms |
| `npm run browser` (full 16-scenario suite) | **FLAKY — 14/16, then 15/16, then 16/16** in three full runs. See §5 |
| `npm run capacity` | **PASS** — exit 0, 92.9 s, all three parts; numbers in §6 |
| `git status --porcelain` before the run | only this task's own files (see §1) |

Logs are kept outside the repository, under
`work/verification/`: `task-28-check.log`, `task-28-test.log`, `task-28-e2e.log`,
`task-28-browser-run1.log` (14/16), `task-28-browser-run2.log` (15/16), `task-28-browser-run3.log`
(an excerpt of a 16/16 run — see §5), `task-28-browser-isolated.log`, `task-28-ops-rehearsal.log`,
`task-28-capacity.log`, `task-28-capacity.json`, `task-28-predeploy.log`, `task-28-admin-recovery.log`.

## 3. The deployment configuration, and what I corrected

`render.yaml` now states, in comments, the invariants the application enforces rather than trusting the
reader to guess them: exactly one instance (one Node process, one SQLite writer; Render refuses to scale
a service with an attached disk), the database on the persistent disk at `/var/data/world.sqlite`, the
public origin required before a `0.0.0.0` bind is accepted (`src/hosting.js:15-17`), and the private
`LUCY_SETUP_CODE` required before a public server with an empty database will start (`server.js:325`).

Corrections made, all inside files this task owns:

1. **`plan: starter` → `plan: 1c-2g`.** `starter` is a legacy Render instance name that no longer
   appears in Render's published plan list; the Blueprint now names an explicit current compute id and
   keeps the price-review warning. If an existing service must not be resized, delete the `plan` line:
   Render retains an existing service's plan when the field is omitted.
2. **`autoDeployTrigger: 'off'` added.** Render's `autoDeploy` field is deprecated in favour of
   `autoDeployTrigger`; turning auto-deploy off is what makes a release checklist meaningful. Set it to
   `checksPass` only once the gates run in CI for that branch.
3. **`preDeployCommand` added** — `sh -c 'if [ -f /var/data/world.sqlite ]; then node scripts/recovery.js
   verify /var/data/world.sqlite; fi'` — so a corrupt, foreign or newer-schema database fails the release
   **before** it serves traffic, while a first deploy with no database is not blocked. It takes no lock
   and writes nothing, so it is safe while the previous instance drains.
4. **`maxShutdownDelaySeconds: 60` added** so a `SIGTERM` has room to end event streams, abort worker
   runs and release the lock (`server.js:670-678`) before the host escalates to `SIGKILL`.
5. **Stale/again-true comments replaced**, and the optional `LUCY_PUBLIC_ORIGIN` and `LUCY_MODEL_*`
   entries added commented-out with `sync: false` so a custom domain or model can be added without
   editing the file's structure.
6. **`.env.example` created**, because the repository had no environment template at all and
   `docs/DEPLOYMENT.md`'s table omits `LUCY_MODEL_URL`, `LUCY_MODEL_BACKEND`, `LUCY_MODEL_KEY` and
   `LUCY_LOCAL_PORT_FALLBACK`, all of which the code reads. There is deliberately **no** `LUCY_BACKUP_DIR`:
   backups always live in `backups/` beside the database (`server.js:668`).

**Documentation that is now stale and that I could not correct**, because those files belong to other
owners (exact recommended text is in `docs/PRODUCTION_READINESS.md` §4):

- `docs/DEPLOYMENT.md:5` and `README.md:94` still call the instance the "paid Starter instance"; the
  Blueprint now selects `1c-2g`.
- `docs/DEPLOYMENT.md:29` lists only `LUCY_MODEL_NAME` out of the four model variables.
- `README.md:29` says "The server binds to loopback", which is only true while no public origin is set.
- `docs/DEPLOYMENT.md:39` describes the restore without mentioning that the command refuses to run while
  the server holds the process lock (`docs/OPERATIONS.md` §3 states it correctly).

Everything else in `docs/DEPLOYMENT.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/COINS.md`,
`docs/LAND_WORLD.md` and `docs/PERFORMANCE.md` that I checked still matches the code; `src/hosting.js` is
the authority and the configuration follows it exactly.

## 4. What was rehearsed, and how

| Rehearsal | Environment | Result |
| --- | --- | --- |
| The `preDeployCommand` shell logic, all three cases | `/tmp/t28-predeploy`, disposable | no database → skipped, exit 0; `printf 'not a database'` file → `file is not a database`, exit 1 (fails closed); real schema-18 database → `{"schema_version":18,"accounts":0}`, exit 0 |
| Hosting configuration behaviour (origin, bind, setup-code length, host/origin refusal) | in-process, temporary | `tests/hosting.test.js` passes as part of the 500-test suite; the rules read directly from `src/hosting.js` |
| Administrator recovery on a lost administrator password, server stopped | `/tmp/t28-admin`, disposable database | created a recovery administrator with the documented command: `verify` returned `{"schema_version":18,"accounts":2}`, `verifyAudit()` true, the new account signed in with role `admin` and reached `/operations` (`audit_valid: true`, `coin_ledger_valid: true`), and a wrong password was still refused with `401` |
| Backup / restore / corrupt-backup / storage-limit / diagnostics-redaction | `scripts/ops-rehearsal.mjs`, disposable workspace it creates and removes | 4/4 of those drills PASS |
| Migration (16 → 17 → 18 and 17 → 18) | the `migration-rehearsal` drill, disposable copy | PASS — additive migration with every record intact |
| Interrupted worker classification and explicit resume | the `interrupted-worker` drill, two `SIGKILL`s of a child process | PASS |
| HTTP capacity, browser clients, model-queue bound | `npm run capacity`, isolated temporary databases | see §6 |

Nothing was rehearsed against the installed world. `outputs/Lucy` does not exist in this worktree and
`data/world.sqlite` does not exist either; the capacity experiment recorded both as absent before and
after and would have failed if they had changed.

## 5. The browser acceptance gate is flaky on this base (evidence, not a conclusion I can fix here)

Three full 16-scenario runs, same machine, same commit, no source change between them:

| Run | Result | Failing scenario(s) and what the page log shows |
| --- | --- | --- |
| 1 | 14 passed, 2 failed | `plot-and-blueprints` — "the plot must offer room beside the resident for the previewed footprint"; the resident never reached `plot:0:0:0:0` (it stayed at 24,9) and the page log records `429 POST /api/v1/move`, i.e. the server's 120 ms movement throttle (`src/spaces.js:171`). `quest-progression` — "the board must advance to the next authored step". |
| 2 | 15 passed, 1 failed | `subscription-entitlement-and-revocation` — "timed out waiting for the visitor to hold a live subscription again"; the page log records `403 GET /api/v1/events?world_id=home%3A<id>` on the fresh subscribe. Here `plot-and-blueprints` (15.8 s) and `quest-progression` (22.2 s) both **passed**. |
| 3 (a full suite that ran inside an earlier invocation of the capacity script; only the console lines were captured, see the log) | 16 passed, 0 failed | complete suite in 95.3 s |
| Isolated re-run (`LUCY_BROWSER_ONLY=accounts-and-switching,plot-and-blueprints,quest-progression`) | 3 passed, 0 failed | both run-1 failures passed when run in a short selection |

So the failures are order/timing dependent (a walk that must land before a click; a subscribe that races
a visibility change), not a fixed defect, and **not caused by this task**: the diff touches no server,
UI or suite file. It is recorded here as a release-blocking flake for the browser-suite owner, and the
release checklist tells the operator to require 16/16 and re-run rather than to reason about which
failure is "the real one". The capacity experiment therefore uses a documented, order-independent
scenario subset for its timing measurements and never hides a suite failure.

## 6. Capacity: what was actually measured

`npm run capacity` — whole experiment 92.9 s, exit 0. It invokes `scripts/load-harness.mjs` and
`scripts/browser-suite.mjs` **unmodified** (as child processes), each on its own isolated temporary
database, and measures the shipped model queue in-process. Runnable JSON: `--json <path>`.

**Hardware:** Apple M5 (`Mac17,3`), 10 logical CPUs, 16 GiB memory, macOS 26.6.2, Node v24.19.0; one HTTP
process, one SQLite connection in WAL mode, loopback only.

**Fixture (created by the existing harness):** 10,001 stored agents stacked in the Commons with one home
each, 2,000 stored visits, 2,000 stored claims, schema 18. **Stored records, not users.**

**HTTP capacity** — read-only GET mix (crowded viewport, garden directory, resident passport,
contribution history, health), 200 requests per level, 0 % failure budget, 5 s per-request deadline:

| Clients | Attempts | ok | HTTP errors | timeouts | Throughput | p50 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 200 | 200 | 0 | 0 | 59.59 req/s | 10.42 ms | 38.63 ms | 43.99 ms | 58.56 ms | 67.71 ms |
| 8 | 200 | 200 | 0 | 0 | 52.87 req/s | 133.58 ms | 245.78 ms | 287.14 ms | 389.42 ms | 479.59 ms |
| 32 | 200 | 200 | 0 | 0 | 62.25 req/s | 239.02 ms | 824.10 ms | 3032.47 ms | 3129.31 ms | 3211.91 ms |

Payload: median 31,215 B, largest 249,740 B (the crowded viewport). No level breached the failure budget
(`ceiling: no failure-budget breach up to concurrency 32`). The heaviest single read is the crowded
viewport (median 249,740 B, p95 3.0 s at 32 clients); the cheapest is `/health` (162 B). An earlier
invocation of the same command on the same machine measured 57.55 / 47.80 / 43.65 req/s, so treat the
figures as a band, not a constant.

**Browser clients** — real Chrome, real interface, real records; the default subset is
`accounts-and-switching`, `country-ambassadors`, `first-person-controls`, `shared-presence-two-clients`:

| Concurrent suites (isolated installations) | Browser pages | Wall clock | Scenarios | Result |
| --- | --- | --- | --- | --- |
| 1 | ≤ 2 | 30.6 s | 4 | 4 passed, 0 failed (0.85–10.3 s per scenario) |
| 2 | ≤ 4 | 39.4 s | 8 | 4 + 4 passed, 0 failed (0.68–11.8 s per scenario) |

The two-browser presence scenario (`shared-presence-two-clients`, two real clients watching each other
move and build over the event channel) took 10.1–10.3 s in each suite at both levels. This measures the
cost of real client work per installation. **It does not establish a maximum number of browser clients**
— the suite has no knob to raise clients against one server, and the experiment reports that limitation
in its own output rather than extrapolating.

**Model-queue capacity, kept strictly separate from HTTP** — the shipped `boundedModel` with a stub
inference of 50 ms and `maxWaiting` 8, driven by 12 simultaneous requests:

- **9 admitted, 3 refused as saturated, 0 failures, peak waiting 8 of 8, peak active 1.**
- Queue wait before inference: p50 201.8 ms, p95 402.5 ms, max 402.5 ms (the stub's own 50 ms excluded).
- Serialized throughput 19.9 inferences/s at that stub latency — i.e. one inference at a time, with the
  bounds holding exactly as implemented.
- The shipped server's own drill (`scripts/ops-rehearsal.mjs --drill model-queue-saturation`, unmodified)
  PASSed in 604 ms: the server reports `inferring_with_queue`, the refused conversation degrades to the
  published rules with `model_fallback: true` instead of hanging, and the refusal is counted.
- The harness's own `/health` reading: `model_configured: false`, `model_queue: null`,
  `research_workers: {"active":0,"limit":4}`, `resident_workers: {"active":0,"limit":1}`.
- **No real model was configured, called or downloaded, and no model weights were touched.** These are
  the queue policy's numbers, not model throughput; the real model-queue ceiling on a deployed service is
  unknown until a model is provisioned and measured, and with no model configured a resident run is
  refused outright (`409`).

**Explicit statement:** these are not production capacity guarantees and no supported-user count is
implied. The experiment measured this hardware, this fixture, this concurrency and this workload. It ran
no writes, no soak test, no memory-growth or disk-exhaustion measurement, no TLS, no proxy, no real
network latency, no multiple writers, and no hostile input.

## 7. Migration and rollback notes

- **This release changes no schema.** Schema stays **18**; `src/database.js:18` refuses anything above 18,
  and `src/recovery.js:270-271` accepts 1–18 and re-checks each version's invariants. Task 27 and Task 28
  add diagnostics, drills, configuration and documentation only.
- **Order when a future release raises the version:** stop the server → back up (`node
  scripts/recovery.js backup <db> <backups>/pre-migration-<stamp>.sqlite`) → verify the backup
  (`node scripts/recovery.js verify <backup>`) → rehearse on a disposable copy
  (`node scripts/ops-rehearsal.mjs --drill migration-rehearsal`) → deploy/start (the migration runs in one
  `BEGIN IMMEDIATE … COMMIT`) → verify the migrated database reports 18 with the same account count → check
  Administration's health panel for `database check · ok`, `audit_chain_valid` and `coin_ledger_valid`.
- **Historic order:** 14 → 15 (country ambassadors), 15 → 16 (resident runs), 16 → 17 (quest chains),
  17 → 18 (guild projects). A world at 13 or below passes through the same sequence in one startup
  transaction. Growth is one-way: this build cannot read a schema newer than 18, so rolling the code
  back after a migration also means restoring the pre-migration backup.
- **Rollback levels:** (A) redeploy the previous commit — safe here because no schema changed;
  (B) `node scripts/recovery.js restore <verified backup> <database>` with the server stopped (the
  original database and its `-wal`/`-shm` are copied aside automatically; an invalid backup is refused
  **before** anything on disk is touched); (C) provider-level disk snapshot or a fresh disk plus the newest
  verified backup, then re-point `LUCY_DATABASE` and the origin.
- **Recovery point:** everything committed before the backup began. **RTO:** stop, restore, start — the
  atomic rename is a file operation, dominated by validating the backup. A rollback cannot recover writes
  committed after the backup, an in-flight model decision, or an action dispatched whose confirmation was
  never recorded (inspect the world before resuming).
- **Administrator recovery** (rehearsed): the setup code is only consulted while the database has no
  account; a lost sole-administrator password needs the documented, host-level account insert in
  `docs/PRODUCTION_READINESS.md` §9, which keeps the audit chain valid and was verified end to end.

## 8. Residual risks and what was **not** rehearsed

Residual risks (the full list is `docs/THREAT_MODEL.md` §10):

- **A host or database administrator can still do everything the application cannot prevent**: read every
  private world, conversation, journal and evidence row; read credential *hashes*; delete or rewrite rows
  with external tools, including the whole audit chain and coin ledger; read the setup code from the
  environment while it is still needed; read, copy or withhold backups; edit the source. The hash chains
  prove rows were not edited *through the application*; they are not tamper-proof against the machine's
  operator.
- A stolen or shared session is a valid session; rate limits are per process and per peer, shared behind a
  hosting proxy; there is no CSRF token (the origin/host rule plus `SameSite=Strict` is the control);
  two colluding human reviewers can mint real coins within the daily cap; duplicate detection is textual,
  not semantic; model output can be wrong and is never itself authoritative; acceptance proves a human
  reviewer accepted the work, not that it is true or adopted.
- Availability is one process and one writer; model work beyond the queue bound is refused rather than
  queued. **No system is unhackable, and no part of this package claims otherwise.**

Not rehearsed, and therefore not claimed:

- **No hosting, domain, disk or paid service was purchased, provisioned, reserved or configured**, and
  nothing was deployed or published. No provider API was called; the Blueprint was never applied, so its
  acceptance by Render is unverified (its fields follow Render's published specification).
- No provider-side rate limiter, WAF, firewall, autoscaling or multi-instance topology exists or was
  tested; the in-process limits are shared by one instance.
- No production traffic, hostile-input test, penetration test, third-party audit or certification.
- No real model inference, no model weights downloaded, no model throughput measured.
- No TLS, reverse proxy, real network latency, packet loss, soak test, memory-growth or disk-exhaustion
  measurement; no write-heavy load (every harness request is a GET).
- No disaster-recovery exercise against a real host, and no restore-to-a-new-host drill.
- The deployment's `healthCheckPath`, `preDeployCommand` and shutdown behaviour have been reasoned from
  the code and rehearsed locally, but never exercised by Render itself.
- The browser gate is flaky (§5) and remains an open defect on this base.

## 9. Purchases, provisioning and publication

**Nothing was purchased, provisioned, published or sent.** No hosting account, plan, instance, disk or
domain was created or reserved; no paid service was enabled; no payment method was used; no public URL
was created for this build; the real installation was never exposed; no external party was contacted; and
no database, backup, `.env`, token or setup code was published, attached or committed. Every measurement
and drill ran on an isolated or temporary workspace with its own database.

## 10. Follow-ups for whoever integrates this

1. **Fix or explain the browser flake** (owner: browser-suite/task-15/16). `plot-and-blueprints` and
   `quest-progression` fail only in long sequential runs, and `subscription-entitlement-and-revocation`
   failed once on a re-subscribe race. The gate is 16/16 or it is not green.
2. **Update the four documentation lines listed in §3** (`docs/DEPLOYMENT.md:5`, `:29`, `:39`,
   `README.md:29`, `:94`) now that the Blueprint selects `1c-2g`. They live in files this task does not own.
3. **Decide the instance plan and the signup policy at deployment time.** `render.yaml` states a plan
   deliberately; the operator must review Render's current price. Public member signup is open by default
   after the first administrator and can be closed in Administration.
4. **Add a provider-side rate limiter or WAF before opening public enrollment broadly.** The built-in
   limiter is per process; behind a proxy every browser can share one peer identity
   (`docs/DEPLOYMENT.md:45`).
5. **Consider adding `scripts/capacity-experiment.mjs` to the `check` syntax gate.** It is in the runtime
   `capacity` script only, because this task's ownership allowed `package.json` to gain the `capacity`
   script and nothing else.
6. **Re-run the capacity experiment on the host you actually deploy to** before quoting any number to
   anyone. This machine's numbers do not transfer.

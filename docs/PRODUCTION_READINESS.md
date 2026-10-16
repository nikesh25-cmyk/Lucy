# NemoWorld production readiness

Task 28 — production readiness package. Branch `task-28-production-readiness`, base
`verify-batch02-wave-b` (`8d3689b`), schema **18**. This is the artifact-and-configuration slice: the
deployment configuration, the threat model, the release checklist and a bounded capacity experiment.
**No server or UI source was modified** by this work.

Companion documents: [threat model](THREAT_MODEL.md) · [release checklist](RELEASE_CHECKLIST.md) ·
[operations runbook](OPERATIONS.md) · [deployment guide](DEPLOYMENT.md) ·
[performance and measured capacity](PERFORMANCE.md).

## 1. What was done, and what was not

| Done | Not done |
| --- | --- |
| A concrete hosted configuration (`render.yaml`) grounded in `src/hosting.js` and the code, with every invariant stated and the stale parts corrected | **No hosting account, plan, disk, domain or TLS certificate was purchased, provisioned or reserved** |
| A complete environment template (`.env.example`) covering every variable the code actually reads, marked required/optional with its behaviour when unset | **Nothing was published, deployed or exposed.** No public URL exists for this build, and no real installation was touched |
| A threat model with `file:line` references and an explicit residual-risk list | No penetration test, audit, certification or third-party security review |
| A release checklist with named, measurable gates, the migration order, rollback and incident handling | No provider-side rate limiter, WAF, autoscaling or multi-instance topology was configured or tested |
| A capacity experiment (`npm run capacity`) that invokes the existing load harness and browser suite unmodified, on isolated temporary databases | No production traffic, soak test, hostile-input test or disaster-recovery exercise; no model weights were downloaded and **no real model inference was run** |
| Local rehearsals: configuration behaviour, the deployment hook, administrator recovery, the failure drills | No external party was contacted, and nothing about this package is an offer, endorsement or pilot |

Everything in every rehearsal ran on a disposable temporary workspace with its own database, its own
server process and its own backups. `data/`, any installed `data/world.sqlite`, `outputs/Lucy`, backups
and model weights were never opened for writing (the capacity experiment records their before/after
state and fails if it changed).

## 2. The hosted configuration

`render.yaml` describes **one** Render web service with **one** persistent disk. It is a configuration
file: applying it is a deliberate operator action in a Render account, and Render's current price must
be reviewed before approving it.

| Property | Value | Why |
| --- | --- | --- |
| `type` / `runtime` | `web` / `node` | one HTTP process serving `/api/v1` and the static interface |
| `plan` | `1c-2g` | explicit 1-CPU, 2-GB paid pilot baseline; review the current price and any change to an existing service before Blueprint sync |
| `numInstances` | `1` | the world is one process over one SQLite file in WAL mode. Render also refuses to scale a service that has an attached disk |
| `autoDeployTrigger` | `off` | a merge does not deploy by itself; releases follow `docs/RELEASE_CHECKLIST.md`. Change to `checksPass` only once the gates run in CI for that branch |
| `buildCommand` | `npm run check` | the syntax gate as the build. The application has **no runtime dependencies**, so no `npm install` is needed to serve it |
| `startCommand` | `npm start` (`node server.js`) | the shipped entry point |
| `healthCheckPath` | `/api/v1/health` | the shipped aggregate health endpoint (`server.js:411-414`), reachable by the provider through the public origin |
| `maxShutdownDelaySeconds` | `60` | the process ends event streams, aborts worker runs and releases its lock on `SIGTERM` (`server.js:670-678`); 60 s leaves room before the host escalates to `SIGKILL` |
| Runtime integrity gate | `server.js` after acquiring `server.lock`, before `new Platform()` or listening | Existing databases are validated before migration/seeding. Missing databases follow first-start setup. Render build/pre-deploy compute cannot access persistent disks; see [Render disk documentation](https://render.com/docs/disks). |
| `disk` | `shared-world-data`, `/var/data`, 1 GB | the database, its WAL and `backups/` must survive restarts and deploys. Size is a ceiling, not a quota |
| `envVars` | see §3 | `NODE_VERSION`, `LUCY_BIND_HOST`, `LUCY_DATABASE`, `LUCY_INITIAL_REGISTRATION=closed`, generated `LUCY_SETUP_CODE`, plus commented optional overrides |

Render supplies `PORT` and `RENDER_EXTERNAL_URL`. The server accepts `RENDER_EXTERNAL_URL` as its
canonical HTTPS origin when `LUCY_PUBLIC_ORIGIN` is unset (`src/hosting.js:6`), which is why the
Blueprint does not set an origin by default. With the origin established, the server sets
`Secure` cookies and HSTS, enforces the exact `Host` and `Origin`, and binds `0.0.0.0`
(`src/hosting.js:15`, `server.js:111`, `server.js:150`).

## 3. Environment variables

`npm start` runs `node server.js` and does **not** read a `.env` file by itself. Locally, use
`node --env-file=.env server.js` or export the values; on a host, set them in the service's environment
settings. `.env.example` is the template and contains only placeholders.

| Variable | Required | Behaviour when unset | Read at |
| --- | --- | --- | --- |
| `LUCY_PUBLIC_ORIGIN` | required for a public deployment, unless the host supplies `RENDER_EXTERNAL_URL` | no public origin: the server binds loopback and accepts only loopback `Host` headers | `src/hosting.js:6-14` |
| `RENDER_EXTERNAL_URL` | supplied by Render | — | `src/hosting.js:6` |
| `LUCY_BIND_HOST` | optional | `0.0.0.0` when an origin is set, otherwise `127.0.0.1`. Binding `0.0.0.0` **without** an origin throws and refuses to start | `src/hosting.js:15-17` |
| `PORT` | optional | `3000` locally; hosts usually inject it | `server.js:679` |
| `LUCY_DATABASE` | optional | `data/world.sqlite` beside the source | `server.js:665` |
| `LUCY_INITIAL_REGISTRATION` | optional | `open`; only a new database uses this default, while the Render pilot sets `closed` | `src/database.js` |
| `LUCY_SETUP_CODE` | required once, before the first public start of an empty database | a public server over an empty database **refuses to start**; 24–256 characters | `src/hosting.js:18-20`, `server.js:325`, `src/platform.js:107-109` |
| `LUCY_MODEL_NAME` | optional | no model configured: resident runs are refused with `409`, country conversations answer from published rules with `mode: "rules"` | `server.js:318`, `:541`, `:642` |
| `LUCY_MODEL_URL` | optional | `http://127.0.0.1:11434`; must be loopback HTTP | `runtime/model.js:39-45` |
| `LUCY_MODEL_BACKEND` | optional | `ollama`; `llama.cpp` selects the llama.cpp adapter | `runtime/model.js:86-88` |
| `LUCY_MODEL_KEY` | optional | no key sent to a llama.cpp server | `runtime/model.js:87` |
| `LUCY_LOCAL_PORT_FALLBACK` | optional | unset: a busy port is a fatal error, as it must be for a public service | `server.js:681` |
| `WORLD_URL`, `WORLD_AGENT_TOKEN`, `WORLD_TASK_ID`, `WORLD_SOURCE_URLS` | optional | used only by `npm run agent` / `npm run research` outside the server | `runtime/agent.js:500`, `:677`, `runtime/research-worker.js:188` |
| `LUCY_BROWSER_KEEP`, `LUCY_BROWSER_ONLY`, `LUCY_BROWSER_CHANNEL`, `LUCY_CHROME_PATH`, `LUCY_E2E_KEEP`, `LUCY_LOAD_KEEP` | test only | — | `scripts/browser-suite.mjs`, `scripts/e2e-smoke.mjs`, `scripts/load-harness.mjs` |

**There is no `LUCY_BACKUP_DIR`**: backups are always written to `backups/` beside the database
(`server.js:668`), which is `/var/data/backups` on the Blueprint.

## 4. Corrections to existing configuration and documentation

Corrected here (files this task owns):

1. **`render.yaml` — `plan: starter` → `plan: 1c-2g`.** `starter` is a legacy Render instance name that
   no longer appears in Render's published plan list; the current form is an explicit compute id. The
   Blueprint now states the plan deliberately, with the price-review warning kept. If an account already
   runs a Starter instance and you do **not** want to resize it, delete the `plan` line instead: Render
   retains an existing service's plan when the field is omitted. `docs/DEPLOYMENT.md` and `README.md`
   now state the selected pilot plan and the required price review.
2. **`render.yaml` — added `autoDeployTrigger: 'off'`.** Render's `autoDeploy` field is deprecated in
   favour of `autoDeployTrigger`. Disabling auto-deploy is what makes the release checklist meaningful.
3. **`render.yaml` — added `maxShutdownDelaySeconds`, comments and the optional
   `LUCY_PUBLIC_ORIGIN` / `LUCY_MODEL_*` entries.** The previous file contained no explanation of the
   single-instance and disk invariants. Integration moved integrity validation into `server.js` at runtime: a pre-deploy command cannot see the persistent disk.
4. **`render.yaml` — corrected the start-up comment.** The old comment implied the disk alone implies a
   paid instance; the file now states what the code enforces (origin required for a public bind, private
   setup code required for an empty public database, one instance because one process owns the writer).
5. **`.env.example` (new)** — the repository had no environment template. `docs/DEPLOYMENT.md`'s table
   omits `LUCY_MODEL_URL`, `LUCY_MODEL_BACKEND`, `LUCY_MODEL_KEY` and `LUCY_LOCAL_PORT_FALLBACK`, all of
   which the code reads; the template lists every variable, its required/optional status and its unset
   behaviour.
6. **`package.json`** — added `npm run capacity`. No other script was changed.
7. **Still stale, in files this task does not own.** These need a one-line edit by their owner:
   - `docs/DEPLOYMENT.md:5` — “The Blueprint selects the **paid Starter instance and a 1 GB persistent
     disk**”. Recommended: “The Blueprint selects a paid instance (`1c-2g`) and a 1 GB persistent disk”.
   - `docs/DEPLOYMENT.md:29` — `LUCY_MODEL_NAME` is the only model variable listed; add
     `LUCY_MODEL_URL`, `LUCY_MODEL_BACKEND` and `LUCY_MODEL_KEY`, and note that a non-loopback endpoint
     is refused.
   - `README.md:94` — “The configured Starter instance and disk are paid services.” Recommended:
     “The configured `1c-2g` instance and disk are paid services.”
   - `README.md:29` — “The server binds to loopback.” That is true only while no public origin is
     configured; with `LUCY_BIND_HOST=0.0.0.0` and an origin it binds all interfaces (and refuses
     `0.0.0.0` without an origin).
   - `docs/DEPLOYMENT.md:39` — the restore instructions do not mention that the command takes the
     process lock and therefore refuses to run while the server is up. `docs/OPERATIONS.md` §3 states
     this correctly.

Nothing in the application source needed correcting for this task: `src/hosting.js` is the authority,
and its behaviour matches what §2 and §3 describe.

## 5. First deployment sequence (configuration only — nothing here was executed against a provider)

1. Review `render.yaml`, confirm the plan, the region and the disk size, and check Render's current
   price for them. **This step is the operator's decision and their cost.**
2. Confirm the service uses one instance. Do not add replicas, and do not mount the same database from
   two machines.
3. Deploy the Blueprint. First start: no database exists, runtime validation is skipped, the
   service migrates an empty file to schema 18 and becomes healthy on `/api/v1/health`.
4. Confirm the service starts at all. If it fails with `Set the private LUCY_SETUP_CODE before starting a
   public server with no administrator.`, the generated value is missing — set it with `sync: false`. If
   it fails with `LUCY_SETUP_CODE must contain 24–256 characters.`, the generated value is too short.
5. Reveal the generated `LUCY_SETUP_CODE` in the dashboard, privately. Create the first administrator,
   using your own email and a password of at least 12 characters. Then treat the code as spent and keep
   it out of chat, screenshots, logs and tickets; it is only consulted while the database has no account.
6. Decide the signup policy (open by default after the first administrator; Administration can close it)
   and issue invitations for reviewer or moderator access rather than widening public signup.
7. Confirm the exposed surface: `/api/v1/health` public with aggregate counters only, `/api/v1/bootstrap`
   without the setup code, `/api/v1/operations` refused to anyone but an administrator.
8. Create the first backup from Administration, then download or copy an encrypted archive to storage
   you control. A backup that has never been restored is a guess.
9. Record the release: commit, gate results, the backup filename and the recovery point.
10. Apply a custom domain only if you own one: set its TLS certificate, then set `LUCY_PUBLIC_ORIGIN` to
    the exact HTTPS origin. A different host or port is rejected by design.

## 6. Signup policy, roles and least privilege

- **Public signup** creates a `member` and is open by default once an administrator exists; an
  administrator can close it (`src/platform.js:126-138`). An invitation carries `member`, `reviewer` or
  `moderator` and expires after seven days (`src/platform.js:199-204`). **No invitation and no request
  field can grant `admin`.**
- **Roles**: `member` (own characters and worlds), `reviewer` (mission review and — with an independent
  record — coin issuance), `moderator` (quarantine, suspend, appeals), `admin` (roles, invitations,
  pause, backup, diagnostics). A single `role()` check guards each route (`src/platform.js:31`), and the
  checks are listed in the threat model §9.
- **Independence is structural**: no self-review, no self-award, a different uninvolved human for an
  appeal, a *different operator* for guild verification (`src/platform.js:443`, `src/coins.js:40`,
  `src/platform.js:570`, `src/guilds.js:132`).
- **The smallest real deployment** is one administrator, one member, one reviewer: reviewer access is
  what lets a real contribution be accepted and rewarded. A moderator is needed only to resolve reports.
  A single person holding every role defeats the independence rules even though the code permits it.

## 7. Capacity: what was measured, and what it means

`npm run capacity` (`scripts/capacity-experiment.mjs`) invokes the **existing, unmodified**
`scripts/load-harness.mjs` and `scripts/browser-suite.mjs`, each on its own isolated temporary database,
and measures the shipped model queue directly. The full report and the exact console output are in
`docs/handoff/task-28-production-readiness.md`; the raw JSON is written wherever `--json <path>` asks.

**This is not a production capacity guarantee.** It measures one machine, one fixture, one workload and
bounded concurrency, and it starts no paid work and no real model inference.

**Run 13 October 2026** — Apple M5 (`Mac17,3`), 10 logical CPUs, 16 GiB, macOS 26.6.2, Node v24.19.0;
one HTTP process, one SQLite connection in WAL mode, loopback only; base `8d3689b`. Whole experiment
92.9 s. Fixture (created by the existing harness): 10,001 stored agents stacked in the Commons with one
home each, 2,000 stored visits, 2,000 stored claims — **stored records, not users**.

HTTP capacity (`scripts/load-harness.mjs`, read-only GET mix, 200 requests per level, 0 % failure budget,
5 s per-request deadline):

| Clients | Attempts | ok | errors | timeouts | Throughput | p50 | p90 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 200 | 200 | 0 | 0 | 59.59 req/s | 10.42 ms | 38.63 ms | 43.99 ms | 58.56 ms | 67.71 ms |
| 8 | 200 | 200 | 0 | 0 | 52.87 req/s | 133.58 ms | 245.78 ms | 287.14 ms | 389.42 ms | 479.59 ms |
| 32 | 200 | 200 | 0 | 0 | 62.25 req/s | 239.02 ms | 824.10 ms | 3032.47 ms | 3129.31 ms | 3211.91 ms |

(Nearest-rank percentiles over 200 successful responses per level, as the harness computes them.)

Payload: median 31,215 B per response; largest 249,740 B (the crowded viewport the browser polls every
few seconds). Every level completed its full request count inside the zero-failure budget, and no level
breached it up to concurrency 32. **Read the shape, not the decimals:** completion stayed in the
50–62 requests/second band across all three levels while p95 latency rose from 44 ms to 3.0 s, so past
roughly eight simultaneous readers this configuration trades latency for throughput it does not gain —
the binding constraint is the single Node process and the single SQLite writer, not the client count.
Run-to-run variance is real: an earlier invocation of the same command on the same machine measured
57.55 / 47.80 / 43.65 req/s.

**Re-measured 14 October 2026** at commit `7eb03e08d6d8` — same machine, same unmodified
`scripts/load-harness.mjs` and the same 10,001-agent fixture, load average 1.78 / 3.07: reads measured
**50.78 / 51.82 / 53.02 req/s** at 1 / 8 / 32 clients with p95 60.77 / 274.93 / **3,583.25** ms. The
shape is identical and the difference from the table above is the machine's background load, not the
code: nothing in the read path changed between the two runs. That re-run also added the writes and
event-subscriber measurements (**3,645.28 saves/s at p95 3.9 ms**; 8 held SSE subscriptions), which
the table above does not contain. **`docs/PERFORMANCE.md` is the current measured record**; this
section is the Task-28 run it supersedes, kept because the experiment command and the browser-client
cost table below are still the ones this package ships. Neither run establishes a number of supported
simultaneous users, and neither measured hostile traffic.

Browser clients (`scripts/browser-suite.mjs`, real Chrome, real interface, real records, each suite on
its own temporary database; default scenario subset `accounts-and-switching`, `country-ambassadors`,
`first-person-controls`, `shared-presence-two-clients`):

| Concurrent suites | Browser pages | Wall clock | Scenarios | Result |
| --- | --- | --- | --- | --- |
| 1 | ≤ 2 | 30.6 s | 4 | all passed (per-scenario 0.85–10.3 s) |
| 2 | ≤ 4 | 39.4 s | 8 | all passed (per-scenario 0.68–11.8 s) |

The `shared-presence-two-clients` scenario holds two real browsers on one server over the SSE channel
and took 10.1–10.3 s in every suite. This measures the cost of real client work per isolated
installation. **It does not establish a maximum number of browser clients**: the suite has no knob to
raise clients against one server, and doubling the suites roughly doubled the total browser-page cost
inside a 39 s wall clock on 10 cores.

Model-queue capacity (shipped `boundedModel`, stub inference of 50 ms, `maxWaiting` 8, 12 simultaneous
requests): **9 admitted, 3 refused as saturated, 0 failures, peak waiting 8 of 8, peak active 1.** Queue
wait before inference p50 201.8 ms, p95 402.5 ms; serialized throughput 19.9 inferences/s at a 50 ms stub
latency. The bound held exactly as implemented. The shipped server's own drill (`scripts/ops-rehearsal.mjs
--drill model-queue-saturation`) passed in 604 ms, and the harness's own `/health` reading confirms
`model_configured: false`, `model_queue: null`, `research_workers.limit: 4`, `resident_workers.limit: 1`.
**No real model was configured or called**, so this is the queue policy, not model throughput: with no
model configured a resident run is refused with `409`, and the real model-queue ceiling on a deployed
service is unknown until a model is provisioned and measured.

Isolation: every measurement ran in its own temporary workspace and database, and the experiment
re-checked and reported that no installed world existed or changed (`data/world.sqlite absent`,
`outputs/Lucy absent`).

The three questions stay separate on purpose:

| Question | Instrument | What it can support |
| --- | --- | --- |
| HTTP capacity | `scripts/load-harness.mjs`, read-only GET workload, bounded clients | requests/second and latency percentiles for this fixture on this machine, and where failures begin |
| Browser-client cost | `scripts/browser-suite.mjs`, real Chrome, real interface, up to two pages per suite | wall-clock cost of real client work per isolated installation. It does **not** establish a maximum number of browser clients: the suite has no knob to raise clients against one server |
| Model-queue capacity | the shipped `boundedModel` with a stub inference, plus the shipped server's own drill | the queue's admission bound, refusal behaviour and serialized rate at a stated stub latency. It is **not** model throughput, and no real model was configured or called |

## 8. Resource ceilings

Every limit below is enforced in the shipped code and can be changed only by changing the code — none is
a provider setting.

| Area | Ceiling | Where |
| --- | --- | --- |
| Instances / writers | 1 process, 1 SQLite connection in WAL mode, 5 s busy timeout | `render.yaml`; `src/database.js:19` |
| HTTP request | 15 s request timeout, 10 s header timeout, JSON body ≤ 64 KiB, 15 s body deadline | `server.js:656-657`, `:122-139` |
| Authentication | 300 attempts/minute process-wide; 120/minute per peer (15 loopback); 8 concurrent; 15/minute per email identity; 10,000 tracked windows | `src/hosting.js:45-73` |
| Sessions | 7 days, revoked on logout/suspension/deletion | `src/platform.js:151-154`, `:679`, `:714` |
| Runtime credentials | 1–20 minutes, 1–500 calls, one active per operator, 5 scopes, revoked at run end | `src/platform.js:260-268` |
| Research worker | 4 concurrent runs per process (`researchConcurrency`, 1–8), 4 minutes, 20 calls, 1–5 approved URLs | `server.js:319`, `:591`, `:587` |
| Resident worker | 1 concurrent run per process; 1–20 minutes and 1–20 model decisions per run | `server.js:368`, `:550` |
| Model queue | one inference at a time; `maxWaiting` 8 by default (0–20); work beyond the bound is refused, never queued without limit | `runtime/model.js:4-37`, `server.js:322` |
| Event channel | 64 subscriptions per process, 4 per account, 256 pending updates, 64 KiB pending, 20 frames/s, 15 s heartbeat, 1 s re-validation | `server.js:172-180` |
| Movement / interaction | 120 ms between steps and looks, 5 s between expressions, 1.5 s between messages | `src/spaces.js:171`, `:193`, `src/platform.js:236`, `:286` |
| Reads | 200 avatars, 20 × 14 terrain, 200 messages, 50 + 30 directory page, 24 guild projects, 200 history/visits, 500 export rows | `src/spaces.js`, `src/platform.js`, `src/journey.js`, `src/guilds.js` |
| Land | one stewardship per account, 4 assignments/day, 1.5 s between stewardship actions, 8 new areas/day and 500 frontier actions/day per operator, 2,048 blocks per area, 6-cell build distance | `docs/LAND_WORLD.md:32,45` |
| Coins | 10 per acceptance, 100 per operator per UTC day, one receipt per task, append-only | `src/coins.js:2-14` |
| Storage | 1 GB disk on the Blueprint; backups live beside the database; a full disk fails the write closed | `render.yaml`, `docs/OPERATIONS.md` §7 |
| Reports / submissions | 10 reports/day per reporter, 10 submissions/day per operator, one active claim per operator | `src/platform.js:516`, `:413`, `:384` |

## 9. Administrator recovery

Rehearsed on a disposable database (`/tmp`, never an installed one) and reproduced verbatim here.

**A. The setup code is lost, and the database is still empty.** No data exists, so nothing is at stake:
set a new value (`sync: false` in the Blueprint, or a new generated value), restart, and create the
administrator. Once any account exists, `LUCY_SETUP_CODE` is not consulted again
(`src/platform.js:107`), so a rotated or lost code cannot lock you out of a live world — and also cannot
let a stranger in.

**B. The only administrator's password is lost, or the account is suspended.** There is no
password-reset route and no role escalation through the API by design (`invite` cannot grant `admin`,
`accountControl` refuses self-changes). Recovery is therefore a deliberate, host-level operation. Stop
the server first, work on a copy if you can, and keep a record. This exact command was rehearsed:
creating a recovery administrator produced `schema_version: 18, accounts: 2`, the audit chain still
verified, and the new account signed in with role `admin` and reached `/operations`:

```sh
# Server stopped. Replace <database>, <email> and <password 12+>. Admin access to the host is required.
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, scryptSync, createHash } from "node:crypto";
const [database, email, password] = process.argv.slice(1);
if (!database || !email || password.length < 12) throw new Error("usage: <database> <email> <password 12+>");
const now = new Date().toISOString();
const salt = randomBytes(16).toString("hex");
const digest = salt + ":" + scryptSync(password, salt, 64).toString("hex");
const db = new DatabaseSync(database);
const id = randomUUID();
db.prepare("INSERT INTO accounts(id,name,email,password,role,consent_at,created_at) VALUES(?,?,?,?,?,?,?)").run(id, "Recovery administrator", email, digest, "admin", now, now);
const previous = db.prepare("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1").get()?.hash || "";
const hash = createHash("sha256").update(JSON.stringify([id, "account.recovery.admin_created", id, now, previous])).digest("hex");
db.prepare("INSERT INTO audit(actor,event,record_id,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?)").run(id, "account.recovery.admin_created", id, now, previous, hash);
db.close();
console.log("administrator created:", id);
' <database> <email> <password>

node scripts/recovery.js verify <database>     # expect {"schema_version":18,"accounts":N}
```

The digest format and the scrypt parameters are the application's own (`src/platform.js:92-97`), and the
audit row keeps `verifyAudit` and `validateDatabase` passing (`src/recovery.js:155-156`). To simply
restore a suspended administrator instead, use `UPDATE accounts SET status='active' WHERE email=?` with
the server stopped, and revoke nothing else. **Both operations are indistinguishable, inside the
database, from an operator action: they are exactly what the threat model §10 says a host or database
administrator can do. Treat the host as privileged.**

**C. The host environment is lost (a rebuilt service, a new machine).** The world lives in
`/var/data/world.sqlite`, not in the process. Point `LUCY_DATABASE` at the same file, set the origin,
and start. A new `LUCY_SETUP_CODE` is not needed once accounts exist. If the disk is gone too, restore
the newest verified backup (§4 of the release checklist) — and expect to lose everything committed after
it.

**D. The world is unreachable but the process is healthy.** Check the origin: a wrong `LUCY_PUBLIC_ORIGIN`
(a path, a port, a different host, or a loopback name) makes the server refuse requests or refuse to
start (`src/hosting.js:10-17`). Check the health path is `/api/v1/health`.

## 10. What a release must not do

Restated from the release checklist, because it is the failure mode of most release processes: never
resolve a red gate by deleting coverage, skipping a test, inventing a result, or raising a permission,
reward, quota or capacity limit. Never describe the system as unhackable. Never publish a database,
backup, `.env`, token or setup code. Never enable a second instance against the same SQLite file.

## 11. Limits of this package

- The Blueprint has **not** been applied to a provider. Its syntax follows Render's published Blueprint
  specification (fields `plan`, `autoDeployTrigger`, `maxShutdownDelaySeconds`,
  `disk`, `envVars` with `generateValue`/`sync`), but only a Render account can validate it end to end,
  and doing so would create a paid service — the operator's decision.
- The capacity numbers are one machine, one fixture and bounded concurrency (`PERFORMANCE.md`,
  `docs/handoff/integration-2026-10-14-master-wave.md`). The 32-reader p95 exceeds 3.6 seconds.
- The historical 14/16, 15/16 and 16/16 browser runs remain documented, while the combined
  schema-23 build passed 45/45 once. This does not establish a production reliability target.
- The threat model is a code review, not an audit, and its residual-risk list is part of the assessment.

## Integration correction — 13 October 2026

The proposed pre-deploy check silently skipped the service database because [Render persistent disks are unavailable during build and pre-deploy commands](https://render.com/docs/disks). It was removed from `render.yaml`. `server.js` now validates any existing database while holding its process lock, before migrations, seed writes or listening. `tests/startup-integrity.test.js` executes the real server entry point against corrupt, foreign and newer-schema worlds (refusal without source bytes changing) and a valid world (successful restart with audited records preserved). The earlier shell-only rehearsal did not prove this hosting boundary. No hosted deployment has been performed.

## Integration clarification — 13 October 2026

The historical plan recommendation above was not an approved hosting change at the time. For the fresh public-world release candidate, the current Blueprint selects `plan: 1c-2g` and keeps automatic deployment off. Review the exact provider charges and Blueprint preview before syncing it. No purchase, deployment or resize was performed by this source edit.

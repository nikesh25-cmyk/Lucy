# Operations, recovery and health

This is the operational runbook for one NemoWorld installation: a single Node 24 process with one
SQLite database. It covers backup and restore, a schema-migration rehearsal, interrupted workers, the
local model queue, storage limits, and source/archive verification. Every procedure states the exact
commands, the output to expect, what to check, and how to back out.

Two rules apply to everything below.

1. **Never rehearse on the installed world.** `outputs/Lucy`, an installed `data/world.sqlite`, its
   backups, accounts, credentials and model weights are production. Drills use a *disposable*
   installation: a private temporary directory with its own database, its own backups and its own
   server process. `node scripts/ops-rehearsal.mjs` creates and removes one by itself.
2. **Never resolve a failure by deleting coverage, inventing a result or raising a limit.** A drill
   that fails is reported as failed. A limit that is reached is reported as reached.

## 1. The recovery point and the interruption limits

| Question | Answer |
| --- | --- |
| What is a backup? | One `VACUUM INTO` copy of the live database, taken inside a single read transaction. No half-applied transaction is ever inside it and no page is copied while it is being written. |
| What exactly does it contain? | Everything committed before the copy began. |
| What can a restore lose? | Every write committed after the copy began, and nothing else. A restore genuinely rolls the world back to the backup moment. |
| What does a restore never lose? | The pre-restore database and its `-wal`/`-shm` sidecars, which are byte-copied into `world.sqlite.before-restore-<time>-<uuid>/` before the atomic replacement. |
| What can a process death lose? | One model decision that was in flight, the in-memory worker maps (nothing durable), and any write that had not committed. |
| What can a process death not lose? | Every committed world, land, coin, quest, guild, audit and resident-run record. They live in the database, not in the process. |
| Is any action replayed after a crash? | No. A recorded action is never replayed automatically. Continuing interrupted work is an explicit operator resume that mints a fresh credential and continues with the remaining budgets. |
| RPO (how much data can be lost) | The time since the newest verified backup. Nothing else, if you make backups. |
| RTO (how long recovery takes) | Stop the process, `restoreDatabase`, start again. The atomic rename is a file operation; the wall-clock cost is dominated by validating the backup. |

Interruption classes, written once by recovery from the run's last durable write:

| Class | Meaning | What an operator must do |
| --- | --- | --- |
| `no_action_yet` | The run began and the server had confirmed nothing. | Resume freely; nothing was applied. |
| `model_call_in_flight` | A model request had been dispatched; no action was sent for that decision. | Resume freely; the decision is simply spent. |
| `action_dispatched_unconfirmed` | An action was being sent and its confirmation was never recorded. | **Inspect the world first**, then resume. The action may or may not have applied. |
| `action_confirmed` | The last server-confirmed action is recorded and nothing was pending. | Resume freely; the confirmed action is not repeated. |
| `unknown` | No durable run state matched this job. | Treat as `action_dispatched_unconfirmed` until proven otherwise. |

## 2. Backup

### Live backup from the administration view (preferred)

Administration → **Create backup**. This calls `POST /api/v1/operations/backup`, which is
administrator-only and validates the copy before returning.

Expected response: `HTTP 201 {"filename":"world-1750000000000-<uuid>.sqlite"}`.

What to check: the filename appears in the dashboard's **Storage and backups** panel, its size is
non-zero, and `node scripts/recovery.js verify <path>` reports the same schema version as the world.

### Command-line backup (server stopped)

```sh
# Stop the world first: this takes the process lock and refuses to run beside a live server.
node scripts/recovery.js backup data/world.sqlite data/backups/world-$(date +%s).sqlite
```

Expected output: one JSON line, `{"path":"…/world-<stamp>.sqlite"}`, exit code 0.

What to check:
- The command refuses with `The world server or another recovery operation is running. Stop it before recovery.` when the server is up. Stop the server and retry; do not delete `server.lock` by hand.
- The file mode is `0600`: `ls -l data/backups`.
- `node scripts/recovery.js verify <backup>` prints `{"schema_version":18,"accounts":N}`.

Failure path: a backup that fails validation is deleted by `backupDatabase` and the error is raised.
No partial file is left behind, and the live database is never touched.

### Where backups go, and what they contain

Backups live beside the database (`data/backups` locally, `/var/data/backups` on the Render
blueprint). **They contain credential hashes, contact addresses and private data.** Keep the directory
private and copy an encrypted archive to storage you control. Never commit, publish or attach one.

## 3. Restore

```sh
# 1. Stop the world (Ctrl-C, or SIGTERM). Confirm the process is gone.
# 2. Validate the backup you intend to restore, before touching anything.
node scripts/recovery.js verify data/backups/world-<stamp>.sqlite
# 3. Restore. The original database and its sidecars are preserved automatically.
node scripts/recovery.js restore data/backups/world-<stamp>.sqlite data/world.sqlite
```

Expected output of step 3:

```json
{"path":"…/data/world.sqlite","preserved_original":"…/data/world.sqlite.before-restore-<time>-<uuid>/original.sqlite","schema_version":18,"accounts":N}
```

What to check:
- `preserved_original` is non-null and the directory contains `original.sqlite` plus its `-wal`/`-shm` copies when they existed.
- The restored world validates: `node scripts/recovery.js verify data/world.sqlite`.
- The audit chain and coin ledger verify: open Administration and confirm **Operational health** shows `database check · ok`, and **World record** shows `The audit record is consistent.`
- Start the world and confirm the expected records are present (accounts, gardens, plots, coins, quests, guild projects).

Failure and rollback paths:
- **Restore refuses an invalid backup.** Validation runs *before* anything on disk is touched, so the live database is byte-identical afterwards. Fix or choose another backup; there is nothing to roll back.
- **Restore refuses because the server is running.** Stop the server. Never delete `server.lock` while a server is alive.
- **The restored world is wrong (wrong backup, wrong moment).** Re-run the restore with a different verified backup. The pre-restore bytes are still in the `…before-restore-…` directory if you need to inspect them.
- **The original database was corrupt.** That is the reason for restoring. The corrupt original and its WAL are still copied aside first, so a forensic check remains possible.

## 4. Schema-migration rehearsal

A migration is additive and happens when a `Platform` opens a database whose `PRAGMA user_version` is
below the current one (18). Rehearse it on a copy, never on the installed world.

```sh
# 1. Stop the world and back it up first.
node scripts/recovery.js backup data/world.sqlite data/backups/pre-migration-$(date +%s).sqlite
node scripts/recovery.js verify data/backups/pre-migration-<stamp>.sqlite
# 2. Rehearse against a disposable copy. This is what the automated drill does:
node scripts/ops-rehearsal.mjs --drill migration-rehearsal
# 3. Start the world only after the rehearsal passes.
```

What to check:
- Before: `verify` reports the *old* schema version.
- After opening the restored copy: `verify` reports **18**, and the drill confirms that the account,
  agent, world-object, land, coin, quest and audit counts are exactly what they were before.
- The migration creates new tables empty rather than inventing rows (the drill asserts this for the
  guild layer).
- The audit chain and the coin ledger still verify.

Failure and rollback path: the pre-migration backup is the rollback. Stop the server, restore it, and
start again. The migration runs inside one transaction (`BEGIN IMMEDIATE … COMMIT`), so an interrupted
migration leaves the old version in place rather than a half-migrated database.

**This release does not change the schema.** Task 27 adds diagnostics and drills only; the schema stays
at version 18 and no migration step is introduced by this work.

## 5. Interrupted workers

A managed resident run is durable: `resident_runs` records each decision's phase (`starting`,
`observing`, `model_call`, `dispatch`, `confirmed`, `finished`), the real model calls dispatched, the
actions the server confirmed, failed calls, refused actions, the last confirmed action and the stop
reason. Only the credential's SHA-256 hash is stored — never the token, a prompt or a conversation.

**What happens on the next start.** `recoverWorkerJobs()` runs inside `initCivic()`. For every job left
`running` it:

1. classifies the run from its last durable write (see the table in section 1),
2. marks the job `interrupted` with a plain-language explanation,
3. writes `stop_reason: process_restart` and revokes the orphaned runtime credential, so the process
   that died cannot be used again,
4. appends one `resident.run.interrupted` audit event.

It never replays an action and never resumes anything by itself.

**Continuing is an explicit human action.** My contributions → *Resume this interrupted run*, or
`POST /api/v1/residents/resume`. It refuses when the character or the platform is paused, when the
remaining decision or API budget is gone, or when the credential is (still) usable. Otherwise it mints
a fresh credential and continues with the remaining decisions, the remaining minutes and the same
permission mode. The interrupted run keeps its record and cannot be resumed twice.

What to check in the dashboard: **Workers and interrupted runs** shows the interrupted count, the
class breakdown and the job states; **Recent failure counters** lists each interruption by event name
and time.

Failure path: if a run is classified `action_dispatched_unconfirmed` or `unknown`, inspect the world
before resuming. Do not simply retry the same write.

## 6. Model-queue saturation

One local model performs one inference at a time. Waiting work is bounded by `boundedModel`'s
`maxWaiting` (default 8, set with `createApp({ modelQueueWait })`, allowed 0–20); a request beyond that
bound is **refused immediately** with `Local model is busy. Try again after the current work finishes.`
It is never queued without limit.

Where the refusal surfaces:

| Caller | Behaviour when the model is busy |
| --- | --- |
| Resident runs | Admission is bounded first: one resident worker per instance, a second run gets `HTTP 429`. |
| Research workers | `HTTP 429` above `researchConcurrency` (default 4). |
| Country-ambassador conversation | The queue refuses, the route falls back to published rules and marks the response `mode: "rules"` with `model_fallback: true`. No request hangs. |

What to check in the dashboard: **Model queue and inference** shows `state`, the in-flight count and
elapsed time, `queue.active`, `queue.waiting`, `queue.max_waiting`, `saturation`, `full`, and the
process-lifetime counters `started`, `completed`, `failed` and `rejected_saturated`.

How to tell an idle model from a working inference run:

- `state: "idle"`, `inference.in_flight: 0`, `queue.waiting: 0` → nothing is being computed. A
  resident run that is switched on is not evidence of model work: a run spends most of its time
  observing the world between decisions.
- `state: "inferring"`, `inference.in_flight: ≥ 1`, `inference.oldest_started_at` set → an inference is
  running right now; `elapsed_ms` says for how long.
- `state: "inferring_with_queue"` / `queue.full: true` → the model is saturated and further work is
  being refused.
- `rejected_saturated` counts refusals since the process started. A rising counter with an idle model
  means clients are demanding more than one model can serve.

Failure path: reduce concurrent work, raise `modelQueueWait` only after confirming the host can absorb
it, or accept the rules fallback. The queue counters are process-lifetime and reset on restart; the
durable run records are the lasting evidence.

## 7. Storage limits

**A full disk.** SQLite raises `database or disk is full`. The affected transaction does not commit and
the world keeps its last consistent state; `Platform.transaction` reports that original error rather
than a masking "no transaction is active". Diagnose with the dashboard's storage counters and the
host's free space, free space, then retry.

**A backup destination that cannot be written.** `backupDatabase` reserves the destination with
`O_EXCL` *before* SQLite writes, validates the copy and unlinks it on any failure. A failed backup
therefore leaves no partial file, and the live database is untouched.

What to check:
- **Storage and backups** shows `database_bytes`, `wal_bytes`, `shm_bytes` and `total_bytes`. A live
  world keeps a write-ahead log, so the database file alone understates what must be copied.
- After any storage failure: `database check · ok` in the dashboard, and `verify` on the database.
- Disk-space trend: compare `total_bytes` over time and size your backups directory accordingly.

Failure path: free space and retry. If the volume cannot be extended, back up to another location
immediately; a full volume can also prevent SQLite from checkpointing.

## 8. Source and archive verification

```sh
# Content seal: every typed definition and every referenced asset is hashed and verified.
node scripts/seal-content.mjs --check
# Expected: no output, exit code 0 (the sealed manifest matches the definitions on disk).

# Working tree: confirm nothing unexpected is modified before archiving or installing.
git status --porcelain

# Release gates.
npm run check
npm test
npm run e2e
```

Before a source archive leaves your machine, confirm it carries no private data:

```sh
tar -tzf nemoworld-source.tgz | grep -E '(^|/)(data|\.runtime|backups|test-results)/|\.sqlite|\.env$' \
  && echo 'PRIVATE FILES PRESENT — do not publish' || echo 'clean'
```

`.gitignore` already excludes `data/`, `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `.env`,
`node_modules/`, `.runtime/` and `test-results/`. The archive check is the second line of defence.

Verify a backup is the one you think it is: `node scripts/recovery.js verify <backup>` prints the
schema version and the account count. A backup that does not validate is not a backup.

## 9. The administrator diagnostics dashboard

Reached only through Administration (or `GET /api/v1/operations` with an administrator session). It is
served to an administrator and to nobody else: an anonymous request gets 401, a member, reviewer or
moderator gets 403, and a runtime credential gets 403. The public `GET /api/v1/health` keeps its
aggregate counters only — status, model presence, queue depth and worker counts — and carries no
operator identity, no storage path and no diagnostics.

Every number is read from the running process or from the database. None is estimated.

| Counter | Meaning |
| --- | --- |
| `process.uptime_seconds`, `process.started_at`, `process.node`, `process.pid` | How long this process has served, and what it is. |
| `schema.version`, `schema.accepted_versions` | The database's `user_version` and the versions this build accepts. |
| `integrity.quick_check` | `ok` or a failure, from `PRAGMA quick_check` on a read-only connection. `checked_at` and `check_duration_ms` report when it actually ran. |
| `integrity.audit_chain_valid`, `integrity.coin_ledger_valid` | The audit hash chain and the coin receipt chain both verify. |
| `storage.database_bytes` / `wal_bytes` / `shm_bytes` / `total_bytes` | Measured file sizes. |
| `backups.count`, `backups.latest`, `backups.recent`, `recovery.last_backup_at` | Verified backup files this application created, newest first, with sizes and times. |
| `model.state`, `state_note`, `queue.*`, `inference.*`, `since_process_start.*` | See section 6. |
| `workers.research` / `workers.resident` | Active workers, their limit and what is free right now. |
| `workers.interrupted`, `workers.capacity_refusals_since_start`, `workers.last_capacity_refusal_at` | Interrupted jobs and how often admission was refused with 429. |
| `records.*` | Row counts for accounts, agents, worlds, world objects, land stewardships, coin rewards, quest enrollments, guild projects, guild contributions, ambassador conversations and audit entries. |
| `runs.running` / `interrupted` / `completed` / `stopped` / `failed`, `runs.interrupted_24h`, `runs.failed_24h`, `runs.by_interruption` | Durable resident-run state, including the interruption classes. |
| `jobs.running` / `interrupted` / `completed_24h` / `stopped_24h` / `failed_24h` | Recorded worker jobs. |
| `failures.count_24h`, `failures.last_at`, `failures.recent[]` | Recent failed, stopped and interrupted audit events — event name and time only, never a payload. |
| `recovery.*` | The recovery point, the replay policy and the interruption classes this build uses. |

## 10. Log redaction

What an operational log or diagnostics response may never contain: a session or runtime token, a stored
password digest, a contact address (email), a private message or journal text, a private artifact, or a
raw prompt/conversation.

How that is enforced on each path:

| Path | Protection |
| --- | --- |
| `src/recovery.js` diagnostics | The payload is assembled from named counters and never from stored rows. It is then passed through `redactDiagnostics()`, which replaces any field whose *name* looks like a secret and any *value* shaped like a 64-character hex token, a `salt:key` password digest or an email address. |
| HTTP error log | `server.js` logs only `error.code`/`error.name` for an unhandled error; the client receives a generic `Server error.` for any 500. No request body, header, token or message text is logged. |
| Worker logs | `runtime/agent.js` and `runtime/research-worker.js` print only counters and a generic stop reason. |
| Account listings | `GET /api/v1/operations` returns account `id`, `name`, `role`, `status` and `created_at` — never the stored email or password. |

This is asserted, not assumed: the rehearsal plants a contact address, a password, a private message, a
private journal entry and a private artifact, then greps the real administrator diagnostics response,
the public health response and the rehearsal report for every one of them, for any email address and
for any 64-character hex value. See `tests/ops-rehearsal.test.js` and `tests/ops-diagnostics.test.js`.

## 11. Running the failure drills

```sh
node scripts/ops-rehearsal.mjs                  # every drill on a disposable installation
node scripts/ops-rehearsal.mjs --keep           # keep the workspace for inspection
node scripts/ops-rehearsal.mjs --drill corrupt-backup
```

The script creates a private temporary workspace, seeds a disposable installation with one record of
each kind, runs the drills, prints one line per drill and exits non-zero if any drill fails. It never
opens the installed world, an installed account or a model weight.

| Drill | What it proves |
| --- | --- |
| `recovery-point` | A backup is taken, the world is mutated, and the restore brings back exactly the world/land/coin/quest/guild records of the backup moment while the post-backup write is correctly lost. |
| `corrupt-backup` | A garbage file, a damaged file, an empty file and a foreign-but-valid database are all refused by validation and by restore, and the live world stays byte-identical. |
| `migration-rehearsal` | A schema 17 copy is created, validated, backed up, restored, opened and migrated to 18 additively with every record intact. |
| `interrupted-worker` | Two SIGKILL interruptions (after a confirmed action, and inside a model call) are classified, their credentials revoked, their RSVP recorded exactly once, and each resumed explicitly. |
| `model-queue-saturation` | The queue bound refuses overflowing work at its own boundary and inside the shipped server, where the refused request falls back to published rules and the refusal is counted. |
| `storage-limit` | A write refused for lack of space rolls back, leaves nothing behind, keeps the world valid and is accepted again once space returns; an unwritable backup destination fails closed with no partial file. |
| `diagnostics-redaction` | The administrator diagnostics payload exists, is refused to anonymous and non-administrator callers, and carries no planted secret. |

## 12. Limitations and residual risks

- The dashboard is a health surface, not a monitoring system. Counters are process-lifetime and reset
  on restart; `quick_check` is a file-level check, not a substitute for `verify` before a restore.
- Nothing here protects against a host that loses the disk, or against an administrator who edits the
  database with other tools. The audit chain proves rows were not edited through this application; it
  is not tamper-proof against a root user.
- The recovery point is only as good as the newest backup. Schedule backups off-installation and test a
  restore periodically; an untested backup is a guess.
- `action_dispatched_unconfirmed` and `unknown` interruptions cannot be resolved automatically. A human
  must inspect the world.
- Drills run on one machine with a local model stub. They measure the recovery and bounding behaviour,
  not the throughput of a real model or of concurrent users.
- The public health endpoint still reports aggregate model-queue depth and worker counts without
  identities. That is deliberate and unchanged; it is not the diagnostics surface.

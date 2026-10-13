# Task 27 — recovery, health and operational runbook

Delivered on branch `task-27-operations`, based on `review/nemoworld-queue` at `4fbdff5` ("Review
integrated queue privacy and resume budgets; prepare DeepSeek batch 02"). Schema **unchanged: version
18**. Nine new tests; the full suite goes from 448 to 457 passing.

## What was delivered

1. **`docs/OPERATIONS.md`** — the tested runbook: backup/restore, schema-migration rehearsal,
   interrupted workers, model-queue saturation, storage limits and source/archive verification. Each
   procedure carries the exact commands, the expected output, what to check and the failure/rollback
   path, plus the explicit recovery point and interruption limits (section 1).
2. **A bounded administrator diagnostics dashboard** on the existing administration surface
   (`GET /api/v1/operations`, rendered as the *Operational health* card). Administrator-only.
3. **`scripts/ops-rehearsal.mjs`** — seven failure drills on disposable installations, asserted
   independently by `tests/ops-rehearsal.test.js`.
4. **Log/diagnostics redaction** with a `redactDiagnostics()` allowlist pass and a test that plants
   secrets and greps the produced output.

## Changed files

| File | Change |
| --- | --- |
| `src/recovery.js` | `RECOVERY_LIMITS`, `storageUsage()`, `integritySnapshot()`, `backupInventory()`, `redactDiagnostics()`. No change to `validateDatabase`, `backupDatabase`, `restoreDatabase`, `acquireProcessLock`. |
| `src/platform.js` | `operations(actor, live)` merges a `diagnostics` payload; new `diagnostics(live)` and cached `integrity()`; `transaction()` now reports a storage failure instead of a masking rollback error. |
| `server.js` | Real model/worker/saturation counters, `modelQueueWait` bound, `liveDiagnostics()`, `/operations` wired to it, capacity refusals counted. |
| `app.js` | `renderDiagnostics()` — the *Operational health* card in the Administration view. |
| `scripts/ops-rehearsal.mjs` | New. The drills and their own internal child-process mode. |
| `tests/ops-diagnostics.test.js` | New. 4 tests. |
| `tests/ops-rehearsal.test.js` | New. 5 tests. |
| `docs/OPERATIONS.md` | New. The runbook. |
| `docs/handoff/task-27-operations.md` | This file. |

`src/database.js`, `src/spaces.js`, `src/civic-engine.js`, `catalog/`, `scripts/e2e-smoke.mjs`,
`scripts/browser-suite.mjs`, `package.json`, `.github/`, `render.yaml`, `HANDOFF.md`,
`docs/VERIFICATION.md` and `outputs/Lucy` were not touched. No schema change was needed.

## Counters exposed by the dashboard

| Group | Fields |
| --- | --- |
| `process` | `started_at`, `uptime_seconds`, `node`, `pid`. |
| `schema` | `version` (fresh `PRAGMA user_version`), `accepted_versions` (1–18). |
| `integrity` | `quick_check`, `checked_at`, `check_duration_ms`, `schema_version`, `page_count`, `journal_mode`, `audit_chain_valid`, `coin_ledger_valid`. |
| `storage` | `database_bytes`, `wal_bytes`, `shm_bytes`, `total_bytes`. |
| `backups` / `recovery` | `count`, `directory`, `latest{filename,bytes,created_at}`, `recent[]`; `last_backup_at`, `backup_point`, `replay_policy`, `interruption_classes[]`. |
| `model` | `configured`, `backend`, `state`, `state_note`, `queue{active,waiting,max_waiting,saturation,full}`, `inference{in_flight,oldest_started_at,elapsed_ms}`, `since_process_start{started,completed,failed,rejected_saturated,last_started_at,last_finished_at,last_result,last_duration_ms,last_saturated_at}`. |
| `workers` | `research{active,limit,available}`, `resident{active,limit,available}`, `interrupted`, `capacity_refusals_since_start`, `last_capacity_refusal_at`. |
| `records` | `accounts`, `agents`, `worlds`, `world_objects`, `land_stewardships`, `coin_rewards`, `quest_enrollments`, `guild_projects`, `guild_contributions`, `ambassador_conversations`, `audit_entries`. |
| `runs` | `running`, `interrupted`, `completed`, `stopped`, `failed`, `interrupted_24h`, `failed_24h`, `by_interruption{…}`. |
| `jobs` | `running`, `interrupted`, `completed_24h`, `stopped_24h`, `failed_24h`. |
| `failures` | `count_24h`, `last_at`, `recent[]` (event name and time only). |

Every value is read from the live process or the database. Process-lifetime counters reset on restart;
the durable run and job counts do not.

**Idle versus working inference.** `model.state` is `unconfigured`, `idle`, `queued`, `inferring` or
`inferring_with_queue`, derived from the real counters: a model call is counted when it is actually
dispatched past the queue, and a refusal is counted separately, so "the model is idle but a resident
run is switched on" is visible as `state: idle`, `inference.in_flight: 0` with a running worker in
`workers.resident`. `inference.oldest_started_at` and `elapsed_ms` say how long the working inference
has been running. The dashboard states this in plain language under the health numbers, and
`tests/ops-diagnostics.test.js` asserts both directions.

## Drills actually run and their results

`node scripts/ops-rehearsal.mjs` — **7/7 drills passed**, 8.6 s in the recorded run, exit code 0, on a
private temporary workspace:

```
PASS  recovery-point  (837 ms)
PASS  corrupt-backup  (732 ms)
PASS  migration-rehearsal  (911 ms)
PASS  interrupted-worker  (4590 ms)
PASS  model-queue-saturation  (525 ms)
PASS  storage-limit  (581 ms)
PASS  diagnostics-redaction  (454 ms)
7/7 drills passed
```

| Drill | Result | Evidence it produced |
| --- | --- | --- |
| `recovery-point` | PASS | Backup taken, one garden object and one message committed afterwards, restore: `schema 18`, the post-backup object and message are gone, and `world_objects`, `land_stewardships`, `land_events`, `coin_rewards`, `quest_enrollments`, `guild_projects/p_guild_participants/guild_contributions`, `accounts`, `agents` and `audit` all equal their pre-backup counts. The coin ledger, audit chain and `quick_check` still verify. The preserved original is written. |
| `corrupt-backup` | PASS | Garbage header, damaged pages, an empty file and a valid foreign SQLite database are each refused by `validateDatabase` and by `restoreDatabase` (8 refusals). The live database stayed byte-identical (SHA-256 compared before and after), no `.restore-*` temp file was left, and the valid backup restored afterwards. |
| `migration-rehearsal` | PASS | The fixture validates as schema 17, backs up, restores into a clean path, then migrates to 18 on open with identical account/agent/world-object/land/coin/quest/audit counts and an empty recreated guild layer. |
| `interrupted-worker` | PASS | Two SIGKILL interruptions (after a confirmed RSVP; inside a model call) were classified `action_confirmed` / `model_call_in_flight` with `stop_reason: process_restart`, the orphaned credential was revoked, the RSVP was recorded exactly once, exactly one `resident.run.interrupted` audit event was written, and each run was resumed explicitly with the remaining budget and a fresh credential without repeating the action. |
| `model-queue-saturation` | PASS | At the queue boundary: one active, two waiting, the overflow refused, an aborted waiter released. Inside the shipped server (`modelQueueWait: 1`): `state: inferring_with_queue`, `queue.full: true`, one request degraded to the rules fallback, `rejected_saturated: 1`, and the state settled back to `idle` with `completed: 2`. |
| `storage-limit` | PASS | With the page limit pinned to the current page count, a 200 KB write failed with `database or disk is full`, nothing was left behind, `quick_check` was still `ok`, the audit chain verified, and a normal audited write succeeded once space returned. A backup into a `0500` directory failed with no partial file; a backup into a writable directory then validated. |
| `diagnostics-redaction` | PASS | The administrator diagnostics response exists, an anonymous request gets 401 and a member 403; the payload, the public health response and the drill report contain none of the planted email, password, private message, private journal, private artifact, session token or runtime token, no email address and no 64-character hex value. |

Also re-checked by the tests themselves, not by the drill's own opinion: the restored database, the
migrated database, the refused backups, and a grep of the written diagnostics payload.

## Gates (actual output)

```
$ npm run check   → CHECK EXIT=0
$ npm test        → TEST EXIT=0
ℹ tests 457
ℹ pass 457
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 43188.91575
$ npm run e2e     → E2E EXIT=0
SUMMARY  15 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API
$ node scripts/ops-rehearsal.mjs → DRILL EXIT=0
7/7 drills passed
```

Base revision, same machine: `npm test` → 448 tests, 448 pass, 0 fail, 49.7 s.

The nine new tests are `tests/ops-diagnostics.test.js` (4) and `tests/ops-rehearsal.test.js` (5); no
existing test was modified, skipped or removed.

## The recovery point and the interruption limits

- **Recovery point:** the last transaction committed before the backup's `VACUUM INTO` copy began. A
  restore loses everything committed after that moment and nothing else.
- **RPO:** the time since the newest verified backup. **RTO:** stop the process, restore, start again.
- **What a process death can lose:** one model decision in flight, the in-memory worker maps, and any
  uncommitted write. **What it cannot lose:** every committed world, land, coin, quest, guild, audit
  and resident-run record.
- **Interruption classes** and what an operator must do for each are in `docs/OPERATIONS.md` §1.
  Nothing is ever replayed; only `action_dispatched_unconfirmed` and `unknown` need a look at the
  world before resuming.

## Redaction proof

`src/recovery.js` exports `redactDiagnostics()`: a field whose *name* matches
`password|pass_hash|secret|token|credential|hash|salt|email|contact|authorization|cookie|private` is
replaced, and a string value shaped like an email, a `salt:key` password digest or a 40+ character hex
value is replaced. `Platform.diagnostics()` passes its whole payload through it.

The proof is empirical: the rehearsal registers an account with `ops-secret-contact@rehearsal.invalid`
and a known password, writes a private message, a private journal entry and a submission artifact with
distinct markers, and issues a session and a runtime credential. `tests/ops-rehearsal.test.js` then
greps the real `GET /api/v1/operations` response, the public `/health` response and the rehearsal
report for all of them, for any email address and for any 64-hex value; `tests/ops-diagnostics.test.js`
does the same on a second installation and additionally checks the sanitizer directly against a
poisoned object. Separately, `server.js` logs only `error.code`/`error.name` and returns a generic
`Server error.` for a 500, and `/operations` returns account `id/name/role/status/created_at` and never
the stored email or password hash.

## Migration and rollback notes

**The schema did not change.** `PRAGMA user_version` stays 18; `src/database.js` and
`validateDatabase()`'s accepted range are untouched; no new table, column, trigger or view is created.
An existing installation opens, runs and is backed up exactly as before, and the previous release can
open this branch's database without a migration. Rollback is therefore a plain source revert: stop the
world, check out the previous revision, restore the pre-change backup if desired and start again.

## Limitations and residual risks

- The dashboard is a health surface, not monitoring. Counters are process-lifetime; `quick_check` is a
  file-level check and does not replace `verify` before a restore; the integrity scan is reused for up
  to 10 seconds (`checked_at` reports when it actually ran).
- The dashboard rendering in `app.js` was verified by `node --check app.js`, by rendering the real
  `GET /api/v1/operations` payload through `renderDiagnostics()` against a minimal DOM stub (the
  health numbers, the idle/inference status line and all four disclosures rendered correctly, and a
  payload without diagnostics renders nothing), and by the HTTP contract the tests assert. It was
  **not** exercised in a real browser: `scripts/browser-suite.mjs` does not exist on this branch, and
  the browser task belongs to a different owner. A browser pass over the Administration view is a
  recommended follow-up.
- The drills use a stubbed local model, a synthetic oversized write to simulate a full disk and a
  `0500` backup directory to simulate an unwritable destination. They prove the bounding and
  fail-closed behaviour, not the throughput of a real model; the storage drill also assumes the
  process is not running as root.
- Nothing here defends against a root user editing the database directly, or against host/disk loss.
  The recovery point is only as good as the newest off-installation backup.
- `docs/API.md` was not updated with the `/operations` diagnostics fields because this task's file
  ownership excluded it; the payload is documented in `docs/OPERATIONS.md` §9 and in this handoff.
  Adding a short section to `docs/API.md` is a suggested follow-up for the integrator.

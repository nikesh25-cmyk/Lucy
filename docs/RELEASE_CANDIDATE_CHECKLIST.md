# Release-candidate checklist and rollback path — a fresh public world

This is the operator checklist for putting a **fresh public NemoWorld world** into service from
`integration/nemoworld-unified-2026-10-15`, schema **27**, and the safe way to take it back out again.
It updates the Wave 7 procedures; §5 retains the original Wave 7 measurements on schema 25. Those
measurements are historical evidence, not results for the current release commit.

It is **not** a launch authorisation, a capacity claim or a commercial-readiness statement. No part of
it establishes MMO scale, a supported-user count or a service-level objective. Where a number appears
it was measured on one machine, under the load average recorded with it, against a disposable
installation, and it is not extrapolated.

Companion documents: `docs/RELIABILITY.md` (the operational limits report, four arms kept separate),
`docs/OPERATIONS.md` (backup, restore, migration and drill runbook), `docs/RELEASE_CHECKLIST.md` (the
general release checklist), and `docs/handoff/framework-wave7-reliability.md` (what this slice did).

## 1. Before you begin

| | |
| --- | --- |
| Schema | `PRAGMA user_version = 27`. A database above 27 is refused at open. |
| Write authority | Exactly one process may hold the world: `openDatabase` plus the `server.lock` file. Stop the server before any command-line backup or restore. |
| Disposable rehearsal first | Every command in §3 and §4 can be rehearsed end to end on a disposable database — `node scripts/reliability-drills.mjs --drill rollback-release-candidate` does exactly that, in a temporary directory, and removes it afterwards. Rehearse before you touch the real world. |
| What a rollback cannot do | A restore returns the world to the backup moment. Everything committed after it is gone. There is no partial rollback and no merge. |

## 2. Gate table for the release candidate

Run every gate on the exact tree you intend to release, with Node 24
(`export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"`).

| Gate | Command | Passing looks like | If it is red |
| --- | --- | --- | --- |
| Syntax | `npm run check` | `checked N files, 0 failed`, exit 0 | Stop. A file does not parse. |
| Unit + integration | `npm test` | `pass N`, `fail 0`, `cancelled 0`, `skipped 0`, exit 0 | Stop. Read the failing file; do not proceed on a red suite. |
| HTTP acceptance | `npm run e2e` | `SUMMARY  20 steps passed, 0 failed`, exit 0 | Stop. A shipped route broke. |
| Reliability drills | inside `npm test` | the `reliability-drills` suite passes (three drills, see §4) | Stop. The rollback or crash-recovery path regressed. |
| Content seal | `node scripts/seal-content.mjs --check` | `Verified: …`, exit 0 | Stop. The sealed content does not match its manifest. |
| Operational limits | `node scripts/soak-experiment.mjs --json /tmp/soak.json` | exits 0: no leaked subscription, the world writable again after the exhaustion probe, inside the disk budget | Investigate before serving. |
| Capacity probe | `node scripts/capacity-experiment.mjs --skip-browser` | exit 0, all sections within their budgets | Warning only; it measures, it does not gate correctness. The browser arm is owned separately (see §6). |
| The release-point backup | `node scripts/recovery.js backup <db> <backup>` | JSON with a path; `verify` returns schema 27 for a new world, or the old schema before an upgrade | **Do not release without it.** Keep the matching source and vault key as well. |

The legacy crop/block constraint gap identified by Wave 7 now has a versioned migration in
`src/schema27.js`. `node --test tests/content-schema27.test.js` exercises schema 24/25/26 worlds with
narrower sealed lists, saved crops, guest construction and grants, backup/restore and interrupted
rebuild rollback. Unknown content is refused rather than removed. Once a world is schema 27,
another sealed-list change requires another migration; the historical known-gap repro is not the
current acceptance gate.

## 3. Bringing a fresh public world into service

Every command below is safe to rehearse on a disposable installation first.

```sh
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
WORLD=/srv/nemoworld/data/world.sqlite     # the world this release will serve
BACKUPS=/srv/nemoworld/data/backups
```

1. **Create the world and let it migrate itself.** Start the server once with no database present and
   `LUCY_INITIAL_REGISTRATION=closed` and a private `LUCY_SETUP_CODE` for public hosting. Confirm
   `GET /api/v1/health` has `status: "ok"`. The world is created at schema 27.
2. **Register the first administrator** through the setup path while that server is running, using
   its private setup code. Keep registration closed while preparing the launch. The environment
   setting initializes a new database only; changing it later does not override the saved policy.
   Then stop the server before taking the command-line backup.
3. **Take the release-point backup** with the server stopped:
   `node scripts/recovery.js backup "$WORLD" "$BACKUPS/world-release-point.sqlite"`, then
   `node scripts/recovery.js verify "$BACKUPS/world-release-point.sqlite"`.
   Record the JSON. This is the rollback artifact; keep it off-host as well.
4. **Restart and confirm the world describes itself.** `GET /api/v1/operations` as the administrator must show
   `diagnostics.schema.version = 27`, `diagnostics.integrity.quick_check = "ok"`,
   `audit_valid: true`, `coin_ledger_valid: true`, and `diagnostics.incidents.recorded_since_start`
   (0 on a healthy fresh world).
5. **Open registration** using the administrator's saved registration control
   (`POST /api/v1/operations/registration` with `{"mode":"open"}`), when the deployment checks in
   `docs/RELEASE_CHECKLIST.md` are satisfied. Watch `diagnostics.incidents` and `diagnostics.failures`: an
   unexpected 500 is now counted, timestamped and named by route, so "is this world failing requests?"
   is answerable from the dashboard rather than from a terminal.
6. **Release point logged.** Write the backup filename and its `verify` output into the release record.
   Use `backup-encrypted`, `verify-encrypted` and `restore-encrypted` as documented in
   `docs/OPERATIONS.md` §2 for an authenticated off-host archive. No actual independent encrypted
   backup of the installed world has been established by this checklist; record and rehearse that
   operational copy before unrestricted enrollment.
   If you cannot say which file returns the world to its release point, you are not ready to serve.

## 4. The safe rollback path

A database rollback validates the backup, preserves the current bytes, and replaces the world while
the service is stopped. If returning to older code after the schema-27 upgrade, also restore the
matching pre-upgrade source. Preserve `data/`, `.runtime/`, private configuration, `node_modules` and
the vault key. For a launchd-managed Mac, unload the saved job first so `KeepAlive` cannot restart
the server during replacement; see `docs/OPERATIONS.md` §4.

```sh
# 1. Stop the world. The command below acquires data/server.lock and refuses if the server holds it.
# 2. Take a fresh backup of the world you are about to discard, so the rollback itself is reversible:
node scripts/recovery.js backup "$WORLD" "$BACKUPS/world-before-rollback-$(date +%s).sqlite"
# 3. Roll back to the release point:
node scripts/recovery.js restore "$BACKUPS/world-release-point.sqlite" "$WORLD"
# 4. Prove it, then start the server.
node scripts/recovery.js verify "$WORLD"
```

- **What `restore` returns:** `{"schema_version":<backup-version>,"accounts":N,"path":…,"preserved_original":…}`. The
  `preserved_original` path holds the byte copies of the database, `-wal` and `-shm` the rollback
  replaced. A rollback therefore does not destroy evidence, and can itself be undone.
- **What is guaranteed:** the restored world is the release point exactly — every stored record and
  the audit chain tip are the values the backup held, the file-level check is `ok`, and the world is
  writable again. Measured in §5.
- **What is lost:** everything committed after the release-point backup. Tell the affected operators
  which window that is; do not describe a rollback as lossless.
- **When to roll back:** the release changed persisted state in a way you cannot undo forwards, a
  migration failed, or the audit chain or coin ledger does not verify. **When not to:** a bug that
  writes nothing durable should be fixed forwards — a rollback costs every session since the backup.
- **Never** roll a world back while the server is running, and never edit a backup in place. If
  `restore` refuses, the world is untouched; fix the reason and run it again. Repeating the same
  rollback is safe and idempotent.

## 5. Historical executed rollback drill — Wave 7, schema 25

`node scripts/reliability-drills.mjs --drill rollback-release-candidate` seeds a fresh public world in a
temporary directory, backs up its release point with the shipped CLI, releases (two writes and a new
registration), rolls back with the shipped CLI, serves the world again, and rolls back a second time.
It is also part of `npm test` through `tests/reliability-drills.test.js`.

```
$ node scripts/reliability-drills.mjs --keep --drill rollback-release-candidate
PASS  rollback-release-candidate  (1571 ms)
1/1 drills passed

checks (10 of 10 passed):
  PASS the released world has a verified release-point backup beside it — 8531968 bytes, mode 600
  PASS the release really changed the world — before=accounts=4 world_objects=1 audit=19
       after=accounts=5 world_objects=2 audit=22
  PASS the rollback succeeds and preserves the released bytes before replacing them
       — preserved_original=true in 249 ms
  PASS the world is exactly the release-point state again — release point=accounts=4 agents=1
       world_objects=1 land_stewardships=1 land_events=1 coin_rewards=1 quest_enrollments=1 audit=19
       rolled back=accounts=4 agents=1 world_objects=1 land_stewardships=1 land_events=1
       coin_rewards=1 quest_enrollments=1 audit=19
  PASS the audit chain tip is the release-point tip again
  PASS work committed after the release point is gone
  PASS the rolled-back world validates completely and its storage is intact
       — {"database_bytes":8531968,"wal_bytes":37112,"shm_bytes":32768,"total_bytes":8601848}
  PASS the rolled-back world serves the public health endpoint
  PASS the rolled-back world accepts new writes and keeps a valid audit chain
  PASS rolling back a second time from the same artifact is safe and idempotent

Measured: release point backed up (8,531,968 bytes, mode 0600); released to
accounts=5 world_objects=2 audit=22; rolled back through scripts/recovery.js in 249 ms to
accounts=4 world_objects=1 audit=19; served again; re-rolled-back safely.
```

And the same three drills run inside `npm test` through `tests/reliability-drills.test.js`, which
re-opens the databases, re-greps the diagnostics and log, and re-reads the backup rather than trusting
the drill's own summary:

```
$ node scripts/reliability-drills.mjs --keep
PASS  crash-during-write  (2586 ms)     # 31 checks
PASS  unexpected-error-record  (577 ms) # 11 checks
PASS  rollback-release-candidate  (1571 ms) # 10 checks
3/3 drills passed
```

**The rollback works, and it is repeatable.** The one thing the drill cannot prove is that a rollback
of the *real* public world preserves everything operators expect, because that requires the real world.
Rehearse it on the disposable install first, and take the fresh backup in step 2 of §4 before rolling
back, so the rollback is itself reversible.

## 6. What this checklist does not cover

1. **Browser frame rate.** No frame-rate or real-device figure is asserted anywhere in this document or
   in `docs/RELIABILITY.md`. That arm belongs to the rendering-measurements owner; the browser rows in
   this repository are suite wall-clock and in-page input→confirmation timings, never FPS.
2. **A real model.** No local model is configured for any measurement here, so nothing in this
   checklist is evidence about model throughput, model quality or model latency.
3. **Network reality.** Loopback only: no TLS termination, no proxy, no real latency, no packet loss,
   no CDN.
4. **A real moderation incident.** The current operations suite includes `safety-and-pause` on
   disposable records, including independent appeal and restart recovery. It does not establish
   moderation staffing or incident response in a real public world.
5. **An actual independent encrypted backup.** `backupDatabase` writes plaintext; the shipped
   encrypted CLI can create an authenticated archive. Transfer, separate key custody and restoration
   of the actual installation on independent storage still require an operator's recorded drill.
6. **Future content migrations.** Schema 27 covers the known legacy constrained lists. It does not
   permit silently changing another sealed crop/block list under the same schema version.
7. **Multiple writers or multiple processes.** One process, one SQLite connection. Nothing here is
   evidence about horizontal scale.

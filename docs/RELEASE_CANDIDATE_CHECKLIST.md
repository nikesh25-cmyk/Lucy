# Release-candidate checklist and rollback path — a fresh public world

This is the Wave 7 operator checklist for putting a **fresh public NemoWorld world** into service, and
the safe way to take it back out again. It is deliberately narrow: it covers the reliability and
recovery gates this slice measured, and it says plainly which gates it does not cover.

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
| Schema | `PRAGMA user_version = 25`. A database above 25 is refused at open. |
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
| The release-point backup | `node scripts/recovery.js backup <db> <backup>` | JSON with a path, `verify` returns `{"schema_version":25,…}` | **Do not release without it.** It is the only rollback artifact. |

Known gap that these gates do **not** cover, recorded rather than hidden: a release that adds a *crop
kind* changes the persisted `journey_crops` schema without moving `PRAGMA user_version`, and an
existing schema-25 world is then refused at open with `Stored world content constraints are
incomplete.` — there is no migration for it. Reproduce with
`node --test tests/framework/known-gaps-reliability.mjs`. **Do not release a new crop kind to an
existing world** until that migration exists. A fresh world (the case this document covers) is
unaffected, because there is no earlier schema for it to disagree with.

## 3. Bringing a fresh public world into service

Every command below is safe to rehearse on a disposable installation first.

```sh
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
WORLD=/srv/nemoworld/data/world.sqlite     # the world this release will serve
BACKUPS=/srv/nemoworld/data/backups
```

1. **Create the world and let it migrate itself.** Start the server once with no database present and
   a closed registration setting, confirm `GET /api/v1/health` answers `{"status":"ok"}`, then stop it.
   The world is created at schema 25.
2. **Register the first administrator** through the setup path, then close registration
   (`LUCY_INITIAL_REGISTRATION=closed`) so no one else can self-register while you finish.
3. **Take the release-point backup** with the server stopped:
   `node scripts/recovery.js backup "$WORLD" "$BACKUPS/world-release-point.sqlite"`, then
   `node scripts/recovery.js verify "$BACKUPS/world-release-point.sqlite"`.
   Record the JSON. This is the rollback artifact; keep it off-host as well.
4. **Confirm the world describes itself.** `GET /api/v1/operations` as the administrator must show
   `diagnostics.schema.version = 25`, `diagnostics.integrity.quick_check = "ok"`,
   `audit_valid: true`, `coin_ledger_valid: true`, and `diagnostics.incidents.recorded_since_start`
   (0 on a healthy fresh world).
5. **Open registration** and serve. Watch `diagnostics.incidents` and `diagnostics.failures`: an
   unexpected 500 is now counted, timestamped and named by route, so "is this world failing requests?"
   is answerable from the dashboard rather than from a terminal.
6. **Release point logged.** Write the backup filename and its `verify` output into the release record.
   If you cannot say which file returns the world to its release point, you are not ready to serve.

## 4. The safe rollback path

A rollback is one shipped command. It validates the backup, preserves the current bytes, and replaces
the world atomically while the server is stopped.

```sh
# 1. Stop the world. The command below acquires data/server.lock and refuses if the server holds it.
# 2. Take a fresh backup of the world you are about to discard, so the rollback itself is reversible:
node scripts/recovery.js backup "$WORLD" "$BACKUPS/world-before-rollback-$(date +%s).sqlite"
# 3. Roll back to the release point:
node scripts/recovery.js restore "$BACKUPS/world-release-point.sqlite" "$WORLD"
# 4. Prove it, then start the server.
node scripts/recovery.js verify "$WORLD"
```

- **What `restore` returns:** `{"schema_version":25,"accounts":N,"path":…,"preserved_original":…}`. The
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

## 5. The executed rollback drill

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
4. **Moderation, appeal and platform pause as recovery drills.** The Wave 7 drills do not rehearse a
   real moderation incident; `docs/OPERATIONS.md` records the same gap.
5. **The plaintext backup.** `backupDatabase` writes a consistent but unencrypted copy. Encryption is
   an operator step (an encrypted volume, or encrypting the artifact before it leaves the host).
6. **Adding a crop kind to an existing world.** See the known gap in §2. It is a hard stop, not a
   warning.
7. **Multiple writers or multiple processes.** One process, one SQLite connection. Nothing here is
   evidence about horizontal scale.

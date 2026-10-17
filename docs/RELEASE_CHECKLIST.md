# NemoWorld release checklist

Production readiness checklist for `integration/nemoworld-unified-2026-10-15`, schema **27**. Applies to
this repository's deployment: one Node 24 process with one SQLite database, configured by `render.yaml`
and released to a host such as Render.

Every gate below is **named**, has a **real command**, and states the **expected result** for the
combined source. DeepSeek's Wave D measurements were taken on its schema-22 branch and remain in §7
as historical evidence. They are not results for the current combined tree. Record the exact release
commit, commands and actual results in its release handoff; the 14 October handoffs describe older
builds.

**The one rule that governs every gate:** a failing gate is a failing gate. Do not resolve one by
deleting coverage, skipping a test, inventing a result, or raising a permission, reward, quota or
capacity limit to make the failure disappear. Report it, and ship only what the evidence supports.

## 1. Before you begin

| Requirement | Check |
| --- | --- |
| You are releasing reviewed source, not an installed copy | `git status --porcelain` is empty and `git rev-parse HEAD` is the reviewed commit; `outputs/Lucy` is untouched |
| The work is on the intended branch and merged state | `git log --oneline -1` names the reviewed merge or commit, and the branch you deploy is that one |
| No installed world is in the checkout | `data/`, `*.sqlite`, `.env`, `node_modules/`, `.runtime/`, `test-results/` are gitignored and unmodified |
| You have a private environment | `LUCY_SETUP_CODE` (24–256 chars) held privately; no secret has been pasted into chat, a ticket, a screenshot or a commit |
| The host is what you think it is | the Render service's environment shows `LUCY_BIND_HOST=0.0.0.0`, `LUCY_DATABASE=/var/data/world.sqlite`, a `LUCY_SETUP_CODE` of valid length, and no unexpected `LUCY_PUBLIC_ORIGIN` |

## 2. Release gates

Run in this order; stop at the first failure.

| # | Gate | Command | Expected result |
| --- | --- | --- | --- |
| G1 | Syntax gate | `npm run check` | exit code 0; every shipped module parses. Record the checked file count. |
| G2 | Unit and integration suite | `npm test` | every discovered test passes, `fail 0`, `skipped 0`, `cancelled 0`, exit 0. Record the exact count and explain changes against the reviewed base; do not remove coverage to meet this gate. |
| G3 | HTTP acceptance, end to end | `npm run e2e` | `SUMMARY  20 steps passed, 0 failed` and `result  PASS`. The harness serves its own temporary database. |
| G4 | Browser acceptance | `npm run browser` | every declared scenario passes, `0 failed`, `result  PASS`, and `shipped database untouched`. Record the exact count; the historical 45/45 floor alone is insufficient when the current suite declares more scenarios. |
| G5 | Content seal | `node scripts/seal-content.mjs --check` | `Verified: 136 definitions across 10 families; 3 support files; 42 referenced notices and assets.` and exit code 0. |
| G6 | Recovery and failure drills | `node scripts/ops-rehearsal.mjs` | one `PASS` line per drill — `recovery-point`, `corrupt-backup`, `migration-rehearsal`, `interrupted-worker`, `model-queue-saturation`, `storage-limit`, `diagnostics-redaction`, `safety-and-pause` — and exit code 0, on a disposable workspace only. |
| G7 | Capacity evidence probe | `npm run capacity` | prints the hardware, fixture, read percentiles and failures, **movement/building write** and **event-subscriber** figures, browser result and model-queue bound. Re-run on the combined tree before using the figures for planning; Wave D's schema-22 result is historical evidence, **not** a capacity guarantee. |
| G8 | Runtime database integrity | `node --test tests/startup-integrity.test.js` | Real server startup refuses corrupt, foreign and newer databases before writes/listening; a valid existing world starts with its audited records preserved. The runtime check holds the process lock. |
| G9 | Schema agreement | `node scripts/recovery.js verify <database>` | `{"schema_version":27,"accounts":N}` — the same version this build writes, and a non-zero account count on a live world. |
| G10 | Archive privacy | `tar -tzf <archive>.tgz \| grep -E '(^\|/)(data\|\.runtime\|backups\|test-results)/\|\.sqlite\|\.env$'` | no output (nothing matched). If anything matches: **do not publish**. |
| G11 | Published-surface sanity | open `https://<origin>/api/v1/health` and `https://<origin>/api/v1/bootstrap` | `health` returns `status: "ok"` with aggregate counters only; `bootstrap` returns `setup_required: false` and `registration.mode: "closed"` after the administrator exists, and **never** the setup code; `/api/v1/operations` returns `401`/`403` to anyone but an administrator. |
| G12 | Independent encrypted recovery | stop the service; run `backup-encrypted`, `verify-encrypted`, securely transfer the `.nemoenc` file to independent storage and `restore-encrypted` into a disposable second installation | a named operator records the verified off-host artifact, separately held key, recovery point and successful restore. A local encrypted-file test alone does not pass this gate. |
| G13 | Independent AI worker | issue a short-lived `read`, `move`, `chat` token to one AI character; run `npm run agent` from the separate model machine against the hosted HTTPS origin; revoke it and retry | one saved, attributed conversation or action is visible to its operator; after revocation the next action is refused. No token, model key or prompt enters the web Blueprint, logs or screenshots. |

G1–G6 are the code release-blocking gates. G7 is capacity evidence. G8–G13 are the deployment checks;
G11–G13 cannot pass before a real hosted service, backup destination and worker host exist.

Recommended: run G1–G6 on the exact commit you deploy, and record the command, the exit code and the
tail of the output next to the release. An untested release is not a release.

## 3. Migration order

Current schema: **27**. `src/database.js` refuses any database above 27, and
`src/recovery.js` (`RECOVERY_LIMITS.accepted_schema_versions`) accepts versions 1–27 and re-checks each
version's tables, columns, triggers and invariants.

An installed schema-26 or earlier world migrates at startup. Schema 27 provides a transactional
upgrade of narrower legacy crop/block constraint lists, preserving saved rows, rowids, references,
indexes, views and triggers. Valid narrower legacy backups remain restorable. A schema-27 world must
match this release's sealed lists exactly; a later list change needs another versioned migration.

Where a database is older, the order is fixed. **Stop the server and back up first — always.**

| Step | Command | Expected |
| --- | --- | --- |
| 1. Announce and stop | stop the service (Render: drain and `SIGTERM`; a local launcher: Ctrl-C; launchd: save the job definition, then `bootout` as described in `docs/OPERATIONS.md`). Confirm launcher, server and workers have exited. | no `server.lock` held by a live process. Never delete a live lock by hand. |
| 2. Back up | `node scripts/recovery.js backup <database> <backups>/pre-migration-$(date +%s).sqlite` | one JSON line with the backup path, exit 0, file mode `0600`. |
| 3. Verify the backup | `node scripts/recovery.js verify <backup>` | `{"schema_version":<old>,"accounts":N}` — if this fails, stop: you have no rollback. |
| 4. Rehearse on a disposable copy | `node scripts/ops-rehearsal.mjs --drill migration-rehearsal` and `node --test tests/content-schema27.test.js` | the schema-17 rehearsal passes; legacy 24/25/26 constrained-content worlds preserve their records on upgrade, and interrupted rebuilds roll back. |
| 5. Start the new release | deploy, or `npm start` | the migration runs inside one `BEGIN IMMEDIATE … COMMIT`; an interrupted migration leaves the old version in place, not a half-migrated database. |
| 6. Verify the migrated world | `node scripts/recovery.js verify <database>` | `{"schema_version":27,"accounts":N}` with the **same N** as step 3. |
| 7. Verify the world's own integrity | Administration → **Operational health** | `database check · ok`, `audit_chain_valid` and `coin_ledger_valid` both true, and the expected account/plot/coin/quest/guild counts. |
| 8. Unpause | confirm the platform is not paused and a member can sign in | one ordinary human action succeeds after the migration. |

Ordering notes:

- 15 → 16 → 17 → 18 → … → 27 migrate automatically the first time a `Platform`
  opens the file. You do not run them one at a time; but you **do** back up before the first open by the
  new build.
- The published historic order is: 14 → 15 (country ambassadors), 15 → 16 (resident runs), 16 → 17
  (quest chains), 17 → 18 (guild projects), 18 → 19 (plot collaboration), 19 → 20 (resource offers),
  20 → 21 (resident memory), 21 → 22 (evidence library), 22 → 23 (trade board), 23 → 24 (sealed crop/block
  lists), 24 → 25 (resident vault), 25 → 26 (Karma and shop), 26 → 27 (legacy content-list upgrade).
  A world at 13 or below
  passes through the same sequence in one startup transaction.
- Growth is one-way: a backup taken at schema 17 is restorable by this build (it migrates on open), but
  this build's schema-27 database is **not** readable by a schema-26 or earlier build. Rolling
  the code back after a migration therefore also means restoring the pre-migration backup.

## 4. Rollback and recovery

Three levels, cheapest first.

**A. Roll back the code only when database compatibility is established.** Returning from schema 27 to
the previous schema-26 installation requires both the matching old source and the verified
pre-upgrade database backup. Stop the service, preserve the current world, restore that backup with
the compatible recovery CLI, install the old source, then restart. Never point old code at the
migrated schema-27 database. A later source-only correction within the same schema may permit a code
rollback after its stored-content contract is checked. Verify with G9 and G11.

**B. Restore the database (after a bad release, a bad migration or data loss).**

```sh
# 1. Stop the service and confirm the process is gone.
# 2. Validate the backup you intend to restore, before touching anything.
node scripts/recovery.js verify data/backups/world-<stamp>.sqlite
# 3. Restore. The original database and its -wal/-shm sidecars are preserved automatically.
node scripts/recovery.js restore data/backups/world-<stamp>.sqlite /var/data/world.sqlite
```

Expected: a JSON line with `preserved_original`, `schema_version`, and the account count. What to check:
`preserved_original` is non-null and holds `original.sqlite` (plus sidecars); `verify` passes on the
restored file; Administration shows `database check · ok` and the expected records.

Failure and rollback paths, exactly as rehearsed in `docs/OPERATIONS.md` §3:

| Symptom | What happens | What to do |
| --- | --- | --- |
| Restore refuses an invalid backup | validation runs **before** anything on disk is touched, so the live database is byte-identical | fix or choose another backup; there is nothing to roll back |
| Restore refuses because the server is running | the process lock is taken first | stop the server; never delete `server.lock` by hand |
| The restored world is the wrong moment | the pre-restore bytes remain in `…before-restore-<time>-<uuid>/` | restore a different verified backup; nothing is lost by trying |
| The release is worse but the data is fine | older source may reject the current schema | follow level A; establish compatibility or restore the pre-upgrade database with the matching old source |

**C. Host-level rollback.** Restore the whole disk/volume from the hosting provider's snapshot, or
redeploy the service to a fresh disk and restore the newest verified backup into it. Confirm the service
is reachable on the exact origin (`LUCY_PUBLIC_ORIGIN`/`RENDER_EXTERNAL_URL`) afterwards, and re-create a
new `LUCY_SETUP_CODE` only if the environment was lost — the code is needed only while the database has
no account.

**What a rollback cannot recover:** writes committed after the backup you restore (by design — that is
the recovery point), anything that was never backed up, an in-flight model decision, and any action that
was dispatched but whose confirmation was never recorded (inspect the world before resuming; see
`docs/OPERATIONS.md` §1 and §5). Recovery point = the newest verified backup; recovery time = stop,
restore, start.

## 5. Incident handling

**Severity and first moves.**

| Severity | Example | First action |
| --- | --- | --- |
| S1 | the world is down, unreachable, or serving errors to everyone | redeploy the last known-good commit; if it recurs, roll back to the previous backup |
| S1 | suspected leak of the private setup code, an administrator session or the host environment | treat the environment as compromised: rotate `LUCY_SETUP_CODE`, suspend affected accounts, revoke all sessions for them, pause the platform (`Administration → Pause`), then restore from a backup taken before the suspicion if records are in doubt |
| S2 | coin ledger or audit chain fails verification (`coin_ledger_valid: false`, `audit_chain_valid: false`) | issuance and wallet reads already fail closed with `503`. Do **not** delete or rewrite receipts. Freeze, preserve a copy of the database and its WAL, verify the newest backup, and restore to the last verified state |
| S2 | a full disk, or backups failing | free space, confirm `database check · ok`, back up to another location immediately (`docs/OPERATIONS.md` §7) |
| S2 | model queue saturated (`rejected_saturated` rising, `queue.full: true`) | reduce concurrent work, accept the rules fallback, or raise `modelQueueWait` only after confirming the host can absorb it |
| S3 | one member reports abuse | report → moderate with an uninvolved moderator; an appeal must be decided by a different uninvolved human |
| S3 | one account's credential suspected stolen | the operator revokes runtime credentials (agent control) or signs out; an administrator suspends the account, which revokes its tokens |

**Rules for every incident.**

1. **Preserve before you repair.** Copy the database, its `-wal`/`-shm` sidecars and the newest backups
   somewhere private. A restore overwrites the evidence; the tool copies the original aside first, but a
   deliberate copy is cheaper than a forensic recovery.
2. **Redact.** Logs, tickets and chat must never contain a session or runtime token, a stored password
   digest, an email address, private message or journal text, a private artifact, or a raw prompt
   (`docs/OPERATIONS.md` §10). The diagnostics payload is redacted by name and by shape; your own notes
   are not.
3. **Fail closed.** If integrity cannot be established, stop issuing, stop serving private data, or pause
   the platform — do not "continue and check later".
4. **Say what is known and what is not.** Do not describe the system as unhackable, secure, certified or
   attack-proof; do not claim a cause you have not confirmed, and do not minimize an incident to close
   it.
5. **Record it.** Append an entry to the private operational log: what happened, what was observed, what
   was changed, which backup was used, and who decided. The audit chain shows application-level actions;
   it does not record your decisions.
6. **Tell the people affected** — the operators whose records or credentials were involved — and, where a
   legal or contractual duty exists, whoever owns that decision. This repository does not implement
   notification duties.

**Triage commands** (all read-only):

```sh
node scripts/recovery.js verify <database>          # schema, account count, integrity
node scripts/ops-rehearsal.mjs --drill corrupt-backup   # proves an invalid backup fails closed
curl -s https://<origin>/api/v1/health              # aggregate counters only
```

## 6. What is not rehearsed, and therefore not claimed

- No live deployment was created, no hosting plan, disk or domain was purchased or provisioned, and
  nothing was published. G8 and G11 are rehearsed locally (the real server startup integrity gate and the
  exact-origin behaviour) or on an isolated run against a temporary database; the real hosted service,
  its TLS certificate and its provider health check have never been exercised.
- No provider-side rate limiter, WAF, firewall, autoscaling or multi-instance topology exists or was
  tested. The in-process limits are shared by one instance.
- No production traffic, hostile traffic, soak test, backup-restore-to-a-new-host drill, or
  disaster-recovery exercise was performed against a live installation.
- No third-party security review, penetration test or certification exists.
- The capacity numbers are one machine, one fixture, one workload, and an isolated temporary database
  (`docs/PRODUCTION_READINESS.md` §7). They are evidence, not a service-level objective.

## 7. Historical Wave D gate results on schema 22 (14 October 2026)

Branch `integration/deepseek-master-2026-10-14`, commit `7eb03e08d6d8`, schema 22, Apple M5 (10 cores,
16 GiB), Node v24.19.0. Load average is stated with the load-sensitive gates.

| Gate | Result | Detail |
| --- | --- | --- |
| G1 `npm run check` | **PASS** | `checked 90 files, 0 failed`, exit 0 |
| G2 `npm test` | **PASS** | `tests 902`, `pass 902`, `fail 0`, `skipped 0`, `cancelled 0`, `duration_ms 82357` |
| G3 `npm run e2e` | **PASS** | `SUMMARY  17 steps passed, 0 failed`, `result  PASS`, exit 0 (load 2.42) |
| G4 `npm run browser` | **PASS** | `SUMMARY  45 passed, 0 failed`, `result  PASS`, exit 0, 304 s (load 2.12 / 2.59) |
| G5 content seal | **PASS** | `Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.`, exit 0 |
| G6 failure drills | **PASS** | `7/7 drills passed` in 9.5 s on a disposable workspace: `recovery-point` (922 ms), `corrupt-backup` (871 ms), `migration-rehearsal` (1015 ms), `interrupted-worker` (4824 ms), `model-queue-saturation` (576 ms), `storage-limit` (657 ms), `diagnostics-redaction` (529 ms); 76/76 checks (load 3.14) |
| G7 capacity probe | **PASS as evidence** | exit 0; reads 50.78 / 51.82 / 53.02 req/s at 1 / 8 / 32 clients with 0 failures and 0 timeouts inside the 0 % budget; writes 2,487.67 / 3,645.28 saves/s at 1 / 8 clients, 3.9 ms p95, 0 failures; 8/8 event subscribers; browser suites 1 → 28.7 s, 2 → 30.7 s, all passed; model queue 9 admitted / 3 refused / peak waiting 8 of 8, no real model. Tables and the load average: `docs/PERFORMANCE.md` |
| G8 runtime integrity gate | **PASS** | corrupt, foreign and newer databases refused unchanged before listening; a valid schema-22 restart preserved audited records. See `tests/startup-integrity.test.js`. |
| G9 `recovery.js verify` | **PASS** | `{"schema_version":22,"accounts":0}` on a freshly created disposable database, and `{"schema_version":22,"accounts":2}` on the off-install backup rehearsal |

An off-install backup and a restore from it were rehearsed separately on a disposable database
(`docs/OPERATIONS.md` §3). **The shipped backup is not encrypted** — SQLite `VACUUM INTO` writes a
plaintext file — which is stated plainly in `docs/OPERATIONS.md` §2.

### History

The Task 28 run on base `8d3689b` (13 October 2026) recorded `tests 500`, 15 end-to-end steps, a
22-scenario browser gate and 86 sealed definitions, and its browser gate was **flaky** that day: three
full-suite runs gave 14/16, 15/16 and 16/16, with different scenarios failing and passing in isolation.
That flakiness is not reproduced on this tip — the 45-scenario gate passed 45/45 in a single run — and
the older failed runs are retained as evidence, not converted into passing runs. Logs for the earlier
gates are kept outside the repository under `work/verification/task-28-*`.

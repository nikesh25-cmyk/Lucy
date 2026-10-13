# NemoWorld release checklist

Task 28 — production readiness package. Applies to this repository's deployment: one Node 24 process
with one SQLite database, configured by `render.yaml` and released to a host such as Render.

Every gate below is **named**, has a **real command**, and states the **expected result**. All of them
were run on 13 October 2026 on the base commit `8d3689b` (`verify-batch02-wave-b`), on the machine named
in the handoff, and the actual results — including the one gate that is currently **red** — are recorded
in §7 and in `docs/handoff/task-28-production-readiness.md`.

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
| G1 | Syntax gate | `npm run check` | exit code 0, no output. Every shipped module parses under Node 24. |
| G2 | Unit and integration suite | `npm test` | `tests 500`, `pass 500`, `fail 0`, `skipped 0`, `cancelled 0`. The count must not drop below the base's 500; a deliberate change to the expected number is recorded in the handoff, never silently. |
| G3 | HTTP acceptance, end to end | `npm run e2e` | `SUMMARY  15 steps passed, 0 failed` and `result  PASS`. The harness serves a real public-origin first-administrator scenario over its own HTTP API on a temporary database. |
| G4 | Browser acceptance | `npm run browser` | `SUMMARY  22 passed, 0 failed`, `result  PASS`, and `the shipped data/world.sqlite` reported `untouched`. **Flaky on this base: three full-suite runs gave 14/16, 15/16 and 16/16, with different scenarios failing and passing in isolation — see §7. Do not release on a run below 22/22; the fix belongs to the browser-suite owner.** |
| G5 | Content seal | `node scripts/seal-content.mjs --check` | `Verified: 86 definitions (…); 3 support files; 42 referenced notices and assets.` and exit code 0. |
| G6 | Recovery and failure drills | `node scripts/ops-rehearsal.mjs` | one `PASS` line per drill — `recovery-point`, `corrupt-backup`, `migration-rehearsal`, `interrupted-worker`, `model-queue-saturation`, `storage-limit`, `diagnostics-redaction` — and exit code 0, on a disposable workspace only. |
| G7 | Capacity evidence probe | `npm run capacity` | prints the hardware, the fixture, the concurrency, the HTTP percentiles and failures, the browser-suite result and the model-queue bound; exits 0 when every bounded budget holds. Evidence to record, **not** a capacity guarantee. |
| G8 | Runtime database integrity | `node --test tests/startup-integrity.test.js` | Real server startup refuses corrupt, foreign and newer databases before writes/listening; a valid existing world starts with its audited records preserved. The runtime check holds the process lock. |
| G9 | Schema agreement | `node scripts/recovery.js verify <database>` | `{"schema_version":18,"accounts":N}` — the same version this build writes, and a non-zero account count on a live world. |
| G10 | Archive privacy | `tar -tzf <archive>.tgz \| grep -E '(^\|/)(data\|\.runtime\|backups\|test-results)/\|\.sqlite\|\.env$'` | no output (nothing matched). If anything matches: **do not publish**. |
| G11 | Published-surface sanity | open `https://<origin>/api/v1/health` and `https://<origin>/api/v1/bootstrap` | `health` returns `status: "ok"` with aggregate counters only; `bootstrap` returns `setup_required: false` after the administrator exists, and **never** the setup code; `/api/v1/operations` returns `401`/`403` to anyone but an administrator. |

G1–G6 are the release-blocking gates. G7 is evidence. G8–G11 are the deployment checks.

Recommended: run G1–G6 on the exact commit you deploy, and record the command, the exit code and the
tail of the output next to the release. An untested release is not a release.

## 3. Migration order

Current schema: **18**. `src/database.js:18` refuses any database above 18, and `src/recovery.js:270-271`
accepts versions 1–18 and re-checks each version's tables, columns, triggers and invariants.

**This release changes no schema.** Tasks 27 and 28 add diagnostics, drills, configuration and
documentation only; the schema stays at 18 and no migration step is introduced. If you are already at
18, skip to §4.

Where a database is older, the order is fixed. **Stop the server and back up first — always.**

| Step | Command | Expected |
| --- | --- | --- |
| 1. Announce and stop | stop the service (Render: a deploy drains and sends `SIGTERM`; locally Ctrl-C). Confirm the process is gone. | no `server.lock` held by a live process. Never delete the lock by hand. |
| 2. Back up | `node scripts/recovery.js backup <database> <backups>/pre-migration-$(date +%s).sqlite` | one JSON line with the backup path, exit 0, file mode `0600`. |
| 3. Verify the backup | `node scripts/recovery.js verify <backup>` | `{"schema_version":<old>,"accounts":N}` — if this fails, stop: you have no rollback. |
| 4. Rehearse on a disposable copy | `node scripts/ops-rehearsal.mjs --drill migration-rehearsal` | `PASS  migration-rehearsal` — a schema-17 copy migrates to 18 additively with every record intact. |
| 5. Start the new release | deploy, or `npm start` | the migration runs inside one `BEGIN IMMEDIATE … COMMIT`; an interrupted migration leaves the old version in place, not a half-migrated database. |
| 6. Verify the migrated world | `node scripts/recovery.js verify <database>` | `{"schema_version":18,"accounts":N}` with the **same N** as step 3. |
| 7. Verify the world's own integrity | Administration → **Operational health** | `database check · ok`, `audit_chain_valid` and `coin_ledger_valid` both true, and the expected account/plot/coin/quest/guild counts. |
| 8. Unpause | confirm the platform is not paused and a member can sign in | one ordinary human action succeeds after the migration. |

Ordering notes:

- 15 → 16 → 17 → 18 each migrate automatically and additively the first time a `Platform` opens the
  file. You do not run them one at a time; but you **do** back up before the first open by the new build.
- The published historic order is: 14 → 15 (country ambassadors), 15 → 16 (resident runs), 16 → 17
  (quest chains), 17 → 18 (guild projects). A world at 13 or below passes through the same sequence in
  one startup transaction.
- Growth is one-way: a backup taken at schema 17 is restorable by this build (it migrates on open), but
  this build's schema-18 database is **not** readable by an older build (`src/database.js:18`). Rolling
  the code back after a migration therefore also means restoring the pre-migration backup.

## 4. Rollback and recovery

Three levels, cheapest first.

**A. Roll back the code (no data change in this release).** Because schema 18 is unchanged, redeploy the
previous known-good commit; the database is untouched and no restore is needed. In Render: revert the
`autoDeployTrigger` approval or deploy the earlier commit explicitly. Verify with G9 and G11.

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
| The release is worse but the data is fine | — | level A: redeploy the previous commit |

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

## 7. Gate results on this base (13 October 2026)

| Gate | Result | Detail |
| --- | --- | --- |
| G1 `npm run check` | **PASS** | exit 0, no output, 4.8 s |
| G2 `npm test` | **PASS** | `tests 500`, `pass 500`, `fail 0`, `skipped 0`, `cancelled 0`, `duration_ms 70768` (a slower earlier run took 130.3 s on the same shared machine) |
| G3 `npm run e2e` | **PASS** | `SUMMARY  15 steps passed, 0 failed`, `result  PASS` |
| G4 `npm run browser` | **FLAKY — 3 full-suite runs: 14/16, 15/16, 16/16** | Different scenarios failed in different runs and each passed in isolation, so this is an order/timing race, not a fixed defect and not something this task introduced (its diff touches no server, UI or suite file). Run 1 failed `plot-and-blueprints` (page log: `429 POST /api/v1/move`, the 120 ms movement throttle at `src/spaces.js:171`, so the resident never reached the plot) and `quest-progression`; run 2 failed only `subscription-entitlement-and-revocation` (timeout waiting for a re-subscription; page log shows a `403` on the fresh `/events` subscribe); run 3 passed 16/16 in 95.3 s; an isolated 3-scenario run passed 3/3. **Owner: the browser-suite/task-15/16 work.** These are historical failed runs. Current releases require the integrated 22-scenario gate; diagnose a failure and preserve its evidence before rerunning. |
| G5 content seal | **PASS** | `Verified: 86 definitions (20 appearance, 7 block, 29 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.` |
| G6 failure drills | **PASS** | `7/7 drills passed` in 9.7 s: `recovery-point` (834 ms), `corrupt-backup` (877 ms), `migration-rehearsal` (1350 ms), `interrupted-worker` (4731 ms), `model-queue-saturation` (556 ms), `storage-limit` (674 ms), `diagnostics-redaction` (487 ms), exit 0, on a disposable workspace |
| G7 capacity probe | **PASS as evidence** | exit 0; Apple M5, 10 CPUs, 16 GiB, Node 24.19.0; HTTP 59.59 / 52.87 / 62.25 req/s at 1 / 8 / 32 clients with 0 failures and 0 timeouts inside the 0 % budget; browser suites 1 → 30.6 s, 2 → 39.4 s, all passed; model queue 9 admitted / 3 refused / peak waiting 8 of 8 with no real model. Full tables: `docs/PRODUCTION_READINESS.md` §7 |
| G8 runtime integrity gate | **PASS (integration review)** | corrupt, foreign and schema-99 files refused unchanged before listening; valid schema-18 restart preserved audited records. See `tests/startup-integrity.test.js`. |
| G9 `recovery.js verify` | **PASS** | `{"schema_version":18,"accounts":0}` on a freshly created disposable database |

Logs for every gate in this table are kept outside the repository, under
`work/verification/task-28-*` (see the handoff).

### Current integrated gate evidence

The original Task 28 measurements below describe its 16-scenario base. Task 17 adds interaction coverage; the integration review adds proposal-retirement coverage, giving 22 scenarios. Its current results and remaining limitations are in `docs/reviews/batch02-integration.md`; historical flaky runs are retained as evidence, not converted into passing runs.

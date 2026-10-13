# Task — security and privacy hardening (browser session, origin checks, backup validation, redaction)

Delivered on branch `task-deepseek-security-privacy`, based on `codex/final-integration` at `f773c46`
("Bind native missions and chat to paired avatar"). **Schema unchanged: version 22.** Six new tests;
the full suite reports **890 tests, 890 passing, 0 failing, 0 skipped**.

The slice asked for real, fail-closed fixes with a named regression test that fails before the fix. Six
such tests were added; each one was run first against the unmodified source and failed (the failure
output is quoted below), then passed after the change. No weakness was invented: one candidate
(`container`/`Host` trust in local mode) was examined and left alone because that mode cannot be
reached off the machine (§4).

## 1. What was delivered, and why

### 1.1 `src/browser-session.js` — the session-end sweep is now the session's own

`clearOperatorState()` is the module that owns "drop operator-visible state when the authenticated
session ends", and its own comment claims a complete sweep. It cleared the private and session state it
named — account, agents, worlds, missions, tasks, history, drafts, callings, quests, guild projects,
blueprints, ambassadors, the operator's own worker records — but not the private material an
authenticated read fills afterwards: resident memory, the evidence library, land data, the review
workbenches, the restoration event, the first-play guide, the current interaction target, the
voxel/parcel selection, the grant preview and the private chat target. The shipped single call site
(`app.js:175`) compensates today by clearing those fields by hand *around* the module call, so nothing
leaked in the shipped build — but the boundary module itself did not do what it says it does, and any
second call site, or the removal of those hand-written lines, would leave another operator's private
state in memory and on screen.

The fix extends the sweep with those 17 fields (and the private chat defaults). No behaviour changes at
the existing call site: it already sets every one of them to the same value immediately afterwards.
State that belongs to the world rather than to a session (the country catalog, camera/graphics
preferences) is still deliberately kept, which the existing test already pinned with
`state.countries`.

### 1.2 `src/hosting.js` — the loopback health exception is decided by the peer, not by a header

`validateRequestOrigin()` is the whole CSRF/origin control (there is no CSRF token). Its one exception
to the public-host rule was:

```js
const internalHealth = request.method === 'GET' && new URL(request.url, 'http://localhost').pathname === '/api/v1/health' && local;
```

`local` was computed only from the **client-supplied `Host` header** (`loopback name + the server's own
port`). With `LUCY_PUBLIC_ORIGIN` configured and the process bound to `0.0.0.0`, any caller that can
reach the port could therefore send `Host: 127.0.0.1:<port>` and be treated as an internal probe,
reaching `/api/v1/health` with a Host the rule otherwise refuses. That discloses the worker, queue and
model counters the threat model and `docs/OPERATIONS.md` keep off the public surface, and it made a
header stand in for the identity of the socket that connected.

The fix adds `loopbackPeer(request)`, which reads `request.socket.remoteAddress` and accepts only
loopback (`127.0.0.0/8`, `::1`, or an IPv4-mapped `::ffff:` form); an absent peer address is refused.
The exception still additionally requires the loopback `Host` and its own port, so the working local
probe (`curl http://127.0.0.1:<port>/api/v1/health`) is unaffected — the existing integration assertion
in the same test file still passes.

### 1.3 `src/recovery.js` — three missing evidence-library checks, all fail-closed

`verifyEvidenceRecords()` is the pass that refuses a tampered backup, a tampered restore or a tampered
startup, and its comment promises that "every stored evidence row must still satisfy the rules that
created it". Three of those rules were not re-checked:

1. **A capture re-pointed at another URL.** The source's own address is re-derived and compared
   (`source_key`, `host`, `path`), and a *citation's* URL is compared with its capture's key, but the
   capture's own `url` column was never compared with the `source_key` it is stored under. A row whose
   URL now names another host or path — while it still claims its original source — validated cleanly.
   The fix re-parses `capture.url`, requires `http(s)` with no credentials and no port, and requires
   `evidenceSourceKey(capture.url) === capture.source_key`, exactly the relation
   `src/platform.js:1045-1046` establishes at write time.
2. **The retained-byte quota.** `EVIDENCE_LIMITS.max_retained_bytes` is documented as "the quota a
   capture write is held to **and the bound the recovery pass re-checks**", and
   `platform.retainedBytes()` is literally `SUM(bytes) WHERE retained=1`. The recovery pass checked the
   source, capture and per-source counts but never the byte total, so a backup carrying more retained
   bytes than the library allows opened without complaint. The fix accumulates the retained captures'
   `bytes` and refuses a total above the quota.
3. **A withdrawn source without its withdrawal.** `evidenceWithdraw()` writes the status change *and* an
   append-only `withdrawn` event carrying the reason; a fresh capture writes the `restored` answer. The
   identity trigger guards only `source_key`/`url`/`host`/`path`, so an ordinary `UPDATE` can set
   `status='withdrawn'` and a plausible reason with no event at all — that state passed validation. The
   fix tallies the append-only events per source and requires the outstanding count
   (`withdrawn - restored`) to be exactly 1 while the source is withdrawn and 0 while it is active,
   refuses a restore that outruns its withdrawal, and requires every event's `detail` to be non-empty
   (both writers always store one).

### 1.4 `src/recovery.js` — the redaction pass now drops the content fields the policy names

`redactDiagnostics()` is the second line of defence for the administrator diagnostics payload. It
dropped a field whose *name* looked like a secret (`SECRET_FIELD`) and replaced a *value* shaped like a
64-character hex token, a `salt:key` digest or an email. `docs/OPERATIONS.md` §10 states what a
diagnostics response may never contain — including "a private message or journal text, a private
artifact, or a raw prompt/conversation" — and none of those names (`message`, `text`, `journal`,
`artifact`, `prompt`, `conversation`, `excerpt`, `transcript`, `body`, `content`, `question`, `answer`,
`passage`) was matched, so text under such a field passed through unchanged.

The fix adds `CONTENT_FIELD`, a final-word rule that drops a field whose last word names narrative
content **while that field carries text or a structure**. A counter that merely mentions one of those
words (`records.ambassador_conversations`, a number) still publishes its number, and the shipped
payload's other names (`state_note`, `journal_mode`, `backup_point`, `replay_policy`) still publish
their values — both directions are asserted.

This one is **defence in depth, not a reachable leak**: every field in the shipped payload is assembled
from named counters in `src/platform.js` and `server.js`, so no narrative content reaches it today. It
closes the gap for the next field a caller adds, which is precisely the failure mode the pass exists
for. `tests/ops-rehearsal.test.js` and `tests/ops-diagnostics.test.js` (which plant secrets and grep the
produced output) still pass unchanged.

## 2. Changed files

| File | Change |
| --- | --- |
| `src/browser-session.js` | `clearOperatorState()` clears 17 further session-scoped fields; the comment states the sweep's contract. |
| `src/hosting.js` | New `loopbackPeer()`; `internalHealth` now requires a loopback peer as well as the loopback `Host`. No other rule changed. |
| `src/recovery.js` | `verifyEvidenceRecords()`: capture URL↔`source_key`, retained-byte quota, withdrawal-event parity and non-empty event detail. `redactDiagnostics()`: `CONTENT_FIELD` + `textOrStructure()`. |
| `tests/browser-session.test.js` | New test 2 (residency/evidence/land/review/build state). |
| `tests/hosting.test.js` | New test 8 (the health exception needs a loopback peer). |
| `tests/recovery.test.js` | New tests 8–11: capture re-pointed, retained-byte quota, withdrawn source without its event, redaction content fields. |
| `docs/THREAT_MODEL.md` | §4 origin/CSRF bullets updated with the peer rule and current line numbers; §8 adds the redaction rule and the browser session-end sweep; §11 test table updated. |
| `docs/OPERATIONS.md` | §10 redaction row states the extended field rule. |
| `docs/handoff/task-deepseek-security-privacy.md` | This file. |

Not touched: `server.js`, `src/platform.js`, `runtime/agent.js`, `app.js`, `game-theme.css`,
`src/community.js`, `src/quests.js`, `src/spaces.js`, `native/**`, `src/database.js`, `catalog/**`, the
farming-slice tests, `.runtime/`, `outputs/Lucy`. No new dependency. No schema change (`PRAGMA
user_version` is still 22; the recovery checks live inside the existing `version >= 22` block).

## 3. Evidence: before and after

The three test files were run against the tree with **only the three changed source files reverted** to
their base revision (`git stash push -- src/browser-session.js src/hosting.js src/recovery.js`), so the
only difference is the fix:

```
$ node --test tests/browser-session.test.js tests/hosting.test.js tests/recovery.test.js   # source reverted
ok 1 - session reset removes operator-visible private state and advances the pending-response epoch
not ok 2 - session reset drops private residency, evidence, land, review and build state
ok 3 - public hosting configuration requires one precise HTTPS origin
ok 4 - public bootstrap protects the first administrator and sets secure proxy cookies
ok 5 - public Host and Origin checks ignore forwarded headers while allowing internal health checks
ok 6 - competing public setup requests cannot create two administrators
ok 7 - authentication limits allow distinct proxy users and bound account attempts and concurrency
not ok 8 - the loopback health exception requires a loopback peer, not only a loopback Host header
ok 9 - SQLite backups recover durable changes and preserve the previous database
ok 10 - restore rejects active server locks and malformed backups
ok 11 - stale process locks are reclaimed and released safely
ok 12 - a validated backup restores over a corrupt original without discarding its bytes
ok 13 - version one backups restore and migrate without losing accounts, avatars or messages
ok 14 - version two state upgrades atomically and version three recovery requires resident tables
ok 15 - process locks recover after a reused PID or a different host boot
not ok 16 - a capture re-pointed at another source URL fails full validation
not ok 17 - a retained-evidence total past its byte quota fails full validation
not ok 18 - a withdrawn source without its recorded withdrawal fails full validation
not ok 19 - the diagnostics redaction drops private content fields and keeps the counters it names
# tests 19
# pass 13
# fail 6

$ node --test tests/browser-session.test.js tests/hosting.test.js tests/recovery.test.js   # with the fix
# tests 19
# pass 19
# fail 0
```

The six failures split into two messages: four `error: 'Missing expected exception.'` — `validateDatabase()`
returned a schema version instead of refusing the tampered database — and two `ERR_ASSERTION` payload
diffs (the session sweep and the redaction). The 13 pre-existing tests pass in both runs, so the new
tests fail because of the behaviour under test and not because of the fixtures.

The rewritten rows are asserted directly, not inferred: the capture tests read
`SELECT url, source_key, retained, bytes FROM evidence_captures` and
`SELECT COALESCE(SUM(bytes),0) FROM evidence_captures WHERE retained=1` before and after the rewrite,
and the withdrawal test reads `SELECT status, withdrawn_reason FROM evidence_sources` together with
`SELECT COUNT(*) FROM evidence_events WHERE source_id=?`. The evidence fixture itself is the real
seeded library: 222 sources, 222 retained captures, no withdrawal event, retained bytes well inside the
96 MiB quota — so each refusal is caused by the rewrite the test performs.

After the fix, the same behaviour holds for legitimate data (asserted by `tests/evidence-library.test.js`,
which still passes: 27/27 in that file plus `tests/recovery.test.js`).

| Test | Asserts |
| --- | --- |
| `session reset drops private residency, evidence, land, review and build state` | every added field is `null`/default, `JSON.stringify(state)` contains no marker, `countries` survives. |
| `the loopback health exception requires a loopback peer, not only a loopback Host header` | a non-loopback peer with `Host: 127.0.0.1:8443`/`localhost:8443`/`[::1]:8443` is refused (403), a missing peer address is refused, `127.0.0.1`, `127.0.0.2`, `::1` and `::ffff:127.0.0.1` peers still pass, the exception never widens the path or method, and the public host is unaffected from any peer. |
| `a capture re-pointed at another source URL fails full validation` | the row is rewritten with the trigger dropped and restored (the same technique `tests/evidence-library.test.js` uses); the URL moves, `source_key` stays, and `validateDatabase` refuses. |
| `a retained-evidence total past its byte quota fails full validation` | one retained capture is rewritten to `max_retained_bytes` bytes; the stored total exceeds the quota and `validateDatabase` refuses. |
| `a withdrawn source without its recorded withdrawal fails full validation` | an ordinary `UPDATE` (no trigger dropped) sets `status='withdrawn'` with a reason and no event; `validateDatabase` refuses. |
| `the diagnostics redaction drops private content fields and keeps the counters it names` | nine content-named fields come back `[redacted-field]`, no marker survives, and `records.accounts`, `records.messages`, `records.ambassador_conversations`, `model.state_note`, `integrity.journal_mode`, `recovery.backup_point` and `recovery.replay_policy` are published unchanged. |

The hosting test unit-tests `validateRequestOrigin` with forged request objects, and the pre-existing
integration assertions in the same file still exercise the real loopback health probe end to end.

## 4. What was audited and found already correct

Checked by reading, and left unchanged (with the pinning tests that already exist or were added):

- **Session cookies.** `Set-Cookie: world_session=…; Path=/; HttpOnly; SameSite=Strict`,
  `Secure` whenever a public origin is configured, `Max-Age` bounded to the 7-day session expiry and
  `Max-Age=0` on logout (`server.js:190-194`, not in this slice's scope). `tests/hosting.test.js`,
  `tests/http.test.js` and the e2e/browser harnesses assert the flags.
- **Token parsing.** A cookie or `Authorization` value must be exactly 64 hex characters before it
  reaches the database (`server.js:186-191`, `src/platform.js:156-159`); an empty or malformed value
  fails closed. No change needed.
- **Forwarded headers.** `X-Forwarded-Host`/`X-Forwarded-Proto` are never read; already asserted.
- **Host parsing.** Whitespace, `@`, `/`, `\`, `?`, `#`, `%` and duplicate-joined Host values are
  refused; an absolute-form request URL cannot change which route is taken.
- **Local mode (no public origin).** The host rule there is still header-based, and this was examined
  as a candidate weakness and deliberately left: `hostingConfiguration()` refuses
  `LUCY_BIND_HOST=0.0.0.0` without a public origin, so that mode is only reachable over loopback, and
  tightening it to a loopback peer would break a containerised local setup where the browser reaches
  the published port through the bridge gateway.
- **Redaction value shapes.** The 64-hex, `salt:key` digest and email patterns already cover every
  credential shape this application produces (tokens and token hashes are SHA-256 hex, passwords are
  `scrypt` `salt:key`, contact data is an email). Unchanged.
- **Authentication limiter.** Global, per-peer, per-account and concurrency bounds with a bounded
  10,000-entry map and 60-second windows; unchanged.
- **`validateDatabase` per-version checks** for schemas 1–22 (triggers, views, cross-table identity,
  foreign keys, the audit hash chain) were read version by version; the three findings above are the
  gaps that were found.

## 5. Residual limits — what this does not fix

**No system is unhackable, and this one is not.** These are the limits that remain after this work:

- **Nothing here is a penetration test.** The changes are code review plus tests. No external audit was
  performed and no attacker was simulated.
- **The browser gate did not complete clean on this host.** See §7: three full-suite runs and one
  focused subset were cut short by Chrome closing or by the suite's own 25 s DOM waits, under load
  averages of 29–54 with 59 concurrent Chrome processes and ~30–90 MB of free memory. Every scenario
  that failed inside a batch passed when re-run alone on the same tree. What the change relies on in a
  browser — the sign-out sweep and the anonymous observer path — is carried by `signout-privacy`,
  `accounts-and-switching`, `game-entry-and-observation` and `live-observation-readonly` passing, not by
  a 39/39 run.
- **A stolen live session is still a valid session**, and a database or host administrator can still
  read or rewrite anything with tools that bypass the application (the new recovery checks raise the
  cost of a *tampered backup*, they do not protect the live file or the host).
- **The redaction change is defence in depth.** No field in the shipped diagnostics payload carries
  narrative content today, so it changes no observable output; it closes the gap for a caller that adds
  such a field later. The pass remains a name/shape heuristic: a private value stored under an
  invented field name still escapes it.
- **No CSRF token.** The origin/host rule plus `SameSite=Strict` remains the control — unchanged, and
  still a deliberate trade rather than a claim that CSRF is impossible.
- **The loopback health rule is now strict about the peer.** A deployment whose health probe genuinely
  arrives from a non-loopback address with a loopback `Host` (for example a proxy that rewrites `Host`
  to `127.0.0.1` while connecting from another host) will now get `403` on `/api/v1/health`. That is the
  intended fail-closed direction; use the configured public host for such a probe.
- **Rate limits stay per process and per peer**, so a proxy that presents one peer identity shares one
  budget, and a distributed attempt is bounded only, not stopped.
- **`validateDatabase` re-checks declared metadata, not retained bytes.** The retained-byte check sums
  the stored `bytes` column; it does not re-read the file under `catalog/` to prove the size or hash.
  The application does that at capture time, and `integritySnapshot()` covers file-level corruption
  separately.

## 6. Migration and rollback

No schema change, no data migration: every fix is in the serving path or in a validation pass, and
`PRAGMA user_version` stays 22. Rollback is `git revert` of the single commit; no database state
depends on it.

A database written by this application continues to validate, because each new check re-states a rule
the write path already enforces: capture URLs are written from the same URL that produces their
`source_key`, retained bytes are admitted only while `retainedBytes() + bytes <= 96 MiB`, and a
withdrawal is always written with its own event. Only a rewritten row, an over-quota copy or a source
state the application never created can now be refused — and `tests/evidence-library.test.js`,
`tests/ops-rehearsal.test.js` and the migration/restore tests confirm the legitimate paths still pass.

## 7. Commands run, with their real output

```sh
npm run check
# exit 0 — every file passes node --check, including src/recovery.js, src/hosting.js,
# src/browser-session.js and scripts/*.mjs

npm test
# # tests 890   # pass 890   # fail 0   # cancelled 0   # skipped 0   # todo 0
# # duration_ms 386130
# 884 of those are the suite as it stands; the 6 added here are the ones listed in §3.
# (An earlier run of the same tree reported the same 890/890/0 with duration_ms 295659.)

npm run e2e
# exit 0
# SUMMARY  17 steps passed, 0 failed
# PASS 1..17 (bootstrap gate … one shared restoration step with two actors, restart persistence)
# PASS cleanup: server stopped, process lock released, temporary workspace removed
# The harness starts the real server with LUCY_PUBLIC_ORIGIN set and probes /api/v1/health with the
# public Host, which the changed rule still serves.
```

### The browser gate on this host

`npm run browser` (real Chrome 155.0.8059.40, 39 scenarios) was run four times on this worktree and
**never completed a clean full pass**, entirely in two infrastructure failure modes: Chrome being closed
mid-run (`Target page, context or browser has been closed`, after which every later scenario fails
instantly) and single scenarios exceeding the suite's own 25 s wait for a DOM element. No failure was an
assertion about the behaviour this change touches, and **every scenario that failed inside a full run
passes when re-run alone on the same tree**:

| Scenario | Failed in | Re-run alone on this tree |
| --- | --- | --- |
| `guild-cooperation` | full run 1 (`locator.fill` timeout) | `PASS` (19 s) |
| `interaction-door-and-crafting` | full run 1 (browser closed, cascade) | `PASS` (24 s) |
| `signout-privacy` | full run 1 (browser closed, cascade) | `PASS` (18 s, and again at 57 s inside a focused subset, and in full run 2) |
| `live-observation-readonly` | full run 2 (25 s wait for `#game-observer-status`) | `PASS` (10 s) |
| `restoration-two-clients` | full run 2 (25 s wait for the restoration panel) | `PASS` (20 s) |
| `management-interface-and-roles` | focused subset (25 s click timeout) | `PASS` (32 s), and `PASS` in full run 2 |

Runs 3 and the focused subset both cut short when Chrome died. The host was under extreme load
throughout: `uptime` reported load averages of **29–54** with 59 concurrent Chrome processes and roughly
**30–90 MB of free memory** — other worktrees on this machine were running their own suites
concurrently. The repository already records this suite as load-sensitive
(`docs/handoff/fix-browser-suite-flake.md`: on the untouched base, **1 of 7** runs failed idle and **3 of
5** failed with 8 CPU hogs present). The scenarios that did complete passed, including every one that
exercises the changed code directly: `accounts-and-switching` (sign-out revokes the session and clears
local operator state), `signout-privacy` (the scenario that asserts sign-out clears cached private
quests, guilds, blueprints and land state — the sweep this change extends), `game-entry-and-observation`
and `live-observation-readonly` (the anonymous observer path).

Two of the three changed files cannot reach the failing code even in principle: the browser suite starts
the server with `LUCY_PUBLIC_ORIGIN` unset, so `validateRequestOrigin` takes its local-mode branch and
the `internalHealth` value this change alters is never consulted; and `clearOperatorState` is called
only when a session ends, which no failing scenario reaches except the sign-out scenario that passes.

This is reported as it happened rather than as a green gate. On an idle host the suite passed 37 of 39
scenarios in run 2, and the two failures passed immediately afterwards in isolation.

## 8. Where this leaves the branch

One commit, `Fail closed on session, origin, evidence and redaction gaps`, on
`task-deepseek-security-privacy` on top of `codex/final-integration` at `f773c46`. Schema 22 unchanged,
no new dependency, no file outside §2 touched. The focused patch is
`patches/task-deepseek-security-privacy.patch`.

`npm run check` exits 0, `npm test` reports 890/890 passing with 0 skipped, `npm run e2e` reports 17
steps passed and 0 failed, and the six new tests fail on the previous revision and pass on this one. The
only gate that did not complete clean here is the Chrome suite, for the host-load reasons recorded in
§7; every scenario that failed in a batch passed alone on the same tree.

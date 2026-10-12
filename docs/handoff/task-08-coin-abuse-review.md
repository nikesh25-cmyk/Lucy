# Task 08 — coin and reward abuse review

Branch `task-08-coin-abuse` (worktree `work/t08`), based on `task-06-guild-projects`. Schema is
unchanged at **18**; this task adds no table, column, view or trigger. One verification function was
tightened and one new test file was added.

Scope is the existing internal coin ledger (`src/coins.js`), the cosmetic calling/quest experience
(`src/journey.js`, `src/vocations.js`, `src/quests.js`), the mission review path (`src/platform.js`)
and backup verification (`src/recovery.js`). No payments, token sales, cash-out, blockchain or
substitute authorization was introduced. The audit covered the ten named surfaces, and every
verdict below was reached by running the real path, not by reading alone.

## How to read the verdicts

- **Demonstrated** — an automated test exercises the real server path and asserts the outcome; the
  test is named. For every refusal, the control was temporarily disabled and the test was confirmed
  to fail (see *Refusal tests are load-bearing*).
- **Reasoned** — the code was read and the argument is given, but no end-to-end test isolates it.

A system cannot be called unhackable. Every residual risk is stated at the end.

## Threat model

| # | Surface | Control | Verdict | Proof |
|---|---------|---------|---------|-------|
| 1 | Self-review | `src/platform.js:409` refuses a review when `submission.account_id === actor.account.id`; the ledger's own SQL repeats it (`src/coins.js:12` `reviewer.id!=c.account_id`, `assigned.id!=c.account_id`) | Holds (demonstrated) | `tests/coin-abuse.test.js` › *a contributor, their sibling character and an administrator cannot accept their own contribution* |
| 2 | Multiple agents under one operator | Per-operator daily cap in the insert trigger (`src/coins.js:13`) and in `awardCoins` (`src/coins.js:45`); global `fingerprint UNIQUE` (`src/coins.js:6`, `:26`); five-agent cap (`src/platform.js:183`); one active claim per operator (`src/platform.js:349`) | Holds (demonstrated) | › *several characters under one operator share one wallet cap and one duplicate-work rule* |
| 3 | Repeated submissions / reviews | One active claim per task (`src/database.js:27`); submission versions increment (`src/platform.js:396`); a version is reviewed once (`src/platform.js:411`); the wallet counts only the latest version and latest review (`src/coins.js:16` `MAX(version)`, `ORDER BY created_at DESC,rowid DESC`); `task_id`/`submission_id`/`review_id` are `UNIQUE` (`src/coins.js:6`) | Holds (demonstrated) | › *a replayed review, a replayed submission key and a key reused for other work cannot multiply receipts* |
| 4 | Replay keys | Claim keys are per operator and per task (`src/platform.js:341-342`); submission keys are per claim and return the stored row (`src/platform.js:374-375`); follow-up keys carry a fingerprint (`src/platform.js:330-331`); quest-join keys are per operator and chain (`src/quests.js:292-293`) | Holds (demonstrated) | Same test as #3, plus the terminal `duplicate_work` check (`src/coins.js:26`) in test #2 |
| 5 | Concurrent requests | One synchronous writer in one transaction: `BEGIN IMMEDIATE` (`src/platform.js:47`), and the whole check-then-write for a write route runs inside one `platform.transaction` (`server.js:361`); the request body is read before the transaction (`server.js:281`) | Holds (demonstrated) | › *simultaneous requests cannot double-award, exceed the daily cap or create two claims* |
| 6 | Suspended / revoked identities | `held` vs `available` projection (`src/coins.js:33`); live eligibility requires `a.status IN ('active','paused')`, `o.status='active'` (`src/coins.js:16`); suspension revokes tokens (`src/platform.js:498`); account suspension revokes tokens (`src/platform.js:569`) | Holds (demonstrated) | › *a suspended or revoked identity earns nothing new and holds the receipts it already issued* |
| 7 | Quarantined evidence | Receipt is held while any submission of the task is quarantined (`src/coins.js:16`); merit derives from live accepted evidence (`src/journey.js:72-78`); an independent appeal restores the same receipt (`src/platform.js:534-543`) | Holds (demonstrated) | › *quarantined evidence holds the receipt and the merit until an independent appeal restores it*; calling-experience hold is `tests/vocations.test.js:83` |
| 8 | Source reuse | `UNIQUE(agent_id,source_kind,source_id)` (`src/vocations.js:47`); the same source cannot feed a second receipt (`src/quests.js:191`) and the same source cannot be re-mediated (`src/vocations.js:55`) | Holds (demonstrated) | › *a saved source is credited once, and calling objectives and quest steps share one ten-a-day limit* |
| 9 | Clock boundaries | Award day derived once from the platform clock (`src/coins.js:45`); the daily limit sums by that stored day (`src/coins.js:13`); equal timestamps break ties by `rowid` (`src/coins.js:16`); the 10-XP/day cap sums by `earned_day` (`src/vocations.js:55`) | Holds (demonstrated) | › *the UTC award day and the hundred-coin cap hold across a midnight boundary and equal timestamps* |
| 10 | Backup tampering | Hash chain plus amount/version/day checks (`src/coins.js:33`); ledger and trigger presence checked by `validateDatabase` (`src/recovery.js:69`) | **Gap found — issued receipts could be fabricated past every gate. Fixed and demonstrated** | › *a modified receipt and a forged receipt crediting the wrong wallet fail wallet, issuance and backup gates* |
| — | Ledger vs cosmetic split | Issuance only in `awardCoins` (`src/coins.js:36-48`); cosmetic experience only in the calling receipt views | Holds (demonstrated) | › *the issued coin ledger and the cosmetic calling experience stay on separate paths* |

## The one gap, and the patch

**Finding (backup tampering, demonstrated).** `verifyCoinLedger` checked only that a receipt row had
not been *edited*: the SHA-256 chain, `amount=10`, `policy_version=1` and
`award_day=substr(created_at,1,10)`. It never re-established that the receipt actually named the
evidence it claims to be issued from. On a database copy, dropping `coins_validate_insert`,
inserting a fabricated receipt with a recomputed chain, and re-creating a trigger with the same
name passed `validateDatabase` and `backupDatabase` untouched — reproducing the task's
"forged ledger passing backup verification" case. Any forged receipt pointing at real-but-ineligible
evidence (an unrewarded practice submission, another operator's accepted work) passed the gates.

**Patch (`src/coins.js:15-32`, one new query).** `verifyCoinLedger` now also refuses a stored
receipt unless the rows it names still agree with it: the review must belong to that submission and
be `accepted`, the reviewer must not be the credited operator, the claim's task/resident/operator
must equal the receipt's, the credited identity must be an agent owned by that operator when the
`kind` column exists, and the submission must be `accepted` or `quarantined`.

Deliberately **not** re-tested, because those are the fields that legitimately change after issuance
and are represented as *held* rather than void: account/agent status, reviewer role, quarantine,
mission practice scope and task version. Re-testing them would wrongly invalidate honest receipts —
and the pre-existing `tests/journey.test.js` mutation of `missions.demo` confirmed that risk during
development. The check is version-aware: schema 9 has no `agents.kind`, so that clause is added only
when the column is present (`src/coins.js:21`).

Because the check lives in `verifyCoinLedger`, the strengthened condition is enforced by the wallet
route, by the issuance gate in `awardCoins`, by `operations`, and by `validateDatabase` — one
change, four gates. No schema change is required, so a pre-change database needs no migration; the
existing round-trip is exercised by `tests/recovery.test.js` and by the new test's
`backupDatabase`/`validateDatabase` steps, and the schema-9 backup validation in
`tests/human-players.test.js` still passes.

## Refusal tests are load-bearing

The forged-receipt assertions fail if the control is removed. Verified by temporarily replacing
`return !db.prepare(receiptIntegrity(db)).get();` with `return true;` in `src/coins.js` and rerunning
`node --test tests/coin-abuse.test.js`: **9 pass, 1 fail** (only *a modified receipt and a forged
receipt crediting the wrong wallet fail wallet, issuance and backup gates*), then restored to
**10 pass, 0 fail**. The other refusals (self-review, replay, suspension, quarantine, source reuse,
the cap race) are likewise asserted against the real path, and their controls are covered by the
unchanged 419-test baseline.

## Residual risks (none of these are closed)

1. **A fully consistent forgery is undetectable by row checks.** An attacker with database write
   access can still create a matching accepted submission, review and claim, then a receipt; the
   structure would be self-consistent. The patch raises the bar to "fabricate the whole subgraph",
   not to "impossible". Per `docs/COINS.md`, a compromised server or direct filesystem access is
   out of scope; a hash chain is an integrity check, not consensus.
2. **A database-level attacker can delete or truncate the ledger.** Receipts are append-only *through
   the API*; dropping tables or triggers is outside that boundary.
3. **Semantic originality is not established.** Exact-duplicate detection normalizes Unicode, case
   and whitespace (`src/coins.js:26`). One altered character is a different fingerprint. This is
   stated policy, not a defect.
4. **The submission and report rate limits still use SQLite's wall clock** (`src/platform.js:377`,
   `:477` `date('now')`) while reward accounting uses the platform clock. In production both are
   `Date.now` in UTC, and this cannot multiply coins — the 100/day cap is enforced by the ledger
   trigger against the stored `award_day` regardless of how many submissions arrive. It is an
   inconsistency, not a reward vector, so it was left unchanged to keep the patch minimal.
5. **Colluding independent human reviewers** remain the weakest link; an honest-looking acceptance
   from a different operator is credited. Admission control and human judgement are the control.
6. **Reasoned, not exercised end-to-end:** the `code` path where two award attempts for one operator
   race the cap cannot arise through the API (one active claim per operator, `src/platform.js:349`);
   the test constructs the second claim directly. The serialization argument is otherwise
   demonstrated by the two same-submission reviews and the shared-key claims.

## Gates (exact output)

```
$ npm run check
> nemoworld@1.0.0 check
> node --check server.js && node --check scripts/local-launch.mjs && node --check src/platform.js ... && node --check src/placement-policy.js
(exit 0)

$ npm test
ℹ tests 429
ℹ suites 0
ℹ pass 429
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0

$ npm run e2e
SUMMARY  12 steps passed, 0 failed
  coins            one fixed 10-coin receipt for an independently accepted contribution; ledger integrity verified
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API

$ node scripts/seal-content.mjs --check
Verified: 86 definitions (20 appearance, 7 block, 29 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.
```

Baseline was 419 tests and 12 e2e steps; the 10 new tests bring the total to 429 with no failures.

## Changed files

- `src/coins.js` — `receiptIntegrity` structural check added to `verifyCoinLedger`.
- `tests/coin-abuse.test.js` — new; ten tests covering the ten surfaces and the ledger/cosmetic split.
- `docs/COINS.md` — one sentence recording what ledger verification now covers.
- `docs/handoff/task-08-coin-abuse-review.md` — this report.

## What was not done / could not be tested

- No live browser QA was run for this task; the surfaces are backend authorization and ledger
  accounting, and the HTTP-level concurrency and refusal behaviour is covered by
  `tests/coin-abuse.test.js`.
- No schema change and therefore no new migration; a pre-change database is validated forward by the
  unchanged `validateDatabase` path and the existing recovery tests.
- The guild contribution and quest step paths were checked to write nothing to `coin_rewards`
  (`tests/guilds.test.js`, `tests/quests.test.js`, and test #8 here); their own peer-confirmation
  rules are tasks 05 and 06 and were not re-litigated.

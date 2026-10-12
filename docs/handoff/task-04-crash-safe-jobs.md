# Task 04 — Crash-safe bounded resident jobs

Branch `task-04-crash-safe-jobs`, stacked on the verified task 01/02/03/07 tip (`5f83a00`).
Baseline at that tip: **391 tests, 0 failures**; syntax gate, e2e harness and content seal green.

The problem: the managed resident worker runs bounded AI sessions over real HTTP writes, but its run
state lived only in the process (`residentRuns` map) and in a `jobs` row that said `running`. If the
process died mid-run, the next start could not tell whether a model call was in flight, whether an
action had already been accepted by the server, or whether nothing had happened at all — and a
resumed or retried run could silently repeat a placement, RSVP, claim or submission write.

## 1. State model (schema 16)

New table `resident_runs`, one row per managed resident run (created inside the `/residents/run`
transaction in `server.js` with the fresh runtime credential; the runtime reports every later
transition into it). It is additive: `src/database.js` writes `PRAGMA user_version=16`, refuses
any database above 16, and creates the table with `CREATE TABLE IF NOT EXISTS` inside the migration
transaction, so a pre-change database migrates forward in place.

| Column | Meaning |
| --- | --- |
| `id` | the job id created for this run; the `jobs` row and the run record share it |
| `account_id`, `agent_id` | the operator and the bound character |
| `permission` | `observe`, `explore` or `creative` — the recorded mode a resume re-uses |
| `status` | `running`, `completed`, `stopped`, `failed` or `interrupted` |
| `phase` | **what was in flight at the last write**: `starting`, `observing`, `model_call`, `dispatch`, `confirmed`, `finished` |
| `interrupted` | the classification recovery wrote, or `''` while the run has not been recovered |
| `stop_reason` | `call_limit`, `credential_budget_exhausted`, `revoked_or_expired`, `canceled_or_duration_limit`, `unavailable_or_invalid_action`, `paused_revoked_or_unavailable`, `process_restart`, `runner_unavailable` |
| `decision`, `decision_budget` | decisions begun, and the granted model-decision budget |
| `model_calls`, `action_count` | **actual** model calls dispatched and **actual** server-confirmed actions |
| `failed_calls`, `failed_actions` | model calls that errored, and actions the server refused or that failed |
| `last_action`, `pending_action` | JSON: the last server-confirmed action (name, decision, idempotency key, timestamp) and the action currently being sent |
| `credential_hash` | SHA-256 of the run's runtime token — the same value `tokens.hash` already stores. **The token itself is never written.** |
| `minutes`, `resumed_from`, `started_at`, `updated_at` | granted duration, the interrupted run this one continues, timestamps |

`decision_budget` is stored, so the remaining decisions of an interrupted run are derived
(`decision_budget - model_calls`) instead of copied and going stale. Remaining API budget is read
from the run's own `tokens` row (`max_calls - used_calls`).

`src/recovery.js` validates version 16: the columns exist, `status`/`phase`/`interrupted`/`permission`
are in their closed sets, counters are consistent (`action_count <= model_calls <= decision <=
decision_budget`, failed counters within `model_calls`), both JSON blobs are objects, `credential_hash`
is empty or 64 lowercase hex, a finished status carries phase `finished`, an `interrupted` status
carries a classification, and every `resumed_from` points at an interrupted run. A backup taken
while a run is live still validates.

## 2. Interruption policy

**On every process start**, `Platform.initCivic()` calls `recoverWorkerJobs()`, which now classifies
each `jobs` row left in `running`:

| Last durable `phase` | Classification | What it means |
| --- | --- | --- |
| `model_call` | `model_call_in_flight` | a model request had been dispatched; no action was sent for that decision |
| `dispatch` with a recorded pending action | `action_dispatched_unconfirmed` | an action was being sent and its confirmation was never recorded — verify it in the world before retrying |
| `confirmed` (or `observing`/`starting` with a confirmed action) | `action_confirmed` | the last server-confirmed action is recorded and nothing was pending |
| `starting`/`observing` with no confirmed action | `no_action_yet` | the run had begun; the server had not confirmed anything |
| missing row, or any unrecognized phase | `unknown` | nothing durable matched this job; treat it as unresolvable |
| no `resident_runs` row at all | `unknown` (job marked `stopped`) | the existing research-worker path, unchanged |

Recovery then, in the same restart transaction:

1. marks the job `interrupted` with a detail built from the classification and the real counters;
2. writes the classification and `stop_reason='process_restart'` into the run record;
3. **revokes the orphaned runtime credential** by its stored hash, so the process that died cannot
   keep using a credential the new process knows nothing about;
4. audits `resident.run.interrupted` once.

Recovery **never re-dispatches anything**: it has no model, no runner and no stored action to send.
The classification is written once; a second start finds no `running` job and returns 0 changed rows.

**What a human must do.** Resuming is a separate, explicit endpoint:
`POST /api/v1/residents/resume` (operator session only, one worker at a time, a local model must be
configured). It resolves the operator's most recent interrupted run that has no successor, then:

- refuses when there is no interrupted run (a run that completed, failed or was cancelled by a human
  is never resumable);
- refuses when the character is paused, revoked or otherwise not active, and when the platform is
  paused (`platform.runtime` re-checks both);
- refuses when the interrupted run used its whole model-decision or API budget;
- refuses when the interrupted run's credential is somehow still usable (that would mean another
  process is alive);
- **mints a fresh runtime credential** through the existing `platform.runtime` path — the old token
  was revoked at restart and can never resume — and starts a new bounded run with the *remaining*
  decisions, the remaining minutes (minimum one) and the recorded permission mode;
- links the new run to the old one with `resumed_from`, so the interrupted run cannot be resumed
  twice;
- never replays a stored action. The resumed run observes the current world again and lets the model
  decide afresh; the last confirmed action stays visible in history as a fact, not as a task.

**Deliberately not automated** (and why):

- No automatic continuation after a restart. The world may have changed, the credential is gone and
  the operator is the only party that can decide whether the work should continue.
- No automatic retry of `action_dispatched_unconfirmed`. The record cannot prove whether the write
  landed; guessing either way would duplicate a write or lose one. The operator sees the run as
  `interrupted · action_dispatched_unconfirmed` and checks the world.
- No automatic replay of the last confirmed action on resume. The world's own idempotency (`Idempotency-Key`
  on claims, submissions, drafts and follow-ups; `UNIQUE`/primary-key no-ops on RSVPs, pledges, circle
  membership and frontier cells; the mutation budgets) makes a repeat of a *specific* write safe, but
  not repeating it at all is stronger, so the runtime does not replay.
- No cross-process takeover of a live run. Two processes must never run the same resident; the
  existing one-worker-per-operator and one-active-credential rules plus the process lock stay in
  force, and a run whose credential is still live is refused at resume.

## 3. Never silently repeating a write

1. **Durable confirmation record.** The runtime reports `phase:'model_call'` *before* dispatching a
   model request, `phase:'dispatch'` with the pending action *before* sending it, and
   `phase:'confirmed'` with the confirmed action *after* the server answers. A crash therefore leaves
   a record of exactly what had been sent and what had been accepted.
2. **Never replay.** Nothing in the restart path, the resume path or the runtime re-sends a recorded
   action.
3. **Existing idempotency, reused.** Every runtime write now carries a deterministic
   `Idempotency-Key` (`writeKey(runId, decision, path, body)` in `runtime/agent.js`): the same run,
   decision, endpoint and body always produce the same key, so a retried request is recognisable as
   the write already sent. The server already honours that header on `/claims`, `/submissions`,
   `/drafts/resume` and `/tasks/follow-up`; the world's other runtime writes are idempotent or refused
   when repeated — `frontierBuild` returns `changed:false` for the identical block, `frontierExpand`
   returns `created:false`, `circleMembership`/`eventRSVP`/`projectPledge` touch their primary-key
   rows only once, `remove_block`/`expand` no-op, `giveThanks` allows one thanks per recipient per
   day, crafting debits real materials — and the mutation budgets bound how often anything can be
   attempted. No parallel dedupe scheme was invented.
4. **Honest counters.** `model_calls` counts calls actually dispatched; `action_count` counts only
   actions the server confirmed; `failed_calls` and `failed_actions` count failures and refusals
   separately. A refused action is never counted as an action, and the receipt names the failures.

## 4. Sensitive tokens

Run state stores `credential_hash` — the SHA-256 value `tokens.hash` already holds — and nothing else
about the credential. Receipts (`jobs.detail`), history (`/history`), the live worker view
(`/workers`) and the account export all omit it. `tests/resident-state.test.js` asserts the token
string appears in no `resident_runs` row, no `jobs` row, no history response and no export.

## 5. Files changed

- `src/database.js` — schema 16: guard `> 16`, `resident_runs` table and its three indexes.
- `src/recovery.js` — accepted versions 1–16, the run-state vocabulary, `classifyResidentRun()`, the
  `version >= 16` validation block.
- `src/platform.js` — `startResidentRun`, `recordResidentRun`, `residentRun(s)`, `residentResumePlan`,
  the classifying `recoverWorkerJobs`, `runs` in `history()`, export format `shared-world-account-v16`.
- `runtime/agent.js` — `writeKey()`, `onState` transition reporting, `runId` plumbing, the
  `Idempotency-Key` header, `phase`-aware stop reasons, `failed_calls`/`failed_actions`.
- `server.js` — the durable recorder and receipt detail, `/residents/resume`, the live `/workers`
  view, `residentRunDetail()`.
- `app.js` — the run/history UI: live phase, per-run durable record, classification text and the
  explicit resume control.
- Tests: `tests/resident-crash.test.js` (new, process level), `tests/fixtures/resident-crash-child.mjs`
  (new fixture), `tests/resident-state.test.js` (new), schema-version assertions updated across
  `tests/`, one `/workers` expectation updated in `tests/resident-worker.test.js`.
- Docs: this file, `docs/RUNTIME.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `HANDOFF.md`.

## 6. What was tested

- **Process death after a confirmed action does not duplicate it.** `tests/resident-crash.test.js`
  spawns a real second process that starts a managed resident over HTTP, receives its own credential,
  performs one RSVP, watches `resident_runs` and then kills itself with `SIGKILL` (uncatchable, so no
  cleanup, no receipt and no revocation run). The parent then asserts: the job is still `running`; the
  run record says `phase=confirmed`, `action_count=1`, `last_action.action=rsvp`; the RSVP exists
  exactly once; after a real restart the job is `interrupted`, the classification is
  `action_confirmed`, the credential is revoked, and the RSVP count is **still 1**. A second test kills
  the process inside the *next* model call and asserts `model_call_in_flight` with the same single RSVP.
- **Resume** — refused without an interrupted run, refused after a clean run, refused when the
  decision budget is spent, refused while the character is paused, refused twice for the same
  interrupted run; a successful resume reports the remaining decisions and minutes, returns no
  credential, links `resumed_from`, and the resumed run does not repeat the stored action.
- **Expired or revoked credentials cannot resume.** Recovery revokes the interrupted run's credential;
  the tests assert `authenticate()` on it throws 401 and that the stored hash row is `revoked=1`.
- **Pause and revocation end work** — pausing the platform stops a running resident
  (`stop_reason=revoked_or_expired`) and revoking the character stops it
  (`stop_reason=paused_revoked_or_unavailable`) with no further decisions.
- **Counters reflect actual calls and actions** — a refused write yields `0 actions` and
  `1 refused actions`; a failing model yields `1 failed model calls` and `0 actions`; the receipt and
  the run record agree.
- **No secrets persisted** — asserted by inspecting the stored rows, history and export.
- **Migration and backup** — a schema-15 database without the table migrates forward to 16 and keeps
  its jobs; `backupDatabase`/`restoreDatabase` round-trip a run record; `validateDatabase` refuses a
  database whose run table was dropped.

### Run/history interface

There is no browser automation in this repository, so the UI is covered by HTTP tests plus a manual
walkthrough. The tests exercise every request the interface makes: `POST /residents/run`,
`GET /workers`, `GET /history` (asserting `runs` is present, carries `last_action`, omits
`credential_hash`, and is empty for another operator) and `POST /residents/resume`.

Manual walkthrough on a disposable database (`LUCY_DATABASE=/tmp/lucy-task04/world.sqlite
LUCY_MODEL_NAME=<installed model> npm start`):

1. Create an account and two agent characters; create a gathering with one character.
2. **My characters → Run with NemoWorld's local AI** for the other character, permission *Explore*,
   one model decision. **My contributions** then shows a run record with the permission, the counters
   (`1 model decisions, 1 confirmed actions`), the stop reason and the last confirmed action.
3. Start a longer run (5 decisions) and watch **My contributions → Refresh runs**: the live line above
   the stop button names the current phase (`waiting for the local model`, `sending one action to the
   world`, `action confirmed by the server`).
4. Kill the server while a run is active (`kill -9 <pid>`), start it again, and reopen **My
   contributions**. The run appears as `interrupted · <classification>` with the plain-language
   explanation, the counters and the last confirmed action, and the **Resume this interrupted run**
   button appears only when decisions remain and no worker is active.
5. Press **Resume this interrupted run**: the run continues with the remaining decisions and the same
   permission mode; the world shows no second copy of the action that had already been confirmed.
6. Pause the character (or the platform) while a run is active: the run ends and reports the pause.

## 7. Residual risks

- **Coverage is process-level, not power-loss level.** The crash tests prove that a `SIGKILL`ed
  process leaves a consistent, classifiable database, and SQLite runs in WAL mode with
  `synchronous=FULL` (verified: `PRAGMA synchronous` returns 2). Durability against a machine power
  loss or storage failure beyond SQLite's own guarantees was not tested.
- **`action_dispatched_unconfirmed` is unresolvable by construction.** The record proves the request
  was sent, not whether the database accepted it. Recovery reports it and never guesses; the operator
  must check the world. The classifier is covered by a unit-level test, not by an end-to-end crash,
  because the window between the two writes cannot be hit deterministically from outside.
- **`Idempotency-Key` is only interpreted by the claim, submission, draft and follow-up routes.** The
  header is sent on every runtime write, but for the other writes the guarantee comes from their
  own uniqueness/no-op semantics and the mutation budgets, not from a generic replay cache — a
  deliberate choice not to invent a parallel dedupe scheme.
- **A resumed run is a new run, not a continuation of the old one.** It re-observes the world; any
  partially completed route or plan is discarded rather than continued.
- **The one-worker-per-operator rule is per process.** Two processes pointed at the same database
  would each think they own the single worker slot; the live-credential check refuses a resume while
  another credential is usable, and the process lock prevents two servers on one database, but the
  worker-slot bookkeeping itself is in-memory.
- **Counters are per run.** Aggregating them into per-character or per-operator totals is not built.

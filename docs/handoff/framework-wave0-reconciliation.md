# Wave 0 handoff — reconciling the capability matrix on the verified base

Wave 0 was a **reconciliation** task, not a build task. The capability matrix in
`docs/framework/wave0-matrix.md` already existed at the verified base `27c0d72`; this branch does not
re-derive it, does not delete a row, and does not edit a line of product code or test code. What it
adds is (1) a provenance header on that matrix, (2) this handoff, and (3) a **measured** record of the
five acceptance gates on this exact base, run on Node 24, rather than the asserted state the brief
carried. **Four of those five gates pass and `npm run browser` fails (44/45, twice, same scenario) —
that is the headline result of this branch; §*Gate status on this base* carries the output.** Two items
the pruning decisions name as "delivered as a failing repro plus an owner patch proposal" were **not**
authored here — see *What was not done*.

## Base and tip

- **Base commit:** `27c0d7297f97c4cd6d2ee157cc80ff931bf35c89` (short `27c0d72`) — branch `feat/world-life`,
  subject *"feat: seed circles, gatherings and a guild project through the living residents"*, database
  schema 25 (`src/database.js:178` sets `PRAGMA user_version=25`; `src/database.js:24` refuses anything
  newer). The matrix's own claims were read at this revision.
- **Branch / worktree:** `framework-wave0-reconciliation` in
  `/Users/nikesh/Documents/Codex/2026-10-15/nemoworld-framework/work/wave0`. The base worktree
  (`.../2026-10-11/i-ve-prepared-automatic-mac-setup/work/Lucy-repo`) was **not** read, written,
  checked out or run against — no command in this work touched it, its database, backups, credentials
  or model weights.
- **Tip commit:** one commit on this branch, `Wave 0: reconcile the capability matrix and gate status
  on the verified base`. It is the commit that contains this document, so its own full sha cannot be
  written into it — writing the sha would change it. The authoritative value is the first line of the
  patch (`From <tip sha> Mon Sep 17 00:00:00 2001`) and `git rev-parse HEAD` in this worktree; the
  change set is exactly the two files below.
- **Changed files:** two new files, both documentation. No source, test, script, config or content
  file was added, edited or deleted, and `git status --porcelain` was empty after the commit.

  | file | change |
  | --- | --- |
  | `docs/framework/wave0-matrix.md` | **new** (was untracked): a 7-line provenance header prepended ahead of the existing content. No existing row, heading or sentence was removed or reworded; the 308 lines that were there are still there, after the header. |
  | `docs/handoff/framework-wave0-reconciliation.md` | **new**: this handoff. |

- **Patch — the exact command that produces it:**

  ```sh
  cd /Users/nikesh/Documents/Codex/2026-10-15/nemoworld-framework/work/wave0
  git format-patch 27c0d72 --stdout > /Users/nikesh/Documents/Codex/2026-10-15/nemoworld-framework/patches/framework-wave0-reconciliation.patch
  ```

## Matrix summary

Recomputed from `docs/framework/wave0-matrix.md` itself (every line whose second `|`-separated field is
one of the status tokens), not from a count carried in prose:

| area | rows | IMPLEMENTED+TESTED | IMPLEMENTED-GAP | IN-CLAUDE-BRANCH |
| --- | --- | --- | --- | --- |
| 1 — Accounts, sessions, identity, permissions, ambassadors | 20 | 18 | 2 | 0 |
| 2 — Physical world: movement, land, building, presence, spatial | 24 | 19 | 4 | 1 |
| 3 — Conversation and AI runtime | 13 | 13 | 0 | 0 |
| 4 — Economy and property (coins, trade, vault, grants) | 13 | 10 | 1 | 2 |
| 5 — Purposeful activity (callings, quests, guilds, civic, evidence, review) | 15 | 12 | 3 | 0 |
| 6 — Server framework seams (request → auth → transaction → audit → observation) | 14 | 5 | 9 | 0 |
| 7 — Operations and acceptance gates (backup, moderation, seal, Luanti, browser) | 14 | 9 | 5 | 0 |
| **total** | **113** | **86** | **24** | **3** |

- The 113 rows against 7 areas reproduce the count the brief states, so the matrix is complete on that
  measure.
- `NOT-IMPLEMENTED` and `UNVERIFIED` are **0 rows** — neither value occurs anywhere in the file.
- Counting every status token rather than the leading one gives 89 `IMPLEMENTED+TESTED`, 24
  `IMPLEMENTED-GAP`, 3 `IN-CLAUDE-BRANCH` (116 tokens over 113 rows): three rows carry a combined
  `IMPLEMENTED-GAP / IMPLEMENTED+TESTED` label for findings reported from two areas
  (`encrypted-backup`, `audit-chain`, `/operations/backup`).
- **The brief says "the seven STATUS values"; the source reports define five** and only three occur.
  The header in the matrix records five and states this discrepancy instead of inventing two more
  statuses. This is a finding for the integrator, listed below.
- **Open questions the matrix could not settle** (detailed in *Open questions* below): whether the
  `heartbeat` `'read'` scope is intended; whether audit belongs inside the transaction wrapper or stays
  a per-helper convention; which route list is authoritative for idempotency keys and for the
  runtime-vs-human refusal; whether `/briefing` and the public `/export` shape are intended public
  surfaces; which of several hand-maintained duplicates is the single source of truth (schema-version
  list, coin eligibility, independence rule); whether the stale schema/seal/capacity figures in three
  documents are to be refreshed; and who sequences the schema-26 karma/shop merge against schema 25.
- One question is **not** from the matrix: the browser gate went red in the full suite on
  `live-observation-readonly` (2 of 2 runs) while passing alone (1 of 1). It is carried as question 10
  and finding 7.

## Gate status on this base

Every row below was **run** on this tree, on the Node the repo requires, and the figures are copied
from the run's own output. The five gates were run **sequentially**, not concurrently, so no gate's
wall time is polluted by a competing suite on the same host. **Four of the five gates pass; the fifth,
`npm run browser`, FAILS on this base — 44 of 45 scenarios, twice, on the same scenario for the same
reason.** That is the measured state and it is reported as it is; nothing here softens it.

| command | ran? | node | observed result | wall time | exit |
| --- | --- | --- | --- | --- | --- |
| `npm run check` (= `node scripts/check-syntax.mjs`) | yes | v24.15.0 | `checked 99 files, 0 failed` | 4 s | 0 |
| `npm test` (= `node --test`) | yes | v24.15.0 | `tests 1074`, `pass 1074`, `fail 0`, `cancelled 0`, `skipped 0`, `todo 0` | 116 s (`duration_ms 115072.56`) | 0 |
| `npm run e2e` (= `node scripts/e2e-smoke.mjs`) | yes | v24.15.0 | `SUMMARY  20 steps passed, 0 failed` | 28 s | 0 |
| `node scripts/seal-content.mjs --check` | yes | v24.15.0 | `Verified: 98 definitions (20 appearance, 9 block, 32 cosmetic, 6 crop, 31 furniture); 3 support files; 42 referenced notices and assets.` | < 1 s | 0 |
| `npm run browser` (= `node scripts/browser-suite.mjs`) | yes — **twice** | v24.15.0 | `SUMMARY  44 passed, 1 failed` both times; the failure is `FAIL  live-observation-readonly — no message may be stored by an observer` (browser-suite.mjs:5512) | run 1 **534 s**, run 2 **474 s** | **1** (both) |

Two further diagnostics were **run** on that failing gate (not inferred, not assumed to be a flake):

| diagnostic | command | observed | wall time | exit |
| --- | --- | --- | --- | --- |
| the failing scenario alone | `LUCY_BROWSER_ONLY=live-observation-readonly npm run browser` | `SUMMARY  1 passed, 0 failed`; the scenario itself 2407 ms, its entry step 551 ms | 15 s | 0 |
| the full gate again | `npm run browser` | `SUMMARY  44 passed, 1 failed` — same scenario, same reason, entry step 6924 ms | 474 s | 1 |

Environment actually used: `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"` → Node
**v24.15.0**, npm 11.12.1, macOS, Apple silicon, load average **4.06 5.36 4.92** (1/5/15) when the run
started and **7.05 9.62 7.90** when it ended. `devDependencies` resolved through this worktree's
`node_modules` symlink (playwright-core present); the browser gate reported `browser 155.0.8059.40` —
the installed Chrome channel with `LUCY_CHROME_PATH` and `LUCY_BROWSER_CHANNEL` unset, so **no browser
was downloaded**. `GET /api/v1/health` answered `"model_configured":false,"model_queue":null` in both
the browser and e2e runs, so **no model ran**. The suite's own scratch database and `test-results/`
(gitignored) were used; the shipped database was untouched.

How these were run (reproducible):

```sh
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd /Users/nikesh/Documents/Codex/2026-10-15/nemoworld-framework/work/wave0
npm run check ; npm test ; npm run e2e ; node scripts/seal-content.mjs --check ; npm run browser
```

### The one failing gate, in its own words

```
FAIL  live-observation-readonly — An anonymous observer sees public activity and can neither build nor control a resident
        reason    no message may be stored by an observer
      · the observer can follow a resident and pan, and every attempt to act is refused — follow then pan;
        writes refused: {"/move":401,"/messages":401,"/frontier/build":401,"/interact":401}
SUMMARY  44 passed, 1 failed
```

What the evidence actually shows, step by step:

- The refused-write step **passed**: all four writes from the observer's page answered `401`. The suite's
  own evidence log (`test-results/live-observation-readonly.log`) lists every response that page
  produced — `GET /me`, `POST /move`, `POST /messages`, `POST /frontier/build`, `POST /interact` — and
  **each one is 401**. The anonymous observer stored nothing itself.
- The failing assertion is a **global counter**, not the observer's own request:
  `expect(count('SELECT COUNT(*) FROM messages') === before.messages, 'no message may be stored by an
  observer')` (`scripts/browser-suite.mjs:5512`, inside the step at `:5509`). So some **other** writer
  put a row into `messages` during the scenario's window.
- The only other writer in that server is the shipped product's own timer. `server.js:791` runs
  `setInterval(..., 3000)` and, on every second tick, `platform.transaction(() => livingWorldTick(platform))`
  — about every ~6 s. A served server defaults that on (`server.js:808` passes
  `livingWorld: process.env.LUCY_LIVING_WORLD !== 'false'`; `LUCY_LIVING_WORLD` is unset here), and the
  suite spawns `node server.js` with the inherited environment (`scripts/browser-suite.mjs:242-245`).
- `livingWorldTick` writes into `messages`: a reply path (`src/living-world.js:426-452`) and an ambient
  bark path (`src/living-world.js:463-478`, `Math.random() < 0.25` once a resident has been quiet for
  45 s). **This is already asserted elsewhere on this base and it passes**: `tests/living-world.test.js:50-82`
  proves a tick inserts a public message attributed to `lw-*`, and that test is part of the 1074/1074
  `npm test` above.
- The window is long enough in the full suite: the scenario's entry step took 6924 ms in run 2 against
  551 ms in the isolated run, so the full-suite window spans at least one tick.
- **Most probable explanation, stated as a hypothesis and not as a proven cause:** the shipped
  autonomous living-world tick stored a public message inside the scenario's count window, so the
  scenario's assumption ("no `messages` row can appear while an anonymous observer watches") is false on
  a base that ships a living world with a 3-second timer. No counter was captured from the server to
  identify the offending insert, so another concurrent writer is not excluded. What *is* established is
  that no observer request was accepted and the red is a scenario-level invariant, reproducible in the
  full suite (2/2) and absent in isolation (1/1). It is escalated as finding 7; it was **not** fixed
  here, and this branch's change set — two documentation files — cannot affect it either way.

What these results do **not** prove, stated so neither the green nor the red is over-read:

- `npm test` **does not execute** the 45 browser scenarios, `npm run e2e`, the seal check, the load or
  capacity harnesses, or the real-engine Luanti smokes. Those are separate gates, and only the ones in
  the table above were run. In particular `npm test` is green while `npm run browser` is red — the suite
  covers a scenario the unit suite does not.
- The counts differ from the figures in older handoffs (e.g. `npm test` was `902/902` and the seal was
  `89 definitions` on the schema-22 Wave D branch). That is a **different base**, not a regression or an
  improvement claim: the deltas were not diffed test-by-test here.
- `npm run check` printed `checked 99 files, 0 failed`; its patterns
  (`server.js`, `world.js`, `app.js`, `src/**/*.js`, `runtime/**/*.js`, `scripts/**/*.js|mjs`) exclude
  `native/**`, matching the Area 7 row that says the native smokes are outside this gate.
- The seal now verifies **98** definitions, which is exactly the number the *Stale docs* finding says
  `docs/RELEASE_CHECKLIST.md` still contradicts (`89`).
- The browser gate is load-sensitive: run 1 started at load average 4.06 and ran 534 s, the isolated
  single-scenario run took 15 s. Timings are quoted for that reason, and no timing claim is made about
  an unloaded host.

## Pruning decisions

Reproduced verbatim from the Wave 0 brief — these are the decisions taken, not proposals:

- TAKEN in Wave 1 (`framework-wave1-contract`): a declarative write-contract policy module; contract
  tests asserting authorization, attribution, persistence-before-success and idempotency; the
  `heartbeat` read-scope write escalation; `src/drafts.js` save honesty and single-owner archival;
  idempotency-key coverage for the six unprotected routes; `gets`/handler/`publicRoute` consistency; a
  schema-version drift guard.
- DELIVERED AS A FAILING REPRO PLUS AN OWNER PATCH PROPOSAL, NOT FIXED IN PLACE: audit attribution
  missing on the `src/spaces.js` movement paths and the `src/platform.js` message/journal paths (both
  touch files other agents are editing); coin eligibility duplicated between `src/coins.js` and the
  `coins_validate_insert` trigger body.
- HELD until the owning branch lands: shared/global map (Wave 2), Karma and shop integration (Wave 5),
  visual slice 2 and the in-game command surface (frontend).
- ANTIGRAVITY'S (not mine): CI wiring, conversation evaluation, rendering measurements, the
  external-worker example, world determinism tests, the fresh-install rehearsal.
- STALE DOCS RECORDED, NOT FIXED: `docs/OPERATIONS.md` still prints schema 23,
  `docs/RELEASE_CHECKLIST.md` still expects 89 sealed definitions (actual 98) and older schema/test
  counts, `docs/PERFORMANCE.md` measures schema 22. Record them as findings so the owners can decide;
  do not edit those files on this branch.

## Findings escalated to owners

The three items the pruning decisions name as "escalate, do not fix in place", plus matrix findings that
need an owner decision, plus the gate failure measured on this branch (finding 7). No file named here
was edited on this branch.

| # | file | exact defect or gap | owner |
| --- | --- | --- | --- |
| 1 | `src/spaces.js` (movement: `stepAgent`/`moveAgent`/`climbAgent`/`lookAgent` L498–527, `heartbeat` L634, `posture` L640) and `src/platform.js` (`message()` L355–401) + `src/journey.js` (`writeJournal` L524) | These writes commit with **no audit row**: audit is a per-helper convention, not a seam inside `platform.transaction()` (`platform.js:100-109`), so the receipt chain does not attribute a movement, a heartbeat, a message or a journal write. The `audit` table also has no append-only trigger. | `src/spaces.js` movement sits next to Claude's global-map work (`feat/global-map-phase1` @ `6868869`; `b95d218`/`ad63562`/`cacd349` rewrite `server.js:541`) — Claude. `src/platform.js` is the shared write-merge point — Claude/Antigravity. `src/journey.js` is unowned. Disposition: failing repro + owner patch proposal, **not** fixed in place. |
| 2 | `src/coins.js` — `const eligible = EXISTS(...)` vs the `coins_validate_insert` trigger body in `COIN_SCHEMA` | Two hand-maintained copies of the same role/status/version predicate ("Eligible coin receipt"); the chain proof is duplicated the same way (`verifyCoinLedger` vs `NEW.previous_hash` check). A change to one silently diverges from the other. | No other agent owns `src/coins.js`, so one owner can collapse both copies; the coin verifier it feeds lives in Claude-owned `src/recovery.js`. Disposition: failing repro + owner patch proposal, **not** fixed in place. |
| 3 | `docs/OPERATIONS.md` (`:385` says "the schema-23 build", `:394` records a schema-22 run), `docs/RELEASE_CHECKLIST.md` (`:36` G5 expects `89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture)`; `:211-212` older schema/test/browser counts), `docs/PERFORMANCE.md` (`:6` measures schema 22) | Stale numeric expectations that contradict this base: schema is **25**, the seal verifies **98 definitions** — measured here as `20 appearance, 9 block, 32 cosmetic, 6 crop, 31 furniture` — and `npm test` is **1074** tests, not 902/500. A reader trusting G5 would call a correct tree broken. | Docs owners to decide (matrix Area 7 lists all three as safe to correct); **not** edited on this branch, per the pruning decision. |
| 4 | `src/recovery.js:157` and `:461`, `scripts/ops-rehearsal.mjs` (`=== 25` in six places), plus doc copies | The accepted-schema-version list is hardcoded in five places; `b95d218` already had to bump every copy to 26. This is the drift the Wave 1 "schema-version drift guard" is meant to stop. | Claude owns `src/recovery.js` and `src/database.js`; `scripts/ops-rehearsal.mjs` is unowned. |
| 5 | `src/platform.js:976` | `exportAccount` still stamps the format string `'shared-world-account-v18'` while the database is at schema 25 — is that a compatibility contract or drift? It is the **one** collision point with Claude's karma/shop export keys on `b95d218`. | Claude (karma/shop port, schema 26). |
| 6 | `docs/framework/wave0-matrix.md` + the Wave 0 brief | The brief asks the header to state **seven** STATUS values; the source reports define **five** and only three occur. The header states five and records the mismatch. | Integrator / brief author, to confirm the vocabulary before Wave 1's contract tests encode a status set. |
| 7 | `scripts/browser-suite.mjs:5509-5512` (scenario `live-observation-readonly`), against `server.js:791` + `src/living-world.js:426-478` | The scenario asserts a **global** `SELECT COUNT(*) FROM messages` is unchanged across its window while the shipped server's own 3-second timer is writing to that table every ~6 s (`livingWorldTick`: reply path and a 25 %-per-resident ambient bark). Measured: `npm run browser` = 44/45, exit 1, on this scenario, in **two of two** full runs; the same scenario alone passes (1/1). All observer requests in the failing run returned 401, so the observer wrote nothing — the count moved for another reason. Owner decision: harden the assertion (count only the rows the observer could have written, or stop the tick for the scenario) rather than leave a red gate. | `scripts/browser-suite.mjs` is unowned (matrix Area 7); Antigravity owns CI wiring, and the suite is the CI gate, so the disposition is shared. **Not** fixed on this branch. |

## Open questions

Carried forward from the matrix, phrased for a human — each is a decision, not a task:

1. **`heartbeat` scope.** `server.js:483` maps `heartbeat` to the `'read'` scope, so a read-only runtime
   credential can POST a write that refreshes `last_seen`. Is that the intended read-scope semantics
   (presence read implies a touch), or should the write require a write scope? Wave 1 has *taken* the
   escalation; who confirms the intent it encodes?
2. **Where does audit belong?** Is a receipt mandatory for every state change (movement, heartbeat,
   message, journal), or is the per-helper convention acceptable and only the *documented* writes need
   attribution? Findings 1 and 4 both turn on this.
3. **Which list is authoritative?** The `gets` Set (`server.js:179`), the `publicRoute` list
   (`server.js:533`), the runtime-refusal route list (`server.js:541`) and the idempotency-key route set
   (`server.js:742`) are four hand-maintained lists over the same routes. Should they be derived from
   the write/scope table (Wave 1 proposes consistency tests), or is the hand-maintained form deliberate?
4. **Public surfaces.** `GET /briefing` is unauthenticated and passes no actor (`server.js:533,605,628`;
   `platform.js:642`); `account export` is self-only with a v18 format string. Are both intended public
   contracts, and who documents them?
5. **Single source of truth for duplicated rules.** Coin eligibility (finding 2), the independence rule
   (`guilds.js:322` vs `community.js:302`, differently worded), the placement validators
   (`frontier.js:837` vs `world_objects_build_guard`), the escape checks (`trapsResident` vs
   `keepsResidentsConnected`) and the two human-session guards (`role()` vs `human()`) are each
   duplicated by hand. Which are intentionally two layers, and which must be collapsed?
6. **Runtime self-reporting.** A runtime records its own `jobs` completion (`server.js:733`; `/jobs` is
   absent from the operator-only block at `server.js:541`), and `/workers` is session-only. Is
   self-attested job success acceptable, or must the server own the state transition?
7. **Which acceptance gates are gates?** `npm run e2e`, `seal-content --check` and the native `*.mjs`
   smokes pass but are outside `npm test` and (except the browser job) outside `ci.yml`; the **browser
   suite does not pass on this base** (44/45, twice). CI wiring is Antigravity's; who decides the set,
   does the native smoke become a `*.test.mjs` behind a `LUANTI_BIN` guard, and is a red browser job
   accepted at this revision?
8. **Schema 26 sequencing.** Claude's karma/shop port (`b95d218`, schema 26) collides with
   `src/database.js` ordering, the five accepted-version lists (finding 4) and the `exportAccount` format
   string (finding 5). Who sequences that bump, and does schema 25's vault survive it (`ad63562`,
   `cacd349`, `6868869` strip the vault from `runtime/agent.js` and `src/spaces.js`)?
9. **The three stale documents** (finding 3) — refresh, or mark historical? They are outside the files
   this branch may edit.
10. **(new, measured on this branch, not from the matrix)** The `live-observation-readonly` scenario
    asserts a global `messages` count across a window in which the product itself writes to that table
    (finding 7). Should the scenario stop the living-world timer for its window, scope its count to rows
    the observer could have written, or should the server's timer be quiesced under acceptance — and
    does a suite that can go red on a random 25 % branch belong in CI unchanged?

## What was not done

- **No failing repro and no owner patch proposal were authored.** The pruning decisions assign findings
  1 and 2 to a "failing repro plus an owner patch proposal"; this branch contains **no test, no repro
  script and no patch proposal file**. The evidence for both findings today is the matrix's own
  `path:line` citations (verified by reading), and the 1074/1074 `npm test` run above shows the base is
  green — i.e. the defects are **unasserted** as well as unfixed. If the repro was meant to land in
  Wave 0, it did not.
- **The failing browser scenario was not fixed and its cause was not instrumented.** `npm run browser`
  is red on this base (44/45, two runs, finding 7). The branch is documentation-only and
  `scripts/browser-suite.mjs` is not this task's to change; no counter or log line was added to the
  server to catch the writing transaction, so the cause in that document stays a **hypothesis** with the
  evidence listed, not a proven one. Fixing it — or accepting the red — is finding 7's owner decision.
- **No product code, test, script, config or content file was changed.** `app.js`, `src/voxel-world.js`,
  `src/scene/*`, `src/database.js` and `src/recovery.js` were neither edited nor needed a finding-only
  escalation beyond finding 4 (the version lists).
- **The stale documents were not corrected** (`docs/OPERATIONS.md`, `docs/RELEASE_CHECKLIST.md`,
  `docs/PERFORMANCE.md`) — recorded as finding 3 instead, per the pruning decision.
- **No matrix row was re-derived, reworded or removed**, and the matrix's own prose beyond the header
  was not touched.
- **No gate beyond the five was run:** `npm run capacity`, `npm run load`, `npm run perf`,
  `node scripts/ops-rehearsal.mjs`, `scripts/multiplayer-soak.mjs`, the `LUANTI_BIN` native smokes and a
  fresh-install rehearsal are all **unrun** on this tree. Nothing in this document claims otherwise.
- **No test was deleted, skipped or weakened, no limit was relaxed, and no gate is reported as passed
  that was not run.**
- **Nothing was pushed, merged, rebased, deployed or installed**; no package was added; no other agent's
  worktree was entered or edited; the installed product worktree (`Lucy-repo`) was not read, written,
  checked out or run.
- **The integrator's files were not touched:** `HANDOFF.md`, `README.md`, `ROADMAP.md`, `STATISTICS.md`,
  `docs/VERIFICATION.md` and the other `docs/handoff/*.md` files were read (where needed for style or
  evidence) but not modified.
- **The patch was produced and left unapplied**; whether Wave 1 rebases on this commit is Wave 1's
  decision.

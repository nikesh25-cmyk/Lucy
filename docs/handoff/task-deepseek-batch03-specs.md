# Task — DeepSeek Batch 03 handoff packet

Branch **`task-deepseek-batch03-specs`**, worktree `work/t39`, base commit
**`a41d26046bd346cfe49f358d976ff157178352bc`** (*Integrate completed game experience with batch two and
harden observation*) on `integration/nemoworld-completed`. **Schema is unchanged: 22.** This is a
**documentation-only** packet: three new specifications plus this handoff. **No code was changed.**
This integrated copy also includes review corrections and schema-document updates on
`integration/nemoworld-completed`; the original `task-deepseek-batch03-specs` branch remains intact.

It defines the shared baseline, the ownership/interface contract and the six task specifications that
sit either side of one boundary: a **Luanti (native engine)** effort and a **DeepSeek (six service
tasks)** effort.

## 1. Changed files

| File | Change |
| --- | --- |
| `docs/deepseek/BATCH_03_BASELINE.md` | New. The shared baseline both efforts build against. |
| `docs/deepseek/OWNERSHIP_AND_INTERFACES.md` | New. The file/ownership map and the integration boundary. |
| `docs/deepseek/TASKS_BATCH_03.md` | New. The six task specifications. |
| `docs/handoff/task-deepseek-batch03-specs.md` | New. This handoff. |

The original packet touched only those four files. Integration additionally updates
`docs/ARCHITECTURE.md` and `docs/OPERATIONS.md`; no `.js`, `package.json`, `HANDOFF.md` or
`outputs/Lucy` file was changed.

## 2. The baseline, as measured (not quoted)

All figures below were re-measured in this worktree on Node v24.19.0 on 2026-10-13. See
[BATCH_03_BASELINE.md](../deepseek/BATCH_03_BASELINE.md) for the full record.

| Fact | Value | How verified |
| --- | --- | --- |
| Commit / branch | `a41d26046bd346cfe49f358d976ff157178352bc` / `integration/nemoworld-completed`, clean tree | `git log -1`, `git status --porcelain` |
| Commit shape | **single-parent** commit (parent `1dd5b66`); the real batch-02 × game-experience merge is the earlier `09485ce` | `git log -1 --format=%P`, `git log --graph` |
| Schema | `user_version = 22`; guard rejects `> 22`; recovery accepts `1…22` | `src/database.js:18`, `:149`, `src/recovery.js:133` |
| `npm run check` | **pass**, exit 0 | run in `work/t39` |
| `npm test` | **774 tests, 774 pass, 0 fail, 0 skipped** (≈87.5 s) | run in `work/t39` |
| `npm run e2e` | **15 steps passed, 0 failed** | run in `work/t39` |
| Content seal | **89 definitions** (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture), 3 support files, 42 notices/assets | `node scripts/seal-content.mjs --check` |
| Route inventory | **84 write routes** in the `writes` Map, **46 GET routes** in the `gets` Set; `specialWrite` = 3; `dynamic` = 7 actions | counted from `server.js:104`, `:149`, `:447`, `:446` |
| Action vocabulary | **20 actions**, exact key counts enforced by `parseAction` | `runtime/agent.js:61`–`:115` |
| Runtime scopes | `read`, `move`, `chat`, `contribute`, `build` | `src/platform.js:301`, `runtime/agent.js:594` |

**One correction to the briefing:** it says "74 write routes". The measured value is **84**; the "46
GET routes" is correct. The full list of all 84 paths and all 46 GET paths is in the baseline
appendix so the number is auditable.

## 3. The ownership boundary (summary)

Full detail, including the single-writer table and the source-of-truth map, is in
[OWNERSHIP_AND_INTERFACES.md](../deepseek/OWNERSHIP_AND_INTERFACES.md).

- **Luanti agent owns** the engine choice, the Lua bridge/mod, world graphics, the scene/rendering
  work and **final integration**. It starts from this repo's own pinned-commit research
  (`docs/VOXEL_ENGINE_REUSE.md`, Luanti pinned at `5bb520ba…`) and does **not** re-research. It bridges
  to the existing mission and identity services rather than duplicating them.
- **DeepSeek owns the six tasks**, all of which extend existing services.
- **Frontend/shell rule:** exactly one owner wires `app.js`, `index.html` and the main stylesheets —
  the convention task 38 established (`docs/handoff/task-38-frontend-integration.md:34`, `:280`). For
  Batch 03 that single owner is the final-integration (Luanti) owner; DeepSeek tasks return payloads
  and module tests, never shell edits.
- **What crosses the boundary:** mission/claim/submission/review/adoption records, agent identity + a
  scoped credential, saved world state and progress signals — each through its existing route, with
  the table named as the single source of truth.
- **Restricted data:** a trusted bridge receives the short-lived runtime bearer token in memory and
  uses it only in authorized HTTP headers. It never persists, logs or puts that token in a model
  prompt or world text. Operator setup/session secrets stay server-side. Approved memory may enter
  only its own bound AI resident's private runtime prompt; private conversations, drafts and contact
  details are not published across the boundary.
- **Schema bumps** are owned by the task that needs them, which is the single writer of
  `src/database.js` and `src/recovery.js` and owes four acceptance items: migration, backup/restore
  round-trip, version assertions, and fail-closed validation.

## 4. The six specifications (summary)

| # | Task | Start now? | Extends | Schema bump |
| --- | --- | --- | --- | --- |
| 1 | Agent mission adapter | **Yes** | `/missions`, `/claims`, `/submissions`, `parseAction`/`authorizeAction`, budgets, `Idempotency-Key`, `expireClaims` | No |
| 2 | Persistent agent memory | **Yes** | schema-21 `resident_memory`, its five allowed source kinds, the 404/404/404/401 isolation rules | Only if a new attribute/source/trigger needs one |
| 3 | Cooperative mission content | **Yes** | quest chains, guild projects, cooperative restoration events, distinct-operator verification | No |
| 4 | Compute-budget controls | **Yes** | operator diagnostics, durable run budgets, `POST /residents/resume`, the bounded model queue | No |
| 5 | Compatibility tests | **BLOCKED on the Luanti bridge** | browser suite, e2e harness, crash-recovery tests | No |
| 6 | Security tests | **Yes** | reward-abuse audit (`src/coins.js`), untrusted-observation tests (`runtime/runtime.test.js`) | No |

Each spec in [TASKS_BATCH_03.md](../deepseek/TASKS_BATCH_03.md) states: purpose; the exact files it may
change; dependencies; the acceptance tests it must add; the evidence it must return; its required
handoff format; its start/blocked status; the existing system it extends with `file:line`/route
evidence; and a **do-not-rebuild** list.

Task 4 carries two explicit constraints written into the spec: the **unit-separation rule** (virtual
coins have an existing nontransferable ledger; compute credits, real money and verified carbon credits
are unimplemented concepts with **no conversion path, no cash-out and no token**), and the
**"≈10% of donated computing credits to exploration/social/learning"** recorded as an **open
hypothesis only** — with its credit unit, donor consent and evaluation undefined until agreed, and
**not implemented as any money flow**.

## 5. What can start now

Tasks **1, 2, 3, 4 and 6** have their runtime prerequisites on `a41d260`; branch from the latest
reviewed `integration/nemoworld-completed` tip so the corrected contract is included. Shared edits to
`src/platform.js`, `server.js` and `runtime/agent.js` must be serialized and rebased between tasks;
two branches must never claim the same schema version. Task **5** is blocked on the Luanti bridge:
its spec is written, but no runnable test skeleton was delivered by this docs-only packet. A skipped
test is never a pass.

## 6. Open questions for the integrator

1. **Write-route count.** The briefing's "74 write routes" does not reproduce (measured **84**). Confirm
   which figure the final integration should carry; this packet uses the measured 84.
2. **The commit description.** The briefing calls `a41d260` a merge; `git` records a single parent (the
   merge is `09485ce`). This packet describes the commit accurately; the summary text elsewhere may
   want correcting.
3. **Shell ownership.** This packet assigns shell ownership to the final-integration (Luanti) owner.
   If the integrator prefers a separate shell owner, name it before any task returns UI work.
4. **Documentation drift resolved in integration.** `docs/ARCHITECTURE.md` and
   `docs/OPERATIONS.md` now describe the schema-22 build. Schema 22 also seeds 222 catalog evidence
   sources and captures at `Platform` startup; those two new tables are not empty after startup.
5. **Task 2 and Task 4 schema bumps.** Both *may* take a bump; if either does, confirm the schema
   ownership serialises (one bump at a time) so two branches never both edit `src/database.js`.
6. **The 10% proposal.** Confirm the intended credit unit, donor consent and evaluation before any
   implementation is attempted; until then it stays an open hypothesis in the Task 4 handoff.
7. **Browser gate.** The 35-scenario suite was not run in the packet worktree, but was subsequently
   run on the same unchanged `a41d260` source and passed **35/35 in real Chrome**.
8. **Luanti verification.** The bridge owner must verify engine details against current official
   documentation and define the short-lived token handoff. Runtime tokens currently bind AI
   characters; native human mutations need a separately designed operator-pairing boundary.

## 7. Reproducing

```sh
cd work/Lucy-repo && export PATH="$PWD/../node-bin:$PATH"
npm run check
npm test
npm run e2e
node scripts/seal-content.mjs --check
```

Expected for the unchanged `a41d260` runtime: exit 0; `774/774`; `15 steps passed, 0 failed`;
`89 definitions …`. The original packet patch is `work/task-deepseek-batch03-specs.patch`; the
integrated review also corrects the contract and updates two existing schema documents.

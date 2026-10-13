# Batch 03 · Task 1 — Agent mission adapter

Branch `task-deepseek-batch03-01-mission-adapter`, based on the integrated
`integration/nemoworld-completed` tip `46fb135ab147cc2b09c048809036303aec88b09e`.

Baseline at that tip: **840 tests, 0 failures**, `npm run check` green, `npm run e2e` 17/17,
sealed-content check 89 definitions. After this task: **848 tests, 0 failures**, all other gates
unchanged.

## 1. State model

No schema change. The task **extends** the existing mission, claim, submission and runtime-credential
records; it adds no table, no column, no second claim store and no new route.

| Existing record | Used by this task |
| --- | --- |
| `missions`, `tasks` (`GET /missions`) | the observed directory the runtime reads |
| `claims` (`POST /claims`) | the one claim store; the runtime's own active lease |
| `submissions` (`POST /submissions`) | the evidence the runtime submits |
| `tokens` (`POST /runtime/start`, `GET /runtime/status`) | the runtime credential, its scopes and `max_calls - used_calls` budget |

The only new derived value is an `active_claim` field the server attaches to a runtime's own read:
`missionList`/`missionDirectory` now return the runtime's single active claim
(`leased` or `changes_requested`) alongside the mission directory, so the runtime can see which task
it already holds and submit against it.

## 2. What changed and why

- **`runtime/agent.js`**
  - `parseAction` accepts `{"action":"claim","task_id"}` and `{"action":"submit","claim_id","artifact","sources",…}`.
    Both are strict on keys and shapes (`max 10` sources, `artifact ≤ 16000`, optional
    `method ≤ 200`, `limitations/rights ≤ 2000`, object `brief`); unknown fields are refused.
  - `authorizeAction` authorizes a `claim` only for an observed **open** task and a `submit` only
    against the runtime's own observed `active_claim.id` in a `leased`/`changes_requested` state.
    It stays advisory — the server remains authoritative.
  - `observationPrompt` adds a bounded `missions` section (five open tasks plus the runtime's own
    active claim) with a whole-item pruning rule (`missions.tasks`, keep 0) so the document still
    fits the 17 000-byte budget. The mission paragraph is advertised **only** with the `contribute`
    scope and a server-supplied directory.
  - `runAgent` dispatches `claim` to `POST /claims` and `submit` to `POST /submissions` with the
    stable `writeKey`, and re-checks identity/authority before dispatch exactly as the other actions
    do. **The mission directory rides inside the resident's own private `/callings` read**, so a
    runtime with `contribute` pays one credential charge for its calling context *and* its available
    work — the previous draft fetched `/missions` on every decision and changed the credential
    budget of unrelated runs.

- **`src/platform.js` — `missionList`** now returns `active_claim` (the runtime's own active lease)
  for a runtime actor, and nothing different for a human session.

- **`src/mission-directory.js` — `missionDirectory`** returns the same `active_claim` for a runtime
  actor on the paged directory, so `/missions` and the folded callings read agree.

- **`src/vocations.js` — `callings`** attaches `missions` (via `missionList(actor)`) **only** for a
  runtime actor whose credential grants `contribute`; human sessions and other scopes are unchanged.

- **`runtime/runtime.test.js`**, **`tests/mission-runtime.test.js`** — extended/new tests (below).

## 3. What was tested

New and extended tests, with the assertion each makes against the database:

**`tests/mission-runtime.test.js` — new, 6 HTTP tests over a real server**

1. *a runtime with contribute scope claims one task and submits evidence through the HTTP routes* —
   `claim` writes exactly one `claims` row; a repeated `Idempotency-Key` returns the same claim id and
   writes **no** second row; `submit` writes exactly one `submissions` row (`pending_review`); a
   repeated submit key returns the same submission and writes no second row; `coin_rewards` stays 0.
2. *a runtime without contribute scope is refused on mission work routes* — `POST /claims` and
   `POST /submissions` are **403**; `claims` stays empty.
3. *a paused or revoked runtime credential is refused before the mission handler* — paused claim is
   **401**; a fresh active credential claims **201**; pausing the character again makes the next
   submission **401**.
4. *claim lease expires after 20 minutes and a second operator can then claim the task* — a second
   operator is **409** while the lease is live, and **201** with a new claim id after
   `f.advance(21 min)`; the new claim belongs to the second operator's account.
5. *one active claim per operator: same leased task is 409, a different open task is 429*.
6. *a runtime cannot review, adopt or mint a coin, and a human avatar cannot receive a runtime token*
   — `POST /reviews` is **403**; `coin_rewards` stays 0; creating a runtime for a `human` avatar
   throws.

**`runtime/runtime.test.js` — extended**

- *mission claim and submit actions are parsed, authorized and dispatched through the existing routes*
  — the model sees the mission paragraph and the directory inside the calling read, emits `claim`
  (`POST /claims` body `{task_id}`), then, on the next turn with an observed `active_claim`, emits
  `submit` with the exact evidence body; authorization refuses an unseen task id and a submit without
  an observed active claim.
- *malformed mission actions cannot smuggle extra fields, coin paths or fake sources* — seven
  malformed payloads (extra `agent_id`, `reward`, `coin`, empty sources, empty artifact, `approval`)
  are all refused by `parseAction`.
- The bounded-observation tests keep the mission section inside the byte budget, and the
  conversation-injection test keeps `/api/v1/missions` in the runtime's allow-listed read set.

## 4. Actual gate output

```
npm run check   → all files syntax-clean
npm test        → # tests 848 / # pass 848 / # fail 0 / duration_ms 92836
npm run e2e     → SUMMARY 17 steps passed, 0 failed  (PASS)
node scripts/seal-content.mjs --check
                → Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop,
                  27 furniture); 3 support files; 42 referenced notices and assets.
node --test runtime/runtime.test.js       → 32 pass / 0 fail
node --test tests/mission-runtime.test.js → 6 pass / 0 fail
node --test tests/calling-runtime.test.js → 7 pass / 0 fail
node --test tests/memory-runtime.test.js  → 6 pass / 0 fail
```

The e2e harness still completes the two-actor shared restoration with both operators’ saved rows and
the independent 10-coin acceptance unchanged; the mission adapter mints nothing.

## 5. Residual risks and limits

- **Directory visibility is unchanged.** A runtime still sees every non-draft mission the human
  session sees; the adapter does not narrow that. Demo missions remain claimable, as before.
- **The runtime sees at most five open tasks** in the prompt (a display bound, not an authorization
  bound); the server still authorizes against its own current records.
- **Claim/calling coupling.** Missions now arrive inside `/callings`; a runtime whose `/callings`
  read returns `404` (unlikely) receives no directory and simply does not attempt mission work.
- **No coin path is added.** Claiming and submitting still mint nothing; only an independent human
  acceptance on a real mission issues a coin (`src/coins.js`).

## 6. Migration / rollback

No migration: schema version is unchanged and no storage is written by this task outside the
existing claim/submission rows. Rollback is a branch revert; the record shapes are untouched.

## 7. Source / asset rights

No new asset. Only project-authored source and tests were changed; the sealed-content manifest is
untouched and re-verified green.

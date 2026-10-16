# Batch 03 · Task 5 — Native/web compatibility tests

Branch `task-deepseek-batch03-05-compatibility`, stacked on the combined review tree
`review/nemoworld-batch03` (which carries Task 1 + the private reply + Task 4, and the merged Task 3,
Task 6, phone-shell and first-play-read slices).

## 1. What this task proves, and what it does not

**Run and green (the Node bridge side, real HTTP, disposable database):**

- `native/bridge.integration.test.mjs` — **2/2**
  - *real NemoWorld routes: native build and web build share rows…* (the pre-existing bridge test):
    a native placement and a web placement land in the same `frontier_blocks` rows; the wrong plot and
    a revoked credential are refused; the sector crossing follows the owned agent's returned world.
  - *native and web read the same mission records; a repeated native claim and submit do not
    duplicate* (new): the native client reads the **same task id** the web directory publishes; a
    native claim writes exactly one `claims` row owned by the paired human's operator and bound to the
    paired human avatar; a repeated native claim replays the same lease with **no second row**; the web
    directory and the native read report the **same `active_claim` id**; a native submission writes
    exactly one `submissions` row, a retry returns the same id, and a database reopen keeps exactly one
    claim and one submission; native human mission work mints **no coin**.
- `native/bridge.test.mjs` + `native/bridge.integration.test.mjs` — **6/6** together (boundary mapping,
  pairing, mod-key enforcement, revocation, shared rows, crossing, refusals, persistence).

**Pending — not run, not reported as passed:**

- The **real Luanti server/mod callback** smoke (`native/luanti-smoke.mjs`). The pinned Luanti engine
  binary is **not installed** in this environment (`LUANTI_BIN` is empty), so the launcher cannot start
  the real engine. The acceptance rule ("the final gate must exercise a real Luanti server/mod callback
  through the bridge, not only a Node HTTP client") is therefore **not satisfied here**. This is an
  environment limit, not a code result, and it must not be recorded as a pass.
- A native **conversation** read (the private channel) is not yet exposed by the bridge; only the
  mission records are. That is the remaining part of the "same mission and conversation records" goal.

## 2. What changed

- **`native/bridge.mjs`** — three bounded native routes that reuse the existing NemoWorld routes and
  the paired operator session (never a second mission store). The paired-player idempotency key is
  bound to the player and task, so a bridge or Luanti restart replays the same lease/submission:
  - `POST /native/missions` — the open task list and the paired human's own active claim, read from
    the same `/missions` directory the browser uses;
  - `POST /native/claim` — `POST /claims` with `Idempotency-Key: native:<player>:claim:<task>`;
  - `POST /native/submit` — `POST /submissions` with the method, limitations and rights the server
    requires, and `Idempotency-Key: native:<player>:submit:<claim>`.
  `call()` now forwards an optional idempotency key.
- **`src/mission-directory.js`** and **`src/platform.js`** — the mission directory now returns
  `active_claim` to an **operator session** (its own account's single active lease) as well as to a
  runtime, so the paired human sees its own claim. Both read the one `claims` store.
- **`native/bridge.integration.test.mjs`** — the new compatibility test above.

The credential boundary is unchanged: the bridge keeps the operator session only in memory, checks it
through `/me` before every request, and never writes it to the Lua mod, world files, logs or a model
prompt. A native human action is attributed through the human pairing; an AI runtime token is refused
by the pairing route.

## 3. Actual gate output

```
npm run check → all files syntax-clean
node --test native/bridge.integration.test.mjs → 2 pass / 0 fail
node --test native/bridge.test.mjs native/bridge.integration.test.mjs → 6 pass / 0 fail
node --test tests/mission-directory.test.js tests/mission-runtime.test.js → 11 pass / 0 fail
LUANTI_BIN is unset → the real-engine smoke remains PENDING
```

## 4. Residual risks and limits

- The Node-side compatibility is proved; the real-engine callback is not. Do not treat this branch as
  a passed real-Luanti gate.
- Native conversation access is not exposed yet; only missions.
- The native idempotency key is bound to the player and task/claim; a different Luanti player name
  would get a different key, which is the intended per-player behaviour.

## 5. Migration / rollback

No schema change. Rollback is a branch revert; the bridge routes are additive.

# NemoWorld External AI Worker Reference Client

An authoritative reference client demonstrating how a separately hosted, autonomous AI worker or background runtime connects to NemoWorld via the scoped runtime API.

---

## 1. Execution Guarantees & Recovery Semantics

### The Distributed Boundary
In a distributed client-server architecture without distributed transactions or two-phase commit, **a client-side local file cannot deliver an "exactly-once" execution guarantee**.

Specifically, for non-idempotent server operations such as `/api/v1/move`:
1. The server updates coordinate state upon request receipt.
2. If network partition, process termination, or hardware failure occurs **after** the server commits the state change but **before** the client receives the HTTP response or flushes its local log to disk, the client cannot know whether the action was applied solely by examining its local filesystem.
3. A naive client that merely replays the action on restart will cause duplicate movement, corrupting agent patrol paths.

### The Precise Guarantee: At-Least-Once Intent Dispatch with Authoritative State Reconciliation
The NemoWorld External AI Worker provides **at-least-once intent dispatch with authoritative state reconciliation (convergent execution)**:

1. **Pre-Action Intent Logging:**
   - Before dispatching any mutating action, the worker logs an `inFlight` intent record containing `{ actionId, type, origin, expectedTarget, dispatchedAt }` to persistent storage (`.worker-state.json`).
2. **Authoritative Reconciliation on Startup / Retry:**
   - On process boot or prior to executing subsequent steps, the worker executes `reconcileInFlight()`.
   - It queries the server's authoritative state via `GET /api/v1/world` or `GET /api/v1/runtime/status`.
   - **Case A (`already_committed`):** If the agent's current position matches `expectedTarget`, the server already committed the step before the crash. The worker marks the action as completed in `completedActions`, clears `inFlight`, and **does not replay** the move.
   - **Case B (`not_committed`):** If the agent's current position matches `origin`, the server never received or committed the move. The worker clears the intent and can safely re-dispatch.
   - **Case C (`diverged`):** If the agent's position is neither `origin` nor `expectedTarget` (e.g. administrative intervention, teleportation, or collision), the worker flags the action as `uncertainDiverged`, avoids replaying, and logs an alert for operator inspection.
3. **Idempotent Routes:**
   - For routes with native server-side idempotency (`/claims`, `/submissions`, `/interact`, `/frontier/build`), the worker supplies the standard `Idempotency-Key: <actionId>` HTTP header, offloading deduplication to the server's authoritative ledger.

---

## 2. Security Boundaries & Guardrails

- **Zero Credential Leakage:** Runtime tokens are passed strictly via `process.env.NEMOWORLD_RUNTIME_TOKEN` and Bearer HTTP headers. Tokens are never persisted to disk, logged, or printed to stdout.
- **Scope Enforcement:** Runtimes operate within narrowly granted scopes (`['read', 'move']`). Route access violations return HTTP 403.
- **Budget Tracking:** Remaining call budgets are tracked through `GET /api/v1/runtime/status`.
- **Debounce & Backoff:** HTTP 429 responses trigger exponential backoff.

---

## 3. Running the Worker & Tests

### Run the Reference Client
```bash
export NEMOWORLD_API_URL="http://127.0.0.1:3000"
export NEMOWORLD_RUNTIME_TOKEN="rt-your-scoped-token"
node examples/external-worker/client.mjs
```

### Run the Failure Injection & Crash Reconciliation Test
```bash
node --test examples/external-worker/worker.test.js
```

---

## 4. Coordination Note for DeepSeek (Backend Contracts)
While state reconciliation handles discrete coordinate movements (`/move`), adding native server-side idempotency to `/move` via `Idempotency-Key` or sequence tokens in future framework waves will allow unified deduplication across all mutating routes.

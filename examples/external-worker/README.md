# NemoWorld External AI Worker Example

An example of a separately hosted worker using NemoWorld's scoped runtime API. It is not a production worker supervisor.

---

## 1. Execution Guarantees & Recovery Semantics

### The Distributed Boundary
In a distributed client-server architecture without distributed transactions or two-phase commit, **a client-side local file cannot deliver an "exactly-once" execution guarantee**.

Specifically, for non-idempotent server operations such as `/api/v1/move`:
1. The server updates coordinate state upon request receipt.
2. If network partition, process termination, or hardware failure occurs **after** the server commits the state change but **before** the client receives the HTTP response or flushes its local log to disk, the client cannot know whether the action was applied solely by examining its local filesystem.
3. A naive client that merely replays the action on restart will cause duplicate movement, corrupting agent patrol paths.

### Recovery behavior
The example saves a local intent before dispatching `/move`. If it loses the response or crashes before recording completion, it **stops movement**. Current coordinates are shown to an operator as diagnostic information, but are not proof that a particular request committed. No automatic retry or subsequent move is permitted while that intent remains unresolved.

1. **Pre-Action Intent Logging:**
   - Before dispatching any mutating action, the worker logs an `inFlight` intent record containing `{ actionId, type, origin, expectedTarget, dispatchedAt }` to persistent storage (`.worker-state.json`).
2. **Diagnostic observation on restart:** `reconcileInFlight()` reports `observed_target`, `observed_origin`, or `observed_elsewhere`. All three retain the intent and require operator resolution. A delayed request may commit after an origin observation; another actor may move the resident back to origin after a commit. The example provides no automatic resolution method.
3. **Idempotent Routes:**
   - `performIdempotentAction` sends an `Idempotency-Key` header. Use it only after verifying that the particular server route actually enforces deduplication for that key. A header alone does not confer idempotency.

The journal is written through a temporary file and rename, then synced. Corrupt saved state fails closed. This local example still cannot provide exactly-once delivery or automatic recovery of an uncertain unkeyed move; server-side action receipts/idempotency would be needed for that.

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

### Run the Failure Injection & Fail-Closed Test
```bash
node --test examples/external-worker/worker.test.js
```

---

## 4. Coordination Note for DeepSeek (Backend Contracts)
The `/move` route needs a server-validated idempotency key or action receipt before uncertain moves can be retried safely.

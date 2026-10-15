# Antigravity delivery review — 15 October 2026

Base: `feat/world-life` at `27c0d72`. This review branch is isolated from the installed world and GitHub `main`.

## Integrated with corrections

- **A1 CI:** Adds the content seal and HTTP e2e gate to the existing CI jobs. The GitHub Actions browser job remains **configured, not run**. Artifact upload and its unprovable regex redactor were removed: text replacement cannot certify screenshot pixels or arbitrary diagnostics as free of private fixture data.
- **A5 determinism:** The original test skipped Bram and Rowan, then asserted that their invalid tree destinations were present. The review fixes Bram's legacy tree spawn and both invalid Harbor destinations, points his Observatory destination at its actual door, and checks every roster member. An existing Bram left on the legacy tree tile is moved once to the valid Harbor door with an audit entry; other saved positions are preserved.
- **A6 rehearsal:** The script proves clean server bootstrap, first-admin registration via HTTP, an API-created resident, persistence after restart, a landing-page capture, and selected startup refusals. It does **not** execute `Start World.command` or a browser account/play journey. The script and report now state that limit and fail when the expected negative errors do not occur.

## Held outside this review branch

- **A2 conversation evaluation:** Its 8/8 score comes from hard-coded `simulateResidentResponse` strings written in the evaluator, not the NemoWorld conversation route or an AI model. The reported adversarial failures are fabricated examples, not observed defects. The suggested regex egress filter would not establish authorization or factual safety. Replace with a route-driven disposable evaluation before integration.
- **A3 rendering performance:** The script waits for any canvas on the anonymous landing page. Its movement timing includes a fixed 150 ms sleep and does not assert a stored move. A single first-render sample cannot support the claimed 31.1% improvement or attribute long tasks to shader compilation. Measure an entered game scene and a confirmed movement, with repeated runs, before accepting the figures.
- **A4 external worker:** `performPermittedMove` writes its local completed-action list **after** the server accepts the move. A crash in that interval replays the move, and `/move` does not accept the route's `Idempotency-Key` ledger. The example's crash-safe claim is false. Use a server-idempotent action or an honest uncertain-outcome recovery protocol before publishing it as a reference client.

The three held branches and their patches remain intact for repair. No held branch was merged into this review tree.

## Gates run on the combined review tree

- `npm run check`: 100 files, 0 failed.
- `node --test tests/world-determinism.test.js tests/living-world.test.js`: 15/15 passed with disposable localhost permission. An initial sandboxed run failed two HTTP tests with `listen EPERM`; the permission-enabled rerun is the valid result.
- `npm test`: 1,079/1,079 passed.
- `npm run e2e`: 20/20 steps passed.
- `node scripts/seal-content.mjs --check`: 98 definitions verified.
- `npm run browser`: 45/45 real Chrome scenarios passed on disposable data; shipped database untouched.
- `node scripts/rehearse-fresh-install.mjs`: scripted bootstrap, restart and selected startup refusals passed on a disposable copy. Mac launcher and browser account/play flow remain unrun in this rehearsal.

These are local gates. The updated GitHub Actions workflow has not run on GitHub and is not reported as a passing hosted CI gate.

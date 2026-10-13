# Batch 03 evidence gap 2 — every Task 4 acceptance criterion mapped to a passing test

Branch `task-batch03-task4-acceptance-map`, based on the frozen review tree
`review/nemoworld-batch03` @ `30e36cf`.

The Batch 03 Task 4 spec lists five acceptance areas — **budget exhaustion**, **resume refusal**,
**queue saturation**, **redacted diagnostics** and **unit separation**. Each already has a shipped,
passing test. No criterion was without coverage, so no limit was raised and no new redundant test was
added; this record pins the mapping and the exact run.

## Mapping

| Task 4 criterion | Passing test | File:line |
| --- | --- | --- |
| Budget exhaustion stops before a provider call | *passport and community reads consume budget and exhaustion stops before a provider call* | `runtime/runtime.test.js:371` |
| Budget exhaustion during navigation | *navigation stops at its remaining API budget without a third movement or another provider call* | `tests/calling-runtime.test.js:81` |
| Budget limits are the shipped maxima | *hard limits reject excessive durations and model budgets before requests* | `runtime/runtime.test.js:135` |
| Runtime status exhaustion/malformed stop before the model | *paused, expired, exhausted and malformed runtime status all stop before the model* | `runtime/runtime.test.js:67` |
| Resume refusal: needs an explicit human action, a live character and an interrupted remainder | *resume needs an explicit human action, a live character and an interrupted remainder* | `tests/resident-state.test.js:188` |
| Resume refusal: an expired run cannot replenish time | *an expired interrupted run requires a new bounded run instead of replenishing time* | `tests/resident-state.test.js:320` |
| Resume keeps the remaining budget, never renews it | *an explicit resume preserves remaining API calls and the original expiry* | `tests/resident-state.test.js:308` |
| Crash classification and credential revocation | *restart classifies each interrupted run from its last durable write and revokes its credential* | `tests/resident-state.test.js:146` |
| Queue saturation: bounded waiting work, cancellations never dispatched | *shared inference bounds waiting work, removes cancelled entries and never dispatches them* | `tests/local-ai.test.js:46` |
| Queue saturation: expired/failed work rechecks before dispatch | *shared inference recovers after model failure and rejects expired work before calling the model*; *queued inference rechecks authority immediately before dispatch* | `tests/local-ai.test.js:60`, `:68` |
| Queue-saturation drill is a shipped rehearsal | the `model-queue-saturation` drill in the operational rehearsal | `tests/ops-rehearsal.test.js:33` |
| Redacted diagnostics | *no token, password, contact address or private artifact can reach the diagnostics* | `tests/ops-diagnostics.test.js:173` |
| Diagnostics are administrators-only | *the diagnostics surface is administrators only and never public* | `tests/ops-diagnostics.test.js:43` |
| Unit separation (one ledger, no conversion/cash-out/token) | four tests | `tests/unit-separation.test.js` |
| Queue bound is the shipped number, not raised | *the shipped spending bounds are the shipped numbers, not raised to pass a test* | `tests/unit-separation.test.js` |

## Run

```
node --test runtime/runtime.test.js tests/calling-runtime.test.js tests/resident-state.test.js \
  tests/local-ai.test.js tests/ops-diagnostics.test.js tests/ops-rehearsal.test.js tests/unit-separation.test.js
→ # tests 78 / # pass 78 / # fail 0
```

## Residual limits

- The mapping covers the Task 4 spec's acceptance list; it is not a claim that no other budget path
  exists. New budget paths must add their own test.
- These are prototype bounds; the numbers are not production capacity.

## Migration / rollback

Documentation only; no code, schema or storage change.

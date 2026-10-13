# Batch 03 · Task 6 — Security tests

Branch `task-deepseek-batch03-06-security-tests`, based on the integrated
`integration/nemoworld-completed` tip `46fb135ab147cc2b09c048809036303aec88b09e`.

Baseline at that tip: **840 tests, 0 failures**. After this task: coin-abuse **14/14** (10 → 14),
runtime **33/33** (30 → 33 standalone; see the merge note), `npm run check` green.

## 1. What changed and why

Test-only. Extends the existing reward-abuse audit and the untrusted-observation tests; it changes
**no** production source. The named controls below already exist in the shipped code, so this task
proves they hold and pins them with regression tests.

- **`tests/coin-abuse.test.js`** — four added cases:
  - *a human avatar cannot receive a runtime credential*
  - *a paused or revoked agent credential is refused before any handler*
  - *a runtime credential cannot review or adopt a submission*
  - *adoption requires a different person from the contributor and from the reviewer*
- **`runtime/runtime.test.js`** — three added cases:
  - *parseAction refuses any model-supplied identity, scope or authorization override*
  - *malicious task text cannot change granted scopes or enable unobserved travel*
  - *every non-read action is refused when only the read scope is granted*

An earlier local edit removed the human-avatar runtime guard in `src/platform.js`; that is a
**security regression** and it contradicts this task's own test, so it was reverted. The control is
restored and pinned (see the load-bearing check).

## 2. Threat/verdict table

| Control | Holds / refused | Test that proves it | Load-bearing |
| --- | --- | --- | --- |
| A human avatar cannot receive a runtime token | refused (403, 0 tokens written) | `coin-abuse.test.js` *a human avatar cannot receive a runtime credential* | **yes** — verified (below) |
| A paused/revoked agent credential is refused before the handler | refused | `coin-abuse.test.js` *a paused or revoked agent credential is refused before any handler* | yes |
| A runtime cannot review or adopt | refused (403) | `coin-abuse.test.js` *a runtime credential cannot review or adopt a submission* | yes |
| Adoption needs a different person from contributor and reviewer | refused (403) | `coin-abuse.test.js` *adoption requires a different person from the contributor and from the reviewer* | yes |
| A model cannot supply its own identity, scope or token | refused by `parseAction` | `runtime.test.js` *parseAction refuses any model-supplied identity, scope or authorization override* | yes |
| Task/message text cannot grant a scope or enable unseen travel | `granted_scopes` unchanged; travel refused | `runtime.test.js` *malicious task text cannot change granted scopes or enable unobserved travel* | yes |
| Any non-read action needs more than `read` | refused | `runtime.test.js` *every non-read action is refused when only the read scope is granted* | yes |

### Load-bearing check (control disabled → test fails → restored → passes)

```
Control: src/platform.js  if (agent.kind !== 'agent') fail(403, 'Human avatars …')
Test:    coin-abuse.test.js  'a human avatar cannot receive a runtime credential'
Disabled → # pass 0 / # fail 1
Restored → # pass 1 / # fail 0
```

## 3. Actual gate output

```
npm run check                              → all files syntax-clean
node --test tests/coin-abuse.test.js       → 14 pass / 0 fail   (was 10)
node --test runtime/runtime.test.js        → 33 pass / 0 fail   (standalone on this base)
```

Merge note: this branch's three runtime tests and the mission-adapter branch's tests both build on the
same `runtime/runtime.test.js`; they are disjoint additions and were reconciled in the combined review
tree (see the combined-tree gate run).

## 4. Residual risks

- No system is unhackable. These tests prove specific refusals, not the absence of every attack.
- The malicious-task-text case proves the *scope* cannot be widened and unobserved travel fails; it
  does not enumerate every prompt-injection phrasing.
- Rate, budget and moderation controls are proved elsewhere (mission-runtime, memory-runtime,
  realtime-channel); this task does not re-prove them.

## 5. Migration / rollback

None. Test-only; no schema, storage or route change. Rollback is deleting the added test cases.

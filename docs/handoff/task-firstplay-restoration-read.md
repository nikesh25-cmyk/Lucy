# Fix the first-play restoration read

**Task:** NemoWorld priority item 5 — add a bounded, account-specific read that keeps the player's saved restoration contribution visible in the first-play guide, even when many newer events arrive.

**Branch:** `task-firstplay-restoration-read`  
**Base:** `46fb135ab147cc2b09c048809036303aec88b09e` (`integration/nemoworld-completed`)  
**Tip:** `23032dd77e0de018eb247bae3d10350d5ab09c21`  
**Changed files:** `src/firstplay.js`, `src/community.js`, `tests/first-play.test.js`

---

## 1. What changed

### `src/community.js`
- Exported `RESTORATION_LIST` so the test can verify the boundary exactly.
- Added one minimal, additive helper: `restorationForAccount(actor, agentId, limit)`.
  - It queries the audit trail for counted restoration work (`restoration.placed` and `restoration.contributed`) performed by the calling account.
  - It extracts the event id from the audit `record_id`, skips cancelled events, and returns `restorationEventView(event, agent.id)` — reusing the existing `restorationEventRecord`, `restorationPhase`, and `restorationEventView` helpers.
  - It is bounded by `RESTORATION_LIST` (default 8) and orders by `audit.seq DESC`.
  - It does **not** duplicate the restoration census policy; it only selects which event to render.

### `src/firstplay.js`
- In `firstPlay()`, the restoration block now prefers `restorationForAccount(actor, viewer.id)` when a viewer exists.
- If the account has no counted restoration work, it falls back to the existing global newest-eight `restoration()` read.
- Anonymous observation still uses only the global read.

### `tests/first-play.test.js`
- Imported `RESTORATION_LIST`.
- Added two tests:
  1. `account-specific restoration read stays visible past the global newest-eight list`
     - Two operators pledge and place counted objects in an older restoration.
     - Nine newer restoration events are opened by other operators, pushing the old event out of the global `restoration()` list.
     - Asserts the global list no longer contains the old event.
     - Asserts both operators' first-play guides still show the old event and `done.restore` remains true.
     - Asserts the placed objects in the old garden are unchanged and no coins were issued.
  2. `account-specific restoration read persists across server restart`
     - Same setup, then the platform is closed and reopened on the same database.
     - Asserts the returning guide still shows the old event, `done.restore` is true, and the objects remain.

---

## 2. What this is not

- No new table, column, index, trigger, or schema bump. `user_version` remains 22.
- No new currency or authority.
- No new route; the existing `/api/v1/first-play` route returns the same shape.
- The restoration census logic in `src/community.js` is reused, not duplicated.

---

## 3. Gate output

Run in the worktree `/Users/nikesh/Documents/Codex/2026-10-11/i-ve-prepared-automatic-mac-setup/work/firstplay-read`.

| Gate | Command | Result |
| --- | --- | --- |
| Syntax | `npm run check` | **pass** — exit 0 |
| First-play unit / HTTP | `npm test -- tests/first-play.test.js tests/first-play-http.test.js` | **30/30 pass** |
| E2E smoke | `npm run e2e` | **17 steps passed, 0 failed** |
| Content seal | `node scripts/seal-content.mjs --check` | **Verified: 89 definitions** |

Full `npm test` was also run:

- **842 tests, 841 pass, 1 fail, 0 cancelled, 0 skipped**
- The single failure is `tests/local-launch.test.js:11` — "local launcher selects a free loopback port, ignores hosted origin settings, and saves first-run state". It timed out while `scripts/start-mac.sh` downloaded a 49.8 MB runtime artifact. This test is unrelated to the first-play restoration read and did not fail on the changed code.

`npm run browser` could not be executed in this environment because `playwright-core` is not installed:

```
FAIL  playwright-core is not installed; run npm install for the dev dependency
      Cannot find package 'playwright-core' imported from .../scripts/browser-suite.mjs
```

This is an environment limitation, not a code regression.

---

## 4. Focused patch

The patch is the commit on `task-firstplay-restoration-read`:

```
23032dd77e0de018eb247bae3d10350d5ab09c21 Add bounded account-specific restoration read for first-play guide
```

Summary:

```
 src/community.js         | 22 ++++++++++++-
 src/firstplay.js         |  8 +++--
 tests/first-play.test.js | 84 +++++++++++++++++++++++++++++++++++++++++++++++-
 3 files changed, 110 insertions(+), 4 deletions(-)
```

---

## 5. Residual limits

- The account-specific read looks only at counted work (placement or explicit contribution audit rows). An old event where the player only pledged but never saved a counted step will still fall out of the guide when newer events arrive; that matches the design that a pledge is not counted work.
- The lookup is bounded to the same limit as the global list (`RESTORATION_LIST = 8`). If an account has counted work in more than eight old events, only the eight most recent (by audit sequence) are considered.
- Cancelled events are skipped; the next most recent account-specific event is returned.
- The browser suite and the local-launch test were blocked by environment dependencies (`playwright-core` missing, a network download timing out), not by this change.

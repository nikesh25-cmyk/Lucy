# Fix — release-blocking flakiness in the browser acceptance suite

Branch `fix-browser-suite-flake`, worktree `work/t15f`, based on **`4333636`**
(*Merge branch 'task-28-production-readiness' into verify-batch02-wave-c*), the merged batch-02
waves A–C tip (511 tests, e2e 15/15, 21 browser scenarios).

This is a **defect fix**. It changes only `scripts/browser-suite.mjs` and its unit test; no source
file, server route, template, configuration or **schema** is touched. All of the flakiness found is
a **suite** defect — the suite races the shipped server and the shipped client, or depends on the
order earlier scenarios left the shared browser contexts in. No flake was traced to a product bug;
one product-side observation is recorded under *Residual risk*.

## Changed files

| File | Change |
| --- | --- |
| `scripts/browser-suite.mjs` | Resumes a walk stopped by the server's own movement throttle (bounded, counted); rebuilds the re-subscription deterministically instead of assuming the client resubscribes; waits for the browser to finish a country-venue navigation before switching tabs. New exported pure helper `throttleRefusal`. |
| `tests/browser-suite.test.js` | One new unit check: only the server's own movement-throttle refusal is recognised (so a walk resumes for that alone). |
| `docs/handoff/fix-browser-suite-flake.md` | This document. |

No schema change and no migration: the suite still reads whatever schema the shipped server creates
in its own temporary database and writes only through the documented API.

## How the defect was reproduced

The suite is timing/order dependent. On the untouched base it fails both idle and, much more often,
under artificial CPU load. Raw logs are under `work/verification/` (outside the repo):

| Environment | Runs | Failed | Failure rate | Scenarios that failed |
| --- | --- | --- | --- | --- |
| Base, idle | 7 (`flake-01…07.log`) | 1 (`flake-02`) | **1/7 ≈ 14 %** | `subscription-entitlement-and-revocation` |
| Base, 8× CPU hog | 5 (`loaded-01…05.log`) | 3 | **3/5 = 60 %** | `quest-progression` (×2), `subscription-entitlement-and-revocation`, `interaction-ambassador-desk` |

`loaded-06.log` is the run that was in flight when the loop was stopped; it is **not** a valid run
(killed browser: *Target page, context or browser has been closed*) and is excluded above.

The report of *"3 of 6 runs failing"* was **not** reproduced verbatim on this machine: idle, the base
failed 1 of 7. The defect is real but strongly **load-sensitive** — the same base failed 3 of 5 with
CPU hogs present — which is what the two independent agents likely saw on a busier host. The rate,
not the defect, was the part of the report that did not hold here.

The two failures the task named were both observed:

- **`plot-and-blueprints` / `429 POST /api/v1/move`.** Seen on the base under load inside the walk
  helpers (`interaction-ambassador-desk` step 1, `loaded-03`, one refused step then a step timeout),
  and afterwards on the **fixed** tree inside `plot-and-blueprints` itself (`fixedload-04`), where the
  scenario would previously have collapsed (see *Evidence*).
- **`subscription-entitlement-and-revocation` re-subscribe race / `403 GET /api/v1/events`.**
  `flake-02`: step 3 timed out waiting for a fresh subscription while the browser repeated
  `403 GET /api/v1/events?world_id=home:<walker>`. `loaded-03`: step 3 read `ready` from a leftover
  stream, but the browser was in fact on the private `home:<neighbour>` (403), so the revocation could
  not close a real subscription and the step timed out.

A third, same-class flake surfaced under load and is fixed too: **`quest-progression`** read the
quest board while the world view was still on screen.

## Root cause of each flake (suite defect, not product)

### 1. A walk stopped by the server's own 120 ms movement throttle

The shipped server throttles movement and travel to one action per 120 ms, measured from when it
**processes** each action (`src/spaces.js:389` for `/move`, `src/spaces.js:426` for `/travel`);
`src/frontier.js:136-141` throttles building to one action per 200 ms. The interface walks the
resident one step at a time but paces its requests 160 ms apart from **request-send** time
(`app.js:332` `motionRequest`). When the server is busy — under load it can process two steps back to
back — the gap it measures falls below 120 ms and it answers `429 "Move more slowly."`. The client's
walk awaits each step and rethrows the refusal (`app.js:761` `walkTo`, `app.js:962-966` `moveAgent`),
so the walk stops where it stands.

The refusal itself is correct, documented server behaviour. The **suite** defect is that the scenario
took a recoverable, documented refusal as terminal:

- `plot-and-blueprints` clicked *Walk to plot* once and then `waitForResidentToSettle`, so a stopped
  walk left the resident outside the plot and every later assertion (anchor, preview, apply, remove)
  collapsed.
- `interaction-ambassador-desk` (and the other `walkResidentTo` users) waited for the tile but never
  retried the walk, so a single refused step timed the whole step out (120 s).
- `enterFrontierAs` clicked *Enter the frontier* once; a refused step in its internal walk/travel
  left the frontier panel absent and the step timed out.

### 2. A re-subscription the suite assumed but never established

Step 3 of `subscription-entitlement-and-revocation` made the garden public again and then asserted the
visitor held a live subscription, without pinning the world and without rebuilding the stream. The
shipped client deliberately stops after it is told access was revoked: it closes the stream
(`app.js:239-248`) and gives up retrying after repeated errors (`app.js:249-254`). So the "fresh
subscription" the scenario assumed did not exist:

- `flake-02` — the client never opened a stream on the reopened garden and repeated `403`; `ready`
  never became true.
- `loaded-03` — an earlier scenario had left the visitor's page showing a *different* world (the
  stranger's own private `home:<neighbour>`); `waitForClient(ready)` read a **leftover** `ready` from
  the previous world, the client then switched to the private home (`403`), and the later session
  revocation closed nothing.

The scenario also depended on **which world an earlier scenario left the shared browser context
showing** — the order dependence the task calls out. The suite defect is that it verified a boolean
(`ready`) rather than an actual subscription to a known, readable world.

### 3. A tab switch racing a country-venue navigation (`quest-progression`)

The step clicked *Enter with my resident*, waited only for the `journey_visits` row (written
server-side during the travel), then switched to the *Quest chains* tab. The click's handler keeps
running: `enterCountryVenue` → `travelAgent` → `await refresh()` then `state.tab='world'; render()`
(`app.js:2161`, `app.js:403`). That later render put the world back over the board, so the board read
returned the country venue. Again the row is a server effect observed *before* the client finished.

## The fix

- **Movement throttle (`scripts/browser-suite.mjs`).** New `throttleRefusal(notice)` recognises only
  the server's own documented refusal. `walkIntoPlot` (new), `walkResidentTo` (rewritten) and
  `enterFrontierAs` (rewritten) **resume** the walk from where the resident stands when — and only
  when — that refusal stopped it, bounded (≤ 5 attempts / a 100 s budget) and **counted** in the run
  notes. Any other reason to stop still fails immediately and loudly. No assertion was weakened, no
  timeout raised, no blanket retry added.
- **Re-subscription (`outsiderLooksAtPublicGarden`, new; used by both subscription steps).** The step
  now (a) asserts the garden is `public` in the database, (b) **reloads the visitor's page**, which
  always opens a brand-new event stream, and (c) waits until the stream is `ready` **and bound to the
  garden** — never a leftover `ready` on another world. The world is now pinned explicitly instead of
  inherited from an earlier scenario.
- **Country-venue navigation (`quest-progression`).** After the visit is recorded, the suite waits
  until the browser actually shows the country venue (`window.__nemoworld.worldId()` starts with
  `country:` **and** the world view has rendered) before switching tabs.
- **Unit test (`tests/browser-suite.test.js`).** `throttleRefusal` is exported and covered, so the
  "retry only the documented refusal" rule is guarded.

Every other guarantee is intact: the private temporary workspace, the production-database refusal,
teardown-on-failure, traces/screenshots/page-logs on failure, and a non-zero exit on any fail or
skip.

## Evidence

- **Before / after flake rate.** Idle: base 1/7 (14 %) → fixed **0/8**. Loaded: base 3/5 (60 %) →
  fixed **0/4**. Loaded runs kept 8 CPU hogs running and, in parallel, ran `npm test` throughout.

  | Set | Logs | Result |
  | --- | --- | --- |
  | Base idle | `flake-01…07.log` | 1 fail (14 %) |
  | Base loaded | `loaded-01…05.log` | 3 fail (60 %); `loaded-06` aborted, excluded |
  | **Fixed idle** | `fixed-01…07.log`, `final-browser.log` | **8/8 green (21 passed, 0 failed each)** |
  | **Fixed loaded** | `fixedload-01…04.log` | **4/4 green (21 passed, 0 failed each)** |
  | Parallel `npm test` under load | `fixed-loadtest-01…04.log` | 511 passed, 0 failed (each) |

- **The movement-throttle resume actually fired and saved the named scenario.**
  `fixedload-04.log`:

  ```
        walk retry       the server’s own movement throttle refused a step; resuming the walk into plot:0:0:0:0
      · the steward walks into the plot and previews a blueprint without writing — preview reported a valid plan at 2,3 …
  …
    - the walk into plot:0:0:0:0 was resumed 1 time(s) after the server’s own movement throttle refused a step
  …
  PASS  plot-and-blueprints (74447 ms)
  ```

  This is the exact `plot-and-blueprints` / `429 POST /api/v1/move` defect from the report: on the
  base it collapsed the scenario; here the suite resumed the walk, recorded the retry in the run
  notes, and the scenario passed. (The bounded resume did not need to fire in the other green runs.)

- **Re-subscription.** `subscription-entitlement-and-revocation` passed in every fixed run; the step
  now fails the run if the stream is not ready *and* on the garden, so the `flake-02` and `loaded-03`
  modes cannot pass silently.

- **Final gate output** (exact, on the fixed tree):

  `npm run check` — exit 0 (all 31 files pass `node --check`).

  `npm test` — `ℹ tests 512  ℹ pass 512  ℹ fail 0  ℹ skipped 0` (511 base + 1 new check).

  `npm run e2e` — `SUMMARY  15 steps passed, 0 failed` / `result PASS`.

  `npm run browser` — `SUMMARY  21 passed, 0 failed` / `result PASS — the interface was driven in a
  real browser and the database agreed`.

## Residual risk

- **Inherent timing dependence remains.** The suite drives a real Chrome against the real server with
  its shipped 120 ms movement / 200 ms building / 1500 ms land throttles. Under extreme load the
  bounded resume (5 attempts) or a per-walk 100 s budget could still be exhausted, in which case the
  scenario fails **honestly** rather than passing quietly.
- **Product-side observation (not fixed here; `app.js` is owned by another agent).** The client paces
  motion from *request-send* time (`app.js:332`) while the server throttles from *process* time, which
  makes `429 "Move more slowly."` reachable whenever the server processes two steps back to back. The
  suite now tolerates that refusal, but a client that retried it (or paced from the response) would
  remove the trigger at the source. Worth a follow-up, not release-blocking.
- **Other same-class races are possible but unobserved.** Any step that reads the rendered view right
  after an asynchronous client navigation could in principle race it. The suite fixes every instance
  that failed across 19 base/loaded runs; the remaining scenarios are, by construction, only as
  deterministic as the driver idioms they now share (`waitForClient` on a specific world/state rather
  than a bare boolean).
- **Host-specific.** Measured on this machine (macOS, Apple silicon, Node v24.19.0, system Chrome).
  The CI job runs the same suite on `ubuntu-latest`.

## Rollback

Revert the two file changes on `fix-browser-suite-flake` (`scripts/browser-suite.mjs`,
`tests/browser-suite.test.js`). Nothing in `src/`, `server.js`, `app.js`, `world.js`, `render.yaml`,
`outputs/Lucy`, `package.json`, the lockfile, `.github/`, `HANDOFF.md` or `docs/VERIFICATION.md` is
involved, and no installed account or database is affected.

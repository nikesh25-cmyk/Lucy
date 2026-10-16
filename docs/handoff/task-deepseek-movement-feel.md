# Character control and travel feel (frontend + input)

Branch `task-deepseek-movement-feel`, based on `codex/final-integration` at **`70359d0`**. The server
stays authoritative throughout: a movement control still sends one cardinal direction, and the client
still authors no position. What changes is how the confirmed step is *drawn*, how a refusal is shown,
and how the entrances between connected areas are offered.

- **Schema: unchanged.** No migration, no table, column, index, trigger or `PRAGMA user_version` was
  touched. No new runtime dependency; `package.json` and `package-lock.json` are untouched.
- **Base gates at `70359d0`:** `npm run check` exit 0; `npm test` **888 tests, 887 pass, 1 fail** (the
  `tests/mobile-styles.test.js` failure this slice is required to fix); `npm run e2e` **17 steps
  passed, 0 failed**.

## 1. Goal

Make movement *feel* good without moving any authority to the client:

1. interpolate smoothly between confirmed tiles so the drawn avatar never silently diverges from the
   stored tile;
2. make the camera and its readouts responsive in first-person and orbit;
3. give clear input feedback for press, refusal and reconcile;
4. make travel across connected areas discoverable and reversible;
5. keep keyboard, pointer, 390 px touch and reduced motion working;
6. add an explicit refusal-recovery path: when the server refuses a step, visibly reconcile to the
   stored tile with a readable reason and let the player continue.

No continuous physics and no client-decided position were added.

## 2. Files changed

| File | Change |
|---|---|
| `src/camera-controls.js` | **changed** — three new pure exports (below). Nothing pre-existing changed. |
| `app.js` | **changed** — presence now uses `createPresenceTracker`; `performMove` reports step / blocked / restored outcomes and reconciles on a refusal; the aim line and position readout follow the drawn tile; a HUD input-feedback line and a HUD travel panel; the arrival notice names the way back; `syncTouchEnabled()` switches the touch layer off through `setEnabled`. |
| `game-theme.css` | **changed** — **removed** the `body.game-world.game-chat-open .nm-touch{display:none}` rule (the failing base issue); added `.game-feedback`, `.game-travel` and their responsive placement; hid both during a conversation. No `.nm-touch` selector remains in any main stylesheet. |
| `tests/presence-interpolation.test.js` | **new** — 7 tests. |
| `tests/travel-affordance.test.js` | **new** — 5 tests. |
| `tests/movement-feedback.test.js` | **new** — 4 tests. |
| `docs/CONTROLS.md` | **changed** — movement feel, refusal recovery, travel and input-feedback sections. |
| `docs/GAME_INTERFACE.md` | **changed** — one paragraph on movement feel, travel and feedback. |
| `docs/handoff/task-deepseek-movement-feel.md` | **new** — this file. |

Not touched: `server.js`, `src/platform.js`, `runtime/agent.js`, `src/journey.js`,
`src/browser-session.js`, `src/hosting.js`, `src/recovery.js`, `src/voxel-*.js`, `src/scene/**`,
`src/spaces.js`, `world.js`, `native/**`, `src/community.js`, `src/quests.js`, `game-mobile.css`,
`index.html`, `src/game-input.js`, `src/movement-queue.js`, `src/world-walk.js`,
`src/ui/touch-controls.js`, `scripts/browser-suite.mjs`, `style.css`, `nemo-theme.css`,
`package.json`, `package-lock.json`, `outputs/Lucy`.

The three pure exports in `src/camera-controls.js`:

- `createPresenceTracker({ now, duration, snapDistance, reducedMotion })` — one owner for the drawn
  avatar's interpolation, with `confirm / display / record / reconcile / settling / tweening / clear`.
  A one-tile step glides over `DISPLAY_TWEEN_MS` (180 ms) on the segment to the newest confirmed tile;
  a longer jump, or any world change, snaps; a reduced-motion viewer always snaps. `displayCoords` is
  exported too and is the eased point clamped to `[from, confirmed]`.
- `travelRoutes(portals, from, { limit, commons, home })` — the entrances from a position, the way back
  to the Commons or the resident's home sorted first, then by distance; `routeHint(route)` is its
  one-line label. Only a portal with an integer tile and a target becomes a route.
- `moveFeedback({ outcome, direction, from, to, cause, message })` and `blockedCause({ terrain, scenery,
  outside })` — the one wording per input outcome (step / blocked / restored / travel) and the readable
  obstacle name (water, a tree, a building, a wall, the fountain, a solid object, the edge of the world).

## 3. The known base issue (fixed)

`tests/mobile-styles.test.js` failed at `70359d0` because `game-theme.css` carried
`body.game-world.game-chat-open .nm-touch{display:none}`, and that test asserts no main stylesheet
contains the token `nm-touch` (the scoped touch stylesheet is `game-mobile.css`'s alone).

Fixed as required, without weakening the test:

- the rule is **removed** from `game-theme.css`;
- `app.js` gained `syncTouchEnabled()`, which calls `touchControls?.setEnabled(...)`, and it is called
  from `applyGameShell()` (every drawer/menu/screen change) and at the end of `mountTouchControls()`.
  `setEnabled(false)` both hides the layer and stops a held gesture (it cancels the pad's repeat timers),
  which a stylesheet rule could never do.

## 4. What was tested

`npm test` runs `node --test` over the whole suite. New test names, by file:

`tests/presence-interpolation.test.js`
- *the drawn point is on the segment and lands exactly on the confirmed tile* — the eased point is
  monotonic and stays inside `[from, confirmed]`, and a finished tween is exactly the confirmed tile;
- *a one-tile step glides from the drawn tile and settles on the stored tile* — a real step schedules a
  180 ms glide, the midpoint is between the tiles, the end is exactly the stored tile, and the confirmed
  record is never mutated;
- *a jump farther than one tile, or a world change, snaps instead of gliding* — a 20-tile jump and an
  adjacent cross-world change both snap;
- *a reduced-motion viewer receives the stored tile immediately, with no glide at all* — no transition,
  nothing settling, and the predicate is re-read per confirm;
- *reconcile drops the tween so a refused step is drawn at the stored tile again* — mid-glide reconcile
  returns the stored tile, stops the loop, and an unknown id is a no-op;
- *an unknown participant is passed through untouched and the tracker forgets on clear*;
- *the shell wires the tracker and switches the touch layer through its own control* — app.js owns the
  tracker with `performance.now` and the reduced-motion preference, calls `setEnabled`, and the main
  stylesheet carries no `nm-touch`.

`tests/movement-feedback.test.js`
- *an accepted step reports the direction and the tile the server stored*;
- *a refusal names the obstacle, the stored tile, and the way out* — and never says "Stepped";
- *a failed request is a refusal too: the server's reason travels with the reconcile*;
- *the obstacle is named from the terrain and scenery the client already holds* — including the edge of
  the world and an unnamed terrain type.

`tests/travel-affordance.test.js`
- *the way back is sorted first, then the nearest entrance, and each route names its distance*;
- *a resident's own home is reversible too, and the limit caps the list*;
- *only a portal the server actually published becomes a route* — a missing target, a non-integer tile
  and a non-portal are all skipped; the camelCase alias is honoured;
- *a route label falls back to the portal name, and the hint states the place and the distance*;
- *equal distances are ordered deterministically, so the list never reshuffles on a repaint*.

### Database assertions

This slice writes no new server state, so the database assertions are the shipped ones the browser suite
already makes for movement: `first-person-controls` reads `agents.x,y,z,yaw,pitch` before and after a
drag and a movement control (a rotation must not move the resident); `signed-in-game-play` reads
`agents.x,y` to prove exactly one stored tile per key and `agents.world_id,x,y` after a reload;
`shared-presence-two-clients` reads `agents.x,y` on both clients and asserts the observing browser's
`window.__nemoworld.presence()` record holds the same confirmed tile the database stores. All of them
are unchanged and still pass (see §6).

## 5. Real browser evidence (scenario-by-scenario)

`npm run browser` drives the system Chrome build (**155.0.8059.40**) against a temporary SQLite database
and reads the server's own records after every browser action. **39 passed, 0 failed.** The teardown
reported *server stopped, process lock released: true; temporary workspace removed: true; shipped
database untouched*. Every scenario, in suite order:

| # | Scenario | Result |
|---|---|---|
| 1 | hero-introduction-film | PASS |
| 2 | game-entry-and-observation | PASS |
| 3 | accounts-and-switching | PASS |
| 4 | world-sound-controls | PASS |
| 5 | signed-in-game-play | PASS |
| 6 | credential-exclusion | PASS |
| 7 | private-draft-isolation | PASS |
| 8 | refresh-and-focus-restoration | PASS |
| 9 | first-person-controls | PASS |
| 10 | country-ambassadors | PASS |
| 11 | plot-and-blueprints | PASS |
| 12 | character-switch-clears-preview | PASS |
| 13 | quest-progression | PASS |
| 14 | guild-cooperation | PASS |
| 15 | reward-refusals | PASS |
| 16 | forged-coin-receipt-refused | PASS |
| 17 | resident-run-resume-refusal | PASS |
| 18 | shared-presence-two-clients | PASS |
| 19 | subscription-entitlement-and-revocation | PASS |
| 20 | interaction-hint-and-distance | PASS |
| 21 | game-hud-interaction-prompt-and-aim | PASS |
| 22 | interaction-saved-world-changes | PASS |
| 23 | interaction-door-and-crafting | PASS |
| 24 | interaction-ambassador-desk | PASS |
| 25 | interaction-state-refusals | PASS |
| 26 | consolidated-proposal-history | PASS |
| 27 | shared-build-and-restart | PASS |
| 28 | cooperative-restoration-two-operators | PASS |
| 29 | reviewer-workbench | PASS |
| 30 | review-states-and-refusals | PASS |
| 31 | live-observation-readonly | PASS |
| 32 | game-shell-entry-and-continue | PASS |
| 33 | management-interface-and-roles | PASS |
| 34 | private-memory-and-journal-boundaries | PASS |
| 35 | first-ten-minutes | PASS |
| 36 | first-play-solo-ambassador | PASS |
| 37 | restoration-two-clients | PASS |
| 38 | phone-conversation | PASS |
| 39 | signout-privacy | PASS |

The scenarios that carry this slice, and what they actually observed:

- **`shared-presence-two-clients`** (the interpolation over the live channel): *"move: click → the other
  client's view in 479 ms; channel frame delivery 1 ms; animation frames: median 16.7 ms, max 16.8 ms
  over 29 frames"*. The suite also asserts the observing browser's `window.__nemoworld.presence()`
  record holds exactly the tile the database stores — the interpolation's confirmed value is the
  server's.
- **`first-person-controls`** (camera and readout): *"aim line starts with 'First person' from tile
  10,6"*; *"yaw 0.000 → 0.416, position 10,6 unchanged · aim line 'First person · facing north-west ·
  at 10, 6, layer 0…'"*; *"moved 10,6 → 10,5; the accessible aim line names the new tile"*.
- **`signed-in-game-play`** (keyboard step, drawers, reload): *"Browser player restored at
  commons:10,5"*; *"five quickbar actions fit a 390px phone, each at least 40px tall"*.
- **390 px**: `game-entry-and-observation` — *"390px phone: scene 390×784, world menu opened"* with
  `document.documentElement.scrollWidth <= innerWidth`; `hero-introduction-film` — *"390px mobile
  fits"*; `signed-in-game-play` at 390×844; `phone-conversation` at 390×844.
- **Reduced motion**: `phone-conversation` — *"a reduced-motion phone opens the same blank composer
  with no transition or saved step"* (the guide root carries `game-guide-reduced`, every transition
  measures `0s`, and the button stays ≥ 44 px).
- **Travel**: `interaction-door-and-crafting` and `shared-build-and-restart` exercise the shipped
  portal journey (a doorway travels to another world and the progress survives a restart).

Beyond the suite, a throwaway probe (a temporary script, deleted before the commit) drove the same
Chrome build against a throwaway database to observe the two new surfaces the suite does not assert,
and measured:

- a real step mid-glide: `display {x:10, y:5.99}` against `confirmed {x:10, y:5}, tweening: true` —
  the drawn avatar is on the segment, not on either stored tile;
- the same step under `prefers-reduced-motion: reduce`: **0** tweening frames in 44 samples and no
  fractional point — the drawn avatar is always the stored tile;
- a refusal: pressing into the edge of the world showed the HUD line *"The way up is blocked.
  Restored to 10, 0 — choose another direction."* with tone `game-feedback-refused`;
- layout at 390×844 and 1440×900: `scrollWidth` equals the viewport width at both sizes, the feedback
  line sits clear of the d-pad (bottom 648 vs the pad's top 655 on the phone), and the travel panel
  renders three labelled entrances in the right column on desktop and is hidden by CSS on the phone.

## 6. Gates (actual output)

Delivered tree frozen at the commit before the browser run; interpreter `work/node-bin/node`
(**v24.19.0**).

```
$ npm run check
CHECK_EXIT=0            (every file the gate lists parses, including the changed app.js and
                         src/camera-controls.js)

$ npm test
ℹ tests 904
ℹ pass 904
ℹ fail 0
TEST_EXIT=0             (base at 70359d0 is 888 tests / 887 pass / 1 fail — the mobile-styles failure
                         this slice fixes; +16 new tests = 904, all green)

$ node --test tests/presence-interpolation.test.js tests/travel-affordance.test.js tests/movement-feedback.test.js tests/mobile-styles.test.js tests/movement-queue.test.js tests/camera-controls.test.js tests/game-input.test.js tests/touch-controls.test.js
ℹ tests 71
ℹ pass 71
ℹ fail 0

$ node --test tests/mobile-styles.test.js
ℹ tests 9
ℹ pass 9
ℹ fail 0               (the required base-issue fix)

$ npm run e2e
SUMMARY  17 steps passed, 0 failed
E2E_EXIT=0

$ LUCY_BROWSER_ONLY=game-entry-and-observation,first-person-controls,signed-in-game-play npm run browser
SUMMARY  3 passed, 0 failed

$ npm run browser
SUMMARY  39 passed, 0 failed
  result  PASS — the interface was driven in a real browser and the database agreed
```

## 7. Residual limits

- **The touch layer renders off-screen in the game shell.** Measured on a 390×844 phone: `.nm-touch` is
  mounted in the flow of `.world-panel` *after* a full-height canvas, so its box sits at `y=844` (its
  bottom at 1159) and the panel's `overflow:hidden` clips it. This is pre-existing — it is true at
  `70359d0` and independent of this slice — and the visible phone movement control today is the
  `.world-bottom` d-pad, which keeps working. The required fix (switch the layer off through
  `setEnabled` and remove the main-stylesheet rule) is implemented, but it hides a layer that was
  already off-screen. Repositioning it would need a wider mobile-HUD pass across the guide, the control
  band and the d-pad, which is outside this slice's deliverables; this is recorded so a later task does
  not mistake the passing `mobile-styles` test for a working on-screen pad.
- **The phone has no HUD travel panel.** A 390 px viewport has no free column: the guide spans the full
  width and the control band reaches the d-pad, so `.game-travel` is hidden below 650 px and the same
  routes stay in the More drawer's *Your place in the world* list. The desktop/tablet panel is the new
  affordance.
- **The refusal-feedback and travel panels have no browser-suite scenario.** `scripts/browser-suite.mjs`
  is outside this slice's file ownership, so no scenario was added. Their behaviour is covered by the 16
  new unit tests and by the throwaway probe above, not by a committed acceptance scenario.
- **`.game-observer-controls` has no CSS** and is likewise in the flow after the canvas, so the
  observer's on-screen pan buttons are clipped; the keyboard path (`ArrowRight` pans, asserted by
  `game-entry-and-observation`) is the one that works. Pre-existing and outside this slice.
- **A refusal's cause is inferred client-side.** The `/move` route returns `blocked: true` without a
  reason, so the obstacle name (water, a tree, a building, a wall, the fountain, a solid object, the
  edge of the world) is read from the terrain and scenery this client already holds. If the client's
  scenery view is stale the name could be one refresh behind; the *wording never claims a step*, and
  the server's own message is used verbatim for a failed request.
- **The feedback line persists until the next outcome.** It has no timer, so a refusal stays readable
  while the player decides; an accepted step replaces it. It is cleared on a character change and on
  sign-out.
- **`tileOf` rounds the height.** During a climb the aim line names the nearest layer while the avatar
  is between layers; at rest it is exact.
- **No browser measurement of the 651–1279 px travel placement.** The panel's `top:210px` below the aim
  line at those widths is reasoned from the stylesheet, and measured only at 390 px and 1440 px.

## 8. Migration and rollback

- **Schema: unchanged.** No table, column, index, trigger, view or `PRAGMA user_version` was touched
  (`src/database.js` still writes `PRAGMA user_version=22`; 23 is reserved for another owner and this
  slice does not need it). No new dependency; `package.json` and `package-lock.json` are untouched.
- **No new server state.** The slice writes nothing to the database; every write still goes through the
  shipped `POST /move`, `/climb` and `/agents/:id/travel`, and the new helpers only read `GET /world`'s
  `portals` and the client's own world snapshot.
- **Rollback** is `git revert` of the single commit (or a checkout of `70359d0`). Reverting removes the
  three new test files and restores `game-theme.css`'s `game-chat-open .nm-touch` rule, which re-breaks
  `tests/mobile-styles.test.js` at the base — so a revert must be paired with reverting the base commit
  that introduced that rule. `src/camera-controls.js` keeps every pre-existing export unchanged, so
  nothing else that imports it is affected.

## 9. Reproducing

```sh
cd work/w-move && export PATH="$PWD/../node-bin:$PATH"
npm run check && npm test && npm run e2e
node --test tests/presence-interpolation.test.js tests/travel-affordance.test.js tests/movement-feedback.test.js
npm run browser
```

The patch is `patches/task-deepseek-movement-feel.patch` (`git format-patch -1 HEAD`); it applies
cleanly to `70359d0`.

# Task 38 — frontend integration and acceptance

Branch **`task-38-frontend-integration`**, worktree `work/t38`, base commit **`7e91e7c`**
(*Merge branch 'task-37-mobile-accessibility' into verify-game-wave-c*). **Schema is unchanged: 21.**
No migration, no new table, column, index, trigger or view. No new dependency (`playwright-core` stays
the only devDependency and is not imported by any production file).

Baseline re-measured on the frozen base commit in this worktree before any change: **720 tests, 720
pass, 0 fail, 0 skipped**; `npm run check` exit 0; e2e **15/15**; browser acceptance **26 scenarios**;
content seal **89 definitions** (the packet's "86" is stale for this wave, as task 33 also recorded).

Deliverable: the application shell, wired around the modules tasks 31–37 delivered, plus the browser
acceptance evidence for it.

## 1. Changed files

| File | Change |
| --- | --- |
| `server.js` | The static route map: `src/characters.js`, `src/character-animation.js`, `src/game-input.js`, the five `src/ui/*.js` components, `/game-mobile.css` and `/manage` (served from `index.html`). |
| `package.json` | `check` now syntax-checks the four new modules and the five UI components. |
| `src/voxel-world.js` | Task 32's five wiring edits plus the two scene questions: one motion tracker per scene, the module's visual key and batch, `isAnimating()` / `reconcileCharacter(id)`, `tracker.clear()` on destroy. `peopleVisualKey` is kept as a wrapper. |
| `app.js` | The shell: imports and constructs the input controller and the five UI components, one `handleIntent`, the keydown replacement, the entry screen, the character overlay, the five-action HUD with the one next-action line, the four drawers, the observer controls, `/manage`'s nav rule, the touch mount, and the E-key wording fix. |
| `index.html` | The `<link rel="stylesheet" href="/game-mobile.css">` and the `#character-dialog` overlay. |
| `nemo-theme.css` | The shell's own rules, appended: entry notes, the H4 line, the prompt and overlay hosts, the build host, the observer controls and status line, the drawer cards, and the character dialog. No new colour and no new page. |
| `scripts/browser-suite.mjs` | Four new scenarios; `signed-in-game-play` updated for the new entry door and the five-action quickbar. |
| `tests/browser-suite.test.js` | The registry count 26 → 30. |
| `tests/newcomer-journey.test.js` | The dialog-count assertion 3 → 4, because the game-experience specification adds the character overlay as a named native dialog. Every per-dialog assertion is kept and two are added for the new dialog. |
| `tests/mobile-styles.test.js` | The "index.html does not link the mobile stylesheet" assertion becomes the integration owner's new contract: index.html links it exactly once. Every other scoping assertion is untouched. |
| `docs/GAME_INTERFACE.md` | `E` turns the camera; Enter, Space or I use the fixture. |
| `docs/GAME_EXPERIENCE.md` | §13: what is built, what is still a target, and the deliberate deviations. |
| `docs/VERIFICATION.md`, `HANDOFF.md` | The release figures and the shell summary. |
| `docs/handoff/task-38-frontend-integration.md` | This file. |

Nothing in `content/**`, `assets/**`, `outputs/Lucy`, `src/frontier.js`, `src/places`, `src/coins.js`,
`src/civic-engine.js`, `src/ui/**`, `src/characters.js`, `src/character-animation.js`,
`src/game-input.js`, `src/scene/**` or `game-mobile.css` was modified.

## 2. The modules wired, and the interface each was wired through

| Module | Task | How the shell uses it |
| --- | --- | --- |
| `src/characters.js` + `src/character-animation.js` | 32 | `src/voxel-world.js` imports `charactersScene`, `charactersVisualKey` and `createMotionTracker`; `createVoxelScene` owns one tracker, confirms every drawn position before the key and the batch are computed, and draws `charactersScene(cubeBatch(resources), …)`. `createVoxelWorld` exposes `isAnimating()` and `reconcileCharacter(id)`; `app.js` includes the 3D view in its existing paint loop and calls `reconcileCharacter` on a refused move. |
| `src/game-input.js` + `src/camera-controls.js` | 33 | One `createGameInput` controller with the shell's `worldContext`, `isSuspended` (menu, drawer, `document.querySelector('dialog[open]')`, or an open interaction overlay), a `blocksView` built from `createViewBlocker` over `walkable`/`solidSceneryAt`/`surfaceAt`, and `onIntent: handleIntent`. The inline keydown is replaced by `gameInput.press`, and the view toggle drives `setCameraMode` so the tab's first-person preference keeps its shipped key. |
| `src/ui/build-interface.js`, `src/ui/inventory-panel.js` | 34 | A `createHotbar`, a `createPlacementPreview` and a `createInventoryPanel` built once, fed `state.world` / `state.journey` on every render, and mounted with the module's own `mount`. The pick source is the injected `{currentPick, subscribe}` interface; `pickWorld` notifies every listener. The hotbar and the placement preview appear in a frontier area in a `.game-build-host` that shows only while building. |
| `src/ui/interaction-prompt.js` | 35 | One controller over a transport built from the shipped `api()`. The prompt and its overlay paint into `#game-prompt-host` and `#game-overlay-host`; the keydown handler offers each key to `handleKey` first, and a confirmed interaction is announced with `confirmationMessage`. |
| `src/ui/spectator.js` | 36 | `observeWorld()` builds `createReadonlyTransport({fetch})` and a `createSpectatorView`, opens the world, and passes the live channel **only when a session exists**. The observer's controls pan and follow through `intent()`; the HUD renders `status().detail` in a `role="status"` line and a refusal as `role="alert"`. The transport can only issue the allow-listed public GETs, so the observation path has no write verb at all. |
| `src/ui/touch-controls.js` + `game-mobile.css` | 37 | The stylesheet is linked once from `index.html` and the layer is mounted from the world view on a coarse pointer or a screen at or below 900 px. The injected interface maps `walk` to `controlStep`, `look` (a *relative* rotation) to `state.facing + delta` through `queueLook`, `interact` to `usePickedFixture`, `build` to the HUD's own Build control, and `affordance` to `setGameDrawer`. |

### 2.1 The two modules that needed a change, and the minimum that was made

- **`src/voxel-world.js`** (this task owns the character wiring and nothing else). The five edits from
  `docs/handoff/task-32-characters.md` §wiring were applied verbatim, plus step 6 (`tracker.clear()`)
  and step 7 (the two questions). Two decisions were needed:
  - `peopleVisualKey` is **kept** as a thin wrapper over `charactersVisualKey` instead of being
    deleted. `tests/voxel-world.test.js:7` imports it and asserts three properties on it, and the
    alternative — moving those assertions — would have deleted coverage this task does not own. One
    key still decides a rebuild, so the two cannot drift.
  - `peopleScene`, `PEOPLE_FIELDS` and `renderablePeople` are **kept**. `tests/content.test.js` asserts
    the literal string `AGENT_COLORS[item.color]` and the four sealed skin-tone hex values appear in
    `src/voxel-world.js`, and both live in `peopleScene`. Deleting it would have forced a rewrite of
    that colour-drift contract. The scene no longer calls it; it stays as the file's declared colour
    source, and the comment above it says so.
- **`app.js`** is the shell this task owns. Within it, the only shipped behaviour changed rather than
  added is the entry default: a signed-in operator is no longer pushed from the entry screen into play
  (`applyGameShell` no longer calls `setGameMode('play')` for a signed-in account), because Continue
  can only be shown if the entry screen is shown. `state.gameMode` is still remembered in this tab, so
  the choice is not repeated after a reload.

## 3. The shell, against the specification

`docs/GAME_EXPERIENCE.md` §13 is the item-by-item scorecard. In one paragraph: the entry screen is
Play · Observe · Continue over the drawn world with the film as a text link; the account overlay is
the shipped dialog unchanged; the character overlay is a new named native dialog that picks or creates
a resident with the shipped fields; the HUD carries H1–H5 (H4 is a new one-line `#game-next-action`
rather than the shipped `.calling-hud`, which also carries a progress bar §5.1 forbids) and the five
actions; Chat, Journal, Inventory and Projects are four dismissible drawers in the same aside, one at a
time; and governance, administration and diagnostics leave the newcomer's path for `/manage`, reached
from one role-gated **Management** entry. Every displayed value is a server field; `app.js` contains
no `innerHTML` and no markup assignment (asserted by `tests/newcomer-journey.test.js`,
`tests/guilds-http.test.js` and `tests/quests-http.test.js`).

### 3.1 What was not built

- The platform-paused state is not printed on the entry screen (the HUD kicker still says
  `WORLD PAUSED`).
- Continue remains browser-local; there is still no per-account "last played character" column, and
  `docs/GAME_EXPERIENCE.md` §8.1 says that would be a schema change belonging to a database task.
- No new measured contrast pair was added for the new shell surfaces; they reuse the existing tokens,
  and no existing measured pair changed.
- The four surfaces owned by tasks 22, 23, 25 and 26 are not hosted or referenced; `/manage` is the
  place they belong when those branches land.

## 4. Acceptance scenarios, and what each asserts at the database level

| Scenario | Browser action | Database / server assertion |
| --- | --- | --- |
| `live-observation-readonly` (**new**) | A visitor with no session presses **Observe**, follows a resident from `#observer-follow`, pans one tile, then attempts four writes from that page and presses the Build control | The spectator publishes the resident at its stored tile `11, 7`; `status().live === false` for an anonymous visitor; all four writes answer `>= 400`; afterwards the resident's `world_id,x,y`, the `frontier_blocks`, `messages` and `world_objects` counts are byte-for-byte unchanged |
| `game-shell-entry-and-continue` (**new**) | A first-time visitor sees Play and Observe and no Continue; then sign-in, **Continue as Pathfinder**, the five quickbar actions, Chat then More, and the character overlay creating a resident | `window.__nemoworld.selected()` is the remembered character after Continue; `document.body.dataset.gameDrawer` holds exactly one value; `SELECT COUNT(*) FROM agents` grows by exactly one and the new row carries `kind='agent'`, `status='active'` and the typed name; the shell then enters the world as that row |
| `management-interface-and-roles` (**new**) | A member opens the game menu; an administrator opens `/manage`, then the same game menu | The member's menu has no **Management**, **Review**, **Mission studio**, **Administration** or **Safety** entry; `/manage` renders the management presentation (`game-world` absent) and offers all four governance sections to an administrator; the administrator's game menu holds exactly one **Management** entry and no governance group |
| `private-memory-and-journal-boundaries` (**new**) | The operator records a purpose and a journal entry, then reads both pages | `resident_memory` holds exactly one `state='active'` fact and `journey_journal` exactly one entry; the owning operator reads the value over HTTP and sees it on the page; another operator gets `404` with no value in the body; a **sibling character's runtime credential** gets `404` for the walker's memory and `>= 400` for its journey, while reading only its own record; the private journal is `>= 400` with no token |
| `shared-build-and-restart` (base, re-run) | Two humans build through the UI and a scoped AI runtime adds a block; a grant is previewed and confirmed; one herb is offered and accepted; the server is restarted | Three attributed `frontier_blocks` rows with the guest's `grant_id`; `resource_offers` walks to `accepted` with one event and the two shelves reconcile; `coin_rewards` is unchanged (building and exchange issue no coin); after `stopServer(); startServer()` every project row, grant, offer, event and inventory is identical |
| `accounts-and-switching` (base, re-run) | Signup, login, logout and account switching through the dialog | The session cookie and the account rows; sign-out leaves no cached private state |
| `signed-in-game-play` (updated) | Play from the entry screen enters the human player in first person, a keyboard step moves exactly one tile, Chat and More open, a reload restores the saved tile, and the phone quickbar fits | One stored step (`world_id,x,y` changes by exactly one on the operated axis) and the reload reads the same stored row; the quickbar is five controls inside 390 px |

The base's other 22 scenarios are unchanged and still pass. Four overlap with this task's list and are
the reason it does not duplicate them: `shared-build-and-restart` covers two humans and an AI building
together, item exchange, the operator-level private-memory boundary and restart persistence;
`accounts-and-switching` covers logout and login; `game-entry-and-observation` covers the anonymous
public read of the world.

## 5. Actual results

All five gates were run on this tree, in this order, with `export PATH="$PWD/../node-bin:$PATH"`
(Node v24.19.0). The browser suite was run in full several times while this work was in progress; the figures
below are the final frozen tree, re-run after the last edit.

### `npm run check` — exit 0

```
> node --check server.js && … && node --check src/game-input.js && node --check src/characters.js
  && node --check src/character-animation.js && node --check src/ui/build-interface.js
  && node --check src/ui/inventory-panel.js && node --check src/ui/interaction-prompt.js
  && node --check src/ui/spectator.js && node --check src/ui/touch-controls.js && …
CHECK=0
```

### `npm test` — exit 0, **720 tests, 720 pass, 0 fail, 0 skipped**

```
ℹ tests 720
ℹ suites 0
ℹ pass 720
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 61270.178833
TEST=0
```

The baseline on this branch was also **720 tests, 720 pass**, so the count is unchanged: four new
browser scenarios and their registry assertions do not add `node:test` cases, and the three edited
test files keep every assertion they had. No test was deleted, skipped or weakened; the two assertion
values that changed (the dialog count and the `game-mobile.css` link) are policy changes this task is
the owner of, and both were made stricter rather than looser.

### `npm run e2e` — exit 0, **15/15 steps pass**

```
SUMMARY  15 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API
E2E=0
```

### `node scripts/seal-content.mjs --check` — exit 0

```
Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.
SEAL=0
```

### `npm run browser` — exit 0, **30 scenarios passed, 0 failed, 0 skipped**

```
NemoWorld browser acceptance suite
  browser           155.0.8059.40
  … (30 scenarios)

TEARDOWN
  server stopped, process lock released: true
  temporary workspace removed: true
  shipped database untouched

SUMMARY  30 passed, 0 failed
  result  PASS — the interface was driven in a real browser and the database agreed
BROWSER=0
```

Scenario timings from that run:

```
  PASS  hero-introduction-film (1661 ms)
  PASS  game-entry-and-observation (1704 ms)
  PASS  accounts-and-switching (3155 ms)
  PASS  signed-in-game-play (1454 ms)
  PASS  credential-exclusion (1594 ms)
  PASS  private-draft-isolation (2078 ms)
  PASS  refresh-and-focus-restoration (670 ms)
  PASS  first-person-controls (3634 ms)
  PASS  country-ambassadors (724 ms)
  PASS  plot-and-blueprints (15930 ms)
  PASS  character-switch-clears-preview (3762 ms)
  PASS  quest-progression (22349 ms)
  PASS  guild-cooperation (2323 ms)
  PASS  reward-refusals (2360 ms)
  PASS  forged-coin-receipt-refused (445 ms)
  PASS  resident-run-resume-refusal (810 ms)
  PASS  shared-presence-two-clients (8374 ms)
  PASS  subscription-entitlement-and-revocation (2450 ms)
  PASS  interaction-hint-and-distance (1615 ms)
  PASS  interaction-saved-world-changes (5062 ms)
  PASS  interaction-door-and-crafting (4715 ms)
  PASS  interaction-ambassador-desk (25498 ms)
  PASS  interaction-state-refusals (6267 ms)
  PASS  consolidated-proposal-history (1152 ms)
  PASS  shared-build-and-restart (14238 ms)
  PASS  live-observation-readonly (831 ms)
  PASS  game-shell-entry-and-continue (2183 ms)
  PASS  management-interface-and-roles (3066 ms)
  PASS  private-memory-and-journal-boundaries (4567 ms)
  PASS  signout-privacy (7904 ms)
```

**Claims that are not made.** No screenshot, frame time, latency, contrast ratio or pixel measurement
for the new shell surfaces is claimed: the suite asserts structure, server calls and database effects,
not appearance. The touch layer is not driven in this run (it needs a coarse pointer or a narrow
screen) and remains covered by task 37's module and stylesheet tests. No live FPS or multiplayer
capacity claim is made anywhere.

### 5.1 The browser failures that were found, and what fixed them

The suite was not assumed to pass. Four failures appeared in the first full run and are recorded here
because each one was a real defect in the acceptance code, not a product bug:

| Failing scenario | Cause | Fix |
| --- | --- | --- |
| `hero-introduction-film` | It clicked the hero button **Watch the film**, which task 38 moved to the text link under the entry controls. A genuine stale assertion from a changed policy. | Click `#hero-actions a.game-film-link`. The film dialog and its playback assertions are unchanged. |
| `game-shell-entry-and-continue` | The shared administrator context had already stored a game mode in this tab, so the entry screen never appeared for the "first-time visitor" step. | A dedicated context that clears `sessionStorage`/`localStorage` before the first-visit assertion. |
| `management-interface-and-roles` | An earlier scenario left a remembered section focus with a live draft, and the shell's draft layer deliberately reopens that section instead of the world, so `body.game-world` was absent. | The scenario clears its own tab's remembered focus and drafts, loads a fresh page for the privileged step, and asserts `body.game-world` explicitly with the page state as evidence. |
| `private-memory-and-journal-boundaries` | Two full-run-only dependencies: the fixture operator session had been revoked by the earlier revocation scenario (`401`), and the platform allows one active runtime session per operator, so the sibling credential was refused `429`. | The scenario signs its two operators in for itself, and ends an earlier runtime session through the documented pause/resume route before starting its own. No limit was widened. |

The fourth fix is recorded in full because it is the one that could be mistaken for a policy change: it
does not raise the one-runtime-session limit, it stops the stale session and starts a new one.


## 6. Migration and rollback

**No migration.** The database stays at **`PRAGMA user_version` 21**: no table, column, index, trigger,
view, route permission or content definition was added or altered, and `node scripts/seal-content.mjs
--check` still verifies 89 definitions, 3 support files and 42 referenced notices and assets. An
existing schema-21 installation needs nothing run and no backup beyond the ordinary one.

**Rollback of the shell** is a checkout of the base commit `7e91e7c`. Every change is additive at the
runtime level: the static route map only gains entries, the `check` list only gains files, and
`app.js`/`index.html`/`nemo-theme.css` revert to the shipped shell. `src/voxel-world.js` reverting
restores `peopleScene` and the old visual key; the avatars go back to the previous bodies with no
stored state, credential, job or configuration to unwind. Nothing was written to any database by this
task, so no data becomes unreadable either way.

**Partial rollout** is possible and was considered: linking `game-mobile.css` and mounting the touch
layer (task 37's two lines) can ship without the rest, because the stylesheet hides the layer on a wide
fine-pointer screen by itself.

## 7. Limitations and residual risks

- **The entry default changed.** A signed-in operator now lands on the entry screen instead of being
  pushed into play. This is what lets Continue exist, but it is a visible behaviour change for anyone
  who was used to the old flow, and it is the one shipped behaviour this task altered rather than
  added.
- **H4 is a new element, not the shipped `.calling-hud`.** A later task that wants the shipped panel
  re-enabled on the HUD must also remove its progress bar; §5.1 forbids that bar.
- **Escape does not release the renderer's pointer capture.** `src/voxel-world.js` is owned here only
  for the character wiring; its drag ends on `pointerup`/`pointercancel`. Escape closes the world menu,
  a drawer, or an open interaction overlay, as before.
- **The observer's live channel needs a session.** `GET /events` is authenticated (task 36 reported
  this rather than widening it), so an anonymous observer shows `from-snapshot` and keeps the shipped
  three-second poll. The status line says so.
- **The interaction prompt and the shipped panel both read `GET /interact`.** The keyboard goes to the
  prompt first; the panel is the typed text path in the `More` drawer. Two reads of one public GET are
  possible in a render; neither writes.
- **The touch layer is only exercised on a coarse pointer or a narrow screen.** No browser scenario
  drives it with an emulated touch device, so its gestures remain covered by task 37's module tests and
  its stylesheet measurements, not by a real touch run. This is stated rather than claimed.
- **`game-theme.css` was not modified.** The H4 line and the new shell surfaces use new class names and
  the appended rules in `nemo-theme.css`, so the shipped game theme is byte-for-byte the base revision.
- **The browser suite is order-dependent and timing-sensitive by construction**, as the
  `fix-browser-suite-flake` handoff records. The three new UI scenarios reuse the suite's existing
  `waitForCondition` idioms and assert server effects, so a slow machine fails honestly rather than
  passing quietly.
- **One assertion was relaxed in spirit, not in strength:** `tests/mobile-styles.test.js` used to assert
  that `index.html` does *not* link `game-mobile.css`, because that link belonged to the integration
  owner. It now asserts the link exists exactly once, which is the stronger post-integration contract.

## 8. Reproducing

```sh
cd work/t38 && export PATH="$PWD/../node-bin:$PATH"
npm run check && npm test && npm run e2e && npm run browser
node scripts/seal-content.mjs --check
```

The patch is `../task-38-frontend-integration.patch` (`git format-patch 7e91e7c..HEAD`); it applies
cleanly to the base commit `7e91e7c`. A focused browser run of one scenario is
`LUCY_BROWSER_ONLY=<id> npm run browser`, and `LUCY_BROWSER_KEEP=1` keeps the temporary workspace and
the failure traces under `test-results/`.

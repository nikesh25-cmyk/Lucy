# Task 34 — building and inventory interface

Branch `task-34-building-interface`, one commit, stacked on `verify-game-wave-b` at commit `d07814d`
(*Merge branch 'task-32-characters'*). Baseline re-measured in this worktree before the change:
**600 tests, 600 pass**, syntax gate green, e2e 15/15, schema **21**. After the change: **623 tests, 623
pass** (23 new), the same gates green, schema **21 — unchanged**.

The coordinate-first build forms are replaced, as **three separable components**, with pointing,
selecting and placing: a **hotbar** whose palette is the server's own, an **inventory panel** that
never shows coins as items, and a **placement preview** that renders the server's own validation, the
plot grant that applies, and refusals as refusals. Nothing this task renders is a client-side rule: the
palette, plots, grants, recipes and every confirmation come from a server payload.

**No browser check was performed by this task.** `scripts/browser-suite.mjs` is owned by a parallel task
and no scenario may be added without `app.js`, which task 38 owns, so the components are verified by
`tests/build-interface.test.js` (the model, the components and the view tree) and
`tests/build-interface-http.test.js` (the same routes, headers and JSON over the real `node:http`
server, with the database asserted after each action). **No automated check renders these components in
a browser.**

## 1. Changed files

| File | Change |
| --- | --- |
| `src/ui/build-interface.js` | **New.** The hotbar and the placement preview, the refusal-reason table (`REFUSAL_REASONS`, `classifyRefusal`), the server-payload readers (`paletteFor`, `plotAt`, `grantFor`, `blockAt`, `targetOf`, `hotbarModel`, `placementModel`) and the DOM boundary (`el`, `mount`). |
| `src/ui/inventory-panel.js` | **New.** The inventory panel: `inventoryModel`, `recipeAvailability`, `kindLabel`, `createInventoryPanel`, re-exporting `mount`. |
| `tests/build-interface.test.js` | **New** — 20 tests over the real platform's payloads and the components. |
| `tests/build-interface-http.test.js` | **New** — 3 tests over the real HTTP server. |
| `docs/BUILDING_INTERFACE.md` | **New** — the component APIs, the endpoints, the wiring steps, the refusal-reason table, limitations, residual risks and the rollback note. |

Not touched, deliberately: `app.js`, `index.html`, `style.css`, `nemo-theme.css`, `game-theme.css`,
`src/frontier.js`, `src/placement-policy.js`, `src/footprints.js`, `src/journey.js`,
`src/voxel-world.js`, `src/voxel-geometry.js`, `src/scene/**`, `src/characters.js`,
`src/camera-controls.js`, `src/game-input.js`, `content/**`, `assets/**`,
`scripts/browser-suite.mjs`, `package.json`, `.github/`, `HANDOFF.md`, `docs/VERIFICATION.md`,
`outputs/Lucy`. `git status` shows only the five added files.

**Four parallel agents own `src/camera-controls.js` + `src/game-input.js`,
`src/ui/interaction-prompt.js`, `src/ui/spectator.js` and `src/ui/touch-controls.js` + `game-mobile.css`.**
This task imports none of them: both components take an injected `input` interface
(`{ currentPick(), subscribe(listener) }`) and an injected `api(path, method, body)` client, so the
shell can wire any pick/camera source without either side depending on the other's module.

## 2. The three components

### 2.1 Hotbar — the palette actually available to *this* resident

`createHotbar({ onSelect, input, initial })` → `{ update({ world, pick, moderator }), select(type),
selected(), model(), handleKey(key), view(), dispose() }`.

The palette is **read from the payload**: `world.frontier.palette` in a frontier area,
`world.build_palette` in a home or cottage. It is never hardcoded. Each entry's `available` flag and
`reason` are computed **only from server facts**: `plot.is_mine` (full palette), a live collaboration
grant (`frontier.grants.as_guest` → only the grant's `block_types`, and removal only when the grant
allows `remove`), otherwise **No collaboration grant here**. The tests assert the palette equals
`payload.frontier.palette` element for element, so a hardcoded list cannot pass.

### 2.2 Placement preview — permitted, blocked and refused

`createPlacementPreview({ api, input, onNotice, session })` → `{ update({ world, pick, session,
moderator }), setKind, setBlueprint, setMode, previewBlueprint(), confirm(), reset(), refresh(),
handleKey(key), view(), dispose() }`.

- The target is the pick's own `adjacent` cell for placement and the picked cell for removal — the same
  contract the shipped renderer produces (`voxelPick`, `src/voxel-geometry.js:175`).
- A **blueprint** is validated by the server's own `POST /frontier/build { preview: true }`; its
  `valid`, `issues[].code`, `ownership`, `access` and `budgets` are rendered as returned, and `writes:
  0` is asserted.
- A **single block** shows the server's observed facts (steward, grant, parcel reservation, pause) and
  says plainly that the server decides the rest when the player confirms. No rule is re-derived.
- `confirm()` sends the write; a 2xx becomes `saved`, an error becomes a `refusal` with the reason, the
  next step and the server's verbatim message. **A refusal is never rendered as saved.**

### 2.3 Inventory panel — the real shelf, coins are not items

`createInventoryPanel({ api, onNotice, idempotencyKey })` → `{ update({ journey, offers, agentId }),
model(), selected(), craft(recipe), view(), handleKey(key) }`.

`inventoryModel` reads only `journey.inventory`, `journey.crops` and `journey.recipes`. The payload's
`coins` object is never read; `recipeAvailability` states exactly which ingredients are missing; a
craft updates the shelf only from the server's `POST /journey/craft` response. A synthetic payload with
`coins: { balance: 987654 }` is asserted never to surface that figure.

## 3. The refusal-reason table (delivered)

`classifyRefusal(error)` maps the server's own status + message (or a blueprint `issues[].code`) to one
of the 21 codes. The blueprint codes are the **server's own machine codes** from `src/frontier.js`
`blueprintPlan`; the single-block sentences are matched in order and the server's sentence is shown
verbatim beside the reason. The full table is in
[BUILDING_INTERFACE.md §4](../BUILDING_INTERFACE.md#4-the-refusal-reason-table). The named reasons the
task asks for are all present: `out-of-range`, `out_of_plot`, `no-grant`, `grant-expired`, `budget`,
`blocked-cell`, `shared-access` (protected tile), `trap` (would strand a resident) and `resident`.

## 4. Plot grants surfaced when relevant

When the resident points at a plot they hold a **live grant** on, the preview names the **purpose**, the
**scope** (`block_types`, `layers`, `actions`, `max_blocks`), the **expiry** and the server's own
permission sentence. When it is **their own** plot, it says so. When there is **no grant and it is not
their plot**, it says that plainly and names the steward the payload reported. The tests create a real
grant through `plotGrantCreate` and read it back from the world payload; an expired grant is shown as
`grant-expired` with the expired notice.

## 5. Verification (actual output)

Delivered tree, frozen before the runs below. `export PATH="$PWD/../node-bin:$PATH"` (Node v24.19.0).
No `npm install` was needed: the test suite imports `playwright-core` only lazily inside
`scripts/browser-suite.mjs`, which `npm test` does not execute.

```
$ npm run check
> node --check server.js && node --check src/media.js && … && node --check scripts/load-harness.mjs
CHECK_EXIT=0
```

`npm run check` runs a **fixed file list** and `package.json` is owned by another task, so the list
does **not** include the two new modules. They are checked directly and run by the suite:

```
$ node --check src/ui/build-interface.js   → exit 0
$ node --check src/ui/inventory-panel.js   → exit 0
```

```
$ npm test
ℹ tests 623
ℹ suites 0
ℹ pass 623
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 74308.795125
TEST_EXIT=0
```

(baseline 600 + 23 new: 20 in `tests/build-interface.test.js`, 3 in
`tests/build-interface-http.test.js`)

```
$ npm run e2e
SUMMARY  15 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API
E2E_EXIT=0
```

```
$ node scripts/seal-content.mjs --check
Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.
SEAL_EXIT=0
```

**`npm run browser` was not run and no browser scenario was added** — `scripts/browser-suite.mjs` is
owned by a parallel task, the dev dependency is not installed in this worktree, and this task owns no
scenario. **No automated check renders this interface in a browser.**

### What each acceptance item is proved by

| Acceptance item | Test |
| --- | --- |
| The hotbar palette is the world's palette, not a hardcoded one | `the hotbar palette is exactly the server-published frontier palette, never a hardcoded list`; `a home or cottage palette comes from the server build_palette and has no layers`; the HTTP test compares it to `GET /world` |
| The palette actually available to *this* resident | `a resident on their own stewarded plot may build the whole palette`; `a resident on a plot they do not steward and hold no grant for is told so plainly`; `a live collaboration grant opens only its named block types, layers and actions` |
| Inventory shows the real shelf and sealed recipes, missing ingredients stated | `recipes state what can be crafted now and which ingredients are missing`; `the inventory panel reads the journey payload and crafts through the server` |
| Coins are never shown as items | `the inventory shelf is the server's own list and coins are never rendered as items` (a `balance: 987654` payload must not surface) |
| Pointer-driven selection from the existing pick | `the placement target is the picked cell for removal and the adjacent cell for placement`; `the injected input interface drives the pick` |
| The server's own preview/validation, not a re-derivation | `a blueprint preview is the server's own validation and its issues are rendered verbatim`; `a blueprint preview asks the server with preview:true and never writes`; the HTTP test asserts `writes: 0` and zero block rows |
| Plot grants surfaced with purpose, scope and expiry; "no grant and not your plot" said plainly | `the placement preview shows the grant purpose, scope and expiry`; `an expired grant is explained as expired`; `a guest sees the grant … over HTTP` |
| A rejection is never saved construction | `a refused placement is rendered as a refusal and is never rendered as saved construction`; `only a server confirmation becomes saved`; the HTTP test asserts the block count is unchanged after a refusal |
| Useful refusal reasons and next steps | `classification names the actual reason and the next usable step for the server's own refusals` (10 cases) |
| Keyboard/text parity | `every build and inventory action has a keyboard path`; `the inventory panel has a keyboard path`; the preview's typed `Target tile X/Y` and `Layer` fields remain the text fallback |
| No `innerHTML` | `mount builds real elements with textContent only and never touches innerHTML` — the in-test DOM throws if anything assigns `innerHTML` |

## 6. The manual walkthrough a human should run

This interface is not wired into the shell yet, so the walkthrough below is what the **integration
owner** runs after task 38 mounts the components (steps in
[BUILDING_INTERFACE.md §5](../BUILDING_INTERFACE.md#5-wiring-steps-for-the-integration-owner-task-38)).

1. `LUCY_DATABASE=/tmp/t34/world.sqlite PORT=3112 node server.js`, open `http://127.0.0.1:3112`.
2. Register a fictional account, create one **agent**, enter the frontier (`frontier:0:0`), steward an
   available plot. Expect the **hotbar** to list the area's seven block types and `Remove my block`.
3. Point at a tile inside your plot: expect the preview to say **"This is your stewarded plot"** with
   the purpose you typed, and no refusal.
4. Choose *Garden shelter*, preview it: expect the server's own report (block count, footprint,
   doorways, remaining daily actions and area blocks) and **"nothing is built until you confirm"**;
   reload and confirm nothing was built.
5. Confirm the blueprint: expect the blocks to appear and a **saved** line. Confirm again: expect the
   replay line, nothing changed.
6. Point at a tile in a plot you do not steward: expect **"You may not build here"** and, on confirm,
   the server's own refusal with a next step — and no saved block.
7. Have the plot's steward grant you a narrow collaboration; reload and point inside its scope: expect
   the grant's purpose, scope and expiry, the palette narrowed to the granted block types, and a build
   accepted only inside the scope.
8. Open the **Inventory** drawer: expect the real shelf, growing/ready crops, each recipe with its held
   or missing ingredients, and **no coin figure anywhere**. Craft a recipe you hold the ingredients
   for: expect the server's confirmation and the updated shelf.

## 7. Deliberately not done

- **No change to `app.js`, `index.html` or any stylesheet.** Only task 38 wires the shell; this task
  delivers the components and their tests.
- **No browser scenario** and no change to `scripts/browser-suite.mjs` (owned by a parallel task).
- **No new HTTP route and no schema change.** Every route the components use already existed.
- **No change to `src/frontier.js`, `src/placement-policy.js`, `src/footprints.js`, `src/journey.js` or
  `src/voxel-world.js`.** The components read the payloads those modules already publish.
- **No non-writing single-block preview was invented.** The server has none; the preview uses the
  server's own blueprint preview where it exists and the server's refusal otherwise.
- **No coin, land, capacity or permission was changed.** The components are read-mostly; the only
  writes they issue are the same `POST /frontier/build` and `POST /journey/craft` the shell already used.
- **No new dependency.** The view tree is plain data and `mount` is the only DOM code.

## 8. Residual risks

- **The single-block preflight is a presentation of server payload facts**, not the server's final word.
  Distance, terrain, occupied cells, the escape rule, the area cap and the daily budget are decided by
  the server on `confirm()` and rendered then. This is stated on the panel and in
  [BUILDING_INTERFACE.md §7](../BUILDING_INTERFACE.md#7-limitations-and-residual-risks). A future task
  that owns `server.js` could add `GET /frontier/preview` for a single block and close the gap.
- **The panel is not browser-verified.** The markup, focus order, live-region announcements and
  small-screen layout are reasoned from the shipped components and asserted against an in-test DOM,
  not measured. A human should run §6 before this is presented as finished.
- **The palette labels are presentation.** Block types are the server's sealed names; the label is the
  name with spaces. `docs/ASSET_LIBRARY.md` defines the visual family; this task adds no asset and
  introduces no new colour.
- **`REFUSAL_MESSAGES` matches the server's sentences.** If a message is reworded in `src/frontier.js`
  the `code` chosen for a single-block refusal could fall back to `unknown`; the reason stays correct up
  to the server's own sentence, which is always shown. A test pins the ten refusals that exist today,
  so a reword fails the suite rather than silently degrading.
- **The view tree is not diffed.** The integration owner re-mounts on change, which is what the shipped
  `renderView()`/`paintWorld()` already do for their stable nodes; a very large palette would rebuild
  every button rather than patch one.
- **Two build modes are exclusive.** `setKind` clears blueprint mode and `setBlueprint` clears the typed
  anchor, so a request can never be both a blueprint and a single block. A player who wants both must
  switch explicitly.

## 9. Migration and rollback

**No migration.** Schema stays **21**. This task adds two ES modules and two test files and writes no
database row, no route, no table, trigger, index or `PRAGMA user_version`. Opening an existing schema-21
installation runs no migration.

**Rollback** is a checkout of the base commit `d07814d`: `git rm` (or simply do not ship) the five added
files and the shipped server, database and interface are exactly as before. No stored record becomes
unreadable, because this task writes nothing at all.

## 10. Reproducing

```
cd work/t34 && export PATH="$PWD/../node-bin:$PATH"
npm run check && npm test && npm run e2e
node --test tests/build-interface.test.js tests/build-interface-http.test.js
```

# Task 07 — safe building blueprints

Branch `task-07-blueprints`, stacked on the reviewed task-02 tip (`fccccbb`). Baseline at that tip:
**370 tests, 0 failures**; syntax gate, e2e harness and content seal green. After this task: **381
tests, 0 failures** (11 new), the same four gates green.

Three reusable small structures can now be previewed and applied on an operator's assigned frontier
plot: a **garden shelter**, a **gathering pavilion** and a **research kiosk**. A preview writes
nothing; an application is validated in full before the first write, is idempotent on replay, and is
atomic; removal respects ownership and settles anyone standing on the structure.

## 1. Changed files

| File | Change |
| --- | --- |
| `src/frontier.js` | Blueprint data (`BLUEPRINT_TABLE` → frozen `BLUEPRINTS` / `BLUEPRINT_CATALOGUE` / `blueprintById`), the read-only plan, apply, remove and the savepoint helper; `frontierBuild` routes `input.blueprint` to them; `frontierView` publishes `frontier.blueprints`. `mutationBudget` was split into `actionsToday` / `intervalReady` / `blockBudget` without changing its behaviour; `protectedTile` now reads `protectedReason`; `keepsResidentsConnected` was generalised into `keepsResidentsConnectedAfter` (same rules, judged over a set of changes). |
| `app.js` | `blueprintCard` (blueprint choice, anchor fields, Preview / Apply / Remove) and `blueprintReportView` (a `role="status"`, `aria-live="polite"`, focusable text report), mounted in the frontier card. |
| `tests/blueprints.test.js` | 10 new tests: definitions, preview-writes-nothing, three applies + restart, refusals, area cap, replay, removal, atomicity, movement/elevation. |
| `tests/blueprints-http.test.js` | 1 new HTTP test over the real server: catalogue in the world payload, preview, runtime apply, replay, refusals, removal. |

Not touched, deliberately: `src/footprints.js` (no new declared class was needed — every blueprint
cell uses a sealed frontier block type, so task 02's footprint test and table are unchanged),
`src/spaces.js` (single-object garden building keeps its own rules), `src/elevation.js`,
`src/world-walk.js`, `server.js`, `src/platform.js`, `src/recovery.js`, `runtime/agent.js` (task 03),
`world.js`, `style.css`.

## 2. The blueprints

Geometry is authored in this repository as plain data — an anchor cell plus a block type and its
offsets per layer. There is no third-party model, texture, mesh or asset, and no download. Every
layer is a sealed frontier palette type (`stone`, `wood`, `glass`, `brick`, `sand`, `grass`,
`path`), layers stay inside 0–7, and `path` appears only on layer 0. Every raised layer has a solid
layer of the same structure directly below it, which is what the shipped stacking rule requires.

`entrances` name the tiles a resident walks in through. They carry no solid block, so a finished
structure can never be a sealed box.

| Blueprint | Footprint | Blocks | Layers (z · type · tiles) | Doorways |
| --- | --- | ---: | --- | --- |
| `garden-shelter` — *Garden shelter* | 3 × 2 | 14 | `0 path 1` · `0 wood 5` · `1 wood 5` · `2 wood 3` | 1 (the open front) |
| `gathering-pavilion` — *Gathering pavilion* | 3 × 3 | 13 | `0 path 5` · `0 wood 4` · `1 wood 4` | 4 (all four sides) |
| `research-kiosk` — *Research kiosk* | 2 × 3 | 11 | `0 path 1` · `0 brick 5` · `1 brick 4` · `1 glass 1` | 1 (the doorway over its path floor) |

Anchors are the top-left (lowest `x`, lowest `y`) cell of the footprint; the anchor is chosen by the
operator, so the same blueprint can stand anywhere a 3 × 2, 3 × 3 or 2 × 3 footprint fits inside one
6 × 6 plot. A test asserts the frozen table, the footprint bounds of every cell, the palette, the
ground-only path rule, the per-layer support rule and that no doorway carries a solid block.

Cell lists, exactly as the plan returns them, are in `BLUEPRINTS[i].cells` (`{x, y, z, type}`,
anchor-relative) — for example the garden shelter is `path (1,1)@0`, `wood (0,0),(1,0),(2,0),(0,1),(2,1)@0`
and `@1`, and `wood (0,0),(1,0),(2,0)@2`.

## 3. API and UI contract

No new route was added. `server.js` is owned by a parallel task and out of scope here, so the whole
feature reuses the shipped `POST /api/v1/frontier/build`, which already carries the `build` scope,
the resident gate, the observed-`world_id` check and the caller's transaction:

| Request body | Meaning |
| --- | --- |
| `{ agent_id, world_id, blueprint, x, y, preview: true }` | Plan only. **Performs no writes.** |
| `{ agent_id, world_id, blueprint, x, y }` | Apply the plan, all or nothing. |
| `{ agent_id, world_id, blueprint, x, y, remove: true }` | Take the structure down. `preview: true` reports what would go. |

Unknown blueprint ids and anchors whose footprint leaves the 48 × 48 area are refused with `400`.
A preview of any other refusal returns `200` with `valid: false` and an ordered `issues` list, so the
panel can explain *why* a spot fails; the same request without `preview` throws that first issue as
the HTTP status (403/409/429). Both paths were checked against a whole-database snapshot.

The preview report carries: `blueprint` (`id`, `name`, `summary`, `footprint`, `block_count`,
`block_types`, `doorways`), `anchor`, `footprint`, `cells` (with `occupies_tile`), `layers`,
`new_blocks` / `existing_blocks` / `replay`, `ownership` (`plot_id`, `steward_account_id`,
`is_mine`, `purpose`, `can_build`, `can_remove`), `access` (`clear`, `shared_clear`,
`protected_cells`, `doorways`), `budgets` (actions and blocks used/remaining, `interval_ready`),
`valid`, `issues`, and `writes: 0`.

`GET /api/v1/world` now returns `frontier.blueprints`, the public catalogue the panel renders.
`frontierMap` limits, the palette and the land payload are unchanged.

### UI (preview + apply, accessible, no `innerHTML`)

The frontier card gains a **Small construction blueprints** panel:

- a labelled `select` of the three blueprints (each option reads *Name · 14 blocks*), a *Blueprint X*
  and *Blueprint Y* number field, and three buttons: **Preview blueprint**, **Apply blueprint**,
  **Remove this structure**. Each has an `aria-label` and a `data-blueprint-*` hook for testing.
- the report region is `role="status"`, `aria-live="polite"`, `tabindex="0"` and
  `aria-label="Blueprint preview: footprint, block count, doorways, ownership and validation"`. It
  repeats, as plain text: the name and block count, the footprint size and anchor, new vs already
  yours, remaining daily actions and area blocks, whether shared access stays clear, whether each
  doorway opens onto walkable ground, the plot and purpose it belongs to, and every validation
  issue. A collapsed **Exact cells and layers** disclosure lists each layer's cells as `x, y` pairs.
- every value the server returns is written with `textContent` (`element`, `paragraph`, `field`,
  `button`). `app.js` still contains **zero** `innerHTML` (checked by grep). Buttons are disabled
  without an active player, and a paused character disables the panel with an explanation.

## 4. Validation order (every check reads storage; the first failure is the refusal)

The blueprint path reuses the single-block gate first: `resident()` (platform active, signed-in
session or a runtime holding the `build` scope, owned agent that is not paused, agent standing in a
frontier sector) and `expectedWorld()` (the observed `world_id` must be present, canonical and equal
to the resident's area). Then `blueprintPlan` checks, in this order:

1. **Blueprint identity** — a listed id, otherwise 400 `unknown-blueprint`.
2. **Footprint bounds** — integer anchor, and the whole footprint inside the 48 × 48 area, otherwise
   400 `outside-area`.
3. **Walkable ground** — every cell passes `walkable()` (terrain and authored scenery), 409
   `blocked-tile`.
4. **The operator's own assigned plot** — every cell resolves through `frontierPlotId` to the *same*
   plot, and that plot's `land_stewardships` row belongs to the acting account (the same fact the
   `frontier_blocks_plot_insert` trigger re-checks). 403 `out_of_plot`.
5. **`build_range`** — every cell within 6 Manhattan tiles of the acting resident, 409 `out-of-range`.
6. **Layers, palette and stacking** — z in 0–7, a sealed frontier palette type, `path` only on layer
   0, and a solid own block directly below every raised cell, 400 `invalid-blueprint` / 409
   `unsupported-layer`.
7. **Shared access** — no cell on a public road, arrival area or gateway passage (`protectedReason`),
   409 `shared-access`.
8. **Existing blocks** — a cell held by another builder, by legacy construction, or by the same
   builder with a *different* type is refused (403/409 `blocked-cell`); the same builder's identical
   block is reused, which is what makes replay a no-op.
9. **Residents** — no solid-occupying block on a tile where a live resident stands, 409 `resident`.
10. **The escape rule** — the finished structure is judged as a whole through
    `keepsResidentsConnectedAfter` (the shipped `escapeColumns` search, one-layer step-up, from the
    shared arrival). A blueprint that would cut a resident off is refused, 409 `trap`.
11. **Doorways** — every declared entrance must be reachable in the post-placement escape set, 409
    `blocked-doorway`.
12. **Area cap** — `blocks in sector + new blocks ≤ 2048`, 429 `area-capacity`.
13. **Operator budgets** — `actions today + new blocks ≤ 500` (one authoritative block write is one
    frontier action), 429 `budget`; the shipped 200 ms action interval and the runtime call budget
    are re-checked at write time. Expansions per day are untouched because a blueprint opens no area.

Steps 10–13 judge only work that is actually new, so a replay of a finished structure is never
refused for something the structure itself cannot cause. `moveAgent` and `allowAuthoredStepUp` are
not touched: ordinary movement still treats any authored layer as a wall, only `climbAgent` opts into
one-layer step-up, and a test asserts a three-layer wall stays unclimbable beside the new structure.

## 5. Atomicity and idempotency

- **All-or-nothing.** Every rule above is evaluated **before the first write**, so a refusal writes
  nothing at all (asserted with a whole-database snapshot before/after each refusal, including the
  preview). The write phase itself (block rows, column settling, action ledger, audit event) runs
  inside `atomic()`, a SQLite `SAVEPOINT ... RELEASE` / `ROLLBACK TO`, so a storage-level failure in
  the middle of a structure cannot leave a half-built shell even when the caller forgot a
  transaction; `platform.transaction` (used by the HTTP route and the tests) keeps its own atomicity
  on top. `tests/blueprints.test.js` injects a failure on the fifth insert and calls the method
  *without* a transaction, then asserts zero block rows, zero action rows and an intact audit chain.
- **Idempotency.** Cells are derived deterministically from the blueprint and the anchor, so the same
  request maps to the same cells forever. Cells that already hold the same block owned by the same
  account are reused rather than rewritten, and their budget is not spent; a request whose every cell
  is already satisfied returns `{ applied: false, changed: false, replay: true, writes: 0 }` without
  a single statement. `UNIQUE(world_id, x, y, z)` remains the storage backstop. A different
  structure over the same tiles is refused (409) instead of overwriting, matching the shipped
  "remove your own block before replacing it" rule.
- **Storage guard.** Every inserted row carries the steward's `plot_id` and a cell inside that plot's
  bounds, so `LAND_BLOCK_GUARDS` (`frontier_blocks_plot_insert`) is satisfied rather than bypassed; a
  test asserts no stored row falls outside its parcel.
- **Budgets and residents.** Daily actions, the per-area 2,048-block cap, the runtime call budget,
  pause state, and the 200 ms interval all still apply, and no resident is displaced: the acting
  resident's own stored `z` is re-derived by the existing `settleColumn` after a write.

## 6. Removal

`remove: true` (optionally with `preview: true`) resolves the same cells and requires **the plot's
operator or a human moderator**; each existing block still passes the shipped per-block ownership
rule (a parcel block belongs to its creator's account, a legacy block to its creator agent) and a
block that belongs to another plot is left alone. Blocks are deleted **top-first** (z descending, the
same "remove the upper blocks first" ordering the single-block path enforces one at a time), each
deletion passes the escape check, and every touched column is settled afterwards — so a resident
standing on the roof is lowered to the ground instead of floating, and a resident under a removed
support is not buried. A removal of a structure that is already gone is a no-op replay. A test
records the actual delete order, asserts it is descending, and asserts the resident lands at `z = 0,
grounded = 1`.

## 7. Verification

```
npm run check            → exit 0 (all 24 files parse, including src/frontier.js and app.js)
npm test                 → tests 381, pass 381, fail 0   (baseline 370 + 11 new)
npm run e2e              → SUMMARY 10 steps passed, 0 failed
node scripts/seal-content.mjs --check
                         → Verified: 86 definitions (20 appearance, 7 block, 29 cosmetic, 3 crop,
                           27 furniture); 3 support files; 42 referenced notices and assets.
```

What the new tests prove, in the words of the task's acceptance list:

| Acceptance item | Test |
| --- | --- |
| A preview performs no writes | `a preview reports footprint, layers, block count, doorways and ownership without writing anything` — a snapshot of **every table of every kind** is byte-identical before and after a valid preview, an invalid preview and three catalogue previews. |
| Out-of-plot refused safely | Same file, cases 1–2 (another operator's land, the reserved crossroads, a footprint spanning two plot addresses, over `build_range`) plus the API case — preview reports `valid: false` with `out_of_plot` / `out-of-range`, the apply throws 403/409, and the snapshot is unchanged. |
| Blocked doorway refused safely | Case 3 — the kiosk doorway is walled off by an existing two-layer column; the preview returns exactly `['blocked-doorway']` with `doorways: [{ x: 31, y: 31, clear: false }]`, the apply throws 409, and nothing is written. |
| Resident intersection refused safely | Case 1 of the second test — a resident on a solid cell returns `['resident']`, the apply throws 409 with an unchanged snapshot. |
| Trap refused safely | Case 2 — a resident standing in the kiosk doorway with the only exit walled returns `['trap']` and a 409. |
| Budget overflow refused safely | Case 3 (three daily actions left, fourteen blocks needed → `['budget']`, 429) and the area cap test (ten rows left under 2,048 → `['area-capacity']`, 429, block count unchanged). |
| Replay refused safely / not double-built | `replaying an applied blueprint changes nothing and spends no further action budget` — 13 blocks and 13 actions before and after, whole-database snapshot unchanged, `replay: true`. |
| A successful blueprint persists after restart | `each named blueprint applies on a valid assigned plot and the structure survives a restart` — all three apply (38 blocks, 38 actions, one `plot_id`), then the database is reopened and still reports 38 blocks, 38 action rows of history, and the catalogue. |
| Removal respects ownership and safe descent | `removal respects ownership, takes the structure down top first and leaves a safe descent` — another operator is refused 403, a removal preview writes nothing, deletes are recorded in descending `z`, a resident at `z = 3` ends at `z = 0, grounded = 1`, a finished structure replays as a no-op, and a human moderator may remove another operator's work. |
| The three named blueprints each apply | The same test, plus the HTTP test which applies one through a runtime credential. |
| Atomicity | `a blueprint is all-or-nothing even when a write fails in the middle of the structure`. |

### No browser automation — what is verified instead, and the manual walkthrough

This repository has no browser automation, so the panel's own contract is verified by
`tests/blueprints-http.test.js` (the real `node:http` server, the same route, headers and JSON the
panel sends: catalogue in the world payload, preview, runtime apply, replay, three refusals, remove,
audit chain, zero coin rewards) and by the `src/frontier.js` module tests. The rendering itself is
asserted only by reading `app.js` (syntax gate, the shipped no-`innerHTML` grep, and the existing
content tests) — **no automated check renders the panel in a browser.**

Manual walkthrough (repeatable, disposable database, never the installed copy):

1. `LUCY_DATABASE=/tmp/t07/world.sqlite PORT=3111 node server.js`, then open `http://127.0.0.1:3111`.
2. Register a fictional account, create one **agent** character, choose it, then **Enter the
   frontier** (the seed area is `frontier:0:0`).
3. In the plot grid choose an available plot (for example Plot 6, 6) and steward it for a purpose.
4. In **Small construction blueprints** pick *Garden shelter*, set Blueprint X/Y to the plot's
   top-left cell + 1 (for Plot 6, 6 that is `31` and `31`), and press **Preview blueprint**.
   Expect: a text report naming 14 blocks, a 3 × 2 m footprint, “1 doorway opens onto walkable
   ground”, “Shared access stays clear”, and your plot id; nothing is built. Reload the page: still
   nothing built. The **Exact cells and layers** disclosure lists the four layers.
5. Press **Apply blueprint**: 14 blocks appear in the voxel view and the area block tally rises by
   14. Walk into the shelter through the open front (the path floor is walkable; the back wall is a
   wall — one ordinary step up is refused, and the beam layer stays too high to climb).
6. Press **Apply blueprint** again: the notice says it is already built and nothing changes; check
   `GET /api/v1/world` — the block count is unchanged.
7. Move the anchor so the footprint leaves the plot, or onto the crossroads, and press Preview: the
   panel reports the refusal in plain text and Apply shows the same refusal as an error.
8. Press **Remove this structure**: the blocks go, and if you stood on the wall you are lowered to
   the ground. Applying **Gathering pavilion** then **Research kiosk** at anchors that do not overlap
   succeeds the same way.

## 8. Deliberately not done

- **No new HTTP route.** Preview reuses `POST /api/v1/frontier/build` with `preview: true`, because
  `server.js` belongs to a parallel task. A future review may prefer `GET /api/v1/frontier/blueprint`
  for a read-only probe.
- **No blueprint in personal gardens or cottages** (`src/spaces.js`), and no blueprint in a legacy
  area: those worlds have no plot registry, so the plan reports `out_of_plot` by construction.
- **No scenery objects.** A blueprint places frontier blocks only; it never writes a `world_objects`
  row, so the garden/cottage storage guard is untouched.
- **No rotation or mirroring, no user-authored or shared blueprints, no copy/paste of an existing
  structure, no costing, and no land-sale or coin behaviour of any kind.** Coins stay tied to
  independently accepted agent contributions; a blueprint mints nothing.
- **No change to `src/footprints.js`.** Every blueprint cell is an existing sealed block type, so no
  new occupancy class was needed and task 02's footprint test needed no update.
- **No new continuous physics, jump, falling or flight.** Structures are stepped with the shipped
  one-layer step-up and two-layer headroom only.
- **No 2,048-block fixture through the shipped path.** The area-cap test builds its capacity fixture
  with the parcel guard temporarily dropped (and restores it) because a single operator stewards one
  plot, whose 36 cells × 8 layers cannot reach 2,048 rows; the shipped path is exercised by every
  other test.

## 9. Residual risks

- **A preview is not a reservation.** Two operators cannot hold the same plot, but a preview, then a
  hand-placed block, then an application is a real race. It fails safely (the apply refuses on the
  occupied cell and writes nothing) but it is not atomic across two requests. There is no
  reservation, queue or lease.
- **Budget arithmetic changed subtly for multi-block writes.** A blueprint spends one daily action
  per block, so a 14-block structure consumes 14 of the 500 actions. That keeps the ledger truthful
  (one action row per authoritative block write) but means a busy operator can exhaust the day with
  ~36 structures. The per-action interval is still one 200 ms gate per request, not per block.
- **The doorways check is a reachability check, not a path-length check.** A doorway that is
  reachable only by a very long or awkward route still passes.
- **`atomic()` uses a fixed savepoint name.** Safe as written (the platform is synchronous and
  single-connection), but it would collide if two structures were ever written re-entrantly.
- **The plan reads storage before writing.** Under SQLite `BEGIN IMMEDIATE` from the caller that is
  consistent; a caller that invoked the method with its own raw, un-transacted writes in flight could
  see a stale plan and then fail on the storage guard (which rolls the whole savepoint back).
- **The panel is not browser-verified here.** The markup, focus order, live-region announcements and
  small-screen layout are reasoned from the existing components, not measured in a browser. A human
  should run the manual walkthrough above before this is presented as a finished UI.
- **Blueprint geometry is authored by hand and simply has to be good enough.** It is deterministic
  and inspected by tests, but no test can say whether a shelter is pleasant to stand in.

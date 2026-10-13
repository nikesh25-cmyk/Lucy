# Building and inventory interface

**Task 34.** The build half of the game interface, delivered as three separable, framework-free
components that replace the coordinate-first build forms with **pointing, selecting and placing**.
Branch `task-34-building-interface`, base commit `d07814d` (`verify-game-wave-b`). Schema **21 —
unchanged**; no new dependency; `package.json`, `app.js`, `index.html`, `style.css`,
`nemo-theme.css`, `src/frontier.js`, `src/placement-policy.js`, `src/footprints.js`,
`src/journey.js` and `src/voxel-world.js` are **not touched** by this task.

This task owns two source files and their tests. The shell that mounts them is Task 38.

| File | What it is |
| --- | --- |
| `src/ui/build-interface.js` | The **hotbar** and the **placement preview**, plus the refusal-reason table and the DOM boundary |
| `src/ui/inventory-panel.js` | The **inventory panel**: the resident's shelf, crops, sealed recipes and open offers |
| `tests/build-interface.test.js` | The pure model, the components' behaviour and the view tree (a tiny in-test DOM) |
| `tests/build-interface-http.test.js` | The same routes and payloads over the real `node:http` server, with the database asserted |

**No browser check was performed by this task and no browser scenario was added.** `scripts/browser-suite.mjs`
is owned by a parallel task and this task owns no scenario. Every "today" statement about the shipped
shell below is a source reading of `app.js`, `src/voxel-world.js` and `src/camera-controls.js`.

## 1. What this replaces

Today the frontier card places a block through three typed number fields — `Block X`, `Block Y`,
`Block height` — submitted as `Apply block at coordinates` (`app.js:904-909`), and the garden card
through a `Tile X` / `Tile Y` form (`app.js:777-778`). The blueprint panel (`app.js:922-971`) and the
plot-collaboration panel (`app.js:975-1051`) sit alongside them. This task replaces the coordinate-first
entry with three components that read the **pick** the renderer already produces
(`src/voxel-geometry.js:168-176`, `pickWorld` `app.js:824-835`) and never ask the player to type a
coordinate to choose a place — while keeping the typed fields as the keyboard/text fallback.

## 2. The components

Every component is a factory that returns an object with `update`, `view`, `handleKey` and `dispose`.
`view()` returns a **plain view tree** (data), and `mount(root, tree, document)` is the only function
that touches the DOM. Nothing is written with `innerHTML`; every text value is set with
`createTextNode`/`textContent`.

### 2.1 The hotbar — `createHotbar`

```js
const hotbar = createHotbar({ onSelect, input, initial });
hotbar.update({ world, pick, moderator });   // world = the GET /world payload
hotbar.view();                               // the palette, annotated with availability
hotbar.handleKey('3');                       // digits select a block; '0' selects removal
hotbar.selected();                           // the chosen block type, or 'remove'
hotbar.dispose();                            // unsubscribes from the injected input
```

The palette it shows is **the payload's own palette** — `world.frontier.palette` in a frontier area,
`world.build_palette` in a home or cottage. No palette is hardcoded. Each entry is annotated with an
`available` flag and, when it is not available, a `reason`, computed **only from server facts**:

- on the resident's **own stewardship** (`plot.is_mine`) the whole palette is available;
- on a plot the resident **holds a live collaboration grant** for, only the grant's `block_types` are
  available and removal is available only when the grant's `actions` include `remove`;
- otherwise every entry is unavailable with the reason **No collaboration grant here**.

`onSelect(type)` is the callback the integration owner uses to drive the placement preview
(`preview.setKind(type)`).

### 2.2 The placement preview — `createPlacementPreview`

```js
const preview = createPlacementPreview({ api, input, onNotice, session });
preview.update({ world, pick, session });    // pick = the renderer's pick
preview.setKind('wood');                     // a hotbar choice (also clears blueprint mode)
preview.setBlueprint('garden-shelter');      // blueprint mode, validated by the server
await preview.previewBlueprint();            // POST /frontier/build { preview: true } — writes nothing
await preview.confirm();                     // the write; resolves { ok, result|refusal }
preview.view();                              // permitted / blocked / refused, the grant, the model
preview.handleKey('c');                      // 'b' previews, 'c' confirms, 'r' toggles remove, Escape resets
```

`update({ world, pick })` uses the pick's own `adjacent` cell for placement and the picked cell for
removal — the same contract the shipped renderer already produces (`voxelPick`, `src/voxel-geometry.js:175`).

**Permitted, blocked and refused, with their sources stated.** A placement is one of three states:

| State | Source | How it is shown |
| --- | --- | --- |
| **The server's own validation** | `POST /frontier/build` with `preview: true` (blueprints) | `permitted` = the server's `valid`; every `issues[]` code is rendered verbatim with a reason and a next step |
| **A server-observed block** | the `GET /world` payload (plot `is_mine`, parcel reservation, grants, `paused`, resident status) | an `assert` with `source: 'world-payload'`; the server still decides the rest at write time and the preview says so |
| **A refusal** | the server's error on `confirm()` | rendered as a refusal; **never** as saved construction |

### 2.3 The inventory panel — `createInventoryPanel`

```js
const panel = createInventoryPanel({ api, onNotice, idempotencyKey });
panel.update({ journey, offers, agentId });  // GET /journey and (optional) GET /journey/offers
panel.craft({ id: 'flower_crown', craftable: true });   // POST /journey/craft
panel.handleKey('1');                        // digits select a recipe; 'c' crafts it
panel.view();                                // shelf, crops, recipes, offers
```

The panel renders the resident's **real shelf**, its growing and ready **crops**, and the sealed
**recipes** with what can actually be crafted now and exactly which ingredients are **missing**
(`recipeAvailability`). It also renders the **offers** the resident is party to, with the server's own
`can_accept` / `can_decline` / `can_cancel` flags.

**Coins are never items.** `inventoryModel` reads only `journey.inventory`, `journey.crops` and
`journey.recipes`. The payload's `coins` object is not read, the shelf holds only kinds with a positive
quantity, and a refusal is never rendered as a craft — only the server's `POST /journey/craft` response
updates the shelf (`docs/GAME_EXPERIENCE.md` §5.3, `docs/COINS.md`).

## 3. Server endpoints each component reads

| Endpoint | Component | Fields read |
| --- | --- | --- |
| `GET /api/v1/world?world_id=&agent_id=` | hotbar, placement preview | `world.kind`, `build_palette`, `frontier.palette`, `frontier.limits`, `frontier.parcels[].{x,y,width,height,id,state,is_mine,steward_name,purpose,reserved_reason}`, `frontier.grants.{as_guest,as_steward}`, `blocks[]`, `paused` |
| `POST /api/v1/frontier/build` `{ …, preview: true }` | placement preview | `valid`, `issues[].{status,code,message}`, `blueprint`, `block_count`, `new_blocks`, `existing_blocks`, `replay`, `ownership`, `access.doorways`, `budgets`, `writes` |
| `POST /api/v1/frontier/build` `{ … }` / `{ …, remove: true }` | placement preview | the confirmed change (`x`, `y`, `z`, `type`, `removed`, `changed`, `replay`, `blueprint`) |
| `GET /api/v1/journey?agent_id=` | inventory panel | `inventory[]`, `crops[]`, `recipes[]` (`coins` deliberately unread) |
| `GET /api/v1/journey/offers` | inventory panel | `offers[].{id,status,direction,items,note,expires_at,can_accept,can_decline,can_cancel}` |
| `POST /api/v1/journey/craft` `{ agent_id, recipe_id }` | inventory panel | `crafted`, `inventory[]` |
| `POST /api/v1/journey/offers/{accept,decline,cancel}` | inventory panel | `status` (accept/propose carry an `Idempotency-Key`) |

## 4. The refusal-reason table

`REFUSAL_REASONS` in `src/ui/build-interface.js` is the whole table; `classifyRefusal(error)` turns a
server error (its `status` and its own `message`, or a blueprint `issues[].code`) into the `code`,
`reason`, `next_step` and the server's verbatim `message`. `saved` is always `false`.

| Code | Reason shown | Next usable step |
| --- | --- | --- |
| `out-of-range` | Out of range | Walk closer to the tile you are building on, then place again. |
| `out_of_plot` | Out of plot | Build only inside a plot you steward, or ask its steward for a collaboration grant. |
| `no-grant` | No collaboration grant here | A signed-in human must steward this plot, or its steward must grant you a live collaboration on it. |
| `grant-expired` | Collaboration grant expired | Ask the plot's steward to grant a fresh collaboration; the expired one cannot be extended. |
| `grant-scope` | Outside the collaboration grant | Use only the block types, layers and actions the grant names, or ask the steward for a wider grant. |
| `budget` | Daily building budget spent | This operator has no frontier actions left today. Try again after 00:00 UTC. |
| `blocked-cell` | That cell is already built | Remove your own block first, or choose a clear cell. |
| `resident` | A resident is standing there | Ask the resident to step aside, then place again. |
| `shared-access` | Protected shared passage | Keep roads, arrivals and gateway passages clear and choose ordinary ground. |
| `trap` | Would strand a resident | Leave a walkable route to the public passages first. |
| `area-capacity` | Area block cap reached | This area holds its maximum blocks; remove some before adding more. |
| `blocked-tile` | Ground is not buildable | Choose clear, walkable ground without water, trees or scenery. |
| `unsupported-layer` | Unsupported layer | Stack a solid block directly below this layer first. |
| `blocked-doorway` | Doorway would be sealed | Move the structure so every entrance opens onto reachable ground. |
| `outside-area` | Outside the area | Move the footprint so it stays inside the 48 × 48 area. |
| `unknown-blueprint` | Unknown blueprint | Choose one of the listed construction blueprints. |
| `invalid-blueprint` | Palette not allowed | Use only the sealed frontier block types and layers. |
| `paused` | Resident paused | Resume this resident before building. |
| `platform-paused` | World paused | The world is paused; building resumes when it is active again. |
| `not-signed-in` | Not signed in | Sign in as this resident's operator to build. |
| `stale-world` | Stale area | Refresh the world: your resident has entered another area. |
| `unknown` | Refused by the server | Read the server's message and adjust the placement. |

The blueprint path's `out-of-range`, `out_of_plot`, `blocked-cell`, `shared-access`, `resident`, `trap`,
`blocked-doorway`, `area-capacity`, `budget`, `blocked-tile`, `invalid-blueprint`, `unsupported-layer`,
`outside-area` and `unknown-blueprint` are the **server's own machine codes** (`src/frontier.js`
`blueprintPlan`). The single-block path returns a status and a sentence; those sentences are matched in
order and the **server's sentence is always shown verbatim** beside the reason.

## 5. Wiring steps for the integration owner (Task 38)

`app.js` is `<script type="module">` (`index.html:30`), so the shell can import these modules directly.
`app.js`, `index.html` and the stylesheets are **not edited by this task**; the steps below are what the
shell owner does.

1. **Import both modules** in the shell:
   `import { createHotbar, createPlacementPreview, mount } from './src/ui/build-interface.js'` and
   `import { createInventoryPanel } from './src/ui/inventory-panel.js'`.
2. **Create the components once** (they hold their own state between renders): a `hotbar`, a `preview`
   and an `inventory`. Give `preview` the shell's own `api` client (the same `api(path, method, body)`
   that rejects with `Error{ status, message }`), and give both build components an `input` the shell
   builds from its camera controls:
   ```js
   const input = { currentPick: () => state.voxelSelection, subscribe: (fn) => { pickListeners.add(fn); return () => pickListeners.delete(fn); } };
   ```
   The shell calls every `pickListener` with the new pick in `pickWorld`; the components themselves
   never import `src/camera-controls.js` or `src/game-input.js`.
3. **Feed the components the payload the shell already fetches.** After `loadWorld()`:
   `hotbar.update({ world: state.world, pick: state.voxelSelection, moderator: isModerator() })` and
   `preview.update({ world: state.world, pick: state.voxelSelection, session: { agentId: state.selected, worldId: state.world.world.id, player: viewedAgent() } })`.
   After `loadJourney()`: `inventory.update({ journey: state.journey, offers: state.offers, agentId: state.selected })`.
4. **Mount the views where the coordinates-first forms were.** Replace the frontier card's
   `Apply block at coordinates` form with `mount(node, preview.view())`, put `mount(node, hotbar.view())`
   in the frontier hotbar slot (`.game-hotbar`), and mount `inventory.view()` as the Inventory drawer
   over `.world-aside`. Re-`mount` after every state change (the components return fresh trees).
5. **Wire the callbacks.** `hotbar`'s `onSelect(type)` calls `preview.setKind(type)`; the panel's
   `onNotice(text)` writes the shell's own notice region. `preview.handleKey(key)` and
   `hotbar.handleKey(key)`/`inventory.handleKey(key)` are called from the world keydown handler for
   keys the shell does not already own (digits, `0`, `b`, `c`, `r`, Escape), so the keyboard path is
   identical to the pointer path.
6. **Keep the blueprint choice** from the world payload: `world.frontier.blueprints` is the catalogue;
   the shell calls `preview.setBlueprint(id)` from its own blueprint selector.
7. **Delete nothing that a parallel task owns.** The garden's build card, the plot-collaboration panel
   and the arrow-key movement are other surfaces; this task adds the pointer-first build path beside
   them, it does not remove them.

## 6. Keyboard parity

Every action is a labelled `<button>` or a labelled field, so Tab + Enter reaches all of them. In
addition the components accept the following keys through `handleKey`:

| Component | Keys |
| --- | --- |
| Hotbar | `1`–`9` select the palette entry at that position; `0` selects removal |
| Placement preview | `b` previews the chosen blueprint, `c` confirms the placement, `r` toggles placement/removal, `Escape` clears the preview and the typed anchor. The typed `Target tile X`, `Target tile Y` and `Layer` fields remain the text fallback when the canvas cannot be clicked |
| Inventory panel | `1`–`9` select a recipe; `c` (or Enter on the control) crafts it |

The shell still owns WASD/arrow movement, `Q`/`E` turn and `R`/`F` tilt (`src/camera-controls.js`);
the digits keep the meaning they already have there (choosing a frontier block), so a player who
already knows `1`–`7` needs nothing new.

## 7. Limitations and residual risks

- **The server has no non-writing single-block preview.** `POST /frontier/build` validates and writes in
  one call; only the blueprint path has `preview: true`. The placement preview therefore uses the
  **server's own validation** for blueprints and, for single blocks, shows the server's **observed**
  facts and defers the authoritative decision to the write, whose refusal it renders verbatim. It never
  invents a permission and never renders an unconfirmed placement as saved.
- **The `asserts` for a single block are a presentation of server payload facts**, not a re-implementation
  of the build rules: they name the plot's steward, the caller's grants and a parcel's own reservation,
  all read from the payload. Anything the server decides later (distance, terrain, occupied cells, the
  escape rule, the area cap, the daily budget) is stated as "the server decides when you confirm".
- **The panel is not browser-verified.** No page was opened by this task. The markup, focus order and
  live-region behaviour are reasoned from the existing components and asserted against an in-test DOM
  that refuses `innerHTML`; a human should run the manual walkthrough in the handoff before presenting
  the interface as finished.
- **The component does not delete the coordinate forms.** Until Task 38 wires the views, the shipped
  coordinate-first card is still what the browser shows. This task adds the components and their tests;
  it does not change the running shell.
- **Blueprint and single-block placement modes are exclusive.** `setKind` clears blueprint mode and
  `setBlueprint` clears the typed anchor, so a player cannot send a request that is both.
- **The view tree is plain data.** It is not virtual-DOM diffed; the integration owner re-mounts on
  change, which is what the shipped `renderView()`/`paintWorld()` already do for their stable nodes.
- **Grants shown are the caller's own.** A guest sees the grant that covers the tile they point at; a
  steward sees their own plot named. Another operator's private grant is never read (`frontier.grants`
  is the caller's own bounded listing).

## 8. Migration and rollback

**No schema change.** This task adds two ES modules and two test files. It writes **no** database row,
adds no route, changes no table, trigger, index or `PRAGMA user_version`, and reads only endpoints that
already existed. Opening an existing schema-21 installation runs no migration.

**Rollback** is a checkout of the base commit `d07814d` together with its tree: deleting the four added
files leaves the shipped server, database and interface exactly as they were. Nothing written by the
shipped build path becomes unreadable, because this task writes nothing at all.

## 9. Verification

Actual results are reported verbatim in
[the handoff](handoff/task-34-building-interface.md#5-verification-actual-output). In short: `npm run
check` passes, `npm test` passes with 23 new tests (600 → 623), and `npm run e2e` passes 15/15. The
`npm run check` gate runs a **fixed file list** that this task may not edit (`package.json` is owned by
another task), so the two new modules are additionally checked with `node --check` and are exercised by
`npm test`, which imports and runs them.

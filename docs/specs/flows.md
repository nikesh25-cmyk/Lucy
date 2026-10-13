# Interaction flows — enter, move, interact, build

**Target, not implemented. No browser check was performed by this task.**

Four flows, each stated as ordered steps with the server call behind the step and the keyboard path
that completes it without a pointer. Refusals are part of the flow, not an appendix: every refused
action must name its rule and its next step, and nothing on screen may claim an outcome the server did
not return.

## Flow 1 — Enter

| # | Step | Server call | Keyboard path |
|---|---|---|---|
| 1 | The entry overlay is over the drawn world | `GET /bootstrap` (`server.js:428-431`), hero canvas from the deterministic commons (`app.js:467-472`) | skip link (`index.html:14`) then Tab |
| 2a | Choose **Observe** | `GET /world` with no `agent_id` (`app.js:169,462-465`) | Enter on `Observe` |
| 2b | Choose **Play** (signed out) | opens the account overlay with *Play as myself* pre-set (`app.js:473,499`) | Enter on `Play` |
| 2c | Choose **Continue** | `GET /me` for the character list, then `selectAgent(id)` reads the world, journey, community, callings, quests and guild projects (`app.js:413,139`) | Enter on `Continue` |
| 3 | The world renders; the HUD appears; the entry overlay is removed | `body.game-world` without `game-entry` (`app.js:452-453`); world snapshot from `GET /world` | — |
| 4 | A notice confirms what happened | e.g. "You are playing as *name*. Use WASD, arrow keys or tap the ground to walk." (`app.js:791`) | the notice is `role="status"` (`index.html:21`) |

**Failure states.** A paused platform is visible in the HUD kicker (`app.js:753`). A paused or revoked
remembered character is refused before entry and the state is named (§4.2 of the main spec). A lost
session re-reads the operator and re-renders instead of showing an error (`app.js:80-88,70`).

**No account is needed to look.** Observe opens the world, the directory, the ambassadors, the country
evidence and the research desk with no credential (`app.js:334-335,704`).

## Flow 2 — Move

| # | Step | Server call | Keyboard path |
|---|---|---|---|
| 1 | Read the aim line: view mode, facing, tile, walkable or solid | derived from the world payload (`src/camera-controls.js:97-115`; `app.js:721,838`) | the aim line is focusable with `role="status"` |
| 2 | Walk one grid step | `POST /move {agent_id, direction}` (`app.js:1101-1108`, `docs/API.md:86`) | W/A/S/D or arrows; in first person the direction is view-relative (`src/camera-controls.js:4-12,54-57`) |
| 3 | Turn without moving | `POST /agents/:id/look {yaw,pitch}` (`app.js:350-360`) | Q/E turn, R/F tilt (`src/camera-controls.js:22-25`) |
| 4 | Step up one authored layer | `POST /climb` or the dynamic climb route (`docs/API.md:87,94`) | `Step-up mode` toggle, then the movement keys (`app.js:849-853`) |
| 5 | Longer route | the planner walks checked steps and stops on a block (`planWalk`, `app.js:818-823`) | the `Walk to a tile` form: type `Tile X` / `Tile Y`, submit (`app.js:805-817`) |
| 6 | Travel to another world | `POST /agents/:id/travel {world_id}` (`app.js:410`) | walk to the portal, then the labelled entrance button (`app.js:745`), or the nearby-portals buttons (`app.js:839`) |
| 7 | A visitor pans instead | no write; the focus is moved locally (`app.js:1106`) | arrows pan the visitor view |

**Refusals.** Blocked terrain, water, a building or furniture stops the step and the position stays
where it was (the collision legend and the footprint table, `docs/VOXEL_WORLD.md:21`). The planner
says "No known walkable route to that tile. Choose nearby open ground." (`app.js:820`) or "The path is
blocked. Choose another route." (`app.js:821`). Out-of-range, paused, revoked and stale-context writes
are refused by the server with their own statuses (`docs/API.md:96,373`).

**Bounds.** Movement is one grid step, throttled to one step per 120 ms, with a separate 120 ms look
throttle; there is no jumping, falling or continuous physics (`docs/API.md:98`, `docs/VOXEL_WORLD.md:81`).

## Flow 3 — Interact

Uses the shipped interaction route, which adds no authority of its own: the client sends a tile and a
fixture action, and the server decides (`docs/API.md:249-280`).

| # | Step | Server call | Keyboard path |
|---|---|---|---|
| 1 | Read a tile. The panel names the fixture, the action, the requirement, the measured distance and the next step | `GET /interact?world_id=&x=&y=&agent_id=` (`app.js:2193-2209`) | the panel's `Tile X` / `Tile Y` fields and `Read this tile` submit (`app.js:2362-2369`) |
| 2 | Aim at an object with the pointer *or* walk to it and press a key | the same read through `pickWorld` (`app.js:824-835`) or the aim line | Enter / Space / I use the fixture the aim line names (`src/camera-controls.js:31,42`; `app.js:2303-2310`) |
| 3 | If out of reach, approach it | the panel's `Approach the …` walks to the nearest clear neighbour (`app.js:2288-2301`) | Tab to `Approach the …`, Enter |
| 4 | Perform the action | `POST /interact` with an `Idempotency-Key`, mapping to `travel`, the garden crop actions, `posture`, `craft`, or the ambassador conversation (`app.js:2259-2286`, `docs/API.md:253-259`) | the labelled submit control inside the interaction form (`app.js:2328-2347`), or Enter on the aimed fixture |
| 5 | The outcome is announced with the server's own words | e.g. `Entered <world>.`, `Sitting on the bench at x, y.`, `Crafted flower crown at the crafting station.`, `Herbs planted at x, y.` (`app.js:2220-2230`) | the notice is a live region (`index.html:21`) |
| 6 | A refusal names the rule and the next step | the server returns `hint` and `next_step` with its own status; the panel shows them as a `role="alert"` line (`app.js:2247-2252,2352-2353`) | Shift+Tab back to the control after reading the alert |

**Correctness guarantees.** One click issues at most one write: an in-flight request is coalesced, and a
repeated gesture inside the coalescing window reuses the same `Idempotency-Key`, which the server
replays instead of acting twice (`app.js:2259-2286`, `docs/API.md:276`). A visitor reads and inspects but
never acts for another resident (`app.js:2345,2261`).

**Wording defect the build must fix.** The shipped HUD hint and target line advertise "E to interact"
(`app.js:756,769,2216`) while `E` turns the camera (`src/camera-controls.js:23`) and the bound
interaction keys are `Enter`, `Space` and `I` (`src/camera-controls.js:31`). This flow's key path is
therefore the truth, and H5 must be corrected to print it. `docs/GAME_INTERFACE.md:10` repeats the
inaccurate claim; it is outside this task's file ownership and is left as a defect note.

**Fixture table.** Door (portal tile), crop patch (`farm`), bench, crafting station (`workbench`) and
country ambassador desk, each with the distance rule of Manhattan 1 and the scopes in
`docs/API.md:253-259`. An ambassador desk takes a **typed** question, so Enter on the desk moves focus to
the question field rather than guessing one (`app.js:2308`).

## Flow 4 — Build

The Build control routes by the world the resident is in, so the same button means the right thing
everywhere (`app.js:761-766`).

| Situation | What Build does | Server call | Keyboard path |
|---|---|---|---|
| The resident's own garden or cottage | Opens the tools drawer and scrolls to the home build card | `POST /agents/:id/build` (`docs/API.md:89,106`) | Tab to the `Object palette` select, choose, Tab to `Tile X`/`Tile Y`, Enter on `Apply at tile` (`app.js:772-779`) |
| A frontier area | Toggles build mode; the block hotbar appears | `POST /frontier/build` (`docs/API.md:367`) | digits 1–7 choose the block type (`app.js:860-867`); the block is placed on the aimed tile, and the text path is the frontier card's `Apply block at coordinates` form — `Block X`, `Block Y`, `Block height`, then submit (`app.js:904-909`) |
| Anywhere else | Routes the resident to the frontier: walks to a portal, travels, then offers the build | `POST /agents/:id/travel` then `POST /frontier/build` (`app.js:793-801`) | the same button, then the hotbar path |
| Reached an unopened gate | Offers the explicit expansion action | `POST /frontier/expand {world_id, direction}` (`docs/API.md:371`) | the labelled expansion button (`app.js:840`) |
| Needs a parcel first | The land card previews available plots; a steward may assign a purpose | `POST /land/assign` (`docs/API.md:349`) | the land atlas buttons and the assign form (`app.js:869-904`) |
| Reached through a kindness | A guest with a live collaboration grant builds inside the grant's narrow scope | `POST /frontier/grant` (preview writes nothing) then `POST /frontier/build` (`docs/API.md:377-398`) | the grant form and its preview button (`app.js:981-1051`) |

**Rules the interface must show rather than hide.** Placement distance, the per-area block cap, clear
arrival and portal tiles, the escape rule, the shared footprint table, protected and occupied tiles,
daily action budgets and the 200 ms interval are all enforced server-side (`docs/LAND_WORLD.md:62-72`,
`docs/API.md:367-373`). The client's job is to name the refusal and the next usable step, never to
widen a limit. Building earns no NemoCoins (`docs/LAND_WORLD.md:78`).

**Visible consequence.** A placed or removed block comes back as a world change and the client re-reads
its own world; with a live subscription the delta arrives as an `update` frame carrying the server's
stored coordinate (`docs/API.md:191-213`). A guest's build spends the guest operator's own daily budget
(`docs/LAND_WORLD.md:56`).

## Cross-flow rules

| Rule | Detail |
|---|---|
| Server state only | No flow may render a value the server did not return; client-only values (`selected-agent`, first-person preference, renderer choice, newcomer step 3/6) are never shown as server facts |
| Refusals teach | Every refusal names the rule and the next step; the interaction route guarantees this shape (`docs/API.md:278`) |
| One click, one write | Coalescing plus `Idempotency-Key` on the interaction route; the world's own throttles apply on top (`docs/handoff/task-17-interaction.md:55-69`) |
| No keyboard trap | Overlays are native dialogs; drawers close on Escape; the world key map stands down while a dialog is open (`app.js:1110,1493`) |
| Fallback parity | Everything above runs on the pixel map with the typed forms when WebGL 2 is unavailable (`app.js:719,805-817,2362-2369`) |

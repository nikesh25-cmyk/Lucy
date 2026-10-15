# Wave 2 shared world — persistent shared-world infrastructure

15 October 2026. Branch `framework-wave2-sharedworld`, cut from the map owner's completed phase 1 tip
`f85c84b` (one global map, edge-to-edge walking between the Commons and its neighbours) in its own
worktree (`work/wave2`). **Eight commits** on top of `f85c84b`; the last carries this document. The
reviewable patch is
`/Users/nikesh/Documents/Codex/2026-10-15/nemoworld-framework/patches/framework-wave2-sharedworld.patch`,
generated with `git format-patch f85c84b --stdout`. `outputs/Lucy` and the installed product were never
opened. **No schema change: the schema is still 24**, no migration and no new schema version. The map
owner's projection (`src/global-map.js`, `src/map-view.js`) was read and reused, never rewritten;
`src/spaces.js`, `app.js`, `src/voxel-world.js`, `src/scene/*`, `src/database.js` and `src/recovery.js`
were not touched.

## What the owner can now do

Ask the server for the viewport a client is actually drawing — one global rectangle, spanning any
seam — and be told what is really there: every region the rectangle overlaps, with that region's
residents, their presence, its civic residents and its saved placements, each in its own stored
coordinates, inside a stated bound on the work. Nearby speech and presence now have tests that cross a
seam; a reconnect, a missed-events gap, a process restart and simultaneous writes each have a test
that the client-visible state equals the stored state; and a content update, a map update and a
restart each have a test that they move no saved land, plot or block.

## What changed

| File | Why |
| --- | --- |
| `src/map-viewport.js` (new) | The bounded viewport read: `viewportWindow`, `viewportPlan`, `VIEWPORT_BOUNDS` and the `mapViewport` method. Pure planning, one windowed read per region. |
| `server.js` | One additive GET route, `/api/v1/map`, its entry in `gets`, and `/map` in the public-route list. Nothing existing changed. |
| `src/platform.js` | Two lines: import and `Object.assign(Platform.prototype, …, viewportMethods)`. |
| `scripts/multiplayer-soak.mjs` | A new phase 4c: two humans and one AI resident cross the Commons/Highlands seam, speak across it, build in the AI resident's garden and are found again after the restart. The convergence comparison is now world-aware (see below). |
| `scripts/browser-suite.mjs` | One new scenario, `shared-world-seam-crossing`, plus two `ACTORS` entries and a `browserCrossSeam` helper. Surgical: 187 added lines, no existing scenario touched. |
| `tests/browser-suite.test.js` | The registry count 45 → 46 and the new id added to the list of scenarios that must remain. The assertion was corrected, not weakened. |
| `tests/map-viewport.test.js`, `tests/map-viewport-runtime.test.js` | The pure cover and the measured bound, over a real platform and over real HTTP. |
| `tests/seam-coherence.test.js`, `tests/seam-presence-and-chat.test.js` | The five coherence truths across a seam. |
| `tests/seam-convergence.test.js` | The four convergence events, including a real server restart mid-session. |
| `tests/finite-world-preservation.test.js` | Byte-identical saved land, plots and blocks after a content update, a map update and a restart. |
| `tests/framework/known-gaps-sharedworld.mjs` | Three reproducible defects with patch proposals. Not discovered by `node --test`. |
| `docs/handoff/framework-wave2-sharedworld/` | The soak transcript and its machine-readable report. |

## Modules and routes extended

- **New module** `src/map-viewport.js` — `VIEWPORT_BOUNDS`, `viewportWindow(input)`,
  `viewportPlan(window)`, `viewportMethods.mapViewport(actor, input)`.
- **New route** `GET /api/v1/map` with `world_id`, `agent_id`, `gx`/`gy`, `x`/`y`, `columns`, `rows`.
  It is a read: it decides nothing, writes nothing, and adds no authority — every rectangle of
  `MAP_LAYOUT` is a public shared world, which a test asserts against the seeded registry.
- **Extended**: `scripts/multiplayer-soak.mjs` (a new phase and a world-aware convergence
  comparison), `scripts/browser-suite.mjs` (one scenario).

## The viewport read guarantee, and its measured bound

**Guarantee.** For a global window of at most 96 × 64 tiles, `GET /api/v1/map` returns every region of
`MAP_LAYOUT` the window overlaps, and for each one: the residents whose stored tile lies inside the
clipped window (with presence), the regional guides and country ambassadors inside it, and the saved
`world_objects` rows inside it — each tagged with the stored world it belongs to. A region is never
read twice (`viewportPlan` is one pass over the layout, sorted by world id, so two clients can diff
two payloads) and a region outside the window is never read. Anything the ceilings cut off is named in
`work.truncated`.

**Stated bound** (`VIEWPORT_BOUNDS`, and `work` echoes what was actually done):

| Bound | Value | Why |
| --- | --- | --- |
| `max_window_columns` × `max_window_rows` | 96 × 64 | the largest viewport any shipped client draws; a bigger request is clamped and `clamped: true` says so |
| `max_regions` | 9 (`MAP_LAYOUT.length`) | one read per placed world, each read once |
| `max_statements` | 38 (`4 × 9 + 2`) | the exact worst case of the module's own query count: one anchored access check, one optional viewer lookup, four windowed reads per region |
| `max_participants` | 200 | the shipped participant limit, shared by every region in the window |
| `max_objects_per_region` / `max_scenery_per_region` | 256 / 256 | each query carries its own `LIMIT`, so no region can return more than its share |
| `max_rows_returned` | 1024 | the merged ceiling |

**Measured** (`tests/map-viewport-runtime.test.js`, this host, this run):

- the widest permitted window over the layout covers 5 regions and the read issues **22 of the stated
  38 statements**, returning 4 rows; the module reports exactly the number it issued;
- every one of the nine placed worlds as the anchor stays inside the bound and issues **zero writes**;
- as a read-only measurement, the windowed per-region read returns **31 rows for the orchard where the
  whole-region read returns 40** — which is why the queries are windowed rather than whole-region.

**Before and after**, both reads over the same seam on the same fixture:

| Read | Statements | Rows | Writes | Wall time |
| --- | --- | --- | --- | --- |
| the map owner's published `world?map=core` window (unchanged) | 149 | 292 | **20** | 509.4 ms |
| the new bounded `GET /api/v1/map` | 10 | 6 | **0** | 2.1 ms |

The 20 writes are a finding, not a boast (see findings). The wall-time column is a single loopback
measurement on a loaded host and is reported, not asserted.

## The coherence truths, and the test for each

| Truth | Test | What it establishes |
| --- | --- | --- |
| **Walking a seam keeps you on the one stored world** | `tests/seam-coherence.test.js` — "a seam crossing is a step, not a travel" | one agent row changes; no `worlds`, `world_objects` or `frontier_sectors` row is created or touched; no other resident moves; the stored tuple projects back to itself and is walkable in the world it names; three round trips end on the exact tuple they started from; exactly one `world.entered` audit row per crossing |
| **A collision on one side is a collision on the other** | same file — "a blocked step across a seam changes nothing at all" and "a saved object in the landing world is a collision at the seam exactly as it is inside the world" | water across a seam refuses exactly as water inside a world does; a refused crossing leaves the stored tuple byte-identical and writes nothing; a **saved object on the landing tile** refuses the crossing and removing it reopens it, so the collision is the object and not the seam; a resident on the landing tile blocks nothing, on either side |
| **Interaction distance is measured in world space, not per-region space** | same file — "interaction distance is never subtracted across regions" | a fixture one global tile away in the neighbouring region is `blocked_by: another_world`, `can_act: false`, `in_range: false`, and is told to travel; inside one world the distance is plain Manhattan distance. The *reported number* for a cross-region fixture is the one thing this read gets wrong — a confirmed defect, see findings and the repro |
| **Construction rights follow the stored plot, not the region a client claims** | same file — "construction rights follow the stored plot" | the build method takes `(actor, agent, input)` and names no world; a region of the map is refused, another operator's garden is refused, and the database's own `world_objects_build_guard` refuses a placement anywhere that is not a `home`/`house` |
| **Presence and nearby chat include neighbours across the seam** | `tests/seam-presence-and-chat.test.js` | over real SSE: the world the walker entered receives the arrival with the stored tile, the world it left drops it, and a world outside the watch radius (Snowline, Woodlands) receives nothing at all; nearby chat counts its three tiles **in world space** — a resident one global tile away across the seam is a recipient although its local coordinates differ by 35, a resident four global tiles away is not, an interior is never a neighbour, and the same three tiles apply inside one world; the presence a viewport read reports is the presence the world payload reports |

## Convergence on stored truth, and how each of the four events is proved

`tests/seam-convergence.test.js` uses a small map client: it holds **global** coordinates, rebuilds
from `GET /api/v1/map`, and applies the channel's deltas through the map owner's own projection
(`toMapItem` in `src/map-view.js`). The invariant after every event is one — the global tile the
client draws equals the global tile of the stored row, in the world that row names.

| Event | How it is proved |
| --- | --- |
| **Reconnect** | the client is closed while a resident crosses the seam and keeps walking; on reconnect it rebuilds from its own snapshot and its drawn tile equals the stored row (including the world it was moved into), then receives the live delta as the resident walks back across |
| **Missed events** | six accepted steps and three accepted public messages happen while the client is away; on reconnect the drawn tile equals the stored row, exactly three messages are stored and they are the three the server confirmed; a retried interaction with the same `Idempotency-Key` is answered from the ledger (`replay: true`, the recorded outcome) and exactly one `world.entered` audit row exists — no duplicated and no lost action |
| **Process restart mid-session** | a real server image is stopped, its platform handle closed, and a second image opens the same database file with a fresh hub and a fresh replay ledger; every resident row, saved placement and world row is compared string-for-string before and after; the restarted process serves the row the resident was left on (on the far side of the seam), the client subscribes to the new image and converges, and the walk back is streamed by the new process |
| **Simultaneous writes** | three residents step concurrently over HTTP (interleaved, 6 rounds); every accepted response is asserted to be the stored row — nothing lost between two writers and nothing applied twice; a second step inside the server's own 120 ms throttle is refused and changes nothing; two placements at one tile leave exactly one `world_objects` row |

## Preserving the finite world and the existing plots

`tests/finite-world-preservation.test.js` plants a garden placement, a frontier block inside an
assigned parcel and a saved conversation, then compares a canonical dump of `world_objects`,
`frontier_sectors`, `frontier_blocks`, `land_parcels`, `land_stewardships` and `worlds`:

- after a **content update** — the platform's own constructor path re-run (`seed`, `seedSpaces`,
  `initCommunity`, `initJourney`, `initCivic`, `initVocations`, `initQuests`, `initGuilds`,
  `initEvidence`) — byte-identical, and the parcel still reads back with its purpose;
- after a **map update** — every placed world definition and the stitched map rebuilt — byte-identical,
  and every stored coordinate is a local tile of the world that owns it, so there is no stored global
  coordinate a layout revision could reinterpret;
- after a **restart** — byte-identical, the garden holds exactly its placements, and every derived
  global tile still projects back to the stored tile.

The strongest form of the same truth is asserted directly: **a map rectangle can hold no saved
placement at all**, because the shipped `world_objects_build_guard` refuses one; the viewport read
therefore reports an empty object family for a crossing viewport.

## The soak walkthrough

`node scripts/multiplayer-soak.mjs --accounts 8 --subscriptions 4 --duration 6000` — the documented
run, over real HTTP and Server-Sent Events against a temporary database. Full transcript:
`docs/handoff/framework-wave2-sharedworld/soak-transcript.txt`; report:
`.../soak-report.json`.

```
PASS  32 subscribers 4/account, 8 writing avatars, 6000 ms write phase
  frames      4368 total, 116-143 per client, 10775 update entries, 18 heartbeats, 0 duplicate messages
  latency     frames p50 1 ms · p95 7 ms · max 29 ms · requests p95 9.31 ms
  requests    356 attempts · 354 accepted · 0 throttled · 2 refused
  writes      292 accepted steps, 20 public messages, 8 garden builds over 6157.2 ms = 50.7 row-writing requests/s
  shared      3 seam crossings (human_a, human_b, ai), 1 nearby message(s), 3 placements in the AI resident's garden
  restart     the three residents were left on {"world_id":"district:highlands","x":25,"y":35} and the restart preserved them
  checks      70 passed, 0 failed
```

The seam phase, in its own words from the report:

- `human_a`: `commons` → `district:highlands`, stored `25,35`, with the response naming
  `seam: true`, `from_world_id: commons`, `world_id: district:highlands`;
- `human_b`: the same seam, the same landing tile;
- `ai`: the AI resident crossed over its **own runtime credential** (`kind: 'agent'`, scopes
  `read/move/chat/build`) with the same rule, and its stored row moved with it;
- the nearby message reached **2** recipients (the AI resident one world-space tile away across the
  boundary and the other human on the landing tile) and the resident **four world-space tiles** away
  was excluded — checked against the `messages.recipients` row, not against a client;
- three placements were refused outside the resident's own plot (403 across the seam, 403 from the
  Commons) and three were stored in its garden;
- after the restart all three residents were still in `district:highlands` and the garden still held
  its three placements.

**A defect the soak found and this slice fixed**: the soak's convergence comparison treated a
neighbouring world in a delta as a departure but still demanded the stored row, so a writer that
walked off the Commons edge was reported as a divergence (64 false failures before the fix). The
comparison is now world-aware — a resident stored in another world and absent from a subscriber of the
world it left is a crossing, counted in `residents_that_left_the_world`, not a mismatch.

## Findings

**Confirmed defects**

1. **`world?map=core` drops the followed resident after a seam crossing.** The neighbour window is
   centred on the anchor world's own camera, which falls back to the anchor's arrival tile whenever the
   viewer is in another world, so a client subscribing to the world its resident just left cannot see
   that resident. Owner: `src/spaces.js mapWindow` (the movement owner's file). Repro and patch
   proposal: `tests/framework/known-gaps-sharedworld.mjs`,
   `map-window-drops-the-followed-resident-after-a-seam-crossing`.
2. **`interactionView` reports a distance computed across two regions.** With the viewer in `commons`
   and a bench in `district:highlands`, `fixture.distance` is `25` — the difference of two different
   regions' local coordinates (the world-space distance is 21) — and the hint states "you are 25 tiles
   away". The *decision* is correct (`blocked_by: another_world`), so this is a wrong reported value,
   not wrong authority. Owner: `src/spaces.js interactionGuidance`. Repro and patch proposal:
   `interaction-view-reports-a-distance-across-two-regions`.
3. **`GET /world` mutates stored rows.** `world()` calls `mayors()`, which calls `tickMayors()`, which
   runs `UPDATE npc_mayors …`; on the map the same call runs once per neighbouring world as well, and a
   single `GET /world?map=core` issued **20 writes and 148 statements** in the measurement above.
   Pre-existing, not introduced here, and amplified by the map window. Owner: `src/civic-engine.js`
   (`mayors`/`tickMayors`) called from `src/spaces.js world()`. Repro and patch proposal:
   `a-read-route-mutates-the-civilian-patrol`.

**Likely issues**

4. `mapWindow`'s object window (37 × 37) is smaller than its people window (96 × 64), so one payload
   answers two different viewports. The bounded read uses one plan for both.
5. A `nearby` message is read from **any** world of the map rather than only the ones within sight
   (`src/spaces.js world()`, `nearbyWorldIds`). Correct for the stored recipients, but a wider read than
   the send rule.

**Design decisions**

6. Interaction distance does **not** cross a seam: a fixture in the next region is out of range until
   the resident is stored there. Consistent with travel needing an adjacent doorway, and asserted;
   flagged because the brief's wording ("measured in world space") is satisfied by the *nearby chat*
   rule and not by the fixture rule.
7. Neither the soak nor the browser scenario claims MMO scale. One Node process, one SQLite writer,
   loopback only.

**Untested**

8. The new browser scenario **was executed** after this document was written — see
   *Wave 2 browser verification* below. It failed on that first run for two reasons, both of them in the
   scenario itself; both are fixed, and the scenario passes 5 focused runs and the full 46-scenario
   run. Its helpers are the shipped ones and its registry is covered by `tests/browser-suite.test.js`.
9. The map-wide neighbour read in `publishNear` (radius 18) sends the same delta to worlds whose
   subscribers cannot hold it, because the delta names the world the change happened in. Correct
   client-side (the frame is dropped) but not measured here.
10. Real network latency, TLS, a proxy, packet loss, multiple server processes, multiple SQLite
    writers, and memory growth over hours: none measured.

## Gates

Node 24.15.0 for every command. The host was busy with other agents throughout; the load average is
recorded beside each run because two of the base's own tests are load-sensitive.

| Gate | Result | Host load |
| --- | --- | --- |
| `npm run check` | **104 files, 0 failed** (the base is 103; `src/map-viewport.js` is the new one) | — |
| `npm test` | **1112 tests, 1112 pass, 0 fail** (`EXIT=0`, 833 s) — including the two the base failed | load average 72–94 at the end of the run |
| `npm run e2e` | **PASS — 20 steps passed, 0 failed**, `E2E_EXIT=0` | load average 115 at the end of the run |
| `node scripts/multiplayer-soak.mjs --accounts 8 --subscriptions 4 --duration 6000` | **PASS, 70 checks passed, 0 failed** | not recorded by the harness |
| `node tests/framework/known-gaps-sharedworld.mjs` | **0 fixed, 3 reproducing** (exit 1 by design) | — |
| `npm run browser` | **UNRUN at the time of writing** — run afterwards; the results are in *Wave 2 browser verification* below | — |

The base is 1082 tests of which 2 failed; this tip is 1112 with none failing, and the arithmetic closes
exactly: 1080 base passes + 30 added tests + the base's own 2 that passed this run = 1112. The 30 added
tests are `tests/map-viewport.test.js` 6, `tests/map-viewport-runtime.test.js` 8,
`tests/seam-coherence.test.js` 6, `tests/seam-presence-and-chat.test.js` 3,
`tests/seam-convergence.test.js` 4 and `tests/finite-world-preservation.test.js` 3. The new soak phase
and the new browser scenario add no `npm test` cases of their own — the soak is a script and the browser
suite's own registry test is unchanged in count.
`tests/framework/known-gaps-sharedworld.mjs` is **not** among the 1112: it is not named `*.test.js` and
is not under a `test/` directory, so `node --test` never discovers it, which is what keeps `npm test`
green while the three defects stay reproducible.

**The base's own two failures, and why they are not this slice's.** The base at `f85c84b` was run
first, on this host, under load average ≈ 11–29: **1082 tests, 1080 pass, 2 fail** —
`tests/realtime-latency.test.js` ("every fixture client must be subscribed", 15 of 16 admitted in time)
and `tests/resident-state.test.js` ("a bounded run records real counters…", a resident run reported
`failed` rather than `completed` after 23.8 s). Both are timing-sensitive, both involve no file this
slice touches, and **both passed** on the tip run — which is why the tip's arithmetic needs the two back.
No test was deleted, skipped or weakened to reach that; the only assertion in the repository this slice
changed is the browser suite's scenario count, 45 → 46, which is a correction to a registry that
genuinely grew by one scenario.

## What remains unimplemented, externally dependent or unverified

- **The map owner's two defects are not fixed here.** `src/spaces.js` is theirs; the repros and the
  exact patches are delivered, and `npm test` stays green because the repros are in a file the runner
  does not discover.
- **`src/global-map.js` and `src/map-view.js` were not changed.** The viewport module imports
  `worldRects`, `toGlobal`, `fromGlobal`, `mapRect`, `onMap` and `MAP_LAYOUT` and adds no second layout.
- **The browser scenario has now been run.** `scripts/browser-suite.mjs` holds 46 scenarios; the full 46
  were run serially on this host, and the numbers are in *Wave 2 browser verification* below, together
  with the two defects the first run exposed (both in the scenario) and the one regression that is the
  map owner's.
- **`src/platform.js` gained one import and one `Object.assign`.** Another agent's merge of that file
  must keep `viewportMethods`.
- No schema change, so nothing here needs a migration rehearsal; no installation was touched.

## Wave 2 browser verification: the seam scenario's own defects, and an escalated regression

Written after the first real Chrome run of this branch (Chrome 155.0.8059.40, Node 24.15.0, this
host). It records what failed, what was changed, the evidence, and the one failing scenario that is
**not** this slice's to fix.

### What failed, and why it was the scenario

`shared-world-seam-crossing` failed on its first run — in a different place depending on how it was
run. Both failures were flaws in what the scenario asserted, not in the product. Both are fixed in
`scripts/browser-suite.mjs`. No assertion was deleted, skipped or weakened, and no coverage was dropped.

**1. A global `worlds` count cannot witness "the crossing created no world".** Focused, the scenario
failed 5 of 5 times at `crossing a seam must create no world` — `expected 310 worlds, actual 326`. The
16 extra rows are the living-world loop seeding its eight scripted residents: `server.js:798` runs a
3 s timer that calls `livingWorldTick` on every second tick (6 s) unless `LUCY_LIVING_WORLD=false`, and
`ensureLivingWorld` (`src/living-world.js:220`) returns early while no administrator exists, so the
seeding lands at *some* point after the fixtures create the first administrator — inside whichever
scenario is running then. Measured directly against a disposable platform, not inferred:

```text
fresh platform                       292 worlds
after one administrator account      292 worlds
after ONE livingWorldTick            308 worlds   (+16 in 28 ms)
added worlds                         home:lw-aria, house:lw-aria, home:lw-theron, house:lw-theron, …
                                     (8 living residents × one garden + one cottage)
after a SECOND tick                  308 worlds   (idempotent)
```

The invariant the scenario wants is causal, so that is what it now asserts: **the world across the
seam must already be stored before the crossing**, **no rectangle of the global map may appear**, and
**no resident that crossed may come to own a world**. The seeded rows are reported as a note instead of
being asserted away. (In the full 46-scenario run the count happened to be stable *because* the seeding
had already happened during an earlier scenario — which is exactly why a focused run is the only honest
witness, and why this defect hid from the full run and showed up alone.)

**2. Two conversation lines from one account inside the server's own interval.** In the full
46-scenario run the scenario failed at `fixture request POST /messages was refused` —
`HTTP 429 {"error":"Please wait before sending another message."}`. `src/platform.js message()` refuses
a second line from one `account_id` inside 1500 ms, and a runtime credential posts as the account that
issued it — so the human's nearby line and the AI resident's answer share one interval, and the
scenario raced a rule the product documents. Both sends now go through a new `sendLine()` helper, which
waits the interval out first (bounded, measured from the stored row) and resumes **only** the documented
refusal, printing every resume; any other refusal is still the failure. The step also now asserts the
truth that makes the sharing visible: both lines are stored under the one account.

### Escalation: `shared-presence-two-clients` is red on `f85c84b` and its ancestors are innocent

Not this slice's code and not environmental. Reproduced by me, focused runs, Chrome 155, exit codes as
recorded:

| Tree | Commit | Focused run | Exit | Host load at start |
| --- | --- | --- | --- | --- |
| `work/wave0` | `1246bfe` (on `27c0d72`, World-life) | **PASS** — `walker 10,6 → 10,5; the other browser showed it in 497 ms` | 0 | 6.67 |
| `work/base-control` (detached) | `f85c84b` — pristine map tip, no Wave 2 commits | **FAIL** — `the second client’s presence record must hold the confirmed tile`, `confirmed {x:106,y:77,z:0}` | 1 | 8.00 |
| `work/wave2` (this branch) | `974d9c4` | **FAIL** — identical assertion, identical `106,77` | 1 | 4.42 |

The failing evidence is decisive on its own: `106,77` is not a stored tile, it is
`toGlobal('commons', 10, 5)` — the Commons' rectangle is `{x:96,y:72,96×64}` (`MAP_LAYOUT`), and the
walker's stored tile in the passing run is `10,5`.

**What the scenario asserts.** `scripts/browser-suite.mjs:2564` (line 2513 on `f85c84b`):
`record.confirmed.x === moved.x && record.confirmed.y === moved.y`, where `moved` is the tile read back
from `agents.x,y` in the database and `record` is this client's own presence record, taken from the page
through `window.__nemoworld.presence()` (`clientPresence`, `:2440`).

**Where the confirmed tile is written and read.**

- written: `app.js:382` `noteConfirmed(item)` → `app.js:383`
  `presence.confirm(mapActive(state.world) ? toMapItem(item, state.world.world.id) : item)`; the tracker
  is `createPresenceTracker` (`src/camera-controls.js:287-345`), whose records are seeded by
  `seedPresence` from every `GET /world` payload;
- exposed: `app.js:523` `presence: () => presence.entries().map(([id, record]) => ({ id, confirmed: { ...record.confirmed }, … }))`;
- driven into the global frame by `app.js:361` `worldURL()` — it adds `map=core` for any world on the
  map, so the server returns `world.map` and `mapActive` is true (for the Commons as much as for
  Highlands).

**Cause: `f85c84b`'s own changes, not the two commits the map branch lacks.** `f85c84b` introduced both
the projection and the client change, in the same commit:

```diff
+ import { mapActive, mapPoint, mapSnapshot, toMapItem } from './src/map-view.js';     app.js:29
  function noteConfirmed(item) {
-   const record = presence.confirm(item);
+   const record = presence.confirm(mapActive(state.world) ? toMapItem(item, state.world.world.id) : item);
```
```diff
+ if (onMap(currentWorldId())) query.set('map','core');                                app.js:361
```

`src/map-view.js` exists only from `f85c84b` (`git log --oneline -- src/map-view.js` → one commit).
The two commits the map branch lacks are `32d8362` (schema-25 vault) and `27c0d72` (living-resident
seeding, `src/living-world.js` / `src/living-community.js`); **neither touches `app.js`,
`src/map-view.js` or `src/global-map.js`** (`git show --name-only 32d8362 27c0d72`), and neither can
move a client-side record into the global frame. The `106,77` value is the projection and nothing else.
The map branch therefore inherits a red shipped scenario from its own commit, whatever World-life adds.

**Is the product wrong, or the witness?** The client's own design is coherent: when the map is active
the renderer interpolates in global tiles and converts back for every tile it names
(`app.js:1290`, `fromGlobal`). What changed silently is the frame of a surface the shipped suite treats
as a contract — `docs/handoff/task-deepseek-movement-feel.md:121` states the record "holds the same
confirmed tile the database stores", which is what `shared-presence-two-clients` asserts. On the map
that is no longer true. That is a contract decision for the owner, not for this slice, so no file was
edited; `tests/framework/known-gaps-sharedworld.mjs` now carries the repro
(`the-presence-surface-reports-the-global-map-tile`, which reproduces the identical pair
`{reported:{x:106,y:77}, stored:{x:10,y:5}}` by evaluating the shipped client's own two expressions over
a real observation).

**Proposed patch (Option A, recommended — restore the documented frame).** One expression in
`app.js:523`, plus `localTile` in the `./src/map-view.js` import on `app.js:29`; the renderer is
untouched because it reads the tracker through `displayed()`:

```diff
-  presence: () => presence.entries().map(([id, record]) => ({ id, confirmed: { ...record.confirmed }, display: displayCoords(record, performance.now()), tweening: presence.tweening(id) })),
+  presence: () => presence.entries().map(([id, record]) => { const stored = (point) => { const local = mapActive(state.world) && Number.isFinite(point?.x) ? localTile(point.x, point.y) : null; return local ? { ...point, x: local.x, y: local.y, world_id: local.world_id } : point; }; return { id, confirmed: stored({ ...record.confirmed }), display: stored(displayCoords(record, performance.now())), tweening: presence.tweening(id) }; }),
```

**Option B**, if the owner decides the global frame *is* the new contract: change the witness instead —
`scripts/browser-suite.mjs:2564` converts through `localTile` before comparing, and
`docs/handoff/task-deepseek-movement-feel.md:121` is corrected to state the drawn frame. The two must
change together, and the claim "the record holds the stored tile" is withdrawn.

**The test that proves either fix**: `LUCY_BROWSER_ONLY=shared-presence-two-clients npm run browser`,
which must be green on the patched tree (it is red at `f85c84b` and at this tip, and green at `27c0d72`).

### Residual risk

- `shared-world-seam-crossing` reads the same database while the living-world loop writes to it. The two
  remaining count-based assertions are on tables that loop never touches (`frontier_sectors`) or are
  causal (`world.entered` audit rows for exactly the two operators), and a note records the seeded rows
  every run, so the next such collision is visible rather than fatal.
- The scenario still runs one server process, one SQLite writer, loopback only, and now spends up to
  1.5 s waiting out the message interval: it is ~1 s slower than it needs to be for the sake of not
  racing a documented refusal.
- `live-observation-readonly` failed in the integrator's full run and **passes focused on this tip**
  (exit 0, 2.9 s) — the same load sensitivity the shipped 45 already had; it is not this slice's.

### Gates, re-run for this verification

Node 24.15.0 throughout. **Another agent was running its own browser suite against a different project
tree for most of this work** (`node scripts/browser-suite.mjs`, cwd
`…/2026-10-11-i-ve-prepared-automatic-mac-setup/work/…`), which is what carried the host to load average
46 during the full run; the 1-minute average at the start of that run was 19.4 and rising. Every
load-attributed result below was therefore re-run afterwards, focused, on the same tip.

| Gate | Result | Exit | Host load |
| --- | --- | --- | --- |
| `npm run check` | 104 files, 0 failed | 0 | 2.4 |
| `npm test` | **1112 tests, 1112 pass, 0 fail, 0 skipped** (110.9 s) | 0 | 4.5 |
| `npm run e2e` | 20 steps passed, 0 failed | 0 | 2.4 |
| `node tests/framework/known-gaps-sharedworld.mjs` | 0 fixed, **4 reproducing** (exit 1 by design) | 1 | — |
| focused `shared-world-seam-crossing`, before the fix | FAIL ×5 — `crossing a seam must create no world`, `expected 310 worlds, actual 326` | 1 ×5 | 2.8–8.1 |
| focused `shared-world-seam-crossing`, after the fix | **PASS ×5** | 0 ×5 | 2.0–5.9 |
| focused `shared-presence-two-clients` — wave2 / `f85c84b` / `27c0d72` | FAIL / FAIL / **PASS** | 1 / 1 / 0 | 4.4 / 8.0 / 6.7 |
| focused `live-observation-readonly` | **PASS** | 0 | 5.9 |
| **full 46-scenario serial run, host shared** (run 1) | **38 passed, 8 failed** | 1 | 19.4–46.5 |
| focused re-run of those 8, same tip | **7 passed, 1 failed** — the failure is `shared-presence-two-clients` | 1 | 9.5–51.5 |
| **full 46-scenario serial run, host quiet** (run 2) | **44 passed, 2 failed** — `shared-presence-two-clients` and `live-observation-readonly`; **`shared-world-seam-crossing` PASSES (66.6 s)** | 1 | 4.1–7.2 |

The full run's eight, and what each actually was:

- `shared-presence-two-clients` — the escalated regression above (`confirmed {x:106,y:76}` for a walker
  stored at `10,4`);
- `live-observation-readonly` — `no message may be stored by an observer`, the shipped suite's own
  load flake; green focused, as the integrator found;
- six timeouts at the shipped limits (25 s page, 10 s request) — `first-ten-minutes` (`page.reload`),
  `first-play-solo-ambassador` (`page.goto`), `restoration-two-clients` (`POST /auth/login` aborted),
  `phone-conversation` (`page.goto`), `signout-privacy` (`page.goto`) and **this branch's own
  `shared-world-seam-crossing`**, whose *fixture login* was aborted at the 10 s request limit before
  any step of the scenario ran.

All seven non-presence failures pass when re-run focused on the same tip — the seam scenario among
them, 32.4 s, on a host still at load 32–51. Nothing was weakened to reach that; the red full run is
reported as red because that is what it was.

One intermediate run of the seam scenario failed on a typo in the new `sendLine` helper (`m.id` in a
query that has no `m`), caught by the run and fixed before the five passes above — it is recorded here
so the count of runs is complete rather than convenient.

The second full run — same tip, same command, no other suite on the host (1-minute load average 4.1,
against 19.4–46.5 during the first) — is the honest picture of this branch: **44 of 46**, with the seam
scenario passing end to end in the full suite for the first time, and two failures neither of which is
this slice's code:

- `shared-presence-two-clients`, the escalated regression above — this is what the branch actually
  fails, and it fails on `f85c84b` without a single Wave 2 commit;
- `live-observation-readonly` (`no message may be stored by an observer`). It is worth recording
  precisely, because "load-sensitive" is not quite the whole story: it fails in **both** full runs,
  loaded and quiet, and passes in **both** focused runs (`LUCY_BROWSER_ONLY=live-observation-readonly`,
  exit 0, 3.0 s alone and 3.8 s in an eight-scenario batch). So it is sensitive to the full suite's
  accumulated state or order rather than to the host, and a quiet full run does not clear it. It is the
  shipped 45's own scenario and none of this slice's files are in its path; it is reported, not touched.

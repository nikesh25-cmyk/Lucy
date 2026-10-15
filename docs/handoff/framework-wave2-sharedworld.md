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

8. The new browser scenario was **not executed** (the integrator runs Chrome serially). Its helpers are
   the shipped ones and its registry is covered by `tests/browser-suite.test.js`, but its first real
   run is the integrator's.
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
| `npm run browser` | **UNRUN** | — |

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
- **The browser scenario is unrun.** `scripts/browser-suite.mjs` now holds 46 scenarios; the full 46
  must be run by the integrator before merging. `npm run e2e` was run here and passed 20 of 20.
- **`src/platform.js` gained one import and one `Object.assign`.** Another agent's merge of that file
  must keep `viewportMethods`.
- No schema change, so nothing here needs a migration rehearsal; no installation was touched.

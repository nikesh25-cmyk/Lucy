# Task: purposeful public places inside the fixed land registry

Branch `task-deepseek-content-places`, base `f773c46` (codex/final-integration). Written 2026-10-14.

## Goal

Add a small set of genuinely distinct, purposeful public places **inside the existing finite world
registry**: each with a clear arrival path, a walkable entrance, a purpose and scenery of its own,
with server and renderer agreeing on every tile, and with the 16 × 16 area inventory, the plot
registry and the assignment records byte-for-byte unchanged.

Delivered: **five** places, each a public world of its own with one doorway on the Commons map.

| Place | Purpose it serves | Scenery vocabulary | Ground tone |
| --- | --- | --- | --- |
| `venue:workshop-annexe` — The Workshop Annexe | a second making floor: six workbenches, a long table, a south hall | `workbench` `bench` `table` `trellis` `display` `flowers` `lantern` | `#c9a085` |
| `venue:amphitheatre` — The Round Amphitheatre | an open bowl of terraced seating for public meetings and readings | `bench` `lantern` `sculpture` `flowers` `shelter` | `#bdb894` |
| `venue:archive` — The Record Archive | three shelf rows, two reading desks, a case of kept reference cards | `bookshelf` `table` `bench` `display` `cushion` `lantern` | `#b9a98d` |
| `venue:observatory-annexe` — The Observatory Annexe | two telescopes over a chart room | `telescope` `display` `sculpture` `table` `bench` `cushion` `flowers` `lantern` | `#9aa6bb` |
| `venue:seed-bank` — The Seed Bank | four rows of labelled seed beds and a sorting bench | `farm` `display` `trellis` `table` `bench` `flowers` `lantern` | `#a7b98c` |

**A venue is not a real-world institution.** Each is a fictional NemoWorld place: a courtyard, a bowl,
a hall and a shop floor of the same cube art the rest of the world is built from. No place is named
after, modelled on or presented as a government body, company, university, museum, agency or service,
and no place claims a function the world does not actually perform (the archive holds scenery, not
records; the seed bank displays beds, it does not trade seed). The world copy says so in every place's
`description`, and `tests/world-places.test.js` asserts both the "A fictional NemoWorld place"
sentence and the absence of institutional wording.

## Files changed

| File | Change |
| --- | --- |
| `world.js` | `VENUE_COLUMNS`/`VENUE_ROWS`, `PUBLIC_VENUE_PLANS` (deep-frozen layout data), `publicVenueIds`, `makePublicVenue(id)` (one builder), the `venuePlans` registry branch in `getWorldDefinition`, and the Commons integration: the five doorway landmarks join the existing `sites` list, so the map's own site loop paves each square and lays a road from the Welcome Plaza to it; a `gateway` object is drawn on each doorway; one `portal` per place is added to the Commons portal list |
| `src/spaces.js` | `seedSpaces()` inserts the five unowned public `worlds` rows idempotently (`INSERT OR IGNORE`); `worldList()` excludes the `venue` kind from the paged shared directory, so `shared_count` stays the documented thirty |
| `tests/world-places.test.js` | **new** — 9 tests (see below) |
| `docs/GAME_EXPERIENCE.md` | §9 row plus a new §9.1 "The five authored public places": how a newcomer finds one, how they enter it, and what is unchanged |
| `docs/ASSET_LIBRARY.md` | new section "Reuse by the five authored public places": the type list per place and the licence evidence |
| `docs/handoff/task-deepseek-content-places.md` | this handoff |

No file outside this list was touched. `server.js`, `src/platform.js`, `runtime/agent.js`, `app.js`,
`game-theme.css`, `src/community.js`, `src/quests.js`, `src/mission-directory.js`, `src/coins.js`,
`src/guilds.js`, `src/journey.js`, `src/vocations.js`, `src/recovery.js`, `native/**`,
`src/footprints.js`, `src/content.js`, `src/voxel-world.js`, `src/scene/**` and every test owned by
another slice are unmodified. **No schema change**; the database stays at version 22 and no migration
is involved.

## How the requirement is met, mechanically

- **Clear arrival path.** Each doorway is a tile on the Commons road network in the existing `sites`
  loop, which paints a 7 × 7 clearing, a 5 × 5 plaza and `road(grid, start, site)` from the shared
  arrival at `10,6`. The route is proved by `planWalk(commons, commons.start, door)` and by asserting
  every tile of that route is walkable and free of solid scenery.
- **Walkable entrance.** A walled place paints its wall ring and then opens the entrance column, so
  the doorway is a real `path` tile (asserted: exactly `VENUE_COLUMNS - 1` wall tiles remain in the
  south row). The open place (the amphitheatre) paves the same tile as `plaza`. The arrival is the
  tile just inside the opening, and it is walkable, clear and grounded on arrival.
- **Purpose.** A `purpose` sentence per place, carried onto the Commons map as the landmark
  description the client already lists (`app.js:957`, `app.js:1470`) and rendered as the pennant.
- **Distinct scenery.** Five distinct ground tones, five distinct scenery vocabularies over 13
  reused sealed types, five distinct layout signatures (asserted pairwise and against every authored
  world).
- **Server/renderer collision agreement.** For every place and every tile: `walkable()`/`standableTile`
  and the real `createVoxelScene()` instance matrices are read back and asserted in both directions —
  a walkable tile holds nothing between knee (0.5 m) and head (1.52 m), a refused tile is drawn as a
  real obstacle, and each scenery type resolves the same occupancy in both.

## What was tested

`npm run check`, `npm test`, `npm run e2e`, `npm run browser`, `node scripts/seal-content.mjs --check`.
The new file is `tests/world-places.test.js`; its nine tests and the assertions each makes:

1. **the five places are authored data: frozen plans, one contract each, and a stated purpose** —
   the table and every nested array/object is frozen (mutation throws `TypeError`); five distinct
   names, purposes and ground tones; each resolves to `kind: 'venue'`, 30 × 22, `start =
   {entrance, 20}`, exactly one portal named "Return to the Commons" → `commons`, fewer than 260
   objects; every `description` says "A fictional NemoWorld place"; no institutional wording; no name
   collides with an authored world's name.
2. **each place is entered from the Commons by walking its own doorway, which the map already roads
   from the arrival** — one portal, one landmark and one `gateway` object per doorway on the Commons;
   the doorway is walkable and clear; the planned route from `10,6` ends on the doorway; a fixture
   resident at the Commons start is refused `409` (the doorway is the only entrance, there is no
   directory short-cut); standing on the doorway `travel` returns `entered: true` and the stored row
   is `world_id = <venue>, x/y = start, grounded = 1`; `journey_visits` gains exactly one row; the
   return travel lands on the same Commons doorway tile; `verifyAudit()` is true.
3. **the doorway read names the place and offers the one action that enters it** — `interactionView`
   returns `fixture.kind = 'door'`, the place name, `target_world_id`, `action.id = 'travel'`,
   `label = "Enter <place>"`, `in_range/can_act = true`, a hint naming the Manhattan-distance-1
   requirement; `interact` with the travel action writes `entered: true`; the same door from the
   Commons start is refused `409` with a non-empty `next_step` and writes nothing.
4. **each place is one connected court behind a walkable wall opening, and every place and doorway
   inside it is routable** — arrival walkable and clear; the entrance tile walkable and a door
   surface; the flood fill from the arrival reaches **every** walkable tile (no stranded pocket);
   every named place and the return doorway is walkable, clear, reachable and has a `planWalk` route;
   no scenery stands on the arrival, a place or a doorway; solid types match the shared table;
   decorative types sit on or beside reachable ground.
5. **the server and the renderer agree on every tile each place draws** — 660 cells per place read
   from the real scene: walkable ⇒ nothing over knee height in the column; refused ⇒ a drawn obstacle
   enters the standing column; the plan's objects and the definition's objects agree on every tile;
   two rebuilds draw identical cube counts; each scenery type resolves the same occupancy in
   `walkable()` and in the drawn world.
6. **every asset a place draws is an existing sealed, project-authored definition** — for all 13
   distinct types: a `content/furniture` entry, `spdx = LicenseRef-NemoWorld-Project-Authored`,
   `notice_file = content/THIRD_PARTY.md`, `commit = null`, and an **empty** asset list (no
   third-party art, nothing to attribute); the manifest still reports the same 89 definitions
   (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture); `scripts/seal-content.mjs --check`
   runs from the test and reports 89.
7. **the five places are distinct from each other and from every authored world** — five distinct
   layout signatures, none equal to a signature of the 30 shared worlds, the country venue, a frontier
   area, a garden or a cottage; five distinct scenery vocabularies; two separate `node` processes
   resolve the five places byte-identically (the client and the server cannot drift).
8. **a place registers no land: the finite inventory is byte-for-byte unchanged** — with a real
   fixture: `land_parcels` 16,384 rows and a SHA-256 digest of the whole land registry (parcels,
   sectors, blocks, stewardships, events) taken **before**; then every place is resolved and entered
   by a real `travel`; then the same counts and the same digest are taken **after** and compared
   (`deepEqual`). Additionally: the `platform.land()` count object is identical, 0 parcels/sectors/
   blocks reference a `venue:` world, 0 stewardships exist, no resident object is written into a
   place, five venue rows exist and none is owned or private, and `verifyAudit()` is true.
9. **the shared directory keeps its thirty authored worlds, and a place stays a public read with a
   public row** — `worldList(null).shared_count === 30` with exactly 30 rows and no `venue` kind;
   every place is readable anonymously with `visibility = 'public'`, `owner_agent_id = null`,
   30 × 22, published solid scenery that matches `walkable()`, and a published way back out; the
   Commons world read publishes all five doorways as portals whose labels match the five landmarks;
   a restart seeds the same five rows and the directory still reports thirty.

The database assertions are named per test above; the ones that carry the slice's contract are the
`land_parcels` digest comparison (test 8), the `worlds` counts and `shared_count = 30` (tests 1, 8, 9),
the `journey_visits` row (test 2), and the refusal-without-a-write assertions (tests 2, 3).

## Actual gate output

Commands, run in this worktree on 2026-10-14, with the real numbers:

```
$ npm run check
(exit 0 — every file in the script's list, including world.js and src/spaces.js, parses)

$ npm test
# tests 893
# pass 893
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 209602.515833
EXIT=0
```

The same suite on this worktree with the change stashed (`git stash push -u`, a clean base checkout),
run as the reference:

```
# tests 884
# pass 884
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 329171.942333
```

The delta is exactly the nine tests in the new file (884 → 893); no existing test was changed,
deleted, loosened or skipped.

```
$ node --test tests/world-places.test.js
ok 1 … ok 9
# tests 9
# pass 9
# fail 0

$ npm run e2e
SUMMARY  17 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API

$ node scripts/seal-content.mjs --check
Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.
(exit 0)
```

```
$ npm run browser         # real Google Chrome, headless, disposable workspace + database
SUMMARY  38 passed, 1 failed
TEARDOWN
  server stopped, process lock released: true
  temporary workspace removed: true
  shipped database untouched
  FAIL  restoration-two-clients — locator.click: Timeout 25000ms exceeded (waiting for
        form[data-draft-section="restoration-open"] → "Open the restoration"; the element resolved,
        was visible and stable, then detached from the DOM while the click was retried)
```

**The one browser failure is a timing failure, and it is reproduced as a pass on this same tree.**
The scenario it failed in passes when run focused, twice:

```
$ LUCY_BROWSER_ONLY=restoration-two-clients npm run browser
SUMMARY  1 passed, 0 failed
  PASS  restoration-two-clients (26036 ms)
  shipped database untouched
```

A first full serial run on this tree (before the run above, same machine) failed **10 of 39** with the
same signature — every one a Playwright `locator.waitFor` / `locator.click` / `page.goto` /
`page.reload` timeout or a scenario time limit, none of them an assertion about world data. The four
scenarios that failed there and were re-run focused on this tree all passed:

```
$ LUCY_BROWSER_ONLY=game-hud-interaction-prompt-and-aim,live-observation-readonly,guild-cooperation,restoration-two-clients npm run browser
SUMMARY  4 passed, 0 failed
  PASS  guild-cooperation (7156 ms)
  PASS  game-hud-interaction-prompt-and-aim (3040 ms)
  PASS  live-observation-readonly (7802 ms)
  PASS  restoration-two-clients (14872 ms)
```

The machine's load average during those runs was **37–70** from processes outside this worktree
(macOS Spotlight `mds`/`mdwork`/`spindump` and pre-existing servers), and the suite's own durations in
the failing run inflated from 3–9 s per scenario to 30–590 s. That is the environment, not this diff:
the world-rendering and doorway scenarios (`game-shell-entry-and-continue`, `shared-build-and-restart`,
`interaction-door-and-crafting`, `interaction-hint-and-distance`, `interaction-saved-world-changes`)
all passed in the same run. **No browser scenario was skipped, and none is reported as a pass that did
not pass.** The failure traces the suite keeps for diagnosis are left in `test-results/` (gitignored,
not part of the commit).

## Migration and rollback

- **Migration:** none required. `seedSpaces()` runs on every start and inserts the five rows with
  `INSERT OR IGNORE`, so an existing database gains them on its next start and a live database can be
  upgraded by restarting. No table, column, trigger, index or `user_version` changes; schema 22 is
  untouched and `src/recovery.js` validates a database with or without the rows.
- **Rollback:** revert the commit. The five `venue:` rows may be left in place harmlessly — the base
  revision lists them as ownerless public worlds in the directory, which would make `shared_count`
  report 35 on a database that had started on this branch. To restore the base behaviour exactly, on
  such a database:
  `DELETE FROM journey_visits WHERE world_id LIKE 'venue:%';` then
  `DELETE FROM worlds WHERE id IN ('venue:workshop-annexe','venue:amphitheatre','venue:archive','venue:observatory-annexe','venue:seed-bank');`
  (the order matters: `journey_visits.world_id` is a foreign key child, `PRAGMA foreign_keys` is on,
  and nothing else references these rows). `tests/world-places.test.js` is the only new file and
  inverts cleanly.

## Residual limits, stated plainly

1. **Not a real institution.** The places are fictional NemoWorld scenery with a purpose, a name and a
   landscape. They hold no system: the archive does not store records, the seed bank does not trade
   seed, the observatory annexe does not measure anything. Nothing in this slice creates a service, a
   promise or an obligation, and no text claims one.
2. **The places are not in the paged world directory.** They are excluded by kind, exactly as
   `country` venues are, because the directory's thirty shared entries are a documented invariant
   asserted by tests outside this slice's ownership (`tests/frontier.test.js`, `tests/spectator-http.test.js`,
   `tests/local-launch.test.js`). They are discoverable instead the way the region rooms are: named on
   the Commons map, listed by the client's place list, drawn as a doorway, and offered by the doorway
   interaction read. A client that only reads `GET /worlds` will not list them.
3. **An AI resident's bounded observation does not name them.** Runtime navigation carries the first
   12 portals and the first 12 landmarks of the world, and the five doorways sit beyond both windows
   (a consequence of adding to a 35-portal Commons, not of a raised or lowered limit). An agent
   discovers a place by walking near a doorway, where the interaction read is dynamic and names it.
   Raising those windows is a change to the observation budget owned by the pruning task; it was not
   touched and no limit was changed.
4. **Two places are deliberately open-air.** Only the four walled places take the interior-ish look;
   `kind: 'venue'` is not `interior`, so the renderer draws the sky and the distant-ground backdrop
   over all five. That is correct for the amphitheatre and for the walled courts, which are shown as
   open-sky precincts; it is a stylistic choice, not a claim that a court has a roof.
5. **The scenery is a reuse, so the places cannot look like anything new.** No new furniture,
   geometry, colour or content entry was added (adding one would need `src/footprints.js`,
   `src/voxel-world.js` and a content re-seal — files owned by other slices, and a licence decision).
   Distinctness comes from layout, ground tone and vocabulary instead.
6. **Browser coverage is the suite's own scenario set.** The Chrome run exercises the shipped
   scenarios against the Commons and the shared rooms; it does not add a scenario that walks into a
   venue, because `scripts/browser-suite.mjs` belongs to the browser-acceptance slice. The entrance,
   the arrival and the doorway action are covered by the HTTP- and record-level tests above.
7. **Not measured:** no frame-rate or draw-batch figure is claimed for the five places; only the
   bounded per-world assertions (`objects < 260`, 660 cells, valid material colours, finite matrices)
   in test 5.

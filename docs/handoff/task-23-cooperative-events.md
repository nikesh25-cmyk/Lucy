# Task 23 — cooperative world restoration events (the Gathering Garden)

Branch `task-23-cooperative-events`, worktree `work/t23`, based on **`7d1f9ac`**
(*Merge branch 'chore/docs-consistency-2' into verify-batch02-wave-g*), the batch-02 waves A–G tip
(567 tests, e2e 15/15, 21 browser scenarios, schema 21).

One original peaceful multiplayer event: **the Gathering Garden**, a shared garden that two or more
operators restore together. It adds no table, no column and no schema bump — the whole event is
derived from records this world already writes — and it mints nothing: no NemoCoin, no account role,
no calling, no land, no moderator or reviewer authority.

## Changed files

| File | Change |
| --- | --- |
| `src/community.js` | The authored plan (`RESTORATION_PLAN`, roles, saved-fact vocabulary, policy), the derived census and progress, and the event routes' methods: `restoration` (read), `restorationOpen`, `restorationJoin`, `restorationLeave`, `restorationContribute`, plus `restorationEventRecord`, `restorationSite`, `restorationPhase`, `restorationParticipant`, `restorationCensus`, `restorationProgress`, `restorationFact`, `restorationFinish`, `restorationEventView`. |
| `src/spaces.js` | `restorationPlace`: the one planned write into another operator's garden, beside the shipped `build()` and under its own palette/bounds/occupancy/arrival/escape/cap rules. |
| `server.js` | Five write routes (`/restoration/open`, `/join`, `/leave`, `/contribute`, `/place`) and one public read (`GET /restoration`), plus the bounded object deltas published to the garden's event subscribers. |
| `app.js` | The **World restoration** navigation section and its panel: plan narrative, the bounded window, open/pledge/leave/take-the-resident-there controls, the four steps with their saved facts and measured progress, the planned tiles and their state, the participants with what they actually saved, and the policy line. |
| `scripts/browser-suite.mjs` | One new scenario, `cooperative-restoration-two-operators`: two browser contexts, two operators, a complete restoration, and a server restart. Imports `RESTORATION_PLAN` and `validateDatabase` so the scenario asserts the authored plan and the migrated database rather than a copy of them. |
| `tests/cooperative-events.test.js` | New: plan integrity, opening bounds, participation prerequisites, derived progress, dedupe, interruption/resume, completion, the restored garden after a restart, the closed window and the garden cap. |
| `tests/cooperative-http.test.js` | New: the routes over HTTP (public plan, human-only opening, scope and calling refusals, one-tile-once) and the interface regression (named render functions, no `innerHTML`). |
| `tests/browser-suite.test.js` | Scenario count 21 → 22 (registry only). |
| `docs/API.md`, `docs/PEACEFUL_WORLD.md`, this document | Documentation. |

No `src/database.js` or `src/recovery.js` change: the schema stays at **21**, `validateDatabase`
accepts exactly the versions it did before, and no migration or backup/restore format changed.

## Why the shared garden, and not a gathering space or a learning trail

I chose **restore a shared garden**, and deliberately not the other two shapes, for reasons inside
this codebase rather than taste:

- The storage layer already decides where a structure may stand: `world_objects` may hold the sealed
  **garden palette** in a `home`-kind world and the cottage palette in a `house`-kind world
  (`world_objects_build_guard`, `src/placement-policy.js`). A garden is therefore the one shared
  structure a resident can leave standing **without** touching land law, plot stewardship, plot
  collaboration grants or the frontier perimeter — and without inventing a new world kind, which the
  fixed 30-world directory in `tests/frontier.test.js`, `tests/world-platform.test.js` and
  `tests/local-launch.test.js` asserts against.
- The work that restores a garden is work the world already measures: a **saved object**, a **real
  sowing**, a **real craft**, and a **circle membership another operator keeps**. Those are the
  shipped calling sources (`calling_source_events`), so this event needed no new fact registry, no
  new "contribution" concept and no second credit scheme.
- "Repair an accessible gathering space" and "assemble a public learning trail" would both have had
  to place blocks in a shared world, and in this world shared building belongs to the frontier, which
  is plot-scoped by law (`frontier_blocks_plot_insert`). Bending that would have meant either a new
  land exemption or a plot grant wired into an event, i.e. real authority created for a cosmetic
  happening. The garden needs neither.

## The records it reuses, and why that is honest

| What the event needs | Where it lives | Why that is not a parallel scheme |
| --- | --- | --- |
| The occurrence and its bounded schedule | one `community_events` row with the deterministic id `restoration:<site world id>` | A gathering already is "a public place, a future window, a capacity and a cancellable status". It is announced on the community board, capacity-bounded, and cancellable through the shipped `POST /community/manage` path (creating operator or `admin`/`moderator`). |
| Explicit, revocable participation | one `community_rsvps` row per resident (primary key `(event_id, agent_id)`) | The shipped opt-in record. Pledging twice writes one row; leaving deletes it; the row's own `created_at` is the lower bound for what counts for that resident. |
| Progress | **derived**, per read: `world_objects` on the planned tiles, `journey_crops.planted_at`, `audit` `journey.crafted` rows, `community_members.joined_at` | Nothing is stored to be credited. The count *is* the saved row. |
| Who placed what | the append-only, hash-chained `audit` log (`restoration.placed`, `record_id` `event|agent|x,y|type`) | `world_objects` carries no author; the world's own tamper-evident log does, and `verifyAudit()` still holds. |
| Completion | `community_events.status = 'completed'` | The shipped status vocabulary already contains `completed` for events. |

The plan itself (four steps, their roles, their tiles and their saved-fact kinds) is **authored and
sealed in code**, like `BLUEPRINTS`, `SEED_QUESTS` and `PATHWAYS`: it is the event's design, not
per-installation data, so it needs no table.

## The plan, its measurable steps and its roles

Site: the garden of the convenor's own resident, which must already be **open to visitors**
(`homeSettings` visibility `public`). Window: 1–24 hours, default 24, stored in `starts_at`/`ends_at`.

| # | Step | Role | Callings | Completed by | Target | What it leaves standing |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Lay the gathering ground | Groundskeepers | Builder, Steward | placing the plan's own object on its own tile in the garden | 3 | `bench` 9,15 · `table` 11,15 · `bench` 13,15 (written by the participants) |
| 2 | Sow the shared beds | Growers | Cultivator, Artisan | a real `journey_crops` sowing in the grower's **own** garden, recorded after the pledge | 2 | `flowers` 9,18 · 10,18 · 11,18 (written when the last step finishes) |
| 3 | Light the gathering | Makers | Artisan, Cultivator | a real `journey.crafted` keepsake, crafted after the pledge | 2 | `lantern` 9,14 · 13,14 (written when the last step finishes) |
| 4 | Keep the garden open | Keepers | Host, Explorer, Mediator, Researcher | joining an active `community_circles` circle that **another operator** keeps | 1 | `sculpture` 11,14, the welcome stone (written when the last step finishes) |

Four steps, four **different kinds** of saved server fact, and every one of the eight callings can
answer at least one step. The steps also match the work each calling already does: a Builder places,
a Cultivator sows, an Artisan crafts, a Host or Explorer joins a neighbour's circle (their own
calling objective), and a Mediator or Researcher takes responsibility for keeping the place open
rather than only helping to build it. `tests/cooperative-events.test.js` asserts the whole plan:
distinct fact kind per step, distinct tile per plan, tiles inside a garden, walkable, clear of the
arrival and of both doorways, every type in the sealed garden palette, and full calling coverage.

## Interruption, resume and duplicate credit

There is no step receipt to duplicate: a step's progress is **read**, not incremented.

- **A repeat request cannot inflate anything.** `POST /restoration/contribute` writes no credit at
  all (`writes: 0`). A second call returns the same measured progress; the tests assert the
  `journey_crops`, `world_objects` and `audit` row counts are unchanged across the repeat.
- **A planned tile is filled once.** `world_objects` is `UNIQUE(world_id,x,y)`; a second placement on
  a filled planned tile is refused `409` and the object count is asserted unchanged.
- **A fact counts once, for one step.** Each step names one fact kind, so the same saved row cannot
  answer two steps, and the derived counts are grouped per resident — the "one saved fact, one
  credit" rule the calling objectives and quest steps already use.
- **Work done before joining never counts.** Every census query bounds by
  `MAX(participation.created_at, occurrence.starts_at)` … `ends_at`, so a planting made before the
  pledge is invisible to the event (asserted) and a craft made before it is ignored.
- **Interruption keeps the work.** A paused or revoked participant is refused (`403`), keeps every
  object already standing and every fact already saved, and contributes again after the operator
  resumes it — the tests drive pause → refusal → resume → next placement and assert the progress is
  `1 → 1 → 2`, never `3`.
- **Leaving and rejoining** withdraws the promise (one `community_rsvps` row deleted) and changes
  nothing else: the objects, sowings, crafts and memberships stay, the re-pledge is a fresh
  participation, and the counts neither reset nor double.
- **The window is the bound.** After `ends_at`, no new object and no new contribution is recorded
  (`409`), the work saved inside the window still stands, and the convenor may extend the same
  window (`starts_at` is kept, so earlier work keeps counting) or a moderator may cancel it.

## The persistent world artifact

The finished garden is nine real `world_objects` rows in the convenor's garden world, and six of them
are written **once**, by the server, in the same transaction that flips the occurrence to
`completed` (`UPDATE … WHERE status='scheduled'` is the guard, so only one caller can ever write
them). Before that, three of them were written by the participants themselves. The result:

- the objects are ordinary world content: the renderer draws them, `world()` returns them, and the
  world's own interaction panel reads a placed `bench` back as a usable fixture of that garden;
- they are visible to every visitor of the public garden, whether or not an operator is signed in;
- they survive the window closing, sign-out, and a **server process restart** — the browser scenario
  stops the server, starts it again on the same temporary database, and asserts the event still reads
  `completed` with all nine objects standing, and `validateDatabase()` still passes (schema 21).

## Promises are never counted as work

The event has exactly one kind of promise and it is labelled wherever it appears: **pledging**.
`policy.promise`, each participant's `promise` object and the interface's own line all state that a
pledge is a promise, `counted_as_work: false`. The tests assert that after all three residents of two
operators have pledged, **every step's progress is still zero, no object exists and nothing is
completed** — and that the unrelated `guests invited`-style counters do not move either: progress has
no writer other than a saved world fact.

## Budgets and permissions that still apply

| Rule | Where it comes from | How the event honours it |
| --- | --- | --- |
| Platform pause, active resident, active operator account | `Platform.active()`, `communityAgent()` | Every write route runs through them unchanged. |
| The occurrence is a community event | `communityQuota(agent,'community_events',10)` | Opening counts against the operator's active community-record budget, exactly as creating a gathering does (asserted with ten existing gatherings → `429`). |
| The shipped garden-visiting setting | `homeSettings` visibility | A private garden cannot be restored (409) and cannot be pledged into (403): the event never widens a garden's visibility. |
| Capacity | `community_events.capacity` (24 here, hard-bounded at 100) | The next pledge after the cap is `409`. |
| The plan is the area/block cap | `RESTORATION_PLAN` | The finished garden can never hold more than the nine authored objects, all inside the garden's own bounds; the garden's own **200-object cap** still refuses the 201st (asserted). |
| The world's mutation interval | `FRONTIER_LIMITS.action_interval_ms` (200 ms) | Applied to event placements and read from the account's last `restoration.placed` audit row (asserted `429`). The garden's shipped `build()` route carries no interval, so this is a **new application of an existing limit**, never a raised one. |
| Palette, walkability, arrival/doorway clearance, occupied tiles, no trapped resident | `build()`, `WORLD_OBJECT_GUARDS`, `trapsResident()` | The placement re-applies each one; the storage trigger is unchanged. |
| Runtime scope | `writes` route table | `/restoration/open` needs a human session; `/join`, `/leave`, `/contribute` need `contribute`; `/place` needs `build`, the same scope the shipped garden build route needs. |

An event contribution spends **no other budget of its own**: the sowings it measures already paid the
crop cap, the crafts already paid their ingredient check, and the circle membership already paid the
circle rules. Nothing in this task raises a limit, a reward, a capacity or a permission.

## What the event never grants

`coin_rewards`, `land_stewardships`, `frontier_blocks` and `resident_callings` are untouched by every
route here, and no route sets an account role. The tests assert that after a **complete** restoration
with three participants from two operators: zero coin receipts, zero stewardships, zero frontier
blocks, unchanged account roles, and an unchanged `resident_callings` table. The NemoCoin boundary is
untouched: participation and completion are cosmetic, and a coin still requires a separately reviewed
real mission contribution through the unchanged ledger in [COINS.md](COINS.md).

The one exception this task creates is stated plainly and narrowly: **while a restoration is open, an
active participant may place the plan's own object on the plan's own tile of the garden the garden's
own operator opened**, and nowhere else. It needs the `build` scope, the resident must stand within
one tile (the same adjacency direct interaction requires), the garden must still be public, the
window must still be open, and every shipped garden rule still applies. Nothing else — no other
object, no other tile, no other garden, no other operator's resident — can be written there.

## The two-operator browser walkthrough

`scripts/browser-suite.mjs` → `cooperative-restoration-two-operators` (run with
`LUCY_BROWSER_ONLY=cooperative-restoration-two-operators npm run browser`). Two isolated browser
contexts, two operators (`owner` and `stranger`), real temporary database, real server process:

1. the convenor opens its own garden to visitors, walks its resident home (recording the visit), and
   opens a 3-hour restoration through the panel — the stored row, its window and its convenor are
   asserted against the database;
2. a resident that has **not** walked into the garden clicks *Pledge to help* and reads the refusal;
   no participation row is written;
3. both operators pledge for real — the visitor is taken into the garden with the panel's own travel
   control — and the assertion is that three pledges across two operators move **no** step and write
   **no** object;
4. a wrong calling (`403`), a missing saved fact (`409`) and an unplanned tile (`409`) are refused
   through the pages' own sessions, and nothing is written;
5. the grower builds two crop patches at home, plants herbs and fiber through the interaction panel,
   records the sowing, and the beds step reads 2 of 2;
6. the maker enters the Maker's Workshop with a fixture placement (the walk is not what this step
   tests), crafts two real keepsakes at the crafting station, records them, and the light step reads
   2 of 2;
7. the other operator's resident creates a circle, the convenor's keeper joins it through the
   Community panel, records it, and the keep step reads 1 of 1;
8. the groundskeepers are refused once for standing too far from the measured tile, then walk with
   the panel's typed walk form and place the bench, the table and the bench; a repeat is refused and
   the objects are asserted one tile each;
9. the finished garden is asserted from three directions: the REST payload (`completed`, 9 standing,
   0 missing), the database (exactly the nine planned objects, one `restoration.completed` audit row,
   no coin, no land, no role, no frontier block), and the world's own interaction panel reading the
   placed bench back as a fixture of that garden;
10. the **server is stopped and started again** on the same database: the events still reads
    `completed`, all nine objects still stand, and `validateDatabase()` reports schema 21.

The scenario is order-independent by construction: it opens a **fresh operator session** for the
second operator and creates a **fresh resident** for it, because an earlier scenario in the suite
revokes every session token of that account and leaves the resident it used standing inside this very
garden. The walkthrough therefore never inherits another scenario's world state, and every control it
clicks is one its own page has just rendered.

Run logs and the exact numbers are in the delivery message; the scenario is also covered by
`tests/browser-suite.test.js` (registry) and `tests/cooperative-http.test.js` (routes and interface).

## API

| Request | Access | Purpose |
| --- | --- | --- |
| `GET /restoration?event_id=&world_id=&agent_id=` | Public (an `agent_id` needs a session) | The authored plan, up to 8 occurrences, and one occurrence in full with its derived progress, artifact and each participant's saved work. `404` for an unknown occurrence. |
| `POST /restoration/open` | Signed-in human session; the resident's own public garden | `{ "agent_id", "hours": 1–24 }`. Creates or extends the one occurrence for that garden. `403` for a runtime credential, `409` for a private garden, an open occurrence or an already completed one. |
| `POST /restoration/join` | Session or `contribute` runtime | `{ "agent_id", "event_id" }`. Requires an active resident, an open window, a place inside the capacity and a **recorded visit to the garden** — the resident has actually stood there. A repeat is a repeat. |
| `POST /restoration/leave` | Session or `contribute` runtime | `{ "agent_id", "event_id" }`. Withdraws the promise only. |
| `POST /restoration/contribute` | Session or `contribute` runtime, pledged, right calling | `{ "agent_id", "event_id", "step_id" }` for the sowing, craft and circle steps. Records the saved fact that answers the step, writes no credit of its own, and records the finished garden once when the last step is done. |
| `POST /restoration/place` | Session or `build` runtime, pledged, right calling | `{ "agent_id", "event_id", "x"?, "y"? }` for the ground step. Writes the plan's object on the plan's tile beside the resident. |

## Limitations and residual risks

- **One plan, one garden at a time.** A garden can hold one restoration; on completion the occurrence
  is recorded history and a second restoration of the same plan is refused rather than repeating
  finished work. Clearing the restored objects does not reopen it. A closed window can be extended.
- **The artifact lives in a garden, so it lives with that garden.** If the convenor's operator deletes
  its account, the garden and its objects go with it, exactly as every other garden does.
- **The convenor is a person.** The event needs one operator to open it on its own garden; it is not
  a world-wide scheduled festival, and nothing opens one automatically.
- **Two steps are measured by facts produced elsewhere** (the grower's own garden, a circle another
  operator keeps), so the artifact's beds and welcome stone are written by the server from those
  facts rather than by the participant's own hand. That is stated in the plan, in the panel and here.
- **The site's tiles are authored.** The plan's nine tiles are fixed; a participant cannot choose a
  tile, and an occupied planned tile would refuse the placement rather than relocate. Because only
  the event writes in the garden while it is open, this is a bounded, understood shape rather than a
  general placement tool.
- **Attribution of a placement comes from the audit log.** `world_objects` has no author column, so
  "who carried the bench" is read from the append-only `audit` rows; an operator who removes a placed
  object with the shipped `build()` route leaves the audit history claiming a placement that no
  longer stands. The artifact state and the history therefore differ in that one case, and the panel
  reports the standing objects, never the history count.
- **Fixture setup in tests.** Both the unit tests and the browser scenario grant crafting ingredients
  with a direct write, because a real harvest takes twenty minutes of server time. The craft itself,
  the placement, the sowing and every asserted effect are real server actions; only the resources are
  setup.
- **The browser scenario drives a real interface against a real server, with the timing dependence
  every scenario in that suite has.** It waits for the page to report each navigation, each control's
  own outcome and each loaded world before moving on (the class of race `docs/handoff/fix-browser-suite-flake.md`
  records), and it retries a section opener within bounds; it does not weaken any assertion to do so.
  Under extreme load a step could still fail honestly rather than pass quietly.
- **Not claimed:** no concurrent-players measurement, no production security assurance, no claim that
  a completed restoration is real-world impact of any kind.

## Migration and rollback

- **No migration.** The database schema stays at **21**; `src/database.js` still accepts `> 21` as
  unsupported, `src/recovery.js` still lists `1…21`, and a pre-change database opens, validates and
  round-trips through `backupDatabase`/`restoreDatabase` unchanged. No hard-coded version assertion in
  any test moved, because nothing moved.
- **Rollback** is reverting this branch: no table, no column, no trigger and no stored version was
  added, so an older build opens the same database. The database rows an event creates are ordinary
  `community_events`, `community_rsvps`, `world_objects`, `journey_crops`, `community_members` and
  `audit` records — an older build reads them as an ordinary gathering, ordinary RSVPs, ordinary
  garden objects and ordinary history, and ignores the `restoration.*` audit events.
- **Existing behaviour preserved:** the community board, the gatherings RSVP route, `build()`,
  `frontierBuild`, the calling objectives, quest steps and guild projects are untouched. A restoration
  occurrence appears on the community board as a gathering, exactly as its record implies.

## Verification

All gates were run on this branch, on the delivery tree, with `node-bin` Node v24.19.0. Exact output:

| Gate | Result |
| --- | --- |
| `npm run check` | exit 0 — all 31 files pass `node --check`. |
| `npm test` | `ℹ tests 578  ℹ pass 578  ℹ fail 0  ℹ skipped 0` (567 baseline + 10 in `tests/cooperative-events.test.js` + 1 in `tests/cooperative-http.test.js`). |
| `npm run e2e` | `SUMMARY  15 steps passed, 0 failed` / `result PASS — the shipped server serves this scenario end to end over its own HTTP API`. |
| `LUCY_BROWSER_ONLY=cooperative-restoration-two-operators npm run browser` | `SUMMARY  1 passed, 0 failed` / `PASS  cooperative-restoration-two-operators (24.0 s)` — the ten steps above, including the server restart. |
| `npm run browser` (all 22 scenarios) | `SUMMARY  22 passed, 0 failed` / `result PASS — the interface was driven in a real browser and the database agreed`, with the new scenario at 25.6 s. |
| `node scripts/seal-content.mjs --check` | exit 0 — `Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.` |

Anything that did not pass is stated in the delivery message rather than here.

# Task 17 — direct, purposeful world interaction

Branch `task-17-interaction`, base commit `8d3689b`
(`Merge branch 'task-20-country-venues' into verify-batch02-wave-b`). Database schema **18 — unchanged**;
no new dependency; `package.json` and `package-lock.json` are untouched.

A resident can now use the fixtures around it directly, from the 3D world and from the text list: a
**door**, a **crop patch**, a **bench**, a **crafting station** and a **country ambassador desk**. Every
one of them runs an action the world already owned — travel, the garden crop actions, posture, crafting,
the ambassador conversation — and the server remains the only authority. The client sends which tile and
which fixture action; it never sends an outcome.

## The interaction table

| Fixture | Recognised from | Action it runs (route) | Runtime scope | Distance | Refusals it can return |
| --- | --- | --- | --- | --- | --- |
| Door | an authored portal tile | `POST /api/v1/agents/:id/travel` | `move` | Manhattan ≤ 1, the same adjacency travel already requires for a doorway | 404 no fixture; 409 out of range / no doorway / blocked doorway; 403 a private garden |
| Crop patch | a `farm` object or authored farm tile | `POST /api/v1/journey/garden` (`plant`, `tend`, `harvest`) | `build` | ≤ 1 | 403 paused/revoked, 403 not the resident's own garden (the owner is named), 409 out of range, 409 a growing crop / still growing / already tended / already harvested / no growing crop, 429 twenty growing crops |
| Bench | a `bench` object or authored bench tile | `POST /api/v1/agents/:id/posture` (`sitting`) | `move` | ≤ 1 | 403 paused/revoked, 409 out of range, 400 unknown posture |
| Crafting station | a `workbench` | `POST /api/v1/journey/craft` | `build` | ≤ 1 | 403 paused/revoked, 403 scope, 409 out of range, 409 missing ingredients (each missing item is named), 400 unknown recipe |
| Country ambassador desk | an `npc_ambassadors` stand, or an `npc_mayors` guide stand (which uses the audited `/mayors/talk` alias) | `POST /api/v1/ambassadors/talk` | `chat` | ≤ 1 | 403 paused/revoked, 403 scope, 409 out of range, 404 a paused or missing ambassador, 429 the desk's own conversation throttle |

Shared refusals, applied before any action runs: **401** no credential, **404** another operator's
resident (a spectator can never act as someone else's character), **403** a paused or revoked resident,
**503** a paused platform. Each refusal keeps the status the world's own rule produced and adds `hint`
and `next_step`.

## Read first, then act

`GET /api/v1/interact?world_id=…&x=…&y=…&agent_id=…` reads a tile and writes nothing. It is readable by
a visitor, so an observer can examine a fixture without acting for anyone. It returns the fixture, the
action, the requirement, the measured distance, `blocked_by` and the readable hint; without coordinates
it returns the nearest fixtures and the acting resident's own next step.

`POST /api/v1/interact` requires the shipped `Idempotency-Key` header (1–100 characters) and body
`{ agent_id, x, y, action?, … }`.

## Keyboard and text equivalents — nothing is mouse-only

| Interaction | Text/keyboard path |
| --- | --- |
| Read a tile | The panel's `Tile X` / `Tile Y` fields and its `Read this tile` submit — the text path for a viewer who cannot click the canvas |
| Any fixture | The action control is a labelled `<button type="submit">` inside a form, so it is reachable by Tab and activated by Enter or Space |
| Use the aimed fixture | `Enter`, `Space` or `I` use the fixture the aim line names (`keyIntent` in `src/camera-controls.js`), when a fixture is picked and the view is not building |
| Approach a fixture that is out of reach | The `Approach the …` button walks the documented route to the nearest clear neighbouring tile |
| A bench | The labelled `Sit on the bench` submit |
| A crop patch | A `Crop patch action` select (plant herbs/fiber/wood, tend, harvest) plus the submit |
| A crafting station | A `Recipe` select listing each recipe, its ingredients and whether the resident already holds them |
| An ambassador desk | A typed question field; `Enter` on the desk focuses that field rather than guessing a question |

The aim line (`reticleText`) names the picked fixture, the action and the keys — or, when the fixture is
out of reach, the tile to stand beside. It stays plain text with no markup, and the panel's hint is a
`role="status"` / `aria-live="polite"` element that becomes a `role="alert"` when it reports a refusal.

## One click cannot issue duplicate writes

Three layers, in order:

1. **The click is single-flight.** `performInteraction` keeps one in-flight promise: a second click
   while a request is outstanding is coalesced into it and sends nothing.
2. **One gesture keeps one `Idempotency-Key`.** A repeat of the same intent inside a 700 ms window sends
   the *same* key, and the server replays the recorded response instead of acting twice. A genuinely new
   intent (a second keepsake on purpose) gets a fresh key and performs normally.
3. **The server replays a repeated key.** `POST /interact` keeps a bounded replay ledger
   (256 live keys per process, five-minute window) in the same header contract the shipped
   `/claims`, `/submissions`, `/drafts/resume`, `/tasks/follow-up` and `/quests/join` routes use: the
   same key returns the recorded response with `replay: true` and writes nothing, and the same key for a
   *different* intent is refused with 409. The world's own per-action throttles still apply on top
   (movement 120 ms, travel 120 ms, the ambassador's 1.5 s per-conversation pause, the garden rules).

## What each browser scenario asserts, and at what level

Five scenarios were added to `scripts/browser-suite.mjs` (registry 16 → 21). Every one drives the real
interface in the system Chrome build against a temporary database and reads the temporary SQLite file
after the action.

| Scenario | Driven in the browser | Asserted in the database |
| --- | --- | --- |
| `interaction-hint-and-distance` | The panel read tile 11,6 and named the door, the interaction, "Manhattan distance 1" and "1 tile away, so you can use it now"; then read the workshop door 43 tiles away, showed "out of reach" and the approach step, and the action control produced the server's own 409 and next step | `agents.world_id` unchanged by the refusal; the audit `world.entered` count unchanged |
| `interaction-saved-world-changes` | Built a crop patch in the resident's own garden, the panel reported "2 tiles away" and `Approach the crop patch` walked the resident beside it, then planted herbs; after a reload the panel described the growing crop and a rapid double click on tend added no second record; then built a bench and sat on it | `world_objects` rows for the patch and the bench; `journey_crops` kind/planted_at/tended_at/harvested_at and row count (1 after the double click); `agents.posture = 'sitting'` read again after the reload |
| `interaction-door-and-crafting` | Used the Meeting Hall doorway from the panel, reloaded and still saw the hall; returned through the hall's own doorway; used the Makers' Workshop door; crafted `flower_crown` with a double click on the crafting control | `agents.world_id` = `hall` then `workshop` across reloads; `journey_inventory` debited to herbs 2 / fiber 1 with exactly one `flower_crown`; `journey_profiles.crafts` = 1 after the double click |
| `interaction-ambassador-desk` | Entered the country venue with the resident, walked to the stand, read the desk hint, pressed Enter (focus moved to the question field), sent a question, then sent a rapid second one straight from the page | one `ambassador_conversations` row for the operator, naming the venue's own ambassador (the recorded run was `amb-AFG`), and none for the other operator; the rapid second question answered 429 and stored nothing |
| `interaction-state-refusals` | Paused and revoked residents were refused over the page with the state named; a visitor in another operator's garden read the patch (the hint named "Walker's garden" before the click) and the planting was refused; a spectator of the Meeting Hall read the door, was told "Inspection only", was offered no live control, and acting as the owner's resident answered 404 | `agents.world_id` unchanged in every refusal; `journey_crops` count unchanged for the visitor; the audit `world.entered` count unchanged by the spectator's inspection |

The two levels are deliberate: the *statuses* of the refusals are asserted by sending the same intent
from the loaded page (`inPage`, the browser's own session), because a disabled control cannot show a
status; the *behaviour* is asserted through the interface.

## Files changed

- `src/camera-controls.js` — `INTERACTION_DISTANCE` (1), `INTERACTION_KEYS` (`Enter`, `Space`, `I`),
  `isInteractionKey`, the `fixture` option of `keyIntent`, and the fixture line in `reticleText`.
- `src/spaces.js` — the interaction table, the fixture resolver, the readable hint and next step, the
  bounded replay ledger, and the `interactionView` (read) and `interact` (write) methods.
- `src/journey.js` — exported `cropAt`, so the passport, the workshop panel and the fixture hint read one
  planting through one implementation.
- `server.js` — the `GET /interact` and `POST /interact` routes (`/interact` added to `gets`, `writes`,
  the public-GET list and the idempotency-key list), and `hint`/`next_step` added to a refusal body only
  when a refusal carries them.
- `app.js` — the interaction panel and its in-place refresh, the read/approach/act flow, the
  single-flight keyed write, the keyboard intent, the aim-line fixture, and state resets on selection,
  travel, world change and sign-out.
- `scripts/browser-suite.mjs` — five scenarios, the registry entries, and the `travelTo`,
  `sendToCommons`, `placeResident`, `readInteractionTile` and `inPage(headers)` helpers.
- `tests/browser-suite.test.js` — the scenario count (21).
- `tests/interaction-controls.test.js`, `tests/interaction-http.test.js` — new.
- `docs/API.md`, `docs/VOXEL_WORLD.md`, this file.

## Migration and rollback

**The schema did not change.** No table, column, index, trigger, view or `PRAGMA user_version` value was
touched, and no stored record is rewritten: the interaction layer writes only through the actions that
already wrote before (travel, `journey_crops`, `journey_inventory`, `journey_profiles`, `agents.posture`,
`ambassador_conversations`, `audit`). An installation on schema 18 needs no migration; a rollback is a
checkout of the base commit, and nothing written by an interaction becomes unreadable, because every
record it writes is one the shipped actions already write. The only non-durable state is the in-process
replay ledger, which is empty again after a restart.

## Limitations and residual risks

- **The replay ledger is per process.** It honours the shipped `Idempotency-Key` contract and is bounded
  (256 keys, five minutes), but a process restart forgets it; the SQLite-backed keys on claims,
  submissions, drafts, follow-ups and enrolments remain the durable ones. A retry that crosses a restart
  could therefore repeat an interaction if it arrived with a *new* key. The click-level guarantees that
  matter for one click are the single-flight guard, the shared key inside one gesture, and the world's
  own per-action throttles and natural keys.
- **The distance rule is enforced on the interaction route only.** The older workshop panel still offers
  `plant`/`tend`/`harvest` for any crop patch in the resident's own garden, and the shipped acceptance
  harness (`npm run e2e`) uses that path deliberately; the direct interaction states and enforces the
  one-tile rule, and the two are described separately rather than pretending to be one.
- **Canvas picking is not exercised automatically.** The browser scenarios drive the interaction panel
  through its typed tile reader (the documented text equivalent), which also covers a viewer who cannot
  click the canvas. `pickWorld` reads the picked tile through the same route, and the module and HTTP
  tests cover the route itself, but a raycast pick → panel read was not automated; that path remains
  manually reviewed.
- **Two browser scenarios place a resident with a fixture write.** `interaction-door-and-crafting` writes
  the resident's tile twice (`placeResident`) because the workshop doorway is about forty tiles from the
  Commons arrival and a browser walk of that length costs minutes under tracing; the door use, the travel
  and the craft are still real interface and server actions, and the walk itself is covered in
  `interaction-saved-world-changes` (which uses the panel's own `Approach` control) and in
  `interaction-ambassador-desk`.
- **A crop harvest is not browser-tested.** The shortest plant-to-harvest time is 15 minutes of server
  time, so the planted crop is asserted through tend and the panel's growing-crop hint; harvest is
  covered at HTTP level (`tests/interaction-http.test.js` uses the fixture clock) and by the garden rules
  the route delegates to.
- **Ambassador guidance is unchanged.** A desk conversation is the shipped action; the interaction adds a
  distance rule and a hint, and never answers for the ambassador.
- **The one-tile reach is a product decision, not a physics result.** It is the adjacency travel already
  required for a doorway. Nothing about it implies a larger interaction radius, a line of sight, or any
  authority over a fixture another operator owns.

## Verification (actual output)

Delivered tree, frozen before the runs below. `export PATH="$PWD/../node-bin:$PATH"` (Node v24.19.0),
`npm install` run once in the worktree for the dev-only `playwright-core` (`package.json` unchanged).

```
$ npm run check
CHECK_EXIT=0            (every file the gate lists parses)

$ npm test
ℹ tests 511
ℹ pass 511
ℹ fail 0
ℹ skipped 0
TEST_EXIT=0             (baseline was 500; +11 = 8 tests/interaction-http.test.js + 3 tests/interaction-controls.test.js)

$ npm run e2e
SUMMARY  15 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API
E2E_EXIT=0

$ npm run browser
  browser           155.0.8059.40
  PASS  accounts-and-switching (3424 ms)
  PASS  credential-exclusion (1220 ms)
  PASS  private-draft-isolation (2141 ms)
  PASS  refresh-and-focus-restoration (723 ms)
  PASS  first-person-controls (3633 ms)
  PASS  country-ambassadors (678 ms)
  PASS  plot-and-blueprints (15866 ms)
  PASS  character-switch-clears-preview (3792 ms)
  PASS  quest-progression (22297 ms)
  PASS  guild-cooperation (2453 ms)
  PASS  reward-refusals (2536 ms)
  PASS  forged-coin-receipt-refused (480 ms)
  PASS  resident-run-resume-refusal (833 ms)
  PASS  shared-presence-two-clients (8368 ms)
  PASS  subscription-entitlement-and-revocation (1869 ms)
  PASS  interaction-hint-and-distance (1819 ms)
  PASS  interaction-saved-world-changes (5287 ms)
  PASS  interaction-door-and-crafting (4883 ms)
  PASS  interaction-ambassador-desk (25530 ms)
  PASS  interaction-state-refusals (6174 ms)
  PASS  signout-privacy (6540 ms)
  shipped database untouched
SUMMARY  21 passed, 0 failed
  result  PASS — the interface was driven in a real browser and the database agreed
```

Every scenario above passed in this run. `subscription-entitlement-and-revocation` (Task 16's
scenario, not this task's) is **flaky under load on this machine**: it failed in 3 of 6 full runs of
this tree with `timed out waiting for the visitor to hold a live subscription again` (its own 6-second
window for a re-subscription) and in 1 of 5 full runs of the untouched base commit `8d3689b`
(`/tmp/base-run-*.log`), while passing in the run above. Its assertions and its code were not changed by
this task. If it fails on a rerun, re-run the suite; the interaction scenarios above passed in every run
they were executed in.

## Reproducing

```
cd work/t17 && export PATH="$PWD/../node-bin:$PATH" && npm install
npm run check && npm test && npm run e2e && npm run browser
LUCY_BROWSER_ONLY=interaction-hint-and-distance,interaction-saved-world-changes,interaction-door-and-crafting,interaction-ambassador-desk,interaction-state-refusals npm run browser
LUCY_BROWSER_KEEP=1 npm run browser        # keep the workspace, database, traces and screenshots
```


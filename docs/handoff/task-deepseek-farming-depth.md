# DeepSeek slice — Farming and resident-life depth

Branch `task-deepseek-farming-depth`, based on `codex/final-integration` tip
`f773c46` (Bind native missions and chat to paired avatar).

Baseline on that tip: **884 tests**; the untouched tree was green on a repeat run (see *Residual
limits* 3 for the one environment-sensitive measurement test). After this slice: **889 tests, 889
pass, 0 fail** (`npm test`), `npm run check` green, `npm run e2e` 17 steps passed / 0 failed, and
`npm run browser` 38 of 39 scenarios passed in each valid full run with a load timeout on a different
unrelated scenario each time (see *Residual limits* 6). No schema change (still version 22), no sealed
content change, no new dependency.

## 1. Goal

Make the crop loop genuinely deep and honest instead of a stub: multi-stage growth on the server
clock, tending that measurably changes what a harvest is worth, a bounded and varying harvest
amount, propagation from a saved seed, and a peaceful tending cadence — with **no** hunger, death,
new currency or coins, and **every** state change derived from a saved server fact.

## 2. What changed and why

One production file (`src/journey.js`), the journey tests, and the peaceful-world document. No new
table, no new column, no new item kind, no new route and no change to the sealed content bundle.

### `src/journey.js` — the crop lifecycle

One planting is still three saved integers on one tile (`planted_at`, `tended_at`, `harvested_at`)
plus its `kind`. Everything else is now **derived** from those saved facts, the sealed crop rules and
the injected server clock, so a restart, a replay or a re-read cannot change any of it:

- **Sealed authority.** `cropRules` resolves `content.rules('crop')` once at load, so the growth
  time, the yield the ground returns, the garden's growing cap and the five minutes a tend may save
  all come from `content/crops/*.json` instead of being repeated in code (the previous revision
  hardcoded `2` for the yield and `20`/`five minutes` in SQL and messages). The garden now enforces
  `CROP_LIMITS.growing`, derived from the sealed `max_growing`, while the refusal sentence stays
  exactly as `src/spaces.js` expects it; `tests/resident-life-farm.test.js` pins the sealed cap and
  that sentence together.
- **`CROP_STAGES`** (`sprout`, `leafing`, `ripening`, `ready`), **`CROP_CARE`**, **`CROP_CARE_BONUS`**,
  **`CROP_LIMITS`** and a published **`CROP_POLICY`** describe the whole loop, so a panel or a test
  never invents its own vocabulary. `cropStage` divides the growth a crop *still has* (sealed growth
  minus the saving its own tend earned) into three equal bands; `cropView` publishes `stage`,
  `stage_index`, `stage_at`, `next_stage_at` and the unchanged `ready_at`/`ready`. Tending shortens
  the growth the bands divide, so a tend moves the crop on as well as shortening it.
- **`cropCare`** reads how carefully a crop was kept from the saved tend time alone: a tend inside
  the crop's own first third is `bountiful`, inside its first two thirds `careful`, later (or once
  the crop is ready) `late`; no tend is `plain`.
- **`cropYield`** returns the sealed `yield.quantity` as the floor, raised by the care bonus and
  never above that base plus the largest bonus (`min`/`max`/`base`/`bonus`/`quantity`). `gardenAction`
  credits exactly that amount, so the shelf always holds what the saved row explains. An untended
  crop still gathers exactly two resources, one time per planting.
- **Saved seed (`savedSeedFrom`).** A crop that was *tended and then gathered* leaves that bed sown
  for `CROP_LIMITS.saved_seed_window_ms` (one hour of server time). A second sowing of the same kind
  inside the window is recorded as cared for from the moment it goes in (`tended_at = planted_at`),
  so it keeps the five-minute saving and gathers with the care it was sown with; the action returns
  `from_saved_seed`. A crop nobody tended, a different kind, a fresh bed and a spent window all sow
  plainly. This is the seed → crop → seed cycle: no seed item is bought, held, sold or traded, and
  the only saved facts involved are the bed's own `tended_at` and `harvested_at`, read before the
  planting replaces the row.
- **`gardenView`** adds a bounded `garden` block to `GET /journey` (`beds`, `growing`, `ready`,
  `by_stage`, `by_care`, `next_stage_at`, `next_ready_at`, `saved_seed_beds`, `saved_seed`, `limits`),
  counted from the rows the passport already read — no extra query — so the tending cadence
  ("what changes next, what is ready, which bed still holds seed") is legible without a client change.
- The passport now reads the clock once (`now`) so its crops, garden summary and `server_time`
  describe the same moment.
- Every refusal string is **unchanged verbatim**: `src/spaces.js` maps those exact messages to their
  own next usable step, so rewording one would silently drop its hint. A comment in `gardenAction`
  records that contract.

### Not changed, and why

- **`src/vocations.js`** was inspected and deliberately left alone. Deepening Cultivator progression
  would mean a third calling objective, and two frozen tests pin the current shape: `tests/quests.test.js`
  (never-touch) asserts the exact cultivator receipt set `['cultivator.crop_plant','quest:quiet-harvest.first-sowing']`,
  and `tests/vocations.test.js` asserts `today.objectives.every(o => o.complete)` plus exactly ten
  experience. The existing wording is still true, so nothing needed rewording.
- **`world.js`** needed no crop/scene change: a crop's stage is per-resident server data, and the
  farm tile is drawn from `world_objects` by `app.js` (never-touch), which does not read crop state.
- **No sealed content change.** Adding a crop definition would break `tests/content.test.js`
  (`manifest().kinds` is pinned to `{crop: 3}` and every crop's `max_growing`/`yield.quantity` are
  asserted as 20 and 2), and that file is outside this slice's ownership, so the slice reuses the
  three existing kinds and re-seals nothing.

### `docs/PEACEFUL_WORLD.md`

The "Gardening and making" section now states the stages, the care tiers, the bounded varying
harvest, the saved-seed cycle and the explicit promise that no crop dies, rots or goes hungry.

## 3. What was tested

**`tests/resident-life-farm.test.js` — new, 5 tests**

1. *a crop walks named stages on the server clock, and the ready moment it publishes is the one a
   harvest checks* — all three kinds planted at one clock read; each names its own band and seals its
   own growth time; a schedule of eight clock advances asserts every crop's stage (herbs `leafing` at
   400 s, fiber at 500 s, wood at 600 s, herbs `ripening` at 800 s, … all `ready` at 20/25/30 min); a
   harvest is refused one millisecond before `ready_at`, a body cannot move the moment by sending
   `ready_at`/`planted_at`/`server_time`, and the same millisecond it passes the gather succeeds; a
   planting body cannot write `planted_at`, `tended_at` or `stage`.
2. *tending records care, moves the crop on, and measurably raises a bounded harvest that the saved
   row explains* — untended gathers exactly the sealed yield (shelf asserted); a tend at the start is
   `bountiful` (+2) and five minutes sooner and can only happen once; a tend inside the second third is
   `careful` (+1) **and moves the crop from `leafing` to `ripening`**; a late tend keeps its capped
   saving, is `late` and gathers the plain amount; the shelf after each gather equals the running sum;
   for every kind × care tier the derived quantity equals `base + bonus` and stays inside
   `[base, base + CROP_LIMITS.yield_bonus]`; the stored row alone reproduces the credited amount
   (`cropYield(stored).quantity === 3`); a gathered bed counts as no growing crop.
3. *a tended gather leaves saved seed, and a second sowing inside the hour carries the care it was
   sown with* — `savedSeedFrom` truth table (same kind, tended, inside the window); a tended gather
   exposes `seed = {kind, until: harvested_at + 1 h, spent: false}`; the re-sowing returns
   `from_saved_seed: true`, records `tended_at === planted_at`, reads `bountiful` and is ready in
   fifteen minutes; tending it again is refused because it is already cared for; the sow–gather–sow
   line keeps returning the bountiful amount; an untended crop leaves no viable seed; a different
   kind in the same bed sows plainly; an untouched bed sows plainly; after the window expires
   (`spent: true`) the bed sows plainly again.
4. *the garden summary is counted from the same saved rows, and the whole loop mints nothing at all* —
   `garden.beds`/`growing` equal the SQL counts; `by_stage`/`by_care` sum to `growing` and name
   `ripening ×2`, `bountiful ×1`, `plain ×1`; `next_stage_at`/`next_ready_at` equal the minima over
   the crops and lie ahead of the clock; `saved_seed_beds`/`saved_seed` name the gathered bed; every
   held inventory kind is a sealed crop or a sealed recipe output (no invented seed or coin item);
   `coin_rewards` for the resident is 0, `coins.balance`/`coins.issued` are 0, `verifyCoinLedger(db)`
   is true and `merit.total` is 0.
5. *every derived crop fact survives a real Platform reopen and follows the stored rows rather than a
   client* — a full sow/tend/gather/re-sow cycle, then `platform.close()` and a real
   `new Platform(f.database, f.clock)`; the reopened passport's `crops`, `garden` and `inventory`
   deep-equal the pre-close ones, the carried care survives (`bountiful`, ready in 15 min), no coin
   exists and the ledger still validates; advancing the clock past the seed window leaves the stored
   row byte-identical while the re-derived `stage` becomes `ready`, `garden.ready` becomes 1 and
   `saved_seed_beds` becomes 0.

**`tests/journey.test.js` — one test updated** (this file is in the slice's ownership). The core crop
test now asserts the tended harvest it performs: `care: 'bountiful'`, `gathered: {kind:'fiber',
quantity:4, base:2, care:'bountiful'}`, a shelf of four, and the same care and `ready` stage after the
restart. The previous expectation of two was the untended amount; the untended path is still asserted
to be exactly two, both here (the other harvest cases) and in `tests/resident-life-farm.test.js`. No
assertion was deleted, and no other expectation was loosened.

**Compatibility runs** (all green; the full suite in section 4 re-covered every one of them on the
final revision): `tests/expansion-http.test.js`
(untended herbs at +5 min and fiber at ready both still gather exactly two, and the craft arithmetic
behind them still balances), `tests/quests.test.js` + `tests/quests-http.test.js`,
`tests/cooperative-events.test.js`, `tests/vocations.test.js`, `tests/pathway.test.js`,
`tests/interaction-http.test.js`, `tests/interaction-prompt*.test.js`, `tests/inventory-exchange.test.js`,
`tests/coins.test.js`, `tests/content.test.js`.

## 4. Gate results

| Gate | Result |
| --- | --- |
| `npm run check` | green (every `node --check` target) |
| `npm test` | **889 tests, 889 pass, 0 fail, 0 skipped** in 384 s; a repeat of the same revision gave 888 pass / 1 fail in 354 s, the single failure being `tests/realtime-latency.test.js`, which also fails on the untouched base blob — see *Residual limits* 3 |
| `npm run e2e` | `SUMMARY 17 steps passed, 0 failed` plus `PASS cleanup`; the newcomer's practice step is still credited from one saved `crop_plant` fact with zero coins |
| `npm run browser` | 39 real Chrome scenarios; two valid full runs each recorded `SUMMARY 38 passed, 1 failed` with a **different** load-timeout failure each time, and each failing scenario passes alone on the same revision; the two crop scenarios passed in both runs — see *Residual limits* 6 |

The 889 counted tests are the 884 of the base plus the five new tests in
`tests/resident-life-farm.test.js`. No test was deleted, skipped or loosened.

## 5. Database assertions

Read through the platform's own API and its own SQLite handle against disposable temporary databases
only (`tests/helpers.js` fixtures; no installed database, backup or `outputs/Lucy` copy was touched):

- `journey_crops` — one row per tile; `planted_at` is the server clock and cannot be supplied by a
  body; `tended_at` is `NULL`, the tend time, or (for a sowing from saved seed) the sowing time
  itself; `harvested_at` is `NULL` until gathered; no stored column is ever rewritten by a read.
- `journey_inventory.quantity` — the delta after each gather equals `cropYield(stored row).quantity`.
- `coin_rewards WHERE agent_id=?` — 0 rows before and after a full loop and after a reopen;
  `verifyCoinLedger(db)` true; `journey().coins.balance`/`issued` are 0; `merit.total` is 0.
- `journey_profiles.harvests` — incremented once per harvested planting (unchanged).

## 6. Residual limits

1. **Two frozen client strings still say "two resources".** `src/spaces.js` (the crop-patch option
   and action labels, `'Harvest 2 resources'`) and `app.js` (the workshop panel's "Harvest gathered.
   Two resources added to your shelf." and the interaction result "two resources were added") are on
   the never-touch list, so they still describe an untended gather. The server's response is correct
   (`gathered.quantity`, `crop.care`, `crop.yield`), so a follow-up writer should read
   `crop.yield.quantity` there instead of hardcoding two. No test pins the strings, and both crop
   scenarios of the real Chrome suite (`interaction-saved-world-changes`,
   `game-hud-interaction-prompt-and-aim`) pass with them unchanged.
2. **`docs/API.md` was not updated.** It is outside this slice's document ownership, so its crop
   paragraph still reads "Each planting can be harvested once for two resources" and does not mention
   stages or saved seed. Suggested one-line replacement for the integrator, in
   `docs/API.md` §"Resident journey, garden and crafting": after "so the shortest planting-to-harvest
   time is 15min (a 20min herb tended at once)." insert "A crop publishes its `stage`
   (`sprout`/`leafing`/`ripening`/`ready`), its `care` (`plain`/`careful`/`bountiful`/`late`) and its
   `yield` (`base`/`bonus`/`quantity`/`min`/`max`), all re-derived from the saved planting, the saved
   tend and the server clock; a tended crop gathers the sealed two plus its care bonus, so the
   quantity is bounded by `base` and `base + 2`. A tended, gathered bed keeps saved seed for one hour
   of server time, and a second sowing of the same kind inside that hour is recorded as already
   tended (`from_saved_seed`)". `docs/handoff/task-17-interaction.md`'s crop-patch row is also
   unchanged and still accurate (409 for a growing crop / still growing / already tended / already
   harvested, 429 for twenty growing crops).
3. **One measurement test is environment-sensitive, not change-sensitive.** An earlier full
   `npm test` of this revision reported 889 tests with one failure: `tests/realtime-latency.test.js`
   (`measured update latency and frame rate on the loopback fixture`) asserted
   `every fixture client must be subscribed` and saw 1 of 16 subscriptions inside its fixed 200 ms
   window. It touches no journey or crop code — it opens sixteen SSE streams and measures frames from
   a recorded move. Control experiment on the same machine, same minute: restoring the **unmodified
   base blob** `git show f773c46:src/journey.js` and running
   `node --test tests/realtime-latency.test.js` produced **0 pass / 1 fail three times out of three**,
   and the first baseline run of the untouched tree also reported one failure in its 884 while the
   repeat run was green. The failure follows machine load (the same 884-test suite took 251 s, 522 s
   and 1236 s on three runs of the same code, and this slice's run took 384 s), so it is reported
   rather than papered over: the deadline and the concurrency are unchanged, and nothing in this slice
   was raised or loosened to make it pass. The full suite ran twice on this exact revision: **889/889
   green** in 384 s and **888/889** in 354 s with this same test the only failure.
4. **The band boundaries are only exact because the sealed growth times divide by three**
   (20/25/30 minutes → 400/500/600 s). `cropBand` uses `Math.ceil`, so a future sealed growth time
   that does not divide evenly still produces monotone bands, but the first and last band would then
   differ in length by less than a millisecond — the stage schedule, not the ready moment, is what
   that rounding touches.
5. **The new depth is not yet drawn.** The passport and the API publish the stage, care, yield and
   saved seed, and the runtime can read them from `GET /journey`, but no pixel or panel shows them:
   `app.js` (never-touch) draws one stage-free farm tile per world object, and
   `src/ui/inventory-panel.js` — which *is* live, since `app.js` mounts it and passes the whole
   journey payload — is outside this slice's ownership, so `inventoryModel` still lists a crop as only
   "growing" or "ready to harvest". Reading `journey.garden`/`crop.care`/`crop.stage`/`crop.seed`
   there is a small, purely additive follow-up for that file's owner.
6. **The browser gate could not be driven on a quiet machine.** Each full run of the 39 real Chrome
   scenarios on this host happened while another workload — `outputs/Lucy/.runtime` node processes
   belonging to a different slice, not this worktree — held the machine at three to fifteen times its
   core count (`uptime` load average between 28 and 134 across the runs). Two valid full runs each
   recorded `SUMMARY 38 passed, 1 failed`, with a **different** failing scenario each time:
   `guild-cooperation` ("the joining resident must be recorded", 21.9 s) and
   `restoration-two-clients` (`locator.click: Timeout 25000ms exceeded`). Both pass alone on the same
   revision (`LUCY_BROWSER_ONLY=guild-cooperation` → PASS 9 627 ms;
   `LUCY_BROWSER_ONLY=restoration-two-clients` → PASS 35 011 ms). A third full run was invalidated
   outright by the Chrome process dying under that load (`8 passed, 31 failed`, every later scenario
   reported "Target page, context or browser has been closed"). Neither failing scenario touches crop
   code, and both crop scenarios passed in both valid runs. No deadline, retry or concurrency bound
   was raised to change any of this.

## 7. Migration and rollback

- **No migration.** Schema version stays **22**; `journey_crops`, `journey_inventory` and
  `journey_profiles` keep their existing columns, constraints and triggers. Nothing was added to
  `src/database.js`, `src/recovery.js` or the sealer, and no sealed definition changed.
- **Every existing database stays readable.** The new fields are derived at read time, so a database
  written by the previous revision has no new state to migrate: its crops simply start reporting a
  stage, care and bounded yield from the planting and tend times they already hold. An untended
  planting keeps its exact previous behaviour (two resources, same ready moment).
- **Rollback** is reverting the commits: the only persisted difference the new code can introduce is
  a `tended_at` written at sowing time for a sowing from saved seed (read back by the old revision as
  an ordinary early tend — the same saving, no new column) and a harvest that credited two to four
  instead of always two. No record is rewritten, nothing is deleted, and no coin, land or permission
  is involved in either direction.

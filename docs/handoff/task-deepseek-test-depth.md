# Test depth — the transitions the browser suite never drove, and the waits that raced them

Branch `task-deepseek-test-depth`, worktree `work/w-test`, based on **`f773c46`**
(*Bind native missions and chat to paired avatar*), the `codex/final-integration`
tip.

This is a **test-only** slice. It changes two harnesses and three HTTP test
files and touches **no** product source: `server.js`, `app.js`, `world.js`,
`src/**`, styles, `native/**`, the schema, the content seal and `outputs/Lucy`
are untouched. The schema stays **22**.

## Goal

The handoff records that *“mature crop harvest and every quest/guild transition
were not browser-tested”*. This slice adds honest depth for exactly those
transitions at the levels that can drive them — the shipped HTTP API in process
(`node --test`) and the shipped server as a real child process (`npm run e2e`)
— and it makes the browser waits in four scenarios deterministic, only where a
failure was actually observed or a race was already disclosed.

## What was already covered, and is therefore not duplicated

| Transition | Already covered by | Where |
| --- | --- | --- |
| Crop growth, one tend, one harvest, restart persistence | `crops use server time, one bounded tending action, one harvest, and survive restart` | `tests/journey.test.js` (platform API) |
| HTTP `POST /journey/garden` harvest, one-time guarded update | `garden resources use server time, harvest only once and crafting spends inventory atomically` | `tests/expansion-http.test.js` |
| Plant/tend through a crop patch, another owner refused | `a crop patch in another resident’s garden is refused with the owner named` | `tests/interaction-http.test.js` |
| Full practice chain, daily limit, real evidence chain | `the practice chain completes end to end from saved facts only…`, `a real evidence chain still ends in an independent human acceptance…` | `tests/quests.test.js` (platform API) |
| Guild participation, pledges, independent verification, land/role/coin refusals | `tests/guilds.test.js` (platform API) and the first two tests of `tests/guilds-http.test.js` | both |

`tests/quests.test.js` was not edited at all. Where the browser suite already
covers a transition it was left alone: `quest-progression` authors, publishes,
enrols and advances one authored step; `first-ten-minutes` saves one practice
planting; `guild-cooperation` creates a public and a private project and joins
one; `interaction-saved-world-changes` plants and tends a crop and explicitly
never harvests it (*“the harvest itself takes twenty minutes of server time and
is not what this step tests”*).

## Changed files

| File | Change |
| --- | --- |
| `tests/journey-http.test.js` | **New.** Two tests: the mature-crop harvest over both routes a browser uses, and the next planting cycle on the same tile. |
| `tests/quests-http.test.js` | Two added tests: the shipped practice chain completed end to end over HTTP, and a real evidence chain completed only by an independent acceptance. Existing tests unchanged. |
| `tests/guilds-http.test.js` | Three added tests: the contribution rework after changes were requested, the project lifecycle with its plan bounds, and a runtime participant. Existing tests unchanged. |
| `scripts/e2e-smoke.mjs` | Three added steps (16–18); restoration/restart renumbered to 19–20; a temporary-database helper and the one documented time-compression write; two summary lines. |
| `scripts/browser-suite.mjs` | Five waits in four scenarios made deterministic. No assertion predicate, scenario, scenario order or timeout limit changed. |

## 1. The mature crop harvest — `tests/journey-http.test.js` (new)

The fixture clock is injected (`tests/helpers.js` `advance`), so a crop can be
ripened without waiting, and both routes a browser uses are driven:
`POST /journey/garden` and the crop patch of `POST /interact`.

**`a crop ripens on the server clock and one harvest is credited once through the garden and interaction routes`**

- Plant herbs: `ready === false`, `ready_at − planted_at === 20 min`
  (`journey_crops.kind='herbs'`, `harvested_at IS NULL`).
- The interaction read offers `tend` plus `harvest … available:false`, and the
  offered verb is `Tend the crop`.
- An early harvest is `409 This crop is still growing.` on **both** routes; the
  interaction refusal carries `next_step` “tend it once to shorten the wait”.
  Database after both refusals: `harvested_at IS NULL`, `journey_inventory`
  empty, `journey_profiles.harvests = 0`, no `calling_receipts` row,
  `audit WHERE event='journey.harvest'` count 0.
- One tend: `tended_at = clock`, `ready_at − planted_at = 15 min`; a second tend
  is `409 This crop has already been tended.`; the panel then offers only the
  waiting harvest.
- The maturity boundary on the served clock: at `ready_at − 1 ms` the harvest
  option is `available:false`, `GET /journey` reports `ready:false` and the
  route refuses; at `ready_at` the option is `available:true` and reads
  `Harvest 2 resources`.
- The harvest through `POST /interact` with one `Idempotency-Key`: `200`,
  `result.crop.harvested_at = clock`, `result.inventory = [{herbs: 2}]`; the
  database then holds `journey_crops.harvested_at = clock`,
  `journey_inventory(herbs, 2)`, `journey_profiles.harvests = 1` and exactly one
  `audit` row `journey.harvest`.
- The same key replays (`replay:true`) and writes nothing; a **new** key on the
  same tile is `409 There is no growing crop on this tile.` with a `next_step`
  naming the replant. Inventory stays `{herbs: 2}`, `harvests` stays 1, the audit
  count stays 1.
- `GET /callings`: receipts are exactly `cultivator.crop_harvest` and
  `cultivator.crop_plant`; the harvest receipt’s `source_kind='crop_harvest'` and
  its `source_id` is `<x>:<y>:<planted_at>` — the exact planting gathered.
  `today.earned = 10`, `remaining = 0`, `experience.cosmetic = true`.
  `GET /coins` balance 0, `coin_rewards` count 0. A second board read credits
  nothing.

**`a harvested tile carries a new planting with its own growth time, and gathered resources are not experience`**

- Cycle one (herbs, one tend) gathers two herbs.
- Re-planting the same tile stores a new `planted_at`, clears `tended_at` and
  publishes the **new** crop’s own growth time (30 min for wood), so at the
  earlier crop’s instant the tile is not ready and the harvest is refused; it
  becomes ready only after its own growth.
- The second harvest returns `[{herbs:2},{wood:2}]`, `harvests = 2`,
  `journey.harvest` audit count 2 — resources are not experience: `today.earned`
  stays 10 and the receipt count stays 2 while the day’s allowance is spent.
- One UTC day later `today.earned` is 0 and all-time `experience.earned` stays
  10: a fact recorded on a spent day is never credited later (the allowance is a
  window, not a bank). A third cycle on the new day earns its own 10 and its own
  two receipts. `coin_rewards` count 0 throughout.

## 2. Quest completion transitions — `tests/quests-http.test.js` (added)

**`the shipped practice chain completes over HTTP from a mature harvest and one craft, crediting each step once`**

- `POST /quests/join` (idempotency key) → one `quest_enrollments` row,
  `next_action.step_slug = 'first-sowing'`.
- Two HTTP plantings → step one `complete` with one saved fact;
  `calling_receipts` holds exactly `quest:quiet-harvest.first-sowing`
  (`source_kind='crop_plant'`, `points=5`); `today.earned = 5`.
- After a 25-minute clock advance, two HTTP harvests → step two `complete` from
  `quest:quiet-harvest.patient-tending` with `source_kind='crop_harvest'` and a
  `source_id` of the form `<x>:<y>:<planted_at>`; `next_action = 'keepsake'`.
- The day’s allowance is spent (`today.earned = 10`, `today.remaining = 0`), so
  the keepsake step stays `available` and the chain stays incomplete; a second
  board read credits nothing.
- Next UTC day: one HTTP craft (`flower_crown`) → all three steps `complete`,
  `progress[0].complete = true`, `next_action = null`;
  `calling_receipts` holds exactly three rows with `source_kind` `crop_plant`,
  `crop_harvest`, `craft`, every `points = 5`; `journey_profiles.crafts = 1`,
  `harvests = 2`.
- `coin_rewards` count 0, `GET /coins` balance 0; `POST /quests/complete` is
  `400` and writes nothing; `verifyQuestReceipts`, `verifyQuestStructure` and
  `verifyCallingReceipts` all return `true` against the database the HTTP path
  wrote.

**`a real evidence chain advances over HTTP only when a different operator accepts the sourced work`**

- A reviewer authors and publishes an `evidence_research` chain; the
  administrator’s resident joins it. The runtime credential (scopes
  `read`+`contribute`) claims the open task: step one `complete` from
  `quest:sourced-harvest.claim-a-task` (`research_claim`), and `next_action` is
  the review boundary with `requires_human_review: true`.
- An HTTP submission is `pending_review`; the contributor’s **own** operator is
  refused `403 An operator cannot review their own or their agents’
  contributions.`; `reviews` count stays 0, `coin_rewards` count stays 0 and the
  step does not move.
- A different authorized operator accepts it: `coin_reward.amount = 10`, the
  chain completes, the acceptance’s saved fact is `available: true`, and
  `coin_rewards` count is 1 with `GET /coins` balance 10. Re-reading the board
  credits nothing twice and both receipt verifiers return `true`.

## 3. Guild project transitions — `tests/guilds-http.test.js` (added)

**`a guild contribution is reworked after changes are requested, and only an unsubmitted pledge can be withdrawn`**

- Two-workstream project: `planned_workstreams = 2`,
  `all_workstreams_verified = false`, the creating resident is the organiser.
- `changes_requested`: `guild_contributions.status` and the stored `review_note`
  are written, `verified_by_account_id IS NULL` and `verified_at IS NULL`; the
  payload reads `completed:false`, `verified:false`, `claims:1`,
  `verified_contributions:0`, `verified_workstreams:0`.
- Re-approving a claim that is not awaiting verification is `409`.
- Re-submitting from `changes_requested` is allowed, clears the note and keeps the
  outcome unverified; the independent approval then stores
  `verified_by_account_id`, with `verified_workstreams = 1` and
  `all_workstreams_verified = false`.
- A verified workstream refuses `pledge`, `submit` **and** `withdraw` with `409`;
  a pledge on the second workstream can be withdrawn, leaving exactly one
  `guild_contributions` row and no commitments. No `coin_rewards` row, no
  `land_stewardships` row, `verifyGuildRecords` true.

**`a guild project closes and reopens for contributions, shares once, archives, and bounds its plan`**

- Empty plan, seven workstreams, a repeated id and a missing output name are all
  `400` and leave the `guild_projects` count unchanged; an unknown workstream is
  `404`.
- A private project is `404` for another operator; `share` returns
  `shared:true`, a second `share` returns `shared:false`, and the stored
  `visibility` is `public`.
- While **closed**: a new join is `409`, a new pledge is `409`, and withdrawing a
  standing pledge is still `200`. `reopen` returns the plan to `open` and a
  pledge is accepted again.
- `archive`: the project is `404` to read (signed in or not), `404` to join and
  absent from `GET /guilds`, while `guild_projects.status = 'archived'` stays
  stored with both participants. `verifyGuildRecords` true.

**`a runtime resident participates in a guild project with the contribute scope and nothing more`**

- A `read`-only runtime is refused (`403`) and writes no participant row; a
  `read`+`contribute` runtime joins, pledges and submits **for its own bound
  resident** without naming an `agent_id`.
- The contributing runtime cannot verify its own resident’s work
  (`403 A different operator must verify this contribution.`); a runtime of a
  third operator approves it and `all_workstreams_verified` becomes true.
- `coin_rewards` 0, `calling_receipts` for that resident 0, no
  `land_stewardships`, `verifyGuildRecords` true.

## 4. New E2E steps — `scripts/e2e-smoke.mjs`

Steps 16–18 are inserted after the newcomer’s practice activity; the existing
restoration and restart steps become 19 and 20, so restart persistence still
runs last and the run still ends with the same teardown checks.

- **16 — the practice crop ripens on the server clock and its harvest answers the
  second step once.** The resident *walks* beside the crop patch over the shipped
  movement route. An early harvest through `POST /interact` is `409 … still
  growing` and stores nothing. The harness then reads the crop’s own growth time
  from `GET /journey` and **moves its own disposable row’s stored planting time
  back** by that growth plus a second (the one direct database write in the
  harness; it is announced in the run notes). The server’s readiness rule then
  reports the crop ready and the harvest is one `200` with two herbs,
  replay-safe, with a second click refused. `GET /quests` shows
  `quest:quiet-harvest.patient-tending` complete from a `crop_harvest` fact and
  the keepsake step still waiting because the day’s ten cosmetic points are spent
  (`GET /callings`), with `GET /coins` at 0.
- **17 — a guild contribution is reworked after changes are requested.** Private
  plan shared once (`shared:false` on the second share); pledge → submit → `403`
  self and creator verification → `409` re-verification → `changes_requested`
  (note kept, nothing verified) → resubmitted → verified by a third operator
  (`all_workstreams_verified:false`, one of two workstreams); a verified
  workstream refuses pledge/submit/withdraw; the second pledge is withdrawn; one
  `guild_contributions` row remains and the wallet is 0.
- **18 — the plan closes, reopens and archives, and its bounds are enforced.**
  Empty/seven/duplicate-id/missing-output plans are `400` with the project count
  unchanged; an unknown workstream is `404`; a closed plan refuses a join and a
  pledge but still allows a withdrawal; `reopen` allows a pledge again; `archive`
  makes it unreadable, unlistable and unjoinable while the row stays stored; no
  stewardship is granted.

## 5. The browser suite: five waits made deterministic

All in `scripts/browser-suite.mjs`. Every assertion predicate, message, scenario,
scenario order and timeout limit is unchanged; no timeout was raised.

1. **`guild-cooperation` → “another operator sees the public project and not the
   private one”.** *Observed failure:* `a public guild project must be listed for
   everyone`, with `#view` still holding the entry screen. The step read `#view`
   immediately after the tab click, while the client’s own enter-and-refresh
   render was still in flight. It now waits for the board text itself and
   re-opens the section within bounds.
2. **`guild-cooperation` → “the second operator joins the public project”.**
   *Observed failure:* `the joining resident must be recorded`, with only the
   organiser among the participants. The wait was “any participant exists”,
   which the organiser already satisfied before the click’s write landed. It now
   waits for the joining resident’s own `guild_participants` row.
3. **`interaction-ambassador-desk` → “the question is stored as a private
   conversation turn”.** *Observed failure:* `the desk must store exactly one
   turn` (expected 2, actual 1). The wait was “a newest turn exists”, which the
   earlier `country-ambassadors` scenario already satisfied. It now waits for a
   genuine count increase — the same fix pattern the first-ten-minutes handoff
   records for its phone step.
4. **`subscription-entitlement-and-revocation` → “making the garden private
   closes the outsider’s subscription”.** The residual flake this branch’s
   handoffs disclose (*“expecting a `garden is now private` notice and observing
   the server’s own `This garden is private.`”*). The step sampled the live
   `#notice` element, which holds one message, so a later notice could overwrite
   the sentence the client wrote. It now records every notice from before the
   visibility change (a `MutationObserver` into a test-only
   `window.__noticeHistory`) and waits for a match in that history. The regex and
   the assertion are unchanged; the failure evidence now carries the whole
   history.
5. **`first-ten-minutes` → “a paused resident receives an announced refusal”.** A
   fixed `await page.waitForTimeout(1000); // let the concurrent first-play read
   land before the next render` was replaced by a wait for the client’s own
   render: after the HTTP read confirms the server reports
   `blocked=resident_unavailable`, the step waits until the guide card carries
   `[data-guide="blocked"]`. The sleep is gone and the assertions that follow
   still discriminate (a shown action must be `disabled` **and**
   `aria-disabled="true"`, the alert must be `role=alert`/`aria-live=assertive`,
   and a disabled action must be absent from the tab order). This is the only
   fixed sleep removed; the step’s companion `readFirstPlay` read is unchanged.

**A speculative change was measured and dropped.** A global rewrite of
`openTab`/`openSectionNamed` (waiting for the page’s own section signal instead
of a 250 ms sample) was tried, and then reverted: the shared machine could not
provide a clean full-suite comparison, and the scenario used to gauge it
(`cooperative-restoration-two-operators`) failed with the rewrite and without it
(see §7), while the local waits above were enough. Only the local,
failure-backed waits were kept.

## 6. Gates (real numbers)

Node v24.15.0 (`.nvmrc`, `engines >=24`), disposable databases, on the shared
build host described in §7.

`npm run check` — exit 0 (every listed file passes `node --check`).

`npm test` — **891 passed, 0 failed, 0 skipped** (884 baseline + 7 new tests):

```
ℹ tests 891
ℹ pass 891
ℹ fail 0
ℹ skipped 0
```

`npm run e2e` — **20 steps passed, 0 failed** (17 baseline steps + 3 new). The
crop step’s own note:

```
PASS  16. the practice crop ripens on the server clock and its harvest answers the second step once
        planted 4,7 refused while growing (409), ripened by moving the stored planting time back 1200000 ms, then harvested once (two herbs, replay-safe, a second click refused); quest:quiet-harvest.patient-tending complete from crop_harvest; keepsake still waiting; 10 of 10 cosmetic points spent today; 0 coins  (538 ms)
...
SUMMARY  20 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API
```

`npm run browser` — **39 passed, 0 failed** (the complete suite, every scenario):

```
SUMMARY  39 passed, 0 failed
  PASS  guild-cooperation (4021 ms)
  PASS  subscription-entitlement-and-revocation (6953 ms)
  PASS  interaction-ambassador-desk (26108 ms)
  PASS  cooperative-restoration-two-operators (60251 ms)
  PASS  first-ten-minutes (30038 ms)
  result  PASS — the interface was driven in a real browser and the database agreed
```

## 7. Browser evidence in detail

Three full-suite attempts were made on a host shared with several other agents
that were running this same Chrome suite; the load average is quoted for each.

| Run | Load average | Result |
| --- | --- | --- |
| 1 | ≈ 35 | 27 passed, **12 failed**, exit 137. The Chrome process was closed at scenario 28 and every later scenario failed in milliseconds with `Target page, context or browser has been closed`. An invalid run. |
| 2 | 34–41 | 29 passed, **10 failed**: 8 × `page.goto`/`page.reload`/`locator.click`/`locator.waitFor` timeouts of 20–25 s and one aborted `/auth/login`, plus the two test-logic races fixed here (`guild-cooperation`, `interaction-ambassador-desk`). |
| 3 | 54–126 | **39 passed, 0 failed** — the committed tree, complete suite. |

**Focused runs (the decisive evidence for this slice).**

```
LUCY_BROWSER_ONLY=guild-cooperation,interaction-ambassador-desk,subscription-entitlement-and-revocation,first-ten-minutes npm run browser
SUMMARY  4 passed, 0 failed
  PASS  guild-cooperation (16957 ms)
  PASS  subscription-entitlement-and-revocation (13179 ms)
  PASS  interaction-ambassador-desk (31283 ms)
  PASS  first-ten-minutes (69610 ms)
```

This run was taken at load average **110** — the four scenarios that this slice
edits were green even at a load that made the whole-suite runs fail.

**The failures in runs 1 and 2 are not caused by this slice.** No failing
scenario failed inside a changed line; the stack traces sit at `openGameTab`,
`page.goto`, `page.reload` and `waitForText` of untouched scenarios, and run 3
(taken at a similar load, with every change committed) passed the same scenarios
that had failed. To check the one scenario that failed repeatedly, `cooperative-restoration-two-operators`
was run alone:

- on this tree at load ≈ 40 and ≈ 33: it failed at `openRestoration`’s 20 s panel
  wait;
- with the whole browser-suite change reverted (`git stash`) at load ≈ 30: it
  **passed** (30454 ms and 44360 ms in two runs);
- with the change reverted at load ≈ 34: it failed again, at a later step
  (`the walk to 11, 14 stopped short`, 131606 ms);
- on the committed tree in run 3: it **passed** (60251 ms).

That is a scenario with inherent load sensitivity on this host, in the class the
suite’s own handoff already discloses; it neither failed inside nor was fixed by
this slice.

## 8. Product observations (reported, not fixed — `src/**` is out of scope)

1. **A harvested fact is only credited while the harvested row is still the
   tile’s stored row.** `calling_source_events` derives `crop_harvest` from
   `journey_crops … WHERE harvested_at IS NOT NULL`, and re-planting the same
   tile (`ON CONFLICT(agent_id,x,y) DO UPDATE`) clears `harvested_at` and
   rewrites `planted_at`. A resident that harvests and re-plants the same tile
   **before** the next `/callings` or `/quests` read therefore never receives the
   `crop_harvest` receipt or its 5 points. Nothing about permissions, land or
   coins is affected. Verified with a throwaway probe against the shipped code:

   ```
   plant herbs → advance 20 min → harvest → plant wood (with no board read in between)
   receipts after replant-then-read: [["cultivator.crop_plant","crop_plant"]] today 5
   ```

   The client itself refreshes after an action, so the window is narrow. No test
   asserts the current behaviour as correct: a test that pinned the expected
   behaviour would have to fail today, so the observation is recorded instead.
2. **A world read of a garden that has just become private surfaces the server’s
   own sentence** (`403 This garden is private.`), which a generic client notice
   path can print verbatim. It is an honest refusal; the browser step in §5.4 now
   tolerates either sentence in the recorded history, but a client that
   translated every refusal through one path without redaction would make the two
   states indistinguishable to the user. `app.js` was not touched.

## 9. Residual limits

- **The e2e crop step compresses time, and says so.** It moves its own disposable
  `journey_crops.planted_at` back by the crop’s growth time instead of waiting
  twenty minutes. The server’s maturity rule still evaluates the new value
  against its own clock, and the refusal *before* the move is asserted through
  the real route, so both the guard and the transition are proved. The run notes
  name the exact row and delta.
- **The third step of the shipped practice chain cannot be completed inside one
  e2e run**, because the planting and the harvest spend the day’s ten cosmetic
  points and the harness cannot move the server’s clock. Step 16 proves steps
  one→two and the limit holding; the full three-step completion is proved in
  `tests/quests-http.test.js` with the injected clock.
- **The browser suite still cannot grow a real crop.** The scenario set is fixed
  for this slice and a browser cannot move the server clock, so the mature
  harvest is asserted at the HTTP/process level only.
- **The browser suite remains inherently timing-dependent on a busy host.** Two
  earlier whole-suite runs on this shared machine failed only with Playwright
  page-load, reload, click and wait timeouts of 20–25 s, and one Chrome process
  was closed outright; the third, on the same committed tree, passed 39/39. §7
  records all three runs and the focused runs, so the difference between them can
  be judged rather than assumed. The suite still paces documented server
  throttles with fixed sleeps, and no timeout was raised anywhere.
- **The notice recorder observes only what the page writes.** If the client ever
  wrote no notice at all when a feed is revoked, §5.4 would still fail honestly.
- **Fixed sleeps remain elsewhere in the suite** (server throttle pacing: 120 ms
  movement, 200 ms building, 1500 ms messaging). They pace documented limits and
  were left alone.
- The counts quoted in `HANDOFF.md` (840 tests, 17 HTTP steps, 38 browser
  scenarios) and `docs/VERIFICATION.md` were already stale on this base (the
  suite is 884 tests, the e2e harness 17 steps, the browser suite 39 scenarios).
  Those files are outside this slice’s ownership and were left to the integrator.

## 10. Migration and rollback

No schema change and no migration. The only writes anywhere are to disposable
temporary databases (`mkdtemp`), removed in the same run; `data/`, backups,
`.runtime/`, `outputs/Lucy` and any installed copy are untouched. Rollback is
`git revert` of this branch’s single commit: it restores the 17-step e2e harness,
the original browser waits and the previous test set, and affects no product
file, account, database, backup or installed copy.

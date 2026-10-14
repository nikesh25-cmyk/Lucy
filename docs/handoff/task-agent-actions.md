# More things an AI resident can do: five new bounded runtime actions

Branch `task-agent-actions`, base `codex/final-integration` at `1de1de3`, one commit on top:
*Add five bounded resident actions and observe their targets*. Focused patch:
`patches/task-agent-actions.patch`, produced by `git format-patch -1 --stdout`, eight files. The commit
SHA and the patch size are reported alongside this handoff rather than inside it, because amending
this file changes both.

## Goal

Give the reference local runtime a meaningful, bounded and safe set of **new** actions, so a resident
has more to do than move, speak and tend its garden. Five were added, each server-authoritative,
scope-checked, bounded, replay-safe, refusal-honest and coin-free:

| Action | Scope | What it does | Route |
| --- | --- | --- | --- |
| `{"action":"inspect","x":int,"y":int}` | `read` | Reads one observed fixture tile and receives the server's own description of it. | `GET /interact` (existing) |
| `{"action":"survey"}` | `read` | Reads the fixtures the observation shows nearby, with their actions and distances. | `GET /interact` (existing) |
| `{"action":"sit","x":int,"y":int}` | `move` | Sits on an observed bench the resident already stands on or beside. | `POST /interact` (existing) |
| `{"action":"offer","recipient_agent_id":…,"kind":…,"quantity":…,"note":…}` | `contribute` | Offers the resident's own grown or crafted resources to one observed neighbouring resident of a **different** operator. | `POST /journey/offers` (existing) |
| `{"action":"guild","project_id":…,"intent":"join"\|"leave"}` | `contribute` | Joins or leaves an observed guild project. | `POST /guilds/participation` (existing) |

**No new server route was added.** Four existing routes carry all five actions. Two reads ride inside
existing routes:

- the **guild board** a resident may join rides inside the resident's own contribute-scoped
  `/callings` read, exactly as its bounded memory and the mission directory already do, so it adds no
  credential charge and can only ever describe that resident's own view;
- a runtime's own `/world` read carries one extra derived **boolean** per visible resident,
  `different_operator`, so an offer to a same-operator sibling can be declined locally instead of
  being sent to a route the server must refuse. It is a boolean, never an identity: every resident of
  another operator reads `true`, so a runtime learns only which visible residents are its own
  operator's — information about its own account.

### Candidates deliberately not taken

- **`mark`** — a personal navigation note the runtime keeps in its own memory. The brief also requires
  every new action to be *server-authoritative*, and a model-authored local note is by construction
  neither world state nor server-owned. It was left out rather than shipped as an exception to the
  rule it was listed under. The useful half of the idea was kept in server-owned form: the one
  **`sighting`** the runtime carries forward from `inspect`/`survey` is the *server's* reading, names
  the world and the decision that asked for it, and is dropped the moment the resident changes world.
- **`guild` `pause`/`resume`** — the world supports them, but "join or leave" is the bounded set the
  candidate named, and a pause/resume pair adds a state the prompt would have to explain for no
  additional cooperative act.

## Files changed

| File | Change |
| --- | --- |
| `runtime/agent.js` | `ACTION_LIMITS`; `OFFER_KINDS`; fixture helpers (`observedFixtureTiles`, `observedFixtureAt`, `observedFixtures`); `boundedSighting`; five `parseAction` branches; five `authorizeAction` rules; conditional prompt sentences and the `fixtures`, `guilds`, `sighting` observation sections; pruning rules for the new lists; the five dispatch lines; the sighting carried between decisions. |
| `server.js` | The runtime's own `/callings` read is extended with the bounded guild board (no new route); a runtime's own `/world` read gains the derived `different_operator` boolean. |
| `src/platform.js` | `Platform#guildObservation(actor, options)` — the bounded board, reusing `guilds()` for the visibility rule; `Platform#differentOperatorView(actor, participants)` — the derived boolean. `GUILD_OBSERVATION_LIMIT = 5`. |
| `tests/agent-actions.test.js` | New. Parsing, scope refusals, unobserved-target refusals, prompt advertisement, the sighting. 7 tests. |
| `tests/agent-actions-runtime.test.js` | New. Every action driven against the shipped server over HTTP: route, body, deterministic key, database rows, no coin, restart. 11 tests. |
| `docs/RUNTIME.md` | The action table, the four-read budget, the guild board, the `different_operator` boolean, the new test files. |
| `docs/API.md` | The runtime-only `different_operator` field on `/world`; the guild board on the runtime's `/callings` read; the runtime's use of `/interact`, `/journey/offers` and `/guilds/participation`. |

No file on the NEVER TOUCH list was opened for writing. No schema change: the database stays at
**version 23** and no migration is needed.

## Design notes

- **Refusal before dispatch.** `authorizeAction` is an advisory pre-filter and the server stays
  authoritative, so it is allowed to refuse more than the server and never less. Every new rule is
  decided from the observation alone: a fixture tile must be one the observation shows within the
  radius the world's own read lists nearby fixtures within (6 tiles), a bench must be at the
  adjacency the world's own write requires (Manhattan 1), an offer recipient must be an observed
  active neighbour the server marked as a different operator's **and** the resource must be on the
  resident's observed shelf, and a guild project must be on the observed board in the direction that
  changes participation. A refused action stops the run before any request is made.
- **Advertised only when usable.** The prompt does not decide from a hand-written condition: for each
  new action it builds a real candidate from the observation and asks the *same* `authorizeAction`
  rule that would approve the dispatch (the pattern `callingActionPriorities` already uses). A prompt
  sentence therefore cannot promise an action the observation would refuse.
- **Replay safety.** `offer` uses the runtime's deterministic `Idempotency-Key` and the shipped route
  stores it on the offer row, so a retry after a restart returns the recorded offer and escrows
  nothing twice. `sit` uses `POST /interact`, whose own replay ledger returns the recorded outcome for
  a repeated key, and is in any case a single-row posture update. `guild` is one row per
  (project, resident) and joining again is a no-op. `inspect` and `survey` write nothing at all.
- **Coin-free.** No new path writes to `coin_rewards` or the coin ledger; every test asserts
  `coin_rewards` stays empty.

## What was tested

### `tests/agent-actions.test.js` (7 tests, no server)

- `each new action parses to exactly one bounded shape` — the five shapes, plus a trimmed note.
- `a new action cannot smuggle an identity, a price, a coin path or an extra field` — 22 malformed or
  smuggling payloads refused at parse time (`agent_id`, `posture`, `role`, `coins`, `price`, an
  unknown resource kind, quantity `0` and `100`, an over-long note, a projectile URL where an
  identifier is required, a third tile coordinate rule, `survey` with a field).
- `every new action is refused without the scope it needs` — each refused with the empty, `move`-only
  and `read+move+chat` scope sets, each approved exactly once its own scope is granted.
- `a fixture, a resident or a project the observation does not show is refused before anything is
  sent` — unobserved tile, a fixture one step beyond the nearby radius, sitting with no observed
  bench, sitting two tiles from a bench, `survey` with no observed fixture, an absent recipient, a
  same-operator recipient, a paused recipient, more than the shelf holds, a kind not on the shelf, a
  sibling's passport, an unobserved project, a closed project, an already-joined project, leaving a
  project the resident is not in, and a sibling's guild identity.
- `the prompt advertises each new action only when the observation makes it usable` — all five
  advertised when usable; none advertised for a barren observation; `sit`, `offer` and `guild` absent
  without their scopes; `offer` absent towards a same-operator neighbour; the `fixtures` and `guilds`
  sections carry no contribution history and no participant list; and the advertisement for each
  action is checked against `authorizeAction` itself.
- `the prompt carries one bounded server reading and drops a reading of another world`.
- `a reading is never a model note` — a sighting does not make an unobserved tile inspectable or a
  distant bench sittable.

### `tests/agent-actions-runtime.test.js` (11 tests, shipped server over HTTP)

Alive world: alice's own public garden with a real bench built through `POST /agents/:id/build` that
she stands beside, bob's character visiting it as a different operator's resident, four herbs on
alice's shelf and one open guild project bob's operator created.

- `inspect and survey …` — exactly two `GET /interact` requests, with the query
  `world_id=<garden>&x=11&y=10` then `world_id=<garden>`, no bodies, `sighting.source === 'inspect'`
  with `world_id`, `decision: 1` and `fixture.action.id === 'posture'` in the **next** prompt; and no
  world object, message, offer, participation or coin written. Database assertions:
  `world_objects=1`, `messages=0`, `resource_offers=0`, `guild_participants=0`, `coin_rewards=0`.
- `sit …` — one `POST /interact` with body `{agent_id, x: 11, y: 10, action: 'posture'}`, key equal to
  `writeKey('run-sit', 1, 'sit', …)`, `agents.posture = 'sitting'`, one `world_objects` row, no coin.
  A direct replay with the same `Idempotency-Key` returns `replay: true` and writes nothing.
- `sit is refused when the observation shows no bench beside the resident` — the run fails, zero
  requests reach `/interact`, posture stays `standing`.
- `offer …` — one `POST /journey/offers` with `{recipient_agent_id, items: {herbs: 2}, note}`, the key
  equal to `writeKey('run-offer', 1, 'offer', …)` and equal to the row's stored `propose_key`;
  `resource_offers` has exactly one `proposed` row with those items and those two parties; the shelf
  moves from 4 to 2 herbs; one `resource_offer_events` row; `coin_rewards=0`. The prompt assertion
  also pins that the neighbour carries `different_operator: true` and **no** `operator_id`.
- `an offer to a same-operator resident, an unobserved neighbour or more than the shelf holds is
  refused before it is sent` — four runs fail with `action_count 0`, zero `/journey/offers` requests,
  `resource_offers=0` and the shelf still at 4.
- `guild joins and leaves …` — one `POST /guilds/participation` for join then one for leave;
  `guild_participants` is one row with `role='member'` after the join and zero rows after the leave;
  the project itself survives; `guild_contributions=0`, `calling_receipts=0`, `land_stewardships=0`,
  `coin_rewards=0`; the calling id is unchanged by the join. A direct second join with a new key
  returns 200 and adds no row.
- `a project the resident already belongs to cannot be joined twice …` — the second join fails with
  the run stopped, `guild_participants` stays at two, and only one request ever reached the route.
- `every new write is refused without its own scope and none of them is sent` — a `read+move` runtime
  cannot offer or join and sends nothing; a `read`-only runtime can still read and is told so.
- `a tile with no observed fixture, and a guild board the read did not carry, stop the run before a
  request` — zero `/interact` and zero `/guilds/participation` requests.
- `a restart replays the same deterministic offer key and duplicates nothing` — the server is closed
  and the database reopened in a fresh `Platform` (same file, same clock); one offer row and two herbs
  survive; `verifyAudit()` is true; a fresh server plus `runAgent` with the **same** `runId` produces
  the same key, the retried write is still one confirmed action, and the offer count, the shelf and
  `resource_offer_events` are all unchanged.
- `repeating the single-row writes after a restart changes no state` — after a restart, replaying
  `sit` succeeds, replaying `guild` join is refused locally with nothing sent, and replaying `inspect`
  succeeds; `world_objects`, `guild_participants`, `agents` and the stored posture are identical,
  `messages=0`, `resource_offers=0`, `coin_rewards=0`, `verifyAudit()` is true.

## Gate output (real numbers)

Run on the tip of `task-agent-actions` (base `1de1de3`), Node v22.23.1, on a host whose load average
was **190–230** while three other agents worked in parallel. Both results of the first, flaky suite
run are reported.

### `npm run check`

```
checked 92 files, 0 failed
```

### `npm test`

**Run 1 (piped through `tail -25`, so the failing test name was not retained):**

```
# tests 1007
# pass 1006
# fail 1
# cancelled 0
# skipped 0
# duration_ms 672675.897833
```

The one failure appeared nowhere in the retained 25 lines, so it was not the last test and could not
be identified afterwards. **Three focused re-runs of every suite this change can reach all passed:**
`runtime-policy`, `interaction-http`, `interaction-prompt-http`, `interaction-prompt`,
`interaction-controls`, `callings-http`, `calling-runtime`, `world-platform`, `world-public-fields`,
`guilds-http`, `exchange-http`, `inventory-exchange` (**77 tests, 77 pass, 0 fail**), and the three
load-sensitive realtime suites twice (**23 tests, 23 pass, 0 fail** each run).

**Run 2 (full, unfiltered, complete TAP captured, host load average 190–230):**

```
# tests 1007
# pass 1007
# fail 0
# cancelled 0
# skipped 0
```

**Run 3 (the committed tip, nothing else running, host load average 12.8):**

```
# tests 1007
# pass 1007
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 98727.521709
```

Two of the three full runs are clean; the one failure in run 1 could not be identified because the
output was piped through `tail`, and no focused re-run of any suite this change can reach reproduced
it. No test was skipped, none was reported as a pass while skipped, and no limit or timeout was
raised.

### `npm run e2e`

```
PASS  cleanup: server stopped, process lock released, temporary workspace removed
SUMMARY  20 steps passed, 0 failed
  result           PASS — the shipped server serves this scenario end to end over its own HTTP API
```

Exit code 0.

### `npm run browser`

This change is **not browser-visible**: `app.js`, every stylesheet and every client module are
untouched, and the two response fields it adds (`different_operator` on `/world` and `guilds` on
`/callings`) are attached to a **runtime** credential only, which no browser session holds. The suite
was run anyway, three times, on a host shared with other agents.

**Run 1 — host load average 190–230.** 30 scenarios passed in order, then Chrome died inside
`wave-b-two-gates` (`locator.click: Target page, context or browser has been closed`), and every
scenario after it failed with the same closed-browser error: a browser crash, not a scenario result.

```
  PASS  hero-introduction-film … PASS  shared-build-and-restart   (30 scenarios)
  FAIL  wave-b-two-gates (204342 ms) — locator.click: Target page, context or browser has been closed
  FAIL  cooperative-restoration-two-operators … signout-privacy  (15 cascaded closed-browser failures)
  result  FAIL — see the failing scenario above
```

Focused re-run of the crashed scenario, same tree, load 58:

```
SUMMARY  1 passed, 0 failed
  PASS  wave-b-two-gates (128875 ms)
  result  PASS — the interface was driven in a real browser and the database agreed
```

**Run 2 — host load average 34–65.** A different set failed, and every one of them is a timing
assertion, not a database disagreement:

```
SUMMARY  38 passed, 7 failed
  FAIL  guild-cooperation — locator.click: Timeout 25000ms exceeded (Create guild project)
  FAIL  game-hud-interaction-prompt-and-aim — locator.waitFor: Timeout 25000ms exceeded (#game-hud)
  FAIL  next-passage-cue — locator.waitFor: Timeout 25000ms exceeded (#game-hud)
  FAIL  hud-visible-while-building — the entry screen never owned the door after the reload
  FAIL  review-states-and-refusals — timed out waiting for the wallet to show the held coin
  FAIL  live-observation-readonly — private conversation must not enter the observer view model
  FAIL  restoration-two-clients — locator.fill: Timeout 25000ms exceeded
```

Focused re-run of exactly those seven on the same tree:

```
SUMMARY  6 passed, 1 failed
  PASS  guild-cooperation (13932 ms)
  PASS  game-hud-interaction-prompt-and-aim (4069 ms)
  PASS  next-passage-cue (14456 ms)
  PASS  hud-visible-while-building (7054 ms)
  PASS  review-states-and-refusals (11712 ms)
  PASS  live-observation-readonly (8732 ms)
  FAIL  restoration-two-clients — locator.waitFor: Timeout 25000ms exceeded
```

Because that last one failed twice, it was measured directly, in isolation, on both trees:

| Tree | Runs | Result |
| --- | --- | --- |
| This branch | 3 | `PASS` 11111 ms, `PASS` 14821 ms, `PASS` 15692 ms |
| Base `1de1de3` (`git archive` into a temporary directory, untouched) | 4 | `PASS` 10684 ms, 9301 ms, 10607 ms, 12101 ms |

It also passed inside browser run 1 on this branch, so the count against it is one failure in five
full or focused runs, all of them loaded. The suite is order- and load-sensitive on this host;
`docs/handoff/fix-browser-suite-flake.md` already documents that class of flake.

**Run 3 — host load average 12.79.** The same tree, the whole suite, nothing else running:

```
SUMMARY  45 passed, 0 failed
  PASS  hero-introduction-film … PASS  signout-privacy   (all 45 scenarios)
  result  PASS
```

Exit code 0.

**Conclusion.** The suite passes end to end on this tree when the host is not saturated by the other
agents, and every scenario that failed in a loaded run passes in isolation. The base passes the one
scenario that failed twice in isolation too, four times out of four. Nothing here is attributable to
this change, and the change is not browser-visible to begin with.

## Residual limits

- **The runtime is advisory, the world is authoritative.** Each rule above can refuse an action the
  server would have accepted (documented and pinned by `tests/runtime-policy.test.js` — refusing more
  is the safe direction). A stronger local check is never a claim that the server decided anything.
- **`sit` uses the world's interaction read, not a bench registry the runtime owns.** The set of
  observed fixture tiles is what `/world` happened to show: authored scenery is returned only inside
  the 20 × 14 camera window and saved objects are returned whole. A bench outside the window is a real
  bench the runtime will not offer, and the model can reach it only by walking closer and re-observing.
- **The nearby radius is the runtime's own bound for `inspect`.** The server's read has no distance
  limit for a single tile, so the runtime declines a distant tile the server would describe. Six tiles
  is the radius the server itself lists nearby fixtures within, so the two agree where it matters.
- **`inspect`/`survey` cost one extra charged API call when chosen.** No session budget, limit or
  timeout was raised; a run that spends its budget on readings stops early with
  `credential_budget_exhausted`, exactly as before. The documentation now states the honest count
  (four reads per decision, plus one when the model reads a fixture).
- **`different_operator` is a new field on a runtime's `/world` response.** It is a boolean derived
  from the authenticated account, and the whole point of it is that it is *not* an identity. A client
  reading it learns nothing but which of the residents it can already see belong to the account it is
  already authenticated as.
- **`survey` reads fixtures, not residents.** The route it reuses (`GET /interact`) is the world's own
  fixture read, so its "nearby" list is doors, crop patches, benches, crafting stations and civic
  desks. Nearby *residents* are already in every decision's own `/world` observation, so no second
  read of them was invented.
- **The guild board is capped at five projects** for a runtime read (`guilds()` for a human client
  keeps its own 1–24 page bound). A resident that must join the sixth-oldest project cannot see it;
  the cap is stated in the docs and asserted by the tests.
- **`guild` exposes `join` and `leave` only.** `pause`/`resume` remain operator or independent-API
  actions.
- **The interaction replay ledger lives in the process.** A `sit` retried after a *restart* with the
  same key is not recognised as a replay, but it is a single-row posture update, so the second write
  sets the same value and duplicates nothing. The offer's key is durable in SQLite and is the one
  write whose replay is proven across a restart.
- **No live model was run.** The tests drive a scripted model function; the prompt-side changes are
  covered by direct assertions on the generated prompt, not by an observed conversation with a real
  local model.

## Migration and rollback

- **Migration:** none. No table, column, index, trigger or `PRAGMA user_version` changed; the schema
  stays at version 23 and an existing database opens unchanged.
- **Rollback:** revert the merge of this branch (or `git revert` the single commit). Nothing was
  written to persistent state by the change itself, so a rollback needs no data repair. Worlds that
  already exist are untouched. The only stored artefacts an operator could have produced with the new
  actions are ordinary rows the world already owned — `resource_offers` (with their escrow and
  events), `guild_participants`, `agents.posture` — every one of which remains valid, readable and
  replay-safe under the previous code.

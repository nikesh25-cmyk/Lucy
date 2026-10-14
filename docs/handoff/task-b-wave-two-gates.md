# Task B — the Wave B two-gate crossing scenario

Wave B's acceptance sentence asks two independent humans and one active AI to enter, navigate the
Commons and a country venue, **cross at least two connected frontier gates**, converse through saved
attributed text, choose a calling, perform varied cooperative actions, see a visible world change, and
leave and return after a restart to the same place and purpose.

Most of that sentence already had a scenario. Nothing crossed a **frontier gate**. This change adds one
browser scenario, `wave-b-two-gates`, that covers the crossing and the parts of the sentence that were
unproved, and deliberately re-proves none of the others.

- Base commit: `4e0a901` (`Stop the cultivator daily-cap test depending on the wall clock`) on
  `integration/deepseek-master-2026-10-14`
- Files changed: `scripts/browser-suite.mjs`, `tests/browser-suite.test.js` (scenario count 42 → 43),
  and this file. `app.js`, `server.js`, `src/**`, `index.html`, the stylesheets, `native/**`, every
  other test, `package.json`, `HANDOFF.md`, `docs/VERIFICATION.md` and `outputs/Lucy` are untouched.
- `docs/specs/world-hud.md` was **not** edited: this scenario establishes no HUD fact (it asserts no
  HUD line at all — see "Limitations").
- No test was deleted, skipped or weakened. The only change in `tests/browser-suite.test.js` is the
  asserted scenario count (42 → 43) in the registry test.
- Patch: `git format-patch` to `../task-b-wave-two-gates.patch`.

## What the scenario drives

Two operators are created by the scenario itself (`wave-b-host@browser.test`,
`wave-b-guest@browser.test`) with one **human avatar** each, plus one **AI resident** owned by the
host. The three sectors are the seeded centre of the finite frontier (`src/frontier.js` opens
`frontier:-1..1:-1..1` at seed), so no land has to be opened and no plot, block or garden is touched:

| # | step | driven by |
|---|---|---|
| 1 | the two humans **walk the Commons** to its Shared Frontier passage at `19,6` and travel through it in their own browsers; the AI resident walks the same passage (9 documented steps) and travels with its **runtime credential** | two browser contexts + one runtime credential |
| 2 | the host operator **records the AI resident's purpose** in *Callings & guilds* and the resident reads it back | the operator's own browser form |
| 3 | the host walks 23 tiles to the **up gate `[24,1]`** of `frontier:0:0` and crosses into `frontier:0:-1` | browser movement control |
| 4 | the guest walks to the same tile and crosses the same gate | browser movement control |
| 5 | the AI resident crosses that gate **both ways**: forward, back onto the tile it left, and forward again | runtime credential, `POST /api/v1/move` |
| 6 | the host walks 44 tiles across the second sector to the **right gate `[46,24]`** and crosses into `frontier:1:-1` | browser movement control |
| 7 | the guest walks the same 44 tiles and crosses the same gate | browser movement control |
| 8 | the AI resident walks the same route and crosses the same gate | runtime credential |
| 9 | the guest sends a **private line to the host** through the conversation card of the sector they crossed into; the AI resident sends its own line through its credential; the recipient reads both from its own browser; a third operator reads the same sector over `GET /world` | browser form + runtime credential + `GET /world` |
| 10 | the server is **stopped and started again** against the same temporary database; all three residents, both browsers and the purpose record are re-read | `stopServer()` / `startServer()` |

Which movement control carries which world direction is **measured, not assumed**
(`learnMovementControls`): the client's movement controls are camera-relative whenever the browser is
in first person, so one confirmed step names its own control, the client's control cycle names the
other three, a **second** measured control checks the derived map, and both measured steps are undone
immediately. `next-passage-cue` uses the same cycle argument; here it is checked before it is trusted
with a crossing. Only the server's own `429` movement refusal is ever resumed (`throttleRefusal`), a
bounded number of times, and each resume is printed and counted — the same rule `walkResidentTo` and
`enterFrontierAs` already follow. Neither full run needed a single resume.

## Every database assertion

Every claim is read from the temporary SQLite file or from the server's own payload. The DOM is never
the authority.

| claim | read from |
|---|---|
| all three residents start in the Commons at `10,6` | `agents` |
| each entry is a real travel, not a position: one `world.entered` audit row per operator (two for the host: its human **and** its AI) | `audit` (`actor`, `record_id`) |
| the three stand in `frontier:0:0` on the sector's own start `24,24` and are `active` | `agents` |
| both browsers hold that one sector as a freshly read payload containing **two humans and one agent** | `window.__nemoworld.world()` after a reload (the read-only hook reports only the payload the page renders) |
| the purpose is the operator's own recorded fact (`purpose` / `intent`), origin `operator`, source `human`, `decided_by` = the host account | `resident_memory` |
| the AI resident can read its own purpose | `GET /api/v1/memory` with the runtime credential |
| the crossing precondition: the resident stands **on the exact gate tile** in the sector it is leaving | `agents.world_id/x/y` |
| the crossing itself: `world_id` becomes the neighbour's, and the arrival tile is the gate that neighbour answers with (`[24,46]`, then `[1,24]`) | `agents.world_id/x/y` |
| the crossing is the server's own recorded entry of that sector, exactly once per operator | `audit` count |
| the AI's steps were charged to **its own credential** (37 charged calls by the end of step 5, ~83 by the end of the journey, against the server's own 500-call session bound) | `tokens.used_calls` for `kind='runtime'` |
| both saved lines: sender `agent_id`, `account_id`, `channel='private'`, `world_id='frontier:1:-1'`, `status='visible'`, `recipients` exactly the two crossing partners, exact text | `messages` |
| the recipient operator reads both lines in the sector it crossed into | the recipient browser's own payload |
| a third operator reads the same sector (`200`) and sees **neither** line; the only two rows in that sector are the two private ones | `GET /api/v1/world?world_id=frontier:1:-1` with `stranger@browser.test`, plus `messages` |
| after the restart: the same `world_id` **and** the same tile for all three residents | `agents` |
| after the restart: the purpose row is byte-for-byte identical, and the resident still reads it through the same credential | `resident_memory`, `GET /memory` |
| after the restart: both saved lines are still addressable in that sector, and both browsers load the sector again | `messages`, `window.__nemoworld.world()` |

The **arrival tile** deserves a note. The brief says "the arrival tile is the new sector's start". The
server's rule (`src/spaces.js`, `travel()`) places a resident crossing a frontier gate on the **gate
the entered sector answers the sector it left with** — `[24,46]` entering `frontier:0:-1` from the
south, `[1,24]` entering `frontier:1:-1` from the west — not on `definition.start` (`24,24`, the
plaza). The scenario therefore asserts the tile the server actually implements, in the strongest form
available: the AI resident crosses the same gate forward, back and forward again, and the scenario
asserts the same landing each time (`24,46`, back to `24,1`, again `24,46`), so the arrival is a rule
rather than an accident. The wording difference is recorded here rather than papered over.

## Labelled substitutes

- **The AI is a runtime credential, not a model.** `npm run browser` boots the shipped server with no
  model configured (`GET /health` → `model_configured:false`), so "one active AI" here is an AI
  resident acting through its own scoped runtime credential on the documented HTTP routes, with the
  route planned by the suite through the shipped `planWalk`. Everything the server enforces is real —
  the credential, the `move`/`chat` scopes, the 120 ms throttle, the charge on the session's call
  budget, the crossing rule and the arrival — but **each step is scripted by the scenario, not chosen
  by a model**. This is the same substitution `shared-build-and-restart` already makes for building
  (`scripts/browser-suite.mjs`, comment at its `runtime` call). A model-driven crossing would need
  `LUCY_MODEL_*` credentials and a resident-run worker; neither is available in this environment, so
  the AI's *navigation* is exercised and its *decision-making* is not.
- **"Purpose" is a `resident_memory` `purpose/intent` fact.** That is the only purpose-bearing record
  this world stores for a resident; there is no separate goal/objective record. It is recorded through
  the operator's own interface (not through an API fixture) and read back by the resident through its
  own credential, before and after the restart.
- **"Leave and return" is the world leaving and returning.** The server process is really stopped and
  started against the same temporary database, and both browsers return by loading the sector again;
  the residents do not walk out of the sector and back (that would be another ~44 tiles each way, per
  resident, with no additional claim to prove).
- **The third-party read** uses the suite's own `stranger@browser.test` operator — never a party to the
  thread — rather than a new visitor account.
- **Everything else is a real action**: two browsers walking and pressing movement controls, one
  operator using the real memory form, the real travel rule through the Commons passage, the real
  crossing rule, the real message route, and a real process restart.

## Reused rather than re-proved

- `actor()`/`context()` per-operator browser contexts, `ensureAccount`, `signIn`, `openApp`, `settle`,
  `openTab`, `openSectionNamed`, `selectResident`, `openWorldAs`, `browserShows`, `waitForClient`,
  `walkResidentTo` (with its `throttleRefusal` resume), `enterFrontierAs` (walks the resident to a
  passage and travels through it, resuming only the documented throttle refusal), `travelTo`,
  `planWalk`, `apiExpect`/`apiRequest`, `stopServer`/`startServer`, and the read-only
  `window.__nemoworld` hook.
- **`shared-build-and-restart`** already proves two humans plus a scoped AI runtime building together,
  exchanging an item and surviving a restart. This scenario builds nothing and exchanges nothing.
- **`shared-presence-two-clients`** already proves two browser clients seeing each other move and
  build, a private message reaching only its recipient after a DOM-driven send, and the character
  profile's direct-message path. Here the thread is one private exchange in the crossed-into sector.
- **`restoration-two-clients`** and **`cooperative-restoration-two-operators`** already prove a
  cooperative world change and its persistence. Nothing is restored here.
- **`first-ten-minutes`** already proves a chosen calling; **`country-ambassadors`** and
  **`interaction-ambassador-desk`** already prove the country-venue half of the sentence;
  **`first-play-solo-ambassador`** already walks a newcomer through the Commons to an ambassador.
- The status, status-count and registry guarantees of the suite are untouched: temporary database,
  production-database refusal, teardown on failure, traces and screenshots on failure, non-zero exit on
  any fail or skip.

## What Wave B's acceptance still lacks after this

Being specific, because the brief's sentence is one claim and no single scenario drives all of it:

- **A country venue visited by the same party.** Wave B wants "the Commons *and* a country venue". The
  Commons half is now exercised end to end (both humans and the AI walk it and enter the frontier
  through its passage, with the entry in `audit`). The country-venue half is covered *elsewhere* and
  never by the same party: `country-ambassadors` (directory, profile, conversation, country mismatch),
  `interaction-ambassador-desk` (a desk answering through the interaction action) and
  `first-play-solo-ambassador` (a newcomer meeting one). No scenario walks these two humans into a
  country venue.
- **A chosen calling, by these residents.** Not proved here: this scenario never opens a calling
  chooser; the AI resident keeps its default (`explorer`). Covered by `first-ten-minutes`.
- **Varied cooperative actions and a visible world change, by this party.** Not proved here. The only
  world change this scenario produces is the crossing itself (a stored `world_id` and the server's
  arrival tile) plus two saved messages; it plants nothing, crafts nothing, builds nothing and finishes
  no shared plan. Covered by `shared-build-and-restart` (two humans + AI build, item exchange),
  `cooperative-restoration-two-operators` and `restoration-two-clients` (a shared garden changes and
  survives a restart). "Varied", in the sense of several different cooperative actions in one run,
  remains split across those scenarios rather than gathered into one.
- **Restart persistence of the *whole* Wave B state.** This scenario proves the place and the purpose
  survive; `shared-build-and-restart` proves built blocks, a grant and an inventory survive. No single
  restart re-reads everything the brief lists together.
- **The remaining three gates of the seeded sector** are not crossed here: the scenario uses the `up`
  gate `[24,1]` and the `right` gate `[46,24]`. `down`/`left` and every non-adjacent gate are covered
  only by the unit-level tests (`tests/frontier.test.js`, `tests/passage-reachability.test.js`,
  `tests/world-navigation.test.js`).
- **An observer's view of a crossing.** No scenario watches a gate crossing from a second client's
  payload as it happens (this one asserts the party's own payload after a reload, and the other
  client's payload for movement in `shared-presence-two-clients`).

## Limitations

- **Load sensitivity, inherited.** The scenario is the longest walk in the suite: two browsers walk 23
  and 44 tiles, and the AI walks 76 documented steps. On a heavily loaded machine a browser walk is
  slow and the server's own 120 ms throttle can refuse a step; only that documented refusal is resumed
  (bounded, counted, printed), and a walk stopped by anything else fails loudly with the notice and the
  stored row. `LUCY_BROWSER_ONLY=wave-b-two-gates npm run browser` re-runs it alone.
- **Cost added to the suite:** about 51 s of scenario time and one extra server restart (the suite
  already restarts twice).
- **New accounts, new characters, new rows.** The scenario creates two member accounts and three
  characters, six audit rows, one `resident_memory` fact and two `messages` rows, and leaves the three
  residents standing in `frontier:1:-1`, which no other scenario reads. No shared fixture resident,
  garden, plot, block, grant or setting is touched, and the platform is never paused. Two full suite
  runs after the change show no other scenario moved — but the list of what it leaves behind is honest
  here rather than assumed harmless.
- **The host account keeps one live runtime session** (20 minutes) so the resident can read its purpose
  after the restart. It belongs to an account no other scenario uses, so the one-session-per-operator
  rule cannot refuse a later scenario's session; the credential is otherwise left to expire.
- **No pixels are asserted.** The scenario makes no claim about the HUD, the aim line, the nameplate or
  the renderer; the read-only hook is used only for the server's payload. `docs/specs/world-hud.md` is
  therefore unchanged. The view used is the workspace presentation (`?mode=workspace`), not the game
  shell HUD.
- **The purpose-check is exact but the fact is small.** `resident_memory` rows are compared with
  `describe()` equality; two runs prove it. A future migration that rewrites `updated_at` on read would
  break that comparison — which is the intended failure, since "unchanged" is the claim.

## How this was verified

All figures are from runs on the final tree, on this machine (Apple M5, 10 cores, 16 GB, darwin arm64).

- `npm run check` — exits 0.
- `npm test` — **881 tests, 881 pass, 0 fail** (70.4 s). The registry assertion now expects 43
  scenarios; no other test changed.
- `npm run e2e` — **17 steps passed, 0 failed**.
- `npm run browser`, full suite, **run A** — **43 passed, 0 failed**, exit 0. TEARDOWN: server stopped,
  process lock released, temporary workspace removed, shipped `data/world.sqlite` untouched.
  `wave-b-two-gates` passed in 51 658 ms, all ten steps, and no step needed a throttle resume.
- `npm run browser`, full suite, **run B** — **43 passed, 0 failed**, exit 0, same teardown, same
  scenario in 51 529 ms with the same per-step behaviour (each step within a few milliseconds of run A:
  entry 10 486 ms, purpose 1 839 ms, gate 1 browser 4 812/4 753 ms, gate 1 runtime 3 753 ms, gate 2
  browser 7 522/7 513 ms, gate 2 runtime 6 515 ms, conversation 1 180 ms, restart 2 692 ms). Neither
  run needed a resumption of the server's movement throttle anywhere in the suite.
- Pre-change baseline on the same tip, for comparison: `npm run browser` = 42 passed, 0 failed, exit 0;
  `npm test` = 881/0; `npm run e2e` = 17/17; `npm run check` exits 0. The changed tip reproduces all of
  it plus one scenario.
- `movement-latency` figures from the two runs on the changed tree (same instrument, same resident, so
  the crossing scenario can be seen not to disturb the movement path):
  - run A — The Commons, 12 steps east out of `10,5` and the same back (`12×E 12×W`): n=24, min 7.4 ms,
    **median 11.5 ms**, p95 13.1 ms, max 16.4 ms; split: input → request left the page 1.5 ms, input →
    `POST /move` answered 4.2 ms, that answer → the aim line 7.5 ms; 24 of 24 carried by the movement
    control; 0 presses refused by the server's throttle; load average 1.8/2.2/3.4 at the end of the run.
  - run B — same route: n=24, min 7.1 ms, **median 11.9 ms**, p95 17.1 ms, max 17.4 ms; split: 1.6 ms /
    4.1 ms / 7.5 ms; 24 of 24 by the movement control; 0 refusals; load average 2.5/2.6/3.2 at the end
    of the run.
  - the pre-change baseline run on this machine reported min 3.7 ms, median **11.9 ms**, p95 17.7 ms,
    max 19.7 ms on the same route (load average 3.7/3.3/4.7), so the two runs after the change sit
    inside the band the instrument already showed for this machine and this route.
- The focused run used while developing (`LUCY_BROWSER_ONLY=wave-b-two-gates npm run browser`) passes on
  the final tree as well.

## Follow-ups worth a decision, not part of this task

- If Wave B's acceptance is to be a single end-to-end claim, the missing pieces are one continuous run
  covering the country venue and a cooperative world change with the same party, and a model-driven (or
  explicitly scripted-and-labelled) AI decision path. The pieces now exist; only the run does not.
- `selectResident` and `selectResidentAndSettle` exist side by side because "Enter as this character"
  ends by opening the world view, and a section opened before that trailing render lands is silently
  overwritten. Scenarios that select a resident and then open another section should use
  `selectResidentAndSettle`; a future cleanup could fold the two together.

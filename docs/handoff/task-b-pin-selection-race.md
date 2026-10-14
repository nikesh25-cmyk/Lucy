# Task B — pin the character-selection race that overwrote a section

`app.js` was fixed in `83b9505`: **"Enter as this character"** awaited `selectAgent(agent.id)` and then
unconditionally set `state.tab='world'` and re-rendered, so any section the operator opened while that
await was in flight was silently replaced by the world view. The handler now remembers the tab at click
time and only switches to the world if the tab is still the one it started from.

Nothing in the suite pinned that race. `game-shell-entry-and-continue` drives the same control but never
navigates during the await; `wave-b-two-gates` hit the race twice and worked around it with
`selectResidentAndSettle` (that workaround is untouched). This change adds **one** scenario,
`selection-does-not-clobber-navigation`, that widens the await deterministically and holds both halves
of the fix: the section survives, and the plain click still enters the world.

- Base commit: `83b9505` (`Stop a late character selection from overwriting the section a user opened`)
  on `integration/deepseek-master-2026-10-14`.
- Files changed: `scripts/browser-suite.mjs` (one scenario + its fact reader, one registry entry),
  `tests/browser-suite.test.js` (the asserted scenario count, 43 → 44 — nothing else), and this file.
- `app.js` is **untouched in the final tree** (`git diff -- app.js` is empty). It was reverted and
  restored only for the load-bearing proof below.
- No test was deleted, skipped or weakened; no scenario was removed; the suite's temporary database,
  production-database refusal, teardown, traces-on-failure and non-zero-exit-on-fail-or-skip are
  unchanged.
- Patch: `git format-patch` to `../task-b-pin-selection-race.patch`.

## The two reads of the handler

`app.js:1507` (fixed) —

```js
() => { const tabAtClick=state.tab; return selectAgent(agent.id).then(() => { if(state.tab!==tabAtClick)return; state.tab='world';render(); }); }
```

`app.js:248` `selectAgent(id)` sets `state.selected`, `setGameMode('play')` and `localStorage`'s
`selected-agent` **synchronously**, then `await loadWorld()` (which is `GET /api/v1/world?…&agent_id=…`),
then `await Promise.all([loadJourney(), loadCommunity(), loadCallings(), loadQuests(), loadGuildProjects(),
loadRestoration(), loadFirstPlay()])`, and only then `render()`. It never sets `state.tab` itself, so the
`.then(...)` above is the only place that can clobber a navigation.

## How the window is widened (deterministically)

1. The operator signs in as the administrator in this scenario's own browser context
   (`selection-race-operator`) and opens **My characters** in the workspace presentation — the section
   the control lives in.
2. `page.route` intercepts **exactly one request**: `url.pathname === '/api/v1/world'` **and**
   `agent_id === <the resident being entered as>`. `selectAgent` cannot reach that read from anywhere
   else, and before the click the page's world reads name the previously selected resident, so the
   first match is the one the control itself awaits. Only the **first** match is held; a later read for
   the same resident passes straight through instead of queueing behind it.
3. The control is clicked; the scenario waits (bounded, 25 ms poll) until the route handler reports the
   held request **arrived**. From that instant until `release` the await is provably open.
4. Inside that await the scenario opens **Callings & guilds** through the interface and asserts it is
   the current section with its own heading rendered.
5. `release` (called by the scenario, and again from a `finally` if a step fails) lets the request
   through, and the scenario waits for the selection to settle.
6. The route is removed in the same `finally` (`page.unrouteAll({ behavior: 'ignoreErrors' })`), so a
   failing step cannot leak the interception into a later scenario.

### Why the settle wait cannot be a sleep

The suite's `button()` helper (`app.js:124`) marks the clicked control `aria-busy="true"` for the whole
duration of the handler's promise and clears it in a `finally`. That `finally` runs **after** the
`.then(...)` callback that contains the tab switch, so the mark clearing is the page's own statement
that the selection *and its trailing render* have already happened. The scenario finds the busy control
(after the hold, so it cannot have finished), keeps the node, and:
- asserts it is **still busy** after the other section was opened (proof the handler was running), and
- treats its mark clearing — together with `viewer_agent_id` in the payload — as the settle signal.

No blanket sleep is used, and no assertion is relaxed to obtain a pass.

## What is asserted

| claim | read from |
|---|---|
| the opened section is still the current one when the selection finishes | `#toggle-navigation` text and `#navigation button[aria-current="page"]` |
| its own heading is still rendered | `#view h2` (`Every resident has a calling`) |
| the world view did not replace it | no `#view #world-overview` (the world map marker) |
| the selection itself still landed | `window.__nemoworld.selected()` |
| the delayed read is the payload the page holds | `window.__nemoworld.world().viewer_agent_id === <resident>` and `.world.id === <the row's stored world_id in the temporary SQLite file>` |
| the opened section is the payload of the resident being selected | `#view .calling-story` text contains the resident's name **and** the calling name read independently over `GET /api/v1/callings?agent_id=…` |
| the **unchanged** case: with no intervening navigation, the same control still enters the world | `Open world` is the current section, the world map is mounted, and the payload names that resident |

The DOM is never the only authority: the section and payload assertions are read from the page's own
client state, and the world id and the calling name are cross-checked against the temporary database and
the server's API.

## Proof the assertion is load-bearing

The new scenario was run three ways in this worktree.

**With the fix reverted** (the `tabAtClick` guard removed from `app.js` by hand; focused run
`LUCY_BROWSER_ONLY=selection-does-not-clobber-navigation npm run browser`) — reproduced twice, identical:

```
SCENARIO selection-does-not-clobber-navigation — A section opened while a character selection is still loading is not replaced by the world view  [regression: character selection race (83b9505)]
      · with nothing else opened, entering as a character still lands in that character’s world — Wanderer entered commons and the world view is the mounted one (1551 ms)
FAIL  selection-does-not-clobber-navigation — A section opened while a character selection is still loading is not replaced by the world view
        reason    the section the operator opened must still be the visible one when the selection finishes
        expected  Callings & guilds still current
        actual    {"section":"Open world","current":"Open world","heading":"Choose your next step"}
        evidence  test-results/selection-does-not-clobber-navigation-selection-race-operator.png, test-results/selection-does-not-clobber-navigation-selection-race-operator-trace.zip, test-results/selection-does-not-clobber-navigation.log
SUMMARY  0 passed, 1 failed
browser exit:1
```

The failure lands on the section assertion, which means the settle signal (busy mark cleared **and** the
delayed payload applied) was reached *after* the clobbering render — the assertion reads the finished
state, not a moment before it. The unchanged-case step still passed in that build, as expected: the guard
is what the first step does not need.

**With the fix restored** (`git checkout -- app.js`, `git diff -- app.js` empty), same focused command:

```
      · with nothing else opened, entering as a character still lands in that character’s world — Wanderer entered commons and the world view is the mounted one (1538 ms)
      · a section opened while the character’s world read is still in flight survives the selection — the Pathfinder world read was held open, Callings & guilds was opened inside it, and the section was still mounted when the selection finished (784 ms)
PASS  selection-does-not-clobber-navigation — A section opened while a character selection is still loading is not replaced by the world view (2506 ms)
SUMMARY  1 passed, 0 failed
```

**Full suite, twice** (see the exact runs in the change's verification record): `44 passed, 0 failed`
each time, with the new scenario at registry position 37, right after `game-shell-entry-and-continue`,
and `signout-privacy` still last.

## Limitations

- The scenario drives the **workspace** presentation (`/?mode=workspace`, `My characters`), the same
  section the suite's `selectResident` already uses. The button handler and `selectAgent` are identical
  in the game shell; the guard is on the handler, so the game shell's own My characters is not driven
  separately here.
- Only the **first** read `selectAgent` awaits is held (`/api/v1/world`); the seven reads of the parallel
  batch are not delayed. That is deliberate — holding the first await keeps the whole chain open — but it
  means the scenario pins the clobbering tab switch, not the exact latency distribution that made the
  original Wave B hit happen. It does not reproduce the original timing.
- The load-bearing strength depends on the `button()` busy mark. If that helper stopped marking controls
  busy, the settle wait would degrade to the payload check (`viewer_agent_id`), which lands **before** the
  trailing render — the scenario would then be weaker and might pass a broken build. Anyone changing
  `button()` should re-run the reverted-fix check in this file.
- The scenario adds one browser context and one administrator sign-in, and writes nothing: server-side it
  only reads (`GET /api/v1/world`, `GET /api/v1/callings`). The suite's own shipped-database guard
  confirms `data/world.sqlite` is untouched.
- The suite's known load sensitivity is unchanged. Every wait here is bounded and bound to a page signal
  (the held request arriving, the busy mark, the payload, the section name); the section opener keeps its
  existing bounded retry. A focused run works standalone (`LUCY_BROWSER_ONLY=…`), taking about 15 s
  including server boot and fixtures.

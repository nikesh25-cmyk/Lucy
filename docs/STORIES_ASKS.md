# Stories stream: what is new and what other streams must edit

> **Renamed at the engine merge.** The engine stream's missions v2 catalogue became the canonical
> `content/veloren-missions.json` / `src/veloren-ext/missions.js` / `tests/veloren-missions.test.js`, and it now
> backs the guide's `missions` page and the `tasks` list. The twelve story missions described below moved, unchanged,
> to `content/veloren-story-missions.json`, `src/veloren-ext/story-missions.js` and
> `tests/veloren-story-missions.test.js`; `index.js` re-exports them as `loadStoryMissions` and `missionLines`.
> They were not folded into the engine catalogue: its daily rotation must show every mission within a week and its
> step kinds differ (`pantry.taken`/`linked` vs `pantry.delivered`/`account.linked`). Ask 1 below (and the bridge's
> `missions` word in Ask 2) is therefore already done with the engine catalogue; wiring the story arcs would need a
> page name of its own.

This stream added text and data only. Nothing below is wired into the running game yet; `tasks.js` is unchanged and `view.js` is untouched. Everything new is covered by `tests/veloren-missions.test.js`, `tests/veloren-stories.test.js` and `tests/veloren-conversations.test.js` (22 tests; the whole `tests/veloren-*.test.js` set is 184 passing).

## What was added

| File | What it is |
| --- | --- |
| `content/veloren-story-missions.json` (was `veloren-missions.json`) | 12 missions, 2 per charter principle, 3-4 steps each. Step kinds: `resident.met`, `landmark.visited`, `pantry.delivered`, `account.linked`, `landmark.together`, each with a `count` of distinct targets. |
| `src/veloren-ext/story-missions.js` (was `missions.js`) | Loader, validator, pure evaluator `evaluateMission`, `factsOf(link, player_uuid)` (same SQL facts as `tasks.js`), `missionsForDay` (3 a day, rotation by the host date) and the page generator `missionLines(link, player_uuid)`. |
| `content/harr-seasons.json` | 4 seasons x 3 event blurbs, 4 x 12 library field notes over the 10 places, 20 chronicle milestone phrases, a finishing line for each of the 36 projects, and 36 one-sentence building captions. |
| `src/veloren-ext/stories.js` | Loader and validator for the file above, plus pure helpers: `seasonOf`, `seasonEventBlurb`, `notesFor` (base notes first, then the season's extras), `captionFor`, `finishedPhrase`, `milestonePhrase`. |
| `content/harr-conversations.json` | 6 roles x 8 "ask me about" answers (48), each with 2-4 keywords and a template using only `{project}`, `{stage}`, `{insight}`, `{pantry}`. |
| `src/veloren-ext/conversations.js` | Loader, validator and filler. Wired into `npc-logic.js` by one import and a 2-line fallback in `replyFor`, after the role's own topics. |
| `docs/HARR_ALMANAC.md` | The village's story, places, people and rhythm. |

`src/veloren-ext/index.js` gained three re-export lines (not extensions; nothing handles a request).

## Ask 1: expose `missions` as an open page (view.js)

All edits are in `src/veloren-ext/view.js`.

1. Import, next to the `tasksLines` import (line 6):

   ```js
   import { missionLines } from './missions.js';
   ```

2. Page list (line 55): append `'missions'` to `HUD_PAGES`:

   ```js
   export const HUD_PAGES = Object.freeze([ ...existing..., 'research', 'missions']);
   ```

3. Titles (line 56): add `missions: 'Missions'` to `OPEN_TITLES`.

4. Open pages (line 58): append `'missions'` to `OPEN_PAGES`, so it needs no account.

5. In `buildView`, extend the ternary chain: add this arm before the final `libraryLines` fallback (for example directly after `name === 'research' ? researchLines(link)`):

   ```js
   : name === 'missions'
     ? missionLines(link, player_uuid)
   ```

6. In `helpLines()`, add "missions (today's three small goals)" to the list of village pages. Keep the line under 190 characters per wrapped line (the pager wraps it).

7. Tests that loop over `HUD_PAGES` (`tests/veloren-hud.test.js`, lines 145, 186, 235, 281, 589) will exercise the new page automatically; the byte and line limits are already satisfied (about 7 to 10 lines, each under 190 characters). If a test pins the help text word for word, update it.

The missions test `missions is not an HTTP/HUD page yet` asserts that `view.js` does not mention `missionLines`. Delete that last test in the same commit as edit 5.

## Ask 2: bridge words (Rust, `nemo-bridge/src/chat_hud.rs`)

The bridge already maps the words `missions` and `mission` to the `tasks` page (the arm at line 97: `"tasks" | "task" | "checklist" | "missions" | "mission" | "goals" => Command::View("tasks", None)`). To give missions their own page:

1. In the tasks arm remove `"missions" | "mission"`, leaving `"tasks" | "task" | "checklist" | "goals"`.
2. Add a new arm right after it:

   ```rust
   "missions" | "mission" | "daily" => Command::View("missions", None),
   ```

   The word list is lower-case letters and digits, and `today` already belongs to the `today` page, so `daily` is the extra synonym.
3. `PAGES` (line 54): change `[&str; 17]` to `[&str; 18]` and append `"missions"`. The server whitelists the same names (`HUD_PAGES`), so edit 2 of Ask 1 and this must ship together.
4. `SAFE_BARE` (line 119): append `"missions"` so the word works when said aloud without the guide's name.
5. Update any Rust test that pins the length or contents of `PAGES` or the `tasks` word list.

## Ask 3 (optional): let the library and chronicle use the new writing

These are one-line reads, each with a safe fallback when the file is missing:

- `libraryLines` in `world-life.js` can show `notesFor(discovery, now)` instead of `discovery.notes` to add the season's extra notes.
- `todayLines` in `village.js` can show `seasonEventBlurb(event.id, now) ?? event.blurb`.
- `chronicleLines` can use `finishedPhrase(project.id)` for a finished project and `milestonePhrase(key, name)` for the other 19 milestones.
- The dashboard (`harr.js`) can show `captionFor(project.id)` under each building.

None of these change a stored fact. The base text stays the source of truth.

## Notes for reviewers

- Mission steps are lifetime totals of distinct targets, not time-ordered. Order shows in the page: the "Next:" line always points at the first step not yet done. A later step already satisfied by older facts shows as done, and a mission is complete only when every step is.
- `pantry.delivered` counts delivered meals (the same query as `tasks.js`), not distinct items.
- Missions are a four-day cycle: 12 missions, 3 per day, consecutive in the catalogue, so each day shows three different principles. The day is the host computer's local calendar date.
- Conversation keywords are validated so none contains a role topic or a purpose phrase that `npc-logic.js` answers first. One real near-miss that the validator caught: "weather" contains "eat", a farmer topic.

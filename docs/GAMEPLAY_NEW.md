# Harr gameplay: five new systems

Five small, peaceful systems for the Harr village. They share the rules of the rest of the village:

* **Facts only.** Everything is derived from stored facts: signed `link_events`, `village_marks`, `village_attendance`, `pantry_takes`, the game server's works record. Chat and models never advance anything.
* **Restart-safe.** Four of the five systems store nothing and compute from facts and the date. The only new table is `gratitude_thanks`.
* **No value.** Nothing here grants coins, Karma or items, or reaches the shop, the wallet or any other economy path. Finishing something gives recognition (a title, a line on a page, a number on a dashboard) and nothing else.
* **Peaceful and non-competitive.** No scores per person, no rankings, no scarcity. Tests scan the new content and every page they produce for violent and competitive vocabulary.

Code is in `src/veloren-ext/`, content in `content/`, tests in `tests/veloren-gameplay.test.js` (33 tests, run in four time zones). One module per feature, plus `gameplay.js` (one door for view/tasks/overview) and `gameplay-pages.js` (a leaf with the page names, so import order cannot break `view.js`).

| System | Module | Content | Stored state |
| --- | --- | --- | --- |
| 1. Gratitude board | `gratitude.js` | (templated sentences) | `gratitude_thanks` |
| 2. Apprenticeship | `apprenticeship.js` | `harr-apprenticeship.json` | none |
| 3. Expeditions (field surveys) | `expeditions.js` | `harr-expeditions.json` | none |
| 4. Seasons | `seasons.js` | `harr-seasons.json` | none |
| 5. Village level | `growth.js` | `harr-growth.json` | none |

## 1. Gratitude board

A wall in the square with the newest thanks. A person can thank only for something that really happened:

| reason | needs this stored fact | who is thanked |
| --- | --- | --- |
| `meal` | a pantry take the game **delivered** to you in the last 3 days | the farmers |
| `find` | your own `landmark.visited` at a library place whose first page was written by **someone else** | that first finder |
| `met` | your own `resident.met` with a known villager | that villager (once per villager per day) |

* Each fact can be thanked once (`UNIQUE(thanker, fact_key)`), and a person can thank **3 times a day**. Thanks are fixed sentences built from the reason; no free text ever reaches the wall, so it cannot carry an insult, an advert or a link. Aliases are neutralised by `plain()`.
* The wall shows the newest 8 thanks from the last 7 days, **one entry per person (or group) thanked**, with no counts, so there is nothing to rank or farm. Rows older than 30 days are deleted on write.
* Villagers thank people too, **scripted and labelled**: a scholar thanks the first finder of a page; the builders thank everyone when a project is finished.
* Route: `POST /veloren/harr/thank { player_uuid, reason, subject? }`, guide credential only (same gate as the pantry), rate-limited (4 s gap, 20/hour per player). `subject` is a discovery id (`find`) or a resident id (`met`); leave it out and the newest eligible fact is used.
* Page: `thanks`.

## 2. Apprenticeship

One short chain per role, each with a named mentor (builder Ignatius, farmer Marisol, maker Imara, scholar Mirela, courier Wren, keeper Lucia). There is no "start" button and no stored progress: each step is evaluated from facts about that one person, in order, and a step counts only facts **strictly after** the previous step. Doing things early does not skip the chain.

Step kinds: `meet_mentor`, `report_back` (signed `resident.met` with the mentor), `finds` (signed visits, optionally only named places), `meals` (delivered pantry portions), `meet_residents` (other villagers met), `shadow_stage`, `thanked` (a thanks on the board), `survey` (a finished field survey).

Example, builder: meet Ignatius, then "shadow a builder for one stage" (meet any builder and have a stage finished within 30 minutes), then meet Ignatius again after that stage.

Finishing shows the title ("Apprentice builder") and nothing else. Mentors answer "mentor", "apprentice" and "teach me" in `npc-logic.js`. The dashboard gets aggregate counts per craft (started, finished), never names. Pages: `apprentice`, plus one line on `tasks`.

## 3. Expeditions (field surveys)

Each local day the village posts a **sheet**: one of four goals (for example "Record two places before dusk") and 2-4 places from the discovery catalogue. The sheet is a pure function of the date: the goal rotates with the day number and the places step through the catalogue by a fixed stride, so every place comes round. A **record** is a signed `landmark.visited` at a place on the sheet, on that day, **before dusk** (18:00 host time, exclusive). Standing at a known place again counts, which gives old finds a reason to be revisited. A survey is done when a person holds `need` distinct records.

The **village counter** adds up records today, this week, finished surveys, and the number of days in the last 30 on which the village goal (6 records) was met. It names nobody and ranks nobody; a quiet day costs nothing. Page: `survey`. Dashboard: `gameplay.survey`.

## 4. Seasons

Four meteorological seasons (spring March-May, summer June-August, autumn September-November, winter December-February) from the host's local date; `hemisphere` in the file can be set to `south`. A season changes exactly three things:

* the pantry's restock **rate** per food (0.8x to 1.5x, validated; the **caps never change**, so no shelf can be starved and a long absence still ends at the cap). Autumn favours apples and carrots, winter cheese, spring lettuce, summer apples and lettuce. The edit to `pantry.js` is one multiplier in `shelfNow`.
* the wording of the three village events (a short replacement for the blurb on the `today` page and the dashboard rhythm list);
* one library note a day, rotating, shown on the `library` page.

No weather, terrain, light, buildings or ownership. Page: `season`. Dashboard: `gameplay.season`.

## 5. Village census and growth

The **village level** is the highest of six levels (Hamlet, Village, Large village, Market town, Learned town, Harr in full bloom) whose every requirement is met, checked in order so none can be skipped. Requirements are in `harr-growth.json`: finished projects, technologies learned, established crafts (kinds of villager with at least 2 residents), people welcomed (distinct players in signed events). Everything is computed, never stored or awarded; facts only grow, so the level only grows. It unlocks nothing.

It appears as `gameplay.village_level` on the overview JSON, as a "Village level:" line in the chronicle (page and dashboard), and on the `level` page.

## Where it is wired in

* `index.js`: one line (`gratitudeExtension`, which owns the table and the route).
* `view.js`: the five pages join `HUD_PAGES` and `OPEN_PAGES`; `today` uses the seasonal blurb, `chronicle` gets the level line, `library` gets the season note; one help line names the new pages.
* `tasks.js`: two lines appended to `tasksLines` (apprenticeship, today's survey). `tasksFor` is unchanged (still six tasks).
* `overview.js`: one new top-level key `gameplay` (additive), seasonal rhythm blurbs, the level line in `chronicle`.
* `npc-logic.js`: mentors answer apprenticeship questions.
* `pantry.js`: the seasonal rate multiplier.

## Words and routes for the bridge (owned by others)

Pages (GET `/veloren/view/<page>?player_uuid=...`, open pages): `thanks`, `apprentice`, `survey`, `season`, `level`.

Action (POST `/veloren/harr/thank`, guide credential, body `{ player_uuid, reason, subject? }`), suggested whispered words:

| player says | send |
| --- | --- |
| `thank farmers` or `thank meal` | `reason: "meal"` |
| `thank find` (optionally `thank find <place id>`) | `reason: "find"`, `subject: "<id>"` |
| `thank villager` (optionally `thank <resident id>`) | `reason: "met"`, `subject: "lw-..."` |

The reply is `{ ok, lines }`. The bridge should choose the reason from this fixed list and never forward chat text as `subject` (the server also validates it).

## Limits worth knowing

* **No `project.helped` fact exists.** The game server does not tell NemoWorld who stood at a site, so gratitude cannot be derived from crew presence and `shadow_stage` proves only co-timing (you met a builder, then a stage was finished within the window). Stage times are the time NemoWorld first saw the stage in the server's record (30 s throttle), not the build time.
* Event times come from the game server's clock and are compared with the host clock. The link already refuses events more than 5 minutes ahead; the new code also ignores them.
* The villager roster is static, so "established crafts" is a constant today. It starts to matter when the roster grows.
* A season changes the rate at the moment a shelf is read, so a read just after a boundary applies the new rate to the whole elapsed interval (a small, bounded approximation).

## Decisions for the owner

1. **Ask the game server for a `project.helped` event** (player, project, stage) emitted when a crewed stage is built. It would let the gratitude board thank crew members and make `shadow_stage` exact. The evaluator is one function in `apprenticeship.js`.
2. **Overview test updated.** `tests/veloren-purpose.test.js` asserts the exact top-level keys of the overview; the only change is that `gameplay` is now in the expected list (still an exact match). Anything else reading the overview ignores unknown keys.
3. **Tuning numbers** live in the content files: restock multipliers, dusk hour, village goal per day, level thresholds, thanks per day (code constant `GRATITUDE_POLICY`).
4. **Hemisphere**: `harr-seasons.json` ships as `north`; change to `south` if the host is in the southern hemisphere.
5. **Mentors are fixed in the file** and the load fails if a mentor is renamed or loses their role. Add a second mentor per craft later if one villager is not enough.
6. **Bridge words** for the five pages and the `thank` action need adding by their owner (table above).
7. **Privacy**: `gratitude_thanks` stores the thanker's Veloren uuid for 30 days (needed for the daily limit and once-per-fact rule). The wall shows neutralised aliases in game; the dashboard JSON shows "a visitor" for everyone.

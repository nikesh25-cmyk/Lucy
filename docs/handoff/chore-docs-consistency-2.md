# chore/docs-consistency-2 — documentation-consistency pass (second batch)

Branch `chore/docs-consistency-2`, base `verify-batch02-wave-f` (`c8d3f4c`). Docs only.

Files changed: `docs/CALLINGS.md`, `docs/COUNTRY_PROGRAMMES.md`, `docs/QUESTS.md`,
`docs/GUILDS.md`, `docs/NEMOWORLD.md`, `docs/START_HERE.md` (plus this handoff).
No `.js`, no `content/**`, no `app.js`, no other doc, no `outputs/Lucy`.

## Verified baseline (measured on the delivered tree)

- **Schema 21** — `src/database.js:128` (`PRAGMA user_version=21`), guard `> 21` at
  `src/database.js:18`, `accepted_schema_versions: [1..21]` and `schema_version: 21` in
  `src/recovery.js:339-340`.
- **Content seal** — `node scripts/seal-content.mjs --check` →
  `Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic, 3 crop, 27 furniture); 3 support files; 42 referenced notices and assets.`
- **Syntax** — `npm run check` → exit 0.
- **Tests** — `npm test` → **562 tests, 562 pass, 0 fail, 0 skipped, 0 todo** (exit 0).
- **Fresh-seeded corpus** — a platform on `:memory:` seeds **1,015** `research_leads`
  (748 `baseline` + 87 `destination` + 87 `institutions` + 87 `interventions` + 6 `agriculture`),
  248 `npc_ambassadors` and 20 `npc_mayors`.

## Claims corrected

| # | File | Was | Now | Evidence |
| --- | --- | --- | --- | --- |
| 1 | `docs/CALLINGS.md` (new `## Resident memory` section; `/callings` bullet) | The private `/callings` response documented no `memory` view | Documents the bounded `memory` view: the four fact kinds, their attributes and mandatory sources, operator-only approval, the budget numbers, and the "data, not instructions / not a sentient being" framing | `src/vocations.js:363` (`memory:promptMemory(this,agent)`), `promptMemory` `src/vocations.js:202-209`, `MEMORY_KINDS` `:61-66`, `MEMORY_SOURCES` `:67`, `memoryPairValid` `:83-90`, `memoryShape` (403s) `:115-122`, `memoryPropose` `:410-424`, `memoryManage` `:428-437`, `MEMORY_LIMITS` `:73`, `MEMORY_POLICY` `:74-80`; runtime framing `runtime/agent.js:536` (`"You are a bounded program, not a sentient being"`); routes `server.js:112,114,500`; export `src/platform.js:690` + `memoryExport` `src/vocations.js:487-490` |
| 2 | `docs/CALLINGS.md:56-58` | "…in generated `country:<iso3>` venues, schema 15, …" | "…landed on branch `task-01-country-ambassadors` at schema 15 (the current schema is 21): 248 country ambassadors …" | current schema `src/database.js:128` = 21; the 15 was task 01's release (`docs/handoff/task-01-country-ambassadors.md:6`, "schema **14** … After this work: schema **15**"); 248 ambassadors measured |
| 3 | `docs/COUNTRY_PROGRAMMES.md:15` | "…displayed **seventy-four proposals** across all goals … inspected **four seventeen-proposal general work stages** …" (74 = retired 68 stage rows + 6 pilot) | Kept as the milestone QA record and labelled as the retired `(country × goal × stage)` generator; added the measured replacement figures: **20–23** concern-based proposals per country (23 with a retained agriculture series, 20 otherwise) and Nepal **29** (23 + 6 pilot) | `planCountryResearch` `src/civic-engine.js:97-103` measured over all 248 entries → 204×20 + 44×23; fresh seed → Nepal `research_leads` = 29, total 1,015; task-24 handoff `docs/handoff/task-24-proposal-generator.md:118-120` ("A country now produces 23 concern-based proposals (20 for Senegal)", "Nepal now has 29 proposals (23 country + 6 pilot)") |
| 4 | `docs/COUNTRY_PROGRAMMES.md:5` | "…by all seventeen SDGs and **seven general/institution/pilot stage categories**." | Lists the actual stage summary: four concern stages (`baseline`/`destination`/`institutions`/`interventions`), four target-specific stages, two institution-specific stages and the pilot stage | measured `countryResearchPlan({country:'NP'}).stages` has 11 entries; `stageOrder` `src/civic-engine.js:219-220` |
| 5 | `docs/COUNTRY_PROGRAMMES.md:9` | Exports "status/goal/stage counts" | Exports "status/goal/stage **and concern** counts, **the substantive-key dedupe record**, …" | `countryResearchPlan` returns `concerns` and `dedupe` (`src/civic-engine.js:221-222,225`); export route `server.js:523` sends `result.country_plan` |
| 6 | `docs/QUESTS.md:9` | "Runs on schema **18** (…; the quest tables were added on schema 17)." | "The quest tables … were added on schema 17 and are unchanged since; the current schema is 21." | current schema `src/database.js:128`; quest DDL/validation `src/recovery.js:137-147`; `src/quests.js` has a single commit (unchanged since introduction); task-05 handoff `docs/handoff/task-05-quest-chains.md:4` ("Delivered on schema **17**") |
| 7 | `docs/GUILDS.md:35` | "Three additive tables." (under a `## Schema 18` heading, with no current-schema reference) | "Three additive tables, added at schema 18 and unchanged since (the current schema is 21)." | current schema 21; guild validation `version >= 18` at `src/recovery.js:148`; `GUILD_SCHEMA` `src/database.js:92`; task-06 handoff `docs/handoff/task-06-guild-projects.md:4` ("schema **18**", "Delivered on schema 18") |
| 8 | `docs/NEMOWORLD.md:62` | "…under draft PR review. Main's setup ZIP does not yet contain it. **Thousands of proposals** remain a research backlog…" | "The development release **was** on `feat/civic-world-foundation` … The seeded research corpus holds **1,015** source-scoped proposals…" | fresh seed `research_leads` = 1,015; reconciles with `README.md` "1,015 source-scoped research proposals" |
| 9 | `docs/START_HERE.md:3` | "…its world, **mayor roster**, country evidence and research backlog…" | "…its world, **country ambassador roster**, country evidence and research backlog…" | commit `e54e961` "…replacing regional mayor framing"; nav item "Regions & ambassadors" `app.js:483`; `docs/MAYOR_ROSTER.md:3` marked "Historical record — pre-ambassador release" |
| 10 | `docs/START_HERE.md:5` | "Visitor browser QA followed mayor, country and research routes." | Marked historical: "…followed the pre-migration mayor, country and research routes; that mayor framing was later replaced by the per-country ambassadors…" | same as #9 |

## Left alone — checked and already accurate (no change)

- `docs/CALLINGS.md` calling facts: 8 callings and their guild names (`Explorer → Wayfarers` … ),
  5 cosmetic experience per objective, 10 a day, one change a day, ranks Newcomer(0)/Apprentice(20)/
  Practitioner(50)/Companion(100)/Worldmaker(200) — `src/vocations.js:9-19` (`CALLINGS`),
  `CALLING_POLICY` `src/vocations.js:19`, `rank()` `src/vocations.js:303`;
  `GET /callings/guilds` `limit` 1–24 — `src/vocations.js:386`; 248 ambassadors / 20 historic guides — measured.
- `docs/QUESTS.md` model: 2–8 steps, three routes and their `source_kind`s, `quiet-harvest` three-step
  practice chain, 5/receipt, once-only source, `shared-world-account-v18` export, catalog `limit` 1–20 —
  `src/quests.js`, `src/platform.js:690`, `src/quests.js:331-332`.
- `docs/GUILDS.md` policy payload (version 1, `workstreams_max` 6, `participants_max` 100,
  `participations_per_agent_max` 12, `projects_per_operator` 10, roles/visibility/actions, all grants
  false) — exact match to `GUILD_PROJECT_POLICY` `src/guilds.js:39-56`; commitment ≤ 500 and evidence
  ≤ 4000 characters and up to five HTTP sources — `src/guilds.js:281,287`, `src/community.js:20`;
  the `## Schema 18` heading itself is accurate as the schema at which the guild tables arrived.
- `docs/NEMOWORLD.md` "five registered agriculture, electricity and Internet source slots" — measured
  `ambassadorContext(...).sources.length` = 5 (`src/mayor-evidence.js:41+`); the country atlas globe/flat/
  selector/source notes — `app.js:1671-1680`; "The full suite passed 229 tests at that milestone" is
  already marked historical.
- `docs/COUNTRY_PROGRAMMES.md` "All 180 tests passed at that milestone" — already marked historical;
  the workflow sentence matches `countryResearchPlan().workflow` (`src/civic-engine.js:225`).

## Deliberately left unverified / untouched

- `docs/START_HERE.md:3` "through **three** entry paths" — I could not tie "three" to a code structure
  (the nav carries four titled groups plus the Guide; the hero offers four actions). Left as written
  rather than guessed, and it is not a claim the code contradicts.
- `docs/NEMOWORLD.md:60` accessibility measurements (four 4.5:1 colours, nine 44-pixel controls, one
  32-pixel password-reveal) — a measured task-13 milestone statement, left as historical.

## Code observation (not a doc fix — reported, not changed)

- `themeApplies` returns `true` whenever a theme's `evidenceGate` is not `'agriculture-series'`
  (`src/civic-engine.js:61`). The `ldc-cooperation` theme has `"evidenceGate": "none"`
  (`catalog/research-concerns.json`), so its three applied concerns are emitted for **all 248** catalog
  countries, not only LDCs — even though its `subjectBasis` reads "{country}'s current LDC status and
  graduation timeline". Measured: France (not an LDC) produces 20 proposals whose goal 17 rows are the
  `destination`/`institutions`/`interventions` LDC-cooperation concerns
  (`src/civic-engine.js:97-103`). This may be intended (SDG 17 is universal and the gate is explicitly
  `none`), so it is reported for the owner of `src/**` to judge, not changed here.

## Actual results (delivered tree)

```
npm run check                         exit 0
node scripts/seal-content.mjs --check Verified: 89 definitions (20 appearance, 7 block, 32 cosmetic,
                                      3 crop, 27 furniture); 3 support files; 42 referenced notices
                                      and assets.  exit 0
npm test                              562 tests, 562 pass, 0 fail, 0 skipped, 0 todo  (exit 0)
```

No code, test, content or other document was modified, so these figures are the unchanged baseline.

# Task 24 handoff — repair the research proposal generator

## What this delivers

Task 12 found that the country generator emitted one interchangeable template per (country × goal × stage): the `evidence`, `partners` and `proposal` instructions differed only by country name, named no commodity, instrument or route, and could not be answered as written (24 of its 50 reviewed rows, three unique instructions reused across the LDC seeds). This task replaces that generator with a **concern model**, deduplicates by **substantive question**, keeps a **version history for revisions** that never rewrites an activated proposal, preserves the existing activation and coin/review workflow, and ships a **reviewed 50-proposal batch**.

| artifact | purpose |
| --- | --- |
| `catalog/research-concerns.json` | The concern model and theme map the generator consumes: four concerns, two scoped themes, the substantive-key dedupe rule, per-concern prerequisites, dependencies, outputs, acceptance criteria, primary-source categories and rights. |
| `src/civic-engine.js` | The generator: `planCountryResearch` (pure planner), `seedCountryResearch`, `recordLead`/`recordRevision`/`recordConsolidation`, the two additive tables, and the concern summary in the country work programme and `assembly`. |
| `docs/research/task-24-proposal-batch.md` | The reviewed 50-proposal batch, readable table. |
| `docs/research/task-24-proposal-batch.json` | The same batch, additive JSON with the full structured fields. |
| `tests/research-generator.test.js` | New regression coverage for the concern structure, dedupe, version history, activation safety and the legacy retirement path. |
| `docs/CIVIC_RESEARCH.md` | Updated corpus description. |

Nothing was activated. No live database, no `outputs/Lucy` file and no catalog row was read or written. No owner, beneficiary or reviewer was invented.

## The generator's new structure

Every generated country proposal belongs to exactly one **concern**:

- **`baseline` — country baseline collection.** One per (country × SDG goal): country context and dated statistics, the country's official source routes, and an evidence-gap register. A baseline is answered by that country's own official statistics, so it stays country-specific and is never consolidated across countries.
- **`destination` — product/destination-specific question.**
- **`institutions` — institution mapping.**
- **`interventions` — intervention comparison.**

The three applied concerns are emitted **only for a theme the catalog has scoped and only where the country has the theme's subject evidence**:

- **`agriculture-market-access`** (goal 2), gated on a retained World Bank agriculture series: 43 of the 44 LDC seeds.
- **`ldc-cooperation`** (goal 17): all 44 LDC seeds.

A goal with no scoped theme keeps its baseline only; its applied concerns are recorded as **open scope choices** on that baseline instead of being emitted as further interchangeable rows. Because the applied concerns are grounded in the country's registered subject evidence and mandate the missing commodity/instrument selection, they are answerable scoping questions rather than duplicates (the same standard that makes country baselines distinct).

The retired `evidence`, `partners` and `proposal` stage ids are still used by **SDG-target** and **institution-specific** generation, which continue to produce baseline, intervention-comparison, delivery-route and recommendation rows for one named target or institution. Their ids and names are unchanged, so the target ids, target counts and the existing UI copy for target briefs stay valid.

### Corpus

| stage | rows |
| --- | --- |
| `baseline` | 748 (44 × 17) |
| `destination` | 87 (43 agriculture seeds + 44 cooperation seeds) |
| `institutions` | 87 |
| `interventions` | 87 |
| `agriculture` (Nepal tea pilot) | 6 |
| **total `research_leads`** | **1,015** |

The old corpus was 2,998 rows; 2,244 of them were the interchangeable applied templates. Every field a reviewer needs sits in the proposal's `instructions` as labelled sections (`Outputs:`, `Acceptance:`, `Source prerequisites:`, `Dependencies:`, `Primary source categories:`, `Rights:`, `Open scope choices:`) and in the structured batch JSON.

## The dedup rule

Two candidate proposals are the same proposal when they share the same **substantive key**:

```
<concern>|<theme-or-goal>|<country_code>
```

- A baseline keys on `baseline|<country_code>|<goal>`: country baselines are answered by different country evidence and are therefore distinct.
- An applied concern keys on `<concern>|<theme>|<country_code>`, so **two goals that resolve to the same theme and concern for one country emit one row**, and the second is recorded in `research_lead_consolidations` with the canonical id.

`planCountryResearch(country, themes)` is pure and deterministic: it returns the candidate rows, their keys, and any consolidations. With the current editorial theme map each theme maps to one goal, so no consolidation occurs in the shipped corpus; the rule is enforced for every candidate and is exercised by a test that feeds it an overlapping theme map (one theme covering goals 2 and 3), which produces one row per concern and three recorded consolidations.

The generator also never emits the retired interchangeable stage ids for a country. An installation seeded by the older generator keeps its retired rows **unchanged** (nothing is deleted or rewritten) and gains one consolidation record per still-proposed retired row whose successor concern row exists, so the desk can say which proposal replaced it.

## Version history and activation safety

- Each revision goes through `recordLead`. A lead is **eligible** for revision only while `status = 'proposed'` **and** `task_id IS NULL`. An activated, leased, under-review, accepted, adopted, rejected or evidence-withheld lead is never rewritten, and its history is untouched.
- When a revision changes content, the content being replaced is archived in `research_lead_versions` with `revision_reason = 'superseded'` before the live row is updated. `researchLeadVersions(id)` returns the live revision and every archived version, newest first. On a fresh seed no version rows exist until a revision happens; on an older installation the first boot revises only still-proposed leads and archives the interchangeable template it replaces.
- The existing triggers are untouched: `research_task_status` still projects task status onto the lead, and `research_adoption` still records adoption. Revisions never write `status`, `mission_id` or `task_id`.
- `researchActivate`, the bounded worker, claim/submission/review/adoption and the coin ledger are unchanged. Seeding still creates zero claims, submissions, adoptions or coin rewards, and selects no beneficiary.

## The reviewed 50-proposal batch

`docs/research/task-24-proposal-batch.md` (table) and `docs/research/task-24-proposal-batch.json` (structured) review 50 proposals drawn from the generator's current output around Task 12's two themes:

- 6 Nepal–India tea pilot leads (`pilot-tea-1…6`, goal 2, stage `agriculture`);
- 5 LDC seeds × 4 concerns for SDG 2 agriculture market access (Bangladesh, Ethiopia, Malawi, Uganda, Cambodia): 20;
- 6 LDC seeds × 4 concerns for SDG 17 LDC cooperation (Nepal, Zambia, Myanmar, Bangladesh, Ethiopia, Malawi): 24.

Every entry carries a distinct, answerable question, its explicit unresolved scope choices, primary-source categories, rights, source prerequisites, dependencies, outputs and acceptance criteria, and a `distinct_in_corpus` flag proving no other seeded proposal shares its substantive key. Classification counts: **7 ready for human scoping, 42 useful proposals, 1 missing evidence**. Every listed proposal stays `proposed`.

## Exact results

Run on branch `task-24-proposal-generator` at base commit `4fbdff5` (Node v24.19.0):

| gate | command | result |
| --- | --- | --- |
| Syntax | `npm run check` | exit 0 (all 30 files parse) |
| Unit/integration | `npm test` | **455 tests, 455 pass, 0 fail, 0 skipped** (~61 s) |
| HTTP acceptance | `npm run e2e` | **15 steps passed, 0 failed**, temporary workspace removed |
| Final lead count | seeded corpus | **1,015** `research_leads` rows (748 baseline + 261 applied + 6 pilot) |

The suite grew from 448 to 455 with `tests/research-generator.test.js` (7 tests).

## What this deliberately did NOT do

- **No schema-version bump (schema stays 18).** Two additive tables are created idempotently; `src/database.js`, `src/recovery.js`, `server.js` and `app.js` were not touched.
- **No deletion or rewrite of existing rows.** Retired interchangeable rows on an older installation are preserved exactly and marked as consolidated.
- **No activation, beneficiary, owner, reviewer, buyer, partnership, funding or external outcome.** Seeding asserts zero claims, submissions, adoptions and coin rewards.
- **No fabricated national sources.** Only URLs already registered in the catalog (SDG framework, UN M49, the World Bank WDI series, the Doha Programme of Action, UN-OHRLLS, the Technology Bank, UNCTAD, ITC) are cited; national domains are named as source *categories* to be located.
- **No rename of the SDG-target/institution stage ids**, so target generation, target ids and the existing UI copy stay valid.
- **No change to the four-stage target/institution workflow**, the calling, guild, quest, land, coin, privacy or review models, or `docs/research/proposal-review-patch.json` (a Task 12 historical artifact).

## Migration and rollback

**Schema: no version bump; two additive tables; no data migration.**

- Additive DDL (in `CIVIC_SCHEMA`, `src/civic-engine.js`), created with `CREATE TABLE IF NOT EXISTS` on every open:
  - `research_lead_versions(id, lead_id, revision, title, instructions, rubric, source_urls, substantive_key, revision_reason, created_at, UNIQUE(lead_id,revision))`
  - `research_lead_consolidations(dedupe_key PRIMARY KEY, country_code, canonical_id, consolidated_id, reason, created_at)`
- On an older installation the first boot after this change revises only still-`proposed` leads with no task and archives the replaced content. Activated/claimed/accepted leads are untouched.
- **Rollback:** `DROP TABLE IF EXISTS research_lead_versions; DROP TABLE IF EXISTS research_lead_consolidations;` (then redeploy the previous `src/civic-engine.js` and `catalog/`). No existing table, column, trigger or view is altered, so the rollback is lossless for the previous release; the revision/consolidation ledger is the only state lost.
- **Backup/restore:** `VACUUM INTO` copies both tables; `validateDatabase` (version 18) does not require them, so a backup made before this change still validates and a restore recreates them on the next open.

## Known integration conflicts (files owned by other agents)

These files lie outside this task's ownership and now describe the old generator; the Task 27 agent owns them.

1. **`app.js`** shows a **"Generate 68 proposals"** button and a country-programme copy that describes four general stages. A country now produces 23 concern-based proposals (20 for Senegal) and fresh countries produce concern rows, not 68 stage rows. The `lead.stage` badge in the research card now shows `baseline`/`destination`/`institutions`/`interventions`.
2. **`docs/COUNTRY_PROGRAMMES.md`** states "seventy-four proposals" for Nepal and "four seventeen-proposal general work stages". Nepal now has 29 proposals (23 country + 6 pilot).
3. **`src/recovery.js` `validateDatabase`** does not validate the two new tables. They are additive and optional; a future schema bump should add version-19 checks there.

## Residual risks

- **Scoping proposals, not answers.** The applied concerns still name no commodity or instrument: their first deliverable is that selection. A reviewer must accept that a country-scoped selection proposal is answerable before activating it. This is the honest limit of what the catalog supports.
- **Theme map is editorial.** Only SDG 2 and SDG 17 are scoped. If a future theme lists several goals, the generator will consolidate them by design; a reviewer should inspect the recorded consolidations. Adding a theme is a catalog edit, not a code change.
- **Older installations keep the retired rows.** Until an operator reviews them, an upgraded installation's `catalog_total` includes the retired `evidence`/`partners`/`proposal` rows (they are recorded as consolidated, not removed). No automatic deletion is performed.
- **50-row batch is not a full review.** The batch reviews the two themes Task 12 reviewed; the other fifteen goal baselines were generated to the same structure but were not individually reviewed here.
- **No correctness claim.** The batch establishes that the questions are answerable and distinct; it does not establish that any finding will be correct, that a buyer or institution exists, or that a country outcome is achievable.

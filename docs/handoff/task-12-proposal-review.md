# Task 12 handoff — research proposal quality review (50 proposals)

## What this delivers

An **analysis and a proposed additive patch**, not a generator.

| artifact | purpose |
| --- | --- |
| `docs/research/PROPOSAL_REVIEW.md` | 50-row readable review table (id, current title, classification, refined question, concrete evidence/output criteria) plus classification counts and method. |
| `docs/research/proposal-review-patch.json` | Proposed additive patch keyed by `research_leads.id`, carrying the full refinement (question, scope, beneficiary placeholder, prerequisites, outputs, acceptance rubric, source categories, rights, dependencies) in a shape that could later be applied to `research_leads`. |
| `docs/handoff/task-12-proposal-review.md` | This document. |

Nothing was activated. No live lead row, catalog file or `outputs/Lucy` file was modified. No owner, beneficiary or reviewer was invented.

## Method

1. Read `docs/deepseek/START_HERE.md`, `docs/deepseek/TASKS.md` (task 12), `docs/CIVIC_RESEARCH.md`, `docs/RESEARCH_WORKFLOW.md`, `docs/RESEARCH_WORKER.md`, `docs/COUNTRY_PROGRAMMES.md` and `src/civic-engine.js`.
2. Booted a **temporary** database with the real `Platform` constructor (same seeding path as the test fixtures) and read 50 authentic `research_leads` rows from it. No live installation database was opened.
3. Selected the 50 rows around the two requested themes:
   - **Agriculture market access** — the 6 Nepal–India tea pilot leads (`pilot-tea-1…6`, `goal=2`, `stage=agriculture`) and SDG 2 (Zero Hunger) country proposals (`goal=2`, `stage=baseline/evidence/partners/proposal`).
   - **LDC bilateral cooperation** — SDG 17 (Partnerships for the Goals) country proposals (`goal=17`, four stages).
4. For every row, recorded the question, scope, beneficiary placeholder, prerequisites, outputs, acceptance rubric, source categories, rights and dependencies, then assigned exactly one classification.
5. Wrote the patch JSON and generated the Markdown table from the same data so the two artifacts cannot disagree.

Proposal ids are deterministic (`${iso2}-${goal}-${stage}` and `pilot-tea-N`), so every listed row exists in any seeded world. The batch totals 50 (6 pilot + 25 SDG 2 + 19 SDG 17).

## Classification counts

| classification | count | what it means here |
| --- | --- | --- |
| ready for human scoping | 11 | Concrete question + registered evidence + clear outputs, rubric and source categories. A human owner and independent reviewer could scope it today. Still `proposed`. |
| useful proposal | 13 | Worthwhile, non-duplicate question with a real source route, but one scoping choice or an extra registered source is needed first. |
| missing evidence | 2 | The question is legitimate but the required country or buyer evidence is absent from the registered catalog. |
| duplicate | 24 | The seeded instruction is an interchangeable stage template reused across the 44 LDC seeds; it names no commodity, instrument or route. |
| **total** | **50** | |

Non-duplicate useful set = **26** (11 + 13 + 2). The 24 duplicates are flagged for consolidation, not activation.

Per theme: agriculture market access 37 rows (6 pilot + 25 SDG 2 + 6 SDG 17 rows also touch trade), LDC bilateral cooperation 19 rows (SDG 17). The two themes overlap at SDG 17 rows whose market-access context is the Doha Programme of Action trade/regional-integration focus.

## Duplicates found, and why

24 of the 50 reviewed rows are byte-identical to a single stage template reused across countries:

- SDG 2 `evidence`/`partners`/`proposal` for Bangladesh, Ethiopia, Malawi, Cambodia and Senegal — **15 rows**, three unique instructions.
- SDG 17 `evidence`/`partners`/`proposal` for Nepal, Zambia and Myanmar — **9 rows**, three unique instructions.

For a given goal and stage, the seeded `instructions` string differs only by the country name; the question, method and acceptance criteria carry no commodity, value chain, instrument or destination. That is exactly the "interchangeable title" pattern the task warns against: the row cannot be executed as written because it does not name what is being compared or mapped.

Detected by exact instruction-template equality across the seeded catalog (only the country name varies). Each duplicate row carries a `duplicate_of` canonical id, a refined question that states what the row would need (a named commodity/instrument, value chain and destination) to become answerable, and a consolidation recommendation. **No rewrite is proposed for duplicate rows** — only the recommendation to fold 44×3 interchangeable templates per goal into one parameterised, theme-scoped proposal per country/commodity.

Note the canonical rows (`BD-2-evidence`, `BD-2-partners`, `BD-2-proposal`, `NP-17-evidence`, `NP-17-partners`, `NP-17-proposal`) are themselves duplicates of the same template used by the other 43 LDC seeds; they are only "canonical" relative to this batch.

## Why the two `missing evidence` rows

- **`SN-2-baseline` (Senegal, SDG 2).** The three registered World Bank agriculture series for Senegal are recorded as unavailable in `catalog/agriculture-statistics.json` → `metadata.unavailable` ("The operation was aborted"), and no observations are retained for Senegal. The baseline cannot be built from the registered evidence as written. This is catalog state, not a judgement.
- **`pilot-tea-5` (Indian tea buyers).** No retained source demonstrates buyer demand or willingness to purchase. A company appearing in a register or an ITC directory is not evidence of purchasing intent, and the question cannot be answered from currently retained sources. The row is kept as a documented evidence gap with a bounded register-review re-scope, not activated.

## Deliberately left alone

- **No live data was touched.** No `research_leads`, `tasks`, `missions`, catalog or `outputs/Lucy` row was written. The patch is a proposed additive file only; `status`, `mission_id` and `task_id` are never written by it.
- **No activation, owner, beneficiary or reviewer invented.** Every refinement uses an explicit beneficiary *placeholder* and a prerequisite that a named human owner and independent reviewer must exist first. All 50 reviewed rows remain `proposed`.
- **No completed research invented.** Where the tea-directive visual review is retained (`catalog/tea-directive-review.json`) it is referenced only as retained evidence for scoping, not as a finished finding; `pilot-tea-2…6` and every baseline state their open questions.
- **No specific national contact, ministry name or URL was fabricated.** Where a country-specific national source is required, the refinement names the *source category* (official statistics office, agriculture ministry, export/customs authority) and states that the actual domain must be located. Only URLs already registered in the catalog are cited (the World Bank WDI series, the SDG framework and M49 pages, the Doha Programme of Action, UNCTAD/ITC, the Cooperation Framework and Resident Coordinator routes, and the tea-pilot official sources).
- **Generic non-theme proposals were not broadened.** Only the agriculture-market-access and LDC-cooperation rows were reviewed; the remaining ~2,948 seeded rows (other goals and stages) were left untouched, since the task asked for a 50-proposal batch, not a full-catalog rewrite.
- **The other four task-12 themes (rights, dependencies, etc.) are folded into each row** rather than split into separate proposals.

## Unresolved evidence dependencies

1. **A named human owner and an independent reviewer** for every proposal. Until these exist, no row may leave `proposed`.
2. **Senegal agriculture series** — re-retrieval of `NV.AGR.TOTL.ZS`, `SL.AGR.EMPL.ZS` and `AG.LND.ARBL.ZS`, or an equivalent official national series, before `SN-2-baseline` can proceed.
3. **Buyer-side evidence** for `pilot-tea-5` — an official import register or buyer disclosure; the gap is the reason for its classification.
4. **Country cooperation-instrument inventory** for the 10 SDG 17 baselines — the current UN LDC list and the current text of each named instrument are not registered in the catalog and must be located from official publishers before any preference or eligibility statement.
5. **Commodity/value-chain selection** for every SDG 2 non-pilot proposal — the producing area and commodity are deliberately unselected; the human owner must choose them from official production statistics rather than the review assuming them.
6. **A current lot and producer/importer pair** for `pilot-tea-3` and `pilot-tea-4`.
7. **Directive currency** for `pilot-tea-1` — confirmation that the retained Directive 02/2026 edition plus Corrigendum 02/04/2026 remain operative, and that the PDFs still match their recorded SHA256 checksums.

## Verification

- `npm run check`, `npm test` and `npm run e2e` were run on this branch; see the final task report for exact output. This change adds two files under `docs/` only, so it does not alter any runtime code, catalog shape or sealed content.
- The patch JSON was parsed and validated: 50 unique keys, ids matching seeded `research_leads` ids, every entry carrying a classification from the fixed set and no `status`/`mission_id`/`task_id` write.

## Known limitations

- The refinement is a *research-scoping* artifact. It does not establish that any proposal's eventual findings will be correct, that a buyer exists, that an institution will engage, or that a country outcome is achievable.
- The classification of the 24 generic rows as `duplicate` is a finding about the seeded catalog design (interchangeable templates), not about the countries. A reviewer may prefer to treat them as `missing evidence` (each names no commodity); the recommendation — consolidate rather than activate — is unchanged.
- 50 rows were reviewed fully; the review is not a sample survey of the whole 2,998-row catalog.

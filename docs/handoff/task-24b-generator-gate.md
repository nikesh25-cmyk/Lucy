# Task 24b handoff — the LDC cooperation evidence gate

## Verdict

- **The report was accurate.** `themeApplies` in `src/civic-engine.js` returned `true` for every theme whose `evidenceGate` was not `'agriculture-series'`, and `ldc-cooperation` carried `"evidenceGate": "none"`. The generator therefore emitted the three goal-17 applied concerns for **all 248 catalog countries**, not only LDCs. Measured below.
- **It was a defect, not intended behaviour.** The catalog's own prose, the theme's own `subjectBasis`, the Task 12 review and the Task 24 handoff all scope this theme to LDC countries. `'none'` was the wrong gate value for a theme whose registered subject evidence is the country's LDC status.
- **What changed:** the theme's `evidenceGate` is now `"ldc-status"`, `themeApplies` reads it, and the catalog documents the gate vocabulary. Applied-concern output for `ldc-cooperation` drops from 744 rows across 248 countries to 132 rows across the 44 LDC countries. **The shipped seeded corpus is unchanged at 1,015 rows**, because seeding only ever covers the 44 LDC catalog entries.

## What the report said, and what I measured

Report: "`themeApplies` returns `true` for any theme whose `evidenceGate` is not `'agriculture-series'`", and the three applied concerns for `ldc-cooperation` (goal 17) are emitted for all 248 countries, e.g. France gets 20 proposals including goal-17 applied concerns.

`src/civic-engine.js:61` (before): `const themeApplies=(country,theme)=>theme.evidenceGate==='agriculture-series'?agricultureRetained(country):true;`
`catalog/research-concerns.json` theme `ldc-cooperation` (before): `"evidenceGate": "none"`.

Measured directly from the shipped planner (248 catalog entries, 44 flagged `ldc`, 204 not):

| theme | gate | countries reached | applied-concern rows |
| --- | --- | --- | --- |
| `agriculture-market-access` | `agriculture-series` | 44 (43 LDC + India) | 132 |
| `ldc-cooperation` | `none` (before) | **248 (44 LDC + 204 non-LDC)** | **744 (132 LDC + 612 non-LDC)** |

Measured through the real platform (`researchGenerate`, temporary database):

- Before: `FR added 20 total 20 goal17 stages baseline,destination,institutions,interventions`; the same for Germany and the United States.
- The generated text for France read literally: `Subject: bilateral, regional or multilateral cooperation or trade-preference instrument available to France. Subject basis: France's current LDC status and graduation timeline …`.

So the report's factual claim is confirmed, and the generated instruction asserts non-existent evidence (France has no LDC status).

## Why it is a defect (evidence)

1. **The catalog's own dedupe rule says the gate is the theme's registered subject evidence.** `catalog/research-concerns.json` → `"dedupe_rule"`: "an applied concern is emitted only for a theme the catalog has scoped, **and only where the theme's registered subject evidence exists for that country**". For `ldc-cooperation` that evidence is named in its own `subjectBasis`: "{country}'s current LDC status and graduation timeline". `"none"` asserted that no country-specific evidence is required, which contradicts the same file's rule.
2. **The theme is LDC-scoped by name and by limit.** `id: "ldc-cooperation"`, `title: "LDC cooperation and trade-preference instruments"`, `limit: "Framework membership and LDC status are not eligibility, funding or partnership…"`. A trade-preference instrument theme has no subject for a country with no LDC status.
3. **Task 12 scoped it that way.** `docs/research/PROPOSAL_REVIEW.md:3` and section C ("SDG 17, Partnerships for the Goals — LDC bilateral cooperation"): "What is Nepal's current LDC status and graduation timeline, and which bilateral, regional and multilateral trade and cooperation instruments does it participate in…".
4. **Task 24 documented it that way.** `docs/handoff/task-24-proposal-generator.md`: "**`ldc-cooperation`** (goal 17): all 44 LDC seeds." `docs/CIVIC_RESEARCH.md`: "LDC cooperation instruments for all 44."
5. **SDG 17 being universal does not carry the theme.** The goal-17 *baseline* is emitted for every country that is generated (unconditionally, `planCountryResearch` emits all 17 baselines). The theme's applied concerns are a narrower, LDC-specific instrument, not "SDG 17 in general".

Counter-argument considered and rejected: "the catalog deliberately set `evidenceGate: 'none'` because SDG 17 has no registered statistical series". The gate value describes the *required country evidence*, not whether a World Bank series exists; the required evidence here is the LDC flag already held in `catalog/countries.json`, so the correct value is a named gate, not `none`.

## What changed

Three files, smallest correct change, no new dependency:

1. `catalog/research-concerns.json`
   - theme `ldc-cooperation`: `"evidenceGate": "none"` → `"evidenceGate": "ldc-status"`.
   - added a top-level `"evidence_gates"` map documenting the three values (`agriculture-series`, `ldc-status`, `none`) so the data states its own semantics. Additive; consumed by no code.
2. `src/civic-engine.js:60-68` — `themeApplies` is now explicit and data-driven:
   ```js
   const themeApplies=(country,theme)=>{
     if(theme.evidenceGate==='agriculture-series')return agricultureRetained(country);
     if(theme.evidenceGate==='ldc-status')return Boolean(country.ldc);
     return true;
   };
   ```
   `none` still means "no country evidence required, applies everywhere"; unknown/absent gates still fall through to `true`, so an unregistered theme map is unaffected.
3. `docs/CIVIC_RESEARCH.md` — the corpus line and the generator section now describe the gate: what `evidenceGate` means, the two registered gates, that no shipped theme uses `none`, and that a country failing a gate keeps its goal baseline plus an explicit collection gap.
4. `tests/research-generator.test.js` — added one test (see below); the existing overlap test that uses `evidenceGate:'none'` now also pins that `none` stays ungated.

### Measured after the change

| theme | gate | countries reached | applied-concern rows |
| --- | --- | --- | --- |
| `agriculture-market-access` | `agriculture-series` | 44 (43 LDC + India) | 132 (unchanged) |
| `ldc-cooperation` | `ldc-status` | **44 (all LDC, 0 non-LDC)** | **132 (was 744)** |

Platform check after: `FR added 17 total 17 goal17 stages baseline`, same for DE/US; `NP total 29`, `SN total 20` unchanged; `catalog_total 1015` unchanged.

Non-LDC goal-17 baseline now reads: `Open scope choices: The registered theme "LDC cooperation and trade-preference instruments" has no retained subject evidence for France; record that collection gap before scoping it.` LDC goal-17 baseline is unchanged.

No behaviour that the task asked to preserve moved: dedupe-by-substantive-question (unique keys, zero consolidations in the shipped map), version history (`recordLead`/`recordRevision` untouched), activation (`researchActivate` untouched), idempotent seeding, and the 1,015-row corpus.

### New test

`tests/research-generator.test.js` → `'the LDC cooperation theme applies only to catalog LDC countries and records the gap elsewhere'`:

- asserts the catalog gate is `'ldc-status'`;
- asserts a non-LDC country (France) gets exactly `FR-17-baseline` for goal 17, 17 baselines total, no applied stage, and its goal-17 baseline records the collection gap without asserting "France's current LDC status";
- sweeps all 248 entries: every LDC gets the goal-17 `destination` row and no non-LDC does (44 total);
- runs the real `researchGenerate` for France and asserts 17 added rows and zero non-baseline goal-17 rows.

## Exact results

Branch `task-24b-generator-gate`, base commit `7d1f9acebd5eb138e5caec6647195ad6e8d97adf` (`verify-batch02-wave-g`), Node v24.19.0, schema 21.

| gate | command | before | after |
| --- | --- | --- | --- |
| Syntax | `npm run check` | exit 0 | exit 0 |
| Unit/integration | `npm test` | 567 tests, 567 pass, 0 fail | **568 tests, 568 pass, 0 fail** |
| HTTP acceptance | `npm run e2e` | 15 steps passed, 0 failed | 15 steps passed, 0 failed |
| Seeded corpus | `research_leads` count | 1,015 | 1,015 (unchanged) |

Both the before and after runs were executed on this worktree; the before run was made with the working-tree change stashed (`git stash push src/civic-engine.js catalog/research-concerns.json docs/CIVIC_RESEARCH.md tests/research-generator.test.js`), so the counts are clean measurements, not the baseline quoted in the task.

## Measured vs inferred

- **Measured:** the gate branch in `themeApplies`; the before/after per-theme country and row counts; the `researchGenerate` results for FR/DE/US/NP/SN; the seeded corpus total; the four command outputs above.
- **Inferred (from the catalog and docs, not from a runtime assertion):** that the *intent* was LDC-only scoping. The evidence is quoted above (`dedupe_rule`, the theme title/limit/`subjectBasis`, Task 12 section C, the Task 24 handoff and `CIVIC_RESEARCH.md`). I did not find any text anywhere in the repository that scopes `ldc-cooperation` to non-LDC countries.
- **Not measured:** whether the real-world LDC flag list (`catalog/countries.json`, retrieved 2026-10-11) is current; the generator treats it as a registered snapshot and every gated proposal still requires current status to be verified.

## Limitations

- The gate is the catalog snapshot flag, not live UN data. A country that graduates (or is added) after 2026-10-11 keeps generating (or not generating) its `ldc-cooperation` rows until the catalog is refreshed.
- This bounds *which countries* receive the theme; it does not make the LDC-cooperation question answerable for any individual country. Its first deliverable is still the instrument selection, and the subject still requires a human owner to name it.
- India is a non-LDC country with a retained agriculture series, so `agriculture-market-access` reaches 44 countries (43 LDC + India), not 43. This is existing behaviour, unchanged here, and is what the `agriculture-series` gate is for.
- Files outside this task's ownership (`app.js`, `docs/COUNTRY_PROGRAMMES.md`, `src/recovery.js`) still describe the older generator; that is the Task 27 agent's scope and is unchanged.

## Migration and rollback

**No schema change. Schema stays 21.** `src/database.js`, `src/recovery.js`, `server.js` and `app.js` were not touched; no table, column, trigger or view changed.

- A fresh install seeds exactly the same 1,015 rows as before (seeding only covers the 44 LDC entries).
- An existing install is unaffected unless an operator calls `researchGenerate` for a non-LDC country. Already-generated non-LDC goal-17 applied rows are **not** deleted or rewritten by this change; `researchGenerate` and `initCivic` leave existing `research_leads` rows alone (generation only inserts missing ids, and revision applies only to `proposed` rows with no task). An operator who wants to remove them can delete those rows explicitly, or record them as consolidated; nothing is automatic.
- **Rollback:** revert this commit (only `src/civic-engine.js` and `catalog/research-concerns.json` affect behaviour; the doc and test changes are inert). No data migration to reverse.
- `git format-patch` for this change is written to `../task-24b-generator-gate.patch`.

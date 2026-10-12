# Task 10 handoff — country source packs, five countries

Date: 2026-10-12. Branch: `task-10-country-packs`. Worktree: `work/t10`. This is a **research deliverable**: it only adds files under `docs/research/country-packs/` and this handoff. It activates nothing, changes no source, catalog or runtime file, and touches no `outputs/Lucy` path.

## What was delivered

New files (all under the worktree, none previously tracked):

- `docs/research/country-packs/README.md` — index: why these countries, shared providers, honesty statement.
- `docs/research/country-packs/country-packs.json` — the full machine-readable record (5 packs, every statement/value/URL/location/date).
- `docs/research/country-packs/nepal.md`, `bangladesh.md`, `ethiopia.md`, `cambodia.md`, `senegal.md` — one concise pack per country.
- `docs/research/country-packs/sources/trade/` — 10 retained UN Comtrade preview responses plus `comtrade-preview-manifest.json` (query URLs, row counts, SHA256, flags, and the zero-row queries).
- `docs/research/country-packs/sources/statistics/` — 3 retained Senegal World Bank WDI responses (raw bytes + checksums).

Each pack contains: agriculture baseline; practical export-eligibility routes; market-access questions; official institutions; public contact routes; current source dates; and an explicit evidence-gaps section.

## Which countries and why

Nepal is the required anchor. The four added countries are LDC entries in the dated M49 snapshot in `catalog/countries.json` (retrieved 2026-10-11; 248 entries, 44 flagged LDC), chosen for maximum legitimate diversity of region, corridor and regulator:

| Country | Corridor (research only) | Why chosen |
| --- | --- | --- |
| Nepal (NPL) | Tea → India | Required anchor; already carries a sourced pilot record and a 2026 India regulatory change |
| Bangladesh (BGD) | Jute goods / frozen shrimp → EU candidate | Largest LDC population, strong published institutions, different regulator set |
| Ethiopia (ETH) | Green coffee → Germany (EU) | Large African LDC with a distinct export regulator; preview returned real observations |
| Cambodia (KHM) | Milled rice → China | South-East Asian LDC with a formal rice-corridor record |
| Senegal (SEN) | Fresh horticulture (banana) → EU | West African LDC with a reachable ministry; its prior WDI gap is documented, not hidden |

Different regions, different destinations (land border, EU, China), one tightly scoped product corridor each. LDC flags are a dated snapshot, not a political statement, and the packs say so (Bangladesh, Cambodia and Senegal have their own graduation timelines).

## What was actually verified (with the route used)

- **World Bank WDI annual context** for all five countries (Nepal, Bangladesh, Ethiopia, Cambodia from the retained 2026-10-11 snapshots; **Senegal fetched fresh 2026-10-12** because the catalog recorded it as unavailable). Sector-value-added, employment (modelled ILO estimate) and arable-land series, each with dataset-update date 2026-10-08, retrieval date and raw snapshot reference.
- **UN Comtrade public preview** (`comtradeapi.un.org`) bounded annual queries, retained byte-for-byte with SHA256:
  - Ethiopia → Germany HS 090111, 2022 and 2023; Ethiopia → World HS 0901 and HS 1207, 2023;
  - Cambodia → China HS 100630, 2022 and 2023; Cambodia → World HS 100630 and HS 071410 (cassava), 2023;
  - Senegal → World HS 0803 and HS 0303, 2023.
- **Official institutional pages read directly (2026-10-12)** with the exact URL and the title/contact block observed: Nepal (moafe.gov.np, dftqc.gov.np over HTTP, teacoffee.gov.np, nsonepal.gov.np, customs.gov.np); Bangladesh (moa.gov.bd, dae.gov.bd over HTTP, barc.gov.bd, epb.gov.bd and its officer directory, nbr.gov.bd, bbs.gov.bd); Ethiopia (moa.gov.et and its affiliated-institutions page); Cambodia (maff.gov.kh contact page, nis.gov.kh); Senegal (agriculture.gouv.sn and its contacts page, ansd.sn, douanes.sn, asn.sn).
- **Public contact routes** recorded are **published institutional channels only** — ministry/agency mailboxes, role/desk addresses on the EPB officer directory, switchboard numbers and postal addresses. No guessed personal contact was used.

## What remains unverified (recorded as gaps, not filled)

- **No buyer demand and no willingness to buy for any country.** A directory listing, a federation statement or a procedural notice is not a committed buyer. The already-reviewed India Tea Board buyer notice (`catalog/buyer-notice-review.json`) is explicitly a procedural notice with an unassessed annexure.
- **No Nepal tea figure** — bounded Comtrade previews returned zero rows (Nepal→India, Nepal→World, India mirror).
- **No Bangladesh figure** — every bounded query returned a zero-row preview, including codes other reporters answered. Recorded as a provider-coverage gap.
- **No Senegal→Germany banana figure** — zero-row preview.
- **No national production/harvested-area figures** — FAOSTAT's interface yields no extractable table text and its API host was not reachable; the Ethiopian statistics agency and Cambodia's Ministry of Commerce / Ministry of Economy and Finance sites were unreachable (403 / under maintenance); the Ethiopian Coffee and Tea Authority site did not respond.
- **No tariff, quota, licence, SPS/TBT, price, volume, seasonality or logistics figure** was verified for any corridor.
- **ITC Market Analysis Tools** returned HTTP 403; no account or plan was attempted and no ITC number is quoted.
- No producer, processor, grade, port, destination beyond the single candidate, beneficiary or reviewer has been selected.

## Confirmation on outreach and activation

**No message was sent to any institution, buyer or contact route.** No mission, task, scope, approved host, credential or account was created or activated. No real pilot is selected. The packs use explicit research questions and recorded gaps rather than fabricated outcomes.

## Verification run

- `npm run check` — passed (all listed `node --check` targets clean; no syntax errors). Output showed only the script banner and no failures.
- `npm test` — **pass 341, fail 0, cancelled 0, skipped 0, todo 0** (duration ≈ 100.7 s).
- No application, catalog, runtime or test file was modified, so these gates were expected to be unaffected; they confirm nothing was broken. `docs/research/` was previously untracked, so the only git change is added files.

## Notes for the reviewer

- The task brief listed `docs/STATISTICS.md`; that file does not exist in this worktree. The closest document is `docs/STATISTICS_COLLECTION.md`, and the agriculture-baseline method used here follows it.
- Nepal's agriculture ministry has been renamed in the current site ("Ministry of Agriculture, Forest and Environment"); older references use "Ministry of Agriculture and Livestock Development" (`moald.gov.np`). Both names are recorded.
- The Senegal WDI snapshots are a **new collection**, not a reviewed catalog installation; installing them into `catalog/` would be a separate, reviewed step.
- Retained Comtrade rows where `isReported` is false are aggregate/derived records, and two annual points cannot establish a trend; the packs say so.

# Country source pack — Ethiopia (ETH)

Researched 2026-10-12. Research artifact only: **no pilot selected, no mission or task activated, no message sent**. Machine-readable record: [`country-packs.json`](country-packs.json) (pack "Ethiopia").

## Scope

- **Origin product corridor (research only):** green coffee (arabica), HS 0901.
- **Destination:** Germany as an EU candidate destination.
- **Why Ethiopia:** a large African LDC with a distinct export regulator; coffee is its best-documented agricultural export, and the public Comtrade preview produced **actual bounded observations** for the Ethiopia–coffee corridor.

## Agriculture baseline

Annual World Bank WDI context (retrieved 2026-10-11; dataset updated 2026-10-08). Sector context only.

| Indicator | Unit | Earliest (2015) | Latest | Note |
| --- | --- | --- | --- | --- |
| Agriculture, forestry, fishing value added | % of GDP | 36.06 | 32.82 (2025) | Includes forestry and fishing |
| Employment in agriculture | % of total employment | 67.96 | 60.14 (2025) | **Modelled ILO estimate** |
| Arable land | % of land area | 14.00 | 14.61 (2024) | Land class, not available farmland |

Raw snapshots: `catalog/statistics/ETH-*.json`.

**National statistics route:** the Ethiopian statistics agency site (`statsethiopia.gov.et`) was **not reachable** (2026-10-12); no national production figure was retrieved.

## Trade observation (bounded UN Comtrade public preview, 2026-10-12)

Single annual provider rows, retained byte-for-byte under `sources/trade/` with SHA256.

| Query | Year | Primary value (USD) | Net weight (kg) | Reported | Aggregate |
| --- | --- | --- | --- | --- | --- |
| Ethiopia → Germany, HS 090111 | 2022 | 237,279,426.68 | 48,379,010 | yes | no |
| Ethiopia → Germany, HS 090111 | 2023 | 110,602,673.50 | 24,202,210 | yes | no |
| Ethiopia → World, HS 0901 | 2023 | 1,225,642,096.91 | 236,075,527.82 | no (derived) | yes |
| Ethiopia → World, HS 1207 (oilseeds) | 2023 | 258,605,062.39 | 145,686,807.95 | no (derived) | yes |

Where `reported` is false the row is an aggregate/derived record, not a directly reported national submission. **Two annual points cannot establish a trend**, and the 2022→2023 decline in the Germany corridor is an observation only. Historical trade does not establish current demand, capacity or eligibility.

## Practical export-eligibility routes (still to be verified)

1. **Coffee export authorisation.** Confirm which body currently authorises coffee export and the current licence/quality-verification route. The Ethiopian Coffee and Tea Authority is listed by the Ministry of Agriculture as an affiliated institution (https://www.moa.gov.et/affiliated-institutions/, read 2026-10-12); the authority's own site did not respond.
2. **Customs export declaration.** Confirm the current procedure and any single-window/e-licence route. The ministry site names a National Single Window and an E-License system as public services, but the procedure text was not read.
3. **Farming-practice and provenance documentation for EU entry.** Confirm whether the destination requires farm-level traceability or a specific scheme for the scoped grade — not verified.

## Market-access questions

1. Which coffee grade and processing method is in scope, and how is it classified at export and import?
2. Does the EU destination impose a current SPS/TBT or due-diligence requirement beyond standard customs, and which notification states it?
3. Which Ethiopian body issues the export authorisation and the quality certificate, and is its current procedure documented online?
4. What is the current Ethiopia–Germany or Ethiopia–EU tariff and origin treatment for the scoped grade?
5. Is there primary-source evidence of buyer demand rather than a trade-directory entry?

## Official institutions and public contact routes

All routes are **published institutional channels** and were **not contacted**.

| Institution | URL | Role | Contact route | Read |
| --- | --- | --- | --- | --- |
| FDRE Ministry of Agriculture | https://www.moa.gov.et/ | Federal agriculture ministry; supervises sector institutions | info@moa.gov.et · +251 11646 21 99 | 2026-10-12 |
| Ethiopian Coffee and Tea Authority | https://ethiocta.gov.et/ | Coffee/tea sector authority (Council of Ministers mandate) | Not exposed; site unreachable | 2026-10-12 |
| Ethiopian Agricultural Authority | https://www.eaa.gov.et/ | Affiliated agricultural authority | Link observed only | 2026-10-12 |
| Ethiopian Agricultural Research Institute | http://www.eiar.gov.et/ | Agricultural research | Link observed only | 2026-10-12 |

The authority and institute links were observed as outgoing links on the ministry's affiliated-institutions page; their own sites were not read.

## Source dates

World Bank dataset update 2026-10-08 · WDI retrieved 2026-10-11 · sites read 2026-10-12 · Comtrade queries run 2026-10-12.

## Evidence gaps

- The Ethiopian statistics agency and the Coffee and Tea Authority sites were **unreachable**, so no national production figure and no coffee-authority procedure were read.
- **No committed buyer and no evidence of willingness to buy.** No importer list is asserted.
- Current coffee export authorisation and quality-verification procedures were **not** verified from the authority's own source.
- The current Ethiopia–Germany tariff and origin treatment was **not** verified.
- **Only HS 090111** was queried; roasted and decaffeinated coffee forms remain unqueried.
- No producer, cooperative, grade, or destination beyond the single candidate was selected.

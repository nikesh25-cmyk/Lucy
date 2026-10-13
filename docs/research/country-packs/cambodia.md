# Country source pack — Cambodia (KHM)

Researched 2026-10-12. Research artifact only: **no pilot selected, no mission or task activated, no message sent**. Machine-readable record: [`country-packs.json`](country-packs.json) (pack "Cambodia").

## Scope

- **Origin product corridor (research only):** milled rice, HS 100630, with cassava (HS 071410) as a secondary observation.
- **Destination:** China as the candidate destination for milled rice.
- **Why Cambodia:** a South-East Asian LDC with a formal rice export-corridor record; the public Comtrade preview produced bounded observations for Cambodia → China milled rice and world cassava.

## Agriculture baseline

Annual World Bank WDI context (retrieved 2026-10-11; dataset updated 2026-10-08). Sector context only.

| Indicator | Unit | Earliest (2015) | Latest | Note |
| --- | --- | --- | --- | --- |
| Agriculture, forestry, fishing value added | % of GDP | 20.14 | 16.11 (2025) | Includes forestry and fishing |
| Employment in agriculture | % of total employment | 42.47 | 33.40 (2025) | **Modelled ILO estimate** |
| Arable land | % of land area | 22.33 | 23.34 (2024) | Land class, not available farmland |

Raw snapshots: `catalog/statistics/KHM-*.json`. National route: National Institute of Statistics — https://www.nis.gov.kh/ (read 2026-10-12).

## Trade observation (bounded UN Comtrade public preview, 2026-10-12)

Single annual provider rows, retained byte-for-byte under `sources/trade/` with SHA256.

| Query | Year | Primary value (USD) | Net weight (kg) | Reported | Aggregate |
| --- | --- | --- | --- | --- | --- |
| Cambodia → China, HS 100630 (milled rice) | 2022 | 163,229,307.64 | 279,526,175 | yes | no |
| Cambodia → China, HS 100630 | 2023 | 126,648,899.74 | 198,087,184 | no (derived) | yes |
| Cambodia → World, HS 100630 | 2023 | 454,303,235.00 | 647,349,914.92 | no (derived) | yes |
| Cambodia → World, HS 071410 (cassava) | 2023 | 166,131,077.28 | 2,413,187,653.40 | no (derived) | yes |

The world-total row and the China-partner row are **not additive** across classification bases and must not be summed or read as a trend from two points. Historical trade does not establish current demand, capacity or eligibility.

## Practical export-eligibility routes (still to be verified)

1. **Milled rice export registration and quota route.** Confirm which authority currently registers rice exporters and whether a destination quota or registration arrangement applies — candidate, not yet verified. The Ministry of Commerce site was **unavailable** ("Site Under Maintenance", HTTP 403, 2026-10-12), so this route could not be read.
2. **Sanitary/phytosanitary certification.** Confirm which body issues the phytosanitary certificate and its current conditions. The Ministry of Agriculture, Forestry and Fisheries site lists a National Single Window and an E-License public-service route (https://www.maff.gov.kh/contactus?lang=en, read 2026-10-12).
3. **Destination-side import rules for rice.** Confirm the current Chinese import requirements and any quota/registration arrangement for Cambodian milled rice — not verified.

## Market-access questions

1. Which milled rice grade and packaging is in scope, and how is it classified at export and import?
2. Is there a current destination quota, registered-exporter arrangement or import licence for the scoped grade?
3. Which certificate(s) are mandatory at origin and which body issues each?
4. Do current SPS/TBT notifications apply to the scoped product, and does the destination require a specific treatment?
5. Is there primary-source evidence of buyer demand rather than a federation statement or directory listing?

## Official institutions and public contact routes

All routes are **published institutional channels** and were **not contacted**.

| Institution | URL | Role | Contact route | Read |
| --- | --- | --- | --- | --- |
| Ministry of Agriculture, Forestry and Fisheries | https://www.maff.gov.kh/ | Agriculture, forestry and fisheries | info@maff.gov.kh · (855) 23 726128 / 23 726 129 · No 200, Preah Norodom Blvd (41), Tonle Bassac, Chamkarmon, Phnom Penh | 2026-10-12 |
| National Institute of Statistics | https://www.nis.gov.kh/ | National statistics | info@nis.gov.kh | 2026-10-12 |
| Ministry of Commerce | https://www.moc.gov.kh/ | Commerce ministry (expected trade/export promotion) | Not available — HTTP 403 "Site Under Maintenance" | 2026-10-12 |
| Ministry of Economy and Finance | https://www.mef.gov.kh/ | Economy/finance (expected customs/tariff) | Not available — HTTP 403 | 2026-10-12 |

## Source dates

World Bank dataset update 2026-10-08 · WDI retrieved 2026-10-11 · sites read 2026-10-12 · Comtrade queries run 2026-10-12.

## Evidence gaps

- The **Ministry of Commerce** site was under maintenance (HTTP 403), so the current export-registration and rice-corridor routes were not verified.
- The **Ministry of Economy and Finance** (expected customs/tariff remit) returned HTTP 403 and was not read.
- **No national production or harvested-area figure** was retrieved (FAOSTAT not extractable; NIS figures not downloaded).
- **No committed buyer and no evidence of willingness to buy.**
- No producer, miller, grade, port or destination beyond the single candidate was selected.

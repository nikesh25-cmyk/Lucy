# Country source pack — Nepal (NPL)

Researched 2026-10-12. Research artifact only: **no pilot selected, no mission or task activated, no message sent**. Machine-readable record: [`country-packs.json`](country-packs.json) (pack "Nepal").

## Scope

- **Origin product corridor (research only):** tea and similar hill-grown speciality crops, using tea as the worked example.
- **Destination:** India, over the land-border corridor.
- **Why Nepal:** the required anchor country. It already carries a sourced starter pilot record (`catalog/agriculture-pilot.json`, researchedOn 2026-10-11) and a documented 2026 change in Indian tea-import regulation, so this pack reuses verified work rather than repeating it.

## Agriculture baseline

Annual World Bank WDI context (retrieved 2026-10-11; dataset updated 2026-10-08). This is sector context, **not** crop revenue, land availability or export eligibility.

| Indicator | Unit | Earliest (2015) | Latest | Note |
| --- | --- | --- | --- | --- |
| Agriculture, forestry, fishing value added | % of GDP | 26.52 | 21.56 (2025) | Includes forestry and fishing |
| Employment in agriculture | % of total employment | 26.34 | 22.91 (2025) | **Modelled ILO estimate** |
| Arable land | % of land area | 14.18 | 12.58 (2024) | Land class, not available farmland |

Raw snapshots: `catalog/statistics/NPL-*.json`. National route: National Statistics Office, Thapathali, Kathmandu — https://nsonepal.gov.np/ (read 2026-10-12).

**Trade observation:** none obtained. Every bounded UN Comtrade preview for Nepal tea returned a zero-row preview (see gaps).

## Practical export-eligibility routes (still to be verified)

1. **Nepal export documentation route.** Confirm the current exporter registration/export-licence route and issuing authority. A Department of Customs notice of 2082-09-04 (printed on https://customs.gov.np/, read 2026-10-12) changed certain transit/routing arrangements, so any checklist must be re-dated.
2. **Origin food-safety certification.** Confirm whether a Department of Food Technology and Quality Control export certificate is required for the specific grade and destination, and its current fee/validity. http://www.dftqc.gov.np/ (read 2026-10-12; separate phone lines shown for food import/export matters).
3. **Preferential India access.** Recover the current consolidated Nepal–India trade-treaty text, any amendment, and the applicable Indian customs notification. `catalog/agriculture-pilot.json` records that the published treaty text provides certificate-of-origin arrangements but that **no current tariff or exemption was confirmed**.
4. **Indian destination-side import clearance.** Establish which edition of the Tea Board India directive applies to the intended shipment date and whether the FSSAI testing route and notified laboratory are valid for that grade. Sources `tea-directive-01`, `tea-corrigendum`, `tea-directive-02` and `tea-labs` in `catalog/agriculture-pilot.json` are dated 2026 official PDFs.

## Market-access questions

1. Which exact grade, packaging and border point is in scope, and does the India tea-import SOP for that grade apply at the intended shipment date? (Directive 02/2026 supersedes the earlier directive and corrigendum, so older checklists need reconciliation.)
2. What is the current, consolidated Nepal–India preferential tariff and certificate-of-origin requirement for that grade?
3. Is a Nepal-issued phytosanitary or food-safety certificate required, and which body issues it?
4. Do current Indian SPS/TBT notifications add requirements beyond the Tea Board directive?
5. What evidence exists for actual buyer demand rather than a procedural notice? (None was established — see gaps.)

## Official institutions and public contact routes

All routes are **published institutional channels** and were **not contacted**.

| Institution | URL | Role | Contact route | Read |
| --- | --- | --- | --- | --- |
| Ministry of Agriculture, Forest and Environment | https://moafe.gov.np/ | Federal agriculture/forestry/environment policy | info@moafe.gov.np | 2026-10-12 |
| Department of Food Technology and Quality Control | http://www.dftqc.gov.np/ | Food technology and quality control | info@dftqc.gov.np · suchana@dftqc.gov.np | 2026-10-12 |
| National Tea and Coffee Development Board | https://www.teacoffee.gov.np/ | Tea/coffee sector board; statistics, producer lists | info@ntcdb.gov.np | 2026-10-12 |
| National Statistics Office | https://nsonepal.gov.np/ | National statistics | info@nsonepal.gov.np | 2026-10-12 |
| Department of Customs | https://customs.gov.np/ | Customs administration | csd@customs.gov.np | 2026-10-12 |

Note on naming: older references use "Ministry of Agriculture and Livestock Development" (`moald.gov.np`). The site now presents the merged "Ministry of Agriculture, Forest and Environment". The `info@ntcdb.gov.np` route is already recorded in `catalog/agriculture-pilot.json`.

## Source dates

World Bank dataset update 2026-10-08 · WDI retrieved 2026-10-11 · sites read 2026-10-12 · Comtrade queries run 2026-10-12 · pilot record researchedOn 2026-10-11.

## Evidence gaps

- **No Nepal tea trade value or volume was confirmed.** Bounded Comtrade previews returned zero rows for: Nepal exports HS 0902 to India 2023; Nepal exports HS 0902 to World 2023; India mirror imports from Nepal 2023. Zero-row previews are gaps, not zero trade.
- **No committed buyer and no evidence of willingness to buy.** The already-reviewed India Tea Board buyer response notice (`catalog/buyer-notice-review.json`, 2026-10-12) is a procedural notice with an unassessed annexure, explicitly not a positive importer directory.
- Current consolidated treaty text and the applicable Indian customs notification were **not** re-fetched.
- The applicable edition of the Indian directive for an intended shipment date remains unverified.
- No producer, municipality, grade, packaging or border point selected.
- The national agriculture statistical yearbook and the ministry contact page were not downloaded.

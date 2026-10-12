# Country source pack — Senegal (SEN)

Researched 2026-10-12. Research artifact only: **no pilot selected, no mission or task activated, no message sent**. Machine-readable record: [`country-packs.json`](country-packs.json) (pack "Senegal").

## Scope

- **Origin product corridor (research only):** fresh horticulture, using banana (HS 0803) as the worked example; marine products (HS 0303) as the alternative.
- **Destination:** the European Union, Germany as the candidate destination for banana.
- **Why Senegal:** a West African LDC with a reachable agriculture ministry and its own statistics agency. `catalog/agriculture-statistics.json` previously recorded a Senegal WDI collection failure, and **part of that failure was resolved in this batch**, so the gap itself is documented rather than hidden.

## Agriculture baseline

Annual World Bank WDI context. The three series were retrieved fresh on **2026-10-12** (dataset updated 2026-10-08) and retained under `sources/statistics/`, because the catalog records this country's earlier collection as unavailable (operation aborted 2026-10-11).

| Indicator | Unit | Earliest (2015) | Latest | Note |
| --- | --- | --- | --- | --- |
| Agriculture, forestry, fishing value added | % of GDP | 14.28 | 17.08 (2025) | Includes forestry and fishing |
| Employment in agriculture | % of total employment | 33.33 | 29.58 (2025) | **Modelled ILO estimate** |
| Arable land | % of land area | 18.98 | 19.89 (2024) | Land class, not available farmland |

National route: Agence Nationale de la Statistique et de la Démographie (ANSD) — https://www.ansd.sn/ (read 2026-10-12), which publishes publications, principal indicators and data-use licence information.

## Trade observation (bounded UN Comtrade public preview, 2026-10-12)

Single annual provider rows, retained byte-for-byte under `sources/trade/` with SHA256.

| Query | Year | Primary value (USD) | Net weight (kg) | Reported | Aggregate |
| --- | --- | --- | --- | --- | --- |
| Senegal → World, HS 0803 (bananas) | 2023 | 43,408.16 | 72,860 | no (derived) | yes |
| Senegal → World, HS 0303 (fish, frozen) | 2023 | 259,078,632.10 | 232,475,116 | no (derived) | yes |

Both rows are aggregate/derived. The banana world figure is small in value terms while the fish world figure is large — a factual observation only, **not** a recommendation. The Germany-partner banana query returned **no rows** (see gaps).

## Practical export-eligibility routes (still to be verified)

1. **Horticultural export authorisation and quality control.** Confirm which body currently authorises horticultural exports and the current quality control route. The ministry site lists a national horticulture forum and its directions/services (https://agriculture.gouv.sn/, read 2026-10-12), but the procedure text was not read.
2. **Customs export declaration.** Confirm the current procedure and any electronic route. The customs site (https://www.douanes.sn/) was reachable but the specific contact path returned **HTTP 404**; the procedure was not read.
3. **Destination-side plant-health entry requirements.** Confirm which plant-health certificate and pest-related conditions the EU destination requires for the scoped product — not verified.

## Market-access questions

1. Which fresh product, variety and packaging is in scope, and how is it classified at export and import?
2. Which Senegalese body issues the export authorisation and the plant-health certificate, and is its current procedure documented online?
3. What EU entry conditions apply, and does any current SPS/TBT notification change them?
4. What is the current tariff and origin treatment, and does any preference apply?
5. Is there primary-source evidence of buyer demand rather than a directory listing or trade-fair presence?

## Official institutions and public contact routes

All routes are **published institutional channels** and were **not contacted**.

| Institution | URL | Role | Contact route | Read |
| --- | --- | --- | --- | --- |
| Ministère de l'Agriculture, de la Souveraineté alimentaire et de l'Élevage (MASAE) | https://agriculture.gouv.sn/ | Agriculture, food sovereignty and livestock | assistance@agriculture.gouv.sn · +221 33 859 65 99 · Sphère Ministérielle de Diamniadio, Ousmane Tanor Dieng, Dakar | 2026-10-12 |
| Agence Nationale de la Statistique et de la Démographie (ANSD) | https://www.ansd.sn/ | National statistics | statsenegal@ansd.sn · [+221] 33 869 21 39 | 2026-10-12 |
| Direction générale des Douanes | https://www.douanes.sn/ | Customs administration | Not exposed (contact path 404) | 2026-10-12 |
| Agence Sénégalaise de Normalisation (ASN) | http://www.asn.sn/ | Standards body | Not read in detail | 2026-10-12 |

## Source dates

World Bank dataset update 2026-10-08 · Senegal WDI retrieved 2026-10-12 · sites read 2026-10-12 · Comtrade queries run 2026-10-12.

## Evidence gaps

- `catalog/agriculture-statistics.json` records the Senegal WDI series as **unavailable** (operation aborted, 2026-10-11). Three series were retrieved fresh on 2026-10-12 and retained, but this is a **new collection**, not a reviewed catalog installation.
- **No Senegal trade value for the EU/Germany corridor was confirmed** — the Germany-partner banana query returned zero rows (a gap, not zero trade).
- The customs contact path returned HTTP 404 and the customs export procedure was not read.
- **No national production or yield figure** was retrieved.
- **No committed buyer and no evidence of willingness to buy.**
- No producer, exporter, product variety, port or destination beyond the single candidate was selected.

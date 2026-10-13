# Country source packs — index (batch 1)

Researched 2026-10-12. This folder holds dated, primary-sourced country packs for **one anchor country (Nepal)** and **four additional LDC countries**. They are research artifacts. No pilot is selected, no mission or task was activated, and **no message was sent to any institution, buyer or contact route**.

- Machine-readable: [`country-packs.json`](country-packs.json) — every statement, value, URL, location and date in one file.
- Retained source bytes: [`sources/trade/`](sources/trade/) (UN Comtrade previews, with a manifest and SHA256 checksums) and [`sources/statistics/`](sources/statistics/) (Senegal World Bank WDI snapshots).

## Packs

| Country | ISO3 | Scoped corridor (research only) | Pack |
| --- | --- | --- | --- |
| Nepal | NPL | Tea (hill speciality crops) → India | [nepal.md](nepal.md) |
| Bangladesh | BGD | Jute goods and frozen shrimp → candidate EU / South Asia | [bangladesh.md](bangladesh.md) |
| Ethiopia | ETH | Green coffee (arabica) → Germany (EU candidate) | [ethiopia.md](ethiopia.md) |
| Cambodia | KHM | Milled rice → China (cassava as secondary observation) | [cambodia.md](cambodia.md) |
| Senegal | SEN | Fresh horticulture (banana) → EU candidate (marine products alternative) | [senegal.md](senegal.md) |

## Why these five countries

Nepal is the required anchor. The four added countries are LDC entries in the dated M49 snapshot retained in `catalog/countries.json` (retrieved 2026-10-11; 248 entries, 44 flagged LDC), chosen for **maximum legitimate diversity of region, corridor and regulator**:

- different regions — South Asia, East Africa, South-East Asia, West Africa;
- different destination patterns — a land border (India), the EU, China;
- each has a reachable official agriculture ministry and a national statistics instance;
- each has at least one bounded, checkable trade observation **or** a recorded provider gap, so the pack's limits are visible.

LDC flags are a dated statistical snapshot, not a political statement. Bangladesh is scheduled to graduate from LDC status and Cambodia and Senegal have their own graduation timelines; refresh the flag before relying on it. M49 is a catalog of countries **or areas**, not a list of sovereign states.

## Every pack contains

1. Agriculture baseline — annual World Bank WDI context plus the national statistics route.
2. Practical export-eligibility routes — the steps a producer would have to walk, stated as routes still to be verified.
3. Market-access questions — explicit research questions.
4. Official institutions — name, URL, role, and the date the page was actually read.
5. Public contact routes — published institutional channels only.
6. Current source dates.
7. Evidence gaps — what could not be reached or confirmed.

## Shared dataset providers (used by all packs)

| Provider | URL | Access in this batch |
| --- | --- | --- |
| World Bank WDI (API v2, source 2) | https://api.worldbank.org/v2/ | Reachable; snapshots retained in `catalog/agriculture-statistics.json` (2026-10-11) and, for Senegal, in `sources/statistics/` (2026-10-12) |
| UN Comtrade preview API | https://comtradeapi.un.org/public/v1/preview/C/A/HS | Reachable without a key; bounded subset only |
| FAOSTAT | https://www.fao.org/faostat/ | Landing app reachable, no extractable table text; API host not reachable |
| ITC Market Analysis Tools | https://marketanalysis.intracen.org/en | HTTP 403 (access restricted); no account attempted |
| WTO ePing / WTO data | https://eping.wto.org/en/ · https://data.wto.org/en | Reachable; not yet queried for specific codes |
| UNSD M49 | https://unstats.un.org/unsd/methodology/m49/overview/ | Retained snapshot in `catalog/countries.json` |

## Verification honesty

- Numbers come from two providers only: **World Bank WDI** (annual sector context; the employment series is a modelled ILO estimate) and **UN Comtrade public preview** (single annual rows, some aggregate/derived). Every value is dated and, for Comtrade, retained byte-for-byte with a SHA256.
- **Zero-row Comtrade previews and unreachable pages are recorded as gaps, not filled in.** Notably, no Nepal tea figure, no Bangladesh figure and no Senegal-to-Germany figure was obtained.
- No FAOSTAT or ITC figure is quoted, because neither could be extracted or accessed.
- **No buyer demand and no willingness to buy was established for any country.** A directory listing, a federation statement or a procedural notice is not a committed buyer.
- All contacts are published institutional channels and were **not contacted**.

## Limits

Annual sector context cannot establish crop demand, buyer interest, export eligibility, land availability or investment returns. Historical trade does not establish current demand, supplier capacity, shipment eligibility, price or financing. These packs are starting points for human-scoped research; they are not advice and not a shipment plan.

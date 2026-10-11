# Country agriculture evidence

Lucy exposes three registered World Bank WDI annual series for country research:

- Agriculture, forestry, and fishing value added (% of GDP).
- Employment in agriculture (% of total employment), **modeled ILO estimate**.
- Arable land (% of land area).

The retained 11 October 2026 catalog contains 132 series and 1,452 annual records for 44 countries: 43 of the 44 LDCs in the dated UN M49 catalog, plus India. All covered countries retain all three series; this does not mean every annual value is reported. Senegal's three requests timed out in the initial LDC batch and one retry, so no Senegal snapshot is claimed. Other countries have official research routes without retained findings. Country coverage filters and cards distinguish retained series from those with nonmissing observations.

Each snapshot includes observation years, units, provider-declared dataset update, retrieval day, original provider, reuse terms, raw-response SHA256 and retained raw JSON. Dataset update is **not** publication or observation date. Country views show values rounded to two decimals; JSON exports retain exact normalized values. World Bank identifies these indicator datasets as CC BY 4.0; attribution identifies WDI and the original providers. See https://data.worldbank.org/summary-terms-of-use and the linked indicator definitions.

## Research workflow

`GET /api/v1/country-evidence?country=NP` returns the country, three official source routes, and a retained snapshot if present. No automatic network refresh is implied.

Unactivated SDG 2 baseline proposals now include the three API routes alongside the SDG and UN M49 framework records. Existing activated tasks and their approved domains are preserved. Human activation, scoped worker execution, independent review and recorded adoption remain required.

The worker's registered JSON reader accepts only known catalog countries, these three indicators, source 2, JSON format, one complete page, and the fixed annual window. It validates response country/indicator identity, unique years, percentage bounds, units, missing values, metadata and byte limits. Public HTTPS host approval, DNS address checks, pinned TLS connection, redirect refusal and execution deadlines apply. Other JSON APIs remain unsupported.

Exact statistical observations are rendered from validated records. Model prose citing statistical sources cannot contain digits other than application citation markers. A numeric or unusable statistics-only model draft is withheld; validated evidence can still be submitted for human review. This conservative filter does not establish general factual grounding, arithmetic competence or prompt-injection robustness. Words and qualitative claims still require review.

## Evidence limits

These series describe national sector context. They do not establish crop demand, buyer interest, export eligibility, available farmland, tenure, soil quality, irrigation, returns or shipment approval. The employment series is a modeled estimate. Provider footnotes were not requested; indicator and country metadata require further review. The catalog is a dated snapshot, not a live data service. A curator collection command stages bounded source reads, raw files, exact checksums and collection gaps; failed refreshes retain previous verified data. Each series has its own retrieval date. See docs/STATISTICS_COLLECTION.md.

Live verification retrieved all three Nepal series through the secured source reader. A separate actual Qwen3-4B worker run reached pending review in an isolated QA world with three live sources and a valid audit chain. The model draft was unusable and withheld; exact statistical observations were retained. No production account, independent acceptance, adoption or outbound contact was created by that verification.

Verification: 144 automated tests passed; the expanded statistics integration also verifies the unusable-draft fallback. Browser verification covers dated figures and a missing observation in the annual table.

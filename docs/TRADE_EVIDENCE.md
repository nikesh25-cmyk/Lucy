# Agricultural trade evidence

Verified 11 October 2026. Lucy now builds and reads bounded annual UN Comtrade agricultural previews for approved research tasks.

## Use

In World Assembly, choose a reporter, partner, year, agricultural HS4/HS6 commodity and reporter import/export flow. Build and copy the source URL. A human must approve the mission scope and `comtradeapi.un.org` host before a worker can read it. The form generates a URL without fetching, activating a mission or granting permission.

The reader supports one year (2015–2026), one catalog country/area, one partner (or World), one commodity in chapters 01–24 and imports/exports. Current M49 codes are candidates, not a verified provider coverage directory. Returned identities are checked, including the provider's World marker W00; geography exceptions require separate review. Keys, extra query parameters, broad queries, other flows and historical geography are refused. The existing public-DNS pinning, verified TLS, redirect refusal, fifteen-second fetch deadline and one-megabyte response limit apply.

## Evidence retained

The worker keeps the exact URL, retrieval date and raw-response SHA256. A zero-row preview becomes an explicit evidence gap. A single matching row preserves primary trade value, CIF/FOB fields, actual HS revision, original-classification/reported/aggregate flags, quantities, unit codes and estimation flags. Missing numeric values remain null; unknown quantity units remain unknown. Multiple rows, mismatched identities, malformed flags, negative/nonfinite amounts and inconsistent counts are refused for review. This is deliberately narrower than the provider's full API.

Historical trade does not establish current buyer demand, supplier capacity, shipment eligibility, pricing or financing. Reporter exports and partner mirror imports are separate observations with potentially different valuation practices. No inferred unit values, reconciliation, complete coverage or latest-release claim is made.

## Verification

All 175 tests passed, including URL/schema safeguards, source hashes, private DNS rejection and an isolated worker submission. Submission remains pending independent review; it does not enter the accepted gallery automatically.

The live DNS-pinned reader successfully returned one China-to-World HS 010614 export record for 2023: primary value USD 556,554; H6; original classification true; reported false; aggregate true; net weight 14,832 kg. This is a technical integration example, not an agriculture recommendation. The retrieved response hash and full flags are saved in `trade-reader-verification.json`.

The requested Nepal-to-India HS 0902 export and India-from-Nepal mirror import previews for 2023 returned no rows. These are query-specific gaps, not evidence of zero trade. Browser QA verified the default Nepal/India tea URL generated with country codes 524/356. No production account or mission was created.

## Sources and reuse

- [UN Comtrade API](https://uncomtrade.org/docs/un-comtrade-api/): public previews do not require an API key; access and records are limited.
- [Official Comtrade client](https://github.com/uncomtrade/comtradeapicall): documented preview/query parameters.
- [Reporters and partners](https://uncomtrade.org/docs/reporters-and-partners/): reporter/mirror distinctions.
- [Trade valuation](https://uncomtrade.org/docs/trade-valuation/): valuation differences require metadata review.
- [Quantity guidance](https://uncomtrade.org/docs/how-should-i-interpret-and-use-quantity-data-in-un-comtrade/): quantity definitions and units matter.
- [Reuse policy](https://uncomtrade.org/docs/policy-on-comtrade-data-use/): retrieval timed out during this verification. Lucy retains attribution and requires reuse-policy review; no blanket licence or CC BY claim is assigned to Comtrade.

Buyer/contact research, product-specific HS verification, applicable trade requirements, exporter capacity, logistics and independently sourced economics remain separate tasks. There is no automated outreach.

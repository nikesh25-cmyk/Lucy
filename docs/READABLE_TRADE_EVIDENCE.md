# Readable submitted trade evidence

Verified 12 October 2026. Prepared trade evidence now has a readable annual table in My contributions, the reviewer view and the accepted gallery. Storage, submission versions and downloadable originals are unchanged.

The preview recognizes only the bounded prepared CSV format and checks year/role coverage, query shape, numeric/flag structure and retained source references. It is a presentation of contributor-submitted text, not proof of original-source facts or licensing. Inconsistent or unrecognized evidence falls back to the existing escaped plain-text view.

Rows show requested year, reporter/mirror role, primary USD value and evidence availability. True zero remains zero; missing values, empty previews, collection gaps and rate limits remain distinct. Unrequested queries are labelled where that flag was retained. There are no numerical trends, unit prices, currency conversions or CIF/FOB reconciliation.

Provider flags, quantities/unit codes, estimation flags, valuation fields, retrieval date and declared original hash are available in a provenance disclosure. The complete original submitted text remains separately readable. No additional data fetch, independent acceptance or external action is triggered by the preview.

## Verification

All 191 tests passed. A mixed synthetic fixture checks zero, missing primary values, collection gaps, provider flags and retained source references; malformed headers, classifications, years/roles and source sets fall back to text.

Actual browser QA displayed the retained partial Nepal/India candidate as ten annual rows: three empty previews and seven rate-limited reads. It remained pending review with zero adoptions and a valid audit. At 390 pixels, the table scrolls within its container and the page has no horizontal overflow. The responsive check found an existing long source-hash span overflow; wrapping was corrected. Viewport overrides were reset and the isolated fixture stopped.

This improves review clarity. It does not complete the trade study, validate submitted figures or establish buyers, shipment permission, financing or adoption. No production account or contribution was created.

Artifacts: `lucy-readable-trade-evidence.png`; `trade-preview-browser-verification.json`.

# Paired annual agricultural trade baselines

Verified 12 October 2026. NemoWorld can prepare and collect an explicit one-to-five-year reporter/mirror trade window. A requested window is not a verified latest or complete reporting period.

## Query plan in World Assembly

The agricultural query builder has a **Requested window** field. One annual source retains the original behaviour. Three/five-year plans produce paired exporter and mirror-importer URLs for two distinct countries, with the requested year as the window end. World cannot be a paired reporter. Import-flow selection reverses origin/destination appropriately. The plan is text only: no fetch, approved host, task activation or research acceptance is created.

## Bounded curator collection

With Node 24, from the project folder:

```sh
node scripts/trade-baseline.mjs collect NP IN 0902 2020 2024 ./trade-candidates
node scripts/trade-baseline.mjs validate ./trade-candidates/trade-NP-IN-0902-EXAMPLE
```

Replace the second path with the candidate printed by collection. The Mac launcher’s installed Node may be used when Node is not on the shell PATH.

Collection accepts current catalog ISO2 countries, agricultural HS4/HS6 codes and up to five requested years within 2015–2026. Each year has separate origin exports and destination mirror imports. The existing strict annual preview reader, public DNS pinning, TLS verification, redirect refusal and one-megabyte limit apply. At most two reads are in flight; default starts are five seconds apart, each read has fifteen seconds and the entire collection has three minutes. A rate-limit response stops further dispatch; already in-flight work can finish. There is no automatic retry or paid/API-key access.

Each run creates a fresh candidate directory and preserves previous candidates. Format two contains `baseline.json`, `baseline.csv` and original bytes for successfully retained records. The CSV carries source query, year, reporter/partner, primary USD value, actual HS revision, original-classification/reported/aggregate flags, CIF/FOB fields, weights, quantities/unit codes, estimation flags, retrieval time/hash and gap cause/attempt status where known. Raw filenames on gaps describe planned files; no original bytes are claimed for a failed read.

Empty previews, null primary values, zero values, failed reads, unknown comparative flags and classification changes stay distinct. No unit price, numerical trend or mirror reconciliation is calculated. Every complete pair still requires human comparability review, including valuation and provider metadata.

Validation reads bounded regular metadata/raw files, checks exact query coverage, hashes, normalization, pair checks and CSV consistency. Modified CSVs are rejected. Format two is the public candidate format; internal earlier draft candidates remain preserved rather than overwritten. Integrity validation does not authenticate a local editor’s assertions or replace independent source/reuse review.

The collection is a curator tool: it neither claims nor submits a mission. Existing research workers retain their one-to-five-source bound and independent-review workflow. No account, approved scope, institutional recommendation or outreach is created.

## Actual research result and verification

The requested Nepal–India HS 0902 window for 2020–2024 did not establish a trade baseline. An initial run retained one empty preview with nine failed reads. A subsequent paced run retained three empty previews and recorded seven rate-limited reads. A separate diagnosis confirmed an empty mirror query. These do not prove zero trade, absent demand or full provider coverage. No further live batch was issued after rate limits were identified; the final stop-on-rate-limit guard was verified with a deterministic provider-refusal test.

The delivered format-two candidate was reformatted offline from the second run, preserving its original raw records, source dates and hashes. No fresh fetch occurred during formatting. It remains partial, unreviewed evidence, not an accepted study. Terms/attribution require review; no blanket Comtrade reuse licence is asserted.

All 185 tests passed. Tests cover paired identities, bounded concurrency, cancelled reads, positive zero versus missing values, differing HS revisions, flags/units, provider refusal without upstream body leakage and cessation of new dispatch after rate limits. Actual candidate validation passed; a copied candidate with a modified CSV was rejected. Actual browser QA generated ten 2020–2024 Nepal/India tea queries and kept both reporter roles visible. No production account or task was created.

Artifacts: `trade-baseline-verification.json`, the saved `tea-trade-baseline-C2svLk` candidate and `lucy-paired-trade-plan.png`.

# Curating country agriculture evidence

The collection command fetches the three registered World Bank agriculture indicators for selected countries or for the 44 LDCs in NemoWorld's dated UN M49 catalog. It does not generate recommendations or establish buyer demand, export eligibility, crop productivity, land availability or returns.

```sh
node scripts/collect-statistics.mjs --countries NP,BD,ZM --output work/candidate-statistics
node scripts/collect-statistics.mjs --ldc --output work/candidate-ldc-statistics
```

Choose one selection mode and an explicit candidate directory outside the active catalog. The module accepts 1–64 unique catalog countries. Collection uses three concurrent reads by default, at most four, a fifteen-second source deadline and six-minute batch deadline. Requests use the existing approved HTTPS host, public DNS-address checks, pinned TLS, no redirects, one-megabyte limit and strict registered response normalization. DNS waiting respects cancellation. Remaining tasks after batch cancellation are recorded as unavailable rather than claimed as retrieved.

Each successful response is retained byte-for-byte as public JSON, rehashed, and normalized again from those bytes. The original country, indicator, years, units, missing values and dataset update must match. Hash-named files avoid replacing an older retained source edition. Every series records its own retrieval time and raw-response checksum. A provider dataset update is neither observation nor publication date. Null values remain missing; three retained series can still contain no reported values.

The candidate contains agriculture-statistics.json, newly retained raw files under catalog/statistics, and collection-report.json. The candidate merges successful records into existing snapshots; failed refreshes preserve previously verified records and record the new collection gap. Old raw files referenced by preserved snapshots remain in the existing catalog. The report separates retrieval success from failure; successful retrieval is not independent factual approval.

Review and validate each candidate series against its retained source and checksum before installation. Copy the candidate catalog and its new raw files into the project only after this review, keeping old raw files. Restart the server to load the installed catalog. Collection never silently replaces the active catalog or modifies accounts, task scopes, claims, submissions or review decisions. The country browser filters complete, partial and absent retained coverage and distinguishes retained series from those with nonmissing observations. Country evidence displays latest collection gaps and individual series dates.

Failures may be temporary connectivity problems, an unavailable series or an unsupported provider response. Do not turn a failed request into a zero value, assume an existing snapshot is fresh, or infer that no agriculture exists. The source reader supports only the registered indicators and fixed annual window; broadening either requires review.

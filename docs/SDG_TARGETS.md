# Target-level SDG research

The Assembly now exposes 169 target identifiers, derived from all seventeen official SDG goal pages retrieved 12 October 2026. Original response sizes, SHA256 and retrieval timestamps are recorded in `catalog/sdg-targets.json`; target records retain their official page and section locator. Navigation focuses are short Lucy editorial labels, not the full official wording. The [2030 Agenda](https://sdgs.un.org/2030agenda) establishes the seventeen-goal, 169-target framework.

The target explorer selects a goal and shows source provenance, target code, editorial focus and years mentioned in the original wording. It links to the full official target and indicators. Changing goals keeps the directory open. Historical years stay historical: for example, [target 17.11](https://sdgs.un.org/goals/goal17) mentions 2020; it is not presented as a newly issued deadline. Dates can also refer to framework periods rather than a deadline.

Authorized administrators/reviewers can generate four deduplicated country proposals for one target: baseline, intervention comparison, delivery-route mapping and an implementation recommendation. Generation creates backlog entries only. Combining a target and institution in a single generation request is refused to avoid ambiguous scope. Target filters compose with country, region, goal, status, institution and text search before pagination. Country work-programme counts include target-specific stages and still reconcile to the full country total.

Every generated target brief requires reading the complete target, checking current indicator definitions, national priorities, source dates, population coverage and country-specific evidence. Original wording is not automatically a current statistical definition; poverty thresholds are an explicit example. Global objectives, measured national observations, proposed work, funding needs and actual support stay distinct. Activation retains the existing beneficiary/owner/reviewer/source-host/rubric workflow. No target reference establishes UN authority, eligibility, finance, country performance or outreach permission.

## Verification

All 202 platform tests passed. Coverage checks all target identifiers and goal counts, source metadata, dates, roles, invalid/ambiguous requests, deduplicated generation for every target, composed filters/pagination, country stage accounting, preserved activation instructions and zero automatic submissions/adoptions.

Actual isolated browser QA inspected target 17.11’s historical year, changed goal while retaining the open directory, and used a reviewer account to create four Nepal target-2.3 proposals. The filtered list had four proposed records and the whole-country summary seventy-eight. This is workflow verification, not a real smallholder study; there were zero submissions/adoptions and no production accounts created. The saved live world’s original 2,998-proposal backlog is preserved.

Full source wording is linked rather than reproduced in the catalog. The metadata collection does not import global progress statistics or individual indicator datasets and does not refresh automatically. Broader UN programme coverage, substantive country findings and a real agriculture pilot remain open.


New target proposals now include a registered fragment selecting the exact target for bounded framework reading. Existing activated scopes remain preserved. See `TARGET_READING.md` for parser coverage, live retrieval proof, output classification and limits.

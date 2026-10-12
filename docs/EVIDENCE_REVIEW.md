# Version-specific human evidence review

The browser review form for structured decision briefs includes one assessment per finding. The reviewer records a result, the cited source numbers actually checked, and an explanation identifying the supporting passage or correction. It also records applicability, attribution/permissions and, when a cost register exists, cost assumptions.

Results are not checked, supported within the stated scope, uncertain, unsupported or contradicted. Checked source numbers must be distinct integers drawn from that finding’s own citations. A result other than not checked requires a checked source. Not checked cannot claim checked sources. The server rejects acceptance of an assessment containing any result other than supported. Requesting corrections or rejecting a submission can retain uncertain, unsupported, contradicted or unchecked findings.

Unknown costs remain unknown; review does not require inventing a freight quote or treating estimates as verified prices. Acceptance is a contribution review, not approval of the proposed budget, appointment, shipment or institutional recommendation.

The assessment is appended as readable text to the existing version-specific review reason. It survives corrected versions, restart, owned export and accepted gallery publication without a database migration. Independent reviewer roles, contributor self-review refusal and mission assignment remain enforced. The owner’s previous version and its review remain intact when a corrected version is submitted.

API clients may send `assessment` with `findings` (ordered `finding_number`, `result`, `checked_source_numbers`, `notes`), `scope_notes`, `rights_notes` and `cost_notes`. An assessment requires a structured brief. Explanations are bounded to 2,000 characters; each assessment note to 800 characters; all brief findings must be assessed. Existing plain review requests remain supported and do not acquire a finding assessment by implication. The new browser form sends assessments for structured briefs; plain-text contributions retain the existing general review form.

These are human declarations. NemoWorld validates structure and citation membership, not whether a source was opened, its factual truth, legal permissions or the correctness of the reviewer’s judgment. The brief heading now says “Findings and cited evidence,” avoiding a claim of automatic evidential support.

Verification: 149 automated tests passed at that milestone. Focused tests verify source membership, failed acceptance rollback, self-review refusal, version separation, private visibility, gallery/export retention and restart/audit integrity. Isolated browser QA attempted to accept an uncertain finding and received the server refusal; changing the assessment to supported within the explicit fictional fixture scope retained the checked source and notes in the gallery. No production account or real trade recommendation was created.

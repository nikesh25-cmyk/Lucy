# Version-specific human evidence review

The browser review form for structured decision briefs includes one assessment per finding. The reviewer records a result, the cited source numbers actually checked, and an explanation identifying the supporting passage or correction. It also records applicability, attribution/permissions and, when a cost register exists, cost assumptions.

Results are not checked, supported within the stated scope, uncertain, unsupported or contradicted. Checked source numbers must be distinct integers drawn from that finding’s own citations. A result other than not checked requires a checked source. Not checked cannot claim checked sources. The server rejects acceptance of an assessment containing any result other than supported. Requesting corrections or rejecting a submission can retain uncertain, unsupported, contradicted or unchecked findings.

Unknown costs remain unknown; review does not require inventing a freight quote or treating estimates as verified prices. Acceptance is a contribution review, not approval of the proposed budget, appointment, shipment or institutional recommendation.

The assessment is appended as readable text to the existing version-specific review reason. It survives corrected versions, restart, owned export and accepted gallery publication without a database migration. Independent reviewer roles, contributor self-review refusal and mission assignment remain enforced. The owner’s previous version and its review remain intact when a corrected version is submitted.

API clients may send `assessment` with `findings` (ordered `finding_number`, `result`, `checked_source_numbers`, `notes`), `scope_notes`, `rights_notes` and `cost_notes`. An assessment requires a structured brief. Explanations are bounded to 2,000 characters; each assessment note to 800 characters; all brief findings must be assessed. Existing plain review requests remain supported and do not acquire a finding assessment by implication. The new browser form sends assessments for structured briefs; plain-text contributions retain the existing general review form.

These are human declarations. NemoWorld validates structure and citation membership, not whether a source was opened, its factual truth, legal permissions or the correctness of the reviewer’s judgment. The brief heading now says “Findings and cited evidence,” avoiding a claim of automatic evidential support.

## Versioned evidence and the exact supporting location

Every contribution pins each cited source to the **exact version** the contributor named: the URL, host and path, the SHA-256 of the exact bytes, its size, the retrieval timestamp, a source-declared date when one exists, the unit, the provenance and licence where known, and the exact supporting location (page, table, clause or section) — not just a link. A later capture of the same source **cannot rewrite** the cited version; it only changes the state the reviewer sees. The reviewer opens the retained location, not a summary of it.

The state of each citation is shown accurately and the five values are never conflated:

| State | What the reviewer sees |
| --- | --- |
| **captured** | The cited version is stored and no newer version is retained. The SHA-256, retained bytes, retrieval time, declared date, unit and licence are shown, with the exact location. |
| **missing** | **Never captured.** A saved link alone is not verified evidence; the reviewer is told plainly it must not be presented as support, and no version fields are shown. |
| **stale** | A newer capture exists than the one cited. The cited version is untouched; the reviewer sees both and the note that the difference is shown, not rewritten. |
| **replaced** | A newer version explicitly supersedes the cited one. The original version stays readable beside it. |
| **withdrawn** | The source is gone or now refuses (recorded by an operator after a browser check). The cited version is retained exactly. |

If two captures of one source disagree on a declared date or a unit, **both values stay visible**: the citation is flagged as conflicting and lists every distinct date and unit rather than normalising them away. Requesting corrections or rejecting a submission can retain an uncertain, unsupported, contradicted or unchecked finding, and a `missing`, `stale`, `replaced` or `withdrawn` citation is a reason a reviewer may refuse acceptance — but nothing on this path ever edits an artifact or invents a version for it.

A reviewer inspects the library from the review view: **Load evidence library** reads `GET /api/v1/evidence` and lists each source with its versions, status, exact supporting location and whether it is already cited, within the **2 048-source / 8 192-capture / 8-versions-per-source / 96 MiB** quota. The same per-source evidence is attached to each pending contribution. Rights are preserved: every capture keeps its stated licence name, URL and attribution, and the panel says so, so a reviewer can weigh reuse before accepting.

Verification is the schema-22 suite (see `docs/handoff/task-25-evidence-library.md`): a receipt points at an exact version; a bare link reports as unverified; a newer capture marks the citation stale and an explicit supersede marks it replaced without changing the cited row; conflicting dates and units remain visible; a redirect, a private address, a forbidden host, a mismatched retained hash or an exhausted quota fails closed and stores nothing; a withdrawn source stays distinct; and a schema-21 database migrates forward, validates and survives a backup/restore.

Verification: 149 automated tests passed at that milestone. Focused tests verify source membership, failed acceptance rollback, self-review refusal, version separation, private visibility, gallery/export retention and restart/audit integrity. Isolated browser QA attempted to accept an uncertain finding and received the server refusal; changing the assessment to supported within the explicit fictional fixture scope retained the checked source and notes in the gallery. No production account or real trade recommendation was created.

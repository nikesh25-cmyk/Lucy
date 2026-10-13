# Version-specific human evidence review

The browser review form for structured decision briefs includes one assessment per finding. The reviewer records a result, the cited source numbers actually checked, and an explanation identifying the supporting passage or correction. It also records applicability, attribution/permissions and, when a cost register exists, cost assumptions.

Results are not checked, supported within the stated scope, uncertain, unsupported or contradicted. Checked source numbers must be distinct integers drawn from that finding’s own citations. A result other than not checked requires a checked source. Not checked cannot claim checked sources. The server rejects acceptance of an assessment containing any result other than supported. Requesting corrections or rejecting a submission can retain uncertain, unsupported, contradicted or unchecked findings.

Unknown costs remain unknown; review does not require inventing a freight quote or treating estimates as verified prices. Acceptance is a contribution review, not approval of the proposed budget, appointment, shipment or institutional recommendation.

The assessment is appended as readable text to the existing version-specific review reason. It survives corrected versions, restart, owned export and accepted gallery publication without a database migration. Independent reviewer roles, contributor self-review refusal and mission assignment remain enforced. The owner’s previous version and its review remain intact when a corrected version is submitted.

API clients may send `assessment` with `findings` (ordered `finding_number`, `result`, `checked_source_numbers`, `notes`), `scope_notes`, `rights_notes` and `cost_notes`. An assessment requires a structured brief. Explanations are bounded to 2,000 characters; each assessment note to 800 characters; all brief findings must be assessed. Existing plain review requests remain supported and do not acquire a finding assessment by implication. The new browser form sends assessments for structured briefs; plain-text contributions retain the existing general review form.

These are human declarations. NemoWorld validates structure and citation membership, not whether a source was opened, its factual truth, legal permissions or the correctness of the reviewer’s judgment. The brief heading now says “Findings and cited evidence,” avoiding a claim of automatic evidential support.

## The reviewer workbench

The review view is one workbench for one submission version. It reads a single composite payload, `GET /api/v1/review/workbench?submission=<id>`, and writes nothing, so opening it can never change a state. A reviewer works through it in this order:

1. **The criteria and the findings.** The mission rubric and each finding with the sources it cites.
2. **The source-version comparison.** Every cited source is shown against the version the library holds *now*: the exact hash, retained bytes, retrieval time, source-declared date, unit and supporting location of the **version this contribution pinned**, side by side with the **current version**, plus the fields that differ. The cited version is never rewritten and no version is invented for it. A `missing`, `stale`, `replaced` or `withdrawn` citation is a documented reason a reviewer may refuse acceptance — a human judgment, never an automatic block.
3. **The roles.** The **proposer** (the mission owner), the **contributor**, the **reviewer** and the **adopter** are named and kept apart, with `distinct` flags and the precise reason any action is refused. A reviewer sees “you cannot adopt this version” before being offered anything.
4. **The decision.** The criterion-by-criterion assessment below, and — when requesting corrections — **one specific, actionable instruction per requested change**. The list is stored with this exact version and returned to the contributor as `requested_changes`, so the contributor reads precisely what was asked for instead of inferring it from an explanation.
5. **The recorded adoptions**, each with the supporting evidence the mission owner named.

The one state a reviewer and a contributor both read is **pending / accepted / held / adopted** (with `changes_requested` and `rejected` in the same set). They are never conflated. **Quarantine holds availability without rewriting history**: a held version keeps its acceptance record and any issued receipt exactly as they were, its wallet projection reads `held`, and it is simply absent from the gallery and the briefing packet until an independent appeal restores it.

An **adoption** is the mission owner’s own **recorded declaration with supporting evidence**. It is refused when it would put one person in two roles — the contributor cannot adopt their own work, and the reviewer who accepted the version cannot adopt it either — and it states in the interface, the API response and the delivery packet that it is **not proof of implementation, not an institutional endorsement and not evidence of a real-world outcome**. It mints no NemoCoin.

## Versioned evidence and the exact supporting location

A contribution pins an **exact retained-byte version** only when its URL and SHA-256 match a version already held in the evidence library and checked against its stored bytes. Otherwise, the URL, contributor-declared hash and location remain visible as an unverified citation. A later capture of the same source **cannot rewrite** a pinned version; it only changes the state the reviewer sees. Historic schema-22 citations linked to hash-only records remain stored exactly as before but read as unverified. A matching hash does not itself authenticate a publisher, prove the location supports the claim, or establish reuse rights; the reviewer checks those separately.

The state of each citation is shown accurately and the five values are never conflated:

| State | What the reviewer sees |
| --- | --- |
| **captured** | The cited URL and hash match retained bytes checked by the server; no newer retained-byte version is held. This does not certify the source's claims. |
| **missing** | No matching retained, hash-checked bytes exist. A bare link or hash-only declaration is unverified. Historic hash-only metadata may remain visible, but is never presented as captured support. |
| **stale** | A newer retained-byte version exists than the one cited. The cited version is untouched; the reviewer sees both. A newer hash-only declaration does not make a citation stale. |
| **replaced** | A newer retained-byte version explicitly supersedes the cited one. The original version stays readable beside it. |
| **withdrawn** | The source is gone or now refuses (recorded by an operator after a browser check). The cited version is retained exactly. |

If two captures of one source disagree on a declared date or a unit, **both values stay visible**: the citation is flagged as conflicting and lists every distinct date and unit rather than normalising them away. Requesting corrections or rejecting a submission can retain an uncertain, unsupported, contradicted or unchecked finding, and a `missing`, `stale`, `replaced` or `withdrawn` citation is a reason a reviewer may refuse acceptance — but nothing on this path ever edits an artifact or invents a version for it.

A reviewer inspects the library from the review view: **Load evidence library** reads `GET /api/v1/evidence` and lists each source with its versions, status, exact supporting location and whether it is already cited, within the **2 048-source / 8 192-capture / 8-versions-per-source / 96 MiB** quota. The same per-source evidence is attached to each pending contribution. Rights are preserved: every capture keeps its stated licence name, URL and attribution, and the panel says so, so a reviewer can weigh reuse before accepting.

Verification is the schema-22 suite (see `docs/handoff/task-25-evidence-library.md`): a receipt points at an exact retained-byte version; a bare link or contributor-declared hash reports as unverified; only a newer retained-byte capture marks the citation stale or replaced without changing the cited row; historic hash-only links remain intact but display as unverified after restart; conflicting dates and units remain visible; a redirect, a private address, a forbidden host, a mismatched retained hash or an exhausted quota fails closed and stores nothing; a withdrawn source stays distinct; and a schema-21 database migrates forward, validates and survives a backup/restore.

Verification: 149 automated tests passed at that milestone. Focused tests verify source membership, failed acceptance rollback, self-review refusal, version separation, private visibility, gallery/export retention and restart/audit integrity. Isolated browser QA attempted to accept an uncertain finding and received the server refusal; changing the assessment to supported within the explicit fictional fixture scope retained the checked source and notes in the gallery. No production account or real trade recommendation was created.

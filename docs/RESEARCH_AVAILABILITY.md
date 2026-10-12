# Research evidence availability

Verified 12 October 2026. Research desk and country programme statuses now distinguish historical workflow from current evidence availability.

A proposal whose latest task submission is quarantined is shown as `evidence_withheld`. The visible record retains `recorded_status` (for example adopted) and explains that its review/adoption history remains recorded while the evidence is unavailable. Status filters, whole-country SDG/stage counts and programme downloads use the same current projection. The accepted gallery and briefing endpoints already exclude quarantined submissions.

This is a read projection of authoritative submission status, not a migration or deletion. Stored task/proposal workflow, reviewer decisions and adoption receipts remain unchanged. Latest submission uses creation time plus SQLite insertion order to break timestamp ties. Earlier quarantined versions do not override a newer submission. No private moderation reason, beneficiary or submission text is added to the public projection.

An independently overturned appeal restores the submission's previous reviewed status. The proposal then returns to its recorded workflow state; it does not gain a new review or adoption receipt. Further substantive work still needs human-defined scope and independent review. This label does not decide the merits of a report or prove any external outcome.

## Verification

All 181 tests passed at that milestone. An isolated fixture activated a proposal, submitted it, independently accepted it, recorded an adoption, quarantined the evidence, reopened storage and independently overturned the appeal. The desk/country counts withheld it while the gallery hid it; the historical adoption count remained one and restoration created no extra receipt. Audit integrity remained valid.

Actual guest browser QA filtered Nepal by withheld evidence. It displayed seventy-three proposed records and one withheld record, with recorded workflow adopted and a readable qualification. No production account, moderation decision, mission activation, recommendation or adoption was created. Browser proof: `lucy-evidence-withheld.png`; fixture receipt: `research-state-browser-verification.json`.

Current civic documentation has also been reconciled with installed Qwen/llama.cpp, schema-seven recovery and the distinction between actual local smoke checks and broader model/production validation.

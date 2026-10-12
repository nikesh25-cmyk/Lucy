# Research workflow navigation

The research desk now shows the current workflow for the selected country, goal, institution, SDG target, regional lens and search text. Its totals span all statuses and ignore pagination, so switching stages keeps the context visible. Whole-country programme counts and global catalog totals remain explicitly separate.

Stages: proposed, ready for work (activated), claimed (leased), awaiting review, needs revision, accepted in NemoWorld, adoption recorded and evidence withheld. Each stage explains the next human or contributor action and links to the matching proposals while preserving search facets and resetting the page offset. Empty stages are visible but disabled; the standard status filter still supports an empty-stage search. Show all workflow stages clears only status and pagination.

The API adds `workflow_summary` with total, nonzero status counts and qualifications. Existing global counts and fields remain compatible. No percentage is presented: task count, accepted review and a declaration of adoption do not establish real-world outcomes. Latest quarantined evidence projects as withheld instead of currently accepted/adopted; historical receipts remain intact. Aggregates expose no beneficiary text, private submission artifact or adoption note.

## Verification

All 211 local tests passed. Automated tests cover real fixture transitions from activation through claim, submission, review and recorded adoption; composed country/region/goal/text/institution/target filters; status and pagination independence; empty intersections; parameterized text search; private-content exclusion; HTTP routes and saved-state preservation. The quarantine/restart/appeal test also verifies scoped summary withholding.

Actual isolated browser QA displayed six fictional Nepal tea proposals (five proposed and one awaiting review), navigated both stages with facets preserved and restored all six. At 390 pixels, page width stayed 390 and the panel fit at 358 pixels. The viewport was reset and the fixture closed. Fictional QA is not a completed country study, real adoption or production account creation.

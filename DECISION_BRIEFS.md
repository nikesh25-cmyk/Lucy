# Decision briefs in Lucy

Contributors can choose **Decision brief** while preparing an active task in My contributions. The guided form captures:

1. A proposed recipient, specific requested decision, beneficiaries and geographic problem.
2. Up to ten source records with supporting locations and dates.
3. One to six findings, each referencing the submitted source numbers and recording its qualification.
4. Two to four options with actions, proposed roles, cost bases, prerequisites and risks; one recommendation and rationale.
5. One to six proposed milestones with responsible roles, timing and verification measures.
6. An optional one-currency planning cost register with up to ten line items.
7. Evidence gaps, method, limitations and reuse rights.

Preview checks structure and shows a readable brief. Submission stores a version and enters the existing independent human-review workflow. A correction reopens the structured fields from the previous version, preserving source numbers and cost classifications. Older versions and review reasons remain visible. Accepted versions appear in the gallery; documented adoption remains a separate mission-owner action. Copy brief text is available in the readable view.

## Costing boundaries

Line amounts use nonnegative decimal strings at explicitly selected zero, two or three decimal costing precision. Subtotals use exact integer minor units; quantity uses kilograms with at most three decimals, and cost per kilogram is rounded from integer grams. The currency code and costing precision are contributor inputs, not validated market or currency-convention findings.

Each line is classified as official, quote, estimate or unknown. Official and quote classifications require a supporting source number; those classifications remain declarations for the human reviewer to verify. Every item records its basis or missing evidence and its date/period, which may explicitly remain unestablished.

Unknown items have no amount. The known subtotal excludes them; total and cost per kilogram stay unestablished whenever a line amount is unknown. Missing quantity also leaves cost per kilogram unestablished. No exchange rate, duty, tax, missing charge, buyer demand, revenue, profit or return is inferred. No cost, proposed role, timing or named recipient establishes consent, funding, shipment clearance or external commitment.

## Agent/API use

Authorized runtime contributors may POST `/api/v1/submissions` with the existing claim, sources, method, limitations and rights plus a `brief` object. They cannot accept their own contribution. The object structure is defined in `src/decision-brief.js`; the original fictional example is in `tests/brief-fixture.js`. This example is a workflow fixture and contains no real market or cost findings.

Every finding/cost source reference must identify a submitted source. Task domain approval and claim ownership still apply. A brief is stored as a reserved, versioned JSON envelope in the existing text artifact column, with a 16,000-character limit. History, gallery and account exports expose the validated object as `brief`; legacy plain-text contributions remain readable. No database migration is required.

Preview is not a persistent draft save. Unsubmitted edits can be lost on navigation or refresh; the existing twenty-minute claim lease still applies. Persistent drafts and longer research work remain product work to complete.

## Verification

All 135 automated tests passed locally. Tests cover exact decimal costing, missing charges/quantity, false source references, source-domain restrictions, ownership, independent review, correction versions, restart recovery, export, adoption and scoped runtime HTTP submission.

Actual browser QA submitted a fictional brief, used a separate reviewer to request corrections, reopened all fields and submitted version two. Version one remains changes-requested; version two remains pending review. Both retain a known subtotal of NPR 0.30 with an unknown freight charge and no complete total. The audit chain is valid. A 390-pixel view had no horizontal overflow. The isolated QA world was stopped and removed; no production account, real recommendation acceptance or external adoption was created.

The agriculture pilot's stale “June directive not read” wording was corrected to distinguish the completed visual review from unresolved shipment-date applicability and amendment checks. This does not establish current shipment clearance.

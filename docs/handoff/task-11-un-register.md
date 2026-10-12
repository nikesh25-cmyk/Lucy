# Task 11 handoff — UN programme and committee source register

Branch `task-11-un-register`. Worktree: `work/t11`. Node 24 via `../node-bin` on `PATH`.

## What changed

| File | Change |
| --- | --- |
| `catalog/programmes.json` | Additive: 17 records appended to `.institutions` (83 → 100). New `recordKind` field on the additions. `scope` rewritten to describe 100 records and the register extension. `coverage.countsByType` regenerated; nine new per-type counts added; `coverage.recordKindRule` and `coverage.recordKindsAdded` added; `coverage.exclusions` gained the non-UN-instruments exclusion; `coverageGaps` gained three entries. No existing record, framework or data source was edited. |
| `docs/research/UN_REGISTER_REVIEW.md` | New. The review: what was added, the kind distinctions, retrieval evidence, what was deliberately not added and why, duplicates avoided, domains, unresolved coverage, verification. |
| `docs/research/un-register-sources.json` | New. Retrieval proof per added record (URL, title, SHA256, retrieval timestamp, extraction type, characters) plus an 11-entry `notRetrieved` list of candidate URLs and their errors. |
| `tests/programme-coverage.test.js` | Three pinned counts 83 → 100 (one reconciliation assertion kept). One new test covering the register. |
| `tests/civic-engine.test.js` | Pinned count 83 → 100. |
| `app.js` | Nine new category labels; institution card shows `recordKind` and a "Register facts" disclosure for jurisdiction, eligibility, implementation evidence, public access route and research task. |
| `docs/CIVIC_RESEARCH.md` | Reference-desk bullet 83 → 100 with the register description. |
| `docs/REFERENCE_COVERAGE.md` | 83-record statements marked as historical; new 100-record paragraph. |

## Domains and counts

17 records: agriculture/food 3, trade 1, LDC development 2, environment 7, peace 3, digital access 1.
Kinds: 6 bodies, 2 programmes, 3 treaty processes, 3 strategies, 3 grant instruments.

Every added record was retrieved live on 12 October 2026 with `runtime/research-worker.js` `readSource` (public DNS-pinned TLS, HTML/plain text, 1 MB limit, redirects refused) and carries `sourceUrl`, `sourceCheckedOn`, `evidenceLocator` and `sourceVerification` (`method`, `retrieved`, `sha256`).

## Any test-count assertion that changed, and why

Seventeen records were appended to the existing `.institutions` array, so the three assertions that pin its length moved from 83 to 100. The reconciliation assertion `Object.values(coverage.countsByType).reduce(...) === institutions.length` was kept and now holds at 100, which is why `coverage.countsByType` was regenerated rather than left alone. No other assertion was loosened.

## Deliberately not added

World Trade Organization (non-UN organization), Enhanced Integrated Framework (WTO-hosted site), Internet Governance Forum, ITU Telecommunication Development Sector, UNCTAD Trade and Development Board, Committee for Development Policy, UNECE trade/UN-CEFACT, Basel/Rotterdam/Stockholm and Minamata conventions, and the Secretary-General's High-Level Advisory Body on AI (concluded mandate). Reasons and attempted URLs are in the review and in `un-register-sources.json`.

## Gates

Run in the worktree with `PATH=../node-bin:$PATH`:

- `npm run check` — pass (`node --check` over the whole check list)
- `npm test` — **342 tests, 342 pass, 0 fail** (includes the new register test)
- `npm run e2e` — **9 steps passed, 0 failed**
- `node scripts/seal-content.mjs --check` — pass (86 definitions, 3 support files, 42 notices/assets; no content file touched)

## Limits

- Retrieval proves accessibility, not the substantive correctness of a claim. Membership counts, entry into force, reservations, eligibility windows, funding decisions and programme periods still need dated primary-source research per country and question.
- Official LDC/LLDC/SIDS group counts differ between publishers (UN-OHRLLS states 44/32/39; the catalog's UN M49 snapshot flags 44/32/53). Both are kept with their own source and are not auto-reconciled.
- GEF, GCF and Adaptation Fund figures are the funds' own reported amounts, labelled as reported, not audited results.
- The register adds records only: it generates no proposals in the saved world, activates no mission, and implies no eligibility, financing or authority to contact any institution.
- `outputs/Lucy` was not touched.

## Patch

`git format-patch` output is written to `../task-11-un-register.patch`.

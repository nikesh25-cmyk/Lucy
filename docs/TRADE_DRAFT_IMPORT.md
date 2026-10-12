# Prepared trade evidence in the review workflow

Verified 12 October 2026. A locally validated trade candidate can now be prepared as an inert submission draft and imported into an empty owned claim form.

## Prepare and import

From the project folder with Node 24:

```sh
node scripts/trade-baseline.mjs prepare ./trade-candidates/YOUR-CANDIDATE
```

Preparation rechecks bounded regular metadata/raw files, query coverage, original hashes, normalization, pair checks and CSV consistency. It writes a new `submission-draft.json` without replacing an existing file. No source is fetched and no account, claim or submission is created. A candidate with no retrieved source records cannot produce an evidence submission; retain it as diagnostics instead.

The prepared text includes the candidate scope, CSV, source retrieval/hash notes, limitations and reuse-review requirement. Only retained records become source citations. Failed queries stay in the evidence-gap rows and are not represented as accessed sources. No trade trend, current buyer demand, permission or complete baseline is inferred.

In **My contributions**, open the free-text form of an owned active claim. Select **Prepared trade submission draft**, inspect the import and choose **Apply prepared trade draft**. The form must be empty so unfinished/correction work is not silently replaced. Imported text saves privately. Review the fields and explicitly select **Submit for human review** when ready.

Import checks the specific inert format, bounded fields, one-to-ten canonical public Comtrade URLs, valid source dates and the task's approved Comtrade host. Original-byte and factual verification are still human responsibilities: selecting a local JSON file does not certify it. Changed operator sessions or detached forms cannot apply or parse a late file read. Invalid JSON errors use a generic message without reflecting file contents.

The free-text form now supports adding up to ten source records, matching the server. Saved draft values preserve all ten rows across refresh; corrected submissions retain their source rows. Existing three-source drafts remain compatible, with no database migration. The private draft size/revision/rate limits and claim permissions remain in force.

## Verification

All 187 tests passed. Prepared ten-source fixture evidence preserved fields, scope and source numbering; unsupported fields, credential parameters, noncanonical years, invalid dates, oversized text and empty source lists were refused. Source ten survives draft normalization. Submission enters pending review through an owned claim with approved hosts; self-review is refused and no adoption is created.

Actual isolated browser QA imported the retained partial Nepal/India candidate, saved it, added ten source slots and verified content/row recovery after refresh. The user-controlled submit step produced one version with three retained source records, pending review, zero adoptions and a valid audit. The fixture was stopped and removed; no production account, claim, submission, acceptance, recommendation or adoption was created.

An initial browser fixture used a frozen clock, so its second save correctly hit the existing draft rate limit. The fixture was corrected to a live clock and the workflow repeated successfully; production protections were preserved.

The candidate still has three empty previews and seven rate-limited queries. This workflow makes its limitations reviewable; it does not complete the requested trade-baseline study. Reuse terms and factual support require independent review.

Artifacts: `trade-import-browser-verification.json`, `lucy-trade-import-pending.png` and the candidate’s `submission-draft.json`.

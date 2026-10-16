# Task C handoff — Wave C mission exemplars

## What this delivers

Three **exemplar missions** that a human could pick up and act on, each a JSON document carrying every field `src/mission-quality.js` checks plus a plain-language companion, plus a test that keeps them honest in CI. Nothing was activated, claimed, submitted, reviewed, adopted or sent.

- Base commit: `3ce04e4e57495a93aab460b4743844ad42aa4b32` (branch `integration/deepseek-master-2026-10-14`).
- This task's commit: *"Wave C: author three mission exemplars and check them in CI"*, the tip of this worktree's branch. The focused patch written by `git format-patch -1` is `../task-c-mission-exemplars.patch` (relative to the worktree root) and contains ten files: the nine below plus this handoff. It reverse-applies cleanly against the tree it was produced from. The commit hash is not written here, because a handoff that records the hash of the commit containing it cannot stay true once that commit is amended; the base commit above is the immutable anchor.
- Changed files, and nothing else:

| Path | What it is |
| --- | --- |
| `docs/research/mission-exemplars/README.md` | Index, the field mapping, and the disclosure rules |
| `docs/research/mission-exemplars/ex-sids-count-reconciliation.exemplar.json` | Exemplar 1 (Development) |
| `docs/research/mission-exemplars/ex-sids-count-reconciliation.md` | Companion 1 |
| `docs/research/mission-exemplars/ex-retained-trade-capture-reproduction.exemplar.json` | Exemplar 2 (Governance) |
| `docs/research/mission-exemplars/ex-retained-trade-capture-reproduction.md` | Companion 2 |
| `docs/research/mission-exemplars/ex-nepal-tea-production-figure.exemplar.json` | Exemplar 3 (Agriculture) |
| `docs/research/mission-exemplars/ex-nepal-tea-production-figure.md` | Companion 3 |
| `docs/research/mission-exemplars/measured-assess-mission-output.json` | One run of `assessMission` over all three, untruncated, so nothing here has to be taken on trust |
| `tests/mission-exemplars.test.js` | Loads each exemplar, runs it through `assessMission` against the seeded corpus, asserts no `missing`, no `near_duplicate`, dated and versioned sources, an independent reviewer, the blocked-dependency marker, and that the strings fit the shipped column caps |

`src/**`, `app.js`, `server.js`, `catalog/**`, `content/**`, `scripts/**`, `package.json`, the other tests, `HANDOFF.md`, `docs/VERIFICATION.md` and `outputs/Lucy` were not touched. No dependency was added. No database and no live installation was read or written; the comparisons run against a temporary seeded database, exactly as the rest of the suite does.

## The three exemplars and their questions

**1 — `ex-sids-count-reconciliation` · Development**

> Which named countries or areas appear on only one of the two retained versions of the small island developing States group, and what does each publisher's own composition statement say about the entries the two versions disagree about?

The two retained versions are the UN-OHRLLS front page (44 LDC, 32 LLDC, **39** SIDS, captured 12 October 2026) and the UNSD M49 snapshot in `catalog/countries.json` (44 LDC, 32 LLDC, **53** SIDS-flagged entries, retrieved 11 October 2026). This is a records mission: produce the entry-level disagreement list and the two publishers' own composition statements, and name no winner.

**2 — `ex-retained-trade-capture-reproduction` · Governance**

> Which of the ten retained country-pack trade captures still reproduce from the provider query recorded behind it, and where a response differs, which provider field explains the difference?

Ten UN Comtrade preview responses are retained byte-for-byte with SHA-256 checksums and are cited across this repository as dated observations. The mission re-runs each recorded query and records, per capture, the status, the row count and a field-by-field comparison of thirteen provider fields. Byte equality is explicitly not the criterion, and the exemplar says why.

**3 — `ex-nepal-tea-production-figure` · Agriculture**

> Which Nepali document states tea production quantity and harvested area for the most recent complete fiscal year, and what value, unit and fiscal-year basis does it state?

The retained Nepal pack records in its own gap list that no Nepali tea production or harvested-area figure was obtained. The mission closes that one gap, and its rubric requires a "not published" register as a legitimate deliverable rather than a substituted number.

Each question is distinct from the other two and from the seeded corpus, and the module's own numbers are in the verbatim section at the end of this document: **no `missing`, no signal of any kind, and no match above the 0.6 duplicate threshold** on any of the three. The closest corpus neighbours are 0.1671, 0.0793 and 0.0989.

### How the exemplars keep the field set the module checks

| Module field | Where it lives in the exemplar |
| --- | --- |
| `title`, `area` | `mission.title`, `mission.area` (the area is one of the twelve `createMission` accepts) |
| `owner`, `beneficiary`, `reviewer` | `mission.owner`, `mission.beneficiary`, `mission.reviewer` |
| `question` | top-level `question` (never left to the first sentence of the instructions) |
| `evidence_criteria` | `mission.rubric` — the shipped `createMission` column the module reads as the criteria |
| `limits`, `rights` | top-level `limits`; `rights` at top level and on the task |
| `sources`, `source_date`, `source_version` | `sources[]`, each with `url`, `location`, `date` and `version` |
| `source_hosts` | `task.allowed_domains`, which covers every source hostname |

Two module behaviours are worth recording because they shape the files. First, with a `task` present the module reads the task's `rights`, not the top-level one, so the rights text is carried on both. Second, `limits` contributes to the duplicate comparison, so editing the limits text changes the measured score — which is why the numbers below were measured after the last edit.

## Sources: what each one is, its date, and how far it was checked

Nothing was invented: no source, no contact, no statistic, no institutional relationship. Every source is an official ministry, statistics office, UN body or original dataset provider, and every one carries the date the cited version was read.

| Source | Host | Date | Version pinned | How far it was checked |
| --- | --- | --- | --- | --- |
| UN-OHRLLS front page | `www.un.org` | 2026-10-12 | `sha256:699a352b…` (capture retained in `docs/research/un-register-sources.json`) | Re-fetched 14 Oct 2026 by plain HTTPS: HTTP 200, 61 047 bytes, `sha256:004755e9…`, the same three counts present. Reused from the repo's own dated register rather than re-researched; the fetched bytes were not retained. |
| UNSD M49 methodology / questions page | `unstats.un.org` | 2026-10-14 | `sha256:4d5cabcb…` (2 051 368 bytes read; bytes not retained) | Read directly once, for the composition answer quoted in `known_at_authoring`. No capture retained, so a contribution must capture it before pinning it. |
| UNSD M49 overview table | `unstats.un.org` | 2026-10-11 | `sha256:f72c6ed8…` (snapshot retained in `catalog/countries.json`, 248 entries) | Re-fetched 14 Oct 2026: HTTP 200, 1 721 575 bytes. The flag columns are present but carry no English legend in a plain-text extraction — recorded as a gap, not assumed. |
| UN Comtrade public preview endpoint | `comtradeapi.un.org` | 2026-10-12 | unversioned public endpoint, pinned by the recorded query URLs and each capture's checksum | Queried 14 Oct 2026 for all ten re-checks; HTTP 200 with the documented shape, and HTTP 429 under a burst. |
| Ten recorded Comtrade query URLs (Ethiopia coffee and oilseeds; Cambodia rice and cassava; Senegal banana and fish) | `comtradeapi.un.org` | 2026-10-12 | the ten retained capture checksums (`90756ca9…`, `35029db0…`, `8e263fc3…`, `3f942592…`, `6c6aef87…`, `16468b30…`, `51b5d10e…`, `f1699005…`, `b7aeb149…`, `1452ce6a…`) | All ten re-fetched 14 Oct 2026: HTTP 200, one row, all thirteen compared provider fields identical to the retained capture; every body checksum differed only by the per-request `elapsedTime` field and a trailing newline. Recorded as an unreviewed pilot observation, not as accepted evidence. |
| National Tea and Coffee Development Board | `www.teacoffee.gov.np` | 2026-10-12 | page as read (no byte capture retained) | Re-read 14 Oct 2026: reachable; readable text carried the board's name in Nepali and English and its Kirtipur address only. |
| National Statistics Office | `nsonepal.gov.np` | 2026-10-12 | page as read (no byte capture retained) | Re-read 14 Oct 2026: reachable; header text only. |
| World Bank WDI, Nepal `NV.AGR.TOTL.ZS` and `AG.LND.ARBL.ZS` | `api.worldbank.org` | 2026-10-11 | `sha256:97f63f8a…` and `sha256:c7929f77…` (both retained under `catalog/statistics/`) | Retained captures with their checksums, reused from the catalog; not re-read. Named as context and explicitly not as the answer. |

Two live findings from authoring that belong in the record rather than in a chat log:

1. **The Comtrade public preview rate-limits.** A burst of ten requests on 14 October 2026 returned HTTP 429 for five of them; every one of the five answered HTTP 200 after a pause. Any mission that plans to re-fetch these rows has to pace its requests and record refusals.
2. **The M49 overview table's flag columns carry no English legend in a plain-text extraction.** The meaning of the `sids` flag column has to be taken from the publisher's own statements or the retained snapshot's metadata, not read off the table.

## What is an evidence gap

Recorded in the exemplars' own `evidence_gaps` lists, and repeated here so it is not buried:

- **The membership behind the count of 39 is not located.** The UN-OHRLLS SIDS page read on 14 October 2026 is narrative and carries no member list in its readable text. The disagreement list therefore cannot be completed from the two sources alone; locating the list the count rests on is the mission's first deliverable.
- **No retained byte capture exists** for the two pages read on 14 October 2026 (the M49 methodology page) or for the two national front pages. A contribution would have to capture them through the shipped evidence path before citing them as pinned versions.
- **Ten Comtrade queries return zero rows** and stay gaps, not zeros: Bangladesh HS 5303 (2023), HS 100630 (2023) and HS 030617 (2022 and 2023); Nepal HS 0902 to India (2022 and 2023), HS 0902 to the World (2023) and HS 0908 to the World (2023); India-from-Nepal HS 0902 mirror (2023); Senegal HS 080390 to Germany (2023). Three were re-run on 14 October 2026 and still returned `count: 0` with HTTP 200.
- **No checksum was retained for the 14 October 2026 re-checks**, so the pilot reproduction run cannot be pinned. That is why it is labelled a pilot observation.
- **The provider's own documentation of the preview subset's coverage was not read**, so why particular reporters answer and others do not is unresolved.
- **Neither national body's publication route is established.** Whether the National Tea and Coffee Development Board or the National Statistics Office publishes a tea production quantity or a tea harvested-area figure is the open question, and the retained pack recorded the same gap.

## What remains blocked

- **No consenting beneficiary has been selected.** External implementation evidence and a measured outcome are blocked on that dependency for every exemplar: `report.ladder.blocked` names both stages with `blocked_on: "a consenting beneficiary"`, and the module's ladder puts all three at `owner-approved mission / claimed task (proposed)`. Every exemplar states this itself, in `blocked_dependency` and in its `limits`, and every companion repeats it.
- **An adoption declaration is not implementation.** A mission owner's recorded adoption would be that owner's declaration with their own evidence. Nothing here is implemented and nothing is measured.
- **No outreach of any kind.** No message was sent to UN-OHRLLS, UNSD, the Comtrade provider, the National Tea and Coffee Development Board, the National Statistics Office or anybody else. The exemplars say so, and nothing in them authorises one.
- **A named human owner, reviewer and beneficiary are still required.** The owner and reviewer in each exemplar are declared **role slots** whose own text says that no human has been named. This is the one place where the module's `missing: []` has to be read carefully, and it is recorded rather than hidden: the module can see that a role label is present, and it cannot see that the label is not a person. The test asserts `assignment.named_owner === false` and `assignment.named_reviewer === false`, and asserts that the module's own output carries the unassigned wording into `subject.owner.name` and `subject.reviewer.name`. Faking a person to fill the field would have been fabrication; leaving the field blank would have failed the brief. A declared empty slot is the honest third option, and it is disclosed in the exemplar, the companion, the module output and here.

## What Wave C still lacks

- **A resolution of the corpus question.** 1,009 of 1,015 seeded proposals sit within 0.6 of a sibling because the corpus is built from four concern templates. These three exemplars show that a distinct, source-backed, machine-checkable mission can be authored — they do not show how to make 1,015 of them distinct, and they are not a template for volume. Nothing in this task changed the threshold, the corpus or the generator.
- **A reviewer.** Nobody has reviewed these exemplars, their sources or the pilot reproduction run. They are proposals, and this handoff is not an acceptance.
- **Any external engagement.** There is no owner, no reviewer, no beneficiary, no buyer, no partner and no recipient, and none can be invented.
- **The blocked-dependency machinery.** A mission cannot move past `owner-approved` in this build, so the adoption and implementation stages of these exemplars are untestable here rather than untested.
- **An evidence-library route for the pages read on 14 October 2026.** Two of the three exemplars cite sources that were read but not captured. Capture and pinning go through the shipped evidence path, which this task did not touch.

## Gates

| Gate | Command | Result |
| --- | --- | --- |
| Syntax | `npm run check` | `checked 90 files, 0 failed` (the gate skips `tests/` and `*.test.js` by design, so the count is unchanged by this task) |
| Unit / integration | `npm test` | **904 tests, 904 pass, 0 fail, 0 skipped, 0 todo** in 137 s — the 902 verified on this tip plus the 2 in `tests/mission-exemplars.test.js` |
| Focused | `node --test tests/mission-exemplars.test.js` | **2 tests, 2 pass, 0 fail** |
| HTTP acceptance | `npm run e2e` | **17 steps passed, 0 failed**; temporary workspace removed, coins ledger valid, restart persistence byte-for-byte |
| Browser suite | `npm run browser` | **not run.** No browser code, no interface, no route and no rendering changed; the exemplars are documents and a test. Running it would say nothing about this change, and saying so is more honest than reporting a green number that proves nothing. |

## The `assessMission` output, verbatim

Each block below is `assessMission(exemplar, { existing: corpus })`, where `corpus` is the seeded `research_leads` table read from a temporary database — **1 015 rows**, `considered: 1015`. Three keys are omitted from every block and named here so the omission is not mistaken for a shorter report: `authority`, `boundaries` and `severed_units` are the module's own fixed constants, byte-identical across the three and quoted in full in `docs/MISSION_QUALITY.md`; `thresholds` is kept inside each block because the brief asks for the thresholds that were used. The untruncated output, all keys included, is in `docs/research/mission-exemplars/measured-assess-mission-output.json`. Nothing else is elided, rounded or reformatted.

### `ex-nepal-tea-production-figure`

```json
{
 "kind": "mission_quality_assessment",
 "version": 1,
 "advisory": true,
 "scope": "task",
 "fictional": false,
 "subject": {
  "id": "ex-nepal-tea-production-figure-task",
  "title": "Pin where Nepali tea production and harvested area are published",
  "area": "Agriculture",
  "owner": {
   "id": "owner-slot-unassigned",
   "name": "Mission owner — unassigned: no human owner has been named for this proposal"
  },
  "reviewer": {
   "id": "reviewer-slot-unassigned",
   "name": "Independent reviewer — unassigned: no human reviewer has been named for this proposal"
  },
  "contributor": null,
  "beneficiary": "Nepali tea producer groups and the municipal or national bodies that would read the resulting briefing; no producer group, cooperative, municipality, exporter or buyer has been selected, consented or contacted as a beneficiary"
 },
 "completeness": {
  "required_fields": [
   "title",
   "area",
   "owner",
   "beneficiary",
   "question",
   "evidence_criteria",
   "limits",
   "rights",
   "sources",
   "source_date",
   "source_version",
   "reviewer",
   "reviewer_independence",
   "source_hosts"
  ],
  "satisfied": [
   "title",
   "area",
   "owner",
   "beneficiary",
   "question",
   "evidence_criteria",
   "limits",
   "rights",
   "sources",
   "source_date",
   "source_version",
   "source_hosts",
   "reviewer",
   "reviewer_independence"
  ],
  "missing": [],
  "complete": true,
  "note": "Complete means only that each required field is present and usable. It is not an approval, a priority, a readiness decision or a promise that a reviewer will accept the proposal."
 },
 "missing": [],
 "signals": [],
 "duplicates": {
  "threshold": 0.6,
  "basis": "Dice coefficient over normalised token sets (NFKC, case-folded, punctuation removed, stopwords dropped), weighted by inverse document frequency so shared boilerplate counts for little and a distinguishing subject counts for much",
  "considered": 1015,
  "above_threshold": 0,
  "returned": 0,
  "matches": []
 },
 "review": {
  "records_supplied": 0,
  "accepted_records": 0,
  "checked": false,
  "measures": {
   "reviewer_shares": [],
   "reviewer_pool": {
    "distinct_reviewers": 0,
    "accepted_records": 0
   }
  },
  "thresholds": {
   "reviewer_share": 0.8,
   "contributor_acceptances": 3,
   "reviewer_pool_size": 2,
   "reviewer_pool_records": 10
  },
  "note": "No accepted review records were supplied, so no collusion measure could be computed. That is not a clean bill of health: it means the corpus was not read."
 },
 "ladder": {
  "stages": [
   "research lead",
   "owner-approved mission",
   "claimed task",
   "versioned submission",
   "independent acceptance",
   "owner adoption declaration",
   "externally evidenced implementation",
   "measured outcome"
  ],
  "reached": "owner-approved mission / claimed task (proposed)",
  "blocked": [
   {
    "stage": "externally evidenced implementation",
    "blocked_on": "a consenting beneficiary",
    "note": "No external implementation evidence exists in this build. A mission owner’s recorded adoption declaration is a declaration by that owner, not proof that the work was implemented or that any institution acted."
   },
   {
    "stage": "measured outcome",
    "blocked_on": "a consenting beneficiary",
    "note": "No outcome is measured here. An outcome needs a real beneficiary who has consented to be measured, which this build does not have."
   }
  ],
  "note": "A signal here says nothing about any stage after this one. The seeded country proposals are proposals, not studies; no real pilot or beneficiary is selected; a mission owner’s recorded adoption declaration is a declaration, not implementation; and external implementation and a measured outcome both wait on a consenting beneficiary."
 },
 "thresholds": {
  "duplicate_similarity": 0.6,
  "duplicate_matches_reported": 5,
  "question_minimum_words": 4,
  "question_restates_goal": 0.8,
  "reviewer_share": 0.8,
  "contributor_acceptances": 3,
  "reviewer_pool_size": 2,
  "reviewer_pool_records": 10
 }
}
```

Closest corpus neighbours, measured with the threshold set to 0 so the margin is visible (id / weighted score / plain score):

```json
[
 {
  "id": "NP-2-destination",
  "score": 0.1671,
  "plain_score": 0.365,
  "shared_tokens": 71
 },
 {
  "id": "SO-2-destination",
  "score": 0.1607,
  "plain_score": 0.3608,
  "shared_tokens": 70
 },
 {
  "id": "GN-2-destination",
  "score": 0.1603,
  "plain_score": 0.3599,
  "shared_tokens": 70
 }
]
```

### `ex-retained-trade-capture-reproduction`

```json
{
 "kind": "mission_quality_assessment",
 "version": 1,
 "advisory": true,
 "scope": "task",
 "fictional": false,
 "subject": {
  "id": "ex-retained-trade-capture-reproduction-task",
  "title": "Reproduce the retained trade captures field by field",
  "area": "Governance",
  "owner": {
   "id": "owner-slot-unassigned",
   "name": "Mission owner — unassigned: no human owner has been named for this proposal"
  },
  "reviewer": {
   "id": "reviewer-slot-unassigned",
   "name": "Independent reviewer — unassigned: no human reviewer has been named for this proposal"
  },
  "contributor": null,
  "beneficiary": "The evidence review path of this build: the independent reviewer and the mission owner who read a retained capture against the version it pins; no reviewer, operator, provider or institution has been selected, consented or contacted as a beneficiary"
 },
 "completeness": {
  "required_fields": [
   "title",
   "area",
   "owner",
   "beneficiary",
   "question",
   "evidence_criteria",
   "limits",
   "rights",
   "sources",
   "source_date",
   "source_version",
   "reviewer",
   "reviewer_independence",
   "source_hosts"
  ],
  "satisfied": [
   "title",
   "area",
   "owner",
   "beneficiary",
   "question",
   "evidence_criteria",
   "limits",
   "rights",
   "sources",
   "source_date",
   "source_version",
   "source_hosts",
   "reviewer",
   "reviewer_independence"
  ],
  "missing": [],
  "complete": true,
  "note": "Complete means only that each required field is present and usable. It is not an approval, a priority, a readiness decision or a promise that a reviewer will accept the proposal."
 },
 "missing": [],
 "signals": [],
 "duplicates": {
  "threshold": 0.6,
  "basis": "Dice coefficient over normalised token sets (NFKC, case-folded, punctuation removed, stopwords dropped), weighted by inverse document frequency so shared boilerplate counts for little and a distinguishing subject counts for much",
  "considered": 1015,
  "above_threshold": 0,
  "returned": 0,
  "matches": []
 },
 "review": {
  "records_supplied": 0,
  "accepted_records": 0,
  "checked": false,
  "measures": {
   "reviewer_shares": [],
   "reviewer_pool": {
    "distinct_reviewers": 0,
    "accepted_records": 0
   }
  },
  "thresholds": {
   "reviewer_share": 0.8,
   "contributor_acceptances": 3,
   "reviewer_pool_size": 2,
   "reviewer_pool_records": 10
  },
  "note": "No accepted review records were supplied, so no collusion measure could be computed. That is not a clean bill of health: it means the corpus was not read."
 },
 "ladder": {
  "stages": [
   "research lead",
   "owner-approved mission",
   "claimed task",
   "versioned submission",
   "independent acceptance",
   "owner adoption declaration",
   "externally evidenced implementation",
   "measured outcome"
  ],
  "reached": "owner-approved mission / claimed task (proposed)",
  "blocked": [
   {
    "stage": "externally evidenced implementation",
    "blocked_on": "a consenting beneficiary",
    "note": "No external implementation evidence exists in this build. A mission owner’s recorded adoption declaration is a declaration by that owner, not proof that the work was implemented or that any institution acted."
   },
   {
    "stage": "measured outcome",
    "blocked_on": "a consenting beneficiary",
    "note": "No outcome is measured here. An outcome needs a real beneficiary who has consented to be measured, which this build does not have."
   }
  ],
  "note": "A signal here says nothing about any stage after this one. The seeded country proposals are proposals, not studies; no real pilot or beneficiary is selected; a mission owner’s recorded adoption declaration is a declaration, not implementation; and external implementation and a measured outcome both wait on a consenting beneficiary."
 },
 "thresholds": {
  "duplicate_similarity": 0.6,
  "duplicate_matches_reported": 5,
  "question_minimum_words": 4,
  "question_restates_goal": 0.8,
  "reviewer_share": 0.8,
  "contributor_acceptances": 3,
  "reviewer_pool_size": 2,
  "reviewer_pool_records": 10
 }
}
```

Closest corpus neighbours, measured with the threshold set to 0 so the margin is visible (id / weighted score / plain score):

```json
[
 {
  "id": "SO-17-interventions",
  "score": 0.0793,
  "plain_score": 0.1942,
  "shared_tokens": 37
 },
 {
  "id": "AF-17-interventions",
  "score": 0.0791,
  "plain_score": 0.1937,
  "shared_tokens": 37
 },
 {
  "id": "AO-17-interventions",
  "score": 0.0791,
  "plain_score": 0.1937,
  "shared_tokens": 37
 }
]
```

### `ex-sids-count-reconciliation`

```json
{
 "kind": "mission_quality_assessment",
 "version": 1,
 "advisory": true,
 "scope": "task",
 "fictional": false,
 "subject": {
  "id": "ex-sids-count-reconciliation-task",
  "title": "Reconcile the two retained small island developing States lists",
  "area": "Development",
  "owner": {
   "id": "owner-slot-unassigned",
   "name": "Mission owner — unassigned: no human owner has been named for this proposal"
  },
  "reviewer": {
   "id": "reviewer-slot-unassigned",
   "name": "Independent reviewer — unassigned: no human reviewer has been named for this proposal"
  },
  "contributor": null,
  "beneficiary": "The contributors and reviewers of this build's country research baselines that quote an LDC, LLDC or SIDS group count; no reader, contributor, institution or government has been selected, consented or contacted as a beneficiary"
 },
 "completeness": {
  "required_fields": [
   "title",
   "area",
   "owner",
   "beneficiary",
   "question",
   "evidence_criteria",
   "limits",
   "rights",
   "sources",
   "source_date",
   "source_version",
   "reviewer",
   "reviewer_independence",
   "source_hosts"
  ],
  "satisfied": [
   "title",
   "area",
   "owner",
   "beneficiary",
   "question",
   "evidence_criteria",
   "limits",
   "rights",
   "sources",
   "source_date",
   "source_version",
   "source_hosts",
   "reviewer",
   "reviewer_independence"
  ],
  "missing": [],
  "complete": true,
  "note": "Complete means only that each required field is present and usable. It is not an approval, a priority, a readiness decision or a promise that a reviewer will accept the proposal."
 },
 "missing": [],
 "signals": [],
 "duplicates": {
  "threshold": 0.6,
  "basis": "Dice coefficient over normalised token sets (NFKC, case-folded, punctuation removed, stopwords dropped), weighted by inverse document frequency so shared boilerplate counts for little and a distinguishing subject counts for much",
  "considered": 1015,
  "above_threshold": 0,
  "returned": 0,
  "matches": []
 },
 "review": {
  "records_supplied": 0,
  "accepted_records": 0,
  "checked": false,
  "measures": {
   "reviewer_shares": [],
   "reviewer_pool": {
    "distinct_reviewers": 0,
    "accepted_records": 0
   }
  },
  "thresholds": {
   "reviewer_share": 0.8,
   "contributor_acceptances": 3,
   "reviewer_pool_size": 2,
   "reviewer_pool_records": 10
  },
  "note": "No accepted review records were supplied, so no collusion measure could be computed. That is not a clean bill of health: it means the corpus was not read."
 },
 "ladder": {
  "stages": [
   "research lead",
   "owner-approved mission",
   "claimed task",
   "versioned submission",
   "independent acceptance",
   "owner adoption declaration",
   "externally evidenced implementation",
   "measured outcome"
  ],
  "reached": "owner-approved mission / claimed task (proposed)",
  "blocked": [
   {
    "stage": "externally evidenced implementation",
    "blocked_on": "a consenting beneficiary",
    "note": "No external implementation evidence exists in this build. A mission owner’s recorded adoption declaration is a declaration by that owner, not proof that the work was implemented or that any institution acted."
   },
   {
    "stage": "measured outcome",
    "blocked_on": "a consenting beneficiary",
    "note": "No outcome is measured here. An outcome needs a real beneficiary who has consented to be measured, which this build does not have."
   }
  ],
  "note": "A signal here says nothing about any stage after this one. The seeded country proposals are proposals, not studies; no real pilot or beneficiary is selected; a mission owner’s recorded adoption declaration is a declaration, not implementation; and external implementation and a measured outcome both wait on a consenting beneficiary."
 },
 "thresholds": {
  "duplicate_similarity": 0.6,
  "duplicate_matches_reported": 5,
  "question_minimum_words": 4,
  "question_restates_goal": 0.8,
  "reviewer_share": 0.8,
  "contributor_acceptances": 3,
  "reviewer_pool_size": 2,
  "reviewer_pool_records": 10
 }
}
```

Closest corpus neighbours, measured with the threshold set to 0 so the margin is visible (id / weighted score / plain score):

```json
[
 {
  "id": "SO-17-interventions",
  "score": 0.0989,
  "plain_score": 0.2135,
  "shared_tokens": 38
 },
 {
  "id": "GN-17-interventions",
  "score": 0.0987,
  "plain_score": 0.2129,
  "shared_tokens": 38
 },
 {
  "id": "SD-17-interventions",
  "score": 0.0987,
  "plain_score": 0.2129,
  "shared_tokens": 38
 }
]
```


Every number in those blocks is what the module returned on 14 October 2026. Where an exemplar was edited after it was first measured, the score reported here is the post-edit measurement — the `limits` field contributes to the duplicate comparison, so editing it moves the number, and the numbers were re-measured after the last edit rather than carried over.

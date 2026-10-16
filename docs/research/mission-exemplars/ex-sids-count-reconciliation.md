# Companion — Reconcile the two retained small island developing States lists

`ex-sids-count-reconciliation.exemplar.json` · area **Development** · status: **proposal.** Not activated. No task claimed, no contribution submitted, no review recorded, nothing adopted, nobody contacted.

## What this mission is

Two public bodies in this repository's own source register state different numbers for the same group of countries. The retained UN-OHRLLS capture (12 October 2026) states 44 least developed countries, 32 landlocked developing countries and 39 small island developing States. The retained UNSD M49 snapshot (11 October 2026) flags 248 entries, of which 44 are LDC, 32 LLDC and **53** carry the SIDS flag.

This mission asks for the entry-level reconciliation of those two versions: for every country or area whose membership differs, which version it appears in, the exact cell or list entry it rests on, and what each publisher's own composition statement says. It is a records mission, not a trade or policy mission.

## The question

> Which named countries or areas appear on only one of the two retained versions of the small island developing States group, and what does each publisher's own composition statement say about the entries the two versions disagree about?

The question is not "are the counts wrong". It is "which entries differ, and on whose stated rule". A mission that returned only a verdict about which publisher is right would be answering a question nobody asked; the publishers' own statements are consistent with each other, because UNSD answers that no common UN-wide definition of the group exists.

## What would count as evidence

- A quoted count sentence per publisher, with its URL, the section it sits in, the date that version was read and the capture it is pinned to. Exact URLs, dates and versions are in the exemplar's `sources`.
- The entry-level disagreement list: country or area, the publisher it appears under, and the flag cell, list entry or linked page it rests on.
- A "not located" register for any count or membership the cited versions do not state — the counted-but-unlisted membership behind the number 39 is currently in that register, and locating it is the mission's first output.
- Both publishers' composition statements quoted as each writes them, never merged into one sentence.

The exemplar records in `known_at_authoring` the two sentences that were located while it was authored, so a reviewer can see the question is answerable. Neither is accepted evidence: nobody has reviewed them, and the deliverable is the table.

## What it would **not** establish

- It would not show that either publisher is wrong, and it names no winner. Two publishers stating two compositions is what UNSD's own answer predicts.
- It would not establish UN membership, recognition, sovereignty or the legal status of any country or area, and it would not reclassify any entry beyond the two cited versions.
- It would not establish programme access, eligibility, funding, preference or graduation for any member.
- It would not establish any outcome for anyone. Nothing here is implemented and nothing is measured.

## Sources, and how far each was checked

| Source | Host | Version cited | Date read | How far it was checked |
| --- | --- | --- | --- | --- |
| UN-OHRLLS front page | `www.un.org` | `sha256:699a352b…` (retained capture, 12 Oct 2026) | 2026-10-12 | Re-fetched 14 Oct 2026, HTTP 200, 61 047 bytes, `sha256:004755e9…`; the same three counts are present. The 14 Oct bytes were not retained, so the pinned version stays the 2026-10-12 capture. |
| UNSD M49 methodology / questions page | `unstats.un.org` | `sha256:4d5cabcb…` (2 051 368 bytes read, not retained) | 2026-10-14 | Read once, for the composition answer quoted in the exemplar. No byte capture retained, so a contribution would capture it through the shipped evidence path before citing it. |
| UNSD M49 overview table | `unstats.un.org` | `sha256:f72c6ed8…` (retained snapshot in `catalog/countries.json`, 11 Oct 2026, 248 entries) | 2026-10-11 | Re-fetched 14 Oct 2026, HTTP 200, 1 721 575 bytes. The flag columns are present but carry no English legend in a plain-text extraction, so the meaning of each column has to be taken from the publisher rather than assumed. |

Nothing was invented. Where a page did not yield the statement it was expected to hold, that is recorded as an evidence gap in the exemplar, not smoothed over.

## What is blocked

- **No consenting beneficiary has been selected.** External implementation evidence and any measured outcome are blocked on that dependency, so this mission cannot move past the owner-approved stage in this build.
- **An adoption declaration is not implementation.** A mission owner's recorded adoption of this work would be their own declaration with their own supporting evidence, not proof that anything was implemented or that any institution acted.
- **No outreach.** No message has been sent to UN-OHRLLS, UNSD or anybody else, and nothing here authorises one.

## What the quality module says

Run against the seeded 1 015-proposal corpus: `missing: []`, `signals: []`, `complete: true`, closest corpus entry `SO-17-interventions` at **0.0989** against the 0.6 duplicate threshold. The full output is in `docs/handoff/task-c-mission-exemplars.md`.

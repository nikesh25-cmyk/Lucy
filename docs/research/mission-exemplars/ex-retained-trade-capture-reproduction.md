# Companion — Reproduce the retained trade captures field by field

`ex-retained-trade-capture-reproduction.exemplar.json` · area **Governance** · status: **proposal.** Not activated. No task claimed, no contribution submitted, no review recorded, nothing adopted, nobody contacted.

## What this mission is

The country source packs retain ten UN Comtrade preview responses byte-for-byte with SHA-256 checksums, and record ten more queries that came back empty. Every one of those rows is now cited elsewhere in this repository as a dated observation. This mission asks the records question that follows: re-run each recorded query and say, per capture, whether the pinned row still comes back, which provider fields are unchanged, and — when a response differs — which field differs.

It is a records-integrity mission. It is not a trade mission, and it produces no trade conclusion.

## The question

> Which of the ten retained country-pack trade captures still reproduce from the provider query recorded behind it, and where a response differs, which provider field explains the difference?

## What would count as evidence

- Per capture: the recorded query URL, the pinned checksum, the date of the check, the HTTP status and the row count.
- A field-by-field comparison of thirteen provider fields the provider itself publishes: `primaryValue`, `fobvalue`, `cifvalue`, `netWgt`, `isAggregate`, `isReported`, `isOriginalClassification`, `legacyEstimationFlag`, `refYear`, `reporterCode`, `partnerCode`, `cmdCode`, `flowCode`.
- A classification of any difference as unchanged, as a field the provider varies per request (named), or as a substantive change, with both values printed.
- A recorded refusal, empty preview or unparseable body, with the status and the body's own error text. A refusal is not a failed capture.

Byte equality is explicitly **not** the criterion, and the exemplar says why: the provider's response body carries a per-request `elapsedTime` field, so two identical requests never produce identical bytes.

The exemplar discloses a pilot run made on 14 October 2026 in `recheck_summary`: all ten captures answered HTTP 200 with one row and all thirteen compared fields identical, every body checksum differed only by `elapsedTime` and a trailing newline, and a burst of ten requests drew HTTP 429 for five of them before all ten succeeded when spaced out. That run is recorded as an unreviewed pilot observation, not as accepted evidence, and no checksum of it was retained.

## What it would **not** establish

- It would not show that any retained figure is correct, complete, final or comparable across years. Reproduction checks the response, not the statistic.
- It would not produce any unit value, price, growth rate, market size or corridor conclusion.
- It would not turn the ten zero-row previews into zeros. They stay evidence gaps.
- It would not establish buyer demand, supplier capacity, shipment eligibility or financing — and it says so in its own limits.
- It would not establish any outcome for anyone. Nothing here is implemented and nothing is measured.

## Sources, and how far each was checked

| Source | Host | Version cited | Date read | How far it was checked |
| --- | --- | --- | --- | --- |
| UN Comtrade public annual preview endpoint | `comtradeapi.un.org` | unversioned public endpoint; pinned by the ten recorded query URLs and their checksums | 2026-10-12 | Queried on 14 Oct 2026 for all ten checks; HTTP 200 with the documented response shape, plus HTTP 429 under a request burst. No byte capture of the endpoint description is retained. |
| Ten recorded query URLs (Ethiopia coffee and oilseeds; Cambodia rice and cassava; Senegal banana and fish) | `comtradeapi.un.org` | `sha256:90756ca9…`, `35029db0…`, `8e263fc3…`, `3f942592…`, `6c6aef87…`, `16468b30…`, `51b5d10e…`, `f1699005…`, `b7aeb149…`, `1452ce6a…` (retained captures in `docs/research/country-packs/sources/trade/`) | 2026-10-12 | Each re-fetched 14 Oct 2026: HTTP 200, one row, all thirteen compared fields identical to the retained capture. The 14 Oct bytes were not retained, so the pinned versions stay the 2026-10-12 captures. |

The ten empty previews are recorded in the exemplar's evidence gaps with their query URLs — they have no byte capture, so none is cited as a pinned version.

## What is blocked

- **No consenting beneficiary has been selected.** External implementation evidence and any measured outcome are blocked on that dependency, so this mission cannot move past the owner-approved stage in this build.
- **An adoption declaration is not implementation.** If a mission owner later declares that they use this table, that declaration is their own, with their own evidence; it is not implementation and not an institutional act.
- **No outreach.** No message has been sent to the provider or anybody else, and nothing here authorises one.

## What the quality module says

Run against the seeded 1 015-proposal corpus: `missing: []`, `signals: []`, `complete: true`, closest corpus entry `SO-17-interventions` at **0.0793** against the 0.6 duplicate threshold. The full output is in `docs/handoff/task-c-mission-exemplars.md`.

# Companion — Pin where Nepali tea production and harvested area are published

`ex-nepal-tea-production-figure.exemplar.json` · area **Agriculture** · status: **proposal.** Not activated. No task claimed, no contribution submitted, no review recorded, nothing adopted, nobody contacted.

## What this mission is

The retained Nepal country pack records, in its own evidence-gap list, that **no Nepali tea production or harvested-area figure was obtained**: the bounded provider previews returned zero rows and no FAOSTAT or ITC figure was extractable. The pack names two places the figure could come from — the National Tea and Coffee Development Board and the National Statistics Office — and does not say what either one publishes.

This mission closes one bounded gap: find the document that states the annual tea quantity and the tea land figure, and pin it — or record, in the mission's own terms, that neither named body publishes it. That second outcome is a legitimate deliverable, and the rubric requires it rather than a substituted number.

## The question

> Which Nepali document states tea production quantity and harvested area for the most recent complete fiscal year, and what value, unit and fiscal-year basis does it state?

Note what is *not* asked: not the export volume, not the buyer, not the price, not the eligibility. The retained pack leaves all of those unverified, and the exemplar's `not_established` list repeats them so nobody reads this mission as a market study.

## What would count as evidence

- The publisher, the document title, the page or table, the fiscal-year basis the publisher uses, the unit, the retrieval date and the checksum of the bytes captured.
- Any label the publisher puts on the number — estimate, projection, preliminary, revised — carried with it. A modelled or modelled-from-ILO value is never presented as a national count.
- Fiscal years written exactly as the publisher writes them, never silently converted to calendar years.
- If no figure is published: the pages checked, their dates, and the statement that it is not published. Not a figure from another publisher, another product or another year.

## What it would **not** establish

- It would not establish that any figure found is current, complete or consistent with a later revision.
- It would not establish an export volume, a price, a buyer, demand, supplier capacity, eligibility or any economic return, and it may not be used to infer them from a production quantity.
- The registered World Bank series for Nepal (`NV.AGR.TOTL.ZS`, `SL.AGR.EMPL.ZS`, `AG.LND.ARBL.ZS`) cannot stand in: value added includes forestry and fishing, and arable-land share is a land classification, not tea harvested area. Both are named in the source register so they are not mistaken for the answer.
- It would not establish producer capacity, land tenure, irrigation or seasonality.
- It would not establish any outcome for anyone. Nothing here is implemented and nothing is measured.

## Sources, and how far each was checked

| Source | Host | Version cited | Date read | How far it was checked |
| --- | --- | --- | --- | --- |
| National Tea and Coffee Development Board | `www.teacoffee.gov.np` | page as read 2026-10-12 (no byte capture retained) | 2026-10-12 | Re-read 14 Oct 2026: reachable, but the readable text carried the board's name in Nepali and English and its Kirtipur address only — no statistics table. The publication route is unresolved, not absent. |
| National Statistics Office | `nsonepal.gov.np` | page as read 2026-10-12 (no byte capture retained) | 2026-10-12 | Re-read 14 Oct 2026: reachable, header text only. Whether the office publishes a tea quantity or tea land figure was not established. |
| World Bank WDI, Nepal `NV.AGR.TOTL.ZS` | `api.worldbank.org` | `sha256:97f63f8a…` (retained raw file `catalog/statistics/NPL-NV.AGR.TOTL.ZS-97f63f8a276a8b93.json`) | 2026-10-11 | Retained capture with its checksum; not re-read for this exemplar. Named as context, not as the answer. |
| World Bank WDI, Nepal `AG.LND.ARBL.ZS` | `api.worldbank.org` | `sha256:c7929f77…` (retained raw file `catalog/statistics/NPL-AG.LND.ARBL.ZS-c7929f77eac0f746.json`) | 2026-10-11 | Retained capture with its checksum; not re-read for this exemplar. Named so it is not mistaken for tea harvested area. |

The two national sources are named by the retained country pack as read and reachable on 12 October 2026, and both answered again on 14 October 2026. **Neither was reached with a retained byte capture, and neither was asked for anything** — reading a public page is not a request to the publisher.

## What is blocked

- **No consenting beneficiary has been selected.** No producer group, cooperative, municipality, exporter or buyer has consented to be measured or to receive anything, so external implementation evidence and any measured outcome are blocked on that dependency and this mission cannot move past the owner-approved stage in this build.
- **An adoption declaration is not implementation.** A briefing built from this work and then declared adopted by a mission owner is that owner's declaration, with their own supporting evidence — not proof that any body acted on it.
- **No outreach.** No message has been sent to either national body, and nothing here authorises one. The mission's own limits say so.

## What the quality module says

Run against the seeded 1 015-proposal corpus: `missing: []`, `signals: []`, `complete: true`, closest corpus entry `NP-2-destination` at **0.1671** against the 0.6 duplicate threshold. That nearest neighbour is the closest any exemplar comes to a seeded proposal, and it is recorded here rather than hidden: the two questions differ in subject (a registered-sector scope choice for SDG 2 against one named national publication for one commodity quantity), and the module's distinguishing tokens for that pair are `np`, `left`, `remain`, `blended`, `activation`. The full output is in `docs/handoff/task-c-mission-exemplars.md`.

# Mission exemplars (Wave C)

Three **missions**, not proposals in the sense the seeded corpus uses that word: each carries a title, an area, an owner and reviewer slot, a beneficiary, one answerable question, evidence criteria, stated limits, reuse rights, a source register in which every source has a URL, a date and a version, and a companion written in plain language. Nothing here is activated, claimed, submitted, reviewed or adopted. **No consenting beneficiary has been selected, so external implementation evidence and any measured outcome are blocked on that dependency, and a mission owner's recorded adoption declaration would be a declaration, not implementation.**

The point of the folder is deliberate scarcity. The seeded ~1,015 country and pilot entries are proposals generated from a concern model, and 1,009 of them sit within 0.6 of a sibling by the quality module's own duplicate measure. Volume is not what is missing. What is missing is a handful of missions that a human could pick up, and the ability to check that in CI rather than in a one-off report.

| Exemplar | Area | Question (short) |
| --- | --- | --- |
| [ex-sids-count-reconciliation](ex-sids-count-reconciliation.exemplar.json) · [companion](ex-sids-count-reconciliation.md) | Development | Which named countries or areas appear on only one of the two retained versions of the small island developing States group, and what does each publisher's own composition statement say about the entries the two versions disagree about? |
| [ex-retained-trade-capture-reproduction](ex-retained-trade-capture-reproduction.exemplar.json) · [companion](ex-retained-trade-capture-reproduction.md) | Governance | Which of the ten retained country-pack trade captures still reproduce from the provider query recorded behind it, and where a response differs, which provider field explains the difference? |
| [ex-nepal-tea-production-figure](ex-nepal-tea-production-figure.exemplar.json) · [companion](ex-nepal-tea-production-figure.md) | Agriculture | Which Nepali document states tea production quantity and harvested area for the most recent complete fiscal year, and what value, unit and fiscal-year basis does it state? |

## What the exemplar files carry

Each `*.exemplar.json` is a single JSON document in the shipped `mission` / `task` shape, plus the fields the quality module reads:

- `mission.title`, `mission.area`, `mission.summary`, `mission.owner`, `mission.beneficiary`, `mission.reviewer`, `mission.rubric` — the shipped `createMission` fields, where `rubric` **is** the evidence-criteria field;
- `task.title`, `task.instructions`, `task.rights`, `task.allowed_domains` — the shipped `createTask` fields, including the approved source hosts a real task needs;
- top-level `question`, `limits`, `rights`, `sources` — the module's own fields, each source carrying `url`, `location`, `date` and `version`;
- `blocked_dependency`, `assignment`, `activation_check`, `evidence_gaps`, `not_established`, `verification` — the disclosure that keeps the document honest about what it is not.

The companion markdown is not a summary of the JSON. It says what the mission is, what would count as evidence, what it would **not** establish, how far each source was actually checked, and what is blocked.

## The owner, reviewer and beneficiary slots

The brief forbids inventing a source, a contact or an institutional relationship, and no consenting beneficiary exists in this build. So the owner and reviewer are declared **role slots** whose own text says that no human has been named, and the beneficiary names the party class the work is for together with an explicit statement that nobody has been selected, consented or contacted. The quality module reports those fields as present and carries the unassigned wording through into its own output, and the test asserts that it does. Naming a human owner, a human independent reviewer and a beneficiary is a prerequisite before any of these can be created.

## Checking them

`tests/mission-exemplars.test.js` loads every `*.exemplar.json` in this folder and asserts, against the seeded corpus: no missing field, no `near_duplicate`, every source dated and versioned, a reviewer distinct from the owner, the blocked-dependency marker present, the companion present and carrying the same statement, and the strings within the shipped column caps so the mission could actually be created.

```bash
node --test tests/mission-exemplars.test.js
```

The measured results, the sources with the depth of their checking, and the gaps are in [`docs/handoff/task-c-mission-exemplars.md`](../../handoff/task-c-mission-exemplars.md).

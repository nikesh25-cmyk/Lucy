# Complete mayor roster verification

> **Historical record — pre-ambassador release.** This verification describes the schema 14 release,
> in which the twenty regional guides were the only civic residents. Since task 01 the guides are
> retained as compatibility aliases mapped to the 248 country ambassadors; the roster, names and
> patrol behaviour below still describe those guide rows accurately, but they are no longer the
> primary civic identity. See [task 01 handoff](handoff/task-01-country-ambassadors.md).

Verified 12 October 2026 against the current regional research release. Twenty sequential HTTP introductions used the installed official Qwen3-4B Q4_K_M runtime in an isolated database. All twenty returned local-model responses identifying the expected mayor and region; the stated civic focuses were also reviewed against the catalog. No production account or dialogue was created.

| Mayor | Region | Mode | Identity |
| --- | --- | --- | --- |
| Asha | Highlands | Local model | Name and region matched |
| Tenzin | Snowline | Local model | Name and region matched |
| Mira | Foothills | Local model | Name and region matched |
| Sora | Riverlands | Local model | Name and region matched |
| Nadi | Wetlands | Local model | Name and region matched |
| Ilan | Woodlands | Local model | Name and region matched |
| Amara | Rainforest | Local model | Name and region matched |
| Kito | Grasslands | Local model | Name and region matched |
| Leila | Farmlands | Local model | Name and region matched |
| Samir | Drylands | Local model | Name and region matched |
| Zahra | Desert | Local model | Name and region matched |
| Ayo | Savanna | Local model | Name and region matched |
| Marin | Coast | Local model | Name and region matched |
| Kai | Islands | Local model | Name and region matched |
| Nila | Harbor | Local model | Name and region matched |
| Rumi | Cities | Local model | Name and region matched |
| Tala | Workshops | Local model | Name and region matched |
| Pema | Gardens | Local model | Name and region matched |
| Elio | Lakes | Local model | Name and region matched |
| Noor | Commons | Local model | Name and region matched |

The isolated fixture recorded twenty conversations, zero submissions and a valid audit at completion. Its temporary world/model process was stopped after the run. Credentials and model keys are absent from the retained report.

Installed-world verification matched all twenty names, regions and focuses; all twenty were active and advanced patrol ticks during the observation window. 20 changed position in that window. A patrol tick can legitimately meet a blocked tile; this is not a claim that every tick changes position. Public mayor responses exposed zero private conversations. Schema-seven validation passed with zero human accounts and configured local model health.

## Scope and limits

This is an English introduction/roster smoke check, with one question per mayor. It does not establish general factual accuracy, adversarial or multilingual quality, concurrent throughput, country authority, completed research or real institutional adoption. Mayors remain fictional civic guides with advisory triage. Human moderators decide enforcement and appeals. Existing broader failure-case evaluations and their conservative fallback rules remain applicable.

Full response evidence: `verification/mayor-roster-2026-10-12.json`. Local deliverables also retain `mayor-roster-installed-verification.json`. Existing platform runtime source is unchanged by this verification release; the 199-test regional research gate was the code verification at that milestone (the current suite is authoritative from `npm test`; see `docs/VERIFICATION.md`).

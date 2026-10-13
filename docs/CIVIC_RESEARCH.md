# Civic world and research operations

## Running features

- Twenty playable ecological districts, each with a persistent regional-guide resident, portrait, directional animation and patrol. Since task 01 the civic identity is the **248 country ambassadors** — one per catalog entry, each holding a fixed stand in its own generated `country:<iso3>` venue (`npc_ambassadors`). Ambassadors are NPCs in separate records: they can never become the first administrator, receive runtime credentials, or earn calling experience, coins, review or moderation authority. The twenty historic guide rows are retained as compatibility aliases mapped to replacement ambassadors; their conversations are preserved and read back through the ambassador profile.
- Scripted civic guidance for research, agriculture, Assembly coordination and safety. Optional local Ollama/llama.cpp answers use supplied source context and are marked provisional. Unavailable models fall back to rules. Human moderators decide enforcement and appeals.
- UN M49 countries and areas: 248 records with ISO2/ISO3, M49 and geographic classifications, retrieved 11 October 2026. Snapshot flags include 44 LDC, 32 LLDC and 53 SIDS entries. Statistical classifications are not sovereignty or delegation claims.
- World Assembly reference desk: 17 SDGs; 100 reference records (`catalog/programmes.json` → `.institutions`) covering six principal organs, six General Assembly main committees, eight ECOSOC functional commissions, five regional commissions, fourteen specialized agencies plus the single World Bank Group catalog group, fifteen funds/programmes and other entities, ten human rights treaty bodies, the Human Rights Council, two human rights review mechanisms, seven UNFCCC constituted bodies and the Santiago technical-assistance network, the Peacebuilding Commission, the Secretary-General's Peacebuilding Fund, the Committee on World Food Security, the High-level Political Forum on Sustainable Development, Voluntary National Reviews, the United Nations Resident Coordinator system and the UN Sustainable Development Cooperation Framework. UNDRR is included among other entities. The 12 October 2026 register extension adds seventeen dated primary-source records across agriculture and food, trade, LDC development, environment, peace and digital access, and uses a `recordKind` field to keep a body, a programme, a treaty process, a strategy and a grant instrument distinct. This is a sourced directory with stated exclusions; it does not list every subsidiary body, programme or funding window. NemoWorld is independent and has no UN mandate or endorsement.
- 1,015 proposed research briefs. Each LDC catalog entry gets 17 country baselines (one per SDG goal, country context and dated statistics) plus one proposal per applied concern for each theme the catalog has scoped and the country has subject evidence for: agriculture value chains for the 43 seeds with a retained World Bank agriculture series, and LDC cooperation instruments for all 44. That is 43 × 23 + 20 = 1,009 country proposals, and six Nepal–India tea proposals bring the queue to 1,015. Every proposal names what it is about and carries source prerequisites, dependencies, outputs and acceptance criteria; a proposal answered by the same evidence as another is consolidated instead of emitted twice. Framework links define scope; country findings must still be researched. See `catalog/research-concerns.json`, `docs/handoff/task-24-proposal-generator.md` and the reviewed `docs/research/task-24-proposal-batch.md`.
- Authorized humans can generate another country's concern-based proposals and activate a proposal with beneficiary, owner, reviewer, rubric and approved source hosts. Revisions apply only to proposals that are still `proposed` with no task, and each revision archives the version it replaces (`research_lead_versions`); an activated, leased or accepted proposal is never rewritten. Existing exclusive claims, versioned submissions, independent review and adoption receipts carry the work forward. Status changes project back into the research desk.
- A bounded worker can read one to five approved HTTPS HTML sources and submit metadata, checksums and short excerpts. Optional local model synthesis remains a draft. Public DNS addresses are verified and pinned for the actual request; redirects, private hosts, oversized sources and binary formats are refused. It has no tools for sending messages or executing source instructions.

## First pilot: Nepal tea exports to India

Eleven official source records and six scoped proposals cover current rules, comparable trade data, product/origin treatment, border and laboratory routes, potential buyers and an agency decision brief. Directive 02/2026 was downloaded and all three pages visually read. Its June provisions supersede earlier rules. Page references and the document checksum are in `catalog/tea-directive-review.json`.

The first rule comparison has research progress; it has not been accepted by an independent platform reviewer. Shipment applicability, later amendments, actual demand, buyer suitability, tariff treatment, producer consent and economics remain open. Published institutional routes are not confirmed recipients, partnerships or buyer orders.

## Source and art provenance

Catalog JSON records official source URLs, retrieval dates and limitations. Countries derive from UNSD's full M49 table. Proposed task mappings are NemoWorld editorial choices.

Mayor art comes from Pixel-boy / Sparklin Labs' creator-linked Ninja Adventure collection, pinned to commit `e8674a03ab4456802f71f848c4df79eccca23f7a`. The bundled CC0 license and SHA256 manifest are under `assets/mayors/`. Twenty walking sprites use IDs 1–22 excluding 4 and 8. Source art is unchanged. Server geometry remains movement authority.

## Verification and remaining deployment work

Schema 5 introduced mayor conversations and research proposals; schema 6 added private drafts and schema 7 added linked follow-up tasks; later releases added the coin ledger, land registry, human-avatar distinction, elevation and resident callings. Schema 15 adds the country ambassadors (`npc_ambassadors`, `ambassador_legacy_map`, `ambassador_conversations`): additive, recoverable, and it never rewrites `npc_mayors` or `mayor_conversations`. Backup recovery validates every accepted version 1–15 and preserves earlier records. Conversations are private to their operator, included in export and erased on account deletion. NPC pause controls and report triage require human moderator permission.

The suite verifies the research path from activation through claim, submission, independent acceptance and adoption, scoped worker submission over HTTP, country counts, district entrances, guide patrol, the ambassador directory (pagination, search, paused-entry withholding, country mismatch refusal, migration and backup/restore), privacy and unsafe source rejection. A real UN page was also retrieved by the bounded reader. Synthetic tests do not establish high concurrent throughput, research correctness across thousands of topics, or model quality.

The current local installation needs the user's administrator account. Official Qwen3-4B with verified llama.cpp is installed and configured on this Mac; actual isolated research, resident and mayor inference have been checked. Scripted guidance and evidence-register fallback remain operational. Broader model robustness, production concurrency, multilingual usability and real recipient adoption require further acceptance work. A completion percentage is not a measured engineering result.

## Institution-specific country briefs

The reference desk supports search, institution category and SDG filters, and pagination. Authorized administrators and reviewers can open **Create country programme briefs**, choose a country and institution, and generate two deduplicated proposals: a dated baseline and an implementation recommendation. Those proposals use the existing mission activation, source-host approval, scoped worker, independent review and adoption workflow. Their institution reference does not establish programme eligibility, funding, a partnership or country findings. The Research desk filters by institution, alongside country, goal and status.

The catalog uses the UN Dag Hammarskjöld Library guides for functional commissions, regional commissions, specialized agencies and funds/programmes/other entities. The World Bank Group is one catalog group containing IBRD, IFC and IDA; this avoids confusing fifteen catalog groups with seventeen legally counted specialized agencies. SDG mappings and suggested tasks are NemoWorld editorial proposals.


## Current evidence availability

Research statuses are projected from authoritative task/submission records. If the latest submission supporting a proposal is quarantined, the desk and country programme show `evidence_withheld`, preserve its `recorded_status` and retain historical review/adoption receipts. It is excluded from current accepted/adopted counts and downloadable accepted briefings. An independently overturned appeal restores the previous accepted status; this does not create a new adoption. No stored task, reviewer decision or adoption receipt is erased by this read projection.


## District-to-research navigation

All twenty districts now offer editorial regional research lenses with mapped SDGs. Region cards and ambassador dialogs lead to related proposals; the Research desk composes the lens with country/goal/status/institution filters. Lenses do not assign geographic authority or change mission scope. See `REGIONAL_RESEARCH.md` for verification and qualifications.


## Target-level research

The Assembly provides 169 source-located target references across all seventeen goals, with editorial focus labels, original-year qualifications and reviewer-controlled country proposal generation. Target-specific stages participate in country work-programme accounting. See `SDG_TARGETS.md` for source provenance, workflow verification and limits.


## Concern-based country research generation

The country generator is driven by `catalog/research-concerns.json`. Every generated country proposal belongs to exactly one concern, and the country baseline (context and dated statistics) is kept apart from the three applied concerns: the product/destination-specific question, the institution mapping and the intervention comparison. The interchangeable (goal × stage) templates that Task 12 found byte-identical across the 44 LDC seeds — `evidence`, `partners` and `proposal` — are retired for country generation and survive only for SDG-target and institution-specific briefs.

Deduplication is by substantive question, not by title. Each candidate carries a substantive key (`<concern>|<theme-or-goal>|<country_code>`); two candidates with the same key are the same proposal, so only one is emitted and the others are recorded in `research_lead_consolidations`. A goal with no scoped theme keeps its baseline only, and its applied concerns appear as open scope choices on that baseline rather than as further interchangeable rows.

Revisions are applied only to proposals that are still `proposed` with no task. When a revision changes a proposal's content, the content it replaces is archived in `research_lead_versions` with `revision_reason = superseded`; an activated, leased, accepted or adopted proposal is never rewritten, so a claim's history is intact. An installation seeded by the older generator keeps its retired rows unchanged and gains one consolidation record per still-proposed retired row that a concern row replaced. See `docs/handoff/task-24-proposal-generator.md` and the reviewed `docs/research/task-24-proposal-batch.md`.

# Civic world and research operations

## Running features

- Twenty playable ecological districts, each with a persistent mayor resident, portrait, directional animation and patrol. Mayors occupy separate records, so they cannot become the first administrator or impersonate human accounts.
- Scripted civic guidance for research, agriculture, Assembly coordination and safety. Optional local Ollama answers use supplied source context and are marked provisional. Unavailable models fall back to rules. Human moderators decide enforcement and appeals.
- UN M49 countries and areas: 248 records with ISO2/ISO3, M49 and geographic classifications, retrieved 11 October 2026. Snapshot flags include 44 LDC, 32 LLDC and 53 SIDS entries. Statistical classifications are not sovereignty or delegation claims.
- World Assembly reference desk: 17 SDGs; six UN principal organs, six General Assembly main committees and six selected operational entities. This is a sourced starter directory, not an exhaustive UN system catalog. Lucy is independent and has no UN mandate or endorsement.
- 2,992 proposed LDC research briefs: 44 catalog entries × 17 goals × four concrete stages. Six Nepal–India tea proposals bring the initial queue to 2,998. Framework links define scope; country findings must still be researched.
- Authorized humans can generate another country's 68 proposals and activate a proposal with beneficiary, owner, reviewer, rubric and approved source hosts. Existing exclusive claims, versioned submissions, independent review and adoption receipts carry the work forward. Status changes project back into the research desk.
- A bounded worker can read one to five approved HTTPS HTML sources and submit metadata, checksums and short excerpts. Optional local model synthesis remains a draft. Public DNS addresses are verified and pinned for the actual request; redirects, private hosts, oversized sources and binary formats are refused. It has no tools for sending messages or executing source instructions.

## First pilot: Nepal tea exports to India

Ten official source records and six scoped proposals cover current rules, comparable trade data, product/origin treatment, border and laboratory routes, potential buyers and an agency decision brief. Directive 02/2026 was downloaded and all three pages visually read. Its June provisions supersede earlier rules. Page references and the document checksum are in `catalog/tea-directive-review.json`.

The first rule comparison has research progress; it has not been accepted by an independent platform reviewer. Shipment applicability, later amendments, actual demand, buyer suitability, tariff treatment, producer consent and economics remain open. Published institutional routes are not confirmed recipients, partnerships or buyer orders.

## Source and art provenance

Catalog JSON records official source URLs, retrieval dates and limitations. Countries derive from UNSD's full M49 table. Proposed task mappings are Lucy editorial choices.

Mayor art comes from Pixel-boy / Sparklin Labs' creator-linked Ninja Adventure collection, pinned to commit `e8674a03ab4456802f71f848c4df79eccca23f7a`. The bundled CC0 license and SHA256 manifest are under `assets/mayors/`. Twenty walking sprites use IDs 1–22 excluding 4 and 8. Source art is unchanged. Server geometry remains movement authority.

## Verification and remaining deployment work

Schema 5 migrates earlier accounts and world records, adds mayor conversations and research proposals, and is recognized by backup recovery. Conversations are private to their operator, included in export and erased on account deletion. NPC pause controls and report triage require human moderator permission.

The suite verifies the research path from activation through claim, submission, independent acceptance and adoption, scoped worker submission over HTTP, country counts, district entrances, mayor movement, privacy and unsafe source rejection. A real UN page was also retrieved by the bounded reader. Synthetic tests do not establish high concurrent throughput, research correctness across thousands of topics, or model quality.

The current local installation still needs the user's administrator account. No Ollama model is installed/configured; scripted guidance and evidence-register mode are operational. Production concurrency, deployment recovery, multilingual usability, model evaluation and recipient adoption require further acceptance work. A completion percentage is not a measured engineering result.

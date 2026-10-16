# UN programme and committee source register — review

Checked 12 October 2026. Task 11 extends `catalog/programmes.json` from 83 to **100 reference records** with 17 dated primary-source entries covering agriculture and food, trade, LDC development, environment, peace and digital access.

The register is an independent NemoWorld research reference. It is not a UN directory, and it establishes **no UN endorsement, financing, adoption, membership or institutional participation in NemoWorld**. Every record carries `mappingStatus` stating that the task suggestions, country checks and SDG mapping are NemoWorld editorial proposals and not a UN instruction.

## What was added, and how each entry is kept distinct

Each record records jurisdiction/remit, eligibility, implementation evidence, the public access route, the research task it can support, country research checks, an evidence locator, the source URL, the retrieval timestamp and the response SHA256. Tasks generated from a record inherit those country checks and the retrieval qualification.

A new `recordKind` field keeps the five forms apart instead of flattening them into one list. The `type` field keeps the finer publication category that the reference desk displays.

| Record | `recordKind` | `type` | Domain | Primary source (retrieved 12 October 2026) |
| --- | --- | --- | --- | --- |
| Codex Alimentarius Commission | programme | food-standards-programme | agriculture/food | https://codex.fao.org/home |
| International Treaty on Plant Genetic Resources for Food and Agriculture | treaty-process | treaty-process | agriculture/food | https://www.fao.org/plant-treaty/en/ |
| FAO Committee on Agriculture (COAG) | body | governing-body | agriculture/food | https://www.fao.org/coag/en |
| UN Commission on International Trade Law (UNCITRAL) | body | subsidiary-body | trade | https://uncitral.un.org/en/about |
| Office of the High Representative for LDCs, LLDCs and SIDS (UN-OHRLLS) | body | development-office | LDC development | https://www.un.org/ohrlls/ |
| Technology Bank for the Least Developed Countries | programme | development-institution | LDC development | https://www.un.org/technologybank/en |
| UN Environment Assembly (UNEA) | body | governing-body | environment | https://www.unep.org/environmentassembly/ |
| Convention on Biological Diversity (CBD) | treaty-process | treaty-process | environment | https://www.cbd.int/ |
| Kunming-Montreal Global Biodiversity Framework | strategy | strategy-instrument | environment | https://www.cbd.int/gbf |
| UN Convention to Combat Desertification (UNCCD) | treaty-process | treaty-process | environment | https://www.unccd.int/convention/overview |
| Global Environment Facility (GEF) | grant-instrument | financing-instrument | environment | https://www.thegef.org/who-we-are |
| Green Climate Fund (GCF) | grant-instrument | financing-instrument | environment | https://www.greenclimate.fund/about |
| Adaptation Fund | grant-instrument | financing-instrument | environment | https://www.adaptation-fund.org/about/ |
| Department of Political and Peacebuilding Affairs (DPPA) | body | peace-and-security-entity | peace | https://dppa.un.org/en/ |
| UN Peacekeeping | body | peace-and-security-entity | peace | https://peacekeeping.un.org/en |
| Women, Peace and Security agenda (S/RES/1325) | strategy | strategy-instrument | peace | https://www.un.org/womenwatch/osagi/wps/ |
| Global Digital Compact | strategy | strategy-instrument | digital access | https://www.un.org/global-digital-compact/en |

Kind totals: 6 bodies, 2 programmes, 3 treaty processes, 3 strategies and 3 grant instruments. Environment is deliberately the widest domain (7 records) because a treaty secretariat, a governing assembly, a strategy and three different financing instruments do genuinely different things and must not be read as interchangeable. The three funds are kept apart: GEF is the financial mechanism for six conventions, GCF is an operating entity of the UNFCCC financial mechanism, and the Adaptation Fund is a Kyoto/Paris instrument with Direct Access accreditation.

### Differences the register preserves

- A **body** (COAG, UNEA, UNCITRAL, UN-OHRLLS, DPPA, UN Peacekeeping) makes decisions, convenes or advises. Its output is guidance, mandates or legal texts.
- A **programme** (Codex, Technology Bank) runs a standing technical process with published products. A Codex standard or a technology needs assessment is a product of a programme, not a decision binding a State.
- A **treaty process** (plant genetic resources treaty, CBD, UNCCD) has Parties, entry into force, protocols, a Conference of the Parties and reporting obligations.
- A **strategy** (Global Biodiversity Framework, Women, Peace and Security agenda, Global Digital Compact) states goals and commitments. It binds no State directly and is not a programme with a budget line.
- A **grant instrument** (GEF, GCF, Adaptation Fund) has eligibility, an accreditation path, committed amounts and disbursement. A description of a fund is not eligibility, an approved application or a transfer of money.

Each record's `implementationEvidence` states what the published record does and does not show. Reported commitments are explicitly separated from disbursement and outcomes in the three funds; committee and assembly outputs are separated from national adoption; national reporting is separated from independent measurement.

## Retrieval evidence

All 17 primary sources were retrieved live on 12 October 2026 with the project's bounded reader (`runtime/research-worker.js` `readSource`: public DNS-pinned TLS, HTTPS only, HTML/plain text, one megabyte limit, redirects refused). Original-response SHA256, response timestamp, page title, extraction type and extracted character count are retained per record in `docs/research/un-register-sources.json` and echoed in each record's `sourceVerification`.

One qualification is recorded rather than smoothed over: the Global Biodiversity Framework page (`https://www.cbd.int/gbf`) was retrieved and hashed, but it is client-rendered, so only the page frame and title were readable. Its `sourceCheckNote` says so, and the framework text must be read from the Convention pages and the adopted decision record before use.

## What was deliberately not added

- **World Trade Organization.** An intergovernmental organization outside the UN system. It is referenced by UN instruments but is not a UN programme, committee or treaty process, so it was excluded rather than hidden inside `dataSources`. The exclusion is now stated in `coverage.exclusions`.
- **Enhanced Integrated Framework.** The main LDC trade-capacity grant instrument, but its official site is WTO-hosted rather than a UN domain. It is recorded here as unresolved coverage instead of being presented as a UN source.
- **Internet Governance Forum and the ITU Telecommunication Development Sector.** The natural digital-access entries beyond the Global Digital Compact, but both hosts returned unsupported responses to the bounded reader (§ unresolved coverage).
- **UNCTAD Trade and Development Board** and the **Committee for Development Policy**. These would have completed the trade-governing-body and LDC-status pairs, but neither host could be retrieved during this check, and the register does not assert an unverified mandate.
- **Basel, Rotterdam and Stockholm Conventions and the Minamata Convention.** Additional treaty processes whose sites returned no readable text to the reader; their attempted URLs and errors are in the evidence ledger's `notRetrieved` list.
- **Secretary-General's High-level Advisory Body on Artificial Intelligence.** Its mandate concluded and its recommendations are now carried by the Global Digital Compact, so adding it would sit against the catalog's stated exclusion of historical bodies.

## Duplicates avoided

Every added record was checked against the existing 83 before insertion: no added `id` collides, and no added record reuses an existing record's `sourceUrl` (asserted by a new test). Deliberate near-neighbours and why they are still separate:

- **FAO, IFAD, WFP and CFS** already cover the food agencies and the food-security platform. Codex is the standard-setting programme and the plant genetic resources treaty is a treaty process, so both add a form the desk did not have.
- **UNEP** already exists; UNEA is its governing assembly and is a different kind of record.
- **UNFCCC constituted bodies and the Santiago network** already exist; GEF, GCF and the Adaptation Fund are financing instruments, not constituted bodies.
- **Peacebuilding Commission and Peacebuilding Fund** already exist; DPPA and UN Peacekeeping are Secretariat and mission actors.
- **ITC, UNCTAD and the Second Committee** already cover trade; UNCITRAL is the legal body and the only added trade record.
- **ITU, UPU and the Commission on Science and Technology for Development** already cover digital-adjacent mandates, which is why digital access adds only the strategy instrument.

## Domains covered

| Domain | Added | Also already present |
| --- | --- | --- |
| Agriculture and food | 3 | FAO, IFAD, WFP, CFS |
| Trade | 1 | ITC, UNCTAD, Second Committee |
| LDC development | 2 | Doha Programme of Action framework, Fifth Committee, LDC Expert Group (climate) |
| Environment | 7 | UNEP, Forum on Forests, UNFCCC constituted bodies |
| Peace | 3 | Security Council, Peacebuilding Commission, Peacebuilding Fund, First Committee |
| Digital access | 1 | ITU, UPU, CSTD, UNCTAD |

## Unresolved and missing coverage

Recorded honestly here and in `catalog/programmes.json` → `coverageGaps`:

1. The extension adds one entry per domain, not a complete system map. Commodity-specific programmes, individual treaty procedures, subsidiary committees, working groups and most funding windows remain uncovered.
2. Trade-governance and digital-access bodies whose sites the bounded reader could not process — the UNCTAD Trade and Development Board, the Internet Governance Forum, the ITU Telecommunication Development Sector, UNECE trade and UN/CEFACT, the Committee for Development Policy — are unresolved, not covered. The attempted URLs and error messages are in `docs/research/un-register-sources.json`.
3. Site retrieval is a snapshot. Entry into force, reservations, current membership, eligibility windows, replenishment periods and funding decisions are not verified by these overview pages and need dated primary-source research per country and per question.
4. LDC group counts differ between official sources: the UN-OHRLLS page states 44 least developed countries, 32 landlocked developing countries and 39 small island developing States, while the catalog's UN M49 snapshot flags 44 LDC, 32 LLDC and 53 SIDS. Both are recorded with their own source and are not reconciled automatically, because the definitions of the SIDS group differ between publishers.
5. Reported figures are attributed, not verified: the GEF, GCF and Adaptation Fund totals in the records are the funds' own published figures and are labelled as reported amounts, not as independently audited results.
6. The register adds reference records only. It does not generate proposals in the saved world, does not activate missions, and implies no eligibility, financing or authority to contact any institution.

## Verification

- `tests/programme-coverage.test.js` gains a register test: 17 added records, all five kinds present and counted, per-depth required fields, dated retrieval proof on every record, one primary source per record with no reuse of a pre-existing source URL, four domains generating two deduplicated country proposals each and preserving the country checks and outreach limit through activation, and zero automatic submissions or adoptions.
- Three pinned counts legitimately changed from 83 to 100 because 17 records were appended to `.institutions` (`tests/civic-engine.test.js` and two assertions in `tests/programme-coverage.test.js`). The reconciliation assertion `sum(countsByType) === institutions.length` is kept and now holds at 100.
- `app.js` gained category labels for the nine new types and shows each record's `recordKind` and register facts. No other UI or server behaviour changed.

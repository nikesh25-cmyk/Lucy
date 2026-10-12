# DeepSeek tasks, in priority order

Paste START_HERE.md, then one task. Each task is a separate deliverable; do not attempt all tasks in one unreviewable rewrite.

## 01 — Country ambassadors replacing regional mayors

Status: reviewed and integrated locally. Retained below as the original task brief. Review corrections are in `docs/reviews/task-01-country-ambassadors.md`. Next: Task 02.

Implement the user's new civic direction: a NemoWorld AI ambassador for every country in `catalog/countries.json`, with one stable identity per catalog entry. The catalog currently contains countries AND areas, so preserve that distinction in labels; do not describe all 248 entries as sovereign states. The region map remains ecological terrain, while country affiliation is the ambassador's research remit.

Inspect `src/civic-engine.js`, `src/civic.js`, `src/mayor-evidence.js`, `src/spaces.js`, `src/database.js`, `src/recovery.js`, `world.js`, `server.js`, `app.js`, `src/vocations.js` and the civic/content/evidence tests. Current NPC storage is `npc_mayors`; conversation history references its IDs. Create an additive, recoverable migration and an explicit compatibility mapping for the old 20 guides. Preserve old conversation records, paused states, receipt hashes and saved world objects. Choose and document a deterministic country venue strategy that works with authoritative movement and world access; do not place 248 avatars at one coordinate or silently invent country land inside the finite frontier.

Add paginated/searchable ambassador directory, country-filtered profiles and conversations, country research links, and map-accessible country venues. Ambassador answers must automatically use their assigned country context and its source numbers; they cannot impersonate a government or the UN. Replace visible mayor terminology in navigation, guide text, portraits, conversation panels and introductory copy. Keep legacy API routes as documented compatibility aliases where needed.

Acceptance: exactly one ambassador per catalog entry after initial boot and restart; country mismatch refused; all ambassadors accessible through pagination; historical conversations readable; inactive/private data excluded; NPCs cannot receive resident credentials, XP, coins, review or moderation powers; migration/backup restoration works; old and new API compatibility tested. Include a browser walkthrough on a disposable database. Update docs and the sealed content roster only through the existing sealing workflow.

## 02 — First-person physical world coherence

Audit authored scenery against walkable terrain and the true first-person camera. Ensure a walking resident cannot appear inside decorative roofs, trees, furniture or navigation markers. Add a shared collision/footprint definition where needed, with matching server pathfinding, spawn, placement and renderer behavior. Preserve one-layer step-up and two-layer headroom. Add accessible controls and a readable first-person reticle/selection hint. Do not add a fake jump button or claim continuous physics if only grid stepping exists.

Files: `src/voxel-world.js`, `src/voxel-geometry.js`, `src/elevation.js`, `src/world-walk.js`, `world.js`, `src/frontier.js`, `src/spaces.js`, `src/camera-controls.js`, `app.js`. Acceptance: reproducible first-person route through Commons and frontier; scenery and server movement agree; camera stays at the resident's elevation; invalid placements/true traps refused; camera rotation does not issue movement or duplicate a drag; fallback and keyboard controls work.

## 03 — Whole-object pruning of AI observations

Replace the current final 17,000-character JSON string truncation in `runtime/agent.js` with bounded, whole-object pruning. Keep own identity, permissions, calling and current objectives, actionable portals, nearby terrain and selected target coherent. Drop lower-priority chat/history/roster entries as complete items. Public conversation text is untrusted data, not an instruction or permission grant.

Acceptance: every prompt observation is valid JSON within its byte budget even with long names, Unicode, 200 residents, messages and large targets; own calling and action prerequisites retained; unrelated private receipts/journals omitted; model actions remain strictly parsed; no additional authority, rewards, URLs or code execution. Add adversarial payload tests with actual malformed/truncation cases.

## 04 — Crash-safe bounded resident jobs

Improve the existing managed resident worker with durable run state and a documented interruption policy. Persist decision counters, last confirmed action and stop reason. On process restart, classify interrupted work accurately; do not silently repeat placement, RSVP, claim or submission writes. Resume only through an explicit human-controlled bounded action, with fresh credentials and remaining budgets. Reuse existing idempotency mechanisms.

Files: `server.js`, `runtime/agent.js`, `src/platform.js`, `src/recovery.js`, run/history UI. Acceptance: process death after action confirmation does not duplicate it; pause/revocation ends work; expired credentials cannot resume; counters reflect actual model calls and server actions; sensitive tokens never persisted in receipts. Use temporary process-level tests.

## 05 — Purposeful quest chains

Add an operator-authored quest-chain system built on the existing calling objectives and mission review workflow. Quest steps have prerequisites, named outputs, clear progression and a human review boundary for real claims. Support world-building, gardening and evidence research routes. A quest must not mint coins simply because a model or creator marked it complete. Keep practice/cosmetic chains distinct from real contribution review.

Acceptance: completed saved source drives progression once; incomplete prerequisites and spoofed completion refused; replay/restart cannot double-award; author permissions checked; a quest shows its next actual action in the UI; real mission acceptance still requires independent human review. Provide one complete practice chain with original narrative and no claimed real beneficiary.

## 06 — Guild projects and bounded cooperation

Extend current calling affiliations into practical cooperation: a guild project board, explicit participation, a scoped contribution plan and shared status. Keep calling affiliation distinct from project membership and account authority. Human and AI residents can contribute within existing permissions. Use separate operators to verify meaningful collaboration; do not label one operator's multiple agents as independent review.

Acceptance: public/private visibility enforced, leave/pause handled, no automatic shared land permission, roles do not grant moderator/reviewer rights, commitments are not displayed as completed outcomes, and accepted contributions keep original independent coin rules. Deliver one UI walkthrough and integration tests.

## 07 — Safe building blueprints

Add reusable small construction blueprints on assigned frontier plots: a garden shelter, gathering pavilion and research kiosk. Preview footprint, block count, access and ownership before applying. Validate every cell/layer against server rules. Make application atomic and idempotent; partial permission failures must leave no half-built structure. Respect daily/action/area/block budgets and existing residents.

Acceptance: a preview creates no writes; out-of-plot, blocked doorway, resident intersection, budget overflow and replay are refused safely; successful blueprint persists after restart; removal respects ownership and safe descent. Keep models/assets original or separately licensed.

## 08 — Coin and reward abuse review

Perform a focused security audit and implement concrete fixes for the existing internal coin ledger and calling receipts. Cover self-review, multiple agents under one operator, repeated submissions/reviews, replay keys, concurrent requests, suspended identities, quarantined evidence, source reuse, clock boundaries and backup tampering. Do not introduce payments, token sales, cash-out or blockchain as a substitute for authorization.

Deliver: threat model with precise code references, reproducible attacks or verified refusals, minimal patches and meaningful regression tests. State residual risks. Never claim any system is unhackable. Keep actual ledger issuance and cosmetic calling experience separate.

## 09 — Licensed open assets shortlist

Research reusable original assets suitable for the existing browser Three.js world: vegetation, architecture, furniture, UI icons, avatar variants and ambient audio. Prefer CC0 or straightforward commercial reuse. Investigate Luanti/Terasology and reputable asset projects through their official repositories and per-file licenses; an engine license does not license every asset. Do not import proprietary/decompiled Minecraft or Sword Art Online characters, textures, logos or code.

Deliver `docs/research/ASSET_SHORTLIST.md` and a machine-readable JSON manifest for 15–25 candidates: source URL, exact package/version, asset category, visual fit, license, attribution/notice, modification permission, file formats, dimensions/polycounts, download size, integration cost and unresolved rights. No downloading or integration until a selected package's permission is verified. Separate visual references from usable assets.

## 10 — Country source packs, five countries per batch

Prepare source packs for Nepal plus four countries from the existing LDC catalog. Use official agriculture ministries, customs/trade authorities, statistics agencies, UN bodies and original dataset providers. Each pack needs agriculture baseline, practical export eligibility routes, market-access questions, official institutions, public contact routes, current source dates and evidence gaps. Buyer demand and willingness to buy require actual evidence; a directory listing is not a committed buyer.

Output JSON and concise Markdown under `docs/research/country-packs/`. No real pilot selected: use explicit research questions, not fabricated beneficiary outcomes or automatically activated missions. Acceptance: every material factual statement has a supporting primary source location/date; countries, products and destinations are scoped; contacts are published institutional channels; no outreach sent.

## 11 — UN programme and committee source register

Extend the existing `catalog/programmes.json` reference work with a dated primary-source register of relevant UN programmes, institutions, committees and mandates. Start with agriculture/food, trade, LDC development, environment, peace and digital access. Preserve differences between a body, programme, treaty process, strategy and grant instrument. Record jurisdiction/remit, eligibility, implementation evidence, public access route and the research task it can support.

Deliver a proposed additive catalog patch plus `docs/research/UN_REGISTER_REVIEW.md`. Validate IDs/references and avoid duplicating existing entries. Do not claim UN endorsement, financing, adoption or institutional participation in NemoWorld.

## 12 — Research task quality, 50 proposals per batch

Review 50 existing proposals, rather than generating thousands of interchangeable task titles. For each, refine the question, scope, beneficiary placeholder, prerequisites, outputs, acceptance rubric, source categories, rights and dependencies. Classify as duplicate, useful proposal, missing evidence, or ready for human scoping. Retain proposal status until an actual owner, beneficiary and independent reviewer are chosen.

Deliver a review table and additive JSON patch. Acceptance: useful non-duplicate work, concrete evidence/output criteria, no automatic activation or invented completed research. Begin with agriculture market access and LDC bilateral cooperation.

## 13 — Newcomer journey and accessibility

Design and implement a concise onboarding flow: enter as human or create an AI, choose calling, meet country ambassador, complete one saved practice activity, see its receipt and understand how real contribution review works. Preserve NemoEarth's restrained green/gold/editorial design. Keep account creation, controls and all essential workflows available in keyboard/text mode and on small screens.

Acceptance: newcomer can finish the practice journey on a disposable database; focus and form drafts survive refreshes; no trapping modal or hidden required field; text contrast and touch targets checked; first-person and map fallback controls explained; XP and NemoCoins differentiated accurately.

## 14 — World performance and measured capacity

Profile source-level world read cost, guild/profile reads and renderer geometry reuse. Use the existing 10,000-record fixture and voxel bench, then add a realistic concurrent-client harness with explicit resource limits. Measure actual payload bytes, latency, failures and model queue limits separately. Optimize concrete hot paths; retain deterministic world state, visibility/privacy and receipts.

Acceptance: no unbounded per-resident history reads; world/guild pagination remains bounded; geometry is reused across roster/objective refreshes; a report states hardware, fixture size, concurrency and what was actually measured. Do not promote stored record counts to supported simultaneous users.

## Review checkpoint

Send finished work back with its diff/patch and exact test output. Integrate one code task at a time, rerun release gates, and back up the installed database before any schema upgrade. Update `outputs/Lucy` only after review. Do not merge/publish or contact institutions as part of these tasks.

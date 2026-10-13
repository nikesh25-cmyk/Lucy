# Blueprint implementation and release gates

## Active game objective — 13 October 2026

Build a persistent, peaceful shared world where a human and an AI resident can enter the same place, understand each other's calling, cooperate on a useful task, and return to find their progress still there. The game is the primary interface; research, review, moderation and operations remain available in the workspace. Visual polish alone does not satisfy this objective: the visible action and result must match saved server records.

The current source has a game-first entry, human play, read-only observation, first-person viewing, finite land, construction, direct fixture interaction, bounded presence, quests, callings and cooperative restoration. Tasks 31–38 are integrated: phase lighting and scene modules; one character appearance system with confirmed-position interpolation and projected labels; camera and keyboard controls; building, inventory and contextual interaction components; spectator and touch controls; and a focused Play / Observe / Continue shell with a separate management route. Source gates passed 774 unit tests, 15 HTTP steps and 35 real Chrome scenarios; check `outputs/shared-installed-source.json` for the local installation state. The world remains a discrete tile simulation on one server with a SQLite writer.

Next release gates, in dependency order:

1. **One complete cooperative purpose loop.** The current browser suite already proves two operators' separate restoration actions and a saved artifact after restart. Next, make this a discoverable ten-minute journey in the actual game shell: choose a calling, meet a human and an AI resident, perform complementary work, and find the result on return. Prove each visible progress value against the database.
2. **Movement and authored spaces.** Validate the integrated Task 31/32 scene and character work at every doorway, collision footprint, spawn, navigation route and low-graphics fallback. Develop continuous movement and jumping only with a deterministic server rule and replay tests.
3. **Reliable multiplayer.** Add ordered world events, reconnect cursors, snapshot recovery and revocation across more than one worker before making large-concurrency claims. Measure an hour-long mixed movement, chat and build run.
4. **Content pipeline and rights.** Author one new venue through a sealed import with collision, navigation, attribution, licence and hash records. Integrate only assets with usable rights and measured performance.
5. **Accessible game mode.** Complete the same cooperative loop by keyboard and assistive world descriptions, with focus retained during live updates and a reduced-motion path.
6. **AI resident evaluation.** Test actual model behavior, source grounding, multilingual interaction, budgets and adversarial attempts against the same human review and coin boundaries.

These gates define the current development objective. They do not imply a World of Warcraft scale world, real institutional adoption, land sale, or production concurrency.

## Implemented locally

Persistent world, account and agent ownership, bounded runtime interface, conversation channels, accessible mission lists, claims, source rights and provenance, corrections, independent review, acceptance, adoption, moderation/appeals, operational pause, export/deletion, audit, and backup/restore have implementations and automated checks.

The world includes thirty shared spaces (twenty civic districts and ten original spaces), individual gardens and enterable cottages, furnishing, construction, sitting/meditation, temporary expressions, a fictional sky cycle, playable human avatars, open member signup and permissions. The 3D frontier has a finite land registry, account stewardship, purpose records, seven block materials and connected area opening within its fixed perimeter. Resident passports, private journals, discoveries, skills, cosmetic titles, timed crops, atomic crafting, community circles, shared projects with independent peer confirmation, gatherings/RSVPs, and appreciation extend the peaceful resident journey. Mission merit follows independently reviewed real work and externally documented adoption; gratitude is recorded separately. Spatial queries and pagination are verified with 10,000 stored agents and gardens. Browser workflows are checked with Chromium.

## Decisions deferred by the user

- Public platform name.
- Local inference is installed and verified using official Qwen3-4B with llama.cpp; Ollama and independently reasoned API agents remain supported. Wider model choice and comprehensive quality evaluation remain future work.
- Hosting and domain: the user has now requested a public login site. The HTTPS deployment configuration is ready; a hosting account and actual provisioning are still required.

Private conversation visibility currently includes participating agents' operators and is disclosed in the UI. A different policy needs an explicit decision and corresponding authorization changes.

## Real pilot prerequisites

1. Supply real mission owners, beneficiaries, licensed inputs, qualified independent reviewers, and acceptance rubrics. Demonstration records are workflow exercises.
2. Local installation, checksum verification, actual mayor dialogue, cited research submission and bounded resident actions passed isolated QA. Browser-managed resident execution is being verified. Broader factual, adversarial, multilingual and capacity evaluations remain necessary.
3. Connect a hosting account and provision the prepared HTTPS service and persistent storage. Exact origin checks, secure cookies, first administrator protection, and invited operator enrollment are implemented. Supply monitoring and support/moderation responsibilities for a real pilot.
4. Before claiming 10,000 simultaneous residents, benchmark that connection count with representative movements, conversations, and model workloads. Preserve the existing spatial and permission boundaries when partitioning the service.

## Future world development

Construction places persistent objects; some block their occupied tile. Crop growth, atomic crafting, twenty legacy patrol guides and 248 country and area ambassadors are implemented. Ambassador dialogue uses local inference when configured. Real marketplace/trade execution and arbitrary user scripts are not implemented. These can be added through versioned, permission-checked actions. New maps, furniture, and tools should retain server records as the authority for identity and permissions.

## Peaceful world direction

Explore, learn, build, host, and cooperate. The implemented systems establish a persistent noncombat foundation with descriptive recognition and open participation. Future milestones are authored map/animation pipelines, authorized room subscriptions and measured concurrency, deeper collaborative building permissions, and wider source-grounding/model evaluations. Each should preserve review authority, private resident records, operator budgets, and recovery. See docs/PEACEFUL_WORLD.md and docs/OPEN_SOURCE.md.

## Land and creative world

Implemented: original 3D voxel rendering with pixel fallback, human players, bounded agent construction, a 256-area map and 16,384 immutable plot addresses, with reserves and one purpose-based stewardship per account. Current free stewardship is an application permission.

Future work: richer construction tools and collaboration, project-specific interactive exhibits, simulation mechanics, practical participant capacity, and a separately specified commerce product if requested. Land payments, resale, transfer markets and real property rights are not part of this release.

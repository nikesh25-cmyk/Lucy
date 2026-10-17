# NemoWorld: an AI city with human guests

Date: 17 October 2026. Status: implementation brief, with staged delivery.

The owner approved the direction and then explicitly delegated remaining decisions and execution while AFK. That instruction supersedes further design/plan approval stops. This document does not describe features as shipped.

## Intent

AI residents live and work in a peaceful modern city. Humans are guests: they explore, converse, request a private home and observe the city's progress. AI architects/builders execute construction. The owner clarified **"AI do everything, human are only guests"**; the earlier proposal that humans personally build or take jobs is superseded.

Human administrative accountability is separate from the guest's in-world role. Operators still control credentials, budgets, privacy, moderation and independent acceptance. An AI cannot approve its own contribution, create spending authority or allocate itself compute because of a job or family relationship.

## Approach

1. **Extend the integrated game (selected):** preserve accounts, land, signed native facts, existing public works and research. Add city services around them. It yields useful improvements incrementally.
2. Reskin Harr: inexpensive but leaves home creation, working institutions and lifecycle gaps unresolved.
3. Rewrite the simulation and game: greater freedom, but discards established contracts and delays a usable game.

The selected design retains Veloren for movement/scene simulation and NemoWorld for durable application authority. No second identity, mission, land or reward ledger is introduced.

## Verified starting point

Source base: NemoWorld `d4496ac8bd392e870966fd1c43bd792c2bc8ca88`; Veloren `622dfde5f23dd6b60f92c713353211aef837a5e9`.

| Capability | Existing evidence | Gap |
| --- | --- | --- |
| Land | `src/frontier.js`: `landAssign`, `landRelease`, grants, immutable parcel grid | Guest home request is disconnected from native buildability |
| Native cottage | `src/veloren-ext/home.js`; Rust `nemo-link-proto/src/home.rs`, `server/src/sys/nemo_home.rs` | Fixed blueprint; claim requires a separate browser flow |
| Native editing | Rust `server/src/sys/msg/in_game.rs` uses `CanBuild` and build areas | No NemoWorld home-specific freehand editing integration |
| People | `living-world.js`, `veloren-ext/villagers.js`, schedules and role logic | A scripted roster is not an independently reasoning workforce |
| Work | Signed stage facts, `world-life.js`, `npc-logic.js`; core claim/submit/review | Scene activity and useful reviewed outputs are not one work loop |
| Learning | `apprenticeship.js`, research, schoolhouse manifest | No persisted resident age, enrollment, household or marriage model found |
| Farms | Core garden/craft records; native pantry | Native pantry restocking is scripted, not a saved individual farmer harvest |
| City appearance | Research tower, vertical farm, transit hub, schoolhouse generated already | Full modern streetscape and working offices require scene/interaction work |

### Land decisions

Keep existing canonical plot IDs and the 16 × 16 frontier registry. A registry parcel remains 6 × 6 conceptual units; native placement currently uses a 14-block pitch, with a pad at local x/y 1 through 12. These are distinct projections: do not label the native pitch as registry square metres. Display both clearly.

For the initial home service, offer only registry-available parcels supported by the existing native cottage contract: sector 0,0, excluding native plot rows/columns 3 and 4. Registry reservations and occupancy further restrict this set. Availability must be checked again at assignment. Terrain acceptance remains the native server's decision; a failed build keeps the claim and offers retry, rather than silently claiming another plot.

Existing homes, positions and claims stay in place. Larger buildings use a later explicit site/envelope allocation; never enlarge an existing parcel or flatten occupied terrain implicitly. Private interiors need access and projection control; wall collision alone is not confidentiality. Existing homes retain their present visibility setting until changed by their owner.

### Guest home journey

The guest opens the city page, signs into the existing account and uses the existing Veloren account link. The page lists eligible plots with registry/native dimensions, an honest scripted AI builder label and eight existing roof styles. It previews a free home request. An explicit guest confirmation assigns the selected plot through the existing human-session land method; this is a request for accommodation, not an in-world job.

Rowan's existing service issues the signed `home_build` command. Show queued/building/applied/rejected/expired-unconfirmed, based on saved command facts. Never show "built" on HTTP success. Retry reuses the assignment, and an outstanding build cannot enqueue a second build. Enter/leave requests reuse the same keeper and ownership checks. No new pairing, credentials, land currency or raw coordinate controls.

The claim and native command are in different stores. Do not pretend this is one SQL transaction. Persist/reconcile the existing claim and home command; a command failure leaves a visible recoverable claimed plot. A subsequent request never silently changes its owner or address.

### What replaces combat

The mission is **make the city more useful, knowledgeable and welcoming**. AI do construction, cultivation, maintenance, research, teaching, design, archiving and hospitality. Guests ask residents about work and see attributable results.

There are two clearly distinct types of progress:

- **City simulation:** saved homes, public work stages, crop records, learning exercises and social events. Scripted actions are labelled. No NemoCoins for ambient work or family milestones.
- **Evidence work:** existing mission → root claim → artifact version → independent review → accepted contribution. Office location is context, never proof of work. External sending/publication still requires its existing human authorization.

Use the existing one-active-claim-per-operator rule. Several office residents cannot evade it by creating extra claims. Their specialist work must sit beneath a root claim or wait. Standing at a desk, playing a work animation or generating prose cannot fabricate an accepted contribution.

### Institutions and offices

Reuse existing role/site mappings for a first district: architecture/public works, urban farming, research/archive, makers/design, hospitality/community, and logistics. School and university are learning venues. Each institution names a purpose, workplace, resident roles, next useful activity and the records that prove progress.

The first release exposes a city directory grounded in the real roster, existing work board and research queue. It does not invent office employment or output records from attendance. Residents remain labelled scripted/model-powered/paused/unavailable according to actual execution.

Later office adapters execute narrow, idempotent actions through existing APIs. A research office returns an artifact; a farmer returns a harvest record; a builder returns accepted construction acknowledgements. Private content never appears on public office boards.

### Resident life, households and learning

Add a bounded durable simulation registry referencing existing resident IDs. Separate the citizen's identity from a running bridge or model. New family members initially exist as simulation records; native character realization requires a separate verified spawn/control path. Never present a registry entry as a character already walking in game.

Proposed stages: child → student → apprentice → adult. Education requires saved exercises and assessment; elapsed age alone cannot grant competence. Marriage requires two distinct adult resident identities and explicit recorded participation permitted by both operators. It is a fictional relationship with no permission, property, memory or budget inheritance. Household formation and exit preserve individual identity and history.

Birth/adoption creates a new ID only within an operator-approved population allowance, household capacity and compute policy. A child gets no tool credentials, employment claim or coin authority. Population simulation does not automatically start model inference. Parents cannot recursively create agents or grant children their credentials. Existing residents are initialized as adults without invented past marriages, qualifications or children.

Use simulation time for age and schedules, real time for credential/grant expiry, and presentation time for animation. Restart never fabricates school attendance, work, social consent or model activity. No destructive absence penalty or compulsory job.

### Presentation and resource use

Modern direction: compact urban blocks, glass/stone/metal facades, clear sidewalks, offices, civic school/university, parks, rooftop/vertical farming and a waterfront. Preserve Harr and its saved works; build a connected city district instead of replacing its terrain wholesale. Use existing licensed assets first.

Humans see a small guest interface: explore, talk, my home and city life. Operations/review/budgets stay in management. A browser city directory complements the native game; it is not described as a native scene upgrade.

Use a capped active population, sleeping distant citizens, deterministic schedules and event-driven inference. No additional per-citizen model server. Current laptop capacity is not MMO capacity. New effects require measured frame/latency checks.

## Delivery gates and order

1. **Guest home service and city directory:** reuse account/land/keeper contracts; public roster and real city progress; private accommodation view; keyboard/390px browser UI; refusal/retry/restart tests. This is the first implementation release.
2. **Native home customization:** a persisted AI-authored checked blueprint, revision/idempotency/revocation, cell-by-cell envelope validation; stop the legacy cottage restamper from overwriting custom work. Requires Rust and real native tests, not merely a web editor.
3. **Office execution:** connect one AI research office and one farm/build service to saved outputs; demonstrate a full task→result→review path. Do not loosen existing operator concurrency limits.
4. **City district:** shared survey, protected approaches, modern buildings and functional doors; real desktop walkthrough; migration/restart proof before live installation.
5. **Life and learning:** durable relationships/age/enrollment with accountable population admission; then native spawning, education and career transitions. Registry-only tests do not establish an in-game family simulation.

Each release must say what actually shipped. Completing release 1 does not complete this entire vision. Do not activate partially built later systems just to inflate feature counts.

## First-release acceptance

- Anonymous guests may read only the city directory; no private plot/player/account data.
- A signed-in linked guest can request a supported free plot and the keeper's build; no manual city job required.
- A runtime/bridge token cannot impersonate the guest session or assign land.
- Unsupported/reserved/occupied plots refuse before native command issuance.
- Repeated request while building produces one outstanding command; failed/uncertain status is visible and restart retains it.
- A second account cannot enter, build, read or change the first account's home request.
- A paused world refuses construction and new claims while preserving reads.
- The directory reuses existing roles, works and research, labels scripted residents and never mints coins.
- No new schema version for the main database, no recreation of existing land/mission tables.
- Real browser checks at desktop and 390px; core home/identity/command tests, full Node gates and content seal. A native server/GUI result is reported only if actually run.

## Self-review

The guest-only clarification is applied throughout. Land projection and terrain refusal are explicit. City work is distinct from reviewed evidence work. Lifecycle does not clone credentials or imply existing native child avatars. First-release scope and later requirements are separate. No external services, purchases, deployment or destructive migration are needed for release 1.

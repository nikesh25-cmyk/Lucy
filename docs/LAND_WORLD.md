# NemoWorld land and stewardship

NemoWorld is a finite shared virtual world. Human players and agents can open connected areas, build useful places and maintain them over time. Land is organized around a purpose: a home, a garden, a learning space, a workshop or a research project.

The land registry records places and stewardship inside this application. Payments, land purchases, resale, investment returns and real property instruments are not implemented. A stewardship entry is an application permission, not a deed, government allocation or claim over real geography.

## A world with a defined size

| Level | Definition | Gross capacity |
|---|---|---:|
| World | A 16 × 16 grid of areas, with each coordinate from −8 through 7 | 256 areas |
| Area | 48 × 48 ground cells; one cell represents one virtual meter | 2,304 virtual square meters |
| Parcel grid | 8 × 8 cells of 6 × 6 virtual meters in each area | 64 parcel slots per area |
| Whole registry | 256 areas × 64 parcel slots | 16,384 gross parcel slots |

The full perimeter spans 768 × 768 virtual meters. These units describe the simulation. They do not describe surveyed land, physical resources or a real-world development permit.

**Gross slots include reserves.** Roads, arrival areas, gateways and protected terrain occupy part of the grid. A gross slot is not automatically a parcel available for stewardship. The registry distinguishes usable parcels from reservations; its current availability and assignment records govern what can be built.

The current deterministic registry contains 8,192 permanently reserved slots and 8,192 unreserved slots. A clean installation opens the seed area first: 32 unreserved plots are initially available there; the remaining 8,160 unreserved plots are in unopened areas. Assignments and retained construction change current availability. Unassigned occupied ground is temporarily reserved until its construction is removed through authorized controls. An unreserved parcel can still contain an obstructed terrain cell; construction requires a clear, permitted cell inside its bounds.

The registry and the live world are different counts. A parcel can be catalogued before its area is opened. Opening an adjacent area creates its persistent shared space; it does not enlarge the fixed perimeter or create more registry slots.

## Build a place with a purpose

An area starts with deterministic terrain and public passages. Each opened area connects through its cardinal gateways to adjacent areas. Human players and appropriately authorized agents can walk outward, open an available neighbor and return through the same network.

Parcel stewardship identifies the account responsible for a place and records its intended use. A signed-in member can select one available, unreserved parcel in an opened area and describe its purpose. The account's human player and agents share that stewardship; the assignment does not create an extra parcel for each avatar. Runtime credentials cannot acquire or release stewardship. Building should follow the recorded use and preserve shared access.

The purpose accepts up to 120 characters, with an optional description of up to 500 characters. A person can release an empty assignment and choose another available parcel. Existing construction must be removed through authorized controls before ordinary release. There is no price, payment step, bidding, deed, transfer market or reward for acquiring a parcel.

The current policy permits at most four assignments per account per UTC day and requires a pause of at least one and a half seconds between stewardship actions. Repeating the same assignment and purpose returns the existing record. Changing the purpose requires releasing the empty parcel and assigning it again.

An assignment does not establish that a proposed project has been built, that research is correct, or that an outside organization supports it. The world should show actual saved construction separately from project descriptions and reviewed contribution records.

## Shared access and construction

- Public roads, arrivals and gateways remain clear.
- New solid blocks must be near the acting resident and cannot trap another resident away from the shared passages.
- Supported blocks can be stacked through layers zero to seven. Ground paths stay on layer zero.
- Builders can remove their own eligible work. Authorized human moderators can remove construction through the application’s controls.
- Building and expansion requests include the exact observed `world_id`. If a resident has entered another area, the server refuses the stale action.
- Requests remain subject to account, avatar, runtime scope, pause, distance, capacity and action-budget checks.

Current bounds allow up to eight new areas and five hundred frontier actions per operator per UTC day, two thousand and forty-eight authored blocks per area, and a six-cell building distance. Humans and their agents share operator limits. These are operating limits, not an estimate of simultaneous players or model capacity.

## Humans, agents and coins

An adult member can register and sign in, create one human player, and manage up to five AI characters. Human players use the signed-in account. Agent characters receive separate, limited runtime credentials; a human avatar cannot receive such a credential.

Nemo Coins remain internal credits for independently accepted agent contributions on real research tasks. Creating accounts, receiving stewardship, placing blocks, opening areas, social activity and practice tasks do not mint coins. There is no land payment or coin-to-land exchange.

## Data and evolution

Construction, area openings and stewardship are persistent application records. Account export includes the relevant owned records. Account removal ends current stewardship, anonymizes access and identity, and clears that account's purpose and description text from land event history. Shared geometry and the event's parcel, action and time remain preserved for accountability. Existing occupied ground does not become an empty parcel merely because an account was removed.

Changing the perimeter, parcel dimensions or reserved geography requires an explicit product and data migration. Existing records must be inspected and preserved; an upgrade must not silently discard previously opened areas or authored construction. Any future commerce would require a separately specified and reviewed product, payment handling and clear user terms. It is outside the current land system.

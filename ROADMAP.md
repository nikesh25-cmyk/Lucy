# Build path

The attached *Human AI Cooperation for Climate and Peace* blueprint defines the longer-term product. This document tracks implementation status. The world is a view over durable records; its graphics must never become the authority for identity, permissions, or work.

## Current local milestone: shared world and demonstration work loop

- Done: customizable agent avatars, movement, a central plaza, climate and peace areas, mission board, gallery, and help point.
- Done: documented HTTP API for an operator-controlled external agent.
- Done: public, nearby, and private avatar messages with recipient filtering.
- Done: persistent world state, token based avatar access, removal, and basic input/rate limits.
- Done: keyboard-accessible mission list; demonstration tasks with exclusive leases, evidence, correction versions, human review, and contribution counts.
- Verified: movement, persistence, private-message isolation, exclusive-claim and correction tests; HTTP evidence/review flow; world restart check.
- Limit: local prototype only. Anyone with access to the server can create an agent avatar; no operator verification or moderation exists. The server does not host an AI model yet. Demonstration missions have no approved owner or beneficiary.

## Next: controlled agent sessions

1. Choose a model/runtime and an explicit per-session cost budget. Keep operator credentials with their runtime.
2. Give every agent a verified operator, a pause/revoke control, and an expiring session. Separate avatar ownership from runtime presence.
3. Add a reference external agent client and one platform-run agent using the same bounded action interface. Test permissions, stop behavior, and resource limits independently.
4. Add reporting, quarantine, appeals, and operator-visible records before opening access beyond a local test.

## Later: cooperation platform

1. Replace demonstration missions with one owner-approved climate task and a named reviewer. Add human accounts and private contacts before inviting participants.
2. Add source checks, richer evidence provenance, adoption records, appeals, and versioned task schemas.
3. Activate peace learning and accessibility missions only after qualified owners and reviewers agree to their scope.
4. Add exports, backups and restore checks, operational pause controls, and the blueprint's acceptance register before an invited pilot.

No mission owner, partner, provider, deployment, or public launch has been confirmed. The blueprint's acceptance tests are gates, not claims about this prototype.

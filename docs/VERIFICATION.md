# Local release verification

Run `npm test` with Node.js 24. Tests use isolated temporary SQLite databases and loopback HTTP servers; they do not modify the development database.

Final local check on 2026-10-11: `npm run check` passed, and `npm test` executed **52 tests: 52 passed, zero failed, zero skipped**. Starting and restarting `npm start` served the expanded world and three demonstration missions with a healthy SQLite status. The documented backup, verification, and restore CLI commands also succeeded against a separate restore destination. GitHub CI is configured to repeat syntax and automated workflow checks on Node 24; a remote CI result has not been observed in this session.

The platform and HTTP suites exercise account invitation enrollment, protected browser sessions, avatar ownership, scoped and bounded external agent credentials, private and nearby conversation visibility, competing task claims, operator quotas, idempotent retries, approved source domains, inert evidence uploads, independent human review, correction versions, accepted contribution counts, adoption records, restart persistence, report quarantine, suspension, appeals, platform pause, account exports, deletion redaction, and audit chain integrity. HTTP checks also cover cross origin and Host rejection, malformed requests, method handling, and safe error responses. The existing world tests cover map movement and landmarks.

`tests/world-platform.test.js` additionally checks personal home provisioning and restart persistence, public and private visits, nearby portal entry to shared interiors, cottage doorway entry and return, private cottage guest eviction, reliable home exits, ownership and scope restrictions on construction, walkable build bounds, obstacle collisions and removal, protected arrival and exit tiles, the 200 object capacity, world conversation isolation, heartbeat presence, exports across worlds, and reporting visible home content. Its synthetic storage fixture inserts 10,001 agent records and 10,001 homes. An observed local run returned 200 avatars in a 155,877 byte world response; the synchronous viewport query took 4.49 ms. The home directory returns only the requested page and shared spaces, and supports name search. These figures check response bounds against stored population; they are not a benchmark of 10,000 concurrent clients, network connections, model calls, or sustained production traffic. Timings vary by machine and the test prints its current measurements.

These are automated workflow fixtures. They demonstrate local software behavior; their evidence and accepted contributions are not real mission results. Deterministic model fixtures are not live AI agents. Any provider integration requires separately configured credentials and a successful provider connection check. No mission partner, beneficiary, or independent reviewer is established by a passing test.

Before a real pilot, the operator must supply actual mission owners, eligible sources and permissions, named independent reviewers, a support and moderation process, and any required model provider configuration. The current delivery is intended for a local loopback installation; a public deployment needs its own hosting and transport security configuration.

## Browser workflow validation

The interface was exercised in headless Chromium with isolated temporary databases and loopback servers, using real browser sessions and the delivered HTTP routes. The checks covered:

- First administrator registration, consent, sign-in, invitation creation, invited operator registration, and character creation.
- Scoped connection credential creation and clearing its displayed value when the dialog closes. The browser stores only the selected character ID; operator sessions use the HTTP-only cookie.
- Keyboard/button movement, public conversation, task claiming, source-backed evidence submission, and acceptance by a different human account. Accepted evidence appeared in the gallery.
- Entry and exit through the meeting hall portal, sitting, personal garden travel, building by coordinates and map clicks, removal, garden renaming, and public/private visiting settings.
- Human visitor directory search, public garden viewing, camera panning, and return to the Commons when a viewed garden becomes private.
- Entry and exit through the personal cottage portal, meditation, and a signed-in human visitor speaking in a shared space without moving their agent there.
- All navigation sections and a 390-pixel mobile viewport without horizontal overflow. The tested flows produced no JavaScript page errors.

These checks use synthetic operator accounts and practice evidence. They verify interaction and privacy behavior, not live model reasoning or external mission outcomes. Browser screenshots from the validation run were saved as temporary review artifacts; they are not seed data or production user records.

# NemoWorld threat model

Task 28 — production readiness package. Written 13 October 2026 against branch
`task-28-production-readiness`, base `verify-batch02-wave-b` (commit `8d3689b`), schema **18**.

This document describes what the shipped code actually does, with `file:line` references a reviewer can
open. It is a design and implementation review of the existing stack, not an audit, a penetration test
or a certification. **No system can honestly be described as unhackable, and this one is not.** The
residual-risk list in §10 is part of the model, not a disclaimer appended to it.

Scope: authentication and sessions, agent runtime credentials, CSRF and origin checks, the research
worker's network protections, the coin ledger's integrity, privacy of worlds/conversations/event
subscriptions, and least-privilege review and moderation. Out of scope: the browser UI's own code
quality, the renderer, content authorship, and anything about a host, network or account outside this
repository (§10 states what a host or database administrator can still do).

## 1. Assets, actors and trust boundaries

| Asset | Where it lives | What protects it |
| --- | --- | --- |
| Account credentials | `accounts.password` (`src/database.js:20`) | scrypt digest with a per-account salt, never a plaintext password (`src/platform.js:92`) |
| Session and runtime tokens | `tokens.hash`, SHA-256 only (`src/database.js:23`) | the secret exists only in the client's cookie/header and in memory (`src/platform.js:150`) |
| Private worlds, conversations, journals, drafts, evidence | `worlds.visibility`, `messages`, `journey_*`, `claim_drafts`, `submissions` | a read check on every route, not a UI rule (§8) |
| Coin receipts | `coin_rewards` (`src/coins.js:6`) | append-only triggers, a hash chain, an eligibility predicate, and a fixed amount (§7) |
| Land registry and stewardship | `land_parcels`, `land_stewardships` (`src/frontier.js`) | canonical-address guards, account-unique stewardship, server-side write checks |
| Audit record | `audit` with `previous_hash` (`src/platform.js:66`) | a hash chain appended through `Platform.audit` (`src/platform.js:66-72`) |
| The private setup code | environment only, never the database | constant-time comparison (`src/platform.js:108`), never returned by `/bootstrap` (`server.js:415-418`) |

Actors and what they can hold:

| Actor | Credential | Notes |
| --- | --- | --- |
| Anonymous visitor | none | public reads only (`server.js:454`) |
| Human operator (member) | 7-day session token (`src/platform.js:151-154`) | one human avatar, up to five AI characters (`src/platform.js:211`) |
| Reviewer | session token, role `reviewer` | may review assigned missions and award coins (§9) |
| Moderator | session token, role `moderator` | quarantine, suspend, decide appeals — never a reward (§9) |
| Administrator | session token, role `admin` | role changes, pause, backup, diagnostics |
| AI resident runtime | short-lived runtime token with scopes (`src/platform.js:255-270`) | one active runtime per operator, never a human avatar |
| Host / database administrator | filesystem and process | outside the application's authority (§10) |

Trust boundaries: browser ↔ HTTPS origin; bearer-token API client ↔ HTTPS origin; the server process ↔
the SQLite file; the research worker ↔ the public internet; the local model ↔ the server.

## 2. Authentication and session model

- **Registration.** Public signup creates a `member`; the **first** account on a public installation is
  the administrator and requires the private setup code. A supplied invalid invitation fails even when
  signup is open (`src/platform.js:105-124`). Role input cannot grant administrator, reviewer or
  moderator: `register` never reads a role from the request, and the only role an invitation can carry
  is one an administrator chose (`src/platform.js:198-204`).
- **First administrator.** With a public origin and an empty database, the server **refuses to start**
  without `LUCY_SETUP_CODE` (`server.js:325`). The code must be 24–256 characters
  (`src/hosting.js:19`) and is compared with `timingSafeEqual` (`src/platform.js:108`). `GET
  /api/v1/bootstrap` reports only `setup_required` / `setup_code_required` and never the code
  (`server.js:415-418`).
- **The first-administrator rule does not reopen.** Account deletion is an `UPDATE … status='deleted'`
  that keeps the row (`src/platform.js:709`), not a `DELETE`, so the "no accounts" condition cannot
  become true again after suspension or deletion.
- **Passwords.** scrypt with a 16-byte random salt and a 64-byte derived key, minimum 12 characters
  (`src/platform.js:92-97`, `src/platform.js:104`). Login always performs the expensive comparison —
  even for an unknown address — with a placeholder digest, so a response time does not disclose whether
  an address is registered (`src/platform.js:140-147`).
- **Sessions.** A 32-byte random token, stored only as SHA-256, valid seven days, revoked by logout,
  suspension, deletion or an explicit account action (`src/platform.js:150-154`, `:679`, `:714`, `:807`).
  `authenticate` rejects anything that is not 64 lowercase hex characters before touching the database
  (`src/platform.js:156-159`).
- **Every request is re-authorized.** `authorize` re-reads the token and checks revocation, expiry,
  account status and — for a runtime credential — the agent's kind, ownership, status, scope and action
  budget (`src/platform.js:163-176`). A write re-authenticates *after* the body is parsed, so a
  credential revoked during a slow upload cannot still write (`server.js:523-524`).
- **Cookies.** `HttpOnly; SameSite=Strict; Path=/`, plus `Secure` whenever a public origin is configured
  (`server.js:149-151`). The session value is never placed in a URL.
- **Authentication throttling.** A per-process limiter bounds total attempts (300/minute), attempts per
  connection peer (120/minute public, 15/minute loopback), concurrent attempts (8) and attempts per
  email identity (15/minute, keyed by SHA-256 of the normalised address, so the limiter itself stores no
  address) (`src/hosting.js:45-73`). A refusal is `429` with `Retry-After: 60` (`server.js:448-450`).
  The map is bounded at 10,000 entries and evicts expired windows rather than growing (`src/hosting.js:52-55`).

## 3. Agent runtime credential model

- **Minting is owner-only and human-only.** `runtime()` requires a signed-in human session with a
  member/reviewer/moderator/administrator role, the agent must belong to that operator and be an
  `agent` (never a `human` avatar), and the agent must be active (`src/platform.js:255-259`). A database
  trigger additionally refuses a `runtime` token whose `agent_id` is not an agent of the same operator
  (`src/database.js:61-62`).
- **Bounded by construction.** 1–20 minutes and 1–500 API calls; the scope list is an allowlist of
  `read`, `move`, `chat`, `contribute`, `build` (`src/platform.js:261-265`). Minting revokes every
  previous token for that agent, and one operator may hold only one active runtime at a time
  (`src/platform.js:260`, `:265`).
- **Budgets are charged per action and re-checked.** `charge()` increments `used_calls` on every
  runtime action and audits at 80 % (`src/platform.js:177-186`); exceeding `max_calls` fails with `429`
  (`src/platform.js:172`); a scope not in the token fails with `403` (`src/platform.js:173`).
- **A runtime cannot act as the human.** Human-only routes (`/drafts`, `/workers`, `/me`, `/export`,
  `/operations`, `/safety`, `DELETE`, any POST without a scope, and `home` settings) are refused with
  `403` for a runtime credential (`server.js:462`). The runtime's `runtimeStatus` view reports only its
  own scopes, remaining calls and the pause state (`src/platform.js:273-275`).
- **Revocation defeats a stolen token.** Pausing or revoking an agent revokes its tokens
  (`src/platform.js:248`), runtime credentials are revoked when a resident run ends
  (`server.js:329`, `:571`), and the event channel re-checks a subscription's stored credential hash at
  least once a second (§8).
- **The credential is never stored.** `resident_runs` keeps only `credential_hash`
  (`src/database.js:89`), and the operator-facing run view strips it (`src/platform.js:39`).

## 4. CSRF and origin checks

There is no CSRF token. The equivalent control is a strict origin/host rule applied to every request
before routing (`server.js:388` → `src/hosting.js:23-43`):

- The `Host` header must be present, free of whitespace, `@`, `/`, `\`, `?`, `#` and `%`, and parse as a
  bare authority (`src/hosting.js:24-28`).
- With a public origin configured, `Host` must equal the configured public host; the only exception is a
  loopback health probe from the same port (`src/hosting.js:29-34`). With no public origin, the server
  accepts only a loopback `Host` matching its own port (`src/hosting.js:36-37`).
- **Forwarded headers never establish trust**: `X-Forwarded-Host` and `X-Forwarded-Proto` are not read
  (`src/hosting.js:39-40`), which is asserted by `tests/hosting.test.js`.
- A present `Origin` must equal the expected origin exactly (`src/hosting.js:41`); a request without
  `Origin` for a write must carry a bearer credential or the explicit `x-api-client: operator` marker
  (`src/hosting.js:42`). Combined with `SameSite=Strict` cookies, a cross-site form post from another
  origin is rejected before any handler runs.
- Additional header hardening on every response: `nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, a `Permissions-Policy` denying camera/microphone/geolocation, a CSP with
  `default-src 'self'` and `object-src 'none'`, and HSTS whenever a public origin is configured
  (`server.js:110-117`). The downloadable briefing packet gets its own restrictive CSP
  (`server.js:510`).
- Request bodies are capped at 64 KiB by header and by counting bytes, must be `application/json`, and
  have a 15-second deadline (`server.js:122-139`); the server sets a 15 s request and 10 s header
  timeout (`server.js:656-657`).

## 5. The research worker's network protections

The worker fetches only sources an operator names, and only from hosts the mission task already
approved. The controls are layered so that no single mistake reaches an internal service:

| Control | Where | Effect |
| --- | --- | --- |
| Scheme and host allowlist | `runtime/research-worker.js:27-30` | `https:` only; no credentials, no explicit port; the hostname must appear in the task's `allowed_domains`; a bare IP literal, `localhost` and `*.local` are refused |
| Resolved-address filter | `runtime/research-worker.js:32-35` | IPv4 private, loopback, link-local, CGNAT, documentation, benchmark and reserved ranges, and IPv6 ULA/link-local/multicast/`::ffff:`/6to4/`2001:db8::` are all refused |
| DNS pinning | `runtime/research-worker.js:75-83` | the hostname is resolved once, **every** returned address must be public (`:92-93`), and the connection is made through `https.request` with a `lookup` callback that returns that exact address — so a second, attacker-controlled DNS answer (a rebind) is never used |
| Redirect refusal | `runtime/research-worker.js:78-80`, `:95` | the pinned transport does not follow redirects at all; it accepts only a 2xx status, and the non-pinned path uses `redirect: 'error'`. A redirect to another host is therefore a failed read, not a fetch |
| Content-type and size limits | `runtime/research-worker.js:80`, `:97-101` | only `text/html`, `text/plain` (or `application/json`/PDF for the specific reviewed source shapes) is accepted; hard caps of 1 MB (or the reviewed PDF's exact size) by header and by streaming count |
| Reviewed-binary pinning | `runtime/research-worker.js:21-24` | a PDF is accepted only if its byte length and SHA-256 match a recorded review and it begins `%PDF-` |
| Interstitial refusal | `runtime/research-worker.js:67-72`, `:104` | a recognised access-check/challenge page is stored as a source problem, never as research text |
| Untrusted-content framing | `server.js:636`, `runtime/model.js:76` | retrieved documents and quotes are passed to the model inside a prompt that labels them untrusted data, and the model's output is re-validated against the retained source numbers before it can be shown (`runtime/model.js:112-118`) |
| Credential scope | `server.js:588-592` | the worker runs with a `read`+`contribute` credential for four minutes and at most 20 calls, minted per run and revoked when the run ends (`server.js:600`) |

Residual: the worker still makes outbound requests, so a *public* host that the task approved can be
probed for its availability, and the allowlist is only as good as the operator's choice of domains. A
malicious approved host can return misleading text — which is why evidence is stored with its URL,
retrieval time, SHA-256 and provenance, and why independent human review is required before anything is
accepted.

## 6. Nothing here is a claim about the whole stack

The controls above protect the application's own records against callers restricted to its API. They do
not defend a compromised server process, a stolen human session (a valid session is a valid session),
colluding human reviewers, or anyone with filesystem or database access. See §10.

## 7. Coin ledger integrity

Coins are the app's most abusable record, so the ledger defends itself in the database, not only in
`awardCoins`.

- **Fixed amounts and uniqueness.** `amount` must equal 10 and `policy_version` must equal 1; `task_id`,
  `submission_id`, `review_id` and the normalised-work `fingerprint` are each `UNIQUE`
  (`src/coins.js:6`).
- **Append-only.** `coins_no_update` and `coins_no_delete` triggers abort any update or delete on
  `coin_rewards` — including one performed with a different client against the same file
  (`src/coins.js:8-9`).
- **Chain continuity and eligibility on insert.** `coins_validate_insert` refuses a receipt whose
  `previous_hash` is not the current head and refuses one that does not name an accepted submission, an
  accepted review by a *different* account, the same agent/operator/task, an active non-demo mission,
  the current task version, and the operator's daily cap of 100 (`src/coins.js:10-14`).
- **Issuance is human and independent.** `awardCoins` refuses any caller that is not a signed-in
  administrator/reviewer, refuses a self-review or a review that is not the caller's own, and fails
  closed with `503` when ledger verification fails (`src/coins.js:36-40`).
- **Balances verify the whole ledger first.** `coins()` and `awardCoins` call `verifyCoinLedger`, which
  recomputes every row's hash chain and re-checks each receipt against the submission, review, claim and
  operator it names (`src/coins.js:33`, `:21-32`). A fabricated receipt that credits the wrong wallet or
  names a self-review fails alongside an edited chain.
- **Backups and restores re-check it.** `validateDatabase` requires the three ledger triggers and a
  valid chain before a backup can be verified or restored (`src/recovery.js:69`), so a tampered backup is
  refused rather than restored.
- **The wallet is private.** `GET /coins` resolves the calling agent through `ownedAgent`, so only the
  owning operator or that exact runtime can read it (`src/coins.js:50`); there is no mint, transfer,
  amount-update or cash-out route (`src/coins.js:35-56`).

Residual: a hash chain is an integrity check, not consensus or external certification; an operator with
write access to the database file can delete the whole ledger, and duplicate *semantic* work is not
detected by a normalised-text fingerprint.

## 8. Privacy: private worlds, private conversations, event subscriptions

- **One read-entitlement decision.** `space()` refuses a private garden to anyone who is not the owning
  operator or that exact agent credential (`src/spaces.js:87`); the garden directory applies the same
  condition in SQL (`src/spaces.js:96`); `canReadWorld` is the single wrapper used for re-checking a
  subscription (`src/platform.js:188-191`).
- **Private conversations stay private.** `canReadMessage` returns true only for an addressee (the exact
  agent for a runtime, any agent of the operator for a session) or the mission reader
  (`src/spaces.js:53-59`); the in-world message read is bounded and scoped (`src/spaces.js:143`).
- **Private and nearby chat never reaches the event channel.** Only `channel === 'public'` publishes a
  message delta (`src/platform.js:301`). Movements, placed objects and frontier blocks are published as
  bounded deltas for the one world concerned (`src/spaces.js:181`, `:226-227`, `:256`, `:290`;
  `server.js:624-626`).
- **A subscription is authorized before any stream is written.** `GET /api/v1/events` authenticates the
  caller and then runs the same `space()` check the `/world` route uses, returning an ordinary JSON
  refusal (`401`/`403`) instead of a stream (`server.js:424-437`).
- **Subscriptions are re-authorized, not trusted.** Every subscription is re-checked at least every
  second (`server.js:276-284`, limit `revalidate_ms: 1000`), and visibility changes, agent status
  changes and suspensions force an immediate re-check (`src/spaces.js:276`, `src/platform.js:252`).
  A revoked session closes with `session_revoked`, a lost entitlement with `access_revoked`
  (`server.js:281-282`).
- **Subscriptions are bounded.** 64 connections per process and 4 per account (`server.js:208-209`),
  256 coalesced updates or 64 KiB buffered before a slow client is closed rather than buffered
  (`server.js:247-250`), 20 frames per second with coalescing, and a 15 s heartbeat
  (`server.js:172-180`).
- **Deletion removes private material.** Account deletion clears drafts, journeys, quest/guild/calling
  state, stewardship, conversation rows and message text, and sets the home private
  (`src/platform.js:692-716`).
- **Diagnostics never carry private data.** The operator-facing view strips the credential hash
  (`src/platform.js:39`), the account list exposes no email (`src/platform.js:33`), and the
  administrator payload is passed through a redaction allowlist that also removes token-shaped,
  digest-shaped and email-shaped values (`src/recovery.js:342`).

Residual: whoever holds the database file holds the private rows; an administrator's export route
(`/export`) is deliberately complete for the exporting account; and a human who legitimately shares a
session or a password defeats every rule above.

## 9. Least-privilege review and moderation

- **Review is a role, and never self-review.** `review()` requires `admin` or `reviewer`, refuses the
  operator who owns the claim, refuses a reviewer who is not the mission's assigned reviewer (unless
  administrator), and refuses to review a version that is not pending (`src/platform.js:440-444`).
- **Coins need independence, twice.** The award path refuses a self-review, and the ledger trigger and
  the integrity check both require a reviewer distinct from the claim's account
  (`src/coins.js:12`, `:29`).
- **Moderation is role-checked and conflict-checked.** `moderate()` requires `admin`/`moderator` and
  refuses a moderator who is the reporter or the target's owner (`src/platform.js:522-525`). Suspension
  also revokes the agent's tokens (`src/platform.js:536-538`).
- **Appeals need a different, uninvolved human.** `decideAppeal` refuses the original moderator, the
  appellant, the reporter and the target's owner (`src/platform.js:566-570`).
- **Guild verification needs a distinct operator.** A contribution can only be verified by an operator
  who is neither the contributor's nor the project creator's operator; the rule is re-checked from
  stored rows by `verifyGuildRecords` (`src/guilds.js:125-133`).
- **Administration is narrow.** Pausing the platform, creating invitations, changing roles or status,
  creating a backup and reading diagnostics all require `admin` (`src/platform.js:662-680`, `:587-593`,
  `server.js:526`). An administrator cannot change their own account status (`src/platform.js:667-669`).
  Moderation authority never confers a coin, a plot, a calling or a build right, and a guild organiser
  role is not an account role (`src/guilds.js:8-9`, `docs/GUILDS.md`).
- **Refusal is always explicit.** Unauthorized actions return `403` with a reason; they do not silently
  no-op (`src/platform.js:31`).

## 10. Residual risk — what is still possible

Stated deliberately, because each one is real:

**What a database administrator or host can still do.** With the database file, or with root on the
host, a person can: read every private world, private conversation, journal and evidence record; read
credential *hashes* (never the tokens or passwords, which are not stored in a recoverable form); delete
or rewrite rows with a tool that bypasses the application, including deleting the audit chain and the
coin ledger wholesale; run arbitrary SQL, install other software, and edit the source before it starts;
read the environment, and therefore the private `LUCY_SETUP_CODE` while it is still needed; read, copy
or withhold backups; and stop, restart or repoint the service. The hash chains prove *through the
application* that rows were not edited — they are not tamper-proof against the operator of the machine
(`docs/COINS.md:25`, `docs/ARCHITECTURE.md:63`, `docs/OPERATIONS.md:317-323`).

**Other accepted risks.**

| Risk | Why it remains |
| --- | --- |
| A stolen or shared human session | A valid session is a valid session; the app cannot distinguish the human from a thief. Cookies are `HttpOnly`/`SameSite=Strict`/`Secure` and sessions expire in 7 days, but a live token is usable. |
| Rate limits are per process and per peer | With a hosting proxy, every browser can share one peer identity; the limits bound abuse but do not stop a distributed attempt (`docs/DEPLOYMENT.md:45`). |
| No CSRF token | The origin/host rule plus `SameSite=Strict` covers the browser threat; a client that is not a browser and not a bearer client cannot write (`src/hosting.js:42`). This is a deliberate trade, not a claim that CSRF is impossible. |
| Colluding human reviewers | Two accounts can agree to accept each other's work and mint real coin receipts within the daily cap. Independence is checked structurally, not socially. |
| Semantic duplication | The duplicate-work fingerprint normalises Unicode, whitespace and case; paraphrase, translation or a re-uploaded copy of the same work is not detected (`docs/COINS.md:7`). |
| Model output | A local model can produce wrong or invented prose. It is constrained (bounded length, source-number validation, qualitative-only country prose) but not trustworthy, and its output never itself awards anything (`runtime/model.js:95-119`). |
| Content and research correctness | Acceptance proves a human reviewer accepted the work; it does not prove the research is true, nor that any external party adopted it. |
| Availability | One process and one SQLite writer. A crash, a full disk, a stuck model or a single slow client can degrade service; model work beyond the queue bound is refused rather than queued (`docs/OPERATIONS.md:164-197`). |
| No penetration test | The controls here are reviewed by reading the code and running the suites. Nobody has attacked this deployment, and there is no external audit, bug-bounty or third-party assurance. |
| Untested at scale | The capacity experiment measures one machine, one process and one fixture (§11 of `docs/PRODUCTION_READINESS.md`). No production traffic, TLS, proxy, multi-writer or hostile-input load was run. |
| Environment variance | The suite and the experiment were run on the hardware named in the handoff. Nothing here establishes behaviour on another host, another Node build or another OS. |

## 11. How these claims are checked

| Claim | Test |
| --- | --- |
| Origin/host rules, forwarded headers ignored, secure cookies, setup-code gate, limiter | `tests/hosting.test.js` |
| Runtime scope, budget, kind and human-route refusal | `tests/http.test.js`, `tests/runtime-policy.test.js`, `tests/human-players.test.js` |
| Private hosts, redirects, binaries, oversized content, interstitials | `tests/civic-engine.test.js:59-62`, `tests/research-failure.test.js`, `tests/research-workflow.test.js` |
| Coin immutability, forged receipts, replay, daily caps, private wallet | `tests/coins.test.js`, `tests/coin-abuse.test.js` |
| Event-channel privacy, revocation, bounds, latency | `tests/realtime-channel.test.js`, `tests/realtime-bounds.test.js`, `tests/realtime-latency.test.js` |
| Backup/restore validation, migration, interrupted workers, diagnostics redaction | `tests/recovery.test.js`, `tests/ops-rehearsal.test.js`, `tests/ops-diagnostics.test.js` |
| Guild verification independence | `tests/guilds.test.js`, `tests/guilds-http.test.js` |
| The same properties through a real browser | `npm run browser` (`scripts/browser-suite.mjs` scenarios `subscription-entitlement-and-revocation`, `reward-refusals`, `forged-coin-receipt-refused`, `credential-exclusion`, `private-draft-isolation`) |

## 12. Changes that would invalidate this assessment

Adding a second instance or a second writer; putting the database on shared storage; enabling an
unreviewed `X-Forwarded-*` trust; exposing the diagnostics or health surface publicly; adding a mint,
transfer, cash-out or land-sale route; adding a remote (non-loopback) model endpoint; relaxing the
source allowlist or the redirect rule; granting a runtime credential an administrative scope; or
accepting an external contributor's code into the serving path without a review gate.

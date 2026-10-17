# AI City Foundation Implementation Plan

> Execute inline with superpowers:executing-plans. The owner approved the direction and explicitly delegated decisions/execution while AFK.

**Goal:** Give human guests a usable AI-built-home journey and an honest directory of the city's existing AI work.

**Architecture:** Extend the existing Veloren home service and extension registry. Reuse platform land authority, existing signed native commands and public works/research readers. Serve a small responsive city page from the existing server.

**Tech stack:** Node 24, node:sqlite, plain browser HTML/CSS/JS, existing Veloren bridge protocol.

**Spec:** `docs/superpowers/specs/2026-10-17-ai-city-design.md` (first release only; later releases remain explicit).

## Global constraints

- Preserve all saved accounts, plots, blocks and cottage commands; no main schema bump.
- Humans are guests; requests/administration do not become city jobs.
- No new runtime scopes, credentials, currencies or model dependencies.
- Native 14-block placement pitch and 12×12 pad are not registry square metres.
- A signed native acknowledgement, never a UI state, establishes a built cottage.

## Review focus

1. Existing incompatible plot: show incompatibility and preserve it; no automatic release/reassignment.
2. Command issuance failure after claim: retain a recoverable claim; never claim a second plot on retry.
3. Session/identity changes: derive player from the current authenticated account, not request fields.
4. Paused/deleted accounts and runtime credentials: reject writes before issuing commands.
5. Conflicting retry fields: refuse unexpected fields and preserve plot identity rather than changing plans silently.

## Tasks

### 1. Establish the actual home and city contract

Files: new `src/veloren-ext/city.js`, new `tests/veloren-city.test.js`; extend registry `src/veloren-ext/index.js`.

Interfaces: `nativeHomePlot(plotId): boolean`; `CityService(link, platform)` with `directory()`, `home(actor)`, `requestHome(actor,input)`, `homeAction(actor,input)`.

- [x] Write failing tests against real disposable platform/link databases: plot filtering, current identity, claim/build/retry/ack, pause, cross-account refusal, unsupported existing plot and restart.
- [x] Run those tests and verify the new module is missing.
- [x] Implement strict session checks and existing `landAssign`/`HomeService` calls. Obtain player only from stored `ident_links`; use its current real identity. Preview writes no state. No browser-supplied player/account/command fields.
- [x] Test directory redaction, roster labels, real works/research projection and unchanged reward counts.
- [x] Run home/identity/command suites alongside the new suite.

### 2. Ship the guest interface

Files: new `city.html`, `city.css`, `city.js`; modify static table in `server.js`, navigation in `harr.html`.

Interfaces: `GET /veloren/city`, `GET /veloren/city/home`, `POST /veloren/city/home/request`, `POST /veloren/city/home/action` under the existing `/api/v1` prefix.

- [x] Add failing HTTP tests for static paths, signed-out/private read refusal, session-only writes and origin refusal.
- [x] Implement extension routes using existing origin validation and platform authentication.
- [x] Build guest page with real city work, resident types, supported plot options, explicit free request, existing roof styles, native acknowledgement status and enter/leave/retry recovery.
- [x] Put untrusted strings in DOM text only; use visible labels, 44px controls, keyboard access, reduced-motion support, no horizontal overflow at 390px.
- [x] Browser-check with disposable accounts/temp DB; do not create accounts in the installed world.

### 3. Verify and hand off

- [x] Run focused and full Node tests, syntax, e2e and sealed content check; investigate regressions without weakening existing gates.
- [x] Review the diff against the spec; preserve later release gaps explicitly.
- [x] Commit verified source and document exact results, browser evidence and native testing limits.
- [x] Do not modify live game data or install unverified changes.

## Execution ledger

- Baseline source is clean at `d4496ac`; branch `feat/ai-city-foundation-2026-10-17` created in the existing isolated integration worktree. No live files changed.
- Ruling: implement first-release home/directory as a complete verified unit before adding office execution or family simulation. The full vision remains in the spec so later work cannot confuse scenery or registry data with completed gameplay.
- Implementation: first-release services, native shared guards, guest interface and browser probe are built. Land/main schemas unchanged.
- Review: independent reviewer reproduced existing-claim occupancy/privacy defects; regression tests failed before fixes and passed afterwards. Re-review found no further blocking findings. Native keeper tests additionally reproduced/fixed pause, layout, occupancy and paused-avatar bypasses.
- Verification: 1,787 full Node tests passed; 59 focused home/city/identity tests passed; 20/20 standard e2e steps; 8/8 real Chrome city scenarios (keyboard, 390px, restart, isolation); syntax 170 files; seal 136 definitions/42 notices. Browser native acknowledgements are signed fixtures, not real-game GUI evidence.
- Visual review: desktop and phone captures inspected; a contradictory pending message after confirmation was reproduced with a failing Chrome assertion and fixed. The resident list now shows eight entries with an expandable remainder.

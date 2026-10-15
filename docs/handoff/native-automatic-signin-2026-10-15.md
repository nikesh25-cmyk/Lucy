# Native account sign-in and automatic return

Base: `80fa4a4`, integration branch `integration/nemoworld-unified-2026-10-15`.

## User flow

The normal flow no longer sends players to a browser to copy a pairing code. Sign in with the NemoWorld account inside Luanti on first use; a single eligible human enters automatically, or choose from the account's active human characters already in opened frontier sectors. On later native logins and bridge/server restarts, restore the saved account/character automatically. `/nemo_connect` offers account switching; `/nemo_signout` removes the remembered connection. Normal operator-session expiry still requires account sign-in, inside Luanti, rather than a code exchange.

## Authority and storage

- Existing `/auth/login` and `/me` remain account/character authority. No main API routes, scope expansion, new identity database or schema migration.
- New local mod-key-protected bridge routes: `/native/login`, `/native/connect`, `/native/resume`, `/native/forget`. Short-lived login handles are bound to the native player and consumed once. Only an active owned human in an opened frontier is eligible. Runtime tokens are never used as human credentials.
- Fresh nonces and generation guards reject callbacks and requests from previous connections. The normal remembered link does not impose the old twenty-minute code requirement; it is bounded by the existing seven-day operator session and checked on every request.
- `native/remembered-session.mjs` stores one encrypted connection, bound to the exact local API origin, using AES-256-GCM. Normal launcher path: `NEMO_NATIVE_DATA/private/native-session`. Directory mode 0700, key/cache mode 0600, owned by this OS user. Passwords are not cached; the operator token never enters Lua, map metadata, model prompts or logs.
- The local OS account can read both encryption key and cache. This is not protection against compromise of that account. World/source backups and exports must exclude this separate private connection directory. Corrupt/tampered caches fail closed; restore the matching cache/key or remove the private connection cache and sign in again. API-origin changes require a fresh connection, preventing silent credential forwarding to another local service.
- Expired or revoked sessions cannot resume. A paused character remains blocked and can return after being reactivated. `/nemo_signout` clears remembered access and the current native connection. Legacy browser/code linking remains compatible, but is absent from the default sign-in UI.

## Evidence

- Red: old native UI could not sign in from its account form and left the synthetic player's height at the unconnected waiting position.
- New HTTP integration test: direct native login, no token in response, native-player-bound handles, encrypted private cache, continuity beyond twenty minutes, bridge restart, a fresh nonce, rejection of old/other-player/unauthenticated requests, paused-character refusal/recovery, token revocation, explicit forget and absence after another restart.
- New storage tests: authenticated ciphertext tampering, API-origin mismatch and world-readable key permissions all fail closed.
- Real Luanti controls probe now uses actual native email/password form callbacks and the actual NemoWorld login endpoint, builds/removes a saved block, leaves and joins again, then restores the character without another password or code. It asserts that the sign-in screen closes and fixture credentials do not appear in engine logs. Synthetic engine callbacks are used; this is not a claimed GUI mouse/keyboard playthrough.
- Existing native arrival, world/travel/restart, mission and private-chat probes remain required.

Final gate results are appended below after completion. Installed account passwords, land, blocks, coins, world database and native authentication records are preserved.

## Final results

- Focused bridge/reconnect/storage tests: **13/13 pass**.
- Full `npm test -- --test-concurrency=3`: **1,471 passed, 0 failed, 0 skipped**, 260.4 seconds on Node 24.19.0.
- `npm run check`: 132 files, 0 failed. Sealed content: 136 definitions verified, 3 support files and 42 notices/assets.
- Five real Luanti 5.17.0 engine probes pass: onboarding/menu, native sign-in/automatic return/controls/build, saved world/travel/restart, missions and conversations.
- Single-player native bridge limit is retained: one remembered native player/account/character connection per local bridge. Choosing another connection replaces the previous remembered connection. This is not a public multiplayer authentication redesign.

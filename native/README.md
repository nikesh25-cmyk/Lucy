# NemoWorld Luanti native slice

This is a working, local native client for an opened NemoWorld frontier sector. Luanti renders one 48×48 sector at a time and can follow an authoritative `/move` through an existing adjacent frontier passage. NemoWorld's Node service remains the authority for identity, positions, land stewardship, plot grants, placement/removal, missions, reviews and coins. The Lua mod never opens NemoWorld's SQLite database. No mission or coin store is copied into Luanti.

## Pinned components and rights (verified 13 October 2026)

| Component | Pin | Rights |
| --- | --- | --- |
| Luanti engine/native client and server | [5.17.0 release](https://github.com/luanti-org/luanti/releases/tag/5.17.0); macOS arm64 archive `luanti_5.17.0_macos12.3_arm64.zip`, SHA-256 `0ba118b537d3cc6fd07cd2268fef25e515fc6d87c27ad69b476144a8e28dba3c` | Engine [LGPL-2.1-or-later; bundled media have individual notices](https://github.com/luanti-org/luanti/blob/5.17.0/LICENSE.txt). The engine is installed separately and is not copied into this repository. |
| `native/nemoworld_game` and `native/bridge.mjs` | This repository's source | Original MIT code and 17 original solid-colour 16×16 PNG textures; see [LICENSE](LICENSE). The colours correspond to NemoWorld's existing frontier palette. No Minetest Game media or proprietary Minecraft material is used. |
| Luanti mod interface | [5.17.0 Lua API](https://github.com/luanti-org/luanti/blob/5.17.0/doc/lua_api.md) | `core.request_http_api`, `HTTPApiTable.fetch`, item `on_place`, node `on_punch`, `core.emerge_area`, `core.load_area`, chat commands and join/leave callbacks were checked against this exact release. |

The `5.17.0` release warning says it fixes critical client and server vulnerabilities; use this pinned version or a later reviewed security release. The launcher checks that `LUANTI_BIN` is provided; verify your archive against the SHA-256 above before use.

## Run locally

1. Start the **source checkout's** NemoWorld Node service against the database you intend to use, or a disposable database for evaluation. Do not point it at the separately installed `outputs/Lucy` database unless you expressly intend to run that installation. For a disposable instance: `LUCY_DATABASE=/absolute/path/to/disposable.sqlite PORT=3000 npm start`.
2. Set `LUANTI_BIN` to the verified engine binary, for example `.../luanti.app/Contents/MacOS/luanti`. Run `node native/run-local.mjs`. `NEMO_API` defaults to `http://127.0.0.1:3000` and the bridge accepts only a literal local HTTP origin, because it forwards an operator token; redirects are refused. Optional `NEMO_NATIVE_DATA` selects the native world directory; the default is ignored `native/.local/`. The launcher copies this game's source, creates a singlenode world, starts a loopback bridge and a loopback Luanti server, and prints both ports. Its bridge key is random for each launch and stored in the local Luanti config with mode 0600; the config is removed on a clean shutdown. This key is **not** a NemoWorld operator or runtime token.
3. Connect the Luanti 5.17.0 native client to `127.0.0.1:39333`. A connection screen explains pairing while a neutral floor is generated. Physics stay suspended until the shared frontier is loaded, so an unpaired player cannot fall through an unloaded map. Use `/nemo_connect` to reopen this screen.
4. In NemoWorld, create/select a **human** avatar and enter an opened frontier sector. Steward a non-reserved plot if you want to build. Open `http://127.0.0.1:3999/`, sign in with the operator email and password, select the returned active human avatar, and create a pairing code. The bridge calls `/auth/login` with `X-API-Client: operator`; the raw operator token stays in bridge memory and is never shown to or copied by the browser. Enter the two-minute code in Luanti's connection screen, or type `/nemo_pair CODE` in chat. Login handles expire after ten minutes and are single-use. The waiting floor is only a render cache, not a saved building or contribution. This client renders frontier sectors; the browser's Commons and connected districts are not projected here.
5. Walk with Luanti's ordinary movement controls. Crossing a tile threshold requests one saved cardinal step from NemoWorld; the client waits for confirmation before the next step. `/nemo_move up|down|left|right` remains a precise text alternative. Select a supplied block item and right-click a node to request placement; punch a projected block to request removal. The bridge waits for NemoWorld's response before the mod changes a node. Land, distance, cooldown, grant, scope and account checks come from the existing server routes. A refused action shows the server reason in Luanti chat.

### Missions and conversation

- `/nemo_missions` lists open tasks and the **paired avatar's** active claim. `/nemo_claim TASK_ID` takes one lease. Repeating it while the lease is active returns the same claim; after release or expiry a new lease may be created. An active claim belonging to another avatar on the operator account is not exposed or usable here.
- Before `/nemo_submit DELIVERABLE_TEXT`, enter **your own** `/nemo_source URL PAGE_OR_SECTION`, `/nemo_method TEXT`, `/nemo_limitations TEXT`, and `/nemo_rights TEXT`. The mod does not insert example sources, imply that rights were checked, or certify evidence. Up to ten sources can be entered. `/nemo_evidence_reset` discards the local unsent statements. Evidence entered in Luanti is not saved across a restart or re-pair; a saved submission is in NemoWorld and can be inspected in its contribution history. The bridge accepts an identical retry for a saved submission and permits a new version after an independent reviewer requests changes.
- `/nemo_chat` reads recent direct/public messages, `/nemo_say TEXT` posts to the current world, and `/nemo_tell RESIDENT_ID TEXT` privately addresses a visible resident. Mission chatter is not surfaced by the native direct-chat command. Incoming private and nearby messages require the Node `/world?agent_id=...` response's `message_scope_agent_id` attestation; with an older Node service the bridge shows only public messages and private messages authored by the paired avatar, rather than risking exposure of another avatar's conversation.

The native server is restricted to loopback by the launcher. `secure.http_mods = nemo` grants only this mod outbound HTTP; `secure.trusted_mods` is not used. The bridge accepts only loopback requests and native endpoints require its per-launch mod key. Each pairing receives an in-memory nonce, bound to every native request; a delayed callback from a replaced pairing is refused. Human pairing accepts only an active `kind: human` avatar owned by the operator session. The operator token stays in bridge process memory, is checked through `/me` before every action, and never enters the Lua mod, Luanti world files, model input or logs. Pairing lasts at most 20 minutes and must be repeated after bridge restart. Revoking the operator session or pausing the human avatar stops actions at the next request. AI runtime tokens are not accepted by this human pairing route; AI residents continue to use NemoWorld's existing scoped runtime API, and their approved blocks are projected into the native sector.

## Coordinate and authority map

| NemoWorld `frontier:0:0` | Luanti world |
| --- | --- |
| `x = 0…47` | `x = 0…47` |
| `y = 0…47` (southward tile row) | `z = 0…47` |
| block layer `z = 0…7` | vertical `y = 0…7` |
| terrain floor | `nemo:ground` at Luanti `y = -1` |
| finite functional boundary | impassable `nemo:boundary` at `x/z = -1` and `48`, heights 0…3; bridge also rejects out-of-range coordinates |

The initial projection fetches all 48×48 through 12 existing bounded `/world` windows and applies server terrain, block and resident-position data. Every five seconds it refreshes those windows. On the first refresh after a Luanti restart or an authoritative sector crossing it emerges and scans the whole sector to remove persisted native blocks that no longer exist in NemoWorld. Native walking detects a cardinal step from physical movement, asks `/move` to save it, and reconciles the client to the server position. At an exact gate tile, the existing server `/move` route enters an already opened adjacent sector and the bridge follows the agent's returned `world_id`; closed sectors remain refused by the server. The native map database is a render cache.

## Verification

`LUANTI_BIN=... node native/luanti-onboarding-smoke.mjs` invokes this mod's real join callback
with a synthetic player in a disposable engine/world. It proves the pairing screen is shown,
unpaired physics are suspended and the actual engine generates a floor without a paired account.
It does not automate a real person's account sign-in.

`node --test native/bridge.test.mjs native/bridge.integration.test.mjs` covers boundary mapping, local pairing, mod-key enforcement, owner validation, revocation, shared block rows, web-to-native and native-to-web visibility, authoritative crossing, mission claim ownership, reclaim after release, evidence refusal, versioned submission, private-message isolation, and reopened database persistence. `LUANTI_BIN=... node native/luanti-smoke.mjs`, `LUANTI_BIN=... node native/luanti-mission-smoke.mjs`, and `LUANTI_BIN=... node native/luanti-conversation-smoke.mjs` launch the **real pinned Luanti server** and invoke registered mod callbacks in disposable games. The probes use synthetic players; they do not automate GUI clicks, physical WASD input, or a real person's evidence review. Each deletes its temporary database and Luanti world.

Residual limits: Luanti renders one sector at a time; expansion of a new sector remains an explicit NemoWorld action, and this is not a deployed public server, MMO capacity claim, graphical native mission UI or a complete AI-native client. The launcher stores only the Luanti rendering world; NemoWorld remains the single durable world/mission authority.

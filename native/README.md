# NemoWorld Luanti native slice

This is a working, local native client for **one** existing NemoWorld sector, `frontier:0:0`. Luanti renders authored terrain colours, resident position markers, the finite edge and saved frontier blocks. NemoWorld's Node service remains the authority for identity, positions, land stewardship, plot grants, placement/removal, missions, reviews and coins. The Lua mod never opens NemoWorld's SQLite database. No mission or coin store is copied into Luanti.

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
3. Connect the Luanti 5.17.0 native client to `127.0.0.1:39333`. The player starts at the frontier crossroads.
4. In NemoWorld, create/select a **human** avatar, enter `frontier:0:0`, and steward a non-reserved plot. Open `http://127.0.0.1:3999/`, sign in with the operator email and password, select the returned active human avatar, and create a pairing code. The bridge calls `/auth/login` with `X-API-Client: operator`; the raw operator token stays in bridge memory and is never shown to or copied by the browser. Type the returned two-minute code as `/nemo_pair CODE` in Luanti. Login handles expire after ten minutes and are single-use.
5. Walk with Luanti's ordinary movement controls. Crossing a tile threshold requests one saved cardinal step from NemoWorld; the client waits for confirmation before the next step. `/nemo_move up|down|left|right` remains a precise text alternative. Select a supplied block item and right-click a node to request placement; punch a projected block to request removal. The bridge waits for NemoWorld's response before the mod changes a node. Land, distance, cooldown, grant, scope and account checks come from the existing server routes. A refused action shows the server reason in Luanti chat.

The native server is restricted to loopback by the launcher. `secure.http_mods = nemo` grants only this mod outbound HTTP; `secure.trusted_mods` is not used. The bridge accepts only loopback requests and native endpoints require its per-launch mod key. Human pairing accepts only an active `kind: human` avatar owned by the operator session. The operator token stays in bridge process memory, is checked through `/me` before every action, and never enters the Lua mod, Luanti world files, model input or logs. Pairing lasts at most 20 minutes and must be repeated after bridge restart. Revoking the operator session or pausing the human avatar stops actions at the next request. AI runtime tokens are not accepted by this human pairing route; AI residents continue to use NemoWorld's existing scoped runtime API, and their approved blocks are projected into the native sector.

## Coordinate and authority map

| NemoWorld `frontier:0:0` | Luanti world |
| --- | --- |
| `x = 0…47` | `x = 0…47` |
| `y = 0…47` (southward tile row) | `z = 0…47` |
| block layer `z = 0…7` | vertical `y = 0…7` |
| terrain floor | `nemo:ground` at Luanti `y = -1` |
| finite functional boundary | impassable `nemo:boundary` at `x/z = -1` and `48`, heights 0…3; bridge also rejects out-of-range coordinates |

The initial projection fetches all 48×48 through 12 existing bounded `/world` windows and applies server terrain, block and resident-position data. Every five seconds it refreshes those windows. On the first refresh after a Luanti restart it emerges and scans the whole sector to remove persisted native blocks that no longer exist in NemoWorld. The native map database is a render cache. Native walking detects a cardinal step from physical movement, asks `/move` to save it, and reconciles the client to the server position. This still feels like discrete tile movement; camera-relative movement, collision and speed need live client testing. The mod currently uses simple flat-colour geometry and does not reproduce the browser's authored trees, water, gardens, buildings or full mission UI.

## Verification

`node --test native/bridge.test.mjs native/bridge.integration.test.mjs` covers boundary mapping, local pairing, mod-key enforcement, owner validation, revocation, shared block rows, web-to-native and native-to-web visibility, refusal of an out-of-range/unlawful action, and reopened database persistence. `LUANTI_BIN=... node native/luanti-smoke.mjs` launches the **real pinned Luanti server** and invokes the mod's registered item-placement and movement command callbacks in a disposable game; the callbacks save one block and one position step through the bridge, then the web `/world` response confirms the block. The probe calls the registered callbacks inside Luanti with a synthetic player; it does not automate a GUI click or a physical WASD press. It also stops Luanti, removes that block through the web API, restarts Luanti and confirms the persisted native node is cleared. Both scripts delete their temporary database and Luanti world.

Residual limits: this is one local sector and one human pairing path, not a deployed public server, MMO capacity claim, cross-sector travel, native mission UI or a complete AI-native client. The launcher stores only the Luanti rendering world; NemoWorld remains the single durable world/mission authority.

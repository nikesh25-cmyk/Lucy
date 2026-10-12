# Open voxel engines and Minecraft tools: reuse decision

Reviewed **12 October 2026** against official project documentation and repositories. NemoWorld currently uses Node.js, SQLite and a Three.js browser client. The recommendations below are engineering judgments based on those sources. No engine, Minecraft JAR, decompiler or plugin was installed; no third-party implementation or game asset was copied into NemoWorld.

## Decision

**Use the documented interaction and engine patterns now. Keep Luanti as the leading candidate for a separate native game client.** Terasology offers useful permissively licensed source references. Paper and Mineflayer offer a practical route if a distinct Minecraft-connected mode is wanted. Each native option needs an explicit adapter and its own client/runtime; none is a replacement JavaScript file for the existing browser world.

| Project | What it provides | License and fit |
|---|---|---|
| **Luanti, formerly Minetest** | A C++ voxel game platform with server-side Lua games/mods, rendering, networking and native clients. | Engine **LGPL-2.1-or-later**; media has several licenses. Strong future native-world candidate. Its official downloads target Windows, Linux, macOS, Android and BSD, rather than a browser SDK. [Project](https://github.com/luanti-org/luanti), [downloads](https://www.luanti.org/en/downloads/), [licenses](https://raw.githubusercontent.com/luanti-org/luanti/master/LICENSE.txt). |
| **Terasology** | A Java voxel engine and modular game ecosystem, with desktop rendering and world-generation interfaces. | Code **Apache-2.0**; artwork generally **CC BY 4.0**, with exceptions. Useful source references; a separate Java/OpenGL integration. The reviewed README specifies JDK 17. [README](https://github.com/MovingBlocks/Terasology), [license](https://github.com/MovingBlocks/Terasology/blob/develop/LICENSE). |
| **GitCraft-Next / Ornithe GitCraft** | Produces versioned repositories of decompiled Minecraft code, with assets included by default. | The tool is **MPL-2.0**. Its README restricts generated repositories to personal use and says not to distribute them. It is an inspection tool, not an original reusable game engine. [Repository](https://github.com/OrnitheMC/gitcraft). |
| **shulkr** | Decompiles Minecraft versions to compare their changes. | **Apache-2.0** tool; its README warns against publishing generated game code. No world engine to embed here. [Repository](https://github.com/clabe45/shulkr). |
| **McDeob** | Remaps/deobfuscates Minecraft client/server JARs, with optional decompilation. | **Apache-2.0** tool; generated output is restricted in its README. No browser-world dependency. [Repository](https://github.com/ShaneBeeStudios/McDeob). |
| **Paper** | A Java Minecraft server and plugin API. | Upstream/default **GPL-3.0**, with specified exceptions for contributions. Suitable for a future Minecraft server bridge. Current Paper 26.1+ documentation requires Java 25. [Documentation](https://docs.papermc.io/paper/), [license](https://github.com/PaperMC/Paper/blob/main/LICENSE.md), [runtime requirements](https://docs.papermc.io/paper/getting-started/). |
| **Spigot** | A modified CraftBukkit server and plugin ecosystem. | The inspected official Spigot API is **GPL-3.0**; check the exact current server distribution before reuse. Requires its Minecraft client/server environment. [Project description](https://www.spigotmc.org/wiki/about-spigotmc/), [API license](https://github.com/SpigotMC/Spigot-API/blob/master/LICENCE.txt). |
| **Purpur** | A Paper-derived server with additional gameplay configuration. | Purpur patches are generally **MIT**, with file exceptions and upstream licensing retained. A future server option, not a browser renderer. [Documentation](https://purpurmc.org/docs/purpur/), [licensing FAQ](https://purpurmc.org/docs/faq/). |

An open-source decompiler's license does **not** license the game code or assets it produces. The Minecraft EULA distinguishes independently created modifications from substantial Minecraft code/content. The decompiler outputs are not a source for NemoWorld assets or implementation. [Minecraft EULA](https://www.minecraft.net/en-us/eula).

## What we can use now

1. **A stronger play loop:** first-person controls, an accessible hotbar, placement previews and clear interaction feedback. Add authoritative elevation, grounded state and collision before presenting jumping or climbing as simulation mechanics.
2. **Chunk-focused rendering:** rebuild changed geometry, suppress hidden faces and stream nearby terrain. Benchmark these independently from agent inference and database throughput.
3. **Typed content definitions:** give blocks, furniture, crops and NPC appearances versioned schemas and individual license manifests. A repository-wide license must not substitute for inspecting a particular asset's terms.
4. **Explicit server permissions:** validate every placement, deletion, traversal and agent intent against NemoWorld's current account, scope, parcel, distance and action limits. UI previews and model output remain requests.

These are original implementation recommendations. The study has not imported engine code or shipped these additional mechanics.

### Source files inspected

Luanti source review is pinned to commit `5bb520ba544536c4c2914bc0a5ad386e758d7036`; Terasology to `3e3717b464f7e41dcc57807aaf3c1e11b0dde5d9`. These are reviewed development revisions, not claims about the latest stable release.

| Verified source | Useful lesson |
|---|---|
| [Luanti `doc/lua_api.md`](https://github.com/luanti-org/luanti/blob/5bb520ba544536c4c2914bc0a5ad386e758d7036/doc/lua_api.md) | Mod interfaces, node protection, bounded map generation and approved HTTP access. The current namespace is `core`; `minetest` remains an alias. |
| [Luanti `builtin/game/item.lua`](https://github.com/luanti-org/luanti/blob/5bb520ba544536c4c2914bc0a5ad386e758d7036/builtin/game/item.lua) | Placement and digging explicitly check protection and record violations. A bridge must enforce protection on every mutation path. |
| [Luanti `src/collision.cpp`](https://github.com/luanti-org/luanti/blob/5bb520ba544536c4c2914bc0a5ad386e758d7036/src/collision.cpp) and [map-block meshing](https://github.com/luanti-org/luanti/blob/5bb520ba544536c4c2914bc0a5ad386e758d7036/src/client/mapblock_mesh.cpp) | Bounded movement steps and voxel mesh lifecycle. Study the design; a source translation would carry the applicable LGPL obligations. |
| [Terasology `ChunkTessellator.java`](https://github.com/MovingBlocks/Terasology/blob/3e3717b464f7e41dcc57807aaf3c1e11b0dde5d9/engine/src/main/java/org/terasology/engine/rendering/primitives/ChunkTessellator.java) | Chunk mesh generation is separated from world storage and gameplay. |
| [Terasology `WorldBuilder.java`](https://github.com/MovingBlocks/Terasology/blob/3e3717b464f7e41dcc57807aaf3c1e11b0dde5d9/engine/src/main/java/org/terasology/engine/world/generation/WorldBuilder.java) | World generation composes providers and their dependencies. |
| [Terasology movement utility](https://github.com/MovingBlocks/Terasology/blob/3e3717b464f7e41dcc57807aaf3c1e11b0dde5d9/engine/src/main/java/org/terasology/engine/logic/characters/CharacterMovementSystemUtility.java) and [permission system](https://github.com/MovingBlocks/Terasology/blob/3e3717b464f7e41dcc57807aaf3c1e11b0dde5d9/engine/src/main/java/org/terasology/engine/logic/permission/PermissionSystem.java) | Movement state, presentation and named permissions have separate responsibilities. These inspected files identify **Apache-2.0** in their headers. |

Any eventual copied Apache-2.0 code must retain the license and applicable notices and identify changes. Artwork is checked separately. No isolated code extraction was justified for this release: the reviewed Java/C++ classes depend on their native engine types, while NemoWorld already has working browser rendering and policy checks.

## Luanti: a native-world integration later

Luanti's Lua interface supplies entities, node operations, privilege checks, `core.is_protected` and map-generation controls. `mapgen_limit` controls generation bounds; matching NemoWorld's exact 16 × 16 area/parcel policy still needs our own enforcement. Protection is a game/mod responsibility, rather than a built-in NemoWorld stewardship ledger. [Official API](https://api.luanti.org/), [privileges](https://api.luanti.org/privileges/), [map-generation implementation](https://github.com/luanti-org/luanti/blob/5bb520ba544536c4c2914bc0a5ad386e758d7036/src/servermap.cpp).

A dedicated Lua bridge could fetch bounded agent jobs from NemoWorld and apply approved commands. Its HTTP API requires explicit mod allowlisting; granting broad trusted-mod privileges is unnecessary for that design. Keep identity mapping, parcel permission, research review and coin issuance in the existing Node service. Never pass arbitrary Lua, shell commands or administrator privileges to a model. [HTTP implementation](https://github.com/luanti-org/luanti/blob/5bb520ba544536c4c2914bc0a5ad386e758d7036/src/script/lua_api/l_http.cpp).

Native clients and a separate world database would be additional products to deploy and test. No supported drop-in browser SDK or official NemoWorld/LLM connector was verified in the reviewed sources. Community browser ports, if considered later, require their own compatibility and provenance assessment.

## Terasology: modular reference and optional native evaluation

The reviewed engine exposes Java world, entity and module interfaces. A bridge would translate bounded NemoWorld intents through a trusted Java module; browser deployment and our ledger integration are additional work. Do not treat module extensibility as an agent sandbox. An active project issue discusses Java 24+ security-manager limitations, so a native evaluation must pin compatible runtime and trusted modules. [Contributor guide](https://terasology.org/contribute/), [module-security issue](https://github.com/MovingBlocks/Terasology/issues/5357).

## Useful components for a distinct Minecraft mode

| Component | Verified role and license | Possible use |
|---|---|---|
| [Mineflayer](https://github.com/PrismarineJS/mineflayer) | **MIT** Node.js Minecraft bot client: movement, world observations, inventory, digging, building and chat. | An agent adapter if a Minecraft server mode is chosen. It needs a compatible server protocol; it is not a standalone voxel world. |
| [Citizens2](https://github.com/CitizensDev/Citizens2) | **OSL-3.0** Bukkit NPC plugin/API. | Native Minecraft mayor NPCs in a separately integrated mode. |
| [PlotSquared](https://github.com/IntellectualSites/PlotSquared) | **GPL-3.0** Minecraft plot and world-management plugin. | Reference for parcel generation, flags and stewardship workflows. |
| [WorldGuard](https://github.com/EngineHub/WorldGuard) | **LGPL-3.0** region protection; depends on a supported Bukkit implementation and WorldEdit. | Reference for region permissions and protection flags. [Region documentation](https://worldguard.enginehub.org/en/latest/regions/). |

A future Paper plugin can validate typed agent intents, process inference away from the world thread and apply approved mutations through server scheduling. Preserve NemoWorld's independent review and coin ledger. Pin a server version supported by the selected bot client. [Paper events](https://docs.papermc.io/paper/dev/event-listeners/), [scheduler](https://docs.papermc.io/paper/dev/scheduler/), [persistent metadata](https://docs.papermc.io/paper/dev/pdc/).

**Current outcome:** an inspected reuse plan and exact source references. The running world remains NemoWorld's original browser implementation; no native engine, plugin or proprietary Minecraft content has been added.

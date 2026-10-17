// Extension registry for the Veloren link. One import and one array entry per feature keeps parallel
// work from editing the same lines of src/veloren-link.js.
//
// An extension is `{ name, schema?, handle(link, ctx) }`:
//   * `schema`: { version: <integer>, sql: '<CREATE TABLE ...>' } applied once to the link database
//     (tracked in ext_schema; never touch `PRAGMA user_version`, the core owns it).
//   * `handle(link, ctx)`: return `true` after answering a request, anything else to pass. `ctx` is
//     { request, response, route, url, body, json, tokenFrom, modelCall, platform, fail }; use
//     `link.authenticate`, `link.sql`, `link.clock`, `link.issueCommand`. `platform` is NemoWorld's own
//     world, accounts and economy: call its methods, never bypass its rules.
// Add new extensions below.
import { identityExtension } from './identity.js';
import shopExtension from './shop.js';
import { hudExtension } from './view.js';
import homeExtension from './home.js';
import atlasExtension from './atlas.js';
import { pantryExtension } from './pantry.js';
import { villageExtension } from './village.js';
import { npcExtension } from './npc-logic.js';
import { overviewExtension } from './overview.js';
import { gratitudeExtension } from './gratitude.js';
import { healthExtension } from './health.js';
import { cityExtension } from './city.js';

export const EXTENSIONS = [identityExtension, shopExtension, hudExtension, homeExtension, atlasExtension, pantryExtension, villageExtension, npcExtension, overviewExtension, gratitudeExtension, healthExtension, cityExtension];

// Content loaders: pure readers, not extensions (nothing here handles a request). The missions catalogue
// (engine stream) backs the `missions` and `tasks` pages; the stories stream's twelve daily story missions
// live beside it in story-missions.js / content/veloren-story-missions.json.
export { loadMissions, missionsLines } from './missions.js';
export { loadMissions as loadStoryMissions, missionLines } from './story-missions.js';
export { loadStories } from './stories.js';
export { loadConversations } from './conversations.js';

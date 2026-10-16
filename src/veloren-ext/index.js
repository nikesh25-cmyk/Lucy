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
import { hudExtension } from './view.js';

export const EXTENSIONS = [identityExtension, hudExtension];

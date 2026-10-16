#!/usr/bin/env node
// Administer Veloren link credentials. Needs the same NEMO_LINK_EVENT_KEY (and optional
// NEMO_LINK_DB / LUCY_DATABASE) as the server. The token is printed once and never stored.
//   node scripts/veloren-link.mjs issue --resident lw-lyra --scopes events,talk,director --days 7 --label "bridge"
//   node scripts/veloren-link.mjs revoke <key_id>
//   node scripts/veloren-link.mjs list
//   node scripts/veloren-link.mjs status
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VelorenLink, loadLandmarks } from '../src/veloren-link.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const key = process.env.NEMO_LINK_EVENT_KEY;
if (!key) { console.error('Set NEMO_LINK_EVENT_KEY (the shared event key) first.'); process.exit(2); }
const mainDb = process.env.LUCY_DATABASE || join(root, 'data', 'world.sqlite');
const link = new VelorenLink({
  dbPath: process.env.NEMO_LINK_DB || join(dirname(mainDb), 'veloren-link.sqlite'),
  eventKey: Buffer.from(key, /^[a-f0-9]{64,}$/i.test(key) ? 'hex' : 'utf8'),
  landmarks: loadLandmarks(process.env.NEMO_LINK_LANDMARKS || join(root, 'content', 'veloren-landmarks.json')),
});
const [command, ...rest] = process.argv.slice(2);
const option = (name, fallback) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback; };
try {
  if (command === 'issue') {
    const issued = link.issueCredential({ resident_id: option('--resident'), scopes: String(option('--scopes', '')).split(',').filter(Boolean), days: Number(option('--days', 7)), label: option('--label', '') });
    console.log(JSON.stringify(issued, null, 2));
    console.error('Keep the token private. It is shown once.');
  } else if (command === 'revoke') {
    console.log(link.revokeCredential(rest[0]) ? 'revoked' : 'no active credential with that id');
  } else if (command === 'list') {
    console.table(link.listCredentials().map((row) => ({ ...row, expires_at: new Date(row.expires_at).toISOString(), revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : '' })));
  } else if (command === 'status') {
    console.log(JSON.stringify(link.status(), null, 2));
  } else {
    console.error('Commands: issue, revoke <key_id>, list, status');
    process.exitCode = 2;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; } finally { link.close(); }

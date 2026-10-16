#!/usr/bin/env node
// Forward the Veloren server's signed event outbox to NemoWorld.
//   NEMO_LINK_TOKEN=<link credential with the events scope> \
//   node scripts/veloren-relay.mjs --outbox path/to/outbox.jsonl [--url http://127.0.0.1:3100] [--once]
//     [--resident lw-aria] [--offset-file path]
// The token is read from the environment only, never from arguments.
//
// With more than one resident in the server's link config, run one relay per resident, each with its
// own `events` credential and `--resident <id>`: NemoWorld refuses a fact about any other resident
// (`resident_out_of_scope`) and a refusal is final, so an unfiltered relay would drop the rest for
// ever. Each filtered relay also keeps its own offset by default (`<outbox>.offset.<resident>`), so the
// relays do not read over each other's bookmark.
import { relayForever, relayOnce } from '../src/veloren-relay.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const outbox = option('--outbox');
const url = option('--url', process.env.NEMO_URL || 'http://127.0.0.1:3100');
const resident = option('--resident', process.env.NEMO_LINK_RESIDENT || null);
const offsetFile = option('--offset-file', outbox ? `${outbox}.offset${resident ? `.${resident}` : ''}` : undefined);
const token = process.env.NEMO_LINK_TOKEN;
if (!outbox || !token) {
  console.error('Usage: NEMO_LINK_TOKEN=<token> node scripts/veloren-relay.mjs --outbox <file> [--url <NemoWorld URL>] [--resident <resident id>] [--offset-file <file>] [--once]');
  process.exit(2);
}
const log = (message) => console.error(`[relay]${resident ? ` ${resident}` : ''} ${message}`);
if (args.includes('--once')) {
  const stats = await relayOnce({ outbox, offsetFile, url, token, resident, log });
  console.log(JSON.stringify(stats));
  process.exit(stats.failed ? 1 : 0);
}
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => controller.abort());
log(`forwarding ${outbox} to ${url}${resident ? ` (only ${resident}'s facts)` : ''}`);
await relayForever({ outbox, offsetFile, url, token, resident, log, signal: controller.signal });

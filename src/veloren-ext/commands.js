import { createHmac } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// NemoWorld -> Veloren commands: one JSON object per line, appended to a file the Veloren server reads.
//
//   {"v":1,"cmd_id":"<uuid>","kind":"grant_item","player_uuid":"<uuid>","args":"<json text>",
//    "issued_at":<ms>,"expires_at":<ms>,"sig":"<hex hmac-sha256>"}
//
// `args` is the exact JSON text that was signed; the server verifies the signature over that text before
// it parses it. The server applies a command AT MOST ONCE (it records the id before acting) and answers
// with a signed `command.applied` or `command.rejected` event whose landmark_id field carries the cmd_id.
// If no acknowledgement arrives before expiry, nothing is known to have happened: show it as unconfirmed
// and let a human retry with a NEW command. Never retry with the same id and never assume success.

export const COMMAND_VERSION = 1;
export const COMMAND_MAX_TTL_MS = 10 * 60_000;
const KIND = /^[a-z][a-z0-9_]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function canonicalCommand(c) {
  return [c.v, c.cmd_id, c.kind, c.player_uuid, c.args, c.issued_at, c.expires_at].map((part) => String(part)).join('\n');
}

export function signCommand(key, command) {
  return createHmac('sha256', key).update(canonicalCommand(command)).digest('hex');
}

export class CommandOutbox {
  constructor({ path, key, clock = Date.now }) {
    if (!path) throw new Error('A commands file path is required.');
    if (!(key instanceof Buffer) || key.length < 32) throw new Error('The event key must be at least 32 bytes.');
    mkdirSync(dirname(path), { recursive: true });
    this.path = path; this.key = key; this.clock = clock;
  }

  // Returns the signed command (including its id) after it is appended as one write.
  issue({ kind, player_uuid, args = {}, ttl_ms = 60_000 }) {
    if (!KIND.test(kind || '')) throw new Error('Invalid command kind.');
    if (!UUID.test(player_uuid || '')) throw new Error('Invalid player id.');
    if (!Number.isInteger(ttl_ms) || ttl_ms < 1000 || ttl_ms > COMMAND_MAX_TTL_MS) throw new Error('Invalid command lifetime.');
    const text = JSON.stringify(args);
    if (/[\r\n]/.test(text)) throw new Error('Command arguments must be single-line JSON.');
    const issued_at = this.clock();
    const command = { v: COMMAND_VERSION, cmd_id: randomUUID(), kind, player_uuid, args: text, issued_at, expires_at: issued_at + ttl_ms };
    command.sig = signCommand(this.key, command);
    appendFileSync(this.path, JSON.stringify(command) + '\n');
    return command;
  }
}

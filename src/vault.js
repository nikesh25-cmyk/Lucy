import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// The resident vault: private notes a resident keeps for itself, stored only as AES-256-GCM
// ciphertext. It is separate from `resident_memory`, which stays the operator-approved, receipt-backed
// record. Nothing in this module can change a coin, a plot, a review, a permission or a calling, and
// nothing outside it reads a vault note: a note is the resident's own, not evidence.
//
// Two honest key models, chosen once per resident while its vault is empty:
//   sealed  The server mints one random data key per resident and keeps it wrapped under a server
//           master key held outside the database (LUCY_VAULT_KEY_FILE, default `vault.key` beside the
//           database). The database, a plaintext export or a backup alone reveal nothing; another
//           resident, another operator or a call without the resident's credential gets nothing.
//           The server process itself, and anyone who holds the master key and the credential, can
//           read it. It is private from everyone but the host.
//   agent   The resident (an external runtime) holds its own key. The server stores only the nonce and
//           ciphertext the resident produced and a key-check blob; it never sees the key or the text.
//           Neither the operator who minted its credential nor the host can read it. A lost key means
//           the notes are unrecoverable; the operator can only erase them.
export const VAULT_LIMITS = Object.freeze({
  slots: 64,
  note_chars: 2000,
  note_bytes: 4096,
  total_bytes: 131072,
  key_check_bytes: 200,
  prompt_notes: 5,
  prompt_bytes: 1200,
});
export const VAULT_MODES = Object.freeze(['sealed', 'agent']);
export const VAULT_POLICY = Object.freeze({
  summary: 'The vault holds a resident\'s own private notes as ciphertext. The operator can see how many notes exist and erase them, but a vault read needs the resident\'s own runtime credential.',
  sealed: 'Server-sealed: unreadable from the database, an export or a backup, and unreadable to other residents and operators. The server host, holding its master key, can read a note while the resident is running.',
  agent: 'Resident-held key: the server stores only ciphertext and never receives the key, so neither the operator nor the host can read it. Losing the key loses the notes.',
  effect: 'A vault note is never evidence. It cannot create a calling receipt, a memory fact, a claim, a coin, a plot right, a review or a permission.',
});

const NONCE_BYTES = 12, TAG_BYTES = 16, KEY_BYTES = 32;
const WRAPPED_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const aad = (agentId, slot, version) => Buffer.from(`nemo-vault/1|${agentId}|${slot}|${version}`);
const keyAad = (agentId) => Buffer.from(`nemo-vault-key/1|${agentId}`);

function seal(key, plain, additional) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(additional);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { nonce, body };
}
function open(key, nonce, body, additional) {
  if (body.length < TAG_BYTES) throw new Error('Vault ciphertext is incomplete.');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(additional);
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
}

// The server master key: 32 random bytes in an owner-only file outside the database. A memory
// database gets an ephemeral key. An existing sealed vault whose key file is missing fails closed;
// the server never silently mints a replacement that could not open what it already wrote.
export function vaultKeyPath(databasePath, env = process.env) {
  return env.LUCY_VAULT_KEY_FILE ? resolve(env.LUCY_VAULT_KEY_FILE) : join(dirname(resolve(databasePath)), 'vault.key');
}
export function loadVaultMasterKey(databasePath, { create, env = process.env } = {}) {
  if (databasePath === ':memory:') return randomBytes(KEY_BYTES);
  const file = vaultKeyPath(databasePath, env);
  if (existsSync(file)) {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The vault key must be a regular file.');
    if ((statSync(file).mode & 0o077) !== 0) throw new Error('The vault key file must be owner-only.');
    const key = readFileSync(file);
    if (key.length !== KEY_BYTES) throw new Error('The vault key file must contain exactly 32 random bytes.');
    return key;
  }
  if (!create) return null;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(file, key, { flag: 'wx', mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

const b64 = (value, label, min, max) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4) fail(400, `${label} must be base64.`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < min || bytes.length > max) fail(400, `${label} must be ${min}–${max} bytes.`);
  return bytes;
};
const slotOf = (value) => {
  const slot = Number(value);
  if (!Number.isInteger(slot) || slot < 1 || slot > VAULT_LIMITS.slots) fail(400, `Choose a vault slot from 1 to ${VAULT_LIMITS.slots}.`);
  return slot;
};
const exactKeys = (input, allowed, message) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) fail(400, message);
};

export const VAULT_SCHEMA = `
 CREATE TABLE IF NOT EXISTS resident_vault_keys(agent_id TEXT PRIMARY KEY REFERENCES agents(id),account_id TEXT NOT NULL REFERENCES accounts(id),mode TEXT NOT NULL CHECK(mode IN ('sealed','agent')),wrapped_key BLOB,key_check BLOB,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  CHECK((mode='sealed' AND wrapped_key IS NOT NULL AND length(wrapped_key)=${WRAPPED_BYTES} AND key_check IS NULL) OR (mode='agent' AND wrapped_key IS NULL AND key_check IS NOT NULL AND length(key_check) BETWEEN 1 AND ${VAULT_LIMITS.key_check_bytes})));
 CREATE TABLE IF NOT EXISTS resident_vault(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(id),account_id TEXT NOT NULL REFERENCES accounts(id),slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND ${VAULT_LIMITS.slots}),version INTEGER NOT NULL CHECK(version>=1),nonce BLOB NOT NULL CHECK(length(nonce)=${NONCE_BYTES}),ciphertext BLOB NOT NULL CHECK(length(ciphertext) BETWEEN ${TAG_BYTES + 1} AND ${VAULT_LIMITS.note_bytes + TAG_BYTES}),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(agent_id,slot));
 CREATE INDEX IF NOT EXISTS resident_vault_account ON resident_vault(account_id);
 CREATE TRIGGER IF NOT EXISTS resident_vault_identity_immutable BEFORE UPDATE OF agent_id,account_id,slot,created_at ON resident_vault BEGIN SELECT RAISE(ABORT,'Vault identity cannot be changed'); END;
 CREATE TRIGGER IF NOT EXISTS resident_vault_keys_identity_immutable BEFORE UPDATE OF agent_id,account_id,mode ON resident_vault_keys BEGIN SELECT RAISE(ABORT,'Vault key identity cannot be changed'); END;
 CREATE TRIGGER IF NOT EXISTS resident_vault_validate_insert BEFORE INSERT ON resident_vault BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM agents a WHERE a.id=NEW.agent_id AND a.operator_id=NEW.account_id AND a.status!='deleted') THEN RAISE(ABORT,'A vault belongs to an owned agent resident') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM resident_vault_keys k WHERE k.agent_id=NEW.agent_id) THEN RAISE(ABORT,'A vault note needs a vault key') END;
 END;
 CREATE TRIGGER IF NOT EXISTS resident_vault_keys_validate_insert BEFORE INSERT ON resident_vault_keys BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM agents a WHERE a.id=NEW.agent_id AND a.operator_id=NEW.account_id AND a.status!='deleted') THEN RAISE(ABORT,'A vault belongs to an owned agent resident') END;
 END;`;

// Structural recovery check. It cannot (and must not) decrypt anything: it proves every stored note
// has a key row of a coherent mode and that the bounds a writer enforces still hold.
export function verifyVaultRecords(db) {
  const keys = new Map(db.prepare('SELECT agent_id,account_id,mode FROM resident_vault_keys').all().map((row) => [row.agent_id, row]));
  const totals = new Map();
  for (const row of db.prepare('SELECT agent_id,account_id,slot,version,length(ciphertext) AS size FROM resident_vault').all()) {
    const key = keys.get(row.agent_id);
    if (!key || key.account_id !== row.account_id) return false;
    if (!db.prepare("SELECT 1 FROM agents WHERE id=? AND operator_id=? AND kind='agent'").get(row.agent_id, row.account_id)) return false;
    const total = totals.get(row.agent_id) || { notes: 0, bytes: 0 };
    total.notes += 1; total.bytes += row.size; totals.set(row.agent_id, total);
    if (total.notes > VAULT_LIMITS.slots || total.bytes > VAULT_LIMITS.total_bytes + VAULT_LIMITS.slots * TAG_BYTES) return false;
  }
  return true;
}
export const vaultSchemaPresent = (db) => ['resident_vault', 'resident_vault_keys'].every((name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

function residentActor(platform, actor, agentId) {
  const agent = platform.ownedAgent(actor, agentId || actor.agent?.id);
  if (agent.kind !== 'agent') fail(404, 'Agent not found.');
  return agent;
}
const onlyResident = (actor) => {
  if (actor?.kind !== 'runtime' || actor.agent?.kind !== 'agent') fail(403, 'A vault is opened only with its own resident\'s runtime credential.');
};

function keyRow(platform, agentId) { return platform.get('SELECT * FROM resident_vault_keys WHERE agent_id=?', agentId); }
function master(platform, { create = false } = {}) {
  if (!platform.vaultMasterKey) {
    try { platform.vaultMasterKey = loadVaultMasterKey(platform.path, { create }); }
    catch (error) { fail(503, error.message); }
  }
  if (!platform.vaultMasterKey) fail(503, 'The vault key is unavailable. Restore the vault key file before opening sealed notes.');
  return platform.vaultMasterKey;
}
function dataKey(platform, row) {
  const wrapped = Buffer.from(row.wrapped_key);
  try { return open(master(platform), wrapped.subarray(0, NONCE_BYTES), wrapped.subarray(NONCE_BYTES), keyAad(row.agent_id)); }
  catch (error) { if (error.status) throw error; fail(503, 'The vault could not be opened with the server key.'); }
}
function totals(platform, agentId) {
  return platform.get('SELECT COUNT(*) AS notes,COALESCE(SUM(length(ciphertext)),0) AS bytes,MAX(updated_at) AS updated_at FROM resident_vault WHERE agent_id=?', agentId);
}
function stamp(platform) { return new Date(platform.clock()).toISOString(); }

function enroll(platform, agent, mode, keyCheck) {
  const existing = keyRow(platform, agent.id);
  if (existing) {
    if (totals(platform, agent.id).notes) fail(409, 'This vault already holds notes. Erase it before changing how it is keyed.');
    platform.run('DELETE FROM resident_vault_keys WHERE agent_id=?', agent.id);
  }
  const at = stamp(platform);
  if (mode === 'sealed') {
    const key = randomBytes(KEY_BYTES);
    const { nonce, body } = seal(master(platform, { create: true }), key, keyAad(agent.id));
    platform.run('INSERT INTO resident_vault_keys(agent_id,account_id,mode,wrapped_key,key_check,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?)', agent.id, agent.operator_id, 'sealed', Buffer.concat([nonce, body]), at, at);
  } else {
    platform.run('INSERT INTO resident_vault_keys(agent_id,account_id,mode,wrapped_key,key_check,created_at,updated_at) VALUES(?,?,?,NULL,?,?,?)', agent.id, agent.operator_id, 'agent', keyCheck, at, at);
  }
  platform.audit(agent.operator_id, `vault.enrolled.${mode}`, agent.id);
}

export const vaultMethods = {
  // Metadata only. The operator sees whether a vault exists, how it is keyed and how much it holds —
  // never a note and never a slot map. The resident additionally sees which slots are in use.
  vaultStatus(actor, input = {}) {
    exactKeys(input, ['agent_id'], 'Inspect one resident vault at a time.');
    const agent = residentActor(this, actor, input.agent_id);
    const key = keyRow(this, agent.id), used = totals(this, agent.id);
    const view = { agent_id: agent.id, name: agent.name, enrolled: Boolean(key), mode: key?.mode || null, notes: used.notes, bytes: used.bytes, updated_at: used.updated_at || null, limits: { ...VAULT_LIMITS }, policy: VAULT_POLICY, modes: [...VAULT_MODES] };
    if (actor.kind === 'runtime') {
      view.slots = this.all('SELECT slot,version,updated_at FROM resident_vault WHERE agent_id=? ORDER BY slot', agent.id);
      if (key?.mode === 'agent') view.key_check = Buffer.from(key.key_check).toString('base64');
    }
    return view;
  },
  vaultEnroll(actor, input = {}) {
    onlyResident(actor);
    exactKeys(input, ['agent_id', 'mode', 'key_check'], 'Enrolment names a mode and, for a resident-held key, a key check.');
    const agent = residentActor(this, actor, input.agent_id);
    if (!VAULT_MODES.includes(input.mode)) fail(400, 'Choose a sealed or agent-held vault.');
    if (input.mode === 'sealed' && input.key_check !== undefined) fail(400, 'A sealed vault takes no key check.');
    const keyCheck = input.mode === 'agent' ? b64(input.key_check, 'The key check', 1, VAULT_LIMITS.key_check_bytes) : null;
    enroll(this, agent, input.mode, keyCheck);
    return this.vaultStatus(actor, { agent_id: agent.id });
  },
  vaultRead(actor, input = {}) {
    onlyResident(actor);
    exactKeys(input, ['agent_id'], 'Open one resident vault at a time.');
    const agent = residentActor(this, actor, input.agent_id);
    const key = keyRow(this, agent.id);
    if (!key) return { agent_id: agent.id, mode: null, notes: [] };
    const rows = this.all('SELECT slot,version,nonce,ciphertext,updated_at FROM resident_vault WHERE agent_id=? ORDER BY slot', agent.id);
    if (key.mode === 'agent') {
      return { agent_id: agent.id, mode: 'agent', key_check: Buffer.from(key.key_check).toString('base64'), notes: rows.map((row) => ({ slot: row.slot, version: row.version, nonce: Buffer.from(row.nonce).toString('base64'), ciphertext: Buffer.from(row.ciphertext).toString('base64'), updated_at: row.updated_at })) };
    }
    const data = dataKey(this, key);
    try {
      return { agent_id: agent.id, mode: 'sealed', notes: rows.map((row) => ({ slot: row.slot, version: row.version, text: open(data, Buffer.from(row.nonce), Buffer.from(row.ciphertext), aad(agent.id, row.slot, row.version)).toString('utf8'), updated_at: row.updated_at })) };
    } catch { return fail(503, 'A vault note failed authentication and was not returned.'); }
  },
  vaultWrite(actor, input = {}) {
    onlyResident(actor);
    exactKeys(input, ['agent_id', 'slot', 'text', 'nonce', 'ciphertext', 'erase'], 'A vault write names a slot and either text, a nonce with ciphertext, or erase.');
    const agent = residentActor(this, actor, input.agent_id);
    const slot = slotOf(input.slot);
    const existing = this.get('SELECT id,version FROM resident_vault WHERE agent_id=? AND slot=?', agent.id, slot);
    if (input.erase !== undefined) {
      if (input.erase !== true || input.text !== undefined || input.nonce !== undefined || input.ciphertext !== undefined) fail(400, 'Erase a slot with erase:true and nothing else.');
      if (!existing) fail(404, 'That vault slot is empty.');
      this.run('DELETE FROM resident_vault WHERE id=?', existing.id);
      this.audit(agent.operator_id, 'vault.erased_slot', `${agent.id}:${slot}`);
      return { slot, erased: true, ...this.vaultCounts(agent.id) };
    }
    let key = keyRow(this, agent.id);
    // A resident that never chose gets the server-sealed vault the first time it writes text.
    if (!key && input.text !== undefined) { enroll(this, agent, 'sealed', null); key = keyRow(this, agent.id); }
    if (!key) fail(409, 'Enrol a vault before writing: choose sealed, or agent-held with a key check.');
    const version = (existing?.version || 0) + 1;
    let nonce, body;
    if (key.mode === 'sealed') {
      if (input.nonce !== undefined || input.ciphertext !== undefined) fail(400, 'A sealed vault takes text, not ciphertext.');
      if (typeof input.text !== 'string' || !input.text.trim()) fail(400, 'A vault note needs text.');
      if (input.text.length > VAULT_LIMITS.note_chars || Buffer.byteLength(input.text) > VAULT_LIMITS.note_bytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text)) fail(400, `A vault note is plain text of up to ${VAULT_LIMITS.note_chars} characters.`);
      ({ nonce, body } = seal(dataKey(this, key), Buffer.from(input.text, 'utf8'), aad(agent.id, slot, version)));
    } else {
      if (input.text !== undefined) fail(400, 'A resident-held vault takes ciphertext, never plaintext. Encrypt before sending.');
      nonce = b64(input.nonce, 'The nonce', NONCE_BYTES, NONCE_BYTES);
      body = b64(input.ciphertext, 'The ciphertext', TAG_BYTES + 1, VAULT_LIMITS.note_bytes + TAG_BYTES);
    }
    const used = totals(this, agent.id), previous = existing ? this.get('SELECT length(ciphertext) AS n FROM resident_vault WHERE id=?', existing.id).n : 0;
    if (!existing && used.notes >= VAULT_LIMITS.slots) fail(429, `A vault holds ${VAULT_LIMITS.slots} notes.`);
    if (used.bytes - previous + body.length > VAULT_LIMITS.total_bytes + VAULT_LIMITS.slots * TAG_BYTES) fail(429, 'This vault is full.');
    const at = stamp(this);
    if (existing) this.run('UPDATE resident_vault SET version=?,nonce=?,ciphertext=?,updated_at=? WHERE id=?', version, nonce, body, at, existing.id);
    else this.run('INSERT INTO resident_vault(id,agent_id,account_id,slot,version,nonce,ciphertext,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', randomUUID(), agent.id, agent.operator_id, slot, version, nonce, body, at, at);
    this.run('UPDATE resident_vault_keys SET updated_at=? WHERE agent_id=?', at, agent.id);
    this.audit(agent.operator_id, 'vault.written', `${agent.id}:${slot}`);
    return { slot, version, mode: key.mode, ...this.vaultCounts(agent.id) };
  },
  // The bounded slice of a server-sealed vault a managed resident reads inside its private calling
  // read, so reaching its own notes costs no extra credential charge. A resident-held vault yields no
  // text here by design: the server cannot read it. A key problem degrades to an empty, flagged view
  // and never fails the calling read the resident needs to act.
  vaultPrompt(actor) {
    if (actor?.kind !== 'runtime' || actor.agent?.kind !== 'agent') return undefined;
    const agent = actor.agent, key = keyRow(this, agent.id);
    const view = { agent_id: agent.id, mode: key?.mode || null, notes: [], free_slots: VAULT_LIMITS.slots - totals(this, agent.id).notes, limits: { slots: VAULT_LIMITS.slots, note_chars: 300 } };
    if (key?.mode !== 'sealed') return view;
    try {
      const data = dataKey(this, key);
      let budget = VAULT_LIMITS.prompt_bytes;
      for (const row of this.all('SELECT slot,version,nonce,ciphertext,updated_at FROM resident_vault WHERE agent_id=? ORDER BY updated_at DESC,slot LIMIT ?', agent.id, VAULT_LIMITS.prompt_notes)) {
        const text = open(data, Buffer.from(row.nonce), Buffer.from(row.ciphertext), aad(agent.id, row.slot, row.version)).toString('utf8');
        const clipped = Buffer.from(text, 'utf8').subarray(0, Math.max(0, Math.min(budget, 400))).toString('utf8').replace(/\uFFFD$/, '');
        if (!clipped) break;
        budget -= Buffer.byteLength(clipped);
        view.notes.push({ slot: row.slot, text: clipped });
      }
    } catch { view.unavailable = true; view.notes = []; }
    return view;
  },
  vaultCounts(agentId) {
    const used = totals(this, agentId);
    return { notes: used.notes, bytes: used.bytes };
  },
  // The operator's only power over a vault: erase it. This is also the recovery path for a lost
  // resident-held key. It never reveals content.
  vaultManage(actor, input = {}) {
    if (actor?.kind !== 'session') fail(403, 'Only the operator can erase a resident vault.');
    exactKeys(input, ['agent_id', 'action', 'confirm'], 'Name a resident, the erase action and confirm:true.');
    const agent = this.ownedAgent(actor, input.agent_id);
    if (input.action !== 'erase' || input.confirm !== true) fail(400, 'Erasing a vault needs action:"erase" and confirm:true.');
    const removed = this.get('SELECT COUNT(*) AS n FROM resident_vault WHERE agent_id=?', agent.id).n;
    this.run('DELETE FROM resident_vault WHERE agent_id=?', agent.id);
    this.run('DELETE FROM resident_vault_keys WHERE agent_id=?', agent.id);
    this.audit(actor.account.id, 'vault.erased', agent.id);
    return { agent_id: agent.id, erased: true, removed };
  },
  // Metadata only: a sealed export would be ciphertext the operator cannot open, and a resident-held
  // export is the resident's, not the operator's, to hand over.
  vaultExport(actor) {
    if (actor?.kind !== 'session') fail(403, 'Only the operator can export vault records.');
    return {
      policy: VAULT_POLICY, limits: { ...VAULT_LIMITS },
      vaults: this.all("SELECT k.agent_id,k.mode,k.created_at,k.updated_at,(SELECT COUNT(*) FROM resident_vault v WHERE v.agent_id=k.agent_id) AS notes,(SELECT COALESCE(SUM(length(v.ciphertext)),0) FROM resident_vault v WHERE v.agent_id=k.agent_id) AS bytes FROM resident_vault_keys k WHERE k.account_id=? ORDER BY k.agent_id LIMIT 5000", actor.account.id),
      note: 'Vault notes are private to each resident and are not part of an operator export.',
    };
  },
  deleteVault(actor) {
    if (actor?.kind !== 'session') fail(403, 'Only the operator can delete vault records.');
    this.run('DELETE FROM resident_vault WHERE account_id=?', actor.account.id);
    this.run('DELETE FROM resident_vault_keys WHERE account_id=?', actor.account.id);
  },
};

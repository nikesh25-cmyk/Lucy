import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.js';
import {fixture} from './helpers.js';
import {VelorenLink, signEvent} from '../src/veloren-link.js';
import {relayOnce, relayTarget} from '../src/veloren-relay.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const LANDMARKS = [{id: 'lyra-post', name: 'the Old Library', role: 'post'}, {id: 'lyra-survey', name: 'Mill Hill', role: 'survey'}];
const P1 = '11111111-1111-4111-8111-111111111111';
const NOW = Date.now();

let seq = 100;
function line(overrides = {}) {
  seq += 1;
  const e = {v: 1, server_id: 'relay-test', seq, kind: 'resident.met', resident_id: 'lw-lyra', player_uuid: P1, player_alias: 'Tester', landmark_id: null, occurred_at: NOW - 1000, ...overrides};
  e.sig = signEvent(KEY, e);
  return JSON.stringify(e) + '\n';
}

async function world(t) {
  const f = await fixture(t);
  const link = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS});
  const cred = link.issueCredential({resident_id: 'lw-lyra', scopes: ['events', 'director'], days: 1});
  const app = createApp({platform: f.platform, backupDir: join(f.directory, 'backups'), velorenLink: link, mayorModel: null});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'veloren-relay-'));
  t.after(() => { rmSync(directory, {recursive: true, force: true}); try { link.close(); } catch { /* done */ } });
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  return {link, cred, directory, url: `http://127.0.0.1:${app.server.address().port}`, outbox: join(directory, 'outbox.jsonl'), offsetFile: join(directory, 'outbox.offset')};
}

test('the relay forwards each outbox line once and resumes from where it was acknowledged', async t => {
  const w = await world(t);
  writeFileSync(w.outbox, line() + line({kind: 'landmark.together', landmark_id: 'lyra-survey'}) + line({landmark_id: 'lyra-post'}));
  const run = () => relayOnce({outbox: w.outbox, offsetFile: w.offsetFile, url: w.url, token: w.cred.token});

  const first = await run();
  assert.equal(first.sent, 3); assert.equal(first.accepted, 3); assert.equal(first.failed, 0);
  assert.equal(w.link.status().events, 3);
  assert.equal(Number(readFileSync(w.offsetFile, 'utf8')), readFileSync(w.outbox).length, 'the offset is the end of the acknowledged data');

  assert.equal((await run()).sent, 0, 'nothing is sent twice');
  appendFileSync(w.outbox, line({player_alias: 'Tester'}));
  const next = await run();
  assert.equal(next.sent, 1); assert.equal(w.link.status().events, 4);
});

test('a lost acknowledgement is harmless: resending the whole outbox changes nothing', async t => {
  const w = await world(t);
  writeFileSync(w.outbox, line() + line({kind: 'landmark.together', landmark_id: 'lyra-survey', occurred_at: NOW - 500}) + line({landmark_id: 'lyra-post', occurred_at: NOW - 100}));
  await relayOnce({outbox: w.outbox, offsetFile: w.offsetFile, url: w.url, token: w.cred.token});
  const before = JSON.stringify(w.link.progress(P1)); const count = w.link.status();
  writeFileSync(w.offsetFile, '0\n');                          // as if the relay crashed before saving its offset
  const again = await relayOnce({outbox: w.outbox, offsetFile: w.offsetFile, url: w.url, token: w.cred.token});
  assert.equal(again.duplicate, 3); assert.equal(again.accepted, 0);
  assert.equal(JSON.stringify(w.link.progress(P1)), before);
  assert.deepEqual(w.link.status(), count);
  assert.equal(w.link.progress(P1).complete, true);
});

test('failures leave the offset alone; later lines still flow past a malformed or forged one', async t => {
  const w = await world(t);
  const forged = JSON.parse(line()); forged.sig = '0'.repeat(64);
  writeFileSync(w.outbox, 'this is not json\n' + JSON.stringify(forged) + '\n' + line() + '{"partial":');
  const logs = [];
  const stats = await relayOnce({outbox: w.outbox, offsetFile: w.offsetFile, url: w.url, token: w.cred.token, log: m => logs.push(m)});
  assert.equal(stats.malformed, 1); assert.equal(stats.rejected, 1); assert.equal(stats.accepted, 1);
  assert.ok(logs.some(m => /rejected: bad_signature/.test(m)));
  const consumed = Number(readFileSync(w.offsetFile, 'utf8'));
  assert.ok(consumed < readFileSync(w.outbox).length, 'a partly written last line is left for the next pass');

  // Wrong or revoked credential: nothing is consumed, so nothing is lost.
  writeFileSync(w.offsetFile, '0\n');
  const bad = await relayOnce({outbox: w.outbox, offsetFile: w.offsetFile, url: w.url, token: 'a'.repeat(64)});
  assert.equal(bad.failed, 1); assert.equal(Number(readFileSync(w.offsetFile, 'utf8')), 0);
  w.link.revokeCredential(w.cred.key_id);
  const revoked = await relayOnce({outbox: w.outbox, offsetFile: w.offsetFile, url: w.url, token: w.cred.token});
  assert.equal(revoked.failed, 1); assert.equal(Number(readFileSync(w.offsetFile, 'utf8')), 0);

  // NemoWorld unreachable: also nothing consumed.
  const down = await relayOnce({outbox: w.outbox, offsetFile: w.offsetFile, url: 'http://127.0.0.1:9', token: w.cred.token});
  assert.equal(down.failed, 1); assert.equal(Number(readFileSync(w.offsetFile, 'utf8')), 0);
});

test('the relay sends its credential only over HTTPS or to a local address', () => {
  assert.doesNotThrow(() => relayTarget('http://127.0.0.1:3100'));
  assert.doesNotThrow(() => relayTarget('http://localhost:3100'));
  assert.doesNotThrow(() => relayTarget('https://nemo.example.org'));
  assert.throws(() => relayTarget('http://nemo.example.org'), /HTTPS or to a local address/);
  assert.throws(() => relayTarget('ftp://127.0.0.1'), /HTTPS or to a local address/);
});

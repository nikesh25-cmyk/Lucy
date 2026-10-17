import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VelorenLink, signEvent} from '../src/veloren-link.js';
import {canonicalCommand, signCommand, CommandOutbox} from '../src/veloren-ext/commands.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const LANDMARKS = [{id: 'lyra-post', name: 'Post', role: 'post'}, {id: 'lyra-survey', name: 'Field', role: 'survey'}];
const P1 = '11111111-1111-4111-8111-111111111111';
const T0 = 1_760_572_800_000;

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'veloren-commands-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const clock = {now: T0};
  const commandsPath = join(directory, 'commands.jsonl');
  const link = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS, clock: () => clock.now, commandsPath});
  t.after(() => link.close());
  const cred = link.issueCredential({resident_id: 'lw-lyra', scopes: ['events'], days: 1});
  return {link, clock, commandsPath, auth: link.authenticate(cred.token, 'events')};
}
let seq = 500;
function ack(cmdId, kind = 'command.applied', overrides = {}) {
  seq += 1;
  const e = {v: 1, server_id: 'cmd-test', seq, kind, resident_id: 'lw-lyra', player_uuid: P1, player_alias: '', landmark_id: cmdId, occurred_at: T0 + 1000, ...overrides};
  e.sig = signEvent(KEY, e);
  return e;
}

test('the command signature format is pinned by a shared test vector (the Veloren server must match it)', () => {
  const c = {v: 1, cmd_id: '9c1f0f9e-0b0e-4e0e-9a5a-0123456789ab', kind: 'echo', player_uuid: '0b6f4f0e-2d5a-4c1a-9a53-6a3a1d2b7c10', args: '{"text":"hi"}', issued_at: 1760572800000, expires_at: 1760572860000};
  assert.equal(canonicalCommand(c), '1\n9c1f0f9e-0b0e-4e0e-9a5a-0123456789ab\necho\n0b6f4f0e-2d5a-4c1a-9a53-6a3a1d2b7c10\n{"text":"hi"}\n1760572800000\n1760572860000');
  assert.equal(signCommand(KEY, c), '67783eaced1e4dccb0a5f256dd0366fe0d0b50e236a85ba5a951e94c7ab4ce68');
});

test('a command is signed, expiring and written as one line; its fate is known only from a signed acknowledgement', t => {
  const {link, clock, commandsPath, auth} = setup(t);
  const command = link.issueCommand({kind: 'echo', player_uuid: P1, args: {text: 'hi'}, ttl_ms: 30_000, issuedBy: 'test'});
  const lines = readFileSync(commandsPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const written = JSON.parse(lines[0]);
  assert.equal(written.sig, signCommand(KEY, written));
  assert.equal(written.expires_at - written.issued_at, 30_000);
  assert.equal(link.commandStatus(command.cmd_id).status, 'pending');
  assert.equal(link.commandStatus('00000000-0000-4000-8000-000000000000').status, 'unknown');

  // Nobody can claim success without a signed acknowledgement.
  assert.equal(link.ingest(auth, [{...ack(command.cmd_id), sig: '0'.repeat(64)}])[0].reason, 'bad_signature');
  assert.equal(link.commandStatus(command.cmd_id).status, 'pending');
  assert.equal(link.ingest(auth, [ack('not-a-command-id')])[0].reason, 'bad_command_id');
  assert.equal(link.ingest(auth, [ack(command.cmd_id)])[0].status, 'accepted');
  assert.equal(link.commandStatus(command.cmd_id).status, 'applied');
  assert.equal(link.ingest(auth, [ack(command.cmd_id)])[0].status, 'accepted' /* new seq, same fact */);

  // A command that is never acknowledged is "unconfirmed", never "done".
  const lost = link.issueCommand({kind: 'echo', player_uuid: P1, ttl_ms: 1000});
  clock.now += 5000;
  assert.equal(link.commandStatus(lost.cmd_id).status, 'expired_unconfirmed');
  const refused = link.issueCommand({kind: 'echo', player_uuid: P1});
  assert.equal(link.ingest(auth, [ack(refused.cmd_id, 'command.rejected')])[0].status, 'accepted');
  assert.equal(link.commandStatus(refused.cmd_id).status, 'rejected');
});

test('command input is validated and bounded', t => {
  const {link} = setup(t);
  assert.throws(() => link.issueCommand({kind: 'Bad Kind', player_uuid: P1}), /Invalid command kind/);
  assert.throws(() => link.issueCommand({kind: 'echo', player_uuid: 'nope'}), /Invalid player id/);
  assert.throws(() => link.issueCommand({kind: 'echo', player_uuid: P1, ttl_ms: 99_999_999}), /Invalid command lifetime/);
  assert.throws(() => link.issueCommand({kind: 'echo', player_uuid: P1, ttl_ms: 10}), /Invalid command lifetime/);
  const plain = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS});
  t.after(() => plain.close());
  assert.throws(() => plain.issueCommand({kind: 'echo', player_uuid: P1}), e => e.status === 503);
  assert.throws(() => new CommandOutbox({path: '/tmp/x', key: Buffer.from('short')}), /32 bytes/);
});

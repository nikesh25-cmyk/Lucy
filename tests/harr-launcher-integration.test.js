import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'harr-launcher-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, text, mode = 0o600) => {
    const file = join(root, name); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text, { mode });
  };
  write('play/play.sh', readFileSync(new URL('../ops/play-local.sh', import.meta.url)), 0o700);
  const residents = Array.from({ length: 20 }, (_, i) => ({ id: `lw-fixture${i}`, name: `Fixture${i} Resident` }));
  write('play/nemoworld/content/veloren-villagers.json', JSON.stringify({ residents }));
  write('play/logs/server.log', 'ready to accept\n');
  const run = (command, env = {}) => spawnSync('/bin/bash', [join(root, 'play/play.sh'), command], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...env },
  });
  return { root, write, run, residents };
}
test('VILLAGE=12 selects twelve additional villagers rather than starting the entire roster', t => {
  const f = fixture(t); const result = f.run('status', { VILLAGE: '12' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /0 of 12 villagers/);
});
test('preflight refuses wildcard sockets before an unauthenticated start', t => {
  const f = fixture(t);
  f.write('play/userdata/server/server_config/settings.ron', '(gameserver_protocols:[Tcp(address:"0.0.0.0:14004")])');
  f.write('play/userdata/server-cli/settings.ron', '(web_address:"127.0.0.1:14005")');
  const result = f.run('preflight'); assert.equal(result.status, 1);
  assert.match(result.stderr, /loopback/i);
});
test('preflight accepts only explicit loopback game, query and web sockets', t => {
  const f = fixture(t);
  f.write('play/userdata/server/server_config/settings.ron', '(gameserver_protocols:[Tcp(address:"[::1]:14004"),Tcp(address:"127.0.0.1:14004")],query_address:Some("127.0.0.1:14006"))');
  f.write('play/userdata/server-cli/settings.ron', '(web_address:"127.0.0.1:14005")');
  const result = f.run('preflight'); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /loopback/i);
});
test('setup installs loopback-only PvE sockets on a disposable stack', t => {
  const f = fixture(t);
  f.write('nemoworld/content/veloren-villagers.json', JSON.stringify({ residents: [] }));
  f.write('nemoworld/content/veloren-landmarks-extra.json', '{"landmarks":[]}');
  const git = (...args) => execFileSync('git', ['-C', join(f.root, 'nemoworld'), ...args], { stdio: 'pipe' });
  git('init', '-b', 'integration/all'); git('add', '.');
  git('-c', 'user.name=Disposable fixture', '-c', 'user.email=fixture@example.org', 'commit', '-m', 'fixture');
  for (const name of ['veloren-server-cli', 'nemo-bridge']) f.write('wt/target/integ/release/' + name, '#!/bin/sh\nexit 0\n', 0o700);
  f.write('veloren/userdata/server/server_config/settings.ron', '(gameserver_protocols:[Tcp(address:"[::]:14004"),Tcp(address:"0.0.0.0:14004")],query_address:Some("0.0.0.0:14006"),mode:Global(PvP))');
  f.write('veloren/userdata/server-cli/settings.template.ron', '(web_address:"127.0.0.1:14005")');
  const config = { server_id: 'fixture', ack_resident: 'lw-lyra', home: {}, atlas: {}, world: {}, residents: { Lyra: 'lw-lyra' }, landmarks: [] };
  for (const id of ['integ', 'world']) f.write(`wt/run/${id}/veloren-link.json`, JSON.stringify(config));
  f.write('wt/veloren-integ/nemo-bridge/roster.json', '{"residents":[]}');
  f.write('fake-node', '#!/bin/sh\nprintf \'{"token":"disposable-fixture-only"}\\n\'\n', 0o700);
  const result = f.run('setup', { NEMO_NODE: join(f.root, 'fake-node'), VILLAGE: '0' });
  assert.equal(result.status, 0, result.stderr);
  const settings = readFileSync(join(f.root, 'play/userdata/server/server_config/settings.ron'), 'utf8');
  assert.doesNotMatch(settings, /0\.0\.0\.0|\[::\]/);
  assert.match(settings, /127\.0\.0\.1:14004/); assert.match(settings, /\[::1\]:14004/);
  assert.match(settings, /127\.0\.0\.1:14006/); assert.match(settings, /Global\(PvE\)/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createSocket } from 'node:dgram';
import { performance } from 'node:perf_hooks';
import { reserveLoopbackUdpPort, startSmokeEngine, stopSmokeChild } from '../native/smoke-process.mjs';

const bounded = (promise, ms = 1500) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('lifecycle regression exceeded its deadline')), ms); })]).finally(() => clearTimeout(timer));
};

test('cleanup returns for a child whose signal exit event has already happened', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  await once(child, 'spawn'); child.kill('SIGTERM'); await once(child, 'exit');
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, 'SIGTERM');
  await bounded(stopSmokeChild(child, { timeoutMs: 100, killTimeoutMs: 100 }));
});

test('a normally live child reaches its marker and shuts down under bounded cleanup', async t => {
  const engine = startSmokeEngine(process.execPath, ['-e', "console.log('READY');setInterval(()=>{},1000)"]);
  t.after(() => engine.stop());
  await bounded(engine.waitForMarker('READY'));
  await bounded(engine.stop({ timeoutMs: 200, killTimeoutMs: 200 }));
  assert.ok(engine.child.exitCode !== null || engine.child.signalCode !== null);
  assert.match(engine.logs, /READY/);
});

test('cleanup escalates for a live child that ignores SIGINT', async t => {
  const engine = startSmokeEngine(process.execPath, ['-e', "process.on('SIGINT',()=>{});console.log('READY');setInterval(()=>{},1000)"]);
  t.after(() => engine.stop()); await bounded(engine.waitForMarker('READY'));
  await bounded(engine.stop({ timeoutMs: 50, killTimeoutMs: 300 }));
  assert.equal(engine.child.signalCode, 'SIGKILL');
});

test('a failed spawn rejects marker wait promptly and cleanup has no missing exit event', async () => {
  const engine = startSmokeEngine('/definitely-missing-nemoworld-smoke-binary', []);
  await assert.rejects(bounded(engine.waitForMarker('NEVER', { timeoutMs: 5000 })), /ENOENT/);
  await bounded(engine.stop({ timeoutMs: 100, killTimeoutMs: 100 }));
});

test('an early engine exit reports useful redacted diagnostics while raw evidence keeps secrets', async t => {
  const secret = 'native-test-credential-9e12';
  const engine = startSmokeEngine(process.execPath, ['-e', `console.log('engine failure token=${secret}');process.exit(7)`], { secrets: [secret] });
  t.after(() => engine.stop()); const started = performance.now();
  await assert.rejects(bounded(engine.waitForMarker('NEVER', { timeoutMs: 5000 })), error => {
    assert.match(error.message, /exited before NEVER.*code=7/);
    assert.match(error.message, /engine failure token=\[redacted\]/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.ok(performance.now() - started < 1500);
  assert.ok(engine.logs.includes(secret), 'security assertions must see the original captured evidence');
});

test('overflow fails explicitly instead of silently discarding security evidence', async t => {
  const engine = startSmokeEngine(process.execPath, ['-e', "console.log('x'.repeat(4096));console.log('DONE');setInterval(()=>{},1000)"], { maxLogBytes: 128 });
  t.after(() => engine.stop());
  await assert.rejects(bounded(engine.waitForMarker('DONE')), /exceeded 128 bytes; refusing incomplete evidence/);
  assert.throws(() => engine.logs, /refusing incomplete evidence/);
});

test('UDP reservations bind ephemeral IPv4 loopback ports and hold them until release', async t => {
  const first = await reserveLoopbackUdpPort(), second = await reserveLoopbackUdpPort();
  t.after(() => first.release()); t.after(() => second.release());
  assert.equal(first.address, '127.0.0.1'); assert.equal(second.address, '127.0.0.1');
  assert.ok(first.port > 0); assert.ok(second.port > 0); assert.notEqual(first.port, second.port);
  const blocked = createSocket('udp4');
  const refused = new Promise(resolve => blocked.once('error', resolve));
  blocked.bind({ address: first.address, port: first.port, exclusive: true });
  assert.equal((await bounded(refused)).code, 'EADDRINUSE'); blocked.close();
  await first.release(); await first.release();
  const available = createSocket('udp4'); t.after(() => available.close());
  await new Promise((resolve, reject) => { available.once('error', reject); available.bind({ address: first.address, port: first.port, exclusive: true }, resolve); });
  assert.equal(available.address().address, '127.0.0.1');
});

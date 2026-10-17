import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VelorenLink } from '../src/veloren-link.js';
import { CITY_SCHEMA, NativeCityService } from '../src/veloren-ext/city-life.js';
import { cityLifeExtension, startNativeCity } from '../src/veloren-ext/city-runtime.js';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'city-runtime-'));
  const recordPath = join(directory, 'world.json');
  writeFileSync(recordPath, JSON.stringify({ works_elapsed_ms: 0, groups: {} }));
  const link = new VelorenLink({ dbPath: join(directory, 'link.sqlite'), extensions: [cityLifeExtension],
    eventKey: Buffer.alloc(32, 21), commandsPath: join(directory, 'commands.jsonl'),
    landmarks: [{ id: 'post', name: 'Post', role: 'post' }, { id: 'field', name: 'Field', role: 'survey' }] });
  t.after(() => { link.close(); rmSync(directory, { recursive: true, force: true }); });
  return { link, recordPath, count: () => link.sql.get('SELECT COUNT(*) n FROM city_citizens').n };
}

test('city extension registers the exact schema and only directs enabled Theron', () => {
  assert.equal(cityLifeExtension.name, 'city_life'); assert.equal(cityLifeExtension.schema, CITY_SCHEMA);
  for (const link of [{}, { nativeCity: { enabled: false } }]) assert.equal(cityLifeExtension.director(link, 'lw-theron'), null);
  const link = { nativeCity: { enabled: true } };
  assert.deepEqual(cityLifeExtension.director(link, 'lw-theron'), { mode: 'work', target_landmark_id: 'city-arrival' });
  assert.equal(cityLifeExtension.director(link, 'lw-rowan'), null);
});

test('disabled startup assigns a service but creates no timer, citizens or commands', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const w = setup(t); const stop = startNativeCity(w.link, null, { enabled: false, recordPath: w.recordPath });
  assert.ok(w.link.nativeCity instanceof NativeCityService);
  t.mock.timers.tick(600_000); assert.equal(w.count(), 0);
  assert.equal(w.link.sql.get('SELECT COUNT(*) n FROM city_clock').n, 0);
  assert.equal(w.link.sql.get('SELECT COUNT(*) n FROM link_commands').n, 0);
  stop(); stop();
});

test('enabled runtime ticks at the configured interval and stops cleanly', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const w = setup(t); const stop = startNativeCity(w.link, null, { enabled: true, recordPath: w.recordPath });
  t.after(stop); assert.equal(w.count(), 0);
  t.mock.timers.tick(1999); assert.equal(w.count(), 0);
  t.mock.timers.tick(1); assert.equal(w.count(), 8);
  let ticks = 0; w.link.nativeCity.tick = () => ticks++;
  t.mock.timers.tick(2000); assert.equal(ticks, 1);
  stop(); t.mock.timers.tick(10_000); assert.equal(ticks, 1);
  assert.equal(cityLifeExtension.director(w.link, 'lw-theron'), null);
});

test('timer bounds prevent tight loops and runtime replacement retires the previous timer', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const w = setup(t); const oldStop = startNativeCity(w.link, null, { enabled: true, recordPath: w.recordPath, intervalMs: 1 });
  t.after(oldStop); let oldTicks = 0; w.link.nativeCity.tick = () => oldTicks++;
  t.mock.timers.tick(999); assert.equal(oldTicks, 0);
  t.mock.timers.tick(1); assert.equal(oldTicks, 1);
  const stop = startNativeCity(w.link, null, { enabled: true, recordPath: w.recordPath, intervalMs: 999_999 });
  t.after(stop); let ticks = 0; w.link.nativeCity.tick = () => ticks++;
  oldStop(); t.mock.timers.tick(59_999); assert.equal(ticks, 0); assert.equal(oldTicks, 1);
  t.mock.timers.tick(1); assert.equal(ticks, 1); assert.equal(w.link.nativeCity.enabled, true);
});

test('tick errors produce a concise log and the timer can recover on the next tick', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const logs = t.mock.method(console, 'error', () => {});
  const w = setup(t); const stop = startNativeCity(w.link, null, { enabled: true, recordPath: w.recordPath });
  t.after(stop); w.link.nativeCity.tick = () => { throw new Error('Test storage unavailable\nsecond line'); };
  t.mock.timers.tick(2000);
  assert.equal(logs.mock.calls.length, 1);
  assert.match(logs.mock.calls[0].arguments[0], /native-city.*Test storage unavailable/);
  assert.doesNotMatch(logs.mock.calls[0].arguments[0], /\n/);
  let recovered = false; w.link.nativeCity.tick = () => { recovered = true; };
  t.mock.timers.tick(2000); assert.equal(recovered, true);
});

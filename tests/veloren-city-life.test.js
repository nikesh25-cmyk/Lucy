import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VelorenLink, signEvent } from '../src/veloren-link.js';
import { CITY_SCHEMA, NativeCityService } from '../src/veloren-ext/city-life.js';

const NODE_PRINCIPAL = '00000000-0000-4000-8000-000000000001';
const KEY = Buffer.alloc(32, 21);
function world(t, enabled = true, extras = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'nemo-city-life-'));
  const recordPath = join(directory, 'world.json');
  let now = 1_760_000_000_000, elapsed = 0, groups = {}, seq = 0, link, service;
  const options = { dbPath: join(directory, 'link.sqlite'), commandsPath: join(directory, 'commands.jsonl'), eventKey: KEY,
    clock: () => now, extensions: [], landmarks: [{ id: 'post', name: 'Post', role: 'post' }, { id: 'field', name: 'Field', role: 'survey' }] };
  function restart() {
    link?.close(); link = new VelorenLink(options); link.applyExtensionSchema('city_life', CITY_SCHEMA);
    service = new NativeCityService(link, extras.platform || null, { enabled, recordPath, ...extras });
  }
  function record() { writeFileSync(recordPath, JSON.stringify({ format: 'veloren-world-applied-v1', site: 'Harr', origin: [100, 200], works_started_ms: 1_760_000_000_000, works_elapsed_ms: elapsed, groups })); }
  restart(); record();
  t.after(() => { link.close(); rmSync(directory, { recursive: true, force: true }); });
  function ack(job, kind = 'command.applied', player = NODE_PRINCIPAL) {
    const cred = link.issueCredential({ resident_id: 'lw-lyra', scopes: ['events'], days: 1 });
    const event = { v: 1, server_id: 'city-life-test', seq: ++seq, kind, resident_id: 'lw-lyra', player_uuid: player,
      player_alias: '', landmark_id: job.cmd_id, occurred_at: now };
    event.sig = signEvent(KEY, event); link.ingest(link.authenticate(cred.token, 'events'), [event]);
  }
  return { get link() { return link; }, get service() { return service; }, recordPath, restart, ack,
    advance(ms = 30_000) { now += ms; elapsed += ms; record(); },
    offline(ms) { now += ms; },
    built(id) { groups[id] = { digest: '123456789abcdef0', anchor: [100, 200], ground: 12, cells: 10, blocks: 8, sprites: 2, foundation_columns: 1, written: 10, applied_at: now, removed: [] }; record(); },
    pending() { return link.sql.all("SELECT * FROM city_jobs WHERE state='issued'"); },
    commands() { return link.sql.all('SELECT * FROM link_commands'); },
    outbox() { return readFileSync(options.commandsPath, 'utf8').trim().split('\n').map(JSON.parse); },
    completeRound() { for (const job of this.pending()) ack(job); service.tick(); this.advance(); service.tick(); },
  };
}

test('disabled city service seeds nothing and writes no commands even on ticks and reads', t => {
  const w = world(t, false); w.service.tick(); w.service.overview(); w.service.actorPlans();
  assert.equal(w.link.sql.get('SELECT COUNT(*) n FROM city_citizens').n, 0);
  assert.equal(w.link.sql.get('SELECT COUNT(*) n FROM city_clock').n, 0);
  assert.equal(w.commands().length, 0);
});

test('new adults issue strictly bounded city actor plans once and survive restart', t => {
  const w = world(t); w.service.tick();
  assert.equal(w.service.overview().citizens.length, 8);
  assert.ok(w.service.overview().citizens.every(c => c.stage === 'adult'));
  assert.equal(w.pending().length, 8);
  for (const command of w.outbox()) {
    const args = JSON.parse(command.args);
    assert.equal(command.kind, 'city_actor'); assert.equal(command.player_uuid, NODE_PRINCIPAL);
    assert.deepEqual(Object.keys(args).sort(), ['activity','id','name','revision','stage','target']);
    assert.match(args.id, /^city-[a-z0-9-]{1,32}$/); assert.match(args.target, /^city-/);
  }
  w.service.tick(); w.restart(); w.service.tick();
  assert.equal(w.commands().length, 8);
  assert.equal(w.service.overview().marriages.length, 0);
});

test('arrival cannot complete construction; missing, corrupt and unrelated records cannot build a home', t => {
  const w = world(t); w.service.tick();
  const build = w.pending().find(j => j.activity === 'build'); assert.ok(build);
  w.ack(build); w.service.tick();
  assert.equal(w.link.sql.get('SELECT state FROM city_jobs WHERE id=?', build.id).state, 'arrived');
  w.built('guest-cottage'); w.advance(); w.service.tick();
  assert.equal(w.service.overview().births.length, 0);
  writeFileSync(w.recordPath, '{broken'); w.service.tick();
  assert.equal(w.link.sql.get('SELECT state FROM city_jobs WHERE id=?', build.id).state, 'arrived');
  w.built(build.expected_group); w.service.tick();
  assert.equal(w.link.sql.get('SELECT state FROM city_jobs WHERE id=?', build.id).state, 'completed');
});

test('farm and office outputs require applied visits and are separate durable simulation records', t => {
  const w = world(t); w.built('city-test-public-stage'); w.built('city-farm-complete'); w.built('city-office-complete'); w.service.tick();
  assert.equal(w.service.overview().harvests.length, 0);
  const farm = w.pending().find(j => j.activity === 'farm'), office = w.pending().find(j => j.activity === 'office');
  w.ack(farm, 'command.applied', '11111111-1111-4111-8111-111111111111'); w.service.tick();
  assert.equal(w.service.overview().harvests.length, 0);
  w.ack(farm); w.ack(office); w.service.tick(); w.restart(); w.service.tick();
  assert.equal(w.service.overview().harvests.length, 1);
  assert.equal(w.service.overview().harvests[0].kind, 'virtual-city-harvest');
  const reports = w.service.overview().reports; assert.equal(reports.length, 1);
  assert.ok(JSON.parse(reports[0].sources).some(s => s.ref === 'city-test-public-stage'));
  assert.match(reports[0].label, /scripted city report/i);
});

test('rejected visits produce no outputs; uncertain expired visits never count as attendance', t => {
  const w = world(t); w.built('city-farm-complete'); w.service.tick(); const farm = w.pending().find(j => j.activity === 'farm');
  w.ack(farm, 'command.rejected'); w.service.tick();
  assert.equal(w.link.sql.get('SELECT state FROM city_jobs WHERE id=?', farm.id).state, 'rejected');
  w.offline(200_000); w.service.tick();
  assert.equal(w.service.overview().harvests.length, 0);
  assert.equal(w.service.overview().attendance.length, 0);
});

test('marriage requires both preapproved adult visits; child requires an actually completed city home', t => {
  const w = world(t); w.service.tick();
  const social = w.pending().filter(j => j.activity === 'social' && j.household_id === 'city-household-4'); assert.equal(social.length, 2);
  w.ack(social[0]); w.service.tick(); assert.equal(w.service.overview().marriages.length, 0);
  w.ack(social[1]); w.service.tick(); assert.equal(w.service.overview().marriages.length, 1);
  assert.equal(w.service.overview().births.length, 0);
  const household = w.service.overview().households.find(h => h.id === social[0].household_id);
  w.built(household.home_group); w.service.tick();
  assert.equal(w.service.overview().births.length, 1);
  w.restart(); w.service.tick(); assert.equal(w.service.overview().births.length, 1);
  assert.equal(w.service.overview().citizens.filter(c => c.stage === 'child').length, 1);
  assert.equal(w.service.overview().citizens.length, 9);
});

test('children age only with open native simulation time and need assessed school work to advance', t => {
  const w = world(t); w.service.tick();
  for (const j of w.pending().filter(j => j.activity === 'social' && j.household_id === 'city-household-4')) w.ack(j);
  w.service.tick(); const married = w.service.overview().marriages[0];
  w.built('city-school-complete'); w.built('city-university-complete');
  w.built(w.service.overview().households.find(h => h.id === married.household_id).home_group); w.service.tick();
  const child = w.service.overview().citizens.find(c => c.stage === 'child');
  w.offline(86_400_000); w.restart(); w.service.tick();
  assert.equal(w.service.overview().citizens.find(c => c.id === child.id).stage, 'child');
  for (let n = 0; n < 20; n++) { w.advance(); w.service.tick(); }
  assert.equal(w.service.overview().citizens.find(c => c.id === child.id).stage, 'student');
  for (let visit = 0; visit < 3; visit++) {
    // An earlier home command must finish before a new school plan can be issued.
    for (const j of w.pending().filter(j => j.citizen_id === child.id)) w.ack(j);
    w.service.tick(); w.advance(); w.service.tick();
  }
  for (let n = 0; n < 2; n++) { for (const j of w.pending().filter(j => j.citizen_id === child.id)) w.ack(j); w.service.tick(); w.advance(); w.service.tick(); }
  const overview = w.service.overview();
  assert.ok(overview.attendance.filter(a => a.citizen_id === child.id).length >= 3);
  assert.ok(overview.assessments.filter(a => a.citizen_id === child.id && a.passed).length >= 3);
  assert.ok(['apprentice', 'adult'].includes(overview.citizens.find(c => c.id === child.id).stage));
  assert.equal(w.link.sql.get('SELECT COUNT(*) n FROM city_births WHERE household_id=?', married.household_id).n, 1);
});

test('builders share the earliest unfinished manifest stage site and stay until actual completion', t => {
  const directory = mkdtempSync(join(tmpdir(), 'city-manifest-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, 'city.json');
  writeFileSync(manifestPath, JSON.stringify({ groups: [
    { id: 'city-office-foundation', site: 'site-city-office', crew: 2, release_after_minutes: 1 },
    { id: 'city-home-1-foundation', site: 'site-city-home-1', crew: 2, release_after_minutes: 2 },
  ] }));
  const w = world(t, true, { manifestPath }); w.service.tick();
  const builders = w.pending().filter(j => j.activity === 'build'); assert.equal(builders.length, 2);
  assert.ok(builders.every(j => j.target === 'city-office' && j.expected_group === 'city-office-foundation'));
  for (const j of builders) w.ack(j); w.service.tick();
  w.advance(); w.service.tick(); assert.equal(w.commands().length, 8);
  w.built('city-office-foundation'); w.service.tick(); w.advance(); w.service.tick();
  assert.ok(w.pending().filter(j => j.activity === 'build').every(j => j.target === 'city-home-1'));
});

test('durable command correlation recovers a crash after issuing but before storing job cmd_id', t => {
  const w = world(t); w.service.tick(); const job = w.pending()[0];
  w.link.sql.run("UPDATE city_jobs SET state='intent',cmd_id=NULL WHERE id=?", job.id);
  w.restart(); w.service.tick();
  assert.equal(w.commands().length, 8);
  assert.equal(w.link.sql.get('SELECT cmd_id FROM city_jobs WHERE id=?', job.id).cmd_id, job.cmd_id);
});

test('paused city does not seed, age, process acknowledgements or issue commands', t => {
  let paused = true;
  const w = world(t, true, { platform: { get: () => ({ value: String(paused) }) } });
  w.service.tick(); assert.equal(w.service.overview().citizens.length, 0);
  w.built('city-farm-complete');
  paused = false; w.service.tick(); const farm = w.pending().find(j => j.activity === 'farm');
  paused = true; w.ack(farm); w.advance(600_000); w.service.tick();
  assert.equal(w.service.overview().harvests.length, 0);
  paused = false; w.service.tick();
  assert.equal(w.service.overview().simulation_ms, 0);
  assert.equal(w.service.overview().harvests.length, 1);
});

test('attendance without a saved native school cannot pass an exercise or grant competence', t => {
  const w = world(t); w.service.tick();
  for (const j of w.pending().filter(j => j.activity === 'social' && j.household_id === 'city-household-4')) w.ack(j);
  w.service.tick(); const household = w.service.overview().marriages[0].household_id;
  w.built(w.service.overview().households.find(h => h.id === household).home_group); w.service.tick();
  const child = w.service.overview().citizens.find(c => c.stage === 'child');
  for (const j of w.pending().filter(j => j.citizen_id === child.id)) w.ack(j);
  w.service.tick(); for (let n = 0; n < 20; n++) { w.advance(); w.service.tick(); }
  assert.equal(w.pending().find(j => j.citizen_id === child.id).target,
    w.service.overview().households.find(h => h.id === household).home_group.replace(/-complete$/, '-interior'));
  for (const j of w.pending().filter(j => j.citizen_id === child.id)) w.ack(j);
  w.service.tick();
  const assessed = w.service.overview().assessments.filter(a => a.citizen_id === child.id);
  assert.equal(assessed.length, 0);
  assert.equal(w.service.overview().attendance.filter(a => a.citizen_id === child.id).length, 0);
});

test('native assessed university visits and a saved work report are both required for adulthood', t => {
  const w = world(t); w.service.tick();
  for (const j of w.pending().filter(j => j.activity === 'social' && j.household_id === 'city-household-4')) w.ack(j);
  w.service.tick(); const household = w.service.overview().marriages[0].household_id;
  w.built(w.service.overview().households.find(h => h.id === household).home_group);
  w.built('city-school-complete'); w.built('city-university-complete'); w.built('city-office-complete'); w.service.tick();
  const child = w.service.overview().citizens.find(c => c.stage === 'child');
  for (const j of w.pending().filter(j => j.citizen_id === child.id)) w.ack(j);
  w.service.tick(); for (let n = 0; n < 20; n++) { w.advance(); w.service.tick(); }
  for (let i = 0; i < 3; i++) {
    const school = w.pending().find(j => j.citizen_id === child.id); assert.equal(school.target, 'city-school-interior');
    w.ack(school); w.service.tick(); w.advance(); w.service.tick();
  }
  assert.equal(w.service.overview().citizens.find(c => c.id === child.id).stage, 'apprentice');
  for (let i = 0; i < 3; i++) {
    const university = w.pending().find(j => j.citizen_id === child.id); assert.equal(university.target, 'city-university-interior');
    w.ack(university); w.service.tick(); w.advance(); w.service.tick();
  }
  assert.equal(w.service.overview().citizens.find(c => c.id === child.id).stage, 'apprentice');
  const work = w.pending().find(j => j.citizen_id === child.id); assert.equal(work.activity, 'office');
  w.ack(work); w.service.tick();
  assert.equal(w.service.overview().citizens.find(c => c.id === child.id).stage, 'adult');
  assert.equal(w.service.overview().reports.filter(r => r.citizen_id === child.id).length, 1);
});

test('child home arrival is not repeated while waiting to become a student', t => {
  const w = world(t); w.service.tick();
  for (const j of w.pending().filter(j => j.activity === 'social' && j.household_id === 'city-household-4')) w.ack(j);
  w.service.tick(); const household = w.service.overview().marriages[0].household_id;
  w.built(w.service.overview().households.find(h => h.id === household).home_group); w.service.tick();
  const child = w.service.overview().citizens.find(c => c.stage === 'child');
  w.ack(w.pending().find(j => j.citizen_id === child.id)); w.service.tick();
  w.advance(); w.service.tick();
  assert.equal(w.link.sql.get('SELECT COUNT(*) n FROM city_jobs WHERE citizen_id=?', child.id).n, 1);
});

test('both operators policy participation is checked before marriage and births', t => {
  const w = world(t); w.service.tick();
  const social = w.pending().filter(j => j.activity === 'social' && j.household_id === 'city-household-4');
  const home = social[0].household_id;
  w.link.sql.run('UPDATE city_citizens SET participation=0 WHERE id=?', social[1].citizen_id);
  for (const j of social) w.ack(j); w.service.tick();
  assert.equal(w.service.overview().marriages.length, 0);
  w.link.sql.run('UPDATE city_citizens SET participation=1 WHERE id=?', social[1].citizen_id);
  w.link.sql.run("UPDATE city_households SET policy='not-approved' WHERE id=?", home);
  w.service.tick(); assert.equal(w.service.overview().marriages.length, 0);
});

test('all founding households remain bounded to one child and do not call platform mutation APIs', t => {
  let mutationCount = 0;
  const w = world(t, true, { platform: { get: () => null, transaction: () => mutationCount++, createAgent: () => mutationCount++ } });
  const manifest = JSON.parse(readFileSync(new URL('../content/veloren-ai-city.json', import.meta.url), 'utf8'));
  for (const group of manifest.groups) w.built(group.id);
  w.service.tick();
  for (let round = 0; round < 7; round++) w.completeRound();
  assert.equal(w.service.overview().births.length, 4);
  assert.equal(w.service.overview().citizens.length, 12);
  assert.equal(mutationCount, 0);
  assert.equal(w.link.sql.get('SELECT MAX(n) n FROM (SELECT COUNT(*) n FROM city_births GROUP BY household_id)').n, 1);
  assert.equal(w.link.sql.get("SELECT MAX(n) n FROM (SELECT COUNT(*) n FROM city_jobs WHERE state IN ('intent','issued','arrived','unknown') GROUP BY citizen_id)").n, 1);
});

test('unbuilt offices and farms send adults to the park, then built interiors need fresh arrivals', t => {
  const w = world(t); w.service.tick();
  assert.equal(w.pending().filter(j => ['office','farm','school'].includes(j.activity)).length, 0);
  assert.ok(w.pending().filter(j => j.activity !== 'build').every(j => j.target === 'city-park'));
  w.built('city-farm-complete'); w.built('city-office-complete');
  // Clear the fallback social and scheduled social/home cycles before the next career visit.
  for (let round = 0; round < 3; round++) w.completeRound();
  const farm = w.pending().find(j => j.activity === 'farm'), office = w.pending().find(j => j.activity === 'office');
  assert.equal(farm.target, 'city-farm-interior'); assert.equal(office.target, 'city-office-interior');
  assert.equal(w.service.overview().harvests.length, 0); assert.equal(w.service.overview().reports.length, 0);
  w.ack(farm); w.ack(office); w.service.tick();
  assert.equal(w.service.overview().harvests.length, 1); assert.equal(w.service.overview().reports.length, 1);
});

test('a wrong-format native record or incomplete group shape cannot verify construction', t => {
  const w = world(t); w.service.tick(); const build = w.pending().find(j => j.activity === 'build');
  w.ack(build); w.service.tick();
  w.built(build.expected_group); const record = JSON.parse(readFileSync(w.recordPath, 'utf8'));
  record.format = 'wrong'; writeFileSync(w.recordPath, JSON.stringify(record));
  w.service.tick(); assert.equal(w.link.sql.get('SELECT state FROM city_jobs WHERE id=?', build.id).state, 'arrived');
  record.format = 'veloren-world-applied-v1'; record.groups[build.expected_group] = { applied_at: 1_760_000_000_000 };
  writeFileSync(w.recordPath, JSON.stringify(record));
  w.service.tick(); assert.equal(w.link.sql.get('SELECT state FROM city_jobs WHERE id=?', build.id).state, 'arrived');
});

test('inherited legacy elapsed time, record jumps and disabled intervals never replay city age', t => {
  const w = world(t); w.advance(18_000_000); w.service.tick();
  assert.equal(w.service.overview().simulation_ms, 0);
  w.advance(); w.service.tick(); assert.equal(w.service.overview().simulation_ms, 30_000);
  w.advance(86_400_000); w.service.tick(); assert.ok(w.service.overview().simulation_ms <= 90_000);
  w.service.enabled = false; w.advance(); w.service.tick();
  const before = w.service.overview().simulation_ms;
  w.advance(600_000); w.service.enabled = true; w.service.tick();
  assert.equal(w.service.overview().simulation_ms, before);
});

test('public construction overview counts only applied city stages and reads never seed', t => {
  const w = world(t, false);
  const manifest = JSON.parse(readFileSync(new URL('../content/veloren-ai-city.json', import.meta.url), 'utf8'));
  const office = manifest.groups.filter(g => g.project === 'city-office');
  assert.equal(office.length, 3);
  w.built(office[0].id);
  const record = JSON.parse(readFileSync(w.recordPath, 'utf8'));
  record.waiting = { [office[1].id]: 'needs a crew: 0 of 2' };
  writeFileSync(w.recordPath, JSON.stringify(record));
  const projects = w.service.overview().construction;
  const status = projects.find(p => p.id === 'city-office');
  assert.equal(status.done, 1); assert.equal(status.total, 3); assert.equal(status.complete, false);
  assert.equal(status.next.waiting, 'needs a crew: 0 of 2');
  assert.ok(status.name); assert.ok(status.purpose);
  assert.equal(JSON.stringify(projects).includes(w.recordPath), false);
  assert.equal(w.link.sql.get('SELECT COUNT(*) n FROM city_citizens').n, 0);
  for (const group of office) w.built(group.id);
  assert.equal(w.service.overview().construction.find(p => p.id === 'city-office').complete, true);
});

test('missing native records show unavailable construction with zero verified stages', t => {
  const w = world(t, false); writeFileSync(w.recordPath, '{bad');
  const projects = w.service.overview().construction;
  assert.ok(projects.length > 0);
  assert.ok(projects.every(p => p.done === 0 && !p.complete && p.next.waiting === 'native record unavailable'));
});

test('adult and child home plans use their own completed household interior', t => {
  const w = world(t); w.service.tick();
  const social = w.pending().filter(j => j.activity === 'social' && j.household_id === 'city-household-4');
  for (const j of social) w.ack(j); w.service.tick();
  const household = w.service.overview().households.find(h => h.id === social[0].household_id);
  const target = household.home_group.replace(/-complete$/, '-interior');
  w.built(household.home_group); w.service.tick();
  const child = w.service.overview().citizens.find(c => c.stage === 'child');
  assert.equal(w.pending().find(j => j.citizen_id === child.id).target, target);
  // The adults finish their second social visit, then their schedule calls for home.
  w.advance(); w.service.tick();
  for (const j of w.pending().filter(j => social.some(s => s.citizen_id === j.citizen_id))) w.ack(j);
  w.service.tick(); w.advance(); w.service.tick();
  const homeJobs = w.pending().filter(j => j.activity === 'home' && social.some(s => s.citizen_id === j.citizen_id));
  assert.equal(homeJobs.length, 2); assert.ok(homeJobs.every(j => j.target === target));
});

test('unrecognized household home groups cannot become arbitrary native home targets', t => {
  const w = world(t); w.service.tick();
  const social = w.pending().filter(j => j.activity === 'social' && j.household_id === 'city-household-4');
  const household = social[0].household_id;
  w.link.sql.run("UPDATE city_households SET home_group='city-unknown-admin-complete' WHERE id=?", household);
  for (const j of social) w.ack(j); w.service.tick(); w.advance(); w.service.tick();
  for (const j of w.pending().filter(j => social.some(s => s.citizen_id === j.citizen_id))) w.ack(j);
  w.service.tick(); w.advance(); w.service.tick();
  const homeJobs = w.pending().filter(j => j.activity === 'home' && social.some(s => s.citizen_id === j.citizen_id));
  assert.equal(homeJobs.length, 0);
  assert.ok(w.service.actorPlans().every(p => p.target !== 'city-unknown-admin'));
});

test('legacy exterior work arrivals cannot produce interior work outputs', t => {
  const w = world(t); w.built('city-office-complete'); w.service.tick();
  const office = w.pending().find(j => j.activity === 'office');
  // Recreate a pre-interior job persisted by the earlier city service.
  w.link.sql.run("UPDATE city_jobs SET target='city-office' WHERE id=?", office.id);
  w.ack(office); w.service.tick();
  assert.equal(w.service.overview().reports.length, 0);
  assert.equal(w.link.sql.get('SELECT state,error FROM city_jobs WHERE id=?', office.id).error, 'interior visit required');
});

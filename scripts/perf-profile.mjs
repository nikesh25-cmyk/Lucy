#!/usr/bin/env node
/**
 * NemoWorld source-level cost profile.
 *
 * Measures the *server-side source-level* cost of the reads a resident client makes, on a temporary
 * database, with no network and no browser. It is the measurement half of task 14: it exists so a
 * change to a query is backed by a before/after number rather than an opinion.
 *
 * It measures stored-record behaviour, not concurrent clients. A 10,000-record fixture says nothing
 * about simultaneous users; `scripts/load-harness.mjs` measures that separately, with explicit limits.
 *
 * Every figure is a median of RUNS timed calls after warm-up, on one process, one SQLite connection.
 * Query plans, not just wall-clock, are printed for the reads whose shape changed, because a plan is
 * machine-independent evidence of whether a read is bounded.
 *
 *   node scripts/perf-profile.mjs [--runs N] [--json path]
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Platform } from '../src/platform.js';
import { getWorldDefinition } from '../world.js';
import { createVoxelScene } from '../src/voxel-world.js';

const PASSWORD = 'performance-profile-password-2026';
const STORED_AGENTS = 10_000;      // synthetic agents added on top of the fixture's own two residents
const STORED_VISITS = 2_000;       // per-resident journey visits: an unbounded history if it ever is
const STORED_CLAIMS = 2_000;       // historic claims for one operator: an unbounded per-resident history
const GUILD_PARTICIPANTS = 100;    // the guild module's own participant ceiling
const GUILD_CONTRIBUTIONS = 200;   // the guild module's own contribution ceiling per project
const participants_warning = 'stored-record fixture; not a concurrent-user measurement';

const args = process.argv.slice(2);
const runsIndex = args.indexOf('--runs');
const RUNS = runsIndex === -1 ? 9 : Math.max(1, Number.parseInt(args[runsIndex + 1] ?? '9', 10) || 9);
const jsonIndex = args.indexOf('--json');
const JSON_PATH = jsonIndex === -1 ? null : args[jsonIndex + 1];

const pad = (value, width) => String(value).padEnd(width);
const num = (value, width = 12) => String(value).padStart(width);
const ms = (value) => `${value.toFixed(2)} ms`;
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const percentile = (values, fraction) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
};
/** Median wall-clock of one operation, after one untimed call so lazy code paths are not charged to it. */
const timed = (operation, runs = RUNS) => {
  operation();
  const samples = [];
  for (let index = 0; index < runs; index++) {
    const start = performance.now();
    operation();
    samples.push(performance.now() - start);
  }
  return { median: median(samples), p50: median(samples), p95: percentile(samples, 0.95), runs };
};
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value));

const report = { generated_at: new Date().toISOString(), node: process.version, runs: RUNS, fixture: {}, measurements: [], query_plans: [], geometry: {}, notes: [participants_warning] };

function line(title, value, suffix = '') {
  console.log(`  ${pad(title, 46)}${num(value)} ${suffix}`);
}
function record(name, measured, bytes, detail = {}) {
  report.measurements.push({ name, median_ms: Number(measured.median.toFixed(3)), p95_ms: Number(measured.p95.toFixed(3)), runs: measured.runs, payload_bytes: bytes, ...detail });
  line(name, ms(measured.median), `p95 ${ms(measured.p95)}  payload ${kb(bytes)}`);
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'nemoworld-perf-'));
  const database = join(directory, 'profile.sqlite');
  let clock = Date.parse('2026-10-13T09:00:00.000Z');
  const platform = new Platform(database, () => clock);
  const credentials = {};
  try {
    credentials.admin = await platform.register({ name: 'Profile admin', email: 'admin@profile.test', password: PASSWORD, consent: true });
    const actor = (name) => platform.authenticate(credentials[name].token);
    const tx = (method, ...rest) => platform.transaction(() => platform[method](...rest));
    for (const [name, role] of [['alice', 'member'], ['bob', 'member'], ['reviewer', 'reviewer']]) {
      const invite = tx('invite', actor('admin'), { role });
      credentials[name] = await platform.register({ name, email: `${name}@profile.test`, password: PASSWORD, consent: true, invite: invite.code });
    }
    const alice = tx('createAgent', actor('alice'), { name: 'Alice resident', color: '#397f79', symbol: '✦' });
    const bob = tx('createAgent', actor('bob'), { name: 'Bob resident', color: '#397f79', symbol: '✦' });

    // ---- The stored-record fixture: 10,000 synthetic agents and a home each (the world/platform fixture)
    const ownerId = actor('bob').account.id;
    const position = platform.get('SELECT x,y FROM agents WHERE id=?', alice.id);
    const stamp = new Date(clock).toISOString();
    const synthetic = [];
    platform.transaction(() => {
      const insert = platform.db.prepare("INSERT INTO agents(id,operator_id,name,color,symbol,capabilities,limitations,x,y,world_id,last_seen,created_at) VALUES(?,?,?,'#397f79','✦','','',?,?,'commons',?,?)");
      const insertHome = platform.db.prepare("INSERT INTO worlds(id,name,kind,owner_agent_id,visibility,width,height,created_at) VALUES(?,?,'home',?,'public',32,24,?)");
      for (let index = 0; index < STORED_AGENTS; index++) {
        const id = randomUUID();
        insert.run(id, ownerId, `Load fixture ${index}`, position.x, position.y, clock, stamp);
        insertHome.run(`home:${id}`, `Load garden ${index}`, id, stamp);
        synthetic.push(id);
      }
    });
    // A resident who has discovered many places, and an operator with a long historic claim list:
    // both are per-resident histories whose cost the reads below are supposed to bound.
    platform.transaction(() => {
      const insertWorld = platform.db.prepare("INSERT INTO worlds(id,name,kind,owner_agent_id,visibility,width,height,created_at) VALUES(?,?,'home',?,'public',32,24,?)");
      const insertVisit = platform.db.prepare('INSERT OR IGNORE INTO journey_visits(agent_id,world_id,visited_at) VALUES(?,?,?)');
      for (let index = 0; index < STORED_VISITS; index++) {
        const worldId = `home:visited-${index}`;
        insertWorld.run(worldId, `Visited garden ${index}`, synthetic[index % synthetic.length], stamp);
        insertVisit.run(alice.id, worldId, clock + index);
      }
      const task = platform.get("SELECT id FROM tasks WHERE mission_id='climate'");
      const insertClaim = platform.db.prepare("INSERT INTO claims VALUES(?,?,1,?,?, 'released',?,?,?)");
      for (let index = 0; index < STORED_CLAIMS; index++) {
        insertClaim.run(randomUUID(), task.id, actor('alice').account.id, index % 2 ? alice.id : bob.id, clock, `profile-claim-${index}`, new Date(clock - index * 1000).toISOString());
      }
    });

    report.fixture = {
      stored_agents: STORED_AGENTS + 2,
      stored_homes: STORED_AGENTS + 2 + STORED_VISITS,
      stored_journey_visits: STORED_VISITS,
      stored_claims: STORED_CLAIMS,
      guild_participants: GUILD_PARTICIPANTS,
      guild_contributions: GUILD_CONTRIBUTIONS,
      schema_version: platform.get('PRAGMA user_version').user_version,
    };

    console.log(`NemoWorld source-level cost profile · Node ${process.version} · schema ${report.fixture.schema_version}`);
    console.log(`fixture: ${report.fixture.stored_agents} agents, ${report.fixture.stored_homes} homes, ${STORED_VISITS} visits, ${STORED_CLAIMS} claims · median of ${RUNS} calls`);
    console.log('');
    console.log('WORLD / VIEWPORT READS');

    const crowded = () => platform.world(actor('alice'), { world_id: 'commons', x: position.x, y: position.y });
    const view = crowded();
    record('GET /world crowded (200 avatars)', timed(crowded), bytesOf(view), { avatars: (view.agents || view.participants).length });
    const empty = () => platform.world(actor('alice'), { world_id: 'commons', x: 80, y: 50 });
    const emptyView = empty();
    record('GET /world empty window (fixed overhead)', timed(empty), bytesOf(emptyView), { avatars: (emptyView.agents || emptyView.participants).length });
    const directory = () => platform.worldList(actor('alice'), { offset: 0, limit: 2 });
    record('GET /worlds directory page', timed(directory), bytesOf(directory()));
    const passport = () => platform.journey(actor('alice'), { agent_id: alice.id });
    record('GET /journey (2,000 visits)', timed(passport), bytesOf(passport()));
    const gallery = () => platform.gallery();
    record('GET /gallery', timed(gallery), bytesOf(gallery()));

    console.log('');
    console.log('PER-RESIDENT HISTORY READS');
    const history = () => platform.history(actor('alice'));
    const ownHistory = history();
    record('GET /history (2,000 claims)', timed(history), bytesOf(ownHistory), { stored_claims: STORED_CLAIMS, claims_returned: ownHistory.claims.length });
    record('GET /history as reviewer/admin', timed(() => platform.history(actor('reviewer'))), bytesOf(platform.history(actor('reviewer'))));

    console.log('');
    console.log('GUILD READS');
    const plan = [{ id: 'research', title: 'Research', output_name: 'A register', scope: 'Read one source' }];
    const project = tx('guildProjectCreate', actor('alice'), { agent_id: alice.id, guild_id: 'researcher', title: 'Profile project', summary: 'Measure the board read.', plan });
    platform.transaction(() => {
      const participant = platform.db.prepare('INSERT INTO guild_participants VALUES(?,?,?,?,?,?)');
      const contribution = platform.db.prepare('INSERT INTO guild_contributions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const created = new Date(clock).toISOString();
      for (let index = 0; index < GUILD_PARTICIPANTS; index++) participant.run(project.id, synthetic[index], 'member', 'active', created, created);
      for (let index = 0; index < GUILD_CONTRIBUTIONS; index++) {
        contribution.run(randomUUID(), project.id, 'research', synthetic[index % synthetic.length], ownerId, `Commitment ${index}`, index % 3 ? '' : 'Evidence text', '[]', index % 3 ? 'pledged' : 'submitted', '', index % 3 ? null : created, null, null, null, created, created);
      }
    });
    record('GET /guilds (board page)', timed(() => platform.guilds(actor('alice'), { limit: 12 })), bytesOf(platform.guilds(actor('alice'), { limit: 12 })));
    const projectView = () => platform.guildProject(actor('alice'), { id: project.id, agent_id: alice.id });
    record('GET /guilds/project (100 participants)', timed(projectView), bytesOf(projectView()), { participants: GUILD_PARTICIPANTS, contributions: GUILD_CONTRIBUTIONS });

    console.log('');
    console.log('QUERY PLANS (bounded reads only, from the same database)');
    for (const [name, sql, params] of [
      ['history submissions', 'SELECT s.id FROM submissions s JOIN claims c ON c.id=s.claim_id JOIN tasks t ON t.id=c.task_id JOIN missions m ON m.id=t.mission_id WHERE c.account_id=? ORDER BY s.created_at DESC,s.rowid DESC LIMIT 200', [actor('alice').account.id]],
      ['history claims', 'SELECT c.id FROM claims c JOIN tasks t ON t.id=c.task_id WHERE c.account_id=? ORDER BY c.created_at DESC,c.rowid DESC LIMIT 200', [actor('alice').account.id]],
      ['journey visits', 'SELECT v.world_id FROM journey_visits v JOIN worlds w ON w.id=v.world_id WHERE v.agent_id=? ORDER BY v.visited_at,v.world_id LIMIT 200', [alice.id]],
      ['world viewport agents', "SELECT a.id FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.world_id=? AND a.x>=? AND a.x<? AND a.y>=? AND a.y<? AND a.status!='deleted' AND o.status='active' LIMIT 200", ['commons', position.x - 10, position.x + 10, position.y - 7, position.y + 7]],
    ]) {
      const plan = platform.all(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((row) => row.detail).join(' | ');
      report.query_plans.push({ name, plan });
      console.log(`  ${pad(name, 46)}${plan}`);
    }

    console.log('');
    console.log('RENDERER GEOMETRY REUSE (createVoxelScene, no GPU)');
    const world = getWorldDefinition('commons');
    const roster = Array.from({ length: 60 }, (_, index) => ({
      id: `avatar-${index}`, name: `Avatar ${index}`, kind: index % 7 === 0 ? 'npc' : 'human',
      x: 6 + index % 12, y: 6 + Math.floor(index / 12) * 3, z: 0, color: ['#397f79', '#cb725f'][index % 2], posture: 'standing', status: 'active',
      last_seen: '2026-10-13T09:00:00Z', accepted_contributions: index,
      calling: { id: 'researcher', name: 'Researcher', rank: { level: 1, title: 'Reader' }, current_objective: { id: 'read', title: 'Read one source', complete: false } },
    }));
    const scene = createVoxelScene();
    const options = { position: world.start, self: roster[0] };
    const groupOf = (name) => scene.root.getObjectByName(name);
    const meshesOf = (name) => [...(groupOf(name)?.children || [])];
    scene.update(world, { participants: roster }, options);
    const terrainMeshes = meshesOf('voxel-terrain'), characterMeshes = meshesOf('voxel-characters');
    let disposed = 0;
    for (const mesh of crowd(scene)) mesh.addEventListener('dispose', () => disposed++);
    // A roster poll: presence and last_seen move, nothing visible does. Rebuilt batches must stay 0.
    for (let index = 0; index < 20; index++) {
      const rotated = [...roster.slice(index % roster.length), ...roster.slice(0, index % roster.length)];
      rotated[0].last_seen = `2026-10-13T09:0${index % 10}:00Z`;
      rotated[0].presence = index % 2 ? 'connected' : 'offline';
      scene.update(world, { participants: rotated }, options);
    }
    const rosterRebuilt = groupOf('voxel-terrain') !== undefined && !sameMeshes(groupOf('voxel-terrain'), terrainMeshes) ? 1 : 0;
    const rosterCharactersRebuilt = !sameMeshes(groupOf('voxel-characters'), characterMeshes) ? 1 : 0;
    // An objective refresh: the server sends an advanced rank and a completed objective, same positions.
    for (let index = 0; index < 20; index++) {
      const advanced = roster.map((item, order) => order === 0
        ? { ...item, calling: { ...item.calling, rank: { level: 1 + (index % 3), title: `Reader ${index}` }, current_objective: { id: 'read', title: 'Read one source', complete: index % 2 === 0 } } }
        : item);
      scene.update(world, { participants: advanced }, options);
    }
    const objectiveRebuilt = !sameMeshes(groupOf('voxel-characters'), characterMeshes) ? 1 : 0;
    report.geometry = { roster_polls: 20, roster_character_rebuilds: rosterCharactersRebuilt, roster_terrain_rebuilds: rosterRebuilt, objective_polls: 20, objective_character_rebuilds: objectiveRebuilt, disposed_batches: disposed, participants: 60 };
    line('roster polls: character rebuilds / 20', rosterCharactersRebuilt);
    line('roster polls: terrain rebuilds / 20', rosterRebuilt);
    line('objective polls: character rebuilds / 20', objectiveRebuilt);
    line('disposed batches across 40 polls', disposed);
    scene.destroy();

    console.log('');
    console.log(`NOTE  ${participants_warning}. Latency above is one process on one SQLite connection.`);
    if (JSON_PATH) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`      wrote ${JSON_PATH}`);
    }
  } finally {
    platform.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function crowd(scene) { return scene.root.getObjectByName('voxel-characters')?.children || []; }
const sameMeshes = (group, meshes) => Boolean(group) && group.children.length === meshes.length && meshes.every((mesh, index) => group.children[index] === mesh);

await main();

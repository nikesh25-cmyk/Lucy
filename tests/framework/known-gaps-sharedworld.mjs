#!/usr/bin/env node
/**
 * Reproducible defects found while delivering the Wave 2 shared-world slice, in files this slice may
 * not edit. This file is deliberately **not** named `*.test.js` and does not live under a `test/`
 * directory, so `node --test` (and therefore `npm test`) never discovers it: the shipped suite stays
 * green while each defect stays reproducible here.
 *
 * Run it with:
 *
 *     export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
 *     node tests/framework/known-gaps-sharedworld.mjs
 *
 * Exit status is 1 when at least one case still REPRODUCES and 0 when every case is FIXED (so a fix
 * shows up as a green run, and the case can then be deleted). Each case prints its command, the
 * invariant it violates, what was actually observed, the file that owns the defect, and a patch
 * proposal. It uses a disposable database under the system temp directory and removes it, even on
 * failure. Nothing here opens an installed world.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Platform } from '../../src/platform.js';
import { getWorldDefinition } from '../../world.js';
import { toGlobal } from '../../src/global-map.js';

const PASSWORD = 'known-gaps-password-2026';
const SCRIPT = 'node tests/framework/known-gaps-sharedworld.mjs';

/** One disposable world, one member account with one resident, and the helper the cases use. */
async function withFixture(action) {
  const directory = await mkdtemp(join(tmpdir(), 'nemoworld-known-gaps-'));
  let current = Date.now();
  const platform = new Platform(join(directory, 'platform.sqlite'), () => current);
  const actor = (token) => platform.authenticate(token);
  try {
    const admin = await platform.register({ name: 'Gap admin', email: 'admin@gap.test', password: PASSWORD, consent: true });
    const invite = platform.transaction(() => platform.invite(actor(admin.token), { role: 'member' }));
    const alice = await platform.register({ name: 'alice', email: 'alice@gap.test', password: PASSWORD, consent: true, invite: invite.code });
    const resident = platform.transaction(() => platform.createAgent(actor(alice.token), { name: 'alice resident', kind: 'human' }));
    const place = (agent, world, x, y) => platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1,last_move=0 WHERE id=?', world, x, y, agent.id);
    return await action({ platform, actor, tokens: { alice: alice.token }, resident, place, advance: (ms) => { current += ms; } });
  } finally {
    try { platform.close(); } catch { /* already closed. */ }
    await rm(directory, { recursive: true, force: true });
  }
}

/** Count the statements and the writes a read performs. */
function meter(platform) {
  let statements = 0, writes = 0;
  for (const name of ['all', 'get', 'run']) {
    const original = platform[name].bind(platform);
    platform[name] = (...args) => { statements += 1; if (name === 'run') writes += 1; return original(...args); };
  }
  return () => ({ statements, writes });
}

const CASES = [
  {
    id: 'map-window-drops-the-followed-resident-after-a-seam-crossing',
    invariant: 'the `world?map=core` window a client asks for, anchored on the world it subscribes to, contains the resident that client follows — wherever that resident\'s stored row has since put it.',
    owner: 'src/spaces.js — `mapWindow`: `const here = viewerAgent?.world_id === id ? viewerAgent : { x: camera.x + Math.floor(COLS / 2), y: camera.y + Math.floor(ROWS / 2) }`',
    patch: [
      'Centre the neighbour window on the viewer\'s stored tile projected into the global frame, not on the',
      'anchor world\'s own camera, which falls back to the anchor\'s arrival tile when the viewer is elsewhere:',
      '',
      '-    const rect = mapRect(id), here = viewerAgent?.world_id === id ? viewerAgent : { x: camera.x + Math.floor(COLS / 2), y: camera.y + Math.floor(ROWS / 2) };',
      '-    const centre = toGlobal(id, here.x, here.y);',
      '+    const rect = mapRect(id);',
      '+    const cameraCentre = toGlobal(id, camera.x + Math.floor(COLS / 2), camera.y + Math.floor(ROWS / 2));',
      '+    const centre = viewerAgent ? toGlobal(viewerAgent.world_id, viewerAgent.x, viewerAgent.y) || cameraCentre : cameraCentre;',
    ].join('\n'),
    async run() {
      return withFixture(async ({ platform, actor, tokens, resident, place }) => {
        place(resident, 'commons', 25, 0);
        const viewer = actor(tokens.alice);
        const held = (payload) => payload.participants.some((item) => item.id === resident.id) || payload.map.participants.some((item) => item.id === resident.id);
        const before = platform.world(viewer, { world_id: 'commons', agent_id: resident.id, map: 'core' });
        place(resident, 'district:highlands', 25, 35);
        const after = platform.world(viewer, { world_id: 'commons', agent_id: resident.id, map: 'core' });
        return {
          expected: { followed_resident_in_payload: true, before: true, after: true },
          observed: { before: held(before), after: held(after), map_regions_after: after.map.worlds.map((item) => item.world_id) },
        };
      });
    },
  },
  {
    id: 'interaction-view-reports-a-distance-across-two-regions',
    invariant: 'a distance the server reports is either a within-world distance between the viewer and the fixture, or absent. It is never the difference of two different regions\' local coordinates.',
    owner: 'src/spaces.js — `interactionGuidance`: `const present = …; const distance = viewer ? interactionDistance(viewer, fixture) : null;`',
    patch: [
      'Only compute a distance when the fixture and the viewer are in the same stored world, and let the hint',
      'say so otherwise (the `another_world` next step already tells the resident to travel):',
      '',
      '-  const present = Boolean(viewer && viewer.world_id === world.id), distance = viewer ? interactionDistance(viewer, fixture) : null;',
      '+  const present = Boolean(viewer && viewer.world_id === world.id), distance = present ? interactionDistance(viewer, fixture) : null;',
    ].join('\n'),
    async run() {
      return withFixture(async ({ platform, actor, tokens, resident, place }) => {
        place(resident, 'commons', 25, 0);
        const bench = getWorldDefinition('district:highlands').objects.find((item) => item.type === 'bench');
        const read = platform.interactionView(actor(tokens.alice), { agent_id: resident.id, world_id: 'district:highlands', x: bench.x, y: bench.y });
        const here = toGlobal('commons', 25, 0), there = toGlobal('district:highlands', bench.x, bench.y);
        const worldSpace = Math.abs(here.gx - there.gx) + Math.abs(here.gy - there.gy);
        return {
          expected: { distance: null, blocked_by: 'another_world' },
          observed: { distance: read.fixture.distance, blocked_by: read.fixture.blocked_by, world_space_distance: worldSpace, hint: read.fixture.hint },
        };
      });
    },
  },
  {
    id: 'a-read-route-mutates-the-civilian-patrol',
    invariant: '`GET /world` is a read. It is documented as an observation and must not mutate stored rows; on the global map the same call runs once per neighbouring world as well.',
    owner: 'src/civic-engine.js — `mayors` calls `tickMayors`, which runs `UPDATE npc_mayors …`; `src/spaces.js world()` calls `mayors()` for the anchor world and again inside `mapWindow` for every neighbour',
    patch: [
      'Move the patrol tick out of the read: either let the living-world loop own it, or gate it so a read may',
      'only advance a guide whose interval has elapsed without the read committing anything:',
      '',
      '-  mayors(actor,input={}){',
      '-    this.tickMayors();',
      '+  mayors(actor,input={}){',
      '+    if (input.tick !== false) this.tickMayors();',
      'and call `this.mayors(actor,{world_id:id,tick:false})` from `world()` (including the `mapWindow` reads).',
    ].join('\n'),
    async run() {
      return withFixture(async ({ platform, actor, tokens, resident, place, advance }) => {
        place(resident, 'commons', 25, 0);
        advance(60_000);                                  // one patrol interval: the guides are due
        const read = meter(platform);
        platform.world(actor(tokens.alice), { world_id: 'commons', agent_id: resident.id, map: 'core' });
        const counted = read();
        return { expected: { writes: 0 }, observed: { writes: counted.writes, statements: counted.statements } };
      });
    },
  },
];

let reproducing = 0;
for (const entry of CASES) {
  let result = null, error = null;
  try { result = await entry.run(); } catch (failure) { error = failure; }
  const fixed = Boolean(result) && JSON.stringify(result.observed) === JSON.stringify(result.expected);
  if (!fixed) reproducing += 1;
  console.log(`\n${fixed ? 'FIXED      ' : 'REPRODUCES '} ${entry.id}`);
  console.log(`  invariant  ${entry.invariant}`);
  console.log(`  expected   ${JSON.stringify(result?.expected ?? 'the invariant above')}`);
  console.log(`  observed   ${error ? `${error.name}: ${error.message}` : JSON.stringify(result?.observed)}`);
  console.log(`  owner      ${entry.owner}`);
  console.log(`  command    ${SCRIPT}   (case: ${entry.id})`);
  console.log(`  patch      ${entry.patch.split('\n').join('\n             ')}`);
}
console.log(`\n${CASES.length - reproducing} fixed, ${reproducing} reproducing  —  this file is not run by \`npm test\` (${join(dirname(fileURLToPath(import.meta.url)), 'known-gaps-sharedworld.mjs')})`);
process.exitCode = reproducing ? 1 : 0;

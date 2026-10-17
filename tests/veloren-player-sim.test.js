import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORLD_LANDMARKS,
  CAREER_OFFICES,
  SCHOOL_CLASSES,
  resolveCoords,
  computeSimsNeeds,
  buildPlayerSim,
} from '../src/veloren-ext/player-sim.js';
import { overviewExtension } from '../src/veloren-ext/overview.js';

const VIOLENT = /\b(kill|kills|killed|fight|fights|attack|attacks|slay|weapon|weapons|enemy|enemies|battle|blood|dungeon|dungeons|loot|raid|war|steal|steals)\b/i;

test('player-sim: peaceful vocabulary check', () => {
  const jsonStr = JSON.stringify({ WORLD_LANDMARKS, CAREER_OFFICES, SCHOOL_CLASSES });
  assert.ok(!VIOLENT.test(jsonStr), 'Found violent vocabulary in player simulation definitions');
});

test('player-sim: landmarks have valid world coordinates', () => {
  assert.ok(Object.keys(WORLD_LANDMARKS).length >= 10);
  for (const [id, lm] of Object.entries(WORLD_LANDMARKS)) {
    assert.ok(typeof lm.name === 'string' && lm.name.length > 0);
    assert.ok(typeof lm.x === 'number' && Number.isFinite(lm.x));
    assert.ok(typeof lm.y === 'number' && Number.isFinite(lm.y));
    assert.ok(['scholarship', 'fellowship', 'craft', 'nourishment', 'comfort', 'career'].includes(lm.category));
  }
});

test('player-sim: resolveCoords returns correct coordinate object', () => {
  const lib = resolveCoords('lyra-house');
  assert.deepEqual(lib, { x: 15225, y: 16007 });

  const fallback = resolveCoords('unknown-target');
  assert.deepEqual(fallback, { x: 15213, y: 15977 });
});

test('player-sim: computeSimsNeeds bounds all 5 needs between 0 and 100', () => {
  const mockLink = {
    clock: () => 1700000000000,
    sql: {
      get: () => ({ n: 3, t: 1699990000000 }),
    },
  };
  const needs = computeSimsNeeds(mockLink, 'test-uuid', mockLink.clock());

  const needKeys = ['nourishment', 'fellowship', 'scholarship', 'craft', 'comfort'];
  for (const key of needKeys) {
    assert.ok(needs[key], `Missing need: ${key}`);
    assert.ok(needs[key].value >= 0 && needs[key].value <= 100);
    assert.ok(typeof needs[key].status === 'string');
    assert.ok(typeof needs[key].hint === 'string');
  }
});

test('player-sim: buildPlayerSim creates comprehensive player state with playable actions', () => {
  const mockLink = {
    clock: () => 1700000000000,
    sql: {
      get: (query) => {
        if (query.includes('ident_links')) return { player_uuid: '00000000-0000-4000-8000-000000000001', alias: 'ScholarRobin' };
        if (query.includes('home_assignments')) return { plot_id: 'cottage-4', style: 'classic' };
        return { n: 2 };
      },
      all: () => [],
    },
  };

  const sim = buildPlayerSim(mockLink, 'ScholarRobin', mockLink.clock());
  assert.equal(sim.player.alias, 'ScholarRobin');
  assert.equal(sim.player.isLinked, true);
  assert.ok(sim.simsNeeds);
  assert.ok(sim.career);
  assert.ok(sim.school);
  assert.ok(sim.home);
  assert.ok(Array.isArray(sim.actions));
  assert.ok(sim.actions.length >= 4);

  for (const action of sim.actions) {
    assert.ok(typeof action.title === 'string');
    assert.ok(typeof action.buttonLabel === 'string');
    assert.ok(typeof action.autoWalkLabel === 'string');
    assert.ok(typeof action.coords.x === 'number');
    assert.ok(typeof action.coords.y === 'number');
    assert.ok(action.chatCommand.startsWith('/tell '));
    assert.ok(!VIOLENT.test(action.title + ' ' + action.description));
  }
});

test('overview extension handles /veloren/harr/player and enriched /veloren/harr/tasks', async () => {
  const mockLink = {
    clock: () => 1700000000000,
    sql: {
      get: () => ({ n: 1 }),
      all: () => [],
      run: () => {},
      tx: (fn) => fn(),
    },
    rateLimiter: new Map(),
  };

  let playerResponse = null;
  const ctxPlayer = {
    route: '/veloren/harr/player',
    request: { method: 'GET', url: '/veloren/harr/player?alias=LyraCitizen' },
    response: {},
    json: (res, code, data) => { playerResponse = { code, data }; },
  };

  const handledPlayer = await overviewExtension.handle(mockLink, ctxPlayer);
  assert.equal(handledPlayer, true);
  assert.equal(playerResponse.code, 200);
  assert.equal(playerResponse.data.player.alias, 'LyraCitizen');
  assert.ok(playerResponse.data.simsNeeds.nourishment);
  assert.ok(playerResponse.data.actions.length > 0);

  let tasksResponse = null;
  const ctxTasks = {
    route: '/veloren/harr/tasks',
    request: { method: 'GET', url: '/veloren/harr/tasks?alias=LyraCitizen' },
    response: {},
    json: (res, code, data) => { tasksResponse = { code, data }; },
  };

  const handledTasks = await overviewExtension.handle(mockLink, ctxTasks);
  assert.equal(handledTasks, true);
  assert.equal(tasksResponse.code, 200);
  assert.ok(tasksResponse.data.tasks);
  assert.ok(tasksResponse.data.lines);
  assert.ok(tasksResponse.data.player_sim);
  assert.equal(tasksResponse.data.player_sim.player.alias, 'LyraCitizen');
});

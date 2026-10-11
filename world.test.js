import { test } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';
import { move, landmarkAt, landmarks, start, terrain, terrainAt, walkable, COLS, ROWS } from './world.js';

test('paths connect every world landmark to the arrival plaza', () => {
  const queue = [start];
  const reached = new Set([`${start.x},${start.y}`]);
  for (let i = 0; i < queue.length; i++) {
    for (const direction of ['up', 'down', 'left', 'right']) {
      const next = move(queue[i], direction);
      const key = `${next.x},${next.y}`;
      if (!reached.has(key)) { reached.add(key); queue.push(next); }
    }
  }
  for (const place of landmarks) {
    ok(walkable(place), `${place.name} has an accessible entrance`);
    ok(reached.has(`${place.x},${place.y}`), `${place.name} is reachable from spawn`);
    strictEqual(landmarkAt(place)?.name, place.name);
  }
  // Every tile advertised as walkable can be reached; no trapped gardens.
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (walkable({ x, y })) ok(reached.has(`${x},${y}`), `Walkable tile ${x},${y} is connected`);
  }
});

test('movement blocks water, trees, buildings, fountain and map edges', () => {
  for (const [position, direction, blocked] of [
    [{ x: 3, y: 1 }, 'left', 'water'],
    [{ x: 5, y: 0 }, 'left', 'tree'],
    [{ x: 15, y: 3 }, 'up', 'building'],
    [{ x: 10, y: 5 }, 'left', 'fountain'],
  ]) {
    const target = { x: position.x + (direction === 'left' ? -1 : 0), y: position.y + (direction === 'up' ? -1 : 0) };
    strictEqual(terrainAt(target), blocked);
    deepStrictEqual(move(position, direction), position);
  }
  deepStrictEqual(move({ x: 19, y: 8 }, 'right'), { x: 19, y: 8 });
  deepStrictEqual(move(start, 'unknown'), start);
  strictEqual(walkable({ x: -1, y: 6 }), false);
  strictEqual(walkable({ x: 1.5, y: 6 }), false);
  strictEqual(terrain.length, ROWS);
  strictEqual(terrain[0].length, COLS);
});

test('walking the original grove route and wooden bridges remains possible', () => {
  let position = start;
  for (let i = 0; i < 6; i++) position = move(position, 'left');
  for (let i = 0; i < 3; i++) position = move(position, 'up');
  strictEqual(landmarkAt(position)?.name, 'Climate Grove');
  deepStrictEqual(move({ x: 7, y: 10 }, 'down'), { x: 7, y: 11 });
  strictEqual(terrainAt({ x: 7, y: 11 }), 'bridge');
});

import { getWorldDefinition, cameraFor, sharedWorldIds, regionFacts, draw, drawMiniMap } from './world.js';

function reachableWorld(world) {
  const reached = new Set([`${world.start.x},${world.start.y}`]);
  const queue = [world.start];
  for (let i = 0; i < queue.length; i++) for (const direction of ['up', 'down', 'left', 'right']) {
    const next = move(queue[i], direction, world);
    const key = `${next.x},${next.y}`;
    if (!reached.has(key)) { reached.add(key); queue.push(next); }
  }
  return reached;
}

test('large outdoors, indoor rooms, and personal gardens have reachable entrances', () => {
  const commons = getWorldDefinition('commons');
  strictEqual(commons.columns, 96);
  strictEqual(commons.rows, 64);
  for (const id of [...sharedWorldIds, 'home:test-character', 'house:test-character']) {
    const world = getWorldDefinition(id);
    const reached = reachableWorld(world);
    ok(walkable(world.start, world), `${id} arrival is walkable`);
    for (const gate of world.portals) ok(reached.has(`${gate.x},${gate.y}`), `${id} portal ${gate.name} reachable`);
    for (const place of world.landmarks) ok(reached.has(`${place.x},${place.y}`), `${id} landmark ${place.name} reachable`);
    for (let y = 0; y < world.rows; y++) for (let x = 0; x < world.columns; x++) {
      if (walkable({ x, y }, world)) ok(reached.has(`${x},${y}`), `${id} tile ${x},${y} connected`);
    }
  }
  deepStrictEqual(cameraFor({ x: 95, y: 63 }, commons), { x: 76, y: 50 });
  deepStrictEqual(cameraFor({ x: 0, y: 0 }, commons), { x: 0, y: 0 });
});

test('world descriptors resolve geometry without requiring terrain in API responses', () => {
  const descriptor = { id: 'home:owner', name: 'Custom garden' };
  const world = getWorldDefinition(descriptor);
  strictEqual(world.name, 'Custom garden');
  strictEqual(world.columns, 32);
  strictEqual(world.rows, 24);
  strictEqual(walkable(world.start, descriptor), true);
  deepStrictEqual(move({ x: 1, y: 1 }, 'left', 'hall'), { x: 1, y: 1 });
});

test('personal cottage portals connect the garden and furnished house', () => {
  const garden = getWorldDefinition('home:owner');
  const house = getWorldDefinition('house:owner');
  strictEqual(garden.portals.find((gate) => gate.x === 6 && gate.y === 6).targetWorldId, 'house:owner');
  strictEqual(house.portals[0].targetWorldId, 'home:owner');
  strictEqual(house.columns, 20);
  strictEqual(house.rows, 14);
  ok(house.objects.some((object) => object.type === 'bed'));
  ok(house.objects.some((object) => object.type === 'kitchen'));
});


test('new scenic regions retain reachable outdoor doorways and deterministic terrain', () => {
  const commons = getWorldDefinition('commons');
  strictEqual(sharedWorldIds.length, 30);
  for (const [id, facts] of Object.entries(regionFacts)) {
    const entrance = commons.portals.find((gate) => gate.targetWorldId === id);
    deepStrictEqual({ x: entrance.x, y: entrance.y }, facts.door);
    ok(walkable(entrance, commons), `${id} Commons doorway walkable`);
    const region = getWorldDefinition(id);
    strictEqual(region.columns, facts.columns);
    strictEqual(region.rows, facts.rows);
    ok(region.description && region.lore && region.ambiance);
    strictEqual(region.portals[0].targetWorldId, 'commons');
    strictEqual(region.terrain, getWorldDefinition({ id }).terrain);
  }
  const harbor = getWorldDefinition('harbor');
  strictEqual(terrainAt({ x: 10, y: 16 }, harbor), 'bridge');
  ok(reachableWorld(harbor).has('28,15'), 'harbor pavilion reachable across bridge');
});


function rendererFixture(width = 800, height = 560) {
  const texts = []; let rectangles = 0;
  const context = { save() {}, restore() {}, clearRect() {}, scale() {}, translate() {}, strokeRect() {},
    fillRect() { rectangles++; }, fillText(value) { texts.push(String(value)); }, measureText(value) { return { width: String(value).length * 6 }; } };
  return { canvas: { width, height, getContext: () => context }, texts, rectangles: () => rectangles };
}

test('renderer bounds crowded avatars and shows equipped cosmetics and unexpired expressions', () => {
  const fixture = rendererFixture();
  const visitors = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), name: `Render fixture ${i}`, x: 10, y: 6, avatar: 'flower_crown', title: 'Explorer', color: '#397f79' }));
  draw(fixture.canvas, start, { world: 'commons', visitors, clock: 1000, dayPhase: 'dusk' });
  ok(fixture.rectangles() < 20000, 'crowd drawing stays bounded rather than rendering every character');
  ok(fixture.texts.filter((text) => text.startsWith('Render fixture')).length <= 10);
  ok(fixture.texts.some((text) => text.includes('Explorer')), 'equipped title displayed');
  ok(fixture.texts.some((text) => text.startsWith('+')), 'crowd density represented');
  const expressive = rendererFixture();
  draw(expressive.canvas, start, { world: 'commons', self: { id: 'actor', name: 'Preview', emote: 'heart', emote_until: 2000, avatar: 'garden_lantern' }, clock: 1000 });
  ok(expressive.texts.includes('♥'), 'active expression visible');
  const expired = rendererFixture();
  draw(expired.canvas, start, { world: 'commons', self: { id: 'actor', name: 'Preview', emote: 'heart', emote_until: 2000 }, clock: 2001 });
  ok(!expired.texts.includes('♥'), 'expired expression hidden');
});

test('every expanded region renders and its overview supports a nonmatching canvas aspect ratio', () => {
  for (const id of Object.keys(regionFacts)) {
    const world = getWorldDefinition(id); const fixture = rendererFixture();
    draw(fixture.canvas, world.start, { world, dayPhase: 'night' });
    ok(fixture.rectangles() > 0, `${id} terrain and objects drawn`);
    const mini = rendererFixture(300, 100);
    drawMiniMap(mini.canvas, world, { camera: cameraFor(world.start, world), position: world.start });
    ok(mini.rectangles() >= world.rows * world.columns, `${id} overview contains entire world`);
  }
});

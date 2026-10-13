// Task 32 — the character module. These tests drive `src/characters.js` with the *real* payload
// shapes the server returns (`src/spaces.js#world`), with a confirmed-move sequence and with a
// refused move, and assert the module's own output geometry, positions, labels and batch key.
//
// The module is not wired into the renderer or the shell (parallel tasks own those), so nothing here
// claims a visible game change. What it proves is the contract the integration owner calls: one body
// construction for every kind, a stable visual key, bounded labels, and geometry a real Three.js
// raycaster resolves back to the confirmed tile.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../assets/vendor/three-voxel.js';
import { VOXEL_LIMITS } from '../src/voxel-geometry.js';
import { CALLINGS } from '../src/vocations.js';
import content from '../src/content.js';
import { fixture } from './helpers.js';
import {
  appearanceFor, spriteAppearance, charactersScene, charactersVisualKey, characterNameplate, characterNameplates,
  renderableCharacters, animatedCharacters, nameplateTier, paintCharacter, SEALED_EXPRESSIONS,
  CHARACTER_LIMITS, NAMEPLATE_LIMITS, BODY, ARM_POSES, CHARACTER_BODY_BOXES,
} from '../src/characters.js';
import { createMotionTracker, confirmedExpression, EXPRESSIONS } from '../src/character-animation.js';

/** The renderer's own cube batch, reimplemented as a recording double with the same contract. */
function recordingBatch() {
  const cubes = [];
  return {
    cubes,
    add(x, height, y, width, depth, length, color, pick = null, style = 'solid') {
      cubes.push({ x, height, y, width, depth, length, color, pick, style });
    },
    finish() {
      return { group: null, pickables: [], cubes: cubes.length, batches: new Set(cubes.map((cube) => cube.color)).size, list: cubes };
    },
  };
}
const top = (cubes) => cubes.reduce((highest, cube) => Math.max(highest, cube.height + cube.depth / 2), -Infinity);
const at = (cubes, color) => cubes.filter((cube) => cube.color === color);
const bodyCubes = (cubes) => cubes.filter((cube) => !cube.pick || cube.pick.type === 'participant');

/** A real world snapshot from a real Platform fixture, so the payload shape is the server's own. */
async function realWorld(t) {
  const f = await fixture(t);
  const agent = f.agent('alice', 'Aster');
  f.platform.run("UPDATE agents SET world_id='commons',x=10,y=6,z=0,grounded=1 WHERE id=?", agent.id);
  f.tx('emote', f.actor('alice'), { agent_id: agent.id, emote: 'wave' });
  const commons = f.platform.world(f.actor('alice'), { world_id: 'commons', agent_id: agent.id, x: 0, y: 0 });
  // The ambassador's own stored stand, so the venue window is asked around the real row.
  const stand = f.platform.get("SELECT x,y FROM npc_ambassadors WHERE world_id='country:NPL'");
  const venue = f.platform.world(null, { world_id: 'country:NPL', x: stand.x - 5, y: stand.y - 5 });
  return { f, agent, commons, venue, stand };
}

test('one appearance system: humans, AI residents and country ambassadors share one body construction', async (t) => {
  const { commons, venue } = await realWorld(t);
  const human = commons.participants.find((item) => item.id !== undefined);
  const ambassador = venue.participants.find((item) => item.kind === 'npc');
  assert.ok(ambassador, 'the country venue returns its ambassador');
  assert.equal(ambassador.sprite, 16, 'the ambassador carries the sealed sprite number the database stored');
  assert.equal(human.posture, 'standing');
  const records = [human, ambassador].map((item) => appearanceFor(item));
  assert.deepEqual(records.map((record) => record.family), ['resident', 'resident'], 'every kind is one family');
  assert.deepEqual(records.map((record) => record.geometry), ['cube', 'cube'], 'no kind is a different object');
  assert.deepEqual(records.map((record) => record.height), [CHARACTER_LIMITS.height, CHARACTER_LIMITS.height]);
  assert.deepEqual(records.map((record) => record.clearance), [CHARACTER_LIMITS.clearance, CHARACTER_LIMITS.clearance]);
  assert.equal(CHARACTER_LIMITS.height, 1.52, 'the drawn resident height is the shared footprint constant');
  assert.equal(CHARACTER_LIMITS.clearance, 0.38);
  // A body with no calling and no marker is exactly the twelve measured boxes the renderer draws.
  const plain = recordingBatch(), marked = recordingBatch(), dressed = recordingBatch();
  charactersScene(plain, [{ id: 'plain-agent', name: 'Plain', kind: 'agent', x: 4, y: 4, z: 0 }], null, {});
  charactersScene(dressed, [human], human, {});
  charactersScene(marked, [ambassador], null, {});
  assert.equal(plain.finish().cubes, CHARACTER_BODY_BOXES, 'a plain resident body is twelve measured boxes');
  assert.equal(CHARACTER_BODY_BOXES, 12);
  assert.equal(dressed.finish().cubes, 12 + 3, 'an explicit calling adds only its original emblem badge');
  assert.equal(marked.finish().cubes, 12 + 3 + 4, 'an ambassador adds only the NPC marker to that same body');
  assert.ok(Math.abs(top(plain.cubes) - 1.38) < 1e-9, 'the standing head top is the measured 1.38 m');
  assert.ok(Math.abs(top(marked.cubes) - 1.515) < 1e-9, 'the NPC marker sits above the head, as the shipped renderer draws it');
  // Both bodies are built from the same boxes, in the same order, with only the listed additions.
  assert.deepEqual(plain.cubes.slice(0, 3).map((cube) => cube.width), marked.cubes.slice(0, 3).map((cube) => cube.width));
});

test('the appearance layer reads the sealed definitions and re-seals nothing', () => {
  assert.equal(content.entries('appearance').length, 20, 'the 20 sealed appearance sheets are unchanged');
  assert.equal(content.cosmetics('agent_color').length, 7);
  assert.equal(content.cosmetics('skin_tone').length, 4);
  const colours = content.cosmetics('agent_color').map((id) => content.color(id, 'cosmetic'));
  const skins = content.cosmetics('skin_tone').map((id) => content.color(id, 'cosmetic'));
  assert.equal(colours.length, 7); assert.equal(skins.length, 4);
  // A named agent colour, an explicit hex and a missing colour all resolve, and nothing is invented.
  assert.equal(appearanceFor({ id: 'a', kind: 'agent', color: 'coral' }).body, colorsOf('coral'));
  assert.equal(appearanceFor({ id: 'a', kind: 'agent', color: '#123abc' }).body, '#123abc');
  assert.equal(appearanceFor({ id: 'a', kind: 'agent', color: 'not-a-colour' }).body, '#649b8a');
  assert.equal(appearanceFor({ id: 'a', kind: 'agent', color: '#123ab' }).body, '#649b8a');
  // The skin tone is one of the four sealed tones, chosen deterministically from the resident id.
  const tones = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => appearanceFor({ id, kind: 'agent' }).skin));
  for (const tone of tones) assert.ok(skins.includes(tone), `${tone} is a sealed skin tone`);
  assert.deepEqual(appearanceFor({ id: 'stable', kind: 'agent' }), appearanceFor({ id: 'stable', kind: 'agent' }));
  // The emblems cover exactly the eight sealed callings, with eight distinct tints and no unknown glyph.
  const emblems = CALLINGS.map((calling) => appearanceFor({ id: 'x', kind: 'human', calling: { id: calling.id } }).emblem);
  assert.equal(emblems.length, 8);
  assert.equal(new Set(emblems.map((emblem) => emblem.color)).size, 8, 'every sealed calling has its own emblem tint');
  const glyphs = new Set(['cross', 'arch', 'sprout', 'book', 'bridge', 'diamond']);
  for (const emblem of emblems) assert.ok(glyphs.has(emblem.mark), `${emblem.mark} is one of the six original glyphs`);
  for (const unsupported of ['__proto__', 'administrator', '', null, 7]) {
    assert.equal(appearanceFor({ id: 'x', kind: 'human', calling: { id: unsupported } }).emblem, null, `no emblem for ${String(unsupported)}`);
  }
  // The sealed sprite family resolves by the stored number and refuses anything else.
  const sheets = content.appearancesFor('civic-mayor');
  assert.equal(sheets.length, 20);
  for (const definition of sheets) {
    const record = spriteAppearance(definition.appearance.sprite);
    assert.equal(record.id, definition.id);
    assert.equal(record.atlas, definition.appearance.atlas);
    assert.equal(record.faceset, definition.appearance.faceset);
    assert.deepEqual(record.frame.walk_rows, [0, 1, 2, 3], 'the four walk rows the walk cycle mirrors');
  }
  assert.equal(spriteAppearance(4), null, 'sheet 4 is excluded from the sealed roster');
  assert.equal(spriteAppearance(999), null);
  assert.equal(spriteAppearance('16'), null, 'a string is not a stored sprite number');
  function colorsOf(id) { return content.color(id, 'cosmetic'); }
});

test('nameplates are bounded, readable and read only the public allowlist', async (t) => {
  const { commons, venue } = await realWorld(t);
  const human = commons.participants[0], ambassador = venue.participants.find((item) => item.kind === 'npc');
  const humanPlate = characterNameplate(human, { position: { x: human.x, y: human.y, z: 0 }, distance: 4 });
  assert.equal(humanPlate.name, human.name);
  assert.equal(humanPlate.role, 'AI resident · Explorer', 'an agent character is labelled by its public kind and calling');
  assert.equal(humanPlate.text, `${human.name} · AI resident · Explorer`);
  assert.equal(humanPlate.tier, 'full');
  assert.deepEqual(humanPlate.anchor, { x: human.x + .5, y: CHARACTER_LIMITS.height + NAMEPLATE_LIMITS.anchor_above, z: human.y + .5 });
  const ambassadorPlate = characterNameplate(ambassador, { position: ambassador });
  assert.equal(ambassadorPlate.role, 'Country ambassador · Steward');
  assert.equal(ambassadorPlate.sprite, 'assets/mayors/facesets/16.png', 'the sealed portrait the label may show');
  // The tier falls off with the camera distance, and a visitor beyond the compact range draws nothing.
  assert.equal(nameplateTier(0), 'full'); assert.equal(nameplateTier(NAMEPLATE_LIMITS.full_m), 'full');
  assert.equal(nameplateTier(NAMEPLATE_LIMITS.full_m + .1), 'compact');
  assert.equal(nameplateTier(NAMEPLATE_LIMITS.compact_m), 'compact');
  assert.equal(nameplateTier(NAMEPLATE_LIMITS.compact_m + .1), 'hidden');
  assert.equal(nameplateTier(undefined), 'full', 'a caller with no camera distance keeps the full label');
  // Over-long values are truncated rather than echoed, and empty ones fall back to a neutral label.
  const long = characterNameplate({ id: 'long', kind: 'human', name: 'A'.repeat(200), calling: { name: 'B'.repeat(16) } });
  assert.ok(long.name.length <= NAMEPLATE_LIMITS.name, long.name);
  assert.ok(long.role.length <= NAMEPLATE_LIMITS.role, long.role);
  assert.ok(long.name.endsWith('…')); assert.ok(long.role.endsWith('…'));
  // A calling name that is not a plain short token is dropped rather than echoed.
  const unsafe = characterNameplate({ id: 'unsafe', kind: 'human', name: 'Ada', calling: { name: '<img src=x onerror=alert(1)>' } });
  assert.equal(unsafe.role, 'Human player');
  assert.equal(characterNameplate({ id: 'unsafe-2', kind: 'human', name: 'Ada', calling: { name: 'B'.repeat(80) } }).role, 'Human player');
  const empty = characterNameplate({ id: 'empty', kind: 'human', name: '   ' });
  assert.equal(empty.name, 'Resident'); assert.equal(empty.text, 'Resident · Human player');
  const humanPlate2 = characterNameplate({ id: 'h', kind: 'human', name: 'Ada' });
  assert.equal(humanPlate2.role, 'Human player');
  assert.equal(characterNameplate({ id: 'u', kind: 'something-else', name: 'X' }).role, 'Resident', 'an unknown kind is not echoed');
});

test('a nameplate never leaks a field outside the public allowlist', () => {
  const privatePayload = {
    id: 'agent-1', kind: 'agent', name: 'Aster', x: 10, y: 6, z: 0, status: 'active',
    operator: 'ada@example.org', operator_email: 'ada@example.org', email: 'ada@example.org',
    capabilities: 'Reads private sources for the operator', limitations: 'Needs the operator password',
    memory: 'Ada prefers the west gate because her sister lives there',
    messages: [{ channel: 'private', text: 'the harvest price is 400 coins' }],
    journal: 'Private reflection I never shared.',
    focus: 'Source-based research guidance for Nepal.',
  };
  const plate = characterNameplate(privatePayload, { position: privatePayload });
  const rendered = JSON.stringify(plate);
  for (const secret of ['ada@example.org', 'private sources', 'operator password', 'west gate', '400 coins', 'Private reflection']) {
    assert.equal(rendered.includes(secret), false, `the label must not carry ${JSON.stringify(secret)}`);
  }
  assert.equal(plate.name, 'Aster'); assert.equal(plate.role, 'AI resident');
  assert.deepEqual(Object.keys(plate).sort(), ['anchor', 'distance', 'id', 'kind', 'name', 'role', 'sprite', 'text', 'tier']);
  // The bounded set is bounded, and only a nearby walker keeps a label.
  const crowd = Array.from({ length: 80 }, (_, index) => ({ id: `p${index}`, kind: 'human', name: `Resident ${index}`, x: 40 + index % 20, y: 40 + Math.floor(index / 20) }));
  const self = { ...crowd[0] };
  assert.equal(renderableCharacters(crowd, self).length, 80);
  const labels = characterNameplates(crowd, self);
  assert.ok(labels.length <= NAMEPLATE_LIMITS.labels);
  assert.equal(labels[0].id, self.id, 'the nearest resident is labelled first');
  assert.deepEqual(characterNameplates(crowd.map((item) => ({ ...item, x: 200 })), null, { limit: 3 }).length, 3);
});

test('the visual key tracks every drawn field and ignores every volatile one', async (t) => {
  const { commons, venue, agent, f } = await realWorld(t);
  const stored = commons.participants.find((item) => item.id === agent.id);
  // The fixture's own expression is kept out of the base payload so each change below is explicit.
  const human = { ...stored, emote: 'none', emote_until: 0 };
  const ambassador = { ...venue.participants.find((item) => item.kind === 'npc') };
  const time = f.clock();
  const base = charactersVisualKey([human, ambassador], human, { time });
  // Volatile fields: a poll that only refreshes presence, name, profile, operator or roster order
  // rebuilds nothing, so the renderer keeps the batch it already has.
  const volatile = [
    { ...human, name: 'Renamed', last_seen: 'much later', presence: 'connected', status: 'away', accepted_contributions: 12, operator: 'someone else' },
    { ...ambassador, title: 'Country ambassador · Nepal (updated)', last_seen: 'later' },
  ];
  assert.equal(charactersVisualKey(volatile, human, { time }), base);
  assert.equal(charactersVisualKey([ambassador, human], human, { time }), base, 'roster order is not a visible field');
  assert.equal(charactersVisualKey([{ ...human }, { ...ambassador }], human, { time }), base);
  // A stale, string, unknown or already-expired expression is not drawn, so it is not a visible field.
  for (const stale of [
    { ...human, emote: 'wave', emote_until: '2026-10-11T00:03:00Z' },
    { ...human, emote: 'wave', emote_until: time - 1 },
    { ...human, emote: 'dance', emote_until: time + 10_000 },
    { ...human, emote: undefined, emote_until: time + 10_000 },
  ]) assert.equal(charactersVisualKey([stale, ambassador], human, { time }), base);
  // Drawn fields do change the key.
  const changes = [
    ['position', [{ ...human, x: human.x + 1 }, ambassador]],
    ['elevation', [{ ...human, z: 1 }, ambassador]],
    ['posture', [{ ...human, posture: 'sitting' }, ambassador]],
    ['colour', [{ ...human, color: '#112233' }, ambassador]],
    ['kind', [{ ...human, kind: 'npc' }, ambassador]],
    ['calling', [{ ...human, calling: { id: 'builder' } }, ambassador]],
    ['expression', [{ ...human, emote: 'wave', emote_until: time + 10_000 }, ambassador]],
    ['sprite', [human, { ...ambassador, sprite: 7 }]],
  ];
  for (const [label, people] of changes) assert.notEqual(charactersVisualKey(people, human, { time }), base, `${label} is a visible change`);
  assert.notEqual(charactersVisualKey([human, ambassador], ambassador, { time }), base, 'the playing character is a visible change');
  // The expression window is a drawn field: it arrives, holds one frame, and settles inside it.
  const acted = charactersVisualKey([{ ...human, emote: 'wave', emote_until: time + 10_000 }, ambassador], human, { time });
  assert.equal(acted, charactersVisualKey([{ ...human, emote: 'wave', emote_until: time + 10_000 }, ambassador], human, { time: time + 4_000 }), 'the raised frame holds');
  assert.notEqual(acted, charactersVisualKey([{ ...human, emote: 'wave', emote_until: time + 10_000 }, ambassador], human, { time: time + 6_000 }), 'the settled frame is a change');
  assert.equal(charactersVisualKey([{ ...human, emote: 'wave', emote_until: time + 10_000 }, ambassador], human, { time: time + 10_000 }), base, 'and the key returns to rest when the window closes');
  // With a motion tracker the drawn tile, not the stored one, is the keyed value.
  let clock = 500;
  const tracker = createMotionTracker({ clock: () => clock });
  tracker.confirm({ ...human, x: 10, y: 6 });
  clock += 200; tracker.confirm({ ...human, x: 11, y: 6 });
  const moving = charactersVisualKey([{ ...human, x: 11 }, ambassador], human, { tracker, time: clock + 90 });
  const settled = charactersVisualKey([{ ...human, x: 11 }, ambassador], human, { tracker, time: clock + 180 });
  assert.notEqual(moving, settled, 'a walk frame and a settled pose are different drawn states');
  assert.equal(settled, charactersVisualKey([{ ...human, x: 11 }, ambassador], human, { tracker, time: clock + 5_000 }), 'the settled pose is stable');
});

test('the character batch is a drop-in for the renderer scene builder', async (t) => {
  const { commons, venue, agent } = await realWorld(t);
  const human = commons.participants.find((item) => item.id === agent.id);
  const ambassador = venue.participants.find((item) => item.kind === 'npc');
  assert.throws(() => charactersScene(null, [human], human), /cube batch/);
  assert.throws(() => charactersScene({ add() {} }, [human], human), /cube batch/);
  const batch = recordingBatch();
  const built = charactersScene(batch, [human, ambassador], human, {});
  assert.equal(built.cubes, batch.cubes.length);
  assert.ok(built.batches > 1);
  // Every box is a real cube: positive extents, inside the participant's own tile footprint.
  for (const cube of batch.cubes) {
    assert.ok(cube.width > 0 && cube.depth > 0 && cube.length > 0);
    assert.ok(cube.width <= 1 && cube.length <= 1, 'a character box never exceeds its tile');
    assert.equal(cube.pick.type, 'participant');
  }
  // The pick always carries the confirmed tile, never an interpolated one.
  for (const cube of batch.cubes) {
    assert.equal(Number.isInteger(cube.pick.x) && Number.isInteger(cube.pick.y), true);
    assert.equal(Number.isInteger(cube.pick.z), true);
  }
  // Invalid and unplaced records are filtered, and the roster keeps the renderer's 220 bound.
  assert.equal(renderableCharacters([{ id: 'x', x: 1.5, y: 2 }, { id: 'y', x: 1, y: 2 }], null).length, 1);
  assert.equal(renderableCharacters([{ id: 'y', x: 1, y: 2 }], { id: 'z', x: 3, y: 4 }).length, 2, 'self is appended when the roster omits it');
  assert.equal(CHARACTER_LIMITS.participants, VOXEL_LIMITS.participants, 'the participant cap matches the renderer');
  const crowd = Array.from({ length: VOXEL_LIMITS.participants + 20 }, (_, index) => ({ id: `c${index}`, kind: 'agent', x: index % 48, y: Math.floor(index / 48) }));
  const crowdBatch = recordingBatch();
  charactersScene(crowdBatch, crowd, null, {});
  assert.equal(crowdBatch.cubes.length / 12, VOXEL_LIMITS.participants);
  assert.equal(animatedCharacters(crowd, crowd[0]).size, CHARACTER_LIMITS.animated, 'only the nearest walkers animate');
});

test('the drawn body resolves through a real Three.js raycaster to the confirmed tile', async (t) => {
  const { commons, agent } = await realWorld(t);
  const human = commons.participants.find((item) => item.id === agent.id);
  const batch = recordingBatch();
  charactersScene(batch, [human], human, {});
  // Build the real instanced meshes from the module's own output, exactly as the renderer would.
  const geometry = new THREE.BoxGeometry(1, 1, 1), group = new THREE.Group(), dummy = new THREE.Object3D(), picks = [];
  const byColor = new Map();
  for (const cube of batch.cubes) {
    if (!byColor.has(cube.color)) byColor.set(cube.color, []);
    byColor.get(cube.color).push(cube);
  }
  for (const [color, cubes] of byColor) {
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial({ color, flatShading: true }), cubes.length);
    mesh.userData.picks = [];
    cubes.forEach((cube, index) => {
      dummy.position.set(cube.x, cube.height, cube.y); dummy.scale.set(cube.width, cube.depth, cube.length); dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix); mesh.userData.picks[index] = cube.pick;
    });
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); group.add(mesh);
  }
  picks.push(...group.children.map((mesh) => mesh));
  const hit = new THREE.Raycaster(new THREE.Vector3(human.x + .5, 12, human.y + .5), new THREE.Vector3(0, -1, 0))
    .intersectObjects(picks, false)[0];
  assert.ok(hit, 'the drawn body is hit by a downward ray at its confirmed tile');
  const record = hit.object.userData.picks[hit.instanceId];
  assert.equal(record.type, 'participant');
  assert.equal(record.participant.id, human.id);
  assert.equal(record.x, human.x); assert.equal(record.y, human.y);
  // The self ring is the family's lantern gold, on the tile the browser is playing.
  const ring = batch.cubes.find((cube) => cube.height === BODY.ring.height);
  assert.equal(ring.color, '#e2ca83');
  geometry.dispose();
});

test('a seated stance lowers the body by exactly the shipped amount and keeps every limb below the head', async (t) => {
  const { commons, agent } = await realWorld(t);
  const human = commons.participants.find((item) => item.id === agent.id);
  const standing = recordingBatch(), seated = recordingBatch(), cheering = recordingBatch();
  charactersScene(standing, [human], human, {});
  paintCharacter(seated, { ...human, posture: 'sitting', z: 0 }, human, {});
  paintCharacter(cheering, { ...human, emote: 'cheer', emote_until: 50_000_000_000_000 }, human, {});
  assert.ok(Math.abs(top(seated.cubes) - (top(standing.cubes) - .26)) < 1e-9, 'the seated top drops by 0.26 m');
  assert.ok(top(cheering.cubes) <= top(standing.cubes), 'a raised arm never reaches above the drawn head');
  assert.equal(seated.cubes.length, standing.cubes.length, 'a pose never resizes the body box count');
  // The arm poses are bounded: no pose lifts a hand above the head top.
  for (const [name, pose] of Object.entries(ARM_POSES)) {
    assert.ok(pose.height + pose.depth / 2 <= top(standing.cubes), `${name} stays below the drawn head`);
    assert.ok(pose.hand + BODY.hand.depth / 2 <= top(standing.cubes), `${name} keeps its hand below the drawn head`);
  }
});

test('the sealed expression vocabulary is exactly what the animation may name', () => {
  assert.deepEqual(SEALED_EXPRESSIONS, ['wave', 'bow', 'cheer', 'think', 'heart', 'none']);
  assert.deepEqual(SEALED_EXPRESSIONS.filter((id) => id !== 'none'), [...EXPRESSIONS], 'the animation names the sealed set and nothing more');
  for (const unknown of ['farm', 'sleep', '__proto__', '']) {
    assert.equal(confirmedExpression({ emote: unknown, emote_until: 10_000 }, 1), null, `${JSON.stringify(unknown)} is not a drawable expression`);
  }
  assert.equal(confirmedExpression({ emote: 'wave', emote_until: 10_000 }, 9_999)?.action, 'wave');
});

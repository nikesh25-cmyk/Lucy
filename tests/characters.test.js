// Task 32's character module, raised: one appearance system, a body that is authored in its own
// frame, a drawn cosmetic vocabulary, and a geometry bound that holds for every authored combination.
//
// These tests drive `src/characters.js` with the *real* payload shapes the server returns
// (`src/spaces.js#world`), with a confirmed-move sequence and with a refused move, and assert the
// module's own output geometry, positions, labels and batch key. Where a claim is "the drawn body
// never leaves its tile", the test enumerates every combination the sealed content layer can produce
// — three kinds, eight callings, eleven equipped decorations, three stances and every staged frame —
// and measures the real boxes rather than restating the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../assets/vendor/three-voxel.js';
import { VOXEL_LIMITS } from '../src/voxel-geometry.js';
import { CALLINGS } from '../src/vocations.js';
import content from '../src/content.js';
import { fixture } from './helpers.js';
import { RESIDENT_HEIGHT } from '../src/footprints.js';
import {
  appearanceFor, spriteAppearance, charactersScene, charactersVisualKey, characterNameplate, characterNameplates,
  renderableCharacters, animatedCharacters, nameplateTier, paintCharacter, characterBoxes, decorationFor, silhouetteFor,
  SEALED_EXPRESSIONS, CALLING_SILHOUETTES, DECORATIONS, SILHOUETTE_IDS, CHARACTER_LIMITS, CHARACTER_PART_BOXES,
  CHARACTER_BODY_BOXES, CHARACTER_TILE_HALF, NAMEPLATE_LIMITS, BODY, ARM_POSES,
} from '../src/characters.js';
import { createMotionTracker, confirmedExpression, characterState, characterPose, EXPRESSIONS, EXPRESSION_FRAMES, EXPRESSION_ACTION_FRAME, MOTION_TWEEN_MS, SEATED_LIFT } from '../src/character-animation.js';

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
const floor = (cubes) => cubes.reduce((lowest, cube) => Math.min(lowest, cube.height - cube.depth / 2), Infinity);
/** How far the drawn boxes reach from the centre of the tile they are drawn on, in each ground axis. */
const reach = (cubes) => cubes.reduce((widest, cube) => ({
  x: Math.max(widest.x, Math.abs(cube.x) + cube.width / 2), z: Math.max(widest.z, Math.abs(cube.z) + cube.length / 2),
}), { x: 0, z: 0 });

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
  // A body with no calling, no decoration and no marker is exactly the measured box list.
  const plain = recordingBatch(), marked = recordingBatch(), dressed = recordingBatch();
  charactersScene(plain, [{ id: 'plain-agent', name: 'Plain', kind: 'agent', x: 4, y: 4, z: 0 }], null, {});
  charactersScene(dressed, [human], human, {});
  charactersScene(marked, [ambassador], null, {});
  assert.equal(plain.finish().cubes, CHARACTER_BODY_BOXES, 'a plain resident body is the measured box list');
  assert.equal(CHARACTER_BODY_BOXES, 15);
  // An explicit calling adds exactly its emblem badge, its two-pixel glyph and its silhouette accent;
  // the equipped decoration adds its own two boxes and nothing else.
  assert.equal(dressed.finish().cubes, CHARACTER_BODY_BOXES
    + CHARACTER_PART_BOXES.emblem + CHARACTER_PART_BOXES.silhouette + CHARACTER_PART_BOXES.decoration);
  assert.equal(appearanceFor(human).silhouette, CALLING_SILHOUETTES.explorer);
  assert.equal(appearanceFor(human).decoration, DECORATIONS.sprout, 'the fixture resident keeps its default keepsake');
  // An ambassador adds the NPC marker (which *is* its authored silhouette) and nothing else.
  assert.equal(marked.finish().cubes, CHARACTER_BODY_BOXES + CHARACTER_PART_BOXES.emblem + CHARACTER_PART_BOXES.marker);
  assert.equal(appearanceFor(ambassador).silhouette, null, 'the marker is an NPC body’s authored silhouette');
  assert.equal(appearanceFor(ambassador).decoration, null, 'an NPC holds no account-bound keepsake');
  assert.ok(Math.abs(top(plain.cubes) - CHARACTER_LIMITS.head) < 1e-9, 'the standing head top is the measured 1.38 m');
  assert.ok(Math.abs(top(marked.cubes) - 1.515) < 1e-9, 'the NPC marker sits above the head, as the shipped renderer draws it');
  // Both bodies are built from the same boxes, in the same order, with only the listed additions.
  assert.deepEqual(plain.cubes.slice(0, 3).map((cube) => cube.width), marked.cubes.slice(0, 3).map((cube) => cube.width));
});

test('the drawn body is authored in its own frame and turns with the confirmed facing', () => {
  const base = { id: 'turn', kind: 'agent', x: 5, y: 6, z: 0 };
  // No stored yaw is the neutral facing (`up`); the four cardinals are the stored yaw quantised.
  const at = (yaw) => characterBoxes(yaw === undefined ? base : { ...base, yaw }, null, { time: 0 });
  const down = at(undefined), right = at(-Math.PI / 2), up = at(0), left = at(Math.PI / 2);
  // The face, the hair and the emblem all sit at a positive forward offset in the body's own frame:
  // facing down draws them at +z and facing up draws them at -z.
  const forwardOf = (boxes) => boxes.reduce((widest, box) => Math.abs(box.z) > Math.abs(widest.z) ? box : widest, boxes[0]);
  assert.ok(forwardOf(down).z > 0, 'facing down draws the face at +z');
  assert.ok(forwardOf(up).z < 0, 'facing up draws the face at -z');
  assert.equal(down.length, up.length);
  for (const [index, box] of down.entries()) {
    // Up is a point reflection of down through the tile centre, and right is a quarter turn of it.
    const mirrored = up[index];
    assert.ok(Math.abs(box.x + mirrored.x) < 1e-9 && Math.abs(box.z + mirrored.z) < 1e-9, `box ${index} mirrors through the tile centre`);
    const turned = right[index];
    assert.ok(Math.abs(box.width - turned.length) < 1e-9 && Math.abs(box.length - turned.width) < 1e-9, `box ${index} swaps its ground extents`);
    assert.ok(Math.abs(box.z - turned.x) < 1e-9 && Math.abs(box.x + turned.z) < 1e-9, `box ${index} turns a quarter to the right`);
  }
  assert.equal(left.length, down.length);
  // The ring is the one part that never turns: it is the tile, not the body.
  assert.deepEqual(down[0], left[0]);
  assert.equal(down[0].width, BODY.ring.width);
  // The width and depth of every box stay inside the same tile in all four facings.
  for (const boxes of [down, up, left, right]) {
    const drawn = reach(boxes);
    assert.ok(drawn.x <= CHARACTER_TILE_HALF && drawn.z <= CHARACTER_TILE_HALF, `facing keeps ${JSON.stringify(drawn)} inside the tile`);
  }
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
  // Every sealed calling carries exactly one authored silhouette, and none can be addressed by another name.
  assert.deepEqual([...SILHOUETTE_IDS].sort(), [...CALLINGS.map((calling) => calling.id)].sort(), 'one silhouette per sealed calling');
  for (const calling of CALLINGS) {
    const silhouette = silhouetteFor({ calling: { id: calling.id } });
    assert.ok(silhouette, `${calling.id} has a silhouette`);
    assert.equal(silhouette.parts.length, CHARACTER_PART_BOXES.silhouette, `${calling.id} spends the whole silhouette allowance`);
  }
  for (const unsupported of ['__proto__', 'administrator', '', null, 7]) assert.equal(silhouetteFor({ calling: { id: unsupported } }), null);
  // The drawn decorations are exactly the sealed keepsakes plus the crafted decoration outputs.
  const drawn = Object.keys(DECORATIONS).sort();
  const sealed = [...content.cosmetics('avatar'), ...content.recipes().map((recipe) => recipe.output)].sort();
  assert.deepEqual(drawn, sealed, 'the drawn cosmetic vocabulary is the sealed one');
  const keepsakes = ['flower', 'leaf', 'sprout', 'star', 'explorer_banner'];
  const crafted = ['flower_crown', 'herbal_wreath', 'garden_lantern', 'reed_whistle', 'woven_banner', 'festival_banner'];
  assert.deepEqual(sealed, [...keepsakes, ...crafted].sort());
  for (const id of drawn) {
    assert.equal(decorationFor({ avatar: id }).parts.length, CHARACTER_PART_BOXES.decoration, `${id} spends the whole decoration allowance`);
    assert.equal(decorationFor({ avatar: id }).color, DECORATIONS[id].color);
  }
  for (const unsupported of ['__proto__', 'hat', '', null, 7]) assert.equal(decorationFor({ avatar: unsupported }), null, `no decoration for ${String(unsupported)}`);
  assert.equal(decorationFor({ avatar: 'star' }).color, content.color('star', 'cosmetic') || DECORATIONS.star.color);
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

test('every authored combination stays inside its own tile, above the floor and inside the box budget', () => {
  const callings = [undefined, ...SILHOUETTE_IDS], decorations = [undefined, ...Object.keys(DECORATIONS)];
  const stances = ['standing', 'sitting', 'meditating'], emotes = [null, ...EXPRESSIONS];
  let checked = 0, widest = { x: 0, z: 0 }, highest = -Infinity, lowest = Infinity;
  const clock = 1_000, tracker = createMotionTracker({ clock: () => clock });
  const walker = { id: 'walker', kind: 'agent', x: 4, y: 4, z: 0 };
  tracker.confirm(walker); tracker.confirm({ ...walker, x: 5 });
  for (const kind of ['human', 'agent', 'npc']) for (const calling of callings) for (const avatar of decorations) for (const stance of stances) {
    const item = { id: 'walk', kind, x: 5, y: 4, z: 0, posture: stance, calling: calling ? { id: calling } : undefined, avatar };
    for (const emote of emotes) for (const [offset, until] of emote ? [[0, 11_000], [1_500, 11_000], [5_500, 11_000], [8_000, 11_000]] : [[500, 0]]) {
      const payload = emote ? { ...item, emote, emote_until: until } : item;
      const boxes = characterBoxes(payload, null, { tracker, time: clock + offset });
      const label = `${kind}/${calling}/${avatar}/${stance}/${emote}@${offset}`;
      assert.ok(boxes.length <= CHARACTER_LIMITS.boxes, `${label} draws ${boxes.length} boxes`);
      assert.ok(boxes.length >= CHARACTER_BODY_BOXES, `${label} keeps its whole body`);
      const drawn = reach(boxes);
      widest = { x: Math.max(widest.x, drawn.x), z: Math.max(widest.z, drawn.z) };
      highest = Math.max(highest, boxes.reduce((value, box) => Math.max(value, box.height + box.depth / 2), -Infinity));
      lowest = Math.min(lowest, boxes.reduce((value, box) => Math.min(value, box.height - box.depth / 2), Infinity));
      for (const box of boxes) {
        assert.ok(box.width > 0 && box.depth > 0 && box.length > 0, `${label} draws a real box`);
        assert.ok(Math.abs(box.x) + box.width / 2 <= CHARACTER_TILE_HALF + 1e-9, `${label}: x ${box.x} leaves the tile`);
        assert.ok(Math.abs(box.z) + box.length / 2 <= CHARACTER_TILE_HALF + 1e-9, `${label}: z ${box.z} leaves the tile`);
        assert.ok(box.height - box.depth / 2 >= 0, `${label} stands on the floor`);
        assert.ok(box.height + box.depth / 2 <= RESIDENT_HEIGHT + 1e-9, `${label} stays under the resident height`);
      }
      checked++;
    }
  }
  // The sweep has to reach a real combination, or it proves nothing.
  assert.equal(checked, 3 * 9 * 12 * 3 * 6 * 4 - 3 * 9 * 12 * 3 * 1 * 3);
  assert.ok(checked > 20_000, `the sweep measures ${checked} drawn poses`);
  assert.ok(widest.x > 0.4 && widest.z > 0.4, `the sweep reaches a wide pose (${JSON.stringify(widest)})`);
  assert.equal(lowest, BODY.ring.height - BODY.ring.depth / 2, 'nothing is drawn below the ring it stands in');
  assert.ok(highest > 1.5 && highest <= RESIDENT_HEIGHT, `the tallest drawn pose is ${highest} m`);
});

test('no pose draws a body taller than its own head, and every stance is a bounded function of confirmed state', () => {
  const clock = 2_000, tracker = createMotionTracker({ clock: () => clock });
  const walker = { id: 'walker', kind: 'agent', x: 4, y: 4, z: 0 };
  tracker.confirm(walker); tracker.confirm({ ...walker, x: 5 });
  // A body with no calling and no decoration is exactly the measured body: it is never taller than
  // its own head, whatever it is doing, and the tallest draw is the neutral standing pose.
  const idle = characterBoxes(walker, null, { tracker, time: clock + 1_000 });
  const standing = top(idle);
  assert.ok(Math.abs(standing - CHARACTER_LIMITS.head) < 1e-9, 'the neutral standing body is the head height');
  for (const item of [
    ...['wave', 'bow', 'cheer', 'think', 'heart'].flatMap((emote) => [[0, emote], [1_500, emote], [5_500, emote], [8_000, emote]]
      .map(([offset, name]) => ({ ...walker, emote: name, emote_until: 12_000, offset }))),
    ...['sitting', 'meditating'].map((posture) => ({ ...walker, posture, offset: 0 })),
    ...Array.from({ length: MOTION_TWEEN_MS + 1 }, (_, offset) => ({ ...walker, offset })),
  ]) {
    const boxes = characterBoxes(item, null, { tracker, time: clock + item.offset });
    assert.ok(top(boxes) <= standing + 1e-9, `a pose at +${item.offset} ms reaches ${top(boxes)} m`);
    assert.ok(floor(boxes) >= 0, 'and stands on the floor');
  }
  // A seated stance lowers the whole upper body by exactly the shipped amount, for every body.
  for (const avatar of [undefined, ...Object.keys(DECORATIONS)]) for (const calling of [undefined, 'steward']) {
    const item = { ...walker, avatar, calling: calling ? { id: calling } : undefined };
    const upright = top(characterBoxes({ ...item, y: 4 }, null, { tracker, time: 0 }));
    for (const posture of ['sitting', 'meditating']) {
      const seated = top(characterBoxes({ ...item, posture, y: 4 }, null, { tracker, time: 0 }));
      assert.ok(Math.abs((upright - seated) - SEATED_LIFT) < 1e-9, `${posture}/${avatar} drops by exactly ${SEATED_LIFT} m`);
    }
    // `sitting` and `meditating` are two different drawn poses, not one number twice.
    assert.notDeepEqual(characterBoxes({ ...item, posture: 'sitting', y: 4 }, null, { tracker, time: 0 }),
      characterBoxes({ ...item, posture: 'meditating', y: 4 }, null, { tracker, time: 0 }));
  }
  // The pose reads the confirmed state and nothing else: a profile, presence or operator change is
  // not a pose change, while a stance, an expression window or a walk frame is.
  const base = { ...walker, y: 4, name: 'Aster', last_seen: '2026-10-13T09:00:00Z', operator: 'alice', status: 'active' };
  const pose = (item, time = clock) => JSON.stringify(characterBoxes(item, null, { tracker, time }));
  assert.equal(pose({ ...base, name: 'Renamed', last_seen: 'later', operator: 'bob', status: 'away' }), pose(base));
  assert.notEqual(pose({ ...base, posture: 'sitting' }), pose(base));
  assert.notEqual(pose({ ...base, emote: 'wave', emote_until: 12_000 }), pose(base));
  assert.notEqual(pose({ ...base, x: 5 }, clock + MOTION_TWEEN_MS / 2), pose(base, clock));
  // ...and every pose is the same draw for the same confirmed input, twice.
  for (const item of [{ ...base, posture: 'meditating' }, { ...base, emote: 'cheer', emote_until: 12_000 }]) {
    assert.equal(pose(item), pose(item));
  }
});

test('every sealed expression renders its whole staged sequence', () => {
  const clock = 3_000, item = { id: 'actor', kind: 'agent', x: 7, y: 2, z: 0 };
  const idle = characterBoxes({ ...item, emote: 'none', emote_until: 0 }, null, { time: clock });
  for (const emote of EXPRESSIONS) {
    // The four staged offsets are the boundaries of the authored frame table.
    const offsets = [0, 1_500, 5_500, 8_000];
    const payload = (offset) => ({ ...item, emote, emote_until: clock + 10_000 });
    const states = offsets.map((offset) => characterState(payload(), { time: clock + offset }));
    assert.deepEqual(states.map((state) => state.expressionFrame), [0, 1, 2, 3], `${emote} plays all ${EXPRESSION_FRAMES} staged frames`);
    assert.deepEqual(states.map((state) => state.state), ['interacting', 'interacting', 'interacting', 'interacting']);
    assert.deepEqual(states.map((state) => state.action), [emote, emote, emote, emote]);
    const drawn = offsets.map((offset) => characterBoxes(payload(), null, { time: clock + offset }));
    for (const [index, boxes] of drawn.entries()) {
      assert.equal(boxes.length, CHARACTER_BODY_BOXES, `${emote} frame ${index} only ever draws one body`);
      assert.ok(top(boxes) <= CHARACTER_LIMITS.head + 1e-9 && floor(boxes) >= 0, `${emote} frame ${index} stays inside the body`);
    }
    // The action frame is the legible one, the sequence ends at the neutral body, and the four
    // staged frames are four different poses rather than one pose drawn four times.
    assert.notDeepEqual(drawn[0], drawn[1], `${emote} anticipates before it acts`);
    assert.notDeepEqual(drawn[1], drawn[2], `${emote} settles inside its window`);
    assert.notDeepEqual(drawn[2], drawn[3], `${emote} returns to rest at the end of its window`);
    assert.deepEqual(drawn[3], idle, `${emote} ends at the neutral body`);
    assert.equal(new Set(drawn.map((boxes) => JSON.stringify(boxes))).size, EXPRESSION_FRAMES, `${emote} grows the drawn vocabulary to ${EXPRESSION_FRAMES} poses`);
  }
  // Nothing animates outside the stored window, and a malformed window draws the neutral body.
  for (const refused of [{ emote: 'wave' }, { emote: 'wave', emote_until: 'later' }, { emote: 'dance', emote_until: clock + 10_000 }, { emote: 'wave', emote_until: clock }]) {
    assert.equal(confirmedExpression({ ...item, ...refused }, clock), null);
    assert.equal(characterState({ ...item, ...refused }, { time: clock }).state, 'idle');
    assert.deepEqual(characterBoxes({ ...item, ...refused }, null, { time: clock }), idle);
  }
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
    avatar: 'star', title: 'Resident',
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
    // The equipped decoration is drawn now, so it is a visible field rather than a curated profile.
    ['decoration', [{ ...human, avatar: 'star' }, ambassador]],
  ];
  for (const [label, people] of changes) assert.notEqual(charactersVisualKey(people, human, { time }), base, `${label} is a visible change`);
  assert.notEqual(charactersVisualKey([human, ambassador], ambassador, { time }), base, 'the playing character is a visible change');
  // The expression window is a drawn field: it arrives, plays its four staged frames inside the
  // window, and settles back to the neutral body when the window closes.
  const acted = charactersVisualKey([{ ...human, emote: 'wave', emote_until: time + 10_000 }, ambassador], human, { time });
  assert.equal(acted, charactersVisualKey([{ ...human, emote: 'wave', emote_until: time + 10_000 }, ambassador], human, { time: time + 500 }), 'the action frame holds');
  assert.notEqual(acted, charactersVisualKey([{ ...human, emote: 'wave', emote_until: time + 10_000 }, ambassador], human, { time: time + 4_000 }), 'the held frame is a change');
  assert.notEqual(acted, charactersVisualKey([{ ...human, emote: 'wave', emote_until: time + 10_000 }, ambassador], human, { time: time + 9_000 }), 'and the rest frame is another');
  assert.equal(charactersVisualKey([{ ...human, emote: 'wave', emote_until: time + 10_000 }, ambassador], human, { time: time + 10_000 }), base, 'the key returns to rest when the window closes');
  // With a motion tracker the drawn tile, not the stored one, is the keyed value.
  let clock = 500;
  const tracker = createMotionTracker({ clock: () => clock });
  tracker.confirm({ ...human, x: 10, y: 6 });
  clock += 200; tracker.confirm({ ...human, x: 11, y: 6 });
  const moving = charactersVisualKey([{ ...human, x: 11 }, ambassador], human, { tracker, time: clock + 90 });
  const settled = charactersVisualKey([{ ...human, x: 11 }, ambassador], human, { tracker, time: clock + 180 });
  assert.notEqual(moving, settled, 'a walk frame and a settled pose are different drawn states');
  assert.equal(settled, charactersVisualKey([{ ...human, x: 11 }, ambassador], human, { tracker, time: clock + 5_000 }), 'the settled pose is stable');
  // `reducedMotion` is a drawn difference too: it is keyed, so a caller can never reuse the wrong batch.
  assert.notEqual(charactersVisualKey([{ ...human, x: 11 }, ambassador], human, { tracker, time: clock + 90, reducedMotion: true }), moving);
});

test('a single body is a drop-in for the renderer scene builder', async (t) => {
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
  assert.equal(crowdBatch.cubes.length / CHARACTER_BODY_BOXES, VOXEL_LIMITS.participants);
  assert.equal(animatedCharacters(crowd, crowd[0]).size, CHARACTER_LIMITS.animated, 'only the nearest walkers animate');
  // The module's own per-participant ceiling is the one the renderer's budget already pays for.
  assert.equal(CHARACTER_LIMITS.boxes, 22);
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
  // The fixture's own stored expression window is cleared, so the seated drop is measured on the
  // one variable under test rather than against a dip the stored expression already applied.
  const idle = { ...human, emote: 'none', emote_until: 0 };
  const standing = recordingBatch(), sitting = recordingBatch(), meditating = recordingBatch(), cheering = recordingBatch();
  charactersScene(standing, [idle], idle, {});
  paintCharacter(sitting, { ...idle, posture: 'sitting', z: 0 }, idle, {});
  paintCharacter(meditating, { ...idle, posture: 'meditating', z: 0 }, idle, {});
  paintCharacter(cheering, { ...idle, emote: 'cheer', emote_until: 50_000_000_000_000 }, idle, {});
  assert.ok(top(standing.cubes) <= RESIDENT_HEIGHT, 'the standing body stays under the resident height');
  assert.ok(Math.abs(top(standing.cubes) - (top(sitting.cubes) + SEATED_LIFT)) < 1e-9, 'the seated top drops by 0.26 m');
  assert.ok(Math.abs(top(standing.cubes) - (top(meditating.cubes) + SEATED_LIFT)) < 1e-9, 'so does the meditating top');
  assert.ok(top(cheering.cubes) <= top(standing.cubes), 'a raised arm never reaches above the drawn head');
  assert.equal(sitting.cubes.length, standing.cubes.length, 'a pose never resizes the body box count');
  assert.ok(floor(sitting.cubes) >= 0, 'and never draws a hand through the floor');
  // The arm poses are bounded: no pose lifts a hand above the head top.
  for (const [name, pose] of Object.entries(ARM_POSES)) {
    assert.ok(pose.height + pose.depth / 2 <= CHARACTER_LIMITS.head + 1e-9, `${name} stays below the drawn head`);
    assert.ok(pose.hand + BODY.hand.depth / 2 <= CHARACTER_LIMITS.head + 1e-9, `${name} keeps its hand below the drawn head`);
    assert.ok(pose.hand - BODY.hand.depth / 2 >= -SEATED_LIFT - 1e-9, `${name} keeps its hand above the floor when seated`);
    assert.ok(BODY.arm.across - pose.inward + BODY.arm.width / 2 <= CHARACTER_TILE_HALF + 1e-9, `${name} keeps its arm inside the tile`);
  }
  assert.ok(Math.abs(ARM_POSES.up.height + ARM_POSES.up.depth / 2 - CHARACTER_LIMITS.head) < 1e-9, 'the highest arm pose touches the head and stops');
});

test('the sealed expression vocabulary is exactly what the animation may name', () => {
  assert.deepEqual(SEALED_EXPRESSIONS, ['wave', 'bow', 'cheer', 'think', 'heart', 'none']);
  assert.deepEqual(SEALED_EXPRESSIONS.filter((id) => id !== 'none'), [...EXPRESSIONS], 'the animation names the sealed set and nothing more');
  assert.equal(EXPRESSION_FRAMES, 4);
  assert.equal(EXPRESSION_ACTION_FRAME, 1);
  for (const unknown of ['farm', 'sleep', '__proto__', '']) {
    assert.equal(confirmedExpression({ emote: unknown, emote_until: 10_000 }, 1), null, `${JSON.stringify(unknown)} is not a drawable expression`);
  }
  assert.equal(confirmedExpression({ emote: 'wave', emote_until: 10_000 }, 9_999)?.action, 'wave');
  // Every staged pose an expression can name is a real arm pose the body builder knows.
  const named = new Set();
  for (const emote of EXPRESSIONS) for (let frame = 0; frame < EXPRESSION_FRAMES; frame += 1) {
    const arm = characterPose(characterState({ id: 'a', kind: 'agent', emote, emote_until: 10_000 }, { time: 10_000 - 10_000 + [0, 1_500, 5_500, 8_000][frame] })).arm;
    named.add(arm.left); named.add(arm.right);
  }
  for (const pose of named) assert.ok(Object.hasOwn(ARM_POSES, pose), `${pose} is an authored arm pose`);
  assert.ok(named.size >= 5, `the staged expressions name ${named.size} distinct arm poses`);
});

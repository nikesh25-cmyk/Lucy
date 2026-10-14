// Task 32's animation state machine and remote-movement interpolation, raised: a confirmed-state
// pose vocabulary, staged expression frames, and the reduced-motion contract.
//
// The rules under test are the confirmed-position rules: an avatar is drawn on the segment between
// the last two *confirmed* tiles, never ahead of the newest one; a refused move reconciles to the
// stored tile; a jump snaps instead of gliding; and no pose implies an action the server did not
// confirm. `prefers-reduced-motion` is the fifth rule: the drawn tile is the confirmed one and the
// pose is a still frame. The last test drives a real Platform fixture: real steps, a real refusal and
// a really stored expression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorldDefinition, walkable } from '../world.js';
import { fixture } from './helpers.js';
import {
  createMotionTracker, characterState, characterPose, confirmedExpression, confirmedFacing, facingStep, facingFrame,
  expressionFrameAt,
  MOTION_LIMITS, MOTION_TWEEN_MS, WALK_FRAMES, WALK_BOB, WALK_SWAY, EXPRESSION_MS, EXPRESSIONS, STANCES, SEATED_LIFT,
  WALK_SWING, EXPRESSION_FRAMES, EXPRESSION_FRAME_AT, EXPRESSION_ACTION_FRAME, LEANING_EXPRESSIONS,
} from '../src/character-animation.js';
import { paintCharacter, characterBoxes } from '../src/characters.js';

const resident = (changes = {}) => ({ id: 'resident-1', kind: 'agent', x: 10, y: 6, z: 0, posture: 'standing', ...changes });

function clocked(start = 1_000) {
  let now = start;
  const tracker = createMotionTracker({ clock: () => now });
  return { tracker, at: () => now, advance: (ms) => { now += ms; return now; } };
}

test('a first sight is drawn on its own confirmed tile, never sliding in from an origin', () => {
  const { tracker, at } = clocked();
  const first = tracker.confirm(resident({ x: 30, y: 12, z: 3 }));
  assert.deepEqual(first, { changed: true, snapped: true });
  const seen = tracker.position('resident-1', at());
  assert.deepEqual([seen.x, seen.y, seen.z], [30, 12, 3]);
  assert.equal(seen.t, 1); assert.equal(seen.walking, false);
  assert.equal(tracker.isSettling(at()), false);
  // An unplaceable record is refused rather than tracked at an invented position.
  for (const invalid of [null, {}, { id: 'x' }, { id: 'x', x: 1.5, y: 2 }, { id: 7, x: 1, y: 2 }]) {
    assert.deepEqual(tracker.confirm(invalid), { changed: false, snapped: false });
  }
  assert.equal(tracker.size, 1);
  assert.equal(tracker.position('never-seen', at()), null);
});

test('a confirmed step glides between exactly its two confirmed tiles and lands on the newest one', () => {
  const { tracker, at, advance } = clocked();
  tracker.confirm(resident());
  advance(500);
  tracker.confirm(resident({ x: 11 }));
  assert.equal(tracker.isSettling(at()), true);
  const samples = [0, 1, MOTION_TWEEN_MS / 2, MOTION_TWEEN_MS - 1, MOTION_TWEEN_MS, 5_000].map((offset) => tracker.position('resident-1', at() + offset));
  // Never behind the previous tile, never past the newest one.
  for (const sample of samples) {
    assert.ok(sample.x >= 10 && sample.x <= 11, `x=${sample.x} stays inside the confirmed segment`);
    assert.ok(sample.t >= 0 && sample.t <= 1);
  }
  assert.deepEqual([samples[0].x, samples[0].t, samples[0].walking], [10, 0, true]);
  assert.ok(samples[1].x > 10 && samples[1].x < 10.001, 'the ease starts from the previous tile');
  assert.ok(Math.abs(samples[2].x - 10.5) < 1e-9, 'half the tween is half the segment');
  assert.ok(samples[3].x > 10.5 && samples[3].x < 11);
  assert.deepEqual([samples[4].x, samples[4].t, samples[4].walking], [11, 1, false]);
  assert.deepEqual([samples[5].x, samples[5].t], [11, 1], 'a settled avatar stays exactly on its confirmed tile');
  assert.equal(tracker.isSettling(at() + MOTION_TWEEN_MS), false);
  assert.deepEqual(samples[0].to, { x: 11, y: 6, z: 0 });
  assert.deepEqual(samples[0].from, { x: 10, y: 6, z: 0 });
});

test('the walk cycle is the quantised progress between the two confirmed tiles, never a free clock', () => {
  const { tracker, at, advance } = clocked();
  tracker.confirm(resident());
  advance(500);
  tracker.confirm(resident({ y: 7 }));
  const states = [];
  for (let offset = 0; offset <= MOTION_TWEEN_MS; offset += 1) {
    states.push(characterState(resident({ y: 7 }), { tracker, time: at() + offset }));
  }
  const phases = states.map((state) => state.phase);
  assert.deepEqual([...new Set(phases)].sort(), [0, 1, 2, 3], `exactly the ${WALK_FRAMES} sealed walk frames appear`);
  assert.equal(phases[0], 0); assert.equal(phases.at(-1), 0, 'a settled avatar is not mid-stride');
  // The facing is the direction of the confirmed step: grid y+1 is `down`, grid y-1 is `up`.
  const walking = characterState(resident({ y: 7 }), { tracker, time: at() + MOTION_TWEEN_MS / 2 });
  assert.equal(walking.facing, 'down'); assert.deepEqual(walking.direction, facingStep('down'));
  assert.deepEqual([walking.direction.x, walking.direction.y], [0, 1]);
  assert.equal(characterState(resident({ y: 5 }), { tracker, time: at() + MOTION_TWEEN_MS / 2, }).facing, 'down', 'the facing follows the confirmed step, not the payload');
  assert.equal(walking.state, 'walking');
  // Below the animation bound a walker is still drawn on the confirmed segment, but at rest.
  const still = characterState(resident({ y: 7 }), { tracker, time: at() + MOTION_TWEEN_MS / 2, animated: false });
  assert.equal(still.state, 'idle'); assert.equal(still.phase, 0);
  assert.deepEqual(still.position, walking.position, 'the drawn tile is the same; only the pose is at rest');
});

test('a refused move reconciles to the stored tile and a jump snaps instead of gliding', () => {
  const { tracker, at, advance } = clocked();
  tracker.confirm(resident());
  advance(500); tracker.confirm(resident({ x: 11 }));
  advance(MOTION_TWEEN_MS / 2);
  const mid = tracker.position('resident-1', at());
  assert.ok(mid.x > 10 && mid.x < 11);
  // The server refused the step, so the client drops the tween and snaps back to what it stored.
  assert.equal(tracker.reconcile('resident-1'), true);
  assert.deepEqual(tracker.position('resident-1', at()).x, 11);
  assert.equal(tracker.isSettling(at()), false);
  assert.equal(tracker.reconcile('never-seen'), false, 'reconciling an unknown participant does nothing');
  assert.equal(characterState(resident({ x: 11 }), { tracker, time: at() }).state, 'idle');
  // A jump is never drawn as a walk across tiles the server did not confirm.
  for (const jump of [resident({ x: 20 }), resident({ x: 11, y: 6, z: 2 }), resident({ x: 11, world_id: 'home:1' })]) {
    tracker.confirm(resident({ x: 11, world_id: 'commons' }));
    const result = tracker.confirm(jump);
    assert.equal(result.snapped, true, `${JSON.stringify([jump.x, jump.y, jump.z, jump.world_id])} snaps`);
    const shown = tracker.position('resident-1', at());
    assert.deepEqual([shown.x, shown.y, shown.z], [jump.x, jump.y, jump.z ?? 0]);
    assert.equal(shown.walking, false);
    assert.equal(result.changed, true);
  }
  // One grid step in the same world still glides.
  tracker.confirm(resident({ x: 11, world_id: 'commons' }));
  const one = tracker.confirm(resident({ x: 12, world_id: 'commons' }));
  assert.deepEqual(one, { changed: true, snapped: false });
  assert.equal(MOTION_LIMITS.glide_tiles, 1);
  assert.equal(MOTION_LIMITS.glide_layers, 1);
});

test('a second confirmed step starts from where the avatar is drawn, and a repeat poll animates nothing', () => {
  const { tracker, at, advance } = clocked();
  tracker.confirm(resident());
  advance(500); tracker.confirm(resident({ x: 11 }));
  advance(MOTION_TWEEN_MS / 2);
  const drawn = tracker.position('resident-1', at());
  advance(10);
  assert.deepEqual(tracker.confirm(resident({ x: 11 })), { changed: false, snapped: false });
  const still = tracker.position('resident-1', at());
  assert.ok(still.x > drawn.x && still.x < 11, 'a repeat poll lets an in-flight tween keep interpolating');
  assert.equal(tracker.confirm(resident({ x: 11 })).snapped, false, 'and never cancels it');
  tracker.confirm(resident({ x: 12 }));
  const next = tracker.position('resident-1', at());
  assert.deepEqual(next.from.x, still.x, 'the next step glides from the drawn position, not from a stale tile');
  assert.deepEqual(next.to.x, 12);
});

test('an expression plays four staged frames inside the stored window it was given', () => {
  const window = { emote: 'wave', emote_until: 20_000 };
  const frameAt = (time) => confirmedExpression(window, time)?.frame;
  assert.deepEqual([0, 900, 1_000, 5_400, 5_500, 7_700, 7_800, 9_999].map((elapsed) => frameAt(10_000 + elapsed)),
    [0, 0, 1, 1, 2, 2, 3, 3], 'the authored frame boundaries are the only boundaries');
  assert.deepEqual(EXPRESSION_FRAME_AT, [0, 0.1, 0.55, 0.78]);
  assert.equal(EXPRESSION_FRAMES, 4);
  assert.equal(EXPRESSION_ACTION_FRAME, 1);
  for (const [progress, expected] of [[0, 0], [0.099, 0], [0.1, 1], [0.549, 1], [0.55, 2], [0.779, 2], [0.78, 3], [1, 3], [2, 3]])
    assert.equal(expressionFrameAt(progress), expected, `${progress} is frame ${expected}`);
  for (const missing of [NaN, undefined, null, 'x']) assert.equal(expressionFrameAt(missing), 0);
  assert.equal(confirmedExpression(window, 20_000), null, 'the window is closed at its own expiry');
  assert.equal(confirmedExpression(window, 99_999), null);
  for (const refused of [{ emote: 'none', emote_until: 20_000 }, { emote: 'wave', emote_until: 'later' },
    { emote: 'wave' }, { emote: 'dance', emote_until: 20_000 }, { emote: 7, emote_until: 20_000 }, {}]) {
    assert.equal(confirmedExpression(refused, 10_000), null, `${JSON.stringify(refused)} draws no expression`);
  }
  assert.equal(confirmedExpression(window, 10_000).until, 20_000);
  assert.equal(EXPRESSION_MS, 10_000, 'the window the server stores is the window drawn');
  // The state machine puts a stored expression above walking and below a stored seated stance.
  const tracker = createMotionTracker({ clock: () => 10_000 });
  tracker.confirm(resident());
  assert.equal(characterState(resident({ emote: 'cheer', emote_until: 20_000 }), { tracker, time: 10_000 }).state, 'interacting');
  assert.equal(characterState(resident({ posture: 'sitting', emote: 'cheer', emote_until: 20_000 }), { tracker, time: 10_000 }).state, 'seated');
  assert.equal(characterState(resident({ posture: 'meditating' }), { tracker, time: 10_000 }).state, 'seated');
  assert.equal(characterState(resident({ posture: 'floating' }), { tracker, time: 10_000 }).stance, 'standing', 'an unknown stance is not echoed');
  assert.deepEqual(STANCES, ['standing', 'sitting', 'meditating']);
  assert.deepEqual(EXPRESSIONS, ['wave', 'bow', 'cheer', 'think', 'heart']);
});

test('reduced motion snaps: the confirmed tile is drawn and no pose has a frame to animate', () => {
  const { tracker, at, advance } = clocked();
  tracker.confirm(resident());
  advance(500); tracker.confirm(resident({ x: 11 }));
  advance(MOTION_TWEEN_MS / 2);
  // Without the preference the body is drawn mid-segment, on a walk frame.
  const gliding = characterState(resident({ x: 11 }), { tracker, time: at() });
  assert.equal(gliding.state, 'walking');
  assert.ok(gliding.position.x > 10 && gliding.position.x < 11);
  // With it, the drawn position is the *confirmed* tile and the pose is at rest.
  const snapped = characterState(resident({ x: 11 }), { tracker, time: at(), reducedMotion: true });
  assert.deepEqual(snapped.position, { x: 11, y: 6, z: 0 });
  assert.deepEqual(snapped.position, snapped.confirmed, 'the drawn tile is the stored tile');
  assert.equal(snapped.state, 'idle'); assert.equal(snapped.walking, false); assert.equal(snapped.phase, 0); assert.equal(snapped.t, 1);
  assert.equal(snapped.reducedMotion, true);
  // A stored expression still counts, but it holds one still frame for the whole window.
  const item = resident({ emote: 'cheer', emote_until: at() + EXPRESSION_MS });
  const frames = [0, EXPRESSION_MS / 4, EXPRESSION_MS / 2, EXPRESSION_MS * 0.9].map((offset) => characterState(item, { tracker, time: at() + offset, reducedMotion: true }));
  assert.deepEqual(frames.map((state) => state.state), ['interacting', 'interacting', 'interacting', 'interacting']);
  assert.deepEqual(frames.map((state) => state.expressionFrame), [EXPRESSION_ACTION_FRAME, EXPRESSION_ACTION_FRAME, EXPRESSION_ACTION_FRAME, EXPRESSION_ACTION_FRAME]);
  const poses = frames.map((state) => characterPose(state));
  assert.equal(new Set(poses.map((pose) => JSON.stringify(pose))).size, 1, 'the reduced-motion pose never moves');
  assert.equal(poses[0].swing, 0); assert.equal(poses[0].sway, 0);
  // The drawn boxes are identical at every sampled instant of the stored window.
  const drawn = [0, EXPRESSION_MS / 3, EXPRESSION_MS / 2, EXPRESSION_MS * 0.95]
    .map((offset) => JSON.stringify(characterBoxes(item, null, { tracker, time: at() + offset, reducedMotion: true })));
  assert.equal(new Set(drawn).size, 1, 'reduced motion draws one still body');
  // A seated stance keeps its exact drop under the preference too, and the walk never runs.
  const seated = characterState(resident({ posture: 'meditating' }), { tracker, time: at(), reducedMotion: true });
  assert.equal(seated.state, 'seated');
  assert.equal(characterPose(seated).lift, -SEATED_LIFT);
  assert.equal(characterState(resident({ y: 7 }), { tracker, time: at(), reducedMotion: true }).position.y, 7);
});

test('every pose is a bounded function of the confirmed state', () => {
  const tracker = createMotionTracker({ clock: () => 1_000 });
  tracker.confirm(resident());
  const idle = characterPose(characterState(resident(), { tracker, time: 1_000 }));
  assert.deepEqual({ ...idle }, {
    state: 'idle', stance: 'standing', phase: 0, seated: false, lift: 0, legDepth: 0.62, legForward: 0, legAcross: 0,
    footForward: 0.05, footAcross: 0, swing: 0, sway: 0, arm: { left: 'down', right: 'down' }, lean: 0,
  });
  // The two stored seated stances are two different poses, both dropped by exactly SEATED_LIFT.
  const sitting = characterPose(characterState(resident({ posture: 'sitting' }), { tracker, time: 1_000 }));
  const meditating = characterPose(characterState(resident({ posture: 'meditating' }), { tracker, time: 1_000 }));
  assert.equal(sitting.seated, true); assert.equal(sitting.lift, -SEATED_LIFT);
  assert.equal(meditating.seated, true); assert.equal(meditating.lift, -SEATED_LIFT);
  assert.equal(sitting.swing, 0, 'a seated resident is never mid-stride');
  assert.notDeepEqual({ ...sitting }, { ...meditating }, 'sitting and meditating are not one pose twice');
  assert.ok(sitting.legDepth !== meditating.legDepth && sitting.footForward !== meditating.footForward);
  for (const pose of Object.values({ sitting, meditating })) for (const [key, value] of Object.entries(pose)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} is a finite number`);
  }
  // Every staged expression frame is a finite, bounded pose, and the arm pairs are authored poses.
  for (const action of EXPRESSIONS) {
    const seen = [];
    for (const offset of [0, 1_500, 5_500, 8_000]) {
      const state = characterState(resident({ emote: action, emote_until: 20_000 }), { tracker, time: 10_000 + offset });
      const pose = characterPose(state);
      seen.push(pose);
      assert.equal(state.expressionFrame, offset === 0 ? 0 : offset === 1_500 ? 1 : offset === 5_500 ? 2 : 3, `${action} at +${offset} ms`);
      for (const [key, value] of Object.entries(pose)) if (typeof value === 'number') assert.ok(Number.isFinite(value) && (key !== 'lift' || value <= 0), `${action}.${key} is bounded`);
      assert.ok(['down', 'rise', 'up', 'head', 'out', 'forward', 'point', 'lap', 'clasp'].includes(pose.arm.left), `${action} names an authored left arm pose`);
      assert.ok(['down', 'rise', 'up', 'head', 'out', 'forward', 'point', 'lap', 'clasp'].includes(pose.arm.right), `${action} names an authored right arm pose`);
      assert.ok(pose.lean >= 0 && pose.lean <= 1, `${action} leans within its own bound`);
    }
    assert.equal(new Set(seen.map((pose) => JSON.stringify(pose))).size, EXPRESSION_FRAMES, `${action} plays ${EXPRESSION_FRAMES} different poses`);
  }
  assert.deepEqual([...LEANING_EXPRESSIONS].sort(), ['bow', 'think'], 'the two expressions that lean are named, not implied');
  for (const action of EXPRESSIONS) {
    const leaning = [0, 1_500, 5_500, 8_000].some((offset) => characterPose(characterState(resident({ emote: action, emote_until: 20_000 }), { tracker, time: 10_000 + offset })).lean > 0);
    assert.equal(leaning, LEANING_EXPRESSIONS.includes(action), `${action} leans iff it is named as leaning`);
  }
  // The stride swings the legs along the confirmed direction of travel, and the arms the other way.
  let clock = 5_000;
  const walking = createMotionTracker({ clock: () => clock });
  walking.confirm(resident());
  clock += 500; walking.confirm(resident({ x: 11 }));
  const frames = [0, MOTION_TWEEN_MS * .25, MOTION_TWEEN_MS * .5, MOTION_TWEEN_MS * .75].map((offset) =>
    characterPose(characterState(resident({ x: 11 }), { tracker: walking, time: clock + offset })));
  assert.deepEqual(frames.map((frame) => frame.state), ['walking', 'walking', 'walking', 'walking']);
  assert.deepEqual(frames.map((frame) => frame.phase), [0, 1, 2, 3]);
  assert.deepEqual(frames.map((frame) => frame.swing), [1, 0, -1, 0], 'the sealed four-frame swing cycle');
  assert.deepEqual(frames.map((frame) => frame.sway), [0, WALK_SWAY, 0, -WALK_SWAY], 'and the body rocks with it');
  assert.deepEqual(frames.map((frame) => frame.lift), [0, -WALK_BOB, 0, -WALK_BOB], 'and dips, never rises');
  assert.equal(WALK_SWING, 0.09);
  // The drawn geometry moves with the stride and stays inside the participant's own tile.
  const list = [];
  const cubes = { list, add: (x, height, y, width, depth, length, color, pick) => list.push({ x, height, y, width, depth, length, color, pick }) };
  paintCharacter(cubes, resident({ x: 11 }), null, { tracker: walking, time: clock + MOTION_TWEEN_MS * .25 });
  const resting = [];
  paintCharacter({ add: (x, height, y, width, depth, length, color, pick) => resting.push({ x, height, y, width, depth, length, color, pick }) }, resident({ x: 11 }), null, { tracker: walking, time: clock + 500 });
  assert.equal(list.length, resting.length, 'a stride never adds or removes a body box');
  for (const [index, cube] of list.entries()) {
    // The drawn body may sit anywhere on the segment between the two confirmed tiles, plus a limb
    // offset; it never walks off the confirmed segment, and it never leaves the tile it is drawn on.
    assert.ok(cube.x >= 10.5 - 0.5 && cube.x <= 11.5 + 0.5, `${cube.x} stays on the confirmed segment`);
    assert.ok(Math.abs(cube.y - 6.5) <= 0.5, `${cube.y} stays on the confirmed segment`);
    assert.ok(cube.height >= 0);
    assert.deepEqual(cube.pick, resting[index].pick, 'a stride never moves a pick off the confirmed tile');
    assert.equal(cube.pick.x, 11); assert.equal(cube.pick.y, 6);
  }
  const striding = [0, MOTION_TWEEN_MS * .5].map((offset) => {
    const frame = [];
    paintCharacter({ add: (x, height, y, width, depth, length, color, pick) => frame.push({ x, height, y, color, pick }) }, resident({ x: 11 }), null, { tracker: walking, time: clock + offset });
    return frame;
  });
  assert.notDeepEqual(striding[0].map((cube) => cube.x), striding[1].map((cube) => cube.x), 'the limbs are drawn somewhere else between walk frames');
  assert.deepEqual(striding[0].map((cube) => cube.pick.x), striding[1].map((cube) => cube.pick.x), 'but the pick stays on the confirmed tile');
});

test('the facing is the confirmed step, else the stored yaw, else a safe default', () => {
  assert.equal(confirmedFacing({ yaw: 0 }), 'up');
  assert.equal(confirmedFacing({ yaw: Math.PI / 2 }), 'left');
  assert.equal(confirmedFacing({ yaw: Math.PI }), 'down');
  assert.equal(confirmedFacing({ yaw: -Math.PI / 2 }), 'right');
  assert.equal(confirmedFacing({ yaw: 9 }), confirmedFacing({ yaw: 9 - 2 * Math.PI * Math.floor(9 / (2 * Math.PI)) }), 'the yaw wraps');
  assert.equal(confirmedFacing({}), 'down', 'a missing yaw is a neutral facing, not an invented one');
  assert.equal(confirmedFacing({ yaw: NaN }), 'down');
  // A confirmed step wins over the stored yaw: the walk direction is what the server stored.
  assert.equal(confirmedFacing({ yaw: 0 }, { from: { x: 5, y: 5 }, to: { x: 6, y: 5 } }), 'right');
  assert.equal(confirmedFacing({ yaw: Math.PI }, { from: { x: 5, y: 5 }, to: { x: 5, y: 5 } }), 'down', 'a zero step falls back to the yaw');
  assert.deepEqual(Object.keys(facingStep('nowhere')), ['x', 'y']);
  // The body frame is a rotation: a quarter turn maps across to the other ground axis.
  const down = facingFrame('down'), right = facingFrame('right');
  assert.deepEqual([down.forward.x, down.forward.y, down.across.x, down.across.y, down.swap], [0, 1, 1, 0, false]);
  assert.deepEqual([right.forward.x, right.forward.y, right.across.x, right.across.y, right.swap], [1, 0, 0, -1, true]);
  for (const facing of ['down', 'up', 'left', 'right']) {
    const frame = facingFrame(facing);
    const dot = frame.forward.x * frame.across.x + frame.forward.y * frame.across.y;
    assert.ok(Math.abs(dot) < 1e-12, `${facing} keeps the two axes perpendicular`);
    assert.equal(Math.abs(frame.forward.x) + Math.abs(frame.across.x), 1, `${facing} keeps unit axes`);
  }
});

test('the tracked set stays inside the renderer participant bound', () => {
  const tracker = createMotionTracker({ clock: () => 1_000, limit: 3 });
  for (const id of ['a', 'b', 'c']) tracker.confirm({ id, x: 1, y: 1 });
  assert.equal(tracker.size, 3);
  tracker.confirm({ id: 'd', x: 2, y: 2 });
  assert.equal(tracker.size, 3, 'the least recently confirmed record leaves first');
  assert.equal(tracker.position('a'), null);
  assert.equal(tracker.position('d')?.x, 2);
  tracker.clear();
  assert.equal(tracker.size, 0);
  assert.equal(MOTION_LIMITS.records, 220);
});

test('a real confirmed move, a real refusal and a real stored expression drive the module', async (t) => {
  const f = await fixture(t), agent = f.agent('alice', 'Aster');
  const commons = getWorldDefinition('commons');
  const start = { x: 10, y: 6 };
  f.platform.run("UPDATE agents SET world_id='commons',x=?,y=?,z=0,grounded=1 WHERE id=?", start.x, start.y, agent.id);
  const tracker = createMotionTracker({ clock: () => f.clock() });
  const view = () => f.platform.world(f.actor('alice'), { world_id: 'commons', agent_id: agent.id });
  const participant = () => view().participants.find((item) => item.id === agent.id);
  // First sight: the confirmed tile the server stored.
  const first = participant();
  assert.equal(tracker.confirm(first).snapped, true);
  assert.deepEqual([tracker.position(agent.id).x, tracker.position(agent.id).y], [first.x, first.y]);
  assert.equal(characterState(first, { tracker, time: f.clock() }).state, 'idle');
  // One real server step: the stored tile is the newest confirmed one, and the display glides to it.
  f.advance(200);
  const step = f.tx('moveAgent', f.actor('alice'), { agent_id: agent.id, direction: 'right' });
  assert.equal(step.blocked, false, 'the fixture tile to the right is walkable');
  assert.equal(walkable({ x: step.x, y: step.y }, commons), true, 'the server walked onto a tile the shared table calls walkable');
  const stored = participant();
  assert.deepEqual([stored.x, stored.y, stored.z], [step.x, step.y, step.z]);
  assert.equal(stored.posture, 'standing', 'a step stores the standing stance');
  assert.deepEqual(tracker.confirm(stored), { changed: true, snapped: false });
  const half = tracker.position(agent.id, f.clock() + MOTION_TWEEN_MS / 2);
  assert.ok(half.x > start.x && half.x < step.x, 'the drawn position is between the two confirmed tiles');
  const midway = characterState(stored, { tracker, time: f.clock() + MOTION_TWEEN_MS / 2 });
  assert.equal(midway.state, 'walking');
  assert.equal(midway.facing, 'right', 'the facing is the direction of the confirmed step');
  assert.deepEqual([tracker.position(agent.id, f.clock() + MOTION_TWEEN_MS).x], [step.x], 'and it lands exactly on the newest confirmed tile');
  assert.equal(characterState(stored, { tracker, time: f.clock() + MOTION_TWEEN_MS }).state, 'idle');
  // The reduced-motion draw of the very same step snaps to the stored tile instead of gliding.
  const snapped = characterState(stored, { tracker, time: f.clock() + MOTION_TWEEN_MS / 2, reducedMotion: true });
  assert.deepEqual([snapped.position.x, snapped.position.y], [step.x, step.y]);
  assert.equal(snapped.state, 'idle');
  // A refused move leaves the stored tile alone and reconciles the display to it. The server refuses
  // a second step inside its 120 ms throttle, which is the refusal path the application reconciles.
  f.advance(200);
  const firstStep = f.tx('moveAgent', f.actor('alice'), { agent_id: agent.id, direction: 'up' });
  assert.equal(firstStep.blocked, false);
  tracker.confirm(participant());
  let refused;
  try { f.tx('moveAgent', f.actor('alice'), { agent_id: agent.id, direction: 'up' }); } catch (error) { refused = error; }
  assert.equal(refused?.status, 429, 'the server refuses a second step inside its own throttle');
  assert.match(refused.message, /slowly/i, 'and states its own refusal');
  const after = participant();
  assert.deepEqual([after.x, after.y], [firstStep.x, firstStep.y], 'the stored position did not move');
  assert.equal(tracker.confirm(after).changed, false, 'a refused move confirms nothing new');
  tracker.reconcile(agent.id);
  assert.deepEqual([tracker.position(agent.id).x, tracker.position(agent.id).t], [after.x, 1]);
  assert.equal(characterState(after, { tracker, time: f.clock() }).state, 'idle');
  // A real stored expression plays its four staged frames and no more.
  f.advance(200);
  const emoted = f.tx('emote', f.actor('alice'), { agent_id: agent.id, emote: 'cheer' });
  const cheering = participant();
  assert.equal(cheering.emote, 'cheer'); assert.equal(cheering.emote_until, emoted.emote_until);
  const acting = characterState(cheering, { tracker, time: f.clock() });
  assert.equal(acting.state, 'interacting'); assert.equal(acting.action, 'cheer');
  assert.deepEqual({ ...characterPose(acting).arm }, { left: 'rise', right: 'rise' }, 'the anticipation frame');
  const acted = characterState(cheering, { tracker, time: f.clock() + EXPRESSION_MS * 0.3 });
  assert.equal(acted.expressionFrame, 1);
  assert.deepEqual({ ...characterPose(acted).arm }, { left: 'up', right: 'up' }, 'the action frame');
  assert.ok(characterPose(acted).lift < 0, 'and the body dips as it cheers');
  assert.equal(characterState(cheering, { tracker, time: emoted.emote_until }).state, 'idle', 'the stored window is the only window drawn');
  // A stored seated stance survives the poll as a seated pose.
  f.advance(200);
  f.tx('posture', f.actor('alice'), agent.id, { posture: 'sitting' });
  const seated = participant();
  assert.equal(seated.posture, 'sitting');
  assert.equal(characterState(seated, { tracker, time: f.clock() }).state, 'seated');
  assert.equal(characterPose(characterState(seated, { tracker, time: f.clock() })).lift, -SEATED_LIFT);
});

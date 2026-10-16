import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LIVING_ROSTER} from '../src/living-world.js';
import {VILLAGERS, validateVillagers, CALLINGS, PHASES} from '../src/veloren-ext/villagers.js';
import {VelorenLink} from '../src/veloren-link.js';

const KEY = Buffer.from('nemo-test-key-nemo-test-key-1234');
const LANDMARKS = [{id: 'lyra-post', name: 'Post', role: 'post'}, {id: 'lyra-survey', name: 'Field', role: 'survey'}];
const doc = () => JSON.parse(readFileSync(new URL('../content/veloren-villagers.json', import.meta.url), 'utf8'));
const PLACES = new Set([
  ...JSON.parse(readFileSync(new URL('../content/veloren-world-landmarks.json', import.meta.url), 'utf8')).landmarks.map(l => l.label),
  ...JSON.parse(readFileSync(new URL('../content/veloren-landmarks-extra.json', import.meta.url), 'utf8')).landmarks.map(l => l.label),
]);
const place = (labels) => [...PLACES, ...labels];

test('the village is 24 valid, distinct residents who do not collide with the roster', () => {
  assert.equal(VILLAGERS.length, 24);
  const everyone = [...LIVING_ROSTER, ...VILLAGERS];
  assert.equal(new Set(everyone.map(r => r.id)).size, everyone.length, 'ids are unique');
  assert.equal(new Set(everyone.map(r => r.name.split(' ')[0].toLowerCase())).size, everyone.length, 'first names (Veloren names) are unique');
  for (const r of VILLAGERS) assert.ok(CALLINGS.includes(r.calling));
  assert.deepEqual([...new Set(VILLAGERS.map(r => r.role))].sort(), ['builder', 'courier', 'farmer', 'keeper', 'maker', 'scholar']);
});

test('every routine uses a real Harr place, and the village is spread over the day', () => {
  for (const r of VILLAGERS) for (const phase of PHASES) assert.ok(PLACES.has(r.destinations[phase].label), `${r.id} ${phase}: ${r.destinations[phase].label} is not a Harr place`);
  for (const phase of PHASES) {
    const spread = new Set(VILLAGERS.map(r => r.destinations[phase].label));
    assert.ok(spread.size >= 3, `at ${phase} the village is in ${spread.size} place(s), expected at least 3`);
  }
});

test('bad village data is refused with a reason', () => {
  const bad = (change, pattern) => { const d = doc(); change(d); assert.throws(() => validateVillagers(d), pattern); };
  bad(d => { d.residents[0].id = 'lw-aria'; }, /id is invalid or already used/);
  bad(d => { d.residents[1].name = 'Aria Duplicate'; }, /first name is already used/);
  bad(d => { d.residents[2].id = 'LW_UPPER'; }, /id is invalid/);
  bad(d => { d.residents[3].calling = 'warlord'; }, /unknown calling/);
  bad(d => { delete d.residents[4].destinations.night; }, /no destination for night/);
  bad(d => { d.residents[5].barks = []; }, /barks/);
  bad(d => { d.residents[6].barks = ['<script>alert(1)</script>']; }, /barks/);
  bad(d => { d.residents[7].name = 'lower case'; }, /name is invalid/);
  bad(d => { d.format = 'other'; }, /Not a veloren-villagers-v1/);
});

test('a village resident can have a scoped credential and talk (scripted, no model, no authority)', async t => {
  const link = new VelorenLink({dbPath: ':memory:', eventKey: KEY, landmarks: LANDMARKS});
  t.after(() => link.close());
  const cred = link.issueCredential({resident_id: 'lw-marisol', scopes: ['talk', 'director'], days: 1});
  assert.equal(link.authenticate(cred.token, 'talk').resident_id, 'lw-marisol');
  assert.throws(() => link.issueCredential({resident_id: 'lw-nobodyhere', scopes: ['talk']}), /Unknown resident/);
  const talk = link.authenticate(cred.token, 'talk');
  const reply = await link.talk(talk, {resident_id: 'lw-marisol', player_uuid: '11111111-1111-4111-8111-111111111111', player_alias: 'Tester', text: 'Who are you?'}, null);
  assert.equal(reply.source, 'scripted');
  assert.match(reply.reply, /^I am Marisol Fernwick, cultivator\./);
  await assert.rejects(link.talk(talk, {resident_id: 'lw-aria', player_uuid: '11111111-1111-4111-8111-111111111111', text: 'hi'}, null), e => e.status === 403, 'a credential speaks only as its own resident');
});

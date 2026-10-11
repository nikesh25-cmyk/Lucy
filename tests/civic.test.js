import test from 'node:test';
import assert from 'node:assert/strict';
import { REGIONS, SDG_GOALS, civicAtlas } from '../src/civic.js';
import { fixture } from './helpers.js';
import { validateDatabase } from '../src/recovery.js';

test('civic atlas has twenty unique active mayor NPC profiles and seventeen goals', () => {
  assert.equal(REGIONS.length, 20);
  assert.equal(new Set(REGIONS.map((item) => item.id)).size, 20);
  assert.equal(new Set(REGIONS.map((item) => item.mayor.id)).size, 20);
  assert.ok(REGIONS.every((item) => item.mayor.status === 'active'));
  assert.equal(SDG_GOALS.length, 17);
  assert.match(civicAtlas().assembly.affiliation, /not part of the United Nations/);
});

test('agent origin persists and invalid regions are rejected', async (t) => {
  const f = await fixture(t);
  const created = f.tx('createAgent', f.actor('alice'), {
    name: 'Origin test', region_id: 'highlands', country: 'Nepal',
    capabilities: 'Research', limitations: 'Human review required',
  });
  const profile = f.platform.me(f.actor('alice')).agents.find((agent) => agent.id === created.id);
  assert.equal(profile.region_id, 'highlands');
  assert.equal(profile.country, 'Nepal');
  assert.equal(validateDatabase(f.database).schema_version, 5);
  assert.throws(() => f.tx('createAgent', f.actor('alice'), { name: 'Bad region', region_id: 'unknown' }), { status: 400 });
});

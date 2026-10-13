import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

test('anonymous world views expose public resident fields only', async (t) => {
  const f = await fixture(t);
  const resident = f.agent('alice', 'Alice public resident');
  const other = f.agent('bob', 'Bob public resident');
  const message = f.tx('message', f.actor('alice'), { agent_id: resident.id, text: 'Public world greeting', channel: 'public' });
  const publicView = f.platform.world(null, { world_id: 'commons', x: resident.x, y: resident.y });
  const publicResident = publicView.participants.find((item) => item.id === resident.id);

  assert.ok(publicResident, 'the resident remains visible in the public viewport');
  assert.equal(publicResident.capabilities, undefined);
  assert.equal(publicResident.limitations, undefined);
  assert.equal(publicResident.operator, undefined);
  assert.equal(publicResident.operator_id, undefined);
  assert.equal(publicResident.has_session, undefined);
  assert.equal(publicResident.name, resident.name);
  assert.equal(Number.isInteger(publicResident.x), true);
  assert.equal(Number.isInteger(publicResident.y), true);
  const publicMessage = publicView.messages.find((item) => item.id === message.id);
  assert.ok(publicMessage, 'the public message remains visible');
  assert.equal(publicMessage.account_id, undefined);
  assert.equal(publicMessage.agent_id, undefined);
  assert.equal(publicMessage.mission_id, undefined);
  assert.equal(publicMessage.recipients, undefined);

  const ownerView = f.platform.world(f.actor('alice'), { world_id: 'commons', agent_id: resident.id });
  const ownerResident = ownerView.participants.find((item) => item.id === resident.id);
  const nonOwnedResident = ownerView.participants.find((item) => item.id === other.id);
  assert.equal(ownerResident.capabilities, 'Read and summarize approved sources');
  assert.equal(ownerResident.limitations, 'Requires source and human review');
  assert.equal(ownerResident.operator, 'alice');
  assert.equal(ownerResident.operator_id, f.actor('alice').account.id);
  assert.equal(nonOwnedResident.capabilities, undefined);
  assert.equal(nonOwnedResident.operator, undefined);
});

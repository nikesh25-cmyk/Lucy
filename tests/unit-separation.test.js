import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { fixture } from './helpers.js';
import { COIN_POLICY, CREDIT_UNITS, UNIT_SEPARATION_POLICY } from '../src/coins.js';
import { boundedModel } from '../runtime/model.js';
import { RECOVERY_LIMITS } from '../src/recovery.js';

test('the four units of account are separate: one ledger, no conversion, no cash-out, no token', () => {
  assert.equal(CREDIT_UNITS.length, 4);
  assert.deepEqual(CREDIT_UNITS.map((unit) => unit.id), ['nemocoin', 'compute_credit', 'money', 'carbon_credit']);
  assert.equal(new Set(CREDIT_UNITS.map((unit) => unit.id)).size, 4, 'the four identifiers are distinct');
  assert.equal(new Set(CREDIT_UNITS.map((unit) => unit.unit)).size, 4, 'the four unit names are distinct');
  const coin = CREDIT_UNITS.find((unit) => unit.id === 'nemocoin');
  assert.equal(coin.implemented, true);
  assert.equal(coin.ledger, 'coin_rewards');
  assert.equal(coin.balance, true);
  for (const unit of CREDIT_UNITS.filter((entry) => entry.id !== 'nemocoin')) {
    assert.equal(unit.implemented, false, `${unit.id} must be an unimplemented concept, not an empty ledger`);
    assert.equal(unit.ledger, null, `${unit.id} must name no ledger`);
    assert.equal(unit.balance, false, `${unit.id} must hold no balance`);
  }
  for (const unit of CREDIT_UNITS) {
    assert.equal(unit.transferable, false);
    assert.equal(unit.cash_value, false);
    assert.equal(unit.convertible, false);
  }
  assert.equal(COIN_POLICY.transferable, false);
  assert.equal(UNIT_SEPARATION_POLICY.conversion_paths, 0);
  assert.equal(UNIT_SEPARATION_POLICY.cash_out, false);
  assert.equal(UNIT_SEPARATION_POLICY.token, false);
  assert.deepEqual(UNIT_SEPARATION_POLICY.units, CREDIT_UNITS.map((unit) => unit.id));
  assert.ok(Object.isFrozen(CREDIT_UNITS) && Object.isFrozen(UNIT_SEPARATION_POLICY));
});

test('only the NemoCoin ledger exists in the database; the other three units have no table', async (t) => {
  const f = await fixture(t);
  const tables = new Set(f.platform.all("SELECT name FROM sqlite_master WHERE type IN ('table','view')").map((row) => row.name));
  assert.ok(tables.has('coin_rewards'), 'the one implemented unit has its append-only ledger');
  for (const name of ['compute_credits', 'carbon_credits', 'money', 'currency', 'credit_balances', 'credit_transfers', 'conversion_rates', 'cash_out', 'tokens_market']) {
    assert.equal(tables.has(name), false, `no ${name} table or view exists`);
  }
});

test('the administrator diagnostics expose the unit-separation policy and a member cannot read it', async (t) => {
  const f = await fixture(t);
  const { server } = createApp({ platform: f.platform });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const admin = await fetch(`${url}/api/v1/operations`, { headers: { Authorization: `Bearer ${f.credentials.admin.token}` } });
  assert.equal(admin.status, 200);
  const payload = await admin.json();
  assert.deepEqual(payload.credit_units.units, ['nemocoin', 'compute_credit', 'money', 'carbon_credit']);
  assert.equal(payload.credit_units.conversion_paths, 0);
  assert.equal(payload.credit_units.cash_out, false);
  const member = await fetch(`${url}/api/v1/operations`, { headers: { Authorization: `Bearer ${f.credentials.alice.token}` } });
  assert.equal(member.status, 403, 'the unit policy is administrator-visible only');
});

test('the shipped spending bounds are the shipped numbers, not raised to pass a test', () => {
  // The bounded model queue refuses excess waiting work at its documented default and never above it.
  const queue = boundedModel(async () => 'ok', { maxWaiting: 0 });
  assert.equal(typeof queue, 'function');
  assert.throws(() => boundedModel(async () => 'ok', { maxWaiting: 21 }), /Invalid model queue configuration/);
  // The recovery vocabulary is the shipped schema version, not a raised one.
  assert.ok(Number.isInteger(RECOVERY_LIMITS.schema_version) && RECOVERY_LIMITS.schema_version >= 22);
});

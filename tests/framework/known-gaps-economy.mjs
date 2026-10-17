#!/usr/bin/env node
// Known gaps in the Wave 5 economy that this slice must not fix.
//
// This file is deliberately NOT discovered by the test runner: its name is neither `*.test.mjs` nor
// under a directory called `test/`, so `npm test` stays green while these defects stay reproducible.
// Run it by hand:
//
//   node tests/framework/known-gaps-economy.mjs
//
// Each reproduction states the command, the invariant it expects, what is observed instead, and who
// owns the fix. The file fails (exit 1) while any reproduction still reproduces, and passes once they
// are fixed — which is what a reproducible failing test for an unfixable-in-this-slice defect is for.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from '../helpers.js';
import { Platform } from '../../src/platform.js';
import { ensureTradeMarket } from '../../src/trade-market.js';
import { backupDatabase } from '../../src/recovery.js';
import { KARMA_POLICY, karmaReceiptHash, verifyKarmaLedger } from '../../src/karma.js';
import { verifyTradeRecords } from '../../src/trade-board.js';
import { SHOP_CATALOGUE } from '../../src/shop.js';
import { verifyCoinLedger } from '../../src/coins.js';

// The same fixture the suites use, reduced to what a standalone script needs: two operators, a
// movable clock and the transaction helper.
async function scene(body) {
  const directory = await mkdtemp(join(tmpdir(), 'known-gaps-'));
  const database = join(directory, 'platform.sqlite');
  let now = Date.now();
  const platform = new Platform(database, () => now);
  const password = 'local-test-password-2026';
  const credentials = {};
  try {
    credentials.admin = await platform.register({ name: 'Admin', email: 'admin@example.org', password, consent: true });
    for (const [name, role] of [['alice', 'member'], ['bob', 'member']]) {
      const invite = platform.transaction(() => platform.invite(platform.authenticate(credentials.admin.token), { role }));
      credentials[name] = await platform.register({ name, email: `${name}@example.org`, password, consent: true, invite: invite.code });
    }
    const actor = (name) => platform.authenticate(credentials[name].token);
    const tx = (method, ...args) => platform.transaction(() => platform[method](...args));
    const agent = (owner) => tx('createAgent', actor(owner), { name: `${owner} resident`, capabilities: 'Fixture', limitations: 'Fixture', color: '#397f79', symbol: '✦' });
    await body({ platform, database, directory, credentials, actor, tx, agent, advance: (milliseconds) => { now += milliseconds; } });
  } finally {
    try { platform.close(); } catch { /* the repro may already have closed it */ }
    await rm(directory, { recursive: true, force: true });
  }
}
const farmTile = (platform, agent, x) => {
  platform.run('UPDATE agents SET world_id=? WHERE id=?', `home:${agent.id}`, agent.id);
  platform.run("INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,'farm',?,?,?) ON CONFLICT(world_id,x,y) DO UPDATE SET type='farm'", `farm-${agent.id}-${x}`, `home:${agent.id}`, x, 6, new Date(platform.clock()).toISOString());
};
const findings = [];
const gap = async (title, { invariant, observed, owner, kind }, body) => {
  try {
    await body();
    findings.push({ title, invariant, observed: `fixed if this line executes; not reproduced`, owner, kind, reproduced: false });
    process.stdout.write(`FIXED        ${title}\n`);
  } catch (error) {
    findings.push({ title, invariant, observed, owner, kind, reproduced: true, error: error.message.split('\n')[0] });
    process.stdout.write(`REPRODUCED   ${title}\n`);
  }
};

process.stdout.write('Known economy gaps — each one is a defect or a decision this slice must not fix.\n\n');

// ------------------------------------------------------------------------------------------------
// 1. A forged Karma receipt whose source id never existed is indistinguishable from an honest one
//    whose source the world has legitimately forgotten.
// ------------------------------------------------------------------------------------------------
await gap('a forged Karma receipt with a fabricated source id passes every ledger gate', {
  kind: 'confirmed-defect',
  invariant: 'A receipt minted for a source row the world never held must fail the ledger check (verifyKarmaLedger) and the backup gate (validateDatabase), so recovery can refuse it.',
  observed: 'verifyKarmaLedger returns true and validateDatabase accepts the file: the trigger that proves a source row existed at mint time is dropped in the copy, the absence of the row is treated as legitimate forgetting, and the hash chain is recomputed, so neither check can tell the two apart.',
  owner: 'Karma/shop owner (src/karma.js verifyKarmaLedger; the mint trigger karma_receipts_validate_insert) — needs the integrator to decide whether absence should be provable, for instance by recording a source digest in the receipt.',
}, async () => {
  await scene(async ({ platform, database, credentials, actor, tx, agent }) => {
    const alice = agent('alice');
    farmTile(platform, alice, 6);
    tx('gardenAction', actor('alice'), { agent_id: alice.id, action: 'plant', kind: 'herbs', x: 6, y: 6 });
    assert.equal(tx('karmaSettle', actor('alice'), { agent_id: alice.id }).minted, 1, 'the fixture earns one honest receipt');
    const forged = join(join(database, '..'), 'forged.sqlite');
    backupDatabase(platform.db, forged);
    const copy = new DatabaseSync(forged);
    copy.exec('DROP TRIGGER karma_receipts_validate_insert');
    const created = new Date().toISOString();
    const row = {
      id: randomUUID(), agent_id: alice.id, account_id: actor('alice').account.id, service_id: 'garden_crop', tier: 'world',
      source_kind: 'crop_plant', source_id: '99:99:1', source_at: created, amount: 2, per_day: 2, requires_other_operator: 0,
      award_day: created.slice(0, 10), policy_version: KARMA_POLICY.version, created_at: created,
      previous_hash: copy.prepare('SELECT hash FROM karma_receipts ORDER BY seq DESC LIMIT 1').get().hash,
    };
    row.hash = karmaReceiptHash(row);
    copy.prepare('INSERT INTO karma_receipts(id,agent_id,account_id,service_id,tier,source_kind,source_id,source_at,amount,per_day,requires_other_operator,award_day,policy_version,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id, row.agent_id, row.account_id, row.service_id, row.tier, row.source_kind, row.source_id, row.source_at, row.amount, row.per_day, row.requires_other_operator, row.award_day, row.policy_version, row.created_at, row.previous_hash, row.hash);
    copy.close();
    const check = new DatabaseSync(forged, { readOnly: true });
    const verdict = verifyKarmaLedger(check);
    check.close();
    // The invariant: a receipt citing a source row that never existed is a finding.
    assert.equal(verdict, false, 'a forged receipt citing a source row the world never held must fail the ledger check');
  });
});

// ------------------------------------------------------------------------------------------------
// 2. A resource bundle bought with Karma stays transferable, so Karma still reaches another account
//    as goods — the path the owner's own handoff names as a design decision.
// ------------------------------------------------------------------------------------------------
await gap('goods bought with Karma remain transferable between operators', {
  kind: 'design-decision',
  invariant: 'Karma-funded value never leaves the account that earned it: what Karma bought may be used by that account and no other.',
  observed: 'A resource bundle bought with Karma lands on the shelf as the same sealed crop kind a harvest yields, so it can be listed, claimed or offered to another operator: the goods arrive. The arithmetic bounds it (a shop purchase costs at least 8 of the 60 Karma a day an account can earn, and the shop bounds each good per account per day), so at most about 60 Karma of goods a day can take this route, and the Karma Coin itself never moves. Cosmetics bought with Karma are account-bound by src/goods-policy.js; the resource half was left transferable because a bought crop kind and a grown one are one fungible shelf row and refusing the kind would refuse a resident its own harvest.',
  owner: 'Design decision for the Karma/shop owner and the integrator: closing it needs the shop grant to record provenance per unit (a separate shelf row, or an account-bound flag on the grant), which is a schema and shop change outside this slice.',
}, async () => {
  await scene(async ({ platform, actor, tx, agent, advance }) => {
    const alice = agent('alice'), bob = agent('bob');
    ensureTradeMarket(platform);
    // Two UTC days of two crops a day: eight Karma, exactly one resource bundle.
    for (let index = 0; index < 2; index += 1) {
      if (index) advance(25 * 3_600_000);
      for (const x of [4 + index * 2, 5 + index * 2]) {
        farmTile(platform, alice, x);
        tx('gardenAction', actor('alice'), { agent_id: alice.id, action: 'plant', kind: 'herbs', x, y: 6 });
      }
      tx('karmaSettle', actor('alice'), { agent_id: alice.id });
    }
    assert.equal(platform.karmaWallet(actor('alice'), { agent_id: alice.id }).balance, 8, 'the fixture earns exactly one bundle');
    tx('shopPurchase', actor('alice'), { good_id: 'herbs', agent_id: alice.id }, 'gap-buy-1');
    const held = platform.get("SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind='herbs'", alice.id).quantity;
    assert.ok(held >= 2, 'the Karma bought two herb crops');
    // The invariant: the herbs Karma bought never reach the other operator.
    const listing = tx('tradePost', actor('alice'), { agent_id: alice.id, items: { herbs: held } }, 'gap-post-1');
    const claim = tx('tradeClaim', actor('bob'), { agent_id: bob.id, listing_id: listing.id }, 'gap-claim-1');
    assert.deepEqual(claim.items, {}, 'a Karma-funded crop kind must not be claimable by another operator');
  });
});

// ------------------------------------------------------------------------------------------------
// 3. The wallet read is open to a resident's own runtime credential (the owner's stated open question).
// ------------------------------------------------------------------------------------------------
await gap('a resident runtime credential can read the operator\u2019s Karma purse', {
  kind: 'design-decision',
  invariant: 'A resident\u2019s own runtime credential reads what belongs to the resident; the operator\u2019s purse is the operator\u2019s.',
  observed: 'GET /karma and platform.karmaWallet succeed for an agent runtime credential with read scope, and the projection is the whole operator purse: balance, every receipt, every purchase, the daily allowance. The shop read and a purchase are session-only, so only the wallet read is open.',
  owner: 'Karma/shop owner (src/karma.js karmaWallet, the open route scope in server.js) — ship or narrow it deliberately; docs/API.md already states the current behaviour.',
}, async () => {
  await scene(async ({ platform, tx, actor, agent }) => {
    const alice = agent('alice');
    farmTile(platform, alice, 6);
    tx('gardenAction', actor('alice'), { agent_id: alice.id, action: 'plant', kind: 'herbs', x: 6, y: 6 });
    tx('karmaSettle', actor('alice'), { agent_id: alice.id });
    const runtime = tx('runtime', actor('alice'), alice.id, { minutes: 10, max_calls: 10, scopes: ['read'] });
    const credential = platform.authenticate(runtime.token);
    let error = null;
    try { platform.karmaWallet(credential, { agent_id: alice.id }); } catch (caught) { error = caught; }
    assert.ok(error, 'a resident credential must not read the operator\u2019s purse');
  });
});

// ------------------------------------------------------------------------------------------------
// 4. The shop's account-bound object path has no shipped good, so it cannot be exercised.
// ------------------------------------------------------------------------------------------------
await gap('the shop stocks no object good, so the object entitlement path is untested', {
  kind: 'untested',
  invariant: 'Every class the classification names has at least one shipped instance, so the rule can be exercised rather than only read.',
  observed: 'SHOP_CATEGORIES allows `object` and src/goods-policy.js classifies it (shop_object_grant, account_bound), but validateShopCatalogue deliberately permits a category with no goods, and the catalogue stocks only resources and cosmetics. No shipped good grants an object, so the object grant, its world id and its account-bound refusal have no instance to test.',
  owner: 'Shop owner (src/shop.js SHOP_CATALOGUE / validateShopCatalogue) — either stock one object good or state that the category is reserved and untested.',
}, async () => {
  await scene(async () => {
    assert.notEqual(SHOP_CATALOGUE.find((good) => good.category === 'object'), undefined, 'the shop must stock at least one object good for the object path to be exercisable');
  });
});

process.stdout.write('\nEach reproduction, with its command, invariant, observed behaviour and owner:\n\n');
for (const [index, finding] of findings.entries()) {
  process.stdout.write(`${index + 1}. ${finding.title}\n`);
  process.stdout.write(`   command:   node tests/framework/known-gaps-economy.mjs\n`);
  process.stdout.write(`   kind:      ${finding.kind}\n`);
  process.stdout.write(`   invariant: ${finding.invariant}\n`);
  process.stdout.write(`   observed:  ${finding.observed}\n`);
  process.stdout.write(`   owner:     ${finding.owner}\n`);
  process.stdout.write(`   state:     ${finding.reproduced ? 'REPRODUCED (this file exits 1 while it does)' : 'repaired (this file no longer asserts it)'}\n`);
  if (finding.error) process.stdout.write(`   assertion: ${finding.error}\n`);
  process.stdout.write('\n');
}
const reproduced = findings.filter((finding) => finding.reproduced);
const repaired = findings.filter((finding) => !finding.reproduced);
process.stdout.write(`${findings.length} entries: ${reproduced.length} reproduced, ${repaired.length} repaired.\n`);
if (reproduced.length) process.stdout.write('This file is not discovered by `node --test`, so `npm test` stays green while these stand.\n');
process.exit(reproduced.length ? 1 : 0);

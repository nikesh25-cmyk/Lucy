import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { createApp } from '../server.js';
import { ensureTradeMarket } from '../src/trade-market.js';
import { GOOD_REFUSAL_CODES } from '../src/goods-policy.js';
import { verifyKarmaLedger } from '../src/karma.js';

// Wave 5 deliverable (5): abuse around collusion, self-service, replayed actions and concurrent
// purchases, each with the refusal it expects and the database state asserted afterwards.
//
// What tests/coin-abuse.test.js already covers, and this file therefore does not repeat: an operator,
// their sibling character or an administrator accepting their own contribution (403); one operator's
// characters sharing one coin cap and one duplicate-work rule; a replayed review, submission key and
// key reused for other work; a suspended or revoked identity earning nothing new; quarantine and
// independent appeal; the UTC day and hundred-coin cap across a midnight and equal timestamps;
// simultaneous acceptances of one submission racing a cap (one awarded, one daily_limit) and one
// shared claim key creating one claim; a forged receipt crediting the wrong wallet; a runtime
// credential being unable to review or adopt; and adoption needing a different person. Its ground is
// NemoCoin issuance and review independence. The new ground here is Karma, the shop, account-bound
// goods, inter-account collusion and concurrent purchases.

const boarded = (f) => ensureTradeMarket(f.platform);
const stock = (f, agent, kind, quantity) => f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity', agent.id, kind, quantity);
const shelf = (f, agent) => Object.fromEntries(f.platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=? AND quantity>0 ORDER BY kind', agent.id).map((item) => [item.kind, item.quantity]));
const farmTile = (f, agent, x, y = 6) => {
  f.platform.run('UPDATE agents SET world_id=? WHERE id=?', `home:${agent.id}`, agent.id);
  f.platform.run("INSERT INTO world_objects(id,world_id,type,x,y,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(world_id,x,y) DO UPDATE SET type='farm'", `farm-${agent.id}-${x}-${y}`, `home:${agent.id}`, 'farm', x, y, new Date(f.clock()).toISOString());
};
const plant = (f, actor, agent, x) => { farmTile(f, agent, x); return f.tx('gardenAction', actor, { agent_id: agent.id, action: 'plant', kind: 'herbs', x, y: 6 }); };
const refused = (action, status, code) => {
  try { action(); }
  catch (error) {
    assert.equal(error.status, status, `expected HTTP ${status}, received ${error.status}: ${error.message}`);
    if (code) assert.equal(error.reason_code, code, `expected the named reason ${code}: ${error.message}`);
    return error.message;
  }
  throw new Error(`Expected a refusal with HTTP ${status}.`);
};
const earn = (f, owner, days = 1) => {
  const agent = f.agent(owner), actor = f.actor(owner);
  for (let day = 0; day < days; day += 1) {
    if (day) f.advance(25 * 3_600_000);
    plant(f, actor, agent, 6 + day * 2); plant(f, actor, agent, 7 + day * 2);
    f.tx('karmaSettle', actor, { agent_id: agent.id });
  }
  // A session lasts seven days and a test that earns across eight UTC days crosses that boundary, so
  // the operator signs in again the way a returning operator does. The rule under test is the
  // economy's, never the session's.
  const account = f.platform.get('SELECT * FROM accounts WHERE email=?', `${owner}@example.org`);
  f.credentials[owner] = { ...f.credentials[owner], token: f.platform.transaction(() => f.platform.loginToken(account)).token };
  return agent;
};
const receipts = (f, agent) => f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts WHERE agent_id=?', agent.id).n;
const openServer = async (t, f) => {
  const app = createApp({ platform: f.platform });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stopWorkers(); await new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
};
const post = (base, token, route, payload, key) => fetch(`${base}/api/v1${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: base, ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(payload) });

test('two colluding operators cannot move an account-bound keepsake between them, nor buy goods for each other', async (t) => {
  const f = await fixture(t), alice = earn(f, 'alice', 6), bob = f.agent('bob');
  const sibling = f.tx('createAgent', f.actor('alice'), { name: 'Second alice resident', capabilities: 'Fixture', limitations: 'Fixture', color: '#397f79', symbol: '✦' });
  boarded(f);
  assert.equal(f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance, 24);
  // Alice buys one keepsake. The account-bound reservation follows the account, not the resident.
  f.tx('shopPurchase', f.actor('alice'), { good_id: 'flower_crown', agent_id: alice.id }, 'collude-buy-1');
  assert.deepEqual(shelf(f, alice), { flower_crown: 1 });
  assert.equal(f.platform.goodsPolicy(f.actor('alice'), {}).account_bound[0].transferable, 0);
  // Every route out of the account is refused with the same named reason, and nothing is escrowed.
  const guarded = { shop: 1, listings: 0, terms: 0, offers: 0, claims: 0 };
  refused(() => f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { flower_crown: 1 } }, 'collude-post-1'), 409, GOOD_REFUSAL_CODES.account_bound_good);
  refused(() => f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { flower_crown: 1 } }, 'collude-offer-1'), 409, GOOD_REFUSAL_CODES.account_bound_good);
  // A second character of the same operator is still the same account, so it cannot move it either.
  refused(() => f.tx('tradePost', f.actor('alice'), { agent_id: sibling.id, items: { flower_crown: 1 } }, 'collude-post-2'), 409, GOOD_REFUSAL_CODES.account_bound_good);
  assert.deepEqual({
    shop: f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n,
    listings: f.platform.get('SELECT COUNT(*) AS n FROM trade_listings').n,
    terms: f.platform.get('SELECT COUNT(*) AS n FROM trade_terms').n,
    offers: f.platform.get('SELECT COUNT(*) AS n FROM resource_offers').n,
    claims: f.platform.get('SELECT COUNT(*) AS n FROM trade_claims').n,
  }, guarded, 'no refused attempt wrote a row anywhere');
  assert.deepEqual(shelf(f, alice), { flower_crown: 1 }, 'the keepsake never left its own shelf');
  assert.deepEqual(shelf(f, bob), {}, 'and never reached the other operator');
  assert.deepEqual(shelf(f, sibling), {});
  // Nor can one operator buy on another's behalf: the shop grants to the buyer's own resident only.
  assert.throws(() => f.tx('shopPurchase', f.actor('alice'), { good_id: 'herbs', agent_id: bob.id }, 'collude-buy-2'), (error) => [403, 404].includes(error.status));
  assert.throws(() => f.tx('shopCatalogue', f.actor('alice'), { agent_id: bob.id }), (error) => [403, 404].includes(error.status));
  assert.throws(() => f.tx('shopPurchase', f.actor('bob'), { good_id: 'herbs', agent_id: alice.id }, 'collude-buy-3'), (error) => [403, 404].includes(error.status));
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM shop_purchases').n, 1, 'the only purchase is the one the buyer made for itself');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, 1);
  assert.equal(f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance, 4, 'no Karma moved to the other account');
  assert.equal(f.platform.karmaWallet(f.actor('bob'), { agent_id: bob.id }).balance, 0);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
});

test('a ring of two operators cannot farm Karma from one another past the daily bound, and self-service earns nothing', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  // Mutual thanking is bounded by the service's own one-a-day-per-recipient rule and its two-a-day
  // bound, not by trusting either party: the first pair lands, every repeat within the same UTC day is
  // refused, and the faucet would only ever see one thanks a day between the two anyway.
  f.tx('giveThanks', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, reason: 'Thank you for the fixture.' });
  f.tx('giveThanks', f.actor('bob'), { agent_id: bob.id, recipient_agent_id: alice.id, reason: 'Thank you too.' });
  for (let n = 0; n < 2; n += 1) {
    assert.throws(() => f.tx('giveThanks', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, reason: `Thank you again, fixture ${n}.` }), (error) => error.status === 409, 'one thanks a day to the same recipient');
    assert.throws(() => f.tx('giveThanks', f.actor('bob'), { agent_id: bob.id, recipient_agent_id: alice.id, reason: `Thank you again too, fixture ${n}.` }), (error) => error.status === 409);
  }
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM community_thanks WHERE giver_account_id=?", f.actor('alice').account.id).n, 1, 'the ring wrote one thanks row, not six');
  // The ring's own members can still only reach the per-service bound: two thanks receipts a day each,
  // and a second recipient is the only way to reach the second one.
  const other = f.tx('createAgent', f.actor('bob'), { name: 'Bob second resident', capabilities: 'Fixture', limitations: 'Fixture', color: '#397f79', symbol: '✦' });
  f.tx('giveThanks', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: other.id, reason: 'Thank you for the second fixture.' });
  assert.equal(f.tx('karmaSettle', f.actor('alice'), { agent_id: alice.id }).balance, 12, 'two thanks receipts, six each');
  assert.equal(receipts(f, alice), 2);
  plant(f, f.actor('alice'), alice, 6);
  assert.equal(f.tx('karmaSettle', f.actor('alice'), { agent_id: alice.id }).balance, 14, 'a third thanks would be refused by the bound, so no third receipt exists');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM karma_receipts WHERE agent_id=? AND service_id='thanks_to_neighbor'", alice.id).n, 2);
  // Self-service is invisible to the faucet: a circle one operates and a project one creates are not
  // service to another operator, whatever the row says.
  const circle = f.tx('createCircle', f.actor('alice'), { agent_id: alice.id, name: 'A ring of one', summary: 'A fixture circle one operator keeps to itself.', focus: 'Care' });
  const project = f.tx('createProject', f.actor('alice'), { agent_id: alice.id, circle_id: circle.id, title: 'A project one operator keeps', summary: 'A fixture project with one contributor.', goal: 'Prove self-service earns nothing.', evidence_requirements: 'A saved fixture row.' });
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_members WHERE circle_id=?', circle.id).n, 1, 'the operator is a member of its own circle');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM community_pledges WHERE project_id=?', project.id).n, 1, 'and a pledger to its own project');
  const before = receipts(f, alice);
  assert.equal(f.tx('karmaSettle', f.actor('alice'), { agent_id: alice.id }).minted, 0, 'its own circle, its own project and its own membership earn nothing');
  assert.equal(receipts(f, alice), before);
  // A guest of that project earns the service award, and the guest's own verification by the
  // contributor's sibling is refused: independence is decided by operator, never by character.
  f.tx('circleMembership', f.actor('bob'), { agent_id: bob.id, circle_id: circle.id, action: 'join' });
  f.tx('projectPledge', f.actor('bob'), { agent_id: bob.id, project_id: project.id, action: 'pledge', commitment: 'I will record one fixture row.' });
  assert.equal(f.tx('karmaSettle', f.actor('bob'), { agent_id: bob.id }).minted, 3, 'a guest of another operator\u2019s circle and project earns two service rewards on top of its own thank-you');
  assert.equal(receipts(f, bob), 3);
  assert.deepEqual(f.platform.all('SELECT service_id FROM karma_receipts WHERE agent_id=? ORDER BY service_id', bob.id).map((row) => row.service_id), ['neighbor_circle', 'neighbor_pledge', 'thanks_to_neighbor']);
  const projectTwo = f.tx('createProject', f.actor('bob'), { agent_id: bob.id, title: 'A project Bob keeps', summary: 'A fixture project with a guest contributor.', goal: 'Prove peer-review independence.', evidence_requirements: 'A saved fixture row.', milestones: ['Record one fixture row'] });
  f.tx('projectPledge', f.actor('alice'), { agent_id: alice.id, project_id: projectTwo.id, action: 'pledge', commitment: 'I will record one fixture row.' });
  assert.equal(f.tx('karmaSettle', f.actor('alice'), { agent_id: alice.id }).minted, 1, 'a pledge to another operator\u2019s project is service to another operator');
  const milestone = projectTwo.milestones[0].id;
  f.tx('projectMilestone', f.actor('alice'), { agent_id: alice.id, project_id: projectTwo.id, milestone_id: milestone, action: 'submit', evidence: 'A recorded fixture row with its limits.', sources: [{ url: 'https://example.org/row', location: 'Section 1' }] });
  // Peer review is decided by operator, never by character: neither the contributor nor the project's
  // own creator may confirm the work, and both refusals leave the milestone exactly where it was.
  assert.throws(() => f.tx('projectMilestone', f.actor('alice'), { agent_id: alice.id, project_id: projectTwo.id, milestone_id: milestone, action: 'approve', reason: 'Self approval.' }), (error) => error.status === 403);
  assert.throws(() => f.tx('projectMilestone', f.actor('bob'), { agent_id: bob.id, project_id: projectTwo.id, milestone_id: milestone, action: 'approve', reason: 'The creator approves.' }), (error) => error.status === 403);
  const stored = JSON.parse(f.platform.get('SELECT milestones FROM community_projects WHERE id=?', projectTwo.id).milestones)[0];
  assert.equal(stored.status, 'submitted', 'both self-reviews were refused and the milestone is untouched');
  assert.equal(stored.approved_by_agent_id, undefined);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
});

test('concurrent purchases of the same key, the last of an allowance and the last of a purse each resolve to one outcome', async (t) => {
  const f = await fixture(t), bob = f.agent('bob');
  const alice = earn(f, 'alice', 8);
  const { base } = await openServer(t, f);
  const token = f.credentials.alice.token;
  const purse = f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance;
  assert.equal(purse, 32, 'eight days of two crops, four Karma Coins a day');
  // 1. Two simultaneous requests under one key: one purchase, one debit, one grant. The key is the
  //    guard, and a second record under it cannot exist.
  const [sameA, sameB] = await Promise.all([
    post(base, token, '/shop/purchase', { good_id: 'herbs', agent_id: alice.id }, 'race-key-1'),
    post(base, token, '/shop/purchase', { good_id: 'herbs', agent_id: alice.id }, 'race-key-1'),
  ]);
  assert.deepEqual([sameA.status, sameB.status], [200, 200], 'a replayed request is answered from the recorded row');
  const bodies = [await sameA.json(), await sameB.json()];
  assert.equal(bodies[0].purchase_id, bodies[1].purchase_id);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM shop_purchases WHERE key='race-key-1'").n, 1);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM karma_purchases WHERE idempotency_key='race-key-1'").n, 1);
  assert.deepEqual(shelf(f, alice), { herbs: 2 }, 'one grant of two herbs');
  assert.equal(f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance, purse - 8);
  // 2. Two different keys racing for the last of a one-a-day allowance: exactly one succeeds.
  const [dayA, dayB] = await Promise.all([
    post(base, token, '/shop/purchase', { good_id: 'flower_crown', agent_id: alice.id }, 'race-key-2'),
    post(base, token, '/shop/purchase', { good_id: 'flower_crown', agent_id: alice.id }, 'race-key-3'),
  ]);
  assert.deepEqual([dayA.status, dayB.status].sort(), [200, 429], 'the per-account allowance admits one keepsake');
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM shop_purchases WHERE good_id='flower_crown'").n, 1);
  assert.deepEqual(shelf(f, alice), { flower_crown: 1, herbs: 2 });
  // 3. Two different keys racing for the last of the purse: the purse is the bound, and it never goes
  //    below zero however the two requests interleave.
  const left = f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance;
  assert.equal(left, 4, 'the herbs and the keepsake took all but four of the purse');
  const [purseA, purseB] = await Promise.all([
    post(base, token, '/shop/purchase', { good_id: 'fiber', agent_id: alice.id }, 'race-key-4'),
    post(base, token, '/shop/purchase', { good_id: 'fiber', agent_id: alice.id }, 'race-key-5'),
  ]);
  assert.deepEqual([purseA.status, purseB.status], [409, 409], 'a purse of four pays for nothing');
  const refusal = await purseA.json();
  assert.match(refusal.error, /holds 4 Karma Coins/);
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM shop_purchases WHERE good_id='fiber'").n, 0);
  assert.equal(f.platform.karmaWallet(f.actor('alice'), { agent_id: alice.id }).balance, 4);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_purchases').n, 2, 'two debits for two purchases, and no third');
  // 4. A key reused for a different good is refused outright rather than granting the second good.
  const reused = await post(base, token, '/shop/purchase', { good_id: 'wood', agent_id: alice.id }, 'race-key-1');
  assert.equal(reused.status, 409);
  assert.match((await reused.json()).error, /already used for a different good/);
  // The whole database state after the race: two purchases, two debits, two kinds on one shelf. The
  // rows are read back in key order because two requests that fit inside one clock tick share a
  // `created_at` and only the key decides which is which.
  assert.deepEqual(f.platform.all('SELECT good_id,price,balance_after,key FROM shop_purchases ORDER BY key').map((row) => ({ ...row })), [
    { good_id: 'herbs', price: 8, balance_after: 24, key: 'race-key-1' },
    { good_id: 'flower_crown', price: 20, balance_after: 4, key: 'race-key-2' },
  ]);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
  assert.equal(f.platform.karmaSpend(f.actor('alice'), { amount: 8, good_id: 'herbs', key: 'race-key-1' }).repeated, true);
});

test('a replayed listing, offer or settle with different content under the same key is refused, not applied', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  boarded(f);
  stock(f, alice, 'herbs', 6); stock(f, bob, 'fiber', 4);
  const listing = f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 4 } }, 'abuse-post-1');
  assert.deepEqual(shelf(f, alice), { herbs: 2 });
  // The same key with different items, for the same resident and for a sibling: both refused, and the
  // recorded listing is the only one.
  assert.throws(() => f.tx('tradePost', f.actor('alice'), { agent_id: alice.id, items: { herbs: 3 } }, 'abuse-post-1'), (error) => error.status === 409);
  const sibling = f.tx('createAgent', f.actor('alice'), { name: 'Second resident', capabilities: 'Fixture', limitations: 'Fixture', color: '#397f79', symbol: '✦' });
  assert.throws(() => f.tx('tradePost', f.actor('alice'), { agent_id: sibling.id, items: { herbs: 4 } }, 'abuse-post-1'), (error) => error.status === 409);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM trade_listings').n, 1);
  assert.deepEqual(shelf(f, alice), { herbs: 2 }, 'and nothing escrowed twice');
  // The same for an offer: the same key with other items or another recipient is refused.
  const offer = f.tx('offerCreate', f.actor('bob'), { agent_id: bob.id, recipient_agent_id: alice.id, items: { fiber: 2 } }, 'abuse-offer-1');
  assert.throws(() => f.tx('offerCreate', f.actor('bob'), { agent_id: bob.id, recipient_agent_id: alice.id, items: { fiber: 3 } }, 'abuse-offer-1'), (error) => error.status === 409);
  assert.throws(() => f.tx('offerCreate', f.actor('bob'), { agent_id: bob.id, recipient_agent_id: sibling.id, items: { fiber: 2 } }, 'abuse-offer-1'), (error) => error.status === 409);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resource_offers').n, 1);
  assert.deepEqual(shelf(f, bob), { fiber: 2 }, 'the offer escrowed exactly once');
  // A replayed claim with a different amount under the same key is refused; the recorded claim stands.
  const claim = f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id, items: { herbs: 2 } }, 'abuse-claim-1');
  assert.throws(() => f.tx('tradeClaim', f.actor('bob'), { agent_id: bob.id, listing_id: listing.id, items: { herbs: 4 } }, 'abuse-claim-1'), (error) => error.status === 409);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM trade_claims').n, 1);
  assert.deepEqual(shelf(f, bob), { fiber: 2, herbs: 2 }, 'the shelf holds exactly the recorded claim');
  // A replay of a settle pass mints nothing twice, and the same settlement cannot be accepted twice.
  f.tx('karmaSettle', f.actor('alice'), { agent_id: alice.id });
  const settled = f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts WHERE agent_id=?', alice.id).n;
  assert.equal(f.tx('karmaSettle', f.actor('alice'), { agent_id: alice.id }).minted, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM karma_receipts WHERE agent_id=?', alice.id).n, settled);
  f.tx('offerAccept', f.actor('alice'), { offer_id: offer.id }, 'abuse-accept-1');
  assert.equal(f.tx('offerAccept', f.actor('alice'), { offer_id: offer.id }, 'abuse-accept-1').repeated, true);
  assert.deepEqual(shelf(f, alice), { fiber: 2, herbs: 2 }, 'the accepted offer credited once, and the claimed herbs are there too');
  assert.equal(f.platform.get('SELECT status FROM resource_offers WHERE id=?', offer.id).status, 'accepted');
  assert.equal(claim.items.herbs, 2);
  assert.equal(verifyKarmaLedger(f.platform.db), true);
});

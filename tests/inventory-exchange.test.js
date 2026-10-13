import test from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from '../src/platform.js';
import { journeyMethods, RESOURCE_OFFER_POLICY, RESOURCE_OFFER_LIMITS } from '../src/journey.js';
import { communityMethods } from '../src/community.js';
import { getWorldDefinition } from '../world.js';
import content from '../src/content.js';
import { fixture } from './helpers.js';

Object.assign(Platform.prototype, journeyMethods);
Object.assign(Platform.prototype, communityMethods);

const denied = (operation, status) => assert.throws(operation, (error) => error.status === status);
const stock = (f, agent, kind, quantity) => f.platform.run('INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,?,?) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity+excluded.quantity', agent.id, kind, quantity);
const shelf = (f, agent) => Object.fromEntries(f.platform.all('SELECT kind,quantity FROM journey_inventory WHERE agent_id=?', agent.id).map((item) => [item.kind, item.quantity]));
const NEW_RECIPES = ['herbal_wreath', 'reed_whistle', 'festival_banner'];

test('three new original recipes are sealed, use grown or crafted ingredients, and a craft can be made from a craft', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  const recipes = content.recipes(), ids = recipes.map((recipe) => recipe.id);
  for (const id of NEW_RECIPES) assert.ok(ids.includes(id), `${id} must be a sealed recipe`);
  const grown = new Set(Object.keys(content.crops())), crafted = new Set(ids);
  for (const recipe of recipes) {
    for (const [kind, quantity] of Object.entries(recipe.ingredients)) {
      assert.ok(grown.has(kind) || crafted.has(kind), `${recipe.id} ingredient ${kind} must be a resource that is grown or crafted`);
      assert.ok(Number.isInteger(quantity) && quantity > 0, `${recipe.id} ingredient ${kind} needs a positive quantity`);
    }
    assert.ok(crafted.has(recipe.output), `${recipe.id} must output a craftable keepsake`);
  }
  // One new recipe consumes a crafted keepsake, so crafting has a second step of depth.
  const festival = recipes.find((recipe) => recipe.id === 'festival_banner');
  assert.ok(Object.keys(festival.ingredients).some((kind) => kind === 'woven_banner'), 'festival_banner consumes the woven_banner craft');
  // Craft the whole chain on a real shelf: fiber and wood become a banner, the banner becomes a festival banner.
  stock(f, alice, 'fiber', 6); stock(f, alice, 'wood', 1); stock(f, alice, 'herbs', 2);
  assert.equal(f.tx('craftItem', f.actor('alice'), { agent_id: alice.id, recipe_id: 'woven_banner' }).crafted, 'woven_banner');
  assert.equal(f.tx('craftItem', f.actor('alice'), { agent_id: alice.id, recipe_id: 'festival_banner' }).crafted, 'festival_banner');
  const after = shelf(f, alice);
  assert.equal(after.festival_banner, 1);
  assert.equal(after.woven_banner, 0);
  assert.equal(after.fiber, 2);
  assert.equal(after.herbs, 0);
  assert.equal(after.wood, 0);
  // A crafted keepsake is offered as a cosmetic the resident actually owns.
  const passport = f.platform.journey(f.actor('alice'), { agent_id: alice.id });
  assert.ok(passport.profile_options.avatars.includes('festival_banner'));
  assert.deepEqual(passport.recipes.filter((recipe) => NEW_RECIPES.includes(recipe.id)).map((recipe) => recipe.id), NEW_RECIPES);
});

test('an offer escrows the items, the named recipient accepts, and both shelves reconcile', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'herbs', 5);
  const offer = f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 3 }, note: 'For your garden.' }, 'propose-1');
  assert.equal(offer.status, 'proposed');
  assert.equal(offer.direction, 'outgoing');
  assert.deepEqual(offer.items, { herbs: 3 });
  assert.equal(offer.note, 'For your garden.');
  assert.equal(shelf(f, alice).herbs, 2, 'the offered items leave the offerer shelf when the offer exists');
  assert.deepEqual(f.platform.journey(f.actor('alice'), { agent_id: alice.id }).inventory, [{ kind: 'herbs', quantity: 2 }]);
  // Only the named recipient may accept.
  denied(() => f.tx('offerAccept', f.actor('alice'), { offer_id: offer.id, agent_id: alice.id }, 'accept-offerer'), 403);
  denied(() => f.tx('offerAccept', f.actor('reviewer'), { offer_id: offer.id }, 'accept-outsider'), 403);
  // A runtime cannot accept on a human operator's behalf.
  const run = f.tx('runtime', f.actor('bob'), bob.id, { scopes: ['read', 'contribute'] });
  const runtimeActor = f.platform.authenticate(run.token);
  denied(() => f.tx('offerAccept', runtimeActor, { offer_id: offer.id }, 'accept-runtime'), 403);
  assert.equal(shelf(f, bob).herbs, undefined);
  // The recipient's human operator accepts; the items move once and the shelves reconcile.
  const accepted = f.tx('offerAccept', f.actor('bob'), { offer_id: offer.id, agent_id: bob.id }, 'accept-1');
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.direction, 'incoming');
  assert.deepEqual(accepted.inventory, [{ kind: 'herbs', quantity: 3 }]);
  assert.equal(shelf(f, bob).herbs, 3);
  assert.equal(shelf(f, alice).herbs, 2);
  // The exchange moved no coin and no land.
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n, 0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships WHERE account_id=?', f.actor('bob').account.id).n, 0);
  assert.equal(RESOURCE_OFFER_POLICY.coins_awarded, 0);
  assert.equal(RESOURCE_OFFER_POLICY.moves_coins, false);
  assert.equal(RESOURCE_OFFER_POLICY.moves_money, false);
  assert.equal(RESOURCE_OFFER_POLICY.moves_land, false);
  assert.equal(RESOURCE_OFFER_POLICY.transferable, false);
});

test('a replayed propose or accept moves nothing twice, and a settled offer cannot be accepted again', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'fiber', 4);
  const first = f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { fiber: 2 } }, 'propose-dup');
  const replay = f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { fiber: 2 } }, 'propose-dup');
  assert.equal(replay.repeated, true);
  assert.equal(replay.id, first.id);
  assert.equal(shelf(f, alice).fiber, 2, 'a replayed propose does not escrow twice');
  // The same key for a different offer is refused.
  denied(() => f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { fiber: 1 } }, 'propose-dup'), 409);
  const accepted = f.tx('offerAccept', f.actor('bob'), { offer_id: first.id }, 'accept-dup');
  assert.equal(accepted.status, 'accepted');
  const acceptedAgain = f.tx('offerAccept', f.actor('bob'), { offer_id: first.id }, 'accept-dup');
  assert.equal(acceptedAgain.repeated, true);
  assert.equal(shelf(f, bob).fiber, 2, 'a replayed accept does not deliver twice');
  denied(() => f.tx('offerAccept', f.actor('bob'), { offer_id: first.id }, 'accept-other'), 409);
  // The recipient's accept key is unique across its offers, so it cannot be reused for another offer.
  stock(f, alice, 'fiber', 2);
  const second = f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { fiber: 1 } }, 'propose-2');
  denied(() => f.tx('offerAccept', f.actor('bob'), { offer_id: second.id }, 'accept-dup'), 409);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resource_offers WHERE status=?', 'accepted').n, 1);
});

test('cancel, decline and expiry return the escrow to the offerer exactly once', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'wood', 6);
  const cancelledOffer = f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { wood: 2 } }, 'p-cancel');
  assert.equal(shelf(f, alice).wood, 4);
  assert.equal(f.tx('offerCancel', f.actor('alice'), { offer_id: cancelledOffer.id }).status, 'cancelled');
  assert.equal(shelf(f, alice).wood, 6);
  assert.equal(f.tx('offerCancel', f.actor('alice'), { offer_id: cancelledOffer.id }).repeated, true);
  assert.equal(shelf(f, alice).wood, 6, 'a replayed cancel does not credit again');
  denied(() => f.tx('offerCancel', f.actor('bob'), { offer_id: cancelledOffer.id }), 403);
  // Decline returns the escrow to the offerer; only the recipient can decline.
  const declinedOffer = f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { wood: 3 } }, 'p-decline');
  assert.equal(shelf(f, alice).wood, 3);
  denied(() => f.tx('offerDecline', f.actor('alice'), { offer_id: declinedOffer.id }), 403);
  assert.equal(f.tx('offerDecline', f.actor('bob'), { offer_id: declinedOffer.id }).status, 'declined');
  assert.equal(shelf(f, alice).wood, 6);
  // Expiry returns the escrow exactly once, and a late accept is refused.
  const expiring = f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { wood: 4 }, expires_minutes: 1 }, 'p-expire');
  assert.equal(shelf(f, alice).wood, 2);
  f.advance(61_000);
  assert.equal(f.platform.expireOffers(), 1);
  assert.equal(f.platform.expireOffers(), 0, 'settling twice does nothing the second time');
  assert.equal(shelf(f, alice).wood, 6);
  assert.equal(f.platform.get('SELECT status FROM resource_offers WHERE id=?', expiring.id).status, 'expired');
  denied(() => f.tx('offerAccept', f.actor('bob'), { offer_id: expiring.id }, 'late-accept'), 409);
  assert.equal(shelf(f, bob).wood, undefined);
});

test('no negative stock is possible: an oversized or invalid offer changes nothing, and the shelf refuses a negative write', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'herbs', 2);
  denied(() => f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 3 } }, 'over'), 409);
  assert.equal(shelf(f, alice).herbs, 2, 'a refused offer leaves the shelf untouched');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resource_offers').n, 0, 'a refused offer is not recorded');
  // A kind that is not grown or crafted is refused, so coins, money or an invented item can never be offered.
  denied(() => f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { coins: 1 } }, 'coins'), 400);
  denied(() => f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 0 } }, 'zero'), 400);
  denied(() => f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: -1 } }, 'neg'), 400);
  denied(() => f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: RESOURCE_OFFER_LIMITS.quantity_max + 1 } }, 'too-many'), 400);
  assert.equal(shelf(f, alice).herbs, 2);
  // The shelf itself cannot go negative, even through a raw write: the schema CHECK is the backstop.
  assert.throws(() => f.platform.run('UPDATE journey_inventory SET quantity=-1 WHERE agent_id=? AND kind=?', alice.id, 'herbs'), /quantity>=0|CHECK/);
  assert.equal(shelf(f, alice).herbs, 2);
});

test('offers stay between two residents of different operators; a resident cannot offer to itself or its sibling', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob'), sibling = f.agent('alice', 'Sibling');
  stock(f, alice, 'herbs', 3);
  denied(() => f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: alice.id, items: { herbs: 1 } }, 'self'), 400);
  denied(() => f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: sibling.id, items: { herbs: 1 } }, 'sibling'), 400);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resource_offers').n, 0);
  assert.equal(shelf(f, alice).herbs, 3);
  // A resident of another operator is a valid recipient.
  assert.equal(f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 1 } }, 'valid').status, 'proposed');
});

test('a runtime may propose within its permissions but cannot accept, decline or invent inventory', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'herbs', 2);
  const run = f.tx('runtime', f.actor('alice'), alice.id, { scopes: ['read', 'contribute'] });
  const actor = f.platform.authenticate(run.token);
  // The runtime proposes from the shelf of the resident it is bound to.
  const offer = f.tx('offerCreate', actor, { recipient_agent_id: bob.id, items: { herbs: 2 } }, 'runtime-propose');
  assert.equal(offer.status, 'proposed');
  assert.equal(offer.offerer.agent_id, alice.id);
  assert.equal(shelf(f, alice).herbs, 0);
  // It cannot invent inventory it does not hold, and it cannot offer from another resident.
  denied(() => f.tx('offerCreate', actor, { recipient_agent_id: bob.id, items: { herbs: 1 } }, 'runtime-invent'), 409);
  denied(() => f.tx('offerCreate', actor, { agent_id: bob.id, recipient_agent_id: bob.id, items: { herbs: 1 } }, 'runtime-other'), 404);
  // It cannot accept or decline on the recipient's behalf.
  denied(() => f.tx('offerAccept', actor, { offer_id: offer.id }, 'runtime-accept'), 403);
  denied(() => f.tx('offerDecline', actor, { offer_id: offer.id }, 'runtime-decline'), 403);
  // But the offering side may cancel its own offer, returning the escrow.
  assert.equal(f.tx('offerCancel', actor, { offer_id: offer.id }).status, 'cancelled');
  assert.equal(shelf(f, alice).herbs, 2);
});

test('the offers view is private to the two parties', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'herbs', 3);
  const offer = f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 3 } }, 'p-view');
  const aliceView = f.platform.resourceOffers(f.actor('alice')), bobView = f.platform.resourceOffers(f.actor('bob'));
  assert.equal(aliceView.offers.length, 1);
  assert.equal(aliceView.offers[0].direction, 'outgoing');
  assert.equal(aliceView.offers[0].can_cancel, true);
  assert.equal(aliceView.offers[0].can_accept, false);
  assert.equal(bobView.offers[0].direction, 'incoming');
  assert.equal(bobView.offers[0].can_accept, true);
  assert.equal(bobView.offers[0].can_decline, true);
  assert.equal(f.platform.resourceOffers(f.actor('reviewer')).offers.length, 0, 'an outsider sees no offers');
  denied(() => f.tx('offerAccept', f.actor('reviewer'), { offer_id: offer.id }, 'outsider'), 403);
  // The operator export carries its own offers and nothing of the other party's private records.
  const exported = f.platform.exportAccount(f.actor('alice'));
  assert.equal(exported.offers.length, 1);
  assert.equal(exported.offers[0].id, offer.id);
});

test('account deletion settles every open offer for its residents so no escrow is stranded', async (t) => {
  const f = await fixture(t), alice = f.agent('alice'), bob = f.agent('bob');
  stock(f, alice, 'herbs', 4);
  stock(f, bob, 'fiber', 4);
  f.tx('offerCreate', f.actor('alice'), { agent_id: alice.id, recipient_agent_id: bob.id, items: { herbs: 2 } }, 'p-del-a');
  f.tx('offerCreate', f.actor('bob'), { agent_id: bob.id, recipient_agent_id: alice.id, items: { fiber: 2 } }, 'p-del-b');
  assert.equal(shelf(f, alice).herbs, 2);
  assert.equal(shelf(f, bob).fiber, 2);
  f.tx('deleteAccount', f.actor('bob'));
  assert.equal(f.platform.get("SELECT status FROM resource_offers WHERE propose_key='p-del-a'").status, 'cancelled');
  assert.equal(f.platform.get("SELECT status FROM resource_offers WHERE propose_key='p-del-b'").status, 'cancelled');
  assert.equal(shelf(f, alice).herbs, 4, "the escrow returns to alice exactly once when the offer's recipient deletes an account");
});

test('crafting adds no world placement and the shipped passage and footprint rules still refuse a blocked tile', async (t) => {
  const f = await fixture(t), alice = f.agent('alice');
  stock(f, alice, 'herbs', 3); stock(f, alice, 'fiber', 2);
  const before = f.platform.get('SELECT COUNT(*) AS n FROM world_objects').n;
  assert.equal(f.tx('craftItem', f.actor('alice'), { agent_id: alice.id, recipe_id: 'herbal_wreath' }).crafted, 'herbal_wreath');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects').n, before, 'a crafted keepsake is a shelf item, never a placed object');
  // A keepsake is not a build-palette object, so no craft can smuggle blocking geometry into the world.
  assert.equal(content.palette('garden').includes('herbal_wreath'), false);
  assert.equal(content.palette('house').includes('herbal_wreath'), false);
  // The one placement path is untouched: the arrival tile still stays clear through the shipped rules.
  const homeId = `home:${alice.id}`;
  f.tx('travel', f.actor('alice'), alice.id, { world_id: homeId });
  const definition = getWorldDefinition(homeId);
  denied(() => f.tx('build', f.actor('alice'), alice.id, { type: 'path', ...definition.start }), 409);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM world_objects WHERE world_id=?', homeId).n, 0);
});

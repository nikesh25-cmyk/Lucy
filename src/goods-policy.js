// The classification of every good, and the one rule that decides what may leave an account.
//
// The world has four separate units of account (src/coins.js), a Karma purse (src/karma.js), a shop
// catalogue (src/shop.js), a trade board (src/trade-market.js) and a resource-offer layer
// (src/journey.js). Before this module each of those decided for itself what could move, so "may this
// leave the account?" had five answers. This module is the one answer, as data: `GOOD_FAMILIES` names
// every family of good the world holds with its classification and the reason for it, and the helpers
// below turn that classification into one enforcement call a transfer path makes before it escrows.
//
// Two classes:
//   * `transferable`  — a sealed crop kind a resident grew, or a keepsake it crafted from ingredients
//                       its own shelf already held. Grown and crafted goods are the trade board's and
//                       the offer layer's whole concern and they move between operators as before.
//   * `account_bound` — everything the world gives one account and never another: a keepsake bought
//                       with Karma Coins at the shop, an object placement entitlement, each of the
//                       four units of account, cosmetic calling experience, land stewardship, a role
//                       or review authority, and a runtime scope.
//
// A shelf kind is fungible and `journey_inventory` stores no provenance: a flower crown a resident
// crafted and one it bought are one row. The enforceable rule is therefore a per-account reservation
// rather than a per-unit label. An account that bought N units of kind K never moves more than
// `held(K over all its residents) - N`, which is exact in quantity (no unit is lost or double-counted)
// and conservative in identity (the bought units are the ones assumed retained). It refuses exactly
// the case the Karma/shop handoff named: a purchased-and-unused keepsake may not be listed or offered.
import content from './content.js';
import { KARMA_POLICY } from './karma.js';
import { COIN_POLICY, UNIT_SEPARATION_POLICY } from './coins.js';

const fail=(status,message,reason_code,detail)=>{throw Object.assign(new Error(message),{status,reason_code,...(detail||{})});};
export const GOOD_CLASSES=Object.freeze({transferable:'transferable',account_bound:'account_bound'});
// The reason codes a refusal can carry. `account_bound_good` is the named reason a transfer of an
// account-bound good is refused with; `unknown_kind` is a kind no family in this world names.
export const GOOD_REFUSAL_CODES=Object.freeze({account_bound_good:'account_bound_good',unknown_kind:'unknown_kind'});

const CROP_KINDS=Object.freeze(Object.keys(content.crops()));
const CRAFT_KINDS=Object.freeze(content.recipes().map((recipe)=>recipe.output));
// The sealed keepsakes a shop purchase can hand over as a wearable entitlement. The same list the
// shop's own catalogue validates its cosmetic grants against, read from the content bundle so the two
// cannot drift: a new sealed keepsake is classified the moment it exists.
const SHOP_COSMETIC_KINDS=Object.freeze(content.cosmetics('craft'));
// Every kind a shelf can hold: a grown crop or a crafted output. Everything else the world holds is a
// unit of account, a claim or an entitlement, and none of it is a shelf item.
export const ITEM_KINDS=Object.freeze([...new Set([...CROP_KINDS,...CRAFT_KINDS])]);

export const GOOD_POLICY=Object.freeze({
 version:1,
 classes:Object.freeze([GOOD_CLASSES.transferable,GOOD_CLASSES.account_bound]),
 shelf:'journey_inventory is the one place a good lives; no module keeps its own item ledger',
 transfer_rule:'Grown and crafted goods move between residents of different operators. A good an account bought from the shop is account-bound and moves only up to its unreserved surplus.',
 enforcement:Object.freeze(['trade listing','trade claim','resource offer','offer acceptance','shop catalogue','account export']),
 description:'Items are classified once, here. A grown crop and a crafted keepsake are transferable goods. A keepsake bought with Karma Coins is an account-bound entitlement, and so is every unit of account, land stewardship, a role, cosmetic experience and a runtime scope. The trade board, the resource-offer layer, the shop and the account export all read this table rather than deciding for themselves.',
});

/**
 * Every family of good the world holds, its class and the reason for it. `kinds` lists the shelf kinds
 * a family covers where it has any; `moves` states in one sentence where the family can go. A family
 * with no `kinds` never appears on a shelf at all.
 */
export const GOOD_FAMILIES=Object.freeze([
 Object.freeze({
  id:'grown_crop',label:'Grown crop',classification:GOOD_CLASSES.transferable,kinds:CROP_KINDS,
  moves:'Between residents of different operators, through the trade board or a resource offer.',
  reason:'A sealed crop kind the resident planted, tended and harvested in its own garden. It is the resident\u2019s own saved world labour and the trade board\u2019s original concern, not something the world gave away.',
  evidence:'A saved journey_crops row for a farm tile in the garden of the resident\u2019s own operator.',
 }),
 Object.freeze({
  id:'crafted_keepsake',label:'Crafted keepsake',classification:GOOD_CLASSES.transferable,kinds:CRAFT_KINDS,
  moves:'Between residents of different operators, through the trade board or a resource offer.',
  reason:'A sealed keepsake the resident crafted from ingredients its own shelf already held: a craft debits those ingredients in the same transaction, so the output was made rather than bought, and it can be given away as freely as the crops it consumed.',
  evidence:'A journey_inventory row written by the crafting transaction that debited its ingredients, plus the audit row that transaction recorded.',
 }),
 Object.freeze({
  id:'shop_cosmetic',label:'Shop keepsake entitlement',classification:GOOD_CLASSES.account_bound,kinds:SHOP_COSMETIC_KINDS,
  moves:'Worn by the buying account\u2019s own resident only. Never listed, offered or handed to another operator.',
  reason:'Bought with Karma Coins at the shop. The shop records every one of these purchases, and moving one to another account would carry Karma value out of the account one step at a time. Karma Coins themselves are not transferable, so what they bought is not either.',
  evidence:'A shop_purchases row with category=cosmetic for the buying account, which the reservation query below reads.',
 }),
 Object.freeze({
  id:'shop_resource_bundle',label:'Shop resource bundle',classification:GOOD_CLASSES.transferable,kinds:CROP_KINDS,
  moves:'As any grown crop: between residents of different operators.',
  reason:'The shop hands over the same sealed crop kinds a garden harvest yields, in the same shelf table, at a per-day allowance the shop bounds. A crop kind is fungible once held, so a bought bundle is the grown resource it is; classifying the kind by where one unit came from is not possible and would refuse a resident its own harvest.',
  evidence:'A shop_purchases row with category=resource, and the shipped per_account_limit_per_day the shop applies to it.',
 }),
 Object.freeze({
  id:'shop_object_grant',label:'Shop object placement entitlement',classification:GOOD_CLASSES.account_bound,
  moves:'Placed in the buying account\u2019s own world through the existing build path. Never carried to another account.',
  reason:'An object purchase is an entitlement to place one thing in the buyer\u2019s own garden or cottage, not a loose item another resident could take away; the shop deliberately grants no placement and writes no world_objects row.',
  evidence:'A shop_purchases row with category=object, and the build-palette guards the placement must still pass.',
 }),
 Object.freeze({
  id:'karma_coin',label:'Karma Coins',classification:GOOD_CLASSES.account_bound,
  moves:'Nowhere. Earned by service in the world and spent only in the shop, by the account that earned them.',
  reason:'A separate in-world unit with no gift, no transfer and no conversion: '+KARMA_POLICY.sentence,
  evidence:'KARMA_POLICY.transferable, transferable_between_accounts and transferable_between_residents are all false, and the ledger has no route that names another account.',
 }),
 Object.freeze({
  id:'nemo_coin',label:'NemoCoins',classification:GOOD_CLASSES.account_bound,
  moves:'Nowhere. Issued to the operator whose agent did the work and held by that operator\u2019s residents.',
  reason:'Internal contribution credits for one independently accepted contribution. '+COIN_POLICY.description,
  evidence:'coin_rewards has no transfer route, no mint endpoint and no balance that another account can reach.',
 }),
 Object.freeze({
  id:'compute_credit',label:'Compute credit',classification:GOOD_CLASSES.account_bound,
  moves:'Nowhere. The concept has no balance, ledger, transfer or purchase in this build.',
  reason:'The world records model-run counters and budgets but holds no compute-credit balance, so there is nothing that could move.',
  evidence:'UNIT_SEPARATION_POLICY names the unit and states one conversion path count of zero.',
 }),
 Object.freeze({
  id:'real_money',label:'Real money',classification:GOOD_CLASSES.account_bound,
  moves:'Nowhere. No payment, price, cash-out or token exists in this build.',
  reason:'There is no payment path at all, so no amount of money can enter, leave or be converted in the world.',
  evidence:'UNIT_SEPARATION_POLICY.cash_out and .token are both false.',
 }),
 Object.freeze({
  id:'carbon_credit',label:'Verified carbon credit',classification:GOOD_CLASSES.account_bound,
  moves:'Nowhere. No carbon-credit balance, registry, transfer or conversion exists.',
  reason:'A verified environmental outcome is not represented as a tradeable unit here, so there is nothing to classify as movable.',
  evidence:'UNIT_SEPARATION_POLICY names the unit and lists four separate units with no path between them.',
 }),
 Object.freeze({
  id:'calling_experience',label:'Calling experience',classification:GOOD_CLASSES.account_bound,
  moves:'Nowhere. Cosmetic experience is held by the resident that earned it.',
  reason:'Calling experience is a cosmetic measure of one resident\u2019s own saved activity. It is derived from the same acceptance events as a NemoCoin receipt but is counted in a different unit, and no path moves or converts either.',
  evidence:'calling_receipts is per agent, and the coin-abuse review proves the two ledgers are separate paths over one event.',
 }),
 Object.freeze({
  id:'land_stewardship',label:'Land stewardship and plot grants',classification:GOOD_CLASSES.account_bound,
  moves:'Nowhere. A plot is assigned to one operator and released by the world, never sold or traded.',
  reason:'Stewardship is a grant of responsibility over one bounded plot, not a good held on a shelf: it has no price, no sale route and no transfer route, and the shop is forbidden from selling land.',
  evidence:'land_stewardships is one row per account with no transfer or sale path, and SHOP_POLICY.never_sells names land first.',
 }),
 Object.freeze({
  id:'role_authority',label:'Role, review authority and moderation power',classification:GOOD_CLASSES.account_bound,
  moves:'Nowhere. A role is granted by an administrator to an account, never bought, sold or given.',
  reason:'Review authority and moderation power decide what other people\u2019s work is worth, so they must never be purchasable or tradeable; the shop states outright that it sells no role, authority or review power.',
  evidence:'accounts.role is written only by the administrator path, and SHOP_POLICY.never_sells names roles and review power.',
 }),
 Object.freeze({
  id:'runtime_scope',label:'Runtime scope',classification:GOOD_CLASSES.account_bound,
  moves:'Nowhere. A runtime credential carries the scopes its operator granted it, and expires.',
  reason:'A scope is a bounded permission over one resident\u2019s own data, issued by an operator to a credential it holds. Nothing in the world sells, transfers or converts one.',
  evidence:'tokens.scopes is written only by the runtime-creation path, which an administrator or the owning operator controls.',
 }),
]);
if(!GOOD_FAMILIES.length)throw new Error('goods-policy: no good family is named');
// The classification cannot disagree with the policies the unit owners ship. Both are frozen, so this
// runs once at load and a future edit to either policy that contradicts the table stops the process.
for(const [name,flag] of [['KARMA_POLICY.transferable',KARMA_POLICY.transferable],['COIN_POLICY.transferable',COIN_POLICY.transferable]])if(flag!==false)throw new Error(`goods-policy: ${name} must stay false for the classification to hold`);
if(UNIT_SEPARATION_POLICY.conversion_paths!==0||UNIT_SEPARATION_POLICY.cash_out!==false||UNIT_SEPARATION_POLICY.token!==false)throw new Error('goods-policy: a unit of account claims a conversion, a cash-out or a token');
for(const family of GOOD_FAMILIES){
 if(!family.id||!family.label||!family.reason||!family.moves||!family.evidence)throw new Error(`goods-policy: ${family.id||'a family'} is incomplete`);
 if(!GOOD_POLICY.classes.includes(family.classification))throw new Error(`goods-policy: ${family.id} has no class`);
 if(family.classification===GOOD_CLASSES.transferable&&!family.kinds?.length)throw new Error(`goods-policy: ${family.id} is transferable but names no kind`);
}
const FAMILY_BY_ID=new Map(GOOD_FAMILIES.map((family)=>[family.id,family]));

/** One family by id, or null. */
export const goodFamily=(id)=>FAMILY_BY_ID.get(id)||null;
/** Every family that names a shelf kind, as a map from kind to the family ids that cover it. */
export const familiesForKind=(kind)=>{
 const ids=GOOD_FAMILIES.filter((family)=>family.kinds?.includes(kind)).map((family)=>family.id);
 return ids;
};
/**
 * The static class of one shelf kind. Every sealed item kind is transferable when the account holds
 * no reservation for it; a kind no family names is unknown and may not move at all. The
 * account-bound part of a keepsake is a property of the account's purchases, not of the kind, because
 * a resident's own crafted keepsake of the same kind stays transferable.
 */
export const kindClassification=(kind)=>ITEM_KINDS.includes(kind)?GOOD_CLASSES.transferable:null;

const hasTable=(platform,name)=>Boolean(platform.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?",name));

/**
 * How many units of each shelf kind this account bought from the shop as an account-bound
 * entitlement. Read from the shop's own append-only purchase record, so the reservation follows the
 * record rather than a second list. A cosmetic is never consumed on the shelf (a held keepsake is
 * offered as an appearance and stays held), so the total is the standing reservation.
 */
export function shopReservations(platform,accountId){
 const reservations=new Map();
 if(typeof accountId!=='string'||!accountId||!hasTable(platform,'shop_purchases'))return reservations;
 const rows=platform.all("SELECT json_extract(granted,'$.cosmetic') AS kind,COUNT(*) AS n FROM shop_purchases WHERE account_id=? AND category='cosmetic' AND json_valid(granted) AND json_extract(granted,'$.cosmetic') IS NOT NULL GROUP BY kind",accountId);
 for(const row of rows)if(row.kind&&row.n>0)reservations.set(row.kind,row.n);
 return reservations;
}
/** Everything one account's residents hold of one kind, on their own shelves. */
export function heldByAccount(platform,accountId,kind){
 if(!hasTable(platform,'journey_inventory'))return 0;
 return platform.get('SELECT COALESCE(SUM(quantity),0) AS n FROM journey_inventory WHERE kind=? AND agent_id IN (SELECT id FROM agents WHERE operator_id=?)',kind,accountId).n||0;
}
/**
 * The units of one kind this account may still move to another account: what its residents hold,
 * less the account-bound reservation its own shop purchases created. Never negative, because an
 * account whose reservation exceeds what it holds may move none of that kind.
 */
export function transferableSurplus(platform,accountId,kind){
 const reserved=shopReservations(platform,accountId).get(kind)||0;
 if(!reserved)return kindClassification(kind)?Infinity:0;
 return Math.max(0,heldByAccount(platform,accountId,kind)-reserved);
}

/**
 * The one enforcement call a transfer path makes before it escrows anything. It refuses a kind no
 * family names, and it refuses an account-bound good past its unreserved surplus, with the named
 * reason `account_bound_good` and a sentence an operator can act on. It never removes or moves a row:
 * a refusal leaves the caller's transaction untouched, so the escrow, the debit and the audit entry
 * roll back together.
 *
 * `items` is the items object a listing or an offer is about; `move` names the path in the sentence.
 */
export function assertTransferable(platform,{account_id,agent_id,items,move='a transfer'}){
 const accountId=typeof account_id==='string'?account_id:'';
 if(!accountId)return;
 const reservations=shopReservations(platform,accountId);
 for(const [kind,quantity] of Object.entries(items||{})){
  const family=familiesForKind(kind);
  if(!family.length)fail(409,`${kind} is not a good this world names, so it cannot leave an account through ${move}.`,'unknown_kind',{kind});
  const reserved=reservations.get(kind)||0;
  if(!reserved)continue;
  const held=heldByAccount(platform,accountId,kind),surplus=Math.max(0,held-reserved);
  if(quantity>surplus)fail(409,`${kind} is account-bound: this operator bought ${reserved} of it from the shop and holds ${held}, so ${surplus} may leave the account and ${quantity} were requested. A keepsake bought with Karma Coins is worn by the buying account\u2019s own resident and is never ${move} to another operator.`,'account_bound_good');
 }
 return true;
}

/**
 * The take-side half of the same rule, for a claim or an acceptance of goods an account escrowed
 * earlier. The post-side check already bounded what left the shelf, so this one asks only whether the
 * reservation is still covered: the units that left must not have been the account-bound ones. A
 * listing that took them (posted before this rule existed, or by a database whose trigger was stubbed)
 * can therefore be neither claimed nor accepted, and it expires back to its poster.
 */
export function assertReservationCovered(platform,{account_id,items,move='a transfer'}){
 const accountId=typeof account_id==='string'?account_id:'';
 if(!accountId)return true;
 const reservations=shopReservations(platform,accountId);
 for(const kind of Object.keys(items||{})){
  const reserved=reservations.get(kind)||0;
  if(!reserved)continue;
  const held=heldByAccount(platform,accountId,kind);
  if(held<reserved)fail(409,`${kind} is account-bound: this operator bought ${reserved} from the shop and its residents now hold ${held} of the kind, because the units that left the shelf were the reserved ones. The goods may not leave the account and will return to it when the listing or offer ends.`,'account_bound_good');
 }
 return true;
}

// The shop's three categories, mapped to the family that classifies them, so a catalogue entry and
// this table can never disagree about what the shop sells. Read by src/shop.js for its projection.
export const SHOP_FAMILY_BY_CATEGORY=Object.freeze({resource:'shop_resource_bundle',cosmetic:'shop_cosmetic',object:'shop_object_grant'});
export function shopGoodClassification(category){
 const family=goodFamily(SHOP_FAMILY_BY_CATEGORY[category]);
 if(!family)throw new Error(`goods-policy: the shop category ${category} is not classified`);
 return{family:family.id,classification:family.classification,transferable:family.classification===GOOD_CLASSES.transferable,rule:family.moves};
}

/** The readable classification surface: every family, and what this account may still move. */
export function goodsPolicyView(platform,actor,input={}){ if(!actor?.account||actor.kind!=='session')fail(403,'The classification of your own account-bound goods belongs to the signed-in operator.');
 for(const key of Object.keys(input))if(!['agent_id'].includes(key))fail(400,'Ask about one resident at a time, or none at all.');
 const accountId=actor.account.id;
 if(input.agent_id)platform.ownedAgent(actor,input.agent_id);
 const reservations=shopReservations(platform,accountId);
 const account_bound=[...reservations].map(([kind,reserved])=>{
  const held=heldByAccount(platform,accountId,kind),surplus=Math.max(0,held-reserved);
  return{kind,reserved,held,transferable:surplus,reason_code:GOOD_REFUSAL_CODES.account_bound_good,
   reason:siblingReason(kind,reserved),family:familiesForKind(kind).find((id)=>goodFamily(id).classification===GOOD_CLASSES.account_bound)};
 });
 return{
  account_id:accountId,policy:GOOD_POLICY,families:GOOD_FAMILIES,item_kinds:ITEM_KINDS,
  transferable_kinds:ITEM_KINDS.filter((kind)=>!reservations.has(kind)),
  account_bound,
  units:{separation:UNIT_SEPARATION_POLICY,currencies:{karma:KARMA_POLICY.currency,nemocoin:COIN_POLICY.currency}},
  refusal_codes:GOOD_REFUSAL_CODES,
  server_time:platform.clock(),
 };
}
const siblingReason=(kind,reserved)=>`${kind} is account-bound: ${reserved} were bought from the shop, and only the surplus above this reservation can leave the account.`;
export const goodsMethods={
 goodsPolicy(actor,input={}){return goodsPolicyView(this,actor,input);},
 goodsPolicyExport(actor){return goodsPolicyExport(this,actor);},
};
/** The operator's own copy of the classification in the account export. No purchase keys, no hashes. */
export function goodsPolicyExport(platform,actor){
 if(actor?.kind!=='session'||!actor.account)fail(403,'Only the operator can export the classification of their own goods.');
 const reservations=shopReservations(platform,actor.account.id);
 return{policy_version:GOOD_POLICY.version,policy_text:GOOD_POLICY.description,families:GOOD_FAMILIES,item_kinds:ITEM_KINDS,
  account_bound:[...reservations].map(([kind,reserved])=>({kind,reserved,held:heldByAccount(platform,actor.account.id,kind),reason_code:GOOD_REFUSAL_CODES.account_bound_good}))};
}

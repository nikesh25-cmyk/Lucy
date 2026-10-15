// The Karma Coin ledger: a second, entirely separate in-world unit.
//
// Karma Coins are earned by service in the world and spent in the shop. NemoCoins (src/coins.js) are
// untouched by this module: nothing here reads, writes, converts or transfers a coin reward, and no
// amount, reason or source identifier is ever taken from a request, a model output or a prompt.
//
// Five rules this module enforces in SQL as well as in the methods that write:
//
//   * The faucet only reads rows the server itself already wrote. A receipt may be minted only against
//     an existing row of a service's own source table (`karma_source_events`), for the resident that
//     row belongs to, and that row may produce one receipt and no more.
//   * Two tiers: world service (your own saved labour, award 2) and service to others (a larger award,
//     6, which must involve a *different operator* — several characters of one operator are one
//     operator).
//   * The day is the UTC day of `platform.clock()`, never a client timestamp or a request field.
//   * The balance is derived, never stored: SUM(earned) - SUM(spent), which the purchase trigger
//     refuses to drive below zero.
//   * Receipts and purchases are append-only and hash-chained, so an edited row is detectable.
import {createHash,randomUUID} from 'node:crypto';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const hash=value=>createHash('sha256').update(value).digest('hex');
const day=platform=>new Date(platform.clock()).toISOString().slice(0,10);
// An integer millisecond column as the ISO instant the receipt records beside it. The same expression
// is used to write `source_at` and to verify it, so the two can never drift apart.
const isoMs=value=>`strftime('%Y-%m-%dT%H:%M:%fZ',(${value})/1000.0,'unixepoch')`;

// ---- The policy ---------------------------------------------------------------------------------
// The no-value flags are booleans, not prose, so a consumer can check them; the sentences state the
// same rules as plainly as the coin policy does.
export const KARMA_POLICY=Object.freeze({
 version:1,
 currency:'Karma Coins',
 unit:'karma',
 daily_operator_limit:60,
 daily_service_limit:2,
 tiers:Object.freeze({
  world:Object.freeze({id:'world',label:'World service',award:2,per_day:2,requires_other_operator:false}),
  service:Object.freeze({id:'service',label:'Service to others',award:6,per_day:2,requires_other_operator:true}),
 }),
 earned:'Only service the server itself already recorded earns Karma Coins: your own saved labour in the world, or service to a different operator confirmed by a row that operator’s side of the world holds. No request field, model output or prompt can name an amount, a reason or a source.',
 not_earned:'Nothing is credited for chatting, posting, claiming, submitting, reviewing, adopting, logging in, or any action that only the resident itself declared.',
 separate_unit:true,
 transferable:false,
 transferable_between_accounts:false,
 transferable_between_residents:false,
 cash_value:false,
 cash_out:false,
 token:false,
 convertible:false,
 convertible_from_nemo_coins:false,
 convertible_to_nemo_coins:false,
 convertible_to_money:false,
 convertible_to_carbon_credits:false,
 buys_land:false,
 buys_role:false,
 buys_experience:false,
 buys_review_authority:false,
 buys_moderation_power:false,
 buys_runtime_scope:false,
 spent_on:'in-world shop goods only; a purchase is an append-only debit that grants nothing outside the shop',
 day:'the UTC day is taken from the server clock only',
 description:'Karma Coins are a separate in-world unit for service in the world. They are never convertible to or from NemoCoins, money or verified carbon credits, are never transferable between accounts or residents, have no cash-out and no token, and buy no land, role, experience, review authority, moderation power or runtime scope.',
 sentence:'Karma Coins are earned by service in the world and spent only in the shop: they are not NemoCoins, not money, have no cash value, cannot be transferred or converted, and buy nothing that is not an in-world good.',
});

// ---- The catalogue ------------------------------------------------------------------------------
// `source_kind` names the kind of saved server row the service is credited from; `note` says which
// table and which cross-operator rule proves it. Every one of these is read from `karma_source_events`
// below, which is generated from this catalogue, so a service and its evidence cannot drift apart.
export const KARMA_SERVICES=Object.freeze([
 Object.freeze({id:'garden_crop',label:'A crop planted in your own garden',tier:'world',award:2,per_day:2,requires_other_operator:false,source_kind:'crop_plant',note:'A saved journey_crops row for a farm tile in the garden of your own resident.'}),
 Object.freeze({id:'garden_harvest',label:'A crop the server confirmed as mature and you gathered',tier:'world',award:2,per_day:2,requires_other_operator:false,source_kind:'crop_harvest',note:'The same journey_crops row, credited once when the server recorded its harvest time.'}),
 Object.freeze({id:'home_furnishing',label:'An object saved in your own garden or cottage',tier:'world',award:2,per_day:2,requires_other_operator:false,source_kind:'home_furnish',note:'A saved world_objects row in a home or cottage your own resident owns. A farm tile is the garden’s own tool and is never a furnishing; the crop planted on it is the credited act.'}),
 Object.freeze({id:'crafted_keepsake',label:'A keepsake crafted after its ingredients were debited',tier:'world',award:2,per_day:2,requires_other_operator:false,source_kind:'craft',note:'The audit row the server wrote when the craft committed, matched to the resident whose ingredient debit it followed.'}),
 Object.freeze({id:'saved_block',label:'A block or path saved inside your own operator’s plot',tier:'world',award:2,per_day:2,requires_other_operator:false,source_kind:'frontier_place',note:'A saved frontier_blocks row inside the plot your operator stewards, built by your own resident.'}),
 Object.freeze({id:'shared_space_visit',label:'A recorded visit to another operator’s shared place',tier:'service',award:6,per_day:2,requires_other_operator:true,source_kind:'shared_visit',note:'A saved journey_visits row for a public world owned by a different operator’s resident.'}),
 Object.freeze({id:'thanks_to_neighbor',label:'A thank-you recorded for a resident of a different operator',tier:'service',award:6,per_day:2,requires_other_operator:true,source_kind:'thanks',note:'A saved community_thanks row whose giver and recipient belong to different operators.'}),
 Object.freeze({id:'neighbor_circle',label:'Membership of an active circle another operator keeps',tier:'service',award:6,per_day:2,requires_other_operator:true,source_kind:'circle_join',note:'A saved community_members row for a circle created by a different operator’s resident.'}),
 Object.freeze({id:'neighbor_pledge',label:'A pledge recorded against another operator’s project',tier:'service',award:6,per_day:2,requires_other_operator:true,source_kind:'project_pledge',note:'A saved community_pledges row on a project created by a different operator. A promise is still not completed work.'}),
 Object.freeze({id:'neighbor_gathering',label:'A pledge to attend another operator’s gathering',tier:'service',award:6,per_day:2,requires_other_operator:true,source_kind:'event_rsvp',note:'A saved community_rsvps row, recorded before another operator’s gathering starts.'}),
 Object.freeze({id:'guild_contribution',label:'A guild contribution a different operator verified',tier:'service',award:6,per_day:2,requires_other_operator:true,source_kind:'guild_contribution',note:'A verified guild_contributions row on another operator’s project, verified by an operator who is neither the contributor nor the project creator.'}),
 Object.freeze({id:'guild_participation',label:'Participation in a guild project another operator keeps',tier:'service',award:6,per_day:2,requires_other_operator:true,source_kind:'guild_participation',note:'An active guild_participants row on a project created by a different operator’s resident.'}),
]);
const SERVICE_IDS=KARMA_SERVICES.map(service=>`'${service.id}'`).join(',');
const AWARDS=[...new Set(KARMA_SERVICES.map(service=>service.award))].join(',');
const PER_DAYS=[...new Set(KARMA_SERVICES.map(service=>service.per_day))].join(',');
const SERVICE_BY_ID=new Map(KARMA_SERVICES.map(service=>[service.id,service]));

// ---- The one saved-fact source registry ----------------------------------------------------------
// Each service reads exactly one kind of row the server already wrote, through one SQL fragment. A
// service-to-others fragment carries the cross-operator rule itself, so a row that a single operator
// could produce on its own is simply not an event the faucet can see.
const source=(service_id,source_kind,agent,id,date,from,where='1')=>`SELECT '${service_id}' AS service_id,'${source_kind}' AS source_kind,${agent} AS agent_id,${id} AS source_id,${date} AS occurred_at FROM ${from} WHERE ${where}`;
const SOURCE_SQL=Object.freeze({
 garden_crop:source('garden_crop','crop_plant','c.agent_id',"CAST(c.x AS TEXT)||':'||CAST(c.y AS TEXT)||':'||CAST(c.planted_at AS TEXT)",isoMs('c.planted_at'),'journey_crops c'),
 garden_harvest:source('garden_harvest','crop_harvest','c.agent_id',"CAST(c.x AS TEXT)||':'||CAST(c.y AS TEXT)||':'||CAST(c.planted_at AS TEXT)||':harvest'",isoMs('c.harvested_at'),'journey_crops c','c.harvested_at IS NOT NULL'),
 // A farm tile is the garden's own tool, never a furnishing: the crop planted on it is the credited
 // act, and crediting the tile too would pay one act twice.
 home_furnishing:source('home_furnishing','home_furnish','w.owner_agent_id','b.id','b.created_at','world_objects b JOIN worlds w ON w.id=b.world_id JOIN agents owner ON owner.id=w.owner_agent_id',"w.kind IN ('home','house') AND b.type!='farm' AND owner.status IN ('active','paused')"),
 crafted_keepsake:source('crafted_keepsake','craft','p.agent_id','CAST(a.seq AS TEXT)','a.created_at','audit a JOIN journey_profiles p ON p.agent_id=a.record_id JOIN agents resident ON resident.id=p.agent_id',"a.event='journey.crafted' AND a.actor=resident.operator_id AND p.crafts>0"),
 saved_block:source('saved_block','frontier_place','b.creator_agent_id','b.id','b.created_at','frontier_blocks b JOIN land_stewardships s ON s.plot_id=b.plot_id JOIN agents builder ON builder.id=b.creator_agent_id','b.plot_id IS NOT NULL AND s.account_id=builder.operator_id AND b.creator_account_id=builder.operator_id'),
 shared_space_visit:source('shared_space_visit','shared_visit','v.agent_id',"v.world_id||':'||CAST(v.visited_at AS TEXT)",isoMs('v.visited_at'),'journey_visits v JOIN worlds w ON w.id=v.world_id JOIN agents owner ON owner.id=w.owner_agent_id JOIN agents visitor ON visitor.id=v.agent_id',"w.visibility='public' AND owner.operator_id!=visitor.operator_id AND owner.status IN ('active','paused')"),
 thanks_to_neighbor:source('thanks_to_neighbor','thanks','t.giver_agent_id','t.id','t.created_at','community_thanks t JOIN agents giver ON giver.id=t.giver_agent_id JOIN agents recipient ON recipient.id=t.recipient_agent_id JOIN accounts other ON other.id=recipient.operator_id',"giver.operator_id!=recipient.operator_id AND recipient.status IN ('active','paused') AND other.status='active'"),
 neighbor_circle:source('neighbor_circle','circle_join','m.agent_id',"m.circle_id||':'||m.joined_at",'m.joined_at','community_members m JOIN community_circles c ON c.id=m.circle_id JOIN agents creator ON creator.id=c.creator_agent_id JOIN agents member ON member.id=m.agent_id JOIN accounts owner ON owner.id=creator.operator_id',"c.status='active' AND creator.operator_id!=member.operator_id AND creator.status IN ('active','paused') AND owner.status='active'"),
 neighbor_pledge:source('neighbor_pledge','project_pledge','p.agent_id',"p.project_id||':'||p.created_at",'p.created_at','community_pledges p JOIN community_projects c ON c.id=p.project_id JOIN agents creator ON creator.id=c.creator_agent_id JOIN agents member ON member.id=p.agent_id JOIN accounts owner ON owner.id=creator.operator_id',"c.status IN ('active','completed') AND creator.operator_id!=member.operator_id AND creator.status IN ('active','paused') AND owner.status='active'"),
 neighbor_gathering:source('neighbor_gathering','event_rsvp','r.agent_id',"r.event_id||':'||r.created_at",'r.created_at','community_rsvps r JOIN community_events e ON e.id=r.event_id JOIN agents creator ON creator.id=e.creator_agent_id JOIN agents member ON member.id=r.agent_id JOIN accounts owner ON owner.id=creator.operator_id',"e.status IN ('scheduled','active','completed') AND creator.operator_id!=member.operator_id AND creator.status IN ('active','paused') AND owner.status='active' AND r.created_at<e.starts_at"),
 guild_contribution:source('guild_contribution','guild_contribution','c.agent_id','c.id','c.verified_at','guild_contributions c JOIN guild_projects p ON p.id=c.project_id JOIN agents contributor ON contributor.id=c.agent_id JOIN agents creator ON creator.id=p.creator_agent_id JOIN agents verifier ON verifier.id=c.verified_by_agent_id JOIN accounts verifying ON verifying.id=c.verified_by_account_id',"c.status='verified' AND c.verified_by_agent_id IS NOT NULL AND c.verified_at IS NOT NULL AND c.verified_by_account_id!=c.account_id AND c.verified_by_account_id!=creator.operator_id AND verifier.operator_id=c.verified_by_account_id AND contributor.operator_id!=creator.operator_id AND contributor.status IN ('active','paused') AND creator.status IN ('active','paused') AND verifier.status IN ('active','paused') AND verifying.status='active' AND p.status!='archived'"),
 guild_participation:source('guild_participation','guild_participation','g.agent_id',"g.project_id||':'||g.joined_at",'g.joined_at','guild_participants g JOIN guild_projects p ON p.id=g.project_id JOIN agents member ON member.id=g.agent_id JOIN agents creator ON creator.id=p.creator_agent_id JOIN accounts owner ON owner.id=creator.operator_id',"g.state='active' AND creator.operator_id!=member.operator_id AND creator.status IN ('active','paused') AND owner.status='active' AND p.status!='archived'"),
});
// Checked once at load, so a service with no saved row behind it, or a fragment nothing names, cannot
// ship: the catalogue and the source registry stay one list.
for(const service of KARMA_SERVICES)if(!SOURCE_SQL[service.id])throw new Error(`karma: ${service.id} has no verified source row`);
for(const id of Object.keys(SOURCE_SQL))if(!SERVICE_BY_ID.has(id))throw new Error(`karma: ${id} is not a listed service`);
// The catalogue is checked against the stated policy in the same pass: a service that pays more than
// its tier allows, or more often than the policy states, cannot ship.
for(const service of KARMA_SERVICES){
 const tier=KARMA_POLICY.tiers[service.tier];
 if(!tier||service.award!==tier.award||service.per_day!==tier.per_day||service.requires_other_operator!==tier.requires_other_operator)throw new Error(`karma: ${service.id} does not match its tier policy`);
 if(service.per_day!==KARMA_POLICY.daily_service_limit)throw new Error(`karma: ${service.id} is outside the stated daily service allowance`);
}
const RULES_SQL=KARMA_SERVICES.map(service=>`SELECT '${service.id}' AS service_id,'${service.tier}' AS tier,${service.award} AS award,${service.per_day} AS per_day,${service.requires_other_operator?1:0} AS requires_other_operator,'${service.source_kind}' AS source_kind`).join(' UNION ALL ');
const EVENTS_SQL=KARMA_SERVICES.map(service=>SOURCE_SQL[service.id]).join(' UNION ALL ');

// ---- The schema ---------------------------------------------------------------------------------
// The two views carry the catalogue into SQL, so `karma_receipts_validate_insert` can refuse a
// receipt the catalogue does not define and a receipt with no saved source row of its own. They are
// dropped and rebuilt on every install because they are derived: no stored row is touched.
export const KARMA_SCHEMA=`
CREATE TABLE IF NOT EXISTS karma_receipts(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,agent_id TEXT NOT NULL REFERENCES agents(id),account_id TEXT NOT NULL REFERENCES accounts(id),service_id TEXT NOT NULL CHECK(service_id IN (${SERVICE_IDS})),tier TEXT NOT NULL CHECK(tier IN ('world','service')),source_kind TEXT NOT NULL,source_id TEXT NOT NULL,source_at TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount IN (${AWARDS})),per_day INTEGER NOT NULL CHECK(per_day IN (${PER_DAYS})),requires_other_operator INTEGER NOT NULL CHECK(requires_other_operator IN (0,1)),award_day TEXT NOT NULL CHECK(length(award_day)=10),policy_version INTEGER NOT NULL CHECK(policy_version=${KARMA_POLICY.version}),created_at TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL,UNIQUE(agent_id,source_kind,source_id));
CREATE INDEX IF NOT EXISTS karma_receipts_operator_day ON karma_receipts(account_id,award_day);
CREATE INDEX IF NOT EXISTS karma_receipts_resident ON karma_receipts(agent_id,created_at);
CREATE TABLE IF NOT EXISTS karma_purchases(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,account_id TEXT NOT NULL REFERENCES accounts(id),agent_id TEXT REFERENCES agents(id),good_id TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),balance_after INTEGER NOT NULL CHECK(balance_after>=0),policy_version INTEGER NOT NULL CHECK(policy_version=${KARMA_POLICY.version}),idempotency_key TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL,UNIQUE(account_id,idempotency_key));
CREATE INDEX IF NOT EXISTS karma_purchases_operator ON karma_purchases(account_id,created_at);
DROP VIEW IF EXISTS karma_service_rules;
DROP VIEW IF EXISTS karma_source_events;
CREATE VIEW karma_service_rules AS ${RULES_SQL};
CREATE VIEW karma_source_events AS ${EVENTS_SQL};
CREATE TRIGGER IF NOT EXISTS karma_receipts_no_update BEFORE UPDATE ON karma_receipts BEGIN SELECT RAISE(ABORT,'Karma receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS karma_receipts_no_delete BEFORE DELETE ON karma_receipts BEGIN SELECT RAISE(ABORT,'Karma receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS karma_receipts_validate_insert BEFORE INSERT ON karma_receipts BEGIN
 SELECT CASE WHEN NEW.previous_hash!=COALESCE((SELECT hash FROM karma_receipts ORDER BY seq DESC LIMIT 1),'') THEN RAISE(ABORT,'Karma chain mismatch') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM agents a JOIN accounts o ON o.id=a.operator_id WHERE a.id=NEW.agent_id AND a.operator_id=NEW.account_id AND a.status IN ('active','paused') AND o.status='active') THEN RAISE(ABORT,'Karma receipt needs an owned resident') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM karma_service_rules rule JOIN karma_source_events e ON e.service_id=rule.service_id AND e.agent_id=NEW.agent_id AND e.source_kind=NEW.source_kind AND e.source_id=NEW.source_id AND e.occurred_at=NEW.source_at WHERE rule.service_id=NEW.service_id AND rule.tier=NEW.tier AND rule.award=NEW.amount AND rule.per_day=NEW.per_day AND rule.requires_other_operator=NEW.requires_other_operator AND rule.source_kind=NEW.source_kind) THEN RAISE(ABORT,'Karma receipt needs a verified saved source') END;
 SELECT CASE WHEN NEW.award_day!=substr(NEW.created_at,1,10) THEN RAISE(ABORT,'Karma award day must be the server day') END;
 SELECT CASE WHEN COALESCE((SELECT SUM(amount) FROM karma_receipts WHERE account_id=NEW.account_id AND award_day=NEW.award_day),0)+NEW.amount>${KARMA_POLICY.daily_operator_limit} THEN RAISE(ABORT,'Operator daily karma limit') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM karma_receipts WHERE account_id=NEW.account_id AND service_id=NEW.service_id AND award_day=NEW.award_day)>=NEW.per_day THEN RAISE(ABORT,'Daily karma service limit') END;
END;
CREATE TRIGGER IF NOT EXISTS karma_purchases_no_update BEFORE UPDATE ON karma_purchases BEGIN SELECT RAISE(ABORT,'Karma purchases are append-only'); END;
CREATE TRIGGER IF NOT EXISTS karma_purchases_no_delete BEFORE DELETE ON karma_purchases BEGIN SELECT RAISE(ABORT,'Karma purchases are append-only'); END;
CREATE TRIGGER IF NOT EXISTS karma_purchases_validate_insert BEFORE INSERT ON karma_purchases BEGIN
 SELECT CASE WHEN NEW.previous_hash!=COALESCE((SELECT hash FROM karma_purchases ORDER BY seq DESC LIMIT 1),'') THEN RAISE(ABORT,'Karma purchase chain mismatch') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND status='active') THEN RAISE(ABORT,'Karma purchase needs an active operator') END;
 SELECT CASE WHEN (SELECT COALESCE(SUM(amount),0) FROM karma_receipts WHERE account_id=NEW.account_id)-(SELECT COALESCE(SUM(amount),0) FROM karma_purchases WHERE account_id=NEW.account_id)<NEW.amount THEN RAISE(ABORT,'Karma balance cannot go below zero') END;
END;`;

// ---- The chain proofs --------------------------------------------------------------------------
// Both hashes cover every immutable column, so an edited row no longer proves itself. `seq` is
// assigned by SQLite after the row is hashed and is deliberately not part of either proof.
export const karmaReceiptHash=row=>hash(JSON.stringify([row.id,row.agent_id,row.account_id,row.service_id,row.tier,row.source_kind,row.source_id,row.source_at,row.amount,row.per_day,row.requires_other_operator,row.award_day,row.policy_version,row.created_at,row.previous_hash]));
export const karmaPurchaseHash=row=>hash(JSON.stringify([row.id,row.account_id,row.agent_id,row.good_id,row.amount,row.balance_after,row.policy_version,row.idempotency_key,row.fingerprint,row.created_at,row.previous_hash]));

/**
 * The whole-ledger check: the receipt chain, every receipt against its source row, every purchase,
 * and each account's derived balance never going below zero. Used by the wallet, by a spend and by the
 * integrator's own recovery validation, so an invalid ledger fails every one of them closed.
 *
 * A receipt is re-checked against its source row whenever the world still holds that row. The world
 * legitimately forgets sources — a tile is re-planted, a circle is left, a furnishing is removed, an
 * operator deletes their journey record — and an honest receipt must survive that, so an absent row is
 * not a finding. A row that is still there and does not match the receipt is.
 */
export function verifyKarmaLedger(db){
 const tables=new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','view')").all().map(row=>row.name));
 if(!['karma_receipts','karma_purchases','karma_service_rules','karma_source_events'].every(name=>tables.has(name)))return false;
 const rules=new Map(db.prepare('SELECT * FROM karma_service_rules').all().map(row=>[row.service_id,row]));
 const sourceEvent=db.prepare('SELECT occurred_at FROM karma_source_events WHERE service_id=? AND agent_id=? AND source_kind=? AND source_id=?');
 const owned=db.prepare('SELECT id FROM agents WHERE id=? AND operator_id=?');
 const account=db.prepare('SELECT id FROM accounts WHERE id=?');
 let previous='';const dayTotals=new Map(),serviceTotals=new Map();
 for(const row of db.prepare('SELECT * FROM karma_receipts ORDER BY seq').all()){
  const rule=rules.get(row.service_id),service=SERVICE_BY_ID.get(row.service_id);
  if(!rule||!service)return false;
  if(row.previous_hash!==previous||row.hash!==karmaReceiptHash(row))return false;
  if(row.tier!==rule.tier||row.amount!==rule.award||row.per_day!==rule.per_day||row.requires_other_operator!==rule.requires_other_operator||row.source_kind!==rule.source_kind||row.source_kind!==service.source_kind)return false;
  if(row.policy_version!==KARMA_POLICY.version||!/^\d{4}-\d{2}-\d{2}$/.test(row.award_day)||row.award_day!==row.created_at.slice(0,10)||!Number.isFinite(Date.parse(row.created_at)))return false;
  if(!owned.get(row.agent_id,row.account_id))return false;
  const key=`${row.account_id}:${row.award_day}`,used=(dayTotals.get(key)||0)+row.amount;if(used>KARMA_POLICY.daily_operator_limit)return false;dayTotals.set(key,used);
  const serviceKey=`${key}:${row.service_id}`,count=(serviceTotals.get(serviceKey)||0)+1;if(count>row.per_day)return false;serviceTotals.set(serviceKey,count);
  const event=sourceEvent.get(row.service_id,row.agent_id,row.source_kind,row.source_id);
  if(event&&event.occurred_at!==row.source_at)return false;
  previous=row.hash;
 }
 const earned=new Map(db.prepare('SELECT account_id,SUM(amount) AS n FROM karma_receipts GROUP BY account_id').all().map(row=>[row.account_id,row.n]));
 const spent=new Map();let purchasePrevious='';
 for(const row of db.prepare('SELECT * FROM karma_purchases ORDER BY seq').all()){
  if(row.previous_hash!==purchasePrevious||row.hash!==karmaPurchaseHash(row))return false;
  if(row.policy_version!==KARMA_POLICY.version||!Number.isInteger(row.amount)||row.amount<1||!Number.isInteger(row.balance_after)||row.balance_after<0)return false;
  if(!Number.isFinite(Date.parse(row.created_at))||!String(row.good_id||'').trim()||!String(row.idempotency_key||'').trim()||row.fingerprint!==hash(JSON.stringify([row.good_id,row.amount])))return false;
  if(!account.get(row.account_id))return false;
  if(row.agent_id!==null&&!owned.get(row.agent_id,row.account_id))return false;
  spent.set(row.account_id,(spent.get(row.account_id)||0)+row.amount);
  purchasePrevious=row.hash;
 }
 for(const [accountId,total] of spent)if((earned.get(accountId)||0)-total<0)return false;
 return true;
}
// The account's purse, derived on every read. Nothing stores a balance, so nothing can drift from it.
const derivedBalance=(platform,accountId)=>platform.get('SELECT (SELECT COALESCE(SUM(amount),0) FROM karma_receipts WHERE account_id=?)-(SELECT COALESCE(SUM(amount),0) FROM karma_purchases WHERE account_id=?) AS n',accountId,accountId).n;
const purchaseFingerprint=(goodId,amount)=>hash(JSON.stringify([goodId,amount]));

const initialized=new WeakSet();
function ensureKarmaSchema(platform){
 if(initialized.has(platform.db))return;
 platform.db.exec(KARMA_SCHEMA);
 initialized.add(platform.db);
}
function requireKarmaSchema(platform){
 if(!platform.get("SELECT name FROM sqlite_master WHERE type='table' AND name='karma_receipts'"))fail(503,'The Karma ledger is not installed on this platform; call initKarma first.');
}
// The whole visibility rule, copied from src/vocations.js: a session reaches only its own residents, a
// runtime credential reaches only the exact character it runs, and anyone else gets 404.
function owned(platform,actor,input){
 if(!actor?.account||!['session','runtime'].includes(actor.kind))fail(401,'Sign in or use an owned agent runtime.');
 const agent=platform.ownedAgent(actor,input?.agent_id||actor.agent?.id);if(agent.status==='deleted')fail(404,'Resident not found.');return agent;
}

/**
 * Mint every receipt one resident can still earn, and return how many were minted. This is the only
 * faucet: it reads the source registry itself, takes no amount, reason or source from the caller, and
 * is idempotent because a saved row can produce one receipt. It opens no transaction of its own, so
 * the caller can put it inside the same `platform.transaction(...)` as the action that saved the row.
 */
export function karmaReconcile(platform,agent){
 const resident=platform.get('SELECT id,operator_id,status,kind FROM agents WHERE id=?',agent?.id||'');
 if(!resident||!['agent','human'].includes(resident.kind))return 0;
 const account=platform.get('SELECT id,status FROM accounts WHERE id=?',resident.operator_id);
 if(!account||account.status!=='active'||!['active','paused'].includes(resident.status))return 0;
 ensureKarmaSchema(platform);
 // The trigger refuses an insert onto a broken chain anyway; refusing here keeps the caller's own
 // transaction intact instead of aborting it, and the wallet still fails closed with 503.
 if(!verifyKarmaLedger(platform.db))return 0;
 const awardDay=day(platform),created=new Date(platform.clock()).toISOString();
 let minted=0,used=platform.get('SELECT COALESCE(SUM(amount),0) AS n FROM karma_receipts WHERE account_id=? AND award_day=?',account.id,awardDay).n;
 for(const service of KARMA_SERVICES){
  if(used>=KARMA_POLICY.daily_operator_limit)break;
  for(let slot=platform.get('SELECT COUNT(*) AS n FROM karma_receipts WHERE account_id=? AND service_id=? AND award_day=?',account.id,service.id,awardDay).n;slot<service.per_day;slot++){
   if(used+service.award>KARMA_POLICY.daily_operator_limit)break;
   const event=platform.get('SELECT e.* FROM karma_source_events e WHERE e.service_id=? AND e.agent_id=? AND NOT EXISTS(SELECT 1 FROM karma_receipts r WHERE r.agent_id=e.agent_id AND r.source_kind=e.source_kind AND r.source_id=e.source_id) ORDER BY e.occurred_at,e.source_id LIMIT 1',service.id,resident.id);
   if(!event)break;
   const row={id:randomUUID(),agent_id:resident.id,account_id:account.id,service_id:service.id,tier:service.tier,source_kind:event.source_kind,source_id:event.source_id,source_at:event.occurred_at,amount:service.award,per_day:service.per_day,requires_other_operator:service.requires_other_operator?1:0,award_day:awardDay,policy_version:KARMA_POLICY.version,created_at:created,previous_hash:platform.get('SELECT hash FROM karma_receipts ORDER BY seq DESC LIMIT 1')?.hash||''};
   row.hash=karmaReceiptHash(row);
   platform.run('INSERT INTO karma_receipts(id,agent_id,account_id,service_id,tier,source_kind,source_id,source_at,amount,per_day,requires_other_operator,award_day,policy_version,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',row.id,row.agent_id,row.account_id,row.service_id,row.tier,row.source_kind,row.source_id,row.source_at,row.amount,row.per_day,row.requires_other_operator,row.award_day,row.policy_version,row.created_at,row.previous_hash,row.hash);
   platform.audit(account.id,'karma.earned',row.id);
   minted+=1;used+=service.award;
  }
 }
 return minted;
}

export const karmaMethods={
 // The integrator's seam, exactly like initGuilds or initJourney: call it once from the Platform
 // constructor. The settle pass heals a platform that never called it; the wallet and a spend report
 // 503 with that instruction instead of creating tables during a read.
 initKarma(){this.db.exec(KARMA_SCHEMA);},
 /**
  * The read-only wallet projection for one resident. It shows the operator's own purse: Karma Coins
  * are held and spent per operator account (that is what the daily cap and the purchase key are
  * measured against), and this read names the resident it was asked about. It writes nothing.
  */
 karmaWallet(actor,input={}){
  if(!input||Object.keys(input).some(key=>key!=='agent_id'))fail(400,'Inspect one resident at a time. Ask for a resident id or nothing at all.');
  const agent=owned(this,actor,input);requireKarmaSchema(this);
  if(!verifyKarmaLedger(this.db))fail(503,'Karma ledger integrity needs administrator inspection.');
  const accountId=agent.operator_id,today=day(this);
  const earned=this.get('SELECT COALESCE(SUM(amount),0) AS n FROM karma_receipts WHERE account_id=?',accountId).n;
  const spent=this.get('SELECT COALESCE(SUM(amount),0) AS n FROM karma_purchases WHERE account_id=?',accountId).n;
  const balance=earned-spent;
  if(!Number.isSafeInteger(balance)||balance<0)fail(503,'Karma balance exceeds supported bounds.');
  const earnedToday=this.get('SELECT COALESCE(SUM(amount),0) AS n FROM karma_receipts WHERE account_id=? AND award_day=?',accountId,today).n;
  const spentToday=this.get("SELECT COALESCE(SUM(amount),0) AS n FROM karma_purchases WHERE account_id=? AND substr(created_at,1,10)=?",accountId,today).n;
  const usedByService=new Map(this.all('SELECT service_id,COUNT(*) AS n FROM karma_receipts WHERE account_id=? AND award_day=? GROUP BY service_id',accountId,today).map(row=>[row.service_id,row.n]));
  const mintedByService=new Map(this.all('SELECT service_id,COUNT(*) AS n FROM karma_receipts WHERE account_id=? GROUP BY service_id',accountId).map(row=>[row.service_id,row.n]));
  const services=KARMA_SERVICES.map(service=>{
   const usedToday=usedByService.get(service.id)||0;
   return{...service,tier_label:KARMA_POLICY.tiers[service.tier].label,hint:service.note,used_today:usedToday,minted:mintedByService.get(service.id)||0,remaining_today:Math.max(0,service.per_day-usedToday)};
  });
  const receipts=this.all('SELECT r.id,r.service_id,r.tier,r.amount,r.agent_id,r.source_kind,r.source_id,r.source_at,r.award_day,r.created_at,a.name AS agent_name FROM karma_receipts r LEFT JOIN agents a ON a.id=r.agent_id WHERE r.account_id=? ORDER BY r.seq DESC LIMIT 100',accountId)
   .map(row=>({direction:'earn',id:row.id,amount:row.amount,label:SERVICE_BY_ID.get(row.service_id)?.label||row.service_id,service_id:row.service_id,tier:row.tier,agent_id:row.agent_id,agent_name:row.agent_name,source_kind:row.source_kind,source_id:row.source_id,source_at:row.source_at,day:row.award_day,created_at:row.created_at}));
  const purchases=this.all('SELECT id,good_id,amount,balance_after,created_at FROM karma_purchases WHERE account_id=? ORDER BY seq DESC LIMIT 100',accountId)
   .map(row=>({direction:'spend',id:row.id,amount:row.amount,label:`Spent on ${row.good_id}`,good_id:row.good_id,balance_after:row.balance_after,day:String(row.created_at).slice(0,10),created_at:row.created_at}));
  const entries=[...receipts,...purchases].sort((left,right)=>String(right.created_at).localeCompare(String(left.created_at))||String(right.id).localeCompare(String(left.id)));
  const receiptCount=this.get('SELECT COUNT(*) AS n FROM karma_receipts WHERE account_id=?',accountId).n;
  const purchaseCount=this.get('SELECT COUNT(*) AS n FROM karma_purchases WHERE account_id=?',accountId).n;
  return{
   agent_id:agent.id,name:agent.name,account_id:accountId,currency:KARMA_POLICY.currency,unit:KARMA_POLICY.unit,
   balance,earned,spent,policy:KARMA_POLICY,policy_text:KARMA_POLICY.sentence,services,
   today:{day:today,earned:earnedToday,spent:spentToday,limit:KARMA_POLICY.daily_operator_limit,remaining:Math.max(0,KARMA_POLICY.daily_operator_limit-earnedToday)},
   entries:entries.slice(0,100),
   counts:{receipts:receiptCount,receipts_today:this.get('SELECT COUNT(*) AS n FROM karma_receipts WHERE account_id=? AND award_day=?',accountId,today).n,purchases:purchaseCount,purchases_today:this.get("SELECT COUNT(*) AS n FROM karma_purchases WHERE account_id=? AND substr(created_at,1,10)=?",accountId,today).n,earned,spent},
   ledger_scope:'operator account',has_more:receiptCount+purchaseCount>entries.length,
   verify:{ledger:true,chain:true,sources:true,balance_non_negative:true},integrity_valid:true,
   server_time:this.clock(),
  };
 },
 /**
  * Settle one owned resident and report what it earned. Only the signed-in human operator can ask:
  * a resident credential never mints, and the amount, the source and the day all come from the server.
  */
 karmaSettle(actor,input={}){
  if(!input||Object.keys(input).some(key=>key!=='agent_id'))fail(400,'Settle one resident at a time.');
  if(actor?.kind!=='session')fail(403,'Only the signed-in human operator can settle Karma Coins.');
  const agent=owned(this,actor,input);this.active();
  // A human avatar and an AI resident both do service in the world, and both hold a home, a garden and
  // a shelf, so both may settle what they earned. What is bounded is the work, not the kind of
  // resident: one receipt per saved row, at most two a day per service, sixty a day per operator, and
  // every service to another resident must name a different operator.
  const resident=this.get('SELECT id,operator_id FROM agents WHERE id=?',agent.id);
  if(!resident)fail(404,'Resident not found.');
  const minted=karmaReconcile(this,agent);
  return{agent_id:agent.id,minted,balance:derivedBalance(this,resident.operator_id),today:{day:day(this),earned:this.get('SELECT COALESCE(SUM(amount),0) AS n FROM karma_receipts WHERE account_id=? AND award_day=?',resident.operator_id,day(this)).n,limit:KARMA_POLICY.daily_operator_limit}};
 },
 /**
  * The one debit. Call it inside the caller's existing `platform.transaction(...)` so the debit and the
  * grant it pays for are one atomic unit: this method opens no transaction of its own, and a refusal
  * leaves no row, no audit entry and no state behind. `ok:false` is the shop's normal refusal (the
  * purse is short, or the account is paused); a malformed request, a replayed key used for other goods
  * and a caller who is not the signed-in operator throw instead.
  */
 karmaSpend(actor,input){
  if(actor?.kind!=='session'||!actor.account)fail(403,'Only the signed-in human operator can spend Karma Coins.');
  this.active();requireKarmaSchema(this);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['amount','good_id','key'].includes(key)))fail(400,'A purchase names only an amount, a good and an idempotency key.');
  const account=this.get('SELECT id,status FROM accounts WHERE id=?',actor.account.id);
  if(!account)fail(404,'Account not found.');
  const amount=Number(input.amount);
  if(!Number.isInteger(amount)||amount<1||amount>KARMA_POLICY.daily_operator_limit)fail(400,`A Karma purchase costs a whole number of 1–${KARMA_POLICY.daily_operator_limit} Karma Coins.`);
  const goodId=typeof input.good_id==='string'?input.good_id.trim():'';
  if(!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(goodId))fail(400,'Name the good being bought as a lowercase identifier.');
  const key=typeof input.key==='string'?input.key.trim():'';
  if(!key||key.length>100)fail(400,'A purchase needs an idempotency key of 1–100 characters.');
  if(!verifyKarmaLedger(this.db))fail(503,'Karma ledger integrity needs administrator inspection.');
  const previous=this.get('SELECT * FROM karma_purchases WHERE account_id=? AND idempotency_key=?',account.id,key);
  if(previous){
   if(previous.good_id!==goodId||previous.amount!==amount)fail(409,'This purchase key was already used for a different good or amount.');
   return{ok:true,balance_after:previous.balance_after,purchase_id:previous.id,reason:'This purchase was already recorded under this key; nothing was debited twice.',repeated:true};
  }
  const balance=derivedBalance(this,account.id);
  if(balance<0||!Number.isSafeInteger(balance))fail(503,'Karma balance exceeds supported bounds.');
  if(account.status!=='active')return{ok:false,balance_after:balance,purchase_id:null,reason:'This operator account is paused, so it cannot spend Karma Coins.',reason_code:'account_paused'};
  if(balance<amount)return{ok:false,balance_after:balance,purchase_id:null,reason:`This purse holds ${balance} Karma Coins, so it cannot pay ${amount}.`,reason_code:'insufficient_balance'};
  const row={id:randomUUID(),account_id:account.id,agent_id:actor.agent?.id||null,good_id:goodId,amount,balance_after:balance-amount,policy_version:KARMA_POLICY.version,idempotency_key:key,fingerprint:purchaseFingerprint(goodId,amount),created_at:new Date(this.clock()).toISOString(),previous_hash:this.get('SELECT hash FROM karma_purchases ORDER BY seq DESC LIMIT 1')?.hash||''};
  row.hash=karmaPurchaseHash(row);
  this.run('INSERT INTO karma_purchases(id,account_id,agent_id,good_id,amount,balance_after,policy_version,idempotency_key,fingerprint,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',row.id,row.account_id,row.agent_id,row.good_id,row.amount,row.balance_after,row.policy_version,row.idempotency_key,row.fingerprint,row.created_at,row.previous_hash,row.hash);
  this.audit(account.id,'karma.spent',row.id);
  return{ok:true,balance_after:row.balance_after,purchase_id:row.id,reason:'The Karma Coins were debited once.',repeated:false};
 },
 // The operator's own export: the whole purse, both halves of the ledger, and the catalogue. The chain
 // hashes, purchase keys and fingerprints are integrity internals, not the operator's records, so they
 // stay out of the export exactly as the coin export leaves its hashes out.
 karmaExport(actor){
  if(actor?.kind!=='session')fail(403,'Only the operator can export Karma records.');
  requireKarmaSchema(this);
  const accountId=actor.account.id;
  return{policy_version:KARMA_POLICY.version,policy_text:KARMA_POLICY.sentence,services:KARMA_SERVICES,account_id:accountId,balance:derivedBalance(this,accountId),integrity_valid:verifyKarmaLedger(this.db),
   receipts:this.all('SELECT id,agent_id,service_id,tier,source_kind,source_id,source_at,amount,per_day,requires_other_operator,award_day,policy_version,created_at FROM karma_receipts WHERE account_id=? ORDER BY seq LIMIT 5000',accountId),
   purchases:this.all('SELECT id,agent_id,good_id,amount,balance_after,policy_version,created_at FROM karma_purchases WHERE account_id=? ORDER BY seq LIMIT 5000',accountId)};
 },
};

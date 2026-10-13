import {createHash,randomUUID} from 'node:crypto';
export const COIN_POLICY=Object.freeze({version:1,award:10,operator_daily_limit:100,currency:'Nemo Coins',unit:'coins',transferable:false,description:'10 coins for one independently accepted agent contribution per real task; up to 100 per operator per UTC day. No practice, duplicate, gardening or social rewards. Internal contribution credits; no cash value or transfers.'});
// The world has four separate units of account. NemoCoin exists and has the append-only ledger above;
// the other three are unimplemented concepts with no balance, ledger, transfer or conversion route.
// Nothing converts between any two, there is no cash-out and no token. A future unit needs its own
// design, evidence standard and authorization review, never an implicit conversion.
export const CREDIT_UNITS=Object.freeze([
 Object.freeze({id:'nemocoin',name:'NemoCoin',unit:'coins',implemented:true,ledger:'coin_rewards',balance:true,transferable:false,cash_value:false,convertible:false,description:'Internal contribution credits issued only by an independent human acceptance of eligible real work. No cash value, no transfer and no redemption.'}),
 Object.freeze({id:'compute_credit',name:'Compute credit',unit:'compute_credits',implemented:false,ledger:null,balance:false,transferable:false,cash_value:false,convertible:false,description:'Unimplemented concept. The world records model-run counters and budgets but holds no compute-credit balance and offers no purchase, donation, transfer or conversion path.'}),
 Object.freeze({id:'money',name:'Real money',unit:'currency',implemented:false,ledger:null,balance:false,transferable:false,cash_value:false,convertible:false,description:'Unimplemented concept. No payment, price, cash-out or token exists in this build; research cost scenarios in real currencies remain planning data only.'}),
 Object.freeze({id:'carbon_credit',name:'Verified carbon credit',unit:'carbon_credits',implemented:false,ledger:null,balance:false,transferable:false,cash_value:false,convertible:false,description:'Unimplemented concept. No carbon-credit balance, registry, transfer or conversion exists; a verified environmental outcome is not represented as a tradeable unit here.'}),
]);
export const UNIT_SEPARATION_POLICY=Object.freeze({version:1,units:Object.freeze(CREDIT_UNITS.map(unit=>unit.id)),conversion_paths:0,cash_out:false,token:false,description:'NemoCoins, compute credits, real money and verified carbon credits are four separate units: no conversion, no cash-out and no token between any two.'});
const hash=value=>createHash('sha256').update(value).digest('hex');
const receiptHash=row=>hash(JSON.stringify([row.id,row.agent_id,row.account_id,row.task_id,row.submission_id,row.review_id,row.fingerprint,row.amount,row.policy_version,row.award_day,row.created_at,row.previous_hash]));
export const COIN_SCHEMA=`
CREATE TABLE IF NOT EXISTS coin_rewards(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,agent_id TEXT NOT NULL REFERENCES agents(id),account_id TEXT NOT NULL REFERENCES accounts(id),task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id),review_id TEXT NOT NULL UNIQUE REFERENCES reviews(id),fingerprint TEXT NOT NULL UNIQUE,amount INTEGER NOT NULL CHECK(amount=10),policy_version INTEGER NOT NULL CHECK(policy_version=1),award_day TEXT NOT NULL,created_at TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS coins_operator_day ON coin_rewards(account_id,award_day);
CREATE TRIGGER IF NOT EXISTS coins_no_update BEFORE UPDATE ON coin_rewards BEGIN SELECT RAISE(ABORT,'Coin receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS coins_no_delete BEFORE DELETE ON coin_rewards BEGIN SELECT RAISE(ABORT,'Coin receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS coins_validate_insert BEFORE INSERT ON coin_rewards BEGIN
SELECT CASE WHEN NEW.previous_hash!=COALESCE((SELECT hash FROM coin_rewards ORDER BY seq DESC LIMIT 1),'') THEN RAISE(ABORT,'Coin chain mismatch') END;
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM submissions s JOIN claims c ON c.id=s.claim_id JOIN tasks t ON t.id=c.task_id JOIN missions m ON m.id=t.mission_id JOIN agents a ON a.id=c.agent_id JOIN accounts o ON o.id=c.account_id JOIN reviews r ON r.submission_id=s.id JOIN accounts reviewer ON reviewer.id=r.reviewer_id JOIN accounts owner ON owner.id=m.owner_id JOIN accounts assigned ON assigned.id=m.reviewer_id WHERE s.id=NEW.submission_id AND r.id=NEW.review_id AND s.status='accepted' AND r.decision='accepted' AND c.task_id=NEW.task_id AND c.agent_id=NEW.agent_id AND c.account_id=NEW.account_id AND a.operator_id=c.account_id AND a.kind='agent' AND a.status IN ('active','paused') AND o.status='active' AND owner.status='active' AND assigned.status='active' AND assigned.role IN ('admin','reviewer') AND assigned.id!=c.account_id AND reviewer.status='active' AND reviewer.role IN ('admin','reviewer') AND reviewer.id!=c.account_id AND (reviewer.id=m.reviewer_id OR reviewer.role='admin') AND m.demo=0 AND m.status IN ('open','closed') AND c.task_version=t.version) THEN RAISE(ABORT,'Ineligible coin receipt') END;
SELECT CASE WHEN COALESCE((SELECT SUM(amount) FROM coin_rewards WHERE account_id=NEW.account_id AND award_day=NEW.award_day),0)+NEW.amount>100 THEN RAISE(ABORT,'Operator daily coin limit') END;
END;`;
// A stored receipt must still name the evidence it was issued from: a review that belongs to that
// submission, on a claim whose task, resident agent and operator account all match the receipt.
// The hash chain proves a receipt row was not edited; this proves it was not fabricated to credit
// the wrong wallet, name a self-review or reference rows that no longer exist. Live eligibility
// (roles, quarantine, suspended identities, practice scope, task version) is deliberately not
// re-tested here: those legitimately change after issuance and hold availability instead.
const receiptIntegrity=db=>`SELECT receipt.id FROM coin_rewards receipt
 LEFT JOIN submissions s ON s.id=receipt.submission_id
 LEFT JOIN claims c ON c.id=s.claim_id
 LEFT JOIN reviews r ON r.id=receipt.review_id
 LEFT JOIN agents a ON a.id=receipt.agent_id
 LEFT JOIN tasks t ON t.id=receipt.task_id
 LEFT JOIN missions m ON m.id=t.mission_id
 WHERE s.id IS NULL OR c.id IS NULL OR r.id IS NULL OR a.id IS NULL OR t.id IS NULL OR m.id IS NULL
  OR r.submission_id!=receipt.submission_id OR r.decision!='accepted' OR r.reviewer_id=receipt.account_id
  OR c.task_id!=receipt.task_id OR c.agent_id!=receipt.agent_id OR c.account_id!=receipt.account_id
  ${db.prepare('PRAGMA table_info(agents)').all().some(column=>column.name==='kind')?"OR a.kind!='agent' ":''}OR a.operator_id!=receipt.account_id
  OR s.status NOT IN ('accepted','quarantined') LIMIT 1`;
export function verifyCoinLedger(db){let previous='';for(const row of db.prepare('SELECT * FROM coin_rewards ORDER BY seq').all()){if(row.previous_hash!==previous||row.hash!==receiptHash(row)||row.amount!==10||row.policy_version!==1||!/^\d{4}-\d{2}-\d{2}$/.test(row.award_day)||row.award_day!==row.created_at.slice(0,10))return false;previous=row.hash;}return !db.prepare(receiptIntegrity(db)).get();}
const eligible=`EXISTS(SELECT 1 FROM submissions s JOIN claims c ON c.id=s.claim_id JOIN tasks t ON t.id=c.task_id JOIN missions m ON m.id=t.mission_id JOIN agents a ON a.id=c.agent_id JOIN accounts o ON o.id=c.account_id JOIN reviews r ON r.id=receipt.review_id JOIN accounts reviewer ON reviewer.id=r.reviewer_id JOIN accounts owner ON owner.id=m.owner_id JOIN accounts assigned ON assigned.id=m.reviewer_id WHERE s.id=receipt.submission_id AND s.status='accepted' AND r.decision='accepted' AND r.submission_id=s.id AND c.agent_id=receipt.agent_id AND c.account_id=receipt.account_id AND a.operator_id=c.account_id AND a.kind='agent' AND a.status IN ('active','paused') AND o.status='active' AND owner.status='active' AND assigned.status='active' AND assigned.role IN ('admin','reviewer') AND assigned.id!=c.account_id AND reviewer.status='active' AND reviewer.role IN ('admin','reviewer') AND reviewer.id!=c.account_id AND (reviewer.id=m.reviewer_id OR reviewer.role='admin') AND m.demo=0 AND m.status IN ('open','closed') AND c.task_version=t.version AND s.version=(SELECT MAX(version) FROM submissions current WHERE current.claim_id=c.id) AND r.rowid=(SELECT latest.rowid FROM reviews latest WHERE latest.submission_id=s.id ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1) AND NOT EXISTS(SELECT 1 FROM submissions latest JOIN claims lc ON lc.id=latest.claim_id WHERE lc.task_id=t.id AND latest.status='quarantined'))`;
export const coinMethods={
 awardCoins(actor,submissionId,reviewId){
  if(actor?.kind!=='session'||!['admin','reviewer'].includes(actor.account.role))throw Object.assign(Error('Only independent human review can award coins.'),{status:403});
  if(!verifyCoinLedger(this.db))throw Object.assign(Error('Coin ledger integrity needs administrator inspection.'),{status:503});
  const record=this.get("SELECT s.*,c.agent_id,c.account_id,c.task_id,r.reviewer_id,m.demo,a.kind AS agent_kind FROM submissions s JOIN claims c ON c.id=s.claim_id JOIN reviews r ON r.submission_id=s.id JOIN tasks t ON t.id=c.task_id JOIN missions m ON m.id=t.mission_id LEFT JOIN agents a ON a.id=c.agent_id WHERE s.id=? AND r.id=? AND r.decision='accepted' AND s.status='accepted'",submissionId,reviewId);
  if(!record||record.reviewer_id!==actor.account.id||record.account_id===actor.account.id)throw Object.assign(Error('An independent acceptance receipt is required.'),{status:403});
  if(!record.agent_id||record.demo||record.agent_kind!=='agent')return {status:'not_eligible',reason:record.demo?'Practice tasks do not earn coins.':record.agent_kind==='human'?'Human avatars do not earn agent contribution coins.':'This contribution has no agent character.'};
  if(!this.get('SELECT '+eligible+' AS available FROM (SELECT ? AS submission_id,? AS review_id,? AS agent_id,? AS account_id) AS receipt',record.id,reviewId,record.agent_id,record.account_id).available)return {status:'not_eligible',reason:'This acceptance does not meet the independent reward policy.'};
  if(this.get('SELECT id FROM coin_rewards WHERE task_id=?',record.task_id))return {status:'already_rewarded',reason:'This task already has a reward receipt.'};
  const fingerprint=hash(record.artifact.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase());if(this.get('SELECT id FROM coin_rewards WHERE fingerprint=?',fingerprint))return {status:'duplicate_work',reason:'Identical normalized work already earned a reward.'};
  const created_at=new Date(this.clock()).toISOString(),award_day=created_at.slice(0,10),used=this.get('SELECT COALESCE(SUM(amount),0) AS amount FROM coin_rewards WHERE account_id=? AND award_day=?',record.account_id,award_day).amount;if(used+COIN_POLICY.award>COIN_POLICY.operator_daily_limit)return {status:'daily_limit',reason:'This operator reached the UTC daily reward limit.'};
  const row={id:randomUUID(),agent_id:record.agent_id,account_id:record.account_id,task_id:record.task_id,submission_id:record.id,review_id:reviewId,fingerprint,amount:COIN_POLICY.award,policy_version:COIN_POLICY.version,award_day,created_at,previous_hash:this.get('SELECT hash FROM coin_rewards ORDER BY seq DESC LIMIT 1')?.hash||''};row.hash=receiptHash(row);
  this.run('INSERT INTO coin_rewards(id,agent_id,account_id,task_id,submission_id,review_id,fingerprint,amount,policy_version,award_day,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',row.id,row.agent_id,row.account_id,row.task_id,row.submission_id,row.review_id,row.fingerprint,row.amount,row.policy_version,row.award_day,row.created_at,row.previous_hash,row.hash);this.audit(actor.account.id,'coins.awarded',row.id);return {status:'awarded',amount:row.amount,agent_id:row.agent_id,receipt_id:row.id};
 },
 coins(actor,input={}){
  const agent=this.ownedAgent(actor,input.agent_id||actor.agent?.id);if(!verifyCoinLedger(this.db))throw Object.assign(Error('Coin ledger integrity needs administrator inspection.'),{status:503});
  const receipts=this.all(`SELECT receipt.id,receipt.task_id,receipt.submission_id,receipt.review_id,receipt.amount,receipt.policy_version,receipt.created_at,receipt.hash,${eligible} AS available FROM coin_rewards receipt WHERE receipt.agent_id=? ORDER BY receipt.seq DESC`,agent.id).map(row=>({...row,state:row.available?'available':'held',available:Boolean(row.available)}));
  const issued=receipts.reduce((n,r)=>n+r.amount,0),balance=receipts.filter(r=>r.available).reduce((n,r)=>n+r.amount,0);if(!Number.isSafeInteger(issued)||!Number.isSafeInteger(balance))throw Object.assign(Error('Coin balance exceeds supported bounds.'),{status:503});
  return {agent_id:agent.id,policy:COIN_POLICY,balance,issued,held:issued-balance,receipt_count:receipts.length,receipts:receipts.slice(0,100),has_more:receipts.length>100,integrity_valid:true};
 },
 coinExport(actor){return this.all('SELECT id FROM agents WHERE operator_id=?',actor.account.id).map(a=>({...this.coins(actor,{agent_id:a.id}),receipts:this.all('SELECT id,task_id,submission_id,review_id,amount,policy_version,award_day,created_at,previous_hash,hash FROM coin_rewards WHERE agent_id=? ORDER BY seq',a.id)}));}
};

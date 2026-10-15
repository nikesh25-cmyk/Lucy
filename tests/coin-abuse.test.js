import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fixture, realMission, evidence} from './helpers.js';
import {Platform} from '../src/platform.js';
import {createApp} from '../server.js';
import {COIN_SCHEMA, verifyCoinLedger} from '../src/coins.js';
import {validateDatabase, backupDatabase} from '../src/recovery.js';
import {verifyCallingReceipts} from '../src/vocations.js';
import {verifyQuestReceipts} from '../src/quests.js';

// One saved source is credited once, so later awards of one operator move to the next UTC day.
// Submissions are backdated where a test needs many awards in one day, so the operator's ten-a-day
// submission rate limit never stands in for the reward control actually under test.
const historical=(f,submission)=>f.platform.run("UPDATE submissions SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?",submission.id);
const make=async t=>{const f=await fixture(t);return{...f,resident:f.agent('alice'),m:realMission(f)};};
const accept=(f,{task,agent,artifact='An independently reviewed fixture contribution.',backdate=false}={})=>{
  const targetTask=task||f.m.task,targetAgent=agent||f.resident;
  const claim=f.tx('claim',f.actor('alice'),{task_id:targetTask.id,agent_id:targetAgent.id},`abuse-claim-${targetTask.id}`);
  const submission=f.tx('submit',f.actor('alice'),evidence(claim,{artifact}),`abuse-submit-${targetTask.id}`);
  if(backdate)historical(f,submission);
  const review=f.tx('review',f.actor('reviewer'),{submission_id:submission.id,decision:'accepted',reason:'Independent fixture source review',reward_amount:999999});
  return {claim,submission,review};
};
const taskFor=(f,n)=>f.tx('createTask',f.actor('admin'),{mission_id:f.m.mission.id,title:`Distinct ${n}`,instructions:`Independent fixture work ${n}`,rights:'Fixture permission',allowed_domains:['example.org']});
const wallet=(f,agent,owner='alice')=>f.platform.coins(f.actor(owner),{agent_id:agent.id});
const sibling=f=>f.tx('createAgent',f.actor('alice'),{name:'Second wallet',capabilities:'Fixture',limitations:'Fixture',color:'#397f79',symbol:'✦'});
const openServer=async(t,f)=>{const app=createApp({platform:f.platform});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const close=async()=>{await app.stopWorkers();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});};t.after(close);return{app,base:`http://127.0.0.1:${app.server.address().port}`,close};};
const post=(base,token,route,payload,key)=>fetch(base+'/api/v1'+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Origin:base,...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(payload)});

test('a contributor, their sibling character and an administrator cannot accept their own contribution',async t=>{
  const f=await make(t),siblingAgent=f.agent('alice','Sibling');
  const claim=f.tx('claim',f.actor('alice'),{task_id:f.m.task.id,agent_id:f.resident.id},'self-claim');
  const submission=f.tx('submit',f.actor('alice'),evidence(claim,{artifact:'A contribution nobody may accept for itself'}),'self-submit');
  // The contributor's own operator session is refused.
  assert.throws(()=>f.tx('review',f.actor('alice'),{submission_id:submission.id,decision:'accepted',reason:'Self'}),{status:403});
  assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?',submission.id).status,'pending_review');
  // An independent reviewer accepts it and issues exactly one receipt.
  const review=f.tx('review',f.actor('reviewer'),{submission_id:submission.id,decision:'accepted',reason:'Independent'});
  assert.equal(review.coin_reward.amount,10);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
  // A second character of the same operator is still the same operator: its work is self-review too.
  const siblingClaim=f.tx('claim',f.actor('alice'),{task_id:realMission(f).task.id,agent_id:siblingAgent.id},'sibling-claim');
  const siblingSubmission=f.tx('submit',f.actor('alice'),evidence(siblingClaim,{artifact:'A sibling character’s contribution'}),'sibling-submit');
  assert.throws(()=>f.tx('review',f.actor('alice'),{submission_id:siblingSubmission.id,decision:'accepted',reason:'Sibling'}),{status:403});
  assert.equal(f.platform.get('SELECT operator_id FROM agents WHERE id=?',siblingAgent.id).operator_id,f.actor('alice').account.id);
  assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?',siblingSubmission.id).status,'pending_review');
  // An administrator may review any submission, but never one from their own account.
  const ownAgent=f.agent('admin','Administrator resident'),ownMission=realMission(f);
  const ownClaim=f.tx('claim',f.actor('admin'),{task_id:ownMission.task.id,agent_id:ownAgent.id},'admin-own-claim');
  const ownSubmission=f.tx('submit',f.actor('admin'),evidence(ownClaim),'admin-own-submit');
  assert.throws(()=>f.tx('review',f.actor('admin'),{submission_id:ownSubmission.id,decision:'accepted',reason:'Own work'}),{status:403});
  assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?',ownSubmission.id).status,'pending_review');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
});

test('several characters under one operator share one wallet cap and one duplicate-work rule',async t=>{
  const f=await make(t),second=sibling(f);
  const results=[];
  for(let n=1;n<=10;n++)results.push(accept(f,{task:taskFor(f,n),agent:n%2?second:f.resident,artifact:`Distinct operator fixture ${n}`,backdate:true}).review.coin_reward.status);
  assert.deepEqual(results,Array(10).fill('awarded'));
  // The cap is per operator: each character's wallet holds its own half, and the operator total is 100.
  assert.equal(wallet(f,second).issued,50);
  assert.equal(wallet(f,f.resident).issued,50);
  assert.equal(wallet(f,second).balance+wallet(f,f.resident).balance,100);
  assert.equal(f.platform.get('SELECT SUM(amount) AS n FROM coin_rewards').n,100);
  // The eleventh accepted contribution stays accepted but reaches the operator limit across avatars.
  const eleventh=accept(f,{task:taskFor(f,11),artifact:'Eleventh operator fixture',backdate:true});
  assert.equal(eleventh.review.coin_reward.status,'daily_limit');
  assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?',eleventh.submission.id).status,'accepted');
  // The same normalized work cannot be farmed across characters, tasks, case or whitespace.
  const duplicate=accept(f,{task:taskFor(f,12),agent:second,artifact:'  distinct   OPERATOR fixture 1  ',backdate:true});
  assert.equal(duplicate.review.coin_reward.status,'duplicate_work');
  assert.equal(f.platform.get('SELECT SUM(amount) AS n FROM coin_rewards').n,100);
  assert.equal(verifyCoinLedger(f.platform.db),true);
});

test('a replayed review, a replayed submission key and a key reused for other work cannot multiply receipts',async t=>{
  const f=await make(t);
  const claim=f.tx('claim',f.actor('alice'),{task_id:f.m.task.id,agent_id:f.resident.id},'replay-claim');
  const first=f.tx('submit',f.actor('alice'),evidence(claim,{artifact:'The one recorded artifact'}),'replay-submit');
  // The same key with different content is the same write, never a second version.
  const again=f.tx('submit',f.actor('alice'),evidence(claim,{artifact:'Different content under the same key'}),'replay-submit');
  assert.equal(again.id,first.id);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions WHERE claim_id=?',claim.id).n,1);
  const review=f.tx('review',f.actor('reviewer'),{submission_id:first.id,decision:'accepted',reason:'Independent'});
  assert.equal(review.coin_reward.amount,10);
  assert.throws(()=>f.tx('review',f.actor('reviewer'),{submission_id:first.id,decision:'accepted',reason:'Replay'}),{status:409});
  assert.equal(f.tx('awardCoins',f.actor('reviewer'),first.id,review.id).status,'already_rewarded');
  // A claim key belongs to one task, and a follow-up key to one fingerprint of work.
  assert.throws(()=>f.tx('claim',f.actor('alice'),{task_id:realMission(f).task.id,agent_id:f.resident.id},'replay-claim'),{status:409});
  f.tx('createFollowUp',f.actor('admin'),{submission_id:first.id,title:'Continue',instructions:'Follow the accepted source',rights:'Fixture permission',allowed_domains:['example.org']},'replay-followup');
  assert.throws(()=>f.tx('createFollowUp',f.actor('admin'),{submission_id:first.id,title:'Different',instructions:'Different work',rights:'Fixture permission',allowed_domains:['example.org']},'replay-followup'),{status:409});
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n,1);
});

test('a suspended or revoked identity earns nothing new and holds the receipts it already issued',async t=>{
  const f=await make(t),bobAccount=f.actor('bob').account.id;
  const {submission}=accept(f);
  assert.equal(wallet(f,f.resident).balance,10);
  const secondClaim=f.tx('claim',f.actor('alice'),{task_id:realMission(f).task.id,agent_id:f.resident.id},'held-claim');
  const secondSubmission=f.tx('submit',f.actor('alice'),evidence(secondClaim,{artifact:'A later contribution held by suspension'}),'held-submit');
  const report=f.tx('report',f.actor('bob'),{target_type:'agent',target_id:f.resident.id,reason:'Fictional suspension fixture'});
  f.tx('moderate',f.actor('moderator'),{report_id:report.id,action:'suspend',reason:'Hold this identity'});
  assert.equal(f.platform.get('SELECT status FROM agents WHERE id=?',f.resident.id).status,'suspended');
  // A suspended character cannot earn: acceptance records no receipt at all.
  const review=f.tx('review',f.actor('reviewer'),{submission_id:secondSubmission.id,decision:'accepted',reason:'Independent'});
  assert.equal(review.coin_reward.status,'not_eligible');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
  const held=wallet(f,f.resident);assert.equal(held.balance,0);assert.equal(held.held,10);assert.equal(held.issued,10);assert.equal(held.receipts[0].state,'held');
  // An independent appeal restores availability of the same receipt without issuing another.
  const appeal=f.tx('appeal',f.actor('alice'),{report_id:report.id,reason:'Independent reinspection'});
  f.tx('decideAppeal',f.actor('admin'),{appeal_id:appeal.id,decision:'overturned',reason:'Independent restoration'});
  const restored=wallet(f,f.resident);assert.equal(restored.balance,10);assert.equal(restored.issued,10);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
  // Revocation holds the same way.
  f.tx('agentControl',f.actor('alice'),f.resident.id,'revoked');
  const revoked=wallet(f,f.resident);assert.equal(revoked.balance,0);assert.equal(revoked.held,10);
  // A suspended operator cannot authenticate at all, so no wallet is reachable.
  f.tx('accountControl',f.actor('admin'),{account_id:bobAccount,status:'suspended'});
  assert.equal(f.platform.get('SELECT status FROM accounts WHERE id=?',bobAccount).status,'suspended');
  assert.throws(()=>f.platform.authenticate(f.credentials.bob.token),{status:401});
  assert.equal(f.platform.operations(f.actor('admin')).coin_ledger_valid,true);
  assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?',submission.id).status,'accepted');
});

test('quarantined evidence holds the receipt and the merit until an independent appeal restores it',async t=>{
  const f=await make(t);
  const {submission}=accept(f);
  const merit=()=>f.platform.journey(f.actor('alice'),{agent_id:f.resident.id}).merit;
  assert.deepEqual(merit(),{accepted:1,adopted:0,total:1});
  const report=f.tx('report',f.actor('bob'),{target_type:'submission',target_id:submission.id,reason:'Fictional evidence concern'});
  f.tx('moderate',f.actor('moderator'),{report_id:report.id,action:'quarantine',reason:'Hold for inspection'});
  const held=wallet(f,f.resident);assert.equal(held.balance,0);assert.equal(held.held,10);assert.equal(held.issued,10);
  assert.deepEqual(merit(),{accepted:0,adopted:0,total:0});
  // The deciding moderator cannot decide the appeal; a different uninvolved administrator must.
  const appeal=f.tx('appeal',f.actor('alice'),{report_id:report.id,reason:'Independent reinspection requested'});
  assert.throws(()=>f.tx('decideAppeal',f.actor('moderator'),{appeal_id:appeal.id,decision:'overturned',reason:'Involved'}),{status:403});
  f.tx('decideAppeal',f.actor('admin'),{appeal_id:appeal.id,decision:'overturned',reason:'Independent restoration'});
  assert.equal(wallet(f,f.resident).balance,10);
  assert.deepEqual(merit(),{accepted:1,adopted:0,total:1});
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
  assert.equal(verifyCoinLedger(f.platform.db),true);
});

test('a saved source is credited once, and calling objectives and quest steps share one ten-a-day limit',async t=>{
  const f=await make(t),visitor=f.agent('bob','Visitor');
  const chain=f.tx('questAuthor',f.actor('reviewer'),{slug:'source-reuse',title:'One visit at a time',route:'world_building',practice:true,beneficiary:'',summary:'Two discoveries that must not share one visit.',narrative:'A practice chain about never counting the same walk twice.',
    steps:[{slug:'first-walk',title:'Discover one place',instructions:'Walk into a shared place you have not visited.',output_name:'A recorded discovery',source_kind:'shared_visit',target:1},{slug:'second-walk',title:'Discover another place',instructions:'Walk into a second shared place.',output_name:'A second recorded discovery',source_kind:'shared_visit',target:1}]});
  f.tx('questManage',f.actor('reviewer'),{chain_id:chain.id,action:'publish'});
  f.tx('questJoin',f.actor('bob'),{agent_id:visitor.id,chain_id:chain.id},'reuse-join');
  const visit=world=>{f.platform.run('UPDATE agents SET world_id=? WHERE id=?',world,visitor.id);f.tx('recordVisit',f.actor('bob'),visitor.id,world);};
  // Reconciliation runs on the calling view, exactly as the interface asks for it.
  const view=()=>{const calling=f.platform.callings(f.actor('bob'),{agent_id:visitor.id});return{receipts:f.platform.all('SELECT objective_id,source_kind,source_id FROM calling_receipts WHERE agent_id=? ORDER BY created_at,rowid',visitor.id),experience:calling.experience};};
  visit('library');
  const one=view();assert.equal(one.receipts.length,1);assert.equal(one.receipts[0].objective_id,'explorer.shared_visit');
  visit('orchard');
  const two=view();assert.equal(two.receipts.length,2);
  assert.equal(two.receipts[1].objective_id,'quest:source-reuse.first-walk');
  // The quest step used the second, genuinely new discovery; it never re-credited the first.
  assert.notEqual(two.receipts[1].source_id,one.receipts[0].source_id);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM (SELECT source_kind,source_id FROM calling_receipts WHERE agent_id=? GROUP BY source_kind,source_id HAVING COUNT(*)>1)',visitor.id).n,0);
  visit('hall');
  assert.equal(view().receipts.length,2,'the shared ten-a-day limit stops the third step');
  assert.equal(view().experience.earned,10);assert.equal(view().experience.available,10);
  assert.equal(verifyCallingReceipts(f.platform.db),true);
  assert.equal(verifyQuestReceipts(f.platform.db),true);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0);
  // A duplicate source row is refused outright by the append-only receipt constraints.
  assert.throws(()=>f.platform.run("INSERT INTO calling_receipts(id,agent_id,account_id,calling_id,objective_id,source_kind,source_id,source_at,selected_at,earned_day,points,created_at,proof_hash) SELECT 'dup',agent_id,account_id,calling_id,'quest:source-reuse.second-walk',source_kind,source_id,source_at,selected_at,earned_day,points,created_at,proof_hash FROM calling_receipts WHERE agent_id=? LIMIT 1",visitor.id),/UNIQUE|Daily calling experience limit/);
});

test('the issued coin ledger and the cosmetic calling experience stay on separate paths',async t=>{
  const f=await make(t);
  // Choose the research calling first: only activity saved after selection can qualify.
  f.tx('callingSelect',f.actor('alice'),{agent_id:f.resident.id,calling_id:'researcher'});
  assert.equal(f.platform.callings(f.actor('alice'),{agent_id:f.resident.id}).experience.available,0);
  const {submission}=accept(f);
  assert.equal(wallet(f,f.resident).balance,10);
  // The cosmetic experience is derived from the same acceptance event by the calling receipt view,
  // which is a different path from the coin ledger: it mints no second receipt.
  const experience=f.platform.callings(f.actor('alice'),{agent_id:f.resident.id}).experience;
  // The researcher calling has two objectives: the scoped claim and the independent acceptance.
  assert.equal(experience.available,10);assert.equal(experience.cosmetic,true);assert.equal(experience.held,0);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
  assert.equal(wallet(f,f.resident).balance,10);
  assert.deepEqual(f.platform.all('SELECT objective_id FROM calling_receipts ORDER BY objective_id').map(row=>row.objective_id),['researcher.research_accepted','researcher.research_claim']);
  assert.equal(f.platform.coinExport(f.actor('alice'))[0].receipts[0].submission_id,submission.id);
  // A repeated reconciliation cannot credit the same acceptance again in either ledger.
  f.platform.callings(f.actor('alice'),{agent_id:f.resident.id});
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts').n,2);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
});

test('the UTC award day and the hundred-coin cap hold across a midnight boundary and equal timestamps',async t=>{
  const f=await make(t),second=sibling(f);
  const now=f.clock(),midnight=Math.ceil(now/86_400_000)*86_400_000;
  f.advance(Math.max(1,midnight-now-30_000));
  const awards=[];
  for(let n=1;n<=10;n++)awards.push(accept(f,{task:taskFor(f,n),agent:n%2?second:f.resident,artifact:`Night fixture ${n}`,backdate:true}).review.coin_reward.status);
  assert.deepEqual(awards,Array(10).fill('awarded'));
  assert.equal(accept(f,{task:taskFor(f,11),artifact:'Eleventh before midnight',backdate:true}).review.coin_reward.status,'daily_limit');
  const beforeDay=new Date(f.clock()).toISOString().slice(0,10);
  assert.equal(f.platform.get('SELECT SUM(amount) AS n FROM coin_rewards WHERE award_day=?',beforeDay).n,100);
  // Crossing the UTC boundary opens a fresh operator day and a fresh cap.
  f.advance(60_000);
  assert.equal(accept(f,{task:taskFor(f,12),artifact:'First after midnight',backdate:true}).review.coin_reward.status,'awarded');
  // Two awards at the exact same clock instant are two distinct receipts and still count once each.
  const sameOne=accept(f,{task:taskFor(f,13),agent:second,artifact:'Equal instant one',backdate:true});
  const sameTwo=accept(f,{task:taskFor(f,14),agent:second,artifact:'Equal instant two',backdate:true});
  assert.equal(sameOne.review.coin_reward.status,'awarded');
  assert.equal(sameTwo.review.coin_reward.status,'awarded');
  assert.notEqual(sameOne.review.coin_reward.receipt_id,sameTwo.review.coin_reward.receipt_id);
  assert.ok(f.platform.all('SELECT award_day,created_at FROM coin_rewards').every(row=>row.award_day===row.created_at.slice(0,10)));
  assert.equal(verifyCoinLedger(f.platform.db),true);
});

test('simultaneous requests cannot double-award, exceed the daily cap or create two claims',async t=>{
  const f=await make(t),{base}=await openServer(t,f);
  const claim=f.tx('claim',f.actor('alice'),{task_id:f.m.task.id,agent_id:f.resident.id},'race-claim');
  const submission=f.tx('submit',f.actor('alice'),evidence(claim,{artifact:'A single raced contribution'}),'race-submit');
  // Two independent reviewers race the same submission's uniqueness check.
  const [ra,rb]=await Promise.all([
    post(base,f.credentials.reviewer.token,'/reviews',{submission_id:submission.id,decision:'accepted',reason:'Concurrent acceptance A'}),
    post(base,f.credentials.admin.token,'/reviews',{submission_id:submission.id,decision:'accepted',reason:'Concurrent acceptance B'}),
  ]);
  assert.deepEqual([ra.status,rb.status].sort(),[201,409]);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM reviews WHERE submission_id=?',submission.id).n,1);
  // A key shared by two simultaneous claims creates exactly one claim.
  const raced=f.tx('createTask',f.actor('admin'),{mission_id:f.m.mission.id,title:'Raced task',instructions:'Fixture',rights:'Fixture permission',allowed_domains:['example.org']});
  const [ca,cb]=await Promise.all([
    post(base,f.credentials.alice.token,'/claims',{task_id:raced.id,agent_id:f.resident.id},'shared-claim-key'),
    post(base,f.credentials.alice.token,'/claims',{task_id:raced.id,agent_id:f.resident.id},'shared-claim-key'),
  ]);
  assert.deepEqual([ca.status,cb.status],[201,201]);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM claims WHERE idempotency_key=?','shared-claim-key').n,1);
  // With one operator one award short of the cap, two simultaneous acceptances cannot exceed it.
  const capped=await capRace(t);
  assert.deepEqual([...capped.statuses].sort(),['awarded','daily_limit']);
  assert.equal(capped.total,100);
});

// The runtime allows one active claim per operator, so two awardable submissions for one account
// cannot be created through the API. One claim is inserted directly to reach the state where two
// acceptances genuinely race the hundred-coin cap; the ledger must still hold.
async function capRace(t){
  const f=await fixture(t),agent=f.agent('alice'),m=realMission(f);
  const task=n=>f.tx('createTask',f.actor('admin'),{mission_id:m.mission.id,title:`Cap ${n}`,instructions:'Fixture',rights:'Fixture permission',allowed_domains:['example.org']});
  for(let n=1;n<=9;n++){const claim=f.tx('claim',f.actor('alice'),{task_id:task(n).id,agent_id:agent.id},`cap-claim-${n}`);const submission=f.tx('submit',f.actor('alice'),evidence(claim,{artifact:`Cap history ${n}`}),`cap-submit-${n}`);historical(f,submission);f.tx('review',f.actor('reviewer'),{submission_id:submission.id,decision:'accepted',reason:'Independent'});}
  const firstTask=task(10),firstClaim=f.tx('claim',f.actor('alice'),{task_id:firstTask.id,agent_id:agent.id},'cap-race-a');
  const firstSubmission=f.tx('submit',f.actor('alice'),evidence(firstClaim,{artifact:'Cap race A'}),'cap-race-a-submit');
  const secondTask=task(11),secondClaim='cap-race-b-claim',version=f.platform.get('SELECT version FROM tasks WHERE id=?',secondTask.id).version;
  f.platform.run('INSERT INTO claims VALUES(?,?,?,?,?,?,?,?,?)',secondClaim,secondTask.id,version,f.actor('alice').account.id,agent.id,'leased',f.clock()+1200000,'cap-race-b',new Date(f.clock()).toISOString());
  const secondSubmission=f.tx('submit',f.actor('alice'),evidence({id:secondClaim},{artifact:'Cap race B'}),'cap-race-b-submit');
  const {base}=await openServer(t,f);
  const [ra,rb]=await Promise.all([
    post(base,f.credentials.reviewer.token,'/reviews',{submission_id:firstSubmission.id,decision:'accepted',reason:'Concurrent acceptance at the cap'}),
    post(base,f.credentials.reviewer.token,'/reviews',{submission_id:secondSubmission.id,decision:'accepted',reason:'Concurrent acceptance at the cap'}),
  ]);
  const bodies=[(await ra.json()).coin_reward,(await rb.json()).coin_reward];
  return{statuses:bodies.map(body=>body.status),total:f.platform.get('SELECT SUM(amount) AS n FROM coin_rewards').n};
}

test('a modified receipt and a forged receipt crediting the wrong wallet fail wallet, issuance and backup gates',async t=>{
  const f=await make(t);
  const {submission,review}=accept(f);
  // 1. An edited receipt breaks the hash chain, so the backup gate and the wallet gate both fail.
  const tampered=join(f.directory,'tampered.sqlite');
  backupDatabase(f.platform.db,tampered);
  const edited=new DatabaseSync(tampered);edited.exec("DROP TRIGGER coins_no_update;UPDATE coin_rewards SET hash='tampered'");edited.exec(COIN_SCHEMA);edited.close();
  assert.throws(()=>validateDatabase(tampered),/coin ledger validation/);
  const editedDb=new DatabaseSync(tampered,{readOnly:true});assert.equal(verifyCoinLedger(editedDb),false);editedDb.close();
  // 2. A whole forged receipt with a recomputed chain, crediting alice's wallet for bob's accepted,
  //    independently reviewed practice submission, passes the old hash-only check but not this one.
  const forged=await forgedReceipt(f);
  assert.equal(verifyCoinLedger(new DatabaseSync(forged,{readOnly:true})),false);
  assert.throws(()=>validateDatabase(forged),/coin ledger validation/);
  const opened=new Platform(forged);t.after(()=>opened.close());
  assert.throws(()=>opened.coins(opened.authenticate(f.credentials.alice.token),{agent_id:f.resident.id}),{status:503});
  assert.throws(()=>opened.transaction(()=>opened.awardCoins(opened.authenticate(f.credentials.reviewer.token),submission.id,review.id)),{status:503});
  assert.equal(opened.operations(opened.authenticate(f.credentials.admin.token)).coin_ledger_valid,false);
  // 3. The original installation and its one honest receipt are untouched by all of the above.
  assert.equal(wallet(f,f.resident).balance,10);
  assert.equal(verifyCoinLedger(f.platform.db),true);
  assert.equal(validateDatabase(f.database).schema_version,26);
  assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?',submission.id).status,'accepted');
  assert.equal(f.platform.get('SELECT decision FROM reviews WHERE id=?',review.id).decision,'accepted');
});

// A copy of the database whose key trigger is stubbed and a hash-consistent receipt is added that
// credits alice's wallet for bob's accepted practice submission, which never earned a reward.
async function forgedReceipt(f){
  const bobAgent=f.tx('createAgent',f.actor('bob'),{name:'Bob resident',capabilities:'Fixture',limitations:'Fixture',color:'#397f79',symbol:'✦'});
  const claim=f.tx('claim',f.actor('bob'),{task_id:'climate-practice',agent_id:bobAgent.id},'forged-source-claim');
  const submission=f.tx('submit',f.actor('bob'),evidence(claim,{artifact:'Bob’s independently reviewed practice register'}),'forged-source-submit');
  const review=f.tx('review',f.actor('reviewer'),{submission_id:submission.id,decision:'accepted',reason:'Independent'});
  assert.equal(review.coin_reward.status,'not_eligible','practice evidence holds no reward to copy');
  const path=join(f.directory,'forged.sqlite');
  backupDatabase(f.platform.db,path);
  const destination=new DatabaseSync(path);
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const receiptHash=row=>hash(JSON.stringify([row.id,row.agent_id,row.account_id,row.task_id,row.submission_id,row.review_id,row.fingerprint,row.amount,row.policy_version,row.award_day,row.created_at,row.previous_hash]));
  destination.exec('DROP TRIGGER coins_validate_insert');
  const created=new Date(f.clock()).toISOString();
  const row={id:'forged-receipt',agent_id:f.resident.id,account_id:f.actor('alice').account.id,task_id:'climate-practice',submission_id:submission.id,review_id:review.id,fingerprint:hash('forged work'),amount:10,policy_version:1,award_day:created.slice(0,10),created_at:created,previous_hash:destination.prepare('SELECT hash FROM coin_rewards ORDER BY seq DESC LIMIT 1').get()?.hash||''};
  row.hash=receiptHash(row);
  destination.prepare('INSERT INTO coin_rewards(id,agent_id,account_id,task_id,submission_id,review_id,fingerprint,amount,policy_version,award_day,created_at,previous_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.agent_id,row.account_id,row.task_id,row.submission_id,row.review_id,row.fingerprint,row.amount,row.policy_version,row.award_day,row.created_at,row.previous_hash,row.hash);
  destination.exec('CREATE TRIGGER coins_validate_insert BEFORE INSERT ON coin_rewards BEGIN SELECT 1; END');
  destination.close();
  return path;
}

// ---------------------------------------------------------------------------
// Task 06 — Security tests: impersonation, unauthorized actions and self-approval.
// Each test below is load-bearing: disabling the named control in
// src/platform.js makes the test fail (recorded in the handoff).
// ---------------------------------------------------------------------------

test('a human avatar cannot receive a runtime credential', async t => {
  const f = await make(t);
  const human = f.tx('createAgent', f.actor('alice'), { name: 'Human avatar', capabilities: '', limitations: '', kind: 'human', color: '#397f79', symbol: '✦' });
  assert.equal(human.kind, 'human');
  assert.throws(() => f.platform.runtime(f.actor('alice'), human.id, { minutes: 10, max_calls: 10, scopes: ['read'] }), { status: 403 });
  assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM tokens WHERE agent_id=? AND kind='runtime'", human.id).n, 0);
});

test('a paused or revoked agent credential is refused before any handler', async t => {
  const f = await make(t);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const runtimeResponse = f.platform.runtime(f.actor('alice'), f.resident.id, { minutes: 10, max_calls: 10, scopes: ['read', 'contribute'] });
  const token = runtimeResponse.token;
  const tokenHash = hash(token);
  const runtime = f.platform.authenticate(token);
  assert.equal(runtime.kind, 'runtime');
  assert.equal(runtime.agent.id, f.resident.id);

  // Pausing revokes the runtime token, so authentication fails before any handler runs.
  f.tx('agentControl', f.actor('alice'), f.resident.id, 'paused');
  assert.throws(() => f.platform.authenticate(token), { status: 401 });
  assert.equal(f.platform.get('SELECT revoked FROM tokens WHERE hash=?', tokenHash).revoked, 1);

  // If a stale token row were somehow unrevoked, the agent status check still refuses.
  f.platform.run('UPDATE tokens SET revoked=0 WHERE hash=?', tokenHash);
  assert.throws(() => f.platform.authenticate(token), { status: 403 });

  // Revoking the agent also revokes its tokens; unrevoking again still fails the status check.
  f.tx('agentControl', f.actor('alice'), f.resident.id, 'revoked');
  assert.throws(() => f.platform.authenticate(token), { status: 401 });
  f.platform.run('UPDATE tokens SET revoked=0 WHERE hash=?', tokenHash);
  assert.throws(() => f.platform.authenticate(token), { status: 403 });
});

test('a runtime credential cannot review or adopt a submission', async t => {
  const f = await make(t);
  const runtime = f.platform.runtime(f.actor('alice'), f.resident.id, { minutes: 10, max_calls: 10, scopes: ['read', 'contribute'] });
  const runtimeActor = f.platform.authenticate(runtime.token);

  const claim = f.tx('claim', f.actor('alice'), { task_id: f.m.task.id, agent_id: f.resident.id }, 'runtime-review-claim');
  const submission = f.tx('submit', f.actor('alice'), evidence(claim), 'runtime-review-submit');

  assert.throws(() => f.platform.review(runtimeActor, { submission_id: submission.id, decision: 'accepted', reason: 'Self-approval' }), { status: 403 });
  assert.throws(() => f.platform.adoption(runtimeActor, { submission_id: submission.id, note: 'Self-adoption' }), { status: 403 });
  assert.equal(f.platform.get('SELECT status FROM submissions WHERE id=?', submission.id).status, 'pending_review');
});

test('adoption requires a different person from the contributor and from the reviewer', async t => {
  const f = await make(t);
  // Bob owns the mission, admin is the assigned reviewer, alice contributes through her agent.
  const mission = f.tx('createMission', f.actor('admin'), {
    title: 'Adoption boundary mission', area: 'Climate', summary: 'Test adoption independence.', beneficiary: 'Test community',
    owner_id: f.actor('bob').account.id, reviewer_id: f.actor('admin').account.id,
    rubric: 'Check exact original sources, rights, uncertainty, and attribution.',
  });
  const task = f.tx('createTask', f.actor('admin'), { mission_id: mission.id, title: 'Adoption boundary task', instructions: 'Record one source.', rights: 'Explicit permission required.', allowed_domains: ['example.org'] });
  f.tx('missionStatus', f.actor('admin'), mission.id, 'open');
  const claim = f.tx('claim', f.actor('alice'), { task_id: task.id, agent_id: f.resident.id }, 'adoption-claim');
  const submission = f.tx('submit', f.actor('alice'), evidence(claim), 'adoption-submit');
  f.tx('review', f.actor('admin'), { submission_id: submission.id, decision: 'accepted', reason: 'Independent review' });

  // The contributor cannot adopt their own work.
  assert.throws(() => f.platform.adoption(f.actor('alice'), { submission_id: submission.id, note: 'I adopt my own work' }), { status: 403 });
  // The reviewer who accepted it cannot adopt it.
  assert.throws(() => f.platform.adoption(f.actor('admin'), { submission_id: submission.id, note: 'I adopt what I reviewed' }), { status: 403 });
  // A different, uninvolved mission owner can adopt it.
  const adoption = f.tx('adoption', f.actor('bob'), { submission_id: submission.id, note: 'Independent adoption by the mission owner' });
  assert.equal(adoption.submission_id, submission.id);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM adoptions WHERE submission_id=?', submission.id).n, 1);
});

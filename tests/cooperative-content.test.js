import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fixture, realMission, evidence} from './helpers.js';
import {Platform} from '../src/platform.js';
import {SEED_QUESTS, receiptProof, verifyQuestReceipts, verifyQuestStructure} from '../src/quests.js';
import {SAMPLE_GUILD_PLANS, GUILD_PROJECT_POLICY, verifyGuildRecords} from '../src/guilds.js';
import {backupDatabase, validateDatabase} from '../src/recovery.js';
import {getWorldDefinition, walkable, frontierGates} from '../world.js';

const error=status=>caught=>caught.status===status;
const questReceipts=f=>f.platform.get("SELECT COUNT(*) AS n FROM calling_receipts WHERE objective_id LIKE 'quest:%'").n;
const chainBySlug=(f,agent,slug)=>f.platform.quests(f.actor('alice'),{agent_id:agent.id}).chains.find(item=>item.slug===slug);
const stepsBySlug=(f,agent,slug)=>chainBySlug(f,agent,slug).steps;

// Frontier helpers adapted from tests/frontier.test.js.
const currentWorld=(f,agent)=>f.platform.get('SELECT world_id FROM agents WHERE id=?',agent.id).world_id;
const position=(f,agent,world,x=6,y=6)=>f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?',world,x,y,agent.id);
const steward=(f,owner='alice',world='frontier:0:0')=>f.tx('landAssign',f.actor(owner),{plot_id:world.replace('frontier:','plot:')+':5:5',purpose:'A shared learning garden'});
const frontierBuild=(f,owner,agent,tile,changes={})=>f.tx('frontierBuild',f.actor(owner),agent.id,{world_id:currentWorld(f,agent),...tile,z:0,type:'stone',...changes});
const frontierExpand=(f,owner,agent,input)=>f.tx('frontierExpand',f.actor(owner),agent.id,{world_id:currentWorld(f,agent),...input});
const homeBuild=(f,owner,agent,tile,type)=>f.tx('build',f.actor(owner),agent.id,{...tile,type});
const findOpenTile=(world='frontier:0:0')=>{
 const definition=getWorldDefinition(world);
 for(let y=31;y<=34;y++)for(let x=31;x<=34;x++){
  if([[0,0],[1,0],[-1,0],[0,1],[0,-1]].every(([dx,dy])=>walkable({x:x+dx,y:y+dy},definition)))return{x,y};
 }
 throw new Error('Expected an open test patch.');
};
const findHomeTile=(agent)=>{
 const world=`home:${agent.id}`,definition=getWorldDefinition(world);
 for(let y=2;y<definition.rows-2;y++)for(let x=2;x<definition.columns-2;x++){
  if(!walkable({x,y},definition))continue;
  if(Math.abs(x-definition.start.x)+Math.abs(y-definition.start.y)<=1)continue;
  if((definition.portals||[]).some(p=>Math.abs(x-p.x)+Math.abs(y-p.y)<=1))continue;
  return{x,y};
 }
 throw new Error('Expected a buildable home tile.');
};

// Open a genuinely unopened neighbour from the starter ring (the nine starter sectors are seeded, so
// a gate from the seed sector is a no-op). Walk to the matching passage and expand outward.
const openFrontier=(f,owner,agent,sector='frontier:0:-1')=>{
 const gate=frontierGates(sector).find(g=>!f.platform.get('SELECT world_id FROM frontier_sectors WHERE world_id=?',g.targetWorldId));
 position(f,agent,sector,gate.x,gate.y);
 return frontierExpand(f,owner,agent,{direction:gate.direction});
};

// Stand on a clear neighbour and place one light in the resident's own garden: a valid home tile that
// keeps the arrival and the cottage exit clear, so the build is a real saved object.
const buildHomeLight=(f,owner,agent)=>{
 const world=`home:${agent.id}`,definition=getWorldDefinition(world),tile=findHomeTile(agent);
 const stand=[[0,1],[1,0],[0,-1],[-1,0]].map(([dx,dy])=>({x:tile.x+dx,y:tile.y+dy}))
   .find(p=>walkable(p,definition)&&!(definition.portals||[]).some(port=>port.x===p.x&&port.y===p.y))||{x:tile.x,y:tile.y};
 position(f,agent,world,stand.x,stand.y);
 homeBuild(f,owner,agent,{x:tile.x,y:tile.y},'lantern');
};

// One complete, saved frontier marker + path + expansion + home light for the shared-frontier-path chain.
function buildFrontierPath(f,agent){
 const seed='frontier:0:0',tile=findOpenTile(seed);
 steward(f,'alice',seed);
 // Step 1: a saved frontier block (marker).
 position(f,agent,seed,tile.x-1,tile.y);
 frontierBuild(f,'alice',agent,{x:tile.x,y:tile.y},{type:'wood'});
 f.advance(400);
 // Step 2: a saved path block inside the stewarded plot.
 frontierBuild(f,'alice',agent,{x:tile.x+1,y:tile.y},{type:'path'});
 f.advance(400);
 // Reconcile on the same UTC day the first two facts were saved: a receipt must be written on its
 // own event's day, and the ten-a-day cosmetic limit means the rest of the path waits for tomorrow.
 f.platform.quests(f.actor('alice'),{agent_id:agent.id});
 // Step 3: open an adjacent frontier area that is genuinely unopened.
 f.advance(86400000);
 openFrontier(f,'alice',agent);
 // Step 4: place a light object in the resident's own garden.
 buildHomeLight(f,'alice',agent);
}

// Guild helpers.
const samplePlan=()=>{
 const plan=SAMPLE_GUILD_PLANS.find(p=>p.slug==='commons-cartography');
 return {guild_id:plan.guild_id,title:plan.title,summary:plan.summary,visibility:'public',plan:plan.plan.map(w=>({id:w.id,title:w.title,output_name:w.output_name,scope:w.scope}))};
};
const createProject=(f,owner,agent,changes={})=>f.tx('guildProjectCreate',f.actor(owner),{agent_id:agent.id,...samplePlan(),...changes});
const participate=(f,owner,agent,project,action)=>f.tx('guildParticipation',f.actor(owner),{agent_id:agent.id,project_id:project.id,action});
const pledge=(f,owner,agent,project,id,commitment='I will do this one bounded thing.')=>f.tx('guildContribution',f.actor(owner),{agent_id:agent.id,project_id:project.id,workstream_id:id,action:'pledge',commitment});
const submit=(f,owner,agent,project,id,evidenceText='A recorded result on the server, with its limits.')=>f.tx('guildContribution',f.actor(owner),{agent_id:agent.id,project_id:project.id,workstream_id:id,action:'submit',evidence:evidenceText,sources:[{url:'https://example.org/route',location:'Section 1'}]});
const verify=(f,owner,agent,project,contribution)=>f.tx('guildVerify',f.actor(owner),{agent_id:agent.id,project_id:project.id,contribution_id:contribution.id,action:'approve',reason:'Checked the recorded result independently.'});

test('the shared-frontier-path chain is seeded once and advances only from saved frontier facts, spanning more than one day',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 const catalog=f.platform.questCatalog();
 assert.ok(catalog.chains.some(c=>c.slug==='shared-frontier-path'),'the new built-in chain appears in the public catalog');
 assert.equal(catalog.chains.find(c=>c.slug==='shared-frontier-path').practice,true);
 assert.equal(catalog.chains.find(c=>c.slug==='shared-frontier-path').route,'world_building');
 assert.equal(catalog.chains.find(c=>c.slug==='shared-frontier-path').beneficiary,'');
 // Join before doing any work; enrolment is the lower bound for what may count.
 f.tx('questJoin',f.actor('alice'),{agent_id:agent.id,chain_id:'shared-frontier-path'},'join-frontier');
 assert.equal(chainBySlug(f,agent,'shared-frontier-path').enrolled,true);
 assert.deepEqual(stepsBySlug(f,agent,'shared-frontier-path').map(s=>s.state),['available','locked','locked','locked']);
 const seed='frontier:0:0',tile=findOpenTile(seed);
 steward(f,'alice',seed);
 // Step 1: a saved frontier block.
 position(f,agent,seed,tile.x-1,tile.y);
 frontierBuild(f,'alice',agent,{x:tile.x,y:tile.y},{type:'wood'});
 f.advance(400);
 f.platform.quests(f.actor('alice'),{agent_id:agent.id});
 assert.equal(stepsBySlug(f,agent,'shared-frontier-path')[0].state,'complete');
 assert.equal(stepsBySlug(f,agent,'shared-frontier-path')[1].state,'available');
 assert.equal(questReceipts(f),1);
 // Step 2: a saved path block inside the stewarded plot.
 frontierBuild(f,'alice',agent,{x:tile.x+1,y:tile.y},{type:'path'});
 f.advance(400);
 f.platform.quests(f.actor('alice'),{agent_id:agent.id});
 assert.equal(stepsBySlug(f,agent,'shared-frontier-path')[1].state,'complete');
 assert.equal(stepsBySlug(f,agent,'shared-frontier-path')[2].state,'available');
 assert.equal(questReceipts(f),2);
 // The daily cosmetic limit is ten; four steps would need twenty, so the rest waits for a new UTC day.
 assert.equal(f.platform.get('SELECT COALESCE(SUM(points),0) AS n FROM calling_receipts WHERE agent_id=?',agent.id).n,10);
 f.advance(86400000);
 // Step 3: open an adjacent frontier area that is genuinely unopened.
 openFrontier(f,'alice',agent);
 f.platform.quests(f.actor('alice'),{agent_id:agent.id});
 assert.equal(stepsBySlug(f,agent,'shared-frontier-path')[2].state,'complete');
 assert.equal(stepsBySlug(f,agent,'shared-frontier-path')[3].state,'available');
 // Step 4: place a light object in the resident's own garden.
 buildHomeLight(f,'alice',agent);
 const finished=f.platform.quests(f.actor('alice'),{agent_id:agent.id});
 const progress=finished.progress.find(p=>p.chain_slug==='shared-frontier-path');
 assert.equal(progress.complete,true);
 assert.equal(progress.steps.every(s=>s.state==='complete'),true);
 assert.equal(questReceipts(f),4);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0,'a practice chain must never mint a coin');
 assert.equal(verifyQuestReceipts(f.platform.db),true);
 assert.equal(verifyQuestStructure(f.platform.db),true);
});

test('the shared-frontier-path chain does not double-advance on replay, restart, or repeated join',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 f.tx('questJoin',f.actor('alice'),{agent_id:agent.id,chain_id:'shared-frontier-path'},'join-frontier');
 buildFrontierPath(f,agent);
 f.platform.quests(f.actor('alice'),{agent_id:agent.id});
 assert.equal(questReceipts(f),4);
 // Repeated reads and the idempotent join must write no new receipts.
 for(let i=0;i<3;i++)f.platform.quests(f.actor('alice'),{agent_id:agent.id});
 const repeated=f.platform.transaction(()=>f.platform.questJoin(f.actor('alice'),{agent_id:agent.id,chain_id:'shared-frontier-path'},'join-frontier'));
 assert.equal(repeated.repeated,true);
 assert.equal(questReceipts(f),4);
 // A restart on the same database still shows four receipts and complete progress.
 f.platform.close();
 const reopened=new Platform(f.database,f.clock);t.after(()=>reopened.close());
 const actor=reopened.authenticate(f.credentials.alice.token);
 assert.equal(reopened.quests(actor,{agent_id:agent.id}).progress.find(p=>p.chain_slug==='shared-frontier-path').complete,true);
 assert.equal(reopened.get('SELECT COUNT(*) AS n FROM calling_receipts').n,4);
 assert.equal(verifyQuestReceipts(reopened.db),true);
});

test('a database that already has the shipped quiet-harvest chain receives shared-frontier-path and commons-trail exactly once',async t=>{
 const f=await fixture(t);
 // Simulate an older database: remove the new chains and leave the original built-in chain. Steps go
 // first because the guard refuses deleting a chain that still has steps.
 f.platform.run("DELETE FROM quest_steps WHERE chain_id IN (SELECT id FROM quest_chains WHERE slug IN ('shared-frontier-path','commons-trail'))");
 f.platform.run("DELETE FROM quest_chains WHERE slug IN ('shared-frontier-path','commons-trail')");
 const before=f.platform.all("SELECT slug FROM quest_chains WHERE origin='built_in' ORDER BY slug").map(r=>r.slug);
 assert.deepEqual(before,['quiet-harvest']);
 // Re-initialising quests must add the new chains and leave enrolments/receipts untouched.
 const enrolmentsBefore=f.platform.get('SELECT COUNT(*) AS n FROM quest_enrollments').n;
 const receiptsBefore=f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts').n;
 f.platform.initQuests();
 const after=f.platform.all("SELECT slug FROM quest_chains WHERE origin='built_in' ORDER BY slug").map(r=>r.slug);
 assert.deepEqual(after,['commons-trail','quiet-harvest','shared-frontier-path']);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM quest_enrollments').n,enrolmentsBefore);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts').n,receiptsBefore);
 // Running init again is a no-op.
 f.platform.initQuests();
 assert.deepEqual(f.platform.all("SELECT slug FROM quest_chains WHERE origin='built_in' ORDER BY slug").map(r=>r.slug),['commons-trail','quiet-harvest','shared-frontier-path']);
});

test('the commons-trail evidence chain ends only in an independent human acceptance and mints no quest coin',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 f.tx('questJoin',f.actor('alice'),{agent_id:agent.id,chain_id:'commons-trail'},'join-trail');
 const board=()=>chainBySlug(f,agent,'commons-trail');
 assert.equal(board().next_action.step_slug,'claim-a-task');
 assert.equal(board().next_action.requires_human_review,false);
 const {task}=realMission(f);
 const claim=f.tx('claim',f.actor('alice'),{task_id:task.id,agent_id:agent.id},'trail-claim');
 f.platform.quests(f.actor('alice'),{agent_id:agent.id});
 assert.equal(stepsBySlug(f,agent,'commons-trail')[0].state,'complete','a leased claim is a saved fact');
 assert.equal(stepsBySlug(f,agent,'commons-trail')[1].state,'available');
 assert.equal(board().next_action.requires_human_review,true);
 const submission=f.tx('submit',f.actor('alice'),evidence(claim),'trail-submit');
 // Self-approval is refused and the step does not move.
 assert.throws(()=>f.tx('review',f.actor('alice'),{submission_id:submission.id,decision:'accepted',reason:'Self approval attempt.'}),error(403));
 assert.equal(stepsBySlug(f,agent,'commons-trail')[1].state,'available');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0);
 const review=f.tx('review',f.actor('reviewer'),{submission_id:submission.id,decision:'accepted',reason:'Independent acceptance against the registered rubric.'});
 assert.equal(review.coin_reward.status,'awarded');
 assert.equal(stepsBySlug(f,agent,'commons-trail')[1].state,'complete');
 assert.equal(board().steps.find(s=>s.slug==='submit-and-accept').state,'complete');
 assert.equal(questReceipts(f),2);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
 assert.equal(f.platform.coins(f.actor('alice'),{agent_id:agent.id}).balance,10);
});

test('commons-trail accepts only a review of the claim credited by its first step',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 f.tx('questJoin',f.actor('alice'),{agent_id:agent.id,chain_id:'commons-trail'},'join-bound-trail');
 const first=realMission(f),claimA=f.tx('claim',f.actor('alice'),{task_id:first.task.id,agent_id:agent.id},'claim-question-a');
 f.platform.quests(f.actor('alice'),{agent_id:agent.id});
 const credited=f.platform.get("SELECT * FROM calling_receipts WHERE agent_id=? AND objective_id='quest:commons-trail.claim-a-task'",agent.id);
 assert.equal(credited.source_id,claimA.id);
 assert.equal(f.platform.get('SELECT task_version FROM claims WHERE id=?',claimA.id).task_version,
  f.platform.get('SELECT version FROM tasks WHERE id=?',first.task.id).version);

 // The first answer is rejected by an independent reviewer, freeing the one active-claim slot.
 // The stored quest receipt still names that first claim and its specific task version.
 const submittedA=f.tx('submit',f.actor('alice'),evidence(claimA),'submit-question-a');
 f.tx('review',f.actor('reviewer'),{submission_id:submittedA.id,decision:'rejected',reason:'This answer does not meet the task rubric.'});
 // A different task receives a valid independent review. It is real work, but it is not the
 // scoped question this chain recorded in its first step.
 const second=realMission(f),claimB=f.tx('claim',f.actor('alice'),{task_id:second.task.id,agent_id:agent.id},'claim-question-b');
 const submittedB=f.tx('submit',f.actor('alice'),evidence(claimB),'submit-question-b');
 const reviewB=f.tx('review',f.actor('reviewer'),{submission_id:submittedB.id,decision:'accepted',reason:'Valid independent review for the other question.'});
 assert.equal(stepsBySlug(f,agent,'commons-trail')[1].state,'available');
 assert.equal(questReceipts(f),1,'the other question cannot write the chain acceptance receipt');
 assert.equal(verifyQuestReceipts(f.platform.db),true);
 assert.equal(verifyQuestStructure(f.platform.db),true);

 // The older receipt trigger validates the accepted review as a real source but has no chain
 // relationship column. The structural audit must detect a recomputed, otherwise valid receipt
 // that tries to bind that unrelated review to this chain.
 const event=f.platform.get("SELECT * FROM calling_source_events WHERE agent_id=? AND source_kind='research_accepted' AND source_id=?",agent.id,reviewB.id);
 assert.ok(event);
 const forged={id:randomUUID(),agent_id:agent.id,account_id:credited.account_id,calling_id:credited.calling_id,
  objective_id:'quest:commons-trail.submit-and-accept',source_kind:'research_accepted',source_id:reviewB.id,
  source_at:event.occurred_at,selected_at:credited.selected_at,earned_day:event.occurred_at.slice(0,10),
  points:5,created_at:new Date(f.clock()).toISOString()};
 forged.proof_hash=receiptProof(forged);
 f.platform.run('INSERT INTO calling_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',...Object.values(forged));
 assert.equal(verifyQuestReceipts(f.platform.db),false,'integrity audit rejects the unrelated claim even with a recomputed receipt hash');
});

test('the commons-cartography guild plan keeps verification independent, pledges uncounted, and coins out of the guild flow',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),bob=f.agent('bob'),reviewer=f.agent('reviewer');
 const plan=samplePlan();
 assert.equal(plan.guild_id,'explorer');
 assert.equal(plan.plan.length,3);
 assert.ok(SAMPLE_GUILD_PLANS.some(p=>p.slug==='commons-cartography'));
 const project=createProject(f,'alice',alice);
 assert.equal(project.title,'The Commons Cartography');
 assert.equal(project.guild_id,'explorer');
 assert.equal(project.shared_status.totals.planned_workstreams,3);
 // Bob and the reviewer (two different operators) join.
 participate(f,'bob',bob,project,'join');
 participate(f,'reviewer',reviewer,project,'join');
 // Several pledges: every contribution is still an intention, not completed work.
 pledge(f,'bob',bob,project,'trace-route','I will trace the east path.');
 pledge(f,'reviewer',reviewer,project,'note-obstacle','I will note the steps by the library.');
 pledge(f,'bob',bob,project,'confirm-waypoint','I will confirm the crossroads.');
 const pledged=f.platform.guildProject(f.actor('alice'),{id:project.id});
 assert.equal(pledged.shared_status.totals.commitments,3);
 assert.equal(pledged.shared_status.totals.verified_contributions,0);
 assert.equal(pledged.shared_status.all_workstreams_verified,false);
 assert.ok(pledged.contributions.every(c=>c.outcome.completed===false),'a pledge is never a completed outcome');
 // Bob submits one workstream; it is still unverified.
 const submitted=submit(f,'bob',bob,project,'trace-route');
 assert.equal(submitted.contributions.find(c=>c.workstream_id==='trace-route').status,'submitted');
 assert.equal(submitted.shared_status.totals.verified_contributions,0);
 // Distinct-operator verification: the contributor's operator, a sibling character, and the project
 // creator's operator are all refused; an unrelated operator verifies.
 const contribution=submitted.contributions.find(c=>c.workstream_id==='trace-route');
 const bobSecond=f.tx('createAgent',f.actor('bob'),{name:'Second Bob avatar'});
 assert.throws(()=>verify(f,'bob',bob,project,contribution),error(403));
 assert.throws(()=>verify(f,'bob',bobSecond,project,contribution),error(403));
 assert.throws(()=>verify(f,'alice',alice,project,contribution),error(403));
 const verified=verify(f,'reviewer',reviewer,project,contribution);
 assert.equal(verified.contributions.find(c=>c.workstream_id==='trace-route').status,'verified');
 assert.equal(verified.contributions.find(c=>c.workstream_id==='trace-route').outcome.completed,true);
 assert.equal(verified.shared_status.totals.verified_contributions,1);
 assert.equal(verifyGuildRecords(f.platform.db),true);
 // The whole guild flow leaves the coin ledger untouched; only an independent mission acceptance mints.
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0,'guild activity must never mint a coin');
 const {task}=realMission(f);
 const claim=f.tx('claim',f.actor('bob'),{task_id:task.id,agent_id:bob.id},'guild-coin-claim');
 const missionSubmission=f.tx('submit',f.actor('bob'),evidence(claim),'guild-coin-submit');
 const missionReview=f.tx('review',f.actor('reviewer'),{submission_id:missionSubmission.id,decision:'accepted',reason:'Independent acceptance against the registered rubric.'});
 assert.equal(missionReview.coin_reward.status,'awarded');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
 assert.equal(f.platform.coins(f.actor('bob'),{agent_id:bob.id}).balance,10);
 assert.equal(GUILD_PROJECT_POLICY.coins_awarded,0);
 assert.equal(GUILD_PROJECT_POLICY.grants_calling,false);
 assert.equal(GUILD_PROJECT_POLICY.grants_land,false);
 assert.equal(GUILD_PROJECT_POLICY.grants_role,false);
});

test('the new cooperative content survives backup, restore and validation',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 f.tx('questJoin',f.actor('alice'),{agent_id:agent.id,chain_id:'shared-frontier-path'},'join-frontier');
 buildFrontierPath(f,agent);
 f.platform.quests(f.actor('alice'),{agent_id:agent.id});
 const project=createProject(f,'alice',agent);
 const bob=f.agent('bob'),reviewer=f.agent('reviewer');
 participate(f,'bob',bob,project,'join');
 pledge(f,'bob',bob,project,'trace-route');
 submit(f,'bob',bob,project,'trace-route');
 verify(f,'reviewer',reviewer,project,f.platform.guildProject(f.actor('alice'),{id:project.id}).contributions.find(c=>c.workstream_id==='trace-route'));
 assert.equal(verifyQuestReceipts(f.platform.db),true);
 assert.equal(verifyQuestStructure(f.platform.db),true);
 assert.equal(verifyGuildRecords(f.platform.db),true);
 const backup=join(f.directory,'cooperative-content-backup.sqlite');
 backupDatabase(f.platform.db,backup);
 assert.equal(validateDatabase(backup).schema_version,22);
 f.platform.close();
 const restored=new Platform(f.database,f.clock);t.after(()=>restored.close());
 assert.equal(restored.quests(restored.authenticate(f.credentials.alice.token),{agent_id:agent.id}).progress.find(p=>p.chain_slug==='shared-frontier-path').complete,true);
 const restoredProject=restored.guildProject(restored.authenticate(f.credentials.alice.token),{id:project.id});
 assert.equal(restoredProject.contributions.find(c=>c.workstream_id==='trace-route').status,'verified');
 assert.equal(validateDatabase(f.database).schema_version,22);
});

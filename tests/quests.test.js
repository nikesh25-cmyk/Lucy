import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fixture, realMission, evidence} from './helpers.js';
import {Platform} from '../src/platform.js';
import {QUEST_ROUTE_IDS, SEED_QUESTS, verifyQuestReceipts, verifyQuestStructure} from '../src/quests.js';
import {verifyCallingReceipts} from '../src/vocations.js';
import {backupDatabase, validateDatabase} from '../src/recovery.js';

const position=(f,agent,world,x=6,y=6)=>f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?',world,x,y,agent.id);
const farm=(f,agent,x=4,y=6)=>{position(f,agent,`home:${agent.id}`,x,y);return f.tx('build',f.actor('alice'),agent.id,{x,y,type:'farm'});};
const garden=(f,agent,action,x=4,y=6,kind='herbs')=>f.tx('gardenAction',f.actor('alice'),{agent_id:agent.id,action,x,y,...(action==='plant'?{kind}:{})});
const begin=(f,agent,chain='quiet-harvest',key='join-1',owner='alice')=>f.tx('questJoin',f.actor(owner),{agent_id:agent.id,chain_id:chain},key);
const board=(f,agent,owner='alice')=>f.platform.quests(f.actor(owner),{agent_id:agent.id});
const questReceipts=f=>f.platform.get("SELECT COUNT(*) AS n FROM calling_receipts WHERE objective_id LIKE 'quest:%'").n;
const chain=(f,agent,slug='quiet-harvest')=>board(f,agent).chains.find(item=>item.slug===slug);
const steps=(f,agent,slug='quiet-harvest')=>chain(f,agent,slug).steps;
const earned=f=>f.platform.get('SELECT COALESCE(SUM(points),0) AS n FROM calling_receipts').n;
const researchSpec=(overrides={})=>({slug:'sourced-claim',title:'From claim to acceptance',route:'evidence_research',practice:false,beneficiary:'A named public beneficiary',
 summary:'Carry one scoped real question from a claim to an independent human acceptance.',narrative:'A real chain: the first step records a commitment and the second waits for a different operator to accept the work. Neither step can be marked complete by a model or by its author.',
 steps:[
  {slug:'scoped-claim',title:'Claim one scoped real task',instructions:'Claim an open real mission task that has an independent reviewer.',output_name:'A leased claim on a real task',source_kind:'research_claim'},
  {slug:'accepted-evidence',title:'Wait for independent acceptance',instructions:'Submit sourced work and wait for a different authorized operator to accept it.',output_name:'An accepted review receipt from another human',source_kind:'research_accepted',prerequisite:'scoped-claim'},
 ],...overrides});
const researchChain=(f,overrides={})=>f.tx('questAuthor',f.actor('reviewer'),researchSpec(overrides));

test('the shipped practice chain is a cosmetic route with no beneficiary, and a saved source advances exactly one step once',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 assert.equal(SEED_QUESTS.length,5);assert.equal(QUEST_ROUTE_IDS.length,3);
 const catalog=f.platform.questCatalog();
 assert.equal(catalog.chains.length,5);
 const chain=catalog.chains.find(entry=>entry.slug==='quiet-harvest');
 assert.equal(chain.slug,'quiet-harvest');assert.equal(chain.route,'gardening');assert.equal(chain.practice,true);assert.equal(chain.beneficiary,'');
 assert.equal(chain.steps.length,3);assert.deepEqual(chain.steps.map(step=>step.output.source_kind),['crop_plant','crop_harvest','craft']);
 assert.deepEqual(chain.steps.map(step=>step.prerequisite),[null,'first-sowing','patient-tending']);
 assert.equal(chain.steps.every(step=>step.output.requires_review===false),true);
 assert.match(chain.narrative,/patience/i);
 assert.equal(catalog.policy.coins_awarded,0);assert.equal(catalog.policy.client_completion,false);
 // No enrolment yet: the board offers the chain and claims nothing.
 const before=board(f,agent);assert.equal(before.enrolled_count,0);assert.equal(before.next_action,null);
 begin(f,agent);farm(f,agent);garden(f,agent,'plant');
 const after=board(f,agent);
 assert.equal(after.next_action.step_slug,'patient-tending');
 assert.equal(after.next_action.output.name,'Two gathered resources from a mature crop');
 assert.equal(after.next_action.action.section,'workshop');assert.equal(after.next_action.requires_human_review,false);
 assert.deepEqual(steps(f,agent).map(step=>step.state),['complete','available','locked']);
 // Reading the board and the calling view repeatedly never credits the same saved planting twice.
 for(let index=0;index<3;index++){board(f,agent);f.platform.callings(f.actor('alice'),{agent_id:agent.id});}
 assert.equal(questReceipts(f),1);
 assert.equal(board(f,agent).chains.find(chain=>chain.slug==='quiet-harvest').steps[0].saved_facts.length,1);
 assert.equal(earned(f),5);
});

test('the practice chain completes end to end from saved facts only, awarding cosmetic experience and never a coin',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 begin(f,agent);farm(f,agent,4,6);farm(f,agent,8,6);
 garden(f,agent,'plant',4,6,'herbs');garden(f,agent,'plant',8,6,'fiber');
 board(f,agent);
 assert.equal(questReceipts(f),1,'the first step is credited from the saved planting');
 f.advance(25*60000);
 garden(f,agent,'harvest',4,6);garden(f,agent,'harvest',8,6);
 board(f,agent);
 assert.equal(questReceipts(f),2,'the second step is credited from a harvested crop');
 assert.equal(board(f,agent).next_action.step_slug,'keepsake');
 assert.equal(steps(f,agent)[2].state,'available');
 // The shared ten-a-day cosmetic limit holds, so the craft waits for the next UTC day.
 assert.equal(board(f,agent).progress[0].steps[1].have,1);
 f.advance(86400000);
 f.tx('craftItem',f.actor('alice'),{agent_id:agent.id,recipe_id:'flower_crown'});
 const finished=board(f,agent);
 assert.equal(finished.progress[0].complete,true);assert.equal(finished.next_action,null);
 assert.deepEqual(steps(f,agent).map(step=>step.state),['complete','complete','complete']);
 assert.equal(questReceipts(f),3);assert.equal(earned(f),15);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0,'a quest chain must never mint a coin');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts WHERE points!=5').n,0);
 assert.equal(verifyCallingReceipts(f.platform.db),true);
 assert.equal(verifyQuestReceipts(f.platform.db),true);assert.equal(verifyQuestStructure(f.platform.db),true);
 // Export, backup and a fresh open agree with the recorded receipts.
 const exported=f.platform.exportAccount(f.actor('alice'));
 assert.equal(exported.format,'shared-world-account-v18');
 assert.equal(exported.quests.enrollments.length,1);assert.equal(exported.quests.receipts.length,3);
 const backup=join(f.directory,'quest-backup.sqlite');backupDatabase(f.platform.db,backup);
 assert.equal(validateDatabase(backup).schema_version, 26);
 f.platform.close();const reopened=new Platform(f.database,f.clock);t.after(()=>reopened.close());
 assert.equal(reopened.quests(reopened.authenticate(f.credentials.alice.token),{agent_id:agent.id}).progress[0].complete,true);
 assert.equal(reopened.get('SELECT COUNT(*) AS n FROM calling_receipts').n,3);
 assert.equal(validateDatabase(f.database).schema_version, 26);
});

test('progression survives reopen and replay without double-awarding, and an unattributable receipt fails validation',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 begin(f,agent);farm(f,agent);garden(f,agent,'plant');
 board(f,agent);
 assert.equal(questReceipts(f),1);
 f.platform.close();const reopened=new Platform(f.database,f.clock);t.after(()=>reopened.close());
 const actor=reopened.authenticate(f.credentials.alice.token);
 for(let index=0;index<3;index++)assert.equal(reopened.quests(actor,{agent_id:agent.id}).progress[0].steps[0].state,'complete');
 assert.equal(reopened.get('SELECT COUNT(*) AS n FROM calling_receipts').n,1);
 assert.equal(reopened.transaction(()=>reopened.questJoin(actor,{agent_id:agent.id,chain_id:'quiet-harvest'},'join-after-restart')).repeated,true);
 assert.equal(reopened.get('SELECT COUNT(*) AS n FROM calling_receipts').n,1);
 // A hand-written receipt cannot pass the existing insertion trigger, and a receipt whose enrolment
 // disappeared fails the whole-database validation.
 assert.throws(()=>reopened.run("INSERT INTO calling_receipts VALUES('fake',?,?,'explorer','quest:quiet-harvest.keepsake','craft','x','2026-01-01T00:00:00.000Z',0,'2026-01-01',5,'2026-01-01T00:00:00.000Z','deadbeef')",agent.id,actor.account.id),/verified current activity/);
 reopened.db.exec('DELETE FROM quest_enrollments');
 assert.equal(verifyQuestReceipts(reopened.db),false);
 assert.throws(()=>validateDatabase(f.database),/quest (chain|progression) validation failed/);
});

test('incomplete prerequisites stay locked and a client completion claim is refused',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 begin(f,agent);farm(f,agent,4,6);garden(f,agent,'plant',4,6,'herbs');
 assert.deepEqual(steps(f,agent).map(step=>step.state),['complete','available','locked']);
 assert.equal(steps(f,agent)[2].prerequisite.title,'Wait, tend, and gather');
 // A client cannot assert completion: the only writer is the server's own saved-fact pass.
 assert.throws(()=>f.platform.questComplete(f.actor('alice'),{agent_id:agent.id,chain_id:'quiet-harvest'}),{status:400});
 assert.throws(()=>f.platform.questComplete(f.actor('alice'),{agent_id:agent.id,chain_id:'quiet-harvest'}),/saved server fact/);
 assert.equal(questReceipts(f),1);
 assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM audit WHERE event='quest.completion_refused'").n,2);
 // The locked step cannot be credited even when its own saved fact arrives first.
 f.advance(25*60000);
 garden(f,agent,'harvest',4,6);
 assert.equal(steps(f,agent)[0].state,'complete');assert.equal(steps(f,agent)[1].state,'complete');
 assert.equal(questReceipts(f),2);
});

test('the two later practice chains are seeded, cosmetic and advanced only by their own saved facts',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 // The patient workshop: two crops, then two *different* crafts, so the second craft step needs a
 // keepsake made from the first keepsake.
 assert.deepEqual(SEED_QUESTS.map(item=>item.slug),['quiet-harvest','shared-frontier-path','commons-trail','patient-workshop','open-hearth-homestead']);
 const workshop=SEED_QUESTS.find(item=>item.slug==='patient-workshop');
 assert.equal(workshop.practice,true);assert.equal(workshop.route,'gardening');assert.equal(workshop.beneficiary,'');
 assert.deepEqual(workshop.steps.map(step=>step.source_kind),['crop_plant','crop_harvest','craft','craft']);
 assert.deepEqual(workshop.steps.map(step=>step.prerequisite),[null,'sow-the-row','gather-what-grew','first-keepsake']);
 begin(f,agent,'patient-workshop','join-workshop');
 assert.deepEqual(steps(f,agent,'patient-workshop').map(step=>step.state),['available','locked','locked','locked']);
 farm(f,agent,4,6);garden(f,agent,'plant',4,6,'herbs');
 assert.equal(steps(f,agent,'patient-workshop')[0].state,'complete');
 assert.equal(steps(f,agent,'patient-workshop')[1].state,'available');
 // The craft chain is stocked with grown resources; the first craft is a chain step, the second
 // spends the first craft's output.
 f.platform.run("INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,'herbs',3) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=3",agent.id);
 f.platform.run("INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,'fiber',1) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=1",agent.id);
 f.platform.run("INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,'grain',1) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=1",agent.id);
 f.advance(25*60000);garden(f,agent,'harvest',4,6,'herbs');
 assert.equal(steps(f,agent,'patient-workshop')[1].state,'complete');
 assert.equal(steps(f,agent,'patient-workshop')[2].state,'available');
 // The shared ten-a-day cosmetic limit holds, so the two craft steps fall on later UTC days.
 assert.equal(earned(f),10);
 f.advance(86400000);
 assert.equal(f.tx('craftItem',f.actor('alice'),{agent_id:agent.id,recipe_id:'sun_thread'}).crafted,'sun_thread');
 assert.equal(steps(f,agent,'patient-workshop')[2].state,'complete');
 assert.equal(steps(f,agent,'patient-workshop')[3].state,'available');
 assert.equal(earned(f),15);
 assert.equal(questReceipts(f),3);
 // The fourth step waits for a second, different saved craft.
 f.platform.run("INSERT INTO journey_inventory(agent_id,kind,quantity) VALUES(?,'grain',1) ON CONFLICT(agent_id,kind) DO UPDATE SET quantity=quantity",agent.id);
 f.advance(86400000);
 assert.equal(f.tx('craftItem',f.actor('alice'),{agent_id:agent.id,recipe_id:'field_ribbon'}).crafted,'field_ribbon');
 const finished=board(f,agent);
 assert.equal(finished.progress.find(item=>item.chain_slug==='patient-workshop').complete,true);
 assert.deepEqual(steps(f,agent,'patient-workshop').map(step=>step.state),['complete','complete','complete','complete']);
 assert.equal(questReceipts(f),4);assert.equal(earned(f),20);
 // The open hearth: four different saved facts, none of them a coin.
 const hearth=SEED_QUESTS.find(item=>item.slug==='open-hearth-homestead');
 assert.deepEqual(hearth.steps.map(step=>step.source_kind),['shared_visit','home_furnish','frontier_place','path_place']);
 assert.equal(new Set(hearth.steps.map(step=>step.source_kind)).size,4);
 assert.equal(hearth.practice,true);assert.equal(hearth.route,'world_building');assert.equal(hearth.beneficiary,'');
 assert.deepEqual(hearth.steps.map(step=>step.prerequisite),[null,'arrive-somewhere-shared','make-the-place-answer','mark-your-ground']);
 // Every shipped practice chain stays cosmetic; only the real evidence chain names a beneficiary.
 for(const item of SEED_QUESTS.filter(item=>item.practice)){
  assert.equal(item.beneficiary,'');assert.equal(item.route==='evidence_research',false);
  assert.equal(item.steps.every(step=>step.requires_review===false),true);
 }
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0,'neither new chain may mint a coin');
 assert.equal(verifyQuestReceipts(f.platform.db),true);assert.equal(verifyQuestStructure(f.platform.db),true);
});

test('one saved fact is credited once, shared honestly between a calling objective and a quest step',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 farm(f,agent,4,6);farm(f,agent,8,6);farm(f,agent,9,6);
 f.tx('callingSelect',f.actor('alice'),{agent_id:agent.id,calling_id:'cultivator'});
 begin(f,agent);
 garden(f,agent,'plant',4,6,'herbs');
 assert.equal(questReceipts(f),0,'the Cultivator objective takes the first saved planting');
 assert.equal(steps(f,agent)[0].state,'available');
 assert.equal(steps(f,agent)[0].progress.have,0);
 garden(f,agent,'plant',8,6,'fiber');
 assert.equal(steps(f,agent)[0].state,'complete');
 assert.equal(questReceipts(f),1);
 assert.deepEqual(f.platform.all("SELECT objective_id FROM calling_receipts WHERE objective_id LIKE 'quest:%' OR objective_id LIKE 'cultivator.%' ORDER BY objective_id").map(row=>row.objective_id),['cultivator.crop_plant','quest:quiet-harvest.first-sowing']);
 assert.equal(earned(f),10);
 // A third planting cannot exceed the shared ten-a-day cosmetic limit.
 farm(f,agent,9,6);garden(f,agent,'plant',9,6,'herbs');
 assert.equal(earned(f),10);
});

test('author permissions, route restrictions and the review boundary are enforced',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 const draft=researchChain(f);
 assert.equal(draft.status,'draft');assert.equal(draft.origin,'operator');
 assert.throws(()=>f.tx('questAuthor',f.actor('alice'),researchSpec({slug:'member-chain'})),{status:403});
 assert.throws(()=>f.tx('questManage',f.actor('alice'),{chain_id:'sourced-claim',action:'publish'}),{status:403});
 assert.throws(()=>begin(f,agent,'sourced-claim','join-draft'),{status:409});
 // A draft authored by another operator is neither listed nor joinable for this resident.
 assert.equal(board(f,agent).chains.some(chain=>chain.slug==='sourced-claim'),false);
 assert.equal(f.platform.questCatalog().chains.some(chain=>chain.slug==='sourced-claim'),false);
 // A shipped practice chain is administered by an administrator, never by an ordinary reviewer.
 assert.throws(()=>f.tx('questManage',f.actor('reviewer'),{chain_id:'quiet-harvest',action:'archive'}),{status:403});
 assert.equal(f.tx('questManage',f.actor('admin'),{chain_id:'quiet-harvest',action:'archive'}).status,'archived');
 assert.equal(f.platform.questCatalog().chains.some(chain=>chain.slug==='quiet-harvest'),false);
 assert.equal(f.platform.questCatalog().chains.length,4);
 assert.equal(f.tx('questManage',f.actor('admin'),{chain_id:'quiet-harvest',action:'publish'}).status,'published');
 // Route restrictions: a real chain must end in acceptance; practice chains stay cosmetic.
 assert.throws(()=>f.tx('questAuthor',f.actor('reviewer'),researchSpec({slug:'bad-route',steps:[{slug:'one',title:'One',instructions:'x',output_name:'x',source_kind:'crop_plant'},{slug:'two',title:'Two',instructions:'x',output_name:'x',source_kind:'research_accepted'}]})),{status:400});
 assert.throws(()=>f.tx('questAuthor',f.actor('reviewer'),researchSpec({slug:'no-accept',steps:[{slug:'one',title:'One',instructions:'x',output_name:'x',source_kind:'research_claim'},{slug:'two',title:'Two',instructions:'x',output_name:'x',source_kind:'research_claim'}]})),{status:400});
 assert.throws(()=>f.tx('questAuthor',f.actor('reviewer'),researchSpec({slug:'practice-real',practice:true,beneficiary:''})),{status:400});
 assert.throws(()=>f.tx('questAuthor',f.actor('reviewer'),researchSpec({slug:'real-without-beneficiary',beneficiary:''})),{status:400});
 assert.throws(()=>f.tx('questAuthor',f.actor('reviewer'),{slug:'bad-order',title:'Bad order',route:'gardening',practice:true,summary:'x',narrative:'x',steps:[{slug:'one',title:'One',instructions:'x',output_name:'x',source_kind:'crop_plant',ordinal:2},{slug:'two',title:'Two',instructions:'x',output_name:'x',source_kind:'craft'}]}),{status:400});
 assert.throws(()=>f.tx('questAuthor',f.actor('reviewer'),{slug:'short',title:'Short',route:'gardening',practice:true,summary:'x',narrative:'x',steps:[{slug:'one',title:'One',instructions:'x',output_name:'x',source_kind:'crop_plant'}]}),{status:400});
 assert.equal(verifyQuestStructure(f.platform.db),true);
});

test('a real evidence chain still ends in an independent human acceptance, and only that acceptance can mint coins',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 researchChain(f);
 f.tx('questManage',f.actor('reviewer'),{chain_id:'sourced-claim',action:'publish'});
 assert.equal(f.platform.questCatalog().chains.some(chain=>chain.slug==='sourced-claim'),true);
 begin(f,agent,'sourced-claim','join-research');
 assert.equal(board(f,agent).next_action.requires_human_review,false);
 const {task}=realMission(f);
 const claim=f.tx('claim',f.actor('alice'),{task_id:task.id,agent_id:agent.id},'claim-1');
 assert.equal(steps(f,agent,'sourced-claim')[0].state,'complete','the leased claim is a saved fact');
 assert.equal(steps(f,agent,'sourced-claim')[1].state,'available');
 assert.equal(board(f,agent).next_action.step_slug,'accepted-evidence');
 assert.equal(board(f,agent).next_action.requires_human_review,true);
 assert.equal(board(f,agent).next_action.action.section,'history');
 const submission=f.tx('submit',f.actor('alice'),evidence(claim),'submit-1');
 // The contributor cannot accept their own work, and the step does not move.
 assert.throws(()=>f.tx('review',f.actor('alice'),{submission_id:submission.id,decision:'accepted',reason:'Self approval attempt'}),{status:403});
 assert.equal(steps(f,agent,'sourced-claim')[1].state,'available');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0);
 const review=f.tx('review',f.actor('reviewer'),{submission_id:submission.id,decision:'accepted',reason:'Independent acceptance against the registered rubric.'});
 assert.equal(review.coin_reward.status,'awarded');
 assert.equal(steps(f,agent,'sourced-claim')[1].state,'complete','the independently accepted receipt is the step proof');
 assert.equal(board(f,agent).progress.find(item=>item.chain_slug==='sourced-claim').complete,true);
 assert.equal(questReceipts(f),2);
 // Exactly one coin receipt for that task, issued by the existing ledger and by nothing in the quest code.
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
 assert.equal(f.platform.coins(f.actor('alice'),{agent_id:agent.id}).balance,10);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts WHERE points!=5').n,0);
});

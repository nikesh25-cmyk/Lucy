import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture, realMission, evidence } from './helpers.js';
import { Platform } from '../src/platform.js';
import { CALLINGS, verifyCallingReceipts } from '../src/vocations.js';
import { WORLD_OBJECT_GUARDS } from '../src/placement-policy.js';
import { backupDatabase, validateDatabase } from '../src/recovery.js';

const read=(f,agent,owner='alice')=>f.platform.callings(f.actor(owner),{agent_id:agent.id});
const select=(f,agent,id,owner='alice')=>f.tx('callingSelect',f.actor(owner),{agent_id:agent.id,calling_id:id});
const position=(f,agent,world,x=6,y=6)=>f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?',world,x,y,agent.id);
const furnish=(f,agent,x=4,y=6,type='flowers')=>{position(f,agent,`home:${agent.id}`);return f.tx('build',f.actor('alice'),agent.id,{x,y,type});};
const circle=(f,agent,owner='bob')=>f.tx('createCircle',f.actor(owner),{agent_id:agent.id,name:'Neighbors with purpose',summary:'Share useful peaceful work.',focus:'Care'});
const event=(f,agent,owner='bob')=>f.tx('createEvent',f.actor(owner),{agent_id:agent.id,title:'Neighbors welcome',summary:'A public invitation, not a completed gathering.',starts_at:new Date(f.clock()+3600000).toISOString(),ends_at:new Date(f.clock()+7200000).toISOString(),capacity:5});

test('every resident starts with an explicit peaceful calling; public guilds omit private identity and private-world residents',async t=>{
 const f=await fixture(t),agent=f.agent('alice'),human=f.tx('createAgent',f.actor('alice'),{kind:'human',name:'Human neighbor'}),bob=f.agent('bob');
 assert.equal(CALLINGS.length,8);assert.equal(read(f,agent).calling.id,'explorer');assert.equal(read(f,human).experience.available,0);assert.equal(read(f,human).can_change,true);
 f.tx('updateProfile',f.actor('alice'),{agent_id:agent.id,bio:'A private context',purpose:'A private calling description'});
 const guilds=f.platform.callingGuilds({limit:1});assert.equal(guilds.groups.length,8);assert.equal(guilds.total,3);assert.equal(guilds.members.length,1);assert.equal(guilds.has_more,true);
 assert.doesNotMatch(JSON.stringify(guilds),/operator_id|account_id|email|password|private context|private calling|proof_hash|source_id/);
 f.tx('homeSettings',f.actor('bob'),bob.id,{visibility:'private'});position(f,bob,`home:${bob.id}`);assert.equal(f.platform.callingGuilds().total,2);
 assert.throws(()=>f.platform.callingGuilds({limit:25}),{status:400});assert.throws(()=>f.platform.callingGuilds({calling_id:'administrator'}),{status:400});
 const mayor=f.platform.all('SELECT id FROM npc_mayors')[0];const guide=f.platform.publicCallings([mayor.id])[mayor.id];assert.deepEqual(guide.rank,{level:0,title:'Civic guide'});assert.equal(guide.id,'steward');
 assert.equal(f.platform.world(null).participants.find(p=>p.id===agent.id).calling.id,'explorer');
});

test('only the human operator selects a calling, once per UTC day, without changing authority; paused and spoofed changes fail',async t=>{
 const f=await fixture(t),agent=f.agent('alice'),sibling=f.agent('alice','Sibling'),bob=f.agent('bob');
 const runtime=f.tx('runtime',f.actor('alice'),agent.id,{scopes:['read','contribute']});const worker=f.platform.authenticate(runtime.token,'read');
 assert.throws(()=>f.tx('callingSelect',worker,{agent_id:agent.id,calling_id:'builder'}),{status:403});assert.throws(()=>f.platform.callings(worker,{agent_id:sibling.id}),{status:404});assert.throws(()=>read(f,bob),{status:404});
 for(const payload of [{calling_id:'admin'},{calling_id:'builder',points:999},{calling_id:'builder',earned_day:'2000-01-01'},{calling_id:'builder',source_id:'fabricated'}])assert.throws(()=>f.tx('callingSelect',f.actor('alice'),{agent_id:agent.id,...payload}),{status:400});
 assert.equal(select(f,agent,'builder').changed,true);assert.equal(select(f,agent,'builder').changed,false);assert.throws(()=>select(f,agent,'cultivator'),{status:429});
 assert.equal(f.platform.get('SELECT role FROM accounts WHERE id=?',f.actor('alice').account.id).role,'member');assert.deepEqual(JSON.parse(f.platform.authenticate(runtime.token).credential.scopes),['read','contribute']);
 f.advance(86400000);assert.equal(select(f,agent,'cultivator').changed,true);f.tx('agentControl',f.actor('alice'),agent.id,'paused');assert.throws(()=>select(f,agent,'builder'),{status:403});assert.equal(read(f,agent).can_change,false);
 f.tx('agentControl',f.actor('alice'),agent.id,'active');f.tx('pause',f.actor('admin'),true);assert.throws(()=>select(f,agent,'builder'),{status:503});assert.equal(read(f,agent).today.earned,0);
});

test('builder experience requires saved permitted placement, deduplicates retries, survives removal, and never creates coins',async t=>{
 const f=await fixture(t),agent=f.agent('alice');
 furnish(f,agent);f.advance();select(f,agent,'builder');assert.equal(read(f,agent).experience.available,0,'Furniture from before selection is not backfilled');
 f.tx('landAssign',f.actor('alice'),{plot_id:'plot:0:0:5:5',purpose:'A peaceful learning garden'});position(f,agent,'frontier:0:0',30,32);
 const block={world_id:'frontier:0:0',x:31,y:33,z:0,type:'wood'};f.tx('frontierBuild',f.actor('alice'),agent.id,block);f.tx('frontierBuild',f.actor('alice'),agent.id,block);
 assert.equal(read(f,agent).experience.available,5);assert.equal(read(f,agent).receipts.length,1);
 furnish(f,agent,8,6);assert.equal(read(f,agent).experience.available,10);f.advance();furnish(f,agent,9,6);assert.equal(read(f,agent).today.earned,10);assert.equal(read(f,agent).today.remaining,0);
 position(f,agent,'frontier:0:0',30,32);f.advance();f.tx('frontierBuild',f.actor('alice'),agent.id,{...block,remove:true});assert.equal(read(f,agent).experience.available,10,'Recorded saved participation remains historical after legitimate cleanup');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0);assert.equal(verifyCallingReceipts(f.platform.db),true);
});

test('cultivator credits actual planting and server-checked harvest, capped per objective and day',async t=>{
 const f=await fixture(t),agent=f.agent('alice');select(f,agent,'cultivator');furnish(f,agent,4,6,'farm');
 const input={agent_id:agent.id,x:4,y:6};f.tx('gardenAction',f.actor('alice'),{...input,action:'plant',kind:'herbs'});assert.equal(read(f,agent).experience.available,5);
 assert.throws(()=>f.tx('gardenAction',f.actor('alice'),{...input,action:'harvest',ready_at:0}),{status:409});assert.equal(read(f,agent).experience.available,5);
 f.advance(20*60000);f.tx('gardenAction',f.actor('alice'),{...input,action:'harvest'});assert.equal(read(f,agent).experience.available,10);assert.equal(read(f,agent).today.objectives.every(o=>o.complete),true);
 f.tx('gardenAction',f.actor('alice'),{...input,action:'plant',kind:'herbs'});assert.equal(read(f,agent).experience.available,10);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts').n,2);
 f.advance(86400000);assert.equal(read(f,agent).today.earned,0,'Yesterday’s saved event cannot earn a new daily receipt');
});

test('host objectives use the exact runtime resident’s RSVP pledge and other-operator membership, not invitation publication or attendance',async t=>{
 const f=await fixture(t),agent=f.agent('alice'),sibling=f.agent('alice','Sibling'),bob=f.agent('bob');select(f,agent,'host');const c=circle(f,bob),e=event(f,bob);
 const mine=event(f,agent,'alice');assert.equal(read(f,agent).experience.available,0,'Automatic creator RSVP is not independent participation');assert.deepEqual(read(f,agent).targets.events.map(e=>e.id),[e.id]);
 const credential=f.tx('runtime',f.actor('alice'),agent.id,{scopes:['read','contribute']});const worker=f.platform.authenticate(credential.token,'contribute');
 f.tx('eventRSVP',worker,{agent_id:agent.id,event_id:e.id,action:'join'});f.tx('circleMembership',worker,{agent_id:agent.id,circle_id:c.id,action:'join'});
 const progress=f.platform.callings(worker);assert.equal(progress.experience.available,10);assert.match(progress.today.objectives.find(o=>o.id==='host.event_rsvp').instructions,/pledge.*not proof of attendance/);
 assert.equal(read(f,sibling).experience.available,0);assert.equal(progress.targets.events.length,0);assert.equal(progress.receipts.every(r=>r.agent_id===agent.id),true);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n,0);
 f.tx('eventRSVP',worker,{agent_id:agent.id,event_id:e.id,action:'cancel'});f.tx('eventRSVP',worker,{agent_id:agent.id,event_id:e.id,action:'join'});assert.equal(f.platform.callings(worker).today.earned,10);assert.notEqual(mine.id,e.id);
});

test('mediator experience records independent thanks and a pledge, not project completion or reviewed evidence',async t=>{
 const f=await fixture(t),agent=f.agent('alice'),bob=f.agent('bob'),sibling=f.agent('alice','Sibling');select(f,agent,'mediator');
 const project=f.tx('createProject',f.actor('bob'),{agent_id:bob.id,title:'Shared learning guide',summary:'Make a careful public guide.',goal:'Publish a source register.',evidence_requirements:'Original source attribution.'});
 assert.throws(()=>f.tx('giveThanks',f.actor('alice'),{agent_id:agent.id,recipient_agent_id:sibling.id,reason:'My own operator'}),{status:403});
 f.tx('giveThanks',f.actor('alice'),{agent_id:agent.id,recipient_agent_id:bob.id,reason:'Thank you for drafting the source register.'});f.tx('projectPledge',f.actor('alice'),{agent_id:agent.id,project_id:project.id,action:'pledge',commitment:'Check each source location.'});
 const progress=read(f,agent);assert.equal(progress.experience.available,10);assert.equal(f.platform.get('SELECT status FROM community_projects WHERE id=?',project.id).status,'active');assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM submissions').n,0);assert.equal(f.platform.coins(f.actor('alice'),{agent_id:agent.id}).balance,0);
});

test('research calling requires real scoped work and independent human acceptance; quarantine holds acceptance XP without rewriting coins',async t=>{
 const f=await fixture(t),agent=f.agent('alice');select(f,agent,'researcher');const {task}=realMission(f);const claim=f.tx('claim',f.actor('alice'),{task_id:task.id,agent_id:agent.id},'calling-real-claim');
 assert.equal(read(f,agent).experience.available,5);const submission=f.tx('submit',f.actor('alice'),evidence(claim),'calling-real-submit');assert.equal(read(f,agent).experience.available,5);assert.throws(()=>f.tx('review',f.actor('alice'),{submission_id:submission.id,decision:'accepted',reason:'Approve myself'}),{status:403});
 f.tx('review',f.actor('reviewer'),{submission_id:submission.id,decision:'accepted',reason:'Independent source review'});assert.equal(read(f,agent).experience.available,10);assert.equal(f.platform.coins(f.actor('alice'),{agent_id:agent.id}).balance,10);
 const coin={...f.platform.get('SELECT * FROM coin_rewards')};f.platform.run("UPDATE submissions SET status='quarantined' WHERE id=?",submission.id);assert.deepEqual(read(f,agent).experience,{earned:10,available:5,held:5,cosmetic:true});assert.equal(f.platform.coins(f.actor('alice'),{agent_id:agent.id}).balance,0);assert.deepEqual({...f.platform.get('SELECT * FROM coin_rewards')},coin);
 f.platform.run("UPDATE submissions SET status='accepted' WHERE id=?",submission.id);assert.equal(read(f,agent).experience.available,10);assert.equal(read(f,agent).receipts.length,2);
 const demo=f.platform.get('SELECT t.id FROM tasks t JOIN missions m ON m.id=t.mission_id WHERE m.demo=1');const demoClaim=f.tx('claim',f.actor('bob'),{task_id:demo.id,agent_id:f.agent('bob').id},'calling-demo');assert.ok(demoClaim);assert.equal(f.platform.get("SELECT COUNT(*) AS n FROM calling_source_events WHERE source_kind='research_claim' AND source_id=?",demoClaim.id).n,0);
});

test('receipt storage rejects model-authored events and point edits; tampering and missing protections fail recovery',async t=>{
 const f=await fixture(t),agent=f.agent('alice');select(f,agent,'builder');furnish(f,agent);read(f,agent);const row=f.platform.get('SELECT * FROM calling_receipts');assert.ok(row);
 const columns=['id','agent_id','account_id','calling_id','objective_id','source_kind','source_id','source_at','selected_at','earned_day','points','created_at','proof_hash'];
 const insert=changes=>f.platform.run(`INSERT INTO calling_receipts VALUES(${columns.map(()=>'?').join(',')})`,...columns.map(key=>({...row,id:'forged',...changes})[key]));
 assert.throws(()=>insert({source_id:'model-says-complete'}),/verified current activity/);assert.throws(()=>insert({objective_id:'builder.admin_approval'}),/verified current activity/);assert.throws(()=>insert({points:999}),/verified current activity|CHECK/);assert.throws(()=>f.platform.run('UPDATE calling_receipts SET points=10'),/cannot be changed/);
 const backup=join(f.directory,'calling-backup.sqlite');backupDatabase(f.platform.db,backup);assert.equal(validateDatabase(backup).schema_version,16);
 const corrupt=new DatabaseSync(backup);corrupt.exec("DROP TRIGGER calling_receipts_no_update; UPDATE calling_receipts SET proof_hash='forged'; CREATE TRIGGER calling_receipts_no_update BEFORE UPDATE ON calling_receipts BEGIN SELECT RAISE(ABORT,'Calling receipts cannot be changed'); END");corrupt.close();assert.throws(()=>validateDatabase(backup),/calling progress validation/);
 f.platform.db.exec('DROP TRIGGER world_objects_update_guard');assert.throws(()=>validateDatabase(f.database),/protections are incomplete/);
});

test('calling selections, receipts and ranks survive restart, export only owned records, and are removed on account deletion',async t=>{
 const f=await fixture(t),agent=f.agent('alice'),bob=f.agent('bob');select(f,agent,'builder');furnish(f,agent);read(f,agent);const saved={...f.platform.get('SELECT * FROM calling_receipts')};
 const exported=f.platform.exportAccount(f.actor('alice'));assert.equal(exported.format,'shared-world-account-v16');assert.equal(exported.callings.selections.length,1);assert.equal(exported.callings.receipts.length,1);assert.equal(exported.callings.receipts[0].agent_id,agent.id);assert.doesNotMatch(JSON.stringify(exported.callings),new RegExp(bob.id));
 f.platform.close();const restored=new Platform(f.database,f.clock);t.after(()=>restored.close());const actor=restored.authenticate(f.credentials.alice.token);assert.equal(restored.callings(actor,{agent_id:agent.id}).experience.available,5);assert.deepEqual({...restored.get('SELECT * FROM calling_receipts')},saved);assert.equal(validateDatabase(f.database).schema_version,16);
 restored.transaction(()=>restored.deleteAccount(actor));assert.equal(restored.get('SELECT COUNT(*) AS n FROM calling_receipts').n,0);assert.equal(restored.get('SELECT COUNT(*) AS n FROM resident_callings WHERE agent_id=?',agent.id).n,0);assert.equal(restored.callingGuilds().total,1);assert.equal(validateDatabase(f.database).schema_version,16);
});

test('schema thirteen migration preserves existing coins and land while starting callings without historical backfill',async t=>{
 const f=await fixture(t),agent=f.agent('alice'),{task}=realMission(f);furnish(f,agent);const claim=f.tx('claim',f.actor('alice'),{task_id:task.id,agent_id:agent.id},'schema13-claim');const submission=f.tx('submit',f.actor('alice'),evidence(claim),'schema13-submit');f.tx('review',f.actor('reviewer'),{submission_id:submission.id,decision:'accepted',reason:'Independent fixture'});
 const coin={...f.platform.get('SELECT * FROM coin_rewards')};f.tx('landAssign',f.actor('alice'),{plot_id:'plot:0:0:5:5',purpose:'Preserve a learning garden'});const land={...f.platform.get('SELECT * FROM land_stewardships')};
 f.platform.db.exec('DROP VIEW calling_source_events; DROP VIEW calling_objective_rules; DROP TABLE calling_receipts; DROP TABLE resident_callings; DROP TRIGGER world_objects_update_guard; PRAGMA user_version=13');assert.equal(validateDatabase(f.database).schema_version,13);f.advance();f.platform.close();const restored=new Platform(f.database,f.clock);t.after(()=>restored.close());
 assert.deepEqual({...restored.get('SELECT * FROM coin_rewards')},coin);assert.deepEqual({...restored.get('SELECT * FROM land_stewardships')},land);assert.equal(restored.callings(restored.authenticate(f.credentials.alice.token),{agent_id:agent.id}).experience.available,0);assert.equal(validateDatabase(f.database).schema_version,16);
});

test('garden and cottage UPDATE storage guards enforce the per-world palette and bounds; restored backups validate the same policy',async t=>{
 const f=await fixture(t),agent=f.agent('alice');furnish(f,agent);position(f,agent,`house:${agent.id}`);const object=f.tx('build',f.actor('alice'),agent.id,{x:6,y:6,type:'flowers'});const id=object.id||f.platform.get('SELECT id FROM world_objects WHERE world_id=?',`house:${agent.id}`).id;
 assert.throws(()=>f.platform.run("UPDATE world_objects SET type='tree' WHERE id=?",id),/palette/);assert.throws(()=>f.platform.run('UPDATE world_objects SET x=999 WHERE id=?',id),/palette/);assert.throws(()=>f.platform.run("UPDATE world_objects SET world_id='commons' WHERE id=?",id),/palette/);f.platform.run("UPDATE world_objects SET type='bench' WHERE id=?",id);assert.equal(validateDatabase(f.database).schema_version,16);
 const backup=join(f.directory,'bad-cottage.sqlite');backupDatabase(f.platform.db,backup);const corrupt=new DatabaseSync(backup);corrupt.exec('DROP TRIGGER world_objects_update_guard');corrupt.prepare("UPDATE world_objects SET type='tree' WHERE id=?").run(id);corrupt.exec(WORLD_OBJECT_GUARDS);corrupt.close();assert.throws(()=>validateDatabase(backup),/garden construction is invalid/);
});


test('explorer, steward and artisan objectives use actual discovery, expansion, path placement and recipe debit',async t=>{
 const f=await fixture(t),explorer=f.agent('alice'),steward=f.agent('alice','Shared paths'),artisan=f.agent('alice','Thoughtful maker'),bob=f.agent('bob');
 position(f,explorer,'library');f.tx('recordVisit',f.actor('alice'),explorer.id,'library');const c=circle(f,bob);f.tx('circleMembership',f.actor('alice'),{agent_id:explorer.id,circle_id:c.id,action:'join'});assert.equal(read(f,explorer).experience.available,10);
 select(f,steward,'steward');position(f,steward,'frontier:0:0',46,24);const expand=f.tx('frontierExpand',f.actor('alice'),steward.id,{world_id:'frontier:0:0',direction:'right'});assert.equal(expand.created,true);f.tx('frontierExpand',f.actor('alice'),steward.id,{world_id:'frontier:0:0',direction:'right'});assert.equal(read(f,steward).experience.available,5);
 f.tx('landAssign',f.actor('alice'),{plot_id:'plot:0:0:5:5',purpose:'A clear neighbor path'});position(f,steward,'frontier:0:0',30,32);f.advance();f.tx('frontierBuild',f.actor('alice'),steward.id,{world_id:'frontier:0:0',x:31,y:33,z:0,type:'path'});assert.equal(read(f,steward).experience.available,10);
 select(f,artisan,'artisan');f.platform.run('INSERT INTO journey_inventory VALUES(?,?,?)',artisan.id,'herbs',2);f.platform.run('INSERT INTO journey_inventory VALUES(?,?,?)',artisan.id,'fiber',1);f.tx('craftItem',f.actor('alice'),{agent_id:artisan.id,recipe_id:'flower_crown'});assert.equal(read(f,artisan).experience.available,5);assert.deepEqual(f.platform.journey(f.actor('alice'),{agent_id:artisan.id}).inventory,[{kind:'flower_crown',quantity:1}]);furnish(f,artisan);assert.equal(read(f,artisan).experience.available,10);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0);
});

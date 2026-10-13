import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture, realMission, evidence} from './helpers.js';
import {Platform} from '../src/platform.js';
import {getWorldDefinition, walkable} from '../world.js';
import {GUILD_IDS, GUILD_PROJECT_POLICY, verifyGuildRecords} from '../src/guilds.js';
import {COIN_POLICY} from '../src/coins.js';
import {backupDatabase, validateDatabase} from '../src/recovery.js';

const error=status=>caught=>caught.status===status;
const position=(f,agent,world,x=6,y=6)=>f.platform.run('UPDATE agents SET world_id=?,x=?,y=?,z=0,grounded=1 WHERE id=?',world,x,y,agent.id);
const workstream=(id,changes={})=>({id,title:`Planned work: ${id}`,output_name:`A saved ${id} result`,scope:`Do the bounded work named ${id}`,...changes});
const create=(f,owner,agent,changes={})=>f.tx('guildProjectCreate',f.actor(owner),{agent_id:agent.id,guild_id:'cultivator',title:'A shared growing plan',summary:'Coordinate one bounded piece of cooperative work.',visibility:'public',plan:[workstream('walk')],...changes});
const participation=(f,owner,agent,project,action)=>f.tx('guildParticipation',f.actor(owner),{agent_id:agent.id,project_id:project.id,action});
const pledge=(f,owner,agent,project,id='walk',changes={})=>f.tx('guildContribution',f.actor(owner),{agent_id:agent.id,project_id:project.id,workstream_id:id,action:'pledge',commitment:'I will do this one bounded thing.',...changes});
const submit=(f,owner,agent,project,id='walk')=>f.tx('guildContribution',f.actor(owner),{agent_id:agent.id,project_id:project.id,workstream_id:id,action:'submit',evidence:'A recorded result on the server, with its limits.',sources:[{url:'https://example.org/route',location:'Section 1'}]});
const verify=(f,owner,agent,project,contribution,changes={})=>f.tx('guildVerify',f.actor(owner),{agent_id:agent.id,project_id:project.id,contribution_id:contribution.id,action:'approve',reason:'Checked the recorded result independently.',...changes});
// Two nearby walkable, empty tiles inside the same stewarded plot, for the land-rule proof.
function plotTiles(f,world='frontier:0:0'){
 const definition=getWorldDefinition(world),tiles=[];
 for(let y=30;y<36;y++)for(let x=30;x<36;x++){
  if(!walkable({x,y},definition))continue;
  if(f.platform.get('SELECT id FROM frontier_blocks WHERE world_id=? AND x=? AND y=? AND z=0',world,x,y))continue;
  if(f.platform.get("SELECT id FROM agents WHERE world_id=? AND x=? AND y=? AND status!='deleted'",world,x,y))continue;
  tiles.push({x,y});
 }
 for(const first of tiles)for(const second of tiles){
  const reach=Math.abs(first.x-second.x)+Math.abs(first.y-second.y);
  if(first!==second&&reach>=1&&reach<=6)return[first,second];
 }
 return null;
}

test('a guild project is not a calling: any resident may join any guild without gaining or needing a calling or an account role',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),bob=f.agent('bob'),human=f.tx('createAgent',f.actor('alice'),{kind:'human',name:'Human neighbor'});
 assert.equal(GUILD_IDS.length,8,'the eight guilds follow the eight callings');
 assert.equal(f.platform.get('SELECT calling_id FROM resident_callings WHERE agent_id=?',bob.id).calling_id,'explorer');
 f.tx('callingSelect',f.actor('bob'),{agent_id:bob.id,calling_id:'builder'});
 // The Builder resident belongs to Peaceful Builders; the project belongs to Living Gardens.
 const project=create(f,'alice',alice,{guild_id:'cultivator'});
 assert.equal(project.guild_id,'cultivator');assert.equal(project.guild_name,'Living Gardens');
 assert.equal(project.participants.find(person=>person.id===alice.id).role,'organiser');
 const before={callings:f.platform.get('SELECT COUNT(*) AS n FROM resident_callings').n,receipts:f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts').n,role:f.platform.get('SELECT role FROM accounts WHERE id=?',f.actor('bob').account.id).role};
 const joined=participation(f,'bob',bob,project,'join');
 assert.equal(joined.joined,true);assert.equal(joined.role,'member');assert.equal(joined.state,'active');
 assert.equal(f.platform.get('SELECT calling_id FROM resident_callings WHERE agent_id=?',bob.id).calling_id,'builder','joining neither grants nor requires a calling');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM resident_callings').n,before.callings);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts').n,before.receipts,'participation awards no calling experience');
 assert.equal(f.platform.get('SELECT role FROM accounts WHERE id=?',f.actor('bob').account.id).role,before.role);
 // A human avatar participates on the same terms as an AI resident.
 assert.equal(participation(f,'alice',human,project,'join').joined,true);
 const view=f.platform.guildProject(f.actor('bob'),{id:project.id,agent_id:bob.id});
 assert.equal(view.participants.find(person=>person.id===human.id).kind,'human');
 assert.equal(view.participants.some(person=>person.kind==='agent'),true);
 assert.equal(view.participation.joined,true);assert.equal(view.participation.state,'active');
 assert.equal(GUILD_PROJECT_POLICY.grants_calling,false);assert.equal(GUILD_PROJECT_POLICY.grants_role,false);
});

test('a private guild project is neither listed nor readable nor joinable by an outsider',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),bob=f.agent('bob');
 const hidden=create(f,'alice',alice,{title:'A private plan',visibility:'private'});
 const shown=create(f,'alice',alice,{title:'A public plan',visibility:'public'});
 assert.deepEqual(f.platform.guilds(null,{}).projects.map(p=>p.title),['A public plan']);
 const outsider=f.platform.guilds(f.actor('bob'),{agent_id:bob.id});
 assert.deepEqual(outsider.projects.map(p=>p.title),['A public plan']);
 assert.doesNotMatch(JSON.stringify(outsider),/A private plan/);
 assert.deepEqual(f.platform.guilds(f.actor('alice'),{agent_id:alice.id}).projects.map(p=>p.title).sort(),['A private plan','A public plan']);
 assert.equal(outsider.projects[0].visibility,'public');
 assert.throws(()=>f.platform.guildProject(f.actor('bob'),{id:hidden.id}),error(404));
 assert.throws(()=>participation(f,'bob',bob,hidden,'join'),error(404));
 assert.equal(f.platform.guildProject(f.actor('alice'),{id:hidden.id}).title,'A private plan');
 assert.equal(f.platform.guildProject(f.actor('alice'),{id:shown.id}).title,'A public plan');
 // Sharing is a one-way action by the creating operator; a shared project then behaves publicly.
 assert.equal(f.tx('guildProjectManage',f.actor('alice'),{id:hidden.id,action:'share',reason:'Ready for neighbors.'}).shared,true);
 assert.equal(f.platform.guilds(f.actor('bob'),{}).projects.some(p=>p.id===hidden.id),true);
 assert.equal(participation(f,'bob',bob,hidden,'join').joined,true);
 assert.throws(()=>f.platform.run("UPDATE guild_projects SET visibility='private' WHERE id=?",hidden.id),/visibility/);
});

test('participation is explicit: pausing keeps standing commitments and leaving withdraws only unsubmitted ones',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),bob=f.agent('bob');
 const project=create(f,'alice',alice,{plan:[workstream('walk'),workstream('map')]});
 const joined=participation(f,'bob',bob,project,'join');
 assert.equal(joined.state,'active');assert.equal(joined.role,'member');
 const pledged=pledge(f,'bob',bob,project,'walk');
 assert.equal(pledged.shared_status.totals.commitments,1);
 assert.equal(pledged.shared_status.totals.verified_contributions,0);
 assert.equal(pledged.contributions[0].outcome.completed,false,'a pledge is never a completed outcome');
 assert.equal(pledged.contributions[0].status,'pledged');
 assert.equal(participation(f,'bob',bob,project,'pause').state,'paused');
 let view=f.platform.guildProject(f.actor('alice'),{id:project.id,agent_id:alice.id});
 assert.equal(view.participation.count,2,'the organiser and the joining resident');
 assert.equal(view.participation.active,1,'the organiser is still active');
 assert.equal(view.participation.paused,1);
 assert.equal(view.shared_status.totals.commitments,1,'a paused standing commitment stays recorded rather than disappearing');
 assert.equal(view.shared_status.totals.paused_participants,1);
 assert.equal(view.contributions[0].participant.state,'paused');
 assert.throws(()=>submit(f,'bob',bob,project,'walk'),error(403),'a paused participant cannot submit evidence');
 assert.throws(()=>pledge(f,'bob',bob,project,'map'),error(403));
 assert.equal(participation(f,'bob',bob,project,'resume').state,'active');
 assert.equal(submit(f,'bob',bob,project,'walk').contributions[0].status,'submitted');
 pledge(f,'bob',bob,project,'map');
 view=f.platform.guildProject(f.actor('alice'),{id:project.id});
 assert.equal(view.shared_status.totals.claims,1);assert.equal(view.shared_status.totals.commitments,1);
 const left=participation(f,'bob',bob,project,'leave');
 assert.equal(left.left,true);assert.equal(left.withdrawn_commitments,1);
 view=f.platform.guildProject(f.actor('alice'),{id:project.id});
 assert.equal(view.participation.count,1,'only the organiser still participates');
 assert.equal(view.participation.joined,false);
 assert.equal(view.shared_status.totals.commitments,0,'the unsubmitted commitment was withdrawn, so the plan stays accurate');
 assert.equal(view.shared_status.totals.claims,1,'the submitted claim stays recorded as history');
 assert.equal(view.contributions.length,1);
 assert.equal(view.contributions[0].workstream_id,'walk');
 assert.equal(view.contributions[0].participant.state,'left');
 assert.equal(view.contributions[0].outcome.completed,false);
 assert.throws(()=>f.tx('guildContribution',f.actor('bob'),{agent_id:bob.id,project_id:project.id,workstream_id:'walk',action:'submit',evidence:'After leaving.'}),error(403));
 assert.equal(participation(f,'bob',bob,project,'join').joined,true,'rejoining is a fresh, explicit participation');
 assert.equal(f.platform.guildProject(f.actor('bob'),{id:project.id,agent_id:bob.id}).participation.joined,true);
 assert.throws(()=>f.tx('guildParticipation',f.actor('bob'),{agent_id:bob.id,project_id:project.id,action:'fly'}),error(400));
});

test('the join, contribute, verify and leave flow keeps verification with a different operator and never mints a coin',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),aliceSecond=f.tx('createAgent',f.actor('alice'),{name:'Second Alice avatar'}),bob=f.agent('bob'),bobSecond=f.tx('createAgent',f.actor('bob'),{name:'Second Bob avatar'}),reviewer=f.agent('reviewer');
 const project=create(f,'alice',alice);
 participation(f,'bob',bob,project,'join');
 assert.equal(pledge(f,'bob',bob,project,'walk').contributions[0].status,'pledged');
 const submitted=submit(f,'bob',bob,project,'walk'),contribution=submitted.contributions[0];
 assert.equal(contribution.status,'submitted');
 assert.equal(contribution.outcome.completed,false);
 assert.equal(contribution.outcome.verified,false);
 assert.equal(submitted.shared_status.totals.verified_contributions,0);
 assert.equal(submitted.shared_status.all_workstreams_verified,false);
 // Independence is decided by operator, never by character: neither the contributor's own operator,
 // nor a second character of it, nor the project creator's operator may verify.
 assert.throws(()=>verify(f,'bob',bob,project,contribution),error(403));
 assert.throws(()=>verify(f,'bob',bobSecond,project,contribution),error(403));
 assert.throws(()=>verify(f,'alice',alice,project,contribution),error(403));
 assert.throws(()=>verify(f,'alice',aliceSecond,project,contribution),error(403));
 assert.equal(f.platform.get('SELECT status FROM guild_contributions WHERE id=?',contribution.id).status,'submitted');
 const verified=verify(f,'reviewer',reviewer,project,contribution);
 assert.equal(verified.contributions[0].status,'verified');
 assert.equal(verified.contributions[0].outcome.completed,true);
 assert.equal(verified.contributions[0].outcome.verified,true);
 assert.equal(verified.contributions[0].verified_by,reviewer.name);
 assert.equal(verified.shared_status.totals.verified_contributions,1);
 assert.equal(verified.shared_status.all_workstreams_verified,true);
 assert.equal(verifyGuildRecords(f.platform.db),true);
 assert.equal(participation(f,'bob',bob,project,'leave').left,true);
 const after=f.platform.guildProject(f.actor('reviewer'),{id:project.id});
 assert.equal(after.contributions[0].status,'verified');
 assert.equal(after.contributions[0].participant.state,'left');
 assert.equal(after.shared_status.totals.verified_contributions,1);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0,'guild activity mints nothing');
 assert.equal(COIN_POLICY.award,10);assert.equal(COIN_POLICY.operator_daily_limit,100);
 assert.equal(COIN_POLICY.currency,'Nemo Coins');
 // The original independent coin rules are intact end to end, including the same-operator exclusion.
 const {task}=realMission(f);
 const claim=f.tx('claim',f.actor('bob'),{task_id:task.id,agent_id:bob.id},'guild-coin-claim');
 const submission=f.tx('submit',f.actor('bob'),evidence(claim),'guild-coin-submit');
 assert.throws(()=>f.tx('review',f.actor('bob'),{submission_id:submission.id,decision:'accepted',reason:'Self approval attempt.'}),error(403));
 const review=f.tx('review',f.actor('reviewer'),{submission_id:submission.id,decision:'accepted',reason:'Independent acceptance against the registered rubric.'});
 assert.equal(review.coin_reward.status,'awarded');assert.equal(review.coin_reward.amount,10);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,1);
 assert.equal(f.platform.coins(f.actor('bob'),{agent_id:bob.id}).balance,10);
});

test('joining and contributing a guild project grants no plot, building right or stewardship',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),bob=f.agent('bob');
 const tiles=plotTiles(f);
 assert.ok(tiles,'the finite registry must offer two nearby walkable tiles in plot:0:0:5:5');
 const [first,second]=tiles;
 f.tx('landAssign',f.actor('alice'),{plot_id:'plot:0:0:5:5',purpose:'A peaceful learning garden'});
 // The steward stands beside the tile she builds, so the plot proof leaves the target clear.
 position(f,alice,'frontier:0:0',second.x,second.y);
 assert.equal(f.tx('frontierBuild',f.actor('alice'),alice.id,{world_id:'frontier:0:0',x:first.x,y:first.y,z:0,type:'wood'}).plot_id,'plot:0:0:5:5');
 position(f,alice,`home:${alice.id}`,4,6);
 const stewardships=f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n;
 const events=f.platform.get('SELECT COUNT(*) AS n FROM land_events').n;
 const project=create(f,'alice',alice,{guild_id:'steward',title:'A cooperative stewardship plan'});
 participation(f,'bob',bob,project,'join');
 pledge(f,'bob',bob,project,'walk');
 submit(f,'bob',bob,project,'walk');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n,stewardships,'a guild project assigns no stewardship');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_events').n,events);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships WHERE account_id=?',f.actor('bob').account.id).n,0);
 position(f,bob,'frontier:0:0',second.x,second.y);
 assert.throws(()=>f.tx('frontierBuild',f.actor('bob'),bob.id,{world_id:'frontier:0:0',x:second.x,y:second.y,z:0,type:'wood'}),error(403),'participation never grants a building right');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM frontier_blocks WHERE creator_account_id=?',f.actor('bob').account.id).n,0);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships').n,1);
});

test('an organiser role grants no moderator, reviewer or management authority',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),bob=f.agent('bob'),reviewer=f.agent('reviewer');
 const project=create(f,'alice',alice);
 assert.equal(f.platform.get('SELECT role FROM guild_participants WHERE project_id=? AND agent_id=?',project.id,alice.id).role,'organiser');
 assert.equal(f.platform.get('SELECT role FROM accounts WHERE id=?',f.actor('alice').account.id).role,'member');
 const bobProject=create(f,'bob',bob,{title:'Another resident’s plan'});
 for(const [label,call] of [
  ['moderate',()=>f.tx('moderate',f.actor('alice'),{report_id:'any',action:'dismiss',reason:'An organiser is not a moderator.'})],
  ['review',()=>f.tx('review',f.actor('alice'),{submission_id:'any',decision:'accepted',reason:'An organiser is not a reviewer.'})],
  ['accountControl',()=>f.tx('accountControl',f.actor('alice'),{account_id:f.actor('bob').account.id,status:'suspended'})],
  ['questAuthor',()=>f.tx('questAuthor',f.actor('alice'),{})],
  ['operations',()=>f.platform.operations(f.actor('alice'))],
  ['manage another project',()=>f.tx('guildProjectManage',f.actor('alice'),{id:bobProject.id,action:'archive',reason:'An organiser is not a moderator.'})],
  ['manage as a runtime',()=>f.tx('guildProjectManage',f.platform.authenticate(f.tx('runtime',f.actor('alice'),alice.id,{scopes:['contribute']}).token),{id:project.id,action:'archive',reason:'A runtime is not an operator.'})],
  ['create as a runtime',()=>f.tx('guildProjectCreate',f.platform.authenticate(f.tx('runtime',f.actor('alice'),alice.id,{scopes:['read','contribute']}).token),{agent_id:alice.id,guild_id:'cultivator',title:'Runtime plan',summary:'Not allowed.',plan:[workstream('walk')]})],
 ])assert.throws(call,error(403),`${label} must be refused (an organiser is a project membership role only)`);
 assert.equal(f.platform.get('SELECT role FROM accounts WHERE id=?',f.actor('alice').account.id).role,'member');
 assert.equal(GUILD_PROJECT_POLICY.grants_moderator,false);assert.equal(GUILD_PROJECT_POLICY.grants_reviewer,false);
 // The organiser of a project cannot verify work inside it, not even as an independent operator.
 participation(f,'bob',bob,project,'join');
 pledge(f,'bob',bob,project,'walk');
 const submitted=submit(f,'bob',bob,project,'walk');
 assert.throws(()=>verify(f,'alice',alice,project,submitted.contributions[0]),error(403));
 // An ordinary member of another operator is still an independent peer verifier.
 assert.equal(verify(f,'reviewer',reviewer,project,submitted.contributions[0]).contributions[0].status,'verified');
});

test('guild project records are checked whole: schema 19 migrates an older database and survives backup and restore',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),bob=f.agent('bob'),reviewer=f.agent('reviewer');
 const project=create(f,'alice',alice);
 participation(f,'bob',bob,project,'join');
 pledge(f,'bob',bob,project,'walk');
 const contribution=submit(f,'bob',bob,project,'walk').contributions[0];
 verify(f,'reviewer',reviewer,project,contribution);
 assert.equal(verifyGuildRecords(f.platform.db),true);
 // A verification naming the contributor's own operator breaks the independence rule that backup
 // validation re-checks, so a tampered record cannot pass a restore.
 f.platform.run('UPDATE guild_contributions SET verified_by_account_id=?,verified_by_agent_id=? WHERE id=?',f.actor('bob').account.id,bob.id,contribution.id);
 assert.equal(verifyGuildRecords(f.platform.db),false);
 assert.throws(()=>validateDatabase(f.database),/guild project validation failed/);
 f.platform.run('UPDATE guild_contributions SET verified_by_account_id=?,verified_by_agent_id=? WHERE id=?',f.actor('reviewer').account.id,reviewer.id,contribution.id);
 assert.equal(verifyGuildRecords(f.platform.db),true);
 const exported=f.platform.exportAccount(f.actor('alice'));
 assert.equal(exported.format,'shared-world-account-v18');
 assert.equal(exported.guilds.projects.length,1);
 assert.equal(exported.guilds.participations.length,1);
 assert.deepEqual(exported.guilds.projects[0].plan,f.platform.guildProject(f.actor('alice'),{id:project.id}).plan);
 assert.doesNotMatch(JSON.stringify(exported.guilds),new RegExp(f.actor('bob').account.id));
 const backup=join(f.directory,'guild-backup.sqlite');
 backupDatabase(f.platform.db,backup);
 assert.equal(validateDatabase(backup).schema_version,19);
 // A backup that lost a guild table is refused rather than silently accepted.
 const broken=join(f.directory,'guild-broken.sqlite');
 backupDatabase(f.platform.db,broken);
 const tampered=new DatabaseSync(broken);
 tampered.exec('DROP TABLE guild_participants');
 tampered.close();
 assert.throws(()=>validateDatabase(broken),/guild project schema is incomplete/);
 f.platform.close();
 const restored=new Platform(f.database,f.clock);t.after(()=>restored.close());
 const view=restored.guildProject(restored.authenticate(f.credentials.alice.token),{id:project.id});
 assert.equal(view.contributions[0].status,'verified');
 assert.equal(view.shared_status.totals.verified_contributions,1);
 assert.equal(restored.verifyAudit(),true);
 // A pre-change database without the guild tables validates as schema 17 and migrates forward.
 const legacy=new DatabaseSync(f.database);
 legacy.exec("PRAGMA foreign_keys=OFF; DROP TABLE guild_contributions; DROP TABLE guild_participants; DROP TABLE guild_projects; DROP TRIGGER IF EXISTS guild_projects_identity_immutable; DROP TRIGGER IF EXISTS guild_projects_keep_records; PRAGMA user_version=17;");
 legacy.close();
 assert.equal(validateDatabase(f.database).schema_version,17);
 const migrated=new Platform(f.database,f.clock);t.after(()=>migrated.close());
 assert.equal(validateDatabase(f.database).schema_version,19);
 assert.equal(migrated.get('SELECT COUNT(*) AS n FROM guild_projects').n,0);
 assert.equal(validateDatabase(f.database).accounts,5);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createApp} from '../server.js';
import {verifyGuildRecords} from '../src/guilds.js';
import {fixture} from './helpers.js';

const plan=[{id:'walk',title:'Walk one accessible route',output_name:'A traced route',scope:'Walk and record one route'}];
const spec={guild_id:'cultivator',title:'A shared growing plan',summary:'One bounded piece of cooperative work.',visibility:'public',plan};

async function serve(t,f){
 const {server}=createApp({platform:f.platform,backupDir:join(f.directory,'backups')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const base=`http://127.0.0.1:${server.address().port}`;
 return async(path,{token,input,method=input?'POST':'GET',apiClient}={})=>{
  const response=await fetch(`${base}/api/v1${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(input?{'Content-Type':'application/json'}:{}),...(apiClient?{'X-API-Client':apiClient}:{})},...(input?{body:JSON.stringify(input)}:{})});
  return{status:response.status,data:await response.json()};
 };
}

test('guild project routes enforce visibility, explicit participation, independent verification and management',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),bob=f.agent('bob'),reviewer=f.agent('reviewer');
 const req=await serve(t,f);
 const board=await req('/guilds');
 assert.equal(board.status,200);
 assert.equal(board.data.guilds.length,8);
 assert.equal(board.data.projects.length,0);
 assert.equal(board.data.policy.coins_awarded,0);
 assert.equal(board.data.policy.grants_land,false);
 assert.equal(board.data.policy.grants_moderator,false);
 assert.equal(board.data.policy.grants_reviewer,false);
 assert.equal((await req('/guilds?limit=25')).status,400);
 assert.equal((await req('/guilds?guild_id=mayor')).status,400);
 assert.equal((await req('/guilds/project')).status,404);
 // Only a signed-in human operator starts a project; a runtime credential cannot.
 const runtime=f.tx('runtime',f.actor('alice'),alice.id,{scopes:['read','contribute']});
 assert.equal((await req('/guilds/projects',{token:runtime.token,input:{agent_id:alice.id,...spec}})).status,403);
 assert.equal((await req('/guilds/projects',{input:{agent_id:alice.id,...spec},apiClient:'operator'})).status,401);
 const privateProject=await req('/guilds/projects',{token:f.credentials.alice.token,input:{agent_id:alice.id,...spec,visibility:'private',title:'A private plan'}});
 assert.equal(privateProject.status,201);assert.equal(privateProject.data.visibility,'private');
 const publicProject=await req('/guilds/projects',{token:f.credentials.alice.token,input:{agent_id:alice.id,...spec}});
 assert.equal(publicProject.status,201);
 const id=publicProject.data.id;
 assert.equal(publicProject.data.shared_status.totals.planned_workstreams,1);
 // Visibility: an outsider cannot read or join a private project, and never sees it listed.
 assert.equal((await req(`/guilds/project?id=${privateProject.data.id}`,{token:f.credentials.bob.token})).status,404);
 assert.equal((await req(`/guilds/project?id=${privateProject.data.id}`)).status,404);
 assert.equal((await req(`/guilds/project?id=${privateProject.data.id}`,{token:f.credentials.alice.token})).status,200);
 assert.equal((await req(`/guilds/project?id=${id}`)).status,200);
 const outsider=await req('/guilds',{token:f.credentials.bob.token});
 assert.equal(outsider.data.projects.length,1);
 assert.doesNotMatch(JSON.stringify(outsider.data),/A private plan/);
 assert.equal((await req('/guilds/participation',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:privateProject.data.id,action:'join'}})).status,404);
 // Explicit participation, a scoped pledge and an unverified submission.
 assert.equal((await req('/guilds/participation',{token:f.credentials.bob.token,input:{agent_id:alice.id,project_id:id,action:'join'}})).status,404);
 assert.equal((await req('/guilds/participation',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,action:'join'}})).status,200);
 assert.equal((await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'missing',action:'pledge',commitment:'Wrong workstream.'}})).status,404);
 assert.equal((await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'walk',action:'submit',evidence:'Not pledged.'}})).status,409);
 const pledged=await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'walk',action:'pledge',commitment:'I will walk one route.'}});
 assert.equal(pledged.status,200);
 assert.equal(pledged.data.contributions[0].outcome.completed,false);
 assert.equal(pledged.data.shared_status.totals.commitments,1);
 assert.equal(pledged.data.shared_status.totals.verified_contributions,0);
 const submitted=await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'walk',action:'submit',evidence:'A recorded route with its limits.',sources:[{url:'https://example.org/route',location:'Section 1'}]}});
 assert.equal(submitted.status,200);
 const contributionId=submitted.data.contributions[0].id;
 assert.equal(submitted.data.contributions[0].status,'submitted');
 assert.equal(submitted.data.contributions[0].outcome.completed,false);
 assert.equal(submitted.data.contributions[0].outcome.verified,false);
 assert.equal(submitted.data.shared_status.all_workstreams_verified,false);
 // Independent verification: the contributor's own operator and the project creator are refused.
 assert.equal((await req('/guilds/verify',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,contribution_id:contributionId,action:'approve',reason:'Self verification.'}})).status,403);
 assert.equal((await req('/guilds/verify',{token:f.credentials.alice.token,input:{agent_id:alice.id,project_id:id,contribution_id:contributionId,action:'approve',reason:'Creator verification.'}})).status,403);
 const verified=await req('/guilds/verify',{token:f.credentials.reviewer.token,input:{agent_id:reviewer.id,project_id:id,contribution_id:contributionId,action:'approve',reason:'Checked the recorded route independently.'}});
 assert.equal(verified.status,200);
 assert.equal(verified.data.contributions[0].status,'verified');
 assert.equal(verified.data.contributions[0].outcome.completed,true);
 assert.equal(verified.data.shared_status.totals.verified_contributions,1);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0,'the guild board never mints a NemoCoin');
 // Pausing and leaving through the API.
 assert.equal((await req('/guilds/participation',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,action:'pause'}})).data.state,'paused');
 assert.equal((await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'walk',action:'pledge',commitment:'While paused.'}})).status,403);
 assert.equal((await req('/guilds/participation',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,action:'resume'}})).data.state,'active');
 assert.equal((await req('/guilds/participation',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,action:'leave'}})).data.left,true);
 const afterLeave=await req(`/guilds/project?id=${id}`,{token:f.credentials.alice.token});
 assert.equal(afterLeave.data.contributions[0].participant.state,'left');
 assert.equal(afterLeave.data.shared_status.totals.verified_contributions,1);
 // Management: an unrelated member and a runtime are refused; the creator may share and close.
 assert.equal((await req('/guilds/manage',{token:f.credentials.bob.token,input:{id,action:'close',reason:'Not mine.'}})).status,403);
 assert.equal((await req('/guilds/manage',{token:runtime.token,input:{id,action:'close',reason:'A runtime is not an operator.'}})).status,403);
 assert.equal((await req('/guilds/manage',{token:f.credentials.alice.token,input:{id:privateProject.data.id,action:'share',reason:'Ready for neighbors.'}})).data.shared,true);
 assert.equal((await req(`/guilds/project?id=${privateProject.data.id}`,{token:f.credentials.bob.token})).status,200);
 assert.equal((await req('/guilds/manage',{token:f.credentials.alice.token,input:{id,action:'close',reason:'The plan is done.'}})).data.status,'closed');
 assert.equal((await req('/guilds/participation',{token:f.credentials.reviewer.token,input:{agent_id:reviewer.id,project_id:id,action:'join'}})).status,409);
 assert.equal((await req('/guilds/manage',{token:f.credentials.alice.token,input:{id,action:'archive',reason:'Archived for the record.'}})).data.status,'archived');
 assert.equal((await req(`/guilds/project?id=${id}`)).status,404);
 const openBoard=(await req('/guilds')).data;
 assert.equal(openBoard.projects.some(item=>item.id===id),false,'an archived project is not listed');
 assert.equal(openBoard.projects.some(item=>item.id===privateProject.data.id),true,'the shared project stays listed');
});

test('the interface renders the guild project board from the published payload without innerHTML',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),bob=f.agent('bob');
 const req=await serve(t,f);
 const board=await req('/guilds');
 assert.equal(board.data.guilds.length,8);
 assert.equal(board.data.guilds.every(guild=>guild.guild_id&&guild.guild_name&&guild.purpose&&guild.charter),true);
 const project=await req('/guilds/projects',{token:f.credentials.alice.token,input:{agent_id:alice.id,...spec}});
 await req('/guilds/participation',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:project.data.id,action:'join'}});
 await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:project.data.id,workstream_id:'walk',action:'pledge',commitment:'An intention, not an outcome.'}});
 const read=await req(`/guilds/project?id=${project.data.id}`,{token:f.credentials.bob.token});
 const entry=read.data.contributions[0];
 // The payload itself distinguishes an intention from a completed outcome by name.
 assert.equal(entry.status,'pledged');
 assert.equal(entry.outcome.code,'pledge');
 assert.equal(entry.outcome.completed,false);
 assert.match(entry.outcome.label,/intention/i);
 assert.match(read.data.shared_status.note,/neither is a completed outcome/);
 assert.match(read.data.shared_status.note,/peer verification/i);
 assert.equal(read.data.policy.grants_land,false);
 assert.equal(read.data.policy.grants_reviewer,false);
 assert.equal(read.data.plan[0].id,'walk');
 // The renderer reads those payload fields by name and creates nodes instead of injecting markup.
 const source=readFileSync(fileURLToPath(new URL('../app.js',import.meta.url)),'utf8');
 const nav=readFileSync(fileURLToPath(new URL('../index.html',import.meta.url)),'utf8');
 for(const field of ['renderGuildProjects','loadGuildProjects','guildProjectCard','guildPlanList','guildContributionList','guildParticipationControls','guildProjectForm','guildOutcomeTag'])assert.match(source,new RegExp(`function ${field}\\(|async function ${field}\\(`));
 for(const field of ['shared_status','outcome','participation','guild_name','visibility','workstream'])assert.match(source,new RegExp(field));
 assert.match(source,/guilds','Guild projects'/);
 assert.doesNotMatch(source,/innerHTML/);
 assert.doesNotMatch(source,/\$\([^)]*\)\.html\s*=/);
 assert.match(nav,/id="view"/);
});

test('a guild contribution is reworked after changes are requested, and only an unsubmitted pledge can be withdrawn',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),bob=f.agent('bob'),reviewer=f.agent('reviewer');
 const req=await serve(t,f);
 const plan=[
  {id:'walk',title:'Walk one accessible route',output_name:'A traced route',scope:'Walk one accessible route and record the tiles actually passable'},
  {id:'map',title:'Note one obstacle',output_name:'An obstacle record with a detour',scope:'Record one blocked passage and the detour around it'},
 ];
 const project=await req('/guilds/projects',{token:f.credentials.alice.token,input:{agent_id:alice.id,guild_id:'cultivator',title:'A two-workstream growing plan',summary:'One bounded piece of cooperative work with two workstreams.',visibility:'public',plan}});
 assert.equal(project.status,201);
 const id=project.data.id,organiser=project.data.participants.find(person=>person.id===alice.id);
 assert.equal(organiser.role,'organiser');
 assert.equal(project.data.shared_status.totals.planned_workstreams,2);
 assert.equal(project.data.shared_status.verified_workstreams,0);
 assert.equal(project.data.shared_status.all_workstreams_verified,false);

 assert.equal((await req('/guilds/participation',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,action:'join'}})).status,200);
 assert.equal((await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'walk',action:'pledge',commitment:'I will walk one route and note what blocks it.'}})).status,200);
 const submitted=await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'walk',action:'submit',evidence:'A route recorded on the server, with its blocked tiles.',sources:[{url:'https://example.org/route',location:'Section 1'}]}});
 assert.equal(submitted.status,200);
 const contribution=submitted.data.contributions[0].id;

 // A request for changes: the claim is neither completed nor verified, the note is stored with it, and
 // the plan must not count it as an outcome.
 const reworked=await req('/guilds/verify',{token:f.credentials.reviewer.token,input:{agent_id:reviewer.id,project_id:id,contribution_id:contribution,action:'changes_requested',reason:'The route needs the detour and the tile numbers it stopped at.'}});
 assert.equal(reworked.status,200);
 const entry=reworked.data.contributions[0];
 assert.equal(entry.status,'changes_requested');
 assert.equal(entry.outcome.code,'changes_requested');
 assert.equal(entry.outcome.completed,false);
 assert.equal(entry.outcome.verified,false);
 assert.match(entry.review_note,/detour/);
 assert.equal(entry.verified_by,null);
 assert.equal(entry.verified_at,null);
 assert.equal(reworked.data.shared_status.totals.claims,1);
 assert.equal(reworked.data.shared_status.totals.verified_contributions,0);
 assert.equal(reworked.data.shared_status.workstreams.find(workstream=>workstream.id==='walk').claimed,1);
 assert.equal(reworked.data.shared_status.workstreams.find(workstream=>workstream.id==='walk').verified,0);
 const stored=f.platform.get('SELECT status,review_note,verified_by_account_id,verified_at FROM guild_contributions WHERE id=?',contribution);
 assert.equal(stored.status,'changes_requested');
 assert.match(stored.review_note,/detour/);
 assert.equal(stored.verified_by_account_id,null);
 assert.equal(stored.verified_at,null);
 // A claim that is not awaiting verification cannot be verified again.
 assert.equal((await req('/guilds/verify',{token:f.credentials.reviewer.token,input:{agent_id:reviewer.id,project_id:id,contribution_id:contribution,action:'approve',reason:'Approving a claim that is not waiting.'}})).status,409);
 assert.equal(f.platform.get('SELECT verified_by_account_id FROM guild_contributions WHERE id=?',contribution).verified_by_account_id,null);

 // The rework: re-submitting is allowed from changes_requested and clears the old note.
 const resubmitted=await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'walk',action:'submit',evidence:'The same route with the detour around the blocked passage.',sources:[{url:'https://example.org/route',location:'Section 2'}]}});
 assert.equal(resubmitted.status,200);
 assert.equal(resubmitted.data.contributions[0].status,'submitted');
 assert.equal(resubmitted.data.contributions[0].outcome.completed,false);
 assert.equal(resubmitted.data.contributions[0].review_note,'');
 assert.match(resubmitted.data.contributions[0].evidence,/detour/);

 // Only then does an independent approval read as a completed outcome, and the second workstream keeps
 // the plan unfinished.
 const verified=await req('/guilds/verify',{token:f.credentials.reviewer.token,input:{agent_id:reviewer.id,project_id:id,contribution_id:contribution,action:'approve',reason:'Checked the recorded detour and the tiles independently.'}});
 assert.equal(verified.status,200);
 assert.equal(verified.data.contributions[0].status,'verified');
 assert.equal(verified.data.contributions[0].outcome.completed,true);
 assert.equal(verified.data.contributions[0].verified_by,reviewer.name);
 assert.equal(verified.data.shared_status.totals.verified_contributions,1);
 assert.equal(verified.data.shared_status.totals.claims,0);
 assert.equal(verified.data.shared_status.verified_workstreams,1);
 assert.equal(verified.data.shared_status.all_workstreams_verified,false);
 // A verified contribution cannot be re-pledged, re-submitted or withdrawn.
 for(const action of ['pledge','submit']) assert.equal((await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'walk',action,commitment:'A fresh intention.',evidence:'A fresh claim.'}})).status,409,`${action} after verification must be refused`);
 assert.equal((await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'walk',action:'withdraw'}})).status,409);

 // A pledge is the only thing a participant may withdraw, and withdrawing stops the plan counting it.
 const pledged=await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'map',action:'pledge',commitment:'I will note one obstacle.'}});
 assert.equal(pledged.data.shared_status.totals.commitments,1);
 const withdrawn=await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'map',action:'withdraw'}});
 assert.equal(withdrawn.status,200);
 assert.equal(withdrawn.data.contributions.length,1,'the withdrawn pledge is gone from the plan');
 assert.equal(withdrawn.data.shared_status.totals.commitments,0);
 assert.equal(withdrawn.data.contributions[0].status,'verified','the verified record stays as attributed history');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_contributions WHERE agent_id=?',bob.id).n,1);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships WHERE account_id=?',f.actor('bob').account.id).n,0);
 assert.equal(verifyGuildRecords(f.platform.db),true);
});

test('a guild project closes and reopens for contributions, shares once, archives, and bounds its plan',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),bob=f.agent('bob'),outsider=f.agent('reviewer');
 const req=await serve(t,f);
 const workstream=(id,changes={})=>({id,title:`Planned work: ${id}`,output_name:`A saved ${id} result`,scope:`Do the bounded work named ${id}`,...changes});
 const create=(plan,changes={})=>req('/guilds/projects',{token:f.credentials.alice.token,input:{agent_id:alice.id,guild_id:'cultivator',title:'A bounded cooperative plan',summary:'One bounded piece of cooperative work for the HTTP fixture.',visibility:'public',plan,...changes}});

 // The plan bounds are refused before anything is stored, and no half-made project is left behind.
 assert.equal((await create([])).status,400);
 assert.equal((await create(Array.from({length:7},(_,index)=>workstream(`work-${index}`)))).status,400);
 assert.match((await create([])).data.error,/one to 6 planned workstreams/);
 assert.equal((await create([workstream('walk'),workstream('walk')])).status,400);
 assert.match((await create([workstream('walk'),workstream('walk')])).data.error,/own id/);
 assert.equal((await create([workstream('walk',{output_name:''})])).status,400);
 assert.equal((await create([workstream('walk',{id:'Not A Slug'})])).status,400);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_projects').n,0,'a refused plan must store nothing');
 assert.equal((await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:'missing',workstream_id:'walk',action:'pledge',commitment:'Nothing to pledge to.'}})).status,404);

 const project=await create([workstream('walk'),workstream('map')],{visibility:'private'});
 assert.equal(project.status,201);
 const id=project.data.id;
 assert.equal(project.data.visibility,'private');
 assert.equal((await req(`/guilds/project?id=${id}`,{token:f.credentials.bob.token})).status,404);
 // Sharing is the one-way private to public action, and repeating it is not a second change.
 const shared=await req('/guilds/manage',{token:f.credentials.alice.token,input:{id,action:'share',reason:'Ready for neighbors.'}});
 assert.equal(shared.status,200);
 assert.equal(shared.data.shared,true);
 assert.equal(shared.data.visibility,'public');
 const reshared=await req('/guilds/manage',{token:f.credentials.alice.token,input:{id,action:'share',reason:'Shared a second time by mistake.'}});
 assert.equal(reshared.status,200);
 assert.equal(reshared.data.shared,false);
 assert.equal(f.platform.get('SELECT visibility FROM guild_projects WHERE id=?',id).visibility,'public');
 assert.equal((await req(`/guilds/project?id=${id}`,{token:f.credentials.bob.token})).status,200);

 assert.equal((await req('/guilds/participation',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,action:'join'}})).status,200);
 assert.equal((await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'walk',action:'pledge',commitment:'I will walk one route.'}})).status,200);

 // Closing stops new participation and new claims, and still lets a participant withdraw a pledge.
 const closed=await req('/guilds/manage',{token:f.credentials.alice.token,input:{id,action:'close',reason:'The plan is being revised.'}});
 assert.equal(closed.status,200);
 assert.equal(closed.data.status,'closed');
 const joinClosed=await req('/guilds/participation',{token:f.credentials.reviewer.token,input:{agent_id:outsider.id,project_id:id,action:'join'}});
 assert.equal(joinClosed.status,409);
 assert.match(joinClosed.data.error,/not open to new participants/);
 const pledgeClosed=await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'map',action:'pledge',commitment:'A pledge while the plan is closed.'}});
 assert.equal(pledgeClosed.status,409);
 assert.match(pledgeClosed.data.error,/not open for new contributions/);
 const withdrewClosed=await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'walk',action:'withdraw'}});
 assert.equal(withdrewClosed.status,200,'withdrawing a standing pledge stays possible while the plan is closed');
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_contributions WHERE project_id=?',id).n,0);

 // Reopening returns the plan to its open state, and the same resident may pledge again.
 const reopened=await req('/guilds/manage',{token:f.credentials.alice.token,input:{id,action:'reopen',reason:'The revision is done.'}});
 assert.equal(reopened.status,200);
 assert.equal(reopened.data.status,'open');
 assert.equal((await req('/guilds/contributions',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,workstream_id:'walk',action:'pledge',commitment:'The route, one more time.'}})).status,200);

 // Archiving ends it: unreadable, unlisted and unjoinable, while the record itself is retained.
 const archived=await req('/guilds/manage',{token:f.credentials.alice.token,input:{id,action:'archive',reason:'Closed for the record.'}});
 assert.equal(archived.status,200);
 assert.equal(archived.data.status,'archived');
 assert.equal((await req(`/guilds/project?id=${id}`)).status,404);
 assert.equal((await req(`/guilds/project?id=${id}`,{token:f.credentials.bob.token})).status,404);
 assert.equal((await req('/guilds/participation',{token:f.credentials.bob.token,input:{agent_id:bob.id,project_id:id,action:'join'}})).status,404);
 assert.equal((await req('/guilds')).data.projects.some(item=>item.id===id),false);
 assert.equal(f.platform.get('SELECT status FROM guild_projects WHERE id=?',id).status,'archived');
 // The archive keeps the record: the organiser and the joining resident are still participants, and
 // the refused third join wrote nothing.
 assert.deepEqual(f.platform.all('SELECT agent_id FROM guild_participants WHERE project_id=? ORDER BY agent_id',id).map(row=>row.agent_id).sort(),[alice.id,bob.id].sort());
 assert.equal(verifyGuildRecords(f.platform.db),true);
});

test('a runtime resident participates in a guild project with the contribute scope and nothing more',async t=>{
 const f=await fixture(t),alice=f.agent('alice'),bob=f.agent('bob'),reviewer=f.agent('reviewer');
 const req=await serve(t,f);
 const plan=[{id:'walk',title:'Walk one accessible route',output_name:'A traced route',scope:'Walk and record one accessible route'}];
 const project=await req('/guilds/projects',{token:f.credentials.alice.token,input:{agent_id:alice.id,guild_id:'explorer',title:'A plan a runtime can join',summary:'One bounded piece of cooperative work.',visibility:'public',plan}});
 assert.equal(project.status,201);
 const id=project.data.id;

 // A read-only runtime cannot join; a contribute runtime joins, pledges and submits for its own resident.
 const readOnly=f.tx('runtime',f.actor('bob'),bob.id,{scopes:['read'],max_calls:10});
 const blocked=await req('/guilds/participation',{token:readOnly.token,input:{agent_id:bob.id,project_id:id,action:'join'}});
 assert.equal(blocked.status,403);
 assert.match(blocked.data.error,/does not permit/);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM guild_participants WHERE project_id=?',id).n,1,'a refused runtime join must write no participant row');
 const contributor=f.tx('runtime',f.actor('bob'),bob.id,{scopes:['read','contribute'],max_calls:20});
 const joined=await req('/guilds/participation',{token:contributor.token,input:{project_id:id,action:'join'}});
 assert.equal(joined.status,200);
 assert.equal(joined.data.joined,true);
 assert.equal(joined.data.role,'member');
 assert.equal(joined.data.state,'active');
 const pledged=await req('/guilds/contributions',{token:contributor.token,input:{project_id:id,workstream_id:'walk',action:'pledge',commitment:'The runtime will walk one route.'}});
 assert.equal(pledged.status,200);
 assert.equal(pledged.data.contributions[0].agent_id,bob.id);
 const submitted=await req('/guilds/contributions',{token:contributor.token,input:{project_id:id,workstream_id:'walk',action:'submit',evidence:'A route recorded by the resident runtime.'}});
 assert.equal(submitted.status,200);
 const contribution=submitted.data.contributions[0].id;
 // A runtime can verify nothing for its own operator, and the contributing runtime cannot verify at all.
 const selfVerify=await req('/guilds/verify',{token:contributor.token,input:{project_id:id,contribution_id:contribution,action:'approve',reason:'A runtime approving its own resident.'}});
 assert.equal(selfVerify.status,403);
 assert.match(selfVerify.data.error,/different operator/);
 const peer=f.tx('runtime',f.actor('reviewer'),reviewer.id,{scopes:['read','contribute'],max_calls:10});
 const verified=await req('/guilds/verify',{token:peer.token,input:{agent_id:reviewer.id,project_id:id,contribution_id:contribution,action:'approve',reason:'Checked the recorded route independently.'}});
 assert.equal(verified.status,200);
 assert.equal(verified.data.contributions[0].outcome.completed,true);
 assert.equal(verified.data.shared_status.all_workstreams_verified,true);
 // The guild layer still grants nothing and mints nothing for a runtime path either.
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM calling_receipts WHERE agent_id=?',bob.id).n,0);
 assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM land_stewardships WHERE account_id=?',f.actor('bob').account.id).n,0);
 assert.equal(verifyGuildRecords(f.platform.db),true);
});

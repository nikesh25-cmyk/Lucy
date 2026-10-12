import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createApp} from '../server.js';
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

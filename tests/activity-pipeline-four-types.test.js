// The Wave 4 four-activity-type walkthrough.
//
// Four distinct activity types are driven through the shipped HTTP API of a real server that is
// pointed at a disposable database, and for each one this file asserts the same four things:
//
//   * participation is saved (an enrolment, a pledge, a participation or a leased claim)
//   * the contribution is attributed to the acting account in stored state
//   * the world effect is visible in stored state
//   * the journal or history records it
//
// On top of that each type is read back through `GET /activity`, so the pipeline's own stage for that
// instance is asserted rather than assumed. The cultivation and construction types are practice
// activities and read as `practice_activity`. The cooperative restoration is a practice activity too.
// The source-backed research activity resolves to a real retained source version and its outcome is
// reported as a proposal — never as an achievement and never as real-world impact.
//
// The one deliberate exception to "everything over HTTP" is stated where it happens: the cultivation
// step moves the platform clock forward instead of waiting out a real crop's growth time. The server
// still decides ripeness from its own clock, and every request and every assertion around it is HTTP.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createApp} from '../server.js';
import {fixture} from './helpers.js';
import {verifyActivityStructure} from '../src/activity-pipeline.js';

const catalog=JSON.parse(readFileSync(new URL('../catalog/agriculture-statistics.json',import.meta.url),'utf8'));
const series=catalog.countries.find(country=>country.country_code==='AF').series.find(entry=>entry.indicator==='NV.AGR.TOTL.ZS');
// Mirrors the collision legend the renderer uses: water, trees, buildings, fountains and walls are not
// walkable; paths and bridges are.
const UNWALKABLE=new Set(['water','tree','building','fountain','wall']);
const MOVE_INTERVAL_MS=140;
const FRONTIER_ACTION_INTERVAL_MS=260;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const walkableTile=(grid,x,y)=>typeof grid[y]?.[x]==='string'&&!UNWALKABLE.has(grid[y][x]);

async function serve(t,f){
 const {server}=createApp({platform:f.platform,backupDir:join(f.directory,'backups')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const base=`http://127.0.0.1:${server.address().port}`;
 return async(path,{token,input,method=input?'POST':'GET',key}={})=>{
  const response=await fetch(`${base}/api/v1${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(input?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},...(input?{body:JSON.stringify(input)}:{})});
  return{status:response.status,data:await response.json()};
 };
}
function windowStarts(minimum,maximum,size,limit){
 const starts=[];
 for(let value=Math.max(0,minimum-3);value<Math.min(maximum+3,limit);value+=size)starts.push(Math.max(0,Math.min(limit-size,value)));
 const last=Math.max(0,Math.min(limit-size,maximum));
 if(!starts.includes(last))starts.push(last);
 return [...new Set(starts)].sort((a,b)=>a-b);
}
// The world view publishes 20 x 14 terrain windows placed by their camera origin, so a walk is planned
// over the server's own terrain rather than a remembered map.
async function readTerrain(api,worldId,area,token){
 const descriptor=(await api(`/world?world_id=${encodeURIComponent(worldId)}`,{token})).data;
 const width=descriptor.bounds.columns,height=descriptor.bounds.rows;
 const rows=descriptor.terrain.length,columns=descriptor.terrain[0].length;
 const areaX={minimum:area?.minimumX??0,maximum:area?.maximumX??width-1};
 const areaY={minimum:area?.minimumY??0,maximum:area?.maximumY??height-1};
 const grid=Array.from({length:height},()=>new Array(width).fill(undefined));
 const solid=new Set();
 for(const item of descriptor.scenery||[])if(Number.isInteger(item?.x)&&Number.isInteger(item?.y)&&item.blocks===true)solid.add(`${item.x},${item.y}`);
 for(const x of windowStarts(areaX.minimum,areaX.maximum,columns,width)){
  for(const y of windowStarts(areaY.minimum,areaY.maximum,rows,height)){
   const page=(await api(`/world?world_id=${encodeURIComponent(worldId)}&x=${x}&y=${y}`,{token})).data;
   for(let row=0;row<page.terrain.length;row++)for(let column=0;column<page.terrain[row].length;column++)grid[page.camera.y+row][page.camera.x+column]=page.terrain[row][column];
  }
 }
 return{descriptor,grid,solid,width,height};
}
function pathTo(grid,origin,target,blocked){
 const key=(x,y)=>`${x},${y}`;
 if(!walkableTile(grid,origin.x,origin.y))return null;
 const cameFrom=new Map([[key(origin.x,origin.y),null]]);
 const queue=[origin];
 for(let index=0;index<queue.length;index++){
  const current=queue[index];
  if(current.x===target.x&&current.y===target.y)break;
  for(const [dx,dy] of [[0,-1],[0,1],[-1,0],[1,0]]){
   const x=current.x+dx,y=current.y+dy,next=key(x,y);
   if(cameFrom.has(next)||blocked.has(next)||!walkableTile(grid,x,y))continue;
   cameFrom.set(next,current);
   queue.push({x,y});
  }
 }
 if(!cameFrom.has(key(target.x,target.y)))return null;
 const path=[];
 for(let node=target;node;node=cameFrom.get(key(node.x,node.y)))path.unshift(node);
 return path.slice(1);
}
// The fixture clock is the server's clock, so a walk advances it instead of waiting in wall-clock
// time: the move throttle, the frontier action interval and the restoration placement interval are all
// measured against the server's own clock, and the server still decides every one of them.
async function walkTo(f,api,token,agentId,from,target,grid,blocked){
 const path=pathTo(grid,from,target,blocked);
 assert.ok(path,`a walkable route from ${from.x},${from.y} to ${target.x},${target.y} must exist`);
 let current={...from};
 for(const next of path){
  f.advance(MOVE_INTERVAL_MS);
  const direction=next.x>current.x?'right':next.x<current.x?'left':next.y>current.y?'down':'up';
  const moved=await api('/move',{token,input:{agent_id:agentId,direction}});
  assert.equal(moved.status,200,`POST /move ${direction} from ${current.x},${current.y}: ${JSON.stringify(moved.data)}`);
  assert.equal(moved.data.blocked,false,`the tile ${next.x},${next.y} is on the planned walkable route`);
  current={x:moved.data.x,y:moved.data.y};
 }
 return current;
}
// Every world effect and journal row is read from the fixture's own disposable database, which is the
// same file the server is serving.
const row=(f,sql,...args)=>f.platform.get(sql,...args);
const rows=(f,sql,...args)=>f.platform.all(sql,...args);

test('four activity types travel the whole pipeline: cultivation, construction, cooperative restoration and source-backed research',async t=>{
 const f=await fixture(t),api=await serve(t,f);
 const admin=f.credentials.admin.token,alice=f.credentials.alice.token,bob=f.credentials.bob.token,reviewer=f.credentials.reviewer.token;
 const aliceId=f.actor('alice').account.id,bobId=f.actor('bob').account.id;
 const transcript=[];
 const activity=async(token,agentId)=>{
  const response=await api(`/activity?agent_id=${agentId}`,{token});
  assert.equal(response.status,200,JSON.stringify(response.data));
  return response.data;
 };
 const createResident=async(token,name,calling)=>{
  const created=await api('/agents',{token,input:{kind:'agent',name,color:'#397f79',symbol:'✦',capabilities:'Walks authored routes and records saved facts',limitations:'No external tools and no real-world claims'}});
  assert.equal(created.status,201,JSON.stringify(created.data));
  const selected=await api('/callings/select',{token,input:{agent_id:created.data.id,calling_id:calling}});
  assert.equal(selected.status,200,JSON.stringify(selected.data));
  return created.data.id;
 };

 // ---- 1. Cultivation -------------------------------------------------------------------------
 // The calling is chosen so its own two objectives do not compete for the same saved facts: the
 // calling objectives are reconciled before the enrolled quest steps, and both share one ten-a-day
 // budget, so a cultivator would spend the day's credit on the calling instead of the chain.
 const keeper=await createResident(alice,'Herb keeper','mediator');
 const joined=await api('/quests/join',{token:alice,key:'four-cultivation-join',input:{agent_id:keeper,chain_id:'quiet-harvest'}});
 assert.equal(joined.status,201);
 const home=`home:${keeper}`;
 f.advance(MOVE_INTERVAL_MS);
 assert.equal((await api(`/agents/${keeper}/travel`,{token:alice,input:{world_id:home}})).status,200);
 const garden=(await api(`/world?world_id=${encodeURIComponent(home)}&agent_id=${keeper}`,{token:alice})).data;
 const arrival=garden.participants.find(entry=>entry.id===keeper);
 const site=[];
 for(let index=0;index<garden.terrain.length;index++){
  for(let column=0;column<garden.terrain[index].length;column++){
   const x=garden.camera.x+column,y=garden.camera.y+index;
   if(!walkableTile(garden.terrain,column,index))continue;
   if(Math.abs(arrival.x-x)+Math.abs(arrival.y-y)<=1)continue;
   if((garden.portals||[]).some(portal=>Math.abs(portal.x-x)+Math.abs(portal.y-y)<=1))continue;
   if((garden.objects||[]).some(object=>object.x===x&&object.y===y))continue;
   site.push({x,y,distance:Math.abs(arrival.x-x)+Math.abs(arrival.y-y)});
  }
 }
 site.sort((left,right)=>left.distance-right.distance||left.y-right.y||left.x-right.x);
 const patch=site[0];
 assert.ok(patch,'the resident’s own garden must offer a free buildable tile');
 const built=(await api(`/agents/${keeper}/build`,{token:alice,input:{type:'farm',x:patch.x,y:patch.y}})).data;
 assert.equal(built.removed,false);
 const planted=await api('/journey/garden',{token:alice,input:{agent_id:keeper,action:'plant',kind:'herbs',x:patch.x,y:patch.y}});
 assert.equal(planted.status,200,JSON.stringify(planted.data));
 // The one clock exception, stated: a real herb takes twenty minutes of wall clock to ripen, so the
 // platform clock moves forward instead. The server still decides readiness from its own clock.
 f.advance(25*60000);
 const harvested=await api('/journey/garden',{token:alice,input:{agent_id:keeper,action:'harvest',x:patch.x,y:patch.y}});
 assert.equal(harvested.status,200,JSON.stringify(harvested.data));
 assert.equal(harvested.data.crop.harvested_at===null,false);
 const board=(await api(`/quests?agent_id=${keeper}`,{token:alice})).data;
 assert.equal(board.chains.find(chain=>chain.slug==='quiet-harvest').steps[0].state,'complete');
 // participation is saved
 assert.ok(row(f,'SELECT id FROM quest_enrollments WHERE agent_id=? AND account_id=?',keeper,aliceId),'cultivation participation is a stored enrolment');
 // the contribution is attributed to the acting account
 const cultivationReceipts=rows(f,"SELECT * FROM calling_receipts WHERE agent_id=? AND objective_id LIKE 'quest:quiet-harvest.%'",keeper);
 assert.equal(cultivationReceipts.length,2);
 assert.ok(cultivationReceipts.every(receipt=>receipt.account_id===aliceId),'each credited fact is attributed to the acting operator');
 assert.equal(cultivationReceipts.reduce((total,receipt)=>total+receipt.points,0),10);
 // the world effect is visible in stored state
 const crop=row(f,'SELECT * FROM journey_crops WHERE agent_id=? AND x=? AND y=?',keeper,patch.x,patch.y);
 assert.equal(crop.harvested_at===null,false,'the harvested crop row is stored');
 assert.equal(row(f,'SELECT quantity FROM journey_inventory WHERE agent_id=? AND kind=?',keeper,'herbs').quantity,2,'the gathering is on the shelf');
 // the journal records it
 const cultivationJournal=rows(f,"SELECT event FROM audit WHERE actor=? AND event IN ('journey.plant','journey.harvest') ORDER BY seq",aliceId);
 assert.deepEqual(cultivationJournal.map(entry=>entry.event),['journey.plant','journey.harvest']);
 assert.equal(row(f,'SELECT COUNT(*) AS n FROM coin_rewards').n,0,'a practice cultivation activity mints no coin');
 const cultivation=activity(alice,keeper);
 const cultivationInstance=(await cultivation).instances.find(entry=>entry.instance_id==='quest:quiet-harvest');
 assert.equal(cultivationInstance.kind,'cultivation');
 assert.equal(cultivationInstance.stage,'journal');
 assert.equal(cultivationInstance.blocked_by,null);
 assert.equal(cultivationInstance.reading.code,'practice_activity');
 assert.equal(cultivationInstance.reading.real_world_impact,false);
 assert.ok(cultivationInstance.stages.find(entry=>entry.id==='world_effect').evidence.some(effect=>effect.code==='harvested_crop'));
 assert.ok(cultivationInstance.stages.find(entry=>entry.id==='journal').evidence.some(entry=>entry.event==='journey.harvest'));
 transcript.push(`cultivation  ${keeper.slice(0,8)}… planted and gathered ${patch.x},${patch.y} in ${home}; two saved facts, both attributed to the acting operator; stage ${cultivationInstance.stage} reading ${cultivationInstance.reading.code}`);

 // ---- 2. Construction ------------------------------------------------------------------------
 // The calling matters for the daily credit budget: the calling's own objectives are reconciled before
 // the enrolled quest steps and share one ten-a-day allowance, so a calling whose objectives answer a
 // fact this chain also uses (or the free `shared_visit` a travel records) would spend the budget first.
 const groundbreaker=await createResident(bob,'Groundbreaker','host');
 // The operator stewards one finite plot, and only that plot can be built in.
 const registry=(await api('/land?limit=25')).data;
 const parcels=(await api('/world?world_id=frontier:0:0')).data.frontier.parcels;
 const buildRange=(await api('/world?world_id=frontier:0:0')).data.frontier.limits.build_range;
 const available=parcels.filter(parcel=>parcel.state==='available'&&!parcel.permanent_reserved);
 assert.ok(available.length>0,'the finite registry must offer an unassigned plot');
 assert.equal(registry.policy.stewardships_per_operator,1);
 const assignTarget=available[Math.min(available.length-1,Math.floor(available.length/2))];
 const assigned=await api('/land/assign',{token:bob,input:{plot_id:assignTarget.id,purpose:'A walked path for the pipeline walkthrough',description:'Stewarded by the construction resident’s operator.'}});
 assert.equal(assigned.status,200,JSON.stringify(assigned.data));
 assert.equal(assigned.data.plot.is_mine,true);
 assert.equal((await api('/quests/join',{token:bob,key:'four-construction-join',input:{agent_id:groundbreaker,chain_id:'shared-frontier-path'}})).status,201);
 // Walk the Commons to the frontier gateway, then enter the frontier.
 const commonsView=(await api('/world?world_id=commons')).data;
 const gateway=commonsView.portals.find(portal=>portal.target_world_id==='frontier:0:0');
 assert.ok(gateway,'the Commons publishes its frontier gateway');
 const me=(await api(`/world?world_id=commons&agent_id=${groundbreaker}`,{token:bob})).data.participants.find(entry=>entry.id===groundbreaker);
 const commons=await readTerrain(api,'commons',{minimumX:Math.min(me.x,gateway.x)-4,maximumX:38,minimumY:0,maximumY:20},bob);
 const commonsBlocked=new Set(commons.solid);
 const doorSteps=[[0,0],[0,-1],[0,1],[-1,0],[1,0]].map(([dx,dy])=>({x:gateway.x+dx,y:gateway.y+dy}));
 const door=doorSteps.find(tile=>pathTo(commons.grid,{x:me.x,y:me.y},tile,commonsBlocked));
 assert.ok(door,'a walkable tile beside the gateway must be reachable');
 await walkTo(f,api,bob,groundbreaker,{x:me.x,y:me.y},door,commons.grid,commonsBlocked);
 f.advance(MOVE_INTERVAL_MS);
 const travelled=await api(`/agents/${groundbreaker}/travel`,{token:bob,input:{world_id:'frontier:0:0'}});
 assert.equal(travelled.status,200,JSON.stringify(travelled.data));
 assert.equal(travelled.data.entered,true);
 const frontier=await readTerrain(api,'frontier:0:0',{minimumX:0,maximumX:47,minimumY:0,maximumY:47},bob);
 const gates=new Set(frontier.descriptor.frontier.neighbors.map(neighbour=>`${neighbour.x},${neighbour.y}`));
 const standDistances=(()=>{
  const key=(x,y)=>`${x},${y}`;
  const distances=new Map([[key(travelled.data.x,travelled.data.y),0]]);
  const queue=[{x:travelled.data.x,y:travelled.data.y}];
  for(let index=0;index<queue.length;index++){
   const current=queue[index];
   for(const [dx,dy] of [[0,-1],[0,1],[-1,0],[1,0]]){
    const x=current.x+dx,y=current.y+dy,next=key(x,y);
    if(distances.has(next)||gates.has(next)||!walkableTile(frontier.grid,x,y))continue;
    distances.set(next,distances.get(key(current.x,current.y))+1);
    queue.push({x,y});
   }
  }
  return distances;
 })();
 const buildable=[];
 for(const parcel of parcels){
  if(parcel.id!==assignTarget.id)continue;
  for(let y=parcel.y;y<parcel.y+parcel.height;y++)for(let x=parcel.x;x<parcel.x+parcel.width;x++){
   if(!walkableTile(frontier.grid,x,y))continue;
   let stand=null;
   for(let dy=-buildRange;dy<=buildRange;dy++)for(let dx=-buildRange;dx<=buildRange;dx++){
    const reach=Math.abs(dx)+Math.abs(dy);
    if(reach===0||reach>buildRange)continue;
    const distance=standDistances.get(`${x+dx},${y+dy}`);
    if(distance===undefined)continue;
    if(!stand||distance<stand.distance)stand={x:x+dx,y:y+dy,distance};
   }
   if(stand)buildable.push({tile:{x,y},stand,distance:stand.distance});
  }
 }
 buildable.sort((left,right)=>left.distance-right.distance||left.tile.y-right.tile.y||left.tile.x-right.tile.x);
 assert.ok(buildable.length>=2,'the stewarded plot must offer at least two reachable buildable tiles');
 const [first,second]=buildable;
 await walkTo(f,api,bob,groundbreaker,{x:travelled.data.x,y:travelled.data.y},first.stand,frontier.grid,gates);
 f.advance(FRONTIER_ACTION_INTERVAL_MS);
 const pathBlock=await api('/frontier/build',{token:bob,input:{agent_id:groundbreaker,world_id:'frontier:0:0',x:first.tile.x,y:first.tile.y,z:0,type:'path'}});
 assert.equal(pathBlock.status,200,JSON.stringify(pathBlock.data));
 assert.equal(pathBlock.data.plot_id,assignTarget.id);
 await walkTo(f,api,bob,groundbreaker,first.stand,second.stand,frontier.grid,gates);
 f.advance(FRONTIER_ACTION_INTERVAL_MS);
 const raised=await api('/frontier/build',{token:bob,input:{agent_id:groundbreaker,world_id:'frontier:0:0',x:second.tile.x,y:second.tile.y,z:0,type:'wood'}});
 assert.equal(raised.status,200,JSON.stringify(raised.data));
 assert.equal(raised.data.plot_id,assignTarget.id);
 // participation is saved
 assert.ok(row(f,'SELECT id FROM quest_enrollments WHERE agent_id=? AND account_id=?',groundbreaker,bobId));
 // the contribution is attributed to the acting account
 const blocks=rows(f,'SELECT * FROM frontier_blocks WHERE creator_agent_id=?',groundbreaker);
 assert.equal(blocks.length,2);
 assert.ok(blocks.every(block=>block.creator_account_id===bobId),'each standing block is attributed to the acting operator');
 assert.ok(blocks.every(block=>block.plot_id===assignTarget.id),'each block stands inside the stewarded plot');
 const constructionReceiptsAfterRead=async()=>(await api(`/quests?agent_id=${groundbreaker}`,{token:bob})).data;
 const constructionBoard=await constructionReceiptsAfterRead();
 assert.equal(constructionBoard.chains.find(chain=>chain.slug==='shared-frontier-path').steps[0].state,'complete');
 assert.equal(constructionBoard.chains.find(chain=>chain.slug==='shared-frontier-path').steps[1].state,'complete');
 const constructionReceipts=rows(f,"SELECT * FROM calling_receipts WHERE agent_id=? AND objective_id LIKE 'quest:shared-frontier-path.%'",groundbreaker);
 assert.equal(constructionReceipts.length,2,'both saved placements are credited to their authored steps');
 assert.ok(constructionReceipts.every(receipt=>receipt.account_id===bobId));
 // the world effect is visible in stored state
 const frontierView=(await api('/world?world_id=frontier:0:0&view=voxel',{token:bob})).data;
 for(const block of blocks)assert.ok((frontierView.blocks||[]).some(entry=>entry.id===block.id),`the block ${block.id} is in the world view`);
 const plotRead=(await api(`/land/plot?plot_id=${encodeURIComponent(assignTarget.id)}`)).data;
 assert.equal(plotRead.plot.block_count,2,'the plot reports both saved blocks');
 // the journal records it
 const ledger=rows(f,"SELECT action FROM frontier_actions WHERE account_id=? AND world_id='frontier:0:0' ORDER BY created_at",bobId);
 assert.deepEqual(ledger.map(entry=>entry.action),['place','place']);
 assert.ok(row(f,"SELECT seq FROM audit WHERE actor=? AND event='frontier.place' LIMIT 1",bobId),'the append-only audit records the build');
 const construction=await activity(bob,groundbreaker);
 const constructionInstance=construction.instances.find(entry=>entry.instance_id==='quest:shared-frontier-path');
 assert.equal(constructionInstance.kind,'construction');
 assert.equal(constructionInstance.stage,'journal');
 assert.equal(constructionInstance.reading.code,'practice_activity');
 assert.ok(constructionInstance.stages.find(entry=>entry.id==='world_effect').evidence.some(effect=>effect.code==='standing_block'));
 assert.equal(row(f,'SELECT COUNT(*) AS n FROM coin_rewards').n,0,'practice construction mints no coin');
 transcript.push(`construction ${groundbreaker.slice(0,8)}… placed a path and a block in ${assignTarget.id}; two attributed blocks in stored state and two ledger rows; stage ${constructionInstance.stage} reading ${constructionInstance.reading.code}`);

 // ---- 3. Cooperative restoration -------------------------------------------------------------
 const keeper2=await createResident(alice,'Garden keeper','builder');
 const guest=await createResident(bob,'Helper keeper','builder');
 const sharedGarden=`home:${keeper2}`;
 const opened=await api(`/agents/${keeper2}/home`,{token:alice,method:'PATCH',input:{visibility:'public'}});
 assert.equal(opened.status,200,JSON.stringify(opened.data));
 const event=await api('/restoration/open',{token:alice,input:{agent_id:keeper2,hours:3}});
 assert.equal(event.status,200,JSON.stringify(event.data));
 const eventId=event.data.id;
 const slots=event.data.progress.steps.find(step=>step.id==='ground').slots.filter(slot=>!slot.filled);
 assert.ok(slots.length>=2,'the plan publishes at least two waiting planned tiles');
 const placeFor=async(token,agentId,slot)=>{
  f.advance(MOVE_INTERVAL_MS);
  assert.equal((await api(`/agents/${agentId}/travel`,{token,input:{world_id:sharedGarden}})).status,200);
  const joined=await api('/restoration/join',{token,input:{agent_id:agentId,event_id:eventId}});
  assert.equal(joined.status,200,JSON.stringify(joined.data));
  assert.equal(joined.data.joined,true);
  const terrain=await readTerrain(api,sharedGarden,null,token);
  const participant=terrain.descriptor.participants.find(entry=>entry.id===agentId);
  const beside=[{x:slot.x,y:slot.y-1},{x:slot.x-1,y:slot.y},{x:slot.x+1,y:slot.y},{x:slot.x,y:slot.y+1}].find(tile=>walkableTile(terrain.grid,tile.x,tile.y));
  assert.ok(beside,`a walkable tile beside ${slot.x},${slot.y} must exist`);
  await walkTo(f,api,token,agentId,{x:participant.x,y:participant.y},beside,terrain.grid,terrain.solid);
  f.advance(FRONTIER_ACTION_INTERVAL_MS);
  const placed=await api('/restoration/place',{token,input:{agent_id:agentId,event_id:eventId,x:slot.x,y:slot.y}});
  assert.equal(placed.status,200,JSON.stringify(placed.data));
  assert.equal(placed.data.placed.x,slot.x);
  assert.equal(placed.data.placed.type,slot.type);
  return placed.data;
 };
 const placedByConvenor=await placeFor(alice,keeper2,slots[0]);
 const placedByGuest=await placeFor(bob,guest,slots[1]);
 assert.equal(placedByConvenor.placed.type,slots[0].type);
 assert.equal(placedByGuest.placed.type,slots[1].type);
 // participation is saved
 const pledges=rows(f,'SELECT * FROM community_rsvps WHERE event_id=?',eventId);
 assert.equal(pledges.length,2,'both operators pledged to the same occurrence');
 assert.deepEqual(pledges.map(pledge=>pledge.agent_id).sort(),[keeper2,guest].sort());
 // the contribution is attributed to the acting account
 const placements=rows(f,"SELECT actor,record_id FROM audit WHERE event='restoration.placed' AND substr(record_id,1,?)=? ORDER BY seq",`${eventId}|`.length,`${eventId}|`);
 assert.equal(placements.length,2);
 assert.deepEqual(placements.map(entry=>entry.actor).sort(),[aliceId,bobId].sort(),'each placement is attributed to the account that acted');
 // the world effect is visible in stored state
 const objects=rows(f,'SELECT id,type,x,y FROM world_objects WHERE world_id=?',sharedGarden);
 for(const slot of [slots[0],slots[1]])assert.ok(objects.some(object=>object.x===slot.x&&object.y===slot.y&&object.type===slot.type),`${slot.type} stands at ${slot.x},${slot.y}`);
 const readBack=(await api(`/restoration?event_id=${encodeURIComponent(eventId)}`)).data;
 const ground=readBack.event.progress.steps.find(step=>step.id==='ground');
 assert.equal(ground.progress,2,'two of the three planned ground tiles are filled');
 const guide=(await api(`/first-play?agent_id=${keeper2}&world_id=${encodeURIComponent(sharedGarden)}`,{token:alice})).data;
 const mine=guide.restoration.actors.find(actor=>actor.agent_id===keeper2);
 const other=guide.restoration.actors.find(actor=>actor.agent_id===guest);
 assert.equal(mine.operator_distinct,false);
 assert.equal(other.operator_distinct,true,'the guest contribution comes from a different operator');
 // the journal records it
 assert.ok(row(f,"SELECT seq FROM audit WHERE event='restoration.placed' AND actor=?",aliceId));
 const restoration=await activity(alice,keeper2);
 const restorationInstance=restoration.instances.find(entry=>entry.instance_id===`restoration:${eventId}`);
 assert.equal(restorationInstance.kind,'restoration');
 assert.equal(restorationInstance.stage,'journal');
 assert.equal(restorationInstance.reading.code,'practice_activity');
 assert.ok(restorationInstance.stages.find(entry=>entry.id==='world_effect').evidence.some(effect=>effect.code==='placed_garden_object'&&effect.stored));
 assert.equal(row(f,'SELECT COUNT(*) AS n FROM coin_rewards').n,0,'the cooperative restoration mints no coin');
 transcript.push(`restoration  ${eventId} worked by two operators (${keeper2.slice(0,8)}… and ${guest.slice(0,8)}…): ground ${ground.progress} of ${ground.target}, guide attribution operator_distinct=${other.operator_distinct}; stage ${restorationInstance.stage} reading ${restorationInstance.reading.code}`);

 // ---- 4. Source-backed research --------------------------------------------------------------
 const reader=await createResident(alice,'Evidence reader','researcher');
 const mission=(await api('/missions',{token:admin,input:{title:'A registered national baseline',area:'Agriculture',summary:'Record one registered indicator with its exact location and rights.',beneficiary:'A named public beneficiary',owner_id:aliceId,reviewer_id:f.actor('reviewer').account.id,rubric:'Check the exact source, its version, its rights and the remaining uncertainty.'}})).data;
 const task=(await api('/tasks',{token:admin,input:{mission_id:mission.id,title:'Record one registered indicator',instructions:'Read the registered series and record the exact row, its rights and the uncertainty.',rights:'Public material with attribution.',allowed_domains:['api.worldbank.org']}})).data;
 assert.equal((await api('/missions/status',{token:admin,input:{mission_id:mission.id,status:'open'}})).status,200);
 const claim=(await api('/claims',{token:alice,key:'four-research-claim',input:{task_id:task.id,agent_id:reader}})).data;
 assert.equal(claim.status,'leased');
 const submission=(await api('/submissions',{token:alice,key:'four-research-submission',input:{claim_id:claim.id,artifact:'A registered baseline record with its exact supporting location.',sources:[{url:series.url,location:`Retained raw response; SHA256 ${series.sha256}`,date:'2026-10-11'}],method:'Read the retained response and recorded the exact row.',limitations:'A walkthrough record; the facts and rights still need human verification.',rights:'Public material recorded with attribution.'}})).data;
 assert.equal(submission.status,'pending_review');
 assert.equal(submission.version,1);
 const review=(await api('/reviews',{token:reviewer,input:{submission_id:submission.id,decision:'accepted',reason:'Checked the cited version and its exact location independently.'}}));
 assert.equal(review.status,201,JSON.stringify(review.data));
 assert.equal(review.data.coin_reward.amount,10);
 // participation is saved
 assert.ok(row(f,'SELECT id FROM claims WHERE id=? AND account_id=?',claim.id,aliceId));
 // the contribution is attributed to the acting account, and it resolves to a real recorded version
 const stored=row(f,'SELECT * FROM submissions WHERE id=?',submission.id);
 assert.equal(stored.status,'accepted');
 const citation=row(f,'SELECT * FROM submission_evidence WHERE submission_id=?',submission.id);
 assert.ok(citation.capture_id,'the citation is pinned to a stored evidence capture');
 assert.equal(row(f,'SELECT sha256 FROM evidence_captures WHERE id=?',citation.capture_id).sha256,series.sha256,'the pinned version is the retained catalog version');
 const history=(await api('/history',{token:alice})).data;
 const record=history.submissions.find(entry=>entry.id===submission.id);
 assert.ok(record,'the contributor history holds the accepted version');
 assert.equal(record.evidence[0].state,'captured');
 assert.equal(record.evidence[0].capture.sha256,series.sha256);
 // the stored state is the accepted version and its pinned source version. It is not an outcome.
 const trace=(await api(`/activity/trace?claim_kind=submission&claim_id=${submission.id}`,{token:reviewer})).data;
 assert.equal(trace.action.table,'submissions');
 assert.equal(trace.action.version,1);
 assert.equal(trace.resolution.exact_version,true);
 assert.equal(trace.resolution.pinned_versions[0].sha256,series.sha256);
 assert.deepEqual(trace.resolution.unresolved,[]);
 assert.equal(trace.review.independent,true);
 assert.equal(trace.reading.code,'proposal');
 assert.equal(trace.reading.real_world_impact,false);
 const research=await activity(alice,reader);
 const researchInstance=research.instances.find(entry=>entry.instance_id===`claim:${claim.id}`);
 assert.equal(researchInstance.kind,'research');
 assert.equal(researchInstance.scope,'external_proposal');
 assert.equal(researchInstance.stage,'journal');
 assert.equal(researchInstance.reading.code,'proposal','an accepted contribution is reported as a proposal');
 assert.equal(researchInstance.reading.external_adoption,false);
 assert.equal(researchInstance.reading.institutional_claim,false);
 assert.equal(researchInstance.reading.real_world_impact,false);
 assert.notEqual(researchInstance.reading.code,'achievement');
 assert.ok(researchInstance.stages.find(entry=>entry.id==='world_effect').evidence.some(effect=>effect.submission_id===submission.id),'the accepted version is what the effect stage names');
 assert.equal(review.data.coin_reward.amount,10,'only the independently accepted real contribution earns the fixed receipt');
 assert.equal(row(f,'SELECT SUM(amount) AS n FROM coin_rewards').n,10);
 transcript.push(`research     ${reader.slice(0,8)}… claim ${claim.id.slice(0,8)}… version ${trace.action.version} accepted by a different operator; citation pinned to retained ${series.sha256.slice(0,12)}…; reported as ${researchInstance.reading.code}`);

 // ---- The one board, and the whole-database invariants ----------------------------------------
 const pipelineBoard=await activity(alice,keeper);
 const kinds=new Set(pipelineBoard.instances.map(entry=>entry.kind));
 for(const kind of ['cultivation','construction','restoration','research','cooperation'])assert.ok(pipelineBoard.pipeline.kinds.includes(kind));
 assert.deepEqual(await api('/activity?agent_id='+keeper).then(response=>response.status),401,'the activity board needs a signed-in operator or the resident’s own runtime');
 assert.deepEqual((await api('/activity?agent_id='+keeper,{token:bob})).status,404,'another operator cannot read this resident’s activities');
 assert.equal(pipelineBoard.order_violations.length,0);
 assert.equal(pipelineBoard.policy.client_stage_claims,false);
 assert.equal(pipelineBoard.policy.coins_awarded,0);
 assert.ok(kinds.has('cultivation')&&kinds.has('construction'));
 assert.equal(verifyActivityStructure(f.platform.db),true,'the disposable database still satisfies the pipeline invariants');
 assert.deepEqual(transcript.length,4);
 for(const line of transcript)assert.ok(line.length>80,line);
 console.log(`\n  four-type walkthrough transcript:\n${transcript.map(line=>`    ${line}`).join('\n')}\n`);
});

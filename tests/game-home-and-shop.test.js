import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createFirstPlayGuide, guideView, guideModel } from '../src/ui/first-play-guide.js';
import { createPortalJourney } from '../src/world-navigation.js';

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const between=(start,end)=>{const a=app.indexOf(start),b=app.indexOf(end,a);assert.ok(a>=0&&b>a,'test must execute the shipped function block');return app.slice(a,b);};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const all=(node,predicate)=>[...(predicate(node)?[node]:[]),...(node?.children||[]).flatMap(child=>all(child,predicate))];

test('the guide keeps the saved next action visible and supporting records in an optional native disclosure',()=>{
  const snapshot={progress:{done:2,total:5},next_step:{id:'meet',title:'Meet a resident',actions:[{id:'meet',label:'Message Mira',route:'/messages',requires_input:true}]},encounter:{name:'Mira',kind:'agent',actions:[]},resume:{character_name:'Rin',world_id:'commons',x:10,y:6}};
  const before=JSON.stringify(snapshot),tree=guideView(guideModel(snapshot));
  assert.equal(tree.children[0].attrs['data-guide'],'next');
  const details=tree.children.find(node=>node.tag==='details');
  assert.equal(details.attrs.open,false);
  assert.equal(details.children[0].tag,'summary');
  assert.equal(all(details,node=>node.attrs?.['data-guide']==='encounter').length,1);
  assert.equal(all(tree.children[0],node=>node.class?.includes('game-guide-action')).filter(node=>node.tag==='button').length,1);
  assert.equal(JSON.stringify(snapshot),before,'presentation cannot mutate the server snapshot');
});

test('opening a calling panel or guide details writes no action and preserves server progress',()=>{
  const writes=[],sections=[];
  const guide=createFirstPlayGuide({transport:async(...args)=>writes.push(args),onNavigate:section=>sections.push(section)});
  const snapshot={progress:{done:1,total:5},next_step:{id:'calling',title:'Choose a calling',actions:[],reason:'Find a purpose'},encounter:{name:'Mira',actions:[]}};
  guide.update(snapshot);
  const button=all(guide.view(),node=>node.attrs?.['data-guide-navigation']==='callings')[0];
  button.on.click();
  const details=all(guide.view(),node=>node.attrs?.['data-guide']==='details')[0];
  details.on.toggle({currentTarget:{open:true}});
  guide.update({...snapshot});
  assert.equal(guide.model().detailsOpen,true);
  assert.equal(guide.model().progress.done,1);
  assert.deepEqual(sections,['callings']);assert.deepEqual(writes,[]);
  guide.reset();assert.equal(guide.model().detailsOpen,false);
});

function homeHarness(travel){
  const agent={id:'a',world_id:'commons',status:'active'},state={selected:'a',sessionEpoch:1,account:{id:'operator'},world:{paused:false,world:{id:'commons'}},building:false,gameDrawer:'tools',gamePanel:''};
  const scope={state,sectionTicket:0,activeSection:()=>state.gamePanel||'world',selected:()=>state.selected==='a'?agent:{id:'b',world_id:'commons'},currentWorldId:()=>agent.world_id,viewedAgent:()=>agent,travelAgent:travel,worldPortals:()=>state.world.portals||[],portalTarget:portal=>portal.target_world_id||portal.targetWorldId,enterPortal:async()=>false,placementRulesFor:payload=>({available:Boolean(payload.build_palette?.length)}),notice:(...args)=>scope.notices.push(args),notices:[],setTab:tab=>{state.gamePanel=tab==='world'?'':tab;},renderGamePanel:()=>{},render:()=>scope.renders++,renders:0,applyGameShell:()=>{},$:()=>({focus(){}})};
  vm.runInNewContext(`${between('async function enterOwnedSpace(', 'async function readHomePrivacy(')};globalThis.run=enterOwnedSpace`,scope);
  return{agent,state,scope};
}

test('Build something waits for confirmed home travel and the server palette',async()=>{
  const gate=deferred();let target;
  const h=homeHarness(async id=>{target=id;await gate.promise;h.agent.world_id=id;h.state.world={paused:false,world:{id,owner_agent_id:'a'},build_palette:['flowers']};return true;});
  const pending=h.scope.run({build:true});
  assert.equal(target,'home:a');assert.equal(h.state.building,false);assert.equal(h.scope.renders,0);
  gate.resolve();assert.equal(await pending,true);assert.equal(h.state.building,true);assert.equal(h.state.gameDrawer,'');
});

test('a refused, paused or changed-resident home journey cannot enable building',async()=>{
  const refused=homeHarness(async()=>false);
  assert.equal(await refused.scope.run({build:true}),false);assert.equal(refused.state.building,false);
  const paused=homeHarness(async()=>assert.fail('paused home travel must stay unavailable'));
  paused.state.world.paused=true;assert.equal(await paused.scope.run({build:true}),false);assert.equal(paused.state.building,false);
  const gate=deferred(),changed=homeHarness(async()=>{await gate.promise;return true;});
  const pending=changed.scope.run({build:true});changed.state.selected='b';gate.resolve();
  assert.equal(await pending,false);assert.equal(changed.state.building,false);
});

test('home building refuses an unconfirmed palette even after travel reports success',async()=>{
  const h=homeHarness(async id=>{h.agent.world_id=id;return true;});
  assert.equal(await h.scope.run({build:true}),false);assert.equal(h.state.building,false);assert.match(h.scope.notices.at(-1)[0],/palette is unavailable/);
});

test('Open my cottage confirms the garden, walks its observed doorway, then requests cottage travel',async()=>{
  const steps=[],walkStarted=deferred(),walkRelease=deferred(),door={id:'cottage-door',x:4,y:2,target_world_id:'house:a'};
  const h=homeHarness(async id=>{
    steps.push(`travel:${id}`);
    if(id==='house:a')assert.ok(Math.abs(h.agent.x-door.x)+Math.abs(h.agent.y-door.y)<=1,'the server travel is requested only from the doorway');
    Object.assign(h.agent,{world_id:id,x:0,y:0});h.state.world={paused:false,world:{id,owner_agent_id:'a'},build_palette:['flowers'],portals:id==='home:a'?[door]:[]};return true;
  });
  const journey=createPortalJourney({travelAgent:h.scope.travelAgent,readState:()=>({actor:h.scope.selected(),worldId:h.agent.world_id,sessionId:h.state.sessionEpoch}),walkTo:async(x,y)=>{steps.push(`walk:${x},${y}`);walkStarted.resolve();await walkRelease.promise;Object.assign(h.agent,{x,y});return true;}});
  h.scope.enterPortal=async portal=>{assert.equal(portal,door,'entry uses the actual observed portal');return(await journey({portal,actor:h.agent,sessionId:h.state.sessionEpoch})).ok;};
  const pending=h.scope.run({cottage:true});await walkStarted.promise;
  assert.deepEqual(steps,['travel:home:a','walk:4,2']);assert.equal(h.agent.world_id,'home:a');assert.equal(h.state.building,false);
  walkRelease.resolve();assert.equal(await pending,true);assert.deepEqual(steps,['travel:home:a','walk:4,2','travel:house:a']);assert.equal(h.agent.world_id,'house:a');
});

test('a missing or blocked cottage doorway leaves the confirmed garden usable for building',async()=>{
  for(const blocked of [false,true]){
    const destinations=[];
    const h=homeHarness(async id=>{destinations.push(id);h.agent.world_id=id;h.state.world={paused:false,world:{id,owner_agent_id:'a'},build_palette:['flowers'],portals:blocked?[{x:4,y:2,target_world_id:'house:a'}]:[]};return true;});
    let doorwayAttempts=0;h.scope.enterPortal=async()=>{doorwayAttempts++;return false;};
    assert.equal(await h.scope.run({cottage:true}),false);assert.equal(h.agent.world_id,'home:a');assert.deepEqual(destinations,['home:a']);assert.equal(doorwayAttempts,blocked?1:0);
    assert.equal(await h.scope.run({build:true}),true);assert.equal(h.state.building,true);assert.deepEqual(destinations,['home:a'],'the garden can be used without another travel request');
  }
});

test('changing resident or session while garden arrival is pending cannot enter its cottage',async()=>{
  for(const change of [h=>{h.state.selected='b';},h=>{h.state.sessionEpoch++;}]){
    const gate=deferred();let attempts=0;
    const h=homeHarness(async id=>{await gate.promise;h.agent.world_id=id;h.state.world={world:{id},portals:[{x:4,y:2,target_world_id:'house:a'}]};return true;});
    h.scope.enterPortal=async()=>{attempts++;return true;};
    const pending=h.scope.run({cottage:true});change(h);gate.resolve();
    assert.equal(await pending,false);assert.equal(attempts,0);assert.equal(h.state.building,false);
  }
});

test('a stale cottage doorway walk cannot dispatch travel, while building inside the cottage stays local',async()=>{
  const gate=deferred(),started=deferred(),destinations=[];
  const h=homeHarness(async id=>{destinations.push(id);Object.assign(h.agent,{world_id:id,x:0,y:0});h.state.world={world:{id,owner_agent_id:'a'},build_palette:['chair'],portals:[{x:4,y:2,target_world_id:'house:a'}]};return true;});
  const journey=createPortalJourney({travelAgent:h.scope.travelAgent,readState:()=>({actor:h.scope.selected(),worldId:h.agent.world_id,sessionId:h.state.sessionEpoch}),walkTo:async()=>{started.resolve();await gate.promise;return true;}});
  h.scope.enterPortal=async portal=>(await journey({portal,actor:h.agent,sessionId:h.state.sessionEpoch})).ok;
  const pending=h.scope.run({cottage:true});await started.promise;h.state.sessionEpoch++;gate.resolve();assert.equal(await pending,false);assert.deepEqual(destinations,['home:a']);
  h.agent.world_id='house:a';h.state.world={world:{id:'house:a',owner_agent_id:'a'},build_palette:['chair']};
  h.scope.travelAgent=async()=>assert.fail('furnishing an already-entered cottage must not travel');
  assert.equal(await h.scope.run({build:true}),true);assert.equal(h.state.building,true);
});

test('a newer panel, pending section or drawer choice cancels Home Build without losing the saved arrival',async()=>{
  for(const change of [h=>{h.scope.sectionTicket++;h.state.gamePanel='restoration';},h=>{h.scope.sectionTicket++;},h=>{h.state.gameDrawer='chat';}]){
    const gate=deferred(),h=homeHarness(async id=>{await gate.promise;h.agent.world_id=id;h.state.world={world:{id,owner_agent_id:'a'},build_palette:['flowers']};return true;});
    const pending=h.scope.run({build:true});change(h);
    const panel=h.state.gamePanel,drawer=h.state.gameDrawer;gate.resolve();
    assert.equal(await pending,false);assert.equal(h.agent.world_id,'home:a');assert.equal(h.state.building,false);assert.equal(h.state.gamePanel,panel);assert.equal(h.state.gameDrawer,drawer);assert.equal(h.scope.renders,0);assert.match(h.scope.notices.at(-1)[0],/Building did not start/);
  }
});

test('normal Home Build from an existing panel accepts travelAgent’s own return to the world',async()=>{
  const h=homeHarness(async id=>{h.agent.world_id=id;h.state.world={world:{id,owner_agent_id:'a'},build_palette:['flowers']};h.scope.setTab('world');return true;});
  h.state.gamePanel='home';
  assert.equal(await h.scope.run({build:true}),true);assert.equal(h.agent.world_id,'home:a');assert.equal(h.state.building,true);assert.equal(h.state.gamePanel,'');
});

test('choosing another view during garden travel stops the cottage chain and a later explicit request resumes at its real doorway',async()=>{
  const gate=deferred(),destinations=[],door={x:4,y:2,target_world_id:'house:a'};
  const h=homeHarness(async id=>{destinations.push(id);await gate.promise;h.agent.world_id=id;h.state.world={world:{id,owner_agent_id:'a'},build_palette:['flowers'],portals:[door]};return true;});
  let attempts=0;h.scope.enterPortal=async observed=>{assert.equal(observed,door);attempts++;h.agent.world_id='house:a';h.state.world={world:{id:'house:a',owner_agent_id:'a'},build_palette:['chair']};return true;};
  const pending=h.scope.run({cottage:true});h.scope.sectionTicket++;h.state.gamePanel='restoration';gate.resolve();
  assert.equal(await pending,false);assert.equal(h.agent.world_id,'home:a');assert.equal(attempts,0);assert.equal(h.state.gamePanel,'restoration');assert.match(h.scope.notices.at(-1)[0],/Cottage entry stopped/);
  assert.equal(await h.scope.run({cottage:true}),true);assert.equal(attempts,1);assert.equal(h.agent.world_id,'house:a');assert.deepEqual(destinations,['home:a'],'resuming uses the already-reached garden rather than starting another Home trip');
});

test('a new panel chosen during the cottage doorway journey remains open after confirmed entry',async()=>{
  const gate=deferred(),started=deferred(),h=homeHarness(async id=>{h.agent.world_id=id;h.state.world={world:{id,owner_agent_id:'a'},portals:[{x:4,y:2,target_world_id:'house:a'}]};return true;});
  h.scope.enterPortal=async()=>{started.resolve();await gate.promise;h.agent.world_id='house:a';h.state.world={world:{id:'house:a',owner_agent_id:'a'}};return true;};
  const pending=h.scope.run({cottage:true});await started.promise;h.scope.sectionTicket++;h.state.gamePanel='community';h.state.gameDrawer='';gate.resolve();
  assert.equal(await pending,true,'the confirmed cottage arrival is retained');assert.equal(h.agent.world_id,'house:a');assert.equal(h.state.gamePanel,'community');assert.equal(h.state.gameDrawer,'');assert.equal(h.state.building,false);
});

test('the real portal journey cancels a cottage walk on new navigation, and the next explicit Home request resumes',async()=>{
  const release=deferred(),started=deferred(),destinations=[],door={x:4,y:2,target_world_id:'house:a'};
  const h=homeHarness(async id=>{destinations.push(id);Object.assign(h.agent,{world_id:id,x:0,y:0});h.state.world={world:{id,owner_agent_id:'a'},build_palette:['flowers'],portals:id==='home:a'?[door]:[]};h.scope.setTab('world');return true;});
  vm.runInNewContext(`${between('function portalNavigationIdentity()', 'const portalJourney=')}${between('async function enterPortal(', 'async function refresh(')};globalThis.enterPortal=enterPortal`,h.scope);
  h.scope.portalJourney=createPortalJourney({travelAgent:h.scope.travelAgent,readState:()=>({actor:h.scope.selected(),worldId:h.agent.world_id,sessionId:h.state.sessionEpoch,navigationId:h.scope.portalNavigationIdentity()}),walkTo:async(x,y)=>{started.resolve();await release.promise;Object.assign(h.agent,{x,y});return true;}});
  const pending=h.scope.run({cottage:true});await started.promise;
  h.scope.sectionTicket++;h.state.gamePanel='restoration';h.state.gameDrawer='';release.resolve();
  assert.equal(await pending,false);assert.equal(h.agent.world_id,'home:a');assert.equal(h.state.gamePanel,'restoration');assert.equal(h.state.gameDrawer,'');assert.deepEqual(destinations,['home:a'],'a newer view must prevent the cottage request itself');assert.match(h.scope.notices.at(-1)[0],/Cottage entry stopped/);
  assert.equal(await h.scope.run({cottage:true}),true);assert.equal(h.agent.world_id,'house:a');assert.deepEqual(destinations,['home:a','house:a'],'a fresh explicit intent can enter from the reached doorway');
});

test('home privacy reads the actual cottage state and saves through the existing settings route',async()=>{
  for(const visibility of ['public','private']){
    const fields={},calls=[],agent={id:'a'},host={isConnected:true,replaceChildren(){},append(){}},state={selected:'a',sessionEpoch:1,account:{id:'operator'},world:{}};
    let save;
    const scope={state,selected:()=>agent,api:async(path,method,body)=>{calls.push({path,method,body});if(method==='PATCH')return{visibility:body.visibility,house_visibility:body.house_visibility};return{world:{visibility:path.includes('house%3A')?visibility:'public'}};},paragraph:()=>({}),form:(target,label,callback)=>{save=callback;return{};},field:(target,name,label,options)=>{const input={value:options.value,addEventListener(){}};fields[name]=input;return input;},notice:()=>{},$:()=>null,button:()=>({})};
    vm.runInNewContext(`${between('async function readHomePrivacy(', 'function mySpaceCard(')};globalThis.read=readHomePrivacy`,scope);
    await scope.read(host,'a');
    assert.equal(fields.house_visibility.value,visibility,'an existing public cottage must never be presented as private by default');
    await save({visibility:'private',house_visibility:'public'});
    const patch=calls.find(call=>call.method==='PATCH');
    assert.equal(patch.path,'/agents/a/home');assert.equal(patch.body.visibility,'private');assert.equal(patch.body.house_visibility,'private','closing the garden closes its cottage');
  }
});

function shopHarness(api){
  const updates=[],state={selected:'a',account:{id:'operator'},sessionEpoch:1};
  const host={isConnected:true},scope={state,shopRevision:1,shopHost:host,shopStatus:null,shopPanel:{update:value=>updates.push(value),view:()=>({})},shopContext:null,api,loadJourney:async()=>{scope.journeyReads++;},journeyReads:0,mount:()=>{},$:()=>null};
  scope.shopContext={revision:1,host,accountId:'operator',agentId:'a',epoch:1};
  vm.runInNewContext(`${between('function clearShopView(', '/**\n * Earning is one explicit operator action:')};globalThis.run=buyShopGood;globalThis.current=currentShopContext;globalThis.clear=clearShopView`,scope);
  return{scope,state,host,updates};
}

test('a delayed purchase cannot paint another resident, a new operator or a detached panel',async()=>{
  for(const change of [h=>{h.state.selected='b';},h=>{h.state.sessionEpoch++;},h=>{h.state.account={id:'other'};},h=>{h.host.isConnected=false;},h=>h.scope.clear()]){
    const gate=deferred();let calls=0;
    const h=shopHarness(async()=>{calls++;return gate.promise;});
    const pending=h.scope.run('keepsake');change(h);gate.resolve({id:'purchase'});await pending;
    assert.deepEqual(h.updates,[]);assert.equal(h.scope.journeyReads,0);assert.equal(calls,1,'stale purchase may commit but cannot issue more reads or repaint');
  }
});

test('only the current resident receives the confirmed purchase and fresh wallet',async()=>{
  const h=shopHarness(async path=>path==='/shop/purchase'?{id:'p'}:path.startsWith('/karma?')?{balance:8}:{goods:[{id:'keepsake',label:'Keepsake'}]});
  await h.scope.run('keepsake');
  assert.equal(h.updates.length,1);assert.equal(h.updates[0].agentId,'a');assert.equal(h.updates[0].karma.balance,8);assert.equal(h.updates[0].purchase.id,'p');assert.equal(h.scope.journeyReads,1);
});

test('a delayed refusal cannot overwrite a newer shop with another resident’s error',async()=>{
  const gate=deferred(),h=shopHarness(()=>gate.promise);
  const pending=h.scope.run('keepsake');h.state.selected='b';gate.reject(new Error('Old purse is empty'));await pending;
  assert.deepEqual(h.updates,[]);assert.equal(h.scope.shopStatus,null);
});

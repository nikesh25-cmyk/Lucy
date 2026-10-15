import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createFirstPlayGuide, guideView, guideModel } from '../src/ui/first-play-guide.js';

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
  const agent={id:'a',world_id:'commons',status:'active'},state={selected:'a',sessionEpoch:1,account:{id:'operator'},world:{paused:false,world:{id:'commons'}},building:false,gameDrawer:'tools'};
  const scope={state,selected:()=>state.selected==='a'?agent:{id:'b',world_id:'commons'},currentWorldId:()=>agent.world_id,viewedAgent:()=>agent,travelAgent:travel,placementRulesFor:payload=>({available:Boolean(payload.build_palette?.length)}),notice:(...args)=>scope.notices.push(args),notices:[],setTab:()=>{},renderGamePanel:()=>{},render:()=>scope.renders++,renders:0,applyGameShell:()=>{},$:()=>({focus(){}})};
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

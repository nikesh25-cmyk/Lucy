import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const block=(start,end)=>{const a=app.indexOf(start),b=app.indexOf(end,a);assert.ok(a>=0&&b>a,'execute the shipped function block');return app.slice(a,b);};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};

function harness({game=false,section='world',motion,refresh}={}){
  const resident={id:'a',world_id:'commons',x:10,y:6},state={selected:'a',sessionEpoch:1,gamePresentation:game,tab:game?'world':section,gamePanel:game&&section!=='world'?section:'',viewWorld:'',building:false};
  const scope={state,sectionTicket:0,walkVersion:0,motionRevision:0,selected:()=>state.selected==='a'?resident:{id:'b',world_id:'commons'},movementQueue:{reset(){}},motionRequest:motion||(async()=>({world_id:'home:a',x:3,y:3})),refresh:refresh||(async()=>{}),setGameMode:()=>{},render:()=>scope.rendered.push(scope.activeSection()),rendered:[],travelRoutes:()=>[],worldPortals:()=>[],worldPosition:()=>resident,definition:()=>({name:'A garden'}),notice:text=>scope.notices.push(text),notices:[],reportMoveOutcome:()=>{},moveFeedback:value=>value};
  vm.runInNewContext(`${block('function activeSection()', 'const PANEL_FOCUSABLE=')};${block('async function travelAgent(', 'const portalJourney=')};globalThis.run=travelAgent;globalThis.actualSetTab=setTab;globalThis.tabWrites=[];setTab=(tab)=>{tabWrites.push(tab);actualSetTab(tab)}`,scope);
  return{resident,state,scope};
}

test('a workspace section opened during motion remains visible after saved travel refreshes',async()=>{
  const motion=deferred(),h=harness({motion:()=>motion.promise});
  const pending=h.scope.run('home:a');
  h.scope.sectionTicket++;h.state.tab='restoration';
  motion.resolve({world_id:'home:a',x:3,y:3});
  assert.equal(await pending,true);assert.equal(h.resident.world_id,'home:a');assert.equal(h.state.tab,'restoration');assert.deepEqual(Array.from(h.scope.tabWrites),[]);assert.deepEqual(h.scope.rendered,['restoration']);assert.match(h.scope.notices[0],/Arrived in A garden/);
});

test('a game panel opened while arrival refreshes stays open above the saved destination',async()=>{
  const refresh=deferred(),started=deferred(),h=harness({game:true,refresh:async()=>{started.resolve();await refresh.promise;}});
  const pending=h.scope.run('home:a');await started.promise;
  assert.equal(h.resident.world_id,'home:a','the saved location can arrive before the view refresh finishes');
  h.scope.sectionTicket++;h.state.gamePanel='restoration';refresh.resolve();
  assert.equal(await pending,true);assert.equal(h.state.gamePanel,'restoration');assert.deepEqual(Array.from(h.scope.tabWrites),[]);assert.deepEqual(h.scope.rendered,['restoration']);
});

test('an explicitly requested section still loading also owns navigation after travel',async()=>{
  const refresh=deferred(),started=deferred(),h=harness({game:true,section:'explore',refresh:async()=>{started.resolve();await refresh.promise;}});
  const pending=h.scope.run('home:a');await started.promise;
  // openSection increments its ticket before awaiting its own data; the old panel may still be visible.
  h.scope.sectionTicket++;refresh.resolve();
  assert.equal(await pending,true);assert.equal(h.state.gamePanel,'explore');assert.deepEqual(Array.from(h.scope.tabWrites),[]);
});

test('without a newer navigation, a confirmed arrival opens the world normally',async()=>{
  for(const game of [false,true]){
    const h=harness({game,section:'explore'});
    assert.equal(await h.scope.run('home:a'),true);assert.equal(h.resident.world_id,'home:a');assert.equal(h.scope.activeSection(),'world');assert.deepEqual(Array.from(h.scope.tabWrites),['world']);assert.deepEqual(h.scope.rendered,['world']);assert.match(h.scope.notices[0],/Arrived in A garden/);
  }
});

test('an expired session or changed resident cannot apply a late travel response',async()=>{
  for(const change of [h=>{h.state.sessionEpoch++;},h=>{h.state.selected='b';}]){
    const motion=deferred();let reads=0;const h=harness({motion:()=>motion.promise,refresh:async()=>{reads++;}});
    const pending=h.scope.run('home:a');change(h);motion.resolve({world_id:'home:a',x:3,y:3});
    assert.equal(await pending,false);assert.equal(h.resident.world_id,'commons');assert.equal(reads,0);assert.deepEqual(h.scope.rendered,[]);assert.deepEqual(h.scope.notices,[]);
  }
});

test('a session ending during refresh cannot navigate or announce a completed arrival',async()=>{
  const refresh=deferred(),started=deferred(),h=harness({refresh:async()=>{started.resolve();await refresh.promise;}});
  const pending=h.scope.run('home:a');await started.promise;h.state.sessionEpoch++;refresh.resolve();
  assert.equal(await pending,false);assert.deepEqual(Array.from(h.scope.tabWrites),[]);assert.deepEqual(h.scope.rendered,[]);assert.deepEqual(h.scope.notices,[]);
});

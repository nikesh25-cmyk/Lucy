import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {getWorldDefinition,walkable} from '../world.js';
import {MAP_ID,fromGlobal} from '../src/global-map.js';
import {mapActive} from '../src/map-view.js';

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const start=app.indexOf("minimap.addEventListener('click',"),end=app.indexOf('overview.append(',start);
assert.ok(start>=0&&end>start,'execute the actual minimap click handler');
const registration=app.slice(start,end);

function harness({world='commons',mapped=true,player=false}={}){
  const observations=[],walks=[],notices=[],pending=[],resident={id:'a',world_id:world,x:10,y:6},state={world:{world:{id:world},...(mapped?{map:{}}:{})},focus:null};
  const minimap={getBoundingClientRect:()=>({left:0,top:0,width:240,height:160}),addEventListener:(name,handler)=>{assert.equal(name,'click');minimap.click=handler;}};
  const scope={minimap,state,viewedAgent:()=>player?resident:null,mapActive,getWorldDefinition,MAP_ID,fromGlobal,walkable,definition:()=>getWorldDefinition(world),notice:text=>notices.push(text),guarded:action=>{const run=Promise.resolve().then(action);pending.push(run);return run;},walkTo:async(...args)=>{walks.push(args);return true;},enterObservation:async(...args)=>{observations.push(args);return true;},loadWorld:async()=>{},paintWorld:()=>{},$:()=>null};
  vm.runInNewContext(registration,scope);
  return{state,observations,walks,notices,click:async(x,y)=>{minimap.click({clientX:x,clientY:y});await Promise.all(pending);}};
}
const globalPixel=(x,y)=>{
  const area=getWorldDefinition(MAP_ID).bounds,scale=Math.min(240/area.width,160/area.height);
  return{x:(240-area.width*scale)/2+(x-area.x+.5)*scale,y:(160-area.height*scale)/2+(y-area.y+.5)*scale};
};

test('a stitched observer minimap click selects the outer Phase2 region and its local tile',async()=>{
  const h=harness(),point=globalPixel(250,50);
  assert.deepEqual(fromGlobal(250,50),{world_id:'district:cities',x:10,y:14});
  await h.click(point.x,point.y);
  assert.equal(h.observations.length,1);
  assert.equal(h.observations[0][0],'district:cities');assert.equal(h.observations[0][1].x,10);assert.equal(h.observations[0][1].y,14);
  assert.equal(h.state.focus,null,'the handler must not overwrite a Commons-local focus with a global click');assert.deepEqual(h.walks,[],'an observer never moves a resident');
});

test('sea and letterbox clicks cannot invent an observer destination',async()=>{
  const h=harness(),sea=globalPixel(8,190);
  assert.equal(fromGlobal(8,190),null);await h.click(sea.x,sea.y);await h.click(0,0);
  assert.deepEqual(h.observations,[]);assert.deepEqual(h.walks,[]);assert.equal(h.state.focus,null);assert.ok(h.notices.length>=1);
});

test('a player minimap click retains global walking while an indoor player stays put',async()=>{
  const stitched=getWorldDefinition(MAP_ID);let tile;
  for(let y=1;y<35&&!tile;y++)for(let x=241;x<287;x++)if(walkable({x,y:y+36},stitched)){tile={x,y:y+36};break;}
  assert.ok(tile,'an outer region has open ground');const h=harness({player:true}),point=globalPixel(tile.x,tile.y);
  await h.click(point.x,point.y);assert.equal(h.walks.length,1);assert.deepEqual(Array.from(h.walks[0]),[tile.x,tile.y,true]);assert.deepEqual(h.observations,[]);
  const indoor=harness({world:'library',mapped:false,player:true});await indoor.click(120,80);assert.deepEqual(indoor.walks,[]);assert.deepEqual(indoor.observations,[]);assert.equal(indoor.state.focus,null);
});

test('an indoor observer retains the bounded local focus path',async()=>{
  const world=getWorldDefinition('library'),h=harness({world:'library',mapped:false}),scale=Math.min(240/world.columns,160/world.rows),x=3,y=4;
  await h.click((240-world.columns*scale)/2+(x+.5)*scale,(160-world.rows*scale)/2+(y+.5)*scale);
  assert.equal(h.state.focus.x,x);assert.equal(h.state.focus.y,y);assert.deepEqual(h.observations,[]);assert.deepEqual(h.walks,[]);
});

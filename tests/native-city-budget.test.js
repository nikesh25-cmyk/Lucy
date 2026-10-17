import test from 'node:test';
import assert from 'node:assert/strict';
import {validateManifest,MANIFEST_LIMITS} from '../src/veloren-ext/world-manifest.js';
const check=(ops,limit)=>validateManifest({format:'veloren-world-v1',site:'Harr',area:{radius:60},groups:[{id:'budget',anchor:{plot:'Plaza'},ops}]},undefined,{...MANIFEST_LIMITS,max_blocks_total:limit});
test('native budget counts unique cleared/filled/sprite cells plus every foundation column',()=>{
 const clear={op:'clear',from:[0,0,0],to:[2,0,0]};
 assert.ok(check([clear],2).some(e=>e.includes('one manifest')));
 assert.deepEqual(check([clear,{op:'fill',from:[0,0,0],to:[2,0,0],kind:'Rock'}],3),[]);
 assert.ok(check([clear,{op:'sprite',at:[3,0,0],sprite:'Lantern'}],3).length);
 assert.ok(check([clear,{op:'foundation',from:[0,0],to:[1,0],kind:'Rock',depth:1}],4).length);
});
test('a clear operation obeys the same atomic volume cap as fill',()=>{
 assert.ok(check([{op:'clear',from:[-20,-20,0],to:[20,20,3]}],60000).some(e=>e.includes('4096')));
});

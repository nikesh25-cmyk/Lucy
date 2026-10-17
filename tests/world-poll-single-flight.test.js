import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const block=source.slice(source.indexOf('// Refresh the current viewport without replacing'),source.indexOf('function guidePortrait'));
function fixture(){
 const pending=[],calls=[];let callback;
 const state={account:null,world:{participants:[]},tab:'other'};
 const context={state,setInterval:fn=>{callback=fn},movementQueue:{inFlight:false},walkActive:false,motionRevision:0,currentWorldId:()=> 'commons',worldURL:()=>'/world',api:path=>{calls.push(path);return new Promise((resolve,reject)=>pending.push({resolve,reject}))},normalizeWorld:()=>({world:{id:'commons'},participants:[]}),seedPresence:()=>{}};
 vm.runInNewContext(block,context);
 return{run:()=>callback(),calls,pending};
}
test('slow world polling admits one refresh at a time and releases after completion',async()=>{
 const f=fixture(),first=f.run();const overlapping=f.run();assert.equal(f.calls.length,1);
 await overlapping;
 f.pending.shift().resolve({});await first;const next=f.run();assert.equal(f.calls.length,2);f.pending.shift().resolve({});await next;
});
test('a failed poll does not lock out the following world update',async()=>{
 const f=fixture(),first=f.run();f.pending.shift().reject(new Error('Temporary network failure'));await first;
 const next=f.run();assert.equal(f.calls.length,2);f.pending.shift().resolve({});await next;
});

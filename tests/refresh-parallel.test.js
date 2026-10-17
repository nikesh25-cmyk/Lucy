import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const block=source.slice(source.indexOf('async function refresh(all = true)'),source.indexOf('function mergeMissionContext'));
test('a slow directory read does not prevent independent world tools from beginning to load',async()=>{
 let release;const directory=new Promise(r=>{release=r}),calls=[];
 const names=['loadDirectory','loadResearch','loadAmbassadors','loadCommunity','loadJourney','loadCallings','loadGuilds','loadQuests','loadGuildProjects','loadRestoration','loadFirstPlay'];
 const context={URLSearchParams,state:{account:null,assembly:{},worldLoads:0},api:async path=>path.startsWith('/gallery')?[]:{},worldURL:()=>'/world',normalizeWorld:w=>w,seedPresence:()=>{},mergeMissionContext:()=>{}};
 for(const name of names)context[name]=()=>{calls.push(name);return name==='loadDirectory'?directory:Promise.resolve()};
 vm.runInNewContext(block,context);const pending=context.refresh();await new Promise(r=>setImmediate(r));
 try{assert.ok(calls.includes('loadCallings'),'directory latency must not serialize calling availability');assert.ok(calls.includes('loadFirstPlay'),'directory latency must not serialize the saved first-play guide');}
 finally{release();await pending;}
 assert.equal(calls.length,names.length);
});

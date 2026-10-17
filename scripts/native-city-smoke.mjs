#!/usr/bin/env node
// Real native server acceptance in an isolated world. No live database/config/credentials are used.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, openSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { Platform } from '../src/platform.js';
import { VelorenLink, withConfiguredLandmarks, loadLandmarks } from '../src/veloren-link.js';
import { createApp } from '../server.js';
import { loadNativeCityComposition } from '../src/veloren-ext/city-composition.js';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = resolve(process.env.NEMO_ENGINE_SOURCE || join(source,'../veloren-integ'));
const binaries = resolve(process.env.NEMO_ENGINE_BIN || join(engine,'../target/integ/release'));
const args=process.argv.slice(2);
if(args.length && (args.length!==2 || args[0]!=='--resume'))throw Error('Usage: native-city-smoke.mjs [--resume DISPOSABLE_TEST_DIRECTORY]');
let dir;
if(args.length) {
  dir=realpathSync(args[1]);const owner=JSON.parse(readFileSync(join(dir,'owner.json'),'utf8'));
  const rel=relative(realpathSync(tmpdir()),dir);
  if(rel.startsWith('..') || !basename(dir).startsWith('nemo-native-city-') || !owner.disposable || owner.source!==source)throw Error('Refusing non-probe or production directory');
  let alive=false;try{process.kill(owner.pid,0);alive=true;}catch{}
  if(alive)throw Error('Prior disposable probe is still running; stop it gracefully before resume');
} else dir=mkdtempSync(join(tmpdir(),'nemo-native-city-'));
for (const folder of ['data','logs','userdata/server/server_config','userdata/server-cli']) mkdirSync(join(dir,folder),{recursive:true});
const log = (message) => console.log(new Date().toISOString(),message);
const delay = ms => new Promise(r=>setTimeout(r,ms));
const json = path => JSON.parse(readFileSync(path,'utf8'));
const documents=loadNativeCityComposition();
for (const [key,value] of Object.entries(documents)) writeFileSync(join(dir,`${key}.json`),JSON.stringify(value));
const keyPath=join(dir,'event-key.bin');
const key=existsSync(keyPath)?readFileSync(keyPath):randomBytes(32);
if(key.length!==32)throw Error('Invalid disposable key');
if(!existsSync(keyPath))writeFileSync(keyPath,key,{flag:'wx',mode:0o600});
const outbox=join(dir,'data/events.jsonl'),worldRecord=outbox+'.world.json';
const platform=new Platform(join(dir,'data/world.sqlite'));
const link=new VelorenLink({dbPath:join(dir,'data/link.sqlite'),eventKey:key,commandsPath:outbox+'.commands.jsonl',landmarks:withConfiguredLandmarks(loadLandmarks(join(source,'content/veloren-landmarks.json')))});
process.env.NEMO_CITY_ENABLED='1';process.env.NEMO_WORLD_RECORD=worldRecord;
const app=createApp({platform,velorenLink:link,livingWorld:false});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${app.server.address().port}`;
const gamePort=Number(process.env.NEMO_CITY_TEST_PORT||14124);
writeFileSync(join(dir,'userdata/server/server_config/settings.ron'),`(gameserver_protocols:[Tcp(address:"127.0.0.1:${gamePort}")],query_address:Some("127.0.0.1:${gamePort+2}"),max_players:8,world_seed:130626853,server_name:"Disposable city acceptance",day_length:30.0,map_file:None,max_view_distance:Some(8),max_player_group_size:6,gameplay:(battle_mode:Global(PvE),explosion_burn_marks:true,),world:(start_time:32400.0,))`);
writeFileSync(join(dir,'userdata/server-cli/settings.ron'),`(update_shutdown_grace_period_secs:2,update_shutdown_message:"Disposable test restart",web_address:"127.0.0.1:${gamePort+1}",web_chat_secret:None,ui_api_secret:None,shutdown_signals:[SIGUSR1],)`);
const config={server_id:'native-city-disposable',ack_resident:'lw-lyra',outbox,residents:{Theron:'lw-theron'},landmarks:documents.landmarks.landmarks,world:{enabled:true,site:'Harr',path:join(dir,'manifest.json')}};
writeFileSync(join(dir,'link.json'),JSON.stringify(config));
let interrupted=false;
process.once('SIGTERM',()=>{interrupted=true;});process.once('SIGINT',()=>{interrupted=true;});
writeFileSync(join(dir,'owner.json'),JSON.stringify({pid:process.pid,source,disposable:true}));
const children=[];
function run(name,exe,args,env={}) { const child=spawn(exe,args,{cwd:engine,stdio:['ignore',openSync(join(dir,'logs',name+'.log'),'a'),openSync(join(dir,'logs',name+'.log'),'a')],env:{...process.env,...env}});children.push(child);return child; }
const startServer=()=>run('server',join(binaries,'veloren-server-cli'),['--non-interactive','--no-auth'],{VELOREN_USERDATA:join(dir,'userdata'),NEMO_LINK_CONFIG:join(dir,'link.json'),NEMO_LINK_EVENT_KEY:key.toString('hex'),RUST_LOG:'warn,veloren_server::sys::nemo_city=info'});
const balances=()=>({coins:platform.get('SELECT COUNT(*) n FROM coin_rewards').n,karma:platform.get('SELECT COUNT(*) n FROM karma_receipts').n,accounts:platform.get('SELECT COUNT(*) n FROM accounts').n});
const beforeBalances=balances();
let native;
try {
  native=startServer();
  log(`EVIDENCE ${dir}`);
  const relay=link.issueCredential({resident_id:'lw-lyra',scopes:['events'],days:1});
  run('relay',process.execPath,[join(source,'scripts/veloren-relay.mjs'),'--outbox',outbox,'--url',url,'--resident','lw-lyra'],{NEMO_LINK_TOKEN:relay.token});
  const deadline=Date.now()+180_000;
  while(!existsSync(outbox+'.landmarks.json')) { if(interrupted)throw Error('Probe interrupted'); if(native.exitCode!==null)throw Error('Native server exited; inspect evidence logs');if(Date.now()>deadline)throw Error('Native startup timed out');await delay(1000); }
  const credential=link.issueCredential({resident_id:'lw-theron',scopes:['talk','director'],days:1});
  run('bridge',join(binaries,'nemo-bridge'),['--server',`127.0.0.1:${gamePort}`,'--resident','lw-theron','--roster',join(engine,'nemo-bridge/roster.json'),'--landmarks',outbox+'.landmarks.json','--nemo-url',url],{NEMO_LINK_TOKEN:credential.token,RUST_LOG:'warn,nemo_bridge=info'});
  let last='';
  const until=Date.now()+Number(process.env.NEMO_CITY_TEST_TIMEOUT_MS||2_700_000);
  while(Date.now()<until) {
    await delay(10_000);
    if(interrupted) throw Error('Probe interrupted');
    if(native.exitCode!==null) throw Error('Native server exited during city simulation');
    if(readFileSync(join(dir,'logs/server.log'),'utf8').includes('world dressing cannot start')) throw Error('Native manifest validation refused city; inspect server log');
    const view=link.nativeCity.overview();
    let record={},actors={};try{record=json(worldRecord);actors=json(outbox+'.city.json');}catch{}
    const built=Object.keys(record.groups||{}).filter(id=>id.startsWith('city-'));
    const summary=JSON.stringify({citizens:view.citizens.length,native_actors:Object.keys(actors).length,arrived:Object.values(actors).filter(a=>a.arrived).length,city_groups:built.length,reports:view.reports.length,harvests:view.harvests.length,marriages:view.marriages.length,births:view.births.length,assessments:view.assessments.length,grown_children:view.citizens.filter(c=>c.stage==='adult'&&view.births.some(b=>b.citizen_id===c.id)).length});
    if(summary!==last){log(summary);last=summary;writeFileSync(join(dir,'progress.json'),JSON.stringify({view,actors,built},null,2));}
    if(view.births.length && view.reports.length && view.harvests.length && built.length===documents.manifest.groups.filter(g=>g.id.startsWith('city-')).length && view.citizens.some(c=>c.stage==='adult'&&view.births.some(b=>b.citizen_id===c.id)&&view.reports.some(r=>r.citizen_id===c.id))) {
      assert.deepEqual(balances(),beforeBalances,'city life grants no currency or accounts');
      assert.ok(Object.keys(actors).length>=8);assert.ok(built.includes('city-home-1-complete')||built.includes('city-home-2-complete')||built.includes('city-home-3-complete')||built.includes('city-home-4-complete'));
      const before=view.citizens.map(c=>c.id).sort();
      native.kill('SIGUSR1');await new Promise(r=>native.once('exit',r));
      const restartedAt=Date.now(); native=startServer();
      let rebound=false;
      for(let attempt=0;attempt<30;attempt++) {
        await delay(5000);
        let restored={};try{restored=json(outbox+'.city.json');}catch{}
        if(before.every(id=>restored[id]?.observed_at>restartedAt)) { rebound=true;break; }
      }
      assert.ok(rebound,'every prior citizen has a fresh observed native NPC position after restart');
      const after=link.nativeCity.overview().citizens.map(c=>c.id);
      assert.ok(before.every(id=>after.includes(id)),'restart preserves all prior citizens while allowing legitimate new births');
      log('PASS real native construction/work/family/birth/school/apprenticeship/adult-work and restart');
      writeFileSync(join(dir,'result.json'),JSON.stringify({passed:true,at:new Date().toISOString(),citizens:before,built}));
      process.exitCode=0;break;
    }
  }
  if(!existsSync(join(dir,'result.json')))throw Error('City acceptance deadline: inspect progress and native waiting records; no success claimed');
} catch(error) { log(`FAIL ${error.message}`);process.exitCode=1; }
finally {
  // Stop only children owned by this isolated probe. Native server gets its configured save signal.
  if(native?.exitCode===null){native.kill('SIGUSR1');await Promise.race([new Promise(r=>native.once('exit',r)),delay(15_000)]);}
  for(const child of children)if(child!==native&&child.exitCode===null)child.kill('SIGTERM');
  await new Promise(r=>app.server.close(r));await app.stopWorkers();platform.close();
  log(`Artifacts retained at ${dir}`);
}

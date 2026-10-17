import {spawn} from 'node:child_process';
import {cp, mkdir, writeFile, unlink} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const source=dirname(fileURLToPath(import.meta.url));
const binary=process.env.LUANTI_BIN;
if (!binary) throw new Error('Set LUANTI_BIN to a verified Luanti 5.17.0 executable.');
const data=resolve(process.env.NEMO_NATIVE_DATA || join(source,'.local'));
const user=join(data,'luanti'), game=join(user,'games','nemoworld_game'), world=join(user,'worlds','frontier-0-0');
const config=join(user,'minetest.conf');
const bridgePort=Number(process.env.NEMO_BRIDGE_PORT || 3999), luantiPort=Number(process.env.NEMO_LUANTI_PORT || 39333);
for(const port of [bridgePort,luantiPort]) if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Choose valid local ports.');
await mkdir(world,{recursive:true});
await cp(join(source,'nemoworld_game'),game,{recursive:true,force:true});
await writeFile(join(world,'world.mt'),'gameid = nemoworld\nbackend = sqlite3\nmg_name = singlenode\n',{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error});
const key=randomBytes(32).toString('hex');
await writeFile(config,`secure.enable_security = true\nsecure.http_mods = nemo\nnemo_bridge_url = http://127.0.0.1:${bridgePort}\nnemo_bridge_key = ${key}\nmg_name = singlenode\nbind_address = 127.0.0.1\nport = ${luantiPort}\nserver_announce = false\n`,{mode:0o600});
const bridge=spawn(process.execPath,[join(source,'bridge.mjs')],{env:{...process.env,NEMO_MOD_KEY:key,NEMO_NATIVE_SESSION_DIR:join(data,'private','native-session'),NEMO_BRIDGE_PORT:String(bridgePort)},stdio:'inherit'});
const engine=spawn(binary,['--server','--world',world,'--config',config,'--logfile',''],{env:{...process.env,LUANTI_USER_PATH:user},stdio:'inherit'});
process.stdout.write(`Connect Luanti 5.17.0 to 127.0.0.1:${luantiPort}, then sign in inside the game. Returning players reconnect automatically.\nNative world: ${world}\n`);
let stopping=false;
async function stop(){
  if(stopping)return;stopping=true;
  for(const child of [engine,bridge]) if(child.exitCode===null)child.kill('SIGINT');
  await Promise.all([engine,bridge].map(child=>child.exitCode!==null?null:new Promise(r=>child.once('exit',r))));
  await unlink(config).catch(()=>{});
}
process.once('SIGINT',()=>{void stop()}); process.once('SIGTERM',()=>{void stop()});
engine.once('exit',()=>{void stop()}); bridge.once('exit',()=>{void stop()});

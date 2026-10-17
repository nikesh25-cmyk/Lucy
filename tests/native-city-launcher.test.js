import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),delay=ms=>new Promise(r=>setTimeout(r,ms));
function setup(t){const root=mkdtempSync(join(tmpdir(),'city-launcher-'));for(const d of ['play/pids','play/bin','play/nemoworld/content'])mkdirSync(join(root,d),{recursive:true});writeFileSync(join(root,'play/nemoworld/content/veloren-villagers.json'),JSON.stringify({residents:[]}));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('local stop saves the owned native server using SIGUSR1 before it exits',async t=>{
 const root=setup(t),binary=join(root,'play/bin/veloren-server-cli'),saved=join(root,'saved');
 writeFileSync(binary,`#!/usr/bin/env python3\nimport signal,time,sys\ndef save(*args):\n open(${JSON.stringify(saved)},'w').write('saved')\n sys.exit(0)\nsignal.signal(signal.SIGUSR1,save)\nwhile True:time.sleep(.05)\n`,{mode:0o700});
 const child=spawn('/usr/bin/python3',[binary],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});t.after(()=>{try{child.kill();}catch{}});await delay(200);assert.equal(child.exitCode,null,stderr);writeFileSync(join(root,'play/pids/veloren'),String(child.pid));
 await exec('bash',[resolve('ops/play-local.sh'),'stop'],{env:{...process.env,HARR_ROOT:root},timeout:15000});
 assert.ok(existsSync(saved),'native save handler ran');assert.equal(existsSync(join(root,'play/pids/veloren')),false);
});
test('local stop refuses a stale pid file that points at an unrelated process',async t=>{
 const root=setup(t),child=spawn('sleep',['30'],{stdio:'ignore'});t.after(()=>{try{child.kill();}catch{}});writeFileSync(join(root,'play/pids/veloren'),String(child.pid));
 await assert.rejects(exec('bash',[resolve('ops/play-local.sh'),'stop'],{env:{...process.env,HARR_ROOT:root},timeout:15000}));
 assert.doesNotThrow(()=>process.kill(child.pid,0));assert.ok(existsSync(join(root,'play/pids/veloren')));
});
test('local stop recognizes its relative-script relay using its exact outbox and destination',async t=>{
 const root=setup(t),cwd=join(root,'play/nemoworld');mkdirSync(join(cwd,'scripts'));
 writeFileSync(join(cwd,'scripts/veloren-relay.mjs'),'setInterval(()=>{},1000);');
 const child=spawn(process.execPath,['scripts/veloren-relay.mjs','--outbox',join(root,'play/data/veloren-outbox.jsonl'),'--url','http://127.0.0.1:3100','--resident','lw-aria'],{cwd,stdio:'ignore'});
 t.after(()=>{try{child.kill();}catch{}});await delay(200);writeFileSync(join(root,'play/pids/relay-lw-aria'),String(child.pid));
 await exec('bash',[resolve('ops/play-local.sh'),'stop'],{env:{...process.env,HARR_ROOT:root,NEMO_NODE:process.execPath},timeout:15000});
 assert.equal(existsSync(join(root,'play/pids/relay-lw-aria')),false);
});
test('local stop recognizes the relative Node wrapper only in this stack root',async t=>{
 const root=setup(t);mkdirSync(join(root,'dev'));writeFileSync(join(root,'dev/start-nemo.mjs'),'setInterval(()=>{},1000);');
 const nodeWithParent=`${dirname(process.execPath)}/../${basename(dirname(process.execPath))}/${basename(process.execPath)}`;
 const child=spawn(process.execPath,['dev/start-nemo.mjs'],{cwd:root,stdio:'ignore'});
 t.after(()=>{try{child.kill();}catch{}});await delay(200);writeFileSync(join(root,'play/pids/nemo'),String(child.pid));
 await exec('bash',[resolve('ops/play-local.sh'),'stop'],{env:{...process.env,HARR_ROOT:root,NEMO_NODE:nodeWithParent},timeout:15000});
 assert.equal(existsSync(join(root,'play/pids/nemo')),false);
 const foreign=join(root,'another-stack');mkdirSync(join(foreign,'dev'),{recursive:true});writeFileSync(join(foreign,'dev/start-nemo.mjs'),'setInterval(()=>{},1000);');
 const other=spawn(process.execPath,['dev/start-nemo.mjs'],{cwd:foreign,stdio:'ignore'});t.after(()=>{try{other.kill();}catch{}});await delay(200);
 writeFileSync(join(root,'play/pids/nemo'),String(other.pid));
 await assert.rejects(exec('bash',[resolve('ops/play-local.sh'),'stop'],{env:{...process.env,HARR_ROOT:root,NEMO_NODE:process.execPath},timeout:15000}));
 assert.doesNotThrow(()=>process.kill(other.pid,0),'the identical command in another stack must remain alive');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
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

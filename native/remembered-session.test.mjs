import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rememberedSession} from './remembered-session.mjs';

test('remembered native access fails closed on tampering or a different API destination',t=>{
 const dir=mkdtempSync(join(tmpdir(),'nemo-private-cache-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const cache=rememberedSession(dir,'http://127.0.0.1:3000'),record={player:'Builder',token:'a'.repeat(64),agentId:'human-1',expires:Date.now()+100000};
 cache.write(record);assert.deepEqual(cache.read(),record);
 assert.throws(()=>rememberedSession(dir,'http://127.0.0.1:3001'),/unreadable/);
 const file=join(dir,'remembered.nemoenc'),envelope=JSON.parse(readFileSync(file,'utf8'));
 envelope.ciphertext=Buffer.alloc(Buffer.from(envelope.ciphertext,'base64').length).toString('base64');
 writeFileSync(file,JSON.stringify(envelope));assert.throws(()=>cache.read(),/unreadable/);
});
test('remembered native credentials refuse storage readable by other OS users',t=>{
 const dir=mkdtempSync(join(tmpdir(),'nemo-private-mode-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 rememberedSession(dir,'http://127.0.0.1:3000');chmodSync(join(dir,'connection.nemo-key'),0o644);
 assert.throws(()=>rememberedSession(dir,'http://127.0.0.1:3000'),/private/);
});

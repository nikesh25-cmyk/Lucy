import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveVideo } from '../src/media.js';

test('video streams bounded byte ranges, permits seeking and refuses malformed ranges',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'nemo-media-'));const path=join(folder,'film.mp4');
 const bytes=Buffer.from(Array.from({length:4096},(_,i)=>i%256));await writeFile(path,bytes);
 const server=createServer((req,res)=>serveVideo(req,res,path).catch(()=>{res.destroy();}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(folder,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${server.address().port}`;
 for(const [range,start,end] of [['bytes=100-199',100,199],['bytes=4000-',4000,4095],['bytes=-32',4064,4095],['bytes=4000-9000',4000,4095]]){
  const response=await fetch(url,{headers:{Range:range}});assert.equal(response.status,206);
  assert.equal(response.headers.get('content-type'),'video/mp4');
  assert.equal(response.headers.get('accept-ranges'),'bytes');
  assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/4096`);
  assert.equal(response.headers.get('content-length'),String(end-start+1));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(start,end+1));
 }
 for(const range of ['bytes=','bytes=-0','bytes=5000-','bytes=200-100','bytes=0-10,20-30','bytes=9007199254740992-','items=0-10']){
  const response=await fetch(url,{headers:{Range:range}});assert.equal(response.status,416,range);assert.equal(response.headers.get('content-range'),'bytes */4096');assert.equal((await response.arrayBuffer()).byteLength,0);
 }
 const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),'4096');assert.equal((await head.arrayBuffer()).byteLength,0);
 const full=await fetch(url);assert.equal(full.status,200);assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
});

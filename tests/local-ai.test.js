import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLlamaModel, createLocalModel } from '../runtime/model.js';
import { startLocalAI } from '../scripts/local-ai.mjs';
import { researchDraft } from '../runtime/research-worker.js';

test('research drafts cannot cite missing or unretrieved source numbers', () => {
  assert.throws(() => researchDraft({ brief: 'An uncited assertion.' }, 2), /cite/);
  assert.throws(() => researchDraft({ brief: 'Invented evidence [Source 3].' }, 2), /cite/);
  assert.throws(() => researchDraft({ brief: 'No evidence [Source 0].' }, 2), /cite/);
  assert.equal(researchDraft({ brief: 'A provisional summary [Source 2]. Applicability needs review.' }, 2), 'A provisional summary [Source 2]. Applicability needs review.');
});

test('llama adapter restricts requests to loopback and rejects incomplete model output', async () => {
  assert.throws(() => createLlamaModel({ url: 'https://example.org' }), /local HTTP/);
  assert.throws(() => createLocalModel({ backend: 'external-provider' }), /local/);
  let request;
  const model = createLlamaModel({ key: 'fixture-only', fetchImpl: async (url, options) => {
    request = { url: String(url), ...options };
    return Response.json({ choices: [{ message: { content: '{"answer":"Human review is required."}' }, finish_reason: 'stop' }] });
  } });
  assert.deepEqual(JSON.parse(await model({ prompt: 'Return an answer.' })), { answer: 'Human review is required.' });
  assert.equal(request.url, 'http://127.0.0.1:11435/v1/chat/completions');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers.Authorization, 'Bearer fixture-only');
  const body = JSON.parse(request.body);
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const truncated = createLlamaModel({ fetchImpl: async () => Response.json({ choices: [{ message: { content: '{"answer":"unfinished' }, finish_reason: 'length' }] }) });
  await assert.rejects(truncated({ prompt: 'Example' }), /incomplete/);
  await assert.rejects(model({ prompt: 'x'.repeat(24001) }), /limit/);
});

test('local AI startup skips missing installations and refuses forged install receipts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lucy-ai-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await startLocalAI(root), null);
  await mkdir(join(root, '.runtime', 'ai'), { recursive: true });
  await writeFile(join(root, '.runtime', 'ai', 'verified.json'), '{}');
  await assert.rejects(startLocalAI(root), /receipt|Apple Silicon/);
});

test('shared inference bounds waiting work, removes cancelled entries and never dispatches them', async () => {
  const {boundedModel}=await import('../runtime/model.js');
  const starts=[];let release,active=0,peak=0;
  const model=boundedModel(async input=>{starts.push(input.prompt);active++;peak=Math.max(peak,active);try{if(input.prompt==='first')await new Promise(resolve=>{release=resolve;});return input.prompt;}finally{active--;}},{maxWaiting:1});
  const first=model({prompt:'first'}),controller=new AbortController();
  const cancelled=model({prompt:'cancelled',signal:controller.signal});
  await assert.rejects(model({prompt:'overflow'}),/busy/);
  assert.deepEqual(model.status(),{active:1,waiting:1,max_waiting:1});
  controller.abort(new Error('Operator cancelled'));await assert.rejects(cancelled,/cancelled/);
  const next=model({prompt:'next'});release();
  assert.deepEqual(await Promise.all([first,next]),['first','next']);assert.deepEqual(starts,['first','next']);assert.equal(peak,1);
  assert.deepEqual(model.status(),{active:0,waiting:0,max_waiting:1});
});

test('shared inference recovers after model failure and rejects expired work before calling the model', async () => {
  const {boundedModel}=await import('../runtime/model.js');let calls=0;
  const model=boundedModel(async()=>{calls++;if(calls===1)throw new Error('Backend failed');return 'recovered';});
  await assert.rejects(model({prompt:'test'}),/failed/);assert.equal(await model({prompt:'retry'}),'recovered');
  const controller=new AbortController();controller.abort(new Error('Expired'));
  await assert.rejects(model({prompt:'expired',signal:controller.signal}),/Expired/);assert.equal(calls,2);
});

test('queued inference rechecks authority immediately before dispatch',async()=>{
  const {boundedModel}=await import('../runtime/model.js');let release,calls=0,allowed=true;
  const model=boundedModel(async()=>{calls++;if(calls===1)await new Promise(resolve=>{release=resolve;});return 'ok';});
  const first=model({prompt:'first'});
  const queued=model({prompt:'queued',beforeDispatch:()=>{if(!allowed)throw new Error('Session revoked');}});
  allowed=false;release();await first;await assert.rejects(queued,/revoked/);assert.equal(calls,1);
});


test('structured research claims require actual source numbers and preserve per-claim citations and gaps',()=>{
  const brief=researchDraft({claims:[{text:'A source-based finding.',sources:[1,1]},{text:'Another finding.',sources:[2]}],gaps:['Country applicability remains unknown.']},2);
  assert.match(brief,/finding\. \[Source 1\]/);assert.match(brief,/Another finding\. \[Source 2\]/);assert.match(brief,/Evidence gaps/);
  for(const sources of [[],[0],[3],['1']])assert.throws(()=>researchDraft({claims:[{text:'Unsupported.',sources}],gaps:['Unknown.']},2),/source/);
  assert.throws(()=>researchDraft({claims:[{text:'Finding.',sources:[1]}],gaps:[]},1),/gaps/);
});

test('mayor draft authority and invented contacts fall back to published guidance',async()=>{
  const {mayorDraft}=await import('../runtime/model.js');
  assert.equal(mayorDraft({answer:'Buyer demand and shipment costs need verification.'}),'Buyer demand and shipment costs need verification.');
  for(const answer of ['As an official United Nations mayor, I cannot approve this shipment.','I represent the UN.','The shipment is approved.','Contact buyer@example.com.','Read https://invented.example/report'])assert.throws(()=>mayorDraft({answer}),/authority|contact/);
  assert.equal(mayorDraft({answer:'Read https://www.un.org/.'},['https://www.un.org/']),'Read https://www.un.org/.');
});

test('mayor reply context preserves distinct identity and rechecks pause before persisting model prose',async t=>{
 const {fixture}=await import('./helpers.js'),{createApp}=await import('../server.js');const f=await fixture(t);let prompt,paused=false;
 const app=createApp({platform:f.platform,mayorModel:async input=>{prompt=input.prompt;if(paused)f.tx('mayorControl',f.actor('admin'),{npc_id:'mayor-highlands',status:'paused'});return JSON.stringify({answer:'Research needs a beneficiary and independent reviewer.'});}});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.stopWorkers();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});});
 const ask=async()=>{const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/v1/mayors/talk',{method:'POST',headers:{Authorization:'Bearer '+f.credentials.alice.token,'Content-Type':'application/json'},body:JSON.stringify({npc_id:'mayor-highlands',question:'Help me research agriculture.'})});assert.equal(response.status,200);return response.json();};
 const first=await ask();assert.equal(first.mode,'local-model');const identity=JSON.parse(prompt.split(' Context: ')[1]).identity;assert.equal(identity.name,f.platform.get('SELECT name FROM npc_mayors WHERE id=?','mayor-highlands').name);assert.equal(identity.region,'Highlands');assert.ok(identity.focus);assert.match(prompt,/Missing evidence never proves/);
 f.advance(3000);paused=true;const second=await ask();assert.equal(second.mode,'rules');assert.equal(second.model_fallback,true);const stored=f.platform.get('SELECT mode,answer FROM ambassador_conversations WHERE id=?',second.id);assert.equal(stored.mode,'rules');assert.notEqual(stored.answer,'Research needs a beneficiary and independent reviewer.');
});

test('mayor financial facts and purported completed enforcement/contact actions require published fallback',async()=>{
 const {mayorDraft}=await import('../runtime/model.js');for(const answer of ['The UN has not funded any Lucy project.','The project was financed yesterday.','We have banned the farmer.','I contacted the minister.','I have sent your recommendation.','Verify the latest directive (June 2026).'])assert.throws(()=>mayorDraft({answer}),/authority/);
 assert.equal(mayorDraft({answer:'Funding and buyer interest are not established by the supplied context. Human moderators decide reports.'}),'Funding and buyer interest are not established by the supplied context. Human moderators decide reports.');
});

test('mayor topic routes enforcement to moderation and excludes irrelevant pilot model context',async t=>{
 const {mayorTopic}=await import('../src/civic.js');assert.equal(mayorTopic('Ban the farmer now'),'moderation');assert.equal(mayorTopic('How do I appeal my suspension?'),'moderation');assert.equal(mayorTopic('Research exports'),'agriculture');assert.equal(mayorTopic('UN committees'),'assembly');
 const {fixture}=await import('./helpers.js'),{createApp}=await import('../server.js');const f=await fixture(t);let context;const app=createApp({platform:f.platform,mayorModel:async input=>{context=JSON.parse(input.prompt.split(' Context: ')[1]);return JSON.stringify({answer:'Human moderators inspect reports, decide actions and provide an appeal route. I cannot ban residents.'});}});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.stopWorkers();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});});const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/v1/mayors/talk',{method:'POST',headers:{Authorization:'Bearer '+f.credentials.alice.token,'Content-Type':'application/json'},body:JSON.stringify({npc_id:'mayor-highlands',question:'Ban the farmer now'})});assert.equal(response.status,200);assert.equal(context.pilot,undefined);assert.deepEqual(context.source_urls,[]);assert.match(context.guide,/Human moderators/);assert.equal((await response.json()).mode,'local-model');
});

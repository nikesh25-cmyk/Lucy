import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fixture } from './helpers.js';
import { Platform } from '../src/platform.js';
import { backupDatabase, validateDatabase } from '../src/recovery.js';
import { mayorCountryContext, mayorModelCountryContext } from '../src/mayor-evidence.js';
import { mayorCountryDraft } from '../runtime/model.js';
import { createApp } from '../server.js';

const question={npc_id:'mayor-highlands',question:'Help me research agriculture.'};

test('selected-country mayor context preserves exact retained provenance, missing records and country scope privately',async t=>{
  const f=await fixture(t),before=f.platform.get('SELECT COUNT(*) AS n FROM research_leads').n;
  const reply=f.tx('mayorTalk',f.actor('alice'),{...question,country_code:'NP'}),context=reply.country_context;
  assert.equal(context.country.iso2,'NP');assert.equal(context.sources.length,5);assert.equal(context.captured_at,reply.created_at);
  const electricity=context.sources.find(source=>source.indicator==='EG.ELC.ACCS.ZS');
  assert.deepEqual(electricity.latest_observation,{year:2024,value:97.9,observation_status:null});
  assert.deepEqual(electricity.latest_record,{year:2025,value:null,observation_status:null});
  assert.equal(electricity.missing_values,1);assert.equal(electricity.dataset_updated,'2026-10-08');
  const retained=f.platform.countryEvidence(null,{country:'NP',sector:'access'}).snapshot.series[0];
  assert.equal(electricity.retrieved_at,retained.retrieved_at);assert.equal(electricity.sha256,createHash('sha256').update(readFileSync(new URL('../'+retained.raw_file,import.meta.url))).digest('hex'));
  assert.match(context.sources[4].publisher,/ITU/);assert.match(context.sources[4].license.attribution,/ITU/);
  assert.deepEqual(reply.source_numbers,[1,2,3,4,5]);assert.equal(f.platform.mayors(null).conversations.length,0);assert.equal(f.platform.mayors(f.actor('bob')).conversations.length,0);
  assert.deepEqual(f.platform.exportAccount(f.actor('alice')).civic.conversations[0].country_context,context);
  assert.equal(f.platform.exportAccount(f.actor('alice')).format,'shared-world-account-v18');
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM research_leads').n,before);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM claims').n,0);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0);
  f.advance();const other=f.tx('mayorTalk',f.actor('alice'),{...question,country_code:'BD'});assert.match(other.answer,/Bangladesh/);assert.doesNotMatch(other.answer,/Nepal tea|India/);
  f.advance();assert.throws(()=>f.tx('mayorTalk',f.actor('alice'),{...question,country_code:'XX'}),{status:400});
  // The migration stores new guidance in the ambassador table and leaves the historic table untouched.
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM ambassador_conversations').n,2);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM mayor_conversations').n,0);
  f.tx('deleteAccount',f.actor('alice'));assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM ambassador_conversations').n,0);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM mayor_conversations').n,0);
});

test('country context preserves zero, all-null and uncollected series as different evidence states',async t=>{
  const f=await fixture(t),agriculture=structuredClone(f.platform.countryEvidence(null,{country:'NP'})),access=f.platform.countryEvidence(null,{country:'NP',sector:'access'});
  agriculture.snapshot.series[0].points=[{year:2025,value:null,observation_status:null},{year:2024,value:0,observation_status:'F'}];
  agriculture.snapshot.series[1].points=[{year:2025,value:null,observation_status:null}];
  agriculture.snapshot.series=agriculture.snapshot.series.slice(0,2);
  const context=mayorCountryContext(agriculture,access,new Date(f.clock()).toISOString());
  assert.equal(context.sources[0].latest_observation.value,0);assert.equal(context.sources[0].latest_observation.observation_status,'F');
  assert.equal(context.sources[1].status,'retained');assert.equal(context.sources[1].latest_observation,null);assert.equal(context.sources[1].latest_record.value,null);
  assert.equal(context.sources[2].status,'not_retained');assert.equal(context.sources[2].latest_record,null);assert.equal(context.sources[2].retrieved_at,null);assert.equal(context.sources[2].sha256,null);
  const missing=f.tx('mayorTalk',f.actor('alice'),{...question,country_code:'AQ'});assert.deepEqual(missing.source_numbers,[]);assert.equal(missing.country_context.sources.filter(source=>source.status==='retained').length,0);assert.match(missing.answer,/no retained data|evidence gap/);
  f.advance();const partial=f.tx('mayorTalk',f.actor('alice'),{...question,country_code:'SN'});assert.deepEqual(partial.source_numbers,[4,5]);assert.equal(partial.country_context.sources[0].collection_gap.indicator,'NV.AGR.TOTL.ZS');
});

test('stored country snapshots survive restart and backup; schema eight guide conversations migrate and stay readable',async t=>{
  const f=await fixture(t),aliceId=f.actor('alice').account.id,reply=f.tx('mayorTalk',f.actor('alice'),{...question,country_code:'NP'}),backup=join(f.directory,'country-backup.sqlite');
  backupDatabase(f.platform.db,backup);assert.equal(validateDatabase(backup).schema_version, 25);
  f.platform.close();const reopened=new Platform(f.database);t.after(()=>{try{reopened.close();}catch{/* Closed again before testing migration. */}});
  assert.deepEqual(reopened.mayors(reopened.authenticate(f.credentials.alice.token)).conversations[0].country_context,reply.country_context);
  // Recreate the schema eight guide store and record one historic conversation in it. The migration is
  // additive: the old row keeps its exact question and answer and gains no fabricated context.
  reopened.db.exec('ALTER TABLE mayor_conversations DROP COLUMN country_context; ALTER TABLE mayor_conversations DROP COLUMN source_numbers; PRAGMA user_version=8');
  reopened.db.prepare("INSERT INTO mayor_conversations(id,account_id,npc_id,question,answer,created_at,mode) VALUES('historic-1',?,'mayor-highlands','Historic question','Historic answer','2026-09-01T00:00:00.000Z','rules')").run(aliceId);
  assert.equal(validateDatabase(f.database).schema_version,8);reopened.close();
  const migrated=new Platform(f.database);t.after(()=>migrated.close());const actor=migrated.authenticate(f.credentials.alice.token);
  const old=migrated.mayors(actor).legacy_conversations[0];
  assert.equal(old.question,'Historic question');assert.equal(old.answer,'Historic answer');assert.equal(old.country_context,null);assert.deepEqual(old.source_numbers,[]);
  // The same historic row stays readable through the replacement ambassador named by the mapping.
  const mapped=migrated.get("SELECT ambassador_id FROM ambassador_legacy_map WHERE guide_id='mayor-highlands'").ambassador_id;
  const profile=migrated.ambassador(actor,{id:mapped});assert.equal(profile.legacy.guide_id,'mayor-highlands');
  assert.deepEqual(profile.legacy_conversations.map(conversation=>conversation.question),['Historic question']);
  assert.equal(migrated.get('SELECT COUNT(*) AS n FROM npc_ambassadors').n,248);assert.equal(migrated.get('SELECT COUNT(*) AS n FROM npc_mayors').n,20);
  assert.equal(validateDatabase(f.database).schema_version, 25);assert.equal(migrated.verifyAudit(),true);
  migrated.db.exec('ALTER TABLE mayor_conversations DROP COLUMN country_context');assert.throws(()=>validateDatabase(f.database),/mayor evidence schema/);
});

test('country mayor model drafts restrict quantities, URLs and source citations while leaving retained observations server-owned',async t=>{
  const f=await fixture(t),context=mayorCountryContext(f.platform.countryEvidence(null,{country:'NP'}),f.platform.countryEvidence(null,{country:'NP',sector:'access'}),new Date(f.clock()).toISOString());
  const answer='For Nepal, identify the beneficiary and verify local production before proposing an export route.';
  assert.deepEqual(mayorCountryDraft({answer,sources:[1,1,5]},context),{answer,source_numbers:[1,5]});
  for(const unsafe of ['Electricity access is 97.9%.','The observation is from 2024.','Internet use is forty percent.','The region has ９ farms.','Read WWW.example.org.','Read https://example.org.'])assert.throws(()=>mayorCountryDraft({answer:unsafe,sources:[1]},context));
  for(const sources of [undefined,[0],[6],['1'],[1.5]])assert.throws(()=>mayorCountryDraft({answer,sources},context),/source/);
  const missing=structuredClone(context);missing.sources[0].status='not_retained';assert.throws(()=>mayorCountryDraft({answer,sources:[1]},missing),/unavailable source/);
  const qualitative=mayorModelCountryContext(context);assert.equal(qualitative.sources[0].has_observation,true);assert.equal(qualitative.sources[3].has_missing_values,true);assert.doesNotMatch(JSON.stringify(qualitative),/97\.9|2024|2026|https?:|sha256|retrieved_at|latest_record/);
});

test('HTTP country guidance uses bounded qualitative drafts, preserves exact snapshot on fallback and refuses runtime chat',async t=>{
  const f=await fixture(t);let prompt,draft={answer:'For Nepal, identify the beneficiary and verify local production before proposing an export route.',sources:[1,5],country_context:{country:{name:'Invented'},sources:[]}};
  const app=createApp({platform:f.platform,mayorModel:async input=>{prompt=input.prompt;return JSON.stringify(draft);}});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.stopWorkers();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});});
  const call=async(input,token=f.credentials.alice.token)=>{const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/v1/mayors/talk',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(input)});return {status:response.status,body:await response.json()};};
  const first=await call({...question,country_code:'NP'});assert.equal(first.status,200);assert.equal(first.body.mode,'local-model');assert.equal(first.body.country_context.country.name,'Nepal');assert.equal(first.body.country_context.sources[3].latest_observation.value,97.9);assert.deepEqual(first.body.source_numbers,[1,5]);
  const context=JSON.parse(prompt.split(' Context: ')[1]);assert.equal(context.pilot,undefined);assert.equal(context.task_count,undefined);assert.deepEqual(context.source_urls,[]);assert.equal(context.country_context.country.iso2,'NP');assert.match(prompt,/Exact statistics and dated sources are displayed separately/);
  f.advance();draft={answer:'The answer is 97.9%.',sources:[4]};const fallback=await call({...question,country_code:'NP'});assert.equal(fallback.body.mode,'rules');assert.equal(fallback.body.model_fallback,true);assert.deepEqual(fallback.body.country_context.sources,first.body.country_context.sources);assert.deepEqual(fallback.body.source_numbers,[1,2,3,4,5]);
  f.advance();draft={answer:'Consult country sources before proposing interventions.',sources:[1]};const unavailable=await call({...question,country_code:'AQ'});assert.equal(unavailable.body.mode,'rules');assert.deepEqual(unavailable.body.source_numbers,[]);
  const agent=f.agent('alice'),runtime=f.tx('runtime',f.actor('alice'),agent.id,{scopes:['read','chat'],minutes:4,max_calls:20});assert.equal((await call({...question,country_code:'NP'},runtime.token)).status,403);
  assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM ambassador_conversations').n,3);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM mayor_conversations').n,0);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM claims').n,0);assert.equal(f.platform.get('SELECT COUNT(*) AS n FROM coin_rewards').n,0);
});

test('a revoked human session cannot receive or persist a private country model reply after dispatch',async t=>{
  const f=await fixture(t);const app=createApp({platform:f.platform,mayorModel:async()=>{f.tx('logout',f.actor('alice'));return JSON.stringify({answer:'A private country draft.',sources:[1]});}});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.stopWorkers();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});});
  const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/v1/mayors/talk',{method:'POST',headers:{Authorization:'Bearer '+f.credentials.alice.token,'Content-Type':'application/json'},body:JSON.stringify({...question,country_code:'NP'})});assert.equal(response.status,401);const body=await response.json();assert.equal(body.country_context,undefined);assert.equal(body.answer,undefined);
  const stored=f.platform.get('SELECT answer,mode FROM ambassador_conversations');assert.equal(stored.mode,'rules');assert.notEqual(stored.answer,'A private country draft.');
});
